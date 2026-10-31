import { z } from 'zod';
import { UnexpectedResponseError, type XoError } from '../core/errors';
import { redact } from '../core/redact';
import {
  type DualSchema,
  defineSchema,
  type ObjFactory,
  parseResponse,
  type ResponseIssue,
} from '../core/schema';
import type { DecimalString, Side } from '../core/types';
import { normalizeTimestamp } from './normalize';

// The events of the orderbook's two public WebSocket channels, and the parser that turns
// a text frame into one. `orderbookWs.ts` owns the sockets; this file only reads frames.
//
// - A frame is a JSON object keyed by `event_type` (the CLOB events), or by `type` (the
//   gateway's own messages: `subscribed`, `error`, and `orders_rebalanced` on /ws/user).
// - Each known `event_type` has a schema (`defineSchema`, lenient or strict). The event keeps
//   the gateway's field names, with `event_type` renamed to `type`; an `order` frame's own
//   `type` (PLACEMENT, UPDATE, ...) becomes `kind`, because `type` is the event's name.
// - `timestamp` becomes milliseconds (a number), and the gateway's string is kept as
//   `rawTimestamp`. The unit is read from the magnitude for every event (below 10^11 means
//   seconds): the gateway mixes seconds and milliseconds, even within one event type.
// - An event the SDK does not know is `{ type: 'unknown', rawType, data }` in lenient mode
//   (with sensitive keys of `data` redacted) and an error with `strictResponses`. That
//   includes an `order` kind or a `trade` status outside the known ones: their shape is
//   unknown too. Every member of the event unions therefore has a literal `type`, so a
//   `switch (event.type)` narrows.

/** Which channel a frame came from: `/ws/market` or `/ws/user`. */
export type OrderbookChannel = 'market' | 'user';

/** Fields of every event that carries a time. */
export interface Stamped {
  /** Milliseconds since the Unix epoch. */
  timestamp: number;
  /**
   * The gateway's `timestamp`, exactly as sent: a string of digits, in seconds or in
   * milliseconds depending on the event (see its docs). The SDK reads the unit from the
   * magnitude for every event (below 10^11 means seconds), so `timestamp` is right either way.
   */
  rawTimestamp: string;
}

/** One price level of a `book` event. */
export interface BookLevel {
  /** Padded to three decimals, as `GET /book` prints it: `"0.550"`. */
  price: DecimalString;
  /** Decimal shares: `"80.123456"`. */
  size: DecimalString;
}

/**
 * `book`: the full depth of one outcome token. Sent for each token
 * on subscribe (`initialDump`, the default), and for both tokens of the market after every
 * placement, cancel and fill, so a book kept from these events heals itself on the next one.
 *
 * Timestamp: milliseconds, except the books sent for a fill, which carry the fill's time in
 * seconds.
 */
export interface BookEvent extends Stamped {
  type: 'book';
  /** The token id (decimal string). */
  asset_id: string;
  /** The condition id. */
  market: string;
  bids: BookLevel[];
  asks: BookLevel[];
  /** A digest of the levels and the timestamp: it changes when the book does. */
  hash: string;
  /**
   * The market's book version this depth was read at; `0` means none. Absent on the
   * snapshots sent on subscribe.
   */
  last_update_id?: number;
}

/** One entry of a `price_change` event. */
export interface PriceChange {
  asset_id: string;
  /** Trimmed: `"0.55"`. */
  price: DecimalString;
  /** The size now resting at this price; `"0"` when the level is gone. */
  size: DecimalString;
  side: Side | (string & {});
  hash: string;
  /** The best bid after the change, `""` when there is none. */
  best_bid: DecimalString;
  /** The best ask after the change, `""` when there is none. */
  best_ask: DecimalString;
}

/**
 * `price_change`: level changes from a placement or a cancel, one entry per outcome.
 * Timestamp: milliseconds.
 */
export interface PriceChangeEvent extends Stamped {
  type: 'price_change';
  market: string;
  price_changes: PriceChange[];
}

/**
 * `best_bid_ask`: the top of one token's book changed. Only with
 * `customFeatures: true`. Timestamp: milliseconds, or seconds when a fill caused it.
 */
