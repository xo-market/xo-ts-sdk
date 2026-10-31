// Internal: the closed query objects and path-segment checks of the account routes (portfolio,
// PnL, activity, account, profiles). The framework (`closedQuery`, `field`) is in `params.ts`;
// the checks here mirror the validation rules of the backend, as there.
//
// **`marketScope`.** These routes list what the account holds or did, so the SDK
// never filters them on its own: `marketScope` defaults to `'withPulse'`, which applies no
// type filter, and a scope the caller passes wins. (The `'onlyClob'` default of the market
// lists is for discovery, what a user can trade; it must not hide holdings.) The backend's
// own default, which the SDK does not use, leaves out the pulse rounds; it is written on each
// param below.

import { normalizeAddress } from '../core/address';
import { numberToDecimal } from '../core/decimal';
import { UserInputError } from '../core/errors';
import {
  closedQuery,
  type Field,
  field,
  MARKET_SCOPES,
  MAX_PAGE,
  type MarketScope,
  marketIdSegment,
  type Query,
} from './params';

const SKIP_HINT =
  'the backend computes skip from page and take, and refuses it as a param';

const PAGE = field.int(1, MAX_PAGE);
const SORT_ORDER = field.oneOf(['ASC', 'DESC']);
const SCOPE = field.oneOf(MARKET_SCOPES);
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The statuses a market can have (the portfolio and PnL filters). */
export const MARKET_STATUSES = [
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
] as const;
/** A market status the account routes filter by. */
export type MarketStatusValue = (typeof MARKET_STATUSES)[number];

/**
 * A flag the backend turns into a boolean by truthiness (`refresh` of the portfolio): it reads
 * the text `"false"` as true, so `false` is not sent, only `true`.
 */
const trueOnlyFlag: Field = (value, name) => {
  if (typeof value !== 'boolean') {
    throw new UserInputError(`${name} must be true or false`);
  }
  return value ? true : undefined;
};

/** A finite number, sent as plain decimal text (`cpMin`, `cpMax`: the DTO reads a Number). */
const finiteNumber: Field = (value, name) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new UserInputError(`${name} must be a finite number`);
  }
  return numberToDecimal(value, name);
};

/**
 * The scope the account routes send when the caller sets none: no market-type filter, so
 * nothing the account holds or did is hidden, pulse rounds included.
 */
export const DEFAULT_HOLDINGS_SCOPE: MarketScope = 'withPulse';

/** Adds {@link DEFAULT_HOLDINGS_SCOPE} unless the caller set a scope. */
function withHoldingsScope(query: Query): Query {
  return query.marketScope === undefined
    ? { ...query, marketScope: DEFAULT_HOLDINGS_SCOPE }
    : query;
}

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

export const PORTFOLIO_SORT_KEYS = [
  'pnl',
  'value',
  'expiry',
  'createdAt',
] as const;
/** What `portfolio.mine` sorts by. */
export type PortfolioSortKey = (typeof PORTFOLIO_SORT_KEYS)[number];

