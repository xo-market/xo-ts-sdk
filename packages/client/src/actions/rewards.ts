import { z } from 'zod';
import type { ActionContext } from '../clients/context';
import {
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
import { MAX_PAGE } from '../data/params';
import { MAX_EPOCH, MS_PER_DAY } from '../data/rewardsParams';
import {
  type MarketRewardsDetails,
  type MarketRewardsEpoch,
  type RewardGroup,
  type RewardPool,
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
} from '../models/rewards';
import { fields, noCursor, pageNumberOf, parseInput } from './internal';

// The liquidity-rewards actions. XO pays market makers for resting orders that stay close to
// the midpoint of a market, in conviction points (`CP`) and in `USDC`, per UTC day. A day is
// numbered by its epoch: the whole days since 1970-01-01. The public reads send no credentials:
// a wallet's rewards can be read by anyone who knows its address. A signed-in client reads its
// own wallet's rewards by default, with its key, and the leaderboard, which XO shows to
// signed-in accounts only.

/** The epoch (UTC-day index) of the server's clock now. */
function todayEpoch(ctx: ActionContext): number {
  return Math.floor((ctx.clock.nowSec() * 1000) / MS_PER_DAY);
}

const EPOCH = () => fields.whole(0, MAX_EPOCH);
const CURRENCIES = ['CP', 'USDC'] as const;

// ---------------------------------------------------------------------------
// listRewardPools
// ---------------------------------------------------------------------------

/** The error union of {@link PublicClient.listRewardPools}. */
export type ListRewardPoolsError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link ListRewardPoolsError}. */
export const ListRewardPoolsError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Lists the markets that pay liquidity rewards, each with its programme per currency: how much
 * is paid a day, the terms for scoring orders, the budget and the bonus windows. All of them
 * come on one page, with the biggest daily pool first.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export function listRewardPools(
  ctx: ActionContext,
  options?: RequestOptions,
): Paginated<RewardPool> {
  const call = parseRequestOptions(options);
  return toPaginated(
    'rewardPools',
    (cursor) => {
      noCursor(cursor);
      return ctx.data.rewards.earningPools(call);
    },
    toRewardPool,
  );
}

// ---------------------------------------------------------------------------
// listRewardGroups
// ---------------------------------------------------------------------------

/** What {@link PublicClient.listRewardGroups} takes. Every key is optional. */
export type ListRewardGroupsRequest = {
  /** Only the groups that pay in this currency. */
  currency?: 'CP' | 'USDC';
  /** Also list the groups that are not paying now. */
  includeInactive?: boolean;
  /** How many groups a page holds, from 1 to 100. */
  pageSize?: number;
};

const ListRewardGroupsSchema = z.strictObject({
  currency: fields.oneOf(CURRENCIES).optional(),
  includeInactive: fields.bool().optional(),
  pageSize: fields.whole(1, 100).optional(),
});

/** The error union of {@link PublicClient.listRewardGroups}. */
export type ListRewardGroupsError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link ListRewardGroupsError}. */
export const ListRewardGroupsError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Lists the Pulse groups, a page at a time. A group is one shared reward pool for all the short
 * rounds of a product, such as one pot for every five-minute window of a price market. A group
 * in a list has only what the list carries: `day`, `totalScoredLiquidity` and `lifetime` are
 * `null` (see {@link PublicClient.fetchRewardGroup}, which fills them).
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export function listRewardGroups(
  ctx: ActionContext,
  request?: ListRewardGroupsRequest,
  options?: RequestOptions,
): Paginated<RewardGroup> {
  const input: ListRewardGroupsRequest = parseInput(
    'listRewardGroups',
    request,
    ListRewardGroupsSchema,
  );
  const call = parseRequestOptions(options);
  const filters = {
    ...(input.currency === undefined ? {} : { currency: input.currency }),
    ...(input.includeInactive === undefined
      ? {}
      : { include_zero: input.includeInactive }),
    ...(input.pageSize === undefined ? {} : { page_size: input.pageSize }),
  };
  return toPaginated(
    'rewardGroups',
    (cursor) =>
      ctx.data.rewards.groups(
        // The first page is page 0 of the source: the cursor of a later page is its number.
        cursor === undefined
          ? filters
          : { ...filters, page: pageNumberOf(cursor) },
        call,
      ),
    toRewardGroup,
  );
}

// ---------------------------------------------------------------------------
// fetchRewardGroup
// ---------------------------------------------------------------------------

