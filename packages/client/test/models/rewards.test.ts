import { type Address, getAddress } from 'viem';
import { describe, expect, expectTypeOf, test } from 'vitest';
import { UnexpectedResponseError } from '../../src/core/errors';
import type { ConditionId, DecimalString } from '../../src/core/types';
import {
  EarningPoolsPageSchema,
  type EarningPool as RawEarningPool,
  type RewardsLeaderboardRow as RawLeaderboardRow,
  type RewardsMakerOrder as RawMakerOrder,
  type RewardsMarketOrder as RawMarketOrder,
  type RewardsGroup as RawRewardsGroup,
  type RewardsGroupDetail as RawRewardsGroupDetail,
  type RewardsMarket as RawRewardsMarket,
  type RewardsMarketEpoch as RawRewardsMarketEpoch,
  type RewardsWalletEpoch as RawWalletEpoch,
  type RewardsWalletSummary as RawWalletSummary,
  RewardsGroupDetailSchema,
  RewardsGroupsPageSchema,
  RewardsLeaderboardRowSchema,
  RewardsMakerOrdersPageSchema,
  RewardsMakersPageSchema,
  RewardsMarketEpochSchema,
  RewardsMarketOrdersPageSchema,
  RewardsMarketSchema,
  RewardsWalletEpochSchema,
  RewardsWalletSummarySchema,
} from '../../src/data/rewardsSchemas';
import { OrderSide } from '../../src/models/enums';
import {
  type MarketRewardsDetails,
  type MarketRewardsEpoch,
  type RewardBonus,
  type RewardGroup,
  type RewardPool,
  type RewardProgramme,
  type RewardsLeaderboardEntry,
  type RewardsLeaderboardStanding,
  type RewardsMaker,
  type RewardsOrder,
  toMarketRewardsDetails,
  toMarketRewardsEpoch,
  toMarketRewardsOrder,
  toRewardGroup,
  toRewardPool,
  toRewardsLeaderboardEntry,
  toRewardsLeaderboardStanding,
  toRewardsMaker,
  toUserRewards,
  toUserRewardsEpoch,
  toUserRewardsOrder,
  type UserRewards,
  type UserRewardsEpoch,
} from '../../src/models/rewards';
import { OWNER } from '../helpers/mockAccountData';
import {
  earningPoolFixture,
  earningPoolsFixture,
  groupDetailFixture,
  groupFixture,
  leaderboardRowFixture,
  MAKER,
  MS_DAY,
  marketDetailFixture,
  marketEpochFixture,
  marketMakersFixture,
  marketOrdersFixture,
  OWNER_RANK,
  OWNER_WALLET,
  REWARD_GROUP,
  REWARD_MARKET,
  REWARD_MARKET_2,
  SCORED_EPOCH,
  STRANGER,
  TODAY_EPOCH,
  walletEpochFixture,
  walletOrdersFixture,
  walletSummaryFixture,
} from '../helpers/mockRewardsData';
import { keysOf, wireStyleKeys } from '../helpers/modelKeys';

const iso = (ms: number): string => new Date(ms).toISOString();
const PROJECTED_THROUGH = iso(1_792_332_596_709);

function pool(
  patch: Record<string, unknown> = {},
  group = false,
): RawEarningPool {
  const [row] = EarningPoolsPageSchema.lenient.parse({
    data: [{ ...earningPoolFixture(REWARD_MARKET, { group }), ...patch }],
    meta: earningPoolsFixture().meta,
  }).data;
  if (row === undefined) {
    throw new Error('no row');
  }
  return row;
}

/** What the USDC and CP rails of the fixture say about their scoring, in the model's words. */
const CP_TERMS = {
  maxDistanceCents: 5,
  singleSidedFactor: 3,
  twoSidedBandLow: '0.499',
  twoSidedBandHigh: '0.501',
  maxAvgPrice: '0.98',
  minOrderRestMs: 500,
  minOrderSize: '5',
  minPayout: '1.00',
};
const USDC_TERMS = { ...CP_TERMS, minPayout: '0.010000' };

