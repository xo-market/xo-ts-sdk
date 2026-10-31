import { HttpResponse, http as mswHttp } from 'msw';
import { setupServer } from 'msw/node';
import { type Address, decodeFunctionData, type Hex } from 'viem';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { ERC20_ABI } from '../../src/account/abis';
import { AccountClient } from '../../src/account/client';
import { resetNonceTracking } from '../../src/account/internal';
import { SponsoredRail } from '../../src/account/rails';
import { Session } from '../../src/auth/session';
import { BridgeClient } from '../../src/bridge/client';
import type {
  BridgePayment,
  BridgeQuote,
  BridgeVerificationItem,
} from '../../src/bridge/schemas';
import { type RailKind, SessionRail } from '../../src/clients/rail';
import { Clock } from '../../src/core/clock';
import { type EnvironmentConfig, production } from '../../src/core/env';
import {
  AuthRequiredError,
  RateLimitError,
  RequestRejectedError,
  SigningError,
  TimeoutError,
  TransactionFailedError,
  TransportError,
  UnexpectedResponseError,
  UserInputError,
  XoError,
} from '../../src/core/errors';
import { Transport } from '../../src/core/transport';
import type { TradingIdentity } from '../../src/wallet/identity';
import type { InternalSigner } from '../../src/wallet/signer';
import { caught } from '../helpers/dataRig';
import { exceptionResponse, installBackend } from '../helpers/mockBackend';
import {
  ACCEPT_BY,
  BASE_USDC,
  type BridgeBackend,
  type BridgeRigOptions,
  bridgeRig,
  DEPOSIT_ADDRESS,
  expectNoRequest,
  FUND_BY_GUARD_MS,
  paymentFixture,
  RECIPIENT,
  XO_USDC_ASSET,
  XO_USDC_TOKEN,
} from '../helpers/mockBridge';
import {
  eoaIdentity,
  noRawSigner,
  OWNER,
  ownerSigner,
  SMART_WALLET,
  smartWalletIdentity,
  TX_HASH,
} from '../helpers/railChain';
import { rejectedWith, serverFailure } from '../helpers/rejections';
import { keySigner } from '../helpers/signers';
import { testEnv } from '../helpers/testEnv';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

const BASE = '/api/bridge/halliday';
const env = testEnv;
const USDC = env.contracts.usdc;
const CLAIM_PATH = `${BASE}/payments/pay_w/funding-claim`;
/** An address in the EIP-55 form (the test vector of the standard), and the same with one letter's case flipped. */
const CHECKSUMMED = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const WRONG_CHECKSUM = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD';

// The calldata is pinned to literal bytes (the selector of `transfer(address,uint256)` and the
// ABI words), so a wrong function, recipient or amount fails here even though the chain stub
// decodes with the SDK's own fragments.
const word = (hex: string): string =>
  hex.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const transferCalldata = (to: Address | string, micro: bigint): Hex =>
  `0xa9059cbb${word(to)}${word(micro.toString(16))}`;

/** A quote option of a withdrawal of 5 XO USDC, as `quoteWithdraw` returns it. */
function wquote(
  paymentId = 'pay_w',
  over: Partial<BridgeQuote> = {},
): BridgeQuote {
  return {
    paymentId,
    direction: 'withdraw',
    input: { asset: XO_USDC_ASSET, amount: '5' },
    output: { asset: BASE_USDC, amount: '4.9' },
    fees: {
      total: '0.1',
      conversion: '0',
      network: '0.05',
      business: '0.05',
      currency: 'USD',
    },
    latencySeconds: 30,
    acceptBy: ACCEPT_BY,
    recipient: RECIPIENT,
    ...over,
  };
}

/** A confirmed withdrawal of 5 XO USDC that waits for its funds, as the backend sends it. */
function withdrawal(over: Record<string, unknown> = {}) {
  return paymentFixture({
    paymentId: 'pay_w',
    direction: 'withdraw',
    input: { asset: XO_USDC_ASSET, amount: '5' },
    output: { asset: BASE_USDC, amount: '4.9' },
    recipient: RECIPIENT,
    destinationAddress: RECIPIENT,
    deposit: {
      address: DEPOSIT_ADDRESS,
      amount: '5',
      token: XO_USDC_TOKEN,
      chain: 'xo',
    },
    ...over,
  });
}

/** The `deposit` block of a withdrawal, with `over` changed. */
const depositOf = (over: Record<string, unknown>) => ({
  address: DEPOSIT_ADDRESS,
  amount: '5',
  token: XO_USDC_TOKEN,
  chain: 'xo',
  ...over,
});

/** Puts a confirmed withdrawal in the fake: a confirm of `pay_w` answers with it. */
function seed(backend: BridgeBackend, over: Record<string, unknown> = {}) {
  backend.payments.set('pay_w', withdrawal(over));
}

/** What the fake had seen, and the state of the payment, when the rail was asked to send. */
interface AtSend {
  requests: string[];
  claimedAt: unknown;
}

/**
 * A rig with a signer and 10 USDC. The rail also records, at the moment it is asked to send,
 * which requests the backend had seen and whether the payment was already claimed there, so a
 * test can assert the order between the claim and the send.
 */
function setup(o: BridgeRigOptions = {}) {
  const rig = bridgeRig(server, {
    signer: ownerSigner(),
    balanceMicro: 10_000_000n,
    ...o,
  });
  const atSend: AtSend[] = [];
  const send = rig.rail.send.bind(rig.rail);
  rig.rail.send = (calls) => {
    atSend.push({
      requests: rig.backend.requests.map((r) => `${r.method} ${r.path}`),
      claimedAt: rig.backend.payments.get('pay_w')?.fundingClaimedAt,
    });
    return send(calls);
  };
  return { ...rig, atSend };
}

/** The funding-claim POSTs the fake has seen. */
const claims = (backend: BridgeBackend) =>
  backend.requests.filter((r) => r.path.endsWith('/funding-claim'));

/** How many contract reads (the USDC balance reads) the chain stub has answered. */
const balanceReads = (rig: ReturnType<typeof setup>) =>
  rig.chain.log.filter((call) => call.method === 'readContract').length;

/** Asserts that nothing was claimed and nothing was sent. */
function expectNothingMoved(rig: ReturnType<typeof setup>): void {
  expect(claims(rig.backend)).toHaveLength(0);
  expect(rig.rail.sent).toEqual([]);
}

/** Asserts that the claim was not answered with a success and nothing was sent. */
function expectClaimedNothingSent(rig: ReturnType<typeof setup>): void {
  expect(claims(rig.backend)).toHaveLength(1);
  expect(rig.rail.sent).toEqual([]);
}

/** An error that is a `TransactionFailedError` with the code and flag, for the payment. */
function expectTransactionError(
  error: unknown,
  code: string,
  mayHaveLanded: boolean,
  paymentId = 'pay_w',
): TransactionFailedError {
  expect(error).toBeInstanceOf(TransactionFailedError);
  const tx = error as TransactionFailedError;
  expect(tx.code).toBe(code);
  expect(tx.service).toBe('sdk');
  expect(tx.mayHaveLanded).toBe(mayHaveLanded);
  expect(tx.paymentId).toBe(paymentId);
  return tx;
}

function expectUnlanded(error: unknown, paymentId = 'pay_w'): XoError {
  expect(error).toBeInstanceOf(XoError);
  const xo = error as XoError;
  expect(xo.mayHaveLanded).toBe(false);
  expect(xo.paymentId).toBe(paymentId);
  return xo;
}

const TEXT = 'Bridge: I authorise payment pay_w.\nNonce: 7';
const textItem = (): BridgeVerificationItem => ({
  reason: 'EVM_WITHDRAWAL',
  signatureType: 'EIP191',
  payload: TEXT,
});
/** A payment that waits for the owner's signature. */
const waiting = (over: Record<string, unknown> = {}) =>
  withdrawal({
    status: 'NEEDS_VERIFICATION',
    hallidayStatus: 'NEEDS_VERIFICATION',
    deposit: null,
    fundBy: null,
    verification: { items: [textItem()] },
    ...over,
  });
const yes = async () => true;

