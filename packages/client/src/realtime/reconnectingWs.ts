import {
  TimeoutError,
  TransportError,
  UserInputError,
  XoError,
} from '../core/errors';
import { backoffMs } from '../core/retry';

// A WebSocket that keeps itself alive: it pings, reconnects with jittered backoff, and
// tells its owner when to resubscribe. It is the transport under the orderbook channels.
//
// Gateway facts it relies on:
// - a text "PING" is answered with a text "PONG" and resets the idle timer;
// - the idle timeout is 60 s, so a ping every 10 s leaves a wide margin;
// - past the per-user cap the server closes with 1008 "max_ws_connections_exceeded".
//
// It uses only web-standard APIs (`WebSocket`, `URL`, `setTimeout`), no Node globals, so it runs
// on Node >= 22, Bun and browsers. Timers are deliberately not unref'd: a live subscription
// keeps the process alive until `close()`.

/** The `readyState` of an open socket. */
const OPEN = 1;
/** The `readyState` of a closed socket. */
const CLOSED = 3;

const DEFAULT_PING_INTERVAL_MS = 10_000;
const MIN_PING_INTERVAL_MS = 1_000;
const MAX_PING_INTERVAL_MS = 50_000;
const DEFAULT_BACKOFF = { baseMs: 250, capMs: 30_000 } as const;
/** A connection that stayed open this long counts as healthy: the backoff starts over. */
const DEFAULT_STABLE_AFTER_MS = 30_000;
/** How long `close()` waits for the peer to finish the close handshake. */
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
/** A connection attempt that has not opened within this long is abandoned and retried. */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/**
 * A socket that has delivered no frame for this many ping intervals is presumed dead (the peer
 * vanished without a FIN: a half-open connection). With the default 10 s ping that is 25 s,
 * well inside the gateway's 60 s idle timeout, and it still tolerates one lost PONG.
 */
const STALE_AFTER_PING_INTERVALS = 2.5;
/**
 * The close code this client sends when it abandons a socket itself. A client may only use 1000
 * or 3000..4999 (browsers and Node's WebSocket enforce it), and 1000 means a normal close.
 */
const CLOSE_ABANDONED = 4000;

/** The longest delay a timer can hold; `setTimeout` runs anything larger at once (after 1 ms). */
const MAX_TIMER_MS = 2_147_483_647;
/** `ws_callback_failed` is reported at most once per this long for each socket. */
const CALLBACK_ERROR_INTERVAL_MS = 1_000;

/** The gateway closes with this code when a user has too many connections. */
const CLOSE_MAX_CONNECTIONS = 1008;
/** The shortest wait after a 1008. The cap is not going to clear in less. */
const MIN_DELAY_AFTER_1008_MS = 1_000;
/** The code a client reports when the connection was lost without a close frame. */
const CLOSE_ABNORMAL = 1006;
/** A close reason is limited to 123 bytes of UTF-8 (RFC 6455 section 5.5). */
const MAX_REASON_BYTES = 123;

/** `text` cut to at most `maxBytes` bytes of UTF-8, on a character boundary. */
function truncateUtf8(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) {
    return text;
  }
  let out = '';
  let bytes = 0;
  // `for...of` walks code points, so a surrogate pair is never split.
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (bytes + size > maxBytes) {
      break;
    }
    out += char;
    bytes += size;
  }
  return out;
}

