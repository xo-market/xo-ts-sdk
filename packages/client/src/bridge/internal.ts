// Internal: plumbing shared by the bridge client's methods. Not re-exported from any barrel.

import { type Address, isAddress, zeroAddress } from 'viem';
import { withLanded } from '../account/internal';
import type { Session } from '../auth/session';
import { isSameAddress } from '../core/address';
import { toMicro } from '../core/decimal';
import type { EnvironmentConfig } from '../core/env';
import {
  AuthRequiredError,
  isServerFailure,
  RateLimitError,
  RequestRejectedError,
  TimeoutError,
  TransactionFailedError,
  TransportError,
  UserInputError,
  XoError,
} from '../core/errors';
import type { CallOptions } from '../core/requestOptions';
import { type DualSchema, parseResponse } from '../core/schema';
import { copyNotSent, type Transport, wasNotSent } from '../core/transport';
import { cannotAuthenticate, NO_BACKEND_CREDENTIAL } from '../data/internal';
import { closedObject } from '../orderbook/internal';
import { isObject } from '../wallet/internal';
import type {
  BridgeDirection,
  BridgeFundingClaim,
  BridgePayment,
  BridgePaymentStatus,
} from './schemas';
import type { VerifyCallback } from './verification';

/** The path of every bridge route, under the backend's `/api`. */
export const BRIDGE_BASE = '/api/bridge/halliday';

/**
 * The codes the backend's bridge routes answer with, besides `bridge_not_available` (which has
 * its own entry: the SDK raises it itself, and it also names the backend's 404) and the bridge
 * provider's failures (see {@link PROVIDER_FAILURES}). Each reaches the caller as the `code` of
 * the `RequestRejectedError` that `parseServiceError` makes for its status (400, 422, 404 or
 * 409). The SDK does not branch on most of them; the list is what `docs/errors.md` documents,
 * and `scripts/error-codes.ts` reads it (`*_CODES`) so that each has an entry there.
 * `funding_already_claimed` is the one the SDK handles itself: it turns it into
 * `bridge_funding_claimed`.
 */
export const BRIDGE_BACKEND_CODES = [
  'asset_not_supported',
  'amount_invalid',
  'amount_out_of_range',
  'recipient_invalid',
  'recipient_family_unsupported',
  'owner_unknown',
  'payment_not_found',
  'quote_expired',
  'verification_failed',
  'payment_not_awaiting_verification',
  'payment_not_awaiting_funds',
  'funding_already_claimed',
  'not_a_withdrawal',
  'cursor_invalid',
] as const;

/**
 * The bridge provider's failures, by the code the backend answers with (a 502 or a 503): the
 * code it sends today, and the bridge's own code, which it may send instead. Both reach the
 * caller as the bridge's own code, through {@link providerFailure}.
 */
const PROVIDER_FAILURES: ReadonlyMap<string, 'unavailable' | 'rejected'> =
  new Map([
    ['halliday_unavailable', 'unavailable'],
    ['bridge_unavailable', 'unavailable'],
    ['halliday_rejected', 'rejected'],
    ['bridge_rejected', 'rejected'],
  ]);

/**
 * A failure of the bridge provider as the caller gets it: `bridge_unavailable` (the provider
 * is down) or `bridge_rejected` (it refused the request). The message is the SDK's own, because
 * the backend's text may name the provider. The status, `service`, `requestId` and
 * `retryAfter` are the original's, and the original is not kept. Any other error is returned
 * as it is.
 */
function providerFailure(error: unknown): unknown {
  if (!(error instanceof RequestRejectedError)) {
    return error;
  }
  switch (PROVIDER_FAILURES.get(error.code)) {
    case 'unavailable':
      return renamedFailure(
        error,
        'bridge_unavailable',
        'The bridge provider is unavailable',
      );
    case 'rejected':
      return renamedFailure(
        error,
        'bridge_rejected',
        'The bridge provider refused the request',
      );
    default:
      return error;
  }
}

/** `error` under the bridge's own `code` and `message`, with its other fields. */
function renamedFailure(
  error: RequestRejectedError,
  code: string,
  message: string,
): RequestRejectedError {
  const renamed = new RequestRejectedError(message, {
    code,
    service: error.service,
    status: error.status,
    requestId: error.requestId,
    retryAfter: error.retryAfter,
  });
  copyNotSent(error, renamed);
  return renamed;
}

/** What the methods of the bridge client send their requests with. */
export interface BridgeDeps {
  env: EnvironmentConfig;
  transport: Transport;
  session: Session;
  /** Reject response fields the schemas do not know. */
  strict: boolean;
}

/**
 * The gate every `BridgeClient` method passes first: the environment must have a bridge.
 *
 * @throws {UserInputError} `bridge_not_available` (service `sdk`, `mayHaveLanded: false`)
 *   when it has none. Nothing has been sent.
 */
