import { z } from 'zod';
import { withLanded } from '../account/internal';
import type { ActionContext } from '../clients/context';
import {
  makeErrorGuard,
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
import { normalizeTokenId } from '../core/ids';
import { type Paginated, toPaginated } from '../core/paginated';
import {
  parseRequestOptions,
  type RequestOptions,
} from '../core/requestOptions';
import { wasNotSent } from '../core/transport';
import type { OrderHash } from '../core/types';
import type { OrderSide, OrderType } from '../models/enums';
import {
  type BatchOperationResult,
  type CancelOrdersResponse,
  type OpenOrder,
  type OrderResponse,
  orderRejectionCode,
  type ReconciledOrder,
  type RejectedOrderResponse,
  type SignedOrder,
  toBatchOrderResponse,
  toCancelOrdersResponse,
  toOpenOrder,
  toOrderResponse,
  toReconciledOrder,
  toRejectedOrderResponse,
} from '../models/orders';
import { type Trade, toTrade } from '../models/trades';
import { readOrderRef } from '../orderbook/internal';
import {
  type BatchOpResult,
  BatchOpsIncompleteError,
  BatchPlaceIncompleteError,
  type BatchPlaceResult,
  failureAfterAnswer,
  PlacementError,
  type PlaceOrderResult,
  placementOutcome,
  readAnswered,
  unknownOutcome,
  withPlacement,
} from '../orderbook/placement';
import type { BatchOp } from '../orderbook/trading';
import { fields, parseInput } from './internal';

// The trading actions of a signed-in client: building and signing orders, sending them,
// cancelling them, and reading the account's own orders and trades.
//
// What a placement answers decides what the caller gets, and the two are never mixed up:
// - XO accepted the order: `{ ok: true, ... }`.
// - XO refused it, for good (a 4xx other than 401, 403 and 429, or trading paused): `{ ok:
//   false, code, message }`. Nothing was placed.
// - Anything else is thrown, with `mayHaveLanded` and the order's `orderHash`: an input or
//   credential problem (`mayHaveLanded: false`), and every failure after which the order may
//   be on the book (`mayHaveLanded: true`: a timeout, a lost connection, a 5xx, an answer
//   that cannot be read). Such an order is never sent or signed again; the caller looks it up
//   with `reconcileOrder`.
//
// Cancels are sent once too. A cancel XO answers is its result (an order that is not open is
// not cancelled, not an error); one whose answer is lost throws with `mayHaveLanded: true`,
// since it may have cancelled orders, and one refused or never sent says `false`.
//
// No call that sends orders or cancels takes request options: it is sent once, and aborting
// it could not undo it.

export type {
  BatchOperationResult,
  CancelOrdersResponse,
  ReconciledOrder,
  SignedOrder,
} from '../models/orders';

// ---------------------------------------------------------------------------
// Shared checks
// ---------------------------------------------------------------------------

/** A price, a size or an amount: a number, or a decimal string. */
const quantity = () =>
  z.union([z.number(), z.string()], {
    error: 'must be a number or a decimal string',
  });

/** An order id: an order hash, or a numeric order id; given back in canonical form. */
const orderRef = () =>
  z
    .string({
      error:
        'must be an order hash (0x and 64 hex characters) or a numeric order id',
    })
    .refine(
      (value) => {
        try {
          readOrderRef(value, 'orderId');
          return true;
        } catch {
          return false;
        }
      },
      {
        error:
          'must be an order hash (0x and 64 hex characters) or a numeric order id',
      },
    )
    .transform((value) => readOrderRef(value, 'orderId'));

/** An order's or a trade's hash: `0x` and 64 hex digits. */
const hash = () => {
  const message = 'must be 0x followed by 64 hex characters';
  return z
    .string({ error: message })
    .regex(/^0x[0-9a-fA-F]{64}$/, { error: message });
};

/** A unix time in seconds stays below this for thousands of years; milliseconds are far above. */
const MAX_UNIX_SECONDS = 1e11;

/** A time as a `Date` or unix seconds. Milliseconds are refused, as for an expiration. */
const unixTime = () => {
  const message =
    'must be a Date or a whole number of unix seconds (not milliseconds)';
  return z.union(
    [
      fields.date(),
      z.number().int().min(0).max(MAX_UNIX_SECONDS, { error: message }),
    ],
    { error: message },
  );
};

/** The most order ids one cancel request takes: the order book's batch size. */
const MAX_CANCELS = 300;

/** The unix seconds of a time a request gave. */
const secondsOf = (time: Date | number): number =>
  typeof time === 'number' ? time : Math.floor(time.getTime() / 1000);

/** The statuses that are not refusals of the order: the request was not accepted as it was. */
const NOT_REFUSALS: ReadonlySet<number> = new Set([401, 403, 429]);

/**
 * Whether a failed request is XO's definite refusal of the orders in it: a 4xx other than
 * 401, 403 and 429, or a 503 `trading_paused`, of a request that was sent. Nothing in it was
 * placed then. A failure before anything was sent (a failed sign-in, or a refused one after a
 * 401) is not a refusal of the order: it is thrown.
 */
function isDefiniteRefusal(error: unknown): error is RequestRejectedError {
  if (!(error instanceof RequestRejectedError) || wasNotSent(error)) {
    return false;
  }
  if (error.status === 503) {
    return error.code === 'trading_paused';
  }
  return (
    error.status >= 400 && error.status < 500 && !NOT_REFUSALS.has(error.status)
  );
}

/**
 * The refusal of the order `orderHash` by `error`: its message, and the code of the message,
 * or of XO's own code when the message has none.
 */
function refusalOf(
  error: RequestRejectedError,
  orderHash: OrderHash,
): RejectedOrderResponse {
  const response = toRejectedOrderResponse(error.message, orderHash);
  if (response.code !== 'rejected') {
    return response;
  }
  return { ...response, code: orderRejectionCode(error.code) };
}

/** An error thrown before anything was sent: it says so, when it says nothing yet. */
function notSent(error: unknown): unknown {
  return error instanceof XoError ? withLanded(error, false) : error;
}

/**
 * The error of a cancel request, saying whether it may have cancelled orders although it threw:
 * `true` when its answer was lost (a timeout, a lost connection, a 5xx, an answer that could not
 * be read), `false` when XO refused it (a 4xx) or it was not sent.
 */
function cancelFailure(error: unknown): unknown {
  return error instanceof XoError
    ? withLanded(error, placementOutcome(error) === 'mayHaveLanded')
    : error;
}

// ---------------------------------------------------------------------------
// Error unions
// ---------------------------------------------------------------------------

/**
 * The error union of {@link SecureClient.createLimitOrder} and {@link SecureClient.createMarketOrder}: the request
 * (`UserInputError`), the wallet's signature (`SigningError`), the reads that building an order
 * makes (the market's tick size and the account's exchange nonce, and the sign-in the client
 * makes when its credentials are refused), and a plain {@link XoError} for the codes of the
 * client's session (`session_closed`), of the nonce (`nonce_unavailable`) and of a smart wallet
 * that cannot sign in.
 */
export type CreateLimitOrderError =
  | UserInputError
  | SigningError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | UnexpectedResponseError
  | XoError;
/** The guard of {@link CreateLimitOrderError}. */
export const CreateLimitOrderError = makeErrorGuard(
  UserInputError,
  SigningError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  UnexpectedResponseError,
  XoError,
);

/** The error union of {@link SecureClient.createMarketOrder}: see {@link CreateLimitOrderError}. */
export type CreateMarketOrderError = CreateLimitOrderError;
/** The guard of {@link CreateMarketOrderError}. */
export const CreateMarketOrderError = CreateLimitOrderError;

/**
 * The error union of {@link SecureClient.postOrder}. Every error thrown once the order may have been sent
 * carries the order's `orderHash` and `mayHaveLanded`: when that is `true`, the order may be on
 * the book, so never send or sign it again; look it up with `reconcileOrder`. A
 * {@link PlacementError} wraps a failure that was not the SDK's own.
 */
export type PostOrderError =
  | UserInputError
  | SigningError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | UnexpectedResponseError
  | PlacementError
  | XoError;
/** The guard of {@link PostOrderError}. */
export const PostOrderError = makeErrorGuard(
  UserInputError,
  SigningError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  UnexpectedResponseError,
  PlacementError,
  XoError,
);

/** The error union of {@link SecureClient.placeLimitOrder}: those of signing and of {@link SecureClient.postOrder}. */
export type PlaceLimitOrderError = PostOrderError;
/** The guard of {@link PlaceLimitOrderError}. */
export const PlaceLimitOrderError = PostOrderError;

/** The error union of {@link SecureClient.placeMarketOrder}: those of signing and of {@link SecureClient.postOrder}. */
export type PlaceMarketOrderError = PostOrderError;
/** The guard of {@link PlaceMarketOrderError}. */
export const PlaceMarketOrderError = PostOrderError;

/**
 * The error union of {@link SecureClient.postOrders}: the list of orders (`UserInputError`), a client that
 * is closing (`session_closed`), and every failure of a request or of an answer, as a
 * {@link BatchPlaceIncompleteError} that says which orders may have been placed.
 */
export type PostOrdersError =
  | UserInputError
  | BatchPlaceIncompleteError
  | XoError;
/** The guard of {@link PostOrdersError}. */
export const PostOrdersError = makeErrorGuard(
  UserInputError,
  BatchPlaceIncompleteError,
  XoError,
);

/**
 * The error union of {@link SecureClient.postOrderBatch}: the operations (`UserInputError`), a client that
 * is closing (`session_closed`), and every failure of the request or of its answer, as a
 * {@link BatchOpsIncompleteError} that says which orders may have been placed.
 */
export type PostOrderBatchError =
  | UserInputError
  | BatchOpsIncompleteError
  | XoError;
/** The guard of {@link PostOrderBatchError}. */
export const PostOrderBatchError = makeErrorGuard(
  UserInputError,
  BatchOpsIncompleteError,
  XoError,
);

/**
 * The error union of {@link SecureClient.cancelOrder}: the request, the errors of the cancel request (sent
 * once: they say `mayHaveLanded: true` when the cancel may have gone through, `false` when it did
 * not), the sign-in the client makes when its credentials are refused, and a plain
 * {@link XoError} for the session's codes.
 */
export type CancelOrderError =
  | UserInputError
  | SigningError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | UnexpectedResponseError
  | XoError;
/** The guard of {@link CancelOrderError}. */
export const CancelOrderError = makeErrorGuard(
  UserInputError,
  SigningError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  UnexpectedResponseError,
  XoError,
);

/** The error union of {@link SecureClient.cancelOrders}: see {@link CancelOrderError}. */
export type CancelOrdersError = CancelOrderError;
/** The guard of {@link CancelOrdersError}. */
export const CancelOrdersError = CancelOrderError;

/** The error union of {@link SecureClient.cancelAll}: see {@link CancelOrderError}. */
export type CancelAllError = CancelOrderError;
/** The guard of {@link CancelAllError}. */
export const CancelAllError = CancelOrderError;

/** The error union of {@link SecureClient.cancelMarketOrders}: see {@link CancelOrderError}. */
export type CancelMarketOrdersError = CancelOrderError;
/** The guard of {@link CancelMarketOrdersError}. */
export const CancelMarketOrdersError = CancelOrderError;

/**
 * The error union of the reads of the account's orders and trades: the request and options, a
 * read that was cancelled, timed out or refused, and the sign-in the client makes when its
 * credentials are refused.
 */
export type ListOpenOrdersError =
  | UserInputError
  | SigningError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError
  | XoError;
/** The guard of {@link ListOpenOrdersError}. */
export const ListOpenOrdersError = makeErrorGuard(
  UserInputError,
  SigningError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
  XoError,
);

/** The error union of {@link SecureClient.fetchOrder}: see {@link ListOpenOrdersError}. */
export type FetchOrderError = ListOpenOrdersError;
/** The guard of {@link FetchOrderError}. */
export const FetchOrderError = ListOpenOrdersError;

/** The error union of {@link SecureClient.listAccountTrades}: see {@link ListOpenOrdersError}. */
export type ListAccountTradesError = ListOpenOrdersError;
/** The guard of {@link ListAccountTradesError}. */
export const ListAccountTradesError = ListOpenOrdersError;

/** The error union of {@link SecureClient.fetchAccountTrade}: see {@link ListOpenOrdersError}. */
export type FetchAccountTradeError = ListOpenOrdersError;
/** The guard of {@link FetchAccountTradeError}. */
export const FetchAccountTradeError = ListOpenOrdersError;

/** The error union of {@link SecureClient.reconcileOrder}: see {@link ListOpenOrdersError}. */
export type ReconcileOrderError = ListOpenOrdersError;
/** The guard of {@link ReconcileOrderError}. */
export const ReconcileOrderError = ListOpenOrdersError;

/**
 * The error union of {@link SecureClient.sendOrderHeartbeat}: the errors of its one request, which is never
 * tried again, and of the sign-in the client makes when its credentials are refused.
 */
export type SendOrderHeartbeatError = CancelOrderError;
/** The guard of {@link SendOrderHeartbeatError}. */
export const SendOrderHeartbeatError = CancelOrderError;

/**
 * The error union of {@link SecureClient.startOrderHeartbeat}: the request, a heartbeat that is already
 * running (`heartbeat_already_running`), and a client whose session is closed.
 */
export type StartOrderHeartbeatError = UserInputError | XoError;
/** The guard of {@link StartOrderHeartbeatError}. */
export const StartOrderHeartbeatError = makeErrorGuard(UserInputError, XoError);

// ---------------------------------------------------------------------------
// createLimitOrder, placeLimitOrder
// ---------------------------------------------------------------------------

/** What {@link SecureClient.createLimitOrder} and {@link SecureClient.placeLimitOrder} take. */
export type CreateLimitOrderRequest = {
  /** The outcome token to trade: `outcomes.yes.tokenId` or `outcomes.no.tokenId` of a market. */
  assetId: string;
  /** Whether the order buys or sells shares: `OrderSide.BUY` or `OrderSide.SELL`. */
  side: OrderSide;
  /**
   * The price per share in dollars, from 0.001 to 0.999, a multiple of the market's tick size.
   * Nothing is rounded.
   */
  price: number | string;
  /** How many shares: at least 1, with at most 6 decimals. */
  size: number | string;
  /**
   * Refuse the order rather than let it trade at once, so it only ever rests on the book.
   * Defaults to `false`.
   */
  postOnly?: boolean;
  /**
   * When the order expires, which makes it a good-till-date order: a `Date`, or unix seconds
   * (milliseconds are refused). At least a second after XO's clock. Without it, the order is
   * good till cancelled.
   */
  expiration?: Date | number;
};

/** What {@link SecureClient.placeLimitOrder} takes: see {@link CreateLimitOrderRequest}. */
export type PlaceLimitOrderRequest = CreateLimitOrderRequest;

const CreateLimitOrderSchema = z.strictObject({
  assetId: fields.assetId(),
  side: fields.side(),
  price: quantity(),
  size: quantity(),
  postOnly: fields.bool().optional(),
  expiration: z
    .union([fields.date(), z.number()], {
      error: 'must be a Date or a number of unix seconds',
    })
    .optional(),
});

async function signLimit(
  ctx: ActionContext,
  label: string,
  request: CreateLimitOrderRequest,
): Promise<SignedOrder> {
  const input = parseInput(label, request, CreateLimitOrderSchema);
  ctx.secure?.assertOpen();
  return ctx.orderbook.createOrder({
    tokenId: input.assetId,
    side: input.side,
    price: input.price,
    size: input.size,
    type: input.expiration === undefined ? 'GTC' : 'GTD',
    ...(input.postOnly === undefined ? {} : { postOnly: input.postOnly }),
    ...(input.expiration === undefined ? {} : { expiration: input.expiration }),
  });
}

/**
 * Builds and signs a limit order without sending it. The order is good till cancelled, or good
 * till date with an `expiration`.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export function createLimitOrder(
  ctx: ActionContext,
  request: CreateLimitOrderRequest,
): Promise<SignedOrder> {
  return signLimit(ctx, 'createLimitOrder', request);
}

/**
 * Builds, signs and sends a limit order. A refusal by XO is the value `{ ok: false, code }`; a
 * failure after which the order may be on the book throws with `mayHaveLanded: true`.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function placeLimitOrder(
  ctx: ActionContext,
  request: PlaceLimitOrderRequest,
): Promise<OrderResponse> {
  let order: SignedOrder;
  try {
    order = await signLimit(ctx, 'placeLimitOrder', request);
  } catch (error) {
    throw notSent(error);
  }
  return send(ctx, order);
}

// ---------------------------------------------------------------------------
// createMarketOrder, placeMarketOrder
// ---------------------------------------------------------------------------

/** A market order that buys: it spends `amount` dollars. */
export type MarketBuyOrderRequest = {
  /** The outcome token to buy: `outcomes.yes.tokenId` or `outcomes.no.tokenId` of a market. */
  assetId: string;
  /** `OrderSide.BUY`. */
  side: OrderSide.BUY;
  /** How many dollars to spend, with at most 6 decimals. */
  amount: number | string;
  /**
   * The highest price per share to pay: the order only fills at this price or better. From
   * 0.001 to 0.999, a multiple of the market's tick size. Without it the order takes any price
   * up to 0.999.
   */
  maxPrice?: number | string;
  /**
   * What happens to the part that does not fill at once: `OrderType.FAK` (the default) drops it,
   * `OrderType.FOK` drops the whole order unless all of it fills.
   */
  orderType?: OrderType.FAK | OrderType.FOK;
};

/** A market order that sells: it gives `shares` shares. */
export type MarketSellOrderRequest = {
  /** The outcome token to sell: `outcomes.yes.tokenId` or `outcomes.no.tokenId` of a market. */
  assetId: string;
  /** `OrderSide.SELL`. */
  side: OrderSide.SELL;
  /** How many shares to sell: at least 1, with at most 6 decimals. */
  shares: number | string;
  /**
   * The lowest price per share to take: the order only fills at this price or better. From
   * 0.001 to 0.999, a multiple of the market's tick size. Without it the order takes any price
   * down to 0.001.
   */
  minPrice?: number | string;
  /** What happens to the part that does not fill at once: see {@link MarketBuyOrderRequest}. */
  orderType?: OrderType.FAK | OrderType.FOK;
};

/**
 * What {@link SecureClient.createMarketOrder} and {@link SecureClient.placeMarketOrder} take: a buy of an `amount` of
 * dollars, or a sell of a number of `shares`.
 */
export type CreateMarketOrderRequest =
  | MarketBuyOrderRequest
  | MarketSellOrderRequest;

/** What {@link SecureClient.placeMarketOrder} takes: see {@link CreateMarketOrderRequest}. */
export type PlaceMarketOrderRequest = CreateMarketOrderRequest;

const CreateMarketOrderSchema = z
  .strictObject({
    assetId: fields.assetId(),
    side: fields.side(),
    amount: quantity().optional(),
    shares: quantity().optional(),
    maxPrice: quantity().optional(),
    minPrice: quantity().optional(),
    orderType: fields.oneOf(['FAK', 'FOK']).optional(),
  })
  .superRefine((value, ctx) => {
    const [wanted, other] =
      value.side === 'BUY' ? ['amount', 'shares'] : ['shares', 'amount'];
    const record = value as Record<string, unknown>;
    if (record[wanted] === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [wanted],
        message: `is required for a market ${value.side === 'BUY' ? 'buy' : 'sell'}`,
        input: value,
      });
    } else if (record[other] !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [other],
        message: `is not for a market ${value.side === 'BUY' ? 'buy: it spends an amount' : 'sell: it gives shares'}`,
        input: value,
      });
    }
    const otherCap = value.side === 'BUY' ? 'minPrice' : 'maxPrice';
    if (record[otherCap] !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [otherCap],
        message: `is not for a market ${value.side === 'BUY' ? 'buy: its worst price is maxPrice' : 'sell: its worst price is minPrice'}`,
        input: value,
      });
    }
  });

