import type { Session } from '../auth/session';
import type { EnvironmentConfig } from '../core/env';
import {
  AuthRequiredError,
  UnexpectedResponseError,
  UserInputError,
  XoError,
} from '../core/errors';
import { normalizeConditionId, normalizeTokenId } from '../core/ids';
import { redact } from '../core/redact';
import type { ConditionId, TokenId } from '../core/types';
import type { OpenOrdersOptions } from '../orderbook/account';
import type { OrderbookClient } from '../orderbook/client';
import { closedObject } from '../orderbook/internal';
import type { OpenOrder, OrderBook } from '../orderbook/schemas';
import type { OrderbookCredential } from '../signing/hmac';
import { hasMethods, isTransient, readFlag, scrubbedCause } from './internal';
import {
  type FrameResult,
  type MarketChannelEvent,
  type OrderbookChannel,
  parseMarketFrame,
  parseUserFrame,
  type UserChannelEvent,
} from './orderbookFrames';
import { ReconnectingWs, type ReconnectingWsOptions } from './reconnectingWs';
import { Subscription } from './subscription';

export type { MarketChannelEvent, UserChannelEvent } from './orderbookFrames';

// The orderbook's market and user WebSocket channels, on top of ReconnectingWs and
// Subscription. The frames themselves are parsed in orderbookFrames.ts.
//
// Gateway facts this file relies on:
// - Subscribe and unsubscribe are CLOB-style frames. /ws/market refuses `type: "user"`;
//   /ws/user needs `type: "user"` and `auth: {apiKey, secret, passphrase}` with the raw secret
//   in the frame.
// - `assets_ids` takes token ids or condition ids. A token id is resolved to its market for
//   the event filter, and gets a `book` snapshot (`initial_dump`, default true); a condition id
//   is stored as it is and gets no snapshot (a snapshot is built for a token id only). An
//   unsubscribe removes the RAW id, so it must name the
//   condition id the market is stored under, whatever the subscribe sent.
// - A connection holds at most 100 markets, but the check counts the ids in the frame:
//   subscribed + ids-in-frame <= 100.
// - On /ws/user an EMPTY market set means every market.
// - A refused frame is answered with `{type: "error", message}` and the socket stays open; a
//   subscribe is answered with `{type: "subscribed"}`, an unsubscribe with nothing.
// - Every connection first gets a `trading_state_changed` snapshot, and gets another one after
//   a broadcast lag, when events were dropped.

/** The gateway's cap: ids per subscribe frame plus markets already held, per connection. */
export const MAX_IDS_PER_CONNECTION = 100;
/** Token lookups (`GET /markets/{condition_id}`) in flight at once, per subscribe. */
const LOOKUP_CONCURRENCY = 8;
/** Markets whose tokens are cached. Tokens never change; the cap only bounds memory. */
const TOKEN_CACHE_LIMIT = 10_000;
/** `ws_frame_invalid` (and `ws_unknown_event`) are reported at most once per this long. */
const FRAME_ERROR_INTERVAL_MS = 1_000;
/** How much of a gateway error message an error repeats. */
const MAX_SERVER_MESSAGE_CHARS = 200;
/** Credentials shorter than this are not scrubbed from text: it would mangle messages. */
const MIN_SCRUB_CHARS = 8;
/**
 * How long a reconnect waits for the gateway to confirm the resubscription before it is
 * announced anyway.
 */
const RECONNECT_ANSWER_TIMEOUT_MS = 5_000;
/**
 * The gateway's refusals of user-channel credentials, told apart
 * from its other refusals of the auth frame ("user channel subscribe failed: engine
 * unavailable", the subscription limit), which are not about the credentials.
 */
const CREDENTIAL_REFUSAL = /^user channel auth\b/;
/** How many credential values (three per set) a user channel keeps scrubbing after a rotation. */
const MAX_SCRUBBED_VALUES = 9;

/** The connection tuning of the orderbook's WebSocket connections that the channels pass through. */
export type OrderbookConnectionOptions = Pick<
  ReconnectingWsOptions,
  | 'pingIntervalMs'
  | 'backoff'
  | 'stableAfterMs'
  | 'closeTimeoutMs'
  | 'connectTimeoutMs'
  | 'random'
>;

const CONNECTION_KEYS = [
  'pingIntervalMs',
  'backoff',
  'stableAfterMs',
  'closeTimeoutMs',
  'connectTimeoutMs',
  'random',
] as const;

/** The options of {@link OrderbookRealtime}. */
export interface OrderbookRealtimeOptions {
  /** Its `orderbookMarketWsUrl` and `orderbookUserWsUrl` are the channels' endpoints. */
  env: EnvironmentConfig;
  /**
   * The orderbook client. The market channel looks up each market's tokens with
   * `getMarket` (for the initial book snapshots), and the resync helpers read through it,
   * with its transport's credentials.
   */
  orderbook: OrderbookClient;
  /**
   * The trader's session. The user channel needs it: it asks `ensureOrderbook()` for the
   * L2 credentials on every connect and reconnect, and `onUnauthorized('orderbook', ...)` to
   * refresh them when the gateway refuses them. The market channel does not.
   */
  session?: Session;
  /**
   * The WebSocket constructor. Defaults to `globalThis.WebSocket` (Node >= 22, Bun). Without
   * one, the constructor throws a `UserInputError` naming this option.
   */
  WebSocketImpl?: typeof WebSocket;
  /**
   * Refuse unknown fields, unknown enum values and unknown events in frames (for contract
   * tests). A refused frame is dropped and reported as an `'error'`; it never ends the stream.
   */
  strictResponses?: boolean;
  /** Keepalive, backoff and timeouts of every connection (see `ReconnectingWsOptions`). */
  connection?: OrderbookConnectionOptions;
}

/** The options of {@link OrderbookRealtime.marketChannel}. */
export interface MarketChannelOptions {
  /** The markets, by condition id. May be empty: add markets later with `subscribe`. */
  conditionIds: readonly (ConditionId | string)[];
  /**
   * Also receive `best_bid_ask`, `new_market` and `market_resolved` (the gateway's
   * `custom_feature_enabled`). Defaults to false.
   */
  customFeatures?: boolean;
  /**
   * Receive a `book` snapshot of every token when a market is subscribed, and again after
   * every reconnect (the gateway's `initial_dump`). Defaults to true. It needs the token ids,
   * which the SDK looks up once per market (`getMarket`); with `false` the frames carry the
   * condition ids and nothing is looked up.
   */
  initialDump?: boolean;
}

