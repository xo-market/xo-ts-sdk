import { type Address, type Hex, isHash } from 'viem';
import type {
  ConditionId,
  DecimalString,
  OrderHash,
  TokenId,
} from '../core/types';
import type { ReconcileResult as RawReconcileResult } from '../orderbook/account';
import type {
  BatchPlaceEntry as RawBatchPlaceEntry,
  CancelResult as RawCancelResult,
  OpenOrder as RawOpenOrder,
  PlaceOrderResponse as RawPlaceOrderResponse,
} from '../orderbook/schemas';
import {
  addressOf,
  conditionIdOf,
  isoFromSeconds,
  requireIso,
  tokenIdOf,
  wholeUnitsOf,
} from './convert';
import type { OrderSide, OrderType } from './enums';
import { type Trade, toTrade } from './trades';

// The public order models: an order that rests on the book, the result of placing one, what a
// cancel did and where a placed order is. A placement that XO refuses is a value, not an
// exception: `{ ok: false, code, message }`, with a `code` that stays the same between releases.

export type { SignedOrder } from '../orderbook/builder';

/**
 * Where an open order is, in XO's words. A status added later reads as its own string.
 *
 * - `LIVE`: nothing has filled yet.
 * - `MATCHED`: some of it has filled (see {@link OpenOrder.sizeMatched}).
 */
export type OpenOrderStatus = 'LIVE' | 'MATCHED' | (string & {});

/**
 * An order of the account that rests on the book.
 *
 * A resting order on a market that has an end time lists as `GTD`, even one placed as `GTC`,
 * and its `expiration` is that end time or the order's own, whichever is earlier.
 */
export type OpenOrder = {
  /** The order's id. Pass it to fetch or cancel the order. */
  orderId: string;
  /** The outcome token the order is for. */
  assetId: TokenId;
  /** The id of the market the token belongs to. */
  market: ConditionId;
  /** The outcome the order is for, `YES` or `NO`. */
  outcome: 'YES' | 'NO' | (string & {});
  /** Whether the order buys or sells. */
  side: OrderSide;
  /** The limit price in dollars between 0 and 1, as printed, such as `"0.570"`. */
  price: DecimalString;
  /** The shares the order was placed for. */
  originalSize: DecimalString;
  /** The shares that have filled so far. */
  sizeMatched: DecimalString;
  /** Where the order is. */
  status: OpenOrderStatus;
  /** How long the order lives. */
  orderType: OrderType;
  /** When the order expires, as an ISO 8601 time. `null` when it does not expire. */
  expiration: string | null;
  /** When the order was placed, as an ISO 8601 time. */
  createdAt: string;
  /** The address that placed the order. */
  makerAddress: Address;
};

/**
 * What became of an order that XO accepted. A status added later reads as its own string.
 *
 * - `live`: the order rests on the book. Part of it may have filled at once (see
 *   {@link AcceptedOrderResponse.tradeIds}).
 * - `matched`: the order filled completely at once.
 * - `delayed`: the order is held for the taker delay and can still fill. What has filled so
 *   far is in `makingAmount`, `takingAmount` and `tradeIds`. To see the rest, read the
 *   account's trades with `listAccountTrades`, or look the order up with
 *   `reconcileOrder({ orderHash })`.
 */
export type OrderPostStatus = 'live' | 'matched' | 'delayed' | (string & {});

/** An order that XO accepted. */
export type AcceptedOrderResponse = {
  /** `true`: the order was accepted. */
  ok: true;
  /** The order's id, as XO gives it. On XO it is the order's hash. */
  orderId: string;
  /**
   * The hash of the signed order, computed here before it was sent. Use it to look the order
   * up again, for example when the answer to a placement never arrived.
   */
  orderHash: OrderHash;
  /** What became of the order. */
  status: OrderPostStatus;
  /**
   * What the order gave up in the fills made at placement, in whole units: dollars for a
   * buy, shares for a sell. `"0"` when nothing filled. `null` when XO did not report it,
   * which is the case for every order posted in a batch (`postOrders`, `postOrderBatch`):
   * read the account's trades for those.
   */
  makingAmount: DecimalString | null;
  /**
   * What the order received in the fills made at placement, in whole units: shares for a
   * buy, dollars for a sell. `"0"` when nothing filled. `null` when XO did not report it, as
   * for {@link AcceptedOrderResponse.makingAmount}.
   */
  takingAmount: DecimalString | null;
  /**
   * The ids of the trades made at placement. Empty when nothing filled. `null` when XO did not
   * report them, which is the case for every order posted in a batch (`postOrders`,
   * `postOrderBatch`): read the account's trades for those. Later fills of a resting order
   * make new trades that are not listed here.
   */
  tradeIds: string[] | null;
  /**
   * The settlement transactions of the fills made at placement. Settlement happens after the
   * match, so this can be empty even when the order filled: read the trades for the hashes.
   * `null` when XO did not report them, as for {@link AcceptedOrderResponse.tradeIds}.
   */
  transactionsHashes: Hex[] | null;
};

