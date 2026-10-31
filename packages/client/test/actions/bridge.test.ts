import { HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { decodeFunctionData, getAddress } from 'viem';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { ERC20_ABI } from '../../src/account/abis';
import { resetNonceTracking } from '../../src/account/internal';
import { resetProcessState, setClientSeams } from '../../src/clients/internal';
import type { SecureClient } from '../../src/clients/secure';
import {
  RequestAbortedError,
  RequestRejectedError,
  UserInputError,
  type XoError,
} from '../../src/core/errors';
import { exceptionResponse } from '../helpers/mockBackend';
import {
  BASE_USDC,
  type BridgeBackend,
  DEPOSIT_ADDRESS,
  RECIPIENT,
} from '../helpers/mockBridge';
import { type RailChainStub, railChain, TX_HASH } from '../helpers/railChain';
import {
  chainReads,
  defaultChainState,
  onlyCall,
  signedInClient,
} from '../helpers/secureRig';
import { testEnvWithBridge } from '../helpers/testEnv';

// Deposits into XO and withdrawals out of it, from a signed-in client. A quote is a read; a
// deposit, a withdrawal and a verification are sent once. A withdrawal moves money once: it
// claims the payment's funding and sends the USDC, each never repeated.

const env = testEnvWithBridge;
const BASE = '/api/bridge/halliday';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

const clients: SecureClient[] = [];
let chain: RailChainStub;

beforeEach(() => {
  chain = railChain();
  chainReads(chain, env, defaultChainState(env));
  setClientSeams({ chain: chain.reader });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((c) => c.close()));
  server.resetHandlers();
  vi.restoreAllMocks();
  setClientSeams({});
  resetProcessState();
  resetNonceTracking();
});

async function rig() {
  const r = await signedInClient(server, { env });
  clients.push(r.client);
  return r;
}

/** The "METHOD /path" of every request the bridge fake saw, in order. */
const bridgeCalls = (bridge: BridgeBackend): string[] =>
  bridge.requests.map((request) => `${request.method} ${request.path}`);

async function caught(run: () => unknown): Promise<XoError> {
  try {
    await run();
  } catch (error) {
    return error as XoError;
  }
  throw new Error('expected the call to throw');
}

describe('listBridgeAssets', () => {
  test('lists the assets of a direction, on one page', async () => {
    const { client, bridge } = await rig();
    const page = await client
      .listBridgeAssets({ direction: 'deposit' })
      .firstPage();
    expect(bridge.requests[0]?.query.direction).toBe('deposit');
    expect(page.hasMore).toBe(false);
    expect(page.items.map((asset) => asset.assetId)).toContain(BASE_USDC);
  });

  test('a direction that is neither is refused at once', async () => {
    const { client, bridge } = await rig();
    const error = await caught(() =>
      client.listBridgeAssets({ direction: 'sideways' } as never),
    );
    expect(error.code).toBe('invalid_input');
    expect(bridge.requests).toEqual([]);
  });
});

