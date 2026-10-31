import { UnexpectedResponseError, UserInputError } from './errors';

/** How long a successful (or failed) sync is trusted before `nowSec()` starts another. */
export const DEFAULT_RESYNC_MS = 600_000;

/** A sync whose round trip took longer than this (or was negative) is not trusted. */
export const DEFAULT_MAX_RTT_MS = 5000;

/** A server time in unix seconds is only believed strictly between these two bounds. */
const MIN_SERVER_SEC = 1e9;
const MAX_SERVER_SEC = 1e11;

/** The options of {@link Clock}. */
export interface ClockOptions {
  /**
   * Reads the server's clock: the orderbook's `GET /time`, as unix **seconds**.
   * Anything that is not a finite number strictly between 1e9 and 1e11 (a string, NaN,
   * a negative number, or milliseconds by mistake) fails the sync.
   */
  fetchServerTimeSec: () => Promise<number>;
  /** The local clock in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * How long to wait, in milliseconds, before `nowSec()` starts a background resync.
   * Must be a positive finite number. Defaults to 600000 (10 minutes).
   */
  resyncMs?: number;
  /**
   * The longest round trip, in milliseconds, whose sample is trusted. The offset is only
   * as good as the midpoint of the round trip, so a sample that took longer than this
   * (a stalled request, a long GC pause, a suspended laptop) fails the sync and the
   * previous offset stays. So does a sample with a negative round trip, which means the
   * local clock was stepped back during the request. Must be a positive finite number.
   * Defaults to 5000.
   */
  maxRttMs?: number;
}

/**
 * Keeps the offset between this machine's clock and the orderbook's, so that every auth
 * timestamp (L1 `ClobAuth` and L2 HMAC) is the server's time and not a skewed local one.
 * The orderbook rejects timestamps too far from its own clock with a 401.
 *
 * - Before the first successful {@link Clock.sync} the offset is 0, so `nowSec()` is the
 *   local time.
 * - The offset is `serverSec * 1000` minus the midpoint of the local clock before and
 *   after the request, which cancels half of the round trip.
 * - {@link Clock.nowSec} also refreshes the offset lazily, in the background, once
 *   `resyncMs` has passed. There are no timers, so the clock never keeps a process alive.
 *
 * The same instance can serve concurrent callers.
 *
 * Internal: an engine behind the two clients. No entry of the package exports it.
 */
export class Clock {
  readonly #fetchServerTimeSec: () => Promise<number>;
  readonly #now: () => number;
  readonly #resyncMs: number;
  readonly #maxRttMs: number;

  /** Server time minus local time, in milliseconds. */
  #offsetMs = 0;
  /**
   * When the last sync attempt finished (it succeeded or failed), or when this clock was
   * built. The next background resync is due `resyncMs` after it, so a broken endpoint
   * is retried once per interval and not on every `nowSec()` call.
   */
  #lastAttemptAt: number;
  #inflight: Promise<void> | undefined;

  constructor(o: ClockOptions) {
    const resyncMs = o.resyncMs ?? DEFAULT_RESYNC_MS;
    if (!isPositiveFinite(resyncMs)) {
      throw new UserInputError(
        'resyncMs must be a positive finite number of milliseconds',
      );
    }
    const maxRttMs = o.maxRttMs ?? DEFAULT_MAX_RTT_MS;
    if (!isPositiveFinite(maxRttMs)) {
      throw new UserInputError(
        'maxRttMs must be a positive finite number of milliseconds',
      );
    }
    this.#fetchServerTimeSec = o.fetchServerTimeSec;
    // Looked up on every call (not `Date.now` captured here), so a fake clock installed
    // after construction, such as `vi.useFakeTimers()`, takes effect.
    this.#now = o.now ?? (() => Date.now());
    this.#resyncMs = resyncMs;
    this.#maxRttMs = maxRttMs;
    this.#lastAttemptAt = this.#now();
  }

