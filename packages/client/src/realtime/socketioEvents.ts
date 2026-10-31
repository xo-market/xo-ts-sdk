import { z } from 'zod';
import { UserInputError } from '../core/errors';
import { type DualSchema, defineSchema, type ObjFactory } from '../core/schema';
import {
  MARKET_STATUSES,
  type MarketStatusValue,
  PORTFOLIO_SORT_KEYS,
  PORTFOLIO_SPEC,
  type PortfolioSortKey,
} from '../data/accountParams';
import {
  activitySchema,
  HISTORY_POSITION_TYPES,
  type MarketActivity,
} from '../data/activitySchemas';
import {
  type ActivitySortKey,
  closedQuery,
  field,
  MARKET_ACTIVITY_SPEC,
  MARKET_SCOPES,
  MAX_PAGE,
  type MarketScope,
} from '../data/params';
import {
  type PortfolioMarket,
  type PortfolioPosition,
  portfolioMarketSchema,
  portfolioPositionSchema,
} from '../data/portfolioSchemas';
import { type PageMeta, pageMetaSchema } from '../data/schemas';

// The events of the backend's Socket.IO channels, their schemas, and the subscribe
// filters with the checks of the gateways. The transport is in socketio.ts.
//
// A snapshot's rows are the REST rows: `/portfolio` builds them with the same use case as
// `GET /users/me/portfolio`, and `/market-activity` with the same use case and presenter as
// `GET /markets/:id/activity`, so the item schemas of the data client are reused as they are.

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

/** The backend's UUID check of `eventId`: versions 1 to 5. */
const EVENT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** The `take` cap of a `/portfolio` market subscription. */
export const PORTFOLIO_MAX_TAKE = 100;
/** The `take` cap of a `/portfolio` event subscription. */
export const PORTFOLIO_EVENT_MAX_TAKE = 50;

/**
 * The scope `/portfolio` is subscribed with when the filters set none and name no event:
 * `'withPulse'`, no market-type filter, so nothing the account holds is hidden (as the
 * data client's `portfolio.mine`). The gateway would otherwise use `'default'`, which leaves
 * out the pulse rounds.
 */
export const DEFAULT_PORTFOLIO_SOCKET_SCOPE: MarketScope = 'withPulse';

/**
 * The scope of an event subscription (`eventId`) when the filters set none: `'onlyClob'`
 * (CLOB and CLOB pulse markets), the gateway's own default there. The gateway counts
 * the event's markets **in the scope** against its limit of 64 (`EVENT_TOO_LARGE`), so
 * `'withPulse'` would count every market type and refuse events that `'onlyClob'` streams.
 */
export const DEFAULT_PORTFOLIO_EVENT_SCOPE: MarketScope = 'onlyClob';

/**
 * The filters of a `/portfolio` subscription: the fields of the backend's subscribe filters
 * that a stream can use. They are checked against the
 * gateway's rules before anything connects.
 */
export interface PortfolioFilters {
  /** 1 to 10000. Defaults (server-side) to 1. */
  page?: number;
  /** 1 to 100, or 1 to 50 with `eventId`. Defaults (server-side) to 10. */
  take?: number;
  /** A word in the market's title. */
  search?: string;
  sortBy?: PortfolioSortKey;
  sortOrder?: 'ASC' | 'DESC';
  /** Position status, as in `portfolio.mine`. */
  status?: 'active' | 'closed' | 'all' | 'resolved';
  /**
   * Defaults to `'withPulse'`: every position, whatever its market type. Without it
   * the gateway would answer `'default'`, which leaves out the pulse rounds.
   *
   * **With `eventId` it defaults to `'onlyClob'`**, the gateway's own default for an
   * event: the gateway counts the event's markets in the scope against its limit of 64
   * (`EVENT_TOO_LARGE`), so a wider scope can refuse an event that `'onlyClob'` streams.
   */
  marketScope?: MarketScope;
  /** One market status. */
  marketStatus?: MarketStatusValue;
  /**
   * One market by its database id. **This switches the snapshots to the detail rows**
   * (`PortfolioPosition`), and the stream also follows that market's trades. Not with
   * `eventId`.
   */
  marketId?: number;
  /** One legacy market by its contract id (as in `portfolio.mine`). Not with `eventId`. */
  contractMarketId?: string;
  /**
   * An event (a fixture root or a sub-event) by its UUID: the snapshots hold the positions
   * in that event's markets, refreshed when any of them trades. At most 64 markets in the
   * scope (`EVENT_TOO_LARGE`; the scope defaults to `'onlyClob'` here), and `take` at most
   * 50. Not with `marketId` or `contractMarketId`.
   */
  eventId?: string;
  /** With `eventId`: include the sub-events' markets. The gateway's default is true. */
  includeSubEvents?: boolean;
}

