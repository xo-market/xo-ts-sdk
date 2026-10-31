import { describe, expect, expectTypeOf, test } from 'vitest';
import { UnexpectedResponseError } from '../../src/core/errors';
import type { ConditionId, DecimalString, TokenId } from '../../src/core/types';
import {
  type RewardsMarketConfig,
  RewardsMarketConfigSchema,
} from '../../src/data/rewardsSchemas';
import {
  type EffectiveFeeConfig,
  EffectiveFeeConfigSchema,
  type Market as RawMarket,
  MarketSchema as RawMarketSchema,
} from '../../src/data/schemas';
import {
  CLOB_MARKET_TYPE,
  type Market,
  toListedMarket,
  toMarket,
} from '../../src/models/market';
import type { OrderbookMarket } from '../../src/orderbook/schemas';
import {
  conditionIdOf,
  feeConfigFixture,
  marketFixture,
  RESOLVED_MARKET_ID,
} from '../helpers/mockBackendData';
import { marketConfigFixture } from '../helpers/mockRewardsData';

// The fixtures: backend market ids 1..14 with these market types (see mockBackendData.ts):
// 1 CLOB, 2 CLOB pulse, 3 CLOB, 4 CLOB pulse, 5 conviction, 6 standard, 7 pulse, 8 CLOB, ...
// and id 12 is a CLOB market that is closed and resolved (NO won).

const TOKEN_BASE =
  71321045679252212594626385532706912750332728571942532289631379312455583992563n;
/** The outcome token ids the fixture gives market `id`: outcome ids `id * 10` and `id * 10 + 1`. */
const yesTokenOf = (id: number): TokenId =>
  `${TOKEN_BASE + BigInt(id * 10)}` as TokenId;
const noTokenOf = (id: number): TokenId =>
  `${TOKEN_BASE + BigInt(id * 10 + 1)}` as TokenId;

function raw(id: number, patch: Record<string, unknown> = {}): RawMarket {
  return RawMarketSchema.lenient.parse({ ...marketFixture(id), ...patch });
}

function book(id: number, patch: Partial<OrderbookMarket> = {}) {
  const market: OrderbookMarket = {
    condition_id: conditionIdOf(id),
    tokens: [
      { token_id: yesTokenOf(id), outcome: 'Yes', price: '0.570' },
      { token_id: noTokenOf(id), outcome: 'No', price: '0.4305' },
    ],
    minimum_tick_size: '0.001',
    neg_risk: false,
    active: true,
    ...patch,
  };
  return market;
}

function fees(id: number): EffectiveFeeConfig {
  return EffectiveFeeConfigSchema.lenient.parse({ data: feeConfigFixture(id) })
    .data;
}

function rewards(id: number): RewardsMarketConfig {
  return RewardsMarketConfigSchema.lenient.parse(
    marketConfigFixture(conditionIdOf(id)),
  );
}

/** Every key at every depth of a plain value. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(keysOf);
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => [
      key,
      ...keysOf(child),
    ]);
  }
  return [];
}

/** The fixture's two outcomes and a third one. */
function threeOutcomes() {
  const [yes, no] = raw(1).outcomes ?? [];
  return [yes, no, { ...no, id: 999, index: 2, title: 'MAYBE' }];
}

function listed(id: number, patch: Record<string, unknown> = {}): Market {
  const market = toListedMarket(raw(id, patch));
  if (market === undefined) {
    throw new Error(`market ${id} was not mapped`);
  }
  return market;
}

