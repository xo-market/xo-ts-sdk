/** How many times a read is retried after its first attempt, unless configured. */
export const DEFAULT_MAX_RETRIES = 2;

/** Backoff for a retry the server gave no hint for: full jitter over 250 ms * 2^n. */
export const BACKOFF_BASE_MS = 250;
export const BACKOFF_CAP_MS = 2000;

/**
 * A server-requested delay (`retry_after_ms` or `Retry-After`) is waited up to this. A longer
 * one is not waited: the error goes back to the caller, who decides.
 */
export const MAX_RETRY_AFTER_MS = 5000;

/** Statuses a read may be retried on: rate limited, bad gateway, unavailable, timeout. */
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 502, 503, 504]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/**
 * Exponential backoff with full jitter: a random delay in `[0, min(capMs, baseMs * 2^attempt))`.
 * `attempt` counts from 0. With `random = () => 1` the result is the ceiling itself
 * (exact for whole-millisecond `baseMs` and `capMs`) and with `() => 0` it is 0.
 * `random` must return a value in `[0, 1]`.
 */
export function backoffMs(
  attempt: number,
  baseMs: number,
  capMs: number,
  random: () => number = Math.random,
): number {
  return Math.floor(random() * Math.min(capMs, baseMs * 2 ** attempt));
}

/**
 * How long to wait before retry number `attempt` (counting from 0): the server's own delay
 * when it gave a finite one, otherwise jittered backoff. `undefined` when the server asked for
 * more than {@link MAX_RETRY_AFTER_MS}: that wait is not slept and the request is not retried.
 */
export function retryDelayMs(retryAfter: undefined, attempt: number): number;
export function retryDelayMs(
  retryAfter: number | undefined,
  attempt: number,
): number | undefined;
export function retryDelayMs(
  retryAfter: number | undefined,
  attempt: number,
): number | undefined {
  if (retryAfter !== undefined && Number.isFinite(retryAfter)) {
    return retryAfter > MAX_RETRY_AFTER_MS
      ? undefined
      : Math.max(0, retryAfter);
  }
  return backoffMs(attempt, BACKOFF_BASE_MS, BACKOFF_CAP_MS);
}

/**
 * Resolves after `ms`. If `signal` aborts first, the timer is cleared and the promise
 * rejects with the signal's reason.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