describe('toRewardPool', () => {
  test('maps an earning pool: the market, one programme per currency and the bonus windows', () => {
    expect(toRewardPool(pool())).toEqual({
      conditionId: REWARD_MARKET,
      market: {
        id: '69781',
        title: 'Will AC Milan lose at least 10 matches in 2026/2027 Serie A?',
        slug: 'will-ac-milan-lose-at-least-10-matches-in-20262027-7688',
        image: 'https://img.example/market.webp',
        category: 'SPORTS',
        status: 'ACTIVE',
        endDate: '2027-05-30T23:59:59.000Z',
        prices: { yes: '0.51', no: '0.49' },
      },
      groupId: null,
      programmes: [
        {
          currency: 'CP',
          active: true,
          inactiveReason: null,
          status: 'LIVE',
          dailyPool: '200.00',
          budgetTotal: '1000.00',
          budgetRemaining: '1000.00',
          daysRemaining: 4,
          startsAt: '2026-10-16T06:15:00Z',
          endsAt: '2026-10-21T06:14:59Z',
          estimatedApr: null,
          terms: CP_TERMS,
        },
        {
          currency: 'USDC',
          active: false,
          inactiveReason: 'window_elapsed',
          status: 'ENDED',
          dailyPool: '1004.000000',
          budgetTotal: '1004.018060',
          budgetRemaining: '1004.000000',
          daysRemaining: 0,
          startsAt: '2026-10-16T06:12:27Z',
          endsAt: null,
          estimatedApr: '3664600.00',
          terms: USDC_TERMS,
        },
      ],
      bonuses: [
        {
          windowId: '5ce306d5-a4f0-4b1e-83ec-b07bce8e5274',
          currency: 'CP',
          status: 'ENDED',
          amount: '50.00',
          remaining: '0.00',
          todayPool: '6.19',
          startsAt: '2026-10-15T08:55:00Z',
          endsAt: '2026-10-18T08:55:00Z',
          stoppedAt: null,
          label: null,
          kind: 'AD_HOC',
          allocationMethod: 'pro_rata',
        },
      ],
    });
  });

  test('a pool of a Pulse group carries the group id and its live bonus window first', () => {
    const mapped = toRewardPool(pool({}, true));

    expect(mapped.groupId).toBe(REWARD_GROUP);
    expect(
      mapped.bonuses.map((bonus) => [bonus.currency, bonus.status]),
    ).toEqual([
      ['USDC', 'LIVE'],
      ['CP', 'ENDED'],
    ]);
    expect(mapped.bonuses[0]).toMatchObject({
      label: 'Derby day',
      amount: '50.000000',
      remaining: '25.000000',
    });
  });

  test('a pool without a market or a rail has null and an empty list for each', () => {
    const mapped = toRewardPool(pool({ market: null, cp: null, usdc: null }));

    expect(mapped.market).toBeNull();
    expect(mapped.programmes).toEqual([]);
  });

  test('has the fields of the model and nothing else, and no snake_case or *ID key', () => {
    const mapped = toRewardPool(pool({}, true));

    expect(Object.keys(mapped).sort()).toEqual(
      ['conditionId', 'market', 'groupId', 'programmes', 'bonuses'].sort(),
    );
    expect(wireStyleKeys(mapped)).toEqual([]);
    for (const name of [
      'bookSnapshot',
      'bookSnapshotUpdatedAt',
      'contractMarketId',
      'marketId_',
      'programStartsAtMs',
      'startsAtMs',
    ]) {
      expect(keysOf(mapped), name).not.toContain(name);
    }
  });

  test('copies its lists and does not change the input', () => {
    const input = pool({}, true);
    const before = structuredClone(input);
    const mapped = toRewardPool(input);
    mapped.programmes.pop();
    mapped.bonuses.pop();

    expect(input).toEqual(before);
  });

  test('a rail time given only in milliseconds becomes an ISO 8601 time', () => {
    const base = pool();
    const mapped = toRewardPool({
      ...base,
      cp: base.cp && {
        ...base.cp,
        programStartsAt: null,
        programStartsAtMs: 1_792_131_300_000,
      },
    });

    expect(mapped.programmes[0]?.startsAt).toBe(iso(1_792_131_300_000));
  });

  test('an estimated rate that is not a plain decimal is null', () => {
    const base = pool();
    const mapped = toRewardPool({
      ...base,
      usdc: base.usdc && { ...base.usdc, estimatedApr: 'n/a' },
    });

    expect(mapped.programmes[1]?.estimatedApr).toBeNull();
  });

  test('has the public types', () => {
    expectTypeOf<RewardPool['conditionId']>().toEqualTypeOf<ConditionId>();
    expectTypeOf<RewardPool['groupId']>().toEqualTypeOf<string | null>();
    expectTypeOf<RewardPool['programmes']>().toEqualTypeOf<RewardProgramme[]>();
    expectTypeOf<RewardPool['bonuses']>().toEqualTypeOf<RewardBonus[]>();
    expectTypeOf<
      RewardProgramme['dailyPool']
    >().toEqualTypeOf<DecimalString | null>();
    expectTypeOf<RewardProgramme['active']>().toEqualTypeOf<boolean | null>();
  });
});

