import type { Paginator } from '../core/paginate';
import type { CallOptions } from '../core/requestOptions';
import type { DataDeps } from './internal';
import { offsetPages, paged, singlePage } from './pages';
import type { Query } from './params';
import {
  conditionIdSegment,
  epochOf,
  epochSegment,
  type GroupDayParams,
  type GroupHistoryParams,
  type GroupsParams,
  groupDayQuery,
  groupHistoryQuery,
  groupIdSegment,
  groupsQuery,
  type LeaderboardParams,
  leaderboardQuery,
  type MakerOrdersParams,
  type MakersParams,
  type MarketDayParams,
  type MarketOrdersParams,
  makerOrdersQuery,
  makersQuery,
  marketDayQuery,
  marketOrdersQuery,
  type RankParams,
  rankQuery,
  walletSegment,
} from './rewardsParams';
import {
  type EarningPool,
  EarningPoolsPageSchema,
  type RewardsGroup,
  type RewardsGroupDay,
  RewardsGroupDaySchema,
  type RewardsGroupDetail,
  RewardsGroupDetailSchema,
  type RewardsGroupHistoryLine,
  RewardsGroupHistorySchema,
  RewardsGroupsPageSchema,
  RewardsLeaderboardPageSchema,
  type RewardsLeaderboardRow,
  RewardsLeaderboardRowSchema,
  type RewardsMaker,
  type RewardsMakerOrder,
  RewardsMakerOrdersPageSchema,
  RewardsMakersPageSchema,
  type RewardsMarket,
  type RewardsMarketConfig,
  RewardsMarketConfigSchema,
  type RewardsMarketDay,
  RewardsMarketDaySchema,
  type RewardsMarketEpoch,
  RewardsMarketEpochSchema,
  type RewardsMarketOrder,
  RewardsMarketOrdersPageSchema,
  RewardsMarketSchema,
  type RewardsWalletEpoch,
  RewardsWalletEpochSchema,
  type RewardsWalletSummary,
  RewardsWalletSummarySchema,
} from './rewardsSchemas';

/** The page a 0-based paginator starts at: the caller's `page`, or 0. */
const firstPage = (query: Query): number =>
  typeof query.page === 'number' ? query.page : 0;