/** The filters with `marketId` set: the detail mode. */
export type PortfolioDetailFilters = PortfolioFilters & { marketId: number };
/** The filters without `marketId`: the summary mode. */
export type PortfolioSummaryFilters = Omit<PortfolioFilters, 'marketId'> & {
  marketId?: undefined;
};

/**
 * The filters as the gateway echoes them on a snapshot, normalized. Fields it did not get are
 * absent.
 */
export interface PortfolioSnapshotFilters {
  page: number;
  take: number;
  marketId?: number;
  contractMarketId?: string;
  search?: string;
  sortOrder?: 'ASC' | 'DESC' | (string & {});
  sortBy?: PortfolioSortKey | (string & {});
  status?: 'active' | 'closed' | 'all' | 'resolved' | (string & {});
  marketScope?: string;
  marketStatus?: string;
  refresh?: boolean;
  eventId?: string;
  includeSubEvents?: boolean;
}

/**
 * The account's portfolio, as `/portfolio` pushes it (`portfolio_snapshot`): on subscribe, and
 * again whenever the account's wallet, the subscribed market or the subscribed event trades. Each
 * snapshot is the whole page for the filters: replace what you had.
 *
 * `T` is {@link PortfolioMarket} (one row per market, the summary) or, with `marketId`,
 * {@link PortfolioPosition} (the detail rows), as in `portfolio.mine`.
 */
export interface PortfolioSnapshotEvent<
  T extends PortfolioMarket | PortfolioPosition =
    | PortfolioMarket
    | PortfolioPosition,
> {
  type: 'portfolio_snapshot';
  data: T[];
  meta: PageMeta;
  filters: PortfolioSnapshotFilters;
  /** When the backend built it (ISO-8601). */
  emittedAt: string;
}

/**
 * The events of a `/portfolio` subscription. The backend's `portfolio_error` and
 * `exception` are not events of the stream: they surface as `'error'` (an `XoError` with
 * the backend's `code`), see `BackendRealtime`.
 */
export type PortfolioChannelEvent =
  | PortfolioSnapshotEvent<PortfolioMarket>
  | PortfolioSnapshotEvent<PortfolioPosition>;

const PORTFOLIO_SOCKET_SPEC = {
  page: field.int(1, MAX_PAGE),
  take: field.int(1, PORTFOLIO_MAX_TAKE),
  search: field.str(),
  sortBy: field.oneOf(PORTFOLIO_SORT_KEYS),
  sortOrder: field.oneOf(['ASC', 'DESC']),
  status: field.oneOf(['active', 'closed', 'all', 'resolved']),
  marketScope: field.oneOf(MARKET_SCOPES),
  marketStatus: field.oneOf(MARKET_STATUSES),
  marketId: field.id(),
  contractMarketId: PORTFOLIO_SPEC.contractMarketId,
  eventId: field.pattern(
    EVENT_UUID,
    'an event UUID (8-4-4-4-12 hex digits, version 1 to 5)',
  ),
  includeSubEvents: field.bool(),
};

const PORTFOLIO_HINTS = {
  refresh:
    'a stream would drop the backend cache on every push; snapshots of a pulse-including scope (the default) are never cached',
  claimableFirst: 'the socket does not read it',
  user: 'that is the public portfolio namespace; /portfolio streams the account of the key',
};

