// Internal: the closed query objects of the data client, and the path-segment checks.
//
// Every route takes a plain params object. An unknown key is a UserInputError raised
// before any request, because the backend refuses a query key it does not know with a 400,
// and because silently dropping a misspelled filter would return the wrong data. The checks
// mirror the validation rules of the backend: ranges, enums and the maximum `take`. Where the
// backend clamps instead (the activity feeds cap `take` at 50 although their filter allows 1000),
// the real limit is used.

import { isDecimalString, numberToDecimal } from '../core/decimal';
import { UserInputError } from '../core/errors';

/** One query value as the transport serializes it. */
export type QueryValue = string | number | boolean;
export type Query = Record<string, QueryValue | undefined>;

/** Checks one param and returns what goes on the wire, or `undefined` to leave it out. */
export type Field = (value: unknown, name: string) => QueryValue | undefined;

const MAX_KEY_ECHO = 40;

// A field check refuses with a message that starts at the param name; closedQuery puts the
// label of the call in front.
function rule(message: string): never {
  throw new UserInputError(message);
}

const SAFE_INT_MAX = Number.MAX_SAFE_INTEGER;

/** Builders for the param checks. */
export const field = {
  /** A whole number in `min..max`. A numeric string is refused. */
  int(min: number, max: number = SAFE_INT_MAX): Field {
    return (value, name) => {
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < min ||
        value > max
      ) {
        rule(
          max === SAFE_INT_MAX
            ? `${name} must be a whole number of at least ${min}`
            : `${name} must be a whole number between ${min} and ${max}`,
        );
      }
      return value;
    };
  },

  /** A positive whole number: a database id. */
  id(): Field {
    return field.int(1);
  },

  /** A non-empty string. */
  str(): Field {
    return (value, name) => {
      if (typeof value !== 'string' || value === '') {
        rule(`${name} must be a non-empty string`);
      }
      return value;
    };
  },

  /** A string that matches `pattern`. */
  pattern(pattern: RegExp, description: string): Field {
    return (value, name) => {
      if (typeof value !== 'string' || !pattern.test(value)) {
        rule(`${name} must be ${description}`);
      }
      return value;
    };
  },

  bool(): Field {
    return (value, name) => {
      if (typeof value !== 'boolean') {
        rule(`${name} must be true or false`);
      }
      return value;
    };
  },

  /** One of the listed strings, exactly. */
  oneOf(values: readonly string[]): Field {
    return (value, name) => {
      if (typeof value !== 'string' || !values.includes(value)) {
        rule(`${name} must be one of: ${values.join(', ')}`);
      }
      return value;
    };
  },

  /**
   * One value or an array, sent comma-separated. An empty array is left out. `max` caps
   * the number of items. A string item must not contain a comma.
   */
  list(item: Field, o: { max?: number } = {}): Field {
    return (value, name) => {
      const items: unknown[] = Array.isArray(value) ? value : [value];
      if (items.length === 0) {
        return undefined;
      }
      if (o.max !== undefined && items.length > o.max) {
        rule(`${name} takes at most ${o.max} values`);
      }
      const parts = items.map((entry, index) => {
        if (typeof entry === 'string' && entry.includes(',')) {
          rule(`${name}[${index}] must not contain a comma`);
        }
        return String(item(entry, `${name}[${index}]`));
      });
      return parts.join(',');
    };
  },

  /** A `Date` or a date string that parses; sent as an ISO-8601 string. */
  dateTime(): Field {
    return (value, name) => {
      const date =
        value instanceof Date
          ? value
          : typeof value === 'string' && value !== ''
            ? new Date(value)
            : undefined;
      if (date === undefined || Number.isNaN(date.getTime())) {
        rule(`${name} must be a valid Date or date string`);
      }
      return date.toISOString();
    };
  },

  /**
   * A non-negative plain decimal, as a decimal string or a number (a number is converted
   * exactly, see `numberToDecimal`). The backend reads it as a number of at least 0.
   */
  decimal(): Field {
    return (value, name) => {
      let text: string | undefined;
      if (typeof value === 'number' && Number.isFinite(value)) {
        text = numberToDecimal(value, name);
      } else if (typeof value === 'string' && isDecimalString(value)) {
        text = value;
      }
      if (text === undefined || text.startsWith('-')) {
        rule(`${name} must be a non-negative plain decimal (no exponent)`);
      }
      return text;
    };
  },
};