export interface BestBidAskEvent extends Stamped {
  type: 'best_bid_ask';
  market: string;
  asset_id: string;
  /** `""` when there is no bid. */
  best_bid: DecimalString;
  /** `""` when there is no ask. */
  best_ask: DecimalString;
  /** `"0"` when a side is empty. */
  spread: DecimalString;
}

/**
 * `last_trade_price`: a fill, from the taker's side.
 *
 * Timestamp: the fill's time, sent in **seconds** (`rawTimestamp`).
 */
export interface LastTradePriceEvent extends Stamped {
  type: 'last_trade_price';
  /** The taker's token. */
  asset_id: string;
  market: string;
  /** The taker's effective price, trimmed. */
  price: DecimalString;
  side: Side | (string & {});
  /** Delivered shares. */
  size: DecimalString;
  /** Always `"0"` since the 2026-08 order format. */
  fee_rate_bps: string;
}

/**
 * `new_market`: a market started accepting orders. Only with
 * `customFeatures: true`. The gateway does not know the metadata: `question`, `slug` and
 * `description` are `""` and `assets_ids` is empty; read the market over REST.
 * Timestamp: milliseconds.
 */
export interface NewMarketEvent extends Stamped {
  type: 'new_market';
  id: string;
  question: string;
  market: string;
  slug: string;
  description: string;
  assets_ids: string[];
  outcomes: string[];
  status: 'ACTIVE' | (string & {});
}

/**
 * `market_resolved`: a market was resolved or voided. Only with
 * `customFeatures: true`. The winner is not known to the gateway: `winning_asset_id` is `"0"`
 * and `winning_outcome` is `""`. Timestamp: milliseconds.
 */
export interface MarketResolvedEvent extends Stamped {
  type: 'market_resolved';
  id: string;
  market: string;
  assets_ids: string[];
  outcomes: string[];
  winning_asset_id: string;
  winning_outcome: string;
  status: 'RESOLVED' | 'VOIDED' | (string & {});
}

/**
 * `trading_state_changed`: the protocol-wide pause flag, on both channels.
 * Every connection receives a `'snapshot'` of the current state first; a channel split over
 * several connections surfaces it from its primary connection only. While `state` is
 * `'paused'`, new orders are refused (503 `trading_paused`). Timestamp: milliseconds.
 */
export interface TradingStateEvent extends Stamped {
  type: 'trading_state_changed';
  state: 'paused' | 'active' | (string & {});
  source: 'on_chain' | 'startup_reconciliation' | 'snapshot' | (string & {});
}

/** Fields of every `order` event of the user channel. Timestamps: milliseconds. */
export interface OrderEventBase extends Stamped {
  type: 'order';
  /** The trading address (the smart wallet, when one trades), lower case. */
  owner: string;
  maker_address: string;
  /** The condition id. */
  market: string;
}

/** `order` with the gateway's `type: "PLACEMENT"`: the order rests on the book. */
export interface OrderPlacementEvent extends OrderEventBase {
  /** The gateway's `type`, renamed: `type` is the event's name. */
  kind: 'PLACEMENT';
  /** The order hash. */
  id: string;
  asset_id: string;
  side: Side | (string & {});
  original_size: DecimalString;
  size_matched: DecimalString;
  price: DecimalString;
  status: 'LIVE' | (string & {});
  outcome: 'YES' | 'NO' | (string & {});
  order_type: 'GTC' | 'GTD' | 'FOK' | 'FAK' | (string & {});
  /** Unix seconds, `"0"` for none. */
  expiration: string;
  /** Unix seconds. */
  created_at: number;
  /** Unix milliseconds, as a string. */
  last_update: string;
}

/**
 * `order` with `type: "UPDATE"`: a fill. `status: 'LIVE'` while
 * part of the order still rests; `'MATCHED'` when it is fully filled (the terminal frame,
 * `size_matched === original_size`).
 */
export interface OrderUpdateEvent extends OrderEventBase {
  kind: 'UPDATE';
  id: string;
  asset_id: string;
  side: Side | (string & {});
  original_size: DecimalString;
  size_matched: DecimalString;
  price: DecimalString;
  status: 'LIVE' | 'MATCHED' | (string & {});
  outcome: 'YES' | 'NO' | (string & {});
}

/** `order` with `type: "CANCELLATION"`: explicit, mass, expiry, market close. */
export interface OrderCancellationEvent extends OrderEventBase {
  kind: 'CANCELLATION';
  id: string;
  asset_id: string;
  side: Side | (string & {});
  price: DecimalString;
  outcome: 'YES' | 'NO' | (string & {});
  status: 'CANCELED' | (string & {});
  last_update: string;
}