describe('bridge.withdraw: the one transfer', () => {
  test('quote → confirm → claim → one USDC transfer of exactly the deposit amount to the deposit address, in that order', async () => {
    const rig = setup();
    const { bridge, backend, rail, atSend } = rig;
    const { quotes } = await bridge.quoteWithdraw({
      asset: BASE_USDC,
      amount: '5',
      recipient: RECIPIENT,
    });
    const chosen = quotes[0] as BridgeQuote;

    const result = await bridge.withdraw(chosen);

    // The calls, in order: the quote, the confirm, the claim. No retry, no read.
    expect(backend.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST ${BASE}/quotes`,
      `POST ${BASE}/payments`,
      `POST ${BASE}/payments/${chosen.paymentId}/funding-claim`,
    ]);
    expect(backend.requests[1]?.body).toEqual({ paymentId: chosen.paymentId });
    expect(backend.requests[2]?.body).toBeUndefined();

    // Exactly one send, of exactly the deposit's amount to its address.
    expect(rail.sent).toEqual([
      [
        {
          to: USDC,
          data: transferCalldata(DEPOSIT_ADDRESS, 5_000_000n),
          value: 0n,
        },
      ],
    ]);

    // The claim was made and answered before the rail was asked to send.
    expect(atSend).toHaveLength(1);
    expect(atSend[0]?.requests.at(-1)).toBe(
      `POST ${BASE}/payments/${chosen.paymentId}/funding-claim`,
    );
    expect(atSend[0]?.requests).toHaveLength(3);

    expect(result.tx).toEqual({
      txHash: TX_HASH,
      status: 'success',
      blockNumber: 1n,
    });
    expect(result.payment.paymentId).toBe(chosen.paymentId);
    expect(result.payment.direction).toBe('withdraw');
    expect(result.payment.status).toBe('AWAITING_FUNDS');
    expect(result.payment.fundingClaimedAt).toEqual(expect.any(String));
  });

  test('the claim is recorded as made when the rail is asked to send (fundingClaimedAt is set by then)', async () => {
    const rig = setup();
    seed(rig.backend);
    await rig.bridge.withdraw(wquote());
    expect(rig.atSend).toHaveLength(1);
    expect(rig.atSend[0]?.claimedAt).toEqual(expect.any(String));
  });

  test.each([
    ['5.250000', '5.25', 5_250_000n],
    ['5.0', '5', 5_000_000n],
    ['0.000001', '0.000001', 1n],
    ['5e0', '5', 5_000_000n],
  ])(
    'a deposit of %s for a quote of %s is sent as %s micro-USDC, exactly',
    async (deposit, quoted, micro) => {
      const rig = setup();
      seed(rig.backend, { deposit: depositOf({ amount: deposit }) });
      await rig.bridge.withdraw(
        wquote('pay_w', { input: { asset: XO_USDC_ASSET, amount: quoted } }),
      );
      expect(rig.rail.sent).toEqual([
        [
          {
            to: USDC,
            data: transferCalldata(DEPOSIT_ADDRESS, micro),
            value: 0n,
          },
        ],
      ]);
    },
  );

  test('the chain and the token are compared without regard to case', async () => {
    const rig = setup();
    seed(rig.backend, {
      deposit: depositOf({
        chain: 'XO',
        token: `XO:${USDC.toUpperCase().replace('0X', '0x')}`,
      }),
    });
    const result = await rig.bridge.withdraw(wquote());
    expect(result.tx.status).toBe('success');
    expect(rig.rail.sent).toHaveLength(1);
  });

  test('a checksummed deposit address is accepted and sent to', async () => {
    const rig = setup();
    seed(rig.backend, { deposit: depositOf({ address: CHECKSUMMED }) });
    await rig.bridge.withdraw(wquote());
    expect(rig.rail.sent[0]?.[0]?.data).toBe(
      transferCalldata(CHECKSUMMED, 5_000_000n),
    );
  });

  test('a balance of exactly the amount is enough', async () => {
    const rig = setup({ balanceMicro: 5_000_000n });
    seed(rig.backend);
    const result = await rig.bridge.withdraw(wquote());
    expect(result.tx.status).toBe('success');
  });

  test('the balance read is the one of the trading address (a smart wallet, not its owner)', async () => {
    const rig = setup();
    const holders: string[] = [];
    const read = rig.chain.read as (call: { to: Address; data: Hex }) => Hex;
    rig.chain.read = (call) => {
      const decoded = decodeFunctionData({ abi: ERC20_ABI, data: call.data });
      if (decoded.functionName === 'balanceOf') {
        holders.push(String((decoded.args as readonly unknown[])[0]));
      }
      return read(call);
    };
    const bridge = new BridgeClient({
      env: rig.env,
      transport: rig.transport,
      session: rig.session,
      identity: async () => smartWalletIdentity(),
      signer: ownerSigner(),
      chain: rig.chain.reader,
      account: rig.account,
    });
    seed(rig.backend);

    await bridge.withdraw(wquote());

    // The first read is the bridge's own (the account client reads again before it sends).
    expect(holders[0]).toBe(SMART_WALLET);
    expect(rig.rail.sent).toHaveLength(1);
  });
});

describe('bridge.withdraw: arguments', () => {
  test('a deposit quote is refused with a UserInputError, before any request', async () => {
    const rig = setup();
    const error = await caught(() =>
      rig.bridge.withdraw(wquote('pay_d', { direction: 'deposit' })),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as XoError).code).toBe('invalid_input');
    expect((error as XoError).mayHaveLanded).toBe(false);
    expect((error as XoError).message).toMatch(/deposit/i);
    expectNoRequest(rig.backend);
    expect(rig.rail.sent).toEqual([]);
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'pay_w'],
    ['an object without a direction', { paymentId: 'pay_w' }],
    ['a paymentId with a path', { ...wquote(), paymentId: 'a/b' }],
    ['no input', { ...wquote(), input: undefined }],
    ['an input without an amount', { ...wquote(), input: { asset: 'x' } }],
    [
      'an amount that is a number',
      { ...wquote(), input: { asset: 'x', amount: 5 } },
    ],
    ['an amount of 0', { ...wquote(), input: { asset: 'x', amount: '0' } }],
    [
      'an amount with a sign',
      { ...wquote(), input: { asset: 'x', amount: '-5' } },
    ],
    [
      'an amount with an exponent',
      { ...wquote(), input: { asset: 'x', amount: '5e0' } },
    ],
    [
      'an amount with more than 6 decimals',
      { ...wquote(), input: { asset: 'x', amount: '5.0000001' } },
    ],
    // The recipient the quote was asked for: withdraw() checks the payment against it.
    ['no recipient', { ...wquote(), recipient: undefined }],
    ['a recipient that is not text', { ...wquote(), recipient: 5 }],
    ['a blank recipient', { ...wquote(), recipient: '   ' }],
    [
      'a recipient longer than 128 characters',
      { ...wquote(), recipient: 'a'.repeat(129) },
    ],
  ])('a quote that is %s is refused before any request', async (_, bad) => {
    const rig = setup();
    const error = await caught(() => rig.bridge.withdraw(bad as never));
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as XoError).mayHaveLanded).toBe(false);
    expectNoRequest(rig.backend);
    expect(rig.rail.sent).toEqual([]);
  });

  test.each([
    ['an unknown option', { verfiy: yes }],
    ['a verify that is not a function', { verify: 'yes' }],
    ['options that are null', null],
  ])('%s is refused before any request', async (_, options) => {
    const rig = setup();
    const error = await caught(() =>
      rig.bridge.withdraw(wquote(), options as never),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as XoError).mayHaveLanded).toBe(false);
    expectNoRequest(rig.backend);
  });

  test('a client without a signer fails at once with AuthRequiredError, before any request: the rail could not send', async () => {
    const rig = bridgeRig(server, { balanceMicro: 10_000_000n });
    const error = await caught(() => rig.bridge.withdraw(wquote()));
    expect(error).toBeInstanceOf(AuthRequiredError);
    expect((error as XoError).code).toBe('auth_required');
    expect((error as XoError).mayHaveLanded).toBe(false);
    expectNoRequest(rig.backend);
    expect(rig.rail.sent).toEqual([]);
  });

  test('a signer that cannot sign a raw digest fails at once with SigningError sign_hash_unsupported: the claim would be spent on a send that cannot be made', async () => {
    const rig = setup({ signer: noRawSigner() });
    seed(rig.backend);
    const error = await caught(() => rig.bridge.withdraw(wquote()));
    expect(error).toBeInstanceOf(SigningError);
    expect((error as XoError).code).toBe('sign_hash_unsupported');
    expect((error as XoError).mayHaveLanded).toBe(false);
    expectNoRequest(rig.backend);
    expect(rig.rail.sent).toEqual([]);
  });

  test('a config without a bridge fails with bridge_not_available before anything else', async () => {
    const rig = setup({ env: testEnv });
    const error = await caught(() => rig.bridge.withdraw(null as never));
    expect((error as XoError).code).toBe('bridge_not_available');
    expect((error as XoError).mayHaveLanded).toBe(false);
    expectNoRequest(rig.backend);
  });

  test('a session with no backend credential fails with AuthRequiredError, mayHaveLanded false, nothing claimed or sent', async () => {
    const rig = setup({ session: 'none' });
    const error = await caught(() => rig.bridge.withdraw(wquote()));
    expect(error).toBeInstanceOf(AuthRequiredError);
    expectUnlanded(error);
    expectNoRequest(rig.backend);
    expect(rig.rail.sent).toEqual([]);
  });
});

describe('bridge.withdraw: errors of the confirm (nothing is claimed or sent)', () => {
  test('409 quote_expired → 409 rejection with the paymentId, mayHaveLanded false, one request', async () => {
    const rig = setup();
    rig.backend.override('confirm', ({ request }) =>
      exceptionResponse(request.path, 409, {
        error: 'quote_expired',
        message: 'The quote expired',
      }),
    );

    const error = await caught(() => rig.bridge.withdraw(wquote()));

    expect(error).toSatisfy(rejectedWith(409));
    expect(expectUnlanded(error).code).toBe('quote_expired');
    expect(rig.backend.requests).toHaveLength(1);
    expectNothingMoved(rig);
  });

  test('404 payment_not_found → 404 rejection, mayHaveLanded false', async () => {
    const rig = setup();
    const error = await caught(() => rig.bridge.withdraw(wquote('pay_nope')));
    expect(error).toSatisfy(rejectedWith(404));
    expectUnlanded(error, 'pay_nope');
    expectNothingMoved(rig);
  });

  test.each([
    [
      '503 from the bridge provider',
      RequestRejectedError,
      (path: string) =>
        exceptionResponse(path, 503, {
          error: 'halliday_unavailable',
          message: 'down',
        }),
    ],
    [
      'a lost connection',
      TransportError,
      () => HttpResponse.error() as Response,
    ],
    [
      'an unreadable 2xx',
      UnexpectedResponseError,
      () => HttpResponse.json({ nonsense: true }),
    ],
  ])(
    '%s on the confirm → mayHaveLanded true with the paymentId, and no claim is made on a guess',
    async (_, cls, answer) => {
      const rig = setup();
      rig.backend.override('confirm', ({ request }) => answer(request.path));

      const error = await caught(() => rig.bridge.withdraw(wquote()));

      expect(error).toBeInstanceOf(cls);
      expect((error as XoError).mayHaveLanded).toBe(true);
      expect((error as XoError).paymentId).toBe('pay_w');
      expect(rig.backend.requests).toHaveLength(1);
      expectNothingMoved(rig);
    },
  );
});

describe('bridge.withdraw: what the confirm answered must be fundable (nothing is claimed or sent)', () => {
  /** Asserts the funding mismatch with a message that does not hold the deposit instructions. */
  function expectMismatch(
    rig: ReturnType<typeof setup>,
    error: unknown,
    paymentId = 'pay_w',
  ): TransactionFailedError {
    const tx = expectTransactionError(
      error,
      'bridge_funding_mismatch',
      false,
      paymentId,
    );
    expect(tx.message).not.toContain(DEPOSIT_ADDRESS);
    expectNothingMoved(rig);
    return tx;
  }

  test.each<[string, Record<string, unknown>]>([
    // Review Focus 2: what the deposit instructions say must be what the quote said.
    [
      'a deposit amount above the quote (5.1 for 5)',
      { deposit: depositOf({ amount: '5.1' }) },
    ],
    [
      'a deposit amount a hair above the quote (5.0000001)',
      { deposit: depositOf({ amount: '5.0000001' }) },
    ],
    [
      'a deposit amount below the quote (4.9)',
      { deposit: depositOf({ amount: '4.9' }) },
    ],
    ['a deposit amount of 0', { deposit: depositOf({ amount: '0' }) }],
    ['a negative deposit amount', { deposit: depositOf({ amount: '-5' }) }],
    [
      'a deposit amount below one micro-USDC (5e-7)',
      { deposit: depositOf({ amount: '5e-7' }) },
    ],
    ['a deposit on Base', { deposit: depositOf({ chain: 'base' }) }],
    ['a deposit with no chain', { deposit: depositOf({ chain: '' }) }],
    [
      'a token on another contract',
      {
        deposit: depositOf({
          token: 'xo:0x0000000000000000000000000000000000000001',
        }),
      },
    ],
    ['a token that is a symbol', { deposit: depositOf({ token: 'USDC' }) }],
    [
      'the right contract on another network',
      { deposit: depositOf({ token: `base:${USDC.toLowerCase()}` }) },
    ],
    [
      'an address that is not an address',
      { deposit: depositOf({ address: 'not-an-address' }) },
    ],
    [
      'an address that is too short',
      { deposit: depositOf({ address: '0x1234' }) },
    ],
    [
      'an address with a wrong checksum',
      { deposit: depositOf({ address: WRONG_CHECKSUM }) },
    ],
    [
      'the zero address',
      { deposit: depositOf({ address: `0x${'0'.repeat(40)}` }) },
    ],
    [
      'the USDC contract as the address',
      { deposit: depositOf({ address: USDC }) },
    ],
    // The payment itself.
    ['a payment that is a deposit', { direction: 'deposit' }],
    ['no deposit block', { deposit: null }],
    ['another payment id', { paymentId: 'pay_other' }],
    ['a payment id that differs only in case', { paymentId: 'PAY_W' }],
    ['a payment id that is not an id', { paymentId: '../assets' }],
  ])('%s → bridge_funding_mismatch, mayHaveLanded false', async (_, over) => {
    const rig = setup();
    seed(rig.backend, over);

    const error = await caught(() => rig.bridge.withdraw(wquote()));

    expectMismatch(rig, error);
    // The confirm was sent (that is where the answer came from); nothing else.
    expect(rig.backend.requests.map((r) => r.path)).toEqual([
      `${BASE}/payments`,
    ]);
  });

  test('a confirm answered with another paymentId is a mismatch for the paymentId asked for, before anything else is looked at', async () => {
    const rig = setup();
    rig.backend.override('confirm', () =>
      HttpResponse.json(withdrawal({ paymentId: 'pay_other' })),
    );
    const error = await caught(() => rig.bridge.withdraw(wquote()));
    const tx = expectMismatch(rig, error, 'pay_w');
    expect(tx.message).toMatch(/another payment/i);
  });

  test.each([
    'PROCESSING',
    'COMPLETE',
    'HALTED',
    'EXPIRED',
    'TAINTED',
    'A_STATUS_FROM_THE_FUTURE',
  ])(
    'a payment in %s cannot be funded: bridge_funding_mismatch names the status and says withdraw(quote) may be retried',
    async (status) => {
      const rig = setup();
      seed(rig.backend, { status });
      const error = await caught(() => rig.bridge.withdraw(wquote()));
      const tx = expectMismatch(rig, error);
      expect(tx.message).toContain(status);
      expect(tx.message).toMatch(/withdraw\(\{ quote \}\)/);
      expect(tx.message).toMatch(/idempotent/);
      expect(tx.message).toMatch(/retried/);
    },
  );

  test('a confirm answered with a payment that is still QUOTED is not fundable either', async () => {
    const rig = setup();
    rig.backend.override('confirm', () =>
      HttpResponse.json(withdrawal({ status: 'QUOTED', deposit: null })),
    );
    const error = await caught(() => rig.bridge.withdraw(wquote()));
    const tx = expectMismatch(rig, error);
    expect(tx.message).toContain('QUOTED');
  });

  test('CONFIRM_UNKNOWN (the backend confirm is still in flight; no deposit block) → bridge_funding_mismatch naming it, and withdraw(quote) may be retried', async () => {
    const rig = setup();
    seed(rig.backend, {
      status: 'CONFIRM_UNKNOWN',
      hallidayStatus: null,
      deposit: null,
      fundBy: null,
    });

    const error = await caught(() => rig.bridge.withdraw(wquote()));

    const tx = expectMismatch(rig, error);
    expect(tx.message).toContain('CONFIRM_UNKNOWN');
    expect(tx.message).toMatch(/retried/);
    // The retry works once the confirm has finished: same quote, same call.
    seed(rig.backend);
    const result = await rig.bridge.withdraw(wquote());
    expect(result.tx.status).toBe('success');
    expect(rig.rail.sent).toHaveLength(1);
  });

  test.each(['five', ''])(
    'a deposit amount of %j is not a decimal: the answer is unreadable (mayHaveLanded true, as for any confirm that cannot be read), and nothing is claimed or sent',
    async (amount) => {
      const rig = setup();
      seed(rig.backend, { deposit: depositOf({ amount }) });
      const error = await caught(() => rig.bridge.withdraw(wquote()));
      expect(error).toBeInstanceOf(UnexpectedResponseError);
      expect((error as XoError).mayHaveLanded).toBe(true);
      expect((error as XoError).paymentId).toBe('pay_w');
      expectNothingMoved(rig);
    },
  );

  test('the status a server invents is not echoed into the message when it is not a plain word', async () => {
    const rig = setup();
    seed(rig.backend, { status: 'x'.repeat(500) });
    const error = await caught(() => rig.bridge.withdraw(wquote()));
    const tx = expectMismatch(rig, error);
    expect(tx.message.length).toBeLessThan(600);
    expect(tx.message).not.toContain('x'.repeat(100));
  });
});

describe("bridge.withdraw: the payment must deliver to the quote's recipient (nothing is claimed or sent)", () => {
  /** A Solana address: base58 is case-sensitive, so its letter case is part of it. */
  const SOLANA = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';

  test.each<[string, Record<string, unknown>]>([
    [
      'another address',
      {
        recipient: '0x00000000000000000000000000000000000000B1',
        destinationAddress: '0x00000000000000000000000000000000000000B1',
      },
    ],
    ['no recipient (null)', { recipient: null }],
    ['the recipient with one more digit', { recipient: `${RECIPIENT}0` }],
  ])(
    'a confirmed payment with %s → bridge_funding_mismatch, mayHaveLanded false, before the balance read and the claim',
    async (_, over) => {
      const rig = setup();
      seed(rig.backend, over);

      const error = await caught(() => rig.bridge.withdraw(wquote()));

      const tx = expectTransactionError(
        error,
        'bridge_funding_mismatch',
        false,
      );
      expect(tx.message).toMatch(/recipient/);
      // Neither address is quoted.
      expect(tx.message).not.toContain(RECIPIENT);
      expect(tx.message).not.toContain('B1');
      expect(rig.backend.requests.map((r) => r.path)).toEqual([
        `${BASE}/payments`,
      ]);
      expect(balanceReads(rig)).toBe(0);
      expectNothingMoved(rig);
    },
  );

  test('an EVM recipient is the same address in any letter case (the backend checksums it)', async () => {
    const rig = setup();
    seed(rig.backend, { recipient: CHECKSUMMED });
    const result = await rig.bridge.withdraw(
      wquote('pay_w', { recipient: CHECKSUMMED.toLowerCase() }),
    );
    expect(result.tx.status).toBe('success');
    expect(rig.rail.sent).toHaveLength(1);
  });

  test('a recipient the caller padded with spaces is the one the backend stored trimmed', async () => {
    const rig = setup();
    seed(rig.backend, { recipient: SOLANA });
    const result = await rig.bridge.withdraw(
      wquote('pay_w', { recipient: `  ${SOLANA}\n` }),
    );
    expect(result.tx.status).toBe('success');
  });

  test('a recipient that is not an EVM address is compared exactly: another letter case is another address', async () => {
    const rig = setup();
    seed(rig.backend, { recipient: SOLANA.toLowerCase() });
    const error = await caught(() =>
      rig.bridge.withdraw(wquote('pay_w', { recipient: SOLANA })),
    );
    expectTransactionError(error, 'bridge_funding_mismatch', false);
    expectNothingMoved(rig);
  });

  test('quote → confirm → claim → send works end to end with the recipient the quote copied', async () => {
    const rig = setup();
    const { quotes } = await rig.bridge.quoteWithdraw({
      asset: BASE_USDC,
      amount: '5',
      recipient: RECIPIENT.toLowerCase(),
    });
    const chosen = quotes[0] as BridgeQuote;
    expect(chosen.recipient).toBe(RECIPIENT.toLowerCase());
    // The backend stores an EVM recipient checksummed.
    const row = rig.backend.payments.get(chosen.paymentId);
    rig.backend.payments.set(chosen.paymentId, {
      ...row,
      recipient: RECIPIENT,
    });
    const result = await rig.bridge.withdraw(chosen);
    expect(result.tx.status).toBe('success');
  });
});

describe('bridge.withdraw: verification before the funding', () => {
  test('NEEDS_VERIFICATION without a callback → verification_required (AuthRequiredError), mayHaveLanded false, nothing claimed or sent', async () => {
    const rig = setup();
    rig.backend.payments.set('pay_w', waiting());

    const error = await caught(() => rig.bridge.withdraw(wquote()));

    expect(error).toBeInstanceOf(AuthRequiredError);
    expect(expectUnlanded(error).code).toBe('verification_required');
    expectNothingMoved(rig);
  });

  test('a callback that approves, and a payment that is AWAITING_FUNDS after it → verification, then claim, then the one transfer', async () => {
    const rig = setup();
    rig.backend.payments.set('pay_w', waiting());
    rig.backend.override('verification', () => {
      const funded = withdrawal();
      rig.backend.payments.set('pay_w', funded);
      return HttpResponse.json(funded);
    });
    const verify = vi.fn(yes);

    const result = await rig.bridge.withdraw(wquote(), { verify });

    expect(verify).toHaveBeenCalledTimes(1);
    expect(rig.backend.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST ${BASE}/payments`,
      `POST ${BASE}/payments/pay_w/verification`,
      `POST ${CLAIM_PATH}`,
    ]);
    expect(rig.atSend).toHaveLength(1);
    expect(rig.rail.sent).toHaveLength(1);
    expect(result.tx.status).toBe('success');
  });

  test('a payment that is not AWAITING_FUNDS after the verification → bridge_funding_mismatch naming the status; nothing claimed or sent', async () => {
    const rig = setup();
    // The fake's verification moves the payment to PROCESSING.
    rig.backend.payments.set('pay_w', waiting());

    const error = await caught(() =>
      rig.bridge.withdraw(wquote(), { verify: yes }),
    );

    expect(error).toBeInstanceOf(TransactionFailedError);
    const tx = error as TransactionFailedError;
    expect(tx.code).toBe('bridge_funding_mismatch');
    expect(tx.mayHaveLanded).toBe(false);
    expect(tx.paymentId).toBe('pay_w');
    expect(tx.message).toContain('PROCESSING');
    expectNothingMoved(rig);
  });

  test('a verification answered for another payment is a mismatch: nothing claimed or sent', async () => {
    const rig = setup();
    rig.backend.payments.set('pay_w', waiting());
    rig.backend.override('verification', () =>
      HttpResponse.json(withdrawal({ paymentId: 'pay_other' })),
    );
    const error = await caught(() =>
      rig.bridge.withdraw(wquote(), { verify: yes }),
    );
    expectTransactionError(error, 'bridge_funding_mismatch', false, 'pay_w');
    expectNothingMoved(rig);
  });

  test.each<[string, Record<string, unknown>]>([
    [
      'another address',
      {
        recipient: '0x00000000000000000000000000000000000000B1',
        destinationAddress: '0x00000000000000000000000000000000000000B1',
      },
    ],
    ['no recipient (null)', { recipient: null }],
  ])(
    'a payment that waits for verification with %s as its recipient → bridge_funding_mismatch straight after the confirm: the callback is not asked and nothing is signed',
    async (_, over) => {
      const real = ownerSigner();
      const signMessage = vi.fn(real.signMessage);
      const signTypedData = vi.fn(real.signTypedData);
      const rig = setup({ signer: { ...real, signMessage, signTypedData } });
      rig.backend.payments.set('pay_w', waiting(over));
      const verify = vi.fn(yes);

      const error = await caught(() =>
        rig.bridge.withdraw(wquote(), { verify }),
      );

      const tx = expectTransactionError(
        error,
        'bridge_funding_mismatch',
        false,
      );
      expect(tx.message).toMatch(/recipient/);
      expect(verify).not.toHaveBeenCalled();
      expect(signMessage).not.toHaveBeenCalled();
      expect(signTypedData).not.toHaveBeenCalled();
      // The confirm and nothing after it: no verification POST, no balance read, no claim.
      expect(rig.backend.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        `POST ${BASE}/payments`,
      ]);
      expect(balanceReads(rig)).toBe(0);
      expectNothingMoved(rig);
    },
  );

  test('a payment that waits for verification and shows fundingClaimedAt → bridge_funding_claimed before anything is signed, whatever its recipient', async () => {
    const real = ownerSigner();
    const signMessage = vi.fn(real.signMessage);
    const rig = setup({ signer: { ...real, signMessage } });
    rig.backend.payments.set(
      'pay_w',
      waiting({
        fundingClaimedAt: '2026-10-21T12:00:00.000Z',
        recipient: '0x00000000000000000000000000000000000000B1',
      }),
    );
    const verify = vi.fn(yes);

    const error = await caught(() => rig.bridge.withdraw(wquote(), { verify }));

    expectTransactionError(error, 'bridge_funding_claimed', true);
    expect(verify).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
    expect(rig.backend.requests.map((r) => r.path)).toEqual([
      `${BASE}/payments`,
    ]);
    expectNothingMoved(rig);
  });

  test('a payment that waits for verification and delivers to the recipient in another letter case is verified as usual', async () => {
    const rig = setup();
    rig.backend.payments.set(
      'pay_w',
      waiting({ recipient: CHECKSUMMED, destinationAddress: CHECKSUMMED }),
    );
    rig.backend.override('verification', () => {
      const funded = withdrawal({
        recipient: CHECKSUMMED,
        destinationAddress: CHECKSUMMED,
      });
      rig.backend.payments.set('pay_w', funded);
      return HttpResponse.json(funded);
    });
    const verify = vi.fn(yes);

    const result = await rig.bridge.withdraw(
      wquote('pay_w', { recipient: CHECKSUMMED.toLowerCase() }),
      { verify },
    );

    expect(verify).toHaveBeenCalledTimes(1);
    expect(result.tx.status).toBe('success');
  });

  test('a callback that says no → verification_required; nothing claimed or sent', async () => {
    const rig = setup();
    rig.backend.payments.set('pay_w', waiting());
    const error = await caught(() =>
      rig.bridge.withdraw(wquote(), { verify: async () => false }),
    );
    expect(expectUnlanded(error).code).toBe('verification_required');
    expectNothingMoved(rig);
  });

  test('503 on the verification → mayHaveLanded true with the paymentId; no claim is made on a guess', async () => {
    const rig = setup();
    rig.backend.payments.set('pay_w', waiting());
    rig.backend.override('verification', ({ request }) =>
      exceptionResponse(request.path, 503, {
        error: 'halliday_unavailable',
        message: 'down',
      }),
    );
    const error = await caught(() =>
      rig.bridge.withdraw(wquote(), { verify: yes }),
    );
    expect(error).toSatisfy(serverFailure);
    expect((error as XoError).mayHaveLanded).toBe(true);
    expect((error as XoError).paymentId).toBe('pay_w');
    expectNothingMoved(rig);
  });
});