/** A param object: field name to its check, in the order the query is written. */
export type Spec = Record<string, Field>;

/**
 * Checks `input` against `spec` and returns the query.
 *
 * `input` must be `undefined` or a plain object. A key outside `spec` is refused (named,
 * truncated, with the allowed keys; `hints` can say why a known backend key is not offered).
 * A key set to `undefined` is the same as absent; `null` is refused. A param's message names
 * the call and the param, never the value.
 */
export function closedQuery(
  label: string,
  input: unknown,
  spec: Spec,
  hints: Record<string, string> = {},
): Query {
  if (input === undefined) {
    return {};
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new UserInputError(`${label}: the params must be an object`);
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(spec, key)) {
      const hint = Object.hasOwn(hints, key) ? hints[key] : undefined;
      throw new UserInputError(
        hint !== undefined
          ? `${label}: ${key} is not available: ${hint}`
          : `${label}: unknown param "${key.slice(0, MAX_KEY_ECHO)}" (allowed: ${Object.keys(spec).join(', ')})`,
      );
    }
  }
  const query: Query = {};
  for (const [name, check] of Object.entries(spec)) {
    const value = record[name];
    if (value === undefined) {
      continue;
    }
    try {
      query[name] = check(value, name);
    } catch (error) {
      if (error instanceof UserInputError) {
        throw new UserInputError(`${label}: ${error.message}`);
      }
      throw error;
    }
  }
  return query;
}

// ---------------------------------------------------------------------------
// Shared enums and fields
// ---------------------------------------------------------------------------

/** The market scopes the backend takes. */
export const MARKET_SCOPES = [
  'default',
  'withPulse',
  'onlyPulse',
  'onlyClob',
  'withClob',
  'onlyClobPulse',
  'onlyConviction',
] as const;
/** Which market types a list includes (the backend's `marketScope`). The data client defaults to `'onlyClob'` for discovery. */
export type MarketScope = (typeof MARKET_SCOPES)[number];

/** The backend's market-type codes: 0 standard (LMSR), 1 pulse, 2 CLOB, 3 CLOB pulse, 4 CLOB conviction. */
export type MarketTypeCode = 0 | 1 | 2 | 3 | 4;

/**
 * What the data client asks for when the caller sets no `marketScope`: CLOB markets (types
 * 2 and 3), the only ones that trade on the orderbook. The backend's own default
 * (`default`) is the legacy AMM markets plus CLOB.
 */
export const DEFAULT_MARKET_SCOPE: MarketScope = 'onlyClob';

/** The statuses a market can have, plus the two values that only the filters accept. */
export const MARKET_STATUS_FILTERS = [
  'PENDING',
  'ACTIVE',
  'PAUSED',
  'CANCELLED',
  'RESOLVED',
  'DISPUTED',
  'CLOSED',
  'DEFAULTED',
  'UPDATE_REQUIRED',
  'VOIDED',
  'VOIDED_CLOSED',
  'CLOSING_24H',
  'EXPIRED',
] as const;
/** A market status filter of the market lists. */
export type MarketStatusFilter = (typeof MARKET_STATUS_FILTERS)[number];

/**
 * The highest `page` the backend takes: its list filters stop at 10000, and a request for page
 * 10001 is a 400.
 * A paginator stops here (see `pages.ts`); narrow the filters to reach what lies beyond.
 */
export const MAX_PAGE = 10_000;
/** `GET /pulse/markets` has no page ceiling; this is the SDK's own sanity bound. */
export const PULSE_MAX_PAGE = 1_000_000;
/**
 * The highest 0-based `page` the liquidity-rewards routes take. The
 * `offsetPages` paginator stops here.
 */
export const MAX_REWARDS_PAGE = 1_000_000;

const PAGE = field.int(1, MAX_PAGE);
const SORT_ORDER = field.oneOf(['ASC', 'DESC']);
const MARKET_TYPES = field.list(field.oneOf(['0', '1', '2', '3', '4']));
const STATUSES = field.list(field.oneOf(MARKET_STATUS_FILTERS));
const SCOPE = field.oneOf(MARKET_SCOPES);

/** A market type or types: sent as numbers, checked as `0..4`. */
const marketTypes: Field = (value, name) => {
  const items: unknown[] = Array.isArray(value) ? value : [value];
  for (const [index, item] of items.entries()) {
    if (
      !Number.isInteger(item) ||
      (item as number) < 0 ||
      (item as number) > 4
    ) {
      rule(`${name}[${index}] must be 0, 1, 2, 3 or 4`);
    }
  }
  return MARKET_TYPES(
    items.map((item) => String(item)),
    name,
  );
};