/** What {@link PublicClient.fetchRewardGroup} takes. */
export type FetchRewardGroupRequest = {
  /** The group's id (`RewardGroup.groupId`): `0x` and 64 hex digits. */
  groupId: string;
};

const FetchRewardGroupSchema = z.strictObject({ groupId: fields.groupId() });

/** The error union of {@link PublicClient.fetchRewardGroup}. */
export type FetchRewardGroupError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link FetchRewardGroupError}. */
export const FetchRewardGroupError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Reads one Pulse group in full: its programmes, the day in progress, the liquidity scored so
 * far and what it paid over its life.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export async function fetchRewardGroup(
  ctx: ActionContext,
  request: FetchRewardGroupRequest,
  options?: RequestOptions,
): Promise<RewardGroup> {
  const input = parseInput('fetchRewardGroup', request, FetchRewardGroupSchema);
  const call = parseRequestOptions(options);
  return toRewardGroup(await ctx.data.rewards.group(input.groupId, call));
}

// ---------------------------------------------------------------------------
// fetchMarketRewards
// ---------------------------------------------------------------------------

/** What {@link PublicClient.fetchMarketRewards} takes. */
export type FetchMarketRewardsRequest = {
  /** The market's id on the order book, `0x` and 64 hex digits. */
  conditionId: string;
};

const MarketSchema = z.strictObject({ conditionId: fields.conditionId() });

/** The error union of {@link PublicClient.fetchMarketRewards}. */
export type FetchMarketRewardsError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link FetchMarketRewardsError}. */
export const FetchMarketRewardsError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Reads the rewards of one market: its programme per currency, the bonus windows, the day in
 * progress and what the market has paid over its life.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export async function fetchMarketRewards(
  ctx: ActionContext,
  request: FetchMarketRewardsRequest,
  options?: RequestOptions,
): Promise<MarketRewardsDetails> {
  const input = parseInput('fetchMarketRewards', request, MarketSchema);
  const call = parseRequestOptions(options);
  return toMarketRewardsDetails(
    await ctx.data.rewards.market(input.conditionId, call),
  );
}

// ---------------------------------------------------------------------------
// fetchMarketRewardsEpoch
// ---------------------------------------------------------------------------

/** What {@link PublicClient.fetchMarketRewardsEpoch} takes. */
export type FetchMarketRewardsEpochRequest = {
  /** The market's id on the order book, `0x` and 64 hex digits. */
  conditionId: string;
  /**
   * The UTC day: whole days since 1970-01-01, from 0 to 10,000,000. Defaults to today, the day
   * in progress, whose figures are a live projection.
   */
  epoch?: number;
};

const MarketEpochSchema = z.strictObject({
  conditionId: fields.conditionId(),
  epoch: EPOCH().optional(),
});

/** The error union of {@link PublicClient.fetchMarketRewardsEpoch}. */
export type FetchMarketRewardsEpochError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link FetchMarketRewardsEpochError}. */
export const FetchMarketRewardsEpochError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Reads one UTC day of a market's rewards: for each currency the pot, the total score, how many
 * makers scored, what was allocated and paid, and the makers with the highest scores. A market
 * with no rewards programme reads as an empty day, not as a 404.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export async function fetchMarketRewardsEpoch(
  ctx: ActionContext,
  request: FetchMarketRewardsEpochRequest,
  options?: RequestOptions,
): Promise<MarketRewardsEpoch> {
  const input = parseInput(
    'fetchMarketRewardsEpoch',
    request,
    MarketEpochSchema,
  );
  const call = parseRequestOptions(options);
  return toMarketRewardsEpoch(
    await ctx.data.rewards.marketEpoch(
      input.conditionId,
      input.epoch ?? todayEpoch(ctx),
      call,
    ),
  );
}

// ---------------------------------------------------------------------------
// listMarketRewardsMakers
// ---------------------------------------------------------------------------

/** What {@link PublicClient.listMarketRewardsMakers} takes. */
export type ListMarketRewardsMakersRequest = {
  /** The market's id on the order book, `0x` and 64 hex digits. */
  conditionId: string;
  /**
   * The UTC day: whole days since 1970-01-01, from 0 to 10,000,000. Defaults to today when the
   * list is made. To resume a walk on another day, pass the `epoch` it started with.
   */
  epoch?: number;
  /** How many makers a page holds, from 1 to 1000. */
  pageSize?: number;
};

const MarketMakersSchema = z.strictObject({
  conditionId: fields.conditionId(),
  epoch: EPOCH().optional(),
  pageSize: fields.whole(1, 1000).optional(),
});

