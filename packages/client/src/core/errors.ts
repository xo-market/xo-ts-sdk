import type { Hex } from 'viem';
import { redact } from './redact';
import type { OrderHash, Service } from './types';

/** Options every error accepts. All of them are optional. */
export interface XoErrorOptions {
  /** A stable, machine-readable code. Each class has its own default. */
  code?: string;
  /** Which service raised the error. Defaults to `'sdk'` (raised locally). */
  service?: Service;
  /** The HTTP status, when the error came from an HTTP response. */
  status?: number;
  /** The server's correlation id for the request, when it sent one. */
  requestId?: string;
  /** The underlying error. Passed through the standard ES2022 `Error` options. */
  cause?: unknown;
}

/** An `xo_sk_...` API key must never survive in a string the SDK exposes. */
function scrub(value: string): string {
  const safe = redact(value);
  return typeof safe === 'string' ? safe : String(safe);
}

/**
 * The base class of every error the SDK throws.
 *
 * `message`, `code` and `requestId` are run through the SDK's redaction, so an API key
 * that a server echoes back never ends up on the error. `toJSON()` redacts everything.
 * The raw response body is never stored.
 */
export class XoError extends Error {
  readonly code: string;
  readonly service: Service;
  readonly status?: number;
  readonly requestId?: string;
  /**
   * Whether the operation may have taken effect although this error was thrown. Set on an
   * error from sending a signed order, on an error of a cancel request, on a
   * {@link TransactionFailedError}, and on every error of a deposit or a withdrawal (a read or a
   * check made before a request is `false`). When it is true, never resend or re-sign: reconcile
   * first (for an order, `reconcileOrder({ orderHash: error.orderHash })`; for a cancel, read
   * the open orders with `listOpenOrders()`). `undefined` on every other error.
   */
  declare readonly mayHaveLanded?: boolean;
  /**
   * The EIP-712 hash of the signed order whose placement threw, for `reconcileOrder`. Set on
   * the errors of placing or posting one order; `undefined` otherwise.
   */
  declare readonly orderHash?: OrderHash;
  /**
   * The id of the bridge payment the failed operation was about, for
   * `fetchBridgePayment({ paymentId })` and `waitForBridgePayment({ paymentId })`. Set on the
   * errors of reading a payment and on every error raised after a quote was confirmed;
   * `undefined` otherwise. When `mayHaveLanded` is true, read the payment by this id before
   * doing anything else, and never confirm the quote again.
   */
  declare readonly paymentId?: string;
  /**
   * The topic an error of a live subscription is about: `'market'`, `'user'`, `'portfolio'` or
   * `'activity'`. Set on the errors a subscription handle reports, so you know whose state to
   * read again; `undefined` on `subscription_overflow`, which is about the whole handle, and on
   * every other error.
   */
  declare readonly topic?: 'market' | 'user' | 'portfolio' | 'activity';

  constructor(message: string, opts: XoErrorOptions = {}) {
    super(
      scrub(String(message)),
      opts.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.name = 'XoError';
    this.code = scrub(opts.code ?? 'xo_error');
    this.service = opts.service ?? 'sdk';
    this.status = opts.status;
    this.requestId =
      opts.requestId !== undefined ? scrub(opts.requestId) : undefined;
  }

  /** Subclass fields to include in `toJSON()`. */
  protected extraJson(): Record<string, unknown> {
    return {};
  }

  /** A log-safe plain object. Fields that are `undefined` are left out. */
  toJSON(): Record<string, unknown> {
    const fields: Record<string, unknown> = {
      name: this.name,
      code: this.code,
      service: this.service,
      status: this.status,
      requestId: this.requestId,
      message: this.message,
      orderHash: this.orderHash,
      paymentId: this.paymentId,
      topic: this.topic,
      mayHaveLanded: this.mayHaveLanded,
      ...this.extraJson(),
      cause: this.cause,
    };
    const defined = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    );
    return redact(defined) as Record<string, unknown>;
  }
}

/**
 * Input that the SDK refused before sending anything: a bad argument, option or setup. Nothing
 * reached a service. The message names the field. A service that refuses a request is a
 * {@link RequestRejectedError}.
 */
