import { HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { type Address, decodeFunctionData, getAddress, maxUint256 } from 'viem';
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
import { CONDITIONAL_TOKENS_ABI, ERC20_ABI } from '../../src/account/abis';
import { resetNonceTracking } from '../../src/account/internal';
import { resetProcessState, setClientSeams } from '../../src/clients/internal';
import type { SecureClient } from '../../src/clients/secure';
import {
  TransactionFailedError,
  UserInputError,
  type XoError,
} from '../../src/core/errors';
import { conditionIdOf } from '../helpers/mockBackendData';
import { CONDITION_A, TOKEN_NO, TOKEN_YES } from '../helpers/mockMarketData';
import {
  OWNER,
  type RailChainStub,
  railChain,
  TX_HASH,
} from '../helpers/railChain';
import {
  type ChainState,
  chainReads,
  defaultChainState,
  OTHER_TOKEN,
  onlyCall,
  signedInClient,
} from '../helpers/secureRig';
import { testEnvWithBridge } from '../helpers/testEnv';

// The on-chain sends of a signed-in client: each goes through XO's sponsor once, and returns
// the handle of the mined transaction. A send is never repeated or signed again; when its
// outcome is unknown it throws with `mayHaveLanded: true` and what identifies it.

const env = testEnvWithBridge;
const USDC = env.contracts.usdc;
const RECIPIENT: Address = getAddress(
  '0x00000000000000000000000000000000000000b0',
);
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

const clients: SecureClient[] = [];
let chain: RailChainStub;
let state: ChainState;

beforeEach(() => {
  chain = railChain();
  state = defaultChainState(env);
  chainReads(chain, env, state);
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

async function caught(run: () => unknown): Promise<XoError> {
  try {
    await run();
  } catch (error) {
    return error as XoError;
  }
  throw new Error('expected the call to throw');
}

describe('transferErc20', () => {
  test("sends XO's USDC by default, in whole units, and returns the mined transaction's handle", async () => {
    const { client, sponsor } = await rig();
    const handle = await client.transferErc20({ to: RECIPIENT, amount: '5' });
    expect(handle.transactionHash).toBe(TX_HASH);
    await expect(handle.wait()).resolves.toEqual({
      transactionHash: TX_HASH,
      status: 'success',
      blockNumber: 42n,
    });
    expect(sponsor.bodies).toHaveLength(1);
    const call = onlyCall(sponsor.bodies[0]);
    expect(call.to?.toLowerCase()).toBe(USDC.toLowerCase());
    expect(decodeFunctionData({ abi: ERC20_ABI, data: call.data })).toEqual({
      functionName: 'transfer',
      args: [RECIPIENT, 5_000_000n],
    });
  });

  test('another token: its decimals are read, and the amount is converted with them', async () => {
    const { client, sponsor } = await rig();
    const handle = await client.transferErc20({
      token: OTHER_TOKEN,
      to: RECIPIENT,
      amount: '1.5',
    });
    expect(handle.transactionHash).toBe(TX_HASH);
    const call = onlyCall(sponsor.bodies[0]);
    expect(call.to?.toLowerCase()).toBe(OTHER_TOKEN.toLowerCase());
    expect(decodeFunctionData({ abi: ERC20_ABI, data: call.data })).toEqual({
      functionName: 'transfer',
      args: [RECIPIENT, 1_500_000_000_000_000_000n],
    });
  });

  test('more decimals than the token has, or a balance that is short: refused, nothing sent', async () => {
    const { client, sponsor } = await rig();
    const tooFine = await caught(() =>
      client.transferErc20({ to: RECIPIENT, amount: '0.0000001' }),
    );
    expect(tooFine).toBeInstanceOf(UserInputError);
    expect(tooFine.mayHaveLanded).toBe(false);
    const short = await caught(() =>
      client.transferErc20({ to: RECIPIENT, amount: '1000.000001' }),
    );
    expect(short.code).toBe('insufficient_balance');
    expect(short.mayHaveLanded).toBe(false);
    expect(sponsor.bodies).toEqual([]);
  });

  test('a recipient that is the token contract, or a request that is not valid: refused at once', async () => {
    const { client, sponsor } = await rig();
    const contract = await caught(() =>
      client.transferErc20({ to: USDC, amount: '1' }),
    );
    expect(contract.code).toBe('recipient_is_token_contract');
    for (const request of [
      { to: 'nope', amount: '1' },
      { to: RECIPIENT },
      { to: RECIPIENT, amount: -1 },
      { to: RECIPIENT, amount: '1', extra: true },
    ]) {
      const error = await caught(() => client.transferErc20(request as never));
      expect(error).toBeInstanceOf(UserInputError);
      expect(error.mayHaveLanded).toBe(false);
    }
    expect(sponsor.bodies).toEqual([]);
  });

  test('a send whose answer is lost after the sponsor took it: mayHaveLanded with the hash, never sent again', async () => {
    const { client, sponsor } = await rig();
    chain.receipt = () => new Error('connection reset');
    const error = await caught(() =>
      client.transferErc20({ to: RECIPIENT, amount: '5' }),
    );
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(error.mayHaveLanded).toBe(true);
    expect((error as TransactionFailedError).transactionHash).toBe(TX_HASH);
    expect(error.code).toBe('receipt_unavailable');
    expect(sponsor.bodies).toHaveLength(1);
  });

  test("a send whose sponsor answer is lost: mayHaveLanded with the nonce to check (the hash is the sponsor's to give), never sent again", async () => {
    const { client, sponsor } = await rig();
    sponsor.reply = () => HttpResponse.error();
    const error = await caught(() =>
      client.transferErc20({ to: RECIPIENT, amount: '5' }),
    );
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(error.mayHaveLanded).toBe(true);
    expect(error.code).toBe('sponsor_outcome_unknown');
    expect((error as TransactionFailedError).nonce).toBe(5n);
    expect(sponsor.bodies).toHaveLength(1);
  });

  test('a reverted transfer is a result: the handle says so', async () => {
    const { client } = await rig();
    chain.receipt = (hash) => ({
      txHash: hash,
      status: 'reverted',
      blockNumber: 43n,
    });
    const handle = await client.transferErc20({ to: RECIPIENT, amount: '5' });
    await expect(handle.wait()).resolves.toMatchObject({ status: 'reverted' });
  });
});

describe('setupTradingApprovals', () => {
  test('approves USDC and the outcome tokens for the exchange, in one transaction', async () => {
    const { client, sponsor } = await rig();
    const handle = await client.setupTradingApprovals();
    expect(handle?.transactionHash).toBe(TX_HASH);
    expect(sponsor.bodies).toHaveLength(1);
    const calls = sponsor.bodies[0]?.tx.calls ?? [];
    expect(calls).toHaveLength(2);
    expect(
      decodeFunctionData({ abi: ERC20_ABI, data: calls[0]?.data ?? '0x' }),
    ).toEqual({
      functionName: 'approve',
      args: [getAddress(env.contracts.ctfExchange), maxUint256],
    });
    expect(
      decodeFunctionData({
        abi: CONDITIONAL_TOKENS_ABI,
        data: calls[1]?.data ?? '0x',
      }).functionName,
    ).toBe('setApprovalForAll');
  });

  test('an account that is set up already: null, and nothing is sent', async () => {
    const { client, sponsor } = await rig();
    state.allowance = maxUint256;
    state.operatorApproved = true;
    expect(await client.setupTradingApprovals()).toBeNull();
    expect(sponsor.bodies).toEqual([]);
  });
});

describe('mergePositions and redeemPositions', () => {
  test('merges what is free of both outcomes when no amount is given', async () => {
    const { client, trading, sponsor } = await rig();
    trading.accounts.set(OWNER.toLowerCase(), {
      cash: '0',
      positions: [
        { token_id: TOKEN_YES, balance: '3000000', reserved: '0' },
        { token_id: TOKEN_NO, balance: '2000000', reserved: '0' },
      ],
    });
    const handle = await client.mergePositions({ conditionId: CONDITION_A });
    expect(handle.transactionHash).toBe(TX_HASH);
    const call = onlyCall(sponsor.bodies[0]);
    const decoded = decodeFunctionData({
      abi: CONDITIONAL_TOKENS_ABI,
      data: call.data,
    });
    expect(decoded.functionName).toBe('mergePositions');
    expect(decoded.args?.at(-1)).toBe(2_000_000n);
  });

  test('redeems a resolved market; one not resolved on chain is refused, nothing sent', async () => {
    const { client, sponsor } = await rig();
    const unresolved = await caught(() =>
      client.redeemPositions({ conditionId: CONDITION_A }),
    );
    expect(unresolved.code).toBe('not_resolved');
    expect(unresolved.mayHaveLanded).toBe(false);
    expect(sponsor.bodies).toEqual([]);
    state.payoutDenominator = 1n;
    const handle = await client.redeemPositions({ conditionId: CONDITION_A });
    expect(handle.transactionHash).toBe(TX_HASH);
    expect(
      decodeFunctionData({
        abi: CONDITIONAL_TOKENS_ABI,
        data: onlyCall(sponsor.bodies[0]).data,
      }).functionName,
    ).toBe('redeemPositions');
  });

  test('redeemAllPositions: one result per market, each redeemed once', async () => {
    const { client, trading, sponsor } = await rig();
    state.payoutDenominator = 1n;
    trading.claimable.set(OWNER.toLowerCase(), [
      {
        market_id: CONDITION_A,
        outcome: 'YES',
        token_id: TOKEN_YES,
        balance: '1000000',
        refund_reason: '',
      },
    ]);
    const results = await client.redeemAllPositions();
    expect(results.map((r) => [r.ok, r.conditionId])).toEqual([
      [true, CONDITION_A],
      [true, conditionIdOf(12)],
    ]);
    expect(sponsor.bodies).toHaveLength(2);
  });

  test('redeemAllPositions: after a send that may have landed, the rest are held back', async () => {
    const { client, trading, sponsor } = await rig();
    state.payoutDenominator = 1n;
    trading.claimable.set(OWNER.toLowerCase(), [
      {
        market_id: CONDITION_A,
        outcome: 'YES',
        token_id: TOKEN_YES,
        balance: '1000000',
        refund_reason: '',
      },
    ]);
    chain.receipt = () => new Error('connection reset');
    const results = await client.redeemAllPositions();
    expect(sponsor.bodies).toHaveLength(1);
    const [first, second] = results;
    expect(first?.ok).toBe(false);
    expect(first?.ok === false && first.error.mayHaveLanded).toBe(true);
    expect(second?.ok === false && second.error.code).toBe(
      'skipped_after_ambiguous',
    );
  });
});

describe('a closed client', () => {
  test('sends nothing: every on-chain call refuses with client_closed', async () => {
    const { client, sponsor } = await rig();
    await client.close();
    for (const run of [
      () => client.setupTradingApprovals(),
      () => client.mergePositions({ conditionId: CONDITION_A }),
      () => client.redeemPositions({ conditionId: CONDITION_A }),
      () => client.redeemAllPositions(),
      () => client.transferErc20({ to: RECIPIENT, amount: '1' }),
    ]) {
      const error = await caught(run);
      expect(error.code).toBe('client_closed');
      expect(error.mayHaveLanded).toBe(false);
    }
    expect(sponsor.bodies).toEqual([]);
  });
});