/** Sets the default scope when the caller gave none. */
function withDefaultScope(query: Query): Query {
  return query.marketScope === undefined
    ? { ...query, marketScope: DEFAULT_MARKET_SCOPE }
    : query;
}

// ---------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------

/** The sort keys of `GET /markets`, as the backend's market filter lists them. */
export const MARKET_SORT_KEYS = [
  'createdAt',
  'expiresAt',
  'startsAt',
  'totalVolume',
  'liquidity',
  'priorityScore',
  'conviction',
  'endingSoon',
  'totalVolumeInUSD',
] as const;
/** What `markets.list` sorts by. */
export type MarketSortKey = (typeof MARKET_SORT_KEYS)[number];

/** The query of `GET /markets`. */
export interface ListMarketsParams {
  /** 1 to 10000. The paginator starts here. */
  page?: number;
  /** 1 to 50. */
  take?: number;
  search?: string;
  sortBy?: MarketSortKey;
  sortOrder?: 'ASC' | 'DESC';
  /** Defaults to `'onlyClob'`: the data client lists markets that trade on the orderbook. */
  marketScope?: MarketScope;
  /** Overrides `marketScope`. */
  marketType?: MarketTypeCode | MarketTypeCode[];
  categories?: string[];
  categoryId?: number;
  subcategoryId?: number;
  subcategoryUnassigned?: boolean;
  tagKey?: string;
  tagValue?: string;
  statuses?: MarketStatusFilter[];
  excludedStatuses?: MarketStatusFilter[];
  creatorId?: number;
  creatorType?: 'admin' | 'user';
  expiresAfter?: Date | string;
  expiresBefore?: Date | string;
  /** In USD, or in collateral token units when `volumeInToken` is true. */
  minVolume?: number | string;
  maxVolume?: number | string;
  volumeInToken?: boolean;
  collateralTokenIds?: number[];
  isResolved?: boolean;
  /**
   * Only admin-featured markets. The backend then ignores `marketScope` (it lists featured
   * markets of every type) unless `marketType` is set.
   */
  isFeatureMarket?: boolean;
  unplacedOnly?: boolean;
  /** Conviction markets only: graduated (true) or ungraduated (false). */
  graduated?: boolean;
  /** Up to 100 contract market ids or condition ids, resolved in one request. */
  contractMarketIds?: string[];
}

/** The query of `GET /markets/browse`: the list filters plus the browse-only ones. */
export interface BrowseMarketsParams extends Omit<ListMarketsParams, 'sortBy'> {
  /** `'smart'` is the browse "trending" order. */
  sortBy?: MarketSortKey | 'smart';
  /** Include legacy LMSR (AMM) markets. They cannot trade on the orderbook. */
  includeAMM?: boolean;
}

// Each spec below is checked against its params interface at compile time: `satisfies
// Record<keyof XParams, Field>` fails if the interface has a key the spec lacks (the param
// would be refused at run time) or the spec has a key the interface lacks (it would be
// accepted but untyped).
export const LIST_MARKETS_SPEC = {
  page: PAGE,
  take: field.int(1, 50),
  search: field.str(),
  sortBy: field.oneOf(MARKET_SORT_KEYS),
  sortOrder: SORT_ORDER,
  marketScope: SCOPE,
  marketType: marketTypes,
  unplacedOnly: field.bool(),
  graduated: field.bool(),
  categories: field.list(field.str()),
  categoryId: field.id(),
  subcategoryId: field.id(),
  subcategoryUnassigned: field.bool(),
  tagValue: field.str(),
  tagKey: field.str(),
  statuses: STATUSES,
  excludedStatuses: STATUSES,
  creatorId: field.id(),
  expiresAfter: field.dateTime(),
  expiresBefore: field.dateTime(),
  minVolume: field.decimal(),
  maxVolume: field.decimal(),
  volumeInToken: field.bool(),
  collateralTokenIds: field.list(field.id()),
  isResolved: field.bool(),
  creatorType: field.oneOf(['admin', 'user']),
  isFeatureMarket: field.bool(),
  contractMarketIds: field.list(field.str(), { max: 100 }),
} satisfies Record<keyof ListMarketsParams, Field>;

