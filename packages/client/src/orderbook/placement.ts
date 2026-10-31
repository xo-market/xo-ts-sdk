// The results and errors of placing orders, shared by the orderbook client's
// trading part (trading.ts). Every error thrown once a signed order may have been sent says
// whether it may have landed, so a caller never resends or re-signs an order that may be
// on the book or filled: they reconcile it with `reconcileOrder` instead.

import {
  RequestRejectedError,
  TimeoutError,
  TransportError,
  UnexpectedResponseError,
  XoError,
} from '../core/errors';
import { copyNotSent, wasNotSent } from '../core/transport';
import type { OrderHash } from '../core/types';
import {
  type BatchOperationResult,
  type OrderResponse,
  toBatchOrderResponse,
} from '../models/orders';
import { errorName } from '../wallet/internal';
import type {
  BatchPlaceEntry,
  CancelResult,
  PlaceOrderResponse,
} from './schemas';

/** What `postOrder` returns: the gateway's answer, plus the hash computed locally before sending. */
export interface PlaceOrderResult extends PlaceOrderResponse {
  /** The EIP-712 hash of the signed order, computed before it was sent. */
  orderHash: OrderHash;
  /**
   * Present (and true) only when the gateway's `orderID` is not `orderHash` (case aside).
   * The order was processed, so the result is kept; reconcile by `orderHash`.
   */
  orderIdMismatch?: true;
}

/** One element of `postOrders`: the gateway's entry (snake_case), plus the local hash of that input. */
export interface BatchPlaceResult extends BatchPlaceEntry {
  /** The hash of the input order at this position, whether or not it was placed. */
  orderHash: OrderHash;
}

/** One group's result of `batchOps`, in the order of the groups. */
export type BatchOpResult =
  | { type: 'place'; payload?: BatchPlaceResult[]; error?: string }
  | { type: 'cancel'; payload?: CancelResult; error?: string };

/**
 * Placing a list of orders stopped because a batch failed, or XO answered without saying what
 * became of some orders. Nothing was retried. Sorted by the same rule as a single placement:
 *
 * - `results`: the result of each order of the batches XO answered, as a placement returns it:
 *   `ok: true` for an order XO took, and `ok: false` with a `code` and XO's `message` for one it
 *   refused. An order whose entry did not say what became of it has no result here: it is in
 *   `failedChunk`. So match a result to its order by `orderHash`, not by position.
 * - `failedChunk`: the hashes of the batch whose request was sent and failed, or of the
 *   orders whose entry in an answer did not say what became of them (the engine took them
 *   and its answer was lost). When `mayHaveLanded` is true (a timeout, a network failure, a
 *   5xx, an answer that could not be read or paired, such an entry) any of them may have
 *   been placed, and may already have filled: never resend or re-sign them; reconcile each
 *   with `reconcileOrder`. When it is false XO refused the batch (a 4xx, or trading
 *   paused) and none of them was placed.
 * - `notSent`: the hashes of the orders that were not sent: the batches after the failed one,
 *   and the failed batch itself when it failed locally before sending.
 * - `cause`: the error of the failed batch. When answered orders whose fate is unknown are
 *   listed and a later batch failed too, the `cause` is the error of that later batch, with
 *   its own `failedChunk`, `notSent` and `mayHaveLanded`.
 */
export class BatchPlaceIncompleteError extends XoError {
  readonly results: OrderResponse[];
  readonly failedChunk: OrderHash[];
  readonly notSent: OrderHash[];
  declare readonly mayHaveLanded: boolean;

  constructor(
    message: string,
    opts: {
      results: OrderResponse[];
      failedChunk: OrderHash[];
      notSent: OrderHash[];
      mayHaveLanded: boolean;
      cause: unknown;
    },
  ) {
    super(message, {
      code: 'batch_place_incomplete',
      service: 'orderbook',
      cause: opts.cause,
    });
    this.name = 'BatchPlaceIncompleteError';
    this.results = opts.results;
    this.failedChunk = opts.failedChunk;
    this.notSent = opts.notSent;
    this.mayHaveLanded = opts.mayHaveLanded;
  }

  protected override extraJson(): Record<string, unknown> {
    return {
      results: this.results,
      failedChunk: this.failedChunk,
      notSent: this.notSent,
    };
  }
}

