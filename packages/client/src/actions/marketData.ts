import { z } from 'zod';
import type { ActionContext } from '../clients/context';
import {
  makeErrorGuard,
  PaginationLimitError,
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
import type { DecimalString } from '../core/types';
import { singlePage } from '../data/pages';
import { type ActivitySortKey, MAX_PAGE } from '../data/params';
import { priceOrNull, tokenIdOf } from '../models/convert';
import type { OrderSide } from '../models/enums';
import {
  type ConvictionMarket,
  type LastTradePrice,
  type LastTradePriceForAsset,
  type MarketCapacity,
  type MarketTrade,
  type PricePoint,
  type PricesBySide,
  toConvictionMarket,
  toLastTradePrice,
  toLastTradePriceForAsset,
  toMarketCapacity,
  toMarketTrade,
  toMidpoints,
  toPricePoint,
  toPrices,
  toSpreads,
} from '../models/marketData';
import { type OrderBook, toOrderBook } from '../models/orderBook';
import type {
  PricePoint as RawPricePoint,
  TradingState,
} from '../orderbook/schemas';
import { fields, noCursor, pageNumberOf, parseInput } from './internal';

// The market-data actions: the books, prices and trades of the order book, the price history
// of an outcome token, and the market-level reads of the order book. They need no credentials,
// except `fetchMarketCapacity`, which reads the account of the signed-in wallet.

/** A side as a request writes it: `OrderSide.BUY`, or the text `'BUY'`. */
export type SideInput = OrderSide | `${OrderSide}`;

// ---------------------------------------------------------------------------
// Shared checks
// ---------------------------------------------------------------------------

const AssetSchema = z.strictObject({ assetId: fields.assetId() });
const AssetsSchema = z.strictObject({ assetIds: fields.assetIds() });
const PriceSchema = z.strictObject({
  assetId: fields.assetId(),
  side: fields.side(),
});
const PricesSchema = z.strictObject({
  requests: z
    .array(PriceSchema, {
      error: 'must be a non-empty list of { assetId, side }',
    })
    .min(1, { error: 'must be a non-empty list of { assetId, side }' }),
});
const ConditionSchema = z.strictObject({ conditionId: fields.conditionId() });

/** What reading one outcome token takes. */
export type AssetRequest = {
  /**
   * The outcome token to read: the `outcomes.yes.tokenId` or `outcomes.no.tokenId` of a
   * market. A decimal string of digits.
   */
  assetId: string;
};

/** What reading several outcome tokens takes. */
export type AssetsRequest = {
  /** The outcome tokens to read: at least one, each a decimal string of digits. */
  assetIds: string[];
};

// ---------------------------------------------------------------------------
// fetchOrderBook
// ---------------------------------------------------------------------------

/** What {@link PublicClient.fetchOrderBook} takes. */
export type FetchOrderBookRequest = AssetRequest;

/** The error union of {@link PublicClient.fetchOrderBook}. */
export type FetchOrderBookError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link FetchOrderBookError}. */
export const FetchOrderBookError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Reads the order book of an outcome token: the resting buy and sell orders, as a list of
 * price levels per side. Both sides are listed with the best price last, so the best bid is
 * `bids.at(-1)` and the best ask is `asks.at(-1)`. No credentials are sent.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export async function fetchOrderBook(
  ctx: ActionContext,
  request: FetchOrderBookRequest,
  options?: RequestOptions,
): Promise<OrderBook> {
  const input = parseInput('fetchOrderBook', request, AssetSchema);
  const call = parseRequestOptions(options);
  return toOrderBook(await ctx.orderbook.getBook(input.assetId, call));
}

// ---------------------------------------------------------------------------
// fetchOrderBooks
// ---------------------------------------------------------------------------

/** What {@link PublicClient.fetchOrderBooks} takes. */
export type FetchOrderBooksRequest = AssetsRequest;

