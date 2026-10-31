import { afterEach, describe, expect, test, vi } from 'vitest';
import { UserInputError, XoError } from '../../src/core/errors';
import { ReconnectingWs } from '../../src/realtime/reconnectingWs';
import {
  DEFAULT_SUBSCRIPTION_BUFFER,
  Subscription,
} from '../../src/realtime/subscription';
import {
  settle,
  startWsServer,
  type WsTestServer,
  waitUntil,
} from '../helpers/wsServer';

type Ev =
  | { type: 'book'; n: number }
  | { type: 'trade'; n: number; price: string };

const book = (n: number): Ev => ({ type: 'book', n });
const trade = (n: number): Ev => ({ type: 'trade', n, price: '0.5' });

/** Takes up to `count` events off an iterator. */
async function take(iterator: AsyncIterator<Ev>, count: number): Promise<Ev[]> {
  const out: Ev[] = [];
  for (let i = 0; i < count; i += 1) {
    const result = await iterator.next();
    if (result.done) {
      break;
    }
    out.push(result.value);
  }
  return out;
}

describe('Subscription listeners', () => {
  test('on(type) gets only events of that type, in order', () => {
    const sub = new Subscription<Ev>();
    const books: number[] = [];
    const trades: number[] = [];
    sub.on('book', (e) => books.push(e.n));
    sub.on('trade', (e) => trades.push(e.n));
    sub.push(book(1));
    sub.push(trade(2));
    sub.push(book(3));
    expect(books).toEqual([1, 3]);
    expect(trades).toEqual([2]);
  });

  test('on() returns an unsubscribe function, and the same listener may be added twice', () => {
    const sub = new Subscription<Ev>();
    const seen: string[] = [];
    const listener = (e: Ev) => seen.push(`${e.type}${e.n}`);
    const offA = sub.on('book', listener);
    const offB = sub.on('book', listener);
    sub.push(book(1));
    expect(seen).toEqual(['book1', 'book1']);
    offA();
    offA(); // idempotent
    sub.push(book(2));
    expect(seen).toEqual(['book1', 'book1', 'book2']);
    offB();
    sub.push(book(3));
    expect(seen).toEqual(['book1', 'book1', 'book2']);
  });

  test('a listener may unsubscribe itself while an event is delivered', () => {
    const sub = new Subscription<Ev>();
    const seen: string[] = [];
    const off = sub.on('book', () => {
      seen.push('first');
      off();
    });
    sub.on('book', () => seen.push('second'));
    sub.push(book(1));
    sub.push(book(2));
    expect(seen).toEqual(['first', 'second', 'second']);
  });

  test('a listener that throws is swallowed and the others still run', () => {
    const sub = new Subscription<Ev>();
    const seen: number[] = [];
    sub.on('book', () => {
      throw new Error('boom');
    });
    sub.on('book', (e) => seen.push(e.n));
    expect(() => sub.push(book(1))).not.toThrow();
    expect(seen).toEqual([1]);
  });

  test('a listener that returns a rejected promise is swallowed too', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const sub = new Subscription<Ev>();
      sub.on('book', async () => {
        throw new Error('async boom');
      });
      sub.push(book(1));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  test('on() rejects a listener that is not a function', () => {
    const sub = new Subscription<Ev>();
    expect(() => sub.on('book', 'nope' as never)).toThrow(UserInputError);
  });

  test("'reconnected' and 'error' reach their listeners; an error listener that throws is swallowed", () => {
    const sub = new Subscription<Ev>();
    const log: string[] = [];
    sub.on('reconnected', () => log.push('reconnected'));
    sub.on('error', (error) => {
      log.push(`error:${error.code}`);
      throw new Error('listener bug');
    });
    sub.pushReconnected();
    sub.pushError(new XoError('x', { code: 'some_code' }));
    expect(log).toEqual(['reconnected', 'error:some_code']);
  });

  test('without an iterator nothing is buffered: a listener-only subscription never overflows', () => {
    const sub = new Subscription<Ev>();
    const errors: XoError[] = [];
    sub.on('error', (e) => errors.push(e));
    for (let i = 0; i < DEFAULT_SUBSCRIPTION_BUFFER + 50; i += 1) {
      sub.push(book(i));
    }
    expect(errors).toEqual([]);
  });
});

describe('Subscription async iterator', () => {
  test('yields pushed events in order, whether pushed before or after next()', async () => {
    const sub = new Subscription<Ev>();
    const it = sub[Symbol.asyncIterator]();
    sub.push(book(1));
    sub.push(trade(2));
    expect(await take(it, 2)).toEqual([book(1), trade(2)]);
    const pending = it.next(); // waits
    sub.push(book(3));
    expect(await pending).toEqual({ value: book(3), done: false });
  });

  test('works with for await', async () => {
    const sub = new Subscription<Ev>();
    const seen: number[] = [];
    const loop = (async () => {
      for await (const ev of sub) {
        seen.push(ev.n);
      }
    })();
    sub.push(book(1));
    sub.push(book(2));
    await waitUntil(() => seen.length === 2, 'two events');
    await sub.close();
    await loop; // the loop ended
    expect(seen).toEqual([1, 2]);
  });

  test('the iterator ends (done) after close(), also a next() that was already waiting', async () => {
    const sub = new Subscription<Ev>();
    const it = sub[Symbol.asyncIterator]();
    const waiting = it.next();
    await sub.close();
    expect(await waiting).toEqual({ value: undefined, done: true });
    expect(await it.next()).toEqual({ value: undefined, done: true });
  });

  test('close() discards events that were buffered but not yet read', async () => {
    const sub = new Subscription<Ev>();
    const it = sub[Symbol.asyncIterator]();
    sub.push(book(1));
    await sub.close();
    expect(await it.next()).toEqual({ value: undefined, done: true });
  });

  test('an iterator requested after close() is already done', async () => {
    const sub = new Subscription<Ev>();
    await sub.close();
    expect(await sub[Symbol.asyncIterator]().next()).toEqual({
      value: undefined,
      done: true,
    });
  });

  test('events pushed after close() are dropped', async () => {
    const sub = new Subscription<Ev>();
    const seen: number[] = [];
    sub.on('book', (e) => seen.push(e.n));
    await sub.close();
    sub.push(book(1));
    sub.pushReconnected();
    sub.pushError(new XoError('late'));
    expect(seen).toEqual([]);
  });

  test('breaking out of a loop stops that iterator only; the subscription stays open', async () => {
    const closeTransport = vi.fn();
    const sub = new Subscription<Ev>({ closeTransport });
    const seen: number[] = [];
    sub.on('book', (e) => seen.push(e.n));
    const it = sub[Symbol.asyncIterator]();
    sub.push(book(1));
    expect(await it.return?.()).toEqual({ value: undefined, done: true });
    expect(await it.next()).toEqual({ value: undefined, done: true });
    sub.push(book(2));
    expect(seen).toEqual([1, 2]); // listeners still get events
    expect(closeTransport).not.toHaveBeenCalled();
  });

  test('two iterators each get every event pushed after they were created', async () => {
    const sub = new Subscription<Ev>();
    const a = sub[Symbol.asyncIterator]();
    sub.push(book(1));
    const b = sub[Symbol.asyncIterator]();
    sub.push(book(2));
    expect(await take(a, 2)).toEqual([book(1), book(2)]);
    expect(await take(b, 1)).toEqual([book(2)]);
  });
});

describe('Subscription overflow', () => {
  test('the buffer is 10_000 events by default', () => {
    expect(DEFAULT_SUBSCRIPTION_BUFFER).toBe(10_000);
  });

  test('on overflow the OLDEST event is dropped and one error is emitted', async () => {
    const sub = new Subscription<Ev>({ bufferSize: 3 });
    const errors: XoError[] = [];
    sub.on('error', (e) => errors.push(e));
    const it = sub[Symbol.asyncIterator]();
    for (let n = 1; n <= 6; n += 1) {
      sub.push(book(n));
    }
    expect(errors).toHaveLength(1); // once, not once per dropped event
    expect(errors[0]).toBeInstanceOf(XoError);
    expect(errors[0]?.code).toBe('subscription_overflow');
    expect(await take(it, 3)).toEqual([book(4), book(5), book(6)]);
  });

  test('the default capacity drops event 1 when event 10_001 arrives', async () => {
    const sub = new Subscription<Ev>();
    const errors: XoError[] = [];
    sub.on('error', (e) => errors.push(e));
    const it = sub[Symbol.asyncIterator]();
    for (let n = 1; n <= DEFAULT_SUBSCRIPTION_BUFFER; n += 1) {
      sub.push(book(n));
    }
    expect(errors).toHaveLength(0); // full, not over
    sub.push(book(DEFAULT_SUBSCRIPTION_BUFFER + 1));
    expect(errors).toHaveLength(1);
    expect((await it.next()).value).toEqual(book(2));
  });

  test('a new overflow episode starts only after the consumer has drained the buffer', async () => {
    const sub = new Subscription<Ev>({ bufferSize: 2 });
    const errors: XoError[] = [];
    sub.on('error', (e) => errors.push(e));
    const it = sub[Symbol.asyncIterator]();
    sub.push(book(1));
    sub.push(book(2));
    sub.push(book(3)); // episode 1
    expect(errors).toHaveLength(1);
    await it.next(); // 2 -- one slot free, not drained
    sub.push(book(4));
    sub.push(book(5)); // still episode 1: the buffer was never empty
    expect(errors).toHaveLength(1);
    expect(await take(it, 2)).toEqual([book(4), book(5)]); // drained
    sub.push(book(6));
    sub.push(book(7));
    sub.push(book(8)); // episode 2
    expect(errors).toHaveLength(2);
    expect(await take(it, 2)).toEqual([book(7), book(8)]);
  });

  test('a waiting consumer never overflows: events go straight to it', async () => {
    const sub = new Subscription<Ev>({ bufferSize: 1 });
    const errors: XoError[] = [];
    sub.on('error', (e) => errors.push(e));
    const it = sub[Symbol.asyncIterator]();
    const first = it.next();
    sub.push(book(1));
    expect((await first).value).toEqual(book(1));
    const second = it.next();
    sub.push(book(2));
    expect((await second).value).toEqual(book(2));
    expect(errors).toEqual([]);
  });

  test('a listener that closes the subscription on overflow lets no event out after the close', async () => {
    const sub = new Subscription<Ev>({ bufferSize: 2 });
    sub.on('error', (error) => {
      if (error.code === 'subscription_overflow') {
        void sub.close();
      }
    });
    const it = sub[Symbol.asyncIterator]();
    sub.push(book(1));
    sub.push(book(2));
    sub.push(book(3)); // overflows: the listener closes the subscription from inside push()
    expect(await it.next()).toEqual({ value: undefined, done: true });
  });

  test('a waiting consumer is released with done when an overflow listener closes', async () => {
    const sub = new Subscription<Ev>({ bufferSize: 1 });
    sub.on('error', () => {
      void sub.close();
    });
    const first = sub[Symbol.asyncIterator]();
    const second = sub[Symbol.asyncIterator]();
    sub.push(book(1)); // both buffered
    sub.push(book(2)); // overflow in the first cursor: closes; the second must not get event 2
    expect(await first.next()).toEqual({ value: undefined, done: true });
    expect(await second.next()).toEqual({ value: undefined, done: true });
  });

  test('bufferSize is capped at 1_000_000 and the buffer grows on demand, never allocated up front', async () => {
    expect(() => new Subscription<Ev>({ bufferSize: 1_000_001 })).toThrow(
      UserInputError,
    );
    expect(() => new Subscription<Ev>({ bufferSize: 1_000_001 })).toThrow(
      /bufferSize/,
    );
    // The largest allowed size costs nothing until events arrive.
    const sub = new Subscription<Ev>({ bufferSize: 1_000_000 });
    const it = sub[Symbol.asyncIterator]();
    sub.push(book(1));
    expect(await take(it, 1)).toEqual([book(1)]);
  });

  test('order is kept while the buffer grows, wraps and overflows', async () => {
    const sub = new Subscription<Ev>({ bufferSize: 100 });
    const errors: XoError[] = [];
    sub.on('error', (e) => errors.push(e));
    const it = sub[Symbol.asyncIterator]();
    for (let n = 1; n <= 50; n += 1) {
      sub.push(book(n)); // grows past its first small allocation
    }
    expect((await take(it, 10)).map((e) => e.n)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    for (let n = 51; n <= 120; n += 1) {
      sub.push(book(n)); // 40 + 70 = 110 pushed into 100 slots: wraps, then overflows
    }
    expect(errors).toHaveLength(1);
    const rest = (await take(it, 100)).map((e) => e.n);
    expect(rest).toEqual(Array.from({ length: 100 }, (_, i) => 21 + i));
  });

  test('bufferSize must be a positive whole number', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, '10']) {
      expect(() => new Subscription<Ev>({ bufferSize: bad as never })).toThrow(
        UserInputError,
      );
    }
  });
});