/**
 * Checks the filters of `portfolio_subscribe` (closed: an unknown key is refused) against
 * the gateway's rules, and returns what is sent, with the default scope (`'withPulse'`, or
 * `'onlyClob'` with `eventId`, the gateway's own default for an event).
 *
 * @throws {UserInputError} before anything connects.
 */
export function portfolioSubscribePayload(
  input: unknown,
): Record<string, unknown> {
  const label = 'portfolio filters';
  const filters: Record<string, unknown> = closedQuery(
    label,
    input,
    PORTFOLIO_SOCKET_SPEC,
    PORTFOLIO_HINTS,
  );
  if (filters.eventId !== undefined) {
    // The gateway's INVALID_FILTER and TAKE_LIMIT checks.
    if (
      filters.marketId !== undefined ||
      filters.contractMarketId !== undefined
    ) {
      throw new UserInputError(
        `${label}: eventId cannot be combined with marketId or contractMarketId`,
      );
    }
    const take = filters.take as number | undefined;
    if (take !== undefined && take > PORTFOLIO_EVENT_MAX_TAKE) {
      throw new UserInputError(
        `${label}: take must be at most ${PORTFOLIO_EVENT_MAX_TAKE} with eventId`,
      );
    }
  }
  if (filters.marketScope !== undefined) {
    return filters;
  }
  return {
    ...filters,
    marketScope:
      filters.eventId === undefined
        ? DEFAULT_PORTFOLIO_SOCKET_SCOPE
        : DEFAULT_PORTFOLIO_EVENT_SCOPE,
  };
}

const portfolioFiltersSchema = (obj: ObjFactory) =>
  obj({
    page: z.number(),
    take: z.number(),
    marketId: z.number().optional(),
    contractMarketId: z.string().optional(),
    search: z.string().optional(),
    sortOrder: z.string().optional(),
    sortBy: z.string().optional(),
    status: z.string().optional(),
    marketScope: z.string().optional(),
    marketStatus: z.string().optional(),
    refresh: z.boolean().optional(),
    eventId: z.string().optional(),
    includeSubEvents: z.boolean().optional(),
  });

export const PortfolioSummarySnapshotSchema: DualSchema<
  PortfolioSnapshotEvent<PortfolioMarket>
> = defineSchema((obj, enumOf) =>
  obj({
    type: z.literal('portfolio_snapshot'),
    data: z.array(portfolioMarketSchema(obj, enumOf)),
    meta: pageMetaSchema(obj),
    filters: portfolioFiltersSchema(obj),
    emittedAt: z.string(),
  }),
);

export const PortfolioDetailSnapshotSchema: DualSchema<
  PortfolioSnapshotEvent<PortfolioPosition>
> = defineSchema((obj, enumOf) =>
  obj({
    type: z.literal('portfolio_snapshot'),
    data: z.array(portfolioPositionSchema(obj, enumOf)),
    meta: pageMetaSchema(obj),
    filters: portfolioFiltersSchema(obj),
    emittedAt: z.string(),
  }),
);

// ---------------------------------------------------------------------------
// Market activity
// ---------------------------------------------------------------------------

/**
 * The filters of a `/market-activity` subscription: the fields of the REST route's filters
 * that the gateway reads, with the REST route's checks.
 */
export interface MarketActivityFilters {
  /** 1 to 10000. */
  page?: number;
  /** 1 to 50 (the gateway caps it at 50). Defaults (server-side) to 10. */
  take?: number;
  /** Defaults (server-side) to `'executedAt'`. */
  sortBy?: ActivitySortKey;
  /** Defaults (server-side) to `'DESC'`. */
  sortOrder?: 'ASC' | 'DESC';
  /** Defaults (server-side) to `'all'`. */
  positionType?: 'BUY' | 'SELL' | 'all';
  /** One trader, by backend user id. */
  userId?: number;
  outcomeId?: number;
  /** 0-based. */
  outcomeIndex?: number;
  /**
   * Only the viewer's own trades. It needs a viewer: a session whose key holds
   * `account:read` and whose account has a Privy id.
   * Without a session it is refused at once. When the backend serves the connection
   * anonymously all the same, it cannot build the snapshots (the backend refuses
   * `userTradesOnly` without a viewer): an
   * `'error'` with code `'ws_anonymous_viewer'` says so, and each snapshot is a
   * `'ws_snapshot_failed'`.
   */
  userTradesOnly?: boolean;
}

