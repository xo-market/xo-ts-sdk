import type { Session } from '../auth/session';
import type { EnvironmentConfig } from '../core/env';
import {
  UnexpectedResponseError,
  UserInputError,
  type XoError,
} from '../core/errors';
import type {
  ReconnectedInfo,
  SubscriptionHandle,
  SubscriptionTopic,
} from '../models/realtime';
import type { OrderbookClient } from '../orderbook/client';
import {
  type OrderbookConnectionOptions,
  OrderbookRealtime,
} from './orderbookWs';
import {
  BackendRealtime,
  type BackendSocketConnectionOptions,
} from './socketio';
import { Subscription } from './subscription';

// One handle over several streams, and the live subscriptions of one client.
//
// A subscription to several topics reads from several engine subscriptions (the orderbook's
// market and user channels, the backend's portfolio and market activity channels). Each one is
// a source of the handle: its events are mapped to the public models and pushed, as they come,
// into one `Subscription` that holds the bounded buffer, the overflow signal and the iterator.
// Its 'reconnected' and 'error' are passed on; closing the handle closes every source.
// Internal: no public barrel exports this module.

/** One engine subscription a handle reads, and how its events become the handle's. */
export interface MergeSource<E> {
  /** The topic it streams: named on every signal of it the handle passes on. */
  readonly topic: SubscriptionTopic;
  /** The engine's subscription. The handle owns it: closing the handle closes it. */
  readonly sub: Subscription<{ type: string }>;
  /** The engine's event types the handle takes. Any other is left out. */
  readonly types: readonly string[];
  /**
   * The handle's event for one engine event, or `undefined` to leave it out. It may throw for
   * an event it cannot read: the event is dropped and reported as `ws_frame_invalid`.
   */
  readonly map: (event: never) => E | undefined;
  /** The service the source reads, named on the error of an event it cannot read. */
  readonly service: 'orderbook' | 'backend';
}

/**
 * A source over an engine subscription of events `R`: `types` are its event types the handle
 * takes, and `map` reads each one.
 */
export function sourceOf<R extends { type: string }, E>(
  topic: SubscriptionTopic,
  sub: Subscription<R>,
  service: MergeSource<E>['service'],
  types: readonly R['type'][],
  map: (event: R) => E | undefined,
): MergeSource<E> {
  return {
    topic,
    // The handle only listens and closes: the event type of the engine does not matter there.
    sub: sub as unknown as Subscription<{ type: string }>,
    service,
    types,
    map: map as (event: never) => E | undefined,
  };
}

/** The options of {@link mergeSubscriptions}. */
export interface MergeOptions {
  /** How many events each iterator buffers. Defaults to the subscription's 10,000. */
  bufferSize?: number;
}

/** The handle's lifecycle types, the only ones `on` takes. */
const LIFECYCLE = new Set(['reconnected', 'error', 'closed']);
/** An event a source could not map is reported at most once per this long. */
const MAP_ERROR_INTERVAL_MS = 1_000;

/** `error`, naming the topic it is about. The instance and its code are kept. */
function withTopic(error: XoError, topic: SubscriptionTopic): XoError {
  try {
    Object.defineProperty(error, 'topic', {
      value: topic,
      enumerable: true,
      configurable: true,
    });
  } catch {
    // A frozen error keeps what it has; the caller still sees its class and code.
  }
  return error;
}

/**
 * One handle over `sources`: their events in one stream, in arrival order. The first iterator
 * is made at once, so the first loop misses nothing that arrives before it starts. When every
 * source has closed by itself (each reported why), the handle closes too, so a loop ends rather
 * than wait forever.
 */
