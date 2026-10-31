import { z } from 'zod';
import type { ActionContext } from '../clients/context';
import {
  isRejected,
  makeErrorGuard,
  PaginationLimitError,
  RateLimitError,
  RequestAbortedError,
  RequestRejectedError,
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
import type { ConditionId } from '../core/types';
import {
  type BrowseMarketsParams,
  type ListMarketsParams,
  MAX_PAGE,
  type ScopedMarketsParams,
} from '../data/params';
import type { RewardsMarketConfig } from '../data/rewardsSchemas';
import type { EffectiveFeeConfig, Market as RawMarket } from '../data/schemas';
import {
  checkTradable,
  conditionIdOf,
  notOnOrderbook,
  type TradableReason,
  unknownToGateway,
} from '../markets/resolve';
import { type BrowseItem, toBrowseItem } from '../models/browse';
import { toPlacedMarket } from '../models/event';
import {
  CLOB_MARKET_TYPE,
  type Market,
  toListedMarket,
  toMarket,
} from '../models/market';
import type { OrderbookMarket } from '../orderbook/schemas';
import { exactlyOne, fields, pageNumberOf, parseInput } from './internal';

export type { TradableReason } from '../markets/resolve';
export type { BrowseItem } from '../models/browse';

// The market actions: lists of CLOB markets, one market with everything joined, and whether a
// market can be traded. Only CLOB markets with two outcomes are modelled; a list leaves the
// others out.

/** The statuses `status` filters by, and the status of XO each is. */
const STATUS_FILTER = {
  active: 'ACTIVE',
  closed: 'CLOSED',
  resolved: 'RESOLVED',
} as const;

/** What `sort` orders a list of markets by, and the key of the market list each is. */
const MARKET_SORT = {
  volume: 'totalVolumeInUSD',
  created: 'createdAt',
  endDate: 'expiresAt',
  liquidity: 'liquidity',
} as const;

/** The same for the markets of an event or a series, whose list has no liquidity order. */
const SCOPED_SORT = {
  volume: 'totalVolumeInUSD',
  created: 'createdAt',
  endDate: 'expiresAt',
} as const;

const STATUSES = ['active', 'closed', 'resolved'] as const;
const SORTS = ['volume', 'created', 'endDate', 'liquidity'] as const;
const ORDERS = ['asc', 'desc'] as const;

/** `ASC` or `DESC`: a sort without an order is descending. */
const directionOf = (order: 'asc' | 'desc' | undefined): 'ASC' | 'DESC' =>
  order === 'asc' ? 'ASC' : 'DESC';

// ---------------------------------------------------------------------------
// listMarkets
// ---------------------------------------------------------------------------

/**
 * What {@link PublicClient.listMarkets} takes. Every key is optional. A market must have two outcomes and
 * trade on the order book to be listed, whatever the filters say.
 */
export type ListMarketsRequest = {
  /**
   * Only markets in this stage of their life: `active` (open for trading and not past their
   * end time), `closed` (trading has ended and the outcome is not decided yet) or `resolved`
   * (the outcome is decided). Defaults to `active`: a list without a `status` holds open
   * markets only.
   */
  status?: 'active' | 'closed' | 'resolved';
  /** Only the markets of this event, its sub-events included. An event's id, a UUID. */
  eventId?: string;
  /** Only the markets of this series. A series' id, a UUID. */
  seriesId?: string;
  /** Only markets in this category, by its name, such as `Sports`, in any case. Not with `eventId` or `seriesId`. */
  category?: string;
  /**
   * What to order by: `volume` (high-volume markets first, in XO's own ranking, which does not
   * always match the order of `Market.metrics.volume`), `created` (when the market was made),
   * `endDate` (when trading ends) or `liquidity`. `liquidity` is not available with `eventId`
   * or `seriesId`.
   */
  sort?: 'volume' | 'created' | 'endDate' | 'liquidity';
  /** The direction of `sort`. Defaults to `desc`. */
  order?: 'asc' | 'desc';
  /** How many markets a page holds, from 1 to 50. */
  pageSize?: number;
  /** Only markets that end after this time. Not with `eventId` or `seriesId`. */
  endAfter?: Date;
};

const ListMarketsSchema = z
  .strictObject({
    status: fields.oneOf(STATUSES).optional(),
    eventId: fields.uuid().optional(),
    seriesId: fields.uuid().optional(),
    category: fields.text().optional(),
    sort: fields.oneOf(SORTS).optional(),
    order: fields.oneOf(ORDERS).optional(),
    pageSize: fields.whole(1, 50).optional(),
    endAfter: fields.date().optional(),
  })
  .superRefine((request, ctx) => {
    const refuse = (message: string) =>
      ctx.addIssue({ code: 'custom', message, input: request });
    if (request.eventId !== undefined && request.seriesId !== undefined) {
      refuse(
        'eventId and seriesId cannot be combined: name the event, or the series that holds it',
      );
      return;
    }
    if (request.eventId === undefined && request.seriesId === undefined) {
      return;
    }
    for (const key of ['category', 'endAfter'] as const) {
      if (request[key] !== undefined) {
        refuse(`${key} cannot be combined with eventId or seriesId`);
        return;
      }
    }
    if (request.sort === 'liquidity') {
      refuse("sort 'liquidity' cannot be combined with eventId or seriesId");
    }
  });

/** The error union of {@link PublicClient.listMarkets}. */
export type ListMarketsError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError
  | PaginationLimitError;
/** The guard of {@link ListMarketsError}. */
export const ListMarketsError = makeErrorGuard(
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
 * Lists CLOB markets with two outcomes, a page at a time. Without `status` it lists open
 * (`active`) markets only; pass `status: 'closed'` or `'resolved'` for the others.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export function listMarkets(
  ctx: ActionContext,
  request?: ListMarketsRequest,
  options?: RequestOptions,
): Paginated<Market> {
  const input: ListMarketsRequest = parseInput(
    'listMarkets',
    request,
    ListMarketsSchema,
  );
  const call = parseRequestOptions(options);
  // Open markets unless the caller asks for another stage.
  const statuses = { statuses: [STATUS_FILTER[input.status ?? 'active']] };
  const direction =
    input.sort === undefined && input.order === undefined
      ? {}
      : { sortOrder: directionOf(input.order) };
  const take = input.pageSize === undefined ? {} : { take: input.pageSize };

  const scope = input.eventId ?? input.seriesId;
  if (scope !== undefined) {
    const params: ScopedMarketsParams = {
      ...statuses,
      ...direction,
      ...take,
      ...(input.sort === undefined
        ? {}
        : { sortBy: SCOPED_SORT[input.sort as keyof typeof SCOPED_SORT] }),
    };
    return toPaginated(
      'markets',
      (cursor) => {
        const page = { ...params, page: pageNumberOf(cursor) };
        return input.eventId === undefined
          ? ctx.data.series.markets(scope, page, call)
          : ctx.data.events.markets(scope, page, call);
      },
      (placement) => toPlacedMarket(placement.market, placement.groupTitle),
      { maxPage: MAX_PAGE },
    );
  }

  const params: ListMarketsParams = {
    marketType: CLOB_MARKET_TYPE,
    ...statuses,
    ...direction,
    ...take,
    ...(input.sort === undefined ? {} : { sortBy: MARKET_SORT[input.sort] }),
    ...(input.category === undefined ? {} : { categories: [input.category] }),
    ...(input.endAfter === undefined ? {} : { expiresAfter: input.endAfter }),
  };
  return toPaginated(
    'markets',
    (cursor) =>
      ctx.data.markets.list({ ...params, page: pageNumberOf(cursor) }, call),
    toListedMarket,
    { maxPage: MAX_PAGE },
  );
}

// ---------------------------------------------------------------------------
// fetchMarket
// ---------------------------------------------------------------------------

/**
 * What {@link PublicClient.fetchMarket} takes: one way to name the market.
 *
 * - `id`: XO's id for the market (`Market.id`), digits.
 * - `slug`: the market's URL name.
 * - `url`: the link of the market's page on XO's website, such as
 *   `https://xo.market/markets/<slug>`. Only `https` links on `xo.market` and its subdomains
 *   are accepted.
 * - `conditionId`: the market's id on the order book, `0x` and 64 hex digits.
 */
export type FetchMarketRequest =
  | { id: string }
  | { slug: string }
  | { url: string }
  | { conditionId: string };

const FETCH_MARKET_KEYS = ['id', 'slug', 'url', 'conditionId'] as const;

const FetchMarketSchema = z
  .strictObject({
    id: fields.digits().optional(),
    slug: fields.slug().optional(),
    // Checked by `marketSlugFromUrl`, whose refusal has a code of its own.
    url: z.string({ error: 'must be a string' }).optional(),
    conditionId: fields.conditionId().optional(),
  })
  .superRefine(exactlyOne(FETCH_MARKET_KEYS));

/** The error union of {@link PublicClient.fetchMarket}. */
export type FetchMarketError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link FetchMarketError}. */
export const FetchMarketError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/** XO's website, whose market links `fetchMarket` reads. */
const SITE_HOST = 'xo.market';
/** The longest host a refusal repeats. */
const MAX_HOST_ECHO = 100;

function badMarketUrl(host?: string): UserInputError {
  // At most the host: the rest of a link can hold a token, a name or a query.
  const where =
    host === undefined
      ? ''
      : ` (this link is on ${host.slice(0, MAX_HOST_ECHO)})`;
  return new UserInputError(
    `fetchMarket: url must be an https link to a market page on ${SITE_HOST}, such as https://${SITE_HOST}/markets/<slug>${where}`,
    { code: 'invalid_market_url' },
  );
}

/**
 * The slug of a market page's link: `https://xo.market/markets/<slug>` on `xo.market` or any
 * subdomain of it, with or without a trailing slash, query or fragment.
 *
 * @throws {UserInputError} `invalid_market_url` for anything else. The message repeats at most
 *   the link's host.
 */
function marketSlugFromUrl(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw badMarketUrl();
  }
  const host = url.hostname;
  const onSite = host === SITE_HOST || host.endsWith(`.${SITE_HOST}`);
  if (
    url.protocol !== 'https:' ||
    !onSite ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== ''
  ) {
    throw badMarketUrl(host);
  }
  const segments = url.pathname.split('/').slice(1);
  if (segments.at(-1) === '') {
    segments.pop();
  }
  const [section, encoded] = segments;
  if (segments.length !== 2 || section !== 'markets' || !encoded) {
    throw badMarketUrl(host);
  }
  let slug: string;
  try {
    slug = decodeURIComponent(encoded);
  } catch {
    throw badMarketUrl(host);
  }
  if (slug === '' || slug.includes('/')) {
    throw badMarketUrl(host);
  }
  return slug;
}