/** The codes of {@link OrderRejectionCode}, in a list. */
export const ORDER_REJECTION_CODES = [
  'post_only_would_cross',
  'duplicate_order',
  'size_below_minimum',
  'notional_below_minimum',
  'price_out_of_range',
  'invalid_expiration',
  'market_not_active',
  'market_not_found',
  'insufficient_balance',
  'insufficient_position',
  'account_not_found',
  'order_cancelled_during_hold',
  'trading_paused',
  'rejected',
] as const;

/**
 * Why XO refused an order, as the `code` of a {@link RejectedOrderResponse}. A code stays the
 * same between releases; the `message` next to it is XO's own words and can change.
 *
 * - `post_only_would_cross`: a post-only order would have traded at once.
 * - `duplicate_order`: this exact signed order is already on the book or has already traded.
 * - `size_below_minimum`: fewer shares than the smallest order.
 * - `notional_below_minimum`: too small in dollars at this price.
 * - `price_out_of_range`: the price is outside 0.001 to 0.999.
 * - `invalid_expiration`: the expiration is missing, in the past or too soon.
 * - `market_not_active`: the market is not open for orders: not started, paused or over.
 * - `market_not_found`: XO has no market for this token.
 * - `insufficient_balance`: not enough USDC for the order.
 * - `insufficient_position`: fewer shares than the order sells.
 * - `account_not_found`: XO does not know this trading account.
 * - `order_cancelled_during_hold`: the order was cancelled while it waited to be matched.
 * - `trading_paused`: trading is paused for everyone.
 * - `rejected`: any other refusal. The `message` has the reason.
 */
export type OrderRejectionCode = (typeof ORDER_REJECTION_CODES)[number];

/** An order that XO refused. Nothing was placed. */
export type RejectedOrderResponse = {
  /** `false`: the order was refused. */
  ok: false;
  /** The hash of the signed order, computed here before it was sent. */
  orderHash: OrderHash;
  /** Why the order was refused. */
  code: OrderRejectionCode;
  /** XO's words for the refusal. */
  message: string;
};

/** The result of placing an order: accepted or refused, told apart by `ok`. */
export type OrderResponse = AcceptedOrderResponse | RejectedOrderResponse;

/**
 * The messages XO gives for an order it refuses, by the code they become. The first rule
 * that matches wins; the rules do not overlap. A message is matched by its text, without
 * regard to letter case, and whatever is wrapped around it: a refusal inside a batch result
 * can come with words in front, such as `trading error: `.
 */
const REFUSAL_RULES: ReadonlyArray<
  readonly [Exclude<OrderRejectionCode, 'rejected'>, RegExp]
> = [
  ['trading_paused', /global trading is paused|trading_paused/i],
  [
    'order_cancelled_during_hold',
    /order_cancelled_during_hold|cancelled (while in|during) (the )?taker-delay hold/i,
  ],
  ['post_only_would_cross', /post-only order would cross/i],
  [
    'duplicate_order',
    /duplicate order|already exists in book|order hash already matched/i,
  ],
  ['size_below_minimum', /size below minimum/i],
  ['notional_below_minimum', /notional below minimum/i],
  ['price_out_of_range', /invalid price tick|price tick out of range/i],
  [
    'invalid_expiration',
    /expiration (is in the past|too large)|requires non-zero expiration/i,
  ],
  [
    'market_not_active',
    /market is not active|only the conviction market creator/i,
  ],
  ['market_not_found', /market not found/i],
  ['insufficient_balance', /insufficient balance/i],
  ['insufficient_position', /insufficient position/i],
  ['account_not_found', /user not found/i],
];

/**
 * The code of a refusal message: an {@link OrderRejectionCode}, `rejected` when
 * the message is not one XO is known to give.
 *
 * @internal
 */
export function orderRejectionCode(message: string): OrderRejectionCode {
  for (const [code, pattern] of REFUSAL_RULES) {
    if (pattern.test(message)) {
      return code;
    }
  }
  return 'rejected';
}

const NO_REASON = 'XO refused the order and gave no reason';

/**
 * The {@link RejectedOrderResponse} of an order that XO refused with `message`. The message
 * is kept as it was; an empty one is replaced by a plain statement that none was given.
 *
 * @internal
 */
export function toRejectedOrderResponse(
  message: string,
  orderHash: OrderHash,
): RejectedOrderResponse {
  return {
    ok: false,
    orderHash,
    code: orderRejectionCode(message),
    message: message.trim() === '' ? NO_REASON : message,
  };
}

