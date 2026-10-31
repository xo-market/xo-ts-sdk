import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import {
  type Address,
  decodeFunctionData,
  encodeFunctionResult,
  type Hex,
  maxUint256,
} from 'viem';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';
import { CONDITIONAL_TOKENS_ABI } from '../../src/account/abis';
import type { TxResult } from '../../src/account/chain';
import { AccountClient } from '../../src/account/client';
import { resetNonceTracking, withLanded } from '../../src/account/internal';
import { SponsoredRail, type TxRail } from '../../src/account/rails';
import {
  type AccountData,
  MAX_REDEEMABLE_SCAN,
  type RedeemAllEntry,
} from '../../src/account/settle';
import type { SponsorRequestBody } from '../../src/account/sponsorClient';
import {
  RequestRejectedError,
  TransactionFailedError,
  UnexpectedResponseError,
  UserInputError,
  XoError,
} from '../../src/core/errors';
import { type Paginator, pagePaginator } from '../../src/core/paginate';
import type { ConditionId, RawUnitsString } from '../../src/core/types';
import type { RedeemablePosition } from '../../src/data/portfolioSchemas';
import type {
  Claimable,
  MarketCapacity,
  MarketCapacityPosition,
} from '../../src/orderbook/schemas';
import { type Call, kernelExecuteCalldata } from '../../src/signing/kernel';
import type { TradingIdentity } from '../../src/wallet/identity';
import {
  eoaIdentity,
  OWNER,
  ownerSigner,
  type RailChainStub,
  railChain,
  SMART_WALLET,
  smartWalletIdentity,
  TX_HASH,
} from '../helpers/railChain';
import { testEnv } from '../helpers/testEnv';

// Merge and redeem. The calldata is pinned to literal bytes, the selectors
// included, so a wrong function, argument order, index set or amount fails here even though
// the chain stub decodes with the SDK's own ABI fragments.

const env = testEnv;
const USDC = env.contracts.usdc;
const CT = env.contracts.conditionalTokens;

const cond = (byte: string): ConditionId =>
  `0x${byte.repeat(32)}` as ConditionId;
const A = cond('a1');
const B = cond('b2');
const C = cond('c3');
const D = cond('d4');

const word = (hex: string): string =>
  hex.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const ZERO_WORD = word('0');
/** `mergePositions(address,bytes32,bytes32,uint256[],uint256)`: the array is the tail, at 0xa0. */
const mergeCalldata = (conditionId: string, micro: bigint): Hex =>
  `0x9e7212ad${word(USDC)}${ZERO_WORD}${word(conditionId)}${word('a0')}${word(
    micro.toString(16),
  )}${word('2')}${word('1')}${word('2')}`;
/** `redeemPositions(address,bytes32,bytes32,uint256[])`: the array is the tail, at 0x80. */
const redeemCalldata = (conditionId: string): Hex =>
  `0x01b7037c${word(USDC)}${ZERO_WORD}${word(conditionId)}${word('80')}${word(
    '2',
  )}${word('1')}${word('2')}`;
/** `payoutDenominator(bytes32)`. */
const payoutDenominatorCalldata = (conditionId: string): Hex =>
  `0xdd34de67${word(conditionId)}`;

const OK: TxResult = { txHash: TX_HASH, status: 'success', blockNumber: 42n };
const REVERTED: TxResult = {
  txHash: TX_HASH,
  status: 'reverted',
  blockNumber: 43n,
};

// ---------------------------------------------------------------------------
// The chain: payoutDenominator per condition, every read recorded
// ---------------------------------------------------------------------------

interface SettleChain extends RailChainStub {
  /** payoutDenominator by condition id (lower case); absent is 0 (not resolved). */
  denominators: Map<string, bigint>;
  /** The raw calldata of every readContract, in order. */
  reads: { to: Address; data: Hex }[];
  /** Answers the raw result instead (or throws), per condition id. */
  override?: (conditionId: string) => Hex | Error | undefined;
}

function settleChain(): SettleChain {
  const chain = railChain();
  const denominators = new Map<string, bigint>();
  const reads: { to: Address; data: Hex }[] = [];
  const stub: SettleChain = Object.assign(chain, { denominators, reads });
  chain.read = ({ to, data }) => {
    reads.push({ to, data });
    if (to.toLowerCase() !== CT.toLowerCase()) {
      return new Error('execution reverted');
    }
    const decoded = decodeFunctionData({ abi: CONDITIONAL_TOKENS_ABI, data });
    if (decoded.functionName !== 'payoutDenominator') {
      return new Error('execution reverted');
    }
    const [id] = decoded.args as readonly [Hex];
    const forced = stub.override?.(id.toLowerCase());
    if (forced !== undefined) {
      return forced;
    }
    return encodeFunctionResult({
      abi: CONDITIONAL_TOKENS_ABI,
      functionName: 'payoutDenominator',
      result: denominators.get(id.toLowerCase()) ?? 0n,
    });
  };
  return stub;
}

// ---------------------------------------------------------------------------
// The orderbook, the data client and the rail
// ---------------------------------------------------------------------------