/**
 * Liquidity rewards (LR): what market makers earn for resting orders near the midpoint, in
 * conviction points (CP) and in USDC, paid per UTC day (an *epoch*). "Read today's earnings" is
 * `mySummary()` (see below for what "today" means); the programmes on offer are
 * `earningPools()`.
 *
 * **Two kinds of route.**
 * - The public reads (`earningPools`, `groups`, `group`, `marketConfig`, `market`, `marketEpoch*`,
 *   `marketWallet`, `wallet*`) have no guard on the backend: they send no credentials, whatever
 *   the client holds. A wallet's rewards are public for any address (the backend attaches the
 *   owner's XO profile to the answer).
 * - The account's own reads (`my*`, `leaderboard`) are `shared` routes (`account:read`): they are
 *   sent with the session's backend key, log in with its signer when it has none, and fail with
 *   an `AuthRequiredError` before any request when the session has neither a signer nor a key.
 *   `mySummary`, `myEpoch`, `myOrders` and `myMarket` answer what `wallet`, `walletEpoch`,
 *   `walletOrders` and `marketWallet` answer for the account's own wallet, so a wallet that is
 *   not the account's is read with the public ones, with no key.
 *
 * The backend also serves `earning-pools` and `markets/:marketId/config` to a key. They are not
 * offered: the public routes return the same programmes and need no credentials. The public
 * `earningPools()` has no `sort` (the shared route's `apr` and `createdAt` orders are not
 * reachable): it is always sorted by daily pool, highest first, so order by APR on the client
 * (`estimatedApr` is a percent string, `null` for CP).
 *
 * **Reading "today's earnings".** The summary (`mySummary()`, `wallet()`) has two answers:
 * - what has **settled** today is the `today` of each rail (`me.cp.liquidity.today` is the
 *   backend's `today_credited`, `me.usdc.liquidityRewards.today` its `today_paid`). It is not the
 *   open day's accrual, and stays `"0.00"` until the day pays;
 * - what the open day has **accrued** so far is `me.cp.currentEpoch` and `me.usdc.currentEpoch`:
 *   `effective` (what the maker earns) and `estimate` (the projected payout), with `projected`.
 *
 * The backend rounds **every** summary figure, USDC included, to 2 decimals
 * (`Number(x).toFixed(2)`), so a first-hour accrual under half a cent reads `"0.00"`. The exact
 * amounts (USDC has 6 decimals) are on `myMarket()` / `marketWallet()` and in
 * `myOrders().raw.payout_summary` (`Page.raw` cast to `RewardsMakerOrdersPage`). Summaries are
 * cached by the backend, about 60 s fresh and up to 5 min stale.
 *
 * **A zero can hide a failure.** The backend turns an upstream failure into an empty answer in
 * two places (see `walletEpoch`, `myEpoch`, `leaderboard`, `myRank`); the other routes surface
 * it as an error.
 *
 * **The market is its condition id.** Every `conditionId` argument is the CLOB market's condition
 * id (`0x` and 64 hex digits; the `conditionId` of a market, the `marketId` of an earning pool).
 * The backend names the path param `:marketId`, but the numeric database id of a market is not
 * accepted by these routes, and the id is matched in lower case: the SDK lower-cases it. A market
 * that is not enrolled in the programme is a 404 `RequestRejectedError`.
 *
 * **Epochs.** An epoch is the UTC-day index, `floor(ms / 86_400_000)`: the day number since
 * 1970-01-01. {@link currentEpoch} gives today's. An epoch argument is a whole number from 0 to
 * 10,000,000 (the backend's range). Today's epoch is a live projection (`projected: true`);
 * earlier ones are scored.
 *
 * **Lists** are `Paginator`s whose pages are 0-based (`page`, `page_size`), except the
 * leaderboard (`page`, `take`, 1-based). Params keep the backend's names (`page_size`,
 * `market_id`, `include_zero`), as the answers do. The decoded answer of every page, with the
 * totals the items do not carry, stays on `Page.raw`.
 *
 * **Fields keep the backend's case** (camelCase in the earning pools, the wallet summary and the
 * leaderboard; snake_case in what the rewards service sends through), and money is exact text: see
 * `rewardsSchemas.ts`.
 */
export class RewardsApi {
  /** @internal Made by `DataClient`, which owns the transport and the session. */
  constructor(private readonly deps: DataDeps) {}

  /**
   * The epoch (UTC-day index) of an instant: `Math.floor(ms / 86_400_000)`, which is how the
   * backend and the rewards service number the days. Without `now`, today's. It reads the local
   * clock; a clock that is off by a few seconds gives the wrong epoch right around midnight UTC, so
   * near a day boundary prefer `earningPools()`'s `meta.currentEpoch` (on `Page.raw`) or pass a
   * date from a synced clock.
   *
   * @throws {UserInputError} For something that is not a valid `Date`, or an instant before
   *   1970-01-01 or after epoch 10,000,000.
   */
  currentEpoch(now: Date = new Date()): number {
    return epochOf(now);
  }

  // -------------------------------------------------------------------------
  // Public reads
  // -------------------------------------------------------------------------

  /**
   * The markets that pay liquidity rewards, with their CP and USDC programmes
   * (`GET /public/liquidity-rewards/earning-pools`): terms, daily pools, budgets, schedules, the
   * live book and the bonus windows. One page, sorted by daily pool (highest first). A Pulse
   * group row carries its `group`.
   *
   * **There is no `sort`.** The shared route takes `sort=pool|market_id|apr|createdAt`, but the
   * public one is always sorted by daily pool, so ordering by APR is the caller's:
   * `estimatedApr` is a percent string (`"3664600.00"`, a rate and not an amount) on the USDC
   * rail and always `null` on the CP rail.
   *
   * `Page.raw` is the answer as an `EarningPoolsPage`: its `meta.currentEpoch` is the epoch the
   * page is drawn for (with `dayOpenMs`, `dayCloseMs` and `endsInMs`).
   */
  earningPools(call?: CallOptions): Paginator<EarningPool> {
    return singlePage(
      () =>
        this.deps.get('rewards.earningPools', EarningPoolsPageSchema, { call }),
      (raw) => raw.data,
    );
  }

