import { type Address, getAddress, type Hex } from 'viem';
import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import type { TxResult } from '../../src/account/chain';
import type { SetupAction } from '../../src/account/client';
import { UnexpectedResponseError } from '../../src/core/errors';
import type { ConditionId, DecimalString, TokenId } from '../../src/core/types';
import {
  AccountProfileSchema,
  PublicProfileSchema,
  UserStatsSchema,
} from '../../src/data/accountSchemas';
import {
  UserMarketActivitiesPageSchema,
  type UserMarketActivity,
} from '../../src/data/activitySchemas';
import {
  PnlMarketSchema,
  PnlPositionResultSchema,
  PnlSummarySchema,
  PortfolioDetailPageSchema,
  type PortfolioMarket,
  type PortfolioPosition,
  PortfolioSummaryPageSchema,
  PortfolioValueSchema,
} from '../../src/data/portfolioSchemas';
import {
  type Activity,
  type Balances,
  type MarketPnl,
  type Position,
  type PositionBalance,
  type PositionPnl,
  type PositionStatus,
  type Profile,
  type PublicProfile,
  type TradingApprovalsState,
  type TransactionHandle,
  type TransactionReceiptSummary,
  toActivity,
  toBalances,
  toMarketPnl,
  toPortfolioValue,
  toPosition,
  toPositionPnl,
  toPositions,
  toProfile,
  toPublicProfile,
  toTradingApprovalsState,
  toTransactionHandle,
  toTransactionReceiptSummary,
  toUserPnl,
  toUserStats,
  type UserPnl,
  type UserStats,
} from '../../src/models/account';
import { OrderSide } from '../../src/models/enums';
import type { MarketStatus } from '../../src/models/market';
import { PositionsSchema } from '../../src/orderbook/schemas';
import {
  currentUserFixture,
  fixtures,
  OWNER,
  PUBLIC_USER,
} from '../helpers/mockAccountData';
import {
  conditionIdOf,
  EVENT_ID,
  EVENT_SLUG,
  pageMeta,
} from '../helpers/mockBackendData';
import { TOKEN_NO, TOKEN_YES } from '../helpers/mockMarketData';
import { keysOf, wireStyleKeys } from '../helpers/modelKeys';

const TS = '2026-10-01T12:00:00.000Z';
const OUTCOME_TOKEN =
  '73921699981071296078090952507533822950204573800942628120869';
const TX = `0x${'ee'.repeat(32)}`;

/** A page schema's row, parsed the way the data client parses an answer. */
function pageOf<T>(schema: { lenient: { parse(v: unknown): { data: T[] } } }) {
  return (rows: unknown[]): T[] =>
    schema.lenient.parse({ data: rows, meta: pageMeta(1, 10, rows.length) })
      .data;
}

function detail(
  patch: Record<string, unknown> = {},
  marketId = 1,
  index = 0,
): PortfolioPosition {
  const [row] = pageOf<PortfolioPosition>(PortfolioDetailPageSchema)([
    { ...fixtures.positionFixture(marketId, index, 'detail'), ...patch },
  ]);
  if (row === undefined) {
    throw new Error('no row');
  }
  return row;
}

function summary(marketId = 1): PortfolioMarket {
  const [row] = pageOf<PortfolioMarket>(PortfolioSummaryPageSchema)([
    fixtures.portfolioMarketRow(marketId),
  ]);
  if (row === undefined) {
    throw new Error('no row');
  }
  return row;
}

/** The detail fixture's market, with a patch for what a test changes. */
function market(id: number, patch: Record<string, unknown>) {
  const base = fixtures.positionFixture(id, 0, 'detail').market as Record<
    string,
    unknown
  >;
  return { ...base, ...patch };
}