/**
 * `order` with `type: "REJECTED"`: an order refused before it rested. It
 * never had an id, so there is none here.
 */
export interface OrderRejectedEvent extends OrderEventBase {
  kind: 'REJECTED';
  status: 'REJECTED' | (string & {});
  reason: string;
}

/** An `order` event of the user channel; narrow it with `kind`. */
export type OrderEvent =
  | OrderPlacementEvent
  | OrderUpdateEvent
  | OrderCancellationEvent
  | OrderRejectedEvent;

/**
 * `trade` with `status: "MATCHED"`: a fill the trader took part in, sent to
 * the maker and to the taker. Timestamp: the fill's time in milliseconds.
 */
export interface TradeMatchedEvent extends Stamped {
  type: 'trade';
  status: 'MATCHED';
  /** The trade id. */
  id: string;
  taker_order_id: string;
  /** Joins with the maker's `order` event (`id`). */
  maker_order_id: string;
  market: string;
  /** The taker's token. */
  asset_id: string;
  /** The taker's side. */
  side: Side | (string & {});
  size: DecimalString;
  price: DecimalString;
  fee_rate_bps: string;
  outcome: 'YES' | 'NO' | (string & {});
  maker_address: string;
  /** The trader's own role in this trade. */
  trader_side: 'MAKER' | 'TAKER' | (string & {});
  match_type: 'COMPLEMENTARY' | 'MINT' | 'MERGE' | (string & {});
  /** Unix milliseconds, as a string. */
  last_update: string;
}

/**
 * `trade` with a later settlement status: only the id, the market and the
 * status. `'FAILED'` means the fill was rolled back. Timestamp: milliseconds.
 */
export interface TradeStatusEvent extends Stamped {
  type: 'trade';
  status: 'MINED' | 'CONFIRMED' | 'RETRYING' | 'FAILED';
  id: string;
  market: string;
}

/** A `trade` event of the user channel; narrow it with `status`. */
export type TradeEvent = TradeMatchedEvent | TradeStatusEvent;

/**
 * `orders_rebalanced`: the gateway cancelled resting orders of the trader because a balance
 * dropped. An XO extension of /ws/user. The gateway sends it only
 * while the channel is scoped to markets (not for a channel on every market). Every connection
 * of a split channel receives it; the SDK surfaces it from the primary connection only.
 */
export interface OrdersRebalancedEvent {
  type: 'orders_rebalanced';
  cancelled_count: number;
  /** Order hashes (or legacy numeric ids). */
  cancelled_order_ids: string[];
}

/**
 * A frame the SDK does not know, emitted as it came in lenient mode (with `strictResponses` it
 * is an error instead). `rawType` is its `event_type` (or its `type`, for a gateway message);
 * for an `order` kind or a `trade` status the SDK does not know it is `'order'` or `'trade'`.
 * Values under sensitive keys of `data` (such as `secret`) are replaced by `[redacted]`.
 */
export interface UnknownEvent {
  type: 'unknown';
  rawType: string;
  data: Record<string, unknown>;
}

/** What `marketChannel` emits. */
export type MarketChannelEvent =
  | BookEvent
  | PriceChangeEvent
  | LastTradePriceEvent
  | BestBidAskEvent
  | NewMarketEvent
  | MarketResolvedEvent
  | TradingStateEvent
  | UnknownEvent;

/** What `userChannel` emits. */
export type UserChannelEvent =
  | OrderEvent
  | TradeEvent
  | TradingStateEvent
  | OrdersRebalancedEvent
  | UnknownEvent;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** An event as the gateway sends it: `event_type` instead of `type`, the raw timestamp. */
type Wire<E> = Omit<E, 'type' | 'timestamp' | 'rawTimestamp'> & {
  event_type: string;
  timestamp: string;
};

/** An `order` frame: its own `type` is the event's `kind`. */
type OrderWire<E> = Omit<E, 'type' | 'kind' | 'timestamp' | 'rawTimestamp'> & {
  event_type: string;
  type: string;
  timestamp: string;
};

