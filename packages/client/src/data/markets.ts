import type { Paginator } from '../core/paginate';
import type { CallOptions } from '../core/requestOptions';
import {
  MarketActivitiesPageSchema,
  type MarketActivity,
} from './activitySchemas';
import { type BrowseItem, BrowsePageSchema } from './catalogSchemas';
import type { DataDeps } from './internal';
import { paged, singlePage } from './pages';
import {
  type AllActivityParams,
  allActivityQuery,
  type BrowseMarketsParams,
  browseMarketsQuery,
  feeConfigQuery,
  type ListMarketsParams,
  listMarketsQuery,
  type MarketActivityParams,
  marketActivityQuery,
  marketIdSegment,
  marketKeySegment,
  type PulseStatsParams,
  pulseStatsQuery,
  slugSegment,
} from './params';
import {
  type ClobTradingStatus,
  ClobTradingStatusSchema,
  type EffectiveFeeConfig,
  EffectiveFeeConfigSchema,
  type Market,
  MarketSchema,
  type MarketStatuses,
  MarketStatusesSchema,
  MarketsPageSchema,
  PriceHistorySchema,
  type PricePoint,
  type PulseStats,
  PulseStatsSchema,
} from './schemas';

/**
 * Markets: the catalogue, one market, its price history, statuses and trades, and the
 * market-wide reads (fees, trading status, pulse statistics).
 *
 * The list methods return a lazy `Paginator`: nothing is requested until it is read, and
 * the first `page` of the params is where it starts. A bad param throws a `UserInputError`
 * at once, before any request. `marketScope` defaults to `'onlyClob'` wherever the route
 * takes one: the data client lists markets that trade on the orderbook (the backend's own
 * default includes legacy LMSR markets, which do not).
 */
export class MarketsApi {
  /** @internal Made by `DataClient`, which owns the transport and the session. */
  constructor(private readonly deps: DataDeps) {}

  /**
   * Markets (`GET /markets`).
   *
   * The default `onlyClob` scope covers CLOB markets (type 2) and CLOB pulse rounds (type 3).
   * The pulse rounds are short-lived and can far outnumber the plain CLOB markets, so pass
   * `marketType: 2` to list those, or `marketScope: 'onlyConviction'` for convictions.
   *
   * @throws {UserInputError} At once, for an unknown param or a value outside the
   *   backend's ranges (`take` is 1 to 50, `page` 1 to 10000).
   */
  list(params?: ListMarketsParams, call?: CallOptions): Paginator<Market> {
    return paged(
      this.deps,
      'markets.list',
      MarketsPageSchema,
      listMarketsQuery(params),
      { call },
    );
  }

  /**
   * The browse catalogue (`GET /markets/browse`): standalone markets and event cards, as the
   * website's market page shows them. `sortBy: 'smart'` is its "trending" order.
   *
   * @throws {UserInputError} At once, like {@link list}.
   */
  browse(
    params?: BrowseMarketsParams,
    call?: CallOptions,
  ): Paginator<BrowseItem> {
    return paged(
      this.deps,
      'markets.browse',
      BrowsePageSchema,
      browseMarketsQuery(params),
      { call },
    );
  }

  /**
   * One market by its database id (`GET /markets/:id`).
   *
   * @throws {RequestRejectedError} Status 404, when there is no such market.
   */
  async get(id: number | string, call?: CallOptions): Promise<Market> {
    return this.deps.get('markets.get', MarketSchema, {
      params: { id: marketIdSegment(id) },
      call,
    });
  }

  /**
   * One market by its slug (`GET /markets/slug/:slug`).
   *
   * @throws {RequestRejectedError} Status 404, when there is no such market.
   */
  async bySlug(slug: string, call?: CallOptions): Promise<Market> {
    return this.deps.get('markets.bySlug', MarketSchema, {
      params: { slug: slugSegment(slug) },
      call,
    });
  }

  /**
   * One market by its contract address or its condition id
   * (`GET /markets/contract/:contractAddress`).
   *
   * @throws {RequestRejectedError} Status 404, when there is no such market.
   */
  async byContract(
    addressOrConditionId: string,
    call?: CallOptions,
  ): Promise<Market> {
    return this.deps.get('markets.byContract', MarketSchema, {
      params: {
        contractAddress: marketKeySegment(
          addressOrConditionId,
          'addressOrConditionId',
        ),
      },
      call,
    });
  }

