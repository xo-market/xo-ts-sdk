import { z } from 'zod';
import {
  defineSchema,
  type EnumFactory,
  type ObjFactory,
  rawUnits,
} from '../core/schema';
import type { DecimalString, OrderHash, RawUnitsString } from '../core/types';

// Response schemas of the orderbook gateway: the public market-data routes first, then
// the trading and own-data routes (at the end of the file). The field names
// are the gateway's own (snake_case on most routes), so a response can be compared with
// the gateway's docs and logs one to one. Every schema mirrors one answer of the gateway, as
// the gateway sends it. The gateway's published docs can lag behind the gateway, so where they
// differ, these schemas follow what the gateway itself sends.
//
// Prices and sizes are strings and stay exactly as the gateway prints them: `/book` pads
// (`"0.550"`), the query routes trim (`"0.55"`). They are never turned into numbers.

/** A decimal as the gateway prints it. Not validated further and never converted. */
const decimal = z.string();

/**
 * A positive tick size that the gateway sends as a JSON number (`0.001`), as a decimal string.
 * A number whose shortest text is an exponent (`1e-7`) is not a plain decimal and is refused.
 *
 * This check holds in lenient mode too: an unexpected value fails the whole response, and
 * for `GET /markets` the whole page. That is fine while every market's tick size is
 * `0.001`, but a future per-market tick size below 0.000001 would need this to change.
 */
const tickSizeText = z
  .number()
  .refine(
    (n) => n > 0 && /^\d+(\.\d+)?$/.test(String(n)),
    'expected a positive plain decimal number',
  )
  .transform((n): DecimalString => String(n));

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

/**
 * Unix seconds. `GET /time` answers a bare JSON number. Plain digits are
 * accepted too (the text is `/^\d+$/`), whichever content type carries them.
 */
export const ServerTimeSchema = defineSchema<number>(() =>
  z.union([
    z
      .number()
      .refine(
        (n) => Number.isSafeInteger(n) && n >= 0,
        'expected whole unix seconds',
      ),
    z
      .string()
      .regex(/^\d+$/, 'expected unix seconds as digits')
      .transform(Number)
      .refine(Number.isSafeInteger, 'expected unix seconds as safe digits'),
  ]),
);

/** The global trading state: `'active'`, `'paused'`, or a state added later. */
export type TradingState = 'active' | 'paused' | (string & {});

export interface TradingStateResponse {
  state: TradingState;
}

export const TradingStateSchema = defineSchema<TradingStateResponse>(
  (obj, enumOf) => obj({ state: enumOf(['active', 'paused']) }),
);

/** `GET /tick-size`. The gateway sends a JSON number; here it is a decimal string. */
export interface TickSizeResponse {
  minimum_tick_size: DecimalString;
}

export const TickSizeSchema = defineSchema<TickSizeResponse>((obj) =>
  obj({ minimum_tick_size: tickSizeText }),
);

/**
 * `POST /v1/heartbeats`. The gateway answers **200 in every case**: `tracked: true` means
 * the heartbeat carried a valid L2 HMAC and was recorded; `tracked: false` means it did not
 * (unauthenticated or mis-signed), and then nothing was recorded. Only `tracked` decides.
 */
export interface HeartbeatResponse {
  /** Always `"ok"` today, even when `tracked` is false. */
  status?: 'ok' | (string & {});
  tracked: boolean;
}

// An answer that does not parse is reported by the heartbeat loop as a miss
// (`heartbeat_not_tracked`, the parse error as `cause`). In strict mode (contract tests,
// `strictResponses: true`) that includes an extra field the gateway starts to send: a false
// alarm, but in the safe direction (the beat is reported as unconfirmed, never as confirmed),
// and it only matters for contract tests. Lenient mode, the default, keeps unknown fields.
export const HeartbeatResponseSchema = defineSchema<HeartbeatResponse>(
  (obj, enumOf) =>
    obj({
      // Optional: the decision is `tracked`, the only field this client depends on.
      status: enumOf(['ok']).optional(),
      tracked: z.boolean(),
    }),
);