/**
 * Placing and cancelling orders in one request failed after its operations were checked.
 * Nothing was retried.
 *
 * - `orderHashes`: the hashes of every order of its place operations, in order; or, when
 *   the answer arrived but did not say what became of some orders (the engine took them and
 *   its answer was lost), the hashes of those orders.
 * - `mayHaveLanded`: true unless the request failed locally before it was sent, or XO
 *   refused it before running any operation (a 400 or 401, or trading paused). A 429 can
 *   come after earlier operations ran, so it counts as may-have-landed.
 *   When true, never resend or re-sign the orders: reconcile each with `reconcileOrder`.
 * - `results`: when XO's answer said what became of every operation but some orders, what each
 *   operation did, in order, as the request returns it: the result of each order placed
 *   (an order of `orderHashes` has none, so match the orders of a place operation by
 *   `orderHash`, not by position) or what a cancel did. Empty otherwise: an answer that
 *   cannot be paired with the operations sent says nothing reliable of any of them.
 * - `cause`: the error.
 */
export class BatchOpsIncompleteError extends XoError {
  readonly orderHashes: OrderHash[];
  readonly results: BatchOperationResult[];
  declare readonly mayHaveLanded: boolean;

  constructor(
    message: string,
    opts: {
      orderHashes: OrderHash[];
      results: BatchOperationResult[];
      mayHaveLanded: boolean;
      cause: unknown;
    },
  ) {
    super(message, {
      code: 'batch_ops_incomplete',
      service: 'orderbook',
      cause: opts.cause,
    });
    this.name = 'BatchOpsIncompleteError';
    this.orderHashes = opts.orderHashes;
    this.results = opts.results;
    this.mayHaveLanded = opts.mayHaveLanded;
  }

  protected override extraJson(): Record<string, unknown> {
    return { orderHashes: this.orderHashes, results: this.results };
  }
}

/** The gateway's 503 `trading_paused`: the pause flag is checked before any parse or auth. */
function isTradingPaused(error: unknown): boolean {
  return (
    error instanceof RequestRejectedError &&
    error.status === 503 &&
    error.code === 'trading_paused'
  );
}

/**
 * What a failed placement request means for the orders in it:
 * - `'mayHaveLanded'`: a `TimeoutError` or `TransportError` (the request may have reached
 *   the gateway), a status of 500 or more, an `UnexpectedResponseError` (a 2xx that could
 *   not be read or paired: the gateway processed it), or any other status outside 4xx.
 * - `'refused'`: a 4xx, or a 503 `trading_paused` (the gateway checks
 *   the pause flag before any parse or auth, and the engine rejects a paused placement before
 *   any match). The gateway answered
 *   definitively: nothing was placed (a 401 means the request was not processed).
 * - `'notSent'`: an error raised in this process before the request went out, or by the
 *   credential refresh after a 401 (the transport marks those, whatever their class or
 *   status: a derive that failed with a 503 or a timeout sent no order), or any other error
 *   without a status: nothing was placed.
 */
export function placementOutcome(
  error: unknown,
): 'mayHaveLanded' | 'refused' | 'notSent' {
  if (wasNotSent(error)) {
    return 'notSent';
  }
  if (isTradingPaused(error)) {
    return 'refused';
  }
  if (
    error instanceof TimeoutError ||
    error instanceof TransportError ||
    error instanceof UnexpectedResponseError
  ) {
    return 'mayHaveLanded';
  }
  if (error instanceof XoError && error.status !== undefined) {
    return error.status >= 400 && error.status < 500
      ? 'refused'
      : 'mayHaveLanded';
  }
  return 'notSent';
}

/**
 * A failure of placing one signed order whose original error is not an `XoError` (from a
 * custom auth provider, a wallet, a runtime `DOMException`, or anything thrown while the
 * answer was read): the original is its `cause`, untouched. Like every placement error it
 * carries `orderHash` and `mayHaveLanded`.
 */
export class PlacementError extends XoError {
  declare readonly orderHash: OrderHash;
  declare readonly mayHaveLanded: boolean;

  constructor(
    message: string,
    opts: { orderHash: OrderHash; mayHaveLanded: boolean; cause: unknown },
  ) {
    super(message, {
      code: 'placement_failed',
      service: 'sdk',
      cause: opts.cause,
    });
    this.name = 'PlacementError';
    this.orderHash = opts.orderHash;
    this.mayHaveLanded = opts.mayHaveLanded;
  }
}

const PLACEMENT_KEYS = ['orderHash', 'mayHaveLanded'];

/**
 * A copy of an `XoError`, with the same prototype and own properties (message, stack, code,
 * status, cause, retryAfter, ...), plus `orderHash` (when one is given) and `mayHaveLanded`;
 * `undefined` when the copy cannot be made or does not read back like the original.
 */
