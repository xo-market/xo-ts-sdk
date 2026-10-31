import { z } from 'zod';
import type { ActionContext } from '../clients/context';
import {
  AuthRequiredError,
  makeErrorGuard,
  RateLimitError,
  RequestAbortedError,
  RequestRejectedError,
  SigningError,
  TimeoutError,
  TransportError,
  UnexpectedResponseError,
  UserInputError,
  XoError,
} from '../core/errors';
import { type Paginated, toPaginated } from '../core/paginated';
import {
  parseRequestOptions,
  type RequestOptions,
} from '../core/requestOptions';
import type { MarketStatusValue } from '../data/accountParams';
import { MAX_PAGE } from '../data/params';
import {
  type Activity,
  type ApiKey,
  type Balances,
  type MarketPnl,
  type PortfolioValue,
  type Position,
  type PositionPnl,
  type Profile,
  type TradingApprovalsState,
  toActivity,
  toApiKey,
  toBalances,
  toMarketPnl,
  toPortfolioValue,
  toPositionPnl,
  toPositions,
  toProfile,
  toTradingApprovalsState,
  toUserPnl,
  toUserStats,
  type UserPnl,
  type UserStats,
} from '../models/account';
import {
  fields,
  flatPages,
  noCursor,
  pageNumberOf,
  parseInput,
  secureOf,
  underCall,
} from './internal';

// The reads of an account: its positions, value, profit and loss, activity, statistics,
// profile, API keys, balances and approvals. A signed-in client reads its own account; the
// positions of any wallet can be read by anyone, from its address.

/**
 * The error union of the reads of an account: the request and options, a read that was
 * cancelled, timed out or refused, an answer that cannot be read, and, on a signed-in client,
 * the sign-in it makes when its API key is refused (`SigningError`) and `client_closed` once it
 * is closed.
 */
export type AccountReadError =
  | UserInputError
  | AuthRequiredError
  | SigningError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError
  | XoError;
/** The guard of {@link AccountReadError}. */
export const AccountReadError = makeErrorGuard(
  UserInputError,
  AuthRequiredError,
  SigningError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
  XoError,
);

// ---------------------------------------------------------------------------
// listPositions
// ---------------------------------------------------------------------------

/** What {@link PublicClient.listPositions} takes on a client without a wallet. */
export type ListPositionsRequest = {
  /** The wallet whose positions to list: `0x` and 40 hex digits. */
  user: string;
  /**
   * `true` lists only the positions the SDK can redeem now (`Position.redeemable`): their
   * market of the order book is resolved or voided, and the winnings are not claimed. `false`
   * lists only the others.
   */
  redeemable?: boolean;
  /** Only the positions of this market: its condition id, `0x` and 64 hex digits. */
  market?: string;
};

/**
 * What `listPositions` takes on a signed-in client: the same as {@link ListPositionsRequest},
 * and the wallet is the client's own when `user` is left out.
 */
export type SecureListPositionsRequest = {
  /** The wallet whose positions to list. Leave it out for the client's own wallet. */
  user?: string;
  /**
   * `true` lists only the positions the SDK can redeem now (`Position.redeemable`): their
   * market of the order book is resolved or voided, and the winnings are not claimed. `false`
   * lists only the others.
   */
  redeemable?: boolean;
  /** Only the positions of this market: its condition id, `0x` and 64 hex digits. */
  market?: string;
};

const PositionsSchema = z.strictObject({
  user: fields.address().optional(),
  redeemable: fields.bool().optional(),
  market: fields.conditionId().optional(),
});

/** The error union of {@link PublicClient.listPositions}. */
export type ListPositionsError = AccountReadError;
/** The guard of {@link ListPositionsError}. */
export const ListPositionsError = AccountReadError;

/** The market statuses whose positions pay out or refund once the market is settled. */
const SETTLED: MarketStatusValue[] = ['RESOLVED', 'VOIDED', 'VOIDED_CLOSED'];

/**
 * How many markets a page of the account's own portfolio reads. The public portfolio reads the
 * most it allows, since XO has been seen to answer its first page again for later pages.
 */