/** The error union of {@link PublicClient.listMarketRewardsMakers}. */
export type ListMarketRewardsMakersError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link ListMarketRewardsMakersError}. */
export const ListMarketRewardsMakersError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Lists the makers who scored on one UTC day of a market, a page at a time, with each maker's
 * score, share of the pot and payout. The list is the conviction-points programme's.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export function listMarketRewardsMakers(
  ctx: ActionContext,
  request: ListMarketRewardsMakersRequest,
  options?: RequestOptions,
): Paginated<RewardsMaker> {
  const input = parseInput(
    'listMarketRewardsMakers',
    request,
    MarketMakersSchema,
  );
  const call = parseRequestOptions(options);
  const epoch = input.epoch ?? todayEpoch(ctx);
  const filters =
    input.pageSize === undefined ? {} : { page_size: input.pageSize };
  return toPaginated(
    'marketRewardsMakers',
    (cursor) =>
      ctx.data.rewards.marketEpochMakers(
        input.conditionId,
        epoch,
        cursor === undefined
          ? filters
          : { ...filters, page: pageNumberOf(cursor) },
        call,
      ),
    toRewardsMaker,
  );
}

// ---------------------------------------------------------------------------
// listMarketRewardsOrders
// ---------------------------------------------------------------------------

/** What {@link PublicClient.listMarketRewardsOrders} takes. */
export type ListMarketRewardsOrdersRequest = {
  /** The market's id on the order book, `0x` and 64 hex digits. */
  conditionId: string;
  /**
   * The UTC day: whole days since 1970-01-01, from 0 to 10,000,000. Defaults to today when the
   * list is made. To resume a walk on another day, pass the `epoch` it started with.
   */
  epoch?: number;
  /** Only the orders of this wallet. */
  maker?: string;
  /** How many orders a page holds, from 1 to 1000. */
  pageSize?: number;
};

const MarketOrdersSchema = z.strictObject({
  conditionId: fields.conditionId(),
  epoch: EPOCH().optional(),
  maker: fields.address().optional(),
  pageSize: fields.whole(1, 1000).optional(),
});

/** The error union of {@link PublicClient.listMarketRewardsOrders}. */
export type ListMarketRewardsOrdersError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link ListMarketRewardsOrdersError}. */
export const ListMarketRewardsOrdersError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Lists the orders that scored on one UTC day of a market, a page at a time, each with its
 * maker, price, score and payout.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export function listMarketRewardsOrders(
  ctx: ActionContext,
  request: ListMarketRewardsOrdersRequest,
  options?: RequestOptions,
): Paginated<RewardsOrder> {
  const input = parseInput(
    'listMarketRewardsOrders',
    request,
    MarketOrdersSchema,
  );
  const call = parseRequestOptions(options);
  const epoch = input.epoch ?? todayEpoch(ctx);
  const filters = {
    ...(input.maker === undefined ? {} : { maker: input.maker }),
    ...(input.pageSize === undefined ? {} : { page_size: input.pageSize }),
  };
  return toPaginated(
    'marketRewardsOrders',
    (cursor) =>
      ctx.data.rewards.marketEpochOrders(
        input.conditionId,
        epoch,
        cursor === undefined
          ? filters
          : { ...filters, page: pageNumberOf(cursor) },
        call,
      ),
    toMarketRewardsOrder,
  );
}

// ---------------------------------------------------------------------------
// fetchUserRewards
// ---------------------------------------------------------------------------

/** What {@link PublicClient.fetchUserRewards} takes. */
export type FetchUserRewardsRequest = {
  /** The wallet whose rewards to read: `0x` and 40 hex digits. */
  user: string;
};

const UserSchema = z.strictObject({ user: fields.address() });

/**
 * The error union of {@link PublicClient.fetchUserRewards}. On a signed-in client that reads its own
 * wallet, also the sign-in it makes when its API key is refused (`SigningError`) and
 * `client_closed` once it is closed.
 */
export type FetchUserRewardsError =
  | UserInputError
  | SigningError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError
  | XoError;
/** The guard of {@link FetchUserRewardsError}. */
export const FetchUserRewardsError = makeErrorGuard(
  UserInputError,
  SigningError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
  XoError,
);