/** The options of the reconnecting WebSocket under the orderbook channels (their `connection` tuning picks from these). */
export interface ReconnectingWsOptions {
  /** `ws://` or `wss://`. */
  url: string;
  /**
   * The WebSocket constructor. Defaults to `globalThis.WebSocket`, which Node >= 22, Bun and
   * browsers provide. If there is none (and none is passed), the constructor throws a
   * `UserInputError` that names this option. Pass the `ws` package's `WebSocket` (cast to
   * `typeof WebSocket`) where the global is missing.
   */
  WebSocketImpl?: typeof WebSocket;
  /**
   * Milliseconds between two text `"PING"` frames: a whole number from 1000 to 50000. Defaults
   * to 10000. The gateway drops a connection that is idle for 60 s.
   */
  pingIntervalMs?: number;
  /**
   * Reconnect delay: full jitter, a random time in `[0, min(capMs, baseMs * 2^n)]` for the
   * n-th consecutive reconnect (`backoffMs`). Defaults to `{ baseMs: 250, capMs: 30000 }`.
   * `0 < baseMs <= capMs <= 2147483647`.
   */
  backoff?: { baseMs: number; capMs: number };
  /**
   * Runs every time a socket opens: the first connect and every reconnect. Send the subscribe
   * frames from here, built from the current state, and a reconnect resubscribes by itself.
   * `send` sends one text frame on the open socket.
   */
  onOpen: (send: (text: string) => void) => void;
  /** Called with each text frame. `"PONG"` (the keepalive answer) is never passed. */
  onMessage: (data: string) => void;
  /**
   * Runs after {@link onOpen} on every reconnect, never on the first connect. The stream does
   * not replay what was missed while the socket was down: refetch state here.
   */
  onReconnected?: () => void;
  /**
   * Called once for every socket that closes, with the close code and reason: a drop (1006), a
   * close from the server (for example 1008), and the 1000 that `close()` sends.
   *
   * A socket the client **abandons** (`'ws_stale'`, `'ws_connect_timeout'`) is reported when it
   * is abandoned, as `(1006, 'ws_stale')` or `(1006, 'ws_connect_timeout')`. Its real close
   * event, which may come much later or never, is deliberately **not** reported again: the
   * owner has already been told, and has a newer socket to think about. The same goes for a
   * socket `close()` gave up on, reported once as `(1006, 'close_timeout')`, for an attempt
   * that failed with an error before it opened, `(1006, 'ws_connect_failed')`, and for one
   * `close()` dropped while it was still connecting, `(1006, 'client_closed')`.
   */
  onClose?: (code: number, reason: string) => void;
  /**
   * Called with errors the socket survives; every one is followed by a reconnect except a
   * callback error. Never called after `close()`. By `code`:
   * - `'transport_error'`: a socket error, or the WebSocket constructor threw (a `TransportError`);
   * - `'max_ws_connections_exceeded'`: the gateway closed with 1008 (an `XoError`);
   * - `'ws_stale'`: nothing at all arrived for 2.5 ping intervals, so the connection is presumed
   *   half-open; the socket was closed locally with code 4000 (a `TransportError`);
   * - `'ws_connect_timeout'`: an attempt did not open within `connectTimeoutMs` (a `TimeoutError`);
   * - `'ws_callback_failed'`: an owner callback threw, the throw as `cause` (an `XoError`). At
   *   most one per second for each socket; further throws in that second are dropped, so a
   *   handler that fails on every message cannot flood the error channel.
   */
  onError?: (error: XoError) => void;
  /**
   * The random source of the jitter, a function returning a number in `[0, 1]`. Defaults to
   * `Math.random`. For tests.
   */
  random?: () => number;
  /**
   * How long a connection must stay open before the backoff starts over (milliseconds, at most
   * 2147483647). Defaults to 30000. A connection the gateway accepts and then refuses with 1008 does not
   * stay open that long, so refusals keep backing off.
   */
  stableAfterMs?: number;
  /**
   * How long `close()` waits for the peer to complete the close handshake before it gives up
   * and resolves anyway (milliseconds, at most 2147483647). Defaults to 5000. It also bounds
   * how long `close()` waits for sockets the client abandoned earlier.
   */
  closeTimeoutMs?: number;
  /**
   * How long a connection attempt may take to open, in milliseconds (a positive whole number,
   * at most 2147483647). Defaults to 10000. An attempt that is still not open then is abandoned, reported with
   * code `'ws_connect_timeout'`, and retried with the normal backoff.
   */
  connectTimeoutMs?: number;
}

type State = 'idle' | 'running' | 'closed';
type Timer = ReturnType<typeof setTimeout>;

/** A positive number of milliseconds a timer can hold (at most 2_147_483_647). */
export function timerMs(value: unknown, name: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_TIMER_MS
  ) {
    throw new UserInputError(
      `${name} must be a positive number of milliseconds, at most ${MAX_TIMER_MS}`,
    );
  }
  return value;
}