/** The rewards of a market with no programme: read, and found none. */
function noProgramme(conditionId: ConditionId): RewardsMarketConfig {
  return {
    market_id: conditionId,
    group_id: null,
    programmes: [],
    active_bonus: [],
    upcoming_bonus: [],
    ended_bonus: [],
  };
}

/** Puts the market and what was read next to it into the model. The first failure wins. */
function joinMarket(
  raw: RawMarket,
  conditionId: ConditionId,
  book: PromiseSettledResult<OrderbookMarket>,
  fees: PromiseSettledResult<EffectiveFeeConfig>,
  rewards: PromiseSettledResult<RewardsMarketConfig>,
): Market {
  if (book.status === 'rejected') {
    const error: unknown = book.reason;
    throw isRejected(error, 404) ? unknownToGateway(raw, error) : error;
  }
  if (fees.status === 'rejected') {
    throw fees.reason;
  }
  let programmes: RewardsMarketConfig;
  if (rewards.status === 'fulfilled') {
    programmes = rewards.value;
  } else if (isRejected(rewards.reason, 404)) {
    // Not enrolled is "no programme". Anything else, an outage included, is an error.
    programmes = noProgramme(conditionId);
  } else {
    throw rewards.reason;
  }
  return toMarket(raw, {
    orderbook: book.value,
    fees: fees.value,
    rewards: programmes,
  });
}

