import { io, type Socket } from 'socket.io-client';
import type { Session } from '../auth/session';
import { type EnvironmentConfig, LOCAL_HOSTS } from '../core/env';
import {
  AuthRequiredError,
  TransportError,
  UnexpectedResponseError,
  UserInputError,
  XoError,
} from '../core/errors';
import { redact } from '../core/redact';
import { backoffMs } from '../core/retry';
import { type DualSchema, parseResponse } from '../core/schema';
import { field } from '../data/params';
import type {
  PortfolioMarket,
  PortfolioPosition,
} from '../data/portfolioSchemas';
import { closedObject } from '../orderbook/internal';
import { hasMethods, isTransient, readFlag, scrubbedCause } from './internal';
import { readBackoff, readCallback, timerMs } from './reconnectingWs';
import {
  type MarketActivityChannelEvent,
  MarketActivityConnectionAckSchema,
  type MarketActivityFilters,
  MarketActivitySnapshotSchema,
  marketActivityFilters,
  type PortfolioChannelEvent,
  type PortfolioDetailFilters,
  PortfolioDetailSnapshotSchema,
  type PortfolioFilters,
  type PortfolioSnapshotEvent,
  type PortfolioSummaryFilters,
  PortfolioSummarySnapshotSchema,
  portfolioSubscribePayload,
} from './socketioEvents';
import { Subscription } from './subscription';

export type {
  MarketActivityChannelEvent,
  PortfolioChannelEvent,
} from './socketioEvents';

// The backend's Socket.IO channels: `/portfolio` (the account's positions, auth
// required) and `/market-activity` (a market's trades, auth optional), as Subscriptions.
// The events, the schemas and the filters are in socketioEvents.ts.
//
// Backend facts this file relies on:
// - The key is read from `query.token`, `auth.token` or `Authorization`. The SDK sends it in
//   `auth.token` only: a query string lands in access logs, and `auth.token` is the one place the
//   server deletes it from once read.
// - `/portfolio` checks the handshake asynchronously, after `connect` has fired,
//   and acknowledges nothing on success. A message that arrives first is answered with the
//   `exception` "Authentication required".
// - A refusal is `portfolio_error {message}` with no code, then `disconnect(true)`, and the
//   client does not reconnect by itself.
// - A failed message handler sends `exception {status, message}` and calls no
//   acknowledgement; a coded failure sends `portfolio_error {message, code}` first, with the
//   same message. A snapshot that cannot be built is a `portfolio_error` with no code and no
//   `exception`, and the handler still acknowledges `{ok: true}`.
// - `/market-activity` resolves the viewer, then emits `market_activity_connection_ack`. Its
//   errors are `market_activity_error {message}` (no codes), followed by an `exception` when
//   the handler failed.

/** The earliest a subscribe goes out after `connect`, as the backend asks. */
const SUBSCRIBE_DELAY_MS = 1_000;
/** The wait before the one re-emit after an `exception` "Authentication required". */
const AUTH_RETRY_DELAY_MS = 1_000;
/**
 * When the snapshot of a subscribe fails, the one re-subscribe waits this long: the strictest
 * rate-limit window the backend documents (one message per 5000 ms per socket and action; the
 * window is fixed and starts at its first message), so the re-emit is never `RATE_LIMITED` by the
 * subscribe it repeats.
 */
const SNAPSHOT_RETRY_DELAY_MS = 5_000;
/** The same uncoded subscribe failure this many times in a row is permanent. */
const MAX_SAME_FAILURES = 3;
/**
 * Uncoded subscribe failures that never count towards MAX_SAME_FAILURES: they stay transient,
 * retried with the capped backoff for as long as they last. "Internal server error" is what
 * the backend sends for any unexpected failure of a handler: a backend incident, which must not
 * close every channel for good. Matched by its documented text, like the refusals.
 */
const TRANSIENT_FAILURES: ReadonlySet<string> = new Set([
  'Internal server error',
]);
/** `/market-activity`: how long the subscribe waits for the connection ack before it goes anyway. */
const CONNECTION_ACK_WAIT_MS = 5_000;
/** A subscribe that gets no answer (acknowledgement or `exception`) within this restarts the connection. */
const SUBSCRIBE_ANSWER_TIMEOUT_MS = 30_000;
const DEFAULT_BACKOFF = { baseMs: 1_000, capMs: 30_000 } as const;
/** A connection that stayed up this long counts as healthy: the backoff starts over. */
const DEFAULT_STABLE_AFTER_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/** `ws_frame_invalid` and `ws_unknown_event` are reported at most once per this long. */
const FRAME_ERROR_INTERVAL_MS = 1_000;
/** How much of a backend message an error repeats. */
const MAX_SERVER_MESSAGE_CHARS = 200;
/** Keys shorter than this are not scrubbed from text: it would mangle messages. */
const MIN_SCRUB_CHARS = 8;
/** How many keys a channel keeps scrubbing after a rotation. */
const MAX_SCRUBBED_KEYS = 4;
/** How many backend error messages a connection remembers, to match the `exception` that repeats one. */
const MAX_REMEMBERED_MESSAGES = 8;
/** What a backend error code may look like to be passed on as the error's `code`. */
const SERVER_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** "Authentication required": a refusal on connect, and the early-subscribe `exception`. */
const AUTH_REQUIRED = 'Authentication required';

type Refusal = 'retry' | 'refresh' | 'permanent';

/**
 * A documented exception to "never branch on server prose" (as for the orderbook's own
 * refusals): a `/portfolio` refusal has no code, only one of these messages, which the
 * backend documents as stable. A message not listed here is treated as possibly transient: a
 * wording change on the backend degrades to a backoff loop, never to a permanent stop of a
 * healthy channel.
 */
const REFUSALS: ReadonlyMap<string, Refusal> = new Map<string, Refusal>([
  // No token reached the server. The SDK always sends one, so this is a glitch: retry.
  [AUTH_REQUIRED, 'retry'],
  // The key is unknown, revoked or expired: the session may replace it.
  ['Authentication failed', 'refresh'],
  // The account lookup failed (database or key store): "worth retrying, with backoff".
  ['Authentication unavailable', 'retry'],
  // A valid key with no account, or an account with no wallet.
  ['User not found', 'permanent'],
  // A key whose account is banned or suspended.
  ['Account restricted', 'permanent'],
]);

/**
 * Codes that the same subscription would get again on every reconnect: the subscription is
 * closed. `RATE_LIMITED` restarts instead, `API_KEY_INVALID` asks the session for a
 * new key, and any other code is reported and nothing more.
 */
const PERMANENT_CODES: ReadonlyMap<string, string> = new Map([
  [
    'INSUFFICIENT_SCOPE',
    'The key lacks the account:read scope: use a key that has it',
  ],
  [
    'EVENT_TOO_LARGE',
    "The event has more markets in the scope than the backend streams (64; it counts the markets of `marketScope`, which defaults to 'onlyClob' for an event): narrow marketScope, leave out the sub-events (includeSubEvents: false), subscribe to a sub-event, or subscribe by marketId",
  ],
  ['INVALID_FILTER', 'The backend refused the filters'],
  ['INVALID_EVENT_ID', 'The backend refused the event id'],
  ['TAKE_LIMIT', 'The backend refused the page size'],
]);