// ---------------------------------------------------------------------------
// Books
// ---------------------------------------------------------------------------

/** One price level of a book. Both fields are decimal strings, as printed. */
export interface PriceLevel {
  /** Padded to three decimals: `"0.550"`. */
  price: DecimalString;
  size: DecimalString;
}

/** `GET /book` and one element of `POST /books`. */
export interface OrderBook {
  /** The market (condition) id. */
  market: string;
  /** The token id the book is for. */
  asset_id: string;
  /** Unix milliseconds, as a string. */
  timestamp: string;
  hash: string;
  bids: PriceLevel[];
  asks: PriceLevel[];
  min_order_size: DecimalString;
  tick_size: DecimalString;
  neg_risk: boolean;
  last_trade_price: DecimalString;
  /**
   * The market's version-axis position this depth was read at. The schema requires a
   * non-negative whole number in lenient mode too, so anything else fails the response.
   */
  last_update_id: number;
}

const priceLevel = (obj: ObjFactory) => obj({ price: decimal, size: decimal });

const orderBook = (obj: ObjFactory) =>
  obj({
    market: z.string(),
    asset_id: z.string(),
    timestamp: z.string(),
    hash: z.string(),
    bids: z.array(priceLevel(obj)),
    asks: z.array(priceLevel(obj)),
    min_order_size: decimal,
    tick_size: decimal,
    neg_risk: z.boolean(),
    last_trade_price: decimal,
    // Strict in lenient mode too: a negative or fractional value fails the whole response.
    last_update_id: z.number().int().nonnegative(),
  });

export const OrderBookSchema = defineSchema<OrderBook>((obj) => orderBook(obj));

export const OrderBooksSchema = defineSchema<OrderBook[]>((obj) =>
  z.array(orderBook(obj)),
);

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

/** `GET /midpoint`. */
export interface MidpointResponse {
  mid: DecimalString;
}

export const MidpointSchema = defineSchema<MidpointResponse>((obj) =>
  obj({ mid: decimal }),
);

/** `GET /price`. */
export interface PriceResponse {
  price: DecimalString;
}

export const PriceSchema = defineSchema<PriceResponse>((obj) =>
  obj({ price: decimal }),
);

/** `GET /spread`. */
export interface SpreadResponse {
  spread: DecimalString;
}

export const SpreadSchema = defineSchema<SpreadResponse>((obj) =>
  obj({ spread: decimal }),
);

/**
 * `POST /midpoints` and `POST /spreads`: token id to decimal string. A token the gateway
 * does not know (or that has no price) is left out.
 */
export const DecimalMapSchema = defineSchema<Record<string, DecimalString>>(
  () => z.record(z.string(), decimal),
);

/** The best price per side that `POST /prices` returns for a token. Only the sides asked for are there. */
export interface PricesBySide {
  BUY?: DecimalString;
  SELL?: DecimalString;
}

/** `POST /prices`: token id to its prices by side. Unknown tokens are left out. */
export const PricesMapSchema = defineSchema<Record<string, PricesBySide>>(
  (obj) =>
    z.record(
      z.string(),
      obj({ BUY: decimal.optional(), SELL: decimal.optional() }),
    ),
);

/** The taker's side of a trade: `'BUY'`, `'SELL'`, or `''` when there is no trade yet. */
export type TradeSide = 'BUY' | 'SELL' | '' | (string & {});

/** `GET /last-trade-price`. A token with no trade answers `{ price: "0.5", side: "" }`. */
export interface LastTradePrice {
  price: DecimalString;
  side: TradeSide;
}

export const LastTradePriceSchema = defineSchema<LastTradePrice>(
  (obj, enumOf) => obj({ price: decimal, side: enumOf(['BUY', 'SELL', '']) }),
);

/** One element of `POST /last-trades-prices`. Tokens with no trade are left out. */
export interface LastTradePriceEntry extends LastTradePrice {
  token_id: string;
}

export const LastTradePricesSchema = defineSchema<LastTradePriceEntry[]>(
  (obj, enumOf) =>
    z.array(
      obj({
        price: decimal,
        side: enumOf(['BUY', 'SELL', '']),
        token_id: z.string(),
      }),
    ),
);

