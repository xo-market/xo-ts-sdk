import { describe, expect, expectTypeOf, test } from 'vitest';
import {
  type CLAIMABLE_MARKETS_SPEC,
  type ClaimableMarketsParams,
  type OPEN_ORDERS_SPEC,
  type OpenOrdersParams,
  type PNL_SUMMARY_SPEC,
  type PnlSummaryParams,
  PORTFOLIO_SPEC,
  type PortfolioParams,
  type PortfolioValueParams,
  PUBLIC_PORTFOLIO_SPEC,
  type PublicPortfolioParams,
  type REDEEMABLE_SPEC,
  type RedeemableParams,
  type USER_ACTIVITY_SPEC,
  type USER_MARKET_ACTIVITY_SPEC,
  type UserActivityParams,
  type UserMarketActivityParams,
  type VALUE_SPEC,
} from '../../src/data/accountParams';
import {
  type ALL_ACTIVITY_SPEC,
  type AllActivityParams,
  BROWSE_MARKETS_SPEC,
  type BrowseMarketsParams,
  type CategoriesParams,
  type Field,
  field,
  type LIST_EVENTS_SPEC,
  LIST_MARKETS_SPEC,
  type LIST_SERIES_SPEC,
  type ListEventsParams,
  type ListMarketsParams,
  type ListSeriesParams,
  type MARKET_ACTIVITY_SPEC,
  type MarketActivityParams,
  OVERVIEW_SPEC,
  type OverviewParams,
  type PULSE_LIST_SPEC,
  type PULSE_STATS_SPEC,
  type PulseListParams,
  type PulseStatsParams,
  type SCOPED_MARKETS_SPEC,
  type ScopedMarketsParams,
  SUBCATEGORIES_SPEC,
  type SubcategoriesParams,
} from '../../src/data/params';
import type {
  GROUP_DAY_SPEC,
  GROUP_HISTORY_SPEC,
  GROUPS_SPEC,
  GroupDayParams,
  GroupHistoryParams,
  GroupsParams,
  LEADERBOARD_SPEC,
  LeaderboardParams,
  MAKER_ORDERS_SPEC,
  MAKERS_SPEC,
  MARKET_DAY_SPEC,
  MARKET_ORDERS_SPEC,
  MakerOrdersParams,
  MakersParams,
  MarketDayParams,
  MarketOrdersParams,
  RANK_SPEC,
  RankParams,
} from '../../src/data/rewardsParams';

// A params interface and its runtime spec must name the same keys: a key in the interface
// without a check would type-check and then be refused at run time as unknown, and a key in
// the spec without the interface would be accepted but untyped. `satisfies Record<keyof
// XParams, Field>` in params.ts makes the compiler fail on either; these tests pin that the
// mechanism works and that every spec is tied to its interface.