export class UserInputError extends XoError {
  constructor(message: string, opts: XoErrorOptions = {}) {
    super(message, { ...opts, code: opts.code ?? 'invalid_input' });
    this.name = 'UserInputError';
  }
}

/** A call needs an API key or a session and the client has none. */
export class AuthRequiredError extends XoError {
  constructor(message: string, opts: XoErrorOptions = {}) {
    super(message, { ...opts, code: opts.code ?? 'auth_required' });
    this.name = 'AuthRequiredError';
  }
}

/**
 * A service answered with an HTTP error status other than 429: the request was refused
 * (400, 401, 403, 404, 409, 422) or the service failed (5xx). `status` says which, and `code`
 * is the service's own code, such as `trading_paused` (503), `frontend_only` or
 * `insufficient_scope` (403), `order_in_delay_window` (409) or `market_not_found` (404), or
 * `http_<status>` when the service sent none. A pause of trading is only this code on a 503:
 * there is no separate flag.
 */
export class RequestRejectedError extends XoError {
  declare readonly status: number;
  /** How long the service asked callers to wait, in milliseconds, when it said so. */
  readonly retryAfter?: number;

  constructor(
    message: string,
    opts: XoErrorOptions & { status: number; retryAfter?: number },
  ) {
    super(message, { ...opts, code: opts.code ?? `http_${opts.status}` });
    this.name = 'RequestRejectedError';
    this.retryAfter = opts.retryAfter;
  }

  protected override extraJson(): Record<string, unknown> {
    return { retryAfter: this.retryAfter };
  }
}

/** The server answered 429. */
export class RateLimitError extends XoError {
  /** How long the server asked callers to wait, in milliseconds, when it said so. */
  readonly retryAfter?: number;

  constructor(
    message: string,
    opts: XoErrorOptions & { retryAfter?: number } = {},
  ) {
    super(message, { ...opts, code: opts.code ?? 'rate_limited' });
    this.name = 'RateLimitError';
    this.retryAfter = opts.retryAfter;
  }

  protected override extraJson(): Record<string, unknown> {
    return { retryAfter: this.retryAfter };
  }
}

/** The request never produced an HTTP response (network failure, DNS, reset). */
export class TransportError extends XoError {
  constructor(message: string, opts: XoErrorOptions = {}) {
    super(message, { ...opts, code: opts.code ?? 'transport_error' });
    this.name = 'TransportError';
  }
}

/** The request or operation took longer than its timeout. */
export class TimeoutError extends XoError {
  constructor(message: string, opts: XoErrorOptions = {}) {
    super(message, { ...opts, code: opts.code ?? 'timeout' });
    this.name = 'TimeoutError';
  }
}

/** The caller aborted the request or operation through its `AbortSignal`. */
export class RequestAbortedError extends XoError {
  constructor(message: string, opts: XoErrorOptions = {}) {
    super(message, { ...opts, code: opts.code ?? 'request_aborted' });
    this.name = 'RequestAbortedError';
  }
}

/**
 * A listing was asked to go past its documented depth cap. The last page before the cap says
 * so with `limitReached: true`; asking for more than that throws this error.
 */
export class PaginationLimitError extends XoError {
  constructor(message: string, opts: XoErrorOptions = {}) {
    super(message, { ...opts, code: opts.code ?? 'pagination_limit' });
    this.name = 'PaginationLimitError';
  }
}

/**
 * A response did not match its schema. Missing or wrong-typed fields raise this in both
 * modes; unknown fields and unknown enum values only in strict mode.
 */
export class UnexpectedResponseError extends XoError {
  readonly issues: unknown;

  constructor(message: string, opts: XoErrorOptions & { issues: unknown }) {
    super(message, { ...opts, code: opts.code ?? 'unexpected_response' });
    this.name = 'UnexpectedResponseError';
    this.issues = opts.issues;
  }

  protected override extraJson(): Record<string, unknown> {
    return { issues: this.issues };
  }
}

/** Signing a message or typed data failed. */
export class SigningError extends XoError {
  constructor(message: string, opts: XoErrorOptions = {}) {
    super(message, { ...opts, code: opts.code ?? 'signing_failed' });
    this.name = 'SigningError';
  }
}

