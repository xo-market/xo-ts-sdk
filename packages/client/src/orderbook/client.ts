import type { Session } from '../auth/session';
import type { EnvironmentConfig } from '../core/env';
import { UserInputError, XoError } from '../core/errors';
import { normalizeConditionId, normalizeTokenId } from '../core/ids';
import { cursorPaginator, type Paginator } from '../core/paginate';
import type { CallOptions } from '../core/requestOptions';
import { type DualSchema, parseResponse } from '../core/schema';
import type { Transport, TransportRequest } from '../core/transport';
import type { ConditionId, DecimalString, Side, TokenId } from '../core/types';
import {
  Account,
  type BalanceAllowanceOptions,
  type OpenOrdersOptions,
  type ReconcileOptions,
  type ReconcileResult,
  type TradesOptions,
} from './account';
import type { LimitOrderArgs, MarketOrderArgs, SignedOrder } from './builder';
import {
  type HeartbeatHandle,
  type HeartbeatOptions,
  Heartbeats,
} from './heartbeat';
import {
  type ContractReader,
  closedObject,
  type OrderbookDeps,
} from './internal';
import type {
  BatchOpResult,
  BatchPlaceResult,
  PlaceOrderResult,
} from './placement';
import {
  type BalanceAllowance,
  type CancelResult,
  type Claimable,
  type ConvictionMarket,
  ConvictionMarketSchema,
  DecimalMapSchema,
  type HeartbeatResponse,
  type LastTradePrice,
  type LastTradePriceEntry,
  LastTradePriceSchema,
  LastTradePricesSchema,
  type MarketCapacity,
  MidpointSchema,
  type OpenOrder,
  type OrderBook,
  OrderBookSchema,
  OrderBooksSchema,
  type OrderbookMarket,
  OrderbookMarketSchema,
  OrderbookMarketsPageSchema,
  type Positions,
  type PricePoint,
  PriceSchema,
  type PricesBySide,
  PricesHistorySchema,
  PricesMapSchema,
  ServerTimeSchema,
  SpreadSchema,
  TickSizeSchema,
  type Trade,
  type TradingState,
  TradingStateSchema,
} from './schemas';
import {
  type BatchOp,
  type CancelAllOptions,
  type CancelMarketOrdersOptions,
  type CancelOrderOptions,
  Trading,
} from './trading';

export type { HeartbeatHandle, HeartbeatOptions } from './heartbeat';
export type { ContractReader } from './internal';
export {
  BatchOpsIncompleteError,
  BatchPlaceIncompleteError,
  PlacementError,
} from './placement';

/**
 * The options of {@link OrderbookClient}: a `transport` with its `session` installed
 * (`transport.setAuth(session)`), as a client builds it.
 */
export interface OrderbookClientOptions {
  /** The SDK transport, with the session installed on it. */
  transport: Transport;
  /**
   * The trader. Building orders and signed cancels use its signer, its trading identity and its
   * server clock (GTD expirations are checked against the server's time); `getPositions` uses
   * its trading address. The public reads work without it.
   */
  session?: Session;
  /** The environment: its hosts and contracts. */
  env: EnvironmentConfig;
  /** Reads `CTFExchange.nonces(maker)` when an order is built. Required to build orders. */
  chain?: ContractReader;
  /** Reject response fields the schemas do not know (for contract tests). */
  strictResponses?: boolean;
  /**
   * The local clock in milliseconds, for the 5-minute tick-size cache of the order
   * builders. Defaults to `Date.now`.
   */
  now?: () => number;
}

/** The options of {@link OrderbookClient.getMarkets}. */
export interface GetMarketsOptions {
  /** Markets per page, 1 to 500. Defaults to the gateway's page size (100). */
  limit?: number;
}

/** The options of {@link OrderbookClient.getPricesHistory}. */
export interface PricesHistoryOptions {
  tokenId: TokenId | string;
  /**
   * The most points to return, 1 to 500 (the gateway's own default is 100). It is the
   * gateway's `fidelity` query parameter: `GET /prices-history` has no `limit`.
   */
  limit?: number;
}

/** One element of {@link OrderbookClient.getPrices}. */
export interface PriceRequest {
  tokenId: TokenId | string;
  side: Side;
}

/** Every option of {@link OrderbookClientOptions}: any other key is refused. */
const OPTION_KEYS = [
  'transport',
  'session',
  'env',
  'chain',
  'strictResponses',
  'now',
] as const;

/** Checks the options: an object with known keys only. */
function readOptions(o: OrderbookClientOptions): OrderbookClientOptions {
  if (typeof o !== 'object' || o === null) {
    throw new UserInputError('options must be an object');
  }
  closedObject(o, 'options', OPTION_KEYS);
  return o;
}

/** The gateway's bounds for a page of markets, and for the points of a price history. */
const MIN_LIMIT = 1;
const MAX_LIMIT = 500;

/** An optional `limit`: a whole number from 1 to 500. */
function readLimit(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MIN_LIMIT ||
    value > MAX_LIMIT
  ) {
    throw new UserInputError(
      `limit must be a whole number between ${MIN_LIMIT} and ${MAX_LIMIT}`,
    );
  }
  return value;
}