const text = z.string();
/** A timestamp: decimal digits only, as the gateway prints every one. */
const digits = z.string().regex(/^\d+$/, 'expected a string of digits');
const sides = ['BUY', 'SELL'] as const;
const outcomes = ['YES', 'NO'] as const;

const level = (obj: ObjFactory) => obj({ price: text, size: text });

const BookSchema = defineSchema<Wire<BookEvent>>((obj) =>
  obj({
    event_type: z.literal('book'),
    asset_id: text,
    market: text,
    bids: z.array(level(obj)),
    asks: z.array(level(obj)),
    timestamp: digits,
    hash: text,
    last_update_id: z.number().int().nonnegative().optional(),
  }),
);

const PriceChangeSchema = defineSchema<Wire<PriceChangeEvent>>((obj, enumOf) =>
  obj({
    event_type: z.literal('price_change'),
    market: text,
    price_changes: z.array(
      obj({
        asset_id: text,
        price: text,
        size: text,
        side: enumOf(sides),
        hash: text,
        best_bid: text,
        best_ask: text,
      }),
    ),
    timestamp: digits,
  }),
);

const BestBidAskSchema = defineSchema<Wire<BestBidAskEvent>>((obj) =>
  obj({
    event_type: z.literal('best_bid_ask'),
    market: text,
    asset_id: text,
    best_bid: text,
    best_ask: text,
    spread: text,
    timestamp: digits,
  }),
);

const LastTradePriceSchema = defineSchema<Wire<LastTradePriceEvent>>(
  (obj, enumOf) =>
    obj({
      event_type: z.literal('last_trade_price'),
      asset_id: text,
      market: text,
      price: text,
      side: enumOf(sides),
      size: text,
      fee_rate_bps: text,
      timestamp: digits,
    }),
);

const NewMarketSchema = defineSchema<Wire<NewMarketEvent>>((obj, enumOf) =>
  obj({
    event_type: z.literal('new_market'),
    id: text,
    question: text,
    market: text,
    slug: text,
    description: text,
    assets_ids: z.array(text),
    outcomes: z.array(text),
    timestamp: digits,
    status: enumOf(['ACTIVE']),
  }),
);

const MarketResolvedSchema = defineSchema<Wire<MarketResolvedEvent>>(
  (obj, enumOf) =>
    obj({
      event_type: z.literal('market_resolved'),
      id: text,
      market: text,
      assets_ids: z.array(text),
      outcomes: z.array(text),
      winning_asset_id: text,
      winning_outcome: text,
      timestamp: digits,
      status: enumOf(['RESOLVED', 'VOIDED']),
    }),
);

const TradingStateSchema = defineSchema<Wire<TradingStateEvent>>(
  (obj, enumOf) =>
    obj({
      event_type: z.literal('trading_state_changed'),
      state: enumOf(['paused', 'active']),
      source: enumOf(['on_chain', 'startup_reconciliation', 'snapshot']),
      timestamp: digits,
    }),
);

const OrderPlacementSchema = defineSchema<OrderWire<OrderPlacementEvent>>(
  (obj, enumOf) =>
    obj({
      event_type: z.literal('order'),
      type: z.literal('PLACEMENT'),
      id: text,
      owner: text,
      maker_address: text,
      market: text,
      asset_id: text,
      side: enumOf(sides),
      original_size: text,
      size_matched: text,
      price: text,
      status: enumOf(['LIVE']),
      outcome: enumOf(outcomes),
      order_type: enumOf(['GTC', 'GTD', 'FOK', 'FAK']),
      expiration: text,
      created_at: z.number().int().nonnegative(),
      last_update: text,
      timestamp: digits,
    }),
);

const OrderUpdateSchema = defineSchema<OrderWire<OrderUpdateEvent>>(
  (obj, enumOf) =>
    obj({
      event_type: z.literal('order'),
      type: z.literal('UPDATE'),
      id: text,
      owner: text,
      maker_address: text,
      market: text,
      asset_id: text,
      side: enumOf(sides),
      original_size: text,
      size_matched: text,
      price: text,
      status: enumOf(['LIVE', 'MATCHED']),
      outcome: enumOf(outcomes),
      timestamp: digits,
    }),
);

const OrderCancellationSchema = defineSchema<OrderWire<OrderCancellationEvent>>(
  (obj, enumOf) =>
    obj({
      event_type: z.literal('order'),
      type: z.literal('CANCELLATION'),
      id: text,
      owner: text,
      maker_address: text,
      market: text,
      asset_id: text,
      side: enumOf(sides),
      price: text,
      outcome: enumOf(outcomes),
      status: enumOf(['CANCELED']),
      last_update: text,
      timestamp: digits,
    }),
);