/** The options of {@link OrderbookRealtime.userChannel}. */
export interface UserChannelOptions {
  /**
   * The markets, by condition id. **Omit it to receive every market**, on one connection. An
   * empty array means none yet (no connection until `subscribe` adds one): the gateway reads
   * an empty list as "every market", so the SDK never sends one for a scoped channel.
   */
  conditionIds?: readonly (ConditionId | string)[];
  /**
   * The user channel sends the raw API secret in a WebSocket frame, so it
   * refuses to run where `globalThis.window` exists (a browser), unless this is true.
   */
  allowBrowserSecrets?: boolean;
}

/** One market on a connection, and the ids its subscribe frame carries for it. */
interface Entry {
  /**
   * The market's condition id. For an outcome token subscribed on its own (a market channel
   * opened with `assetIds`), the token id: such an entry is never unsubscribed.
   */
  conditionId: string;
  /** Its token ids (market channel with initial dumps), else the condition id alone. */
  ids: readonly string[];
}

/** One socket of a channel, and what the SDK knows about the gateway's view of it. */
class Connection {
  readonly entries = new Map<string, Entry>();
  /** How many ids the full subscribe frame carries: at most MAX_IDS_PER_CONNECTION. */
  weight = 0;
  /** Bumped on every open and every close: an async step for an older socket is stale. */
  generation = 0;
  /** The current socket got its subscribe frame: changes go out as dynamic frames now. */
  ready = false;
  /** Subscribe frames on the current socket the gateway has not answered yet. */
  pendingAnswers = 0;
  /** The current socket's first (full) subscribe frame went out and is not answered yet. */
  awaitingInitial = false;
  /** The current socket delivered its connect snapshot (`trading_state_changed`) already. */
  sawSnapshot = false;
  /** A reconnect waits to be announced until the gateway confirms the resubscription. */
  reconnectPending = false;
  /** Announces a pending reconnect anyway when the gateway does not answer in time. */
  reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  /** The API key the current socket's user subscribe frame carried (for onUnauthorized). */
  sentApiKey: string | undefined;
  /** Retired or closed: nothing more is sent. */
  closed = false;

  constructor(readonly ws: ReconnectingWs) {}
}

/** What every channel of one OrderbookRealtime shares. */
interface Shared {
  readonly env: EnvironmentConfig;
  readonly impl: typeof WebSocket;
  readonly connection: OrderbookConnectionOptions;
  readonly strict: boolean;
  readonly session: Session | undefined;
  tokensOf(conditionId: ConditionId): Promise<readonly string[]>;
}

interface ChannelConfig<E> {
  kind: OrderbookChannel;
  /** A user channel on every market: one connection with an empty market list. */
  allMarkets: boolean;
  initialDump: boolean;
  customFeatures: boolean;
  parse: (text: string, strict: boolean) => FrameResult<E>;
}

/** Runs `fn` over `items` with at most `limit` calls in flight, keeping the order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

/**
 * One subscription and the connections behind it: more than 100 ids are split over several
 * connections of at most 100, all feeding the same `Subscription`. Subscribe and unsubscribe
 * run one at a time, in call order, so a change never overtakes an earlier one.
 */