function readSide(value: unknown, field = 'side'): Side {
  if (value !== 'BUY' && value !== 'SELL') {
    throw new UserInputError(`${field} must be 'BUY' or 'SELL'`);
  }
  return value;
}

/** A list of token ids. A hole in the list is read as `undefined`, so it is refused. */
function readTokenIds(value: unknown): TokenId[] {
  if (!Array.isArray(value)) {
    throw new UserInputError('tokenIds must be an array of token ids');
  }
  return Array.from(value as unknown[], (id, index) =>
    normalizeTokenId(id, `tokenIds[${index}]`),
  );
}

/** The body of a batch read: `[{ token_id }]`. */
function tokenBody(tokenIds: readonly TokenId[]): Array<{ token_id: string }> {
  return tokenIds.map((token_id) => ({ token_id }));
}

/**
 * The client of the orderbook gateway.
 *
 * The market-data reads need no credentials: they send none, and the auth provider of the
 * transport is never asked. A GET is retried like any read. The batch reads are POSTs, but
 * they only read, so they are retried too.
 *
 * Trading and own data are authenticated with the L2 (HMAC) credentials of the transport's
 * auth provider (the session). **Orders are never placed twice by the SDK**: placement
 * (`postOrder`, `postOrders`, `batchOps`) is never retried and a signed order is never
 * re-signed. Cancels are never retried either.
 *
 * Prices and sizes stay the exact strings the gateway sends: `getBook` prints `"0.550"`,
 * while `getPrice` prints `"0.55"`. Token ids are decimal strings; a number is refused,
 * because it would lose precision. Ids are validated before any request is made.
 *
 * The trading methods live in `trading.ts` and the own-data reads in `account.ts`; this
 * class delegates to them.
 *
 * Internal: an engine behind the two clients. No entry of the package exports it.
 */
export class OrderbookClient {
  private readonly transport: Transport;
  private readonly strict: boolean;
  private readonly trading: Trading;
  private readonly account: Account;
  private readonly heartbeats: Heartbeats;
  /** Set by `refuseNewOrders()`: the client is closing. */
  private refusingOrders = false;

