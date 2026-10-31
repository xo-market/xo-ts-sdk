import {
  type Address,
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  type Hex,
  maxUint256,
} from 'viem';
import { describe, expect, test } from 'vitest';
import { CONDITIONAL_TOKENS_ABI, ERC20_ABI } from '../../src/account/abis';
import type { TxResult } from '../../src/account/chain';
import { AccountClient, BALANCE_BATCH_SIZE } from '../../src/account/client';
import { isEmptyCode } from '../../src/account/internal';
import type { TxRail } from '../../src/account/rails';
import { isSameAddress } from '../../src/core/address';
import { fromMicro } from '../../src/core/decimal';
import {
  RequestRejectedError,
  TransactionFailedError,
  UnexpectedResponseError,
  UserInputError,
  XoError,
} from '../../src/core/errors';
import type { RawUnitsString } from '../../src/core/types';
import type { Positions } from '../../src/orderbook/schemas';
import type { Call } from '../../src/signing/kernel';
import type { TradingIdentity } from '../../src/wallet/identity';
import {
  eoaIdentity,
  OWNER,
  type RailChainStub,
  railChain,
  SMART_WALLET,
  smartWalletIdentity,
  TX_HASH,
} from '../helpers/railChain';
import { testEnv } from '../helpers/testEnv';

const env = testEnv;
const {
  usdc: USDC,
  ctfExchange: EXCHANGE,
  clobMarketManager: MANAGER,
} = env.contracts;
const CT = env.contracts.conditionalTokens;
/** A recipient for transfers. */
const TO: Address = getAddress('0x00000000000000000000000000000000000000b0');
/** A user operation hash: the SDK has no bundler rail, so it never passes one on. */
const USER_OP_HASH: Hex = `0x${'5e'.repeat(32)}`;

// The calldata is pinned to literal bytes (the well-known selectors and ABI words), so a wrong
// function, argument order or amount fails here even though the chain stub below decodes with
// the SDK's own fragments.
const word = (hex: string): string =>
  hex.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const approveMax = (spender: Address): Hex =>
  `0x095ea7b3${word(spender)}${'f'.repeat(64)}`;
const setApprovalForAllTrue = (operator: Address): Hex =>
  `0xa22cb465${word(operator)}${word('1')}`;
const transferCalldata = (to: Address, micro: bigint): Hex =>
  `0xa9059cbb${word(to)}${word(micro.toString(16))}`;

// ---------------------------------------------------------------------------
// The chain: the rail stub, with a small ledger behind `readContract`
// ---------------------------------------------------------------------------

/** One decoded read of USDC or ConditionalTokens. */
interface Read {
  to: Address;
  name: string;
  args: readonly unknown[];
}

/** What the chain holds. Every address key is lower case. */
interface Ledger {
  /** USDC balances, by holder. */
  usdc: Map<string, bigint>;
  /** USDC allowances, by `holder>spender`. */
  allowance: Map<string, bigint>;
  /** ConditionalTokens operator approvals, as `holder>operator`. */
  approved: Set<string>;
  /** Outcome-token balances, by `holder>id`. */
  tokens: Map<string, bigint>;
  /** Every read, in order. */
  reads: Read[];
  /** Answers the raw result instead (or throws), per read. */
  override?: (read: Read) => Hex | Error | undefined;
}

const pair = (a: string, b: string): string =>
  `${a.toLowerCase()}>${b.toLowerCase()}`;

interface AccountChain extends RailChainStub {
  ledger: Ledger;
}

/** The rail stub (owner and smart wallet deployed) with a ledger where nothing is held or approved. */
function accountChain(): AccountChain {
  const chain = railChain();
  const ledger: Ledger = {
    usdc: new Map(),
    allowance: new Map(),
    approved: new Set(),
    tokens: new Map(),
    reads: [],
  };
  chain.read = ({ to, data }) => {
    if (isSameAddress(to, USDC)) {
      const decoded = decodeFunctionData({ abi: ERC20_ABI, data });
      const read: Read = { to, name: decoded.functionName, args: decoded.args };
      ledger.reads.push(read);
      const forced = ledger.override?.(read);
      if (forced !== undefined) {
        return forced;
      }
      if (decoded.functionName === 'allowance') {
        const [holder, spender] = decoded.args;
        return encodeFunctionResult({
          abi: ERC20_ABI,
          functionName: 'allowance',
          result: ledger.allowance.get(pair(holder, spender)) ?? 0n,
        });
      }
      if (decoded.functionName === 'balanceOf') {
        const [holder] = decoded.args;
        return encodeFunctionResult({
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          result: ledger.usdc.get(holder.toLowerCase()) ?? 0n,
        });
      }
    }
    if (isSameAddress(to, CT)) {
      const decoded = decodeFunctionData({ abi: CONDITIONAL_TOKENS_ABI, data });
      const read: Read = {
        to,
        name: decoded.functionName,
        args: decoded.args ?? [],
      };
      ledger.reads.push(read);
      const forced = ledger.override?.(read);
      if (forced !== undefined) {
        return forced;
      }
      if (decoded.functionName === 'isApprovedForAll') {
        const [holder, operator] = decoded.args;
        return encodeFunctionResult({
          abi: CONDITIONAL_TOKENS_ABI,
          functionName: 'isApprovedForAll',
          result: ledger.approved.has(pair(holder, operator)),
        });
      }
      if (decoded.functionName === 'balanceOfBatch') {
        const [holders, ids] = decoded.args;
        return encodeFunctionResult({
          abi: CONDITIONAL_TOKENS_ABI,
          functionName: 'balanceOfBatch',
          result: holders.map(
            (holder, i) =>
              ledger.tokens.get(pair(holder, String(ids[i]))) ?? 0n,
          ),
        });
      }
    }
    return new Error('execution reverted');
  };
  return Object.assign(chain, { ledger });
}