/**
 * Reads one market with everything joined: XO's market data, its order book, its fee policy
 * and its liquidity-rewards programme. That is four requests, and the only way to get the
 * fields a list leaves `null`.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export async function fetchMarket(
  ctx: ActionContext,
  request: FetchMarketRequest,
  options?: RequestOptions,
): Promise<Market> {
  const input = parseInput('fetchMarket', request, FetchMarketSchema);
  const call = parseRequestOptions(options);

  if (input.conditionId !== undefined) {
    // The condition id is all the other three sources need, so all four are asked at once.
    const conditionId = input.conditionId.toLowerCase() as ConditionId;
    const [market, book, fees, rewards] = await Promise.allSettled([
      ctx.data.markets.byContract(conditionId, call),
      ctx.orderbook.getMarket(conditionId, call),
      ctx.data.markets.feeConfig(conditionId, call),
      ctx.data.rewards.marketConfig(conditionId, call),
    ]);
    if (market.status === 'rejected') {
      throw market.reason;
    }
    return joinMarket(market.value, conditionId, book, fees, rewards);
  }

  const raw =
    input.id !== undefined
      ? await ctx.data.markets.get(input.id, call)
      : await ctx.data.markets.bySlug(
          input.slug ?? marketSlugFromUrl(input.url ?? ''),
          call,
        );
  const conditionId = conditionIdOf(raw);
  if (conditionId === undefined) {
    throw notOnOrderbook(
      raw,
      `it has no condition id (type ${raw.type}, a legacy market)`,
    );
  }
  const [book, fees, rewards] = await Promise.allSettled([
    ctx.orderbook.getMarket(conditionId, call),
    ctx.data.markets.feeConfig(conditionId, call),
    ctx.data.rewards.marketConfig(conditionId, call),
  ]);
  return joinMarket(raw, conditionId, book, fees, rewards);
}

// ---------------------------------------------------------------------------
// fetchMarketTradability
// ---------------------------------------------------------------------------

/** What {@link PublicClient.fetchMarketTradability} takes. */
export type FetchMarketTradabilityRequest = {
  /** The market's id on the order book, `0x` and 64 hex digits. */
  conditionId: string;
};