/** The query of `GET /users/me/portfolio`. */
export interface PortfolioParams {
  /** 1 to 10000. The paginator starts here. */
  page?: number;
  /** 1 to 1000. */
  take?: number;
  /** A word in the market's title. */
  search?: string;
  /**
   * `'createdAt'` is the latest position opened in the market, `'expiry'` the market's
   * expiry; for a list of settled statuses only, `createdAt` is treated as `expiry`.
   */
  sortBy?: PortfolioSortKey;
  sortOrder?: 'ASC' | 'DESC';
  /**
   * Defaults to `'withPulse'`: every position, whatever its market type. Without a scope the
   * backend would answer `'default'`, standard (type 0), CLOB (2) and conviction (4)
   * markets, and leave out the pulse rounds (types 1 and 3); `'onlyClobPulse'` is the CLOB
   * pulse rounds only. The scope filters by the market's type in the detail mode too.
   */
  marketScope?: MarketScope;
  /**
   * Position status: `'active'` is open positions, `'closed'` every other one (sold-out
   * legs included) and `'resolved'` positions in a resolved market.
   */
  status?: 'active' | 'closed' | 'all' | 'resolved';
  /** One market status or several (any of them matches). */
  marketStatus?: MarketStatusValue | MarketStatusValue[];
  /**
   * One market by its database id. **This switches the call to the detail mode**: the items
   * are then the market's flat position rows (`PortfolioPosition`) instead of one row per
   * market with its positions.
   */
  marketId?: number;
  /**
   * One market by its contract market id: a legacy market's 20-byte address or its numeric
   * id. It stays in the summary mode. A CLOB market's condition id (64 hex digits) is not
   * accepted by the route: use `marketId` for those.
   */
  contractMarketId?: string;
  /**
   * Bypass the backend's 30 s cache of the summary (it caches only scopes that leave out the
   * pulse rounds, so with the default `'withPulse'` every answer is live). `false` is the
   * same as leaving it out: the backend would read the text `"false"` as true, so the SDK
   * sends `refresh` only when it is `true`.
   */
  refresh?: boolean;
  /**
   * Put the markets with winnings to claim first, and keep them even when they do not match
   * `status`.
   */
  claimableFirst?: boolean;
}

/** The public variant (`GET /users/portfolio`): the params that the route acts on. */
export type PublicPortfolioParams = Omit<
  PortfolioParams,
  'refresh' | 'claimableFirst'
>;

const CONTRACT_MARKET_ID = field.pattern(
  /^(0x[a-fA-F0-9]{40}|[0-9]+)$/,
  'a 0x contract address (40 hex digits) or a numeric contract id',
);

export const PORTFOLIO_SPEC = {
  page: PAGE,
  take: field.int(1, 1000),
  search: field.str(),
  sortBy: field.oneOf(PORTFOLIO_SORT_KEYS),
  sortOrder: SORT_ORDER,
  marketScope: SCOPE,
  status: field.oneOf(['active', 'closed', 'all', 'resolved']),
  marketStatus: field.list(field.oneOf(MARKET_STATUSES)),
  marketId: field.id(),
  contractMarketId: CONTRACT_MARKET_ID,
  refresh: trueOnlyFlag,
  claimableFirst: field.bool(),
} satisfies Record<keyof PortfolioParams, Field>;

export const PUBLIC_PORTFOLIO_SPEC = {
  page: PORTFOLIO_SPEC.page,
  take: PORTFOLIO_SPEC.take,
  search: PORTFOLIO_SPEC.search,
  sortBy: PORTFOLIO_SPEC.sortBy,
  sortOrder: PORTFOLIO_SPEC.sortOrder,
  marketScope: PORTFOLIO_SPEC.marketScope,
  status: PORTFOLIO_SPEC.status,
  marketStatus: PORTFOLIO_SPEC.marketStatus,
  marketId: PORTFOLIO_SPEC.marketId,
  contractMarketId: PORTFOLIO_SPEC.contractMarketId,
} satisfies Record<keyof PublicPortfolioParams, Field>;

/** `GET /users/me/portfolio`. `detail` is true when `marketId` selects the detail mode. */
export function portfolioQuery(input: unknown): {
  query: Query;
  detail: boolean;
} {
  const query = closedQuery('portfolio.mine', input, PORTFOLIO_SPEC, {
    skip: SKIP_HINT,
  });
  return {
    query: withHoldingsScope(query),
    detail: query.marketId !== undefined,
  };
}

/** `GET /users/portfolio`, without the `user` param (see {@link publicTarget}). */
export function publicPortfolioQuery(input: unknown): {
  query: Query;
  detail: boolean;
} {
  const query = closedQuery(
    'portfolio.ofWallet',
    input,
    PUBLIC_PORTFOLIO_SPEC,
    {
      skip: SKIP_HINT,
      refresh:
        'the public route does not cache, so there is nothing to refresh',
      claimableFirst: 'the public route does not take it',
      user: 'name the account in the first argument: { wallet } or { username }',
      wallet:
        'name the account in the first argument: { wallet } or { username }',
    },
  );
  return {
    query: withHoldingsScope(query),
    detail: query.marketId !== undefined,
  };
}