const OrderRejectedSchema = defineSchema<OrderWire<OrderRejectedEvent>>(
  (obj, enumOf) =>
    obj({
      event_type: z.literal('order'),
      type: z.literal('REJECTED'),
      owner: text,
      maker_address: text,
      market: text,
      status: enumOf(['REJECTED']),
      reason: text,
      timestamp: digits,
    }),
);

const TradeMatchedSchema = defineSchema<Wire<TradeMatchedEvent>>(
  (obj, enumOf) =>
    obj({
      event_type: z.literal('trade'),
      id: text,
      taker_order_id: text,
      maker_order_id: text,
      market: text,
      asset_id: text,
      side: enumOf(sides),
      size: text,
      price: text,
      fee_rate_bps: text,
      status: z.literal('MATCHED'),
      outcome: enumOf(outcomes),
      maker_address: text,
      trader_side: enumOf(['MAKER', 'TAKER']),
      match_type: enumOf(['COMPLEMENTARY', 'MINT', 'MERGE']),
      last_update: text,
      timestamp: digits,
    }),
);

/** The settlement statuses after `MATCHED`. */
const TRADE_STATUSES = ['MINED', 'CONFIRMED', 'RETRYING', 'FAILED'] as const;

const TradeStatusSchema = defineSchema<Wire<TradeStatusEvent>>((obj) =>
  obj({
    event_type: z.literal('trade'),
    id: text,
    market: text,
    // Not enumOf: the parser only picks this schema for one of these values, so the status
    // stays a closed type and `event.status === 'MATCHED'` narrows a TradeEvent.
    status: z.enum(TRADE_STATUSES),
    timestamp: digits,
  }),
);

const OrdersRebalancedSchema = defineSchema<OrdersRebalancedEvent>((obj) =>
  obj({
    type: z.literal('orders_rebalanced'),
    cancelled_count: z.number().int().nonnegative(),
    cancelled_order_ids: z.array(text),
  }),
);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * A timestamp below this is in seconds, at or above it in milliseconds. Seconds stay below it
 * until the year 5138; milliseconds have been above it since 1973.
 */
const SECONDS_BELOW = 100_000_000_000;

/**
 * Every timestamp is read by its magnitude, whatever the event: the gateway mixes the units within
 * one event type (`book` and `best_bid_ask` carry seconds when a fill caused them), and the
 * per-event unit of today (`last_trade_price` in seconds) is not a contract.
 */
function toMs(raw: string): number {
  return normalizeTimestamp(raw, Number(raw) < SECONDS_BELOW ? 's' : 'ms');
}

type AnyEvent = MarketChannelEvent | UserChannelEvent;

/** One kind of frame: how to check it and turn it into an event. */
interface Spec {
  /** How errors name the frame. */
  readonly name: string;
  /** Throws `UnexpectedResponseError` (schema) or `UserInputError` (timestamp). */
  read(frame: unknown, strict: boolean, channel: OrderbookChannel): AnyEvent;
}

function check<T>(
  schema: DualSchema<T>,
  frame: unknown,
  strict: boolean,
  channel: OrderbookChannel,
  name: string,
): T {
  return parseResponse(schema, frame, {
    strict,
    service: 'orderbook',
    path: `/ws/${channel} "${name}"`,
  });
}

/** An event with a timestamp: `event_type` becomes `type`, `timestamp` is normalised. */
function timed<E extends AnyEvent & Stamped>(
  type: E['type'],
  schema: DualSchema<Wire<E>>,
): Spec {
  return {
    name: type,
    read(frame, strict, channel) {
      const wire = check(schema, frame, strict, channel, type);
      const { event_type: _eventType, timestamp, ...rest } = wire;
      return {
        type,
        ...rest,
        timestamp: toMs(timestamp),
        rawTimestamp: timestamp,
      } as unknown as E;
    },
  };
}