const OWN_PAGE_MARKETS = 100;
const PUBLIC_PAGE_MARKETS = 1000;

function positionsOf(
  ctx: ActionContext,
  input: z.output<typeof PositionsSchema>,
  options: RequestOptions | undefined,
): Paginated<Position> {
  const call = parseRequestOptions(options);
  const { user, redeemable } = input;
  const market = input.market?.toLowerCase();
  // Asking for the settled markets alone reads fewer pages; whether the winnings are claimed,
  // and whether the market is one the SDK redeems, is known per position only.
  const settled = redeemable === true ? { marketStatus: SETTLED } : {};
  const keep = (position: Position): boolean =>
    (redeemable === undefined || position.redeemable === redeemable) &&
    (market === undefined || position.conditionId === market);
  return flatPages(
    toPaginated(
      'positions',
      (cursor) => {
        const page = pageNumberOf(cursor);
        return user === undefined
          ? ctx.data.portfolio.mine(
              { ...settled, take: OWN_PAGE_MARKETS, page },
              call,
            )
          : ctx.data.portfolio.ofWallet(
              { wallet: user },
              { ...settled, take: PUBLIC_PAGE_MARKETS, page },
              call,
            );
      },
      (row) => toPositions(row).filter(keep),
      { maxPage: MAX_PAGE },
    ),
  );
}

/**
 * Lists the positions of a wallet, by its address.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export function listPositions(
  ctx: ActionContext,
  request: ListPositionsRequest,
  options?: RequestOptions,
): Paginated<Position> {
  const input = parseInput(
    'listPositions',
    request,
    PositionsSchema.required({ user: true }),
  );
  return positionsOf(ctx, input, options);
}

/**
 * Lists the positions of the client's own wallet, or of any wallet by its address.
 *
 * The public documentation is on the `SecureClient` member `listPositions`.
 */
export function secureListPositions(
  ctx: ActionContext,
  request?: SecureListPositionsRequest,
  options?: RequestOptions,
): Paginated<Position> {
  const input = parseInput('listPositions', request, PositionsSchema);
  ctx.secure?.assertOpen();
  return positionsOf(ctx, input, options);
}

// ---------------------------------------------------------------------------
// fetchPortfolioValue
// ---------------------------------------------------------------------------

/** The error union of {@link SecureClient.fetchPortfolioValue}. */
export type FetchPortfolioValueError = AccountReadError;
/** The guard of {@link FetchPortfolioValueError}. */
export const FetchPortfolioValueError = AccountReadError;

/**
 * Reads the account's cash, the value of its positions and its winnings to claim.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function fetchPortfolioValue(
  ctx: ActionContext,
  options?: RequestOptions,
): Promise<PortfolioValue> {
  const call = parseRequestOptions(options);
  ctx.secure?.assertOpen();
  return toPortfolioValue(await ctx.data.portfolio.value(undefined, call));
}

// ---------------------------------------------------------------------------
// fetchUserPnl
// ---------------------------------------------------------------------------

/** What {@link SecureClient.fetchUserPnl} takes for the whole account: nothing. */
export type FetchUserPnlRequest = {
  /** Not given: the whole account. */
  marketId?: undefined;
  /** Not given: the whole account. */
  positionId?: undefined;
};

/** What {@link SecureClient.fetchUserPnl} takes for one market. */
export type FetchMarketPnlRequest = {
  /** XO's id for the market: the `id` of a `Market`, or the `marketId` of a `Position`. */
  marketId: string;
  /** Not given with a market. */
  positionId?: undefined;
};

/** What {@link SecureClient.fetchUserPnl} takes for one position. */
export type FetchPositionPnlRequest = {
  /** XO's id for the position: the `positionId` of a `Position`. */
  positionId: string;
  /** Not given with a position. */
  marketId?: undefined;
};

const PnlSchema = z
  .strictObject({
    marketId: fields.id().optional(),
    positionId: fields.id().optional(),
  })
  .superRefine((value, check) => {
    if (value.marketId !== undefined && value.positionId !== undefined) {
      check.addIssue({
        code: 'custom',
        message: 'takes a marketId or a positionId, not both',
        input: value,
      });
    }
  });