async function signMarket(
  ctx: ActionContext,
  label: string,
  request: CreateMarketOrderRequest,
): Promise<SignedOrder> {
  const input = parseInput(label, request, CreateMarketOrderSchema);
  ctx.secure?.assertOpen();
  return ctx.orderbook.createMarketOrder({
    tokenId: input.assetId,
    side: input.side,
    amount: (input.side === 'BUY' ? input.amount : input.shares) as
      | number
      | string,
    ...(input.maxPrice === undefined ? {} : { maxPrice: input.maxPrice }),
    ...(input.minPrice === undefined ? {} : { minPrice: input.minPrice }),
    ...(input.orderType === undefined ? {} : { type: input.orderType }),
  });
}

/**
 * Builds and signs a market order without sending it: a fill-and-kill (or fill-or-kill) order at
 * the worst price, so it takes the best prices on the book.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export function createMarketOrder(
  ctx: ActionContext,
  request: CreateMarketOrderRequest,
): Promise<SignedOrder> {
  return signMarket(ctx, 'createMarketOrder', request);
}

/**
 * Builds, signs and sends a market order, with the results of {@link SecureClient.placeLimitOrder}.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function placeMarketOrder(
  ctx: ActionContext,
  request: PlaceMarketOrderRequest,
): Promise<OrderResponse> {
  let order: SignedOrder;
  try {
    order = await signMarket(ctx, 'placeMarketOrder', request);
  } catch (error) {
    throw notSent(error);
  }
  return send(ctx, order);
}

// ---------------------------------------------------------------------------
// postOrder
// ---------------------------------------------------------------------------

/**
 * Sends one signed order, once, and turns the outcome into a result or an error (see the top
 * of this module).
 */