/** Like {@link timerMs}, for a whole number of milliseconds. */
function timerWholeMs(value: unknown, name: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_TIMER_MS
  ) {
    throw new UserInputError(
      `${name} must be a positive whole number of milliseconds, at most ${MAX_TIMER_MS}`,
    );
  }
  return value;
}

/** Closes a socket as far as the implementation allows, without waiting for the peer. */
function terminate(socket: WebSocket): void {
  try {
    // The WHATWG WebSocket API has no force-close. The `ws` package's client does.
    (socket as { terminate?: () => void }).terminate?.();
  } catch {
    // Nothing more can be done for a socket that refuses.
  }
}

export function readBackoff(value: unknown): {
  baseMs: number;
  capMs: number;
} {
  if (value === undefined) {
    return DEFAULT_BACKOFF;
  }
  if (typeof value !== 'object' || value === null) {
    throw new UserInputError('backoff must be { baseMs, capMs }');
  }
  const { baseMs, capMs } = value as { baseMs?: unknown; capMs?: unknown };
  const base = timerMs(baseMs, 'backoff.baseMs');
  const cap = timerMs(capMs, 'backoff.capMs');
  if (cap < base) {
    throw new UserInputError('backoff.capMs must be at least backoff.baseMs');
  }
  return { baseMs: base, capMs: cap };
}

function readUrl(value: unknown): string {
  if (typeof value !== 'string') {
    throw new UserInputError('url must be a string');
  }
  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    throw new UserInputError(`url is not a valid URL: ${value.slice(0, 80)}`);
  }
  if (protocol !== 'ws:' && protocol !== 'wss:') {
    throw new UserInputError('url must start with ws:// or wss://');
  }
  return value;
}

function readImplementation(value: unknown): typeof WebSocket {
  const impl =
    value ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (typeof impl !== 'function') {
    throw new UserInputError(
      'No WebSocket implementation: this runtime has no global WebSocket (Node >= 22, Bun and browsers do), and no WebSocketImpl option was given. Pass the WebSocketImpl option, for example the WebSocket class of the "ws" package',
    );
  }
  return impl as typeof WebSocket;
}

export function readCallback<T>(
  value: unknown,
  name: string,
  required: boolean,
): T {
  if (typeof value === 'function' || (!required && value === undefined)) {
    return value as T;
  }
  throw new UserInputError(`${name} must be a function`);
}

/**
 * A WebSocket client that pings, reconnects and resubscribes. Create it, then `start()` it;
 * nothing happens in the constructor.
 *
 * - **Connect.** `start()` opens the socket. {@link ReconnectingWsOptions.onOpen} runs for
 *   every open, and {@link ReconnectingWsOptions.onReconnected} after it for every open but
 *   the first.
 * - **Keepalive.** A text `"PING"` goes out every `pingIntervalMs` while the socket is open.
 *   The gateway's `"PONG"` is swallowed.
 * - **Reconnect.** When a socket closes, the next one opens after a full-jitter delay that
 *   doubles with each consecutive failure up to `capMs`. The count starts over once a
 *   connection has stayed open for 30 s. After a close with code 1008 the delay is at least
 *   1 s and the owner gets an error with code `'max_ws_connections_exceeded'`.
 * - **Dead peers.** A socket that delivers no frame at all (a `"PONG"` counts) for 2.5 ping
 *   intervals is presumed half-open: the owner gets a `'ws_stale'` error, the socket is
 *   abandoned and the client reconnects with the normal backoff. A connection attempt that has
 *   not opened within `connectTimeoutMs` gets the same treatment with `'ws_connect_timeout'`.
 *   Abandoning means: `close(4000, ...)` is sent, and where the implementation has a
 *   `terminate()` (the `ws` package's client does) the socket is terminated at once. The
 *   WHATWG WebSocket API has no force-close, so on an implementation without one (Node's
 *   global `WebSocket`, which is undici) a half-open peer can hold the socket and its file
 *   descriptor until the kernel's TCP timeout, which takes minutes. The client does not wait
 *   for that: the abandoned socket is tracked, `close()` waits for it for at most
 *   `closeTimeoutMs`, and nothing it raises later reaches the callbacks. Pair `ws_stale` with
 *   alerting if it repeats: it means a path between you and the gateway is dropping packets.
 * - **Restart.** `reconnect(reason)` drops a socket the owner finds unusable and reconnects
 *   with the normal backoff (the orderbook channels use it when the gateway refuses a frame).
 * - **Failed attempts.** An `error` on a socket that is not open (a refused connection, a
 *   failed handshake) ends the attempt at once: one `'transport_error'`, one
 *   `onClose(1006, 'ws_connect_failed')`, and a reconnect with the normal backoff. It does not
 *   wait for a `close` event, which Node 22's global WebSocket never fires in that case, and a
 *   `close` that does follow (Node 24, Bun, `ws`) is not counted again.
 * - **Close.** `close()` is final. It cancels every timer, stops reconnecting, and resolves
 *   once the open socket, and any socket abandoned after it had opened, has closed, or after
 *   `closeTimeoutMs`. A socket that never opened is not waited for: it is dropped at once
 *   (`onClose(1006, 'client_closed')`). No callback runs after it except the one `onClose`
 *   for the socket it closed.
 *
 * Feed a {@link Subscription} from it as shown in the Subscription docs.
 */