describe('bridge.withdraw: the balance is checked before the claim is used', () => {
  test('a balance below the amount → UserInputError insufficient_balance, mayHaveLanded false, the paymentId; no claim, no send', async () => {
    const rig = setup({ balanceMicro: 1_000_000n });
    seed(rig.backend);

    const error = await caught(() => rig.bridge.withdraw(wquote()));

    expect(error).toBeInstanceOf(UserInputError);
    const xo = expectUnlanded(error);
    expect(xo.code).toBe('insufficient_balance');
    expect(xo.service).toBe('sdk');
    expect(xo.message).toMatch(/nothing was claimed/i);
    // The confirm was sent; the claim was not.
    expect(rig.backend.requests.map((r) => r.path)).toEqual([
      `${BASE}/payments`,
    ]);
    expectNothingMoved(rig);
  });

  test('one micro-USDC short is short', async () => {
    const rig = setup({ balanceMicro: 4_999_999n });
    seed(rig.backend);
    const error = await caught(() => rig.bridge.withdraw(wquote()));
    expect(expectUnlanded(error).code).toBe('insufficient_balance');
    expectNothingMoved(rig);
  });

  test('a balance that cannot be read → chain_read_failed, mayHaveLanded false, the paymentId; no claim, no send', async () => {
    const rig = setup();
    seed(rig.backend);
    rig.chain.read = new Error('rpc down');

    const error = await caught(() => rig.bridge.withdraw(wquote()));

    expect(expectUnlanded(error).code).toBe('chain_read_failed');
    expectNothingMoved(rig);
  });

  test('an identity that cannot be resolved fails with its own class, the paymentId and mayHaveLanded false; no claim, no send', async () => {
    const rig = setup();
    seed(rig.backend);
    const down = new RequestRejectedError('the chain is down', {
      status: 503,
      code: 'chain_rpc_failed',
      service: 'chain',
    });
    const bridge = new BridgeClient({
      env: rig.env,
      transport: rig.transport,
      session: rig.session,
      identity: async () => {
        throw down;
      },
      signer: ownerSigner(),
      chain: rig.chain.reader,
      account: rig.account,
    });

    const error = await caught(() => bridge.withdraw(wquote()));

    expect(error).toSatisfy(serverFailure);
    expect(expectUnlanded(error).code).toBe('chain_rpc_failed');
    expectNothingMoved(rig);
  });
});

