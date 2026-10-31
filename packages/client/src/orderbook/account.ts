// The orderbook client's own-data part: the authenticated reads of the caller's
// orders, trades, balances and positions. `OrderbookClient` (client.ts) delegates to it; the
// public JSDoc lives there.
//
// Every read carries the L2 (HMAC) credentials, which the gateway takes as the identity, and
// none sends a `maker` or `address` parameter (the gateway's legacy, unauthenticated
// fallbacks), except `/positions`: its query requires `address`, and
// the SDK sends the session's own trading address, never a caller-supplied one.

import { isRejected, UserInputError } from '../core/errors';
import { normalizeConditionId, normalizeTokenId } from '../core/ids';
import { cursorPaginator, type Paginator } from '../core/paginate';
import type { CallOptions } from '../core/requestOptions';
import type { DualSchema } from '../core/schema';
import type { TransportRequest } from '../core/transport';
import {
  closedObject,
  type OrderbookDeps,
  readOrderRef,
  requireSession,
} from './internal';
import {
  type BalanceAllowance,
  BalanceAllowanceSchema,
  type Claimable,
  ClaimableSchema,
  type CursorPage,
  type MarketCapacity,
  MarketCapacitySchema,
  type OpenOrder,
  OpenOrderSchema,
  OpenOrdersPageSchema,
  type Positions,
  PositionsSchema,
  type Trade,
  TradeSchema,
  TradesPageSchema,
} from './schemas';

/** The options of `getOpenOrders`. */
export interface OpenOrdersOptions {
  /** Only orders in this market (`market`). */
  conditionId?: string;
  /** Only orders on this outcome token (`asset_id`). */
  tokenId?: string;
}

/** The options of `getTrades`. */
export interface TradesOptions {
  /** Only trades in this market (`market`). */
  conditionId?: string;
}

/** `'COLLATERAL'` is the USDC balance, `'CONDITIONAL'` the shares of one token. */
export type AssetType = 'COLLATERAL' | 'CONDITIONAL';

/** The options of `getBalanceAllowance`. */
export interface BalanceAllowanceOptions {
  assetType: AssetType;
  /** Required for `'CONDITIONAL'`, refused for `'COLLATERAL'`. */
  tokenId?: string;
}

/** The options of `reconcileOrder`. */
export interface ReconcileOptions {
  /** How many pages of the trader's trades (newest first) to scan: 1 to 100, default 3. */
  maxTradePages?: number;
}

/**
 * Where a placed (or possibly placed) order is:
 * - `'resting'`: open: on the book, possibly partly filled (`order.size_matched`), or held
 *   in the taker-delay window before it matches (reported `LIVE`; the gateway's lookup by
 *   hash falls back to the held queue). Both can be
 *   cancelled.
 * - `'traded'`: no longer open, but it traded: filled, or partly filled with the rest
 *   killed (FOK, FAK) or cancelled. `trades` are the trades found in the pages scanned.
 * - `'not_found'`: neither, as far as the lookups reached. **Not proof that it was not
 *   placed**: the placement request may still be in flight (a request that timed out here
 *   can reach the gateway later), or the order traded before the pages scanned. Check
 *   again later; never resend or re-sign it on the strength of a `not_found`.
 */
export type ReconcileResult =
  | { state: 'resting'; order: OpenOrder }
  | { state: 'traded'; trades: Trade[] }
  | { state: 'not_found' };

const ORDER_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const TRADE_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const DEFAULT_TRADE_PAGES = 3;
const MAX_TRADE_PAGES = 100;

export class Account {
  readonly #deps: OrderbookDeps;

  constructor(deps: OrderbookDeps) {
    this.#deps = deps;
  }