async function send(
  ctx: ActionContext,
  order: SignedOrder,
): Promise<OrderResponse> {
  ctx.secure?.assertOpen();
  let result: PlaceOrderResult;
  try {
    result = await ctx.orderbook.postOrder(order);
  } catch (error) {
    // Only an error of a request that was sent carries `orderHash`; a refusal says
    // `mayHaveLanded: false`, and a timeout or a 5xx never does.
    if (
      error instanceof RequestRejectedError &&
      error.mayHaveLanded === false &&
      typeof error.orderHash === 'string' &&
      isDefiniteRefusal(error)
    ) {
      return refusalOf(error, error.orderHash);
    }
    throw notSent(error);
  }
  try {
    return toOrderResponse(result, result.orderHash);
  } catch (error) {
    // XO answered: the order was taken, whatever could not be read in the answer.
    throw withPlacement(error, result.orderHash, true);
  }
}

/**
 * Sends one order that {@link SecureClient.createLimitOrder} or {@link SecureClient.createMarketOrder} signed, once.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function postOrder(
  ctx: ActionContext,
  order: SignedOrder,
): Promise<OrderResponse> {
  return send(ctx, order);
}

// ---------------------------------------------------------------------------
// postOrders
// ---------------------------------------------------------------------------

/**
 * Sends signed orders in batches of at most 300, one batch after another, each once. Every
 * order gets its result, in the order given.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function postOrders(
  ctx: ActionContext,
  orders: SignedOrder[],
): Promise<OrderResponse[]> {
  ctx.secure?.assertOpen();
  let results: BatchPlaceResult[];
  try {
    results = await ctx.orderbook.postOrders(orders);
  } catch (error) {
    if (!(error instanceof BatchPlaceIncompleteError)) {
      throw notSent(error);
    }
    // XO refused a batch for good, and no order was left unsent: every order has its result.
    // An answered order whose fate is unknown made the error say `mayHaveLanded: true`, so
    // `results` here holds every answered order.
    const cause = error.cause;
    if (
      !error.mayHaveLanded &&
      error.notSent.length === 0 &&
      error.failedChunk.length > 0 &&
      isDefiniteRefusal(cause)
    ) {
      return [
        ...error.results,
        ...error.failedChunk.map((orderHash) => refusalOf(cause, orderHash)),
      ];
    }
    throw error;
  }
  const answered = readAnswered(results);
  if (answered.unknown.length > 0) {
    throw unknownOutcome(answered.responses, answered.unknown, undefined);
  }
  return answered.responses;
}

// ---------------------------------------------------------------------------
// postOrderBatch
// ---------------------------------------------------------------------------

/**
 * One operation of {@link SecureClient.postOrderBatch}: signed orders to place, or ids of orders to cancel.
 */