/**
 * An on-chain transaction failed or its outcome is unknown. When `mayHaveLanded` is
 * true the transaction may still be mined, so it must be reconciled, never re-sent:
 * by `transactionHash` when it is known, otherwise by finding which transaction used `nonce`
 * from the executor.
 */
export class TransactionFailedError extends XoError {
  readonly mayHaveLanded: boolean;
  readonly transactionHash?: Hex;
  /**
   * The executor nonce the transaction was signed with, when one was. On
   * `previous_operation_pending` from the sponsored rail it is the nonce of the earlier
   * transaction the call was held back for.
   */
  readonly nonce?: bigint;

  constructor(
    message: string,
    opts: XoErrorOptions & {
      mayHaveLanded: boolean;
      transactionHash?: Hex;
      nonce?: bigint;
    },
  ) {
    super(message, { ...opts, code: opts.code ?? 'transaction_failed' });
    this.name = 'TransactionFailedError';
    this.mayHaveLanded = opts.mayHaveLanded;
    this.transactionHash = opts.transactionHash;
    this.nonce = opts.nonce;
  }

  protected override extraJson(): Record<string, unknown> {
    // A bigint cannot go through JSON.stringify: the nonce is a decimal string here.
    return {
      mayHaveLanded: this.mayHaveLanded,
      transactionHash: this.transactionHash,
      nonce: this.nonce === undefined ? undefined : this.nonce.toString(),
    };
  }
}

/**
 * True for an error a service refused with exactly this HTTP status. Internal: the SDK's own
 * checks (a 404 that means "none", a 401 that asks for a new key) go through it.
 */
export function isRejected(
  error: unknown,
  status: number,
): error is RequestRejectedError {
  return error instanceof RequestRejectedError && error.status === status;
}

/** True for a {@link RequestRejectedError} with a 5xx status: the service failed. Internal. */
export function isServerFailure(error: unknown): error is RequestRejectedError {
  return (
    error instanceof RequestRejectedError &&
    error.status >= 500 &&
    error.status <= 599
  );
}

/**
 * The guard of an error union: the value of the same name as the union, such as
 * `ListMarketsError`, whose `isError` narrows a caught `unknown` to exactly the errors that
 * call can throw.
 *
 * @example
 * try {
 *   await client.fetchMarket({ slug });
 * } catch (error) {
 *   if (FetchMarketError.isError(error)) {
 *     console.log(error.code);
 *   }
 * }
 */
export interface ErrorGuard<E extends XoError> {
  /** True when `error` is an instance of any of the guarded classes. */
  isError(error: unknown): error is E;
}

/**
 * Makes a runtime guard for a union of error classes, to pair with the union type of the same
 * name: the guard narrows a caught `unknown` to exactly the errors a call can throw.
 *
 * @param classes - The error classes the guard accepts.
 * @returns An object whose `isError` is a type guard for the union of their instances.
 * @example
 * const ReadError = makeErrorGuard(RateLimitError, TimeoutError);
 * try {
 *   await readSomething();
 * } catch (error) {
 *   if (ReadError.isError(error)) {
 *     console.log(error.code);
 *   }
 * }
 */
export function makeErrorGuard<
  const C extends readonly (new (
    ...args: never[]
  ) => XoError)[],
>(...classes: C): ErrorGuard<InstanceType<C[number]>> {
  return {
    isError(error: unknown): error is InstanceType<C[number]> {
      return classes.some((cls) => error instanceof cls);
    },
  };
}

// ---------------------------------------------------------------------------
// Parsing the error bodies of the backend, the orderbook and the sponsor.
// ---------------------------------------------------------------------------

/** A server error code: lower snake case, such as `frontend_only`. */
const CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asCode(value: unknown): string | undefined {
  return typeof value === 'string' && CODE_PATTERN.test(value)
    ? value
    : undefined;
}

/** A non-empty string, or a non-empty `string[]` joined with `'; '`. */
function asMessage(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim() === '' ? undefined : value;
  }
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string')
  ) {
    return value.join('; ');
  }
  return undefined;
}

function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

interface BodyFields {
  code?: string;
  message?: string;
  retryAfter?: number;
  requestId?: string;
}