describe('toListedMarket', () => {
  test('maps a CLOB row: id string, yes token from index 0, volume from totalVolumeInUSD, tick size null', () => {
    const market = listed(1);

    expect(market.id).toBe('1');
    expect(market.slug).toBe('market-1');
    expect(market.question).toBe('Will thing 1 happen?');
    expect(market.groupItemTitle).toBeNull();
    expect(market.conditionId).toBe(conditionIdOf(1));
    expect(market.description).toBe('Resolves YES if it does.');
    expect(market.category).toBe('Sports');
    expect(market.image).toBe('https://cdn.example/m.png');

    expect(market.outcomes.yes).toEqual({
      label: 'YES',
      tokenId: yesTokenOf(1),
      price: null,
    });
    expect(market.outcomes.no).toEqual({
      label: 'NO',
      tokenId: noTokenOf(1),
      price: null,
    });

    expect(market.metrics.volume).toBe('1500.00');
    expect(market.trading.minimumTickSize).toBeNull();
    expect(market.state).toEqual({
      active: true,
      closed: false,
      status: 'ACTIVE',
      acceptingOrders: null,
      startDate: '2026-10-01T12:00:00.000Z',
      endDate: '2026-12-01T00:00:00.000Z',
    });
  });

  test('a list row has no source for the order book fields: they are null, never invented', () => {
    const market = listed(1);

    expect(market.trading).toEqual({
      minimumTickSize: null,
      minimumOrderSize: null,
      feesEnabled: null,
      feeType: null,
      feeSchedule: null,
    });
    expect(market.rewards).toEqual({
      clobRewards: null,
      rewardsMinSize: null,
      rewardsMaxSpread: null,
    });
  });

  test('does not read the stale price the backend keeps on a CLOB outcome', () => {
    // The fixture's outcomes carry currentPrice 570000 and 430000.
    const market = listed(1);
    expect(market.outcomes.yes.price).toBeNull();
    expect(market.outcomes.no.price).toBeNull();
  });

  test('returns undefined for a row that is not a CLOB market', () => {
    expect(CLOB_MARKET_TYPE).toBe(2);
    for (const [id, type] of [
      [2, 'CLOB pulse'],
      [5, 'conviction'],
      [6, 'standard'],
      [7, 'pulse'],
    ] as const) {
      expect(toListedMarket(raw(id)), type).toBeUndefined();
    }
  });

  test('returns undefined for a row with 3 outcomes, with 1, and with none', () => {
    for (const outcomes of [
      threeOutcomes(),
      (raw(1).outcomes ?? []).slice(0, 1),
      [],
      undefined,
    ]) {
      expect(toListedMarket(raw(1, { outcomes }))).toBeUndefined();
    }
  });

  test('returns undefined when the two outcomes are not index 0 and 1', () => {
    const outcomes = (raw(1).outcomes ?? []).map((o) => ({ ...o, index: 1 }));
    expect(toListedMarket(raw(1, { outcomes }))).toBeUndefined();
  });

  test('takes yes from index 0 and no from index 1, whatever the order of the list', () => {
    const outcomes = [...(raw(1).outcomes ?? [])].reverse();
    const market = listed(1, { outcomes });
    expect(market.outcomes.yes.tokenId).toBe(yesTokenOf(1));
    expect(market.outcomes.no.tokenId).toBe(noTokenOf(1));
  });

  test('a missing outcomeTokenId maps to tokenId null', () => {
    const outcomes = (raw(1).outcomes ?? []).map((o, i) =>
      i === 0 ? { ...o, outcomeTokenId: undefined } : o,
    );
    const market = listed(1, { outcomes });
    expect(market.outcomes.yes.tokenId).toBeNull();
    expect(market.outcomes.yes.label).toBe('YES');
    expect(market.outcomes.no.tokenId).toBe(noTokenOf(1));

    const nulled = (raw(1).outcomes ?? []).map((o) => ({
      ...o,
      outcomeTokenId: null,
    }));
    const both = listed(1, { outcomes: nulled });
    expect(both.outcomes.yes.tokenId).toBeNull();
    expect(both.outcomes.no.tokenId).toBeNull();
  });

  test('a token id that is not a decimal uint256 is treated as missing', () => {
    const outcomes = (raw(1).outcomes ?? []).map((o, i) =>
      i === 0 ? { ...o, outcomeTokenId: '0xabc' } : o,
    );
    expect(listed(1, { outcomes }).outcomes.yes.tokenId).toBeNull();
  });

  test('a market without a usable condition id has conditionId null', () => {
    expect(listed(1, { conditionId: null }).conditionId).toBeNull();
    expect(listed(1, { conditionId: 'nope' }).conditionId).toBeNull();
    expect(
      listed(1, {
        conditionId: conditionIdOf(1).toUpperCase().replace('0X', '0x'),
      }).conditionId,
    ).toBe(conditionIdOf(1));
  });

  test('state follows the backend status', () => {
    const states = (status: string) => listed(1, { status }).state;
    expect(states('ACTIVE')).toMatchObject({ active: true, closed: false });
    expect(states('PAUSED')).toMatchObject({
      active: false,
      closed: false,
      status: 'PAUSED',
    });
    for (const status of ['CLOSED', 'RESOLVED', 'VOIDED', 'VOIDED_CLOSED']) {
      expect(states(status), status).toMatchObject({
        active: false,
        closed: true,
      });
    }
    // A status added later is kept as it is.
    expect(states('SOMETHING_NEW')).toMatchObject({
      active: false,
      closed: false,
      status: 'SOMETHING_NEW',
    });
  });

  test('a resolved market names the winner and when it resolved', () => {
    const market = listed(RESOLVED_MARKET_ID);
    expect(market.state).toMatchObject({ closed: true, status: 'CLOSED' });
    expect(market.resolution).toEqual({
      winningOutcome: 'no',
      resolvedAt: '2026-10-01T12:00:00.000Z',
      resolvedBy: '0x7777777777777777777777777777777777777777',
      resolutionType: 'MANUAL',
      sources: ['https://example.com'],
      evidence: null,
    });
  });

  test('an open market has no winner and no resolution time', () => {
    expect(listed(1).resolution).toMatchObject({
      winningOutcome: null,
      resolvedAt: null,
    });
  });

  test('the winner is found by id when only winningOutcomeId is there', () => {
    const base = raw(RESOLVED_MARKET_ID);
    const market = toListedMarket({ ...base, winningOutcome: undefined });
    expect(market?.resolution.winningOutcome).toBe('no');
    const yes = toListedMarket({
      ...base,
      winningOutcome: undefined,
      winningOutcomeId: base.outcomes?.[0]?.id,
    });
    expect(yes?.resolution.winningOutcome).toBe('yes');
    const unknown = toListedMarket({
      ...base,
      winningOutcome: undefined,
      winningOutcomeId: 99_999,
    });
    expect(unknown?.resolution.winningOutcome).toBeNull();
  });

  test('empty strings are no value', () => {
    const market = listed(1, {
      description: '',
      imageUrl: '',
      resolutionEvidence: '',
      resolverAddress: null,
    });
    expect(market.description).toBeNull();
    expect(market.image).toBeNull();
    expect(market.resolution.evidence).toBeNull();
    expect(market.resolution.resolvedBy).toBeNull();
  });

  test('evidence text and a checksummed resolver address come through', () => {
    const market = listed(1, {
      resolutionEvidence: 'See the final scoresheet.',
      resolverAddress: `0x${'ab'.repeat(20)}`,
    });
    expect(market.resolution.evidence).toBe('See the final scoresheet.');
    expect(market.resolution.resolvedBy).toBe(
      '0xABaBaBaBABabABabAbAbABAbABabababaBaBABaB',
    );
  });

  test('category is the first taxonomy node, else the raw category name, else null', () => {
    expect(listed(1).category).toBe('Sports');
    expect(
      listed(1, { categoryPath: undefined, categoryNameRaw: 'Politics' })
        .category,
    ).toBe('Politics');
    expect(listed(1, { categoryPath: [] }).category).toBeNull();
  });

  test('tags and the event come from the row', () => {
    expect(listed(1).tags).toEqual([{ key: 'league', value: 'wc' }]);
    expect(listed(1).events).toEqual([]);
    const placed = listed(1, {
      eventId: 'evt-1',
      rootEventSlug: 'argentina-vs-france',
    });
    expect(placed.events).toEqual([
      { id: 'evt-1', slug: 'argentina-vs-france' },
    ]);
    expect(listed(1, { eventId: 'evt-1' }).events).toEqual([
      { id: 'evt-1', slug: null },
    ]);
  });

  test('uses the fee config a detail row carries', () => {
    const market = listed(1, { effectiveFeeConfig: feeConfigFixture(1) });
    expect(market.trading.feesEnabled).toBe(true);
    expect(market.trading.feeSchedule?.takerFeeBps).toBe(200);
  });

  test('does not change the row it reads', () => {
    const row = raw(1);
    const before = JSON.stringify(row);
    toListedMarket(row);
    expect(JSON.stringify(row)).toBe(before);
  });

  test('the model is plain data that survives JSON', () => {
    const market = toMarket(raw(1), {
      orderbook: book(1),
      fees: fees(1),
      rewards: rewards(1),
    });
    expect(JSON.parse(JSON.stringify(market))).toEqual(market);
  });
});