/** One point of a price history: unix seconds and a padded price. */
export interface PricePoint {
  t: number;
  p: DecimalString;
}

export interface PricesHistoryResponse {
  history: PricePoint[];
}

export const PricesHistorySchema = defineSchema<PricesHistoryResponse>((obj) =>
  obj({
    history: z.array(obj({ t: z.number().int().nonnegative(), p: decimal })),
  }),
);

// ---------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------

/** One outcome token of a market. */
export interface MarketToken {
  /** A decimal string (uint256). */
  token_id: string;
  /** `'Yes'` or `'No'`. */
  outcome: 'Yes' | 'No' | (string & {});
  /** The midpoint, else the last trade, else `"0.000"`. */
  price: DecimalString;
}

const marketToken = (obj: ObjFactory, enumOf: EnumFactory) =>
  obj({
    token_id: z.string(),
    outcome: enumOf(['Yes', 'No']),
    price: decimal,
  });

/** A market as `GET /markets` and `GET /markets/{condition_id}` return it. */
export interface OrderbookMarket {
  condition_id: string;
  tokens: MarketToken[];
  /** The gateway sends a JSON number (`0.001`); here it is a decimal string. */
  minimum_tick_size: DecimalString;
  neg_risk: boolean;
  /** True while the market is accepting orders. */
  active: boolean;
}

const orderbookMarket = (obj: ObjFactory, enumOf: EnumFactory) =>
  obj({
    condition_id: z.string(),
    tokens: z.array(marketToken(obj, enumOf)),
    minimum_tick_size: tickSizeText,
    neg_risk: z.boolean(),
    active: z.boolean(),
  });

export const OrderbookMarketSchema = defineSchema<OrderbookMarket>(
  (obj, enumOf) => orderbookMarket(obj, enumOf),
);

/** One page of `GET /markets`. */
export interface OrderbookMarketsPage {
  /** The page size the gateway used. */
  limit: number;
  /** The total number of markets. */
  count: number;
  /** The cursor of the next page, or `"LTE="` after the last one. */
  next_cursor: string;
  data: OrderbookMarket[];
}

export const OrderbookMarketsPageSchema = defineSchema<OrderbookMarketsPage>(
  (obj, enumOf) =>
    obj({
      limit: z.number().int().nonnegative(),
      count: z.number().int().nonnegative(),
      next_cursor: z.string(),
      data: z.array(orderbookMarket(obj, enumOf)),
    }),
);

/**
 * The creator's one-shot commitment of a conviction market. `side`, `price`, `size` and
 * `remaining` are left out when the gateway has no detail. A `'spent_tombstone'` carries
 * the frozen record: its `side` is always `"buy"` and its `remaining` the placeholder `"0"`.
 */
export interface Commitment {
  /** The commitment's order id, as a decimal string. */
  order_id: string;
  /** `'resting'` while the order is live, `'spent_tombstone'` after it left the book. */
  status: 'resting' | 'spent_tombstone' | (string & {});
  /** Which outcome token the commitment is on. */
  outcome: 'yes' | 'no' | (string & {});
  side?: 'buy' | 'sell' | (string & {});
  price?: DecimalString;
  size?: DecimalString;
  remaining?: DecimalString;
}

/** A market with its conviction metadata: `GET /conviction/markets/{condition_id}`. */
export interface ConvictionMarket {
  condition_id: string;
  tokens: MarketToken[];
  active: boolean;
  /** `'clob'`, `'clob_pulse'` or `'conviction'`. */
  variant: 'clob' | 'clob_pulse' | 'conviction' | (string & {});
  /** The on-chain creator, or `null` for a market that is not a conviction market. */
  creator: string | null;
  /** The creator's commitment, or `null` when the slot is empty. */
  commitment: Commitment | null;
}