export function assertBridgeAvailable(env: EnvironmentConfig): void {
  if (env.bridge !== true) {
    throw withLanded(
      new UserInputError(
        `The ${env.name} environment has no bridge, so deposits and withdrawals are not available`,
        { code: 'bridge_not_available', service: 'sdk' },
      ),
      false,
    );
  }
}

/** A `UserInputError` for an argument refused before anything was sent: `mayHaveLanded: false`. */
function refused(message: string): UserInputError {
  return withLanded(new UserInputError(message), false);
}

/**
 * A `direction` argument, checked.
 *
 * @throws {UserInputError} `invalid_input`, `mayHaveLanded: false`, for any other value.
 */
export function readDirection(value: unknown): BridgeDirection {
  if (value !== 'deposit' && value !== 'withdraw') {
    throw refused('direction must be "deposit" or "withdraw"');
  }
  return value;
}

/** What the backend's DTO takes as an amount: no sign, no exponent, no padding zero, at most 36 fraction digits. */
const AMOUNT_PATTERN = /^(0|[1-9]\d*)(\.\d{1,36})?$/;
/** The longest amount the backend takes, in characters. */
const MAX_AMOUNT_CHARS = 80;
/** The bridge's `network:address`: a lower-case network, then the token address or id. */
const ASSET_PATTERN = /^[a-z0-9-]+:[A-Za-z0-9]{1,100}$/;
/** The longest asset and recipient the backend takes, in characters. */
const MAX_ASSET_CHARS = 128;
const MAX_RECIPIENT_CHARS = 128;
/** The backend's payment ids; the pattern also keeps a path or a query out of a lookup. */
const PAYMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** How many payments `history()` asks for per page: the most the backend gives. */
export const HISTORY_PAGE_SIZE = 100;
/** How long `wait()` sleeps between two reads of a payment. */
export const BRIDGE_POLL_MS = 10_000;
/** How long `wait()` waits when `timeoutMs` is not given: one hour. */
export const BRIDGE_WAIT_TIMEOUT_MS = 3_600_000;
/** The longest `timeoutMs` `wait()` accepts: 24 hours. */
export const BRIDGE_WAIT_TIMEOUT_MAX_MS = 86_400_000;

/**
 * An amount argument, checked: a decimal string, or a number turned into one with `String(n)`.
 * It has the backend DTO's grammar (`^(0|[1-9]\d*)(\.\d{1,36})?$`, at most 80 characters) and a
 * digit other than zero, so the SDK refuses here exactly what the backend would refuse as a
 * flat 400 with no code. `0.1 + 0.2` is the string `'0.30000000000000004'` and passes; `1e-7`
 * is `'1e-7'`, `Infinity` and `NaN` are not finite, and they fail. Nothing is rounded or
 * reformatted: the string that is returned is the string that is sent.
 *
 * @throws {UserInputError} `invalid_input`, `mayHaveLanded: false`, whose message never holds
 *   the value.
 */
export function readBridgeAmount(value: unknown): string {
  const text =
    typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (
    typeof text !== 'string' ||
    text.length > MAX_AMOUNT_CHARS ||
    !AMOUNT_PATTERN.test(text) ||
    !/[1-9]/.test(text)
  ) {
    throw refused(
      'amount must be a decimal string or a number above 0, such as "25" or 0.5: no sign, no exponent, at most 36 decimal places',
    );
  }
  return text;
}

/**
 * An asset argument, checked: the bridge's `network:address`, as `listBridgeAssets` lists it.
 * Whether the asset is supported is for the backend to say (`asset_not_supported`).
 *
 * @throws {UserInputError} `invalid_input`, `mayHaveLanded: false`.
 */
export function readBridgeAsset(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > MAX_ASSET_CHARS ||
    !ASSET_PATTERN.test(value)
  ) {
    throw refused(
      'assetId must be an asset id as listBridgeAssets lists it, network:address, such as "base:0x8335…2913"',
    );
  }
  return value;
}

/**
 * A withdrawal's recipient, checked only for what any address is: text that is not blank and
 * at most 128 characters. It is sent as it was given, never trimmed or changed; whether it is
 * an address on the asset's network is for the backend to say (`recipient_invalid`).
 *
 * @throws {UserInputError} `invalid_input`, `mayHaveLanded: false`.
 */
export function readRecipient(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > MAX_RECIPIENT_CHARS
  ) {
    throw refused(
      'recipient must be an address as text, from 1 to 128 characters',
    );
  }
  return value;
}

/**
 * A payment id argument, checked with the backend's rule, so no path or query can get into the
 * URL of a lookup.
 *
 * @throws {UserInputError} `invalid_input`, `mayHaveLanded: false`, whose message never holds
 *   the value.
 */
export function readPaymentId(value: unknown): string {
  if (typeof value !== 'string' || !PAYMENT_ID_PATTERN.test(value)) {
    throw refused(
      'paymentId must be 1 to 128 letters, digits, underscores or hyphens',
    );
  }
  return value;
}

