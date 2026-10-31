import { UserInputError, XoError } from '../core/errors';

// The consumer side of every realtime stream. A `Subscription` is what the realtime engines
// hand to the bot: typed listeners (`on`), an async iterator, and `close()`.
//
// It knows nothing about sockets. A transport (`ReconnectingWs` for the orderbook, Socket.IO
// for the backend) feeds it through `push`, `pushReconnected` and `pushError`, and gives
// it a `closeTransport` hook for `close()`. See the class JSDoc for the wiring.

/** How many events one iterator buffers before it starts dropping the oldest. */
export const DEFAULT_SUBSCRIPTION_BUFFER = 10_000;
/** The largest `bufferSize` accepted: an iterator can hold this many events in memory. */
export const MAX_SUBSCRIPTION_BUFFER = 1_000_000;
/** A new iterator's buffer starts with room for this many events and grows as needed. */
const INITIAL_SLOTS = 16;

export interface SubscriptionOptions {
  /**
   * What `close()` does to the transport underneath. It is awaited, and `'closed'` is emitted
   * after it settles. For one socket: `() => ws.close()`. For several:
   * `() => Promise.all(sockets.map((s) => s.close())).then(() => {})`. It is called once, a
   * microtask after `close()`. It may call `close()` again (that returns the same promise) but
   * must not await it, which would wait on itself.
   */
  closeTransport?: () => void | Promise<void>;
  /**
   * How many events each iterator buffers (a whole number from 1 to 1_000_000). Defaults to
   * {@link DEFAULT_SUBSCRIPTION_BUFFER}. The buffer only fills while an iterator exists and is
   * not keeping up, and its memory grows with the events actually held, not with this number.
   */
  bufferSize?: number;
}

type Listener = (payload: unknown) => void;

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * One iterator's bounded queue of events: a ring buffer, so a push and a read are both O(1)
 * even when the buffer is full (an `Array.shift` per read would not be). The ring starts small
 * and doubles up to `capacity`, so an iterator that keeps up never pays for the full size.
 */
class Cursor<E> implements AsyncIterableIterator<E> {
  private slots: Array<E | undefined> = [];
  private head = 0;
  private size = 0;
  private waiting: Array<(result: IteratorResult<E, undefined>) => void> = [];
  private ended = false;
  /** True from the first dropped event until the consumer has emptied the buffer. */
  private overflowing = false;

  constructor(
    private readonly capacity: number,
    private readonly onOverflow: () => void,
    private readonly onReturn: (cursor: Cursor<E>) => void,
  ) {}

  push(event: E): void {
    if (this.ended) {
      return;
    }
    // A consumer that is already waiting gets the event directly; the buffer is empty then.
    const waiter = this.waiting.shift();
    if (waiter !== undefined) {
      waiter({ value: event, done: false });
      return;
    }
    if (this.size === this.capacity) {
      // Full: the oldest event goes. The consumer is behind, so the book it has built is no
      // longer exact. One error per episode tells it to resync, without a flood.
      this.slots[this.head] = undefined;
      this.head = (this.head + 1) % this.slots.length;
      this.size -= 1;
      if (!this.overflowing) {
        this.overflowing = true;
        this.onOverflow();
        // The error listener may have closed the subscription, which ends this cursor: the
        // event being pushed must not be buffered, or it would be read after the close.
        if (this.ended) {
          return;
        }
      }
    } else if (this.size === this.slots.length) {
      this.grow();
    }
    this.slots[(this.head + this.size) % this.slots.length] = event;
    this.size += 1;
  }

  /** Doubles the ring (from 16 slots), never beyond `capacity`, keeping the events in order. */
  private grow(): void {
    const length = Math.min(
      Math.max(INITIAL_SLOTS, this.slots.length * 2),
      this.capacity,
    );
    const next = new Array<E | undefined>(length);
    for (let i = 0; i < this.size; i += 1) {
      next[i] = this.slots[(this.head + i) % this.slots.length];
    }
    this.slots = next;
    this.head = 0;
  }