class Channel<E extends { type: string }> {
  readonly sub: Subscription<E>;
  private readonly connections: Connection[] = [];
  /** Which connection holds each market (or token subscribed on its own). */
  private readonly owner = new Map<string, Connection>();
  /** Connections being closed (emptied by unsubscribe), for `close()` to wait on. */
  private readonly retiring = new Set<Promise<void>>();
  private readonly errorAt = new Map<string, number>();
  /**
   * The credential values this channel has sent (the newest first, including rotated-out
   * ones): scrubbed from gateway messages, and frames that contain one are dropped.
   */
  private secrets: string[] = [];
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly shared: Shared,
    readonly config: ChannelConfig<E>,
  ) {
    this.sub = new Subscription<E>({ closeTransport: () => this.closeAll() });
  }

  /** Runs `op` after every earlier one. */
  enqueue(op: () => Promise<void>): Promise<void> {
    const run = this.queue.then(op);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The connection of a user channel on every market. */
  openAllMarkets(): void {
    this.open().ws.start();
  }

  async add(ids: readonly ConditionId[]): Promise<void> {
    const wanted = ids.filter((id) => !this.owner.has(id));
    if (this.closed || wanted.length === 0) {
      return;
    }
    const entries = await this.entriesFor(wanted);
    if (this.closed) {
      return;
    }
    this.place(entries);
  }

  /**
   * Adds outcome tokens on their own (a market channel only): each one is an entry of one id,
   * with no lookup, and gets its book snapshot with the initial dumps.
   */
  addAssets(tokenIds: readonly TokenId[]): void {
    const wanted = tokenIds.filter((id) => !this.owner.has(id));
    if (this.closed || wanted.length === 0) {
      return;
    }
    this.place(wanted.map((id) => ({ conditionId: id, ids: [id] })));
  }

  /** Puts entries on connections with room, opening new ones when all are full. */
  private place(entries: readonly Entry[]): void {
    const added = new Map<Connection, Entry[]>();
    const opened: Connection[] = [];
    for (const entry of entries) {
      const weight = entry.ids.length;
      let conn = this.connections.find(
        (c) => c.weight + weight <= MAX_IDS_PER_CONNECTION,
      );
      if (conn === undefined) {
        conn = this.open();
        opened.push(conn);
      } else if (!opened.includes(conn)) {
        added.set(conn, [...(added.get(conn) ?? []), entry]);
      }
      conn.entries.set(entry.conditionId, entry);
      conn.weight += weight;
      this.owner.set(entry.conditionId, conn);
    }
    for (const [conn, list] of added) {
      this.sendChange(conn, 'subscribe', list);
    }
    for (const conn of opened) {
      conn.ws.start();
    }
  }

  async remove(ids: readonly ConditionId[]): Promise<void> {
    if (this.closed) {
      return;
    }
    const removed = new Map<Connection, Entry[]>();
    for (const id of ids) {
      const conn = this.owner.get(id);
      const entry = conn?.entries.get(id);
      if (conn === undefined || entry === undefined) {
        continue;
      }
      conn.entries.delete(id);
      conn.weight -= entry.ids.length;
      this.owner.delete(id);
      removed.set(conn, [...(removed.get(conn) ?? []), entry]);
    }
    for (const [conn, list] of removed) {
      if (conn.entries.size === 0) {
        // Never leave a connection with no market: on /ws/user that would mean every market.
        this.retire(conn);
      } else {
        this.sendChange(conn, 'unsubscribe', list);
      }
    }
  }

  /** `close()` of the subscription: closes every connection, and waits for them. */
  private async closeAll(): Promise<void> {
    this.closed = true;
    const closing = this.connections.splice(0).map((conn) => {
      conn.closed = true;
      this.clearReconnect(conn);
      return conn.ws.close();
    });
    await Promise.all([...closing, ...this.retiring]);
  }

  private retire(conn: Connection): void {
    conn.closed = true;
    this.clearReconnect(conn);
    const index = this.connections.indexOf(conn);
    if (index >= 0) {
      this.connections.splice(index, 1);
    }
    const closing = conn.ws.close();
    this.retiring.add(closing);
    void closing.finally(() => this.retiring.delete(closing));
  }

  /**
   * Stops a connection for good, for a cause that retrying cannot fix: reports it once, closes
   * it, and gives up its markets, which are no longer subscribed. Nothing reconnects it. A user
   * channel on every market has no market list to subscribe again, so nothing could ever
   * revive it: its subscription closes too, as the backend's channels do.
   */
  private stop(conn: Connection, why: string, cause?: unknown): void {
    const markets = conn.entries.size;
    const lost =
      markets > 0
        ? `, and its ${markets} market(s) are no longer subscribed`
        : '';
    const ends = this.config.allMarkets;
    this.sub.pushError(
      new XoError(
        ends
          ? `${why} The stream is closed and not retried: subscribe again once the cause is fixed`
          : `${why} This connection is closed and not retried${lost}: subscribe its markets again once the cause is fixed`,
        {
          code: 'ws_auth_unrecoverable',
          service: 'orderbook',
          ...(cause === undefined ? {} : { cause: scrubbedCause(cause) }),
        },
      ),
    );
    for (const id of conn.entries.keys()) {
      this.owner.delete(id);
    }
    conn.entries.clear();
    conn.weight = 0;
    this.retire(conn);
    if (ends) {
      void this.sub.close();
    }
  }

  /** Market entries carry the tokens when initial dumps are on; everything else, the id. */
  private async entriesFor(ids: readonly ConditionId[]): Promise<Entry[]> {
    if (this.config.kind === 'user' || !this.config.initialDump) {
      return ids.map((conditionId) => ({ conditionId, ids: [conditionId] }));
    }
    const failed: Array<{ id: ConditionId; error: unknown }> = [];
    const entries = await mapLimit(ids, LOOKUP_CONCURRENCY, async (id) => {
      try {
        return { conditionId: id, ids: await this.shared.tokensOf(id) };
      } catch (error) {
        failed.push({ id, error });
        return { conditionId: id, ids: [id] };
      }
    });
    const first = failed[0];
    if (first !== undefined && !this.closed) {
      const more = failed.length > 1 ? ` and ${failed.length - 1} more` : '';
      this.sub.pushError(
        new XoError(
          `Could not look up the outcome tokens of market ${first.id}${more}, so it is subscribed by condition id: its events arrive, but no initial book snapshot does. Read its order books over REST for a snapshot`,
          {
            code: 'ws_tokens_unresolved',
            service: 'orderbook',
            cause: first.error,
          },
        ),
      );
    }
    return entries;
  }

  private open(): Connection {
    const { env, impl, connection } = this.shared;
    const conn: Connection = new Connection(
      new ReconnectingWs({
        ...connection,
        url:
          this.config.kind === 'market'
            ? env.orderbookMarketWsUrl
            : env.orderbookUserWsUrl,
        WebSocketImpl: impl,
        onOpen: () => this.handleOpen(conn),
        onReconnected: () => this.handleReconnected(conn),
        onMessage: (data) => this.handleMessage(conn, data),
        onClose: () => this.handleClose(conn),
        onError: (error) => this.sub.pushError(error),
      }),
    );
    this.connections.push(conn);
    return conn;
  }

  private handleOpen(conn: Connection): void {
    this.resetSocketState(conn);
    if (conn.closed) {
      return;
    }
    if (this.config.kind === 'market') {
      this.sendSubscribe(
        conn,
        JSON.stringify({
          type: 'market',
          assets_ids: [...conn.entries.values()].flatMap((entry) => entry.ids),
          initial_dump: this.config.initialDump,
          custom_feature_enabled: this.config.customFeatures,
        }),
        true,
      );
    } else {
      this.authenticate(conn, conn.generation).catch(() =>
        // Not expected (authenticate handles its failures); never an unhandled rejection,
        // and no cause: nothing near the credentials goes into an error.
        this.sub.pushError(
          new XoError('The user channel subscribe failed unexpectedly', {
            code: 'ws_auth_failed',
            service: 'sdk',
          }),
        ),
      );
    }
  }

  /**
   * Fetches the credentials (every connect: they may have been rotated) and sends the user
   * subscribe frame, unless the socket it was meant for is gone by then. The frame holds the
   * raw secret: it is never logged, and never part of an error.
   */
  private async authenticate(
    conn: Connection,
    generation: number,
  ): Promise<void> {
    const session = this.shared.session as Session;
    let credential: OrderbookCredential;
    try {
      credential = await session.ensureOrderbook();
    } catch (error) {
      if (this.isStale(conn, generation)) {
        return;
      }
      if (isTransient(error)) {
        this.sub.pushError(
          new XoError(
            'Could not get the orderbook credentials for the user channel, so this connection is not subscribed yet. The connection is retried with the backoff',
            {
              code: 'ws_auth_failed',
              service: 'orderbook',
              cause: scrubbedCause(error),
            },
          ),
        );
        conn.ws.reconnect('ws_auth_failed');
      } else {
        const { name, code } = scrubbedCause(error);
        this.stop(
          conn,
          `Could not get the orderbook credentials for the user channel (${name}${code === undefined ? '' : ` ${code}`}), and retrying cannot help.`,
          error,
        );
      }
      return;
    }
    if (this.isStale(conn, generation)) {
      return;
    }
    const { apiKey, secret, passphrase } = credential;
    const values = [secret, passphrase, apiKey].filter(
      (value) => typeof value === 'string' && value.length >= MIN_SCRUB_CHARS,
    );
    this.secrets = [...new Set([...values, ...this.secrets])].slice(
      0,
      MAX_SCRUBBED_VALUES,
    );
    conn.sentApiKey = apiKey;
    this.sendSubscribe(
      conn,
      JSON.stringify({
        type: 'user',
        auth: { apiKey, secret, passphrase },
        markets: [...conn.entries.keys()],
      }),
      true,
    );
  }

  /**
   * The gateway refused the user channel's credentials. The session gets the chance to
   * refresh them (`onUnauthorized`, as after a REST 401): if it does, the connection restarts
   * and the next connect sends the new ones. If it cannot (credentials passed in by the
   * caller, no signer, or a refresh within the last minute), sending the same credentials
   * again would be refused again, so the connection is stopped.
   */
  private async credentialsRefused(
    conn: Connection,
    message: string,
  ): Promise<void> {
    const generation = conn.generation;
    const apiKey = conn.sentApiKey;
    const session = this.shared.session as Session;
    let refreshed = false;
    let failure: unknown;
    try {
      refreshed = await session.onUnauthorized('orderbook', {
        headers: apiKey === undefined ? {} : { XO_API_KEY: apiKey },
      });
    } catch (error) {
      failure = error;
    }
    if (this.isStale(conn, generation)) {
      return;
    }
    if (refreshed === true || (failure !== undefined && isTransient(failure))) {
      this.sub.pushError(
        new XoError(
          `The orderbook user channel refused its credentials: ${message}. ${refreshed === true ? 'The session refreshed them' : 'The session could not refresh them yet'}, and the connection is restarted with the backoff`,
          { code: 'ws_subscribe_refused', service: 'orderbook' },
        ),
      );
      conn.ws.reconnect('ws_subscribe_refused');
      return;
    }
    this.stop(
      conn,
      `The orderbook user channel refused its credentials (${message}), and the session cannot refresh them (credentials passed in by the caller, no signer, or a refresh within the last minute).`,
      failure,
    );
  }

  /**
   * The primary connection is the first one: account-wide events are surfaced from it alone,
   * so a split channel does not repeat them. When it is retired (its markets unsubscribed),
   * the next one is promoted. While it is down they pause, and resume once it reconnects:
   * the others are not promoted on a drop.
   */
  private isPrimary(conn: Connection): boolean {
    return this.connections[0] === conn;
  }

  private isStale(conn: Connection, generation: number): boolean {
    return this.closed || conn.closed || conn.generation !== generation;
  }

  /**
   * A reconnect is announced once the gateway confirms the resubscription (its
   * `{type: "subscribed"}` answer to the full subscribe frame), or 5 s after that frame went
   * out without an answer. A resync started from the listener then cannot miss what arrives
   * before the subscription is back. A refused resubscription is not announced: the socket
   * restarts, and its own reconnect is.
   */
  private handleReconnected(conn: Connection): void {
    conn.reconnectPending = true;
    this.armReconnect(conn);
  }

  /** Starts the 5 s fallback once the full subscribe frame of a reconnect is out. */
  private armReconnect(conn: Connection): void {
    if (
      !conn.reconnectPending ||
      !conn.awaitingInitial ||
      conn.reconnectTimer !== undefined
    ) {
      return;
    }
    const generation = conn.generation;
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = undefined;
      if (!this.isStale(conn, generation)) {
        this.flushReconnected(conn);
      }
    }, RECONNECT_ANSWER_TIMEOUT_MS);
  }

  private flushReconnected(conn: Connection): void {
    if (!conn.reconnectPending) {
      return;
    }
    conn.reconnectPending = false;
    this.clearReconnect(conn);
    if (!this.closed && !conn.closed) {
      this.sub.pushReconnected();
    }
  }

  private clearReconnect(conn: Connection): void {
    if (conn.reconnectTimer !== undefined) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = undefined;
    }
  }

  /** Forgets everything about the previous socket: a new one opened, or the old one closed. */
  private resetSocketState(conn: Connection): void {
    conn.generation += 1;
    conn.ready = false;
    conn.pendingAnswers = 0;
    conn.awaitingInitial = false;
    conn.sawSnapshot = false;
    conn.reconnectPending = false;
    conn.sentApiKey = undefined;
    this.clearReconnect(conn);
  }

  private handleClose(conn: Connection): void {
    this.resetSocketState(conn);
  }

  private handleMessage(conn: Connection, data: string): void {
    const result = this.config.parse(data, this.shared.strict);
    switch (result.kind) {
      case 'ignored':
        return;
      case 'subscribed':
        conn.pendingAnswers = Math.max(0, conn.pendingAnswers - 1);
        if (conn.awaitingInitial) {
          conn.awaitingInitial = false;
          this.flushReconnected(conn);
        }
        return;
      case 'server_error':
        // Acted on even when it echoes the credentials: the message is scrubbed.
        this.refused(conn, result.message);
        return;
    }
    // The raw text, and the decoded JSON (a `\u` escape could hide a value from the first).
    const decoded = JSON.stringify(result.frame) ?? '';
    if (
      this.secrets.some(
        (secret) => data.includes(secret) || decoded.includes(secret),
      )
    ) {
      // Something echoed our credentials back: never let them into an event or an error.
      this.frameError(
        new UnexpectedResponseError(
          `The orderbook ${this.config.kind} channel sent a frame that contains this channel's credentials. It was dropped unread`,
          { code: 'ws_frame_invalid', service: 'orderbook', issues: [] },
        ),
      );
      return;
    }
    switch (result.kind) {
      case 'invalid':
        this.frameError(result.error);
        return;
      case 'event': {
        // An event of no market (trading_state_changed, orders_rebalanced, an unknown
        // frame without `market`) reaches every connection; only the primary one surfaces it.
        if (marketOf(result.event) !== undefined || this.isPrimary(conn)) {
          this.sub.push(result.event);
        }
        // A lag on ANY connection lost that connection's events: always reported.
        const event = result.event as { type: string; source?: unknown };
        const snapshot =
          event.type === 'trading_state_changed' && event.source === 'snapshot';
        // The first snapshot of a socket is its connect snapshot; any later one, a lag.
        const lag = snapshot && conn.sawSnapshot;
        if (snapshot) {
          conn.sawSnapshot = true;
        }
        if (lag) {
          this.sub.pushError(
            new XoError(
              `The orderbook ${this.config.kind} channel fell behind and dropped events (it sent a trading-state snapshot after a broadcast lag). State built from the stream may be wrong: read it again over REST (the open orders, the order books)`,
              { code: 'ws_events_dropped', service: 'orderbook' },
            ),
          );
        }
        return;
      }
    }
  }

  /**
   * The gateway refused a frame and kept the socket open: a subscription it does not hold,
   * or a change it dropped. The socket is restarted, so the next one is sent the whole
   * subscription (with fresh credentials on /ws/user), with the backoff if it keeps happening.
   */
  private refused(conn: Connection, message: string): void {
    conn.awaitingInitial = false;
    const answering = conn.pendingAnswers > 0;
    conn.pendingAnswers = Math.max(0, conn.pendingAnswers - 1);
    if (this.config.kind === 'user' && CREDENTIAL_REFUSAL.test(message)) {
      const safe = JSON.stringify(this.scrub(message));
      this.credentialsRefused(conn, safe).catch(() =>
        // Not expected; never an unhandled rejection. Restart, as for any refusal.
        conn.ws.reconnect('ws_subscribe_refused'),
      );
      return;
    }
    const code = answering ? 'ws_subscribe_refused' : 'ws_server_error';
    const what = answering ? 'refused a subscription' : 'refused a frame';
    this.sub.pushError(
      new XoError(
        `The orderbook ${this.config.kind} channel ${what}: ${JSON.stringify(this.scrub(message))}. The connection is restarted to send the whole subscription again`,
        { code, service: 'orderbook' },
      ),
    );
    conn.ws.reconnect(code);
  }

  /** A gateway message, without our credentials or an API key, and cut to 200 characters. */
  private scrub(message: string): string {
    let safe = message;
    for (const secret of this.secrets) {
      safe = safe.split(secret).join('[redacted]');
    }
    return String(redact(safe)).slice(0, MAX_SERVER_MESSAGE_CHARS);
  }

  /** Reports a dropped frame, at most once a second per code. */
  private frameError(error: XoError): void {
    const now = performance.now();
    const last = this.errorAt.get(error.code);
    if (last !== undefined && now - last < FRAME_ERROR_INTERVAL_MS) {
      return;
    }
    this.errorAt.set(error.code, now);
    this.sub.pushError(error);
  }

  /** Sends a subscribe frame; `initial` for the full one a socket gets when it opens. */
  private sendSubscribe(
    conn: Connection,
    text: string,
    initial = false,
  ): boolean {
    if (!this.send(conn, text)) {
      return false;
    }
    conn.ready = true;
    conn.pendingAnswers += 1;
    if (initial) {
      conn.awaitingInitial = true;
      this.armReconnect(conn);
    }
    return true;
  }

  /** A change on a connection that already got its subscribe frame; else the next one has it. */
  private sendChange(
    conn: Connection,
    operation: 'subscribe' | 'unsubscribe',
    entries: readonly Entry[],
  ): void {
    if (!conn.ready || conn.closed) {
      return;
    }
    let frame: Record<string, unknown>;
    if (this.config.kind === 'user') {
      frame = { operation, markets: entries.map((e) => e.conditionId) };
    } else if (operation === 'subscribe') {
      frame = {
        operation,
        assets_ids: entries.flatMap((e) => e.ids),
        initial_dump: this.config.initialDump,
      };
    } else {
      // Always the condition id: the gateway removes the raw id it is given.
      frame = { operation, assets_ids: entries.map((e) => e.conditionId) };
    }
    if (operation === 'subscribe') {
      this.sendSubscribe(conn, JSON.stringify(frame));
    } else {
      this.send(conn, JSON.stringify(frame));
    }
  }

  /** Sends on the current socket; false when it is going away (its reconnect resends all). */
  private send(conn: Connection, text: string): boolean {
    try {
      conn.ws.send(text);
      return true;
    } catch {
      return false;
    }
  }
}