/**
 * The quote option handed to `deposit` (or, for `withdraw`, to its own method), checked: an
 * object whose `direction` is the one the method is for and whose `paymentId` is a payment id.
 * Returns the payment id. Only these two fields are read: whether the quote is still open is for
 * the backend to say (`quote_expired`).
 *
 * @throws {UserInputError} `invalid_input`, `mayHaveLanded: false`, whose message never holds
 *   the value. A quote of the other direction is told apart, so the caller knows which method
 *   to use.
 */
export function readQuoteOption(
  quote: unknown,
  direction: BridgeDirection,
): string {
  if (!isObject(quote)) {
    throw refused(
      'quote must be a quote option, as quoteDeposit or quoteWithdrawal returns it',
    );
  }
  if (quote.direction !== direction) {
    const other = direction === 'deposit' ? 'withdraw' : 'deposit';
    throw refused(
      quote.direction === other
        ? `this is a ${other} quote: confirm it with ${other}(), not ${direction}()`
        : `quote.direction must be "${direction}"`,
    );
  }
  return readPaymentId(quote.paymentId);
}

/**
 * What a withdrawal quote says goes in, in micro-USDC: `quote.input.amount`, a decimal string
 * above 0 with at most 6 decimal places (the USDC token's). It is what the caller agreed to
 * withdraw, and `withdraw` sends no more than that: the deposit instructions the backend
 * answers with are compared to it. A hand-made quote without it is refused before anything
 * is confirmed.
 *
 * @throws {UserInputError} `invalid_input`, `mayHaveLanded: false`, whose message never holds
 *   the value.
 */
export function readQuotedMicro(quote: unknown): bigint {
  const input = isObject(quote) ? quote.input : undefined;
  const amount = isObject(input) ? input.amount : undefined;
  if (typeof amount === 'string') {
    try {
      const micro = toMicro(amount, 'amount');
      if (micro > 0n) {
        return micro;
      }
    } catch {
      // Refused below, with one message for every kind of bad amount.
    }
  }
  throw refused(
    "quote.input.amount must be the quote's XO USDC amount: a decimal string above 0 with at most 6 decimal places, as quoteWithdrawal returns it",
  );
}

/**
 * The recipient a withdrawal quote was asked for: `quote.recipient`, which `quoteWithdraw` copies
 * onto every option. `withdraw` funds a payment only if it delivers there. A hand-made quote
 * without it is refused before anything is confirmed, as one without `input.amount` is.
 *
 * @throws {UserInputError} `invalid_input`, `mayHaveLanded: false`, whose message never holds
 *   the value.
 */
export function readQuoteRecipient(quote: unknown): string {
  const recipient = isObject(quote) ? quote.recipient : undefined;
  if (
    typeof recipient !== 'string' ||
    recipient.trim() === '' ||
    recipient.length > MAX_RECIPIENT_CHARS
  ) {
    throw refused(
      'quote.recipient must be the recipient the quote was asked for, as quoteWithdrawal returns it',
    );
  }
  return recipient;
}

/** An EVM address: its letter case is only a checksum. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Whether the recipient a payment answers with is the one its quote was asked for. The backend
 * stores a recipient trimmed, and an EVM one checksummed (`getAddress`), so the quote's is
 * trimmed, and two EVM addresses are compared without regard to case. Any other address (a
 * Solana one is base58, where case matters) must be the same text.
 */
export function isSameRecipient(
  quoted: string,
  answered: string | null,
): boolean {
  if (typeof answered !== 'string') {
    return false;
  }
  const asked = quoted.trim();
  return EVM_ADDRESS.test(asked) && EVM_ADDRESS.test(answered)
    ? asked.toLowerCase() === answered.toLowerCase()
    : asked === answered;
}

/**
 * The options of `deposit` and `verify`: a closed object whose only key is `verify`, a function
 * that approves what the owner is asked to sign. With `required` a missing `verify` is refused
 * (for `verify()`, which has no other job); without it the options and the callback may be left
 * out.
 *
 * @throws {UserInputError} `invalid_input`, `mayHaveLanded: false`: an unknown key, options
 *   that are not an object, a `verify` that is not a function, or one that is missing when it is
 *   required.
 */
export function readVerifyOption(
  options: unknown,
  required: boolean,
): VerifyCallback | undefined {
  const o =
    options === undefined && !required ? {} : readOptions(options, ['verify']);
  const { verify } = o;
  if (verify === undefined) {
    if (required) {
      throw refused(
        'verify is required: a function that approves what the owner is asked to sign',
      );
    }
    return undefined;
  }
  if (typeof verify !== 'function') {
    throw refused('verify must be a function that returns true to approve');
  }
  return verify as VerifyCallback;
}

/** The keys of an options object, closed; an error carries `mayHaveLanded: false`. */
function readOptions(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  try {
    return closedObject(value, 'options', allowed);
  } catch (error) {
    throw error instanceof XoError ? withLanded(error, false) : error;
  }
}

/** What `wait()` does with its options, checked. */
export interface WaitOptions {
  /** How long to wait in all, in ms, from the call. */
  timeoutMs: number;
  /** Ends the wait when it aborts. */
  signal: AbortSignal | undefined;
  /** Called with the payment on each change of status. */
  onUpdate: ((payment: BridgePayment) => void) | undefined;
}

