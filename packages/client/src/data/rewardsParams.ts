// Internal: the closed query objects and path-segment checks of the liquidity-rewards routes.
// The framework (`closedQuery`, `field`) is in `params.ts`; the checks here mirror the
// validation rules of the backend and what the rewards service, which the backend proxies,
// refuses.
//
// **The names are the backend's own.** The liquidity-rewards routes are snake_case on the wire
// (`page_size`, `market_id`, `include_zero`), and so are most of their answers, so the params
// keep those names: a `market_id` you filter by is the `market_id` you read back. The leaderboard
// is the exception, as it is on the backend: `page` and `take`, 1-based.
//
// **Paging is 0-based** on every route here but the leaderboard: `page` is 0 to 1,000,000, and
// `page_size` is 1 to 1,000 (1 to 100 on the group routes).

import { normalizeAddress } from '../core/address';
import { UserInputError } from '../core/errors';
import { normalizeConditionId } from '../core/ids';
import {
  closedQuery,
  type Field,
  field,
  MAX_REWARDS_PAGE,
  type Query,
} from './params';

/** A UTC day is an epoch: `floor(ms / 86_400_000)`, as the rewards service and the backend count it. */
export const MS_PER_DAY = 86_400_000;
/**
 * The last epoch the backend takes, 10,000,000, and the rewards service answers a 400
 * `epoch must be in 0..=10000000` for anything beyond it (also on the public routes, where the
 * backend only checks that the path param is an integer). That is the year 29,000.
 */
export const MAX_EPOCH = 10_000_000;
export const REWARD_CURRENCIES = ['CP', 'USDC'] as const;
/** A reward rail: conviction points or USDC. */
export type RewardCurrency = (typeof REWARD_CURRENCIES)[number];

export const LEADERBOARD_PERIODS = ['daily', 'weekly', 'seasonal'] as const;
/** The period of a rewards leaderboard. */
export type RewardsLeaderboardPeriod = (typeof LEADERBOARD_PERIODS)[number];

// ---------------------------------------------------------------------------
// Path segments
// ---------------------------------------------------------------------------

const EPOCH = field.int(0, MAX_EPOCH);

/**
 * An epoch for a path: a whole number from 0 to {@link MAX_EPOCH}. A numeric string is
 * refused, like every integer of the data client's params.
 */
export function epochSegment(value: unknown, name = 'epoch'): string {
  return String(EPOCH(value, name));
}

/**
 * The epoch (UTC-day index) of an instant: `Math.floor(ms / 86_400_000)`, which is how the
 * backend computes the current epoch and how the rewards service numbers its days. The result
 * is always one that {@link epochSegment} accepts.
 *
 * @throws {UserInputError} For something that is not a valid `Date`, or an instant whose day
 *   is before 1970-01-01 or after epoch 10,000,000.
 */
export function epochOf(now: unknown): number {
  if (
    Object.prototype.toString.call(now) !== '[object Date]' ||
    Number.isNaN((now as Date).getTime())
  ) {
    throw new UserInputError('now must be a valid Date');
  }
  const epoch = Math.floor((now as Date).getTime() / MS_PER_DAY);
  if (epoch < 0 || epoch > MAX_EPOCH) {
    throw new UserInputError(
      `now must be a date whose UTC day is an epoch from 0 (1970-01-01) to ${MAX_EPOCH}`,
    );
  }
  return epoch;
}

/**
 * A market of the rewards ledger: its **condition id**, `0x` and 64 hex digits, sent in lower
 * case. The backend names the path param `:marketId`, but what it takes is the CLOB condition
 * id that the rewards service keys on, not the market's numeric database id (the backend
 * answers 404 `No liquidity reward config exists for market 69781`). The rewards service
 * matches the id case-sensitively in lower case (the same id in upper case is a 404), so the id is
 * lower-cased here, as `normalizeConditionId` does. The backend itself only checks that the param
 * is a string; the SDK holds it to what the ledger keys on, which is a 32-byte id for every CLOB
 * market.
 */
