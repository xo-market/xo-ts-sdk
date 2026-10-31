import { z } from 'zod';
import { UserInputError } from './errors';
import { DEFAULT_MAX_RETRIES } from './retry';

/** The most retries a read accepts. */
export const MAX_RETRIES = 5;

/** How long one attempt of a request may take, unless a call says otherwise: 30 s. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The longest timeout accepted. `setTimeout` stores its delay in a signed 32-bit integer, so
 * above 2^31 - 1 ms a timer overflows and fires after 1 ms instead of waiting.
 */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Options of one read: how long each attempt may take, how often it is retried, and a signal
 * that cancels it. Calls that change something take none of them: aborting one could not undo
 * it. Orders, cancels, on-chain transactions, deposits and withdrawals are sent once and never
 * retried. Deleting the client's own API key (when it closes, rotates its key or ends
 * authentication) is retried, since deleting it twice is harmless.
 *
 * @example
 * const controller = new AbortController();
 * const options: RequestOptions = { signal: controller.signal, timeout: 5_000, retries: 0 };
 */
export type RequestOptions = {
  /**
   * Cancels the call: every attempt, the waits between attempts and reading the answer. The
   * credentials a request needs are not cut short: the signal is checked again once they are
   * ready, before anything is sent. Aborting rejects with a `RequestAbortedError` whose `cause`
   * is the signal's reason.
   */
  signal?: AbortSignal;
  /**
   * How long each attempt may take, in whole milliseconds, before it fails with a
   * `TimeoutError`. `false` sets no limit. Defaults to 30 000 (30 s).
   */
  timeout?: number | false;
  /**
   * How many times a read is tried again after a network error or a 429, 502, 503 or 504: a
   * whole number from 0 to 5. Defaults to 2. The wait between attempts grows from 250 ms up to
   * 2 s. When the service asks for a wait (`Retry-After`), it is waited up to 5 s; a longer one
   * is not waited, and the error goes back to you with `retryAfter` set.
   */
  retries?: number;
};

/**
 * The per-call options of a read, checked and with every default filled in: the form the clients
 * hand down to each request. Every read method takes it as its last parameter; leave it out for
 * the defaults (30 s per attempt, 2 retries, no signal). A call that changes something takes
 * none.
 */
export interface CallOptions {
  /**
   * Cancels the call: every attempt, the waits between attempts and reading the answer. The
   * credentials a request needs are not cut short: the signal is checked again once they are
   * ready, before anything is sent. Aborting rejects with a `RequestAbortedError` whose `cause`
   * is the signal's reason.
   */
  signal?: AbortSignal;
  /**
   * How long each attempt may take, in whole milliseconds (1 to 2147483647), before it fails with
   * a `TimeoutError`; `false` for no limit.
   */
  timeoutMs: number | false;
  /**
   * How many times a read is tried again after a network error or a 429, 502, 503 or 504: a whole
   * number from 0 to 5.
   */
  retries: number;
}

const KEYS = ['signal', 'timeout', 'retries'] as const;

const schema = z.object({
  signal: z.instanceof(AbortSignal).optional(),
  timeout: z
    .union([z.literal(false), z.number().int().min(1).max(MAX_TIMEOUT_MS)])
    .optional(),
  retries: z.number().int().min(0).max(MAX_RETRIES).optional(),
});

/** What each option must be. Messages never quote the value that was refused. */
const RULES: Record<(typeof KEYS)[number], string> = {
  signal: 'options.signal must be an AbortSignal',
  timeout: `options.timeout must be a whole number of milliseconds from 1 to ${MAX_TIMEOUT_MS}, or false`,
  retries: `options.retries must be a whole number from 0 to ${MAX_RETRIES}`,
};

function refused(message: string): UserInputError {
  return new UserInputError(message, { code: 'invalid_request_options' });
}

function isKey(key: unknown): key is (typeof KEYS)[number] {
  return (KEYS as readonly unknown[]).includes(key);
}

/**
 * @internal Checks the {@link RequestOptions} of a read and fills in the defaults: a 30 s
 * timeout per attempt and 2 retries. A key set to `undefined` counts as left out.
 *
 * @throws {UserInputError} `invalid_request_options` when `o` is not an object, has a key other
 *   than `signal`, `timeout` and `retries`, or one of them is out of range. The message names the
 *   option and never quotes its value.
 */
export function parseRequestOptions(o?: RequestOptions): CallOptions {
  if (o === undefined) {
    return { timeoutMs: DEFAULT_TIMEOUT_MS, retries: DEFAULT_MAX_RETRIES };
  }
  const value: unknown = o;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw refused(
      `options must be an object with ${KEYS.join(', ')} (each optional)`,
    );
  }
  const unknownKey = Object.keys(value).find((key) => !isKey(key));
  if (unknownKey !== undefined) {
    throw refused(
      `options has an unknown key "${unknownKey.slice(0, 40)}" (allowed: ${KEYS.join(', ')})`,
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    throw refused(
      isKey(field)
        ? RULES[field]
        : `options must be an object with ${KEYS.join(', ')} (each optional)`,
    );
  }
  const { signal, timeout, retries } = parsed.data;
  const call: CallOptions = {
    timeoutMs: timeout ?? DEFAULT_TIMEOUT_MS,
    retries: retries ?? DEFAULT_MAX_RETRIES,
  };
  if (signal !== undefined) {
    call.signal = signal;
  }
  return call;
}

function isWhole(value: unknown, min: number, max: number): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

/**
 * @internal Checks {@link CallOptions} that reach a request, which a caller can also build by
 * hand: the same ranges as {@link parseRequestOptions}. Returns `call` as it is.
 *
 * @throws {UserInputError} `invalid_request_options` when `call` is not an object, its `signal`
 *   is not an `AbortSignal`, its `timeoutMs` is neither `false` nor a whole number of
 *   milliseconds from 1 to 2147483647, or its `retries` is not a whole number from 0 to 5. The
 *   message names the field and never quotes its value.
 */
export function checkCallOptions(call: CallOptions): CallOptions {
  const value: unknown = call;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw refused('call must be an object with timeoutMs, retries and signal');
  }
  const { signal, timeoutMs, retries } = value as Record<string, unknown>;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw refused('call.signal must be an AbortSignal');
  }
  if (timeoutMs !== false && !isWhole(timeoutMs, 1, MAX_TIMEOUT_MS)) {
    throw refused(
      `call.timeoutMs must be a whole number of milliseconds from 1 to ${MAX_TIMEOUT_MS}, or false`,
    );
  }
  if (!isWhole(retries, 0, MAX_RETRIES)) {
    throw refused(
      `call.retries must be a whole number from 0 to ${MAX_RETRIES}`,
    );
  }
  return call;
}