export function mergeSubscriptions<E extends { type: string }>(
  sources: readonly MergeSource<E>[],
  options: MergeOptions = {},
): SubscriptionHandle<E> {
  let closingSources = false;
  let open = sources.length;
  let ended = false;
  let mapErrorAt = Number.NEGATIVE_INFINITY;
  const out = new Subscription<E>({
    ...(options.bufferSize === undefined
      ? {}
      : { bufferSize: options.bufferSize }),
    closeTransport: async () => {
      closingSources = true;
      await Promise.allSettled(sources.map((source) => source.sub.close()));
    },
  });
  out.on('closed', () => {
    ended = true;
  });
  const unreadable = (source: MergeSource<E>, error: unknown): void => {
    const now = performance.now();
    if (now - mapErrorAt < MAP_ERROR_INTERVAL_MS) {
      return;
    }
    mapErrorAt = now;
    out.pushError(
      withTopic(
        new UnexpectedResponseError(
          `An event of the ${source.topic} topic could not be read and was dropped: ${error instanceof Error ? error.message : 'unreadable'}`,
          {
            code: 'ws_frame_invalid',
            service: source.service,
            issues:
              error instanceof UnexpectedResponseError ? error.issues : [],
          },
        ),
        source.topic,
      ),
    );
  };
  for (const source of sources) {
    const map = source.map as (event: unknown) => E | undefined;
    for (const type of source.types) {
      source.sub.on(type as never, (event: unknown) => {
        let mapped: E | undefined;
        try {
          mapped = map(event);
        } catch (error) {
          unreadable(source, error);
          return;
        }
        if (mapped !== undefined) {
          out.push(mapped);
        }
      });
    }
    const reconnected: ReconnectedInfo = Object.freeze({ topic: source.topic });
    source.sub.on('reconnected', () => out.pushReconnected(reconnected));
    source.sub.on('error', (error) =>
      out.pushError(withTopic(error, source.topic)),
    );
    source.sub.on('closed', () => {
      open -= 1;
      if (!closingSources && open === 0) {
        void out.close();
      }
    });
  }
  let first: AsyncIterableIterator<E> | undefined = out[Symbol.asyncIterator]();

  function on(
    type: 'reconnected',
    listener: (info: ReconnectedInfo) => void,
  ): () => void;
  function on(type: 'error', listener: (error: XoError) => void): () => void;
  function on(type: 'closed', listener: () => void): () => void;
  function on(type: string, listener: (payload: never) => void): () => void {
    if (!LIFECYCLE.has(type)) {
      throw new UserInputError(
        "on() takes 'reconnected', 'error' or 'closed': the events themselves come through the loop",
      );
    }
    if (typeof listener !== 'function') {
      throw new UserInputError('A listener must be a function');
    }
    if (ended) {
      // Over already: a 'closed' listener still hears of it, once; the others, never.
      if (type === 'closed') {
        queueMicrotask(() => {
          try {
            (listener as () => void)();
          } catch {
            // A listener cannot break anything.
          }
        });
      }
      return () => {};
    }
    return out.on(type as 'closed', listener as () => void);
  }

  return Object.freeze({
    [Symbol.asyncIterator](): AsyncIterator<E> {
      const iterator = first ?? out[Symbol.asyncIterator]();
      first = undefined;
      return iterator;
    },
    close: () => out.close(),
    on,
  });
}

/** The live subscriptions of one client, until each one has closed. */
export class HandleSet {
  private readonly open = new Set<SubscriptionHandle<unknown>>();

  /** Keeps `handle` until it closes. */
  add(handle: SubscriptionHandle<unknown>): void {
    this.open.add(handle);
    handle.on('closed', () => {
      this.open.delete(handle);
    });
  }

  /** Closes every handle, and resolves once they have closed. Never rejects. */
  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.open].map((handle) => handle.close()));
  }

  /** How many are open. */
  get size(): number {
    return this.open.size;
  }
}

/** What a client's live subscriptions are built from. */
export interface RealtimeHubOptions {
  env: EnvironmentConfig;
  /** The client's order book: the market channel reads each market's tokens with it. */
  orderbook: OrderbookClient;
  /** The signed-in client's session: the user and portfolio channels need it. */
  session?: Session;
  /** The WebSocket constructor of the order book's channels. Defaults to the global one. */
  WebSocket?: typeof WebSocket;
  /** Refuse unknown fields and events (for contract tests). */
  strict: boolean;
  /** The connection tuning of the order book's sockets (tests). */
  orderbookConnection?: OrderbookConnectionOptions;
  /** The connection tuning of the backend's sockets (tests). */
  backendConnection?: BackendSocketConnectionOptions;
  /** How many events each iterator of a handle buffers (tests). */
  bufferSize?: number;
}

/**
 * A client's live subscriptions: the engines of the sockets, made on first use (so a runtime
 * without a WebSocket can still use the rest of the client), and the open handles.
 */
export class RealtimeHub {
  readonly handles = new HandleSet();
  readonly session: Session | undefined;
  readonly bufferSize: number | undefined;
  private orderbookRealtime: OrderbookRealtime | undefined;
  private backendRealtime: BackendRealtime | undefined;

  constructor(private readonly options: RealtimeHubOptions) {
    this.session = options.session;
    this.bufferSize = options.bufferSize;
  }

  /**
   * The order book's channels.
   *
   * @throws {UserInputError} when there is no WebSocket implementation.
   */
  orderbook(): OrderbookRealtime {
    const o = this.options;
    if (
      o.WebSocket === undefined &&
      typeof (globalThis as { WebSocket?: unknown }).WebSocket !== 'function'
    ) {
      throw new UserInputError(
        'No WebSocket implementation: this runtime has no global WebSocket (Node >= 22, Bun and browsers do). Pass the WebSocket option to the client, for example the WebSocket class of the "ws" package',
      );
    }
    this.orderbookRealtime ??= new OrderbookRealtime({
      env: o.env,
      orderbook: o.orderbook,
      ...(o.session === undefined ? {} : { session: o.session }),
      ...(o.WebSocket === undefined ? {} : { WebSocketImpl: o.WebSocket }),
      strictResponses: o.strict,
      ...(o.orderbookConnection === undefined
        ? {}
        : { connection: o.orderbookConnection }),
    });
    return this.orderbookRealtime;
  }

  /** The backend's channels. */
  backend(): BackendRealtime {
    const o = this.options;
    this.backendRealtime ??= new BackendRealtime({
      env: o.env,
      ...(o.session === undefined ? {} : { session: o.session }),
      strictResponses: o.strict,
      ...(o.backendConnection === undefined
        ? {}
        : { connection: o.backendConnection }),
    });
    return this.backendRealtime;
  }
}