  /**
   * About 300 points that span the market's history from its first to its last trade, each
   * with the price of every outcome (`GET /markets/:id/price-history`). One page.
   *
   * The backend builds it from the legacy AMM price table, so a CLOB market (type 2, 3 or 4)
   * has no points: the list is empty for it. For the price history of a CLOB token use
   * `OrderbookClient.getPricesHistory`.
   */
  priceHistory(id: number | string, call?: CallOptions): Paginator<PricePoint> {
    const params = { id: marketIdSegment(id) };
    return singlePage(
      () =>
        this.deps.get('markets.priceHistory', PriceHistorySchema, {
          params,
          call,
        }),
      (raw) => raw,
    );
  }

  /** When the market reached each lifecycle status (`GET /markets/:id/statuses`). */
  async statuses(
    id: number | string,
    call?: CallOptions,
  ): Promise<MarketStatuses> {
    return this.deps.get('markets.statuses', MarketStatusesSchema, {
      params: { id: marketIdSegment(id) },
      call,
    });
  }

  /**
   * The fills of one market (`GET /markets/:id/activity`), newest first by default. The
   * route is public: it cannot filter to "my trades" (`userTradesOnly` needs a Privy user),
   * so use `userId` to follow a trader.
   *
   * @throws {UserInputError} At once, like {@link list}. `take` is 1 to 50.
   */
  activity(
    id: number | string,
    params?: MarketActivityParams,
    call?: CallOptions,
  ): Paginator<MarketActivity> {
    return paged(
      this.deps,
      'markets.activity',
      MarketActivitiesPageSchema,
      marketActivityQuery(params),
      { params: { id: marketIdSegment(id) }, call },
    );
  }

  /**
   * The fills across markets (`GET /markets/activities`), scoped by `marketScope`
   * (default `'onlyClob'`) or `marketType`.
   *
   * @throws {UserInputError} At once, like {@link list}. `take` is 1 to 50.
   */
  allActivity(
    params?: AllActivityParams,
    call?: CallOptions,
  ): Paginator<MarketActivity> {
    return paged(
      this.deps,
      'markets.allActivity',
      MarketActivitiesPageSchema,
      allActivityQuery(params),
      { call },
    );
  }

  /**
   * The fee policy that applies to a market (`GET /markets/fee-config/effective`).
   *
   * @param contractMarketId The market's id on chain: a CLOB market's condition id (`0x` and
   *   64 hex digits, `ResolvedMarket.conditionId`), or a legacy market's contract market id.
   *   Not the backend's numeric market id (`ResolvedMarket.marketId`), which the other
   *   methods take. Sent as the route's `marketId` query parameter.
   * @throws {UserInputError} For an empty id.
   * @throws {RequestRejectedError} Status 400 when the backend does not know the market (it
   *   answers 400, not 404).
   */
  async feeConfig(
    contractMarketId: string,
    call?: CallOptions,
  ): Promise<EffectiveFeeConfig> {
    const { data } = await this.deps.get(
      'markets.feeConfig',
      EffectiveFeeConfigSchema,
      { query: feeConfigQuery(contractMarketId), call },
    );
    return data;
  }

  /**
   * The global CLOB trading status the indexer last saw (`GET /markets/clob/trading-status`).
   * This is a `shared` route: it needs the client's backend credentials, the only route of
   * this client that does. For the orderbook gateway's own state use
   * `OrderbookClient.getTradingState()`.
   *
   * @throws {AuthRequiredError} When the client has no credentials, before any request.
   */
  async tradingStatus(call?: CallOptions): Promise<ClobTradingStatus> {
    const { data } = await this.deps.get(
      'markets.tradingStatus',
      ClobTradingStatusSchema,
      { call },
    );
    return data;
  }

  /**
   * Aggregate statistics of the pulse markets (`GET /markets/pulse/stats`).
   *
   * `marketScope` defaults to `'onlyClobPulse'`: the CLOB pulse markets, which trade on the
   * orderbook. The backend maps any other value to `'onlyPulse'`, the legacy AMM pulse
   * markets, so pass `marketScope: 'onlyPulse'` for those.
   *
   * @throws {UserInputError} For an unknown param, or a scope other than the two pulse
   *   ones (the general `'onlyClob'` is not one of them).
   */
  async pulseStats(
    params?: PulseStatsParams,
    call?: CallOptions,
  ): Promise<PulseStats> {
    return this.deps.get('markets.pulseStats', PulseStatsSchema, {
      query: pulseStatsQuery(params),
      call,
    });
  }
}