/** The error union of {@link SecureClient.fetchUserPnl}. */
export type FetchUserPnlError = AccountReadError;
/** The guard of {@link FetchUserPnlError}. */
export const FetchUserPnlError = AccountReadError;

/**
 * Reads the profit and loss of the account, of one market or of one position.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function fetchUserPnl(
  ctx: ActionContext,
  request?: FetchUserPnlRequest,
  options?: RequestOptions,
): Promise<UserPnl>;
export async function fetchUserPnl(
  ctx: ActionContext,
  request: FetchMarketPnlRequest,
  options?: RequestOptions,
): Promise<MarketPnl>;
export async function fetchUserPnl(
  ctx: ActionContext,
  request: FetchPositionPnlRequest,
  options?: RequestOptions,
): Promise<PositionPnl>;
export async function fetchUserPnl(
  ctx: ActionContext,
  request?:
    | FetchUserPnlRequest
    | FetchMarketPnlRequest
    | FetchPositionPnlRequest,
  options?: RequestOptions,
): Promise<UserPnl | MarketPnl | PositionPnl> {
  const input = parseInput('fetchUserPnl', request, PnlSchema);
  const call = parseRequestOptions(options);
  ctx.secure?.assertOpen();
  if (input.marketId !== undefined) {
    return toMarketPnl(await ctx.data.pnl.market(input.marketId, call));
  }
  if (input.positionId !== undefined) {
    const { position } = await ctx.data.pnl.position(input.positionId, call);
    return toPositionPnl(position);
  }
  return toUserPnl(await ctx.data.pnl.summary(undefined, call));
}

// ---------------------------------------------------------------------------
// listActivity
// ---------------------------------------------------------------------------

const ACTIVITY_TYPES = [
  'TRADE',
  'REDEEM',
  'SPLIT',
  'MERGE',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'REFUND',
  'CREATOR_UNLOCK',
] as const;

/** What {@link SecureClient.listActivity} takes. Every key is optional. */
export type ListActivityRequest = {
  /** Only the activity of this market: XO's id for it, the `id` of a `Market`. */
  marketId?: string;
  /** Only rows of this kind, such as `TRADE` (buys and sells) or `REDEEM`. */
  type?: (typeof ACTIVITY_TYPES)[number];
  /** How many rows XO reads for a page, from 1 to 50. */
  pageSize?: number;
};

const ListActivitySchema = z.strictObject({
  marketId: fields.id().optional(),
  type: fields.oneOf(ACTIVITY_TYPES).optional(),
  pageSize: fields.whole(1, 50).optional(),
});

/** The error union of {@link SecureClient.listActivity}. */
export type ListActivityError = AccountReadError;
/** The guard of {@link ListActivityError}. */
export const ListActivityError = AccountReadError;

/**
 * Lists the account's activity, newest first: its trades, redemptions, splits, merges and
 * transfers.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export function listActivity(
  ctx: ActionContext,
  request?: ListActivityRequest,
  options?: RequestOptions,
): Paginated<Activity> {
  const input = parseInput('listActivity', request, ListActivitySchema);
  const call = parseRequestOptions(options);
  ctx.secure?.assertOpen();
  const { type } = input;
  const filters = {
    ...(input.marketId === undefined
      ? {}
      : { marketId: Number(input.marketId) }),
    // XO filters redemptions itself; every other kind is kept here.
    ...(type === 'REDEEM' ? { positionType: 'REDEEM' as const } : {}),
    ...(input.pageSize === undefined ? {} : { take: input.pageSize }),
  };
  return toPaginated(
    'activity',
    (cursor) =>
      ctx.data.activity.marketActivities(
        { ...filters, page: pageNumberOf(cursor) },
        call,
      ),
    (row) => {
      const activity = toActivity(row);
      return type === undefined || activity.type === type
        ? activity
        : undefined;
    },
    { maxPage: MAX_PAGE },
  );
}

// ---------------------------------------------------------------------------
// fetchUserStats (the signed-in variant)
// ---------------------------------------------------------------------------

/**
 * What `fetchUserStats` takes on a signed-in client: a user's `username`, or nothing for the
 * client's own account.
 */