describe('toPosition', () => {
  test('maps a portfolio position: reference names, whole units, nulls for what is missing', () => {
    expect(toPosition(detail())).toEqual({
      positionId: '46010',
      marketId: '1',
      wallet: getAddress(OWNER.wallet),
      assetId: OUTCOME_TOKEN,
      conditionId: conditionIdOf(1),
      currentSize: '662.000004',
      avgPrice: '0.5',
      currentPrice: '0.9',
      currentValue: '595.800003',
      entryCostUsdc: '331.000002',
      unrealizedPnl: '264.80000099999995',
      realizedPnl: '0',
      percentPnl: '79.9999998187311',
      status: 'OPEN',
      redeemable: false,
      title: 'Market 1',
      slug: 'market-1',
      icon: 'https://img.example/market.png',
      eventId: null,
      eventSlug: null,
      outcome: 'Yes',
      outcomeIndex: 0,
      endDate: '2026-12-31T23:59:59.000Z',
      firstEntryAt: TS,
      lastEventAt: TS,
    });
  });

  test('a loss is a negative whole-unit decimal, converted exactly', () => {
    expect(toPosition(detail({}, 1, 1)).realizedPnl).toBe('-0.05');
    expect(
      toPosition(detail({ totalPnlInCollateral: '-123456789' })).realizedPnl,
    ).toBe('-123.456789');
  });

  test('has the fields of the model and nothing else, and no snake_case or *ID key', () => {
    const position = toPosition(detail());

    expect(Object.keys(position).sort()).toEqual(
      [
        'positionId',
        'marketId',
        'wallet',
        'assetId',
        'conditionId',
        'currentSize',
        'avgPrice',
        'currentPrice',
        'currentValue',
        'entryCostUsdc',
        'unrealizedPnl',
        'realizedPnl',
        'percentPnl',
        'status',
        'redeemable',
        'title',
        'slug',
        'icon',
        'eventId',
        'eventSlug',
        'outcome',
        'outcomeIndex',
        'endDate',
        'firstEntryAt',
        'lastEventAt',
      ].sort(),
    );
    expect(wireStyleKeys(position)).toEqual([]);
  });

  test('a row without an outcome, a price, a condition id or a realised PnL has null for each', () => {
    const position = toPosition(
      detail({
        outcome: null,
        entryPrice: null,
        totalPnlInCollateral: null,
        market: market(1, {
          conditionId: null,
          imageUrl: null,
          expiresAt: null,
        }),
      }),
    );

    expect(position).toMatchObject({
      assetId: null,
      conditionId: null,
      avgPrice: null,
      currentPrice: null,
      realizedPnl: null,
      outcome: null,
      outcomeIndex: null,
      icon: null,
      endDate: null,
    });
  });

  test('a condition id is lower-cased and a token id has no leading zeros', () => {
    const position = toPosition(
      detail({
        market: market(1, { conditionId: `0x${'AB'.repeat(32)}` }),
        outcome: {
          id: 801,
          title: 'Yes',
          index: 0,
          currentPrice: '900000',
          outcomeTokenId: '0042',
        },
      }),
    );

    expect(position.conditionId).toBe(`0x${'ab'.repeat(32)}`);
    expect(position.assetId).toBe('42');
  });

  test('the event comes from the market placement: its root event id and slug', () => {
    const [first] = toPositions(summary(1));

    expect(first?.eventId).toBe(EVENT_ID);
    expect(first?.eventSlug).toBe(EVENT_SLUG);
    expect(
      toPosition(detail({ market: market(1, { event: summary(1).event }) }))
        .eventSlug,
    ).toBe(EVENT_SLUG);
  });

  test('the status follows the market: open, redeemable once it resolved and the winnings are unclaimed, closed otherwise', () => {
    const open = toPosition(detail());
    expect([open.status, open.redeemable]).toEqual(['OPEN', false]);

    const unclaimed = toPosition(detail({}, 12));
    expect([unclaimed.status, unclaimed.redeemable]).toEqual([
      'REDEEMABLE',
      true,
    ]);

    const claimed = toPosition(detail({ hasClaimed: true }, 12));
    expect([claimed.status, claimed.redeemable]).toEqual(['CLOSED', false]);

    const sold = toPosition(detail({ status: 'CLOSED' }));
    expect([sold.status, sold.redeemable]).toEqual(['CLOSED', false]);

    for (const status of ['VOIDED', 'VOIDED_CLOSED']) {
      const voided = toPosition(
        detail({ market: market(1, { status }), hasClaimed: false }),
      );
      expect(voided.redeemable, status).toBe(true);
    }
    const stillOpen = toPosition(
      detail({ market: market(1, { status: 'PAUSED' }), hasClaimed: false }),
    );
    expect(stillOpen.redeemable).toBe(false);
  });

  test('only a position the SDK can redeem is redeemable: a settled market that pays out on its own contract is not', () => {
    // CLOB markets (2, 3 and 4) settle on the outcome-token contract, which the SDK redeems on.
    for (const type of [2, 3, 4]) {
      const position = toPosition(detail({ market: market(12, { type }) }, 12));
      expect([position.status, position.redeemable], `type ${type}`).toEqual([
        'REDEEMABLE',
        true,
      ]);
    }
    // Standard (0) and pulse (1) markets pay out on their own contracts: still settled and
    // unclaimed, but not redeemable here.
    for (const type of [0, 1]) {
      const position = toPosition(detail({ market: market(12, { type }) }, 12));
      expect([position.status, position.redeemable], `type ${type}`).toEqual([
        'REDEEMABLE',
        false,
      ]);
    }
  });

  test('an amount that is not micro-units is an unexpected response that names the field, not the value', () => {
    const bad = { ...detail(), shareAmount: 'secret-12abc' };

    expect(() => toPosition(bad as PortfolioPosition)).toThrow(
      UnexpectedResponseError,
    );
    try {
      toPosition(bad as PortfolioPosition);
    } catch (error) {
      expect(String((error as Error).message)).toContain('currentSize');
      expect(String((error as Error).message)).not.toContain('secret');
    }
  });

  test('does not change its input and returns plain JSON data', () => {
    const input = detail();
    const before = structuredClone(input);
    const position = toPosition(input);

    expect(input).toEqual(before);
    expect(JSON.parse(JSON.stringify(position))).toEqual(position);
  });

  test('has the public types', () => {
    expectTypeOf<Position['positionId']>().toEqualTypeOf<string>();
    expectTypeOf<Position['marketId']>().toEqualTypeOf<string>();
    expectTypeOf<Position['wallet']>().toEqualTypeOf<Address>();
    expectTypeOf<Position['assetId']>().toEqualTypeOf<TokenId | null>();
    expectTypeOf<Position['conditionId']>().toEqualTypeOf<ConditionId | null>();
    expectTypeOf<Position['currentSize']>().toEqualTypeOf<DecimalString>();
    expectTypeOf<Position['avgPrice']>().toEqualTypeOf<DecimalString | null>();
    expectTypeOf<
      Position['realizedPnl']
    >().toEqualTypeOf<DecimalString | null>();
    expectTypeOf<Position['status']>().toEqualTypeOf<PositionStatus>();
    expectTypeOf<Position['redeemable']>().toEqualTypeOf<boolean>();
    expectTypeOf<Position['outcomeIndex']>().toEqualTypeOf<number | null>();
  });
});