type Timer = ReturnType<typeof setTimeout>;

/** The connection tuning of the backend channels. */
export interface BackendSocketConnectionOptions {
  /**
   * Reconnect delay: full jitter, a random time in `[0, min(capMs, baseMs * 2^n)]` for the
   * n-th consecutive reconnect. Defaults to `{ baseMs: 1000, capMs: 30000 }`.
   * `0 < baseMs <= capMs <= 2147483647`.
   */
  backoff?: { baseMs: number; capMs: number };
  /**
   * How long a connection must stay up before the backoff starts over (milliseconds).
   * Defaults to 30000.
   */
  stableAfterMs?: number;
  /** A connection attempt that has not opened within this long fails and is retried. Defaults to 10000. */
  connectTimeoutMs?: number;
  /** The random source of the jitter, returning a number in `[0, 1]`. Defaults to `Math.random`. For tests. */
  random?: () => number;
}

/** The options of {@link BackendRealtime}. */
export interface BackendRealtimeOptions {
  /** Its `backendSocketUrl` (an origin, such as `https://api-mainnet.xo.market`) is the server. */
  env: EnvironmentConfig;
  /**
   * The account's session. `/portfolio` needs it: every connect and reconnect asks
   * `ensureBackend()` for the key, and `onUnauthorized('backend', ...)` when the backend
   * refuses it. `/market-activity` sends the key the session holds, so the viewer is the
   * account, and logs in for one only for `userTradesOnly`; without a key it connects
   * anonymously.
   *
   * **WARNING: never enable the `socket.io-client` debug namespaces with a real key**
   * (`DEBUG=socket.io-client:*`, `DEBUG=*`): its Node builds log the handshake packet, which
   * carries this key in `auth.token`. See {@link BackendRealtime}.
   */
  session?: Session;
  /**
   * Refuse unknown fields, unknown enum values and unknown events in what the backend sends
   * (for contract tests). A refused snapshot is dropped and reported as an `'error'`; the
   * stream goes on.
   */
  strictResponses?: boolean;
  connection?: BackendSocketConnectionOptions;
}

/** The options of {@link BackendRealtime.portfolioChannel}. */
export interface PortfolioChannelOptions<
  F extends PortfolioFilters = PortfolioFilters,
> {
  filters?: F;
}

/** The options of {@link BackendRealtime.marketActivityChannel}. */
export interface MarketActivityChannelOptions {
  /** The market, by its backend database id. */
  marketId: number;
  filters?: MarketActivityFilters;
}

interface Shared {
  readonly origin: string;
  readonly session: Session | undefined;
  readonly strict: boolean;
  readonly backoff: { baseMs: number; capMs: number };
  readonly stableAfterMs: number;
  readonly connectTimeoutMs: number;
  readonly random: () => number;
}

interface ChannelSpec<E> {
  namespace: '/portfolio' | '/market-activity';
  /** `/portfolio`: no key, no connection. `/market-activity`: a key when the session has one. */
  authRequired: boolean;
  subscribeEvent: string;
  payload: unknown;
  snapshotEvent: string;
  errorEvent: string;
  /** `/market-activity`: the subscribe also waits for this event (or CONNECTION_ACK_WAIT_MS). */
  ackEvent?: string;
  /** The uncoded message of a snapshot that could not be built. */
  snapshotFailed: string;
  schema: DualSchema<E>;
  /** `userTradesOnly`: an anonymous connection is reported. */
  wantsViewer: boolean;
}

/** One socket of a channel: what the SDK knows about it. Retired sockets are ignored. */
class Attempt {
  socket: Socket | undefined;
  /** The key its handshake carried. */
  key: string | undefined;
  retired = false;
  /** A reconnect was scheduled for it already. */
  rescheduled = false;
  connected = false;
  delayElapsed = false;
  acked = false;
  /** Bumped on every subscribe sent: an answer to an older one is stale. */
  subscribeSeq = 0;
  /** A subscribe is out and neither acknowledged nor answered with an `exception`. */
  awaiting = false;
  /** The one re-emit after "Authentication required" was used. */
  authRetried = false;
  /** The subscription answered (acknowledgement or snapshot). */
  confirmed = false;
  /** The snapshot of the subscribe in flight could not be built. */
  snapshotFailed = false;
  /** The one re-subscribe after a failed snapshot was used. */
  snapshotRetried = false;
  answerTimer: Timer | undefined;
  /**
   * Backend error messages already reported, and whether they had a code, to match the
   * `exception` that repeats one.
   */
  readonly reported: Array<{ message: string; coded: boolean }> = [];
  readonly timers = new Set<Timer>();

  after(ms: number, run: () => void): Timer {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  /**
   * Like {@link after}, but never early: a timer can fire a little before `ms` by the
   * high-resolution clock (the event loop's clock is cached and whole milliseconds), and a
   * delay the backend's behaviour depends on is waited out in full.
   */
  atLeast(ms: number, run: () => void): void {
    const due = performance.now() + ms;
    const check = (): void => {
      const left = due - performance.now();
      if (left > 0) {
        this.after(Math.ceil(left), check);
      } else {
        run();
      }
    };
    this.after(ms, check);
  }
}

function readServerError(payload: unknown): {
  message: string;
  code: string | undefined;
} {
  const record =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  return {
    message: typeof record.message === 'string' ? record.message : '',
    code: typeof record.code === 'string' ? record.code : undefined,
  };
}

/** Whether `value` (any JSON value) holds one of `secrets` in a string or a key. */
function containsSecret(
  value: unknown,
  secrets: readonly string[],
  depth = 0,
): boolean {
  if (typeof value === 'string') {
    return secrets.some((secret) => value.includes(secret));
  }
  if (typeof value !== 'object' || value === null || depth > 64) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsSecret(item, secrets, depth + 1));
  }
  return Object.entries(value).some(
    ([key, item]) =>
      secrets.some((secret) => key.includes(secret)) ||
      containsSecret(item, secrets, depth + 1),
  );
}

/**
 * One subscription and the socket behind it. Each connect is a new Socket.IO manager
 * (`forceNew`, no built-in reconnection): the SDK drives the reconnects, so every connect
 * fetches the key again and subscribes again.
 */