export type BatchOperation =
  | {
      /** Place orders. */
      type: 'place';
      /** The orders, each signed by {@link SecureClient.createLimitOrder} or {@link SecureClient.createMarketOrder}. */
      orders: SignedOrder[];
    }
  | {
      /** Cancel orders. */
      type: 'cancel';
      /** The ids of the orders: order hashes or numeric order ids. */
      orderIds: string[];
    };

/** What {@link SecureClient.postOrderBatch} takes. */
export type PostOrderBatchRequest = {
  /** The operations, run in this order. */
  operations: BatchOperation[];
};

const OperationSchema = z.discriminatedUnion(
  'type',
  [
    z.strictObject({
      type: z.literal('place'),
      orders: z
        .array(z.unknown(), { error: 'must be a list of signed orders' })
        .min(1, { error: 'must hold at least one signed order' }),
    }),
    z.strictObject({
      type: z.literal('cancel'),
      orderIds: z
        .array(orderRef(), { error: 'must be a list of order ids' })
        .min(1, { error: 'must hold at least one order id' }),
    }),
  ],
  {
    error: "must be { type: 'place', orders } or { type: 'cancel', orderIds }",
  },
);

const PostOrderBatchSchema = z.strictObject({
  operations: z
    .array(OperationSchema, { error: 'must be a list of operations' })
    .min(1, { error: 'must hold at least one operation' }),
});