/**
 * The options of `wait()`, checked: a closed object whose keys are `timeoutMs` (a number above 0,
 * finite, at most 24 hours; {@link BRIDGE_WAIT_TIMEOUT_MS} when left out), `signal` (an
 * `AbortSignal`) and `onUpdate` (a function). A key set to `undefined` counts as left out.
 *
 * @throws {UserInputError} `invalid_input`, `mayHaveLanded: false`, whose message names the
 *   option and never holds its value.
 */
export function readWaitOptions(options: unknown): WaitOptions {
  const o = readOptions(options, ['timeoutMs', 'signal', 'onUpdate']);
  const { timeoutMs, signal, onUpdate } = o;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > BRIDGE_WAIT_TIMEOUT_MAX_MS)
  ) {
    throw refused(
      `timeoutMs must be a number of milliseconds above 0 and at most ${BRIDGE_WAIT_TIMEOUT_MAX_MS} (24 hours)`,
    );
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw refused('signal must be an AbortSignal');
  }
  if (onUpdate !== undefined && typeof onUpdate !== 'function') {
    throw refused('onUpdate must be a function that takes the payment');
  }
  return {
    timeoutMs: timeoutMs ?? BRIDGE_WAIT_TIMEOUT_MS,
    signal,
    onUpdate: onUpdate as WaitOptions['onUpdate'],
  };
}

/** The statuses that end a payment, as the backend defines them. `'HALTED'` is not one: it may still finish. */
const FINAL_STATUSES: ReadonlySet<string> = new Set([
  'COMPLETE',
  'EXPIRED',
  'TAINTED',
]);

/** Whether a payment in `status` has ended, so `wait()` is done. An unknown status has not. */
export function isFinalStatus(status: string): boolean {
  return FINAL_STATUSES.has(status);
}

/**
 * Whether a failed read of a payment is one `wait()` rides out: the service is down or
 * limiting (a `RequestRejectedError` with a 5xx status, `RateLimitError`), a request timed out (`TimeoutError`),
 * or no answer came (`TransportError`). **Not** an abort, which ends the wait: the transport
 * raises a caller's abort as a `RequestAbortedError` (which `wait()` turns into the signal's
 * reason before it gets here) and a `fetch` that gave up by itself as a `TransportError` whose
 * message ends in "was aborted". Every other error, auth and validation and an unreadable answer
 * included, is final.
 */
export function isTransientRead(error: unknown): error is XoError {
  return (
    isServerFailure(error) ||
    error instanceof RateLimitError ||
    error instanceof TimeoutError ||
    (error instanceof TransportError && !error.message.endsWith(' was aborted'))
  );
}

/**
 * `bridge_wait_timeout`: `wait()` reached its deadline with the payment not final
 * (`mayHaveLanded: true`: the payment is still going on, and may end at any moment). `last` is
 * the payment as last read, if any was; `cause` the error of the last read when that read
 * failed (a transient error). The message says what is known and never quotes a value from
 * an answer other than a status word.
 */
export function waitTimedOut(
  paymentId: string,
  timeoutMs: number,
  last: BridgePayment | undefined,
  cause: XoError | undefined,
): TimeoutError {
  const known =
    last === undefined
      ? 'it could not be read even once'
      : STATUS_WORD.test(last.status)
        ? `its last status was ${last.status}`
        : 'its last status is one this SDK cannot place';
  const reading =
    cause === undefined
      ? ''
      : ' The last read failed (see cause), so the payment may have moved on since.';
  return withPaymentId(
    withLanded(
      new TimeoutError(
        `Payment ${paymentId} was not final after waiting ${timeoutMs} ms: ${known}.${reading} Nothing was cancelled or sent: the payment goes on. Read it with fetchBridgePayment({ paymentId: "${paymentId}" }), or wait for it again`,
        {
          code: 'bridge_wait_timeout',
          service: 'sdk',
          ...(cause === undefined ? {} : { cause }),
        },
      ),
      true,
    ),
    paymentId,
  );
}

/** The body of a `POST /quotes` request. A deposit has no `recipient` key. */
export interface QuoteBody {
  direction: BridgeDirection;
  asset: string;
  amount: string;
  recipient?: string;
}

/**
 * The options of `quoteDeposit` (`direction: 'deposit'`: `asset` and `amount`) or `quoteWithdraw`
 * (`'withdraw'`: and a `recipient`) as the request body, every part checked.
 *
 * @throws {UserInputError} `invalid_input`, `mayHaveLanded: false`: an unknown key, or an
 *   asset, amount or recipient that is refused.
 */
export function readQuoteBody(
  direction: BridgeDirection,
  options: unknown,
): QuoteBody {
  const o = readOptions(
    options,
    direction === 'deposit'
      ? ['asset', 'amount']
      : ['asset', 'amount', 'recipient'],
  );
  const asset = readBridgeAsset(o.asset);
  const amount = readBridgeAmount(o.amount);
  return direction === 'deposit'
    ? { direction, asset, amount }
    : { direction, asset, amount, recipient: readRecipient(o.recipient) };
}