  next(): Promise<IteratorResult<E, undefined>> {
    if (this.size > 0) {
      const value = this.slots[this.head] as E;
      this.slots[this.head] = undefined;
      this.head = (this.head + 1) % this.slots.length;
      this.size -= 1;
      if (this.size === 0) {
        this.overflowing = false;
      }
      return Promise.resolve({ value, done: false });
    }
    if (this.ended) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /** Called by `for await` on `break`. Stops this iterator only. */
  return(): Promise<IteratorResult<E, undefined>> {
    this.end();
    this.onReturn(this);
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  /** Ends the iterator now. Events that were buffered but not read are discarded. */
  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.slots = [];
    this.head = 0;
    this.size = 0;
    for (const resolve of this.waiting.splice(0)) {
      resolve({ value: undefined, done: true });
    }
  }
}

/**
 * A live stream of events of type `E`: typed listeners, an async iterator, and `close()`.
 *
 * **WARNING: a `for await` loop sees events only, never gaps.** The iterator yields the stream's
 * events and nothing else. `'reconnected'` (the stream dropped and came back, and the events in
 * between are gone), `'error'` (including `'subscription_overflow'`, events were dropped because
 * the loop was too slow) and `'closed'` are delivered **only** through {@link Subscription.on}.
 * A consumer that keeps state built from the stream, such as an order book, and iterates without
 * also listening to `'reconnected'` and `'error'` will carry a wrong book across every
 * reconnect without knowing it. Listen to both, and resync from REST when either fires:
 *
 * ```ts
 * sub.on('reconnected', () => resync());
 * sub.on('error', (e) => { if (e.code === 'subscription_overflow') resync(); });
 * for await (const event of sub) { ... }
 * ```
 *
 * ```ts
 * const sub = realtime.book([conditionId]);
 * sub.on('book', (event) => ...);           // listeners
 * sub.on('reconnected', () => resync());    // the stream does not replay what was missed
 * sub.on('error', (error) => ...);          // XoError; the stream keeps going
 * for await (const event of sub) { ... }    // or iterate
 * await sub.close();
 * ```
 *
 * **Listeners.** `on(type, fn)` returns a function that removes the listener. `type` is an event
 * type of `E`, or one of the lifecycle types `'reconnected'`, `'error'` (payload: an `XoError`)
 * and `'closed'`. Those three names are reserved: an event type of the stream must not use
 * them. A listener that throws, or returns a promise that rejects, is ignored: it cannot
 * affect other listeners or the stream.
 *
 * **Iterating.** `for await (const event of sub)` yields the stream's events (never the
 * lifecycle types, which come through `on`). Each call to `sub[Symbol.asyncIterator]()` makes a
 * new iterator that sees every event pushed from then on, so events pushed before iteration
 * starts are not replayed. Each iterator buffers up to 10_000 events (`bufferSize`). When the
 * consumer falls behind, the **oldest** event is dropped and one `'error'` with code
 * `'subscription_overflow'` is emitted per overflow episode (an episode ends when the consumer
 * has caught up and emptied the buffer): treat it as "my local state may be wrong, resync".
 * Overflow is tracked **per iterator**: with two iterators, each one that falls behind raises
 * its own error, and a listener cannot tell which one it was. The loop ends after
 * `close()`; events still buffered at that moment are discarded. Breaking out of a loop stops
 * that iterator only: the subscription stays open (and keeps the process alive) until
 * `close()`.
 *
 * **Closing.** `close()` is idempotent. It ends every iterator, closes the transport, then
 * emits `'closed'`. Nothing is emitted after it.
 *
 * ### Wiring a transport
 *
 * `push`, `pushReconnected` and `pushError` are the producer side. They are internal: only
 * the code that owns the transport calls them. For a `ReconnectingWs`:
 *
 * ```ts
 * const sub = new Subscription<MarketChannelEvent>({ closeTransport: () => ws.close() });
 * const ws = new ReconnectingWs({
 *   url,
 *   // Runs on every connect AND reconnect: send the subscribe frames here, from current state.
 *   onOpen: (send) => send(subscribeFrame()),
 *   onMessage: (data) => { for (const event of parseFrame(data)) sub.push(event); },
 *   // Runs after onOpen on a reconnect, so the stream is resubscribed before the bot resyncs.
 *   onReconnected: () => sub.pushReconnected(),
 *   // 1008 (max_ws_connections_exceeded), socket errors, throwing callbacks.
 *   onError: (error) => sub.pushError(error),
 * });
 * ws.start();
 * return sub;
 * ```
 *
 * A subscription fed by several sockets (more than 100 ids are split across connections) gives
 * every socket the same `push` callbacks and a `closeTransport` that closes all of them.
 *
 * Internal: an engine behind the two clients. No entry of the package exports it.
 */
export class Subscription<E extends { type: string }>
  implements AsyncIterable<E>
{
  private readonly capacity: number;
  private readonly closeTransport: (() => void | Promise<void>) | undefined;
  private listeners = new Map<string, Array<{ fn: Listener }>>();
  private readonly cursors = new Set<Cursor<E>>();
  private closing: Promise<void> | undefined;
  private closed = false;

  /** @internal Producer side: the transport that owns the stream makes the subscription. */
  constructor(options: SubscriptionOptions = {}) {
    const bufferSize = options.bufferSize ?? DEFAULT_SUBSCRIPTION_BUFFER;
    if (
      typeof bufferSize !== 'number' ||
      !Number.isInteger(bufferSize) ||
      bufferSize < 1 ||
      bufferSize > MAX_SUBSCRIPTION_BUFFER
    ) {
      throw new UserInputError(
        `bufferSize must be a whole number of events from 1 to ${MAX_SUBSCRIPTION_BUFFER}`,
      );
    }
    this.capacity = bufferSize;
    this.closeTransport = options.closeTransport;
  }

  /** Listens for events of one type. Returns a function that removes this listener. */
  on<T extends E['type']>(
    type: T,
    fn: (event: Extract<E, { type: T }>) => void,
  ): () => void;
  /** The stream was re-established after a drop. Missed events are gone: resync. */
  on(type: 'reconnected', fn: () => void): () => void;
  /** Something went wrong that the stream survived (see the error's `code`). */
  on(type: 'error', fn: (error: XoError) => void): () => void;
  /** `close()` finished. */
  on(type: 'closed', fn: () => void): () => void;
  on(type: string, fn: (payload: never) => void): () => void {
    if (typeof fn !== 'function') {
      throw new UserInputError('A listener must be a function');
    }
    // The overloads above are what callers see; inside, a payload is whatever was dispatched.
    const entry = { fn: fn as Listener };
    let list = this.listeners.get(type);
    if (list === undefined) {
      list = [];
      this.listeners.set(type, list);
    }
    list.push(entry);
    return () => {
      const current = this.listeners.get(type);
      const at = current?.indexOf(entry) ?? -1;
      if (current !== undefined && at >= 0) {
        current.splice(at, 1);
      }
    };
  }

  /**
   * A new iterator over the events pushed from now on, with its own bounded buffer. **It yields
   * events only**: `'reconnected'`, `'error'` and `'closed'` never appear in the loop, so a
   * consumer that keeps state built from the stream must also listen with
   * `on('reconnected', ...)` and `on('error', ...)` and resync when they fire (see the
   * warning on {@link Subscription}). Ends after `close()`. Breaking out of the loop stops this
   * iterator only. Overflow is per iterator.
   */
  [Symbol.asyncIterator](): AsyncIterableIterator<E> {
    const cursor = new Cursor<E>(
      this.capacity,
      () =>
        this.dispatch(
          'error',
          new XoError(
            `The subscription buffer (${this.capacity} events) overflowed because the consumer is too slow: the oldest events were dropped. Local state built from this stream may be wrong, so resync it`,
            { code: 'subscription_overflow', service: 'sdk' },
          ),
        ),
      (done) => this.cursors.delete(done),
    );
    if (this.closed) {
      cursor.end();
    } else {
      this.cursors.add(cursor);
    }
    return cursor;
  }

  /** Stops the stream. Idempotent: every call returns the same promise. See the class docs. */
  close(): Promise<void> {
    if (this.closing === undefined) {
      this.closed = true;
      for (const cursor of this.cursors) {
        cursor.end();
      }
      this.cursors.clear();
      // `closing` is set before anything of the caller's runs: a transport hook (or a listener)
      // that calls close() again gets this promise instead of starting a second close. The hook
      // therefore runs a microtask later, and it must not await close() itself.
      this.closing = Promise.resolve().then(() => this.finishClose());
    }
    return this.closing;
  }

  private async finishClose(): Promise<void> {
    try {
      await this.closeTransport?.();
    } finally {
      this.dispatch('closed', undefined);
      // The subscription is over; do not keep the listeners (and what they capture) alive.
      this.listeners = new Map();
    }
  }

  /**
   * @internal Producer side: delivers one event of the stream to the listeners of its type and
   * to every iterator. Ignored after `close()`.
   */
  push(event: E): void {
    if (this.closed) {
      return;
    }
    this.dispatch(event.type, event);
    for (const cursor of this.cursors) {
      cursor.push(event);
    }
  }

  /**
   * @internal Producer side: the transport re-established the stream. Ignored after `close()`.
   * `info`, when given, is what the `'reconnected'` listeners receive (a merged handle passes
   * the topic that reconnected).
   */
  pushReconnected(info?: unknown): void {
    if (!this.closed) {
      this.dispatch('reconnected', info);
    }
  }

  /** @internal Producer side: reports an error the stream survived. Ignored after `close()`. */
  pushError(error: XoError): void {
    if (!this.closed) {
      this.dispatch('error', error);
    }
  }

  /** Calls the listeners of `type`, each one isolated from the others and from the caller. */
  private dispatch(type: string, payload: unknown): void {
    const list = this.listeners.get(type);
    if (list === undefined) {
      return;
    }
    // A copy, so a listener that unsubscribes (or subscribes) mid-delivery is safe.
    for (const { fn } of [...list]) {
      try {
        const result: unknown = fn(payload);
        if (isThenable(result)) {
          result.then(undefined, () => {});
        }
      } catch {
        // A listener cannot break the stream.
      }
    }
  }
}