class SocketChannel<E extends { type: string }> {
  readonly sub: Subscription<E>;
  private current: Attempt | undefined;
  private reconnectTimer: Timer | undefined;
  /** Consecutive reconnects since the last stable connection: the `n` of the backoff. */
  private failures = 0;
  /** A subscription was confirmed before: the next confirmation is a reconnect. */
  private everConfirmed = false;
  private connectErrorReported = false;
  /**
   * The session replaced a refused key, and no connection has been confirmed since: a key
   * refused now is refused right after a refresh, so the session is not asked again.
   */
  private refreshedKey = false;
  /** The last uncoded subscribe failure, and how many times in a row it happened. */
  private failure: { message: string; count: number } | undefined;
  private closed = false;
  /** The keys this channel has sent, newest first: scrubbed from messages. */
  private keys: string[] = [];
  private readonly errorAt = new Map<string, number>();

  constructor(
    private readonly shared: Shared,
    private readonly spec: ChannelSpec<E>,
  ) {
    this.sub = new Subscription<E>({ closeTransport: () => this.shutdown() });
  }

  /** Connects on the next turn, so a `close()` right after creation opens nothing. */
  start(): void {
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.launch();
    }, 0);
  }

  /**
   * Opens the next connection. An unexpected failure there (in `open()` or `connect()`) is
   * reported and the connection is retried with the backoff, so the channel never stalls.
   */
  private launch(): void {
    this.open().catch((cause: unknown) => {
      this.unexpected(cause);
      if (this.current !== undefined) {
        this.scheduleReconnect(this.current);
      }
    });
  }

  private unexpected(cause: unknown): void {
    this.report(
      new XoError(
        `The backend ${this.spec.namespace} channel failed unexpectedly`,
        {
          code: 'ws_channel_failed',
          service: 'sdk',
          cause: scrubbedCause(cause),
        },
      ),
    );
  }

  /** Runs a step; an unexpected failure is reported, never thrown into Socket.IO or a timer. */
  private run(step: () => void | Promise<void>): void {
    const fail = (cause: unknown): void => this.unexpected(cause);
    try {
      const result = step();
      if (result instanceof Promise) {
        result.catch(fail);
      }
    } catch (cause) {
      fail(cause);
    }
  }

  private report(error: XoError): void {
    this.sub.pushError(error);
  }

  /**
   * `/market-activity`: whether this connect sends a key. One the session holds is sent (the
   * viewer is then the account); a login for one only happens when the filters need the
   * viewer (`userTradesOnly`). So a public feed costs no wallet signature while the held key
   * is valid; `ensureBackend()` still renews a held key that has expired or is due for
   * rotation, which may log in.
   */
  private sendsOptionalKey(): boolean {
    const session = this.shared.session;
    return (
      session !== undefined &&
      (session.hasBackendCredential() ||
        (this.spec.wantsViewer && session.hasSigner()))
    );
  }

  /** Fetches the key (every connect: it may have been rotated), then opens the socket. */
  private async open(): Promise<void> {
    if (this.closed) {
      return;
    }
    const attempt = new Attempt();
    this.current = attempt;
    let key: string | undefined;
    if (this.spec.authRequired || this.sendsOptionalKey()) {
      try {
        key = (await (this.shared.session as Session).ensureBackend()).key;
      } catch (error) {
        if (this.isStale(attempt)) {
          return;
        }
        if (this.spec.authRequired) {
          this.keyFailed(attempt, error);
          return;
        }
        this.report(
          new XoError(
            'Could not get the backend key for the /market-activity channel, so this connection is anonymous (with userTradesOnly, the backend then cannot build the snapshots). The next reconnect tries again',
            {
              code: 'ws_auth_failed',
              service: 'backend',
              cause: scrubbedCause(error),
            },
          ),
        );
      }
      if (this.isStale(attempt)) {
        return;
      }
    }
    if (key !== undefined) {
      attempt.key = key;
      if (key.length >= MIN_SCRUB_CHARS) {
        this.keys = [key, ...this.keys.filter((k) => k !== key)].slice(
          0,
          MAX_SCRUBBED_KEYS,
        );
      }
    }
    this.connect(attempt);
  }

  /** `/portfolio` could not get its key: transient errors retry, anything else stops. */
  private keyFailed(attempt: Attempt, error: unknown): void {
    if (isTransient(error)) {
      this.report(
        new XoError(
          `Could not get the backend key for the ${this.spec.namespace} channel. The connection is retried with the backoff`,
          {
            code: 'ws_auth_failed',
            service: 'backend',
            cause: scrubbedCause(error),
          },
        ),
      );
      this.scheduleReconnect(attempt);
      return;
    }
    const { name, code } = scrubbedCause(error);
    this.stop(
      new XoError(
        `Could not get the backend key for the ${this.spec.namespace} channel (${name}${code === undefined ? '' : ` ${code}`}), and retrying cannot help. The stream is closed: subscribe again once the cause is fixed`,
        {
          code: 'ws_auth_unrecoverable',
          service: 'backend',
          cause: scrubbedCause(error),
        },
      ),
    );
  }

  private connect(attempt: Attempt): void {
    const { spec, shared } = this;
    const socket = io(`${shared.origin}${spec.namespace}`, {
      // Its own manager: a /portfolio refusal closes the whole underlying connection
      // (`disconnect(true)`), and the SDK runs the reconnects itself.
      forceNew: true,
      reconnection: false,
      autoConnect: false,
      transports: ['websocket'],
      timeout: shared.connectTimeoutMs,
      // The key goes in the handshake's `auth`, never in the query or a header.
      ...(attempt.key === undefined ? {} : { auth: { token: attempt.key } }),
    });
    attempt.socket = socket;
    const on = (event: string, handle: (payload: unknown) => void): void => {
      socket.on(event, (payload: unknown) => {
        if (!attempt.retired && !this.closed) {
          this.run(() => handle(payload));
        }
      });
    };
    on('connect', () => this.onConnect(attempt));
    on('connect_error', (error) => this.onConnectError(attempt, error));
    on('disconnect', () => this.scheduleReconnect(attempt));
    on(spec.snapshotEvent, (payload) => this.onSnapshot(attempt, payload));
    on(spec.errorEvent, (payload) => this.onServerError(attempt, payload));
    on('exception', (payload) => this.onException(attempt, payload));
    if (spec.ackEvent !== undefined) {
      on(spec.ackEvent, (payload) => this.onConnectionAck(attempt, payload));
    }
    if (shared.strict) {
      const known = new Set([
        spec.snapshotEvent,
        spec.errorEvent,
        'exception',
        ...(spec.ackEvent === undefined ? [] : [spec.ackEvent]),
      ]);
      socket.onAny((event: unknown) => {
        if (!attempt.retired && !this.closed && !known.has(String(event))) {
          this.frameError(
            new UnexpectedResponseError(
              `The backend ${spec.namespace} socket sent an event this SDK does not know (${JSON.stringify(String(event).slice(0, 40))}). With strictResponses that is an error; without it, the event is ignored`,
              { code: 'ws_unknown_event', service: 'backend', issues: [] },
            ),
          );
        }
      });
    }
    socket.connect();
  }

  private onConnect(attempt: Attempt): void {
    attempt.connected = true;
    this.connectErrorReported = false;
    attempt.after(this.shared.stableAfterMs, () => {
      this.failures = 0;
    });
    attempt.atLeast(SUBSCRIBE_DELAY_MS, () => {
      attempt.delayElapsed = true;
      this.maybeSubscribe(attempt);
    });
    if (this.spec.ackEvent !== undefined) {
      attempt.atLeast(CONNECTION_ACK_WAIT_MS, () => {
        attempt.acked = true;
        this.maybeSubscribe(attempt);
      });
    }
  }

  private onConnectError(attempt: Attempt, error: unknown): void {
    if (!this.connectErrorReported) {
      // Once per streak of failed connects, until one succeeds.
      this.connectErrorReported = true;
      const message =
        error instanceof Error ? this.scrub(error.message) : 'unknown error';
      this.report(
        new TransportError(
          `Could not connect to the backend ${this.spec.namespace} socket (${JSON.stringify(message)}). It is retried with the backoff`,
          { code: 'transport_error', service: 'backend' },
        ),
      );
    }
    this.scheduleReconnect(attempt);
  }

  private onConnectionAck(attempt: Attempt, payload: unknown): void {
    // Unknown (undefined) when the ack does not parse: then nothing is said about the viewer.
    let authenticated: boolean | undefined;
    try {
      authenticated = parseResponse(
        MarketActivityConnectionAckSchema,
        payload,
        {
          strict: this.shared.strict,
          service: 'backend',
          path: `${this.spec.namespace} ${this.spec.ackEvent}`,
        },
      ).authenticated;
    } catch (error) {
      this.invalidFrame(error);
    }
    if (!attempt.acked && this.spec.wantsViewer && authenticated === false) {
      this.report(
        new XoError(
          'The backend serves this /market-activity connection anonymously, so it cannot build the userTradesOnly snapshots (each one is a ws_snapshot_failed). The key needs the account:read scope, and its account a Privy id',
          { code: 'ws_anonymous_viewer', service: 'backend' },
        ),
      );
    }
    attempt.acked = true;
    this.maybeSubscribe(attempt);
  }

  private maybeSubscribe(attempt: Attempt): void {
    if (
      attempt.retired ||
      !attempt.connected ||
      !attempt.delayElapsed ||
      (this.spec.ackEvent !== undefined && !attempt.acked) ||
      attempt.subscribeSeq > 0
    ) {
      return;
    }
    this.sendSubscribe(attempt);
  }

  private sendSubscribe(attempt: Attempt): void {
    const socket = attempt.socket;
    if (attempt.retired || this.closed || socket === undefined) {
      return;
    }
    attempt.subscribeSeq += 1;
    const seq = attempt.subscribeSeq;
    attempt.awaiting = true;
    this.clearAnswerTimer(attempt);
    attempt.answerTimer = attempt.after(SUBSCRIBE_ANSWER_TIMEOUT_MS, () => {
      if (seq !== attempt.subscribeSeq || !attempt.awaiting) {
        return;
      }
      attempt.awaiting = false;
      this.report(
        new XoError(
          `The backend did not answer the ${this.spec.subscribeEvent} within ${SUBSCRIBE_ANSWER_TIMEOUT_MS / 1000} s. The connection restarts with the backoff`,
          { code: 'ws_subscribe_failed', service: 'backend' },
        ),
      );
      this.scheduleReconnect(attempt);
    });
    socket.emit(
      this.spec.subscribeEvent,
      this.spec.payload,
      (answer: unknown) => {
        if (!attempt.retired && !this.closed) {
          this.run(() => this.onAnswer(attempt, seq, answer));
        }
      },
    );
  }

  private clearAnswerTimer(attempt: Attempt): void {
    if (attempt.answerTimer !== undefined) {
      clearTimeout(attempt.answerTimer);
      attempt.timers.delete(attempt.answerTimer);
      attempt.answerTimer = undefined;
    }
  }

  private onAnswer(attempt: Attempt, seq: number, answer: unknown): void {
    if (seq !== attempt.subscribeSeq) {
      return;
    }
    attempt.awaiting = false;
    this.clearAnswerTimer(attempt);
    if (
      typeof answer === 'object' &&
      answer !== null &&
      (answer as { ok?: unknown }).ok === true
    ) {
      if (attempt.snapshotFailed && !attempt.snapshotRetried) {
        // The subscription stands, but its snapshot could not be built: subscribe once more,
        // later. 'reconnected' waits for the outcome, so it never announces data that is not
        // there.
        attempt.snapshotFailed = false;
        attempt.snapshotRetried = true;
        attempt.atLeast(SNAPSHOT_RETRY_DELAY_MS, () => {
          if (!attempt.confirmed) {
            this.sendSubscribe(attempt);
          }
        });
        return;
      }
      this.confirm(attempt);
      return;
    }
    this.report(
      new XoError(
        `The backend answered the ${this.spec.subscribeEvent} without ok. The connection restarts with the backoff`,
        { code: 'ws_subscribe_failed', service: 'backend' },
      ),
    );
    this.scheduleReconnect(attempt);
  }

  /** The subscription is in place. After a reconnect, that is when `'reconnected'` goes out. */
  private confirm(attempt: Attempt): void {
    if (attempt.confirmed) {
      return;
    }
    attempt.confirmed = true;
    this.refreshedKey = false;
    this.failure = undefined;
    if (this.everConfirmed) {
      this.sub.pushReconnected();
    }
    this.everConfirmed = true;
  }

  private onSnapshot(attempt: Attempt, payload: unknown): void {
    // A snapshot comes only after a subscribe went through, and before its acknowledgement.
    this.clearAnswerTimer(attempt);
    this.confirm(attempt);
    if (containsSecret(payload, this.keys)) {
      // Something echoed the key back: never let it into an event or an error.
      this.frameError(
        new UnexpectedResponseError(
          `The backend ${this.spec.namespace} socket sent a ${this.spec.snapshotEvent} that contains this channel's API key. It was dropped unread`,
          { code: 'ws_frame_invalid', service: 'backend', issues: [] },
        ),
      );
      return;
    }
    let event: E;
    try {
      event = parseResponse(this.spec.schema, payload, {
        strict: this.shared.strict,
        service: 'backend',
        path: `${this.spec.namespace} ${this.spec.snapshotEvent}`,
      });
    } catch (error) {
      this.invalidFrame(error);
      return;
    }
    this.sub.push(event);
  }

  private invalidFrame(error: unknown): void {
    if (error instanceof UnexpectedResponseError) {
      this.frameError(
        new UnexpectedResponseError(`${error.message}. It was dropped`, {
          code: 'ws_frame_invalid',
          service: 'backend',
          issues: error.issues,
        }),
      );
      return;
    }
    throw error;
  }

  /** `portfolio_error` / `market_activity_error`. */
  private onServerError(attempt: Attempt, payload: unknown): void {
    const { message, code } = readServerError(payload);
    const shown = JSON.stringify(this.scrub(message));
    const ns = this.spec.namespace;
    if (ns === '/portfolio' && code === undefined) {
      const refusal = REFUSALS.get(message);
      if (refusal !== undefined) {
        this.refused(attempt, shown, refusal);
        return;
      }
    }
    if (code === undefined && message === this.spec.snapshotFailed) {
      this.onSnapshotFailed(attempt, shown);
      return;
    }
    attempt.reported.push({ message, coded: code !== undefined });
    if (attempt.reported.length > MAX_REMEMBERED_MESSAGES) {
      attempt.reported.shift();
    }
    if (code === undefined) {
      // An uncoded message that is no refusal. If the server disconnects next, the
      // disconnect reconnects with the backoff; if an `exception` follows, it restarts. A
      // repeat of the subscribe failure already reported is not reported again.
      if (this.failure?.message !== message) {
        this.report(
          new XoError(`The backend ${ns} socket reported ${shown}`, {
            code: 'ws_server_error',
            service: 'backend',
          }),
        );
      }
      return;
    }
    const advice = PERMANENT_CODES.get(code);
    if (advice !== undefined) {
      this.stop(
        new XoError(
          `The backend refused the ${ns} subscription: ${shown} (${code}). ${advice}. The same subscription would be refused again, so it is closed and not retried`,
          { code, service: 'backend' },
        ),
      );
      return;
    }
    const passed = SERVER_CODE.test(code) ? code : 'ws_server_error';
    if (code === 'API_KEY_INVALID') {
      // The backend's key monitor: the key was revoked or expired, and the server disconnects next.
      // Reconnecting with the same key cannot work: the session is asked for a new one.
      this.report(
        new XoError(
          `The backend says the API key of the ${ns} channel is no longer valid (${shown}). The session is asked for a new key`,
          { code: passed, service: 'backend' },
        ),
      );
      this.retire(attempt);
      this.run(() => this.credentialsRefused(attempt, shown, true));
      return;
    }
    // RATE_LIMITED, and codes this SDK does not know. The `exception` that follows a failed
    // subscribe restarts the connection.
    const next =
      code === 'RATE_LIMITED'
        ? ' The connection restarts with the backoff and subscribes again'
        : '';
    this.report(
      new XoError(
        `The backend ${ns} socket reported ${shown} (${code}).${next}`,
        {
          code: passed,
          service: 'backend',
        },
      ),
    );
  }

  /**
   * "Failed to build ... snapshot" (no code). The handler still acknowledges `ok`, so the
   * subscription stands. When it is the snapshot of the subscribe in flight, the
   * acknowledgement schedules one re-subscribe (see `onAnswer`) and nothing is reported yet;
   * when that one fails too, or a pushed snapshot fails, it is reported.
   */
  private onSnapshotFailed(attempt: Attempt, shown: string): void {
    if (attempt.awaiting && !attempt.snapshotRetried) {
      attempt.snapshotFailed = true;
      return;
    }
    const retried = attempt.awaiting;
    this.report(
      new XoError(
        retried
          ? `The backend could not build a ${this.spec.snapshotEvent} (${shown}), on the subscribe and again on the one re-subscribe ${SNAPSHOT_RETRY_DELAY_MS / 1000} s later. The stream stands and the next change in it sends one; to try again now, close this subscription and subscribe again`
          : `The backend could not build a ${this.spec.snapshotEvent} (${shown}). The subscription stands, and the next change in the stream sends a new one`,
        { code: 'ws_snapshot_failed', service: 'backend' },
      ),
    );
  }

  /** A connection refusal of `/portfolio`. The server disconnects the socket next. */
  private refused(attempt: Attempt, shown: string, refusal: Refusal): void {
    this.retire(attempt);
    const ns = this.spec.namespace;
    if (refusal === 'permanent') {
      this.stop(
        new XoError(
          `The backend refused the ${ns} connection: ${shown}. Retrying cannot help, so the stream is closed: subscribe again once the account is fixed`,
          { code: 'ws_auth_unrecoverable', service: 'backend' },
        ),
      );
      return;
    }
    if (refusal === 'retry') {
      this.report(
        new XoError(
          `The backend refused the ${ns} connection for now: ${shown}. It is retried with the backoff`,
          { code: 'ws_auth_failed', service: 'backend' },
        ),
      );
      this.scheduleReconnect(attempt);
      return;
    }
    this.run(() => this.credentialsRefused(attempt, shown, false));
  }

  /**
   * The backend refused the key. The session gets the chance to replace it
   * (`onUnauthorized`, as after a REST 401), and the connection restarts with what
   * `ensureBackend()` then returns. When it cannot (a key passed in by the caller, no
   * signer, a refresh within the last minute), the same key would be refused again: stop.
   */
  private async credentialsRefused(
    attempt: Attempt,
    shown: string,
    coded: boolean,
  ): Promise<void> {
    const ns = this.spec.namespace;
    if (this.refreshedKey) {
      // The key the session handed out right after a refresh is refused too: asking again
      // would loop (a session that always says it refreshed, or a backend that refuses every
      // key of this account). Stop.
      this.stop(
        new XoError(
          `The backend refused the API key of the ${ns} channel (${shown}) again, right after the session replaced it. The session is not asked again, and the stream is closed: subscribe again once the cause is fixed`,
          { code: 'ws_auth_unrecoverable', service: 'backend' },
        ),
      );
      return;
    }
    const sent = attempt.key;
    let refreshed = false;
    let failure: unknown;
    try {
      refreshed =
        (await this.shared.session?.onUnauthorized('backend', {
          headers:
            sent === undefined ? {} : { Authorization: `Bearer ${sent}` },
        })) === true;
    } catch (error) {
      failure = error;
    }
    if (this.isStale(attempt)) {
      return;
    }
    if (refreshed) {
      this.refreshedKey = true;
      if (!coded) {
        this.report(
          new XoError(
            `The backend refused the API key of the ${ns} channel (${shown}). The session replaced it, and the connection restarts with the backoff`,
            { code: 'ws_auth_refused', service: 'backend' },
          ),
        );
      }
      this.scheduleReconnect(attempt);
      return;
    }
    if (failure !== undefined && isTransient(failure)) {
      this.report(
        new XoError(
          `The backend refused the API key of the ${ns} channel (${shown}), and the session could not replace it yet. The connection is retried with the backoff`,
          {
            code: 'ws_auth_failed',
            service: 'backend',
            cause: scrubbedCause(failure),
          },
        ),
      );
      this.scheduleReconnect(attempt);
      return;
    }
    this.stop(
      new XoError(
        `The backend refused the API key of the ${ns} channel (${shown}), and the session cannot replace it (a key passed in by the caller, no signer, or a refresh within the last minute). The stream is closed: subscribe again once the cause is fixed`,
        {
          code: 'ws_auth_unrecoverable',
          service: 'backend',
          ...(failure === undefined ? {} : { cause: scrubbedCause(failure) }),
        },
      ),
    );
  }

  /** A message handler failed (no acknowledgement follows). */
  private onException(attempt: Attempt, payload: unknown): void {
    const { message } = readServerError(payload);
    const at = attempt.reported.findIndex((entry) => entry.message === message);
    const known = at >= 0;
    const coded = attempt.reported[at]?.coded === true;
    if (known) {
      attempt.reported.splice(at, 1);
    }
    const shown = JSON.stringify(this.scrub(message));
    const ns = this.spec.namespace;
    if (!attempt.awaiting) {
      if (!known) {
        this.report(
          new XoError(`The backend ${ns} socket reported ${shown}`, {
            code: 'ws_server_error',
            service: 'backend',
          }),
        );
      }
      return;
    }
    attempt.awaiting = false;
    this.clearAnswerTimer(attempt);
    if (message === AUTH_REQUIRED && !known) {
      // The subscribe overtook the asynchronous handshake check. Once more, later.
      if (!attempt.authRetried) {
        attempt.authRetried = true;
        attempt.atLeast(AUTH_RETRY_DELAY_MS, () => this.sendSubscribe(attempt));
        return;
      }
      this.report(
        new XoError(
          `The backend ${ns} socket still says "Authentication required" to a second subscribe. The connection is retried with the backoff`,
          { code: 'ws_auth_failed', service: 'backend' },
        ),
      );
      this.scheduleReconnect(attempt);
      return;
    }
    if (!coded && TRANSIENT_FAILURES.has(message)) {
      // Not counted, and it breaks a streak of another failure: reported, then the backoff.
      this.failure = undefined;
    } else if (!coded) {
      // An uncoded failure (an event that does not exist, a market_activity_error): the same
      // one MAX_SAME_FAILURES times in a row is permanent.
      const count =
        this.failure?.message === message ? this.failure.count + 1 : 1;
      this.failure = { message, count };
      if (count >= MAX_SAME_FAILURES) {
        this.stop(
          new XoError(
            `The backend refused the ${this.spec.subscribeEvent} ${count} times in a row with ${shown}. The stream is closed: subscribe again once the cause is fixed`,
            { code: 'ws_subscribe_unrecoverable', service: 'backend' },
          ),
        );
        return;
      }
      if (count > 1) {
        // Reported the first time already.
        this.scheduleReconnect(attempt);
        return;
      }
    }
    if (!known) {
      this.report(
        new XoError(
          `The backend refused the ${this.spec.subscribeEvent}: ${shown}. The connection restarts with the backoff`,
          { code: 'ws_subscribe_failed', service: 'backend' },
        ),
      );
    }
    this.scheduleReconnect(attempt);
  }

  private isStale(attempt: Attempt): boolean {
    return this.closed || this.current !== attempt;
  }

  /** Drops a socket: nothing it does later reaches the subscription. */
  private retire(attempt: Attempt): void {
    if (attempt.retired) {
      return;
    }
    attempt.retired = true;
    for (const timer of attempt.timers) {
      clearTimeout(timer);
    }
    attempt.timers.clear();
    attempt.answerTimer = undefined;
    const socket = attempt.socket;
    if (socket !== undefined) {
      socket.off();
      socket.offAny();
      socket.disconnect();
    }
  }

  /** Retires the socket and connects again after the jittered backoff. */
  private scheduleReconnect(attempt: Attempt): void {
    this.retire(attempt);
    if (this.isStale(attempt) || attempt.rescheduled) {
      return;
    }
    attempt.rescheduled = true;
    const { baseMs, capMs } = this.shared.backoff;
    const delay = backoffMs(this.failures, baseMs, capMs, this.shared.random);
    this.failures += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.launch();
    }, delay);
  }

  /** Reports a cause retrying cannot fix, once, and closes the subscription. */
  private stop(error: XoError): void {
    if (this.closed) {
      return;
    }
    this.report(error);
    this.shutdown();
    void this.sub.close();
  }

  /** `close()` of the subscription. */
  private shutdown(): void {
    this.closed = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.current !== undefined) {
      this.retire(this.current);
    }
  }

  /** A backend message, without this channel's keys or any API key, and cut to 200 characters. */
  private scrub(message: string): string {
    let safe = message;
    for (const key of this.keys) {
      safe = safe.split(key).join('[redacted]');
    }
    return String(redact(safe)).slice(0, MAX_SERVER_MESSAGE_CHARS);
  }

  /** Reports a dropped event, at most once a second per code. */
  private frameError(error: XoError): void {
    const now = performance.now();
    const last = this.errorAt.get(error.code);
    if (last !== undefined && now - last < FRAME_ERROR_INTERVAL_MS) {
      return;
    }
    this.errorAt.set(error.code, now);
    this.report(error);
  }
}