describe('toRewardGroup', () => {
  const listed = (n = 0): RawRewardsGroup => {
    const [row] = RewardsGroupsPageSchema.lenient.parse({
      page: 0,
      page_size: 10,
      total: 1,
      truncated: false,
      current_epoch: TODAY_EPOCH,
      current_epoch_open_ms: TODAY_EPOCH * MS_DAY,
      current_epoch_close_ms: (TODAY_EPOCH + 1) * MS_DAY,
      current_epoch_ends_in_ms: 1,
      groups: [groupFixture(n)],
    }).groups;
    if (row === undefined) {
      throw new Error('no row');
    }
    return row;
  };
  const detailed = (): RawRewardsGroupDetail =>
    RewardsGroupDetailSchema.lenient.parse(groupDetailFixture(REWARD_GROUP));

  test('maps a group of the list: product, programmes and bonuses; the day and the lifetime are not loaded', () => {
    const mapped = toRewardGroup(listed());

    expect(mapped).toMatchObject({
      groupId: REWARD_GROUP,
      active: true,
      activeMarkets: 174,
      product: {
        name: '5m Up/Down',
        slug: '5m-up-down',
        path: ['PULSE', 'BTC', '5m Up/Down'],
      },
      day: null,
      totalScoredLiquidity: null,
      lifetime: null,
    });
    expect(mapped.programmes[0]).toEqual({
      currency: 'CP',
      active: true,
      inactiveReason: null,
      status: 'LIVE',
      dailyPool: '200.00',
      budgetTotal: '1000.00',
      budgetRemaining: '1000.00',
      daysRemaining: 4,
      startsAt: '2026-10-16T06:15:00Z',
      endsAt: '2026-10-21T06:14:59Z',
      estimatedApr: null,
      terms: CP_TERMS,
    });
    expect(mapped.programmes[1]).toMatchObject({
      currency: 'USDC',
      active: false,
      inactiveReason: 'window_elapsed',
      status: 'ENDED',
      dailyPool: '200.000000',
      estimatedApr: '3664600.00',
      terms: USDC_TERMS,
    });
    expect(
      mapped.bonuses.map((bonus) => [bonus.currency, bonus.status]),
    ).toEqual([
      ['USDC', 'LIVE'],
      ['CP', 'ENDED'],
    ]);
    expect(mapped.bonuses[0]).toMatchObject({
      windowId: '1427f50e-b91f-4c19-a9f5-7e2b849fbea4',
      amount: '50.000000',
      remaining: '25.000000',
      todayPool: '6.190000',
      startsAt: '2026-10-15T08:55:00Z',
    });
  });

  test('a group without a label has a null product', () => {
    expect(toRewardGroup(listed(1)).product).toBeNull();
  });

  test('maps a group in full: the day in progress, the liquidity scored and what it paid over its life', () => {
    const mapped = toRewardGroup(detailed());

    expect(mapped.day).toEqual({
      epoch: TODAY_EPOCH,
      opensAt: iso(TODAY_EPOCH * MS_DAY),
      closesAt: iso((TODAY_EPOCH + 1) * MS_DAY),
    });
    expect(mapped.totalScoredLiquidity).toBe('385300915998620.312037');
    expect(mapped.activeMarkets).toBe(174);
    expect(mapped.lifetime).toEqual([
      {
        currency: 'CP',
        scoredEpochs: 6,
        latestEpoch: SCORED_EPOCH,
        totalScoredLiquidity: '385300915998620.312037',
        allocated: '2149.99',
        distributed: '1980.50',
        baseAllocated: '2049.99',
        bonusAllocated: '100.00',
        bonusOnlyEpochs: 0,
      },
      {
        currency: 'USDC',
        scoredEpochs: 6,
        latestEpoch: SCORED_EPOCH,
        totalScoredLiquidity: '385300915998620.312037',
        allocated: '2149.990000',
        distributed: '1980.500000',
        baseAllocated: '2049.990000',
        bonusAllocated: '100.000000',
        bonusOnlyEpochs: 0,
      },
    ]);
  });

  test('has no snake_case or *ID key, and the same fields for the list and the full group', () => {
    expect(wireStyleKeys(toRewardGroup(listed()))).toEqual([]);
    expect(wireStyleKeys(toRewardGroup(detailed()))).toEqual([]);
    expect(Object.keys(toRewardGroup(listed())).sort()).toEqual(
      Object.keys(toRewardGroup(detailed())).sort(),
    );
    expect(keysOf(toRewardGroup(detailed()))).not.toContain('productId');
  });

  test('a rail that is missing leaves no programme', () => {
    const base = detailed();

    expect(toRewardGroup({ ...base, cp: null, usdc: null }).programmes).toEqual(
      [],
    );
    expect(
      toRewardGroup({ ...base, usdc: null }).programmes.map((p) => p.currency),
    ).toEqual(['CP']);
  });

  test('copies its lists', () => {
    const input = detailed();
    const mapped = toRewardGroup(input);
    mapped.lifetime?.pop();
    mapped.programmes.pop();
    mapped.product?.path.pop();

    expect(input.lifetime_by_currency).toHaveLength(2);
    expect(input.product?.path).toHaveLength(3);
  });

  test('has the public types', () => {
    expectTypeOf<RewardGroup['groupId']>().toEqualTypeOf<string>();
    expectTypeOf<RewardGroup['activeMarkets']>().toEqualTypeOf<number>();
    expectTypeOf<RewardGroup['totalScoredLiquidity']>().toEqualTypeOf<
      string | null
    >();
  });
});