const commitment = (obj: ObjFactory, enumOf: EnumFactory) =>
  obj({
    order_id: z.string(),
    status: enumOf(['resting', 'spent_tombstone']),
    outcome: enumOf(['yes', 'no']),
    side: enumOf(['buy', 'sell']).optional(),
    price: decimal.optional(),
    size: decimal.optional(),
    remaining: decimal.optional(),
  });

export const ConvictionMarketSchema = defineSchema<ConvictionMarket>(
  (obj, enumOf) =>
    obj({
      condition_id: z.string(),
      tokens: z.array(marketToken(obj, enumOf)),
      active: z.boolean(),
      variant: enumOf(['clob', 'clob_pulse', 'conviction']),
      creator: z.string().nullable(),
      commitment: commitment(obj, enumOf).nullable(),
    }),
);

// ===========================================================================
// Trading and own data
// ===========================================================================
//
// The authenticated routes. Field names are again the gateway's: the single place is
// camelCase (`PlaceOrderResponse`), the batch results and every own-data read are
// snake_case, and the cancel response is `{ canceled, notCanceled }`. Amounts on the
// account routes (balances, positions, capacities), the placement amounts and a trade's
// `*_original_size` / `*_remaining_after_fill` are integer micro-units (6 decimals) as
// strings, never converted to numbers. They are typed `RawUnitsString`, so none of them can
// be passed where whole units are expected (an order's price, size or amount):
// `formatUnits(BigInt(value), 6)` (viem) turns one into whole units. Whole-unit fields stay
// `DecimalString`.

/** An EIP-712 order hash, `0x` and 64 hex digits, as the gateway prints a B256. */
const orderHash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'expected an order hash')
  .transform((value) => value as OrderHash);

/**
 * A micro-unit amount of a placement response: a string, branded, and not checked further.
 * Once the gateway answered 200 the order was processed, so (as for `placedOrderId`) a
 * cosmetic surprise here must not turn into an exception.
 */
const placedAmount = z.string().transform((value) => value as RawUnitsString);

/**
 * The order id of a placement response. Not pattern-checked: once the gateway answered 200
 * the order was processed, so a cosmetic surprise in this field must not turn into an
 * exception the caller could mistake for "not placed". The gateway prints the B256 hash.
 */
const placedOrderId = z.string().transform((value) => value as OrderHash);

/**
 * `status` of a placement: `'live'` (resting), `'matched'` (filled) or `'delayed'` (neither
 * resting nor filled: in the gateway's words "queued / FOK fail / not yet matched").
 */
export type PlaceOrderStatus = 'live' | 'matched' | 'delayed' | (string & {});

/** `POST /order`, as the gateway answers it. */
export interface PlaceOrderResponse {
  /** `false` is a result, not an error: read `errorMsg`. */
  success: boolean;
  errorMsg: string | null;
  /** What the placer gave across this match walk, in micro-units (USDC for a BUY, shares for a SELL). */
  makingAmount: RawUnitsString;
  /** What the placer received across this match walk, in micro-units. */
  takingAmount: RawUnitsString;
  /** The gateway's id of the order: its EIP-712 hash. */
  orderID: OrderHash;
  status: PlaceOrderStatus;
  transactionsHashes: string[];
  tradeIds: string[];
}

export const PlaceOrderResponseSchema = defineSchema<PlaceOrderResponse>(
  (obj, enumOf) =>
    obj({
      success: z.boolean(),
      errorMsg: z.string().nullable(),
      makingAmount: placedAmount,
      takingAmount: placedAmount,
      orderID: placedOrderId,
      status: enumOf(['live', 'matched', 'delayed']),
      transactionsHashes: z.array(z.string()),
      tradeIds: z.array(z.string()),
    }),
);

/** One entry of `POST /orders` (snake_case). Every field is `null` on the side that does not apply. */
export interface BatchPlaceEntry {
  /** The order hash when it was placed, else `null`. */
  order_id: string | null;
  fills: number | null;
  resting: boolean | null;
  /** Shares left, as a decimal string. */
  remaining_size: DecimalString | null;
  /** Why this order was not placed, else `null`. */
  error: string | null;
  order_hash: OrderHash | null;
}