  /**
   * The Pulse products, one pot per product ("BTC 5m") rather than per five-minute window
   * (`GET /public/liquidity-rewards/groups`). `Page.raw` holds the epoch and the totals.
   *
   * @throws {UserInputError} At once, for an unknown param or a value outside the DTO's ranges.
   */
  groups(params?: GroupsParams, call?: CallOptions): Paginator<RewardsGroup> {
    const query = groupsQuery(params);
    return offsetPages(
      firstPage(query),
      (page) =>
        this.deps.get('rewards.groups', RewardsGroupsPageSchema, {
          query: { ...query, page },
          call,
        }),
      (raw) => raw.groups,
    );
  }

  /**
   * One Pulse group (`GET /public/liquidity-rewards/groups/:groupId`): its live rails and what
   * they paid over their life.
   *
   * @param groupId The bytes32 group id (`group_id` of {@link groups}).
   * @throws {UserInputError} For a malformed id, before any request.
   * @throws {RequestRejectedError} Status 404, when there is no such group.
   */
  async group(
    groupId: string,
    call?: CallOptions,
  ): Promise<RewardsGroupDetail> {
    return this.deps.get('rewards.group', RewardsGroupDetailSchema, {
      params: { groupId: groupIdSegment(groupId) },
      call,
    });
  }

  /**
   * A market's reward configuration (`GET /public/liquidity-rewards/markets/:marketId/config`):
   * one programme per rail, the Pulse group that pays it if any, and its bonus windows.
   *
   * @param conditionId The market's condition id.
   * @throws {UserInputError} For something that is not a condition id, before any request.
   * @throws {RequestRejectedError} Status 404, when the market has no reward programme.
   */
  async marketConfig(
    conditionId: string,
    call?: CallOptions,
  ): Promise<RewardsMarketConfig> {
    return this.deps.get('rewards.marketConfig', RewardsMarketConfigSchema, {
      params: { marketId: conditionIdSegment(conditionId) },
      call,
    });
  }

  /**
   * A market's rewards (`GET /public/liquidity-rewards/markets/:marketId`): both rails with their
   * live state and terms, the day in progress, and what the market has paid over its life
   * (`lifetime_by_currency`). The analytics source for a market's paid totals.
   *
   * @param conditionId The market's condition id.
   * @throws {RequestRejectedError} Status 404, when the market has no reward programme.
   */
  async market(
    conditionId: string,
    call?: CallOptions,
  ): Promise<RewardsMarket> {
    return this.deps.get('rewards.market', RewardsMarketSchema, {
      params: { marketId: conditionIdSegment(conditionId) },
      call,
    });
  }

  /**
   * A market's UTC day (`GET .../markets/:marketId/epochs/:epoch`): the pot, the total score and
   * the top makers of both rails. The CP rail keeps the bare names (`pool`, `top_makers`…) and
   * the USDC rail is beside it under the `_usdc` names (`pool_usdc`, `top_makers_usdc`…); a
   * market with no USDC programme that day sends `null`s and zeros there. A response may omit
   * the USDC rail: the `_usdc` fields are then missing, and `omitted_rails` names it.
   *
   * @param epoch A UTC-day index; see {@link currentEpoch}. Today's is a live projection.
   */
  async marketEpoch(
    conditionId: string,
    epoch: number,
    call?: CallOptions,
  ): Promise<RewardsMarketEpoch> {
    return this.deps.get('rewards.marketEpoch', RewardsMarketEpochSchema, {
      params: {
        marketId: conditionIdSegment(conditionId),
        epoch: epochSegment(epoch),
      },
      call,
    });
  }

  /**
   * The makers of a market's UTC day, with their scores and payouts
   * (`GET .../markets/:marketId/epochs/:epoch/makers`). Pages of `page_size` makers (1 to 1,000).
   * `Page.raw` holds the total. A maker's `user_id` is the wallet that the wallet routes take.
   * The list is the CP rail's.
   *
   * @throws {UserInputError} At once, for a bad id, epoch or param.
   * @throws {RequestRejectedError} Status 409, when a market on both rails has no CP-only makers page for the day
   *   (the rewards service answers 409; the backend passes it through). Read {@link marketEpoch}
   *   instead, which carries the top makers of both rails, or {@link marketEpochOrders}, which
   *   names the makers on every rail.
   */
  marketEpochMakers(
    conditionId: string,
    epoch: number,
    params?: MakersParams,
    call?: CallOptions,
  ): Paginator<RewardsMaker> {
    const path = {
      marketId: conditionIdSegment(conditionId),
      epoch: epochSegment(epoch),
    };
    const query = makersQuery(params);
    return offsetPages(
      firstPage(query),
      (page) =>
        this.deps.get('rewards.marketEpochMakers', RewardsMakersPageSchema, {
          params: path,
          query: { ...query, page },
          call,
        }),
      (raw) => raw.makers,
    );
  }

