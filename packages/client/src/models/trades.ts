import { type Address, type Hex, isHash } from 'viem';
import type { ConditionId, DecimalString, TokenId } from '../core/types';
import type {
  MakerOrderEntry as RawMakerOrder,
  Trade as RawTrade,
} from '../orderbook/schemas';
import { addressOf, conditionIdOf, requireIso, tokenIdOf } from './convert';
import type { OrderSide } from './enums';

// The public trade model: one fill of the account's orders, with the order on the other side.

/**
 * Where a trade is in its settlement, in XO's words. A status added later reads as its own
 * string.
 *
 * - `MATCHED`: matched, not settled on chain yet.
 * - `MINED`: the settlement transaction is sent and waits for its confirmation.
 * - `CONFIRMED`: settled on chain. Final.
 * - `RETRYING`: settlement failed for now and is tried again.
 * - `FAILED`: settlement failed for good and the fill was undone. Final.
 */
export type TradeStatus =
  | 'MATCHED'
  | 'MINED'
  | 'CONFIRMED'
  | 'RETRYING'
  | 'FAILED'
  | (string & {});

/** Which side of the trade the account was on: the resting order or the one that took it. */
export type TraderSide = 'MAKER' | 'TAKER' | (string & {});

/** The resting order that a trade filled. */
export type MakerOrder = {
  /** The id of the resting order. */
  orderId: string;
  /** The outcome token the order was for. */
  assetId: TokenId;
  /** The address that placed the resting order. */
  makerAddress: Address;
  /** The shares of this order that the trade filled. */
  matchedAmount: DecimalString;
  /** The price of the resting order, in dollars between 0 and 1. */
  price: DecimalString;
  /** The fee rate of the fill, in basis points. */
  feeRateBps: DecimalString;
  /** The outcome of the resting order, `YES` or `NO`. */
  outcome: 'YES' | 'NO' | (string & {});
};

/**
 * A trade of the account: one fill, seen from the account's side (see
 * {@link Trade.traderSide}). `side`, `outcome` and `price` describe the order that took the
 * liquidity.
 */
export type Trade = {
  /** The trade's id. */
  id: string;
  /** The outcome token that traded. */
  assetId: TokenId;
  /** The id of the market the token belongs to. */
  market: ConditionId;
  /** The outcome the taker traded, `YES` or `NO`. */
  outcome: 'YES' | 'NO' | (string & {});
  /** The taker's side. */
  side: OrderSide;
  /** Whether the account was the maker or the taker of this trade. */
  traderSide: TraderSide;
  /** The taker's effective price in dollars between 0 and 1. */
  price: DecimalString;
  /** The shares that changed hands. */
  size: DecimalString;
  /** Where the trade is in its settlement. */
  status: TradeStatus;
  /** The fee rate of the trade, in basis points. */
  feeRateBps: DecimalString;
  /** The settlement transaction. `null` until there is one. */
  transactionHash: Hex | null;
  /** The id of the order that took the liquidity. */
  takerOrderId: string;
  /** The address of the maker. */
  makerAddress: Address;
  /** The resting orders the trade filled: one on XO. */
  makerOrders: MakerOrder[];
  /** When the trade was matched, as an ISO 8601 time. */
  matchedAt: string;
  /** When the trade last changed status, as an ISO 8601 time. */
  updatedAt: string;
};

function makerOrderOf(raw: RawMakerOrder): MakerOrder {
  return {
    orderId: raw.order_id,
    assetId: tokenIdOf(raw.asset_id),
    makerAddress: addressOf(raw.maker_address),
    matchedAmount: raw.matched_amount,
    price: raw.price,
    feeRateBps: raw.fee_rate_bps,
    outcome: raw.outcome,
  };
}

/**
 * Maps a trade of the account to the {@link Trade} model.
 *
 * @throws {UnexpectedResponseError} When the match time or the update time is not a time.
 * @internal
 */
export function toTrade(raw: RawTrade): Trade {
  return {
    id: raw.id,
    assetId: tokenIdOf(raw.asset_id),
    market: conditionIdOf(raw.market),
    outcome: raw.outcome,
    side: raw.side as OrderSide,
    traderSide: raw.trader_side,
    price: raw.price,
    size: raw.size,
    status: raw.status,
    feeRateBps: raw.fee_rate_bps,
    transactionHash:
      raw.transaction_hash !== null && isHash(raw.transaction_hash)
        ? raw.transaction_hash
        : null,
    takerOrderId: raw.taker_order_id,
    makerAddress: addressOf(raw.maker_address),
    makerOrders: raw.maker_orders.map(makerOrderOf),
    matchedAt: requireIso(raw.match_time, 'matchedAt'),
    updatedAt: requireIso(raw.last_update, 'updatedAt'),
  };
}