describe('toPositions', () => {
  test('flattens a summary row into its positions, in order, each with the row market', () => {
    const positions = toPositions(summary(1));

    expect(positions.map((position) => position.positionId)).toEqual([
      '46010',
      '46011',
    ]);
    expect(positions.map((position) => position.outcome)).toEqual([
      'Yes',
      'No',
    ]);
    expect(positions.every((position) => position.marketId === '1')).toBe(true);
    expect(positions[0]).toMatchObject({
      currentPrice: '0.9',
      currentSize: '662.000004',
    });
  });

  test('a market without an event leaves the event fields null', () => {
    const [first] = toPositions(summary(2));

    expect(first?.eventId).toBeNull();
    expect(first?.eventSlug).toBeNull();
  });

  test('copies the list: changing the result does not change the input', () => {
    const input = summary(1);
    const positions = toPositions(input);
    positions.pop();

    expect(input.positions).toHaveLength(2);
  });
});

describe('toActivity', () => {
  function row(n = 0, patch: Record<string, unknown> = {}): UserMarketActivity {
    const [item] = pageOf<UserMarketActivity>(UserMarketActivitiesPageSchema)([
      { ...fixtures.marketActivityFixture(n), ...patch },
    ]);
    if (item === undefined) {
      throw new Error('no row');
    }
    return item;
  }

  test('maps a trade: a type, a side, shares, an amount in dollars and a price', () => {
    expect(toActivity(row(0))).toEqual({
      id: '5000',
      type: 'TRADE',
      side: OrderSide.BUY,
      timestamp: TS,
      transactionHash: TX,
      marketId: '1',
      conditionId: conditionIdOf(1),
      title: 'BTC 5min Pulse',
      slug: 'btc-5min-pulse-5018',
      eventSlug: null,
      icon: 'https://img.example/market.png',
      outcome: 'Yes',
      outcomeIndex: 0,
      shares: '10',
      amount: '5.70',
      price: '0.57',
      netFee: '-0.0996',
      realizedPnl: '0.00',
    });
  });

  test('a sell is a trade with the SELL side, and keeps its realised PnL', () => {
    const activity = toActivity(row(1));

    expect(activity.type).toBe('TRADE');
    expect(activity.side).toBe(OrderSide.SELL);
    expect(activity.realizedPnl).toBe('-12.50');
  });

  test('a redeem and the other kinds of history rows have a type and no side', () => {
    expect(toActivity(row(2))).toMatchObject({ type: 'REDEEM', side: null });
    for (const positionType of [
      'SPLIT',
      'MERGE',
      'TRANSFER_IN',
      'TRANSFER_OUT',
      'REFUND',
    ]) {
      expect(toActivity(row(0, { positionType }))).toMatchObject({
        type: positionType,
        side: null,
      });
    }
  });

  test('a creator unlock is its own type, not a buy', () => {
    expect(
      toActivity(row(0, { activityType: 'CREATOR_UNLOCK' })),
    ).toMatchObject({ type: 'CREATOR_UNLOCK', side: null });
  });

  test('a kind added later passes through as its own string', () => {
    expect(toActivity(row(0, { positionType: 'REBALANCE_IN' }))).toMatchObject({
      type: 'REBALANCE_IN',
      side: null,
    });
  });

  test('has the fields of the model and nothing else, and no snake_case or *ID key', () => {
    const activity = toActivity(row(0));

    expect(Object.keys(activity).sort()).toEqual(
      [
        'id',
        'type',
        'side',
        'timestamp',
        'transactionHash',
        'marketId',
        'conditionId',
        'title',
        'slug',
        'eventSlug',
        'icon',
        'outcome',
        'outcomeIndex',
        'shares',
        'amount',
        'price',
        'netFee',
        'realizedPnl',
      ].sort(),
    );
    expect(wireStyleKeys(activity)).toEqual([]);
  });

  test('a row without a market, an outcome, a price or a transaction has null for each', () => {
    const activity = toActivity(
      row(0, {
        market: null,
        outcome: null,
        priceAtExecution: null,
        transactionHash: null,
        netFeeUSD: null,
      }),
    );

    expect(activity).toMatchObject({
      marketId: null,
      conditionId: null,
      title: null,
      slug: null,
      eventSlug: null,
      icon: null,
      outcome: null,
      outcomeIndex: null,
      price: null,
      transactionHash: null,
      netFee: null,
    });
  });

  test('a market key that is not a condition id (an older market) leaves the condition id null', () => {
    const activity = toActivity(
      row(0, {
        market: {
          ...(fixtures.marketActivityFixture(0).market as object),
          contractMarketId: `0x${'cd'.repeat(20)}`,
        },
      }),
    );

    expect(activity.conditionId).toBeNull();
    expect(activity.marketId).toBe('1');
  });

  test('a transaction hash that is not a hash is null', () => {
    expect(
      toActivity(row(0, { transactionHash: 'pending' })).transactionHash,
    ).toBeNull();
  });

  test('shares and price are converted from micro-units exactly', () => {
    const activity = toActivity(
      row(0, { shareAmount: '12345678', priceAtExecution: '5' }),
    );

    expect(activity.shares).toBe('12.345678');
    expect(activity.price).toBe('0.000005');
  });

  test('does not change its input and returns plain JSON data', () => {
    const input = row(0);
    const before = structuredClone(input);
    const activity = toActivity(input);

    expect(input).toEqual(before);
    expect(JSON.parse(JSON.stringify(activity))).toEqual(activity);
  });

  test('has the public types', () => {
    expectTypeOf<Activity['side']>().toEqualTypeOf<OrderSide | null>();
    expectTypeOf<Activity['transactionHash']>().toEqualTypeOf<Hex | null>();
    expectTypeOf<Activity['shares']>().toEqualTypeOf<DecimalString>();
    expectTypeOf<Activity['price']>().toEqualTypeOf<DecimalString | null>();
    expectTypeOf<Activity['conditionId']>().toEqualTypeOf<ConditionId | null>();
    expectTypeOf<Activity['timestamp']>().toEqualTypeOf<string>();
  });
});