const batchPlaceEntry = (obj: ObjFactory) =>
  obj({
    order_id: z.string().nullable(),
    fills: z.number().int().nonnegative().nullable(),
    resting: z.boolean().nullable(),
    remaining_size: decimal.nullable(),
    error: z.string().nullable(),
    order_hash: orderHash.nullable(),
  });

export interface BatchPlaceResponse {
  results: BatchPlaceEntry[];
}

export const BatchPlaceResponseSchema = defineSchema<BatchPlaceResponse>(
  (obj) => obj({ results: z.array(batchPlaceEntry(obj)) }),
);

/** Every cancel route: the ids cancelled, and why each other one was not. */
export interface CancelResult {
  canceled: string[];
  notCanceled: Record<string, string>;
}

const cancelResult = (obj: ObjFactory) =>
  obj({
    canceled: z.array(z.string()),
    notCanceled: z.record(z.string(), z.string()),
  });

export const CancelResultSchema = defineSchema<CancelResult>((obj) =>
  cancelResult(obj),
);

/** One group of `POST /orders/batch-ops`, as the gateway answers it. */
export type BatchOpsEntry =
  | { type: 'place'; payload?: BatchPlaceEntry[]; error?: string }
  | { type: 'cancel'; payload?: CancelResult; error?: string };

export interface BatchOpsResponse {
  results: BatchOpsEntry[];
}

export const BatchOpsResponseSchema = defineSchema<BatchOpsResponse>((obj) =>
  obj({
    results: z.array(
      z.discriminatedUnion('type', [
        obj({
          type: z.literal('place'),
          payload: z.array(batchPlaceEntry(obj)).optional(),
          error: z.string().optional(),
        }),
        obj({
          type: z.literal('cancel'),
          payload: cancelResult(obj).optional(),
          error: z.string().optional(),
        }),
      ]),
    ),
  }),
);

/** A resting order of the caller: `GET /data/orders` and `GET /data/order/{id}`. */
export interface OpenOrder {
  /** The order hash. */
  id: OrderHash;
  /** The condition id of the market. */
  market: string;
  outcome: 'YES' | 'NO' | (string & {});
  side: 'BUY' | 'SELL' | (string & {});
  /** Padded to three decimals: `"0.570"`. */
  price: DecimalString;
  /** Shares, as a decimal string. */
  original_size: DecimalString;
  size_matched: DecimalString;
  status: 'LIVE' | 'MATCHED' | (string & {});
  /** Unix seconds. */
  created_at: number;
  order_hash: OrderHash;
  /** The token id, a decimal string (empty when the engine has no market info). */
  asset_id: string;
  maker_address: string;
  /** A UUID derived from `maker_address` (for SDK compatibility), not an API key. */
  owner: string;
  /**
   * Unix seconds as a decimal string; `"0"` means no expiry. On a market with an end time, it is
   * the earlier of that end and the order's own expiration.
   */
  expiration: string;
  /**
   * A resting order on a market with an end time is listed as `'GTD'`, even one placed as
   * `'GTC'`: the orderbook ends it when the market ends (see `expiration`).
   */
  order_type: 'GTC' | 'GTD' | 'FOK' | 'FAK' | (string & {});
}

const openOrder = (obj: ObjFactory, enumOf: EnumFactory) =>
  obj({
    id: orderHash,
    market: z.string(),
    outcome: enumOf(['YES', 'NO']),
    side: enumOf(['BUY', 'SELL']),
    price: decimal,
    original_size: decimal,
    size_matched: decimal,
    status: enumOf(['LIVE', 'MATCHED']),
    created_at: z.number().int().nonnegative(),
    order_hash: orderHash,
    asset_id: z.string(),
    maker_address: z.string(),
    owner: z.string(),
    expiration: z.string(),
    order_type: enumOf(['GTC', 'GTD', 'FOK', 'FAK']),
  });

export const OpenOrderSchema = defineSchema<OpenOrder>((obj, enumOf) =>
  openOrder(obj, enumOf),
);