export function conditionIdSegment(
  value: unknown,
  name = 'conditionId',
): string {
  try {
    return normalizeConditionId(value, name);
  } catch (error) {
    if (error instanceof UserInputError) {
      throw new UserInputError(
        `${error.message}: the market's condition id (its \`conditionId\` field), not its numeric id or contract address`,
      );
    }
    throw error;
  }
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * A Pulse reward group: its bytes32 id, `0x` and 64 hex digits, sent in lower case (the
 * backend lower-cases it too; the rewards service refuses anything else).
 */
export function groupIdSegment(value: unknown, name = 'groupId'): string {
  if (typeof value !== 'string' || !BYTES32.test(value)) {
    throw new UserInputError(
      `${name} must be 0x followed by 64 hex characters (a 32-byte group id)`,
    );
  }
  return value.toLowerCase();
}

/**
 * A maker wallet: 0x and 40 hex digits, sent in lower case, which is how the backend reads it
 * (`requireWallet` lower-cases) and keys its cache.
 */
export function walletSegment(value: unknown, name = 'wallet'): string {
  if (typeof value !== 'string') {
    throw new UserInputError(
      `${name} must be a 0x-prefixed 20-byte hex address`,
    );
  }
  return normalizeAddress(value, name).toLowerCase();
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

const PAGE = field.int(0, MAX_REWARDS_PAGE);
const PAGE_SIZE = field.int(1, 1000);
const GROUP_PAGE_SIZE = field.int(1, 100);
const CURRENCY = field.oneOf(REWARD_CURRENCIES);

const walletField: Field = (value, name) => walletSegment(value, name);
const conditionIdField: Field = (value, name) =>
  conditionIdSegment(value, name);

/** A flag the backend reads as `'true'` or `'false'`, and refuses as anything else. */
const flag = field.bool();

const PAGING_HINTS = {
  pageSize: 'use page_size',
  take: 'use page_size',
  skip: 'the backend computes the offset from page and page_size',
};

// ---------------------------------------------------------------------------
// Public lists
// ---------------------------------------------------------------------------

/** The query of `GET /public/liquidity-rewards/groups`. */
export interface GroupsParams {
  /** 0-based, 0 to 1,000,000. The paginator starts here. */
  page?: number;
  /** 1 to 100 (the route's default is 100). */
  page_size?: number;
  /** Only the groups that pay on this rail. */
  currency?: RewardCurrency;
  /** Also list the enrolled products that are not paying now. */
  include_zero?: boolean;
}

export const GROUPS_SPEC = {
  page: PAGE,
  page_size: GROUP_PAGE_SIZE,
  currency: CURRENCY,
  include_zero: flag,
} satisfies Record<keyof GroupsParams, Field>;

export function groupsQuery(input: unknown): Query {
  return closedQuery('rewards.groups', input, GROUPS_SPEC, {
    ...PAGING_HINTS,
    includeZero: 'use include_zero',
  });
}

/**
 * The query of `GET .../markets/:marketId/epochs/:epoch/makers`. The route reads `page` and
 * `page_size` by hand (no DTO), and the rewards service refuses a `page_size` outside 1 to 1,000.
 */
export interface MakersParams {
  /** 0-based. The paginator starts here. */
  page?: number;
  /** 1 to 1,000 (the route's default is 100). */
  page_size?: number;
}

export const MAKERS_SPEC = {
  page: PAGE,
  page_size: PAGE_SIZE,
} satisfies Record<keyof MakersParams, Field>;

export function makersQuery(input: unknown): Query {
  return closedQuery(
    'rewards.marketEpochMakers',
    input,
    MAKERS_SPEC,
    PAGING_HINTS,
  );
}

/** The query of `GET .../markets/:marketId/epochs/:epoch/orders`. */
export interface MarketOrdersParams {
  /** 0-based. The paginator starts here. */
  page?: number;
  /** 1 to 1,000 (the route's default is 100). */
  page_size?: number;
  /** Only this maker's orders. */
  maker?: string;
}

export const MARKET_ORDERS_SPEC = {
  page: PAGE,
  page_size: PAGE_SIZE,
  maker: walletField,
} satisfies Record<keyof MarketOrdersParams, Field>;

export function marketOrdersQuery(input: unknown): Query {
  return closedQuery(
    'rewards.marketEpochOrders',
    input,
    MARKET_ORDERS_SPEC,
    PAGING_HINTS,
  );
}

// ---------------------------------------------------------------------------
// A maker's orders (the wallet's and the account's own)
// ---------------------------------------------------------------------------

/**
 * The query of `GET .../wallets/:walletAddress/orders` and `GET /liquidity-rewards/me/orders`.
 */
export interface MakerOrdersParams {
  /** Only this market's orders: its condition id. Without it, every market of the day. */
  market_id?: string;
  /**
   * The UTC day, an epoch (0 to 10,000,000). Without it the route answers the day in
   * progress. `'latest'` is not accepted.
   */
  epoch?: number;
  /** 0-based. The paginator starts here. */
  page?: number;
  /** 1 to 1,000 (the route's default is 100). */
  page_size?: number;
  /**
   * The live overlay of the day in progress (on upstream by default): adds the resting orders
   * the scorer has not folded yet as `unscored` rows. `false` lists the scored orders alone.
   */
  live?: boolean;
}

export const MAKER_ORDERS_SPEC = {
  market_id: conditionIdField,
  epoch: EPOCH,
  page: PAGE,
  page_size: PAGE_SIZE,
  live: flag,
} satisfies Record<keyof MakerOrdersParams, Field>;

export function makerOrdersQuery(input: unknown, label: string): Query {
  return closedQuery(label, input, MAKER_ORDERS_SPEC, {
    ...PAGING_HINTS,
    marketId: 'use market_id',
  });
}

// ---------------------------------------------------------------------------
// A maker on one market-day, one group-day, the group history
// ---------------------------------------------------------------------------

/**
 * The query of `GET .../markets/:marketId/wallets/:walletAddress` and `GET
 * /liquidity-rewards/markets/:marketId/me`.
 */
export interface MarketDayParams {
  /** The UTC day, an epoch. Without it the rewards service answers the maker's latest scored day. */
  epoch?: number;
  /**
   * Which rail to describe. A market on both rails answers for one per call; without it
   * the rewards service picks the first.
   */
  currency?: RewardCurrency;
  /** 0-based page of the day's qualifying orders. */
  page?: number;
  /** 1 to 1,000 qualifying orders per page (the route's default is 100). */
  page_size?: number;
}

export const MARKET_DAY_SPEC = {
  epoch: EPOCH,
  currency: CURRENCY,
  page: PAGE,
  page_size: PAGE_SIZE,
} satisfies Record<keyof MarketDayParams, Field>;

export function marketDayQuery(input: unknown, label: string): Query {
  return closedQuery(label, input, MARKET_DAY_SPEC, PAGING_HINTS);
}

/** The query of `GET /liquidity-rewards/groups/:groupId/me`. */
export interface GroupDayParams {
  /** The UTC day, an epoch. Without it, the day in progress. */
  epoch?: number;
  /** The rail to describe. Without it, the first rail allocated that day. */
  currency?: RewardCurrency;
}

export const GROUP_DAY_SPEC = {
  epoch: EPOCH,
  currency: CURRENCY,
} satisfies Record<keyof GroupDayParams, Field>;

export function groupDayQuery(input: unknown): Query {
  return closedQuery('rewards.myGroup', input, GROUP_DAY_SPEC);
}

/** The query of `GET /liquidity-rewards/me/group-history`. */
export interface GroupHistoryParams {
  /** 0-based. The paginator starts here. */
  page?: number;
  /** 1 to 100 (the route's default is 100). */
  page_size?: number;
}

export const GROUP_HISTORY_SPEC = {
  page: PAGE,
  page_size: GROUP_PAGE_SIZE,
} satisfies Record<keyof GroupHistoryParams, Field>;

export function groupHistoryQuery(input: unknown): Query {
  return closedQuery(
    'rewards.myGroupHistory',
    input,
    GROUP_HISTORY_SPEC,
    PAGING_HINTS,
  );
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

const PERIOD = field.oneOf(LEADERBOARD_PERIODS);
const IGNORED = 'the route ignores it';

/**
 * The query of `GET /liquidity-rewards/leaderboard`. The DTO is the global page filter, which
 * also accepts `search`, `sortBy` and `sortOrder`, but the handler never reads them, so they
 * are not offered.
 */
export interface LeaderboardParams {
  /** The window: the day, the last 7 days or the season. The default is `'weekly'`. */
  period?: RewardsLeaderboardPeriod;
  /** 1-based, 1 to 10,000. The paginator starts here. */
  page?: number;
  /** Rows per page, 1 to 1,000 (the route's default is 10). */
  take?: number;
}

export const LEADERBOARD_SPEC = {
  period: PERIOD,
  page: field.int(1, 10_000),
  take: field.int(1, 1000),
} satisfies Record<keyof LeaderboardParams, Field>;

export function leaderboardQuery(input: unknown): Query {
  return closedQuery('rewards.leaderboard', input, LEADERBOARD_SPEC, {
    pageSize: 'use take',
    search: IGNORED,
    sortBy: IGNORED,
    sortOrder: IGNORED,
    skip: 'the backend computes the offset from page and take',
  });
}

/** The query of `GET /liquidity-rewards/leaderboard/me`. */
export interface RankParams {
  /** The window. The default is `'weekly'`. */
  period?: RewardsLeaderboardPeriod;
}

export const RANK_SPEC = {
  period: PERIOD,
} satisfies Record<keyof RankParams, Field>;

export function rankQuery(input: unknown): Query {
  return closedQuery('rewards.myRank', input, RANK_SPEC);
}