/**
 * The options of `history()`, checked. A status is an open set (a later backend can add one),
 * so only its shape is checked, and `'QUOTED'`, which the backend never lists.
 *
 * @throws {UserInputError} `invalid_input`, `mayHaveLanded: false`.
 */
export function readHistoryOptions(options: unknown): {
  direction: BridgeDirection | undefined;
  status: BridgePaymentStatus | undefined;
} {
  const o = readOptions(options, ['direction', 'status']);
  const direction =
    o.direction === undefined ? undefined : readDirection(o.direction);
  const { status } = o;
  if (status === undefined) {
    return { direction, status };
  }
  if (typeof status !== 'string' || status === '') {
    throw refused('status must be a payment status, such as "COMPLETE"');
  }
  if (status === 'QUOTED') {
    throw refused(
      'status "QUOTED" is never listed: a quote nobody confirmed is not history',
    );
  }
  return { direction, status };
}

/** The parts of a plain decimal string: its sign, whole digits and fraction digits. */
const DECIMAL_PARTS = /^(-?)(\d+)(?:\.(\d+))?$/;

/** A plain decimal string as its sign and its digits, with the number of fraction digits. */
function splitDecimal(text: string): {
  negative: boolean;
  digits: string;
  places: number;
} {
  const match = typeof text === 'string' ? DECIMAL_PARTS.exec(text) : null;
  if (match === null) {
    throw new UserInputError('compareDecimal needs plain decimal strings');
  }
  const [, sign, whole = '', fraction = ''] = match;
  return {
    negative: sign === '-',
    digits: `${whole}${fraction}`,
    places: fraction.length,
  };
}

/**
 * Compares two plain decimal strings exactly, as numbers: `-1`, `0` or `1`. It does not use
 * floats: both values are scaled to the same number of fraction digits and compared as
 * integers (`BigInt`), so `'1.0'` equals `'1'`, `'10.01'` is below `'10.1'`, and a value wider
 * than a double is still told apart.
 *
 * @throws {UserInputError} When a value is not a plain decimal string (an optional minus,
 *   digits, an optional fraction).
 */
