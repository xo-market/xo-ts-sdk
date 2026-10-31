// Helpers shared by the transaction rails, the sponsor client, the chain reader and the account
// client. Not part of the public API.

import {
  TransactionFailedError,
  UnexpectedResponseError,
  XoError,
} from '../core/errors';
import { errorName } from '../wallet/internal';

// `resetNonceTracking` and `setNonceClock` are test-only.
export {
  lastHandedOver,
  markAccepted,
  markHandedOver,
  nextNonce,
  resetNonceTracking,
  setNonceClock,
} from './nonceQueue';

/**
 * Sets `mayHaveLanded` on an error thrown before or by a send. An error that already says
 * (a `TransactionFailedError`, or any error with a boolean `mayHaveLanded`, the rule `guarded` in
 * the rails uses) is returned as it is: what it says is never overwritten.
 *
 * Meant for an error object made for this one send (by the SDK in this call, or by the
 * transport for this one request). A read before the send can throw an object other callers
 * hold too (the session rethrows one login-pause error to every caller): it may be marked
 * `false` here, which is true for each holder, since no holder's request was sent.
 */
export function withLanded<E extends XoError>(
  error: E,
  mayHaveLanded: boolean,
): E {
  if (
    error instanceof TransactionFailedError ||
    typeof error.mayHaveLanded === 'boolean'
  ) {
    return error;
  }
  try {
    Object.defineProperty(error, 'mayHaveLanded', {
      value: mayHaveLanded,
      enumerable: true,
      configurable: true,
    });
  } catch {
    // A frozen error keeps what it has; the caller still sees its class and code.
  }
  return error;
}

/**
 * What a failure says, without quoting anything unsafe: the message of an SDK error (the SDK
 * never puts a URL or a key in one), only the error name for anything else. A raw RPC error
 * can carry the node URL, and that URL can hold an API key.
 */
export function describeFailure(error: unknown): string {
  return error instanceof XoError ? error.message : errorName(error);
}

/**
 * Whether an `eth_getCode` answer means "no contract": `'0x'`, or `'0x0'`, which some nodes
 * answer instead. The rails (whether to prepend the smart wallet deploy) and the account client
 * (`isDeployed`, the `deploy` action of `setup`) all decide with it, so they always agree.
 */
export function isEmptyCode(code: string): boolean {
  return code === '0x' || code === '0x0';
}

/** Micro-units as the orderbook's account routes print them: digits only. */
export const MICRO_UNITS = /^[0-9]+$/;

/**
 * An orderbook answer whose `field` is not what the gateway documents, for the account client
 * (`/positions`, `/data/market-capacity`, `/claimable`). It names the route and the field,
 * never the value.
 */
export function unexpectedOrderbookAnswer(
  route: string,
  field: string,
  rule: string,
): UnexpectedResponseError {
  return new UnexpectedResponseError(
    `Unexpected orderbook response for ${route}: ${field}: ${rule}`,
    {
      service: 'orderbook',
      issues: [{ path: field, code: 'invalid_value', message: rule }],
    },
  );
}
