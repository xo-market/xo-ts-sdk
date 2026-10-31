import type { ConditionId, DecimalString, TokenId } from '../core/types';
import type {
  OrderBook as RawOrderBook,
  PriceLevel as RawPriceLevel,
} from '../orderbook/schemas';
import { conditionIdOf, tokenIdOf } from './convert';
import { MINIMUM_ORDER_SIZE } from './market';

// The public order book model: the resting buy and sell orders of one outcome token, as a
// list of price levels per side.

/** One price level of an order book: all the resting size at one price. */
export type PriceLevel = {
  /** The price in dollars between 0 and 1, as printed, such as `"0.550"`. */
  price: DecimalString;
  /** The shares resting at this price, as printed, such as `"80.123456"`. */
  size: DecimalString;
};

/**
 * The order book of one outcome token.
 *
 * Both sides are listed with the best price last: `bids` from the lowest bid to the highest,
 * and `asks` from the highest ask to the lowest. The best bid is `bids.at(-1)` and the best
 * ask is `asks.at(-1)`.
 */
export type OrderBook = {
  /** The outcome token the book is for. */
  assetId: TokenId;
  /** The id of the market the token belongs to. */
  market: ConditionId;
  /** The buy orders, lowest price first, so the best bid is the last level. */
  bids: PriceLevel[];
  /** The sell orders, highest price first, so the best ask is the last level. */
  asks: PriceLevel[];
  /** The smallest price step, such as `"0.001"`. */
  minimumTickSize: DecimalString;
  /** The smallest order in shares: 1 unless the book states a larger one. */
  minimumOrderSize: DecimalString;
  /** Whether the market is a negative-risk market. */
  negRisk: boolean;
  /** When the book was read, in Unix milliseconds. `null` when the source gave no readable time. */
  timestamp: number | null;
  /** A short fingerprint of the book that changes when the book does. */
  hash: string;
};

/** A decimal with at least one non-zero digit. */
const POSITIVE_DECIMAL = /^(?=.*[1-9])\d+(\.\d+)?$/;

/** The book's own minimum when it states one; its placeholder `"0"` means the SDK's minimum. */
function minimumOrderSizeOf(value: string): DecimalString {
  return POSITIVE_DECIMAL.test(value) ? value : MINIMUM_ORDER_SIZE;
}

function timestampOf(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const milliseconds = Number(value);
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

const levelOf = (level: RawPriceLevel): PriceLevel => ({
  price: level.price,
  size: level.size,
});

/**
 * Maps the order book of a token to the {@link OrderBook} model. The source lists the best
 * level of each side first; the model lists it last, so the lists are reversed.
 *
 * @internal
 */
export function toOrderBook(raw: RawOrderBook): OrderBook {
  return {
    assetId: tokenIdOf(raw.asset_id),
    market: conditionIdOf(raw.market),
    bids: raw.bids.map(levelOf).reverse(),
    asks: raw.asks.map(levelOf).reverse(),
    minimumTickSize: raw.tick_size,
    minimumOrderSize: minimumOrderSizeOf(raw.min_order_size),
    negRisk: raw.neg_risk,
    timestamp: timestampOf(raw.timestamp),
    hash: raw.hash,
  };
}