/**
 * Maps the answer to a placement to an {@link OrderResponse}. The micro-unit amounts of the
 * answer become whole-unit decimals, exactly. An amount is never `null` here: the answer to a
 * single placement always carries both, and an empty one is how the order book has long
 * written zero, so it is `"0"`.
 *
 * An answer with `success: false` is a refusal: its `errorMsg` becomes the `message` and its
 * {@link orderRejectionCode} the `code`. Every other answer is accepted as it is, a `delayed`
 * one with nothing filled included: such an order is held for the taker delay and can still
 * fill.
 *
 * @param raw The answer to the placement.
 * @param orderHash The hash of the signed order, computed before it was sent.
 * @throws {UnexpectedResponseError} When an amount of an accepted order is not digits.
 * @internal
 */
export function toOrderResponse(
  raw: RawPlaceOrderResponse,
  orderHash: OrderHash,
): OrderResponse {
  if (!raw.success) {
    return toRejectedOrderResponse(raw.errorMsg ?? '', orderHash);
  }
  const makingAmount = wholeUnitsOf(raw.makingAmount, 'makingAmount');
  const takingAmount = wholeUnitsOf(raw.takingAmount, 'takingAmount');
  const answeredId: string = raw.orderID;
  return {
    ok: true,
    orderId: answeredId === '' ? orderHash : answeredId,
    orderHash,
    status: raw.status,
    makingAmount,
    takingAmount,
    tradeIds: [...raw.tradeIds],
    transactionsHashes: raw.transactionsHashes.filter((hash): hash is Hex =>
      isHash(hash),
    ),
  };
}

/** The expiration of an open order: `"0"` means it does not expire. */
function expirationOf(value: string): string | null {
  return value === '0' ? null : isoFromSeconds(value);
}

/**
 * Maps an open order of the account to the {@link OpenOrder} model.
 *
 * @throws {UnexpectedResponseError} When the creation time is not a time.
 * @internal
 */
export function toOpenOrder(raw: RawOpenOrder): OpenOrder {
  return {
    orderId: raw.id,
    assetId: tokenIdOf(raw.asset_id),
    market: conditionIdOf(raw.market),
    outcome: raw.outcome,
    side: raw.side as OrderSide,
    price: raw.price,
    originalSize: raw.original_size,
    sizeMatched: raw.size_matched,
    status: raw.status,
    orderType: raw.order_type as OrderType,
    expiration: expirationOf(raw.expiration),
    createdAt: requireIso(raw.created_at, 'createdAt'),
    makerAddress: addressOf(raw.maker_address),
  };
}

/**
 * The texts of a batch entry known not to say what became of its order: it may have been
 * placed, or may not.
 *
 * - `engine reply channel dropped`: XO's matching engine took the order, and its answer was
 *   lost on the way back.
 * - `engine has stopped`: the engine's answer was lost, after it may have taken the order. An
 *   order sent alone or in a batch can also come back with this text when it never reached the
 *   engine, which would be a definite failure; the two read alike, so both are taken as
 *   unknown, on purpose.
 * - `trade log error`: XO does not answer a placement with it today; it is here so that, if
 *   it ever does, it is never taken for a refusal.
 *
 * Every text that is neither one of these nor one of the `DEFINITE_REFUSALS` is unknown too.
 */
const UNKNOWN_OUTCOME =
  /engine has stopped|engine reply channel dropped|trade log error/i;

/**
 * The texts of a batch entry that are XO's definite refusal of its order. XO gives each of them
 * when it turns the order down before matching it, or instead of matching it, so nothing of
 * the order was placed. They are matched from the start of the text, as XO writes them.
 */
const DEFINITE_REFUSALS: readonly RegExp[] = [
  // The matching engine refused the order. Its refusals come before any match: the market,
  // a pause, the expiry, a conviction market's rules, post-only, and the account's balance or
  // position.
  /^trading error: /,
  /^validation error: /,
  // The same refusals, met without the `trading error: ` in front.
  /^(engine error|accounting error): /,
  /^market not found/,
  /^global trading is paused/,
  /^order cancelled during taker-delay hold/,
  // The checks of the price and the size before the order goes to the engine.
  /^(invalid price tick|invalid size|size below minimum|notional below minimum)\b/,
  // XO's checks of each order of a batch: the funder, the side, the amounts, the order type
  // and its expiration, and post-only.
  /^funder is not a valid Ethereum address/,
  /^invalid request: funder exceeds maximum length/,
  /^invalid side in order$/,
  /^order amount: /,
  /^invalid request: (unsupported orderType|GTD order requires non-zero expiration|(GTC|GTD) expiration (is in the past or too soon|too large))/,
  /^postOnly orders must use orderType GTC or GTD$/,
  // The signature of an order of a batch with operations, which XO checks before anything else.
  /^(signature mismatch|invalid signature|unsupported signature type|signature type \d+ requires a configured JSON-RPC URL|signature verification failed|EIP-1271)/,
  // An EIP-1271 signature check that failed, under a code of its family: an upper-case name,
  // then `_1271`, then a colon.
  /^[A-Z]+_1271:/,
];