describe('toPortfolioValue', () => {
  const raw = PortfolioValueSchema.lenient.parse({
    cashUSD: 100.5,
    positionsValueUSD: '595.800003',
    claimableAmountUSD: 1.5,
    portfolioValueUSD: 697.800003,
    currency: 'USD',
    unpricedPositionCount: 2,
  });

  test('maps the totals to whole-unit dollars under plain names', () => {
    expect(toPortfolioValue(raw)).toEqual({
      value: '697.800003',
      cash: '100.5',
      positionsValue: '595.800003',
      claimableAmount: '1.5',
      unpricedPositionCount: 2,
    });
  });

  test('has no snake_case, *ID or USD-suffixed key', () => {
    const keys = keysOf(toPortfolioValue(raw));

    expect(wireStyleKeys(toPortfolioValue(raw))).toEqual([]);
    expect(keys.filter((key) => /USD$/.test(key))).toEqual([]);
  });

  test('has the public types', () => {
    expectTypeOf<
      ReturnType<typeof toPortfolioValue>['value']
    >().toEqualTypeOf<DecimalString>();
  });
});

describe('PnL', () => {
  const position = (id: number, patch: Record<string, unknown> = {}) => ({
    positionId: id,
    marketId: 1,
    marketTitle: 'Market 1',
    marketStatus: 'ACTIVE',
    outcomeTitle: 'Yes',
    entryValue: 500,
    currentValue: 623.45,
    pnl: 123.45,
    pnlPercentage: 24.69,
    calculationType: 'ACTIVE',
    shareAmount: '2000000',
    entryPrice: '250000',
    calculatedAt: TS,
    ...patch,
  });

  const summaryRaw = (positions: unknown[]) =>
    PnlSummarySchema.lenient.parse({
      totalPnl: 123.45,
      totalPnlPercentage: 24.69,
      totalEntryValue: 500,
      totalCurrentValue: 623.45,
      activePositionsCount: 1,
      closedPositionsCount: 2,
      calculationErrors: 0,
      positions,
    });

  test('toPositionPnl: one position, whole units, plain names', () => {
    const raw = PnlPositionResultSchema.lenient.parse({
      position: position(46010),
    }).position;

    expect(toPositionPnl(raw)).toEqual({
      positionId: '46010',
      marketId: '1',
      marketTitle: 'Market 1',
      marketStatus: 'ACTIVE',
      outcome: 'Yes',
      status: 'OPEN',
      shares: '2',
      avgPrice: '0.25',
      entryValue: '500',
      currentValue: '623.45',
      pnl: '123.45',
      percentPnl: '24.69',
      redeemableAmount: null,
      calculatedAt: TS,
    });
  });

  test('a closed calculation reads CLOSED and keeps the redeemable amount', () => {
    const raw = PnlPositionResultSchema.lenient.parse({
      position: position(1, { calculationType: 'CLOSED', redeemableAmount: 2 }),
    }).position;

    expect(toPositionPnl(raw)).toMatchObject({
      status: 'CLOSED',
      redeemableAmount: '2',
    });
  });

  test('toUserPnl: the totals of the account and its positions', () => {
    const raw = summaryRaw([position(1), position(2, { pnl: -1.5 })]);
    const pnl = toUserPnl(raw);

    expect(pnl).toMatchObject({
      pnl: '123.45',
      percentPnl: '24.69',
      entryValue: '500',
      currentValue: '623.45',
      openPositions: 1,
      closedPositions: 2,
      failedCalculations: 0,
    });
    expect(pnl.positions.map((p) => p.positionId)).toEqual(['1', '2']);
    expect(pnl.positions[1]?.pnl).toBe('-1.5');
    expect(wireStyleKeys(pnl)).toEqual([]);
  });

  test('toMarketPnl: one market, its total and its positions', () => {
    const raw = PnlMarketSchema.lenient.parse({
      marketId: 1,
      marketTitle: 'Market 1',
      totalPnl: 123.45,
      totalPnlPercentage: 24.69,
      positionsCount: 1,
      positions: [position(46010)],
    });

    expect(toMarketPnl(raw)).toMatchObject({
      marketId: '1',
      title: 'Market 1',
      pnl: '123.45',
      percentPnl: '24.69',
    });
    expect(toMarketPnl(raw).positions).toHaveLength(1);
    expect(wireStyleKeys(toMarketPnl(raw))).toEqual([]);
  });

  test('copies the lists and does not change the input', () => {
    const raw = summaryRaw([position(1)]);
    const before = structuredClone(raw);
    const pnl = toUserPnl(raw);
    pnl.positions.pop();

    expect(raw).toEqual(before);
    expect(raw.positions).toHaveLength(1);
  });

  test('a share count that is not micro-units is an unexpected response', () => {
    const raw = PnlPositionResultSchema.lenient.parse({
      position: position(1),
    }).position;

    expect(() =>
      toPositionPnl({ ...raw, shareAmount: '1.5' } as typeof raw),
    ).toThrow(UnexpectedResponseError);
  });

  test('has the public types', () => {
    expectTypeOf<UserPnl['positions']>().toEqualTypeOf<PositionPnl[]>();
    expectTypeOf<MarketPnl['positions']>().toEqualTypeOf<PositionPnl[]>();
    expectTypeOf<PositionPnl['marketStatus']>().toEqualTypeOf<MarketStatus>();
    expectTypeOf<UserPnl['pnl']>().toEqualTypeOf<DecimalString>();
    expectTypeOf<UserPnl['openPositions']>().toEqualTypeOf<number>();
  });
});