/** The query of `GET /users/me/portfolio-value`. */
export interface PortfolioValueParams {
  /** Bypass the backend's 15 s cache. */
  refresh?: boolean;
}

export const VALUE_SPEC = {
  refresh: field.bool(),
} satisfies Record<keyof PortfolioValueParams, Field>;

/** `GET /users/me/portfolio-value`. */
export function valueQuery(input: unknown): Query {
  return closedQuery('portfolio.value', input, VALUE_SPEC);
}

/** The query of `GET /users/me/claimable-markets`. */
export interface ClaimableMarketsParams {
  page?: number;
  /** 1 to 100. */
  take?: number;
  sortBy?: 'claimableAmount' | 'closedAt';
  sortOrder?: 'ASC' | 'DESC';
  /**
   * Defaults to `'withPulse'`: every market with winnings, pulse rounds included. Without a
   * scope the backend would answer `'default'`, standard (type 0), CLOB (2) and conviction
   * (4) markets, and leave out the pulse rounds (types 1 and 3).
   */
  marketScope?: MarketScope;
}

/** The query of `GET /users/me/redeemable-positions`: the same, and the role. */
export interface RedeemableParams extends ClaimableMarketsParams {
  /** The trader's positions (the default) or the market creator's. */
  role?: 'user' | 'creator';
}

export const CLAIMABLE_MARKETS_SPEC = {
  page: PAGE,
  take: field.int(1, 100),
  sortBy: field.oneOf(['claimableAmount', 'closedAt']),
  sortOrder: SORT_ORDER,
  marketScope: SCOPE,
} satisfies Record<keyof ClaimableMarketsParams, Field>;

export const REDEEMABLE_SPEC = {
  ...CLAIMABLE_MARKETS_SPEC,
  role: field.oneOf(['user', 'creator']),
} satisfies Record<keyof RedeemableParams, Field>;

/** `GET /users/me/claimable-markets`. */
export function claimableMarketsQuery(input: unknown): Query {
  return withHoldingsScope(
    closedQuery('portfolio.claimableMarkets', input, CLAIMABLE_MARKETS_SPEC, {
      skip: SKIP_HINT,
    }),
  );
}

/** `GET /users/me/redeemable-positions`. */
export function redeemableQuery(input: unknown): Query {
  return withHoldingsScope(
    closedQuery('portfolio.redeemable', input, REDEEMABLE_SPEC, {
      skip: SKIP_HINT,
    }),
  );
}

export const OPEN_ORDER_STATUSES = ['resting', 'partial', 'filled'] as const;
/** The fill state `portfolio.openOrders` filters by. */
export type OpenOrderStatus = (typeof OPEN_ORDER_STATUSES)[number];

/** The query of `GET /users/me/open-orders`. */
export interface OpenOrdersParams {
  /**
   * `'latest'` (the default) newest first, `'oldest'` oldest first (stable while a history is
   * walked), `'size'` the largest notional first.
   */
  sort?: 'latest' | 'oldest' | 'size';
  /**
   * One order status or several. Without it the route answers all three: `'resting'`
   * (unfilled), `'partial'` and `'filled'`. `['resting', 'partial']` is the live book.
   */
  status?: OpenOrderStatus | OpenOrderStatus[];
  /** Orders per request, 1 to 200 (the route's default is 50). */
  limit?: number;
}

export const OPEN_ORDERS_SPEC = {
  sort: field.oneOf(['latest', 'oldest', 'size']),
  status: field.list(field.oneOf(OPEN_ORDER_STATUSES)),
  limit: field.int(1, 200),
} satisfies Record<keyof OpenOrdersParams, Field>;