  /**
   * The scored orders of a market's UTC day, each with its maker
   * (`GET .../markets/:marketId/epochs/:epoch/orders`). `maker` keeps one wallet's orders. On a
   * USDC-only day the CP makers list is empty but these rows still name the makers.
   *
   * @throws {UserInputError} At once, for a bad id, epoch or param.
   */
  marketEpochOrders(
    conditionId: string,
    epoch: number,
    params?: MarketOrdersParams,
    call?: CallOptions,
  ): Paginator<RewardsMarketOrder> {
    const path = {
      marketId: conditionIdSegment(conditionId),
      epoch: epochSegment(epoch),
    };
    const query = marketOrdersQuery(params);
    return offsetPages(
      firstPage(query),
      (page) =>
        this.deps.get(
          'rewards.marketEpochOrders',
          RewardsMarketOrdersPageSchema,
          { params: path, query: { ...query, page }, call },
        ),
      (raw) => raw.orders,
    );
  }

  /**
   * A maker on one market-day (`GET .../markets/:marketId/wallets/:walletAddress`): the score,
   * the payout on one rail (`currency`), the bonus windows and a page of qualifying orders.
   * Without `epoch`, the maker's latest scored day. The account's own is {@link myMarket}.
   *
   * @throws {UserInputError} For a bad id, wallet or param, before any request.
   */
  async marketWallet(
    conditionId: string,
    wallet: string,
    params?: MarketDayParams,
    call?: CallOptions,
  ): Promise<RewardsMarketDay> {
    const path = {
      marketId: conditionIdSegment(conditionId),
      walletAddress: walletSegment(wallet),
    };
    return this.deps.get('rewards.marketWallet', RewardsMarketDaySchema, {
      params: path,
      query: marketDayQuery(params, 'rewards.marketWallet'),
      call,
    });
  }

  /**
   * A wallet's reward totals, for any address (`GET .../wallets/:walletAddress/summary`):
   * lifetime and **settled-today** CP and USDC, the open day's accrual and projection, and
   * whether the maker is flagged. An address with no activity gets zeros. The account's own is
   * {@link mySummary}.
   *
   * `.today` is what has settled today (`today_credited` for CP, `today_paid` for USDC), not the
   * open day's accrual: that is `me.cp.currentEpoch` / `me.usdc.currentEpoch`, `effective` and
   * `estimate`. Every figure is rounded to 2 decimals (USDC included), so an accrual under half a
   * cent reads `"0.00"`; the exact amounts are on {@link marketWallet} and in
   * {@link walletOrders}`().raw.payout_summary`. The backend caches the summary, about 60 s fresh
   * and up to 5 min stale.
   *
   * @throws {UserInputError} For a malformed wallet, before any request.
   */
  async wallet(
    wallet: string,
    call?: CallOptions,
  ): Promise<RewardsWalletSummary> {
    return this.deps.get('rewards.wallet', RewardsWalletSummarySchema, {
      params: { walletAddress: walletSegment(wallet) },
      call,
    });
  }

  /**
   * A wallet's UTC day across every market (`GET .../wallets/:walletAddress/epochs/:epoch`),
   * with the XO profile of the wallet's owner. The account's own is {@link myEpoch}.
   *
   * **It is the CP rail only** (`effective_cp`, `allocated_cp`, `credited_cp`): USDC is not in
   * it. **A zero can mean "unavailable".** The backend turns an upstream
   * failure of the rewards service, including the 409 of a dual-rail market, into a 200 with zeros
   * and `markets: []`, so an empty rollup is not proof the wallet earned nothing. For both rails,
   * and for a failure that surfaces as an error, read {@link marketWallet} per market or
   * {@link walletOrders}`().raw.payout_summary` for the whole day.
   */
  async walletEpoch(
    wallet: string,
    epoch: number,
    call?: CallOptions,
  ): Promise<RewardsWalletEpoch> {
    return this.deps.get('rewards.walletEpoch', RewardsWalletEpochSchema, {
      params: {
        walletAddress: walletSegment(wallet),
        epoch: epochSegment(epoch),
      },
      call,
    });
  }