type CheckedOperation = z.output<typeof OperationSchema>;

/** The hashes of the orders an operation sends, as the order book computes them. */
const hashesOf = (operation: { orders: unknown[] }): OrderHash[] =>
  operation.orders.map(
    (order) =>
      String((order as SignedOrder).orderHash).toLowerCase() as OrderHash,
  );

/**
 * The results of a batch XO refused before any of it ran: every order refused, every cancel not
 * made, with XO's reason.
 */
function refusedBatch(
  operations: readonly CheckedOperation[],
  orderHashes: readonly OrderHash[],
  cause: RequestRejectedError,
): BatchOperationResult[] {
  let next = 0;
  return operations.map((operation): BatchOperationResult => {
    if (operation.type === 'place') {
      const hashes = orderHashes.slice(next, next + operation.orders.length);
      next += operation.orders.length;
      return {
        type: 'place',
        orders: hashes.map((orderHash) => refusalOf(cause, orderHash)),
      };
    }
    return {
      type: 'cancel',
      canceled: [],
      notCanceled: Object.fromEntries(
        operation.orderIds.map((id) => [id, cause.message]),
      ),
    };
  });
}

/**
 * Places and cancels orders in one request: the operations run in order, and one that fails does
 * not undo another. Sent once.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function postOrderBatch(
  ctx: ActionContext,
  request: PostOrderBatchRequest,
): Promise<BatchOperationResult[]> {
  const input = parseInput('postOrderBatch', request, PostOrderBatchSchema);
  ctx.secure?.assertOpen();
  const operations = input.operations;
  const ops = operations.map(
    (operation): BatchOp =>
      operation.type === 'place'
        ? { type: 'place', orders: operation.orders as SignedOrder[] }
        : { type: 'cancel', ids: operation.orderIds },
  );
  let results: BatchOpResult[];
  try {
    results = await ctx.orderbook.batchOps(ops);
  } catch (error) {
    if (!(error instanceof BatchOpsIncompleteError)) {
      throw notSent(error);
    }
    const cause = error.cause;
    if (!error.mayHaveLanded && isDefiniteRefusal(cause)) {
      return refusedBatch(operations, error.orderHashes, cause);
    }
    throw error;
  }
  const unknown: OrderHash[] = [];
  const mapped = results.map((group, index): BatchOperationResult => {
    const operation = operations[index] as CheckedOperation;
    if (group.type === 'place') {
      if (group.payload === undefined) {
        // The group failed as a whole, and XO did not say what became of its orders.
        unknown.push(
          ...(operation.type === 'place' ? hashesOf(operation) : []),
        );
        return { type: 'place', orders: [] };
      }
      const orders: OrderResponse[] = [];
      for (const entry of group.payload) {
        const response = toBatchOrderResponse(entry, entry.orderHash);
        if (response === undefined) {
          unknown.push(entry.orderHash);
        } else {
          orders.push(response);
        }
      }
      return { type: 'place', orders };
    }
    if (group.payload === undefined) {
      const ids = operation.type === 'cancel' ? operation.orderIds : [];
      const reason = group.error ?? 'XO did not cancel this order';
      return {
        type: 'cancel',
        canceled: [],
        notCanceled: Object.fromEntries(ids.map((id) => [id, reason])),
      };
    }
    return { type: 'cancel', ...toCancelOrdersResponse(group.payload) };
  });
  if (unknown.length > 0) {
    throw new BatchOpsIncompleteError(
      `postOrderBatch: XO answered, but did not say what became of ${unknown.length} of the orders: they may have been placed (and filled): never resend or re-sign them; reconcile each of orderHashes with reconcileOrder`,
      {
        orderHashes: unknown,
        results: mapped,
        mayHaveLanded: true,
        cause: undefined,
      },
    );
  }
  return mapped;
}

// ---------------------------------------------------------------------------
// Cancels
// ---------------------------------------------------------------------------

/** What {@link SecureClient.cancelOrder} takes. */
export type CancelOrderRequest = {
  /** The order's id: its hash (the `orderId` of a placement), or a numeric order id. */
  orderId: string;
};