/** The error union of {@link PublicClient.fetchOrderBooks}. */
export type FetchOrderBooksError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link FetchOrderBooksError}. */
export const FetchOrderBooksError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Reads the order books of several outcome tokens in one request, in the order asked. See
 * {@link PublicClient.fetchOrderBook} for the order of the levels. No credentials are sent.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export async function fetchOrderBooks(
  ctx: ActionContext,
  request: FetchOrderBooksRequest,
  options?: RequestOptions,
): Promise<OrderBook[]> {
  const input = parseInput('fetchOrderBooks', request, AssetsSchema);
  const call = parseRequestOptions(options);
  return (await ctx.orderbook.getBooks(input.assetIds, call)).map(toOrderBook);
}

// ---------------------------------------------------------------------------
// fetchMidpoint, fetchMidpoints
// ---------------------------------------------------------------------------

/** What {@link PublicClient.fetchMidpoint} takes. */
export type FetchMidpointRequest = AssetRequest;

/** The error union of {@link PublicClient.fetchMidpoint}. */
export type FetchMidpointError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link FetchMidpointError}. */
export const FetchMidpointError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Reads the midpoint of an outcome token: halfway between its best bid and its best ask, as
 * a decimal string between 0 and 1. It is `null` when a side of the book is empty: the order
 * book's `"0.000"` is no price. No credentials are sent.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export async function fetchMidpoint(
  ctx: ActionContext,
  request: FetchMidpointRequest,
  options?: RequestOptions,
): Promise<DecimalString | null> {
  const input = parseInput('fetchMidpoint', request, AssetSchema);
  const call = parseRequestOptions(options);
  return priceOrNull(await ctx.orderbook.getMidpoint(input.assetId, call));
}

/** What {@link PublicClient.fetchMidpoints} takes. */
export type FetchMidpointsRequest = AssetsRequest;

/** The error union of {@link PublicClient.fetchMidpoints}. */
export type FetchMidpointsError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link FetchMidpointsError}. */
export const FetchMidpointsError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Reads the midpoints of several outcome tokens in one request, as an object by token id with
 * an entry for every token asked: its midpoint, or `null` when it has none (a side of its book
 * is empty, or the order book does not know the token). No credentials are sent.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export async function fetchMidpoints(
  ctx: ActionContext,
  request: FetchMidpointsRequest,
  options?: RequestOptions,
): Promise<Record<string, DecimalString | null>> {
  const input = parseInput('fetchMidpoints', request, AssetsSchema);
  const call = parseRequestOptions(options);
  return toMidpoints(
    input.assetIds,
    await ctx.orderbook.getMidpoints(input.assetIds, call),
  );
}

// ---------------------------------------------------------------------------
// fetchPrice, fetchPrices
// ---------------------------------------------------------------------------

/** What {@link PublicClient.fetchPrice} takes. */
export type FetchPriceRequest = {
  /** The token to read: a decimal string of digits. */
  assetId: string;
  /** The side of the book to read: `BUY` is the best bid, `SELL` the best ask. */
  side: SideInput;
};

/** The error union of {@link PublicClient.fetchPrice}. */
export type FetchPriceError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link FetchPriceError}. */
export const FetchPriceError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Reads the best price on one side of an outcome token's book, as a decimal string between 0
 * and 1: the best bid for `BUY`, the best ask for `SELL`, or `null` when that side is empty.
 * No credentials are sent.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export async function fetchPrice(
  ctx: ActionContext,
  request: FetchPriceRequest,
  options?: RequestOptions,
): Promise<DecimalString | null> {
  const input = parseInput('fetchPrice', request, PriceSchema);
  const call = parseRequestOptions(options);
  return priceOrNull(
    await ctx.orderbook.getPrice(input.assetId, input.side, call),
  );
}

/** What {@link PublicClient.fetchPrices} takes. */
export type FetchPricesRequest = {
  /** The tokens and sides to read: at least one. A token may appear with both sides. */
  requests: FetchPriceRequest[];
};