function copyXoError(
  error: XoError,
  orderHash: OrderHash | undefined,
  mayHaveLanded: boolean,
): XoError | undefined {
  try {
    const copy = Object.create(Object.getPrototypeOf(error)) as XoError;
    const descriptors: PropertyDescriptorMap =
      Object.getOwnPropertyDescriptors(error);
    for (const key of PLACEMENT_KEYS) {
      delete descriptors[key];
    }
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key] as PropertyDescriptor;
      // An own accessor can depend on the original's internal slots (V8's `stack` is one),
      // so the copy gets the value it reads now.
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        descriptors[key] = {
          value: Reflect.get(error, key),
          writable: true,
          enumerable: descriptor.enumerable ?? false,
          configurable: true,
        };
      }
    }
    Object.defineProperties(copy, descriptors);
    if (orderHash !== undefined) {
      Object.defineProperty(copy, 'orderHash', {
        value: orderHash,
        enumerable: true,
      });
    }
    Object.defineProperty(copy, 'mayHaveLanded', {
      value: mayHaveLanded,
      enumerable: true,
    });
    // The copy must read back like the original, or it is not used.
    if (
      copy.message !== error.message ||
      copy.code !== error.code ||
      String(copy) !== String(error)
    ) {
      return undefined;
    }
    return copy;
  } catch {
    return undefined;
  }
}

/**
 * The error of a later request of a call sent in several requests (a cancel of more than 300
 * orders): an earlier request was answered and may have taken effect, so it says
 * `mayHaveLanded: true` whatever went wrong with this one. An error that already says, or that
 * the transport marked as not sent (the kind the session hands to several callers), is copied
 * with its class and fields, never stamped: another caller may hold it. Anything else that is
 * not an `XoError` is returned as it is.
 */
export function failureAfterAnswer(error: unknown): unknown {
  if (!(error instanceof XoError) || error.mayHaveLanded === true) {
    return error;
  }
  if (typeof error.mayHaveLanded === 'boolean' || wasNotSent(error)) {
    return copyXoError(error, error.orderHash, true) ?? error;
  }
  try {
    Object.defineProperty(error, 'mayHaveLanded', {
      value: true,
      enumerable: true,
      configurable: true,
    });
  } catch {
    // A frozen error keeps what it has; the caller still sees its class and code.
  }
  return error;
}

/**
 * The error a `postOrder` call throws, its own object every time: the same error can reach
 * several callers (a session login that concurrent requests share rejects them all with one
 * object), and each call must name its own order. It carries `orderHash` and
 * `mayHaveLanded`, which is true when `answered` (the gateway answered, so the order may
 * be placed, whatever went wrong after) or when {@link placementOutcome} says so.
 *
 * An `XoError` is copied, keeping its class and fields. Anything else (and an `XoError`
 * whose copy fails) is wrapped in a {@link PlacementError} whose `cause` is the original.
 */
export function withPlacement(
  error: unknown,
  orderHash: OrderHash,
  answered: boolean,
): XoError {
  const mayHaveLanded = answered || placementOutcome(error) === 'mayHaveLanded';
  if (error instanceof XoError) {
    const copy = copyXoError(error, orderHash, mayHaveLanded);
    if (copy !== undefined) {
      // The same failure: a copy of one that left before anything was sent says so too.
      copyNotSent(error, copy);
      return copy;
    }
  }
  const what = mayHaveLanded
    ? 'it may have been placed: never resend or re-sign it; reconcile it with reconcileOrder'
    : 'it was not placed';
  const wrapped = new PlacementError(
    `Placing order ${orderHash} failed (${errorName(error)}): ${what}`,
    { orderHash, mayHaveLanded, cause: error },
  );
  copyNotSent(error, wrapped);
  return wrapped;
}

/**
 * The results of answered orders, each paired with the order sent at its position, and the
 * hashes of those whose entry does not say what became of them (see `toBatchOrderResponse`:
 * only XO's definite refusals are refusals, anything else unknown is unknown).
 */
export function readAnswered(results: readonly BatchPlaceResult[]): {
  responses: OrderResponse[];
  unknown: OrderHash[];
} {
  const responses: OrderResponse[] = [];
  const unknown: OrderHash[] = [];
  for (const entry of results) {
    const response = toBatchOrderResponse(entry, entry.orderHash);
    if (response === undefined) {
      unknown.push(entry.orderHash);
    } else {
      responses.push(response);
    }
  }
  return { responses, unknown };
}

/**
 * The error for answered orders whose fate is unknown (`unknown`): they may have been placed,
 * so the error says `mayHaveLanded: true` and lists them in `failedChunk`, with `more` (a
 * failed batch whose orders may have been placed too). `responses` are the results of the
 * other answered orders. `failure` is the failure of a later batch, if one failed: its
 * `cause`, where the orders it refused are listed.
 */
