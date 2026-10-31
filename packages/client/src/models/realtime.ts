import type { Address } from 'viem';
import type { XoError } from '../core/errors';
import type { ConditionId, DecimalString, TokenId } from '../core/types';
import type {
  PortfolioMarket as RawPortfolioMarket,
  PortfolioPosition as RawPortfolioPosition,
} from '../data/portfolioSchemas';
import type {
  BookEvent as RawBookEvent,
  BookLevel as RawBookLevel,
  LastTradePriceEvent as RawLastTradePriceEvent,
  OrderEvent as RawOrderEvent,
  PriceChangeEvent as RawPriceChangeEvent,
  TradeEvent as RawTradeEvent,
} from '../realtime/orderbookFrames';
import type {
  MarketActivitySnapshotEvent as RawActivitySnapshot,
  PortfolioSnapshotEvent as RawPortfolioSnapshot,
} from '../realtime/socketioEvents';
import { type Position, toPosition, toPositions } from './account';
import {
  addressOf,
  conditionIdOf,
  isoFromSeconds,
  tokenIdOf,
  unexpectedField,
} from './convert';
import type { OrderSide, OrderType } from './enums';
import { type MarketTrade, toMarketTrade } from './marketData';
import type { PriceLevel } from './orderBook';
import type { TraderSide, TradeStatus } from './trades';

// The events a subscription delivers, one family per topic, and the handle that delivers them.
// Every event names its `topic` and its `type`, so a `switch` on either narrows it. Field names
// are camelCase, times are Unix milliseconds, and a value the source does not give is `null`.

// ---------------------------------------------------------------------------
// The handle
// ---------------------------------------------------------------------------

/** A topic of a subscription: `'market'`, `'user'`, `'portfolio'` or `'activity'`. */
export type SubscriptionTopic = 'market' | 'user' | 'portfolio' | 'activity';

/** What a `'reconnected'` listener of a {@link SubscriptionHandle} receives. */
export type ReconnectedInfo = {
  /** The topic whose connection came back. */
  topic: SubscriptionTopic;
};

/**
 * A live subscription: iterate it with `for await` to read its events, and close it when you
 * are done. The events of every topic it was opened with arrive in one stream, in the order
 * they arrived.
 *
 * **The loop sees events only, never gaps.** A stream does not replay what it missed while it
 * was down. Listen with {@link SubscriptionHandle.on} too: `'reconnected'` says the connection
 * of a topic came back and its events in between are gone, and `'error'` says something went
 * wrong that the stream survived, such as `ws_events_dropped` (the service fell behind). Both
 * name the topic (`info.topic`, `error.topic`): read the state of the topic named again over
 * REST, such as `fetchOrderBooks` for `market` and `listOpenOrders` for `user`. The error
 * `subscription_overflow` (the loop read too slowly and old events were dropped) is about the
 * whole handle and names no topic: read the state of every topic again.
 *
 * The first loop gets every event since `subscribe` resolved, up to 10,000 waiting events; a
 * later loop gets the events from when it starts. Breaking out of a loop stops that loop only:
 * the subscription stays open, and keeps the process alive, until {@link SubscriptionHandle.close}.
 * A topic whose stream stops for good reports why on `'error'` and the others go on; when every
 * topic has stopped, the handle closes.
 *
 * @example
 * const handle = await client.subscribe([{ topic: 'market', assetIds: [assetId] }]);
 * handle.on('reconnected', ({ topic }) => console.log(`${topic} is back: read it again`));
 * try {
 *   for await (const event of handle) {
 *     console.log(event.type, event.timestamp);
 *   }
 * } finally {
 *   await handle.close();
 * }
 */
export interface SubscriptionHandle<E> extends AsyncIterable<E> {
  /**
   * Stops every stream of the subscription and closes its connections. A loop over it ends, and
   * `'closed'` is emitted once the connections are closed. Calling it again returns the same
   * promise, and it never rejects.
   *
   * @example
   * await handle.close();
   */
  close(): Promise<void>;