describe('the spec of a params interface has exactly its keys', () => {
  test('a missing key and an extra key both fail to compile', () => {
    interface Example {
      a?: number;
      b?: string;
    }
    // @ts-expect-error `b` has no check
    const missing = { a: field.int(1) } satisfies Record<keyof Example, Field>;
    const extra = {
      a: field.int(1),
      b: field.str(),
      // @ts-expect-error `c` is not a param
      c: field.str(),
    } satisfies Record<keyof Example, Field>;
    const exact = {
      a: field.int(1),
      b: field.str(),
    } satisfies Record<keyof Example, Field>;
    expect(Object.keys(missing)).toEqual(['a']);
    expect(Object.keys(extra)).toEqual(['a', 'b', 'c']);
    expect(Object.keys(exact)).toEqual(['a', 'b']);
  });

  test('every spec is typed with the keys of its interface', () => {
    expectTypeOf<keyof typeof LIST_MARKETS_SPEC>().toEqualTypeOf<
      keyof ListMarketsParams
    >();
    expectTypeOf<keyof typeof BROWSE_MARKETS_SPEC>().toEqualTypeOf<
      keyof BrowseMarketsParams
    >();
    expectTypeOf<keyof typeof MARKET_ACTIVITY_SPEC>().toEqualTypeOf<
      keyof MarketActivityParams
    >();
    expectTypeOf<keyof typeof ALL_ACTIVITY_SPEC>().toEqualTypeOf<
      keyof AllActivityParams
    >();
    expectTypeOf<keyof typeof PULSE_STATS_SPEC>().toEqualTypeOf<
      keyof PulseStatsParams
    >();
    expectTypeOf<keyof typeof LIST_EVENTS_SPEC>().toEqualTypeOf<
      keyof ListEventsParams
    >();
    expectTypeOf<keyof typeof SCOPED_MARKETS_SPEC>().toEqualTypeOf<
      keyof ScopedMarketsParams
    >();
    expectTypeOf<keyof typeof LIST_SERIES_SPEC>().toEqualTypeOf<
      keyof ListSeriesParams
    >();
    expectTypeOf<keyof typeof PULSE_LIST_SPEC>().toEqualTypeOf<
      keyof PulseListParams
    >();
    expectTypeOf<keyof typeof OVERVIEW_SPEC>().toEqualTypeOf<
      keyof OverviewParams
    >();
    expectTypeOf<keyof typeof OVERVIEW_SPEC>().toEqualTypeOf<
      keyof CategoriesParams
    >();
    expectTypeOf<keyof typeof SUBCATEGORIES_SPEC>().toEqualTypeOf<
      keyof SubcategoriesParams
    >();
  });

  test('the account specs are typed with the keys of their interfaces', () => {
    expectTypeOf<keyof typeof PORTFOLIO_SPEC>().toEqualTypeOf<
      keyof PortfolioParams
    >();
    expectTypeOf<keyof typeof PUBLIC_PORTFOLIO_SPEC>().toEqualTypeOf<
      keyof PublicPortfolioParams
    >();
    expectTypeOf<keyof typeof VALUE_SPEC>().toEqualTypeOf<
      keyof PortfolioValueParams
    >();
    expectTypeOf<keyof typeof REDEEMABLE_SPEC>().toEqualTypeOf<
      keyof RedeemableParams
    >();
    expectTypeOf<keyof typeof CLAIMABLE_MARKETS_SPEC>().toEqualTypeOf<
      keyof ClaimableMarketsParams
    >();
    expectTypeOf<keyof typeof OPEN_ORDERS_SPEC>().toEqualTypeOf<
      keyof OpenOrdersParams
    >();
    expectTypeOf<keyof typeof PNL_SUMMARY_SPEC>().toEqualTypeOf<
      keyof PnlSummaryParams
    >();
    expectTypeOf<keyof typeof USER_ACTIVITY_SPEC>().toEqualTypeOf<
      keyof UserActivityParams
    >();
    expectTypeOf<keyof typeof USER_MARKET_ACTIVITY_SPEC>().toEqualTypeOf<
      keyof UserMarketActivityParams
    >();
  });

  test('the public portfolio spec is the portfolio spec without refresh and claimableFirst', () => {
    expect(Object.keys(PORTFOLIO_SPEC).sort()).toEqual(
      [
        ...Object.keys(PUBLIC_PORTFOLIO_SPEC),
        'refresh',
        'claimableFirst',
      ].sort(),
    );
  });

  test('the browse spec adds only sortBy: smart and includeAMM to the list spec', () => {
    const extra = Object.keys(BROWSE_MARKETS_SPEC).filter(
      (key) => !(key in LIST_MARKETS_SPEC),
    );
    expect(extra).toEqual(['includeAMM']);
  });

  test('categories and subcategories share the overview params', () => {
    for (const key of Object.keys(OVERVIEW_SPEC)) {
      expect(key in SUBCATEGORIES_SPEC).toBe(true);
    }
    expect(Object.keys(SUBCATEGORIES_SPEC).sort()).toEqual(
      [
        ...Object.keys(OVERVIEW_SPEC),
        'page',
        'take',
        'search',
        'categoryId',
      ].sort(),
    );
  });
});

describe('the liquidity-rewards params', () => {
  test('the liquidity-rewards specs are typed with the keys of their interfaces', () => {
    expectTypeOf<keyof typeof GROUPS_SPEC>().toEqualTypeOf<
      keyof GroupsParams
    >();
    expectTypeOf<keyof typeof MAKERS_SPEC>().toEqualTypeOf<
      keyof MakersParams
    >();
    expectTypeOf<keyof typeof MARKET_ORDERS_SPEC>().toEqualTypeOf<
      keyof MarketOrdersParams
    >();
    expectTypeOf<keyof typeof MAKER_ORDERS_SPEC>().toEqualTypeOf<
      keyof MakerOrdersParams
    >();
    expectTypeOf<keyof typeof MARKET_DAY_SPEC>().toEqualTypeOf<
      keyof MarketDayParams
    >();
    expectTypeOf<keyof typeof GROUP_DAY_SPEC>().toEqualTypeOf<
      keyof GroupDayParams
    >();
    expectTypeOf<keyof typeof GROUP_HISTORY_SPEC>().toEqualTypeOf<
      keyof GroupHistoryParams
    >();
    expectTypeOf<keyof typeof LEADERBOARD_SPEC>().toEqualTypeOf<
      keyof LeaderboardParams
    >();
    expectTypeOf<keyof typeof RANK_SPEC>().toEqualTypeOf<keyof RankParams>();
  });
});