  /**
   * Reads the server's clock and updates the offset. Calls made while a sync is in
   * flight share it, including a call made by `fetchServerTimeSec` itself. Rejects on
   * any failure (the fetch failed, the value was implausible, or the round trip was
   * negative or took longer than `maxRttMs`) and the previous offset stays in force.
   */
  sync(): Promise<void> {
    if (this.#inflight !== undefined) {
      return this.#inflight;
    }
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const shared = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // `#inflight` is set before `#run()` calls the fetcher. The fetcher runs
    // synchronously, so one that calls `sync()` or `nowSec()` re-entrantly would
    // otherwise start another sync, which would call it again, without end.
    this.#inflight = shared;
    this.#run().then(
      () => {
        this.#inflight = undefined;
        resolve();
      },
      (error: unknown) => {
        this.#inflight = undefined;
        reject(error);
      },
    );
    return shared;
  }

  /**
   * The current server time as unix seconds, rounded down. It returns at once, with the
   * offset known so far, and never throws because of a sync. If a resync is due it
   * starts one in the background and does not wait for it.
   */
  nowSec(): number {
    const local = this.#now();
    this.#resyncIfDue(local);
    return Math.floor((local + this.#offsetMs) / 1000);
  }

  /** {@link Clock.nowSec} as a decimal string, the form that goes in an auth header. */
  nowSecString(): string {
    return String(this.nowSec());
  }

  async #run(): Promise<void> {
    const t0 = this.#now();
    try {
      const serverSec = await this.#fetchServerTimeSec();
      const t1 = this.#now();
      assertPlausibleServerSec(serverSec);
      assertTrustedRoundTrip(t1 - t0, this.#maxRttMs);
      // `/time` answers in whole seconds, truncated, so `serverSec` is the server's true
      // time rounded down by up to 1 s. The offset is therefore deliberately up to about
      // 1 s early and never ahead of the server, and no 500 ms is added to compensate.
      // That is small next to the orderbook's timestamp windows.
      this.#offsetMs = serverSec * 1000 - (t0 + t1) / 2;
      this.#lastAttemptAt = t1;
    } catch (error) {
      this.#lastAttemptAt = this.#now();
      throw error;
    }
  }

  #resyncIfDue(local: number): void {
    if (this.#inflight !== undefined) {
      return;
    }
    const elapsed = local - this.#lastAttemptAt;
    // A negative `elapsed` means the local clock was stepped back since the last
    // attempt, which makes the stored offset wrong, so that also counts as due. This
    // only sees a step larger than the time since the last attempt, and it does not see
    // a step forward at all. Those are caught at the next scheduled resync, and
    // recovering sooner belongs to the auth layer, which should force `sync()` when the
    // orderbook rejects a timestamp with a 401.
    if (elapsed >= 0 && elapsed < this.#resyncMs) {
      return;
    }
    // Fire and forget: the failure is already on the clock (offset kept, retry throttled),
    // and a caller of `nowSec()` has nowhere to handle it.
    this.sync().catch(() => undefined);
  }
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function assertPlausibleServerSec(value: unknown): asserts value is number {
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > MIN_SERVER_SEC &&
    value < MAX_SERVER_SEC
  ) {
    return;
  }
  // The received value is left out of the error: it is whatever the endpoint sent.
  throw new UnexpectedResponseError(
    'The server time was not a unix timestamp in seconds',
    {
      service: 'orderbook',
      issues: [
        {
          path: '(root)',
          code: 'invalid_server_time',
          message:
            'Expected a finite number of unix seconds between 1e9 and 1e11',
        },
      ],
    },
  );
}

/**
 * A round trip is only trusted when it is between 0 and `maxRttMs` inclusive. Too long
 * and the midpoint is a poor estimate of when the server read its clock. Negative means
 * the local clock was stepped back during the request, so `t0` and `t1` straddle a jump
 * and their midpoint is meaningless. Either way it is a failed sync. The measured round
 * trip is left out of the errors, like the server value.
 */
function assertTrustedRoundTrip(rttMs: number, maxRttMs: number): void {
  if (rttMs < 0) {
    throw new UnexpectedResponseError(
      'The local clock moved backwards during the server time request',
      {
        service: 'orderbook',
        issues: [
          {
            path: '(root)',
            code: 'round_trip_negative',
            message: 'Expected the round trip not to be negative',
          },
        ],
      },
    );
  }
  if (rttMs > maxRttMs) {
    throw new UnexpectedResponseError(
      'The server time request took too long to give a trustworthy offset',
      {
        service: 'orderbook',
        issues: [
          {
            path: '(root)',
            code: 'round_trip_too_long',
            message: 'Expected the round trip to finish within maxRttMs',
          },
        ],
      },
    );
  }
}