export const BROWSE_MARKETS_SPEC = {
  ...LIST_MARKETS_SPEC,
  sortBy: field.oneOf([...MARKET_SORT_KEYS, 'smart']),
  includeAMM: field.bool(),
} satisfies Record<keyof BrowseMarketsParams, Field>;

const SKIP_HINT =
  'the backend computes skip from page and take, and refuses it as a param';

/** `GET /markets`. */
export function listMarketsQuery(input: unknown): Query {
  return withDefaultScope(
    closedQuery('markets.list', input, LIST_MARKETS_SPEC, { skip: SKIP_HINT }),
  );
}

/** `GET /markets/browse`. */
export function browseMarketsQuery(input: unknown): Query {
  return withDefaultScope(
    closedQuery('markets.browse', input, BROWSE_MARKETS_SPEC, {
      skip: SKIP_HINT,
    }),
  );
}

const ACTIVITY_SORT_KEYS = [
  'executedAt',
  'volumeInUSD',
  'collateralAmount',
  'shareAmount',
  'createdAt',
] as const;
/** What a market's activity (`markets.activity`, `markets.allActivity`) sorts by. */
export type ActivitySortKey = (typeof ACTIVITY_SORT_KEYS)[number];

/**
 * The query of `GET /markets/:id/activity`. The route caps `take` at 50.
 */
export interface MarketActivityParams {
  page?: number;
  /** 1 to 50. */
  take?: number;
  sortBy?: ActivitySortKey;
  sortOrder?: 'ASC' | 'DESC';
  positionType?: 'BUY' | 'SELL' | 'all';
  /** A backend user id. */
  userId?: number;
  outcomeId?: number;
  /** 0-based. */
  outcomeIndex?: number;
}

export const MARKET_ACTIVITY_SPEC = {
  page: PAGE,
  take: field.int(1, 50),
  sortBy: field.oneOf(ACTIVITY_SORT_KEYS),
  sortOrder: SORT_ORDER,
  positionType: field.oneOf(['BUY', 'SELL', 'all']),
  userId: field.id(),
  outcomeId: field.id(),
  outcomeIndex: field.int(0, 1_000),
} satisfies Record<keyof MarketActivityParams, Field>;

/** `GET /markets/:id/activity`. */
export function marketActivityQuery(input: unknown): Query {
  return closedQuery('markets.activity', input, MARKET_ACTIVITY_SPEC, {
    userTradesOnly:
      'it needs a signed-in user, and public calls are sent without credentials; use userId to filter by trader',
    search: 'the route does not search',
    skip: SKIP_HINT,
  });
}

/** The query of `GET /markets/activities`. */
export interface AllActivityParams {
  page?: number;
  /** 1 to 50. */
  take?: number;
  /** Overrides `marketScope`. */
  marketType?: MarketTypeCode | MarketTypeCode[];
  /** Defaults to `'onlyClob'`. */
  marketScope?: MarketScope;
  sortBy?: ActivitySortKey;
  sortOrder?: 'ASC' | 'DESC';
  positionType?: 'BUY' | 'SELL' | 'all';
  /** A single market's database id. */
  marketId?: number;
}

export const ALL_ACTIVITY_SPEC = {
  page: PAGE,
  take: field.int(1, 50),
  marketType: marketTypes,
  marketScope: SCOPE,
  sortBy: field.oneOf(ACTIVITY_SORT_KEYS),
  sortOrder: SORT_ORDER,
  positionType: field.oneOf(['BUY', 'SELL', 'all']),
  marketId: field.id(),
} satisfies Record<keyof AllActivityParams, Field>;

/** `GET /markets/activities`. */
export function allActivityQuery(input: unknown): Query {
  return withDefaultScope(
    closedQuery('markets.allActivity', input, ALL_ACTIVITY_SPEC, {
      skip: SKIP_HINT,
    }),
  );
}

/**
 * `GET /markets/fee-config/effective`: the market's contract market id or condition id.
 * The backend looks the id up as stored, so no format is enforced here beyond a sane string.
 */
export function feeConfigQuery(contractMarketId: unknown): Query {
  const text =
    typeof contractMarketId === 'string' ? contractMarketId.trim() : '';
  if (text === '' || text.length > 128) {
    throw new UserInputError(
      "markets.feeConfig: contractMarketId must be a market's condition id or contract market id",
    );
  }
  return { marketId: text };
}