  /**
   * Listens for the connection of a topic that came back after a drop. Its events in between
   * are gone: read the state of the topic named again. Returns a function that removes the
   * listener.
   *
   * @param type - `'reconnected'`.
   * @param listener - Called once per reconnect, with the topic that reconnected.
   * @example
   * const stop = handle.on('reconnected', ({ topic }) => console.log(`${topic} reconnected`));
   * stop();
   */
  on(
    type: 'reconnected',
    listener: (info: ReconnectedInfo) => void,
  ): () => void;
  /**
   * Listens for something that went wrong; the error's `code` says what (see the realtime codes
   * of the errors page), and its `topic` which topic it is about (`undefined` for
   * `subscription_overflow`, which is about the whole handle). The stream goes on, except a
   * topic that stopped for good, which the message says. Returns a function that removes the
   * listener.
   *
   * @param type - `'error'`.
   * @param listener - Called with each error.
   * @example
   * handle.on('error', (error) => console.log(error.topic, error.code, error.message));
   */
  on(type: 'error', listener: (error: XoError) => void): () => void;
  /**
   * Listens for the end of the subscription: it closed, by {@link SubscriptionHandle.close},
   * by the client closing it, or because every stream of it stopped for good. A listener added
   * after the end is called once, soon after. Returns a function that removes the listener.
   *
   * @param type - `'closed'`.
   * @param listener - Called once.
   * @example
   * handle.on('closed', () => console.log('closed'));
   */
  on(type: 'closed', listener: () => void): () => void;
}

// ---------------------------------------------------------------------------
// The market topic
// ---------------------------------------------------------------------------

/**
 * `book`: the whole order book of one outcome token. One comes for each token when the
 * subscription opens and after every reconnect, and another after every placement, cancel and
 * fill in the market, so a book kept from these events heals itself on the next one. Replace
 * what you hold with each one.
 *
 * Both sides are listed with the best price last, as in `fetchOrderBook`: the best bid is
 * `bids.at(-1)` and the best ask is `asks.at(-1)`.
 */
export type MarketBookEvent = {
  /** `'market'`. */
  topic: 'market';
  /** `'book'`. */
  type: 'book';
  /** The outcome token the book is for. */
  assetId: TokenId;
  /** The id of the market the token belongs to. */
  market: ConditionId;
  /** The buy orders, lowest price first, so the best bid is the last level. */
  bids: PriceLevel[];
  /** The sell orders, highest price first, so the best ask is the last level. */
  asks: PriceLevel[];
  /** A short fingerprint of the book that changes when the book does. */
  hash: string;
  /** When the book was read, in Unix milliseconds. */
  timestamp: number;
};

/** One price level that changed, in a {@link PriceChangeEvent}. */
export type PriceChange = {
  /** The outcome token whose book changed. */
  assetId: TokenId;
  /** The price of the level, in dollars between 0 and 1, such as `"0.55"`. */
  price: DecimalString;
  /** The shares resting at this price now; `"0"` when the level is gone. */
  size: DecimalString;
  /** The side of the book the level is on. */
  side: OrderSide;
  /** The fingerprint of the token's book after the change. */
  hash: string;
  /** The best bid after the change. `null` when there is none. */
  bestBid: DecimalString | null;
  /** The best ask after the change. `null` when there is none. */
  bestAsk: DecimalString | null;
};

/**
 * `price_change`: price levels of a market changed after a placement or a cancel, one entry per
 * level. With `assetIds`, only the entries of those tokens are kept.
 */
export type PriceChangeEvent = {
  /** `'market'`. */
  topic: 'market';
  /** `'price_change'`. */
  type: 'price_change';
  /** The id of the market. */
  market: ConditionId;
  /** The levels that changed. */
  priceChanges: PriceChange[];
  /** When the change happened, in Unix milliseconds. */
  timestamp: number;
};

/** `last_trade_price`: a fill, seen from the side of the order that took the liquidity. */
export type LastTradePriceEvent = {
  /** `'market'`. */
  topic: 'market';
  /** `'last_trade_price'`. */
  type: 'last_trade_price';
  /** The outcome token the taker traded. */
  assetId: TokenId;
  /** The id of the market. */
  market: ConditionId;
  /** The taker's effective price, in dollars between 0 and 1. */
  price: DecimalString;
  /** The taker's side. */
  side: OrderSide;
  /** The shares that changed hands. */
  size: DecimalString;
  /** The fee rate of the fill, in basis points. */
  feeRateBps: DecimalString;
  /** When the fill happened, in Unix milliseconds. */
  timestamp: number;
};

/** An event of the `market` topic; narrow it with `type`. */
export type MarketTopicEvent =
  | MarketBookEvent
  | PriceChangeEvent
  | LastTradePriceEvent;