/** The origin Socket.IO connects to: `https:`, or `http:` on a local host, with no path. */
function readOrigin(value: unknown): string {
  const problem = new UserInputError(
    'env.backendSocketUrl must be an https: origin (http: on localhost, 127.0.0.1 or [::1]), with no path',
  );
  if (typeof value !== 'string') {
    throw problem;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw problem;
  }
  const secure =
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
  if (!secure || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw problem;
  }
  return url.origin;
}

const NO_SESSION =
  'The /portfolio channel needs a backend API key: pass the `session` option to BackendRealtime (a session with the `signer` option, or with `credentials: { backend: { apiKey } }`)';
const NO_BACKEND_CREDENTIAL =
  'The /portfolio channel needs a backend API key, but the session has neither a signer nor a key: pass the `signer` option to log in with a wallet, or `credentials: { backend: { apiKey } }` to use an existing key';

/** Whether the session can never produce a key. A closed session is left to its own `session_closed`. */
function cannotAuthenticate(session: Session): boolean {
  return (
    session.toJSON().closed !== true &&
    !session.hasSigner() &&
    !session.hasBackendCredential()
  );
}

/**
 * The backend's live streams over Socket.IO: the account's portfolio (`/portfolio`) and a
 * market's trades (`/market-activity`), as {@link Subscription}s.
 *
 * ```ts
 * const realtime = new BackendRealtime({ env, session });
 * const portfolio = realtime.portfolioChannel();
 * portfolio.on('portfolio_snapshot', (snapshot) => { positions = snapshot.data; });
 * portfolio.on('error', (error) => console.warn(error.code, error.message));
 * const trades = realtime.marketActivityChannel({ marketId: 1234 });
 * for await (const snapshot of trades) { ... }
 * ```
 *
 * > **WARNING: never enable the `socket.io-client` debug namespaces with a real key.**
 * > `socket.io-client`'s Node builds log every packet they write
 * > (`debug("writing packet %j", packet)` in its manager), and the handshake's CONNECT
 * > packet carries `auth: { token: "xo_sk_..." }`. With `DEBUG=socket.io-client:*` (or
 * > `DEBUG=*`, or any pattern that matches `socket.io-client:manager`) the backend key is
 * > printed to stderr in clear text. The SDK cannot prevent that (the key must travel in
 * > `auth`); its own guarantees below cover the SDK's output only.
 *
 * ## Snapshots, not deltas
 *
 * Every event is a whole page for the filters (the first page by default, `take` rows):
 * replace what you had. The backend sends one on subscribe and again after each change
 * (a trade of the account, of the subscribed market or of the event). Nothing is replayed
 * after a drop, but the first snapshot after a reconnect is complete again.
 *
 * ## Connecting
 *
 * - **The key.** Each connect and reconnect asks the session for the backend key
 *   (`session.ensureBackend()`), so a rotated key is picked up, and sends it in the
 *   Socket.IO handshake's `auth.token`, never in the URL's query or a header (a query string
 *   lands in access logs; `auth.token` is the one place the backend deletes it from once
 *   read). `/portfolio` needs it. `/market-activity` sends the key the session holds, so the
 *   viewer is the account (`userTradesOnly` works when the key holds `account:read` and its
 *   account has a Privy id), and logs in for one only when `userTradesOnly` needs it. So a
 *   public feed costs no wallet signature while the held key is valid; a held key that has
 *   expired or is due for rotation is renewed by `ensureBackend()` on connect, which may
 *   log in. Without a session, or with one that holds no key, it connects anonymously.
 * - **The early subscribe.** The backend checks the handshake after `connect` has fired, so
 *   the subscribe goes out 1000 ms after `connect` (`/market-activity`: also after its
 *   connection ack). If `/portfolio` still answers it with "Authentication required", it is
 *   sent once more 1000 ms later.
 * - **Reconnects.** Each connection is its own Socket.IO manager with Socket.IO's own
 *   reconnection off: the SDK reconnects after every drop and every retryable refusal, with
 *   full-jitter backoff (1 s doubling to 30 s by default; it starts over once a connection has
 *   stayed up 30 s), fetches the key again, subscribes again, and emits `'reconnected'` once
 *   the new subscription answered (its snapshot or its acknowledgement), before that
 *   snapshot. A `for await` loop never sees `'reconnected'` or `'error'`: listen with
 *   `on()` too (see {@link Subscription}).
 *
 * ## Errors
 *
 * The backend's `portfolio_error`, `market_activity_error` and `exception` are not events of
 * the stream: they arrive as `'error'`, an `XoError`. An `exception` that repeats an error
 * just reported is not reported again. By `code`:
 *
 * - The backend's own codes, passed on as they are (`service: 'backend'`):
 *   - `'INSUFFICIENT_SCOPE'` (the key lacks `account:read`), `'EVENT_TOO_LARGE'` (more than
 *     64 markets in the scope: the scope of an event subscription defaults to `'onlyClob'`),
 *     `'INVALID_FILTER'`, `'INVALID_EVENT_ID'`, `'TAKE_LIMIT'`: the same
 *     subscription would be refused again, so it is **closed** (`'closed'` follows; an
 *     iterator ends). The filter checks of the SDK make the last three unlikely;
 *   - `'RATE_LIMITED'`: the connection restarts with the backoff and subscribes again;
 *   - `'API_KEY_INVALID'` (the key was revoked or expired): the session is asked for a new
 *     key (`onUnauthorized`) and the connection restarts; when it cannot give one,
 *     `'ws_auth_unrecoverable'` follows;
 *   - any other code is reported and nothing more.
 * - `/portfolio` refusals, which carry no code: they are told apart by their documented
 *   messages, which the backend documents as stable:
 *   - `'ws_auth_refused'`: "Authentication failed" (the key is unknown, revoked or expired),
 *     and the session replaced the key (`onUnauthorized('backend', ...)` with the key that
 *     was sent): the connection restarts with the new one. If that key is refused too
 *     before a subscription has been confirmed, the session is not asked again:
 *     `'ws_auth_unrecoverable'`;
 *   - `'ws_auth_failed'`: "Authentication unavailable" or "Authentication required" (worth
 *     retrying), a second "Authentication required" to a subscribe, the session could not
 *     get a key or replace a refused one for a reason that may pass (the network, a timeout,
 *     a 429, a 5xx): retried with the backoff. On `/market-activity`: the session could not
 *     give a key, so that connection is anonymous;
 *   - `'ws_auth_unrecoverable'`: "User not found", "Account restricted", "Authentication
 *     failed" when the session cannot replace the key (a key passed in by the caller, no
 *     signer, a refresh within the last minute), or the session cannot give a key for any
 *     other reason (a closed session, a refused signature): reported **once**, and the
 *     subscription is **closed**. Subscribe again once the cause is fixed;
 *   - a refusal message this SDK does not know: `'ws_server_error'`, and the reconnect
 *     after the server's disconnect uses the backoff (never a stop).
 * - `'ws_snapshot_failed'`: the backend could not build a snapshot ("Failed to build ...
 *   snapshot"). It still acknowledges the subscribe, so the subscription stands; an
 *   acknowledgement is no proof that a snapshot was sent. When it is the snapshot of a
 *   subscribe, the SDK subscribes once more 5 s later (outside the strictest rate-limit
 *   window the backend documents) and reports only when that fails too; after a reconnect,
 *   `'reconnected'` waits for that outcome. The next change in the stream then sends a
 *   snapshot; to try again at once, close the subscription and subscribe again. A pushed
 *   snapshot that fails is reported at once.
 * - `'ws_subscribe_failed'`: a subscribe answered with an `exception` the SDK does not know
 *   (an event that does not exist, "Internal server error"), or not answered within 30 s:
 *   the connection restarts with the backoff. The same uncoded failure (this one, or a
 *   `market_activity_error`) is reported the first time only, and the third time in a row
 *   it is `'ws_subscribe_unrecoverable'`: reported once, and the subscription is **closed**.
 *   "Internal server error" (a backend incident) is the exception: it stays transient, is
 *   reported each time, and is retried with the capped backoff for as long as it lasts.
 * - `'ws_server_error'`: any other backend error message.
 * - `'ws_anonymous_viewer'`: `/market-activity` with `userTradesOnly` was served
 *   anonymously (the key lacks `account:read`, or its account has no Privy id), so the
 *   backend cannot build its snapshots: each one is a `'ws_snapshot_failed'`.
 * - `'ws_frame_invalid'`: a snapshot failed its schema, or contained the channel's key, and
 *   was dropped (at most one a second); `'ws_unknown_event'`: with `strictResponses`, an
 *   event the SDK does not know (at most one a second).
 * - `'transport_error'`: a connect failed (once per streak of failures); retried with the
 *   backoff.
 * - `'ws_channel_failed'` (`service: 'sdk'`): an unexpected failure inside the SDK; the
 *   stream goes on.
 *
 * No event and no error of the SDK ever holds the key, and the SDK logs nothing: backend
 * messages are scrubbed of it (and of any `xo_sk_` key), and a snapshot that contains it is
 * dropped. That covers the SDK's own output only: see the warning above about
 * `socket.io-client`'s debug logging.
 *
 * ## For the clients
 *
 * A client's realtime hub builds one `BackendRealtime` with its `env`, `session` and
 * `strictResponses`, and opens the `portfolio` and `activity` topics on it.
 *
 * Internal: an engine behind the two clients. No entry of the package exports it.
 */