/** Condition ids, validated, lower-cased and de-duplicated in order. */
function readIds(value: unknown, field: string): ConditionId[] {
  if (!Array.isArray(value)) {
    throw new UserInputError(`${field} must be an array of condition ids`);
  }
  const ids = Array.from(value as unknown[], (id, index) =>
    normalizeConditionId(id, `${field}[${index}]`),
  );
  return [...new Set(ids)];
}

const noop = (): void => {};

/** The market an event is about (`market`, or `data.market` of an unknown one), if any. */
function marketOf(event: { type: string }): string | undefined {
  const { market, data } = event as { market?: unknown; data?: unknown };
  const value =
    event.type === 'unknown' && typeof data === 'object' && data !== null
      ? (data as { market?: unknown }).market
      : market;
  return typeof value === 'string' ? value : undefined;
}

/**
 * The orderbook's live streams: the public market channel (`/ws/market`) and the trader's
 * user channel (`/ws/user`), as {@link Subscription}s, with the REST resync helpers.
 *
 * ```ts
 * const realtime = new OrderbookRealtime({ env, session, orderbook });
 * const book = realtime.marketChannel({ conditionIds: [conditionId] });
 * const mine = realtime.userChannel({ conditionIds: [conditionId] });
 * book.on('book', (event) => ...);
 * mine.on('order', (event) => ...);
 * mine.on('reconnected', async () => { openOrders = await realtime.resyncMyOrders(); });
 * ```
 *
 * ## Gaps: the stream does not replay what it missed
 *
 * **WARNING.** After a drop, the SDK reconnects and re-sends the same subscriptions, then
 * emits `'reconnected'` once the gateway confirms them (its `subscribed` answer, or 5 s after
 * the frame went out without one). Nothing that happened while the socket was down is replayed, and the
 * gateway has no sequence numbers. Treat `'reconnected'` as "my state is stale" and resync from
 * REST:
 * - {@link OrderbookRealtime.resyncMyOrders}: the trader's open orders (`getOpenOrders`);
 * - {@link OrderbookRealtime.resyncBooks}: books by token id (`getBooks`). With
 *   `initialDump` (the default) the market channel also gets a fresh `book` per token after
 *   every reconnect.
 *
 * Resync on these `'error'` codes as well, which also mean events were lost:
 * `'ws_events_dropped'` (the gateway fell behind), `'subscription_overflow'` (your consumer
 * fell behind), `'ws_subscribe_refused'` and `'ws_server_error'` (the gateway refused a frame;
 * the connection restarts and emits `'reconnected'`).
 *
 * A `for await` loop over a subscription **never sees** `'reconnected'` or `'error'`: listen
 * with `on('reconnected', ...)` and `on('error', ...)` too (see {@link Subscription}).
 *
 * ## Connections
 *
 * The gateway holds at most 100 ids per connection, counting every id of a subscribe frame. A
 * channel with more is split over several connections, all merged into one subscription;
 * `subscribe` fills the first connection with room and opens a new one when all are full, and
 * `unsubscribe` goes to the connection that holds the market. A connection whose last market
 * is unsubscribed is closed. With initial dumps every market costs its tokens (two for a
 * binary market, so 50 markets per connection); without, one.
 *
 * **WebSocket slots.** Each user-channel connection takes one of the account's WebSocket
 * slots (the gateway's per-account limit; a 1008 `max_ws_connections_exceeded` when none
 * is left), and a user channel holds 100 markets per connection, so splitting beyond 100
 * markets costs one more slot per 100. To follow many markets, omit `conditionIds` (every
 * market, one connection, one slot), but note that such an unscoped user channel never
 * receives `orders_rebalanced`: the gateway sends it only to a connection scoped to markets.
 * Market-channel connections are anonymous and take no slot, whether they
 * hold 50 markets (initial dumps) or 100.
 *
 * **Account-wide events come from one connection.** Events of no particular market
 * (`trading_state_changed`, `orders_rebalanced`, and an unknown frame without `market`) reach
 * every connection of a split channel; the SDK surfaces them from the **primary** connection
 * only (the first one), so they are not repeated. Market events come from the connection that
 * holds the market. When the primary connection is closed because its markets were
 * unsubscribed, the next one becomes primary (its earlier frames are not replayed). While the
 * primary connection is down, account-wide events pause until it reconnects. That can last
 * indefinitely: a user channel whose primary connection keeps being refused with 1008
 * (another connection took the last slot first) delivers none until a slot frees up. Each reconnect
 * of any connection emits its own `'reconnected'`, and a lag on any connection its own
 * `'ws_events_dropped'`.
 *
 * ## Errors
 *
 * The stream survives every `'error'` (an `XoError`); by `code`:
 * - `'ws_frame_invalid'`: a frame failed its schema and was dropped (at most one a second);
 * - `'ws_unknown_event'`: with `strictResponses`, an event the SDK does not know (without
 *   it, such frames are `{ type: 'unknown' }` events);
 * - `'ws_tokens_unresolved'`: a market's tokens could not be looked up, so it is subscribed
 *   by condition id (events, but no initial book snapshot);
 * - `'ws_auth_failed'`: the session could not provide the user channel's credentials for a
 *   reason that may pass (the network, a timeout, a 429, a 5xx). The connection retries with
 *   the backoff;
 * - `'ws_auth_unrecoverable'`: the user channel's credentials can never work as things are:
 *   the session could not provide them for any other reason (no signer or credentials, a
 *   closed session, a refused wallet signature, an undeployed smart wallet, an invalid
 *   option), or the gateway refused them and the session could not refresh them (credentials
 *   passed in by the caller, no signer, or a refresh within the last minute). Reported **once
 *   and not retried**: that connection is closed and its markets are no longer subscribed
 *   (subscribe them again once the cause is fixed). A user channel on every market closes its
 *   subscription too (`'closed'` follows);
 * - `'ws_subscribe_refused'`, `'ws_server_error'`, `'ws_events_dropped'`: see above. A refusal
 *   of the user channel's credentials first asks the session to refresh them
 *   (`onUnauthorized`), and restarts the connection only when it did;
 * - the transport's own: `'max_ws_connections_exceeded'`, `'ws_stale'`, `'transport_error'`,
 *   `'ws_connect_timeout'` (see `ReconnectingWs`).
 *
 * No event and no error ever holds the user channel's credentials, and the subscribe frame
 * that carries them is never logged.
 *
 * ## For the clients
 *
 * A client's realtime hub builds one `OrderbookRealtime` with its `env`, `session`, `orderbook`
 * client, `WebSocketImpl` and `strictResponses`, and opens the `market` and `user` topics on it.
 *
 * Internal: an engine behind the two clients. No entry of the package exports it.
 */