/** The error union of {@link PublicClient.fetchPrices}. */
export type FetchPricesError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link FetchPricesError}. */
export const FetchPricesError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Reads the best prices of several outcome tokens and sides in one request, as an object by
 * token id and then by side, with an entry for every token and side asked: the price, or `null`
 * when that side of the book is empty or the order book does not know the token. See
 * {@link PublicClient.fetchPrice} for what a side reads. No credentials are sent.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export async function fetchPrices(
  ctx: ActionContext,
  request: FetchPricesRequest,
  options?: RequestOptions,
): Promise<Record<string, PricesBySide>> {
  const input = parseInput('fetchPrices', request, PricesSchema);
  const call = parseRequestOptions(options);
  return toPrices(
    input.requests,
    await ctx.orderbook.getPrices(
      input.requests.map((each) => ({
        tokenId: each.assetId,
        side: each.side,
      })),
      call,
    ),
  );
}

// ---------------------------------------------------------------------------
// fetchSpread, fetchSpreads
// ---------------------------------------------------------------------------

/** What {@link PublicClient.fetchSpread} takes. */
export type FetchSpreadRequest = AssetRequest;

/** The error union of {@link PublicClient.fetchSpread}. */
export type FetchSpreadError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link FetchSpreadError}. */
export const FetchSpreadError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Reads the spread of an outcome token: the gap between its best ask and its best bid, as a
 * decimal string. It is `null` when a side of the book is empty. No credentials are sent.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export async function fetchSpread(
  ctx: ActionContext,
  request: FetchSpreadRequest,
  options?: RequestOptions,
): Promise<DecimalString | null> {
  const input = parseInput('fetchSpread', request, AssetSchema);
  const call = parseRequestOptions(options);
  const spread = await ctx.orderbook.getSpread(input.assetId, call);
  if (priceOrNull(spread) !== null) {
    return spread;
  }
  // The order book prints a spread of 0 both for a book with an empty side, which has no
  // spread, and for a book whose best bid meets its best ask. Its list of spreads leaves out the
  // first, so it tells the two apart.
  const spreads = await ctx.orderbook.getSpreads([input.assetId], call);
  return toSpreads([input.assetId], spreads)[tokenIdOf(input.assetId)] ?? null;
}

/** What {@link PublicClient.fetchSpreads} takes. */
export type FetchSpreadsRequest = AssetsRequest;

/** The error union of {@link PublicClient.fetchSpreads}. */
export type FetchSpreadsError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link FetchSpreadsError}. */
export const FetchSpreadsError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Reads the spreads of several outcome tokens in one request, as an object by token id with an
 * entry for every token asked: its spread, or `null` when it has none (a side of its book is
 * empty, or the order book does not know the token). No credentials are sent.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export async function fetchSpreads(
  ctx: ActionContext,
  request: FetchSpreadsRequest,
  options?: RequestOptions,
): Promise<Record<string, DecimalString | null>> {
  const input = parseInput('fetchSpreads', request, AssetsSchema);
  const call = parseRequestOptions(options);
  return toSpreads(
    input.assetIds,
    await ctx.orderbook.getSpreads(input.assetIds, call),
  );
}

// ---------------------------------------------------------------------------
// fetchLastTradePrice, fetchLastTradePrices
// ---------------------------------------------------------------------------

/** What {@link PublicClient.fetchLastTradePrice} takes. */
export type FetchLastTradePriceRequest = AssetRequest;

/** The error union of {@link PublicClient.fetchLastTradePrice}. */
export type FetchLastTradePriceError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link FetchLastTradePriceError}. */
export const FetchLastTradePriceError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Reads the last trade of an outcome token: its price and the side of the order that took the
 * liquidity. It is `null` for a token that has not traded. No credentials are sent.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export async function fetchLastTradePrice(
  ctx: ActionContext,
  request: FetchLastTradePriceRequest,
  options?: RequestOptions,
): Promise<LastTradePrice | null> {
  const input = parseInput('fetchLastTradePrice', request, AssetSchema);
  const call = parseRequestOptions(options);
  return toLastTradePrice(
    await ctx.orderbook.getLastTradePrice(input.assetId, call),
  );
}