/** `GET /users/me/open-orders`. The cursor is the paginator's, not a param. */
export function openOrdersQuery(input: unknown): Query {
  const cursor =
    'the paginator follows nextCursor; start a new traversal instead';
  return closedQuery('portfolio.openOrders', input, OPEN_ORDERS_SPEC, {
    cursor,
    page: cursor,
    take: 'use limit',
  });
}

// ---------------------------------------------------------------------------
// PnL
// ---------------------------------------------------------------------------

/** The query of `GET /user/pnl`. */
export interface PnlSummaryParams {
  /**
   * Defaults to `'withPulse'`: every position. Without a scope the backend would answer
   * `'default'`, standard (type 0), CLOB (2) and conviction (4) markets, and leave out the
   * pulse rounds (types 1 and 3).
   */
  marketScope?: MarketScope;
  status?: 'active' | 'closed' | 'all';
  /** One market status. */
  marketStatus?: MarketStatusValue;
}

export const PNL_SUMMARY_SPEC = {
  marketScope: SCOPE,
  status: field.oneOf(['active', 'closed', 'all']),
  marketStatus: field.oneOf(MARKET_STATUSES),
} satisfies Record<keyof PnlSummaryParams, Field>;

/** `GET /user/pnl`. */
export function pnlSummaryQuery(input: unknown): Query {
  return withHoldingsScope(closedQuery('pnl.summary', input, PNL_SUMMARY_SPEC));
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

const ACTIVITY_SORT_KEYS = [
  'executedAt',
  'volumeInUSD',
  'collateralAmount',
  'shareAmount',
  'createdAt',
] as const;

/** The query of `GET /users/me/activities`. */
export interface UserActivityParams {
  page?: number;
  /** 1 to 1000. */
  take?: number;
  /** A word in the market's title. */
  search?: string;
  /** Defaults to `'executedAt'`. */
  sortBy?: (typeof ACTIVITY_SORT_KEYS)[number];
  /** Defaults to `'DESC'`: the latest first. */
  sortOrder?: 'ASC' | 'DESC';
  /**
   * Defaults to `'withPulse'`: the history of every market type. Without a scope the backend
   * would answer `'default'`, standard (type 0) and CLOB (2) markets only, and leave out
   * pulse (1), CLOB pulse (3) and conviction (4) trades.
   */
  marketScope?: MarketScope;
  positionType?: 'BUY' | 'SELL' | 'REDEEM' | 'all';
  /** One market by its database id. */
  marketId?: number;
  /** Executed on or after this time. */
  dateFrom?: Date | string;
  /** Executed on or before this time. */
  dateTo?: Date | string;
  /** Conviction points earned: at least. */
  cpMin?: number;
  /** Conviction points earned: at most. */
  cpMax?: number;
}

/** The query of `GET /users/me/market-activities`: the same, scoped to an event if needed. */
export interface UserMarketActivityParams
  extends Omit<UserActivityParams, 'take'> {
  /** 1 to 50: the route's use case caps it there. */
  take?: number;
  /**
   * Only the markets of this event (a root event or a sub-event). For a root event the
   * backend includes the markets of its sub-events; with `subEventId` only that sub-event's.
   * (The route's `includeSubEvents` flag is not offered: it answers 400 "includeSubEvents is
   * not a boolean" to both `true` and `false`, so the backend's choice above is the only one.)
   */
  eventId?: string;
  /** With `eventId`: narrow to this sub-event. */
  subEventId?: string;
}

const ACTIVITY_FIELDS = {
  page: PAGE,
  search: field.str(),
  sortBy: field.oneOf(ACTIVITY_SORT_KEYS),
  sortOrder: SORT_ORDER,
  marketScope: SCOPE,
  positionType: field.oneOf(['BUY', 'SELL', 'REDEEM', 'all']),
  marketId: field.id(),
  dateFrom: field.dateTime(),
  dateTo: field.dateTime(),
  cpMin: finiteNumber,
  cpMax: finiteNumber,
};

export const USER_ACTIVITY_SPEC = {
  ...ACTIVITY_FIELDS,
  take: field.int(1, 1000),
} satisfies Record<keyof UserActivityParams, Field>;

export const USER_MARKET_ACTIVITY_SPEC = {
  ...ACTIVITY_FIELDS,
  take: field.int(1, 50),
  eventId: field.pattern(UUID_V4, 'a UUID'),
  subEventId: field.pattern(UUID_V4, 'a UUID'),
} satisfies Record<keyof UserMarketActivityParams, Field>;

/** `GET /users/me/activities`. */
export function userActivityQuery(input: unknown): Query {
  return withHoldingsScope(
    closedQuery('activity.mine', input, USER_ACTIVITY_SPEC, {
      skip: SKIP_HINT,
    }),
  );
}

/** `GET /users/me/market-activities`. */
export function userMarketActivityQuery(input: unknown): Query {
  return withHoldingsScope(
    closedQuery('activity.marketActivities', input, USER_MARKET_ACTIVITY_SPEC, {
      skip: SKIP_HINT,
      includeSubEvents:
        'the route answers 400 "includeSubEvents is not a boolean" to true and to false; a root eventId includes its sub-events, and subEventId narrows to one',
    }),
  );
}

// ---------------------------------------------------------------------------
// Path segments and targets
// ---------------------------------------------------------------------------

/** A position's database id, which the backend parses as an integer: a positive whole number or its digits. */
export function positionIdSegment(value: unknown, name = 'positionId'): string {
  return marketIdSegment(value, name);
}

const MAX_USERNAME = 100;

/**
 * A username, percent-encoded for the path. The backend documents 3 to 50 letters, digits,
 * underscores and hyphens but does not enforce it, so only what could not be a path segment
 * is refused: an empty or dot-only name, a control character, more than 100 characters.
 */
export function usernameSegment(value: unknown, name = 'username'): string {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.length > MAX_USERNAME ||
    value === '.' ||
    value === '..' ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new UserInputError(
      `${name} must be a non-empty string of at most ${MAX_USERNAME} characters without control characters`,
    );
  }
  return encodeURIComponent(value);
}