export class BackendRealtime {
  private readonly shared: Shared;

  /**
   * Checks every option and opens nothing.
   *
   * @throws {UserInputError} for an invalid or unknown option.
   */
  constructor(o: BackendRealtimeOptions) {
    const options = closedObject(o, 'options', [
      'env',
      'session',
      'strictResponses',
      'connection',
    ]) as Partial<BackendRealtimeOptions>;
    const { env, session } = options;
    if (typeof env !== 'object' || env === null) {
      throw new UserInputError(
        'env must be an environment config with backendSocketUrl',
      );
    }
    const origin = readOrigin(env.backendSocketUrl);
    if (
      session !== undefined &&
      !hasMethods(session, [
        'ensureBackend',
        'onUnauthorized',
        'hasSigner',
        'hasBackendCredential',
        'toJSON',
      ])
    ) {
      throw new UserInputError('session must be a Session');
    }
    const strict = readFlag(options.strictResponses, 'strictResponses', false);
    const connection = closedObject(options.connection ?? {}, 'connection', [
      'backoff',
      'stableAfterMs',
      'connectTimeoutMs',
      'random',
    ]) as BackendSocketConnectionOptions;
    this.shared = {
      origin,
      session,
      strict,
      backoff:
        connection.backoff === undefined
          ? DEFAULT_BACKOFF
          : readBackoff(connection.backoff),
      stableAfterMs: timerMs(
        connection.stableAfterMs ?? DEFAULT_STABLE_AFTER_MS,
        'connection.stableAfterMs',
      ),
      connectTimeoutMs: timerMs(
        connection.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        'connection.connectTimeoutMs',
      ),
      random:
        readCallback<() => number>(
          connection.random,
          'connection.random',
          false,
        ) ?? Math.random,
    };
  }