describe('toMarketRewardsDetails', () => {
  const raw = (patch: Record<string, unknown> = {}): RawRewardsMarket =>
    RewardsMarketSchema.lenient.parse({
      ...marketDetailFixture(REWARD_MARKET),
      ...patch,
    });

  test('maps a market: programmes, the day in progress, the liquidity scored and the lifetime figures', () => {
    const mapped = toMarketRewardsDetails(raw());

    expect(mapped).toMatchObject({
      conditionId: REWARD_MARKET,
      active: true,
      day: {
        epoch: TODAY_EPOCH,
        opensAt: iso(TODAY_EPOCH * MS_DAY),
        closesAt: iso((TODAY_EPOCH + 1) * MS_DAY),
      },
      totalScoredLiquidity: '385300915998620.312037',
      bonuses: [],
    });
    expect(mapped.programmes.map((p) => p.currency)).toEqual(['CP', 'USDC']);
    expect(mapped.lifetime.map((line) => line.currency)).toEqual([
      'CP',
      'USDC',
    ]);
    expect(mapped.lifetime[0]?.distributed).toBe('1980.50');
  });

  test('has the fields of the model and nothing else, and no snake_case or *ID key', () => {
    const mapped = toMarketRewardsDetails(raw());

    expect(Object.keys(mapped).sort()).toEqual(
      [
        'conditionId',
        'active',
        'programmes',
        'bonuses',
        'day',
        'totalScoredLiquidity',
        'lifetime',
      ].sort(),
    );
    expect(wireStyleKeys(mapped)).toEqual([]);
  });

  test('a rail XO does not have is left out, and an unreadable condition id passes through', () => {
    const mapped = toMarketRewardsDetails(
      raw({ usdc: null, market_id: `0x${'AB'.repeat(32)}` }),
    );

    expect(mapped.programmes.map((p) => p.currency)).toEqual(['CP']);
    expect(mapped.conditionId).toBe(`0x${'ab'.repeat(32)}`);
  });

  test('a day that has no time is an unexpected response', () => {
    expect(() =>
      toMarketRewardsDetails(raw({ current_epoch_open_ms: -1 })),
    ).toThrow(UnexpectedResponseError);
  });

  test('has the public types', () => {
    expectTypeOf<MarketRewardsDetails['day']>().toEqualTypeOf<
      NonNullable<RewardGroup['day']>
    >();
    expectTypeOf<MarketRewardsDetails['lifetime']>().toEqualTypeOf<
      NonNullable<RewardGroup['lifetime']>
    >();
  });
});