export class ReconnectingWs {
  private readonly url: string;
  private readonly Impl: typeof WebSocket;
  private readonly pingIntervalMs: number;
  private readonly backoff: { baseMs: number; capMs: number };
  private readonly random: () => number;
  private readonly stableAfterMs: number;
  private readonly closeTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly onOpen: (send: (text: string) => void) => void;
  private readonly onMessage: (data: string) => void;
  private readonly onReconnected: (() => void) | undefined;
  private readonly onClose:
    | ((code: number, reason: string) => void)
    | undefined;
  private readonly onError: ((error: XoError) => void) | undefined;

  private state: State = 'idle';
  private socket: WebSocket | undefined;
  /** Consecutive reconnects since the last stable connection: the `n` of the backoff. */
  private attempt = 0;
  /** Whether any socket has opened yet, to tell a reconnect from the first connect. */
  private hasOpened = false;
  private pingTimer: Timer | undefined;
  private reconnectTimer: Timer | undefined;
  private stableTimer: Timer | undefined;
  /** Fires when the current socket has delivered nothing for 2.5 ping intervals. */
  private staleTimer: Timer | undefined;
  /** Fires when the current attempt has not opened in time. Only runs until it opens. */
  private connectTimer: Timer | undefined;
  /** When the current socket last delivered a frame of any kind (`performance.now()`). */
  private lastFrameAt = 0;
  /**
   * Sockets given up on after they had opened (stale, `reconnect()`) whose own close event has
   * not come yet: `close()` waits for them, bounded. A socket that never opened is not kept.
   */
  private readonly abandoned = new Set<WebSocket>();
  /** Every socket that has opened. A socket that never did has no close handshake to wait for. */
  private readonly opened = new WeakSet<WebSocket>();
  /** When `ws_callback_failed` was last reported for each socket, for the 1 per second limit. */
  private readonly callbackErrorAt = new WeakMap<WebSocket, number>();
  private closing: Promise<void> | undefined;
  private settleClose: (() => void) | undefined;

  /**
   * @throws {UserInputError} for an invalid option, or when there is no WebSocket
   * implementation (see {@link ReconnectingWsOptions.WebSocketImpl}).
   */
  constructor(options: ReconnectingWsOptions) {
    this.url = readUrl(options.url);
    this.Impl = readImplementation(options.WebSocketImpl);
    const ping = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    if (
      typeof ping !== 'number' ||
      !Number.isInteger(ping) ||
      ping < MIN_PING_INTERVAL_MS ||
      ping > MAX_PING_INTERVAL_MS
    ) {
      throw new UserInputError(
        `pingIntervalMs must be a whole number of milliseconds from ${MIN_PING_INTERVAL_MS} to ${MAX_PING_INTERVAL_MS} (the gateway drops a connection that is idle for 60 s)`,
      );
    }
    this.pingIntervalMs = ping;
    this.backoff = readBackoff(options.backoff);
    this.random = readCallback<() => number>(
      options.random ?? Math.random,
      'random',
      true,
    );
    this.stableAfterMs = timerMs(
      options.stableAfterMs ?? DEFAULT_STABLE_AFTER_MS,
      'stableAfterMs',
    );
    this.closeTimeoutMs = timerMs(
      options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
      'closeTimeoutMs',
    );
    this.connectTimeoutMs = timerWholeMs(
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      'connectTimeoutMs',
    );
    this.onOpen = readCallback(options.onOpen, 'onOpen', true);
    this.onMessage = readCallback(options.onMessage, 'onMessage', true);
    this.onReconnected = readCallback(
      options.onReconnected,
      'onReconnected',
      false,
    );
    this.onClose = readCallback(options.onClose, 'onClose', false);
    this.onError = readCallback(options.onError, 'onError', false);
  }