/**
 * Reads what a wallet has earned from liquidity rewards: in each currency the total received,
 * what came from liquidity and what is accruing on the open day. A wallet that has earned
 * nothing reads zeros. Every figure is rounded to two decimals.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export async function fetchUserRewards(
  ctx: ActionContext,
  request: FetchUserRewardsRequest,
  options?: RequestOptions,
): Promise<UserRewards> {
  const input = parseInput('fetchUserRewards', request, UserSchema);
  const call = parseRequestOptions(options);
  return toUserRewards(await ctx.data.rewards.wallet(input.user, call));
}

// ---------------------------------------------------------------------------
// fetchUserRewardsEpoch
// ---------------------------------------------------------------------------

/** What {@link PublicClient.fetchUserRewardsEpoch} takes. */
export type FetchUserRewardsEpochRequest = {
  /** The wallet whose rewards to read: `0x` and 40 hex digits. */
  user: string;
  /**
   * The UTC day: whole days since 1970-01-01, from 0 to 10,000,000. Defaults to today, the day
   * in progress, whose figures are a live projection.
   */
  epoch?: number;
};

const UserEpochSchema = z.strictObject({
  user: fields.address(),
  epoch: EPOCH().optional(),
});

/**
 * The error union of {@link PublicClient.fetchUserRewardsEpoch}. On a signed-in client that reads its own
 * wallet, also the sign-in it makes when its API key is refused (`SigningError`) and
 * `client_closed` once it is closed.
 */
export type FetchUserRewardsEpochError =
  | UserInputError
  | SigningError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError
  | XoError;
/** The guard of {@link FetchUserRewardsEpochError}. */
export const FetchUserRewardsEpochError = makeErrorGuard(
  UserInputError,
  SigningError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
  XoError,
);

/**
 * Reads one UTC day of a wallet's rewards across every market it made liquidity in: for each
 * market the score, the share of the pot and the payout.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export async function fetchUserRewardsEpoch(
  ctx: ActionContext,
  request: FetchUserRewardsEpochRequest,
  options?: RequestOptions,
): Promise<UserRewardsEpoch> {
  const input = parseInput('fetchUserRewardsEpoch', request, UserEpochSchema);
  const call = parseRequestOptions(options);
  return toUserRewardsEpoch(
    await ctx.data.rewards.walletEpoch(
      input.user,
      input.epoch ?? todayEpoch(ctx),
      call,
    ),
  );
}

// ---------------------------------------------------------------------------
// listUserRewardsOrders
// ---------------------------------------------------------------------------

/** What {@link PublicClient.listUserRewardsOrders} takes. */
export type ListUserRewardsOrdersRequest = {
  /** The wallet whose orders to list: `0x` and 40 hex digits. */
  user: string;
  /** Only the orders of this market: its id on the order book, `0x` and 64 hex digits. */
  conditionId?: string;
  /**
   * The UTC day: whole days since 1970-01-01, from 0 to 10,000,000. Without it the day in
   * progress is listed.
   */
  epoch?: number;
  /**
   * Whether the day in progress also lists the resting orders that have not been scored yet.
   * `false` lists the scored orders alone. On by default.
   */
  live?: boolean;
  /** How many orders a page holds, from 1 to 1000. */
  pageSize?: number;
};

const UserOrdersSchema = z.strictObject({
  user: fields.address(),
  conditionId: fields.conditionId().optional(),
  epoch: EPOCH().optional(),
  live: fields.bool().optional(),
  pageSize: fields.whole(1, 1000).optional(),
});

/**
 * The error union of {@link PublicClient.listUserRewardsOrders}. On a signed-in client that reads its own
 * wallet, also the sign-in it makes when its API key is refused (`SigningError`) and
 * `client_closed` once it is closed.
 */
export type ListUserRewardsOrdersError =
  | UserInputError
  | SigningError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError
  | XoError;
/** The guard of {@link ListUserRewardsOrdersError}. */
export const ListUserRewardsOrdersError = makeErrorGuard(
  UserInputError,
  SigningError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
  XoError,
);