describe('toMarketRewardsEpoch', () => {
  const raw = (
    epoch = SCORED_EPOCH,
    options: { usdc?: boolean } = {},
  ): RawRewardsMarketEpoch =>
    RewardsMarketEpochSchema.lenient.parse(
      marketEpochFixture(REWARD_MARKET, epoch, options),
    );

  test('maps a settled day: one rail per currency with its pool, its score and its top makers', () => {
    const mapped = toMarketRewardsEpoch(raw());

    expect(mapped).toMatchObject({
      conditionId: REWARD_MARKET,
      day: {
        epoch: SCORED_EPOCH,
        opensAt: iso(SCORED_EPOCH * MS_DAY),
        closesAt: iso((SCORED_EPOCH + 1) * MS_DAY),
      },
      bonusOnly: false,
      omittedRails: [],
    });
    expect(mapped.rails).toHaveLength(2);
    expect(mapped.rails[0]).toMatchObject({
      currency: 'CP',
      pool: '200.00',
      status: 'settled',
      totalScore: '35277817245000.000000',
      makerCount: 5,
      allocated: '68.75',
      credited: '68.75',
      projected: false,
      projectedThrough: null,
    });
    expect(mapped.rails[0]?.makers[0]).toEqual({
      wallet: getAddress(MAKER),
      score: '35277817245000.000000',
      scoreShare: '1.00000000',
      effective: '68.75',
      allocated: '68.75',
      credited: '0.00',
      status: 'paid',
    });
    expect(mapped.rails[1]).toMatchObject({
      currency: 'USDC',
      pool: '500.000000',
      status: 'settled',
      totalScore: '12345678901234.500000',
      makerCount: 2,
      allocated: '200.008826',
      credited: '200.008826',
      projected: false,
    });
    expect(mapped.rails[1]?.makers[0]).toMatchObject({
      wallet: getAddress(MAKER),
      effective: '200.008826',
      allocated: '200.008826',
      credited: '200.008826',
      status: 'paid',
    });
    expect(mapped.rails[1]?.makers[1]).toMatchObject({
      credited: null,
      status: 'none',
    });
  });

  test("today's day is a live projection with the time it is projected to", () => {
    const mapped = toMarketRewardsEpoch(raw(TODAY_EPOCH));

    for (const rail of mapped.rails) {
      expect(rail.projected).toBe(true);
      expect(rail.projectedThrough).toBe(PROJECTED_THROUGH);
      expect(rail.status).toBe('projected');
    }
    expect(mapped.rails[1]?.makers[0]?.credited).toBeNull();
  });

  test('an answer without the USDC rail has one rail and names the one it left out', () => {
    const mapped = toMarketRewardsEpoch(raw(SCORED_EPOCH, { usdc: false }));

    expect(mapped.rails.map((rail) => rail.currency)).toEqual(['CP']);
    expect(mapped.omittedRails).toEqual(['USDC']);
  });

  test('has no snake_case or *ID key and does not carry the cents suffixes', () => {
    const mapped = toMarketRewardsEpoch(raw());

    expect(wireStyleKeys(mapped)).toEqual([]);
    for (const name of [
      'allocatedCp',
      'allocatedUsdc',
      'poolUsdc',
      'effectiveCp',
      'topMakers',
    ]) {
      expect(keysOf(mapped), name).not.toContain(name);
    }
  });

  test('copies its lists and does not change the input', () => {
    const input = raw();
    const before = structuredClone(input);
    const mapped = toMarketRewardsEpoch(input);
    mapped.rails.pop();
    mapped.rails[0]?.makers.pop();

    expect(input).toEqual(before);
  });

  test('has the public types', () => {
    expectTypeOf<MarketRewardsEpoch['rails']>().toEqualTypeOf<
      MarketRewardsEpoch['rails']
    >();
    expectTypeOf<MarketRewardsEpoch['rails'][number]['makers']>().toEqualTypeOf<
      RewardsMaker[]
    >();
    expectTypeOf<RewardsMaker['wallet']>().toEqualTypeOf<Address>();
    expectTypeOf<
      RewardsMaker['credited']
    >().toEqualTypeOf<DecimalString | null>();
  });
});

describe('toRewardsMaker', () => {
  test('maps a maker of a page of makers', () => {
    const page = RewardsMakersPageSchema.lenient.parse(
      marketMakersFixture(REWARD_MARKET, SCORED_EPOCH, 0, 10),
    );

    expect(
      page.makers.map(toRewardsMaker).map((maker) => maker.status),
    ).toEqual(['paid', 'none', 'none', 'none', 'none']);
    expect(toRewardsMaker(page.makers[1] as never).wallet).toBe(
      getAddress(`0x${'41'.repeat(20)}`),
    );
  });
});