describe('toUserStats', () => {
  test('maps the statistics, with null for what the indexer does not have', () => {
    const raw = UserStatsSchema.lenient.parse({
      pnl: 12.5,
      volume: '1000',
      marketsTraded: 52,
      winRate: null,
    });

    expect(toUserStats(raw)).toEqual({
      pnl: '12.5',
      volume: '1000',
      tradedMarketCount: 52,
    });
    expect(
      toUserStats(
        UserStatsSchema.lenient.parse({
          pnl: null,
          volume: null,
          marketsTraded: null,
          winRate: null,
        }),
      ),
    ).toEqual({ pnl: null, volume: null, tradedMarketCount: null });
  });

  test('has the public types', () => {
    expectTypeOf<UserStats['pnl']>().toEqualTypeOf<DecimalString | null>();
    expectTypeOf<UserStats['tradedMarketCount']>().toEqualTypeOf<
      number | null
    >();
  });
});

describe('toProfile', () => {
  const raw = () => AccountProfileSchema.lenient.parse(currentUserFixture());

  test('maps the account: identity, wallet, socials, points and volume', () => {
    expect(toProfile(raw())).toEqual({
      id: String(OWNER.id),
      username: OWNER.username,
      name: null,
      wallet: getAddress(OWNER.wallet),
      bio: null,
      profileImage: null,
      verifiedBadge: false,
      isOg: false,
      isAmbassador: false,
      isPrivate: false,
      status: 'ACTIVE',
      socials: { x: null, tiktok: null, instagram: null, discord: null },
      referralCode: null,
      convictionPoints: '5000',
      tier: 'Believer',
      points: { current: '15.75', totalEarned: '47.25' },
      volume: '1234.56',
      createdAt: TS,
      updatedAt: TS,
      lastActiveAt: null,
      lastLoginAt: null,
    });
  });

  test('keeps the fields a profile has and drops the empty history and position lists', () => {
    const keys = keysOf(toProfile(raw()));

    for (const name of [
      'positionHistory',
      'currentPositions',
      'stats',
      'hasAccess',
      'likedMarketIds',
    ]) {
      expect(keys, name).not.toContain(name);
    }
    expect(wireStyleKeys(toProfile(raw()))).toEqual([]);
  });

  test('a profile with a bio, a picture, a referral code and activity times has them', () => {
    const profile = toProfile(
      AccountProfileSchema.lenient.parse({
        ...currentUserFixture(),
        bio: 'Hello',
        profilePictureUrl: 'https://img.example/me.png',
        referralCode: 'ABC',
        verified: true,
        lastActiveAt: TS,
        lastLoginAt: TS,
        socials: { x: 'bot_one', tiktok: null, instagram: null, discord: null },
      }),
    );

    expect(profile).toMatchObject({
      bio: 'Hello',
      profileImage: 'https://img.example/me.png',
      referralCode: 'ABC',
      verifiedBadge: true,
      lastActiveAt: TS,
      lastLoginAt: TS,
      socials: { x: 'bot_one' },
    });
  });

  test('has the public types', () => {
    expectTypeOf<Profile['id']>().toEqualTypeOf<string>();
    expectTypeOf<Profile['wallet']>().toEqualTypeOf<Address>();
    expectTypeOf<Profile['volume']>().toEqualTypeOf<DecimalString>();
    expectTypeOf<Profile['bio']>().toEqualTypeOf<string | null>();
  });
});