describe('toMarket', () => {
  test('fills trading.minimumTickSize, minimumOrderSize, fees and rewards from the extras', () => {
    const market = toMarket(raw(1), {
      orderbook: book(1),
      fees: fees(1),
      rewards: rewards(1),
    });

    expect(market.trading).toEqual({
      minimumTickSize: '0.001',
      minimumOrderSize: '1',
      feesEnabled: true,
      feeType: 'FLAT_BPS',
      feeSchedule: {
        takerFeeBps: 200,
        makerFeeBps: 0,
        split: {
          creatorShareBps: 5000,
          makerShareBps: 2500,
          platformShareBps: 2500,
        },
      },
    });
    expect(market.rewards).toEqual({
      clobRewards: [
        {
          currency: 'CP',
          active: true,
          rewardsAmount: '1000',
          rewardsDailyRate: '200',
          startDate: '2026-10-16T06:15:00Z',
          endDate: '2026-10-21T06:14:59Z',
        },
        {
          currency: 'USDC',
          active: false,
          rewardsAmount: '1004.01806',
          rewardsDailyRate: '1004',
          startDate: '2026-10-16T06:15:00Z',
          endDate: null,
        },
      ],
      rewardsMinSize: '5',
      rewardsMaxSpread: 5,
    });
  });

  test('the order book says whether the market accepts orders', () => {
    const closed = toMarket(raw(1), {
      orderbook: book(1, { active: false }),
    });
    expect(closed.state.acceptingOrders).toBe(false);
    expect(toMarket(raw(1), { orderbook: book(1) }).state.acceptingOrders).toBe(
      true,
    );
  });

  test('with no extras it is the list model', () => {
    expect(toMarket(raw(1), {})).toEqual(listed(1));
  });

  test('the tick size is the order book value, as it prints it', () => {
    const market = toMarket(raw(1), {
      orderbook: book(1, { minimum_tick_size: '0.01' }),
    });
    expect(market.trading.minimumTickSize).toBe('0.01');
  });

  test('outcome prices come from the order book tokens', () => {
    const market = toMarket(raw(1), { orderbook: book(1) });
    expect(market.outcomes.yes.price).toBe('0.570');
    expect(market.outcomes.no.price).toBe('0.4305');
    expect(market.outcomes.yes.tokenId).toBe(yesTokenOf(1));
  });

  test("a '0.000' midpoint/price becomes null", () => {
    const market = toMarket(raw(1), {
      orderbook: book(1, {
        tokens: [
          { token_id: yesTokenOf(1), outcome: 'Yes', price: '0.000' },
          { token_id: noTokenOf(1), outcome: 'No', price: '0' },
        ],
      }),
    });
    expect(market.outcomes.yes.price).toBeNull();
    expect(market.outcomes.no.price).toBeNull();

    const half = toMarket(raw(1), {
      orderbook: book(1, {
        tokens: [
          { token_id: yesTokenOf(1), outcome: 'Yes', price: '0.000' },
          { token_id: noTokenOf(1), outcome: 'No', price: '0.001' },
        ],
      }),
    });
    expect(half.outcomes.yes.price).toBeNull();
    expect(half.outcomes.no.price).toBe('0.001');
  });

  test('a price that is not a decimal is no price', () => {
    const market = toMarket(raw(1), {
      orderbook: book(1, {
        tokens: [
          { token_id: yesTokenOf(1), outcome: 'Yes', price: 'n/a' },
          { token_id: noTokenOf(1), outcome: 'No', price: '' },
        ],
      }),
    });
    expect(market.outcomes.yes.price).toBeNull();
    expect(market.outcomes.no.price).toBeNull();
  });

  test('a token the order book does not list for an outcome gives that outcome no price', () => {
    const market = toMarket(raw(1), {
      orderbook: book(1, {
        tokens: [{ token_id: '12345', outcome: 'Yes', price: '0.9' }],
      }),
    });
    expect(market.outcomes.yes.tokenId).toBe(yesTokenOf(1));
    expect(market.outcomes.yes.price).toBeNull();
    expect(market.outcomes.no.price).toBeNull();
  });

  test('a missing outcomeTokenId is filled from the order book token with the same label', () => {
    const outcomes = (raw(1).outcomes ?? []).map((o) => ({
      ...o,
      outcomeTokenId: undefined,
    }));
    const market = toMarket(raw(1, { outcomes }), { orderbook: book(1) });
    expect(market.outcomes.yes.tokenId).toBe(yesTokenOf(1));
    expect(market.outcomes.yes.price).toBe('0.570');
    expect(market.outcomes.no.tokenId).toBe(noTokenOf(1));
    expect(market.outcomes.no.price).toBe('0.4305');
  });

  test('a missing outcomeTokenId with no order book stays null', () => {
    const outcomes = (raw(1).outcomes ?? []).map((o) => ({
      ...o,
      outcomeTokenId: undefined,
    }));
    const market = toMarket(raw(1, { outcomes }), {});
    expect(market.outcomes.yes.tokenId).toBeNull();
    expect(market.outcomes.no.tokenId).toBeNull();
  });

  test('throws UnexpectedResponseError code market_not_binary for 3 outcomes', () => {
    let thrown: unknown;
    try {
      toMarket(raw(1, { outcomes: threeOutcomes() }), { orderbook: book(1) });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnexpectedResponseError);
    const error = thrown as UnexpectedResponseError;
    expect(error.code).toBe('market_not_binary');
    expect(error.service).toBe('backend');
    expect(error.message).toContain('Market 1');
    expect(error.message).toContain('3 outcomes');
    expect(error.mayHaveLanded).toBeUndefined();
    expect(error.issues).toEqual([
      expect.objectContaining({ path: 'outcomes' }),
    ]);
  });

  test('throws market_not_binary for one outcome and for none', () => {
    for (const outcomes of [
      (raw(1).outcomes ?? []).slice(0, 1),
      [],
      undefined,
    ]) {
      expect(() => toMarket(raw(1, { outcomes }), {})).toThrow(
        expect.objectContaining({
          name: 'UnexpectedResponseError',
          code: 'market_not_binary',
        }),
      );
    }
  });

  test('does not check the market type: a market asked for by id is mapped', () => {
    expect(toMarket(raw(5), {}).id).toBe('5');
    expect(toMarket(raw(2), {}).id).toBe('2');
  });

  test('fees: a config that does not apply to the market means no fees and no schedule', () => {
    const none: EffectiveFeeConfig = {
      ...fees(1),
      eligible: false,
      curveModel: 'LEGACY_CREATOR_BPS',
      takerFeeBps: 0,
      makerFeeBps: 0,
      configId: null,
      configName: null,
      splitSummary: null,
    };
    const market = toMarket(raw(1), { fees: none });
    expect(market.trading.feesEnabled).toBe(false);
    expect(market.trading.feeType).toBe('LEGACY_CREATOR_BPS');
    expect(market.trading.feeSchedule).toBeNull();
  });

  test('fees: a config with zero rates charges nothing but keeps its schedule', () => {
    const zero: EffectiveFeeConfig = {
      ...fees(1),
      takerFeeBps: 0,
      makerFeeBps: 0,
    };
    const market = toMarket(raw(1), { fees: zero });
    expect(market.trading.feesEnabled).toBe(false);
    expect(market.trading.feeSchedule).toMatchObject({
      takerFeeBps: 0,
      makerFeeBps: 0,
    });
  });

  test('fees: a maker fee alone means fees are on; no split is null', () => {
    const makerOnly: EffectiveFeeConfig = {
      ...fees(1),
      takerFeeBps: 0,
      makerFeeBps: 10,
      splitSummary: null,
    };
    const market = toMarket(raw(1), { fees: makerOnly });
    expect(market.trading.feesEnabled).toBe(true);
    expect(market.trading.feeSchedule).toEqual({
      takerFeeBps: 0,
      makerFeeBps: 10,
      split: null,
    });
  });

  test('fees: the extra wins over the config the row carries', () => {
    const embedded = { ...feeConfigFixture(1), takerFeeBps: 999 };
    const market = toMarket(raw(1, { effectiveFeeConfig: embedded }), {
      fees: fees(1),
    });
    expect(market.trading.feeSchedule?.takerFeeBps).toBe(200);
  });

  test('rewards: a market with no programme has an empty list and no terms', () => {
    const empty: RewardsMarketConfig = { ...rewards(1), programmes: [] };
    const market = toMarket(raw(1), { rewards: empty });
    expect(market.rewards).toEqual({
      clobRewards: [],
      rewardsMinSize: null,
      rewardsMaxSpread: null,
    });
  });

  test('rewards: the terms come from the first programme that pays, else the first', () => {
    const [cp, usdc] = rewards(1).programmes;
    if (cp === undefined || usdc === undefined) {
      throw new Error('fixture has two programmes');
    }
    const config = (programmes: RewardsMarketConfig['programmes']) =>
      toMarket(raw(1), { rewards: { ...rewards(1), programmes } }).rewards;

    const paying = config([
      {
        ...cp,
        active: false,
        min_order_size_shares: 7,
        max_distance_cents: '9',
      },
      {
        ...usdc,
        active: true,
        min_order_size_shares: 3,
        max_distance_cents: '4',
      },
    ]);
    expect(paying.rewardsMinSize).toBe('3');
    expect(paying.rewardsMaxSpread).toBe(4);

    const idle = config([
      {
        ...cp,
        active: false,
        min_order_size_shares: 7,
        max_distance_cents: '9',
      },
      {
        ...usdc,
        active: false,
        min_order_size_shares: 3,
        max_distance_cents: '4',
      },
    ]);
    expect(idle.rewardsMinSize).toBe('7');
    expect(idle.rewardsMaxSpread).toBe(9);
  });

  test('rewards: amounts are exact decimals, a missing one is null, a bad spread is null', () => {
    const [cp] = rewards(1).programmes;
    if (cp === undefined) {
      throw new Error('fixture has a programme');
    }
    const market = toMarket(raw(1), {
      rewards: {
        ...rewards(1),
        programmes: [
          {
            ...cp,
            daily_pool: null,
            budget_total: null,
            program_starts_at: null,
            program_ends_at: null,
            min_order_size_shares: 0.5,
            max_distance_cents: 'abc',
          },
        ],
      },
    });
    expect(market.rewards).toEqual({
      clobRewards: [
        {
          currency: 'CP',
          active: true,
          rewardsAmount: null,
          rewardsDailyRate: null,
          startDate: null,
          endDate: null,
        },
      ],
      rewardsMinSize: '0.5',
      rewardsMaxSpread: null,
    });
  });
});