describe('toMarketRewardsOrder and toUserRewardsOrder', () => {
  const marketOrder = (n = 0): RawMarketOrder => {
    const page = RewardsMarketOrdersPageSchema.lenient.parse(
      marketOrdersFixture(REWARD_MARKET, SCORED_EPOCH, 0, 10, undefined),
    );
    const row = page.orders[n];
    if (row === undefined) {
      throw new Error('no row');
    }
    return row;
  };
  const userOrder = (n = 0): RawMakerOrder => {
    const page = RewardsMakerOrdersPageSchema.lenient.parse(
      walletOrdersFixture(OWNER_WALLET, {
        epoch: SCORED_EPOCH,
        page: 0,
        pageSize: 10,
      }),
    );
    const row = page.orders[n];
    if (row === undefined) {
      throw new Error('no row');
    }
    return row;
  };

  test('maps a scored order of a market: the maker, a price from the tick, whole-share sizes', () => {
    expect(toMarketRewardsOrder(marketOrder())).toEqual({
      orderId: '101407907',
      conditionId: null,
      maker: getAddress(MAKER),
      outcome: 'Yes',
      side: OrderSide.BUY,
      price: '0.89',
      score: '5835224679864.586035',
      scoreShare: '0.16540776',
      payouts: [{ currency: 'CP', amount: '11.37' }],
      eligibleMs: 59_400_000,
      firstSeenAt: iso(SCORED_EPOCH * MS_DAY),
      lastSeenAt: iso((SCORED_EPOCH + 1) * MS_DAY),
      createdAt: iso(1_789_325_522_000),
      openingSize: '1000',
      closingSize: '961.219812',
      exit: null,
      scored: true,
      projected: null,
      groupId: null,
      scoring: null,
    });
  });

  test('maps an order of the account: the market, the payouts per currency and how it is scoring', () => {
    expect(toUserRewardsOrder(userOrder())).toEqual({
      orderId: '101401037',
      conditionId: REWARD_MARKET,
      maker: null,
      outcome: 'Yes',
      side: OrderSide.BUY,
      price: '0.79',
      score: '19333333333333.333333',
      scoreShare: '0.20000000',
      payouts: [
        { currency: 'CP', amount: '32.22' },
        { currency: 'USDC', amount: '2.500000' },
      ],
      eligibleMs: 55_680_000,
      firstSeenAt: iso(SCORED_EPOCH * MS_DAY),
      lastSeenAt: iso((SCORED_EPOCH + 1) * MS_DAY),
      createdAt: iso(1_789_324_083_746),
      openingSize: '1000',
      closingSize: '1000',
      exit: null,
      scored: true,
      projected: false,
      groupId: null,
      scoring: 'previously_scored',
    });
  });

  test('an order of a Pulse group carries its group id; an unscored order is not scored', () => {
    expect(toUserRewardsOrder(userOrder(4)).groupId).toBe(REWARD_GROUP);
    expect(
      toUserRewardsOrder({
        ...userOrder(),
        unscored: true,
        scoring_status: null,
      }),
    ).toMatchObject({ scored: false, scoring: null });
  });

  test('a sell is SELL, an order that filled or was cancelled says how it ended', () => {
    expect(toMarketRewardsOrder({ ...marketOrder(), side: 'Sell' }).side).toBe(
      OrderSide.SELL,
    );
    expect(toMarketRewardsOrder(marketOrder(4)).exit).toBe('filled');
    expect(
      toMarketRewardsOrder({ ...marketOrder(), exit_kind: 'cancelled' }).exit,
    ).toBe('cancelled');
  });

  test('both have the same fields, and no snake_case or *ID key', () => {
    const market = toMarketRewardsOrder(marketOrder());
    const user = toUserRewardsOrder(userOrder());

    expect(Object.keys(market).sort()).toEqual(Object.keys(user).sort());
    expect(wireStyleKeys(market)).toEqual([]);
    expect(wireStyleKeys(user)).toEqual([]);
    for (const name of [
      'openingSizeShares',
      'closingSizeShares',
      'priceTick',
      'unscored',
    ]) {
      expect(keysOf(user), name).not.toContain(name);
    }
  });

  test('a price tick that is not a whole number from 0 to 1000 is an unexpected response', () => {
    for (const price_tick of [-1, 1.5, 1001]) {
      expect(
        () => toMarketRewardsOrder({ ...marketOrder(), price_tick }),
        String(price_tick),
      ).toThrow(UnexpectedResponseError);
    }
    expect(
      toMarketRewardsOrder({ ...marketOrder(), price_tick: 1000 }).price,
    ).toBe('1');
    expect(
      toMarketRewardsOrder({ ...marketOrder(), price_tick: 1 }).price,
    ).toBe('0.001');
  });

  test('a size that is not micro-shares is an unexpected response that names the field, not the value', () => {
    const bad = {
      ...marketOrder(),
      opening_size_micro: 'secret-1.5',
    } as RawMarketOrder;

    expect(() => toMarketRewardsOrder(bad)).toThrow(UnexpectedResponseError);
    try {
      toMarketRewardsOrder(bad);
    } catch (error) {
      expect((error as Error).message).toContain('openingSize');
      expect((error as Error).message).not.toContain('secret');
    }
  });

  test('does not change its input and returns plain JSON data', () => {
    const input = userOrder();
    const before = structuredClone(input);
    const mapped = toUserRewardsOrder(input);
    mapped.payouts.pop();

    expect(input).toEqual(before);
    expect(JSON.parse(JSON.stringify(mapped))).toEqual(mapped);
  });

  test('has the public types', () => {
    expectTypeOf<RewardsOrder['side']>().toEqualTypeOf<OrderSide>();
    expectTypeOf<RewardsOrder['maker']>().toEqualTypeOf<Address | null>();
    expectTypeOf<
      RewardsOrder['conditionId']
    >().toEqualTypeOf<ConditionId | null>();
    expectTypeOf<RewardsOrder['openingSize']>().toEqualTypeOf<DecimalString>();
    expectTypeOf<RewardsOrder['firstSeenAt']>().toEqualTypeOf<string>();
  });
});