describe('quoteDeposit and quoteWithdrawal', () => {
  test('a deposit quote: the options, best first, without limits on the answer', async () => {
    const { client, bridge } = await rig();
    const quotes = await client.quoteDeposit({
      assetId: BASE_USDC,
      amount: '25',
    });
    expect(bridgeCalls(bridge)).toEqual([`POST ${BASE}/quotes`]);
    expect(bridge.requests[0]?.body).toEqual({
      direction: 'deposit',
      asset: BASE_USDC,
      amount: '25',
    });
    expect(quotes).toHaveLength(2);
    expect(quotes[0]).toMatchObject({
      input: { assetId: BASE_USDC, amount: '25' },
    });
    expect(quotes[0]).not.toHaveProperty('recipient');
    expect(quotes).not.toHaveProperty('limits');
  });

  test('a withdrawal quote carries the recipient it was asked for', async () => {
    const { client } = await rig();
    const quotes = await client.quoteWithdrawal({
      assetId: BASE_USDC,
      amount: '10',
      recipient: RECIPIENT,
    });
    expect(quotes[0]?.recipient).toBe(RECIPIENT);
  });

  test('a quote is a read: a 503 is retried as a read is, with the options of the call', async () => {
    const { client, bridge } = await rig();
    let calls = 0;
    bridge.override('quotes', ({ request }) => {
      calls += 1;
      return calls === 1
        ? exceptionResponse(request.path, 503, {
            error: 'halliday_unavailable',
            message: 'The bridge is unavailable',
          })
        : HttpResponse.json({
            data: {
              quotes: [],
              acceptBy: '2026-10-21T12:05:00.000Z',
              limits: [],
            },
          });
    });
    await expect(
      client.quoteDeposit({ assetId: BASE_USDC, amount: '25' }, { retries: 1 }),
    ).resolves.toEqual([]);
    expect(calls).toBe(2);
  });

  test("an amount out of range fails with amount_out_of_range, whose message names the bounds; a quote's error never says it may have landed", async () => {
    const { client } = await rig();
    const error = await caught(() =>
      client.quoteDeposit({ assetId: BASE_USDC, amount: '1000000' }),
    );
    expect(error).toBeInstanceOf(RequestRejectedError);
    expect(error.code).toBe('amount_out_of_range');
    expect(error.message).toMatch(/1.*100000/);
    expect(error.mayHaveLanded).toBe(false);
  });
});

describe('createDeposit', () => {
  test('confirms a deposit quote: the payment says where to send the funds', async () => {
    const { client, bridge } = await rig();
    const [quote] = await client.quoteDeposit({
      assetId: BASE_USDC,
      amount: '25',
    });
    if (quote === undefined) throw new Error('no quote');
    const payment = await client.createDeposit({ quote });
    expect(payment).toMatchObject({
      paymentId: quote.paymentId,
      direction: 'deposit',
      status: 'AWAITING_FUNDS',
      deposit: { address: DEPOSIT_ADDRESS, amount: '25' },
    });
    expect(bridgeCalls(bridge).filter((c) => c.startsWith('POST'))).toEqual([
      `POST ${BASE}/quotes`,
      `POST ${BASE}/payments`,
    ]);
  });

  test('a withdrawal quote is not a deposit: refused, nothing confirmed', async () => {
    const { client, bridge } = await rig();
    const [quote] = await client.quoteWithdrawal({
      assetId: BASE_USDC,
      amount: '10',
      recipient: RECIPIENT,
    });
    const before = bridge.requests.length;
    const error = await caught(() => client.createDeposit({ quote } as never));
    expect(error).toBeInstanceOf(UserInputError);
    expect(bridge.requests.length).toBe(before);
  });
});

describe('withdraw', () => {
  test('confirms, claims the funding once and sends the quoted USDC once, to the deposit address', async () => {
    const { client, bridge, sponsor } = await rig();
    const [quote] = await client.quoteWithdrawal({
      assetId: BASE_USDC,
      amount: '10',
      recipient: RECIPIENT,
    });
    if (quote === undefined) throw new Error('no quote');
    const { payment, transaction } = await client.withdraw({ quote });
    expect(payment.paymentId).toBe(quote.paymentId);
    expect(payment.fundingClaimedAt).not.toBeNull();
    expect(transaction.transactionHash).toBe(TX_HASH);
    await expect(transaction.wait()).resolves.toMatchObject({
      status: 'success',
    });
    expect(
      bridgeCalls(bridge).filter((c) => c.endsWith('/funding-claim')),
    ).toHaveLength(1);
    expect(sponsor.bodies).toHaveLength(1);
    expect(
      decodeFunctionData({
        abi: ERC20_ABI,
        data: onlyCall(sponsor.bodies[0]).data,
      }),
    ).toEqual({
      functionName: 'transfer',
      args: [getAddress(DEPOSIT_ADDRESS), 10_000_000n],
    });
  });

  test('a transfer whose answer is lost after the claim: mayHaveLanded with the hash and the payment id, never sent again', async () => {
    const { client, sponsor } = await rig();
    const [quote] = await client.quoteWithdrawal({
      assetId: BASE_USDC,
      amount: '10',
      recipient: RECIPIENT,
    });
    if (quote === undefined) throw new Error('no quote');
    chain.receipt = () => new Error('connection reset');
    const error = await caught(() => client.withdraw({ quote }));
    expect(error.mayHaveLanded).toBe(true);
    expect(error).toMatchObject({
      transactionHash: TX_HASH,
      paymentId: quote.paymentId,
    });
    expect(sponsor.bodies).toHaveLength(1);
  });

  test('a deposit quote is not a withdrawal: refused, nothing confirmed, claimed or sent', async () => {
    const { client, bridge, sponsor } = await rig();
    const [quote] = await client.quoteDeposit({
      assetId: BASE_USDC,
      amount: '25',
    });
    const before = bridge.requests.length;
    const error = await caught(() => client.withdraw({ quote } as never));
    expect(error).toBeInstanceOf(UserInputError);
    expect(error.mayHaveLanded).toBe(false);
    expect(bridge.requests.length).toBe(before);
    expect(sponsor.bodies).toEqual([]);
  });
});