/** The query of `GET /markets/pulse/stats`. */
export interface PulseStatsParams {
  /** A market's contract market id: adds that market's seed to `currentPositionsValue`. */
  marketId?: string;
  /**
   * `'onlyClobPulse'` (CLOB pulse markets, type 3: the ones that trade on the orderbook) or
   * `'onlyPulse'` (legacy AMM pulse markets, type 1). Defaults to `'onlyClobPulse'`.
   * The backend itself maps anything other than `'onlyClobPulse'` to `'onlyPulse'`.
   */
  marketScope?: 'onlyPulse' | 'onlyClobPulse';
}

/**
 * What the data client asks `GET /markets/pulse/stats` for when the caller sets no scope:
 * the CLOB pulse markets, the pulse counterpart of the `onlyClob` default. The
 * backend's own default is `onlyPulse`, the legacy AMM pulse markets.
 */
export const DEFAULT_PULSE_STATS_SCOPE = 'onlyClobPulse' as const;

export const PULSE_STATS_SPEC = {
  marketId: field.str(),
  marketScope: field.oneOf(['onlyPulse', 'onlyClobPulse']),
} satisfies Record<keyof PulseStatsParams, Field>;

/**
 * `GET /markets/pulse/stats`. The route takes only the two pulse scopes, so the general
 * `onlyClob` default does not apply; the default is {@link DEFAULT_PULSE_STATS_SCOPE}.
 */
export function pulseStatsQuery(input: unknown): Query {
  const query = closedQuery('markets.pulseStats', input, PULSE_STATS_SPEC);
  return query.marketScope === undefined
    ? { ...query, marketScope: DEFAULT_PULSE_STATS_SCOPE }
    : query;
}

// ---------------------------------------------------------------------------
// Events and series
// ---------------------------------------------------------------------------

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = field.pattern(UUID_PATTERN, 'a UUID');

/** The sort keys the backend's event lists take. */
export const EVENT_SORT_KEYS = [
  'sortOrder',
  'title',
  'createdAt',
  'updatedAt',
  'metadataValue',
  'totalVolumeInUSD',
  'totalVolume',
  'expiresAt',
  'endingSoon',
] as const;
/** What `events.list` sorts by. */
export type EventSortKey = (typeof EVENT_SORT_KEYS)[number];

/** The query of `GET /v1/events`. */
export interface ListEventsParams {
  page?: number;
  /** 1 to 1000. */
  take?: number;
  search?: string;
  /** The market-derived keys (`totalVolumeInUSD` and below) apply with `withMarkets`. */
  sortBy?: EventSortKey;
  sortOrder?: 'ASC' | 'DESC';
  seriesId?: string;
  /** The backend default is true. */
  rootsOnly?: boolean;
  categoryId?: number;
  /** Embed `markets[]` per root event. Needs `seriesId`. */
  withMarkets?: boolean;
  hasSubEvents?: boolean;
  /** Only with `withMarkets`. */
  statuses?: MarketStatusFilter[];
  excludedStatuses?: MarketStatusFilter[];
  /** Filter by event type and placed market type. */
  marketType?: MarketTypeCode | MarketTypeCode[];
  /** A JSON metadata key (letters, digits, underscore) for `metadataValue` sorting and the range. */
  metadataKey?: string;
  metadataAfter?: Date | string;
  metadataBefore?: Date | string;
}

export const LIST_EVENTS_SPEC = {
  page: PAGE,
  take: field.int(1, 1000),
  search: field.str(),
  sortBy: field.oneOf(EVENT_SORT_KEYS),
  sortOrder: SORT_ORDER,
  metadataKey: field.pattern(
    /^[A-Za-z0-9_]+$/,
    'letters, digits and underscores only',
  ),
  metadataAfter: field.dateTime(),
  metadataBefore: field.dateTime(),
  hasSubEvents: field.bool(),
  seriesId: uuid,
  rootsOnly: field.bool(),
  categoryId: field.id(),
  withMarkets: field.bool(),
  statuses: STATUSES,
  excludedStatuses: STATUSES,
  marketType: marketTypes,
} satisfies Record<keyof ListEventsParams, Field>;

/** `GET /v1/events`. */
export function listEventsQuery(input: unknown): Query {
  return closedQuery('events.list', input, LIST_EVENTS_SPEC, {
    skip: SKIP_HINT,
  });
}