/** What {@link SecureClient.cancelOrders} takes. */
export type CancelOrdersRequest = {
  /** The orders' ids: order hashes or numeric order ids. At least one. */
  orderIds: string[];
};

/**
 * What {@link SecureClient.cancelMarketOrders} takes: the `market` (a condition id) to cancel every order
 * of, or the `assetId` of one outcome to cancel only its orders; both narrow to the orders of
 * that outcome in that market.
 */
export type CancelMarketOrdersRequest =
  | {
      /** The market's condition id, `0x` and 64 hex digits. */
      market: string;
      /** Only the orders of this outcome token. */
      assetId?: string;
    }
  | {
      /** The market's condition id, `0x` and 64 hex digits. */
      market?: string;
      /** Only the orders of this outcome token. */
      assetId: string;
    };

const CancelOrderSchema = z.strictObject({ orderId: orderRef() });
const CancelOrdersSchema = z.strictObject({
  orderIds: z
    .array(orderRef(), { error: 'must be a list of order ids' })
    .min(1, { error: 'must hold at least one order id' }),
});
const CancelMarketOrdersSchema = z
  .strictObject({
    market: fields.conditionId().optional(),
    assetId: fields.assetId().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.market === undefined && value.assetId === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'needs market, assetId or both',
        input: value,
      });
    }
  });

/** Cancels `ids` by id, 300 to a request, and puts the answers together. */
async function cancelByIds(
  ctx: ActionContext,
  ids: readonly string[],
): Promise<CancelOrdersResponse> {
  let canceled: string[] = [];
  let notCanceled: Record<string, string> = {};
  for (let start = 0; start < ids.length; start += MAX_CANCELS) {
    let answer: CancelOrdersResponse;
    try {
      answer = toCancelOrdersResponse(
        await ctx.orderbook.cancelOrders(ids.slice(start, start + MAX_CANCELS)),
      );
    } catch (error) {
      // Once a request was answered, orders may be cancelled whatever this one's failure was.
      throw start > 0 ? failureAfterAnswer(error) : cancelFailure(error);
    }
    canceled = [...canceled, ...answer.canceled];
    notCanceled = { ...notCanceled, ...answer.notCanceled };
  }
  return { canceled, notCanceled };
}