/** Everything `setup()` checks is in place for `holder`, including the market manager. */
function approveAll(ledger: Ledger, holder: Address): void {
  ledger.allowance.set(pair(holder, EXCHANGE), maxUint256);
  ledger.allowance.set(pair(holder, MANAGER), maxUint256);
  ledger.approved.add(pair(holder, EXCHANGE));
}

const OK: TxResult = { txHash: TX_HASH, status: 'success', blockNumber: 42n };

/** A rail that records each batch and answers `answer` (or throws it). */
function fakeRail(answer: TxResult | Error = OK) {
  const sent: Call[][] = [];
  const rail: TxRail = {
    async send(calls) {
      sent.push(calls);
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    },
  };
  return { rail, sent };
}

/**
 * An orderbook whose `/positions` answers `answer` (or throws it). The capacity and claimable
 * reads are merge's and redeemAll's (`settle.test.ts`): unused here.
 */
/** A gateway answer as its JSON carries it: the micro-unit amounts are plain strings. */
type Wire<T> = T extends RawUnitsString
  ? string
  : T extends readonly (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

function fakeOrderbook(
  answer: Wire<Positions> | Error = { cash_balance: '0', positions: [] },
) {
  const book = {
    calls: 0,
    async getPositions(): Promise<Positions> {
      book.calls += 1;
      if (answer instanceof Error) {
        throw answer;
      }
      return answer as Positions;
    },
    getMarketCapacity: () => Promise.reject(new Error('unused')),
    getClaimable: () => Promise.reject(new Error('unused')),
  };
  return book;
}

interface RigOptions {
  identity?: TradingIdentity;
  /** `null`: no rail at all. */
  rail?: TxRail | null;
  railAnswer?: TxResult | Error;
  positions?: Wire<Positions> | Error;
}

function rig(o: RigOptions = {}) {
  const chain = accountChain();
  const fake = fakeRail(o.railAnswer);
  const book = fakeOrderbook(o.positions);
  const identity = o.identity ?? eoaIdentity();
  let identityCalls = 0;
  const client = new AccountClient({
    env,
    identity: async () => {
      identityCalls += 1;
      return identity;
    },
    chain: chain.reader,
    orderbook: book,
    ...(o.rail === null ? {} : { rail: o.rail ?? fake.rail }),
  });
  return {
    client,
    chain,
    ledger: chain.ledger,
    sent: fake.sent,
    book,
    identity,
    identityCalls: () => identityCalls,
  };
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('AccountClient: construction', () => {
  const chain = accountChain().reader;
  const orderbook = fakeOrderbook();
  const identity = async () => eoaIdentity();

  test.each([
    ['env', { identity, chain, orderbook }],
    ['identity', { env, chain, orderbook }],
    ['chain', { env, identity, orderbook }],
    ['orderbook', { env, identity, chain }],
  ])('refuses options without %s', (_, options) => {
    expect(() => new AccountClient(options as never)).toThrow(UserInputError);
  });

  test('refuses a rail without send', () => {
    expect(
      () =>
        new AccountClient({
          env,
          identity,
          chain,
          orderbook,
          rail: {} as TxRail,
        }),
    ).toThrow(UserInputError);
  });

  test('refuses a chain without getCode', () => {
    expect(
      () =>
        new AccountClient({
          env,
          identity,
          chain: { readContract: chain.readContract } as never,
          orderbook,
        }),
    ).toThrow(UserInputError);
  });
});

// ---------------------------------------------------------------------------
// setup()
// ---------------------------------------------------------------------------

describe('AccountClient.setup', () => {
  test('fresh EOA with zero allowance → one tx with [USDC.approve(exchange, maxUint256), CT.setApprovalForAll(exchange, true)]', async () => {
    const r = rig();
    const result = await r.client.setup();

    expect(result).toEqual({
      txHash: TX_HASH,
      actions: ['approve_usdc', 'approve_ctf'],
    });
    expect(r.sent).toEqual([
      [
        { to: USDC, data: approveMax(EXCHANGE), value: 0n },
        { to: CT, data: setApprovalForAllTrue(EXCHANGE), value: 0n },
      ],
    ]);
    // The checks read the trader's address, against the exchange. No manager by default.
    expect(r.ledger.reads.map((read) => [read.name, ...read.args])).toEqual([
      ['allowance', OWNER, EXCHANGE],
      ['isApprovedForAll', OWNER, EXCHANGE],
    ]);
    // An EOA is never checked for code.
    expect(r.chain.count('getCode')).toBe(0);
  });

  test('already approved → no tx, actions []', async () => {
    const r = rig();
    approveAll(r.ledger, OWNER);
    const result = await r.client.setup();

    expect(result).toEqual({ actions: [] });
    expect('txHash' in result).toBe(false);
    expect(r.sent).toEqual([]);
  });

  test("undeployed smart wallet → actions start with 'deploy' and all go in one tx", async () => {
    const r = rig({ identity: smartWalletIdentity() });
    r.chain.code.delete(SMART_WALLET.toLowerCase());
    const result = await r.client.setup();

    expect(result).toEqual({
      txHash: TX_HASH,
      actions: ['deploy', 'approve_usdc', 'approve_ctf'],
    });
    // One send of the plain calls: the rail wraps them in execute and prepends createAccount.
    expect(r.sent).toEqual([
      [
        { to: USDC, data: approveMax(EXCHANGE), value: 0n },
        { to: CT, data: setApprovalForAllTrue(EXCHANGE), value: 0n },
      ],
    ]);
    // A codeless account's approvals are known to be zero: nothing is read but its code.
    expect(r.chain.log).toEqual([{ method: 'getCode', args: [SMART_WALLET] }]);
  });

  test("a smart wallet whose code reads '0x0' is undeployed too, as the rail sees it", async () => {
    const r = rig({ identity: smartWalletIdentity() });
    r.chain.code.set(SMART_WALLET.toLowerCase(), '0x0');
    const result = await r.client.setup();
    expect(result.actions).toEqual(['deploy', 'approve_usdc', 'approve_ctf']);
    expect(r.chain.log).toEqual([{ method: 'getCode', args: [SMART_WALLET] }]);
  });

  test('undeployed smart wallet with includeMarketManager → deploy and all three approvals in one tx', async () => {
    const r = rig({ identity: smartWalletIdentity() });
    r.chain.code.delete(SMART_WALLET.toLowerCase());
    const result = await r.client.setup({ includeMarketManager: true });

    expect(result.actions).toEqual([
      'deploy',
      'approve_usdc',
      'approve_ctf',
      'approve_manager',
    ]);
    expect(r.sent).toEqual([
      [
        { to: USDC, data: approveMax(EXCHANGE), value: 0n },
        { to: CT, data: setApprovalForAllTrue(EXCHANGE), value: 0n },
        { to: USDC, data: approveMax(MANAGER), value: 0n },
      ],
    ]);
  });

  test('deployed smart wallet: the approvals are read and set at the smart wallet, not the owner', async () => {
    const r = rig({ identity: smartWalletIdentity() });
    const first = await r.client.setup();
    expect(first.actions).toEqual(['approve_usdc', 'approve_ctf']);
    expect(r.ledger.reads.map((read) => read.args[0])).toEqual([
      SMART_WALLET,
      SMART_WALLET,
    ]);

    approveAll(r.ledger, SMART_WALLET);
    expect(await r.client.setup()).toEqual({ actions: [] });
    expect(r.sent).toHaveLength(1);
  });

  test.each([
    ['2^255 - 1 is low', 2n ** 255n - 1n, ['approve_usdc']],
    ['2^255 is enough', 2n ** 255n, []],
    ['maxUint256 is enough', maxUint256, []],
    ['zero is low', 0n, ['approve_usdc']],
  ])('allowance threshold: %s', async (_, allowance, actions) => {
    const r = rig();
    r.ledger.approved.add(pair(OWNER, EXCHANGE));
    r.ledger.allowance.set(pair(OWNER, EXCHANGE), allowance);
    const result = await r.client.setup();

    expect(result.actions).toEqual(actions);
    expect(r.sent).toEqual(
      actions.length === 0
        ? []
        : [[{ to: USDC, data: approveMax(EXCHANGE), value: 0n }]],
    );
  });

  test('only the missing operator approval → actions [approve_ctf]', async () => {
    const r = rig();
    r.ledger.allowance.set(pair(OWNER, EXCHANGE), maxUint256);
    const result = await r.client.setup();

    expect(result.actions).toEqual(['approve_ctf']);
    expect(r.sent).toEqual([
      [{ to: CT, data: setApprovalForAllTrue(EXCHANGE), value: 0n }],
    ]);
  });

  test('includeMarketManager defaults to false: the manager allowance is not read', async () => {
    const r = rig();
    r.ledger.allowance.set(pair(OWNER, EXCHANGE), maxUint256);
    r.ledger.approved.add(pair(OWNER, EXCHANGE));
    expect(await r.client.setup()).toEqual({ actions: [] });
    expect(await r.client.setup({})).toEqual({ actions: [] });
    expect(await r.client.setup({ includeMarketManager: undefined })).toEqual({
      actions: [],
    });
    expect(
      r.ledger.reads.some((read) =>
        isSameAddress(String(read.args[1]), MANAGER),
      ),
    ).toBe(false);
  });

  test('includeMarketManager: true adds USDC.approve(ClobMarketManager, max) when its allowance is low', async () => {
    const r = rig();
    r.ledger.allowance.set(pair(OWNER, EXCHANGE), maxUint256);
    r.ledger.approved.add(pair(OWNER, EXCHANGE));
    r.ledger.allowance.set(pair(OWNER, MANAGER), 2n ** 255n - 1n);
    const result = await r.client.setup({ includeMarketManager: true });

    expect(result).toEqual({ txHash: TX_HASH, actions: ['approve_manager'] });
    expect(r.sent).toEqual([
      [{ to: USDC, data: approveMax(MANAGER), value: 0n }],
    ]);
    expect(r.ledger.reads.at(-1)).toMatchObject({
      name: 'allowance',
      args: [OWNER, MANAGER],
    });
  });

  test('includeMarketManager: true with the manager approved → nothing to do', async () => {
    const r = rig();
    approveAll(r.ledger, OWNER);
    expect(await r.client.setup({ includeMarketManager: true })).toEqual({
      actions: [],
    });
  });

  test('the actions and the calls keep one order: approve_usdc, approve_ctf, approve_manager', async () => {
    const r = rig();
    const result = await r.client.setup({ includeMarketManager: true });

    expect(result.actions).toEqual([
      'approve_usdc',
      'approve_ctf',
      'approve_manager',
    ]);
    expect(r.sent).toEqual([
      [
        { to: USDC, data: approveMax(EXCHANGE), value: 0n },
        { to: CT, data: setApprovalForAllTrue(EXCHANGE), value: 0n },
        { to: USDC, data: approveMax(MANAGER), value: 0n },
      ],
    ]);
  });

  test('a reverted receipt → TransactionFailedError tx_reverted with the hash; calling setup() again is safe', async () => {
    const r = rig({
      railAnswer: { txHash: TX_HASH, status: 'reverted', blockNumber: 43n },
    });
    const error = await caught(() => r.client.setup());

    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(error).toMatchObject({
      code: 'tx_reverted',
      transactionHash: TX_HASH,
      mayHaveLanded: false,
    });
    expect((error as Error).message).toContain(TX_HASH);
    expect((error as Error).message).toContain(
      'Creating the client again, or calling setupTradingApprovals(), is safe: both read the on-chain state again and send only what is missing',
    );
    // Not a user operation: no userOpHash, and the message does not speak of one.
    expect('userOpHash' in (error as TransactionFailedError)).toBe(false);
    expect((error as Error).message).not.toContain('user operation');
  });

  test('a rail result that carries a userOpHash: setup() returns the hash and the actions only', async () => {
    const r = rig({
      railAnswer: {
        txHash: TX_HASH,
        status: 'success',
        blockNumber: 43n,
        userOpHash: USER_OP_HASH,
      } as TxResult,
    });
    const result = await r.client.setup();
    expect(result).toEqual({
      txHash: TX_HASH,
      actions: ['approve_usdc', 'approve_ctf'],
    });
    expect('userOpHash' in result).toBe(false);
  });

  test('a result without userOpHash (the other rails) has no userOpHash key', async () => {
    const result = await rig().client.setup();
    expect('userOpHash' in result).toBe(false);
  });

  test('a reverted rail result that carries a userOpHash: tx_reverted names the setup transaction, and no userOpHash is passed on', async () => {
    const r = rig({
      railAnswer: {
        txHash: TX_HASH,
        status: 'reverted',
        blockNumber: 43n,
        userOpHash: USER_OP_HASH,
      } as TxResult,
    });
    const error = await caught(() => r.client.setup());

    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(error).toMatchObject({
      code: 'tx_reverted',
      transactionHash: TX_HASH,
      mayHaveLanded: false,
      service: 'chain',
    });
    expect('userOpHash' in (error as TransactionFailedError)).toBe(false);
    expect('userOpHash' in (error as TransactionFailedError).toJSON()).toBe(
      false,
    );
    const { message } = error as Error;
    expect(message).toContain(
      `The setup transaction ${TX_HASH} (approve_usdc, approve_ctf) was mined but reverted`,
    );
    expect(message).not.toContain('user operation');
    expect(message).not.toContain(USER_OP_HASH);
  });

  test('a rail error propagates unchanged, mayHaveLanded and transactionHash intact', async () => {
    const failure = new TransactionFailedError('no receipt', {
      mayHaveLanded: true,
      transactionHash: TX_HASH,
      nonce: 5n,
      code: 'receipt_timeout',
      service: 'chain',
    });
    const r = rig({ railAnswer: failure });
    const error = await caught(() => r.client.setup());

    expect(error).toBe(failure);
    expect(error).toMatchObject({
      mayHaveLanded: true,
      transactionHash: TX_HASH,
      nonce: 5n,
    });
  });

  test('without a rail: the actions are worked out, then rail_not_configured names them and nothing is sent', async () => {
    const r = rig({ rail: null });
    const error = await caught(() => r.client.setup());

    expect(error).toBeInstanceOf(UserInputError);
    expect(error).toMatchObject({
      code: 'rail_not_configured',
      mayHaveLanded: false,
    });
    expect((error as Error).message).toContain('approve_usdc, approve_ctf');
  });

  test('without a rail and nothing to do → { actions: [] }', async () => {
    const r = rig({ rail: null });
    approveAll(r.ledger, OWNER);
    expect(await r.client.setup()).toEqual({ actions: [] });
  });

  test('a failed read → chain_read_failed with mayHaveLanded false, and nothing is sent', async () => {
    const r = rig();
    r.ledger.override = (read) =>
      read.name === 'isApprovedForAll' ? new Error('boom') : undefined;
    const error = await caught(() => r.client.setup());

    expect(error).toBeInstanceOf(XoError);
    expect(error).toMatchObject({
      code: 'chain_read_failed',
      service: 'chain',
      mayHaveLanded: false,
    });
    expect(r.sent).toEqual([]);
  });

  test('a read that answers garbage → chain_read_failed', async () => {
    const r = rig();
    r.ledger.override = (read) =>
      read.name === 'allowance' ? '0x' : undefined;
    expect(await caught(() => r.client.setup())).toMatchObject({
      code: 'chain_read_failed',
    });
    expect(r.sent).toEqual([]);
  });

  test('a failed code read of a smart wallet → chain_read_failed, nothing sent', async () => {
    const r = rig({ identity: smartWalletIdentity() });
    r.chain.reader.getCode = async () => {
      throw new Error('down');
    };
    expect(await caught(() => r.client.setup())).toMatchObject({
      code: 'chain_read_failed',
      mayHaveLanded: false,
    });
    expect(r.sent).toEqual([]);
  });

  test('includeMarketManager must be a boolean', async () => {
    const r = rig();
    await expect(
      r.client.setup({ includeMarketManager: 'yes' as never }),
    ).rejects.toBeInstanceOf(UserInputError);
    expect(r.chain.log).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// transferUsdc()
// ---------------------------------------------------------------------------

describe('AccountClient.transferUsdc', () => {
  function funded(o: RigOptions = {}, micro = 100_000_000n) {
    const r = rig(o);
    r.ledger.usdc.set(r.identity.address.toLowerCase(), micro);
    return r;
  }

  test("transferUsdc(to, '5') → USDC.transfer(to, 5_000_000)", async () => {
    const r = funded();
    const result = await r.client.transferUsdc(TO, '5');

    expect(result).toEqual(OK);
    expect(r.sent).toEqual([
      [{ to: USDC, data: transferCalldata(TO, 5_000_000n), value: 0n }],
    ]);
  });

  test.each([
    [0.5, 500_000n],
    ['0.000001', 1n],
    ['153.641122', 153_641_122n],
    [12, 12_000_000n],
  ] as const)(
    'the amount %s is %s micro-USDC, exactly',
    async (amount, micro) => {
      const r = funded({}, 1_000_000_000n);
      await r.client.transferUsdc(TO, amount);
      expect(r.sent).toEqual([
        [{ to: USDC, data: transferCalldata(TO, micro), value: 0n }],
      ]);
    },
  );

  test('a lower-case recipient is accepted and checksummed', async () => {
    const r = funded();
    await r.client.transferUsdc(TO.toLowerCase() as Address, '1');
    expect(r.sent[0]?.[0]?.data).toBe(transferCalldata(TO, 1_000_000n));
  });

  test('transferUsdc to bad address → UserInputError', async () => {
    const r = funded();
    for (const bad of ['0x1234', 'not an address', '', 42]) {
      const error = await caught(() =>
        r.client.transferUsdc(bad as Address, '5'),
      );
      expect(error).toBeInstanceOf(UserInputError);
      expect(error).toMatchObject({ mayHaveLanded: false });
    }
    expect(r.sent).toEqual([]);
    expect(r.chain.log).toEqual([]);
  });

  test('the zero address is refused', async () => {
    const r = funded();
    const error = await caught(() =>
      r.client.transferUsdc('0x0000000000000000000000000000000000000000', '5'),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as Error).message).toContain('zero address');
    expect(r.sent).toEqual([]);
    expect(r.chain.log).toEqual([]);
  });

  test.each([
    ['checksummed', USDC],
    ['lower case', USDC.toLowerCase()],
    ['upper-case hex', `0x${USDC.slice(2).toUpperCase()}`],
  ])(
    'the USDC contract itself is refused (%s): recipient_is_token_contract',
    async (_, to) => {
      const r = funded();
      const error = await caught(() =>
        r.client.transferUsdc(to as Address, '5'),
      );
      expect(error).toBeInstanceOf(UserInputError);
      expect(error).toMatchObject({
        code: 'recipient_is_token_contract',
        mayHaveLanded: false,
      });
      expect(r.sent).toEqual([]);
      expect(r.chain.log).toEqual([]);
    },
  );

  test.each([
    ['zero', '0'],
    ['zero as a number', 0],
    ['negative', '-1'],
    ['negative number', -1],
    ['more than 6 decimals', '1.0000001'],
    ['an exponent', '1e3'],
    ['a tiny number', 1e-7],
    ['not finite', Number.POSITIVE_INFINITY],
    ['blank', ''],
    ['a bigint (ambiguous: whole units or micro?)', 5n],
    ['negative zero', -0],
    ['0.1 + 0.2 (17 decimals)', 0.1 + 0.2],
    ['a leading space', ' 5'],
    ['hex', '0x10'],
    ['100 digits (beyond a uint256 of micro-units)', '1'.repeat(100)],
  ])('the amount is refused: %s', async (_, amount) => {
    const r = funded();
    const error = await caught(() =>
      r.client.transferUsdc(TO, amount as never),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect(error).toMatchObject({ mayHaveLanded: false });
    expect(r.sent).toEqual([]);
    expect(r.chain.log).toEqual([]);
  });

  test('a RawUnitsString amount is refused at compile time', async () => {
    const r = funded();
    const raw = '570000' as RawUnitsString;
    // @ts-expect-error a raw token-unit amount is not a whole-unit amount
    const error = await caught(() => r.client.transferUsdc(TO, raw));
    // At run time it is read as 570 000 USDC, which this wallet does not have.
    expect(error).toMatchObject({ code: 'insufficient_balance' });
    expect(r.sent).toEqual([]);
  });

  test('a short balance → UserInputError insufficient_balance naming both amounts, nothing sent', async () => {
    const r = funded({}, 3_250_000n);
    const error = await caught(() => r.client.transferUsdc(TO, '5.5'));

    expect(error).toBeInstanceOf(UserInputError);
    expect(error).toMatchObject({
      code: 'insufficient_balance',
      mayHaveLanded: false,
    });
    expect((error as Error).message).toContain('3.25');
    expect((error as Error).message).toContain('5.5');
    expect(r.sent).toEqual([]);
    expect(r.ledger.reads).toEqual([
      { to: USDC, name: 'balanceOf', args: [OWNER] },
    ]);
  });

  test('the whole balance can be sent', async () => {
    const r = funded({}, 5_000_000n);
    await r.client.transferUsdc(TO, 5);
    expect(r.sent).toHaveLength(1);
  });

  test('Smart wallet: the balance checked is the smart wallet’s', async () => {
    const r = funded({ identity: smartWalletIdentity() });
    await r.client.transferUsdc(TO, '1');
    expect(r.ledger.reads).toEqual([
      { to: USDC, name: 'balanceOf', args: [SMART_WALLET] },
    ]);
  });

  test('a reverted receipt is returned as it is, not thrown', async () => {
    const reverted: TxResult = {
      txHash: TX_HASH,
      status: 'reverted',
      blockNumber: 43n,
    };
    const r = funded({ railAnswer: reverted });
    expect(await r.client.transferUsdc(TO, '1')).toEqual(reverted);
  });

  test('a rail error propagates unchanged, mayHaveLanded intact', async () => {
    const failure = new TransactionFailedError('sponsor outcome unknown', {
      mayHaveLanded: true,
      nonce: 7n,
      code: 'sponsor_outcome_unknown',
      service: 'sponsor',
    });
    const r = funded({ railAnswer: failure });
    const error = await caught(() => r.client.transferUsdc(TO, '1'));
    expect(error).toBe(failure);
    expect(error).toMatchObject({ mayHaveLanded: true, nonce: 7n });
  });

  test('without a rail → rail_not_configured before the identity or any read', async () => {
    const r = funded({ rail: null });
    const error = await caught(() => r.client.transferUsdc(TO, '1'));

    expect(error).toBeInstanceOf(UserInputError);
    expect(error).toMatchObject({
      code: 'rail_not_configured',
      mayHaveLanded: false,
    });
    expect(r.identityCalls()).toBe(0);
    expect(r.chain.log).toEqual([]);
  });

  test('a failed balance read → chain_read_failed with mayHaveLanded false, nothing sent', async () => {
    const r = funded();
    r.ledger.override = () => new Error('down');
    expect(await caught(() => r.client.transferUsdc(TO, '1'))).toMatchObject({
      code: 'chain_read_failed',
      mayHaveLanded: false,
    });
    expect(r.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getBalances()
// ---------------------------------------------------------------------------

describe('AccountClient.getBalances', () => {
  test('every amount is a whole-unit decimal string: on-chain and orderbook', async () => {
    const r = rig({
      positions: {
        cash_balance: '12500000',
        positions: [
          { token_id: '11', balance: '1000000', reserved: '250000' },
          { token_id: '12', balance: '7', reserved: '0' },
        ],
      },
    });
    r.ledger.usdc.set(OWNER.toLowerCase(), 3_000_000n);
    r.ledger.tokens.set(pair(OWNER, '11'), 1_500_000n);

    expect(await r.client.getBalances()).toEqual({
      usdc: '3',
      tokens: { '11': '1.5', '12': '0' },
      orderbook: {
        cash: '12.5',
        positions: [
          { tokenId: '11', balance: '1', reserved: '0.25' },
          { tokenId: '12', balance: '0.000007', reserved: '0' },
        ],
      },
    });
  });

  test('tokens are the union of tokenIds and the /positions ids, read in one balanceOfBatch for the trader', async () => {
    const r = rig({
      positions: {
        cash_balance: '0',
        positions: [
          { token_id: '9', balance: '1', reserved: '0' },
          { token_id: '11', balance: '1', reserved: '0' },
        ],
      },
    });
    r.ledger.tokens.set(pair(OWNER, '7'), 2_000_000n);
    const balances = await r.client.getBalances({
      tokenIds: ['7', '009', '9'],
    });

    expect(Object.keys(balances.tokens)).toEqual(['7', '9', '11']);
    expect(balances.tokens['7']).toBe('2');
    const batches = r.ledger.reads.filter(
      (read) => read.name === 'balanceOfBatch',
    );
    expect(batches).toEqual([
      {
        to: CT,
        name: 'balanceOfBatch',
        args: [
          [OWNER, OWNER, OWNER],
          [7n, 9n, 11n],
        ],
      },
    ]);
  });

  test('more than 500 tokens → one balanceOfBatch per 500 ids, every balance in its place', async () => {
    expect(BALANCE_BATCH_SIZE).toBe(500);
    const r = rig();
    const ids = Array.from({ length: 1201 }, (_, i) => String(i + 1));
    // Each token holds its own id in micro-units, so a misplaced answer shows.
    for (const id of ids) {
      r.ledger.tokens.set(pair(OWNER, id), BigInt(id));
    }
    const balances = await r.client.getBalances({ tokenIds: ids });

    const batches = r.ledger.reads.filter(
      (read) => read.name === 'balanceOfBatch',
    );
    expect(
      batches.map((read) => {
        const [holders, chunk] = read.args as [Address[], bigint[]];
        return {
          holders: new Set(holders),
          first: chunk[0],
          last: chunk.at(-1),
          size: chunk.length,
        };
      }),
    ).toEqual([
      { holders: new Set([OWNER]), first: 1n, last: 500n, size: 500 },
      { holders: new Set([OWNER]), first: 501n, last: 1000n, size: 500 },
      { holders: new Set([OWNER]), first: 1001n, last: 1201n, size: 201 },
    ]);
    expect(balances.tokens).toEqual(
      Object.fromEntries(ids.map((id) => [id, fromMicro(BigInt(id))])),
    );
  });

  test('exactly 500 tokens → one balanceOfBatch', async () => {
    const r = rig();
    const ids = Array.from({ length: 500 }, (_, i) => String(i + 1));
    await r.client.getBalances({ tokenIds: ids });
    expect(
      r.ledger.reads.filter((read) => read.name === 'balanceOfBatch'),
    ).toHaveLength(1);
  });

  test('a wrong-length answer in a later chunk → chain_read_failed naming the chunk', async () => {
    const r = rig();
    const ids = Array.from({ length: 1001 }, (_, i) => String(i + 1));
    r.ledger.override = (read) => {
      const chunk = read.args[1] as bigint[] | undefined;
      return read.name === 'balanceOfBatch' && chunk?.[0] === 501n
        ? encodeFunctionResult({
            abi: CONDITIONAL_TOKENS_ABI,
            functionName: 'balanceOfBatch',
            result: chunk.slice(1),
          })
        : undefined;
    };
    const error = await caught(() => r.client.getBalances({ tokenIds: ids }));
    expect(error).toMatchObject({ code: 'chain_read_failed' });
    expect((error as Error).message).toContain('ids 500 to 999');
    expect((error as Error).message).toContain(
      '499 balances answered for 500 tokens',
    );
  });

  test('no token anywhere → no ConditionalTokens read, tokens {}', async () => {
    const r = rig();
    const balances = await r.client.getBalances();
    expect(balances).toEqual({
      usdc: '0',
      tokens: {},
      orderbook: { cash: '0', positions: [] },
    });
    expect(r.ledger.reads.map((read) => read.name)).toEqual(['balanceOf']);
  });

  test('Smart wallet: the balances are the smart wallet’s', async () => {
    const r = rig({ identity: smartWalletIdentity() });
    r.ledger.usdc.set(SMART_WALLET.toLowerCase(), 1_000_000n);
    r.ledger.tokens.set(pair(SMART_WALLET, '5'), 3_000_000n);
    const balances = await r.client.getBalances({ tokenIds: ['5'] });
    expect(balances.usdc).toBe('1');
    expect(balances.tokens).toEqual({ '5': '3' });
  });

  test('an orderbook error propagates unchanged: no partial result', async () => {
    const failure = new RequestRejectedError('no positions', {
      status: 404,
      code: 'not_found',
      service: 'orderbook',
    });
    const r = rig({ positions: failure });
    expect(await caught(() => r.client.getBalances())).toBe(failure);
  });

  test.each([
    ['cash_balance', { cash_balance: '1.5', positions: [] }],
    ['cash_balance', { cash_balance: '-1', positions: [] }],
    ['cash_balance', { cash_balance: '', positions: [] }],
    [
      'positions[0].balance',
      {
        cash_balance: '0',
        positions: [{ token_id: '1', balance: '1e6', reserved: '0' }],
      },
    ],
    [
      'positions[0].reserved',
      {
        cash_balance: '0',
        positions: [{ token_id: '1', balance: '1', reserved: ' 1' }],
      },
    ],
    [
      'positions[0].token_id',
      {
        cash_balance: '0',
        positions: [{ token_id: '0xabc', balance: '1', reserved: '0' }],
      },
    ],
  ])(
    'an orderbook %s that is not micro-units → UnexpectedResponseError',
    async (field, positions) => {
      const r = rig({ positions });
      const error = await caught(() => r.client.getBalances());
      expect(error).toBeInstanceOf(UnexpectedResponseError);
      expect(error).toMatchObject({ service: 'orderbook' });
      expect((error as Error).message).toContain(field);
    },
  );

  test('a bad tokenId is refused before anything is read', async () => {
    const r = rig();
    await expect(
      r.client.getBalances({ tokenIds: ['12', 'x'] }),
    ).rejects.toBeInstanceOf(UserInputError);
    await expect(
      r.client.getBalances({ tokenIds: '12' as never }),
    ).rejects.toBeInstanceOf(UserInputError);
    expect(r.book.calls).toBe(0);
    expect(r.chain.log).toEqual([]);
  });

  test('a balanceOfBatch answer of the wrong length → chain_read_failed', async () => {
    const r = rig();
    r.ledger.override = (read) =>
      read.name === 'balanceOfBatch'
        ? encodeFunctionResult({
            abi: CONDITIONAL_TOKENS_ABI,
            functionName: 'balanceOfBatch',
            result: [1n],
          })
        : undefined;
    expect(
      await caught(() => r.client.getBalances({ tokenIds: ['1', '2'] })),
    ).toMatchObject({ code: 'chain_read_failed', service: 'chain' });
  });

  test('a failed chain read → chain_read_failed', async () => {
    const r = rig();
    r.ledger.override = () => new Error('down');
    const error = await caught(() => r.client.getBalances());
    expect(error).toBeInstanceOf(XoError);
    expect(error).toMatchObject({ code: 'chain_read_failed' });
  });
});

// ---------------------------------------------------------------------------
// isDeployed()
// ---------------------------------------------------------------------------

describe('AccountClient.isDeployed', () => {
  test('EOA: always true, nothing read', async () => {
    const r = rig();
    expect(await r.client.isDeployed()).toBe(true);
    expect(r.chain.log).toEqual([]);
  });

  test('Smart wallet: whether it has code', async () => {
    const r = rig({ identity: smartWalletIdentity() });
    expect(await r.client.isDeployed()).toBe(true);
    r.chain.code.delete(SMART_WALLET.toLowerCase());
    expect(await r.client.isDeployed()).toBe(false);
    expect(r.chain.log).toEqual([
      { method: 'getCode', args: [SMART_WALLET] },
      { method: 'getCode', args: [SMART_WALLET] },
    ]);
  });

  test("Smart wallet: code '0x0' (as some nodes answer for none) is not deployed", async () => {
    const r = rig({ identity: smartWalletIdentity() });
    r.chain.code.set(SMART_WALLET.toLowerCase(), '0x0');
    expect(await r.client.isDeployed()).toBe(false);
  });

  test('Smart wallet: a failed code read → chain_read_failed', async () => {
    const r = rig({ identity: smartWalletIdentity() });
    r.chain.reader.getCode = async () => {
      throw new Error('down');
    };
    expect(await caught(() => r.client.isDeployed())).toMatchObject({
      code: 'chain_read_failed',
      service: 'chain',
    });
  });
});

describe('isEmptyCode: one rule for the rails and the account client', () => {
  test.each([
    ['0x', true],
    ['0x0', true],
    ['0x00', false],
    ['0x6000', false],
  ])('%s → %s', (code, empty) => {
    expect(isEmptyCode(code)).toBe(empty);
  });
});

// ---------------------------------------------------------------------------
// The identity
// ---------------------------------------------------------------------------

describe('AccountClient: identity() is asked on every operation, never cached', () => {
  test.each([
    ['setup', (client: AccountClient) => client.setup()],
    ['getBalances', (client: AccountClient) => client.getBalances()],
    ['transferUsdc', (client: AccountClient) => client.transferUsdc(TO, '1')],
    ['isDeployed', (client: AccountClient) => client.isDeployed()],
  ] as const)('%s', async (_, run) => {
    const r = rig();
    approveAll(r.ledger, OWNER);
    r.ledger.usdc.set(OWNER.toLowerCase(), 10_000_000n);
    await run(r.client);
    await run(r.client);
    expect(r.identityCalls()).toBe(2);
  });
});