/**
 * Reads the code, message, retry delay and correlation id out of an error body.
 *
 * - backend 4xx: `{ statusCode, response: { error, message } }`, or a flat body
 *   `{ statusCode, message }` (where `message` may be a `string[]`)
 * - backend 5xx: `{ error_type, correlation_id }`
 * - orderbook: `{ error }`, `{ error, message }` or `{ error, retry_after_ms }`
 * - sponsor: `{ error: { code, message } }`
 */
function readBody(body: unknown): BodyFields {
  if (!isRecord(body)) {
    return {};
  }
  const response = isRecord(body.response) ? body.response : undefined;
  const error = body.error;
  const envelope = isRecord(error) ? error : undefined;

  const code =
    asCode(response?.error) ?? asCode(error) ?? asCode(envelope?.code);

  const message =
    asMessage(response?.message) ??
    asMessage(body.message) ??
    asMessage(envelope?.message) ??
    // A string `error` that is not a code is a human-readable message.
    (typeof error === 'string' && !CODE_PATTERN.test(error)
      ? asMessage(error)
      : undefined);

  const retryAfter =
    typeof body.retry_after_ms === 'number' &&
    Number.isFinite(body.retry_after_ms)
      ? Math.max(0, body.retry_after_ms)
      : undefined;

  const requestId =
    typeof body.correlation_id === 'string' && body.correlation_id !== ''
      ? body.correlation_id
      : undefined;

  return { code, message, retryAfter, requestId };
}

function readHeader(headers: Headers, name: string): string | undefined {
  const value = attempt(() => headers.get(name));
  return value === null || value === undefined || value === ''
    ? undefined
    : value;
}

/**
 * `Retry-After` is either whole seconds or an HTTP-date. Returns milliseconds, or
 * `undefined` when the value is missing, unparseable or not a finite number (a digit
 * string long enough to overflow to `Infinity` must not become a delay).
 */
function parseRetryAfter(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const text = value.trim();
  let ms: number | undefined;
  if (/^\d+$/.test(text)) {
    ms = Number(text) * 1000;
  } else if (/[a-z]/i.test(text)) {
    // `Date.parse` accepts odd inputs such as "3.5", so require a letter (a day or
    // month name) before treating the value as a date.
    const at = Date.parse(text);
    if (!Number.isNaN(at)) {
      ms = Math.max(0, at - Date.now());
    }
  }
  return ms !== undefined && Number.isFinite(ms) ? ms : undefined;
}

export interface ParseServiceErrorInput {
  service: Service;
  status: number;
  /** The decoded response body. It may be anything, including `undefined`. */
  body: unknown;
  headers: Headers;
}

/**
 * Turns an HTTP error response into a typed {@link XoError}. It never throws, whatever
 * the body looks like, and it never keeps the raw body on the error.
 *
 * - a 429 is a {@link RateLimitError}; every other status is a {@link RequestRejectedError}
 *   with the HTTP `status`
 * - code: the first lower-snake-case string among `body.response.error`, `body.error`
 *   and `body.error.code`, otherwise `http_<status>`
 * - message: `response.message`, `message` (a `string[]` is joined with `'; '`),
 *   `error.message`, or a non-code `error` string, otherwise `<service> responded <status>`
 * - retryAfter (milliseconds): `body.retry_after_ms`, otherwise the `Retry-After` header
 * - requestId: `body.correlation_id`, otherwise the `x-correlation-id` header
 */
export function parseServiceError(input: ParseServiceErrorInput): XoError {
  const { service, status, body, headers } = input;
  const fields = attempt(() => readBody(body)) ?? {};

  const code = fields.code ?? `http_${status}`;
  const message = fields.message ?? `${service} responded ${status}`;
  const requestId = fields.requestId ?? readHeader(headers, 'x-correlation-id');
  const opts: XoErrorOptions = { code, service, status, requestId };

  const retryAfter =
    fields.retryAfter ??
    attempt(() => parseRetryAfter(readHeader(headers, 'retry-after')));

  if (status === 429) {
    return new RateLimitError(message, { ...opts, retryAfter });
  }
  return new RequestRejectedError(message, { ...opts, status, retryAfter });
}