/**
 * Cancels one order of the account.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function cancelOrder(
  ctx: ActionContext,
  request: CancelOrderRequest,
): Promise<CancelOrdersResponse> {
  const input = parseInput('cancelOrder', request, CancelOrderSchema);
  ctx.secure?.assertOpen();
  try {
    return toCancelOrdersResponse(
      await ctx.orderbook.cancelOrder(input.orderId),
    );
  } catch (error) {
    // XO answers an order that is not open with a 404: it was not cancelled, as a cancel of
    // several orders says in `notCanceled`. A 404 of a sign-in before the cancel was sent is an
    // error of its own.
    if (
      error instanceof RequestRejectedError &&
      error.status === 404 &&
      !wasNotSent(error)
    ) {
      return {
        canceled: [],
        notCanceled: { [input.orderId]: error.message },
      };
    }
    throw cancelFailure(error);
  }
}

/**
 * Cancels orders of the account by id.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function cancelOrders(
  ctx: ActionContext,
  request: CancelOrdersRequest,
): Promise<CancelOrdersResponse> {
  const input = parseInput('cancelOrders', request, CancelOrdersSchema);
  ctx.secure?.assertOpen();
  return cancelByIds(ctx, input.orderIds);
}

/**
 * Cancels every open order of the account, in every market.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function cancelAll(
  ctx: ActionContext,
): Promise<CancelOrdersResponse> {
  ctx.secure?.assertOpen();
  try {
    return toCancelOrdersResponse(await ctx.orderbook.cancelAll());
  } catch (error) {
    throw cancelFailure(error);
  }
}

/**
 * Cancels the open orders of the account in one market, or of one outcome.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function cancelMarketOrders(
  ctx: ActionContext,
  request: CancelMarketOrdersRequest,
): Promise<CancelOrdersResponse> {
  const input = parseInput(
    'cancelMarketOrders',
    request,
    CancelMarketOrdersSchema,
  );
  ctx.secure?.assertOpen();
  if (input.assetId === undefined) {
    try {
      return toCancelOrdersResponse(
        await ctx.orderbook.cancelMarketOrders({
          conditionId: input.market as string,
        }),
      );
    } catch (error) {
      throw cancelFailure(error);
    }
  }
  // XO cancels a whole market, both outcomes at once: one outcome's orders are cancelled by id.
  // Reading them cancels nothing.
  const ids = new Set<string>();
  try {
    for await (const order of ctx.orderbook.getOpenOrders({
      conditionId: input.market,
      tokenId: input.assetId,
    })) {
      ids.add(order.id.toLowerCase());
    }
  } catch (error) {
    throw notSent(error);
  }
  if (ids.size === 0) {
    return { canceled: [], notCanceled: {} };
  }
  return cancelByIds(ctx, [...ids]);
}

// ---------------------------------------------------------------------------
// listOpenOrders, fetchOrder
// ---------------------------------------------------------------------------

/** What {@link SecureClient.listOpenOrders} takes. Every key is optional. */
export type ListOpenOrdersRequest = {
  /** Only the orders of this market: its condition id, `0x` and 64 hex digits. */
  market?: string;
  /** Only the orders of this outcome token. */
  assetId?: string;
};

const ListOpenOrdersSchema = z.strictObject({
  market: fields.conditionId().optional(),
  assetId: fields.assetId().optional(),
});

/**
 * Lists the account's orders that rest on the book, a page at a time.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export function listOpenOrders(
  ctx: ActionContext,
  request?: ListOpenOrdersRequest,
  options?: RequestOptions,
): Paginated<OpenOrder> {
  const input = parseInput('listOpenOrders', request, ListOpenOrdersSchema);
  const call = parseRequestOptions(options);
  const filters = { conditionId: input.market, tokenId: input.assetId };
  return toPaginated(
    'openOrders',
    (cursor) => {
      // A list made before the client closed reads nothing after.
      ctx.secure?.assertOpen();
      return ctx.orderbook.getOpenOrders(filters, call, cursor);
    },
    toOpenOrder,
  );
}

/** What {@link SecureClient.fetchOrder} takes. */
export type FetchOrderRequest = {
  /** The order's id: its hash (the `orderId` of a placement), or a numeric order id. */
  orderId: string;
};

const FetchOrderSchema = z.strictObject({ orderId: orderRef() });

/**
 * Reads one open order of the account.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function fetchOrder(
  ctx: ActionContext,
  request: FetchOrderRequest,
  options?: RequestOptions,
): Promise<OpenOrder> {
  const input = parseInput('fetchOrder', request, FetchOrderSchema);
  const call = parseRequestOptions(options);
  ctx.secure?.assertOpen();
  return toOpenOrder(await ctx.orderbook.getOrder(input.orderId, call));
}

// ---------------------------------------------------------------------------
// listAccountTrades, fetchAccountTrade
// ---------------------------------------------------------------------------

/** What {@link SecureClient.listAccountTrades} takes. Every key is optional. */
export type ListAccountTradesRequest = {
  /** Only the trades of this market: its condition id, `0x` and 64 hex digits. */
  market?: string;
  /** Only the trades of this outcome token. */
  assetId?: string;
  /** Only the trades matched before this time: a `Date`, or unix seconds. */
  before?: Date | number;
  /** Only the trades matched at or after this time: a `Date`, or unix seconds. */
  after?: Date | number;
};

const ListAccountTradesSchema = z.strictObject({
  market: fields.conditionId().optional(),
  assetId: fields.assetId().optional(),
  before: unixTime().optional(),
  after: unixTime().optional(),
});