describe('reading payments', () => {
  test('fetchBridgePayment reads one payment; listBridgePayments lists the confirmed ones', async () => {
    const { client } = await rig();
    const [quote] = await client.quoteDeposit({
      assetId: BASE_USDC,
      amount: '25',
    });
    if (quote === undefined) throw new Error('no quote');
    await client.createDeposit({ quote });
    const payment = await client.fetchBridgePayment({
      paymentId: quote.paymentId,
    });
    expect(payment.status).toBe('AWAITING_FUNDS');
    const page = await client
      .listBridgePayments({ direction: 'deposit' })
      .firstPage();
    expect(page.items.map((p) => p.paymentId)).toContain(quote.paymentId);
  });

  test('verifyBridgePayment returns a payment that waits for no signature as it is, and signs nothing', async () => {
    const { client, bridge } = await rig();
    const [quote] = await client.quoteDeposit({
      assetId: BASE_USDC,
      amount: '25',
    });
    if (quote === undefined) throw new Error('no quote');
    await client.createDeposit({ quote });
    const verify = vi.fn(() => true);
    const payment = await client.verifyBridgePayment({
      paymentId: quote.paymentId,
      verify,
    });
    expect(payment.status).toBe('AWAITING_FUNDS');
    expect(verify).not.toHaveBeenCalled();
    expect(
      bridgeCalls(bridge).filter((c) => c.endsWith('/verification')),
    ).toEqual([]);
  });
});

describe('waitForBridgePayment', () => {
  test('a signal that aborts ends the wait with RequestAbortedError, whose cause is the reason', async () => {
    const { client } = await rig();
    const [quote] = await client.quoteDeposit({
      assetId: BASE_USDC,
      amount: '25',
    });
    if (quote === undefined) throw new Error('no quote');
    await client.createDeposit({ quote });
    const controller = new AbortController();
    const reason = new Error('the user left');
    setTimeout(() => controller.abort(reason), 50);
    const error = await caught(() =>
      client.waitForBridgePayment(
        { paymentId: quote.paymentId },
        { signal: controller.signal },
      ),
    );
    expect(error).toBeInstanceOf(RequestAbortedError);
    expect(error.cause).toBe(reason);
    expect(error.mayHaveLanded).toBe(false);
  });

  test('a signal that is already aborted: RequestAbortedError before any request', async () => {
    const { client, bridge } = await rig();
    const controller = new AbortController();
    controller.abort();
    const error = await caught(() =>
      client.waitForBridgePayment(
        { paymentId: 'pay_1' },
        { signal: controller.signal },
      ),
    );
    expect(error).toBeInstanceOf(RequestAbortedError);
    expect(bridge.requests).toEqual([]);
  });

  test('a timeout that is not a number of milliseconds is refused at once', async () => {
    const { client, bridge } = await rig();
    const error = await caught(() =>
      client.waitForBridgePayment({ paymentId: 'pay_1' }, { timeout: 0 }),
    );
    expect(error.code).toBe('invalid_request_options');
    expect(bridge.requests).toEqual([]);
  });
});