export function unknownOutcome(
  responses: readonly OrderResponse[],
  unknown: readonly OrderHash[],
  failure: BatchPlaceIncompleteError | undefined,
): BatchPlaceIncompleteError {
  const more = failure?.mayHaveLanded === true ? failure.failedChunk : [];
  const notSent = failure?.notSent ?? [];
  const later =
    failure === undefined
      ? ''
      : `; a later batch failed too (see cause)${more.length > 0 ? `, and its ${more.length} orders may have been placed as well` : ''}`;
  return new BatchPlaceIncompleteError(
    `postOrders: XO answered, but did not say what became of ${unknown.length} of the orders${later}: they may have been placed (and filled): never resend or re-sign them; reconcile each of failedChunk with reconcileOrder; ${notSent.length} orders were not sent`,
    {
      results: [...responses],
      failedChunk: [...unknown, ...more],
      notSent: [...notSent],
      mayHaveLanded: true,
      cause: failure,
    },
  );
}

/**
 * The error `postOrders` throws when chunk `index` failed: its orders sorted by
 * {@link placementOutcome}, and `results` (the paired entries of the chunks answered before
 * it) as public results. When one of those entries does not say what became of its order, the
 * error is the {@link unknownOutcome} of those orders, whose `cause` is the chunk's failure: an
 * order that may have been placed never hides behind a later failure.
 * `answered`: the failure came after the gateway answered (reading or pairing the answer).
 */
export function incomplete(
  index: number,
  chunks: number,
  chunk: readonly OrderHash[],
  after: readonly OrderHash[],
  results: readonly BatchPlaceResult[],
  cause: unknown,
  answered: boolean,
): BatchPlaceIncompleteError {
  // Once the gateway answered, the chunk may have been placed, whatever failed after.
  const outcome = answered ? 'mayHaveLanded' : placementOutcome(cause);
  const failedChunk = outcome === 'notSent' ? [] : [...chunk];
  const notSent = outcome === 'notSent' ? [...chunk, ...after] : [...after];
  const reason = cause instanceof XoError ? cause.code : errorName(cause);
  const what =
    outcome === 'mayHaveLanded'
      ? `its ${failedChunk.length} orders may have been placed (and filled): never resend or re-sign them; reconcile each with reconcileOrder`
      : outcome === 'refused'
        ? `the gateway refused its ${failedChunk.length} orders, so none of them was placed`
        : `it failed before it was sent, so none of its ${chunk.length} orders was placed`;
  const before = readAnswered(results);
  const failure = new BatchPlaceIncompleteError(
    `postOrders stopped at chunk ${index + 1} of ${chunks} (${reason}): ${what}; ${results.length} results came back and ${notSent.length} orders were not sent`,
    {
      results: before.responses,
      failedChunk,
      notSent,
      mayHaveLanded: outcome === 'mayHaveLanded',
      cause,
    },
  );
  return before.unknown.length > 0
    ? unknownOutcome(before.responses, before.unknown, failure)
    : failure;
}

/**
 * The error `batchOps` throws once its request was attempted (see
 * {@link BatchOpsIncompleteError}), with no results: an answer that came cannot be paired with
 * the groups sent. `answered`: the failure came after the gateway answered.
 */
export function opsIncomplete(
  orderHashes: OrderHash[],
  cause: unknown,
  answered: boolean,
): BatchOpsIncompleteError {
  // Once the gateway answered, its groups ran, whatever failed after.
  const outcome = answered ? 'mayHaveLanded' : placementOutcome(cause);
  const status = cause instanceof XoError ? cause.status : undefined;
  // Refused before any group ran: the pause flag, the envelope (400) and the HMAC (401) are
  // checked first. Every other refusal (a 429 above all) can come after earlier groups ran.
  const beforeAnyGroup =
    outcome === 'notSent' ||
    (outcome === 'refused' &&
      (isTradingPaused(cause) || status === 400 || status === 401));
  const reason = cause instanceof XoError ? cause.code : errorName(cause);
  const what = beforeAnyGroup
    ? outcome === 'notSent'
      ? `it failed before it was sent, so none of its ${orderHashes.length} orders was placed`
      : `the gateway refused it before running any group, so none of its ${orderHashes.length} orders was placed`
    : `its groups may have run, so its ${orderHashes.length} orders may have been placed (and filled): never resend or re-sign them; reconcile each with reconcileOrder`;
  return new BatchOpsIncompleteError(
    `postOrderBatch failed (${reason}): ${what}`,
    {
      orderHashes,
      results: [],
      mayHaveLanded: !beforeAnyGroup,
      cause,
    },
  );
}