/** The sort keys of the scoped market lists. */
export const SCOPED_MARKET_SORT_KEYS = [
  'totalVolume',
  'totalVolumeInUSD',
  'createdAt',
  'expiresAt',
  'eventSortOrder',
  'rootEventSortOrder',
] as const;
/** What the markets of an event or a series sort by. */
export type ScopedMarketSortKey = (typeof SCOPED_MARKET_SORT_KEYS)[number];

/** The query of `GET /v1/events/:id/markets` and `GET /v1/series/:id/markets`. */
export interface ScopedMarketsParams {
  page?: number;
  /** 1 to 1000. */
  take?: number;
  search?: string;
  /** The backend default is `totalVolumeInUSD`. */
  sortBy?: ScopedMarketSortKey;
  sortOrder?: 'ASC' | 'DESC';
  /** Include sub-event markets. The backend default is true. */
  includeSubEvents?: boolean;
  statuses?: MarketStatusFilter[];
  excludedStatuses?: MarketStatusFilter[];
}

export const SCOPED_MARKETS_SPEC = {
  page: PAGE,
  take: field.int(1, 1000),
  search: field.str(),
  sortBy: field.oneOf(SCOPED_MARKET_SORT_KEYS),
  sortOrder: SORT_ORDER,
  includeSubEvents: field.bool(),
  statuses: STATUSES,
  excludedStatuses: STATUSES,
} satisfies Record<keyof ScopedMarketsParams, Field>;

/** The scoped market lists of events and series. */
export function scopedMarketsQuery(input: unknown, label: string): Query {
  return closedQuery(label, input, SCOPED_MARKETS_SPEC, { skip: SKIP_HINT });
}

/** The query of `GET /v1/series`. */
export interface ListSeriesParams {
  /** Only active series (the backend default is true). */
  active?: boolean;
}

export const LIST_SERIES_SPEC = {
  active: field.bool(),
} satisfies Record<keyof ListSeriesParams, Field>;

/**
 * `GET /v1/series`. The route's filter also takes `page`, `take`, `search` and the sort keys, but
 * the route reads only `active` and answers the whole list, so they are not offered.
 */
export function listSeriesQuery(input: unknown): Query {
  return closedQuery('series.list', input, LIST_SERIES_SPEC, {
    page: 'the route returns every series',
    take: 'the route returns every series',
    search: 'the route returns every series',
    sortBy: 'the route returns every series',
    sortOrder: 'the route returns every series',
  });
}

// ---------------------------------------------------------------------------
// Pulse
// ---------------------------------------------------------------------------

/** The query of `GET /pulse/markets`. */
export interface PulseListParams {
  page?: number;
  /** 1 to 100 (the documented maximum). */
  limit?: number;
  /** Such as `'ACTIVE'`, `'RESOLVED'`, `'CLOSED'`. The backend lower-cases it. */
  status?: string;
  marketConfigId?: number;
  adapterConfigId?: number;
  sortBy?: 'createdAt' | 'expiresAt' | 'resolvedAt' | 'closedAt';
  sortOrder?: 'ASC' | 'DESC';
}

export const PULSE_LIST_SPEC = {
  page: field.int(1, PULSE_MAX_PAGE),
  limit: field.int(1, 100),
  status: field.str(),
  marketConfigId: field.id(),
  adapterConfigId: field.id(),
  sortBy: field.oneOf(['createdAt', 'expiresAt', 'resolvedAt', 'closedAt']),
  sortOrder: SORT_ORDER,
} satisfies Record<keyof PulseListParams, Field>;

/** `GET /pulse/markets`. */
export function pulseListQuery(input: unknown): Query {
  return closedQuery('pulse.list', input, PULSE_LIST_SPEC);
}

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

/**
 * The overview params that `GET /categories` and `GET /subcategories` share.
 */
export interface OverviewParams {
  sortBy?: 'marketsCount';
  /** The direction of the `marketsCount` order. The backend default is `'desc'`. */
  sort?: 'asc' | 'desc';
  /** Overrides `marketScope`. */
  marketType?: MarketTypeCode | MarketTypeCode[];
  /** Scopes `marketsCount`. Defaults to `'onlyClob'`. */
  marketScope?: MarketScope;
  status?: 'active' | 'inactive';
  /** `'browse'` counts only the markets `GET /markets/browse` can return. */
  countScope?: 'all' | 'browse';
}

export const OVERVIEW_SPEC = {
  sortBy: field.oneOf(['marketsCount']),
  sort: field.oneOf(['asc', 'desc']),
  marketType: marketTypes,
  marketScope: SCOPE,
  status: field.oneOf(['active', 'inactive']),
  countScope: field.oneOf(['all', 'browse']),
} satisfies Record<keyof OverviewParams, Field>;