describe('bridge.withdraw: the claim answers (no send unless it succeeded)', () => {
  test('409 funding_already_claimed (another call claimed it after this one confirmed) → TransactionFailedError bridge_funding_claimed, mayHaveLanded true, the paymentId; nothing is sent', async () => {
    const rig = setup();
    // The confirm shows an unclaimed payment; the claim loses the race.
    seed(rig.backend);
    rig.backend.override('fundingClaim', ({ request }) =>
      exceptionResponse(request.path, 409, {
        error: 'funding_already_claimed',
        message: 'Funding for this payment was already claimed',
      }),
    );

    const error = await caught(() => rig.bridge.withdraw(wquote()));

    const tx = expectTransactionError(error, 'bridge_funding_claimed', true);
    expect(tx.message).toMatch(
      /fetchBridgePayment\(\{ paymentId: "pay_w" \}\)/,
    );
    expect((tx.cause as XoError).code).toBe('funding_already_claimed');
    expect(tx.transactionHash).toBeUndefined();
    expectClaimedNothingSent(rig);
  });

  test('bridge_funding_claimed says to reconcile an earlier transfer first, and to send by hand only if nothing went out (the advice of docs/errors.md)', async () => {
    const rig = setup();
    seed(rig.backend, { fundingClaimedAt: '2026-10-21T12:01:00.000Z' });

    const error = await caught(() => rig.bridge.withdraw(wquote()));

    const { message } = expectTransactionError(
      error,
      'bridge_funding_claimed',
      true,
    );
    expect(message).toMatch(/reconcile any earlier transfer first/);
    expect(message).toMatch(/have a receipt/);
    expect(message).toMatch(
      /nonce used by another transaction|its nonce was used/,
    );
    expect(message).toMatch(/transferErc20 only if nothing went out/);
    // The by-hand advice always asks for the instructions to be confirmed first.
    expect(message).toMatch(
      /its deposit instructions name XO's chain, XO USDC and exactly the quoted amount/,
    );
    // The advice goes by the status of a claimed payment.
    expect(message).toMatch(
      /PROCESSING or COMPLETE: [^.]*waitForBridgePayment\(\{ paymentId: "pay_w" \}\)/,
    );
    expect(message).toMatch(/HALTED: [^.]*recoveryUrl/);
    expect(message).toMatch(
      /EXPIRED: it was never funded[^.]*reconcile any earlier transfer that may still be pending/,
    );
    expect(message).toMatch(/TAINTED: [^.]*report the paymentId to XO/);
    expect(message).toMatch(
      /AWAITING_FUNDS: reconcile any earlier transfer first/,
    );
    expect(message).toMatch(/Never call withdraw\(\) again/);
    // The old advice sent by hand after a wait; a wait proves nothing about a pending transfer.
    expect(message).not.toMatch(/120 s/);
    expect(message).not.toMatch(/had its/);
    expectNothingMoved(rig);
  });

  test('a lost connection on the claim → bridge_funding_claimed, mayHaveLanded true; nothing is sent', async () => {
    const rig = setup();
    seed(rig.backend);
    rig.backend.override('fundingClaim', () => HttpResponse.error());

    const error = await caught(() => rig.bridge.withdraw(wquote()));

    const tx = expectTransactionError(error, 'bridge_funding_claimed', true);
    expect(tx.cause).toBeInstanceOf(TransportError);
    expectClaimedNothingSent(rig);
  });

  test('a claim that times out → bridge_funding_claimed, mayHaveLanded true; nothing is sent', async () => {
    const rig = setup();
    const transport = new Transport({
      env: rig.env,
      version: '9.9.9',
      maxRetries: 0,
      defaultTimeoutMs: 80,
    });
    transport.setAuth(rig.session);
    const bridge = new BridgeClient({
      env: rig.env,
      transport,
      session: rig.session,
      identity: async () => eoaIdentity(),
      signer: ownerSigner(),
      chain: rig.chain.reader,
      account: rig.account,
    });
    seed(rig.backend);
    rig.backend.override('fundingClaim', async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return HttpResponse.json(withdrawal({ fundingClaimedAt: 'x' }));
    });

    const error = await caught(() => bridge.withdraw(wquote()));

    const tx = expectTransactionError(error, 'bridge_funding_claimed', true);
    expect(tx.cause).toBeInstanceOf(TimeoutError);
    expectClaimedNothingSent(rig);
  });

  test.each([
    [
      '503 from the bridge provider',
      (path: string) =>
        exceptionResponse(path, 503, {
          error: 'halliday_unavailable',
          message: 'down',
        }),
    ],
    [
      '500 with no code',
      (path: string) =>
        exceptionResponse(path, 500, { error: 'boom', message: 'boom' }),
    ],
    [
      '502 from the bridge provider',
      (path: string) =>
        exceptionResponse(path, 502, {
          error: 'halliday_rejected',
          message: 'no',
        }),
    ],
    ['an unreadable 2xx', () => HttpResponse.json({ nonsense: true })],
    ['a 2xx that is not JSON', () => new Response('ok', { status: 200 })],
  ])(
    '%s on the claim → bridge_funding_claimed, mayHaveLanded true; nothing is sent',
    async (_, answer) => {
      const rig = setup();
      seed(rig.backend);
      rig.backend.override('fundingClaim', ({ request }) =>
        answer(request.path),
      );

      const error = await caught(() => rig.bridge.withdraw(wquote()));

      expectTransactionError(error, 'bridge_funding_claimed', true);
      expectClaimedNothingSent(rig);
    },
  );

  test('a 2xx whose payment does not show the claim (fundingClaimedAt null) is ambiguous → bridge_funding_claimed, mayHaveLanded true; nothing is sent', async () => {
    const rig = setup();
    seed(rig.backend);
    rig.backend.override('fundingClaim', () =>
      HttpResponse.json(withdrawal({ fundingClaimedAt: null })),
    );

    const error = await caught(() => rig.bridge.withdraw(wquote()));

    const tx = expectTransactionError(error, 'bridge_funding_claimed', true);
    expect(tx.message).toMatch(
      /fetchBridgePayment\(\{ paymentId: "pay_w" \}\)/,
    );
    expectClaimedNothingSent(rig);
  });

  test('a 2xx whose payment is another payment is ambiguous → bridge_funding_claimed, mayHaveLanded true, for the payment asked for; nothing is sent', async () => {
    const rig = setup();
    seed(rig.backend);
    rig.backend.override('fundingClaim', () =>
      HttpResponse.json(
        withdrawal({
          paymentId: 'pay_other',
          fundingClaimedAt: '2026-10-21T12:01:00.000Z',
        }),
      ),
    );

    const error = await caught(() => rig.bridge.withdraw(wquote()));

    expectTransactionError(error, 'bridge_funding_claimed', true, 'pay_w');
    expectClaimedNothingSent(rig);
  });

  const notAwaiting = (path: string) =>
    exceptionResponse(path, 409, {
      error: 'payment_not_awaiting_funds',
      message: 'The payment is not awaiting funds',
    });
  const CLAIMED_AT = '2026-10-21T12:01:00.000Z';
  const CLAIM_THEN_READ = [
    `POST ${BASE}/payments`,
    `POST ${CLAIM_PATH}`,
    `GET ${BASE}/payments/pay_w`,
  ];
  const calls = (backend: BridgeBackend) =>
    backend.requests.map((r) => `${r.method} ${r.path}`);

  test('409 payment_not_awaiting_funds, and the payment read after it shows no claim → 409 rejection with its code, mayHaveLanded false, the paymentId; nothing is sent', async () => {
    const rig = setup();
    seed(rig.backend);
    rig.backend.override('fundingClaim', ({ request }) =>
      notAwaiting(request.path),
    );

    const error = await caught(() => rig.bridge.withdraw(wquote()));

    expect(error).toSatisfy(rejectedWith(409));
    const xo = expectUnlanded(error);
    expect(xo.code).toBe('payment_not_awaiting_funds');
    expect(xo.status).toBe(409);
    // One read of the payment, to see whether another call claimed it.
    expect(calls(rig.backend)).toEqual(CLAIM_THEN_READ);
    expectClaimedNothingSent(rig);
  });

  test.each(['PROCESSING', 'COMPLETE', 'AWAITING_FUNDS'])(
    '409 payment_not_awaiting_funds for a payment another call claimed meanwhile (%s when read) → bridge_funding_claimed, mayHaveLanded true, the 409 as cause; nothing is sent',
    async (status) => {
      const rig = setup();
      seed(rig.backend);
      rig.backend.override('fundingClaim', ({ request }) => {
        // Another process claimed (and maybe funded) it between this call's confirm and its claim.
        rig.backend.payments.set(
          'pay_w',
          withdrawal({ status, fundingClaimedAt: CLAIMED_AT }),
        );
        return notAwaiting(request.path);
      });

      const error = await caught(() => rig.bridge.withdraw(wquote()));

      const tx = expectTransactionError(error, 'bridge_funding_claimed', true);
      expect(tx.cause).toSatisfy(rejectedWith(409));
      expect((tx.cause as XoError).code).toBe('payment_not_awaiting_funds');
      expect(tx.message).toMatch(
        /fetchBridgePayment\(\{ paymentId: "pay_w" \}\)/,
      );
      expect(calls(rig.backend)).toEqual(CLAIM_THEN_READ);
      expectClaimedNothingSent(rig);
    },
  );

  test.each([
    [
      'a 503',
      (path: string) =>
        exceptionResponse(path, 503, {
          error: 'halliday_unavailable',
          message: 'down',
        }),
    ],
    ['a lost connection', () => HttpResponse.error() as Response],
    [
      'a 404',
      (path: string) =>
        exceptionResponse(path, 404, {
          error: 'payment_not_found',
          message: 'Payment not found',
        }),
    ],
    [
      'an answer for another payment',
      () =>
        HttpResponse.json(
          withdrawal({ paymentId: 'pay_other', fundingClaimedAt: CLAIMED_AT }),
        ),
    ],
  ])(
    '409 payment_not_awaiting_funds, and the read after it fails (%s) → the 409 as it was: 409 rejection, mayHaveLanded false, the paymentId; nothing is sent',
    async (_, answer) => {
      const rig = setup();
      seed(rig.backend);
      rig.backend.override('fundingClaim', ({ request }) =>
        notAwaiting(request.path),
      );
      rig.backend.override('payment', ({ request }) => answer(request.path));

      const error = await caught(() => rig.bridge.withdraw(wquote()));

      expect(error).toSatisfy(rejectedWith(409));
      const xo = expectUnlanded(error);
      expect(xo.code).toBe('payment_not_awaiting_funds');
      expect(xo.status).toBe(409);
      expect(xo.cause).toBeUndefined();
      expect(calls(rig.backend)).toEqual(CLAIM_THEN_READ);
      expectClaimedNothingSent(rig);
    },
  );

  test('the fund-by guard of the backend (a deadline within 10 minutes) is payment_not_awaiting_funds too: a refusal, nothing sent', async () => {
    const rig = setup();
    seed(rig.backend, {
      fundBy: new Date(Date.now() + FUND_BY_GUARD_MS / 2).toISOString(),
    });

    const error = await caught(() => rig.bridge.withdraw(wquote()));

    expect(error).toSatisfy(rejectedWith(409));
    expect(expectUnlanded(error).code).toBe('payment_not_awaiting_funds');
    expectClaimedNothingSent(rig);
  });

  test.each([
    [
      '400 not_a_withdrawal',
      RequestRejectedError,
      400,
      'not_a_withdrawal',
      'Only a withdrawal is funded by its owner',
    ],
    [
      '404 payment_not_found',
      RequestRejectedError,
      404,
      'payment_not_found',
      'Payment not found',
    ],
    [
      '429 with a code',
      RateLimitError,
      429,
      'rate_limited',
      'Too many requests',
    ],
  ])(
    '%s → that error with its code, mayHaveLanded false; nothing is sent',
    async (_, cls, status, code, message) => {
      const rig = setup();
      seed(rig.backend);
      rig.backend.override('fundingClaim', ({ request }) =>
        exceptionResponse(request.path, status, { error: code, message }),
      );

      const error = await caught(() => rig.bridge.withdraw(wquote()));

      expect(error).toBeInstanceOf(cls);
      expect(expectUnlanded(error).code).toBe(code);
      expectClaimedNothingSent(rig);
    },
  );
});