describe('the mapped Market', () => {
  const full = () =>
    toMarket(
      raw(RESOLVED_MARKET_ID, { eventId: 'evt-1', rootEventSlug: 's' }),
      {
        orderbook: book(RESOLVED_MARKET_ID),
        fees: fees(RESOLVED_MARKET_ID),
        rewards: rewards(RESOLVED_MARKET_ID),
      },
    );

  test('no snake_case or *ID key anywhere in a mapped Market', () => {
    for (const market of [full(), listed(1)]) {
      const keys = keysOf(market);
      expect(keys.length).toBeGreaterThan(40);
      expect(keys.filter((key) => /_|ID$/.test(key))).toEqual([]);
    }
  });

  test('the market type is never exposed', () => {
    const keys = keysOf(full());
    for (const name of [
      'type',
      'marketType',
      'contractMarketId',
      'versionId',
    ]) {
      expect(keys, name).not.toContain(name);
    }
  });

  test('has the groups of the model and nothing else', () => {
    expect(Object.keys(full()).sort()).toEqual([
      'category',
      'conditionId',
      'description',
      'events',
      'groupItemTitle',
      'id',
      'image',
      'metrics',
      'outcomes',
      'question',
      'resolution',
      'rewards',
      'slug',
      'state',
      'tags',
      'trading',
    ]);
  });

  test('has the types of the model', () => {
    const market = full();
    expectTypeOf(market.id).toEqualTypeOf<string>();
    expectTypeOf(market.conditionId).toEqualTypeOf<ConditionId | null>();
    expectTypeOf(market.outcomes.yes.tokenId).toEqualTypeOf<TokenId | null>();
    expectTypeOf(
      market.outcomes.yes.price,
    ).toEqualTypeOf<DecimalString | null>();
    expectTypeOf(market.outcomes.no.label).toEqualTypeOf<string>();
    expectTypeOf(market.metrics.volume).toEqualTypeOf<DecimalString>();
    expectTypeOf(
      market.trading.minimumTickSize,
    ).toEqualTypeOf<DecimalString | null>();
    expectTypeOf(market.state.startDate).toEqualTypeOf<string | null>();
    expectTypeOf(toListedMarket).returns.toEqualTypeOf<Market | undefined>();
  });
});