/** Who a public portfolio is about: a wallet address or a username (one of the two). */
export type PortfolioOwner = { wallet: string } | { username: string };

const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The `user` param of `GET /users/portfolio`, which takes a wallet address or a username. A
 * wallet is checksummed. A username that looks like an address is refused, because the
 * backend would take it for a wallet.
 */
export function publicTarget(target: unknown): { user: string } {
  if (typeof target !== 'object' || target === null || Array.isArray(target)) {
    throw new UserInputError(
      'portfolio.ofWallet: the first argument must be { wallet } or { username }',
    );
  }
  const record = target as Record<string, unknown>;
  const keys = Object.keys(record);
  const unknown = keys.filter((key) => key !== 'wallet' && key !== 'username');
  if (unknown.length > 0) {
    throw new UserInputError(
      `portfolio.ofWallet: unknown key "${(unknown[0] as string).slice(0, 40)}" (allowed: wallet, username)`,
    );
  }
  const wallet = record.wallet;
  const username = record.username;
  if ((wallet === undefined) === (username === undefined)) {
    throw new UserInputError(
      'portfolio.ofWallet: give exactly one of { wallet } and { username }',
    );
  }
  if (wallet !== undefined) {
    return { user: normalizeAddress(wallet as string, 'wallet') };
  }
  if (typeof username !== 'string' || username.trim() === '') {
    throw new UserInputError(
      'portfolio.ofWallet: username must be a non-empty string',
    );
  }
  if (ADDRESS_SHAPE.test(username)) {
    throw new UserInputError(
      'portfolio.ofWallet: this username looks like a wallet address, which the route would treat as one: pass it as { wallet }',
    );
  }
  if (username.length > MAX_USERNAME) {
    throw new UserInputError(
      `portfolio.ofWallet: username must be at most ${MAX_USERNAME} characters`,
    );
  }
  return { user: username };
}