/**
 * Lists the orders of a wallet that were scored for rewards, a page at a time, each with its
 * market, price, score, how it ended and what it paid per currency.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export function listUserRewardsOrders(
  ctx: ActionContext,
  request: ListUserRewardsOrdersRequest,
  options?: RequestOptions,
): Paginated<RewardsOrder> {
  const input = parseInput('listUserRewardsOrders', request, UserOrdersSchema);
  const call = parseRequestOptions(options);
  const filters = {
    ...(input.conditionId === undefined
      ? {}
      : { market_id: input.conditionId }),
    ...(input.epoch === undefined ? {} : { epoch: input.epoch }),
    ...(input.live === undefined ? {} : { live: input.live }),
    ...(input.pageSize === undefined ? {} : { page_size: input.pageSize }),
  };
  return toPaginated(
    'userRewardsOrders',
    (cursor) =>
      ctx.data.rewards.walletOrders(
        input.user,
        cursor === undefined
          ? filters
          : { ...filters, page: pageNumberOf(cursor) },
        call,
      ),
    toUserRewardsOrder,
  );
}

// ---------------------------------------------------------------------------
// The reads of a signed-in client: its own wallet by default
// ---------------------------------------------------------------------------

/** What `fetchUserRewards` takes on a signed-in client: a wallet, or none for its own. */
export type SecureFetchUserRewardsRequest = {
  /** The wallet whose rewards to read. Leave it out for the client's own wallet. */
  user?: string;
};

const OwnUserSchema = z.strictObject({ user: fields.address().optional() });

/**
 * Reads what the client's own wallet, or any wallet, has earned from liquidity rewards.
 *
 * The public documentation is on the `SecureClient` member `fetchUserRewards`.
 */
export async function secureFetchUserRewards(
  ctx: ActionContext,
  request?: SecureFetchUserRewardsRequest,
  options?: RequestOptions,
): Promise<UserRewards> {
  const input = parseInput('fetchUserRewards', request, OwnUserSchema);
  const call = parseRequestOptions(options);
  ctx.secure?.assertOpen();
  return toUserRewards(
    input.user === undefined
      ? await ctx.data.rewards.mySummary(call)
      : await ctx.data.rewards.wallet(input.user, call),
  );
}

/** What `fetchUserRewardsEpoch` takes on a signed-in client: a wallet, or none for its own. */
export type SecureFetchUserRewardsEpochRequest = {
  /** The wallet whose rewards to read. Leave it out for the client's own wallet. */
  user?: string;
  /**
   * The UTC day: whole days since 1970-01-01, from 0 to 10,000,000. Defaults to today, the day
   * in progress, whose figures are a live projection.
   */
  epoch?: number;
};

const OwnUserEpochSchema = z.strictObject({
  user: fields.address().optional(),
  epoch: EPOCH().optional(),
});

/**
 * Reads one UTC day of the rewards of the client's own wallet, or of any wallet.
 *
 * The public documentation is on the `SecureClient` member `fetchUserRewardsEpoch`.
 */
export async function secureFetchUserRewardsEpoch(
  ctx: ActionContext,
  request?: SecureFetchUserRewardsEpochRequest,
  options?: RequestOptions,
): Promise<UserRewardsEpoch> {
  const input = parseInput(
    'fetchUserRewardsEpoch',
    request,
    OwnUserEpochSchema,
  );
  const call = parseRequestOptions(options);
  ctx.secure?.assertOpen();
  const epoch = input.epoch ?? todayEpoch(ctx);
  return toUserRewardsEpoch(
    input.user === undefined
      ? await ctx.data.rewards.myEpoch(epoch, call)
      : await ctx.data.rewards.walletEpoch(input.user, epoch, call),
  );
}

/** What `listUserRewardsOrders` takes on a signed-in client: a wallet, or none for its own. */
export type SecureListUserRewardsOrdersRequest = {
  /** The wallet whose orders to list. Leave it out for the client's own wallet. */
  user?: string;
  /** Only the orders of this market: its id on the order book, `0x` and 64 hex digits. */
  conditionId?: string;
  /**
   * The UTC day: whole days since 1970-01-01, from 0 to 10,000,000. Without it the day in
   * progress is listed.
   */
  epoch?: number;
  /**
   * Whether the day in progress also lists the resting orders that have not been scored yet.
   * `false` lists the scored orders alone. On by default.
   */
  live?: boolean;
  /** How many orders a page holds, from 1 to 1000. */
  pageSize?: number;
};

const OwnUserOrdersSchema = z.strictObject({
  user: fields.address().optional(),
  conditionId: fields.conditionId().optional(),
  epoch: EPOCH().optional(),
  live: fields.bool().optional(),
  pageSize: fields.whole(1, 1000).optional(),
});

/**
 * Lists the scored orders of the client's own wallet, or of any wallet.
 *
 * The public documentation is on the `SecureClient` member `listUserRewardsOrders`.
 */