// ---------------------------------------------------------------------------
// The user topic
// ---------------------------------------------------------------------------

/**
 * What happened to an order, in an {@link UserOrderEvent}:
 *
 * - `PLACEMENT`: the order rests on the book.
 * - `UPDATE`: some of it filled (`status: 'MATCHED'` once all of it has).
 * - `CANCELLATION`: it was cancelled: by you, by a mass cancel, by its expiry or by the market
 *   closing.
 * - `REJECTED`: it was refused before it rested, so it has no id.
 *
 * A kind added later reads as its own string.
 */
export type UserOrderEventKind =
  | 'PLACEMENT'
  | 'UPDATE'
  | 'CANCELLATION'
  | 'REJECTED'
  | (string & {});

/**
 * `order`: one of the account's orders changed. A field that the `kind` does not carry is
 * `null`.
 */
export type UserOrderEvent = {
  /** `'user'`. */
  topic: 'user';
  /** `'order'`. */
  type: 'order';
  /** What happened to the order. */
  kind: UserOrderEventKind;
  /** The order's id. `null` for `REJECTED`. */
  orderId: string | null;
  /** The outcome token the order is for. `null` for `REJECTED`. */
  assetId: TokenId | null;
  /** The id of the market. */
  market: ConditionId;
  /** Whether the order buys or sells. `null` for `REJECTED`. */
  side: OrderSide | null;
  /** The limit price, in dollars between 0 and 1. `null` for `REJECTED`. */
  price: DecimalString | null;
  /** The outcome the order is for, `YES` or `NO`. `null` for `REJECTED`. */
  outcome: 'YES' | 'NO' | (string & {}) | null;
  /** The shares the order was placed for. Given for `PLACEMENT` and `UPDATE`. */
  originalSize: DecimalString | null;
  /** The shares that have filled so far. Given for `PLACEMENT` and `UPDATE`. */
  sizeMatched: DecimalString | null;
  /**
   * Where the order is: `LIVE` while some of it rests, `MATCHED` once all of it filled,
   * `CANCELED`, or `REJECTED`. A status added later reads as its own string.
   */
  status: 'LIVE' | 'MATCHED' | 'CANCELED' | 'REJECTED' | (string & {});
  /** How long the order lives. Given for `PLACEMENT`. */
  orderType: OrderType | null;
  /** When the order expires, as an ISO 8601 time. `null` when it does not, or for another kind. */
  expiration: string | null;
  /** Why the order was refused. Given for `REJECTED`. */
  reason: string | null;
  /** The address that trades: the smart wallet, when one trades. */
  owner: Address;
  /** The address that signed the order. */
  makerAddress: Address;
  /** When it happened, in Unix milliseconds. */
  timestamp: number;
};

/**
 * `trade`: a fill the account took part in, then each step of its settlement. The first event
 * of a trade (`status: 'MATCHED'`) describes the fill; the later ones carry its id, market and
 * new status only, so their other fields are `null`.
 */
export type UserTradeEvent = {
  /** `'user'`. */
  topic: 'user';
  /** `'trade'`. */
  type: 'trade';
  /** The trade's id. */
  id: string;
  /** The id of the market. */
  market: ConditionId;
  /** Where the trade is in its settlement. `FAILED` means the fill was undone. */
  status: TradeStatus;
  /** The outcome token the taker traded. Given for `MATCHED`. */
  assetId: TokenId | null;
  /** The taker's side. Given for `MATCHED`. */
  side: OrderSide | null;
  /** The outcome the taker traded, `YES` or `NO`. Given for `MATCHED`. */
  outcome: 'YES' | 'NO' | (string & {}) | null;
  /** The taker's effective price, in dollars between 0 and 1. Given for `MATCHED`. */
  price: DecimalString | null;
  /** The shares that changed hands. Given for `MATCHED`. */
  size: DecimalString | null;
  /** The fee rate of the fill, in basis points. Given for `MATCHED`. */
  feeRateBps: DecimalString | null;
  /** Whether the account was the maker or the taker. Given for `MATCHED`. */
  traderSide: TraderSide | null;
  /** The id of the order that took the liquidity. Given for `MATCHED`. */
  takerOrderId: string | null;
  /** The id of the resting order it filled. Given for `MATCHED`. */
  makerOrderId: string | null;
  /** The address of the maker. Given for `MATCHED`. */
  makerAddress: Address | null;
  /**
   * How the two orders met: `COMPLEMENTARY` (a buy and a sell of one token), `MINT` (two buys of
   * opposite tokens) or `MERGE` (two sells of opposite tokens). Given for `MATCHED`.
   */
  matchType: 'COMPLEMENTARY' | 'MINT' | 'MERGE' | (string & {}) | null;
  /** When it happened, in Unix milliseconds. */
  timestamp: number;
};