  /**
   * Opens the first connection. Idempotent, and a no-op after `close()`. The socket opens
   * asynchronously: nothing may be sent until {@link ReconnectingWsOptions.onOpen} runs.
   */
  start(): void {
    if (this.state !== 'idle') {
      return;
    }
    this.state = 'running';
    this.connect();
  }

  /**
   * Sends a text frame on the open socket.
   *
   * @throws {UserInputError} (code `'ws_not_open'`) when no socket is open: before the first
   * connect, between a drop and the reconnect, and after `close()`. Send from
   * {@link ReconnectingWsOptions.onOpen}, which runs when a socket is open.
   */
  send(text: string): void {
    if (typeof text !== 'string') {
      throw new UserInputError('A WebSocket frame must be a string');
    }
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== OPEN) {
      throw new UserInputError(
        'Cannot send: the WebSocket is not open. Send from onOpen, which runs each time a socket opens',
        { code: 'ws_not_open' },
      );
    }
    socket.send(text);
  }

  /**
   * Drops the current socket and reconnects with the normal backoff, as if it had dropped by
   * itself. For an owner that finds the connection unusable: the orderbook channels
   * call it when the gateway refuses a frame, so the next connection sends the subscription
   * whole again (and fetches fresh credentials).
   *
   * The socket is abandoned like a stale one (see the class docs): `close(4000, reason)`, then
   * `terminate()` where the implementation has it, and `onClose` gets `(1006, reason)` at once,
   * before this returns. No error is reported: the owner knows why. The backoff counter keeps
   * growing, because the connection did not stay open for `stableAfterMs`, so a refusal that
   * repeats backs off up to `capMs`. A no-op before `start()`, after `close()`, and while no
   * socket exists (waiting to reconnect).
   *
   * A close reason is limited to 123 bytes of UTF-8, so a longer `reason` is cut to that, on
   * a character boundary (the same text goes to `onClose`).
   *
   * @throws {UserInputError} when `reason` is not a string.
   */
  reconnect(reason = 'client_reconnect'): void {
    if (typeof reason !== 'string') {
      throw new UserInputError('reason must be a string');
    }
    const socket = this.socket;
    if (this.state !== 'running' || socket === undefined) {
      return;
    }
    this.abandon(socket, truncateUtf8(reason, MAX_REASON_BYTES));
  }

  /**
   * Stops for good: cancels the ping and reconnect timers, stops reconnecting, closes the
   * socket (code 1000) and resolves once it has closed, and once every socket the client
   * abandoned after it had opened (see the class docs) has closed too. Idempotent: every call
   * returns the same promise. With nothing to wait for (not started, waiting to reconnect, or
   * a socket still connecting, which is dropped with `onClose(1006, 'client_closed')`) it
   * resolves at once. If the peers do not finish closing within `closeTimeoutMs` it resolves
   * anyway: the socket that was open gets `onClose(1006, 'close_timeout')`, and every socket
   * still closing is terminated where the implementation can.
   */
  close(): Promise<void> {
    if (this.closing !== undefined) {
      return this.closing;
    }
    this.state = 'closed';
    this.clearSocketTimers();
    this.clearReconnect();
    const current = this.socket;
    if (current !== undefined && !this.opened.has(current)) {
      // Still connecting: there is no close handshake to wait for, and an implementation may
      // never fire `close` for an aborted handshake (Node 22's global WebSocket does not).
      this.socket = undefined;
      this.dropUnopened(current);
      this.guard(
        () => this.onClose?.(CLOSE_ABNORMAL, 'client_closed'),
        current,
      );
    }
    const open =
      this.socket !== undefined && this.socket.readyState !== CLOSED
        ? this.socket
        : undefined;
    if (open === undefined) {
      this.socket = undefined;
    }
    if (open === undefined && this.abandoned.size === 0) {
      this.closing = Promise.resolve();
      return this.closing;
    }
    this.closing = new Promise<void>((resolve) => {
      const giveUp = setTimeout(() => {
        // A peer never answered. Stop waiting; ignore these sockets from now on.
        if (open !== undefined && this.socket === open) {
          this.socket = undefined;
          this.guard(
            () => this.onClose?.(CLOSE_ABNORMAL, 'close_timeout'),
            open,
          );
          terminate(open);
        }
        for (const stuck of this.abandoned) {
          terminate(stuck);
        }
        this.abandoned.clear();
        resolve();
      }, this.closeTimeoutMs);
      // Runs when a socket's close event arrives: done once nothing is left to wait for.
      this.settleClose = () => {
        if (this.socket === undefined && this.abandoned.size === 0) {
          clearTimeout(giveUp);
          resolve();
        }
      };
    });
    try {
      open?.close(1000, 'client_closed');
    } catch {
      // Already closing; the close event settles the promise.
    }
    return this.closing;
  }

  private connect(): void {
    this.reconnectTimer = undefined;
    if (this.state !== 'running') {
      return;
    }
    let socket: WebSocket;
    try {
      socket = new this.Impl(this.url);
    } catch (cause) {
      // No socket exists, so no close event will come: treat it as a failed attempt.
      this.report(
        new TransportError('Could not create the WebSocket', {
          service: 'orderbook',
          cause,
        }),
      );
      this.scheduleReconnect(false);
      return;
    }
    this.socket = socket;
    this.connectTimer = setTimeout(
      () => this.handleConnectTimeout(socket),
      this.connectTimeoutMs,
    );
    socket.addEventListener('open', () => this.handleOpen(socket));
    socket.addEventListener('message', (event) =>
      this.handleMessage(socket, event.data),
    );
    socket.addEventListener('error', (event) =>
      this.handleError(socket, event),
    );
    socket.addEventListener('close', (event) =>
      this.handleClose(
        socket,
        typeof event.code === 'number' ? event.code : CLOSE_ABNORMAL,
        typeof event.reason === 'string' ? event.reason : '',
      ),
    );
  }

  private handleOpen(socket: WebSocket): void {
    if (socket !== this.socket || this.state !== 'running') {
      return;
    }
    this.opened.add(socket);
    // It opened in time: the connect timer is done, and the silence watchdog takes over.
    this.clearConnectTimer();
    this.armStaleTimer(
      socket,
      this.pingIntervalMs * STALE_AFTER_PING_INTERVALS,
    );
    this.stableTimer = setTimeout(() => {
      this.stableTimer = undefined;
      this.attempt = 0;
    }, this.stableAfterMs);
    this.pingTimer = setInterval(() => this.ping(socket), this.pingIntervalMs);
    const isReconnect = this.hasOpened;
    this.hasOpened = true;
    this.guard(() => this.onOpen((text) => this.send(text)), socket);
    // onOpen may have closed us, or the socket may have dropped meanwhile.
    if (isReconnect && this.state === 'running' && this.socket === socket) {
      this.guard(() => this.onReconnected?.(), socket);
    }
  }

  private handleMessage(socket: WebSocket, data: unknown): void {
    if (socket !== this.socket || this.state !== 'running') {
      return;
    }
    // A frame of any kind, "PONG" and binary included, proves the peer is there. Only the time
    // is noted; the silence timer checks it when it fires (see handleStale).
    this.lastFrameAt = performance.now();
    // The gateway sends text only; anything else is not ours to interpret.
    if (typeof data !== 'string' || data === 'PONG') {
      return;
    }
    this.guard(() => this.onMessage(data), socket);
  }

  private handleError(socket: WebSocket, event: unknown): void {
    // After close() an aborted handshake raises an error event: expected, not worth reporting.
    // A socket this client already gave up on (an earlier error, a timeout) is not either.
    if (socket !== this.socket || this.state !== 'running') {
      return;
    }
    const { message, error } = (event ?? {}) as {
      message?: unknown;
      error?: unknown;
    };
    const detail =
      typeof message === 'string' && message !== ''
        ? `: ${message.slice(0, 200)}`
        : '';
    const failure = new TransportError(`WebSocket error${detail}`, {
      service: 'orderbook',
      cause: error,
    });
    if (socket.readyState === OPEN) {
      // An open socket that errors closes next: its close event drives the reconnect.
      this.report(failure);
      return;
    }
    // Not open (a refused connection, a failed handshake): the attempt ends here. Node 22's
    // global WebSocket fires no `close` after this error, so waiting for one would leave the
    // attempt hanging until the connect timeout. Where a `close` does follow (Node 24, Bun,
    // the `ws` package), it finds the socket no longer current and is ignored, so the attempt
    // is reported, closed and counted once.
    this.abandon(
      socket,
      this.opened.has(socket) ? 'ws_error' : 'ws_connect_failed',
      failure,
    );
  }

  private handleClose(socket: WebSocket, code: number, reason: string): void {
    if (this.abandoned.delete(socket)) {
      // Abandoned earlier: onClose already ran for it (1006, with the reason it was abandoned),
      // and its real close, which may be late, is deliberately not reported a second time.
      this.settleClose?.();
      return;
    }
    if (socket !== this.socket) {
      return; // a socket close() gave up on
    }
    this.socket = undefined;
    this.clearSocketTimers();
    this.guard(() => this.onClose?.(code, reason), socket);
    if (this.state === 'closed') {
      // close() asked for this (or a callback just called close()): settle it, do not reconnect.
      this.settleClose?.();
      return;
    }
    const refused = code === CLOSE_MAX_CONNECTIONS;
    if (refused) {
      this.report(
        new XoError(
          'The orderbook closed the WebSocket with code 1008: this account has too many open WebSocket connections. Close the ones you do not need; the client retries with a growing delay',
          { code: 'max_ws_connections_exceeded', service: 'orderbook' },
        ),
      );
    }
    this.scheduleReconnect(refused);
  }

  /**
   * The silence timer fired. Frames only note their arrival time, they do not touch the timer
   * (that would be a clearTimeout and a setTimeout per frame), so the deadline is checked
   * here: if a frame arrived since the timer was set, wait out the rest of the silence window;
   * if nothing arrived for 2.5 ping intervals, the connection is presumed half-open.
   */
  private handleStale(socket: WebSocket): void {
    if (socket !== this.socket || this.state !== 'running') {
      return;
    }
    this.staleTimer = undefined;
    const limitMs = this.pingIntervalMs * STALE_AFTER_PING_INTERVALS;
    // The timer was set for exactly one window after the open, so a `lastFrameAt` from before
    // the open (an earlier socket's, or the initial 0) is at least a window old: no frame yet.
    const quietMs = performance.now() - this.lastFrameAt;
    if (quietMs < limitMs) {
      this.armStaleTimer(socket, limitMs - quietMs);
      return;
    }
    this.abandon(
      socket,
      'ws_stale',
      new TransportError(
        `The WebSocket received nothing for ${limitMs} ms (${STALE_AFTER_PING_INTERVALS} ping intervals), not even a PONG: the connection is presumed dead. It was closed and the client reconnects`,
        { code: 'ws_stale', service: 'orderbook' },
      ),
    );
  }

  /** The attempt has not opened within `connectTimeoutMs`. */
  private handleConnectTimeout(socket: WebSocket): void {
    if (socket !== this.socket || this.state !== 'running') {
      return;
    }
    this.abandon(
      socket,
      'ws_connect_timeout',
      new TimeoutError(
        `The WebSocket did not open within ${this.connectTimeoutMs} ms. The attempt was abandoned and the client retries`,
        { code: 'ws_connect_timeout', service: 'orderbook' },
      ),
    );
  }

  /**
   * Gives up on a socket that will not tell us it is closed (a half-open connection, or a
   * handshake that never finishes) and reconnects. Waiting for its close event would mean
   * waiting for the peer, which is the thing that is not answering. So the socket is closed
   * as far as the implementation allows (`close(4000)`, then `terminate()` where it exists),
   * and `onClose` gets code 1006, "closed abnormally, no close frame", at once.
   *
   * It is then tracked in `abandoned` until its own close event arrives, so that `close()` can
   * wait for it (bounded) and so that the late event is recognised and not reported again.
   * Whatever else it raises meanwhile is ignored, because it is no longer `this.socket`.
   */
  private abandon(socket: WebSocket, reason: string, error?: XoError): void {
    this.socket = undefined;
    this.clearSocketTimers();
    if (this.opened.has(socket)) {
      this.abandoned.add(socket);
      try {
        socket.close(CLOSE_ABANDONED, reason);
      } catch {
        // Nothing more to do for a socket that refuses to close.
      }
      terminate(socket);
    } else {
      // It never opened: no close handshake to wait for, so `close()` does not track it.
      this.dropUnopened(socket);
    }
    this.guard(() => this.onClose?.(CLOSE_ABNORMAL, reason), socket);
    if (error !== undefined) {
      this.report(error);
    }
    this.scheduleReconnect(false);
  }

  /**
   * Aborts a socket that never opened, without waiting for anything: `close()` cancels its
   * handshake (it may have failed already), and `terminate()` frees it where the
   * implementation has one. Whatever it fires later is ignored, because it is no longer
   * `this.socket` and is not in `abandoned`.
   */
  private dropUnopened(socket: WebSocket): void {
    try {
      socket.close(CLOSE_ABANDONED, 'client_closed');
    } catch {
      // A handshake that already failed may refuse.
    }
    terminate(socket);
  }

  /** Waits a jittered, growing delay, then connects again. */
  private scheduleReconnect(refused: boolean): void {
    if (this.state !== 'running') {
      return; // a callback closed us
    }
    let delay = backoffMs(
      this.attempt,
      this.backoff.baseMs,
      this.backoff.capMs,
      this.random,
    );
    if (refused) {
      delay = Math.max(MIN_DELAY_AFTER_1008_MS, delay);
    }
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private ping(socket: WebSocket): void {
    if (socket !== this.socket || socket.readyState !== OPEN) {
      return;
    }
    try {
      socket.send('PING');
    } catch {
      // The socket is going away; its close event drives the reconnect.
    }
  }

  /**
   * Runs a callback of the owner so that what it throws cannot break the connection. A throw is
   * reported as `ws_callback_failed`, at most once per second for each socket: a handler that
   * fails on every message would otherwise turn one bug into thousands of error events.
   */
  private guard(callback: () => void, socket: WebSocket): void {
    try {
      callback();
    } catch (cause) {
      const now = performance.now();
      const last = this.callbackErrorAt.get(socket);
      if (last !== undefined && now - last < CALLBACK_ERROR_INTERVAL_MS) {
        return;
      }
      this.callbackErrorAt.set(socket, now);
      this.report(
        new XoError('A ReconnectingWs callback threw', {
          code: 'ws_callback_failed',
          service: 'sdk',
          cause,
        }),
      );
    }
  }

  private report(error: XoError): void {
    if (this.onError === undefined || this.state === 'closed') {
      return;
    }
    try {
      this.onError(error);
    } catch {
      // An observer cannot break the connection either.
    }
  }

  /** Starts the silence timer: when the socket opens, and again by handleStale if needed. */
  private armStaleTimer(socket: WebSocket, delayMs: number): void {
    this.staleTimer = setTimeout(() => this.handleStale(socket), delayMs);
  }

  /** Clears every timer that belongs to the current socket. */
  private clearSocketTimers(): void {
    this.clearPing();
    this.clearStable();
    this.clearConnectTimer();
    if (this.staleTimer !== undefined) {
      clearTimeout(this.staleTimer);
      this.staleTimer = undefined;
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== undefined) {
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }
  }

  private clearPing(): void {
    if (this.pingTimer !== undefined) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  private clearStable(): void {
    if (this.stableTimer !== undefined) {
      clearTimeout(this.stableTimer);
      this.stableTimer = undefined;
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}