/** The query of `GET /categories`. */
export type CategoriesParams = OverviewParams;

/**
 * `GET /categories`. Any of `marketScope`, `marketType`, `sortBy` or `countScope` makes the
 * route answer in overview mode (every active category with a `marketsCount`); the default
 * `marketScope` therefore always selects the overview, which has every field of the plain
 * list and the count.
 */
export function categoriesQuery(input: unknown): Query {
  return withDefaultScope(
    closedQuery('taxonomy.categories', input, OVERVIEW_SPEC),
  );
}

/** The query of `GET /subcategories`: the overview params and the paginated list's own. */
export interface SubcategoriesParams extends OverviewParams {
  // Paginated list (give any of these three):
  page?: number;
  /** 1 to 1000. */
  take?: number;
  search?: string;
  // Both modes:
  categoryId?: number;
}

const PAGINATED_KEYS = ['page', 'take', 'search'] as const;
const OVERVIEW_KEYS = [
  'sortBy',
  'sort',
  'marketType',
  'marketScope',
  'countScope',
] as const;

export const SUBCATEGORIES_SPEC = {
  ...OVERVIEW_SPEC,
  page: PAGE,
  take: field.int(1, 1000),
  search: field.str(),
  categoryId: field.id(),
} satisfies Record<keyof SubcategoriesParams, Field>;

/**
 * `GET /subcategories` answers in one of two modes: a paginated list
 * (`{ items, total, page, limit, totalPages, hasNext, hasPrev }`) for `page`, `take` and
 * `search`, or, when any of `sortBy`, `marketType`, `marketScope` or `countScope` is set, a
 * flat array with `marketsCount` that ignores the paginated params. The two are mutually
 * exclusive, so mixing them is refused rather than letting the backend drop half of them.
 * With neither, the overview is used with the default scope.
 */
export function subcategoriesQuery(input: unknown): {
  query: Query;
  paginated: boolean;
} {
  const query = closedQuery(
    'taxonomy.subcategories',
    input,
    SUBCATEGORIES_SPEC,
    {
      sortOrder: 'use sort: "asc" or "desc" (and sortBy: "marketsCount")',
    },
  );
  const paginated = PAGINATED_KEYS.some((key) => query[key] !== undefined);
  const overview = OVERVIEW_KEYS.some((key) => query[key] !== undefined);
  if (paginated && overview) {
    throw new UserInputError(
      `taxonomy.subcategories: ${PAGINATED_KEYS.join(', ')} select the paginated list and ${OVERVIEW_KEYS.join(', ')} select the overview; use one or the other`,
    );
  }
  return { paginated, query: paginated ? query : withDefaultScope(query) };
}

// ---------------------------------------------------------------------------
// Path segments
// ---------------------------------------------------------------------------

/** A market's database id, which the backend parses as an integer: a positive whole number or its digits. */
export function marketIdSegment(value: unknown, name = 'id'): string {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^[0-9]{1,16}$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new UserInputError(`${name} must be a positive whole number`);
  }
  return String(n);
}

/** An event or series id: a UUID, as the backend checks it. */
export function uuidSegment(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new UserInputError(`${name} must be a UUID`);
  }
  return value;
}

const MAX_SLUG = 300;

/**
 * A slug, percent-encoded for the path. A dot-only slug is refused: `..` would be resolved
 * by the URL parser and reach another route.
 */
export function slugSegment(value: unknown, name = 'slug'): string {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.length > MAX_SLUG ||
    value === '.' ||
    value === '..' ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new UserInputError(
      `${name} must be a non-empty string of at most ${MAX_SLUG} characters without control characters`,
    );
  }
  return encodeURIComponent(value);
}

const ADDRESS_OR_BYTES32 = /^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

/**
 * A market key, as the backend checks it: a 20-byte contract address or a 32-byte
 * condition id.
 */
export function marketKeySegment(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ADDRESS_OR_BYTES32.test(value)) {
    throw new UserInputError(
      `${name} must be a 0x contract address (40 hex digits) or a condition id (64 hex digits)`,
    );
  }
  return value;
}

/** A pulse market key: an on-chain market address or a condition id. */
export function pulseKeySegment(value: unknown, name = 'address'): string {
  return marketKeySegment(value, name);
}