  /**
   * A wallet's scored orders for one UTC day (`GET .../wallets/:walletAddress/orders`): every
   * market, or one with `market_id`; the day in progress unless `epoch` says otherwise. On
   * that day the live overlay adds the resting orders the scorer has not folded yet as
   * `unscored` rows (`live: false` leaves them out). `Page.raw` holds the money behind the
   * list over the whole scope (`payout_summary`), the markets' catalogue slice (`markets`) and
   * the owner's profile (`user`). The account's own is {@link myOrders}.
   *
   * @throws {UserInputError} At once, for a bad wallet or param.
   */
  walletOrders(
    wallet: string,
    params?: MakerOrdersParams,
    call?: CallOptions,
  ): Paginator<RewardsMakerOrder> {
    const path = { walletAddress: walletSegment(wallet) };
    const query = makerOrdersQuery(params, 'rewards.walletOrders');
    return offsetPages(
      firstPage(query),
      (page) =>
        this.deps.get('rewards.walletOrders', RewardsMakerOrdersPageSchema, {
          params: path,
          query: { ...query, page },
          call,
        }),
      (raw) => raw.orders,
    );
  }

  // -------------------------------------------------------------------------
  // The account's own reads (shared: the session key)
  // -------------------------------------------------------------------------

  /**
   * The account's reward totals (`GET /liquidity-rewards/me/summary`, `account:read`): lifetime
   * and **settled-today** CP and USDC, the open day's accrual and projection, and whether the
   * maker is flagged. This is the first-hour "read today's earnings", with two parts:
   *
   * - `.today` (`me.cp.liquidity.today`, `me.usdc.liquidityRewards.today`) is what has
   *   **settled** today: the backend's `today_credited` (CP) and `today_paid` (USDC). It is not
   *   the open day's accrual and stays `"0.00"` until the day pays.
   * - the live accrual of the open day is `me.cp.currentEpoch` and `me.usdc.currentEpoch`:
   *   `effective` (what the maker earns) and `estimate` (the projected payout), `projected: true`.
   *
   * **Every figure is rounded to 2 decimals** (`Number(x).toFixed(2)`), USDC included, so a
   * first-hour accrual under half a cent reads `"0.00"`. The exact amounts (USDC has 6
   * decimals) are on {@link myMarket} (`projected_payout`, `base_amount`) and in
   * {@link myOrders}`().raw.payout_summary` (`Page.raw` cast to `RewardsMakerOrdersPage`).
   *
   * The backend caches the summary, about 60 s fresh and up to 5 min stale (the public
   * {@link wallet} of the same wallet shares the cache), so it can lag your orders.
   *
   * @throws {AuthRequiredError} When the session has neither a signer nor a key, before any request.
   */
  async mySummary(call?: CallOptions): Promise<RewardsWalletSummary> {
    return this.deps.get('rewards.mySummary', RewardsWalletSummarySchema, {
      call,
    });
  }

  /**
   * The account's UTC day across every market (`GET /liquidity-rewards/me/epochs/:epoch`).
   *
   * **CP rail only**, and **a zero can mean "unavailable"**: the backend
   * turns an upstream failure, including the 409 of a dual-rail market, into a 200 with zeros and
   * `markets: []`. For both rails read {@link myMarket} per market or
   * {@link myOrders}`().raw.payout_summary`; see {@link walletEpoch}.
   */
  async myEpoch(
    epoch: number,
    call?: CallOptions,
  ): Promise<RewardsWalletEpoch> {
    return this.deps.get('rewards.myEpoch', RewardsWalletEpochSchema, {
      params: { epoch: epochSegment(epoch) },
      call,
    });
  }

  /**
   * The account's scored orders for one UTC day (`GET /liquidity-rewards/me/orders`); see
   * {@link walletOrders}, which answers the same for any wallet.
   *
   * @throws {UserInputError} At once, for a bad param.
   */
  myOrders(
    params?: MakerOrdersParams,
    call?: CallOptions,
  ): Paginator<RewardsMakerOrder> {
    const query = makerOrdersQuery(params, 'rewards.myOrders');
    return offsetPages(
      firstPage(query),
      (page) =>
        this.deps.get('rewards.myOrders', RewardsMakerOrdersPageSchema, {
          query: { ...query, page },
          call,
        }),
      (raw) => raw.orders,
    );
  }