/** A gateway answer as its JSON carries it: the micro-unit amounts are plain strings. */
type Wire<T> = T extends RawUnitsString
  ? string
  : T extends readonly (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

/** One capacity position; `free` and the rest in micro-shares. */
function position(
  outcome: string,
  free: string,
  extra: Partial<Wire<MarketCapacityPosition>> = {},
): MarketCapacityPosition {
  return {
    token_id: outcome === 'NO' ? '22' : '11',
    outcome,
    balance: free,
    reserved: '0',
    pending_settlement: '0',
    free_position: free,
    ...extra,
  } as MarketCapacityPosition;
}

function capacityOf(
  conditionId: string,
  positions: MarketCapacityPosition[],
): MarketCapacity {
  return {
    user_id: 'u-1',
    market_id: conditionId,
    free_market_capacity: '0' as RawUnitsString,
    positions,
    smart_account: null,
  };
}

function claimableOf(...marketIds: string[]): Claimable {
  return {
    address: OWNER.toLowerCase(),
    claimable: marketIds.map((market_id, i) => ({
      market_id,
      outcome: i % 2 === 0 ? 'YES' : 'NO',
      token_id: String(100 + i),
      balance: '1000000' as RawUnitsString,
      refund_reason: 'resolved_winner',
    })),
  };
}

interface BookOptions {
  capacity?: MarketCapacity | Error;
  claimable?: Claimable | Error;
}

function fakeOrderbook(o: BookOptions = {}) {
  const book = {
    capacityCalls: [] as string[],
    claimableCalls: 0,
    async getPositions(): Promise<never> {
      throw new Error('unused');
    },
    async getMarketCapacity(conditionId: string): Promise<MarketCapacity> {
      book.capacityCalls.push(conditionId);
      const answer =
        o.capacity ??
        capacityOf(conditionId, [position('YES', '0'), position('NO', '0')]);
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    },
    async getClaimable(): Promise<Claimable> {
      book.claimableCalls += 1;
      const answer = o.claimable ?? claimableOf();
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    },
  };
  return book;
}

/** A redeemable position of the data client: only the fields `redeemAll` reads matter. */
function redeemable(
  contractMarketId: string,
  type: number,
  role = 'user',
): RedeemablePosition {
  return {
    role,
    marketId: 1,
    contractMarketId,
    status: 'RESOLVED',
    type,
    claimableAmountWei: '0' as RawUnitsString,
    claimableAmountUSD: '0',
    position: {
      id: 1,
      status: 'ACTIVE',
      positionType: 'BUY',
      outcomeId: 1,
      shareAmount: '0' as RawUnitsString,
      shareAmountFormatted: '0',
    },
  };
}

/** `position` with a position id of its own: real pages differ, and identical pages end a list. */
function nth(position: RedeemablePosition, id: number): RedeemablePosition {
  return { ...position, position: { ...position.position, id } };
}

/** A data client whose `portfolio.redeemable()` serves `pages` (or fails with an error). */
function fakeData(pages: RedeemablePosition[][] | Error | 'endless') {
  const seen = { params: [] as unknown[], fetched: 0 };
  const data: AccountData = {
    portfolio: {
      redeemable(params?: unknown): Paginator<RedeemablePosition> {
        seen.params.push(params);
        return pagePaginator(async (page) => {
          seen.fetched += 1;
          if (pages instanceof Error) {
            throw pages;
          }
          if (pages === 'endless') {
            return {
              items: Array.from({ length: 100 }, (_, i) =>
                nth(redeemable(D, 2), page * 100 + i),
              ),
              hasNext: true,
              raw: null,
            };
          }
          return {
            items: pages[page - 1] ?? [],
            hasNext: page < pages.length,
            raw: null,
          };
        });
      },
    } as AccountData['portfolio'],
  };
  return { data, seen };
}

/** A rail that records each batch and answers `answer(n)` (or throws it); n counts from 1. */
function fakeRail(
  answer: (n: number, calls: Call[]) => TxResult | Error = () => OK,
) {
  const sent: Call[][] = [];
  const rail: TxRail = {
    async send(calls) {
      sent.push(calls);
      const out = answer(sent.length, calls);
      if (out instanceof Error) {
        throw out;
      }
      return out;
    },
  };
  return { rail, sent };
}

interface RigOptions extends BookOptions {
  identity?: TradingIdentity;
  /** `null`: no rail at all. */
  rail?: TxRail | null;
  railAnswer?: (n: number, calls: Call[]) => TxResult | Error;
  data?: AccountData;
  /** Defaults to recording into `warnings`. */
  warn?: (message: string) => void;
}

function rig(o: RigOptions = {}) {
  const chain = settleChain();
  const fake = fakeRail(o.railAnswer);
  const book = fakeOrderbook(o);
  const identity = o.identity ?? eoaIdentity();
  let identityCalls = 0;
  const warnings: string[] = [];
  const client = new AccountClient({
    env,
    identity: async () => {
      identityCalls += 1;
      return identity;
    },
    chain: chain.reader,
    orderbook: book,
    warn: o.warn ?? ((message) => warnings.push(message)),
    ...(o.rail === null ? {} : { rail: o.rail ?? fake.rail }),
    ...(o.data === undefined ? {} : { data: o.data }),
  });
  return {
    client,
    chain,
    sent: fake.sent,
    book,
    warnings,
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

/** The redeem call the client hands the rail for `conditionId`. */
const redeemBatch = (conditionId: string): Call[] => [
  { to: CT, data: redeemCalldata(conditionId), value: 0n },
];

// ---------------------------------------------------------------------------
// The ABI fragment payoutDenominator is read with
// ---------------------------------------------------------------------------

describe('CONDITIONAL_TOKENS_ABI: payoutDenominator', () => {
  test('payoutDenominator(bytes32) is in the fragment', () => {
    expect(
      CONDITIONAL_TOKENS_ABI.some((item) => item.name === 'payoutDenominator'),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('AccountClient: construction with merge and redeem', () => {
  const chain = settleChain().reader;
  const identity = async () => eoaIdentity();

  test.each(['getPositions', 'getMarketCapacity', 'getClaimable'] as const)(
    'refuses an orderbook without %s',
    (method) => {
      const { [method]: _, ...orderbook } = fakeOrderbook();
      expect(
        () =>
          new AccountClient({
            env,
            identity,
            chain,
            orderbook: orderbook as never,
          }),
      ).toThrow(UserInputError);
    },
  );

  test.each([
    ['null', null],
    ['no portfolio', {}],
    ['no redeemable', { portfolio: {} }],
    ['redeemable not a function', { portfolio: { redeemable: 1 } }],
  ])('refuses data with %s', (_, data) => {
    expect(
      () =>
        new AccountClient({
          env,
          identity,
          chain,
          orderbook: fakeOrderbook(),
          data: data as never,
        }),
    ).toThrow(UserInputError);
  });

  test.each([
    ['a string', 'console'],
    ['null', null],
  ])('refuses a warn that is %s', (_, warn) => {
    expect(
      () =>
        new AccountClient({
          env,
          identity,
          chain,
          orderbook: fakeOrderbook(),
          warn: warn as never,
        }),
    ).toThrow(UserInputError);
  });

  test('data is optional', () => {
    expect(
      () =>
        new AccountClient({
          env,
          identity,
          chain,
          orderbook: fakeOrderbook(),
        }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// merge()
// ---------------------------------------------------------------------------

describe('AccountClient.merge', () => {
  test('merge default uses free (unreserved) min; reserved tokens excluded', async () => {
    const r = rig({
      capacity: capacityOf(A, [
        // 10 YES held, 4 reserved by a resting SELL: 6 free.
        position('YES', '6000000', {
          balance: '10000000',
          reserved: '4000000',
        }),
        // 9 NO held, 1 pending settlement: 8 free.
        position('NO', '8000000', {
          balance: '9000000',
          pending_settlement: '1000000',
        }),
      ]),
    });
    const result = await r.client.merge(A);

    expect(result).toEqual(OK);
    expect(r.sent).toEqual([
      [{ to: CT, data: mergeCalldata(A, 6_000_000n), value: 0n }],
    ]);
    expect(r.book.capacityCalls).toEqual([A]);
    // Nothing is read on chain for a merge.
    expect(r.chain.reads).toEqual([]);
  });

  test('YES and NO are matched by outcome label, not array order: NO listed first', async () => {
    const r = rig({
      capacity: capacityOf(A, [
        position('NO', '2000000'),
        position('YES', '5000000'),
      ]),
    });
    await r.client.merge(A);
    expect(r.sent).toEqual([
      [{ to: CT, data: mergeCalldata(A, 2_000_000n), value: 0n }],
    ]);

    // The message names each side's own free amount.
    const error = await caught(() => r.client.merge(A, '3'));
    expect(error).toMatchObject({ code: 'amount_exceeds_free' });
    expect((error as Error).message).toContain('free YES 5');
    expect((error as Error).message).toContain('free NO 2');
  });

  test('the labels are read in any case, as the orderbook prints them', async () => {
    const r = rig({
      capacity: capacityOf(A, [
        position('no', '4000000'),
        position(' Yes ', '7000000'),
      ]),
    });
    await r.client.merge(A);
    expect(r.sent[0]?.[0]?.data).toBe(mergeCalldata(A, 4_000_000n));
  });

  test.each([
    ['5', 5_000_000n],
    ['2.5', 2_500_000n],
    [0.5, 500_000n],
    ['0.000001', 1n],
    ['6', 6_000_000n],
  ] as const)(
    'an explicit amount of %s whole shares is %s micro, exactly',
    async (amount, micro) => {
      const r = rig({
        capacity: capacityOf(A, [
          position('YES', '6000000'),
          position('NO', '9000000'),
        ]),
      });
      await r.client.merge(A, amount);
      expect(r.sent).toEqual([
        [{ to: CT, data: mergeCalldata(A, micro), value: 0n }],
      ]);
    },
  );

  test('merge amount above free → UserInputError naming free amount', async () => {
    const r = rig({
      capacity: capacityOf(A, [
        position('YES', '6000000', {
          balance: '10000000',
          reserved: '4000000',
        }),
        position('NO', '8000000'),
      ]),
    });
    const error = await caught(() => r.client.merge(A, '6.000001'));

    expect(error).toBeInstanceOf(UserInputError);
    expect(error).toMatchObject({
      code: 'amount_exceeds_free',
      mayHaveLanded: false,
    });
    // The free amount, in whole shares: min(6, 8).
    expect((error as Error).message).toContain('only 6 is free');
    expect((error as Error).message).toContain('6.000001');
    expect(r.sent).toEqual([]);
  });

  test('merge 0 free → UserInputError nothing_to_merge', async () => {
    const r = rig({
      capacity: capacityOf(A, [
        position('YES', '0', { balance: '5000000', reserved: '5000000' }),
        position('NO', '5000000'),
      ]),
    });
    const error = await caught(() => r.client.merge(A));

    expect(error).toBeInstanceOf(UserInputError);
    expect(error).toMatchObject({
      code: 'nothing_to_merge',
      mayHaveLanded: false,
    });
    expect(r.sent).toEqual([]);

    // An explicit amount does not change it: there is nothing free.
    expect(await caught(() => r.client.merge(A, '1'))).toMatchObject({
      code: 'nothing_to_merge',
    });
    expect(r.sent).toEqual([]);
  });

  test.each([
    ['no positions (a market the engine does not know)', []],
    ['YES only', [position('YES', '5000000')]],
    ['NO only', [position('NO', '5000000')]],
  ])('unknown market: %s → nothing_to_merge', async (_, positions) => {
    const r = rig({ capacity: capacityOf(A, positions) });
    const error = await caught(() => r.client.merge(A));
    expect(error).toBeInstanceOf(UserInputError);
    expect(error).toMatchObject({
      code: 'nothing_to_merge',
      mayHaveLanded: false,
    });
    expect((error as Error).message).toContain(A);
    expect(r.sent).toEqual([]);
  });

  test.each([
    [
      'two YES',
      [
        position('YES', '1000000'),
        position('YES', '1000000'),
        position('NO', '1000000'),
      ],
      'positions: must list YES once',
    ],
    [
      'a third outcome',
      [
        position('YES', '1000000'),
        position('NO', '1000000'),
        position('MAYBE', '1000000'),
      ],
      'positions[2].outcome',
    ],
    [
      'a decimal free_position',
      [position('YES', '1.5'), position('NO', '1000000')],
      'positions[0].free_position',
    ],
    [
      'a negative free_position',
      [position('YES', '1000000'), position('NO', '-1')],
      'positions[1].free_position',
    ],
    [
      'a blank free_position',
      [position('NO', '1000000'), position('YES', '')],
      'positions[1].free_position',
    ],
    [
      'an exponent',
      [position('NO', '1e6'), position('YES', '1000000')],
      'positions[0].free_position',
    ],
    [
      'a free_position above a uint256',
      [
        position('YES', '1000000'),
        position('NO', (maxUint256 + 1n).toString()),
      ],
      'positions[1].free_position: must fit a uint256',
    ],
  ])(
    'a capacity answer with %s → UnexpectedResponseError, nothing sent',
    async (_, positions, field) => {
      const r = rig({ capacity: capacityOf(A, positions) });
      const error = await caught(() => r.client.merge(A));
      expect(error).toBeInstanceOf(UnexpectedResponseError);
      expect(error).toMatchObject({
        service: 'orderbook',
        mayHaveLanded: false,
      });
      expect((error as Error).message).toContain('/data/market-capacity');
      expect((error as Error).message).toContain(field);
      expect(r.sent).toEqual([]);
    },
  );

  test.each([
    ['zero', '0'],
    ['zero as a number', 0],
    ['negative', '-1'],
    ['more than 6 decimals', '1.0000001'],
    ['an exponent', '1e3'],
    ['blank', ''],
    ['a bigint (ambiguous: whole units or micro?)', 5n],
    ['null', null],
    ['not finite', Number.POSITIVE_INFINITY],
    ['100 digits (beyond a uint256 of micro-units)', '1'.repeat(100)],
  ])('the amount is refused before anything is read: %s', async (_, amount) => {
    const r = rig();
    const error = await caught(() => r.client.merge(A, amount as never));
    expect(error).toBeInstanceOf(UserInputError);
    expect(error).toMatchObject({ mayHaveLanded: false });
    expect(r.book.capacityCalls).toEqual([]);
    expect(r.identityCalls()).toBe(0);
    expect(r.sent).toEqual([]);
  });

  test('a free_position of exactly maxUint256 is accepted', async () => {
    const top = maxUint256.toString();
    const r = rig({
      capacity: capacityOf(A, [position('YES', top), position('NO', top)]),
    });
    await r.client.merge(A);
    expect(r.sent[0]?.[0]?.data).toBe(mergeCalldata(A, maxUint256));
  });

  test('an amount typed string | undefined (or with a number) compiles: overload 3', async () => {
    // `pnpm typecheck` pins this: without the third overload these calls do not compile.
    const amounts: Array<string | undefined> = ['1', undefined];
    const mixed: Array<string | number | undefined> = [0.5, undefined];
    const r = rig({
      capacity: capacityOf(A, [
        position('YES', '3000000'),
        position('NO', '3000000'),
      ]),
    });
    for (const amount of amounts) {
      await r.client.merge(A, amount);
    }
    for (const amount of mixed) {
      await r.client.merge(A, amount);
    }
    // A plain `string | number` goes through overload 2.
    const plain = ['2'] as Array<string | number>;
    for (const amount of plain) {
      await r.client.merge(A, amount);
    }
    expect(r.sent.map((batch) => batch[0]?.data)).toEqual([
      mergeCalldata(A, 1_000_000n),
      mergeCalldata(A, 3_000_000n),
      mergeCalldata(A, 500_000n),
      mergeCalldata(A, 3_000_000n),
      mergeCalldata(A, 2_000_000n),
    ]);
  });

  test('a RawUnitsString amount is refused at compile time', async () => {
    const r = rig({
      capacity: capacityOf(A, [
        position('YES', '1000000'),
        position('NO', '1000000'),
      ]),
    });
    const raw = '570000' as RawUnitsString;
    // @ts-expect-error a raw token-unit amount is not a whole-unit amount
    const error = await caught(() => r.client.merge(A, raw));
    // At run time it is read as 570 000 shares, more than is free.
    expect(error).toMatchObject({ code: 'amount_exceeds_free' });
    expect(r.sent).toEqual([]);
  });

  test('the condition id is normalized: upper-case hex is read and encoded lower case', async () => {
    const r = rig({
      capacity: capacityOf(A, [
        position('YES', '1000000'),
        position('NO', '1000000'),
      ]),
    });
    await r.client.merge(`0x${'A1'.repeat(32)}`);
    expect(r.book.capacityCalls).toEqual([A]);
    expect(r.sent[0]?.[0]?.data).toBe(mergeCalldata(A, 1_000_000n));
  });

  test.each([
    ['short', '0x1234'],
    ['an address', OWNER],
    ['upper-case 0X', `0X${'a1'.repeat(32)}`],
    ['a number', 42],
  ])(
    'a bad condition id (%s) → UserInputError before anything',
    async (_, id) => {
      const r = rig();
      const error = await caught(() => r.client.merge(id as never));
      expect(error).toBeInstanceOf(UserInputError);
      expect(error).toMatchObject({ mayHaveLanded: false });
      expect(r.identityCalls()).toBe(0);
      expect(r.book.capacityCalls).toEqual([]);
    },
  );

  test('without a rail → rail_not_configured before the identity or any read', async () => {
    const r = rig({ rail: null });
    const error = await caught(() => r.client.merge(A));
    expect(error).toBeInstanceOf(UserInputError);
    expect(error).toMatchObject({
      code: 'rail_not_configured',
      mayHaveLanded: false,
    });
    expect(r.identityCalls()).toBe(0);
    expect(r.book.capacityCalls).toEqual([]);
  });

  test('a capacity read error propagates as it is, with mayHaveLanded false, nothing sent', async () => {
    const failure = new RequestRejectedError('no such market', {
      status: 404,
      code: 'not_found',
      service: 'orderbook',
    });
    const r = rig({ capacity: failure });
    const error = await caught(() => r.client.merge(A));
    expect(error).toBe(failure);
    expect(error).toMatchObject({ mayHaveLanded: false });
    expect(r.sent).toEqual([]);
  });

  test('a rail error propagates unchanged, mayHaveLanded intact', async () => {
    const failure = new TransactionFailedError('sponsor outcome unknown', {
      mayHaveLanded: true,
      nonce: 7n,
      code: 'sponsor_outcome_unknown',
      service: 'sponsor',
    });
    const r = rig({
      capacity: capacityOf(A, [
        position('YES', '1000000'),
        position('NO', '1000000'),
      ]),
      railAnswer: () => failure,
    });
    const error = await caught(() => r.client.merge(A));
    expect(error).toBe(failure);
    expect(error).toMatchObject({ mayHaveLanded: true, nonce: 7n });
  });

  test('a reverted receipt is returned as it is, not thrown', async () => {
    const r = rig({
      capacity: capacityOf(A, [
        position('YES', '1000000'),
        position('NO', '1000000'),
      ]),
      railAnswer: () => REVERTED,
    });
    expect(await r.client.merge(A)).toEqual(REVERTED);
  });

  test('Smart wallet: the same plain call goes to the rail, which sends it from the smart wallet', async () => {
    const r = rig({
      identity: smartWalletIdentity(),
      capacity: capacityOf(A, [
        position('YES', '3000000'),
        position('NO', '4000000'),
      ]),
    });
    await r.client.merge(A);
    // Not wrapped here: the rail wraps it in execute.
    expect(r.sent).toEqual([
      [{ to: CT, data: mergeCalldata(A, 3_000_000n), value: 0n }],
    ]);
  });
});

// ---------------------------------------------------------------------------
// redeem()
// ---------------------------------------------------------------------------

describe('AccountClient.redeem', () => {
  test('redeem encodes [1,2] index sets and zero parent collection', async () => {
    const r = rig();
    r.chain.denominators.set(A, 1n);
    const result = await r.client.redeem(A);

    expect(result).toEqual(OK);
    expect(r.sent).toEqual([redeemBatch(A)]);
    // Resolution is checked first, with one literal payoutDenominator read.
    expect(r.chain.reads).toEqual([
      { to: CT, data: payoutDenominatorCalldata(A) },
    ]);
  });

  test('payoutDenominator 0 → UserInputError not_resolved, nothing sent', async () => {
    const r = rig();
    const error = await caught(() => r.client.redeem(A));
    expect(error).toBeInstanceOf(UserInputError);
    expect(error).toMatchObject({
      code: 'not_resolved',
      mayHaveLanded: false,
    });
    expect((error as Error).message).toContain(A);
    expect(r.sent).toEqual([]);
  });

  test('a failed payoutDenominator read → chain_read_failed, nothing sent', async () => {
    const r = rig();
    r.chain.override = () => new Error('down');
    const error = await caught(() => r.client.redeem(A));
    expect(error).toBeInstanceOf(XoError);
    expect(error).toMatchObject({
      code: 'chain_read_failed',
      service: 'chain',
      mayHaveLanded: false,
    });
    expect(r.sent).toEqual([]);
  });

  test('a payoutDenominator answer that does not decode → chain_read_failed', async () => {
    const r = rig();
    r.chain.override = () => '0x';
    expect(await caught(() => r.client.redeem(A))).toMatchObject({
      code: 'chain_read_failed',
    });
    expect(r.sent).toEqual([]);
  });

  test('upper-case hex is normalized', async () => {
    const r = rig();
    r.chain.denominators.set(B, 1n);
    await r.client.redeem(`0x${'B2'.repeat(32)}`);
    expect(r.sent).toEqual([redeemBatch(B)]);
  });

  test('a bad condition id → UserInputError before anything', async () => {
    const r = rig();
    const error = await caught(() => r.client.redeem('0x12' as never));
    expect(error).toBeInstanceOf(UserInputError);
    expect(error).toMatchObject({ mayHaveLanded: false });
    expect(r.identityCalls()).toBe(0);
    expect(r.chain.reads).toEqual([]);
  });

  test('without a rail → rail_not_configured before the identity or any read', async () => {
    const r = rig({ rail: null });
    r.chain.denominators.set(A, 1n);
    const error = await caught(() => r.client.redeem(A));
    expect(error).toMatchObject({
      code: 'rail_not_configured',
      mayHaveLanded: false,
    });
    expect(r.identityCalls()).toBe(0);
    expect(r.chain.reads).toEqual([]);
  });

  test('a reverted receipt is returned as it is, not thrown', async () => {
    const r = rig({ railAnswer: () => REVERTED });
    r.chain.denominators.set(A, 1n);
    expect(await r.client.redeem(A)).toEqual(REVERTED);
  });

  test('a rail error propagates unchanged, mayHaveLanded intact', async () => {
    const failure = new TransactionFailedError('no receipt', {
      mayHaveLanded: true,
      transactionHash: TX_HASH,
      code: 'receipt_timeout',
      service: 'chain',
    });
    const r = rig({ railAnswer: () => failure });
    r.chain.denominators.set(A, 1n);
    const error = await caught(() => r.client.redeem(A));
    expect(error).toBe(failure);
    expect(error).toMatchObject({
      mayHaveLanded: true,
      transactionHash: TX_HASH,
    });
  });
});

// ---------------------------------------------------------------------------
// A smart wallet through a real rail
// ---------------------------------------------------------------------------

describe('merge and redeem from a smart wallet, through SponsoredRail', () => {
  const SEND_URL = `${env.sponsorUrl}/v1/sponsor/send`;
  const server = setupServer();
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
  beforeEach(() => resetNonceTracking());

  function smartWalletRig(capacity?: MarketCapacity) {
    const bodies: SponsorRequestBody[] = [];
    server.use(
      http.post(SEND_URL, async ({ request }) => {
        bodies.push((await request.json()) as SponsorRequestBody);
        return HttpResponse.json({ txHash: TX_HASH, executor: OWNER });
      }),
    );
    const identity = smartWalletIdentity();
    const chain = settleChain();
    const rail = new SponsoredRail({
      env,
      identity,
      signer: ownerSigner(),
      chain: chain.reader,
    });
    const client = new AccountClient({
      env,
      identity: async () => identity,
      chain: chain.reader,
      orderbook: fakeOrderbook({ capacity }),
      rail,
    });
    return { client, chain, bodies };
  }

  test('merge: one call to the smart wallet, execute(CT.mergePositions(...))', async () => {
    const k = smartWalletRig(
      capacityOf(A, [position('YES', '2000000'), position('NO', '2000000')]),
    );
    await k.client.merge(A);
    expect(k.bodies.map((body) => body.tx.calls)).toEqual([
      [
        {
          to: SMART_WALLET,
          value: '0x0',
          data: kernelExecuteCalldata([
            { to: CT, data: mergeCalldata(A, 2_000_000n), value: 0n },
          ]),
        },
      ],
    ]);
  });

  test('redeem: one call to the smart wallet, execute(CT.redeemPositions(...))', async () => {
    const k = smartWalletRig();
    k.chain.denominators.set(A, 1n);
    await k.client.redeem(A);
    expect(k.bodies.map((body) => body.tx.calls)).toEqual([
      [
        {
          to: SMART_WALLET,
          value: '0x0',
          data: kernelExecuteCalldata(redeemBatch(A)),
        },
      ],
    ]);
  });
});

// ---------------------------------------------------------------------------
// redeemAll()
// ---------------------------------------------------------------------------

describe('AccountClient.redeemAll', () => {
  const ids = (entries: RedeemAllEntry[]) => entries.map((e) => e.conditionId);

  test('redeemAll continues after one failure', async () => {
    const r = rig({ claimable: claimableOf(A, B, C) });
    r.chain.denominators.set(A, 1n);
    // B is not resolved on chain: a definite failure before any send.
    r.chain.denominators.set(C, 1n);
    const entries = await r.client.redeemAll();

    expect(ids(entries)).toEqual([A, B, C]);
    expect(entries[0]).toEqual({ conditionId: A, result: OK });
    expect(entries[1]?.result).toBeUndefined();
    expect(entries[1]?.error).toBeInstanceOf(UserInputError);
    expect(entries[1]?.error).toMatchObject({
      code: 'not_resolved',
      mayHaveLanded: false,
    });
    expect(entries[2]).toEqual({ conditionId: C, result: OK });
    expect(r.sent).toEqual([redeemBatch(A), redeemBatch(C)]);
  });

  test('candidates: orderbook then data, deduped, CLOB types 2/3/4 only, in order of first appearance', async () => {
    const E = cond('e5');
    const F = cond('f6');
    const G = cond('ef');
    const { data, seen } = fakeData([
      [
        redeemable(C, 2),
        redeemable(B, 3), // already from the orderbook
        redeemable(D, 0), // standard LMSR: settles elsewhere
        redeemable(E, 1), // pulse: settles elsewhere
      ],
      [
        redeemable(F, 4),
        redeemable('48608', 2), // not a condition id
        redeemable('0x49c3b3b4adcaa889cd42934f20f5a563d0bbfde8', 3), // an address
        redeemable(`0x${'EF'.repeat(32)}`, 3), // upper-case hex: G
        redeemable(C, 4), // a repeat
      ],
    ]);
    const r = rig({ claimable: claimableOf(A, B, A), data });
    for (const id of [A, B, C, D, E, F, G]) {
      r.chain.denominators.set(id, 1n);
    }
    const entries = await r.client.redeemAll();

    expect(ids(entries)).toEqual([A, B, C, F, G]);
    expect(entries.every((e) => e.result !== undefined)).toBe(true);
    expect(r.sent).toEqual([A, B, C, F, G].map(redeemBatch));
    // Every page was read, 100 positions at a time.
    expect(seen.fetched).toBe(2);
    expect(seen.params).toEqual([
      {
        role: 'user',
        sortBy: 'claimableAmount',
        sortOrder: 'DESC',
        take: 100,
      },
    ]);
    // Not cut at the cap: no warning.
    expect(r.warnings).toEqual([]);
  });

  test('without the data client the candidates are the orderbook claimable only', async () => {
    const r = rig({ claimable: claimableOf(B) });
    r.chain.denominators.set(B, 1n);
    expect(ids(await r.client.redeemAll())).toEqual([B]);
  });

  test(`more than ${MAX_REDEEMABLE_SCAN} data positions: the first ${MAX_REDEEMABLE_SCAN} are used, and warn is called once`, async () => {
    expect(MAX_REDEEMABLE_SCAN).toBe(1000);
    const E = cond('e5');
    // Ten full pages of D, then an eleventh whose market E is past the cap.
    const pages = [
      ...Array.from({ length: 10 }, (_, p) =>
        Array.from({ length: 100 }, (_, i) =>
          nth(redeemable(D, 2), p * 100 + i),
        ),
      ),
      [redeemable(E, 2)],
    ];
    const { data, seen } = fakeData(pages);
    const r = rig({ data });
    r.chain.denominators.set(D, 1n);
    r.chain.denominators.set(E, 1n);
    const entries = await r.client.redeemAll();

    expect(ids(entries)).toEqual([D]);
    // One position past the cap is fetched, to tell that the list goes on.
    expect(seen.fetched).toBe(11);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('more than 1000 redeemable positions');
    expect(r.warnings[0]).toContain(
      'Call redeemAllPositions() again once these redemptions have landed to pick up more',
    );
  });

  test(`exactly ${MAX_REDEEMABLE_SCAN} data positions: nothing is cut, no warning`, async () => {
    const pages = Array.from({ length: 10 }, (_, p) =>
      Array.from({ length: 100 }, (_, i) => nth(redeemable(D, 2), p * 100 + i)),
    );
    const { data, seen } = fakeData(pages);
    const r = rig({ data });
    r.chain.denominators.set(D, 1n);
    expect(ids(await r.client.redeemAll())).toEqual([D]);
    expect(seen.fetched).toBe(10);
    expect(r.warnings).toEqual([]);
  });

  test('an endless data list is read only to one past the cap', async () => {
    const { data, seen } = fakeData('endless');
    const r = rig({ data });
    r.chain.denominators.set(D, 1n);
    expect(ids(await r.client.redeemAll())).toEqual([D]);
    expect(seen.fetched).toBe(11);
    expect(r.warnings).toHaveLength(1);
  });

  test('warn is called once per cut redeemAll() call, and a throwing warn changes nothing', async () => {
    let calls = 0;
    const { data } = fakeData('endless');
    const r = rig({
      data,
      warn: () => {
        calls += 1;
        throw new Error('broken logger');
      },
    });
    r.chain.denominators.set(D, 1n);
    expect(ids(await r.client.redeemAll())).toEqual([D]);
    expect(ids(await r.client.redeemAll())).toEqual([D]);
    expect(calls).toBe(2);
    expect(r.sent).toEqual([redeemBatch(D), redeemBatch(D)]);
  });

  test("a data row whose role is not 'user' is skipped", async () => {
    const { data } = fakeData([
      [redeemable(C, 2, 'creator'), redeemable(D, 2)],
    ]);
    const r = rig({ data });
    r.chain.denominators.set(C, 1n);
    r.chain.denominators.set(D, 1n);
    expect(ids(await r.client.redeemAll())).toEqual([D]);
  });

  test('nothing to redeem → [] and nothing read on chain or sent', async () => {
    const { data } = fakeData([[redeemable(D, 0)]]);
    const r = rig({ data });
    expect(await r.client.redeemAll()).toEqual([]);
    expect(r.chain.reads).toEqual([]);
    expect(r.sent).toEqual([]);
  });

  test('a definite rail failure (mayHaveLanded false) is recorded and the rest continue', async () => {
    const refused = new TransactionFailedError('insufficient funds', {
      mayHaveLanded: false,
      code: 'sponsor_refused',
      service: 'sponsor',
    });
    const r = rig({
      claimable: claimableOf(A, B, C),
      railAnswer: (n) => (n === 1 ? refused : OK),
    });
    for (const id of [A, B, C]) {
      r.chain.denominators.set(id, 1n);
    }
    const entries = await r.client.redeemAll();
    expect(entries).toEqual([
      { conditionId: A, error: refused },
      { conditionId: B, result: OK },
      { conditionId: C, result: OK },
    ]);
    expect(entries[0]?.error).toBe(refused);
    expect(r.sent).toHaveLength(3);
  });

  test('an ambiguous failure (mayHaveLanded true) is recorded, then everything after it is skipped unsent', async () => {
    const unknown = new TransactionFailedError('no receipt', {
      mayHaveLanded: true,
      transactionHash: TX_HASH,
      nonce: 9n,
      code: 'receipt_timeout',
      service: 'chain',
    });
    const r = rig({
      claimable: claimableOf(A, B, C, D),
      railAnswer: (n) => (n === 2 ? unknown : OK),
    });
    for (const id of [A, B, C, D]) {
      r.chain.denominators.set(id, 1n);
    }
    const entries = await r.client.redeemAll();

    expect(ids(entries)).toEqual([A, B, C, D]);
    expect(entries[0]).toEqual({ conditionId: A, result: OK });
    expect(entries[1]).toEqual({ conditionId: B, error: unknown });
    expect(entries[1]?.error).toBe(unknown);
    for (const skipped of entries.slice(2)) {
      expect(skipped.result).toBeUndefined();
      expect(skipped.error).toBeInstanceOf(TransactionFailedError);
      expect(skipped.error).toMatchObject({
        code: 'skipped_after_ambiguous',
        mayHaveLanded: false,
      });
      expect(skipped.error?.message).toContain(B);
    }
    // Two sends, and nothing at all for C and D: not even their resolution read.
    expect(r.sent).toEqual([redeemBatch(A), redeemBatch(B)]);
    expect(r.chain.reads).toEqual([
      { to: CT, data: payoutDenominatorCalldata(A) },
      { to: CT, data: payoutDenominatorCalldata(B) },
    ]);
  });

  test('a rail failure without mayHaveLanded false is treated as ambiguous: it stops', async () => {
    const r = rig({
      claimable: claimableOf(A, B),
      railAnswer: () => new Error('custom rail exploded'),
    });
    r.chain.denominators.set(A, 1n);
    r.chain.denominators.set(B, 1n);
    const entries = await r.client.redeemAll();

    expect(entries[0]?.error).toBeInstanceOf(TransactionFailedError);
    expect(entries[0]?.error).toMatchObject({ mayHaveLanded: true });
    expect(entries[1]?.error).toMatchObject({
      code: 'skipped_after_ambiguous',
      mayHaveLanded: false,
    });
    expect(r.sent).toHaveLength(1);
  });

  test('a reverted receipt counts as a result, and the rest continue', async () => {
    const r = rig({
      claimable: claimableOf(A, B),
      railAnswer: (n) => (n === 1 ? REVERTED : OK),
    });
    r.chain.denominators.set(A, 1n);
    r.chain.denominators.set(B, 1n);
    expect(await r.client.redeemAll()).toEqual([
      { conditionId: A, result: REVERTED },
      { conditionId: B, result: OK },
    ]);
  });

  test('a claimable read failure rejects the whole call: nothing sent, mayHaveLanded false', async () => {
    const failure = new XoError('gateway down', {
      code: 'server_error',
      service: 'orderbook',
    });
    const { data, seen } = fakeData([[redeemable(C, 2)]]);
    const r = rig({ claimable: failure, data });
    const error = await caught(() => r.client.redeemAll());
    expect(error).toBe(failure);
    expect(error).toMatchObject({ mayHaveLanded: false });
    expect(seen.fetched).toBe(0);
    expect(r.chain.reads).toEqual([]);
    expect(r.sent).toEqual([]);
  });

  test('a data read failure rejects the whole call: nothing sent, mayHaveLanded false', async () => {
    const failure = new XoError('backend down', {
      code: 'server_error',
      service: 'backend',
    });
    const { data } = fakeData(failure);
    const r = rig({ claimable: claimableOf(A), data });
    r.chain.denominators.set(A, 1n);
    const error = await caught(() => r.client.redeemAll());
    expect(error).toBe(failure);
    expect(error).toMatchObject({ mayHaveLanded: false });
    expect(r.sent).toEqual([]);
  });

  test('a claimable market_id that is not a condition id → UnexpectedResponseError, nothing sent', async () => {
    const r = rig({ claimable: claimableOf(A, 'market-1') });
    r.chain.denominators.set(A, 1n);
    const error = await caught(() => r.client.redeemAll());
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(error).toMatchObject({ service: 'orderbook', mayHaveLanded: false });
    expect((error as Error).message).toContain('/claimable');
    expect((error as Error).message).toContain('claimable[1].market_id');
    expect(r.sent).toEqual([]);
  });

  test('upper-case orderbook ids are normalized and deduped against lower case', async () => {
    const r = rig({ claimable: claimableOf(`0x${'A1'.repeat(32)}`, A) });
    r.chain.denominators.set(A, 1n);
    expect(ids(await r.client.redeemAll())).toEqual([A]);
  });

  test('without a rail → rail_not_configured before the identity or any read', async () => {
    const r = rig({ rail: null, claimable: claimableOf(A) });
    const error = await caught(() => r.client.redeemAll());
    expect(error).toMatchObject({
      code: 'rail_not_configured',
      mayHaveLanded: false,
    });
    expect(r.identityCalls()).toBe(0);
    expect(r.book.claimableCalls).toBe(0);
  });

  test('Smart wallet: each redeem is the same plain call, handed to the rail', async () => {
    const r = rig({
      identity: smartWalletIdentity(),
      claimable: claimableOf(A),
    });
    r.chain.denominators.set(A, 1n);
    await r.client.redeemAll();
    expect(r.sent).toEqual([redeemBatch(A)]);
  });
});

// ---------------------------------------------------------------------------
// withLanded: what an error already says is kept
// ---------------------------------------------------------------------------

describe('withLanded', () => {
  test('a non-Transaction XoError carrying mayHaveLanded: true stays true', () => {
    const error = withLanded(
      new XoError('placed, maybe', { service: 'orderbook' }),
      true,
    );
    expect(withLanded(error, false)).toBe(error);
    expect(error.mayHaveLanded).toBe(true);
  });

  test('one carrying false stays false', () => {
    const error = withLanded(new XoError('refused'), false);
    expect(withLanded(error, true).mayHaveLanded).toBe(false);
  });

  test('one without it gets it; a TransactionFailedError keeps its own', () => {
    const plain = new XoError('read failed');
    expect(withLanded(plain, false).mayHaveLanded).toBe(false);
    const tx = new TransactionFailedError('no receipt', {
      mayHaveLanded: true,
    });
    expect(withLanded(tx, false).mayHaveLanded).toBe(true);
  });

  test('a capacity error already saying mayHaveLanded: true leaves merge() as it is', async () => {
    const failure = withLanded(
      new XoError('shared', { service: 'orderbook' }),
      true,
    );
    const r = rig({ capacity: failure });
    const error = await caught(() => r.client.merge(A));
    expect(error).toBe(failure);
    expect(error).toMatchObject({ mayHaveLanded: true });
    expect(r.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The identity
// ---------------------------------------------------------------------------

describe('merge, redeem, redeemAll: identity() is asked once per operation', () => {
  test.each([
    ['merge', (client: AccountClient) => client.merge(A)],
    ['redeem', (client: AccountClient) => client.redeem(A)],
    ['redeemAll', (client: AccountClient) => client.redeemAll()],
  ] as const)('%s', async (_, run) => {
    const r = rig({
      capacity: capacityOf(A, [
        position('YES', '1000000'),
        position('NO', '1000000'),
      ]),
      claimable: claimableOf(A, B),
    });
    r.chain.denominators.set(A, 1n);
    r.chain.denominators.set(B, 1n);
    await run(r.client);
    await run(r.client);
    expect(r.identityCalls()).toBe(2);
  });

  test('a bad identity is refused before anything is sent', async () => {
    const r = rig({
      identity: { type: 'other' } as never,
      claimable: claimableOf(A),
    });
    r.chain.denominators.set(A, 1n);
    for (const run of [
      () => r.client.merge(A),
      () => r.client.redeem(A),
      () => r.client.redeemAll(),
    ]) {
      const error = await caught(run);
      expect(error).toBeInstanceOf(UserInputError);
      expect(error).toMatchObject({ mayHaveLanded: false });
    }
    expect(r.sent).toEqual([]);
  });
});