  /**
   * Checks the options and requests nothing.
   * @throws {UserInputError} For an option that is not an object or an unknown key.
   */
  constructor(o: OrderbookClientOptions) {
    const { transport, session, env, chain } = readOptions(o);
    this.transport = transport;
    this.strict = o.strictResponses ?? false;
    const deps: OrderbookDeps = {
      send: (schema, request) => this.send(schema, request),
      request: (request) =>
        this.transport.request({ service: 'orderbook', ...request }),
      parse: (schema, data, path) => this.parse(schema, data, path),
      env,
      session,
      chain,
      tickSize: (tokenId) => this.getTickSize(tokenId),
      now: o.now ?? (() => Date.now()),
    };
    this.trading = new Trading(deps);
    this.account = new Account(deps);
    this.heartbeats = new Heartbeats(deps);
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  /** Sends one request to the orderbook and checks the answer against `schema`. */
  private async send<T>(
    schema: DualSchema<T>,
    o: Omit<TransportRequest, 'service'>,
  ): Promise<T> {
    const data = await this.transport.request({ service: 'orderbook', ...o });
    return this.parse(schema, data, o.path);
  }

  /** Checks an orderbook answer against `schema`. `path` is the request path, without a query. */
  private parse<T>(schema: DualSchema<T>, data: unknown, path: string): T {
    return parseResponse(schema, data, {
      strict: this.strict,
      service: 'orderbook',
      path,
    });
  }

  /** A public GET: no credentials, and the transport's read retries (or the call's). */
  private publicGet<T>(
    schema: DualSchema<T>,
    path: string,
    query?: TransportRequest['query'],
    call?: CallOptions,
  ): Promise<T> {
    return this.send(schema, {
      method: 'GET',
      path,
      query,
      auth: 'none',
      call,
    });
  }

  /** A public batch read: a POST with no credentials. It only reads, so it is retried. */
  private publicBatch<T>(
    schema: DualSchema<T>,
    path: string,
    body: unknown,
    call?: CallOptions,
  ): Promise<T> {
    return this.send(schema, {
      method: 'POST',
      path,
      body,
      auth: 'none',
      retry: 'read',
      call,
    });
  }

  // -------------------------------------------------------------------------
  // Server
  // -------------------------------------------------------------------------

  /**
   * The gateway's clock, in whole unix seconds (`GET /time`).
   *
   * @throws {UnexpectedResponseError} When the answer is not whole seconds.
   */
  getServerTime(call?: CallOptions): Promise<number> {
    return this.publicGet(ServerTimeSchema, '/time', undefined, call);
  }

  /**
   * Whether trading is `'active'` or `'paused'` (`GET /trading-state`). A state the SDK
   * does not know is returned as it is.
   */
  async getTradingState(call?: CallOptions): Promise<TradingState> {
    return (
      await this.publicGet(
        TradingStateSchema,
        '/trading-state',
        undefined,
        call,
      )
    ).state;
  }

  /**
   * The minimum tick size of a token's market, as a decimal string such as `"0.001"`
   * (`GET /tick-size`).
   *
   * @throws {RequestRejectedError} Status 404, when the gateway does not know the token.
   */
  async getTickSize(
    tokenId: TokenId | string,
    call?: CallOptions,
  ): Promise<DecimalString> {
    const token_id = normalizeTokenId(tokenId);
    return (
      await this.publicGet(TickSizeSchema, '/tick-size', { token_id }, call)
    ).minimum_tick_size;
  }

  // -------------------------------------------------------------------------
  // Markets
  // -------------------------------------------------------------------------

  /**
   * Every market the gateway knows (`GET /markets`), page by page. It is lazy: nothing is
   * fetched until you read it, and it ends at the gateway's `"LTE="` cursor.
   *
   * @throws {UserInputError} At once, when `limit` is not a whole number from 1 to 500
   *   or an option is unknown.
   */
  getMarkets(
    options: GetMarketsOptions = {},
    call?: CallOptions,
  ): Paginator<OrderbookMarket> {
    const limit = readLimit(closedObject(options, 'options', ['limit']).limit);
    return cursorPaginator(async (cursor) => {
      const page = await this.publicGet(
        OrderbookMarketsPageSchema,
        '/markets',
        { limit, next_cursor: cursor },
        call,
      );
      return { data: page.data, next_cursor: page.next_cursor, raw: page };
    });
  }

  /**
   * One market by its condition id (`GET /markets/{condition_id}`).
   *
   * @throws {RequestRejectedError} Status 404, when the gateway does not know the market.
   */
  async getMarket(
    conditionId: ConditionId | string,
    call?: CallOptions,
  ): Promise<OrderbookMarket> {
    const id = normalizeConditionId(conditionId);
    return this.publicGet(
      OrderbookMarketSchema,
      `/markets/${id}`,
      undefined,
      call,
    );
  }

  /**
   * One market with its conviction metadata: the variant, the creator and the creator's
   * commitment (`GET /conviction/markets/{condition_id}`). A market that is not a
   * conviction market answers `variant: 'clob'` with a null creator and commitment.
   *
   * @throws {RequestRejectedError} Status 404, when the gateway does not know the market.
   */
  async getConvictionMarket(
    conditionId: ConditionId | string,
    call?: CallOptions,
  ): Promise<ConvictionMarket> {
    const id = normalizeConditionId(conditionId);
    return this.publicGet(
      ConvictionMarketSchema,
      `/conviction/markets/${id}`,
      undefined,
      call,
    );
  }

  // -------------------------------------------------------------------------
  // Books
  // -------------------------------------------------------------------------

  /**
   * The order book of a token (`GET /book`). Prices are padded (`"0.550"`).
   *
   * @throws {RequestRejectedError} Status 404, when the gateway has no orderbook for the token.
   */
  async getBook(
    tokenId: TokenId | string,
    call?: CallOptions,
  ): Promise<OrderBook> {
    const token_id = normalizeTokenId(tokenId);
    return this.publicGet(OrderBookSchema, '/book', { token_id }, call);
  }

  /**
   * The order books of several tokens, in the order asked (`POST /books`).
   *
   * @throws {RequestRejectedError} Status 404, when the gateway has no orderbook for one of the tokens.
   */
  async getBooks(
    tokenIds: readonly (TokenId | string)[],
    call?: CallOptions,
  ): Promise<OrderBook[]> {
    const ids = readTokenIds(tokenIds);
    return this.publicBatch(OrderBooksSchema, '/books', tokenBody(ids), call);
  }

  // -------------------------------------------------------------------------
  // Prices
  // -------------------------------------------------------------------------

  /**
   * The midpoint of a token's best bid and best ask (`GET /midpoint`), or `"0.000"` when a
   * side is empty.
   *
   * @throws {RequestRejectedError} Status 404, when the gateway has no orderbook for the token.
   */
  async getMidpoint(
    tokenId: TokenId | string,
    call?: CallOptions,
  ): Promise<DecimalString> {
    const token_id = normalizeTokenId(tokenId);
    return (
      await this.publicGet(MidpointSchema, '/midpoint', { token_id }, call)
    ).mid;
  }

  /**
   * The midpoints of several tokens, by token id (`POST /midpoints`). A token the gateway
   * does not know is left out.
   */
  async getMidpoints(
    tokenIds: readonly (TokenId | string)[],
    call?: CallOptions,
  ): Promise<Record<string, DecimalString>> {
    const ids = readTokenIds(tokenIds);
    return this.publicBatch(
      DecimalMapSchema,
      '/midpoints',
      tokenBody(ids),
      call,
    );
  }

  /**
   * The best price on one side of a token's book (`GET /price`): the best bid for `'BUY'`,
   * the best ask for `'SELL'`, or `"0.000"` when that side is empty.
   *
   * @throws {RequestRejectedError} Status 404, when the gateway has no orderbook for the token.
   */
  async getPrice(
    tokenId: TokenId | string,
    side: Side,
    call?: CallOptions,
  ): Promise<DecimalString> {
    const token_id = normalizeTokenId(tokenId);
    const checked = readSide(side);
    return (
      await this.publicGet(
        PriceSchema,
        '/price',
        { token_id, side: checked },
        call,
      )
    ).price;
  }

  /**
   * The best prices of several tokens and sides, by token id and then side
   * (`POST /prices`). A token the gateway does not know is left out.
   */
  async getPrices(
    requests: readonly PriceRequest[],
    call?: CallOptions,
  ): Promise<Record<string, PricesBySide>> {
    if (!Array.isArray(requests)) {
      throw new UserInputError(
        'requests must be an array of { tokenId, side }',
      );
    }
    const body = Array.from(requests as unknown[], (request, index) => {
      const field = `requests[${index}]`;
      const item = closedObject(request, field, ['tokenId', 'side']);
      return {
        token_id: normalizeTokenId(item.tokenId, `${field}.tokenId`),
        side: readSide(item.side, `${field}.side`),
      };
    });
    return this.publicBatch(PricesMapSchema, '/prices', body, call);
  }

  /**
   * The gap between a token's best ask and best bid (`GET /spread`), or `"0"` when a side
   * is empty.
   *
   * @throws {RequestRejectedError} Status 404, when the gateway has no orderbook for the token.
   */
  async getSpread(
    tokenId: TokenId | string,
    call?: CallOptions,
  ): Promise<DecimalString> {
    const token_id = normalizeTokenId(tokenId);
    return (await this.publicGet(SpreadSchema, '/spread', { token_id }, call))
      .spread;
  }

  /**
   * The spreads of several tokens, by token id (`POST /spreads`). A token the gateway does
   * not know, or whose book has an empty side, is left out.
   */
  async getSpreads(
    tokenIds: readonly (TokenId | string)[],
    call?: CallOptions,
  ): Promise<Record<string, DecimalString>> {
    const ids = readTokenIds(tokenIds);
    return this.publicBatch(DecimalMapSchema, '/spreads', tokenBody(ids), call);
  }

  /**
   * The last trade of a token (`GET /last-trade-price`): its price and the taker's side.
   * A token with no trade answers `{ price: "0.5", side: "" }`.
   */
  async getLastTradePrice(
    tokenId: TokenId | string,
    call?: CallOptions,
  ): Promise<LastTradePrice> {
    const token_id = normalizeTokenId(tokenId);
    return this.publicGet(
      LastTradePriceSchema,
      '/last-trade-price',
      { token_id },
      call,
    );
  }

  /**
   * The last trades of several tokens (`POST /last-trades-prices`). A token with no trade
   * is left out.
   */
  async getLastTradePrices(
    tokenIds: readonly (TokenId | string)[],
    call?: CallOptions,
  ): Promise<LastTradePriceEntry[]> {
    const ids = readTokenIds(tokenIds);
    return this.publicBatch(
      LastTradePricesSchema,
      '/last-trades-prices',
      tokenBody(ids),
      call,
    );
  }

  /**
   * The recent trade prices of a token, newest first (`GET /prices-history`). The gateway
   * walks its trade log backwards and the SDK keeps that order, so the first point is the
   * latest one.
   *
   * @throws {UserInputError} When `limit` is not a whole number from 1 to 500 or an
   *   option is unknown.
   */
  async getPricesHistory(
    options: PricesHistoryOptions,
    call?: CallOptions,
  ): Promise<PricePoint[]> {
    const o = closedObject(options, 'options', ['tokenId', 'limit']);
    const token_id = normalizeTokenId(o.tokenId);
    const limit = readLimit(o.limit);
    const response = await this.publicGet(
      PricesHistorySchema,
      '/prices-history',
      { token_id, fidelity: limit },
      call,
    );
    return response.history;
  }

  // -------------------------------------------------------------------------
  // Build and place
  // -------------------------------------------------------------------------

  /**
   * Builds and signs a limit order, without sending it. The result is deeply frozen, and
   * its `orderHash` is the order's id on the gateway.
   *
   * It reads the market's tick size (`getTickSize`, reused for 5 minutes per token) and
   * checks a GTD expiration against the session's server clock.
   *
   * **Nonce.** The order carries the trader's exchange nonce, read once per client and maker
   * (`CTFExchange.nonces(maker)` through `chain`). The gateway does not check it: after the
   * nonce is incremented on chain, an order built with the cached nonce still rests and
   * matches, then fails at settlement. Call `refreshNonce()` after any nonce increment.
   *
   * @throws {AuthRequiredError} Without a session, or a session without a signer.
   * @throws {UserInputError} For any invalid input, starting with the field name; code
   *   `chain_not_configured` when the client has no `chain`.
   * @throws {XoError} Code `nonce_unavailable` (service `chain`) when the nonce read fails.
   */
  createOrder<P extends string | number, S extends string | number>(
    a: LimitOrderArgs<P, S>,
  ): Promise<SignedOrder> {
    return this.newOrders(() => this.trading.createOrder(a));
  }

  /**
   * Builds and signs a market order (a FAK, or FOK, capped at 0.999 to buy and 0.001 to
   * sell), without sending it. No tick-size lookup is made. Same errors as `createOrder`.
   */
  createMarketOrder<A extends string | number>(
    a: MarketOrderArgs<A>,
  ): Promise<SignedOrder> {
    return this.newOrders(() => this.trading.createMarketOrder(a));
  }

  /**
   * Places a signed order (`POST /order`) with the L2 credentials. The body is exactly
   * `{ order: wire, orderType, postOnly }`.
   *
   * Before sending, the hash is recomputed from `order.order` under this environment's
   * exchange domain and must equal `order.orderHash`, and the wire order is derived again
   * from `order.order` and its signature.
   *
   * **Never retried, never re-signed.** The one resend is the transport's: on a 401 it
   * refreshes the credentials and sends the same bytes once (a 401 means the gateway did
   * not process the order; the signature and HMAC checks run before the engine).
   *
   * Every error from sending it is this call's own copy of the error, of the same class,
   * with `orderHash` and `mayHaveLanded`. The error does not carry the signed
   * order.
   * - `mayHaveLanded: true` (a timeout, a network failure, a status of 500 or more other than
   *   `trading_paused`, a 2xx that could not be read): the order may have been placed, and
   *   may already have filled. **Never resend or re-sign it**: call
   *   `reconcileOrder(error.orderHash)` to find out where it is.
   * - `mayHaveLanded: false` (a 4xx, `trading_paused`, a local error before sending, or a
   *   failure of the credential refresh before sending or after a 401, whatever its status): it was
   *   not placed.
   *
   * On a 200 whose `orderID` is not the local hash, the result is kept, with
   * `orderIdMismatch: true`.
   *
   * An order that did not fill is a **result**, not an error: a FOK or FAK that found no
   * liquidity answers `status: 'delayed'` (or `success: false` with an `errorMsg`). The
   * result is the gateway's answer plus the locally computed `orderHash`.
   *
   * The SDK does not handle duplicates: the same signed order sent again is refused with a
   * 400 `RequestRejectedError` whose only detail is prose, and the SDK never branches on it.
   *
   * @throws {UserInputError} When `order` is not a signed order (before any request).
   * @throws {RequestRejectedError} Status 400 or 422 when the gateway refused the order, and
   *   status 409, such as `order_cancelled_during_hold`.
   * @throws {RequestRejectedError} Status 503, code `trading_paused` (`retryAfter` from `Retry-After`).
   */
  postOrder(order: SignedOrder): Promise<PlaceOrderResult> {
    return this.newOrders(() => this.trading.postOrder(order));
  }

  /**
   * `createOrder` then `postOrder`. An error thrown after signing carries the order's
   * `orderHash` and `mayHaveLanded`, as `postOrder` describes: when `mayHaveLanded` is true,
   * never place it again, call `reconcileOrder(error.orderHash)`.
   *
   * **Nonce.** The order carries the trader's exchange nonce, read once per client and maker
   * (`CTFExchange.nonces(maker)` through `chain`). The gateway does not check it: after the
   * nonce is incremented on chain, an order built with the cached nonce still rests and
   * matches, then fails at settlement. Call `refreshNonce()` after any nonce increment.
   */
  placeOrder<P extends string | number, S extends string | number>(
    a: LimitOrderArgs<P, S>,
  ): Promise<PlaceOrderResult> {
    return this.newOrders(() => this.trading.placeOrder(a));
  }

  /** `createMarketOrder` then `postOrder`, with the same errors as `placeOrder`. */
  placeMarketOrder<A extends string | number>(
    a: MarketOrderArgs<A>,
  ): Promise<PlaceOrderResult> {
    return this.newOrders(() => this.trading.placeMarketOrder(a));
  }

  /**
   * Places signed orders in batches (`POST /orders`): chunks of at most
   * 300 (`MAX_BATCH_PLACE`), sent one after another, never retried. The results come
   * back in input order, one per order, each with the input's `orderHash`; an order the
   * gateway refused has `error` set (a result, not an exception).
   *
   * All the orders are checked before the first chunk is sent. The same signed order twice
   * is refused, because it could fill twice.
   *
   * @throws {BatchPlaceIncompleteError} Code `batch_place_incomplete`, when a chunk fails
   *   (or its answer cannot be paired with the orders sent): it carries the `results` so
   *   far as public order results, the `failedChunk` hashes and the `notSent` hashes
   *   (including the failed chunk when it failed locally before sending). When `mayHaveLanded`
   *   is true the `failedChunk` orders may have been placed and filled: never resend or
   *   re-sign them, reconcile each with `reconcileOrder`. When it is false they were refused.
   *   An answered order whose entry does not say what became of it has no result: it is in
   *   `failedChunk`, with `mayHaveLanded: true`, and the chunk's failure is the `cause`.
   * @throws {UserInputError} For an empty list, a duplicate or a malformed order, before
   *   any request.
   */
  postOrders(orders: readonly SignedOrder[]): Promise<BatchPlaceResult[]> {
    return this.newOrders(() => this.trading.postOrders(orders));
  }

  /**
   * Sends ordered groups of placements and cancels in one request
   * (`POST /orders/batch-ops`, L2). The gateway runs the groups in order and does not undo
   * one when another fails. Never retried: it places orders.
   *
   * @throws {BatchOpsIncompleteError} Code `batch_ops_incomplete`, for any failure of the
   *   request or of pairing its answer, with the place groups' `orderHashes` and no
   *   `results`. When `mayHaveLanded` is true (anything after sending except a 400, a 401 or
   *   `trading_paused`; a 429 can come after earlier groups ran), never resend or re-sign
   *   the orders: reconcile each with `reconcileOrder`.
   * @throws {UserInputError} For malformed ops, before any request.
   */
  batchOps(ops: readonly BatchOp[]): Promise<BatchOpResult[]> {
    const places =
      Array.isArray(ops) &&
      ops.some(
        (op: unknown) =>
          typeof op === 'object' &&
          op !== null &&
          (op as { type?: unknown }).type === 'place',
      );
    return places
      ? this.newOrders(() => this.trading.batchOps(ops))
      : this.trading.batchOps(ops);
  }

  /**
   * @internal From now on, refuses every new order: building or signing one (`createOrder`,
   * `createMarketOrder`) and placing one (`postOrder`, `placeOrder`, `placeMarketOrder`,
   * `postOrders`, a `batchOps` with a place group) reject at once with XoError
   * `session_closed` and `mayHaveLanded: false`. Cancels are not affected. The client
   * facade's `close()` calls it first.
   */
  refuseNewOrders(): void {
    this.refusingOrders = true;
  }

  /** Runs `place`, unless new orders are refused (see `refuseNewOrders`). */
  private newOrders<T>(place: () => Promise<T>): Promise<T> {
    if (this.refusingOrders) {
      const error = new XoError(
        'The client is closing: it places no new orders. Nothing was signed or sent; cancels still go out until its session closes',
        { code: 'session_closed' },
      );
      Object.defineProperty(error, 'mayHaveLanded', {
        value: false,
        enumerable: true,
        configurable: true,
      });
      return Promise.reject(error);
    }
    return place();
  }

  // -------------------------------------------------------------------------
  // Cancel
  // -------------------------------------------------------------------------

  /**
   * Cancels one order (`DELETE /order`) by its hash or legacy numeric id. HMAC (L2) by
   * default. With `signed: true` it signs `CancelOrder(orderId, conditionId)` as the trader
   * and sends no L2 headers; the gateway takes that only for a numeric id, with
   * `conditionId`. Sent once and never retried.
   *
   * **A signed cancel is replayable.** The signature is its only authentication, and it has
   * no expiry and no nonce: whoever holds it can send it again at any time. It is also exactly
   * the signature a signed `cancelOrders` starting with this id carries, so it can be used to
   * cancel any of your orders in that market through the batch route. Prefer the default L2
   * (HMAC) cancel unless you need signed mode.
   *
   * An order held in the taker-delay window is cancelled too (the gateway cancels the held
   * entry first).
   *
   * @throws {RequestRejectedError} Status 404, when the order is not open (neither resting nor held): it may
   *   never have reached the gateway, or it already filled or was cancelled. Use
   *   `reconcileOrder` to tell these apart.
   * @throws {RequestRejectedError} Status 409 `order_in_delay_window`.
   */
  cancelOrder(
    idOrHash: string,
    options?: CancelOrderOptions,
  ): Promise<CancelResult> {
    return this.trading.cancelOrder(idOrHash, options);
  }

  /**
   * Cancels several orders (`DELETE /orders`) by hash or numeric id. HMAC (L2) by default.
   * Ids are sent in canonical form (lower-case hashes, no leading zeros), and the result
   * names them so. `notCanceled[id] = "order not found"` means the order is not open (see
   * `cancelOrder`). Sent once and never retried.
   *
   * With `signed: true` and the `conditionId` of their market, it sends the gateway's signed
   * form instead, with no L2 headers: `{ orderIds, marketId, signature, signatureType,
   * signer }`, the signature being `CancelOrder(first id, conditionId)` as the trader. That
   * form takes numeric ids only (up to 2^53 − 1), at least one, all in that one market: an
   * order of another market is reported in `notCanceled`.
   *
   * **A signed cancel is replayable.** It carries no HMAC: the signature over the first id and
   * the market is its only authentication, and it is the very signature of a signed
   * `cancelOrder(firstId)`. It has no expiry and no nonce, so whoever holds it can send it
   * again, with any list of ids that starts with that id, and cancel any of your orders in
   * that market. Prefer the default L2 (HMAC) cancel unless you need signed mode.
   *
   * @throws {UserInputError} For a bad id or option before any request: with `signed`, a
   *   hash, an id above 2^53 − 1, an empty list or no `conditionId`; without it, a
   *   `conditionId`.
   */
  cancelOrders(
    ids: readonly string[],
    options?: CancelOrderOptions,
  ): Promise<CancelResult> {
    return this.trading.cancelOrders(ids, options);
  }

  /**
   * Cancels every open order of the trader, in every market (`DELETE /cancel-all`). HMAC
   * (L2, empty body) by default. With `signed: true` it signs `CancelAll("")` as the trader
   * and sends `{ signature, signatureType, signer }` with no L2 headers.
   *
   * A signed cancel has no expiry or nonce: whoever holds the signature can replay it.
   * Prefer HMAC unless the L2 credentials are unavailable. Resting orders and orders held
   * in the taker-delay window are cancelled; an
   * order that already filled is not.
   */
  cancelAll(options?: CancelAllOptions): Promise<CancelResult> {
    return this.trading.cancelAll(options);
  }

  /**
   * Cancels every open order of the trader in one market (`DELETE /cancel-market-orders`).
   * HMAC by default; `signed: true` signs `CancelAll(conditionId)`. `tokenId` is sent as
   * `assetId`, but the gateway does not filter by it yet: both outcomes are cancelled.
   */
  cancelMarketOrders(
    options: CancelMarketOrdersOptions,
  ): Promise<CancelResult> {
    return this.trading.cancelMarketOrders(options);
  }

  /**
   * Forgets the cached exchange nonces, so the next order reads `CTFExchange.nonces(maker)`
   * again. Call it after incrementing the nonce on chain (which invalidates every order
   * signed with the old one).
   */
  refreshNonce(): void {
    this.trading.refreshNonce();
  }

  // -------------------------------------------------------------------------
  // Heartbeat (opt-in dead-man switch)
  // -------------------------------------------------------------------------

  /**
   * Starts the heartbeat, a dead-man switch for market makers: **strictly opt-in**. The SDK
   * never sends a heartbeat unless you call this method.
   *
   * It sends `POST /v1/heartbeats` (L2 HMAC over that exact path, empty body) at once and then
   * every `intervalMs` (1000 to 20000, default 10000).
   *
   * **Read this before you call it. A single valid heartbeat opts the WHOLE ACCOUNT into
   * auto-cancel.** The gateway keeps one last-seen time per account (the user the API key
   * belongs to), not per bot, process or key. Once an account has one, the gateway cancels
   * **every open order of the account, in every market, placed by any bot or any of its
   * API keys**, if no valid heartbeat arrives for 30 s. It
   * sweeps every 5 s, so the cancel lands 30 to 35 s after the last heartbeat. That window is
   * nominal: the sweep cancels the stale accounts one after another, so on a busy gateway
   * yours can come later. A second bot on the same account that never calls this is
   * cancelled too, when this one stops.
   *
   * **`stop()` does not opt out.** It only stops sending. The account stays opted in for the
   * rest of that window, so its open orders are cancelled about 30 s after the last
   * heartbeat, including orders you place after `stop()`. To end a session, cancel on
   * purpose (`cancelAll()`) rather than by silence. Even so, `cancelAll()` does **not**
   * clear the account's entry: it cancels what is open now, but the countdown from the last
   * heartbeat keeps running, and an order you place in the 30 to 35 s after that heartbeat
   * is still swept.
   *
   * Can the account get out of the opt-in? The gateway has no route for it: only the two
   * heartbeat routes write the tracker. In practice it ends in three ways, none of which
   * you should rely on: (1) when the 30 s countdown fires, the sweep removes the account's
   * entry **before** it cancels, so after that one auto-cancel the
   * account is untracked again and orders placed later are not protected until the next
   * valid heartbeat; (2) the tracker is in memory only, so a gateway restart forgets it;
   * (3) it holds at most 50000 accounts and drops the oldest first, without cancelling.
   * The tracker also belongs to one gateway process: if the
   * gateway runs several replicas, a heartbeat registers only on the replica that handled it.
   *
   * **A miss.** The gateway answers 200 even to an unauthenticated or mis-signed heartbeat,
   * with `tracked: false`, which silently leaves the account unprotected. The SDK treats
   * that as a miss and calls `onMissed(error)` with code `heartbeat_not_tracked`; it never
   * counts as success. So does an answer that cannot be read as `{ tracked: boolean }`
   * (same code, the parse error as `cause`). A transport or HTTP failure is a miss too and
   * `onMissed` gets that error, and so does a beat that outlives its deadline (the request
   * timeout plus 1000 ms; a `TimeoutError`, the request is aborted and the next tick sends a
   * new beat). Every missed beat is reported, the loop keeps going, and `onMissed` is never
   * fatal (if it throws, the error is swallowed). Treat `onMissed` as an alarm: if misses go
   * on for 30 s the gateway has already cancelled your orders, so stop quoting.
   *
   * **No automatic recovery from bad credentials.** Because the gateway answers 200
   * `tracked: false` and not 401, the transport's credential refresh never runs for a
   * heartbeat. A rotated, revoked or expired key therefore produces a `heartbeat_not_tracked`
   * miss on every beat until you act: `stop()`, fix the session's credentials, and start
   * again.
   *
   * **Process lifetime.** The timers are `unref()`ed: a heartbeat never keeps the process
   * alive. When the process exits or dies, the heartbeats stop and the gateway cancels the
   * orders 30 to 35 s later. The same happens if the event loop is blocked, or the machine
   * suspended, for longer than 30 s minus `intervalMs` (20 s by default).
   *
   * **Scheduling.** A chain of `setTimeout`s, not `setInterval`; requests never overlap (a
   * tick that finds one in flight is skipped). Each request has a timeout of
   * `min(intervalMs, 5000)` ms and carries no body. It is never retried: the next beat is
   * the retry. The one resend that exists is the transport's single credential refresh after
   * a 401, with the same bytes, which a heartbeat does not trigger in practice (see above).
   * The loop belongs to this client: a second call while one is running throws.
   *
   * @throws {AuthRequiredError} When the client has no session, or its session has neither a
   *   signer nor `credentials.orderbook` (a read-only client): no heartbeat could register, so
   *   none is started.
   * @throws {XoError} code `session_closed` when the session is closed.
   * @throws {UserInputError} When `intervalMs` is not a whole number from 1000 to 20000,
   *   an option is unknown or `onMissed` is not a function; code `heartbeat_already_running`
   *   when a heartbeat is already running on this client (call `stop()` first).
   */
  startHeartbeat(options?: HeartbeatOptions): HeartbeatHandle {
    return this.heartbeats.start(options);
  }

  /**
   * @internal Sends one heartbeat (`POST /v1/heartbeats`, L2 HMAC over that path, empty body)
   * and returns the gateway's answer, never retried. `tracked: false` means the beat did not
   * register (see `startHeartbeat`). It opts the account in to the auto-cancel as a running
   * heartbeat does.
   */
  sendHeartbeat(): Promise<HeartbeatResponse> {
    return this.heartbeats.send();
  }

  /**
   * @internal Stops the heartbeat running on this client, if any, as its handle's `stop()`
   * does (it does not opt the account out). The secure client's `close()` calls it.
   */
  stopHeartbeat(): void {
    this.heartbeats.stop();
  }

  // -------------------------------------------------------------------------
  // Own data (L2)
  // -------------------------------------------------------------------------

  /**
   * The trader's resting orders (`GET /data/orders`), page by page with `next_cursor`.
   * Lazy; the identity is the L2 credentials, so no `maker` is ever sent. `cursor` starts the
   * walk at a `next_cursor` a page gave out instead of at the first page.
   *
   * @throws {UserInputError} At once, for an unknown option or a bad id.
   */
  getOpenOrders(
    options?: OpenOrdersOptions,
    call?: CallOptions,
    cursor?: string,
  ): Paginator<OpenOrder> {
    return this.account.getOpenOrders(options, call, cursor);
  }

  /**
   * One of the trader's **open** orders by hash or numeric id (`GET /data/order/{id}`):
   * resting on the book, or (by hash) held in the taker-delay window, which the gateway
   * reports as `LIVE`. An order that filled, was killed or was cancelled is a 404. To find
   * out what happened to a placed order, use `reconcileOrder`.
   *
   * @throws {RequestRejectedError} Status 404, when it is not open, or is not the trader's.
   */
  getOrder(idOrHash: string, call?: CallOptions): Promise<OpenOrder> {
    return this.account.getOrder(idOrHash, call);
  }

  /**
   * Finds out what happened to an order that may have been placed, typically after an
   * error with `mayHaveLanded: true`: first `getOrder(orderHash)` (resting, or held in the
   * taker-delay window), then the trader's own trades, newest first, for a trade where it
   * was the taker
   * (`taker_order_id`) or a maker (`maker_orders[].order_id`), at most `maxTradePages`
   * pages (default 3).
   *
   * `'not_found'` is **not proof that the order was not placed**: the placement request may
   * still be in flight (one that timed out here can reach the gateway later), or the order
   * traded before the pages scanned. Check again later. Never resend or re-sign an order
   * whose placement may have landed. Trades are de-duplicated by id.
   *
   * @throws {UserInputError} When `orderHash` is not a hash or an option is invalid.
   */
  reconcileOrder(
    orderHash: string,
    options?: ReconcileOptions,
    call?: CallOptions,
  ): Promise<ReconcileResult> {
    return this.account.reconcileOrder(orderHash, options, call);
  }

  /**
   * The trader's trades, newest first (`GET /data/trades`), page by page with
   * `next_cursor`. Lazy. The gateway lists the latest 500 trades at most. `cursor` starts the
   * walk at a `next_cursor` a page gave out instead of at the first page.
   */
  getTrades(
    options?: TradesOptions,
    call?: CallOptions,
    cursor?: string,
  ): Paginator<Trade> {
    return this.account.getTrades(options, call, cursor);
  }

  /**
   * One trade by id (`GET /trades/{id}`), for polling its settlement status.
   *
   * @throws {RequestRejectedError} Status 404, when the gateway does not know it.
   */
  getTrade(id: string, call?: CallOptions): Promise<Trade> {
    return this.account.getTrade(id, call);
  }

  /**
   * The trader's USDC balance (`'COLLATERAL'`) or shares of one token (`'CONDITIONAL'`), in
   * micro-units (`GET /balance-allowance`). `allowance` is always `"0"`: the on-chain
   * allowance needs a chain read.
   */
  getBalanceAllowance(
    options: BalanceAllowanceOptions,
    call?: CallOptions,
  ): Promise<BalanceAllowance> {
    return this.account.getBalanceAllowance(options, call);
  }

  /**
   * The trader's cash and token positions, in micro-units (`GET /positions`). The route
   * takes `address`, so the session's trading address is sent (the smart wallet, for a
   * smart wallet).
   *
   * @throws {AuthRequiredError} Without a session with a signer.
   */
  getPositions(call?: CallOptions): Promise<Positions> {
    return this.account.getPositions(call);
  }

  /** The trader's redeemable positions of resolved or voided markets (`GET /claimable`). */
  getClaimable(call?: CallOptions): Promise<Claimable> {
    return this.account.getClaimable(call);
  }

  /**
   * What the trader can still commit in one market (`GET /data/market-capacity`): free
   * micro-USDC for a BUY and, per outcome, the free shares for a SELL.
   */
  getMarketCapacity(
    conditionId: ConditionId | string,
    call?: CallOptions,
  ): Promise<MarketCapacity> {
    return this.account.getMarketCapacity(conditionId, call);
  }
}
