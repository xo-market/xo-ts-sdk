import { z } from 'zod';
import type { ActionContext } from '../clients/context';
import {
  makeErrorGuard,
  PaginationLimitError,
  RateLimitError,
  RequestAbortedError,
  RequestRejectedError,
  TimeoutError,
  TransportError,
  UnexpectedResponseError,
  UserInputError,
} from '../core/errors';
import { type Paginated, toPaginated } from '../core/paginated';
import {
  parseRequestOptions,
  type RequestOptions,
} from '../core/requestOptions';
import { PULSE_MAX_PAGE, type PulseListParams } from '../data/params';
import {
  type Category,
  type CollateralToken,
  type Subcategory,
  toCategory,
  toCollateralToken,
  toSubcategory,
} from '../models/catalog';
import {
  type PulseMarket,
  type PulseStats,
  toPulseMarket,
  toPulseStats,
} from '../models/pulse';
import { fields, noCursor, pageNumberOf, parseInput } from './internal';

// The lookup lists of XO: the categories markets are filed under, the tokens they are
// paid in, and the pulse markets.

// ---------------------------------------------------------------------------
// listCategories
// ---------------------------------------------------------------------------

/** The error union of {@link PublicClient.listCategories}. */
export type ListCategoriesError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link ListCategoriesError}. */
export const ListCategoriesError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Lists the categories that markets are filed under, such as `Sports`, each with the number
 * of CLOB markets in it. All of them come on one page.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export function listCategories(
  ctx: ActionContext,
  options?: RequestOptions,
): Paginated<Category> {
  const call = parseRequestOptions(options);
  return toPaginated(
    'categories',
    (cursor) => {
      noCursor(cursor);
      return ctx.data.taxonomy.categories({}, call);
    },
    toCategory,
  );
}

// ---------------------------------------------------------------------------
// listSubcategories
// ---------------------------------------------------------------------------

/** What {@link PublicClient.listSubcategories} takes. Every key is optional. */
export type ListSubcategoriesRequest = {
  /** Only the subcategories of this category. A category's id (`Category.id`), digits. */
  categoryId?: string;
};

const ListSubcategoriesSchema = z.strictObject({
  categoryId: fields.digits().optional(),
});

/** The error union of {@link PublicClient.listSubcategories}. */
export type ListSubcategoriesError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link ListSubcategoriesError}. */
export const ListSubcategoriesError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Lists the subcategories under the categories, such as `Football` under `Sports`, each with
 * the number of CLOB markets in it. All of them come on one page.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export function listSubcategories(
  ctx: ActionContext,
  request?: ListSubcategoriesRequest,
  options?: RequestOptions,
): Paginated<Subcategory> {
  const input: ListSubcategoriesRequest = parseInput(
    'listSubcategories',
    request,
    ListSubcategoriesSchema,
  );
  const call = parseRequestOptions(options);
  return toPaginated(
    'subcategories',
    (cursor) => {
      noCursor(cursor);
      return ctx.data.taxonomy.subcategories(
        input.categoryId === undefined
          ? {}
          : { categoryId: Number(input.categoryId) },
        call,
      );
    },
    toSubcategory,
  );
}

// ---------------------------------------------------------------------------
// fetchCollateralTokens
// ---------------------------------------------------------------------------

/** The error union of {@link PublicClient.fetchCollateralTokens}. */
export type FetchCollateralTokensError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link FetchCollateralTokensError}. */
export const FetchCollateralTokensError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Reads the tokens that markets are paid in, such as USDC.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export async function fetchCollateralTokens(
  ctx: ActionContext,
  options?: RequestOptions,
): Promise<CollateralToken[]> {
  const call = parseRequestOptions(options);
  const rows = await ctx.data.taxonomy.tokens(call).toArray();
  return rows.map(toCollateralToken);
}

// ---------------------------------------------------------------------------
// listPulseMarkets
// ---------------------------------------------------------------------------

/** What {@link PublicClient.listPulseMarkets} takes. Every key is optional. */
export type ListPulseMarketsRequest = {
  /** Only rounds in this stage: `active` (running), `resolved` or `closed`. */
  status?: 'active' | 'resolved' | 'closed';
  /** How many rounds a page holds, from 1 to 100. */
  pageSize?: number;
};

const PULSE_STATUSES = ['active', 'resolved', 'closed'] as const;

const ListPulseMarketsSchema = z.strictObject({
  status: fields.oneOf(PULSE_STATUSES).optional(),
  pageSize: fields.whole(1, 100).optional(),
});

/** The error union of {@link PublicClient.listPulseMarkets}. */
export type ListPulseMarketsError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError
  | PaginationLimitError;
/** The guard of {@link ListPulseMarketsError}. */
export const ListPulseMarketsError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
  PaginationLimitError,
);

/**
 * Lists the rounds of the pulse markets, newest first, a page at a time. Only the rounds that
 * trade on the order book are listed, so a page can hold fewer rounds than `pageSize`, even
 * none, and still have more pages. A round's `conditionId` is the key to trade it with
 * `fetchMarket`.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export function listPulseMarkets(
  ctx: ActionContext,
  request?: ListPulseMarketsRequest,
  options?: RequestOptions,
): Paginated<PulseMarket> {
  const input: ListPulseMarketsRequest = parseInput(
    'listPulseMarkets',
    request,
    ListPulseMarketsSchema,
  );
  const call = parseRequestOptions(options);
  const params: PulseListParams = {
    ...(input.status === undefined
      ? {}
      : { status: input.status.toUpperCase() }),
    ...(input.pageSize === undefined ? {} : { limit: input.pageSize }),
  };
  return toPaginated(
    'pulseMarkets',
    (cursor) =>
      ctx.data.pulse.list({ ...params, page: pageNumberOf(cursor) }, call),
    toPulseMarket,
    { maxPage: PULSE_MAX_PAGE },
  );
}

// ---------------------------------------------------------------------------
// fetchPulseStats
// ---------------------------------------------------------------------------

/** The error union of {@link PublicClient.fetchPulseStats}. */
export type FetchPulseStatsError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link FetchPulseStatsError}. */
export const FetchPulseStatsError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Reads the totals of the pulse markets that trade on the order book: volume, trades,
 * traders and open positions.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export async function fetchPulseStats(
  ctx: ActionContext,
  options?: RequestOptions,
): Promise<PulseStats> {
  const call = parseRequestOptions(options);
  return toPulseStats(await ctx.data.markets.pulseStats({}, call));
}