export function secureListUserRewardsOrders(
  ctx: ActionContext,
  request?: SecureListUserRewardsOrdersRequest,
  options?: RequestOptions,
): Paginated<RewardsOrder> {
  const input = parseInput(
    'listUserRewardsOrders',
    request,
    OwnUserOrdersSchema,
  );
  const call = parseRequestOptions(options);
  ctx.secure?.assertOpen();
  const filters = {
    ...(input.conditionId === undefined
      ? {}
      : { market_id: input.conditionId }),
    ...(input.epoch === undefined ? {} : { epoch: input.epoch }),
    ...(input.live === undefined ? {} : { live: input.live }),
    ...(input.pageSize === undefined ? {} : { page_size: input.pageSize }),
  };
  const { user } = input;
  return toPaginated(
    'userRewardsOrders',
    (cursor) => {
      const params =
        cursor === undefined
          ? filters
          : { ...filters, page: pageNumberOf(cursor) };
      return user === undefined
        ? ctx.data.rewards.myOrders(params, call)
        : ctx.data.rewards.walletOrders(user, params, call);
    },
    toUserRewardsOrder,
  );
}

// ---------------------------------------------------------------------------
// The leaderboard (signed-in clients)
// ---------------------------------------------------------------------------

const PERIODS = ['daily', 'weekly', 'seasonal'] as const;

/** What {@link SecureClient.listRewardsLeaderboard} takes. Every key is optional. */
export type ListRewardsLeaderboardRequest = {
  /** The window: the day, the last 7 days or the season. Defaults to `weekly`. */
  period?: 'daily' | 'weekly' | 'seasonal';
  /** How many makers a page holds, from 1 to 1000. */
  pageSize?: number;
};

const LeaderboardSchema = z.strictObject({
  period: fields.oneOf(PERIODS).optional(),
  pageSize: fields.whole(1, 1000).optional(),
});

/**
 * The error union of {@link SecureClient.listRewardsLeaderboard}: those of a read, and the sign-in the client
 * makes when its API key is refused.
 */
export type ListRewardsLeaderboardError = FetchUserRewardsError;
/** The guard of {@link ListRewardsLeaderboardError}. */
export const ListRewardsLeaderboardError = FetchUserRewardsError;

/**
 * Lists the makers by the liquidity rewards they earned in a period, best first.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export function listRewardsLeaderboard(
  ctx: ActionContext,
  request?: ListRewardsLeaderboardRequest,
  options?: RequestOptions,
): Paginated<RewardsLeaderboardEntry> {
  const input = parseInput(
    'listRewardsLeaderboard',
    request,
    LeaderboardSchema,
  );
  const call = parseRequestOptions(options);
  ctx.secure?.assertOpen();
  const filters = {
    ...(input.period === undefined ? {} : { period: input.period }),
    ...(input.pageSize === undefined ? {} : { take: input.pageSize }),
  };
  return toPaginated(
    'rewardsLeaderboard',
    (cursor) =>
      ctx.data.rewards.leaderboard(
        { ...filters, page: pageNumberOf(cursor) },
        call,
      ),
    toRewardsLeaderboardEntry,
    { maxPage: MAX_PAGE },
  );
}

/** What {@link SecureClient.fetchRewardsLeaderboardStanding} takes. Every key is optional. */
export type FetchRewardsLeaderboardStandingRequest = {
  /** The window: the day, the last 7 days or the season. Defaults to `weekly`. */
  period?: 'daily' | 'weekly' | 'seasonal';
};

const StandingSchema = z.strictObject({
  period: fields.oneOf(PERIODS).optional(),
});

/**
 * The error union of {@link SecureClient.fetchRewardsLeaderboardStanding}: those of a read (a 404 when the
 * account is not ranked in the period), and the sign-in the client makes when its API key is
 * refused.
 */
export type FetchRewardsLeaderboardStandingError = FetchUserRewardsError;
/** The guard of {@link FetchRewardsLeaderboardStandingError}. */
export const FetchRewardsLeaderboardStandingError = FetchUserRewardsError;

/**
 * Reads where the client's own wallet stands on the leaderboard.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function fetchRewardsLeaderboardStanding(
  ctx: ActionContext,
  request?: FetchRewardsLeaderboardStandingRequest,
  options?: RequestOptions,
): Promise<RewardsLeaderboardStanding> {
  const input = parseInput(
    'fetchRewardsLeaderboardStanding',
    request,
    StandingSchema,
  );
  const call = parseRequestOptions(options);
  ctx.secure?.assertOpen();
  return toRewardsLeaderboardStanding(
    await ctx.data.rewards.myRank(
      input.period === undefined ? {} : { period: input.period },
      call,
    ),
  );
}