describe('toUserRewards', () => {
  const raw = (wallet: string = MAKER): RawWalletSummary =>
    RewardsWalletSummarySchema.lenient.parse(walletSummaryFixture(wallet));

  test('maps the summary: totals, what settled today and the open day, per currency', () => {
    const openDay = {
      allocated: '0.00',
      effective: '0.00',
      paid: '0.00',
      estimate: '12.50',
      credited: null,
      projected: true,
      projectedThrough: PROJECTED_THROUGH,
      status: 'projected',
      baseAmount: '0.00',
      bonusAmount: '0.00',
    };
    expect(toUserRewards(raw())).toEqual({
      flagged: false,
      day: {
        epoch: TODAY_EPOCH,
        opensAt: iso(TODAY_EPOCH * MS_DAY),
        closesAt: iso((TODAY_EPOCH + 1) * MS_DAY),
      },
      usdc: {
        totalReceived: '378.43',
        makerRebates: { lifetime: '7.80', today: '0.00' },
        liquidityRewards: { lifetime: '370.63', today: '20.00' },
        currentDay: openDay,
      },
      cp: {
        totalReceived: '7833.97',
        liquidity: { lifetime: '7833.97', today: '100.00' },
        creatorBonus: '0.00',
        currentDay: openDay,
      },
    });
  });

  test('a wallet with no activity reads zeros, with no projection', () => {
    const mapped = toUserRewards(raw(STRANGER));

    expect(mapped.cp?.totalReceived).toBe('0.00');
    expect(mapped.usdc?.currentDay).toMatchObject({
      estimate: '0.00',
      projected: false,
      projectedThrough: null,
      status: 'none',
    });
  });

  test('a summary without an account has no currency figures', () => {
    expect(toUserRewards({ ...raw(), me: null })).toMatchObject({
      usdc: null,
      cp: null,
    });
  });

  test('an unknown key anywhere in the summary stays out of the model, nested totals included', () => {
    const fixture = walletSummaryFixture(MAKER) as {
      meta: Record<string, unknown>;
      me: {
        usdc: Record<string, Record<string, unknown>>;
        cp: Record<string, Record<string, unknown>>;
      };
    };
    const extra = { wire_extra: 'x', wireExtra: 'x' };
    Object.assign(fixture, extra);
    Object.assign(fixture.meta, extra);
    for (const side of [fixture.me.usdc, fixture.me.cp]) {
      Object.assign(side, extra);
      for (const group of Object.values(side)) {
        if (typeof group === 'object') {
          Object.assign(group, extra);
        }
      }
    }
    const input = RewardsWalletSummarySchema.lenient.parse(fixture);

    expect(keysOf(input)).toContain('wire_extra');
    expect(input.me?.usdc.makerRebates).toHaveProperty('wire_extra');
    expect(input.me?.usdc.liquidityRewards).toHaveProperty('wire_extra');
    expect(input.me?.cp.liquidity).toHaveProperty('wire_extra');

    const mapped = toUserRewards(input);

    expect(keysOf(mapped)).not.toContain('wire_extra');
    expect(keysOf(mapped)).not.toContain('wireExtra');
    expect(Object.keys(mapped.usdc?.makerRebates ?? {}).sort()).toEqual([
      'lifetime',
      'today',
    ]);
    expect(Object.keys(mapped.usdc?.liquidityRewards ?? {}).sort()).toEqual([
      'lifetime',
      'today',
    ]);
    expect(Object.keys(mapped.cp?.liquidity ?? {}).sort()).toEqual([
      'lifetime',
      'today',
    ]);
    expect(mapped).toEqual(toUserRewards(raw()));
  });

  test('a day status XO leaves out is null', () => {
    const base = raw();
    const day = base.me?.cp.currentEpoch;
    const { status: _status, ...rest } = day as NonNullable<typeof day>;
    const mapped = toUserRewards({
      ...base,
      me: base.me && { ...base.me, cp: { ...base.me.cp, currentEpoch: rest } },
    });

    expect(mapped.cp?.currentDay.status).toBeNull();
  });

  test('has no snake_case or *ID key, and does not change the input', () => {
    const input = raw();
    const before = structuredClone(input);

    expect(wireStyleKeys(toUserRewards(input))).toEqual([]);
    expect(input).toEqual(before);
  });

  test('has the public types', () => {
    expectTypeOf<UserRewards['flagged']>().toEqualTypeOf<boolean>();
    expectTypeOf<
      NonNullable<UserRewards['cp']>['creatorBonus']
    >().toEqualTypeOf<DecimalString>();
  });
});