/** An `order` event: its own `type` becomes `kind`. */
function order<E extends OrderEvent>(
  kind: E['kind'],
  schema: DualSchema<OrderWire<E>>,
): Spec {
  return {
    name: `order ${kind}`,
    read(frame, strict, channel) {
      const wire = check(schema, frame, strict, channel, `order ${kind}`);
      const { event_type: _eventType, type: _kind, timestamp, ...rest } = wire;
      return {
        type: 'order',
        kind,
        ...rest,
        timestamp: toMs(timestamp),
        rawTimestamp: timestamp,
      } as unknown as E;
    },
  };
}

const BOOK = timed<BookEvent>('book', BookSchema);
const PRICE_CHANGE = timed<PriceChangeEvent>('price_change', PriceChangeSchema);
const BEST_BID_ASK = timed<BestBidAskEvent>('best_bid_ask', BestBidAskSchema);
const LAST_TRADE_PRICE = timed<LastTradePriceEvent>(
  'last_trade_price',
  LastTradePriceSchema,
);
const NEW_MARKET = timed<NewMarketEvent>('new_market', NewMarketSchema);
const MARKET_RESOLVED = timed<MarketResolvedEvent>(
  'market_resolved',
  MarketResolvedSchema,
);
const TRADING_STATE = timed<TradingStateEvent>(
  'trading_state_changed',
  TradingStateSchema,
);
const ORDER_KINDS = new Map<unknown, Spec>([
  ['PLACEMENT', order<OrderPlacementEvent>('PLACEMENT', OrderPlacementSchema)],
  ['UPDATE', order<OrderUpdateEvent>('UPDATE', OrderUpdateSchema)],
  [
    'CANCELLATION',
    order<OrderCancellationEvent>('CANCELLATION', OrderCancellationSchema),
  ],
  ['REJECTED', order<OrderRejectedEvent>('REJECTED', OrderRejectedSchema)],
]);
// The fill's seconds are scaled to milliseconds by the gateway.
const TRADE_MATCHED = timed<TradeMatchedEvent>('trade', TradeMatchedSchema);
const TRADE_STATUS = timed<TradeStatusEvent>('trade', TradeStatusSchema);
const ORDERS_REBALANCED: Spec = {
  name: 'orders_rebalanced',
  read: (frame, strict, channel) =>
    check(OrdersRebalancedSchema, frame, strict, channel, 'orders_rebalanced'),
};

/** Picks the spec of a frame, or `undefined` when its shape is unknown. */
type Selector = (frame: Record<string, unknown>) => Spec | undefined;

const MARKET_EVENTS = new Map<string, Selector>([
  ['book', () => BOOK],
  ['price_change', () => PRICE_CHANGE],
  ['best_bid_ask', () => BEST_BID_ASK],
  ['last_trade_price', () => LAST_TRADE_PRICE],
  ['new_market', () => NEW_MARKET],
  ['market_resolved', () => MARKET_RESOLVED],
  ['trading_state_changed', () => TRADING_STATE],
]);

const USER_EVENTS = new Map<string, Selector>([
  ['order', (frame) => ORDER_KINDS.get(frame.type)],
  [
    'trade',
    (frame) =>
      frame.status === 'MATCHED'
        ? TRADE_MATCHED
        : (TRADE_STATUSES as readonly unknown[]).includes(frame.status)
          ? TRADE_STATUS
          : undefined,
  ],
  ['trading_state_changed', () => TRADING_STATE],
]);

/** The gateway's own messages (tagged by `type`) that are events. */
const MARKET_MESSAGES = new Map<string, Spec>();
const USER_MESSAGES = new Map<string, Spec>([
  ['orders_rebalanced', ORDERS_REBALANCED],
]);