/** An event of the `user` topic; narrow it with `type`. */
export type UserEvent = UserOrderEvent | UserTradeEvent;

// ---------------------------------------------------------------------------
// The portfolio and activity topics
// ---------------------------------------------------------------------------

/**
 * `positions`: the account's positions each time they change (and once when the subscription
 * opens): the positions `listPositions` lists, in the first 100 markets of the account (all of
 * them for an account in fewer markets). Replace what you hold with each one.
 */
export type PortfolioEvent = {
  /** `'portfolio'`. */
  topic: 'portfolio';
  /** `'positions'`. */
  type: 'positions';
  /** The positions. */
  positions: Position[];
  /** When XO built the list, in Unix milliseconds. */
  timestamp: number;
};

/**
 * `trades`: the newest fills of one market, up to 50, newest first, each time it trades (and
 * once when the subscription opens). Replace what you hold with each one.
 */
export type ActivityEvent = {
  /** `'activity'`. */
  topic: 'activity';
  /** `'trades'`. */
  type: 'trades';
  /** XO's id for the market (the `id` of a `Market`). */
  marketId: string;
  /** The fills, newest first. */
  trades: MarketTrade[];
  /** When XO built the list, in Unix milliseconds. */
  timestamp: number;
};

/** Any event a subscription delivers. */
export type SubscriptionEvent =
  | MarketTopicEvent
  | UserEvent
  | PortfolioEvent
  | ActivityEvent;

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

/** `""` (the source's "none") as `null`. */
const priceOrNull = (value: string): DecimalString | null =>
  value === '' ? null : value;

const levelOf = (level: RawBookLevel): PriceLevel => ({
  price: level.price,
  size: level.size,
});

/**
 * Maps a `book` event of the market channel. The source lists the best level of each side
 * first; the model lists it last, so the lists are reversed.
 *
 * @internal
 */
export function toMarketBookEvent(raw: RawBookEvent): MarketBookEvent {
  return {
    topic: 'market',
    type: 'book',
    assetId: tokenIdOf(raw.asset_id),
    market: conditionIdOf(raw.market),
    bids: raw.bids.map(levelOf).reverse(),
    asks: raw.asks.map(levelOf).reverse(),
    hash: raw.hash,
    timestamp: raw.timestamp,
  };
}

/**
 * Maps a `price_change` event of the market channel, keeping the entries `keep` accepts.
 * `undefined` when it keeps none.
 *
 * @internal
 */
export function toPriceChangeEvent(
  raw: RawPriceChangeEvent,
  keep: (assetId: TokenId) => boolean = () => true,
): PriceChangeEvent | undefined {
  const priceChanges = raw.price_changes
    .map(
      (change): PriceChange => ({
        assetId: tokenIdOf(change.asset_id),
        price: change.price,
        size: change.size,
        side: change.side as OrderSide,
        hash: change.hash,
        bestBid: priceOrNull(change.best_bid),
        bestAsk: priceOrNull(change.best_ask),
      }),
    )
    .filter((change) => keep(change.assetId));
  if (priceChanges.length === 0) {
    return undefined;
  }
  return {
    topic: 'market',
    type: 'price_change',
    market: conditionIdOf(raw.market),
    priceChanges,
    timestamp: raw.timestamp,
  };
}

/**
 * Maps a `last_trade_price` event of the market channel.
 *
 * @internal
 */
export function toLastTradePriceEvent(
  raw: RawLastTradePriceEvent,
): LastTradePriceEvent {
  return {
    topic: 'market',
    type: 'last_trade_price',
    assetId: tokenIdOf(raw.asset_id),
    market: conditionIdOf(raw.market),
    price: raw.price,
    side: raw.side as OrderSide,
    size: raw.size,
    feeRateBps: raw.fee_rate_bps,
    timestamp: raw.timestamp,
  };
}