describe('toPublicProfile', () => {
  const raw = (patch: Record<string, unknown> = {}) =>
    PublicProfileSchema.lenient.parse({
      ...fixtures.profileFixture(),
      ...patch,
    });

  test('maps a public profile: names, picture, badges and points', () => {
    expect(toPublicProfile(raw())).toEqual({
      id: String(PUBLIC_USER.id),
      username: PUBLIC_USER.username,
      name: null,
      bio: 'Testing testing',
      profileImage: 'https://img.example/avatar.png',
      verifiedBadge: false,
      isOg: false,
      isPrivate: false,
      socials: {
        x: 'xouser1330',
        tiktok: null,
        instagram: null,
        discord: null,
      },
      badges: [
        { key: 'CATALYST', earned: true, revoked: false },
        { key: 'HATCHLING', earned: false, revoked: false },
      ],
      achievements: ['CATALYST'],
      convictionPoints: '520321.56',
      tier: 'Caller',
    });
  });

  test('a private profile has null for the bio, the socials, the badges and the achievements', () => {
    const profile = toPublicProfile(
      raw({
        isPrivate: true,
        bio: null,
        socials: null,
        profileBadges: null,
        achievements: null,
        profilePictureUrl: null,
        cpPoints: undefined,
        tier: undefined,
      }),
    );

    expect(profile).toMatchObject({
      isPrivate: true,
      bio: null,
      socials: null,
      badges: null,
      achievements: null,
      profileImage: null,
      convictionPoints: null,
      tier: null,
    });
  });

  test('has no snake_case or *ID key and drops the legacy badge lists', () => {
    const profile = toPublicProfile(raw());

    expect(wireStyleKeys(profile)).toEqual([]);
    for (const name of [
      'boardingPassTiers',
      'profileBadges',
      'tokenId',
      'notes',
    ]) {
      expect(keysOf(profile), name).not.toContain(name);
    }
  });

  test('copies its lists', () => {
    const input = raw();
    const profile = toPublicProfile(input);
    profile.badges?.pop();
    profile.achievements?.pop();

    expect(input.profileBadges).toHaveLength(2);
    expect(input.achievements).toHaveLength(1);
  });

  test('has the public types', () => {
    expectTypeOf<PublicProfile['socials']>().toEqualTypeOf<
      Profile['socials'] | null
    >();
    expectTypeOf<
      PublicProfile['convictionPoints']
    >().toEqualTypeOf<DecimalString | null>();
    expectTypeOf<Profile['convictionPoints']>().toEqualTypeOf<DecimalString>();
  });

  test('conviction points are an exact decimal, whatever form XO writes them in', () => {
    expect(toPublicProfile(raw({ cpPoints: 1e21 })).convictionPoints).toBe(
      '1000000000000000000000',
    );
    expect(toPublicProfile(raw({ cpPoints: 1e-7 })).convictionPoints).toBe(
      '0.0000001',
    );
    expect(toPublicProfile(raw({ cpPoints: 0 })).convictionPoints).toBe('0');
  });
});