/** What one text frame turned out to be. */
export type FrameResult<E> =
  /** An event to emit. `frame` is the decoded JSON it came from. */
  | { kind: 'event'; event: E; frame: unknown }
  /** The gateway's answer to a subscribe frame (`{type: "subscribed"}`). */
  | { kind: 'subscribed' }
  /** The gateway refused a frame (`{type: "error", message}`); `message` is raw and untrusted. */
  | { kind: 'server_error'; message: string }
  /** A frame that failed its schema, or an unknown one with `strictResponses`. */
  | { kind: 'invalid'; error: XoError; frame?: unknown }
  /** Not JSON: ignored. */
  | { kind: 'ignored' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A name from the gateway, safe to put in a message: quoted and cut to 40 characters. */
function shown(name: string): string {
  return JSON.stringify(name.slice(0, 40));
}

function summary(issues: readonly ResponseIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
}

function invalidFrame(
  channel: OrderbookChannel,
  name: string,
  issues: ResponseIssue[],
): XoError {
  return new UnexpectedResponseError(
    `The orderbook ${channel} channel sent a ${shown(name)} frame that does not match its schema, so it was dropped: ${summary(issues)}`,
    { code: 'ws_frame_invalid', service: 'orderbook', issues },
  );
}

function unknownFrame(
  channel: OrderbookChannel,
  rawType: string,
  frame: Record<string, unknown>,
  strict: boolean,
): FrameResult<UnknownEvent> {
  if (strict) {
    const issues: ResponseIssue[] = [
      {
        path: typeof frame.event_type === 'string' ? 'event_type' : 'type',
        code: 'unknown_event',
        message: `unknown event ${shown(rawType)}`,
      },
    ];
    return {
      kind: 'invalid',
      error: new UnexpectedResponseError(
        `The orderbook ${channel} channel sent a ${shown(rawType)} frame of a shape this SDK does not know. With strictResponses that is an error; without it, the frame is emitted as an 'unknown' event`,
        { code: 'ws_unknown_event', service: 'orderbook', issues },
      ),
    };
  }
  return {
    kind: 'event',
    event: {
      type: 'unknown',
      rawType,
      data: redact(frame) as Record<string, unknown>,
    },
    frame,
  };
}

function readFrame(
  text: string,
  channel: OrderbookChannel,
  strict: boolean,
): FrameResult<AnyEvent> {
  let frame: unknown;
  try {
    frame = JSON.parse(text);
  } catch {
    return { kind: 'ignored' };
  }
  const result = readDecoded(frame, channel, strict);
  // The decoded frame goes with an event or an error, for the caller's credential check.
  return result.kind === 'invalid' ? { ...result, frame } : result;
}

function readDecoded(
  frame: unknown,
  channel: OrderbookChannel,
  strict: boolean,
): FrameResult<AnyEvent> {
  if (!isRecord(frame)) {
    return {
      kind: 'invalid',
      error: invalidFrame(channel, 'non-object', [
        {
          path: '(root)',
          code: 'invalid_type',
          message: 'expected a JSON object',
        },
      ]),
    };
  }
  const { event_type: eventType, type } = frame;
  let spec: Spec | undefined;
  let rawType: string;
  if (typeof eventType === 'string') {
    rawType = eventType;
    const events = channel === 'market' ? MARKET_EVENTS : USER_EVENTS;
    spec = events.get(eventType)?.(frame);
  } else if (eventType === undefined && typeof type === 'string') {
    if (type === 'subscribed') {
      return { kind: 'subscribed' };
    }
    if (type === 'error') {
      return {
        kind: 'server_error',
        message: typeof frame.message === 'string' ? frame.message : '',
      };
    }
    rawType = type;
    spec = (channel === 'market' ? MARKET_MESSAGES : USER_MESSAGES).get(type);
  } else {
    return {
      kind: 'invalid',
      error: invalidFrame(channel, 'untyped', [
        {
          path: 'event_type',
          code: 'invalid_type',
          message: 'expected a string event_type, or a string type',
        },
      ]),
    };
  }
  if (spec === undefined) {
    return unknownFrame(channel, rawType, frame, strict);
  }
  try {
    return { kind: 'event', event: spec.read(frame, strict, channel), frame };
  } catch (error) {
    const issues: ResponseIssue[] =
      error instanceof UnexpectedResponseError
        ? (error.issues as ResponseIssue[])
        : [
            {
              path: 'timestamp',
              code: 'invalid_timestamp',
              message:
                error instanceof Error ? error.message : 'invalid timestamp',
            },
          ];
    return { kind: 'invalid', error: invalidFrame(channel, spec.name, issues) };
  }
}

/** Reads one text frame of `/ws/market`. Never throws. */
export function parseMarketFrame(
  text: string,
  strict: boolean,
): FrameResult<MarketChannelEvent> {
  return readFrame(text, 'market', strict) as FrameResult<MarketChannelEvent>;
}

/** Reads one text frame of `/ws/user`. Never throws. */
export function parseUserFrame(
  text: string,
  strict: boolean,
): FrameResult<UserChannelEvent> {
  return readFrame(text, 'user', strict) as FrameResult<UserChannelEvent>;
}