/** What {@link PublicClient.fetchLastTradePrices} takes. */
export type FetchLastTradePricesRequest = AssetsRequest;

/** The error union of {@link PublicClient.fetchLastTradePrices}. */
export type FetchLastTradePricesError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link FetchLastTradePricesError}. */
export const FetchLastTradePricesError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Reads the last trades of several outcome tokens in one request. A token that has not
 * traded is left out, so match the rows by `assetId`: the list is not in the order asked. No
 * credentials are sent.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export async function fetchLastTradePrices(
  ctx: ActionContext,
  request: FetchLastTradePricesRequest,
  options?: RequestOptions,
): Promise<LastTradePriceForAsset[]> {
  const input = parseInput('fetchLastTradePrices', request, AssetsSchema);
  const call = parseRequestOptions(options);
  const trades: LastTradePriceForAsset[] = [];
  for (const entry of await ctx.orderbook.getLastTradePrices(
    input.assetIds,
    call,
  )) {
    const trade = toLastTradePriceForAsset(entry);
    if (trade !== undefined) {
      trades.push(trade);
    }
  }
  return trades;
}

// ---------------------------------------------------------------------------
// listPriceHistory
// ---------------------------------------------------------------------------

/** How far back each interval reaches, in seconds. `max` has no limit. */
const INTERVAL_SECONDS = {
  '1h': 3_600,
  '6h': 21_600,
  '1d': 86_400,
  '1w': 604_800,
} as const;

const INTERVALS = ['1h', '6h', '1d', '1w', 'max'] as const;

/** The last day a time may name, 9999-12-31, in Unix seconds. It also refuses milliseconds. */
const MAX_TIMESTAMP = 253_402_300_799;

/** The most points the order book returns. */
const MAX_FIDELITY = 500;

/** What {@link PublicClient.listPriceHistory} takes. */
export type ListPriceHistoryRequest = {
  /** The outcome token whose prices to read: a decimal string of digits. */
  assetId: string;
  /**
   * How far back to read, ending at `endTs` (now when it is left out): `1h`, `6h`, `1d`, `1w`
   * or `max` for as far back as the points reach.
   */
  interval: '1h' | '6h' | '1d' | '1w' | 'max';
  /** Only points at or after this time, in Unix seconds. */
  startTs?: number;
  /** Only points at or before this time, in Unix seconds. */
  endTs?: number;
  /**
   * How many of the newest points to read from the order book, from 1 to 500. The order book
   * returns 100 when this is left out.
   */
  fidelity?: number;
};

const ListPriceHistorySchema = z
  .strictObject({
    assetId: fields.assetId(),
    interval: fields.oneOf(INTERVALS),
    startTs: fields.whole(0, MAX_TIMESTAMP).optional(),
    endTs: fields.whole(0, MAX_TIMESTAMP).optional(),
    fidelity: fields.whole(1, MAX_FIDELITY).optional(),
  })
  .superRefine((request, ctx) => {
    if (
      request.startTs !== undefined &&
      request.endTs !== undefined &&
      request.startTs > request.endTs
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'startTs must not be after endTs',
        input: request,
      });
    }
  });

/** The error union of {@link PublicClient.listPriceHistory}. */
export type ListPriceHistoryError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link ListPriceHistoryError}. */
export const ListPriceHistoryError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Lists the recent trade prices of an outcome token, oldest first, on one page.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export function listPriceHistory(
  ctx: ActionContext,
  request: ListPriceHistoryRequest,
  options?: RequestOptions,
): Paginated<PricePoint> {
  const input: ListPriceHistoryRequest = parseInput(
    'listPriceHistory',
    request,
    ListPriceHistorySchema,
  );
  const call = parseRequestOptions(options);
  return toPaginated(
    'priceHistory',
    (cursor) => {
      noCursor(cursor);
      return singlePage(
        () =>
          ctx.orderbook.getPricesHistory(
            { tokenId: input.assetId, limit: input.fidelity },
            call,
          ),
        (points) => inWindow(points, input, ctx.clock.nowSec()),
      );
    },
    toPricePoint,
  );
}