/**
 * Maps an `order` event of the user channel.
 *
 * @internal
 */
export function toUserOrderEvent(raw: RawOrderEvent): UserOrderEvent {
  const base = {
    topic: 'user' as const,
    type: 'order' as const,
    kind: raw.kind,
    market: conditionIdOf(raw.market),
    status: raw.status,
    owner: addressOf(raw.owner),
    makerAddress: addressOf(raw.maker_address),
    timestamp: raw.timestamp,
  };
  if (raw.kind === 'REJECTED') {
    return {
      ...base,
      orderId: null,
      assetId: null,
      side: null,
      price: null,
      outcome: null,
      originalSize: null,
      sizeMatched: null,
      orderType: null,
      expiration: null,
      reason: raw.reason,
    };
  }
  const order = {
    ...base,
    orderId: raw.id,
    assetId: tokenIdOf(raw.asset_id),
    side: raw.side as OrderSide,
    price: raw.price,
    outcome: raw.outcome,
    reason: null,
  };
  switch (raw.kind) {
    case 'PLACEMENT':
      return {
        ...order,
        originalSize: raw.original_size,
        sizeMatched: raw.size_matched,
        orderType: raw.order_type as OrderType,
        expiration:
          raw.expiration === '0' ? null : isoFromSeconds(raw.expiration),
      };
    case 'UPDATE':
      return {
        ...order,
        originalSize: raw.original_size,
        sizeMatched: raw.size_matched,
        orderType: null,
        expiration: null,
      };
    default:
      return {
        ...order,
        originalSize: null,
        sizeMatched: null,
        orderType: null,
        expiration: null,
      };
  }
}

/**
 * Maps a `trade` event of the user channel.
 *
 * @internal
 */
export function toUserTradeEvent(raw: RawTradeEvent): UserTradeEvent {
  const base = {
    topic: 'user' as const,
    type: 'trade' as const,
    id: raw.id,
    market: conditionIdOf(raw.market),
    status: raw.status,
    timestamp: raw.timestamp,
  };
  if (raw.status !== 'MATCHED') {
    return {
      ...base,
      assetId: null,
      side: null,
      outcome: null,
      price: null,
      size: null,
      feeRateBps: null,
      traderSide: null,
      takerOrderId: null,
      makerOrderId: null,
      makerAddress: null,
      matchType: null,
    };
  }
  return {
    ...base,
    assetId: tokenIdOf(raw.asset_id),
    side: raw.side as OrderSide,
    outcome: raw.outcome,
    price: raw.price,
    size: raw.size,
    feeRateBps: raw.fee_rate_bps,
    traderSide: raw.trader_side,
    takerOrderId: raw.taker_order_id,
    makerOrderId: raw.maker_order_id,
    makerAddress: addressOf(raw.maker_address),
    matchType: raw.match_type,
  };
}

/** An ISO 8601 time of the backend, in Unix milliseconds. */
function millisecondsOf(value: string, field: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw unexpectedField(field, 'a time', 'backend');
  }
  return ms;
}

/**
 * Maps a snapshot of the portfolio channel: its rows (one per market, or one per position) as
 * positions.
 *
 * @throws {UnexpectedResponseError} When an amount or the time cannot be read.
 * @internal
 */
export function toPortfolioEvent(
  raw: RawPortfolioSnapshot<RawPortfolioMarket | RawPortfolioPosition>,
): PortfolioEvent {
  return {
    topic: 'portfolio',
    type: 'positions',
    positions: raw.data.flatMap((row) =>
      'positions' in row ? toPositions(row) : [toPosition(row)],
    ),
    timestamp: millisecondsOf(raw.emittedAt, 'emittedAt'),
  };
}

/**
 * Maps a snapshot of a market's activity channel: its fills, as trades. Rows that are not a
 * buy or a sell are left out.
 *
 * @throws {UnexpectedResponseError} When an amount or the time cannot be read.
 * @internal
 */
export function toActivityEvent(raw: RawActivitySnapshot): ActivityEvent {
  const marketId = String(raw.marketId);
  return {
    topic: 'activity',
    type: 'trades',
    marketId,
    trades: raw.data
      .map((row) => toMarketTrade(row, marketId))
      .filter((trade): trade is MarketTrade => trade !== undefined),
    timestamp: millisecondsOf(raw.emittedAt, 'emittedAt'),
  };
}