describe('toUserRewardsEpoch', () => {
  const raw = (wallet: string = MAKER): RawWalletEpoch =>
    RewardsWalletEpochSchema.lenient.parse(
      walletEpochFixture(wallet, SCORED_EPOCH),
    );

  test('maps a wallet day: the totals, the market lines and the owner profile', () => {
    expect(toUserRewardsEpoch(raw())).toEqual({
      wallet: getAddress(MAKER),
      day: {
        epoch: SCORED_EPOCH,
        opensAt: iso(SCORED_EPOCH * MS_DAY),
        closesAt: iso((SCORED_EPOCH + 1) * MS_DAY),
      },
      flagged: false,
      effectiveCp: '133.19',
      allocatedCp: '133.19',
      creditedCp: '0.00',
      markets: [
        {
          conditionId: REWARD_MARKET,
          currency: 'CP',
          score: '38666666666666.666667',
          scoreShare: '1.00000000',
          effective: '64.44',
          allocated: '64.44',
          credited: '0.00',
          status: 'paid',
        },
        {
          conditionId: REWARD_MARKET_2,
          currency: 'CP',
          score: '35277817245000.000000',
          scoreShare: '1.00000000',
          effective: '68.75',
          allocated: '68.75',
          credited: null,
          status: 'pending',
        },
      ],
      user: {
        userId: '138',
        username: 'xouser1148',
        name: null,
        profileImage: 'https://img.example/profile.jpg',
        verifiedBadge: false,
        achievements: [],
        convictionPoints: '19604.9',
        tier: 'Believer',
      },
    });
  });

  test('a wallet with no account and no market has an empty list and a null user', () => {
    const mapped = toUserRewardsEpoch(raw(STRANGER));

    expect(mapped.markets).toEqual([]);
    expect(mapped.user).toBeNull();
  });

  test('has no snake_case or *ID key and leaves out the avatar colour', () => {
    const mapped = toUserRewardsEpoch(raw());

    expect(wireStyleKeys(mapped)).toEqual([]);
    expect(keysOf(mapped)).not.toContain('roosterColor');
  });

  test('copies its lists', () => {
    const input = raw();
    const mapped = toUserRewardsEpoch(input);
    mapped.markets.pop();
    mapped.user?.achievements.push('x');

    expect(input.markets).toHaveLength(2);
    expect(input.user?.achievements).toEqual([]);
  });

  test('has the public types', () => {
    expectTypeOf<UserRewardsEpoch['wallet']>().toEqualTypeOf<Address>();
    expectTypeOf<
      UserRewardsEpoch['creditedCp']
    >().toEqualTypeOf<DecimalString | null>();
    expectTypeOf<
      NonNullable<UserRewardsEpoch['user']>['convictionPoints']
    >().toEqualTypeOf<DecimalString>();
    expectTypeOf<
      RewardsLeaderboardEntry['convictionPoints']
    >().toEqualTypeOf<DecimalString>();
  });
});

describe('the leaderboard', () => {
  const row = (rank: number): RawLeaderboardRow =>
    RewardsLeaderboardRowSchema.lenient.parse(leaderboardRowFixture(rank));

  test('toRewardsLeaderboardEntry maps a row with the profile of its wallet', () => {
    expect(toRewardsLeaderboardEntry(row(OWNER_RANK))).toEqual({
      rank: 3,
      wallet: getAddress(OWNER_WALLET),
      userId: String(OWNER.id),
      username: OWNER.username,
      name: null,
      profileImage: null,
      liquidityCp: '950.50',
      creditedCp: '900.50',
      marketDays: 21,
      verifiedBadge: false,
      isOg: false,
      achievements: [],
      convictionPoints: '5000',
      tier: 'Believer',
    });
  });

  test('a wallet with no XO account has a null user id and username', () => {
    expect(toRewardsLeaderboardEntry(row(1))).toMatchObject({
      rank: 1,
      userId: null,
      username: null,
      isOg: true,
    });
  });

  test('toRewardsLeaderboardStanding keeps the rank and the figures, not the profile', () => {
    expect(toRewardsLeaderboardStanding(row(OWNER_RANK))).toEqual({
      rank: 3,
      wallet: getAddress(OWNER_WALLET),
      liquidityCp: '950.50',
      creditedCp: '900.50',
      marketDays: 21,
    });
  });

  test('neither has a snake_case or *ID key, and the input is not changed', () => {
    const input = row(OWNER_RANK);
    const before = structuredClone(input);

    expect(wireStyleKeys(toRewardsLeaderboardEntry(input))).toEqual([]);
    expect(wireStyleKeys(toRewardsLeaderboardStanding(input))).toEqual([]);
    expect(input).toEqual(before);
    expect(keysOf(toRewardsLeaderboardEntry(input))).not.toContain(
      'walletAddress',
    );
  });

  test('has the public types', () => {
    expectTypeOf<RewardsLeaderboardEntry['rank']>().toEqualTypeOf<number>();
    expectTypeOf<RewardsLeaderboardEntry['userId']>().toEqualTypeOf<
      string | null
    >();
    expectTypeOf<
      RewardsLeaderboardStanding['wallet']
    >().toEqualTypeOf<Address>();
    expectTypeOf<
      RewardsLeaderboardStanding['liquidityCp']
    >().toEqualTypeOf<DecimalString>();
  });
});