/** Whether a market can be traded, and why not when it cannot. */
export type MarketTradability = {
  /** `true` only when every check passed. */
  ok: boolean;
  /** One stable code per check that failed, in a fixed order. Empty when `ok`. */
  reasons: TradableReason[];
};

const FetchMarketTradabilitySchema = z.strictObject({
  conditionId: fields.conditionId(),
});

/**
 * The error union of {@link PublicClient.fetchMarketTradability}. A failed read of the chain is a plain
 * {@link XoError} with the code `chain_read_failed`.
 */
export type FetchMarketTradabilityError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError
  | XoError;
/** The guard of {@link FetchMarketTradabilityError}. */
export const FetchMarketTradabilityError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
  XoError,
);

/**
 * Says whether a market can be traded now. The order book reports a market active that
 * cannot be traded: one that has expired, that is not set up on chain, or that the exchange
 * does not know. Orders on such a market can be accepted and then fail to settle. So this
 * checks that the order book takes orders, that the market has not ended, and three things
 * on chain: the condition is set up with two outcomes, it is not resolved, and the exchange
 * has registered the market.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export async function fetchMarketTradability(
  ctx: ActionContext,
  request: FetchMarketTradabilityRequest,
  options?: RequestOptions,
): Promise<MarketTradability> {
  const input = parseInput(
    'fetchMarketTradability',
    request,
    FetchMarketTradabilitySchema,
  );
  const call = parseRequestOptions(options);
  const { ok, reasons } = await checkTradable(
    input.conditionId.toLowerCase(),
    {
      data: ctx.data,
      orderbook: ctx.orderbook,
      chain: ctx.chain,
      env: ctx.env,
      nowMs: () => ctx.clock.nowSec() * 1000,
    },
    call,
  );
  return { ok, reasons };
}

// ---------------------------------------------------------------------------
// listBrowseItems
// ---------------------------------------------------------------------------

/** What {@link PublicClient.listBrowseItems} takes. Every key is optional. */
export type ListBrowseItemsRequest = {
  /**
   * Only markets in this stage of their life, as for {@link ListMarketsRequest}. Defaults to
   * `active`: a feed without a `status` shows open markets only. The market page takes the same
   * status filter as a market list.
   */
  status?: 'active' | 'closed' | 'resolved';
  /** Only markets in this category, by its name, such as `Sports`, in any case. */
  category?: string;
  /**
   * What to order by. `trending` is the order of XO's market page: boosted markets first, then
   * markets that close within a day, then the rest by XO's own volume ranking, which does not
   * always match the order of `metrics.volume`. The others are as for
   * {@link ListMarketsRequest}. Defaults to `trending`.
   */
  sort?: 'trending' | 'volume' | 'created' | 'endDate' | 'liquidity';
  /**
   * The direction of `sort`. For `trending` it flips the volume ranking only. Defaults to
   * `desc`.
   */
  order?: 'asc' | 'desc';
  /** How many cards a page holds, from 1 to 50. */
  pageSize?: number;
  /** Only markets that end after this time. */
  endAfter?: Date;
};