export type SecureFetchUserStatsRequest = {
  /** The user's unique name on XO. Leave it out for the client's own account. */
  username?: string;
};

const UserStatsSchema = z.strictObject({
  username: fields.username().optional(),
});

/**
 * Reads the trading statistics of the client's own account, or of any user by username.
 *
 * The public documentation is on the `SecureClient` member `fetchUserStats`.
 */
export async function secureFetchUserStats(
  ctx: ActionContext,
  request?: SecureFetchUserStatsRequest,
  options?: RequestOptions,
): Promise<UserStats> {
  const input = parseInput('fetchUserStats', request, UserStatsSchema);
  const call = parseRequestOptions(options);
  ctx.secure?.assertOpen();
  return toUserStats(
    input.username === undefined
      ? await ctx.data.activity.stats(call)
      : await ctx.data.profiles.stats(input.username, call),
  );
}

// ---------------------------------------------------------------------------
// fetchProfile
// ---------------------------------------------------------------------------

/** The error union of {@link SecureClient.fetchProfile}. */
export type FetchProfileError = AccountReadError;
/** The guard of {@link FetchProfileError}. */
export const FetchProfileError = AccountReadError;

/**
 * Reads the account's own profile.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function fetchProfile(
  ctx: ActionContext,
  options?: RequestOptions,
): Promise<Profile> {
  const call = parseRequestOptions(options);
  ctx.secure?.assertOpen();
  return toProfile(await ctx.data.account.me(call));
}

// ---------------------------------------------------------------------------
// listApiKeys
// ---------------------------------------------------------------------------

/** The error union of {@link SecureClient.listApiKeys}. */
export type ListApiKeysError = AccountReadError;
/** The guard of {@link ListApiKeysError}. */
export const ListApiKeysError = AccountReadError;

/**
 * Lists the account's API keys.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export function listApiKeys(
  ctx: ActionContext,
  options?: RequestOptions,
): Paginated<ApiKey> {
  const call = parseRequestOptions(options);
  ctx.secure?.assertOpen();
  return toPaginated(
    'apiKeys',
    (cursor) => {
      noCursor(cursor);
      return ctx.data.account.apiKeys(call);
    },
    toApiKey,
  );
}

// ---------------------------------------------------------------------------
// fetchBalances
// ---------------------------------------------------------------------------

/** The error union of {@link SecureClient.fetchBalances}. */
export type FetchBalancesError = AccountReadError;
/** The guard of {@link FetchBalancesError}. */
export const FetchBalancesError = AccountReadError;

/**
 * Reads what the order book holds for the account: its cash credit and its outcome shares.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function fetchBalances(
  ctx: ActionContext,
  options?: RequestOptions,
): Promise<Balances> {
  const call = parseRequestOptions(options);
  ctx.secure?.assertOpen();
  return toBalances(await ctx.orderbook.getPositions(call));
}

// ---------------------------------------------------------------------------
// fetchTradingApprovalsState
// ---------------------------------------------------------------------------

/** The error union of {@link SecureClient.fetchTradingApprovalsState}. */
export type FetchTradingApprovalsStateError = AccountReadError;
/** The guard of {@link FetchTradingApprovalsStateError}. */
export const FetchTradingApprovalsStateError = AccountReadError;

/**
 * Reads on chain what the account has set up for trading.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function fetchTradingApprovalsState(
  ctx: ActionContext,
  options?: RequestOptions,
): Promise<TradingApprovalsState> {
  const call = parseRequestOptions(options);
  const secure = secureOf(ctx, 'fetchTradingApprovalsState');
  secure.assertOpen();
  // The state is what setting the account up would still send: the same reads, and nothing
  // sent. The market manager's approval is not one trading needs, so it is not read.
  const missing = await underCall(call, () => secure.account.setupPlan());
  return toTradingApprovalsState(missing, false);
}