/** One page of a paginated own-data read. */
export interface CursorPage<T> {
  limit: number;
  /** The total number of items. */
  count: number;
  /** The cursor of the next page, or `"LTE="` after the last one. */
  next_cursor: string;
  data: T[];
}

const cursorPage = <T>(obj: ObjFactory, item: z.ZodType<T>) =>
  obj({
    limit: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
    next_cursor: z.string(),
    data: z.array(item),
  });

export const OpenOrdersPageSchema = defineSchema<CursorPage<OpenOrder>>(
  (obj, enumOf) => cursorPage(obj, openOrder(obj, enumOf)),
);

/** The maker side of a trade. XO records one maker per trade. */
export interface MakerOrderEntry {
  /** The maker's order hash (or its numeric id on legacy records). */
  order_id: string;
  maker_address: string;
  owner: string;
  /** Shares delivered, as a decimal string. */
  matched_amount: DecimalString;
  price: DecimalString;
  fee_rate_bps: string;
  asset_id: string;
  outcome: 'YES' | 'NO' | (string & {});
}

/** A trade of the caller: `GET /data/trades` and `GET /trades/{id}`. */
export interface Trade {
  /** The trade id, `0x` and 64 hex digits. */
  id: string;
  /** The condition id of the market. */
  market: string;
  /** The taker's outcome. */
  outcome: 'YES' | 'NO' | (string & {});
  /** The taker's side. */
  side: 'BUY' | 'SELL' | (string & {});
  /** The taker's effective price, padded. */
  price: DecimalString;
  /** Shares delivered, as a decimal string. */
  size: DecimalString;
  status:
    | 'MATCHED'
    | 'MINED'
    | 'CONFIRMED'
    | 'RETRYING'
    | 'FAILED'
    | (string & {});
  /** Unix seconds, as a decimal string. */
  match_time: string;
  /** Unix seconds of the latest lifecycle change, as a decimal string. */
  last_update: string;
  bucket_index: number;
  /** The settlement transaction, once there is one. */
  transaction_hash: string | null;
  taker_order_id: string;
  asset_id: string;
  fee_rate_bps: string;
  owner: string;
  maker_address: string;
  /** The caller's side of the trade. */
  trader_side: 'MAKER' | 'TAKER' | (string & {});
  maker_orders: MakerOrderEntry[];
  /** The maker's size at placement, in micro-shares; left out on legacy records (as are the next three). */
  maker_original_size?: RawUnitsString;
  /** The maker's size left right after this fill, in micro-shares. */
  maker_remaining_after_fill?: RawUnitsString;
  /** The taker's size at placement, in micro-shares. */
  taker_original_size?: RawUnitsString;
  /** The taker's size left right after this fill, in micro-shares. */
  taker_remaining_after_fill?: RawUnitsString;
}

const trade = (obj: ObjFactory, enumOf: EnumFactory) =>
  obj({
    id: z.string(),
    market: z.string(),
    outcome: enumOf(['YES', 'NO']),
    side: enumOf(['BUY', 'SELL']),
    price: decimal,
    size: decimal,
    status: enumOf(['MATCHED', 'MINED', 'CONFIRMED', 'RETRYING', 'FAILED']),
    match_time: z.string(),
    last_update: z.string(),
    bucket_index: z.number().int().nonnegative(),
    transaction_hash: z.string().nullable(),
    taker_order_id: z.string(),
    asset_id: z.string(),
    fee_rate_bps: z.string(),
    owner: z.string(),
    maker_address: z.string(),
    trader_side: enumOf(['MAKER', 'TAKER']),
    maker_orders: z.array(
      obj({
        order_id: z.string(),
        maker_address: z.string(),
        owner: z.string(),
        matched_amount: decimal,
        price: decimal,
        fee_rate_bps: z.string(),
        asset_id: z.string(),
        outcome: enumOf(['YES', 'NO']),
      }),
    ),
    maker_original_size: rawUnits.optional(),
    maker_remaining_after_fill: rawUnits.optional(),
    taker_original_size: rawUnits.optional(),
    taker_remaining_after_fill: rawUnits.optional(),
  });

export const TradeSchema = defineSchema<Trade>((obj, enumOf) =>
  trade(obj, enumOf),
);