/**
 * The points of the order book (newest first) that fall in the request's window, oldest
 * first. The window reaches back from `endTs` (now without it) by the interval, and not before
 * `startTs`; only `endTs` bounds it from above.
 */
function inWindow(
  points: RawPricePoint[],
  request: ListPriceHistoryRequest,
  nowSec: number,
): RawPricePoint[] {
  const reach =
    request.interval === 'max' ? 0 : INTERVAL_SECONDS[request.interval];
  const from = Math.max(
    request.startTs ?? 0,
    reach === 0 ? 0 : (request.endTs ?? nowSec) - reach,
  );
  const to = request.endTs ?? Number.POSITIVE_INFINITY;
  return points.filter((point) => point.t >= from && point.t <= to).reverse();
}

// ---------------------------------------------------------------------------
// fetchTradingState
// ---------------------------------------------------------------------------

/** The error union of {@link PublicClient.fetchTradingState}. */
export type FetchTradingStateError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link FetchTradingStateError}. */
export const FetchTradingStateError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Reads whether trading is `active` or `paused` on all of XO. While it is paused, a new order
 * is refused. A state added later is returned as it is. No credentials are sent.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export async function fetchTradingState(
  ctx: ActionContext,
  options?: RequestOptions,
): Promise<TradingState> {
  const call = parseRequestOptions(options);
  return ctx.orderbook.getTradingState(call);
}

// ---------------------------------------------------------------------------
// fetchConvictionMarket
// ---------------------------------------------------------------------------

/** What {@link PublicClient.fetchConvictionMarket} and {@link SecureClient.fetchMarketCapacity} take. */
export type ConditionRequest = {
  /** The market's id on the order book, `0x` and 64 hex digits. */
  conditionId: string;
};

/** What {@link PublicClient.fetchConvictionMarket} takes. */
export type FetchConvictionMarketRequest = ConditionRequest;

/** The error union of {@link PublicClient.fetchConvictionMarket}. */
export type FetchConvictionMarketError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link FetchConvictionMarketError}. */
export const FetchConvictionMarketError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Reads a market with the metadata of a conviction market: who created it and the order the
 * creator committed to. A market that is not a conviction market answers its `variant` with
 * no creator and no commitment. No credentials are sent.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export async function fetchConvictionMarket(
  ctx: ActionContext,
  request: FetchConvictionMarketRequest,
  options?: RequestOptions,
): Promise<ConvictionMarket> {
  const input = parseInput('fetchConvictionMarket', request, ConditionSchema);
  const call = parseRequestOptions(options);
  return toConvictionMarket(
    await ctx.orderbook.getConvictionMarket(input.conditionId, call),
  );
}

// ---------------------------------------------------------------------------
// fetchMarketCapacity
// ---------------------------------------------------------------------------

/** What {@link SecureClient.fetchMarketCapacity} takes. */
export type FetchMarketCapacityRequest = ConditionRequest;

/**
 * The error union of {@link SecureClient.fetchMarketCapacity}. It reads an account, so it is the union of a
 * read that signs in: the order book logs in with the wallet's signature, and again when it
 * refuses the credentials (a 401), which can fail to sign ({@link SigningError}). A plain
 * {@link XoError} carries the other codes of that login: `session_closed` for a client that
 * has been closed, and `smart_wallet_not_deployed`, `smart_wallet_deployment_unknown` and
 * `smart_wallet_address_unavailable` for a smart wallet whose deployment or address could not
 * be read.
 */