  /**
   * The account's settled Pulse group-days, newest first (`GET /liquidity-rewards/me/group-history`).
   * The rewards service's answer is passed through untouched (see `RewardsGroupHistory`);
   * `Page.raw` holds the totals per currency (`totals_by_currency`) and the labels of every known
   * group (`products`).
   *
   * @throws {UserInputError} At once, for a bad param (`page_size` is 1 to 100).
   */
  myGroupHistory(
    params?: GroupHistoryParams,
    call?: CallOptions,
  ): Paginator<RewardsGroupHistoryLine> {
    const query = groupHistoryQuery(params);
    return offsetPages(
      firstPage(query),
      (page) =>
        this.deps.get('rewards.myGroupHistory', RewardsGroupHistorySchema, {
          query: { ...query, page },
          call,
        }),
      (raw) => raw.lines,
    );
  }

  /**
   * The account on one market-day (`GET /liquidity-rewards/markets/:marketId/me`); see
   * {@link marketWallet}, which answers the same for any wallet.
   *
   * @throws {RequestRejectedError} Status 404, when the market has no reward programme.
   */
  async myMarket(
    conditionId: string,
    params?: MarketDayParams,
    call?: CallOptions,
  ): Promise<RewardsMarketDay> {
    const path = { marketId: conditionIdSegment(conditionId) };
    return this.deps.get('rewards.myMarket', RewardsMarketDaySchema, {
      params: path,
      query: marketDayQuery(params, 'rewards.myMarket'),
      call,
    });
  }

  /**
   * The account on one Pulse group-day (`GET /liquidity-rewards/groups/:groupId/me`), with the
   * group's `product` label. The rewards service's answer is passed through untouched (see
   * {@link RewardsGroupDay}).
   *
   * @param groupId The bytes32 group id.
   * @throws {RequestRejectedError} Status 404, when there is no such group.
   */
  async myGroup(
    groupId: string,
    params?: GroupDayParams,
    call?: CallOptions,
  ): Promise<RewardsGroupDay> {
    const path = { groupId: groupIdSegment(groupId) };
    return this.deps.get('rewards.myGroup', RewardsGroupDaySchema, {
      params: path,
      query: groupDayQuery(params),
      call,
    });
  }

  /**
   * The maker leaderboard by effective liquidity CP (`GET /liquidity-rewards/leaderboard`),
   * `period` `'weekly'` (default), `'daily'` or `'seasonal'`. 1-based pages of `take` rows.
   * `Page.raw` holds the window (`fromEpoch`, `toEpoch`) and `totalCp`.
   *
   * **An empty page can be a failure.** When the rewards service is unavailable the backend
   * answers 200 with no rows (`totalCp: "0.00"`, the window collapsed to
   * today) instead of an error, so an empty leaderboard is not proof that nobody earned, and the
   * backend caches that empty page for about 5 minutes.
   *
   * @throws {UserInputError} At once, for a bad param.
   */
  leaderboard(
    params?: LeaderboardParams,
    call?: CallOptions,
  ): Paginator<RewardsLeaderboardRow> {
    return paged(
      this.deps,
      'rewards.leaderboard',
      RewardsLeaderboardPageSchema,
      leaderboardQuery(params),
      { call },
    );
  }

  /**
   * The account's row on the leaderboard (`GET /liquidity-rewards/leaderboard/me`).
   *
   * @throws {RequestRejectedError} Status 404, when the account is not ranked in the period. **That can be a
   *   failure in disguise:** when the rewards service is unavailable the backend
   *   looks the account up in an empty leaderboard, so "not ranked" is also
   *   what an upstream outage reads like. Retry before concluding; {@link leaderboard} shows
   *   whether the board itself is empty.
   */
  async myRank(
    params?: RankParams,
    call?: CallOptions,
  ): Promise<RewardsLeaderboardRow> {
    return this.deps.get('rewards.myRank', RewardsLeaderboardRowSchema, {
      query: rankQuery(params),
      call,
    });
  }
}