describe('toBalances', () => {
  test('maps the cash and the positions to whole units, with the reserved shares', () => {
    const raw = PositionsSchema.lenient.parse({
      cash_balance: '12500000',
      positions: [
        { token_id: TOKEN_YES, balance: '3500000', reserved: '1000000' },
        { token_id: TOKEN_NO, balance: '1', reserved: '0' },
      ],
    });

    expect(toBalances(raw)).toEqual({
      collateral: '12.5',
      positions: [
        { assetId: TOKEN_YES, balance: '3.5', reserved: '1' },
        { assetId: TOKEN_NO, balance: '0.000001', reserved: '0' },
      ],
    });
  });

  test('an account without positions has an empty list and keeps its keys camelCase', () => {
    const balances = toBalances(
      PositionsSchema.lenient.parse({ cash_balance: '0', positions: [] }),
    );

    expect(balances).toEqual({ collateral: '0', positions: [] });
    expect(
      wireStyleKeys(
        toBalances(
          PositionsSchema.lenient.parse({
            cash_balance: '1',
            positions: [{ token_id: TOKEN_YES, balance: '1', reserved: '0' }],
          }),
        ),
      ),
    ).toEqual([]);
  });

  test('copies the list and does not change the input', () => {
    const raw = PositionsSchema.lenient.parse({
      cash_balance: '1000000',
      positions: [{ token_id: TOKEN_YES, balance: '1', reserved: '0' }],
    });
    const before = structuredClone(raw);
    const balances = toBalances(raw);
    balances.positions.pop();

    expect(raw).toEqual(before);
  });

  test('an amount that is not micro-units is an unexpected response that names the field', () => {
    const raw = PositionsSchema.lenient.parse({
      cash_balance: '1',
      positions: [],
    });

    expect(() =>
      toBalances({ ...raw, cash_balance: '1.5' } as typeof raw),
    ).toThrow(UnexpectedResponseError);
    expect(() =>
      toBalances({
        cash_balance: '1',
        positions: [{ token_id: TOKEN_YES, balance: 'x', reserved: '0' }],
      } as typeof raw),
    ).toThrow(/positions\[0\]\.balance/);
  });

  test('has the public types', () => {
    expectTypeOf<Balances['collateral']>().toEqualTypeOf<DecimalString>();
    expectTypeOf<Balances['positions']>().toEqualTypeOf<PositionBalance[]>();
    expectTypeOf<PositionBalance['assetId']>().toEqualTypeOf<TokenId>();
    expectTypeOf<PositionBalance['reserved']>().toEqualTypeOf<DecimalString>();
  });
});