/**
 * Lists the account's trades, newest first, a page at a time.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export function listAccountTrades(
  ctx: ActionContext,
  request?: ListAccountTradesRequest,
  options?: RequestOptions,
): Paginated<Trade> {
  const input = parseInput(
    'listAccountTrades',
    request,
    ListAccountTradesSchema,
  );
  const call = parseRequestOptions(options);
  // In the form the trade model gives: no leading zeros.
  const asset =
    input.assetId === undefined ? undefined : normalizeTokenId(input.assetId);
  const before =
    input.before === undefined ? undefined : secondsOf(input.before);
  const after = input.after === undefined ? undefined : secondsOf(input.after);
  // XO filters by market; the outcome and the time window are kept here, page by page.
  const keep = (trade: Trade): boolean => {
    if (asset !== undefined && trade.assetId !== asset) {
      return false;
    }
    const matched = Date.parse(trade.matchedAt) / 1000;
    return (
      (after === undefined || matched >= after) &&
      (before === undefined || matched < before)
    );
  };
  return toPaginated(
    'accountTrades',
    (cursor) => {
      ctx.secure?.assertOpen();
      return ctx.orderbook.getTrades(
        { conditionId: input.market },
        call,
        cursor,
      );
    },
    (raw) => {
      const trade = toTrade(raw);
      return keep(trade) ? trade : undefined;
    },
  );
}

/** What {@link SecureClient.fetchAccountTrade} takes. */
export type FetchAccountTradeRequest = {
  /** The trade's id, `0x` and 64 hex digits. */
  tradeId: string;
};

const FetchAccountTradeSchema = z.strictObject({ tradeId: hash() });

/**
 * Reads one trade of the account, to follow its settlement.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function fetchAccountTrade(
  ctx: ActionContext,
  request: FetchAccountTradeRequest,
  options?: RequestOptions,
): Promise<Trade> {
  const input = parseInput(
    'fetchAccountTrade',
    request,
    FetchAccountTradeSchema,
  );
  const call = parseRequestOptions(options);
  ctx.secure?.assertOpen();
  return toTrade(await ctx.orderbook.getTrade(input.tradeId, call));
}

// ---------------------------------------------------------------------------
// reconcileOrder
// ---------------------------------------------------------------------------

/** What {@link SecureClient.reconcileOrder} takes. */
export type ReconcileOrderRequest = {
  /** The order's hash: the `orderHash` of a result or of an error. */
  orderHash: string;
};

const ReconcileOrderSchema = z.strictObject({ orderHash: hash() });

/**
 * Finds out where an order that may have been placed is: open, traded, or not found.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function reconcileOrder(
  ctx: ActionContext,
  request: ReconcileOrderRequest,
  options?: RequestOptions,
): Promise<ReconciledOrder> {
  const input = parseInput('reconcileOrder', request, ReconcileOrderSchema);
  const call = parseRequestOptions(options);
  ctx.secure?.assertOpen();
  return toReconciledOrder(
    await ctx.orderbook.reconcileOrder(input.orderHash, {}, call),
  );
}

// ---------------------------------------------------------------------------
// Heartbeats
// ---------------------------------------------------------------------------

/** What {@link SecureClient.sendOrderHeartbeat} answers. */
export type OrderHeartbeatResponse = {
  /**
   * Whether XO counted the beat. `false` means it did not: the credentials were not accepted,
   * and the countdown to the cancel of every open order was not reset.
   */
  tracked: boolean;
};

/** A running order heartbeat, from {@link SecureClient.startOrderHeartbeat}. */
export interface OrderHeartbeat {
  /**
   * Stops sending heartbeats, and can be called again. It does not take the account out of the
   * cancel on silence: the open orders are cancelled about 30 seconds after the last beat.
   */
  stop(): void;
  /** `true` from the start until `stop()`. A missed beat does not change it. */
  readonly running: boolean;
}

/** What {@link SecureClient.startOrderHeartbeat} takes. Every key is optional. */
export type StartOrderHeartbeatRequest = {
  /** Milliseconds between two beats: a whole number from 1 000 to 20 000. Defaults to 10 000. */
  intervalMs?: number;
  /**
   * Called with the error of every beat that did not count: XO answered that it did not track
   * it, or the request failed or took too long. It never stops the heartbeat, and an error it
   * throws is ignored.
   */
  onMissed?: (error: XoError) => void;
};

const StartOrderHeartbeatSchema = z.strictObject({
  intervalMs: fields.whole(1_000, 20_000).optional(),
  onMissed: z
    .custom<(error: XoError) => void>((value) => typeof value === 'function', {
      error: 'must be a function',
    })
    .optional(),
});

/**
 * Sends one order heartbeat, once, and says whether XO counted it.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function sendOrderHeartbeat(
  ctx: ActionContext,
): Promise<OrderHeartbeatResponse> {
  ctx.secure?.assertOpen();
  const answer = await ctx.orderbook.sendHeartbeat();
  return { tracked: answer.tracked };
}

/**
 * Starts sending order heartbeats, and returns the running heartbeat at once.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export function startOrderHeartbeat(
  ctx: ActionContext,
  request?: StartOrderHeartbeatRequest,
): OrderHeartbeat {
  const input = parseInput(
    'startOrderHeartbeat',
    request,
    StartOrderHeartbeatSchema,
  );
  ctx.secure?.assertOpen();
  const handle = ctx.orderbook.startHeartbeat({
    ...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
    ...(input.onMissed === undefined ? {} : { onMissed: input.onMissed }),
  });
  return Object.freeze({
    stop: () => handle.stop(),
    get running() {
      return handle.running;
    },
  });
}
