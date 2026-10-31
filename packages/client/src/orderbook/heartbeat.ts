// The orderbook client's heartbeat part: the opt-in dead-man switch. `OrderbookClient`
// (client.ts) delegates to it; the public JSDoc, with the server contract, lives there.
//
// Nothing in this module runs unless `Heartbeats.start` is called: there is no constructor
// side effect and no module-level timer.

import { sessionInternals } from '../auth/sessionInternal';
import {
  AuthRequiredError,
  TimeoutError,
  UnexpectedResponseError,
  UserInputError,
  XoError,
} from '../core/errors';
import { closedObject, type OrderbookDeps, requireSession } from './internal';
import { type HeartbeatResponse, HeartbeatResponseSchema } from './schemas';

/** The options of {@link OrderbookClient.startHeartbeat}. */
export interface HeartbeatOptions {
  /**
   * Milliseconds between two heartbeats: a whole number from 1000 to 20000. Defaults to
   * 10000. The gateway cancels after 30000 ms of silence, so the longest allowed interval
   * still leaves a 10 s margin for one late or lost beat.
   */
  intervalMs?: number;
  /**
   * Called for every heartbeat that did not register:
   * - the gateway answered `tracked: false`, or an answer that cannot be read as
   *   `{ tracked: boolean }` (a missing or non-boolean `tracked`, a body that is not JSON):
   *   an `XoError` with code `heartbeat_not_tracked` (for an unreadable answer, with the
   *   parse error as `cause`), so one code covers "this beat is not confirmed";
   * - the request failed: the transport's own error, such as a `TimeoutError` or a
   *   `RequestRejectedError` with a 5xx status; anything that is not an `XoError` is wrapped in one with
   *   code `heartbeat_failed`;
   * - the beat did not finish by its deadline (the request timeout plus 1000 ms, which a
   *   hung auth provider can exceed): a `TimeoutError`, and the request is aborted.
   *
   * It is not de-duplicated and it never stops the loop. If it throws (or returns a promise
   * that rejects) the error is swallowed and the loop goes on.
   */
  onMissed?: (error: XoError) => void;
}

/** A running heartbeat. */
export interface HeartbeatHandle {
  /**
   * Stops sending heartbeats. Idempotent, and safe to call from `onMissed`. It cancels the
   * pending timer and the request in flight (whose result is then ignored). It does **not**
   * opt the account out of the auto-cancel: see {@link OrderbookClient.startHeartbeat}.
   */
  stop(): void;
  /** `true` from `startHeartbeat()` until `stop()`. Misses never change it. */
  readonly running: boolean;
}

/** The canonical path. The HMAC is verified over exactly this path and an empty body. */
const HEARTBEAT_PATH = '/v1/heartbeats';
const DEFAULT_INTERVAL_MS = 10_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 20_000;
/** A request never waits longer than this, nor longer than one interval. */
const MAX_TIMEOUT_MS = 5_000;
/**
 * A beat gets its request timeout plus this long to finish. The transport's timeout does not
 * cover everything a beat does (the auth provider's `headers()` runs outside it and outside
 * the abort signal), so a watchdog ends a beat that is stuck there.
 */
const WATCHDOG_GRACE_MS = 1_000;

const NO_CREDENTIALS =
  'A heartbeat needs the orderbook credentials, and this client has neither a signer nor `credentials.orderbook`: no beat could register, so none is started';
const NOT_TRACKED_MESSAGE =
  'Heartbeat not tracked: the gateway answered 200 with tracked=false because it did not accept the L2 credentials. This beat did not count: the 30 s auto-cancel countdown was not refreshed';
const UNREADABLE_MESSAGE =
  "Heartbeat not tracked: the gateway's answer could not be read as { tracked: boolean } (see cause), so this beat is not confirmed and is not counted";

