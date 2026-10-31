import type { Paginator } from '../core/paginate';
import type { CallOptions } from '../core/requestOptions';
import {
  type UserActivityParams,
  type UserMarketActivityParams,
  userActivityQuery,
  userMarketActivityQuery,
} from './accountParams';
import { type UserStats, UserStatsSchema } from './accountSchemas';
import {
  UserActivitiesPageSchema,
  type UserActivity,
  UserMarketActivitiesPageSchema,
  type UserMarketActivity,
} from './activitySchemas';
import type { DataDeps } from './internal';
import { paged } from './pages';

/**
 * The account's trading history and statistics. All three routes are `shared`
 * (`account:read`): they are sent with the session's backend key, and fail at once with an
 * `AuthRequiredError` when the session has neither a signer nor a key.
 *
 * **The history is never hidden by default.** `mine` and `marketActivities` default
 * `marketScope` to `'withPulse'`, which applies no type filter: trades in every market type
 * are listed, pulse rounds included. A scope you pass wins. The backend alone would answer
 * `'default'`: standard (type 0) and CLOB (2) markets only, with pulse (1), CLOB pulse (3) and
 * conviction (4) trades left out.
 */
export class ActivityApi {
  /** @internal Made by `DataClient`, which owns the transport and the session. */
  constructor(private readonly deps: DataDeps) {}

  /**
   * The account's activity history (`GET /users/me/activities`): its trades and its creator
   * share unlocks, each with a text description, newest first by default.
   * `marketScope` defaults to `'withPulse'`, every market type.
   *
   * @throws {UserInputError} At once, for an unknown param or a value outside the DTO's
   *   ranges (`take` is 1 to 1000).
   */
  mine(
    params?: UserActivityParams,
    call?: CallOptions,
  ): Paginator<UserActivity> {
    return paged(
      this.deps,
      'activity.mine',
      UserActivitiesPageSchema,
      userActivityQuery(params),
      { call },
    );
  }

  /**
   * The account's own fills in the format of the public trade feeds, with each trade's
   * realised PnL (`pnlInUSD`) and the CLOB pulse round (`market.cycleNumber`)
   * (`GET /users/me/market-activities`). It lists buys, sells and redeems; `eventId` scopes
   * it to an event's markets (a root event with its sub-events, or one sub-event with `subEventId`). `marketScope` defaults to `'withPulse'`, every market type.
   *
   * @throws {UserInputError} At once, like {@link mine}; `take` is 1 to 50 here, the most
   *   the route's use case returns.
   */
  marketActivities(
    params?: UserMarketActivityParams,
    call?: CallOptions,
  ): Paginator<UserMarketActivity> {
    return paged(
      this.deps,
      'activity.marketActivities',
      UserMarketActivitiesPageSchema,
      userMarketActivityQuery(params),
      { call },
    );
  }

  /** The account's trading statistics (`GET /users/me/stats`): PnL, volume and markets traded. */
  async stats(call?: CallOptions): Promise<UserStats> {
    return this.deps.get('activity.stats', UserStatsSchema, { call });
  }
}