export const TradesPageSchema = defineSchema<CursorPage<Trade>>((obj, enumOf) =>
  cursorPage(obj, trade(obj, enumOf)),
);

/** `GET /balance-allowance`. */
export interface BalanceAllowance {
  /** Micro-units: USDC for COLLATERAL, shares of the token for CONDITIONAL. */
  balance: RawUnitsString;
  /** Micro-units, like `balance`. Always `"0"` today: the on-chain allowance needs a chain read. */
  allowance: RawUnitsString;
  /** The account's smart account, hex without `0x`, or `null` for an unknown user. */
  smart_account: string | null;
}

export const BalanceAllowanceSchema = defineSchema<BalanceAllowance>((obj) =>
  obj({
    balance: rawUnits,
    allowance: rawUnits,
    smart_account: z.string().nullable(),
  }),
);

/** One token position: micro-shares as strings. */
export interface PositionEntry {
  token_id: string;
  /** Micro-shares. */
  balance: RawUnitsString;
  /** Micro-shares reserved by resting SELL orders. */
  reserved: RawUnitsString;
}

/** `GET /positions`. */
export interface Positions {
  /** Micro-USDC. */
  cash_balance: RawUnitsString;
  /** Tokens with a positive balance. */
  positions: PositionEntry[];
}

export const PositionsSchema = defineSchema<Positions>((obj) =>
  obj({
    cash_balance: rawUnits,
    positions: z.array(
      obj({ token_id: z.string(), balance: rawUnits, reserved: rawUnits }),
    ),
  }),
);

/** One redeemable position. */
export interface ClaimableEntry {
  market_id: string;
  outcome: 'YES' | 'NO' | (string & {});
  token_id: string;
  /** Micro-shares. */
  balance: RawUnitsString;
  /** `'resolved_winner'`, or `'voided_refund'` for an invalidated market. */
  refund_reason: 'resolved_winner' | 'voided_refund' | (string & {});
}

/** `GET /claimable`. */
export interface Claimable {
  /** The account the gateway answered for (the authenticated user). */
  address: string;
  claimable: ClaimableEntry[];
}

export const ClaimableSchema = defineSchema<Claimable>((obj, enumOf) =>
  obj({
    address: z.string(),
    claimable: z.array(
      obj({
        market_id: z.string(),
        outcome: enumOf(['YES', 'NO']),
        token_id: z.string(),
        balance: rawUnits,
        refund_reason: enumOf(['resolved_winner', 'voided_refund']),
      }),
    ),
  }),
);

/** One outcome's position capacity: micro-shares as strings. */
export interface MarketCapacityPosition {
  token_id: string;
  outcome: 'YES' | 'NO' | (string & {});
  /** Micro-shares. */
  balance: RawUnitsString;
  /** Micro-shares reserved by resting SELL orders. */
  reserved: RawUnitsString;
  /** Micro-shares matched but not yet settled on chain. */
  pending_settlement: RawUnitsString;
  /** `balance − reserved − pending_settlement`, in micro-shares: what a new SELL may use. */
  free_position: RawUnitsString;
}

/** `GET /data/market-capacity`. */
export interface MarketCapacity {
  user_id: string;
  /** The condition id, as the gateway canonicalised it. */
  market_id: string;
  /** Micro-USDC a new BUY in this market may use. */
  free_market_capacity: RawUnitsString;
  /** YES then NO; empty for a market the engine does not know. */
  positions: MarketCapacityPosition[];
  smart_account: string | null;
}

export const MarketCapacitySchema = defineSchema<MarketCapacity>(
  (obj, enumOf) =>
    obj({
      user_id: z.string(),
      market_id: z.string(),
      free_market_capacity: rawUnits,
      positions: z.array(
        obj({
          token_id: z.string(),
          outcome: enumOf(['YES', 'NO']),
          balance: rawUnits,
          reserved: rawUnits,
          pending_settlement: rawUnits,
          free_position: rawUnits,
        }),
      ),
      smart_account: z.string().nullable(),
    }),
);