/** Checks the options of `startHeartbeat`. */
function readOptions(options: unknown): {
  intervalMs: number;
  onMissed: ((error: XoError) => void) | undefined;
} {
  const o = closedObject(options, 'options', ['intervalMs', 'onMissed']);
  const intervalMs =
    o.intervalMs === undefined ? DEFAULT_INTERVAL_MS : o.intervalMs;
  if (
    typeof intervalMs !== 'number' ||
    !Number.isInteger(intervalMs) ||
    intervalMs < MIN_INTERVAL_MS ||
    intervalMs > MAX_INTERVAL_MS
  ) {
    throw new UserInputError(
      `intervalMs must be a whole number of milliseconds from ${MIN_INTERVAL_MS} to ${MAX_INTERVAL_MS} (the gateway cancels every open order after 30000 ms without a heartbeat)`,
    );
  }
  if (o.onMissed !== undefined && typeof o.onMissed !== 'function') {
    throw new UserInputError('onMissed must be a function');
  }
  return {
    intervalMs,
    onMissed: o.onMissed as ((error: XoError) => void) | undefined,
  };
}

/** The error a missed beat reports: the SDK's own error as it is, anything else wrapped. */
function asXoError(error: unknown): XoError {
  return error instanceof XoError
    ? error
    : new XoError('Heartbeat request failed', {
        code: 'heartbeat_failed',
        service: 'orderbook',
        cause: error,
      });
}

/** Tells the observer about a miss. Whatever it does, it cannot break the loop. */
function report(
  onMissed: ((error: XoError) => void) | undefined,
  miss: XoError,
): void {
  if (onMissed === undefined) {
    return;
  }
  try {
    const result: unknown = onMissed(miss);
    // An `async` observer that rejects would be an unhandled rejection, and would end a Node
    // process by default: this loop is exactly what must not die of that.
    if (
      typeof result === 'object' &&
      result !== null &&
      typeof (result as { then?: unknown }).then === 'function'
    ) {
      (result as PromiseLike<unknown>).then(undefined, () => {});
    }
  } catch {
    // A broken observer is the observer's problem; the next beat goes out regardless.
  }
}

/**
 * Lets the process exit while the timer is pending. A dead (or finished) process must stop
 * sending heartbeats so the gateway cancels its orders, so a heartbeat must never be the
 * thing that keeps a process alive. Only Node's timers have `unref`; a browser's id is a
 * number.
 */
function unref(timer: unknown): void {
  const candidate = timer as { unref?: unknown } | null;
  if (typeof candidate === 'object' && candidate !== null) {
    if (typeof candidate.unref === 'function') {
      (candidate as { unref(): void }).unref();
    }
  }
}

export class Heartbeats {
  readonly #deps: OrderbookDeps;
  /** The loop that is running on this client, if any. */
  #active: HeartbeatHandle | undefined;

  constructor(deps: OrderbookDeps) {
    this.#deps = deps;
  }

  /** Stops the loop that is running on this client, if any. Idempotent. */
  stop(): void {
    this.#active?.stop();
  }

  /**
   * Refuses at once when no beat could register: without credentials a heartbeat only ever
   * reports `AuthRequiredError`, which would look like protection. A session always exists,
   * so ask what it can authenticate with: a signer, or orderbook credentials passed in. (A
   * closed session throws `session_closed` here.)
   */
  #requireCredentials(): void {
    const session = requireSession(this.#deps);
    const internals = sessionInternals(session);
    if (
      internals !== undefined &&
      internals.signer === undefined &&
      !internals.providedOrderbook
    ) {
      throw new AuthRequiredError(NO_CREDENTIALS);
    }
  }