/** Whether an entry's text is one of XO's definite refusals of the order. */
function isDefiniteRefusalText(text: string): boolean {
  return (
    !UNKNOWN_OUTCOME.test(text) &&
    DEFINITE_REFUSALS.some((family) => family.test(text))
  );
}

/** A batch's remaining size of zero: `"0"`, or zero with decimals. */
const ZERO_SIZE = /^0+(\.0+)?$/;

/**
 * Maps one entry of a batch answer to the {@link OrderResponse} of the order sent at its
 * position, whose hash is `orderHash`. `undefined` when the entry does not say what became of
 * the order: it may have been placed, so it is neither accepted nor refused. An entry with an
 * error is a refusal only when its text is one of XO's definite refusals; any other text, one
 * the SDK does not know included, is `undefined`.
 *
 * A batch answer carries no amounts, trade ids or transactions: an accepted order has
 * `makingAmount`, `takingAmount`, `tradeIds` and `transactionsHashes` all `null`. Its status
 * follows the entry as a single placement's does: `matched` when it filled and nothing is
 * left, `live` when it rests, else `delayed`.
 *
 * @internal
 */
export function toBatchOrderResponse(
  entry: RawBatchPlaceEntry,
  orderHash: OrderHash,
): OrderResponse | undefined {
  if (entry.error !== null) {
    return isDefiniteRefusalText(entry.error)
      ? toRejectedOrderResponse(entry.error, orderHash)
      : undefined;
  }
  const filled = entry.fills !== null && entry.fills > 0;
  const status: OrderPostStatus =
    filled &&
    entry.remaining_size !== null &&
    ZERO_SIZE.test(entry.remaining_size)
      ? 'matched'
      : entry.resting === true
        ? 'live'
        : 'delayed';
  return {
    ok: true,
    orderId:
      entry.order_id === null || entry.order_id === ''
        ? orderHash
        : entry.order_id,
    orderHash,
    status,
    makingAmount: null,
    takingAmount: null,
    tradeIds: null,
    transactionsHashes: null,
  };
}

/** What a cancel did: the orders it cancelled, and why each other one was not. */
export type CancelOrdersResponse = {
  /** The ids of the orders that were cancelled. */
  canceled: string[];
  /** The orders that were not cancelled, by id, with XO's reason, such as `order not found`. */
  notCanceled: Record<string, string>;
};

/** What one operation of {@link SecureClient.postOrderBatch} did, in the order of the operations. */
export type BatchOperationResult =
  | {
      /** Orders placed. */
      type: 'place';
      /** The result of each order, in the order given. */
      orders: OrderResponse[];
    }
  | ({
      /** Orders cancelled. */
      type: 'cancel';
    } & CancelOrdersResponse);

/**
 * Maps the answer to a cancel to a {@link CancelOrdersResponse}, copying it.
 *
 * @internal
 */
export function toCancelOrdersResponse(
  raw: RawCancelResult,
): CancelOrdersResponse {
  return { canceled: [...raw.canceled], notCanceled: { ...raw.notCanceled } };
}

/**
 * Where an order that may have been placed is:
 *
 * - `resting`: it is open, on the book or held for the taker delay, possibly partly filled
 *   (see {@link OpenOrder.sizeMatched}). It can be cancelled.
 * - `traded`: it is no longer open, and it traded: these are its trades among the account's
 *   latest ones.
 * - `not_found`: neither, as far as the lookups reached. This is not proof that it was not
 *   placed: the placement may still be on its way, or the order traded before the trades
 *   read. Look again later, and never send or sign it again on the strength of it.
 */
export type ReconciledOrder =
  | { state: 'resting'; order: OpenOrder }
  | { state: 'traded'; trades: Trade[] }
  | { state: 'not_found' };

/**
 * Maps where an order is to the {@link ReconciledOrder} model.
 *
 * @throws {UnexpectedResponseError} When a time of the order or of a trade is not a time.
 * @internal
 */
export function toReconciledOrder(raw: RawReconcileResult): ReconciledOrder {
  switch (raw.state) {
    case 'resting':
      return { state: 'resting', order: toOpenOrder(raw.order) };
    case 'traded':
      return { state: 'traded', trades: raw.trades.map(toTrade) };
    default:
      return { state: 'not_found' };
  }
}