export function compareDecimal(a: string, b: string): number {
  const left = splitDecimal(a);
  const right = splitDecimal(b);
  const scale = Math.max(left.places, right.places);
  const scaled = (value: typeof left): bigint => {
    const digits = BigInt(
      value.digits.padEnd(value.digits.length + scale - value.places, '0'),
    );
    return value.negative ? -digits : digits;
  };
  const x = scaled(left);
  const y = scaled(right);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * A copy of `error` for one call: the same prototype (so the class and `instanceof` hold) and
 * the same own properties (message, stack, code, service, status, requestId, `mayHaveLanded`,
 * subclass fields), with this call's `paymentId` and `cause` set to `error`, the original. The
 * copy is as much "not sent" as the original. `undefined` when the copy cannot be made or does
 * not read back like the original. It mirrors `copyXoError` in `orderbook/placement.ts`.
 */
function copyForPayment<E extends XoError>(
  error: E,
  paymentId: string,
): E | undefined {
  try {
    const copy = Object.create(Object.getPrototypeOf(error)) as E;
    const descriptors: PropertyDescriptorMap =
      Object.getOwnPropertyDescriptors(error);
    delete descriptors.paymentId;
    delete descriptors.cause;
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
    Object.defineProperty(copy, 'cause', {
      value: error,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(copy, 'paymentId', {
      value: paymentId,
      enumerable: true,
      configurable: true,
    });
    copyNotSent(error, copy);
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
 * The error a call about one payment throws, carrying that call's `paymentId`, as `orderHash`
 * is carried by a placement error: a plain own property, so `toJSON()` and `util.inspect` show
 * it.
 *
 * The same error object can reach several callers. The session rethrows one login failure to
 * every caller that shares the login, and to every later caller while logins are paused, so
 * stamping the first caller's id on it would hand the next caller someone else's. Hence:
 *
 * - an error that already has this `paymentId` is returned as it is;
 * - an error that has another `paymentId`, or that the transport marked as not sent (the kind
 *   the session shares), is not touched: the caller gets a per-call copy with the same
 *   prototype and own fields, this `paymentId`, and the original as its `cause`;
 * - any other error is stamped in place (nobody else holds it), and a frozen one keeps what it
 *   has: the caller still gets its class and code, without an id.
 *
 * If a copy cannot be made (nothing in the SDK does this), the original comes back as it is: an id
 * is never overwritten and a shared error is never stamped.
 *
 * **Use what it returns** (`throw withPaymentId(error, id)`): it may be a copy, not `error`. The
 * copy is made with `Object.create` from the original's prototype, so `instanceof`, `name`,
 * `message` and `stack` hold, but it is not a native error object: `Error.isError(copy)` and
 * `util.types.isNativeError(copy)` are `false` for it.
 */
export function withPaymentId<E extends XoError>(
  error: E,
  paymentId: string,
): E {
  if (error.paymentId === paymentId) {
    return error;
  }
  if (error.paymentId !== undefined || wasNotSent(error)) {
    return copyForPayment(error, paymentId) ?? error;
  }
  try {
    Object.defineProperty(error, 'paymentId', {
      value: paymentId,
      enumerable: true,
      configurable: true,
    });
  } catch {
    // A frozen error keeps what it has.
  }
  return error;
}

/**
 * Whether a POST that failed with `error` may have had its effect, for the methods that send
 * one (the quote; the confirm, the verification and the funding claim after it).
 *
 * `false` when the request never went out (the transport marks those, whatever their class
 * and status), and when the service answered a 4xx, which refuses a request for sure. `true`
 * for everything else: a 5xx, a timeout, a lost connection, an answer that could not be read
 * after a 2xx, and any error it cannot place.
 */
export function landedAfterPost(error: unknown): boolean {
  if (wasNotSent(error)) {
    return false;
  }
  return !(
    error instanceof XoError &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500
  );
}

/**
 * `bridge_funding_mismatch`: what the backend answered for a withdrawal is not something the SDK
 * will fund, so it claimed nothing and sent nothing (`mayHaveLanded: false`). `message` never
 * holds a value from the answer.
 */
export function fundingMismatch(
  paymentId: string,
  message: string,
): TransactionFailedError {
  return withPaymentId(
    new TransactionFailedError(message, {
      code: 'bridge_funding_mismatch',
      mayHaveLanded: false,
    }),
    paymentId,
  );
}

/**
 * `bridge_funding_claimed`: the funding of the withdrawal is, or may be, claimed, and this call
 * sent no USDC (`mayHaveLanded: true`). `why` says how the call knows. `cause` is kept only when
 * it is an `XoError`, which redacts itself; anything else could hold what it should not.
 *
 * The advice in the message is the same as `docs/errors.md` gives: read the payment first, and
 * go by its status (`PROCESSING` or `COMPLETE`: wait; `HALTED`: its `recoveryUrl`; `EXPIRED`:
 * never funded, so reconcile any pending transfer; `TAINTED`: report it). Send by hand only for
 * `AWAITING_FUNDS`, after reconciling any earlier transfer (a receipt for its transaction, or its
 * nonce used by another one), because a second transfer sent while the first is still pending
 * pays twice if both land.
 */
export function fundingClaimed(
  paymentId: string,
  why: string,
  cause?: unknown,
): TransactionFailedError {
  return claimedError(
    paymentId,
    why,
    `Read the payment with fetchBridgePayment({ paymentId: "${paymentId}" }) before anything else. If fundingClaimedAt is null, the claim was not made and withdraw({ quote }) can be called again. If it is set, go by the status. PROCESSING or COMPLETE: the bridge has the funds, follow it with waitForBridgePayment({ paymentId: "${paymentId}" }). HALTED: it may still finish, and the bridge's recovery page is its recoveryUrl. EXPIRED: it was never funded, so send nothing more, and reconcile any earlier transfer that may still be pending (if it lands, report the paymentId to XO). TAINTED: the bridge will not complete it, so report the paymentId to XO. AWAITING_FUNDS: reconcile any earlier transfer first (does its transaction have a receipt, or was its nonce used by another transaction?) and send the exact deposit amount yourself with transferErc20 only if nothing went out and its deposit instructions name XO's chain, XO USDC and exactly the quoted amount`,
    cause,
  );
}

/**
 * The first look `withdraw` takes at the payment a confirm answered with, before it checks the
 * funding target, reads the balance or claims anything: a payment that shows `fundingClaimedAt`
 * has had its funding claimed by an earlier call (this process or another), and an earlier
 * transfer may be on chain. Nothing here may say that nothing was sent, so it is
 * `bridge_funding_claimed` (`mayHaveLanded: true`, the reconcile-first message) whatever the
 * payment's status is, and none of the later checks (a balance that dropped because that
 * transfer landed, a status that moved on) can answer instead. An answer for another payment is
 * left to {@link readFundingTarget}, which refuses it.
 *
 * @throws {TransactionFailedError} `bridge_funding_claimed`, `mayHaveLanded: true`, with `paymentId`.
 */
export function assertFundingNotClaimed(
  payment: BridgePayment,
  paymentId: string,
): void {
  if (
    payment.paymentId === paymentId &&
    typeof payment.fundingClaimedAt === 'string'
  ) {
    throw fundingClaimed(
      paymentId,
      'was already claimed, as the confirmed payment shows',
    );
  }
}

/**
 * `bridge_funding_claimed` for a claim whose answer showed deposit instructions other than the
 * ones checked before it: the funding is claimed, and the SDK refused to send to instructions it
 * did not check. The advice differs from {@link fundingClaimed}'s: the instructions must be
 * confirmed with `get()` before anything is sent, by anyone.
 */
export function fundingClaimedOtherInstructions(
  paymentId: string,
): TransactionFailedError {
  return claimedError(
    paymentId,
    'was claimed, but the answer to the claim does not show the deposit instructions that were checked',
    `Confirm its deposit instructions with fetchBridgePayment({ paymentId: "${paymentId}" }) before you send anything: they must name XO's chain, XO USDC and exactly the quoted amount. If they do not, send nothing and report the paymentId to XO. If they do, reconcile any earlier transfer first (does its transaction have a receipt, or was its nonce used by another transaction?) and send the exact deposit amount yourself with transferErc20 only if nothing went out`,
  );
}

/** The error both `bridge_funding_claimed` builders make; `advice` is what to do next. */
function claimedError(
  paymentId: string,
  why: string,
  advice: string,
  cause?: unknown,
): TransactionFailedError {
  return withPaymentId(
    new TransactionFailedError(
      `The funding of payment ${paymentId} ${why}, so this call sent no USDC and withdraw() cannot send it again. ${advice}. Never call withdraw() again expecting a second send`,
      {
        code: 'bridge_funding_claimed',
        mayHaveLanded: true,
        ...(cause instanceof XoError ? { cause } : {}),
      },
    ),
    paymentId,
  );
}

/** A status the message may quote: a plain word, as the backend's statuses are. */
const STATUS_WORD = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** Where a withdrawal sends its USDC: the bridge's deposit address and the amount, checked. */
export interface FundingTarget {
  /** The one-time address, a valid address that is neither the zero address nor the USDC contract. */
  address: Address;
  /** The amount in whole USDC, as the backend wrote it. */
  amount: string;
  /** `amount` in micro-USDC: above 0 and equal to the amount of the quote. */
  micro: bigint;
}

/** `bridge_funding_mismatch` for a withdrawal: `why`, then that nothing moved, then `advice`. */
function withdrawalMismatch(
  paymentId: string,
  why: string,
  advice = '',
): TransactionFailedError {
  return fundingMismatch(
    paymentId,
    `${why}. Nothing was claimed or sent.${advice === '' ? '' : ` ${advice}`}`,
  );
}

/**
 * Checks, with nothing sent, that the payment a confirm answered with is the withdrawal the
 * caller's quote describes, whatever its status. In this order: the payment is the one asked for;
 * it is a withdrawal; it delivers to the quote's `recipient` ({@link isSameRecipient}).
 * `withdraw` makes these checks straight after the confirm when the payment waits for
 * verification, so the owner is never asked to sign for a payment that delivers elsewhere, and
 * {@link readFundingTarget} makes them again before the claim.
 *
 * @throws {TransactionFailedError} `bridge_funding_mismatch` (`mayHaveLanded: false`, with
 *   `paymentId`) for the first check that fails. The message names the rule, and never quotes
 *   the recipients.
 */
export function assertWithdrawalOfQuote(
  payment: BridgePayment,
  o: { paymentId: string; recipient: string },
): void {
  const id = o.paymentId;
  if (payment.paymentId !== id) {
    throw withdrawalMismatch(
      id,
      `The answer for payment ${id} is for another payment`,
    );
  }
  if (payment.direction !== 'withdraw') {
    throw withdrawalMismatch(
      id,
      `Payment ${id} is not a withdrawal, so there is nothing to fund`,
    );
  }
  if (!isSameRecipient(o.recipient, payment.recipient)) {
    throw withdrawalMismatch(
      id,
      `Payment ${id} does not deliver to the recipient of the quote you confirmed`,
      'Do not send funds yourself: ask for a new quote, and report the paymentId to XO.',
    );
  }
}

/**
 * Checks, with nothing sent, that the payment a confirm answered with is a withdrawal the SDK
 * can fund exactly as the caller's quote said, and returns where to send the USDC. In this
 * order: the checks of {@link assertWithdrawalOfQuote} (the payment is the one asked for, a
 * withdrawal, delivering to the quote's `recipient`); it is `AWAITING_FUNDS` and has its deposit
 * instructions; those name XO's own chain and XO USDC (the environment's USDC contract), an
 * address that can be sent to, and exactly `quotedMicro` of USDC.
 *
 * @throws {TransactionFailedError} `bridge_funding_mismatch` (`mayHaveLanded: false`, with
 *   `paymentId`) for the first check that fails. The message names the rule, and the status
 *   when that is the problem, and never quotes the deposit instructions or the recipients.
 */
export function readFundingTarget(
  payment: BridgePayment,
  o: {
    paymentId: string;
    quotedMicro: bigint;
    usdc: Address;
    recipient: string;
  },
): FundingTarget {
  const id = o.paymentId;
  const stop = (why: string, advice = ''): TransactionFailedError =>
    withdrawalMismatch(id, why, advice);
  assertWithdrawalOfQuote(payment, o);
  if (payment.status !== 'AWAITING_FUNDS') {
    const named = STATUS_WORD.test(payment.status)
      ? `in ${payment.status}`
      : 'in a status this SDK cannot place';
    throw stop(
      `Payment ${id} is ${named}, not AWAITING_FUNDS, so it is not ready to be funded`,
      payment.status === 'CONFIRM_UNKNOWN'
        ? `Its confirm is still running or ended unknown: withdraw({ quote }) may be retried in a moment, because confirming is idempotent and the funding can be claimed only once. Read it with fetchBridgePayment({ paymentId: "${id}" }) to watch it.`
        : `Read it with fetchBridgePayment({ paymentId: "${id}" }). withdraw({ quote }) may be retried, because confirming is idempotent and the funding can be claimed only once, but it will not fund a payment that is not waiting for funds.`,
    );
  }
  const { deposit } = payment;
  if (deposit === null) {
    throw stop(
      `Payment ${id} is AWAITING_FUNDS but has no deposit instructions to send to`,
    );
  }
  if (deposit.chain.toLowerCase() !== 'xo') {
    throw stop(
      `The deposit instructions of payment ${id} are not on XO's own chain, where a withdrawal is funded`,
    );
  }
  if (deposit.token.toLowerCase() !== `xo:${o.usdc.toLowerCase()}`) {
    throw stop(
      `The deposit instructions of payment ${id} are not for XO USDC (this environment's USDC contract)`,
    );
  }
  const { address } = deposit;
  if (
    !isAddress(address) ||
    address.toLowerCase() === zeroAddress ||
    isSameAddress(address, o.usdc)
  ) {
    throw stop(
      `The deposit address of payment ${id} is not an address USDC can be sent to`,
    );
  }
  let micro: bigint;
  try {
    micro = toMicro(deposit.amount, 'amount');
  } catch {
    throw stop(
      `The deposit amount of payment ${id} is not an amount of USDC the SDK can send (above 0, at most 6 decimal places)`,
    );
  }
  if (micro <= 0n || micro !== o.quotedMicro) {
    throw stop(
      `The deposit amount of payment ${id} is not the amount of the quote you confirmed`,
      'Do not send funds yourself.',
    );
  }
  return { address, amount: deposit.amount, micro };
}

/**
 * Whether the deposit instructions in the answer of a funding claim are the ones that were
 * checked before the claim: XO's chain, XO USDC, the same address and the same amount. The
 * USDC is sent to `target`, so an answer that shows other instructions (or none) is not a claim
 * the SDK can vouch for. Never throws.
 */
export function claimShowsDeposit(
  deposit: BridgeFundingClaim['deposit'],
  target: FundingTarget,
  usdc: Address,
): boolean {
  if (deposit === null || deposit === undefined) {
    return false;
  }
  try {
    return (
      deposit.chain.toLowerCase() === 'xo' &&
      deposit.token.toLowerCase() === `xo:${usdc.toLowerCase()}` &&
      deposit.address.toLowerCase() === target.address.toLowerCase() &&
      toMicro(deposit.amount, 'amount') === target.micro
    );
  } catch {
    return false;
  }
}

/**
 * Sends one request to the bridge routes with the session's backend credentials and checks
 * the answer against `schema`. In this order:
 *
 * 1. the gate ({@link assertBridgeAvailable});
 * 2. a session that can never get a backend key fails at once, nothing sent;
 * 3. the request. Only a read is retried (the transport's read policy): a GET, or a POST the
 *    caller marks `read` because it moves nothing (a quote). Any other POST is sent once;
 * 4. the answer is checked against `schema`.
 *
 * A failure of the bridge provider leaves under the bridge's own code ({@link providerFailure}).
 * An error of a read leaves with `mayHaveLanded: false`: a read moves nothing. An error of any
 * other POST is left as it is, for the method to classify.
 */
export async function bridgeRequest<T>(
  deps: BridgeDeps,
  o: {
    method: 'GET' | 'POST';
    path: string;
    query?: Record<string, string | number | undefined>;
    body?: unknown;
    schema: DualSchema<T>;
    signal?: AbortSignal;
    /** The caller's per-call options, for a read. */
    call?: CallOptions;
    /** A POST that moves nothing, retried and classified as a read. */
    read?: boolean;
  },
): Promise<T> {
  assertBridgeAvailable(deps.env);
  if (cannotAuthenticate(deps.session)) {
    throw withLanded(
      new AuthRequiredError(NO_BACKEND_CREDENTIAL, { service: 'backend' }),
      false,
    );
  }
  const read = o.method === 'GET' || o.read === true;
  try {
    const data = await deps.transport.request({
      service: 'backend',
      method: o.method,
      path: o.path,
      query: o.query,
      body: o.body,
      auth: 'backend',
      retry: read ? 'read' : 'none',
      signal: o.signal,
      call: o.call,
    });
    return parseResponse(o.schema, data, {
      strict: deps.strict,
      service: 'backend',
      path: o.path,
    });
  } catch (caught) {
    const error = providerFailure(caught);
    throw read && error instanceof XoError ? withLanded(error, false) : error;
  }
}