describe('bridge.withdraw: exactly one transfer', () => {
  test('a second withdraw(quote) after a success claims nothing new and sends nothing: bridge_funding_claimed, one send in all', async () => {
    const rig = setup();
    seed(rig.backend);

    const first = await rig.bridge.withdraw(wquote());
    expect(first.tx.status).toBe('success');
    const second = await caught(() => rig.bridge.withdraw(wquote()));

    expectTransactionError(second, 'bridge_funding_claimed', true);
    expect(rig.rail.sent).toHaveLength(1);
    // The second call saw `fundingClaimedAt` on the confirmed payment and stopped: one claim.
    expect(claims(rig.backend)).toHaveLength(1);
  });

  test('two withdraw(quote) calls at the same time: one claim wins and sends, the other is bridge_funding_claimed; one send in all', async () => {
    const rig = setup();
    seed(rig.backend);

    const settled = await Promise.allSettled([
      rig.bridge.withdraw(wquote()),
      rig.bridge.withdraw(wquote()),
    ]);

    const won = settled.filter((s) => s.status === 'fulfilled');
    const lost = settled.filter((s) => s.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expectTransactionError(
      (lost[0] as PromiseRejectedResult).reason,
      'bridge_funding_claimed',
      true,
    );
    expect(rig.rail.sent).toHaveLength(1);
  });

  test('a withdraw whose transfer failed is not made again by a second call: the claim is used', async () => {
    const rig = setup();
    seed(rig.backend);
    rig.rail.answer = new TransactionFailedError('no receipt', {
      code: 'receipt_timeout',
      mayHaveLanded: true,
      transactionHash: TX_HASH,
    });
    await caught(() => rig.bridge.withdraw(wquote()));
    rig.rail.answer = { txHash: TX_HASH, status: 'success', blockNumber: 1n };

    const readsBefore = balanceReads(rig);

    const again = await caught(() => rig.bridge.withdraw(wquote()));

    expectTransactionError(again, 'bridge_funding_claimed', true);
    expect(rig.rail.sent).toHaveLength(1);
    // The second call confirmed, saw the claim, and stopped: no balance read, no second claim.
    expect(balanceReads(rig)).toBe(readsBefore);
    expect(claims(rig.backend)).toHaveLength(1);
  });
});

describe('bridge.withdraw: a payment whose funding an earlier call claimed goes straight to reconcile (S-N)', () => {
  const CLAIMED_AT = '2026-10-21T12:01:00.000Z';

  test('a confirm answer that shows fundingClaimedAt → bridge_funding_claimed, mayHaveLanded true, the paymentId; no balance read, no claim request, no send', async () => {
    const rig = setup();
    seed(rig.backend, { fundingClaimedAt: CLAIMED_AT });

    const error = await caught(() => rig.bridge.withdraw(wquote()));

    const tx = expectTransactionError(error, 'bridge_funding_claimed', true);
    expect(tx.message).toMatch(
      /fetchBridgePayment\(\{ paymentId: "pay_w" \}\)/,
    );
    expect(tx.message).toMatch(/reconcile any earlier transfer first/);
    expect(tx.message).not.toContain(DEPOSIT_ADDRESS);
    // The confirm was sent, and nothing after it.
    expect(rig.backend.requests.map((r) => r.path)).toEqual([
      `${BASE}/payments`,
    ]);
    expect(balanceReads(rig)).toBe(0);
    expectNothingMoved(rig);
  });

  test('after a first transfer that took the USDC, a repeated withdraw() is bridge_funding_claimed, not insufficient_balance: the first transfer may be on chain', async () => {
    const rig = setup();
    seed(rig.backend);
    rig.rail.answer = new TransactionFailedError('no receipt', {
      code: 'receipt_timeout',
      mayHaveLanded: true,
      transactionHash: TX_HASH,
    });
    const first = await caught(() => rig.bridge.withdraw(wquote()));
    expectTransactionError(first, 'receipt_timeout', true);
    // The transaction was mined after all: the wallet no longer holds the 5 USDC.
    rig.chain.balanceMicro = 0n;
    const readsBefore = balanceReads(rig);

    const again = await caught(() => rig.bridge.withdraw(wquote()));

    const tx = expectTransactionError(again, 'bridge_funding_claimed', true);
    expect(tx.code).not.toBe('insufficient_balance');
    expect(tx.message).toMatch(/reconcile any earlier transfer first/);
    expect(balanceReads(rig)).toBe(readsBefore);
    expect(claims(rig.backend)).toHaveLength(1);
    expect(rig.rail.sent).toHaveLength(1);
  });

  test.each([
    'AWAITING_FUNDS',
    'PROCESSING',
    'COMPLETE',
    'HALTED',
    'EXPIRED',
    'TAINTED',
    'A_STATUS_FROM_THE_FUTURE',
  ])(
    'a claimed payment in %s is bridge_funding_claimed, never bridge_funding_mismatch (which says nothing was claimed)',
    async (status) => {
      const rig = setup();
      seed(rig.backend, { status, fundingClaimedAt: CLAIMED_AT });

      const error = await caught(() => rig.bridge.withdraw(wquote()));

      expectTransactionError(error, 'bridge_funding_claimed', true);
      expect(balanceReads(rig)).toBe(0);
      expectNothingMoved(rig);
    },
  );

  test("an answer for another payment is still refused as that: the claim shown is not this payment's", async () => {
    const rig = setup();
    rig.backend.override('confirm', () =>
      HttpResponse.json(
        withdrawal({ paymentId: 'pay_other', fundingClaimedAt: CLAIMED_AT }),
      ),
    );

    const error = await caught(() => rig.bridge.withdraw(wquote()));

    const tx = expectTransactionError(error, 'bridge_funding_mismatch', false);
    expect(tx.message).toMatch(/another payment/i);
    expectNothingMoved(rig);
  });

  test('a payment that is not claimed (fundingClaimedAt null) is funded as before', async () => {
    const rig = setup();
    seed(rig.backend, { fundingClaimedAt: null });

    const result = await rig.bridge.withdraw(wquote());

    expect(result.tx.status).toBe('success');
    expect(claims(rig.backend)).toHaveLength(1);
    expect(rig.rail.sent).toHaveLength(1);
  });
});

describe('bridge.withdraw: the transfer', () => {
  test('a rail error comes out as it is, with the paymentId: receipt_timeout, mayHaveLanded true and its txHash; the transfer is not retried', async () => {
    const rig = setup();
    seed(rig.backend);
    const railError = new TransactionFailedError('no receipt in 120 s', {
      code: 'receipt_timeout',
      mayHaveLanded: true,
      transactionHash: TX_HASH,
      nonce: 7n,
    });
    rig.rail.answer = railError;

    const error = await caught(() => rig.bridge.withdraw(wquote()));

    expect(error).toBe(railError);
    const tx = expectTransactionError(error, 'receipt_timeout', true);
    expect(tx.transactionHash).toBe(TX_HASH);
    expect(tx.nonce).toBe(7n);
    expect(tx.message).toBe('no receipt in 120 s');
    // One claim, one send, nothing more.
    expect(claims(rig.backend)).toHaveLength(1);
    expect(rig.rail.sent).toHaveLength(1);
  });

  test('a rail error that was not sent keeps its flag (false) and gains the paymentId', async () => {
    const rig = setup();
    seed(rig.backend);
    rig.rail.answer = new TransactionFailedError('node refused', {
      code: 'rejected_by_node',
      mayHaveLanded: false,
    });
    const error = await caught(() => rig.bridge.withdraw(wquote()));
    expectTransactionError(error, 'rejected_by_node', false);
    expect(rig.rail.sent).toHaveLength(1);
  });

  test('an XoError from the transfer that has no flag is given mayHaveLanded true: the claim is used, so nothing is known', async () => {
    const rig = setup();
    seed(rig.backend);
    const odd = new XoError('odd');
    rig.rail.answer = odd;
    const error = await caught(() => rig.bridge.withdraw(wquote()));
    expect(error).toBe(odd);
    expect((error as XoError).mayHaveLanded).toBe(true);
    expect((error as XoError).paymentId).toBe('pay_w');
  });

  test('an error that is not an XoError becomes TransactionFailedError send_failed with mayHaveLanded true and the paymentId: the claim is used, so nothing is known; its message is not copied', async () => {
    const rig = setup();
    seed(rig.backend);
    rig.rail.answer = new Error('rpc https://node.example/?key=SECRET-123');

    const error = await caught(() => rig.bridge.withdraw(wquote()));

    const tx = expectTransactionError(error, 'send_failed', true);
    expect(tx.cause).toBeUndefined();
    expect(JSON.stringify(tx.toJSON())).not.toContain('SECRET-123');
    expect(tx.message).toMatch(
      /fetchBridgePayment\(\{ paymentId: "pay_w" \}\)/,
    );
    expect(tx.message).toMatch(/cannot send twice/);
    expect(rig.rail.sent).toHaveLength(1);
    expect(claims(rig.backend)).toHaveLength(1);
  });

  test('a plain error from the account client after the claim (its identity() throws) is send_failed, true, with the paymentId; nothing is sent', async () => {
    const rig = setup();
    seed(rig.backend);
    // The bridge client's own identity works; the account client's fails once the claim is made.
    const account = new AccountClient({
      env: rig.env,
      identity: async () => {
        if (claims(rig.backend).length > 0) {
          throw new Error('identity lookup failed');
        }
        return eoaIdentity();
      },
      chain: rig.chain.reader,
      orderbook: {
        getPositions: () => Promise.reject(new Error('unused')),
        getMarketCapacity: () => Promise.reject(new Error('unused')),
        getClaimable: () => Promise.reject(new Error('unused')),
      },
      rail: rig.rail,
    });
    const bridge = new BridgeClient({
      env: rig.env,
      transport: rig.transport,
      session: rig.session,
      identity: async () => eoaIdentity(),
      signer: ownerSigner(),
      chain: rig.chain.reader,
      account,
    });

    const error = await caught(() => bridge.withdraw(wquote()));

    expectTransactionError(error, 'send_failed', true);
    expect(claims(rig.backend)).toHaveLength(1);
    expect(rig.rail.sent).toEqual([]);
  });

  test('a reverted transfer is a result, not an error: tx.status is reverted, the claimed payment comes with it', async () => {
    const rig = setup();
    seed(rig.backend);
    rig.rail.answer = { txHash: TX_HASH, status: 'reverted', blockNumber: 9n };

    const result = await rig.bridge.withdraw(wquote());

    expect(result.tx).toEqual({
      txHash: TX_HASH,
      status: 'reverted',
      blockNumber: 9n,
    });
    expect(result.payment.fundingClaimedAt).toEqual(expect.any(String));
    expect(rig.rail.sent).toHaveLength(1);
  });
});

describe('bridge.withdraw: the rail is checked before the quote is confirmed', () => {
  const unused = {
    getPositions: () => Promise.reject(new Error('unused')),
    getMarketCapacity: () => Promise.reject(new Error('unused')),
    getClaimable: () => Promise.reject(new Error('unused')),
  };

  /**
   * A client over a real `SessionRail` (as the secure client builds it), whose `send` is
   * replaced by a spy that logs how many claims the fake had seen when it was called.
   */
  function withSessionRail(
    rig: ReturnType<typeof setup>,
    o: {
      kind: RailKind;
      env?: EnvironmentConfig;
      /**
       * The environment of the SessionRail alone, when it is not `env`: the rail's choice and
       * its check follow it, while the account and the bridge keep the rig's chain and USDC.
       */
      railEnv?: EnvironmentConfig;
      identity?: TradingIdentity;
      railSigner?: InternalSigner;
      isOpen?: () => boolean;
    },
  ) {
    const accountEnv = o.env ?? rig.env;
    const railEnv = o.railEnv ?? accountEnv;
    const identity = async () => o.identity ?? eoaIdentity();
    const rail = new SessionRail({
      kind: o.kind,
      env: railEnv,
      identity,
      isOpen: o.isOpen ?? (() => true),
      signer: o.railSigner ?? ownerSigner(),
      chain: rig.chain.reader,
      transport: rig.transport,
    });
    const claimsAtSend: number[] = [];
    const send = vi.spyOn(rail, 'send').mockImplementation(async () => {
      claimsAtSend.push(claims(rig.backend).length);
      return { txHash: TX_HASH, status: 'success', blockNumber: 1n };
    });
    const account = new AccountClient({
      env: accountEnv,
      identity,
      chain: rig.chain.reader,
      orderbook: unused,
      rail,
    });
    const bridge = new BridgeClient({
      env: rig.env,
      transport: rig.transport,
      session: rig.session,
      identity,
      signer: ownerSigner(),
      chain: rig.chain.reader,
      account,
    });
    return { bridge, send, claimsAtSend };
  }

  function expectRefusedUpFront(
    rig: ReturnType<typeof setup>,
    error: unknown,
    send: unknown,
    code: string,
  ): XoError {
    expect(error).toBeInstanceOf(UserInputError);
    const xo = error as XoError;
    expect(xo.code).toBe(code);
    expect(xo.mayHaveLanded).toBe(false);
    // Not one request to the bridge: not even the confirm. And no send.
    expectNoRequest(rig.backend);
    expect(send).not.toHaveBeenCalled();
    return xo;
  }

  test('the sponsored rail of an environment with no sponsorUrl: sponsor_not_configured, mayHaveLanded false, no confirm, no claim, no send', async () => {
    const rig = setup();
    seed(rig.backend);
    const { sponsorUrl: _omitted, ...rest } = rig.env;
    const { bridge, send } = withSessionRail(rig, {
      kind: 'sponsored',
      env: rest as EnvironmentConfig,
    });

    const error = await caught(() => bridge.withdraw(wquote()));

    const xo = expectRefusedUpFront(rig, error, send, 'sponsor_not_configured');
    expect(xo.service).toBe('sponsor');
  });

  test('the automatic rail of an EOA on an environment with no sponsor is the sponsored rail: sponsor_not_configured, mayHaveLanded false, no confirm, no claim, no send', async () => {
    const rig = setup();
    seed(rig.backend);
    // A custom environment: mainnet's fields without its sponsor.
    const { sponsorUrl: _mainnetSponsor, ...mainnetFields } = production;
    const { bridge, send } = withSessionRail(rig, {
      kind: 'auto',
      env: { ...mainnetFields, name: 'mainnet-no-sponsor' },
    });

    const error = await caught(() => bridge.withdraw(wquote()));

    const xo = expectRefusedUpFront(rig, error, send, 'sponsor_not_configured');
    expect(xo.service).toBe('sponsor');
  });

  test.each([
    ['a plain wallet', eoaIdentity()],
    ['a smart wallet', smartWalletIdentity()],
  ])(
    "the automatic rail of %s on mainnet is mainnet's sponsor: it passes the check, and the claim is made before the one send",
    async (_, identity) => {
      const rig = setup();
      seed(rig.backend);
      const { bridge, send, claimsAtSend } = withSessionRail(rig, {
        kind: 'auto',
        railEnv: production,
        identity,
      });

      const result = await bridge.withdraw(wquote());

      expect(result.tx.status).toBe('success');
      expect(send).toHaveBeenCalledTimes(1);
      expect(claimsAtSend).toEqual([1]);
      expect(rig.backend.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        `POST ${BASE}/payments`,
        `POST ${CLAIM_PATH}`,
      ]);
      // The whole chain log: the sponsored rail's check reads the owner's two nonces, and
      // nothing else; then the bridge's balance check and the transfer's own balance read.
      const balanceRead = {
        method: 'readContract',
        args: [
          {
            to: USDC,
            data: `0x70a08231${'0'.repeat(24)}${identity.address.slice(2).toLowerCase()}`,
          },
        ],
      };
      expect(rig.chain.log).toEqual([
        { method: 'getNonce', args: [OWNER, 'latest'] },
        { method: 'getNonce', args: [OWNER, 'pending'] },
        balanceRead,
        balanceRead,
      ]);
    },
  );

  describe("the sponsored rail's pre-claim guard: an earlier transaction of the owner that may still land", () => {
    afterEach(() => resetNonceTracking());

    /** A refusal of the guard: nothing confirmed, nothing claimed, no send. */
    function expectHeldBack(
      rig: ReturnType<typeof setup>,
      error: unknown,
      send: unknown,
      code: string,
    ): XoError {
      expect(error).toBeInstanceOf(TransactionFailedError);
      const xo = error as XoError;
      expect(xo.code).toBe(code);
      expect(xo.mayHaveLanded).toBe(false);
      // Not one request to the bridge: no confirm (POST /payments), no claim. And no send.
      expectNoRequest(rig.backend);
      expect(send).not.toHaveBeenCalled();
      return xo;
    }

    test('a transaction of the owner in the mempool (pending above latest): previous_operation_pending, before the confirm and the claim', async () => {
      const rig = setup();
      seed(rig.backend);
      rig.chain.latestNonce = 5n;
      rig.chain.nonce = 6n;
      const { bridge, send } = withSessionRail(rig, { kind: 'sponsored' });

      const error = await caught(() => bridge.withdraw(wquote()));

      const xo = expectHeldBack(rig, error, send, 'previous_operation_pending');
      expect(xo).toMatchObject({ nonce: 5n });
      expect(xo.message).toContain(OWNER);
    });

    test('an earlier send of this process that ended sponsor_outcome_unknown and has not landed: previous_operation_pending, before the confirm and the claim', async () => {
      const rig = setup();
      seed(rig.backend);
      server.use(
        mswHttp.post(`${rig.env.sponsorUrl}/v1/sponsor/send`, () =>
          HttpResponse.json({ error: 'down' }, { status: 503 }),
        ),
      );
      const earlier = new SponsoredRail({
        env: rig.env,
        identity: eoaIdentity(),
        signer: ownerSigner(),
        chain: rig.chain.reader,
        transport: rig.transport,
      });
      const unknown = await caught(() =>
        earlier.send([{ to: USDC, data: transferCalldata(RECIPIENT, 1n) }]),
      );
      expect(unknown).toMatchObject({
        code: 'sponsor_outcome_unknown',
        mayHaveLanded: true,
      });
      const { bridge, send } = withSessionRail(rig, { kind: 'sponsored' });

      const error = await caught(() => bridge.withdraw(wquote()));

      expectHeldBack(rig, error, send, 'previous_operation_pending');
    });

    test('it passes when latest and pending are equal and the process handed nothing over that has not landed', async () => {
      const rig = setup();
      seed(rig.backend);
      rig.chain.latestNonce = 5n;
      rig.chain.nonce = 5n;
      const { bridge, send, claimsAtSend } = withSessionRail(rig, {
        kind: 'sponsored',
      });

      await bridge.withdraw(wquote());

      expect(send).toHaveBeenCalledTimes(1);
      expect(claimsAtSend).toEqual([1]);
    });

    test('a nonce read that fails refuses with chain_read_failed, before the confirm and the claim', async () => {
      const rig = setup();
      seed(rig.backend);
      rig.chain.latestNonce = new Error('rpc down');
      const { bridge, send } = withSessionRail(rig, { kind: 'sponsored' });

      const error = await caught(() => bridge.withdraw(wquote()));

      expectHeldBack(rig, error, send, 'chain_read_failed');
    });
  });

  test('the direct rail with a smart wallet: direct_rail_eoa_only, mayHaveLanded false, no confirm, no claim, no send', async () => {
    const rig = setup();
    seed(rig.backend);
    const { bridge, send } = withSessionRail(rig, {
      kind: 'direct',
      identity: smartWalletIdentity(),
    });

    const error = await caught(() => bridge.withdraw(wquote()));

    expectRefusedUpFront(rig, error, send, 'direct_rail_eoa_only');
  });

  test('an account client with no rail: rail_not_configured, mayHaveLanded false, no confirm, no claim', async () => {
    const rig = setup();
    seed(rig.backend);
    const account = new AccountClient({
      env: rig.env,
      identity: async () => eoaIdentity(),
      chain: rig.chain.reader,
      orderbook: unused,
    });
    const bridge = new BridgeClient({
      env: rig.env,
      transport: rig.transport,
      session: rig.session,
      identity: async () => eoaIdentity(),
      signer: ownerSigner(),
      chain: rig.chain.reader,
      account,
    });

    const error = await caught(() => bridge.withdraw(wquote()));

    expect(error).toBeInstanceOf(UserInputError);
    expect((error as XoError).code).toBe('rail_not_configured');
    expect((error as XoError).mayHaveLanded).toBe(false);
    expectNoRequest(rig.backend);
  });

  test('a closed client: session_closed, mayHaveLanded false, no confirm, no claim, no send', async () => {
    const rig = setup();
    seed(rig.backend);
    const { bridge, send } = withSessionRail(rig, {
      kind: 'sponsored',
      isOpen: () => false,
    });
    const error = await caught(() => bridge.withdraw(wquote()));
    expect((error as XoError).code).toBe('session_closed');
    expect((error as XoError).mayHaveLanded).toBe(false);
    expectNoRequest(rig.backend);
    expect(send).not.toHaveBeenCalled();
  });

  test('a rail whose signer is not the owner of the identity: signer_mismatch, no confirm, no claim, no send', async () => {
    const rig = setup();
    seed(rig.backend);
    const { bridge, send } = withSessionRail(rig, {
      kind: 'direct',
      railSigner: keySigner(`0x${'22'.repeat(32)}`),
    });
    const error = await caught(() => bridge.withdraw(wquote()));
    expectRefusedUpFront(rig, error, send, 'signer_mismatch');
  });

  test('a rail whose signer cannot sign a digest: sign_hash_unsupported, no confirm, no claim, no send', async () => {
    const rig = setup();
    seed(rig.backend);
    const { bridge, send } = withSessionRail(rig, {
      kind: 'sponsored',
      railSigner: noRawSigner(),
    });
    const error = await caught(() => bridge.withdraw(wquote()));
    expect(error).toBeInstanceOf(SigningError);
    expect((error as XoError).code).toBe('sign_hash_unsupported');
    expect((error as XoError).mayHaveLanded).toBe(false);
    expectNoRequest(rig.backend);
    expect(send).not.toHaveBeenCalled();
  });

  test.each([
    ['sponsored', 'the sponsored rail with a sponsorUrl and an EOA'],
    ['direct', 'the direct rail with an EOA'],
  ] as const)(
    '%s: %s passes the check, and the claim is made before the one send',
    async (kind, _why) => {
      const rig = setup();
      seed(rig.backend);
      const { bridge, send, claimsAtSend } = withSessionRail(rig, { kind });

      const result = await bridge.withdraw(wquote());

      expect(result.tx.status).toBe('success');
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith([
        {
          to: USDC,
          data: transferCalldata(DEPOSIT_ADDRESS, 5_000_000n),
          value: 0n,
        },
      ]);
      // The confirm and the claim were made, in that order, before the send.
      expect(claimsAtSend).toEqual([1]);
      expect(rig.backend.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        `POST ${BASE}/payments`,
        `POST ${CLAIM_PATH}`,
      ]);
    },
  );

  test('a smart wallet on the sponsored rail passes the check', async () => {
    const rig = setup();
    seed(rig.backend);
    const { bridge, send } = withSessionRail(rig, {
      kind: 'sponsored',
      identity: smartWalletIdentity(),
    });
    await bridge.withdraw(wquote());
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('bridge.withdraw: the claim answer is read for what it is needed for', () => {
  /** The stored payment as the claim answers it, with `over` changed and `drop` removed. */
  const claimAnswer = (
    over: Record<string, unknown> = {},
    drop: string[] = [],
  ) => {
    const answer: Record<string, unknown> = {
      ...withdrawal({ fundingClaimedAt: '2026-10-21T12:01:00.000Z' }),
      ...over,
    };
    for (const key of drop) {
      delete answer[key];
    }
    return answer;
  };

  test.each([
    ['fees', ['fees']],
    ['createdAt and updatedAt', ['createdAt', 'updatedAt']],
    [
      'recoveryUrl, the provider status and verification',
      ['recoveryUrl', 'hallidayStatus', 'verification'],
    ],
    [
      'everything but the three fields the call reads',
      [
        'direction',
        'status',
        'hallidayStatus',
        'input',
        'output',
        'fees',
        'ownerAddress',
        'destinationAddress',
        'recipient',
        'acceptBy',
        'fundBy',
        'verification',
        'fundingTxHash',
        'deliveryTxHash',
        'recoveryUrl',
        'createdAt',
        'updatedAt',
        'completedAt',
      ],
    ],
  ])(
    'a 200 claim answer without %s still sends once: the claim is used, so the transfer is not given up for a field the call does not read',
    async (_, drop) => {
      const rig = setup();
      seed(rig.backend);
      rig.backend.override('fundingClaim', () =>
        HttpResponse.json(claimAnswer({}, drop)),
      );

      const result = await rig.bridge.withdraw(wquote());

      expect(rig.rail.sent).toHaveLength(1);
      expect(result.tx.status).toBe('success');
      // The payment is the confirmed one with the claim's time, a complete BridgePayment.
      expect(result.payment.fundingClaimedAt).toBe('2026-10-21T12:01:00.000Z');
      expect(result.payment.status).toBe('AWAITING_FUNDS');
      expect(result.payment.fees).toEqual(withdrawal().fees);
      expect(result.payment.deposit?.address).toBe(DEPOSIT_ADDRESS);
    },
  );

  test('with strictResponses a claim answer with a field the SDK does not know still sends once', async () => {
    const rig = setup({ strict: true });
    seed(rig.backend);
    rig.backend.override('fundingClaim', () =>
      HttpResponse.json(claimAnswer({ somethingNew: { nested: true } })),
    );

    const result = await rig.bridge.withdraw(wquote());

    expect(rig.rail.sent).toHaveLength(1);
    expect(result.payment.fundingClaimedAt).toBe('2026-10-21T12:01:00.000Z');
  });

  test('a claim answer that is complete is returned as it is', async () => {
    const rig = setup();
    seed(rig.backend);
    const answer = claimAnswer({ updatedAt: '2026-10-21T12:01:00.000Z' });
    rig.backend.override('fundingClaim', () => HttpResponse.json(answer));
    const result = await rig.bridge.withdraw(wquote());
    expect(result.payment).toEqual(answer);
  });

  test.each([
    ['without paymentId', ['paymentId']],
    ['without fundingClaimedAt', ['fundingClaimedAt']],
  ])(
    'a claim answer %s cannot be read: bridge_funding_claimed, true; nothing is sent',
    async (_, drop) => {
      const rig = setup();
      seed(rig.backend);
      rig.backend.override('fundingClaim', () =>
        HttpResponse.json(claimAnswer({}, drop)),
      );
      const error = await caught(() => rig.bridge.withdraw(wquote()));
      expectTransactionError(error, 'bridge_funding_claimed', true);
      expectClaimedNothingSent(rig);
    },
  );
});

describe('bridge.withdraw: the claim answer must show the deposit that was checked', () => {
  const claimed = (deposit: unknown) =>
    withdrawal({ fundingClaimedAt: '2026-10-21T12:01:00.000Z', deposit });

  test.each<[string, unknown]>([
    ['no deposit (null)', null],
    ['a different address', depositOf({ address: CHECKSUMMED })],
    ['a larger amount', depositOf({ amount: '5.1' })],
    ['a smaller amount', depositOf({ amount: '4.9' })],
    ['another chain', depositOf({ chain: 'base' })],
    [
      'another token',
      depositOf({ token: 'xo:0x0000000000000000000000000000000000000001' }),
    ],
  ])(
    'a claim answer with %s → bridge_funding_claimed, mayHaveLanded true, the paymentId; nothing is sent',
    async (_, deposit) => {
      const rig = setup();
      seed(rig.backend);
      rig.backend.override('fundingClaim', () =>
        HttpResponse.json(claimed(deposit)),
      );

      const error = await caught(() => rig.bridge.withdraw(wquote()));

      const tx = expectTransactionError(error, 'bridge_funding_claimed', true);
      expect(tx.message).toMatch(/deposit instructions/);
      // It tells the caller to confirm the instructions before anything is sent, by anyone.
      expect(tx.message).toMatch(
        /Confirm its deposit instructions with fetchBridgePayment\(\{ paymentId: "pay_w" \}\) before you send anything/,
      );
      expect(tx.message).toMatch(/send nothing and report the paymentId/);
      expect(tx.message).not.toMatch(/120 s/);
      expect(tx.message).not.toContain(CHECKSUMMED);
      expectClaimedNothingSent(rig);
    },
  );

  test('a claim answer with no deposit key at all is the same', async () => {
    const rig = setup();
    seed(rig.backend);
    const answer = claimed(null);
    delete (answer as Record<string, unknown>).deposit;
    rig.backend.override('fundingClaim', () => HttpResponse.json(answer));
    const error = await caught(() => rig.bridge.withdraw(wquote()));
    expectTransactionError(error, 'bridge_funding_claimed', true);
    expectClaimedNothingSent(rig);
  });

  test('the same address in another letter case, the same amount written differently and the chain and token in another case are the same deposit: one send', async () => {
    const rig = setup();
    seed(rig.backend);
    rig.backend.override('fundingClaim', () =>
      HttpResponse.json(
        claimed(
          depositOf({
            address: DEPOSIT_ADDRESS.toUpperCase().replace('0X', '0x'),
            amount: '5.000000',
            chain: 'XO',
            token: XO_USDC_TOKEN.toUpperCase().replace('XO:0X', 'xo:0x'),
          }),
        ),
      ),
    );
    const result = await rig.bridge.withdraw(wquote());
    expect(result.tx.status).toBe('success');
    expect(rig.rail.sent).toHaveLength(1);
    // What is sent is what was checked before the claim, not what the claim answered.
    expect(rig.rail.sent[0]?.[0]?.data).toBe(
      transferCalldata(DEPOSIT_ADDRESS, 5_000_000n),
    );
  });
});

describe('bridge.withdraw: what the result and the errors carry', () => {
  test('every error after the confirm serializes with its paymentId, and no error message holds the API key', async () => {
    const rig = setup();
    seed(rig.backend, { fundingClaimedAt: '2026-10-21T12:01:00.000Z' });
    const error = (await caught(() =>
      rig.bridge.withdraw(wquote()),
    )) as XoError;
    const json = JSON.stringify(error.toJSON());
    expect(json).toContain('pay_w');
    expect(json).toContain('bridge_funding_claimed');
    expect(json).not.toContain('xo_sk');
  });

  test('the payment that comes back is the one the claim answered', async () => {
    const rig = setup();
    seed(rig.backend);
    const result = await rig.bridge.withdraw(wquote());
    const stored = rig.backend.payments.get(
      'pay_w',
    ) as unknown as BridgePayment;
    expect(result.payment).toEqual(stored);
    expect(result.payment.ownerAddress).toBe(OWNER);
  });
});

describe('bridge.withdraw: the confirm and the claim are never sent twice, whatever the retry budget', () => {
  const failures: [string, (path: string) => Response][] = [
    ['a lost connection', () => HttpResponse.error() as Response],
    [
      'a 503',
      (path) =>
        exceptionResponse(path, 503, {
          error: 'halliday_unavailable',
          message: 'down',
        }),
    ],
  ];
  const confirms = (backend: BridgeBackend) =>
    backend.requests.filter(
      (r) => r.method === 'POST' && r.path === `${BASE}/payments`,
    );

  test.each(failures)(
    'the confirm meets %s on a transport with maxRetries 3: one confirm POST, mayHaveLanded true, nothing claimed or sent',
    async (_, answer) => {
      const rig = setup({ maxRetries: 3 });
      seed(rig.backend);
      rig.backend.override('confirm', ({ request }) => answer(request.path));

      const error = await caught(() => rig.bridge.withdraw(wquote()));

      expect(error).toBeInstanceOf(XoError);
      expect((error as XoError).mayHaveLanded).toBe(true);
      expect((error as XoError).paymentId).toBe('pay_w');
      expect(confirms(rig.backend)).toHaveLength(1);
      expect(rig.backend.requests).toHaveLength(1);
      expectNothingMoved(rig);
    },
  );

  test.each(failures)(
    'the claim meets %s on a transport with maxRetries 3: one claim POST, bridge_funding_claimed, nothing sent',
    async (_, answer) => {
      const rig = setup({ maxRetries: 3 });
      seed(rig.backend);
      rig.backend.override('fundingClaim', ({ request }) =>
        answer(request.path),
      );

      const error = await caught(() => rig.bridge.withdraw(wquote()));

      expectTransactionError(error, 'bridge_funding_claimed', true);
      expect(confirms(rig.backend)).toHaveLength(1);
      expectClaimedNothingSent(rig);
    },
  );

  test('a 401 on the claim logs in again and sends the claim once more: one claim processed, one transfer', async () => {
    const rig = setup();
    // A session that logs in with the owner's signer, on a transport that may retry reads.
    const login = installBackend(server);
    const transport = new Transport({
      env: rig.env,
      version: '9.9.9',
      maxRetries: 3,
    });
    const session = new Session({
      env: rig.env,
      transport,
      clock: new Clock({
        fetchServerTimeSec: async () => Math.floor(Date.now() / 1000),
      }),
      signer: ownerSigner(),
      readContract: async () => '0x',
      warn: () => {},
    });
    transport.setAuth(session);
    // The bridge routes take the keys the login minted, while they are not revoked.
    rig.backend.fixtures.validKeys = Object.assign(new Set<string>(), {
      has: (key: string) => {
        const record = login.keys.get(key);
        return record !== undefined && record.revokedAt === null;
      },
    });
    const bridge = new BridgeClient({
      env: rig.env,
      transport,
      session,
      identity: async () => eoaIdentity(),
      signer: ownerSigner(),
      chain: rig.chain.reader,
      account: rig.account,
    });
    seed(rig.backend);
    // The key the confirm went out with is revoked once the confirm is answered (at the
    // balance read, which comes between the confirm and the claim): the claim meets a 401.
    let revoked = false;
    const read = rig.chain.read as (call: { to: Address; data: Hex }) => Hex;
    rig.chain.read = (call) => {
      if (!revoked) {
        revoked = true;
        for (const record of login.keys.values()) {
          record.revokedAt = new Date().toISOString();
        }
      }
      return read(call);
    };

    const result = await bridge.withdraw(wquote());

    const [first, second] = login.minted;
    expect(login.minted).toHaveLength(2);
    // The confirm once, the claim twice: refused with 401 (not processed), then sent again
    // with the new key and processed. A second processed claim would have answered
    // funding_already_claimed and sent nothing.
    expect(
      rig.backend.requests.map((r) => [
        `${r.method} ${r.path}`,
        r.authorization,
      ]),
    ).toEqual([
      [`POST ${BASE}/payments`, `Bearer ${first?.key}`],
      [`POST ${CLAIM_PATH}`, `Bearer ${first?.key}`],
      [`POST ${CLAIM_PATH}`, `Bearer ${second?.key}`],
    ]);
    expect(result.payment.fundingClaimedAt).toEqual(expect.any(String));
    expect(result.tx.status).toBe('success');
    expect(rig.rail.sent).toHaveLength(1);
  });
});