const BROWSE_SORTS = ['trending', ...SORTS] as const;

const ListBrowseItemsSchema = z.strictObject({
  status: fields.oneOf(STATUSES).optional(),
  category: fields.text().optional(),
  sort: fields.oneOf(BROWSE_SORTS).optional(),
  order: fields.oneOf(ORDERS).optional(),
  pageSize: fields.whole(1, 50).optional(),
  endAfter: fields.date().optional(),
});

/** The error union of {@link PublicClient.listBrowseItems}. */
export type ListBrowseItemsError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError
  | PaginationLimitError;
/** The guard of {@link ListBrowseItemsError}. */
export const ListBrowseItemsError = makeErrorGuard(
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
 * Lists the cards of XO's market page: markets that stand alone, and events with their
 * markets, in the page's own trending order. {@link PublicClient.listMarkets} cannot give this: it lists
 * markets one by one, without the events they sit under, and has no trending order.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export function listBrowseItems(
  ctx: ActionContext,
  request?: ListBrowseItemsRequest,
  options?: RequestOptions,
): Paginated<BrowseItem> {
  const input: ListBrowseItemsRequest = parseInput(
    'listBrowseItems',
    request,
    ListBrowseItemsSchema,
  );
  const call = parseRequestOptions(options);
  const sort = input.sort ?? 'trending';
  const params: BrowseMarketsParams = {
    marketType: CLOB_MARKET_TYPE,
    sortBy: sort === 'trending' ? 'smart' : MARKET_SORT[sort],
    ...(input.order === undefined && sort === 'trending'
      ? {}
      : { sortOrder: directionOf(input.order) }),
    // Open markets unless the caller asks for another stage.
    statuses: [STATUS_FILTER[input.status ?? 'active']],
    ...(input.category === undefined ? {} : { categories: [input.category] }),
    ...(input.pageSize === undefined ? {} : { take: input.pageSize }),
    ...(input.endAfter === undefined ? {} : { expiresAfter: input.endAfter }),
  };
  return toPaginated(
    'browse',
    (cursor) =>
      ctx.data.markets.browse({ ...params, page: pageNumberOf(cursor) }, call),
    toBrowseItem,
    { maxPage: MAX_PAGE },
  );
}