export type FetchMarketCapacityError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError
  | SigningError
  | XoError;
/** The guard of {@link FetchMarketCapacityError}. */
export const FetchMarketCapacityError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
  SigningError,
  XoError,
);

/**
 * Reads what the signed-in account can still commit in one market: the USDC a new buy may use,
 * and for each outcome the shares a new sell may use. Use it to size an order. It reads the
 * account of the wallet that signed in, so only a client that signed in has it.
 *
 * @param request - The market's `conditionId`.
 * @param options - Cancel, timeout and retries of the request.
 * @throws {FetchMarketCapacityError} `invalid_input` for a request that is not valid,
 *   `invalid_request_options` for bad options, a 401 {@link RequestRejectedError} when the
 *   account's credentials are refused and a new login does not help, a {@link SigningError}
 *   when the wallet cannot sign that login, and a plain error with the code `session_closed`
 *   (the client was closed) or `smart_wallet_not_deployed`, `smart_wallet_deployment_unknown`
 *   or `smart_wallet_address_unavailable` (a smart wallet that cannot sign in).
 * @example
 * const capacity = await client.fetchMarketCapacity({ conditionId });
 * console.log(capacity.buyCapacity, capacity.positions.map((position) => position.free));
 */
export async function fetchMarketCapacity(
  ctx: ActionContext,
  request: FetchMarketCapacityRequest,
  options?: RequestOptions,
): Promise<MarketCapacity> {
  const input = parseInput('fetchMarketCapacity', request, ConditionSchema);
  const call = parseRequestOptions(options);
  return toMarketCapacity(
    await ctx.orderbook.getMarketCapacity(
      input.conditionId.toLowerCase(),
      call,
    ),
  );
}

// ---------------------------------------------------------------------------
// listTrades
// ---------------------------------------------------------------------------

/** What {@link PublicClient.listTrades} takes. Only `marketId` is required. */
export type ListTradesRequest = {
  /** The market whose fills to list: XO's id for it (`Market.id`), digits. */
  marketId: string;
  /** Only buys or only sells. */
  side?: SideInput;
  /** How many fills a page holds, from 1 to 50. XO's own page size when left out. */
  pageSize?: number;
};

const ListTradesSchema = z.strictObject({
  marketId: fields.digits(),
  side: fields.side().optional(),
  pageSize: fields.whole(1, 50).optional(),
});

/** The error union of {@link PublicClient.listTrades}. */
export type ListTradesError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError
  | PaginationLimitError;
/** The guard of {@link ListTradesError}. */
export const ListTradesError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
  PaginationLimitError,
);

/** The fills come newest first. */
const NEWEST_FIRST: { sortBy: ActivitySortKey; sortOrder: 'DESC' } = {
  sortBy: 'executedAt',
  sortOrder: 'DESC',
};

/**
 * Lists the fills of one CLOB market, newest first, a page at a time: who bought or sold how
 * many shares at what price. Anyone can read them; no credentials are sent. The market's own
 * fields (`conditionId`, `title`, `slug`, `icon`) are left out of the rows: you know them
 * already.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export function listTrades(
  ctx: ActionContext,
  request: ListTradesRequest,
  options?: RequestOptions,
): Paginated<MarketTrade> {
  const input = parseInput(
    'listTrades',
    request,
    ListTradesSchema,
  ) satisfies ListTradesRequest;
  const call = parseRequestOptions(options);
  const filters = {
    ...NEWEST_FIRST,
    ...(input.side === undefined ? {} : { positionType: input.side }),
    ...(input.pageSize === undefined ? {} : { take: input.pageSize }),
  };
  const { marketId } = input;
  return toPaginated(
    'trades',
    (cursor) =>
      ctx.data.markets.activity(
        marketId,
        { ...filters, page: pageNumberOf(cursor) },
        call,
      ),
    (row) => toMarketTrade(row, marketId),
    { maxPage: MAX_PAGE },
  );
}