describe('Subscription.close', () => {
  test('is idempotent: one transport close, one closed event, the same promise', async () => {
    const closeTransport = vi.fn(async () => {});
    const sub = new Subscription<Ev>({ closeTransport });
    const closed = vi.fn();
    sub.on('closed', closed);
    const first = sub.close();
    const second = sub.close();
    expect(second).toBe(first);
    await first;
    await sub.close();
    expect(closeTransport).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  test("'closed' fires after the transport has finished closing", async () => {
    const order: string[] = [];
    const sub = new Subscription<Ev>({
      closeTransport: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        order.push('transport closed');
      },
    });
    sub.on('closed', () => order.push('closed event'));
    await sub.close();
    expect(order).toEqual(['transport closed', 'closed event']);
  });

  test('a failing transport close rejects close() but still ends the subscription', async () => {
    const sub = new Subscription<Ev>({
      closeTransport: () => Promise.reject(new Error('transport')),
    });
    const closed = vi.fn();
    sub.on('closed', closed);
    const it = sub[Symbol.asyncIterator]();
    await expect(sub.close()).rejects.toThrow('transport');
    expect(closed).toHaveBeenCalledTimes(1);
    expect((await it.next()).done).toBe(true);
  });

  test('a transport hook that calls sub.close() again does not recurse or close twice', async () => {
    const hook = vi.fn(() => {
      void sub.close();
    });
    const sub: Subscription<Ev> = new Subscription<Ev>({
      closeTransport: hook,
    });
    const closed = vi.fn();
    sub.on('closed', closed);
    await sub.close();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  test('works with no transport', async () => {
    await expect(new Subscription<Ev>().close()).resolves.toBeUndefined();
  });
});

describe('Subscription wired to a ReconnectingWs (the orderbook channel pattern)', () => {
  let server: WsTestServer;
  let ws: ReconnectingWs | undefined;
  afterEach(async () => {
    await ws?.close();
    ws = undefined;
    await server?.close();
    // A test that forgets to start its own server must fail loudly, not reuse a closed one.
    server = undefined as unknown as WsTestServer;
    vi.useRealTimers();
  });

  test('events, reconnected, error and close flow through a real socket', async () => {
    // Timers are faked so that the 1 s wait after the 1008 below never elapses by itself: a
    // slow CI machine cannot slip a third connection into the assertions.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server = await startWsServer();
    const opens: Array<(text: string) => void> = [];
    let closes = 0;
    // This is the wiring the orderbook channels use: the Subscription is the consumer side, the
    // ReconnectingWs is the transport, and the glue is five lines.
    const sub = new Subscription<Ev>({ closeTransport: () => ws?.close() });
    ws = new ReconnectingWs({
      url: server.url,
      backoff: { baseMs: 5, capMs: 20 },
      random: () => 1, // the ceiling: the first reconnect waits 5 ms
      onOpen: (send) => {
        opens.push(send);
        send(JSON.stringify({ subscribe: 'book' }));
      },
      onClose: () => {
        closes += 1;
      },
      onMessage: (data) => sub.push(JSON.parse(data) as Ev),
      onReconnected: () => sub.pushReconnected(),
      onError: (error) => sub.pushError(error),
    });

    const fromListener: number[] = [];
    const lifecycle: string[] = [];
    sub.on('book', (e) => fromListener.push(e.n));
    sub.on('reconnected', () => lifecycle.push('reconnected'));
    sub.on('error', (e) => {
      // A dropped TCP connection may also surface as a socket error; that is not under test.
      if (e.code !== 'transport_error') {
        lifecycle.push(`error:${e.code}`);
      }
    });
    sub.on('closed', () => lifecycle.push('closed'));
    const fromIterator: number[] = [];
    const loop = (async () => {
      for await (const ev of sub) {
        fromIterator.push(ev.n);
      }
    })();

    ws.start();
    const first = await server.accept();
    await waitUntil(() => first.received.includes('{"subscribe":"book"}'));
    first.send(JSON.stringify(book(1)));
    await waitUntil(() => fromIterator.length === 1, 'event 1');

    // A drop reconnects and resubscribes by itself, and the consumer is told.
    first.drop();
    await waitUntil(() => closes === 1, 'the client to see the drop');
    vi.advanceTimersByTime(5);
    const second = await server.accept();
    await waitUntil(() => second.received.includes('{"subscribe":"book"}'));
    await waitUntil(() => lifecycle.includes('reconnected'), 'reconnected');
    second.send(JSON.stringify(book(2)));
    await waitUntil(() => fromIterator.length === 2, 'event 2');

    // The gateway's connection cap arrives as an error event. The client now waits at least
    // 1 s (fake time, which is not advanced) before it reconnects; closing during that wait
    // ends everything.
    second.closeWith(1008, 'max_ws_connections_exceeded');
    await waitUntil(
      () => lifecycle.includes('error:max_ws_connections_exceeded'),
      'the 1008 error',
    );
    await sub.close();
    await loop; // the for await ended
    expect(fromListener).toEqual([1, 2]);
    expect(fromIterator).toEqual([1, 2]);
    expect(lifecycle).toEqual([
      'reconnected',
      'error:max_ws_connections_exceeded',
      'closed',
    ]);
    await settle();
    expect(server.connections).toHaveLength(2);
    expect(opens).toHaveLength(2);
  });

  test('sub.close() closes the socket with code 1000', async () => {
    server = await startWsServer();
    const sub = new Subscription<Ev>({ closeTransport: () => ws?.close() });
    let opened = false;
    ws = new ReconnectingWs({
      url: server.url,
      onOpen: () => {
        opened = true;
      },
      onMessage: (data) => sub.push(JSON.parse(data) as Ev),
    });
    ws.start();
    const conn = await server.accept();
    await waitUntil(() => opened, 'the client to open');
    await sub.close();
    expect((await conn.closed).code).toBe(1000);
  });
});