  /**
   * Streams the account's portfolio (`/portfolio`): a `portfolio_snapshot` on subscribe and
   * after every change, each the whole page for `filters`. Without `marketId` the rows are
   * one {@link PortfolioMarket} per market (the summary); with it, that market's
   * {@link PortfolioPosition} rows (the detail), as in `portfolio.mine`. `marketScope`
   * defaults to `'withPulse'`: nothing the account holds is hidden. With `eventId` it
   * defaults to `'onlyClob'`, because the backend counts the event's markets in the
   * scope against its limit of 64 (`EVENT_TOO_LARGE`).
   *
   * It needs the session's key, with the `account:read` scope. See the class docs for the
   * connection, reconnects and errors.
   *
   * @throws {UserInputError} at once, for an unknown option or filter, or a filter outside
   *   the gateway's rules (`take` 1 to 100, or to 50 with `eventId`; `eventId` a UUID and not
   *   with `marketId` or `contractMarketId`).
   * @throws {AuthRequiredError} at once, when there is no session, or it has neither a
   *   signer nor a key.
   */
  portfolioChannel(options: {
    filters: PortfolioDetailFilters;
  }): Subscription<PortfolioSnapshotEvent<PortfolioPosition>>;
  portfolioChannel(options?: {
    filters?: PortfolioSummaryFilters;
  }): Subscription<PortfolioSnapshotEvent<PortfolioMarket>>;
  portfolioChannel(
    options?: PortfolioChannelOptions,
  ): Subscription<PortfolioChannelEvent>;
  portfolioChannel(
    options?: PortfolioChannelOptions,
  ):
    | Subscription<PortfolioChannelEvent>
    | Subscription<PortfolioSnapshotEvent<PortfolioPosition>>
    | Subscription<PortfolioSnapshotEvent<PortfolioMarket>> {
    const o =
      options === undefined
        ? {}
        : closedObject(options, 'options', ['filters']);
    const payload = portfolioSubscribePayload(o.filters);
    const session = this.shared.session;
    if (session === undefined) {
      throw new AuthRequiredError(NO_SESSION, { service: 'backend' });
    }
    if (cannotAuthenticate(session)) {
      throw new AuthRequiredError(NO_BACKEND_CREDENTIAL, {
        service: 'backend',
      });
    }
    const detail = payload.marketId !== undefined;
    const channel = new SocketChannel<PortfolioChannelEvent>(this.shared, {
      namespace: '/portfolio',
      authRequired: true,
      subscribeEvent: 'portfolio_subscribe',
      payload,
      snapshotEvent: 'portfolio_snapshot',
      errorEvent: 'portfolio_error',
      snapshotFailed: 'Failed to build portfolio snapshot',
      schema: (detail
        ? PortfolioDetailSnapshotSchema
        : PortfolioSummarySnapshotSchema) as DualSchema<PortfolioChannelEvent>,
      wantsViewer: false,
    });
    channel.start();
    return channel.sub;
  }