  /** One heartbeat, sent once and never retried: the gateway's answer, unjudged. */
  async send(): Promise<HeartbeatResponse> {
    this.#requireCredentials();
    const data = await this.#deps.request({
      method: 'POST',
      path: HEARTBEAT_PATH,
      auth: 'orderbook',
      retry: 'none',
    });
    return this.#deps.parse(HeartbeatResponseSchema, data, HEARTBEAT_PATH);
  }

  start(options: HeartbeatOptions = {}): HeartbeatHandle {
    const { intervalMs, onMissed } = readOptions(options);
    this.#requireCredentials();
    if (this.#active?.running) {
      throw new UserInputError(
        'A heartbeat is already running on this client: call stop() on its handle before starting another',
        { code: 'heartbeat_already_running' },
      );
    }

    const deps = this.#deps;
    const timeoutMs = Math.min(intervalMs, MAX_TIMEOUT_MS);
    const deadlineMs = timeoutMs + WATCHDOG_GRACE_MS;
    let stopped = false;
    /** The pending tick. */
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** The deadline of the beat in flight. */
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    /** The request in flight, if any. One per beat, so no long-lived signal collects listeners. */
    let current: AbortController | undefined;
    let inFlight = false;
    /**
     * Numbers the beats, and moves on whenever one ends (answered, timed out by the watchdog
     * or stopped). A result is only taken if it still carries the current number, so a
     * late answer of a beat the watchdog gave up on cannot end the beat that replaced it.
     */
    let generation = 0;

    /** Ends beat `id` once: frees the loop, and reports the miss, if there was one. */
    const settle = (id: number, miss: XoError | undefined): void => {
      if (id !== generation) {
        return;
      }
      generation += 1;
      inFlight = false;
      current = undefined;
      if (watchdog !== undefined) {
        clearTimeout(watchdog);
        watchdog = undefined;
      }
      // After stop() the answer is of no interest to anyone.
      if (!stopped && miss !== undefined) {
        report(onMissed, miss);
      }
    };

    /** One heartbeat: sends it, judges the answer and settles. It never rejects. */
    const beat = async (id: number, signal: AbortSignal): Promise<void> => {
      let miss: XoError | undefined;
      try {
        const data = await deps.request({
          method: 'POST',
          path: HEARTBEAT_PATH,
          auth: 'orderbook',
          retry: 'none',
          timeoutMs,
          signal,
        });
        const answer = deps.parse(
          HeartbeatResponseSchema,
          data,
          HEARTBEAT_PATH,
        );
        // 200 is not success: an unauthenticated or mis-signed beat is a 200 with
        // `tracked: false`, a silent opt-out.
        if (!answer.tracked) {
          miss = new XoError(NOT_TRACKED_MESSAGE, {
            code: 'heartbeat_not_tracked',
            service: 'orderbook',
          });
        }
      } catch (error) {
        // An answer that is not `{ tracked: boolean }` (the schema, or a 200 whose body is
        // not JSON) is one more way of not being tracked, under the same code.
        miss =
          error instanceof UnexpectedResponseError
            ? new XoError(UNREADABLE_MESSAGE, {
                code: 'heartbeat_not_tracked',
                service: 'orderbook',
                cause: error,
              })
            : asXoError(error);
      } finally {
        settle(id, miss);
      }
    };

    /**
     * The beat `id` did not finish by its deadline. Aborting cancels the request, but cannot
     * interrupt a hung `auth.headers()`, so the loop is freed here, not by the beat.
     */
    const expire = (id: number): void => {
      if (stopped || id !== generation) {
        return;
      }
      current?.abort();
      settle(
        id,
        new TimeoutError(
          `Heartbeat did not finish within ${deadlineMs} ms (the ${timeoutMs} ms request timeout plus ${WATCHDOG_GRACE_MS} ms); it was abandoned`,
          { service: 'orderbook' },
        ),
      );
    };

    /** Arms the next tick, then sends a beat unless one is still in flight. */
    const tick = (): void => {
      if (stopped) {
        return;
      }
      // Re-armed first: the cadence does not depend on how long a request takes, and a
      // skipped tick cannot break the chain.
      timer = setTimeout(tick, intervalMs);
      unref(timer);
      if (inFlight) {
        return;
      }
      generation += 1;
      const id = generation;
      const controller = new AbortController();
      watchdog = setTimeout(() => expire(id), deadlineMs);
      unref(watchdog);
      current = controller;
      inFlight = true;
      void beat(id, controller.signal);
    };

    const handle: HeartbeatHandle = {
      stop: () => {
        if (stopped) {
          return;
        }
        stopped = true;
        generation += 1; // whatever is in flight is no longer wanted
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (watchdog !== undefined) {
          clearTimeout(watchdog);
          watchdog = undefined;
        }
        current?.abort();
        current = undefined;
        inFlight = false;
        if (this.#active === handle) {
          this.#active = undefined;
        }
      },
      get running() {
        return !stopped;
      },
    };
    try {
      tick();
    } catch (error) {
      // Nothing may keep running behind a call that threw.
      handle.stop();
      throw error;
    }
    // Only a loop whose first tick succeeded counts as "already running".
    this.#active = handle;
    return handle;
  }
}