  getOpenOrders(
    options: OpenOrdersOptions = {},
    call?: CallOptions,
    cursor?: string,
  ): Paginator<OpenOrder> {
    const o = closedObject(options, 'options', ['conditionId', 'tokenId']);
    const market =
      o.conditionId === undefined
        ? undefined
        : normalizeConditionId(o.conditionId, 'conditionId');
    const asset_id =
      o.tokenId === undefined ? undefined : normalizeTokenId(o.tokenId);
    return this.#pages(
      OpenOrdersPageSchema,
      '/data/orders',
      { market, asset_id },
      call,
      cursor,
    );
  }

  async getOrder(idOrHash: string, call?: CallOptions): Promise<OpenOrder> {
    const ref = readOrderRef(idOrHash, 'idOrHash');
    return this.#read(OpenOrderSchema, `/data/order/${ref}`, undefined, call);
  }

  async reconcileOrder(
    orderHash: string,
    options: ReconcileOptions = {},
    call?: CallOptions,
  ): Promise<ReconcileResult> {
    if (typeof orderHash !== 'string' || !ORDER_HASH_PATTERN.test(orderHash)) {
      throw new UserInputError(
        'orderHash must be an order hash: 0x and 64 hex characters',
      );
    }
    const hash = orderHash.toLowerCase();
    const o = closedObject(options, 'options', ['maxTradePages']);
    const maxPages =
      o.maxTradePages === undefined ? DEFAULT_TRADE_PAGES : o.maxTradePages;
    if (
      typeof maxPages !== 'number' ||
      !Number.isInteger(maxPages) ||
      maxPages < 1 ||
      maxPages > MAX_TRADE_PAGES
    ) {
      throw new UserInputError(
        `maxTradePages must be a whole number from 1 to ${MAX_TRADE_PAGES}`,
      );
    }
    // 1. Open? `/data/order/{id}` looks in the books, then in the taker-delay held queue.
    try {
      return { state: 'resting', order: await this.getOrder(hash, call) };
    } catch (error) {
      if (!isRejected(error, 404)) {
        throw error;
      }
    }
    // 2. Traded? The trader's trades, newest first, as taker or maker.
    const matches = (trade: Trade) =>
      trade.taker_order_id.toLowerCase() === hash ||
      trade.maker_orders.some((m) => m.order_id.toLowerCase() === hash);
    // Pages are separate snapshots: a trade added meanwhile shifts the list, so the same
    // trade can show up on two pages. Each trade is kept once, by id.
    const trades: Trade[] = [];
    const seen = new Set<string>();
    let pages = 0;
    for await (const page of this.getTrades({}, call).pages()) {
      for (const trade of page.items) {
        const id = trade.id.toLowerCase();
        if (matches(trade) && !seen.has(id)) {
          seen.add(id);
          trades.push(trade);
        }
      }
      pages += 1;
      if (pages >= maxPages) {
        break;
      }
    }
    return trades.length > 0
      ? { state: 'traded', trades }
      : { state: 'not_found' };
  }

  getTrades(
    options: TradesOptions = {},
    call?: CallOptions,
    cursor?: string,
  ): Paginator<Trade> {
    const o = closedObject(options, 'options', ['conditionId']);
    const market =
      o.conditionId === undefined
        ? undefined
        : normalizeConditionId(o.conditionId, 'conditionId');
    return this.#pages(
      TradesPageSchema,
      '/data/trades',
      { market },
      call,
      cursor,
    );
  }

  async getTrade(id: string, call?: CallOptions): Promise<Trade> {
    if (typeof id !== 'string' || !TRADE_ID_PATTERN.test(id)) {
      throw new UserInputError(
        'id must be a trade id: 0x and 64 hex characters',
      );
    }
    return this.#read(
      TradeSchema,
      `/trades/${id.toLowerCase()}`,
      undefined,
      call,
    );
  }

  async getBalanceAllowance(
    options: BalanceAllowanceOptions,
    call?: CallOptions,
  ): Promise<BalanceAllowance> {
    const o = closedObject(options, 'options', ['assetType', 'tokenId']);
    const assetType = o.assetType;
    if (assetType !== 'COLLATERAL' && assetType !== 'CONDITIONAL') {
      throw new UserInputError(
        "assetType must be 'COLLATERAL' or 'CONDITIONAL'",
      );
    }
    if (assetType === 'CONDITIONAL' && o.tokenId === undefined) {
      throw new UserInputError(
        "tokenId is required when assetType is 'CONDITIONAL'",
      );
    }
    if (assetType === 'COLLATERAL' && o.tokenId !== undefined) {
      throw new UserInputError(
        "tokenId is only for assetType 'CONDITIONAL' (the gateway ignores it for COLLATERAL)",
      );
    }
    const token_id =
      o.tokenId === undefined ? undefined : normalizeTokenId(o.tokenId);
    return this.#read(
      BalanceAllowanceSchema,
      '/balance-allowance',
      { asset_type: assetType, token_id },
      call,
    );
  }

  async getPositions(call?: CallOptions): Promise<Positions> {
    const identity = await requireSession(this.#deps).identity();
    return this.#read(
      PositionsSchema,
      '/positions',
      { address: identity.address.toLowerCase() },
      call,
    );
  }

  async getClaimable(call?: CallOptions): Promise<Claimable> {
    return this.#read(ClaimableSchema, '/claimable', undefined, call);
  }

  async getMarketCapacity(
    conditionId: string,
    call?: CallOptions,
  ): Promise<MarketCapacity> {
    const market = normalizeConditionId(conditionId);
    return this.#read(
      MarketCapacitySchema,
      '/data/market-capacity',
      { market },
      call,
    );
  }

  /** One authenticated GET. GETs are retried like any read (or as the call says). */
  #read<T>(
    schema: DualSchema<T>,
    path: string,
    query: TransportRequest['query'],
    call: CallOptions | undefined,
  ): Promise<T> {
    return this.#deps.send(schema, {
      method: 'GET',
      path,
      query,
      auth: 'orderbook',
      call,
    });
  }

  /**
   * A paginated authenticated GET, walked with the gateway's `next_cursor`, from `first` (a
   * cursor a page gave out) or from the first page.
   */
  #pages<T>(
    schema: DualSchema<CursorPage<T>>,
    path: string,
    query: Record<string, string | undefined>,
    call: CallOptions | undefined,
    first: string | undefined,
  ): Paginator<T> {
    return cursorPaginator(async (cursor) => {
      const page = await this.#read(
        schema,
        path,
        { ...query, next_cursor: cursor },
        call,
      );
      return { data: page.data, next_cursor: page.next_cursor, raw: page };
    }, first);
  }
}