/** The filters as the gateway echoes them, normalized. */
export interface MarketActivitySnapshotFilters {
  page: number;
  take: number;
  sortBy: ActivitySortKey | (string & {});
  sortOrder: 'ASC' | 'DESC' | (string & {});
  positionType: 'BUY' | 'SELL' | 'all' | (string & {});
  userId?: number;
  outcomeId?: number;
  outcomeIndex?: number;
  userTradesOnly: boolean;
}

/**
 * A market's trade feed, as `/market-activity` pushes it (`market_activity_snapshot`): on
 * subscribe, and again (debounced) after each trade
 * in the market. Each snapshot is the whole page for the filters: replace what you had. The
 * rows are those of `markets.activity` (`GET /markets/:id/activity`), except that the
 * socket does not add `marketEffectiveFeeConfig`, and that a `userTradesOnly` snapshot (with a
 * viewer) lists the account's own history: its rows can be a `REDEEM`, `SPLIT`, `MERGE`,
 * `TRANSFER_IN`, `TRANSFER_OUT` or `REFUND` as well as a fill, so check `positionType`.
 */
export interface MarketActivitySnapshotEvent {
  type: 'market_activity_snapshot';
  marketId: number;
  data: MarketActivity[];
  meta: PageMeta;
  filters: MarketActivitySnapshotFilters;
  /** When the backend built it (ISO-8601). */
  emittedAt: string;
}

/**
 * The events of a `/market-activity` subscription. The backend's `market_activity_error` and
 * `exception` surface as `'error'`, see `BackendRealtime`.
 */
export type MarketActivityChannelEvent = MarketActivitySnapshotEvent;

const MARKET_ACTIVITY_SOCKET_SPEC = {
  ...MARKET_ACTIVITY_SPEC,
  userTradesOnly: field.bool(),
};

/**
 * Checks the filters of `market_activity_subscribe` (closed) and returns what is sent.
 *
 * @throws {UserInputError} before anything connects.
 */
export function marketActivityFilters(input: unknown): Record<string, unknown> {
  return closedQuery('activity filters', input, MARKET_ACTIVITY_SOCKET_SPEC, {
    search: 'the gateway does not search',
  });
}

export const MarketActivitySnapshotSchema: DualSchema<MarketActivitySnapshotEvent> =
  defineSchema((obj, enumOf) =>
    obj({
      type: z.literal('market_activity_snapshot'),
      marketId: z.number(),
      // Every kind of history row, not only the fills of the public REST feeds: with an
      // authenticated viewer and `userTradesOnly` (no `outcomeIndex`) the gateway builds the page
      // from the account's own history, REDEEM, SPLIT and the rest included, with no type
      // filter. One schema serves every subscription of the channel.
      data: z.array(activitySchema(obj, enumOf, HISTORY_POSITION_TYPES)),
      meta: pageMetaSchema(obj),
      filters: obj({
        page: z.number(),
        take: z.number(),
        sortBy: z.string(),
        sortOrder: z.string(),
        positionType: z.string(),
        userId: z.number().optional(),
        outcomeId: z.number().optional(),
        outcomeIndex: z.number().optional(),
        userTradesOnly: z.boolean(),
      }),
      emittedAt: z.string(),
    }),
  );

/** `market_activity_connection_ack`. */
export interface MarketActivityConnectionAck {
  message: string;
  /** True only when a viewer was resolved from the credential. */
  authenticated: boolean;
  timestamp: string;
}

export const MarketActivityConnectionAckSchema: DualSchema<MarketActivityConnectionAck> =
  defineSchema((obj) =>
    obj({
      message: z.string(),
      authenticated: z.boolean(),
      timestamp: z.string(),
    }),
  );