describe('toTradingApprovalsState', () => {
  test('nothing to do means the account is deployed and approved, and ready', () => {
    expect(toTradingApprovalsState([], false)).toEqual({
      deployed: true,
      usdcApproved: true,
      conditionalTokensApproved: true,
      marketManagerApproved: null,
      ready: true,
    });
  });

  test('each action that setup would send is one thing that is missing', () => {
    const cases: Array<[SetupAction[], Partial<TradingApprovalsState>]> = [
      [['approve_usdc'], { usdcApproved: false, ready: false }],
      [['approve_ctf'], { conditionalTokensApproved: false, ready: false }],
      [
        ['deploy', 'approve_usdc', 'approve_ctf'],
        {
          deployed: false,
          usdcApproved: false,
          conditionalTokensApproved: false,
          ready: false,
        },
      ],
    ];
    for (const [missing, expected] of cases) {
      expect(toTradingApprovalsState(missing, false), missing.join()).toEqual({
        deployed: true,
        usdcApproved: true,
        conditionalTokensApproved: true,
        marketManagerApproved: null,
        ready: true,
        ...expected,
      });
    }
  });

  test('the market manager is read only when it was asked for, and does not decide readiness', () => {
    expect(toTradingApprovalsState(['approve_manager'], true)).toMatchObject({
      marketManagerApproved: false,
      ready: true,
    });
    expect(toTradingApprovalsState([], true)).toMatchObject({
      marketManagerApproved: true,
      ready: true,
    });
    expect(toTradingApprovalsState(['approve_manager'], false)).toMatchObject({
      marketManagerApproved: null,
    });
  });

  test('has no snake_case key and does not change its input', () => {
    const missing: SetupAction[] = ['approve_usdc'];
    const state = toTradingApprovalsState(missing, false);

    expect(wireStyleKeys(state)).toEqual([]);
    expect(missing).toEqual(['approve_usdc']);
    expectTypeOf<
      TradingApprovalsState['marketManagerApproved']
    >().toEqualTypeOf<boolean | null>();
  });
});

describe('transactions', () => {
  const hash = `0x${'12'.repeat(32)}` as Hex;
  const summaryOf = (): TransactionReceiptSummary => ({
    transactionHash: hash,
    status: 'success',
    blockNumber: 123n,
  });

  test('toTransactionReceiptSummary renames the hash and keeps the status and the block', () => {
    const tx: TxResult = { txHash: hash, status: 'reverted', blockNumber: 9n };

    expect(toTransactionReceiptSummary(tx)).toEqual({
      transactionHash: hash,
      status: 'reverted',
      blockNumber: 9n,
    });
  });

  test('toTransactionHandle has the hash and a wait that resolves to the receipt summary', async () => {
    const wait = vi.fn(async () => summaryOf());
    const handle = toTransactionHandle(hash, wait);

    expect(handle.transactionHash).toBe(hash);
    await expect(handle.wait()).resolves.toEqual(summaryOf());
    expect(wait).toHaveBeenCalledTimes(1);
  });

  test('the handle is frozen and has exactly a hash and a wait', () => {
    const handle = toTransactionHandle(hash, async () => summaryOf());

    expect(Object.isFrozen(handle)).toBe(true);
    expect(Object.keys(handle).sort()).toEqual(['transactionHash', 'wait']);
    expect(() => {
      (handle as { transactionHash: Hex }).transactionHash =
        `0x${'00'.repeat(32)}`;
    }).toThrow(TypeError);
  });

  test('a failing wait rejects with its own error', async () => {
    const failure = new Error('no receipt');
    const handle = toTransactionHandle(hash, async () => {
      throw failure;
    });

    await expect(handle.wait()).rejects.toBe(failure);
  });

  test('has the public types', () => {
    expectTypeOf<TransactionHandle['transactionHash']>().toEqualTypeOf<Hex>();
    expectTypeOf<TransactionHandle['wait']>().toEqualTypeOf<
      () => Promise<TransactionReceiptSummary>
    >();
    expectTypeOf<TransactionReceiptSummary['status']>().toEqualTypeOf<
      'success' | 'reverted'
    >();
    expectTypeOf<
      TransactionReceiptSummary['blockNumber']
    >().toEqualTypeOf<bigint>();
  });
});