  /**
   * Streams one market's trade feed (`/market-activity`): a `market_activity_snapshot` on
   * subscribe and after every trade, each the whole page for `filters`, with the rows of
   * `markets.activity`.
   *
   * The session is optional. The key it holds is sent, and the viewer is the account; with
   * `userTradesOnly` (which needs the viewer) it logs in for one when it holds none. Without a
   * key the connection is anonymous: no session, or a session that holds no key and the
   * filters need no viewer. See the class docs for the connection, reconnects and errors.
   *
   * @throws {UserInputError} at once, for an unknown option or filter, a bad `marketId`,
   *   a filter outside the gateway's rules (`take` 1 to 50), or `userTradesOnly` without a
   *   session that can get a key.
   */
  marketActivityChannel(
    options: MarketActivityChannelOptions,
  ): Subscription<MarketActivityChannelEvent> {
    const o = closedObject(options, 'options', ['marketId', 'filters']);
    const marketId = field.id()(o.marketId, 'marketId') as number;
    const filters = marketActivityFilters(o.filters);
    const wantsViewer = filters.userTradesOnly === true;
    const session = this.shared.session;
    if (wantsViewer && (session === undefined || cannotAuthenticate(session))) {
      throw new UserInputError(
        'activity filters: userTradesOnly needs a viewer: pass a session (with a signer, or a key that holds account:read)',
      );
    }
    const channel = new SocketChannel<MarketActivityChannelEvent>(this.shared, {
      namespace: '/market-activity',
      authRequired: false,
      subscribeEvent: 'market_activity_subscribe',
      payload: { marketId, filters },
      snapshotEvent: 'market_activity_snapshot',
      errorEvent: 'market_activity_error',
      ackEvent: 'market_activity_connection_ack',
      snapshotFailed: 'Failed to build market activity snapshot',
      schema: MarketActivitySnapshotSchema,
      wantsViewer,
    });
    channel.start();
    return channel.sub;
  }
}