export class OrderbookRealtime {
  private readonly shared: Shared;
  private readonly orderbook: OrderbookClient;
  private readonly tokens = new Map<ConditionId, readonly string[]>();
  private readonly lookups = new Map<ConditionId, Promise<readonly string[]>>();
  private readonly channels = new WeakMap<
    object,
    Channel<MarketChannelEvent> | Channel<UserChannelEvent>
  >();

  /**
   * Checks every option, including the connection tuning and the WebSocket implementation,
   * and opens nothing.
   *
   * @throws {UserInputError} for an invalid or unknown option, or when there is no WebSocket
   * implementation (see {@link OrderbookRealtimeOptions.WebSocketImpl}).
   */
  constructor(o: OrderbookRealtimeOptions) {
    const options = closedObject(o, 'options', [
      'env',
      'orderbook',
      'session',
      'WebSocketImpl',
      'strictResponses',
      'connection',
    ]) as Partial<OrderbookRealtimeOptions>;
    const { env, orderbook, session } = options;
    if (
      typeof env !== 'object' ||
      env === null ||
      typeof env.orderbookMarketWsUrl !== 'string' ||
      typeof env.orderbookUserWsUrl !== 'string'
    ) {
      throw new UserInputError(
        'env must be an environment config with orderbookMarketWsUrl and orderbookUserWsUrl',
      );
    }
    if (!hasMethods(orderbook, ['getMarket', 'getOpenOrders', 'getBooks'])) {
      throw new UserInputError('orderbook must be an OrderbookClient');
    }
    if (
      session !== undefined &&
      !hasMethods(session, ['ensureOrderbook', 'onUnauthorized'])
    ) {
      throw new UserInputError('session must be a Session');
    }
    const strict = readFlag(options.strictResponses, 'strictResponses', false);
    const connection = closedObject(
      options.connection ?? {},
      'connection',
      CONNECTION_KEYS,
    ) as OrderbookConnectionOptions;
    const impl =
      options.WebSocketImpl ??
      (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    // ReconnectingWs checks the URL, the implementation and the tuning, and its constructor
    // opens nothing: check them now rather than on the first connect.
    for (const url of [env.orderbookMarketWsUrl, env.orderbookUserWsUrl]) {
      new ReconnectingWs({
        ...connection,
        url,
        WebSocketImpl: impl,
        onOpen: noop,
        onMessage: noop,
      });
    }
    this.orderbook = orderbook as OrderbookClient;
    this.shared = {
      env,
      impl: impl as typeof WebSocket,
      connection,
      strict,
      session,
      tokensOf: (id) => this.tokensOf(id),
    };
  }

  /**
   * Streams the public market channel (`/ws/market`) of `conditionIds`: `book`,
   * `price_change` and `last_trade_price`, plus `best_bid_ask`, `new_market` and
   * `market_resolved` with `customFeatures`, and `trading_state_changed`. See the class docs
   * for gaps and resync.
   *
   * With `initialDump` (the default) each market's token ids are looked up once
   * (`GET /markets/{condition_id}`, cached), because the gateway only sends a book snapshot
   * for a token id; a lookup that fails is reported (`'ws_tokens_unresolved'`) and that market
   * is subscribed by condition id instead.
   *
   * @throws {UserInputError} at once, for a bad condition id or option.
   */
  marketChannel(
    options: MarketChannelOptions,
  ): Subscription<MarketChannelEvent> {
    const o = closedObject(options, 'options', [
      'conditionIds',
      'customFeatures',
      'initialDump',
    ]);
    const ids = readIds(o.conditionIds, 'conditionIds');
    const channel = new Channel<MarketChannelEvent>(this.shared, {
      kind: 'market',
      allMarkets: false,
      initialDump: readFlag(o.initialDump, 'initialDump', true),
      customFeatures: readFlag(o.customFeatures, 'customFeatures', false),
      parse: parseMarketFrame,
    });
    this.channels.set(channel.sub, channel);
    this.start(channel, ids);
    return channel.sub;
  }

  /**
   * The market channel of markets and of outcome tokens, with the initial dumps and without the
   * custom features: what a client's `subscribe` opens for the `market` topic. A token is sent
   * as it is, with no lookup; a market is looked up for its tokens, as in `marketChannel`. The
   * ids are checked and normalized by the caller. The subscription has no market list to change.
   *
   * @internal
   */
  marketChannelOf(o: {
    conditionIds: readonly ConditionId[];
    assetIds: readonly TokenId[];
  }): Subscription<MarketChannelEvent> {
    const channel = new Channel<MarketChannelEvent>(this.shared, {
      kind: 'market',
      allMarkets: false,
      initialDump: true,
      customFeatures: false,
      parse: parseMarketFrame,
    });
    // The tokens first: they need no lookup, so they connect at once.
    if (o.assetIds.length > 0) {
      channel
        .enqueue(async () => channel.addAssets(o.assetIds))
        .catch((cause: unknown) =>
          // Not expected. Reported like a failed subscribe of markets, never swallowed.
          channel.sub.pushError(
            new XoError('Could not subscribe the outcome tokens', {
              code: 'ws_subscribe_failed',
              service: 'sdk',
              cause,
            }),
          ),
        );
    }
    this.start(channel, o.conditionIds);
    return channel.sub;
  }

  /**
   * Streams the trader's user channel (`/ws/user`): `order` (placement, fills, cancellation,
   * rejection), `trade` (the match, then its settlement statuses), `orders_rebalanced` and
   * `trading_state_changed`. Omit `conditionIds` for every market.
   *
   * Each connect and reconnect asks the session for the L2 credentials
   * (`session.ensureOrderbook()`) and sends them in the subscribe frame, which holds the raw
   * secret.
   * - When the session cannot provide them for a reason that may pass (the network, a
   *   timeout, a 429, a 5xx), one `'ws_auth_failed'` error is emitted and the connection is
   *   retried with the backoff.
   * - For any other reason (no signer or credentials, a closed session, a refused wallet
   *   signature, an undeployed smart wallet), one `'ws_auth_unrecoverable'` error is
   *   emitted and the connection is closed and **not retried**: subscribe its markets again
   *   once the cause is fixed. A channel on every market closes its subscription too.
   * - When the gateway refuses the credentials, the session is asked to refresh them
   *   (`session.onUnauthorized('orderbook', ...)`). If it did, `'ws_subscribe_refused'` and
   *   the connection restarts with the new ones; if it cannot (credentials passed in by the
   *   caller, no signer, or a refresh within the last minute), `'ws_auth_unrecoverable'` and
   *   the connection stops, as above.
   *
   * `'reconnected'` is emitted once the gateway confirms the resubscription.
   *
   * Each connection takes one of the account's WebSocket slots (the gateway caps them per
   * account), and a connection holds 100 markets: more markets cost more slots (see the class docs).
   *
   * @throws {UserInputError} at once, for a bad condition id or option.
   * @throws {UserInputError} code `'browser_secret_refused'` where `globalThis.window` exists,
   *   unless `allowBrowserSecrets: true`.
   * @throws {AuthRequiredError} when this OrderbookRealtime has no session.
   */
  userChannel(
    options: UserChannelOptions = {},
  ): Subscription<UserChannelEvent> {
    const o = closedObject(options, 'options', [
      'conditionIds',
      'allowBrowserSecrets',
    ]);
    const allow = readFlag(o.allowBrowserSecrets, 'allowBrowserSecrets', false);
    const ids =
      o.conditionIds === undefined
        ? undefined
        : readIds(o.conditionIds, 'conditionIds');
    if (!allow && (globalThis as { window?: unknown }).window !== undefined) {
      throw new UserInputError(
        'The user channel sends the orderbook API secret over the WebSocket, and this looks like a browser (globalThis.window exists). Pass allowBrowserSecrets: true only if the page is trusted with the secret',
        { code: 'browser_secret_refused' },
      );
    }
    if (this.shared.session === undefined) {
      throw new AuthRequiredError(
        'The user channel needs the L2 credentials of a session: pass the `session` option to OrderbookRealtime',
      );
    }
    const channel = new Channel<UserChannelEvent>(this.shared, {
      kind: 'user',
      allMarkets: ids === undefined,
      initialDump: false,
      customFeatures: false,
      parse: parseUserFrame,
    });
    this.channels.set(channel.sub, channel);
    if (ids === undefined) {
      channel.openAllMarkets();
    } else {
      this.start(channel, ids);
    }
    return channel.sub;
  }

  /**
   * Adds markets to a subscription of this OrderbookRealtime, by condition id: they go to a
   * connection with room (a new one when all are full). Resolves once the change is sent, or
   * queued for the connection's next subscribe frame. Markets already subscribed are skipped.
   * After `close()` it does nothing.
   *
   * @throws {UserInputError} for a subscription that is not from this OrderbookRealtime, a
   *   bad condition id, or a user channel on every market (it has no list to change).
   */
  async subscribe(
    sub: Subscription<MarketChannelEvent> | Subscription<UserChannelEvent>,
    conditionIds: readonly (ConditionId | string)[],
  ): Promise<void> {
    const channel = this.channelOf(sub);
    const ids = readIds(conditionIds, 'conditionIds');
    await channel.enqueue(() => channel.add(ids));
  }

  /**
   * Removes markets from a subscription, by condition id, on the connection that holds each
   * one (the frame names the condition id, whatever the subscribe sent). A connection left
   * with no market is closed. Ids that are not subscribed are ignored.
   *
   * @throws {UserInputError} as for {@link OrderbookRealtime.subscribe}.
   */
  async unsubscribe(
    sub: Subscription<MarketChannelEvent> | Subscription<UserChannelEvent>,
    conditionIds: readonly (ConditionId | string)[],
  ): Promise<void> {
    const channel = this.channelOf(sub);
    const ids = readIds(conditionIds, 'conditionIds');
    await channel.enqueue(() => channel.remove(ids));
  }

  /**
   * **The gap remedy for orders.** The trader's open orders now, every page
   * (`getOpenOrders(options).toArray()`, L2). Call it on `'reconnected'` (and on the error
   * codes listed in the class docs) and replace the order state built from the stream.
   */
  async resyncMyOrders(options?: OpenOrdersOptions): Promise<OpenOrder[]> {
    return this.orderbook.getOpenOrders(options).toArray();
  }

  /**
   * **The gap remedy for books.** The books of `tokenIds` now (`getBooks`). Call it on
   * `'reconnected'` (and on the error codes listed in the class docs), unless the market
   * channel's initial dumps already sent fresh `book` events.
   */
  async resyncBooks(
    tokenIds: readonly (TokenId | string)[],
  ): Promise<OrderBook[]> {
    return this.orderbook.getBooks(tokenIds);
  }

  private start(
    channel: Channel<MarketChannelEvent> | Channel<UserChannelEvent>,
    ids: readonly ConditionId[],
  ): void {
    if (ids.length === 0) {
      return;
    }
    channel
      .enqueue(() => channel.add(ids))
      .catch((cause: unknown) =>
        // Not expected: add() reports its own failures. Never an unhandled rejection.
        channel.sub.pushError(
          new XoError('Could not subscribe the initial markets', {
            code: 'ws_subscribe_failed',
            service: 'sdk',
            cause,
          }),
        ),
      );
  }

  private channelOf(
    sub: unknown,
  ): Channel<MarketChannelEvent> | Channel<UserChannelEvent> {
    const channel =
      typeof sub === 'object' && sub !== null
        ? this.channels.get(sub)
        : undefined;
    if (channel === undefined) {
      throw new UserInputError(
        'sub must be a subscription returned by marketChannel or userChannel of this OrderbookRealtime',
      );
    }
    if (channel.config.allMarkets) {
      throw new UserInputError(
        'This user channel covers every market, so it has no market list to change. Open one with conditionIds to subscribe and unsubscribe',
      );
    }
    return channel;
  }

  /** A market's token ids, looked up once (`getMarket`) and cached; one lookup in flight. */
  private tokensOf(id: ConditionId): Promise<readonly string[]> {
    const cached = this.tokens.get(id);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }
    const inflight = this.lookups.get(id);
    if (inflight !== undefined) {
      return inflight;
    }
    const lookup = this.orderbook
      .getMarket(id)
      .then((market) => {
        const tokens = market.tokens.map((token, index) =>
          normalizeTokenId(token.token_id, `tokens[${index}].token_id`),
        );
        if (tokens.length === 0 || tokens.length > MAX_IDS_PER_CONNECTION) {
          throw new XoError(
            `The orderbook lists ${tokens.length} tokens for market ${id}`,
            { code: 'unexpected_response', service: 'orderbook' },
          );
        }
        if (this.tokens.size >= TOKEN_CACHE_LIMIT) {
          const oldest = this.tokens.keys().next().value;
          if (oldest !== undefined) {
            this.tokens.delete(oldest);
          }
        }
        this.tokens.set(id, tokens);
        return tokens;
      })
      .finally(() => this.lookups.delete(id));
    this.lookups.set(id, lookup);
    return lookup;
  }
}
