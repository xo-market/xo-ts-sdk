import { afterEach, describe, expect, test, vi } from 'vitest';
import { WebSocket as WsClient } from 'ws';
import { TransportError, UserInputError, XoError } from '../../src/core/errors';
import {
  ReconnectingWs,
  type ReconnectingWsOptions,
} from '../../src/realtime/reconnectingWs';
import {
  type ServerConnection,
  type SilentTcpServer,
  settle,
  startSilentTcpServer,
  startWsServer,
  type WsTestServer,
  waitUntil,
} from '../helpers/wsServer';

// The `ws` package's client, in the shape of the global WebSocket the SDK expects. Most tests
// inject it through the `WebSocketImpl` option; one test uses Node's own global instead.
const WsImpl = WsClient as unknown as typeof WebSocket;

let server: WsTestServer;
let silent: SilentTcpServer | undefined;
let ws: ReconnectingWs | undefined;

afterEach(async () => {
  await ws?.close();
  ws = undefined;
  await server?.close();
  // A test that forgets to start its own server must fail loudly, not reuse a closed one.
  server = undefined as unknown as WsTestServer;
  await silent?.close();
  silent = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** What the callbacks of one ReconnectingWs saw. */
interface Log {
  opens: number;
  sends: Array<(text: string) => void>;
  messages: string[];
  reconnected: number;
  closes: Array<{ code: number; reason: string }>;
  errors: XoError[];
}

function build(overrides: Partial<ReconnectingWsOptions> = {}): {
  ws: ReconnectingWs;
  log: Log;
} {
  const log: Log = {
    opens: 0,
    sends: [],
    messages: [],
    reconnected: 0,
    closes: [],
    errors: [],
  };
  const instance = new ReconnectingWs({
    url: server.url,
    WebSocketImpl: WsImpl,
    onOpen: (send) => {
      log.opens += 1;
      log.sends.push(send);
    },
    onMessage: (data) => log.messages.push(data),
    onReconnected: () => {
      log.reconnected += 1;
    },
    onClose: (code, reason) => log.closes.push({ code, reason }),
    onError: (error) => log.errors.push(error),
    ...overrides,
  });
  ws = instance;
  return { ws: instance, log };
}

describe('keepalive', () => {
  test('sends "PING" every 10 s (the default) and nothing before', async () => {
    // Only the interval is faked: the sockets are real, and their I/O needs no timers.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    server = await startWsServer();
    const { ws, log } = build();
    ws.start();
    const conn = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');

    vi.advanceTimersByTime(9_999);
    await settle();
    expect(conn.received).toEqual([]);

    vi.advanceTimersByTime(1);
    await waitUntil(() => conn.received.length === 1, 'the first PING');
    expect(conn.received).toEqual(['PING']);

    vi.advanceTimersByTime(20_000); // two more intervals
    await waitUntil(() => conn.received.length === 3, 'two more PINGs');
    expect(conn.received).toEqual(['PING', 'PING', 'PING']);
  });

  test('pingIntervalMs sets the cadence', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    server = await startWsServer();
    const { ws, log } = build({ pingIntervalMs: 2_000 });
    ws.start();
    const conn = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    vi.advanceTimersByTime(1_999);
    await settle();
    expect(conn.received).toEqual([]);
    vi.advanceTimersByTime(1);
    await waitUntil(() => conn.received.length === 1, 'a PING');
  });

  test('"PONG" is never passed to onMessage; every other frame is', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    server = await startWsServer();
    const { ws, log } = build();
    ws.start();
    const conn = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');

    vi.advanceTimersByTime(10_000); // the server answers the PING with PONG
    await waitUntil(() => conn.received.length === 1, 'the PING');
    conn.send('PONG'); // an unsolicited one
    conn.send('hello');
    conn.send('PONGX');
    conn.send('pong'); // only the exact text "PONG" is the keepalive answer
    conn.send('{"type":"book"}');
    await waitUntil(() => log.messages.length === 4, 'four messages');
    expect(log.messages).toEqual(['hello', 'PONGX', 'pong', '{"type":"book"}']);
  });

  test('close() cancels the ping timer', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    server = await startWsServer();
    const { ws, log } = build();
    ws.start();
    await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    expect(vi.getTimerCount()).toBe(1);
    await ws.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('pingIntervalMs is validated to 1000..50000', () => {
    const base = { url: 'ws://127.0.0.1:1', WebSocketImpl: WsImpl };
    const make = (pingIntervalMs: unknown) =>
      new ReconnectingWs({
        ...base,
        pingIntervalMs: pingIntervalMs as number,
        onOpen: () => {},
        onMessage: () => {},
      });
    for (const bad of [999, 50_001, 0, -1, 1500.5, Number.NaN, '5000']) {
      expect(() => make(bad)).toThrow(UserInputError);
    }
    expect(() => make(1_000)).not.toThrow();
    expect(() => make(50_000)).not.toThrow();
    expect(() => make(undefined)).not.toThrow();
  });
});

describe('connect and reconnect', () => {
  test('onOpen runs on the first connect; onReconnected does not', async () => {
    server = await startWsServer();
    const { ws, log } = build();
    ws.start();
    await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    expect(log.opens).toBe(1);
    expect(log.reconnected).toBe(0);
  });

  test('onOpen hands out a working send', async () => {
    server = await startWsServer();
    const { ws, log } = build({
      onOpen: (send) => send('{"subscribe":"x"}'),
    });
    ws.start();
    const conn = await server.accept();
    await waitUntil(() => conn.received.length === 1, 'the frame');
    expect(conn.received).toEqual(['{"subscribe":"x"}']);
    expect(log.errors).toEqual([]);
  });

  test('a server drop reconnects, calls onOpen again (resubscribe) and fires onReconnected', async () => {
    server = await startWsServer();
    // Real timers with a tiny backoff: the whole cycle takes a few milliseconds.
    const { ws, log } = build({
      backoff: { baseMs: 5, capMs: 20 },
      onOpen: (send) => send('resubscribe'),
    });
    ws.start();
    const first = await server.accept();
    await waitUntil(() => first.received.length === 1, 'first subscribe');

    first.drop();
    const second = await server.accept();
    await waitUntil(() => second.received.length === 1, 'second subscribe');
    await waitUntil(() => log.reconnected === 1, 'onReconnected');
    expect(second.received).toEqual(['resubscribe']);
    expect(log.closes).toHaveLength(1);
    expect(log.closes[0]?.code).toBe(1006);

    // And again: each reconnect fires onReconnected once.
    second.drop();
    const third = await server.accept();
    await waitUntil(() => third.received.length === 1, 'third subscribe');
    await waitUntil(() => log.reconnected === 2, 'second onReconnected');
  });

  test('onOpen runs before onReconnected', async () => {
    server = await startWsServer();
    const order: string[] = [];
    const { ws } = build({
      backoff: { baseMs: 1, capMs: 5 },
      onOpen: () => {
        order.push('open');
      },
      onReconnected: () => {
        order.push('reconnected');
      },
    });
    ws.start();
    const first = await server.accept();
    await waitUntil(() => order.length === 1, 'first open');
    first.drop();
    await waitUntil(() => order.length === 3, 'reconnect');
    expect(order).toEqual(['open', 'open', 'reconnected']);
  });

  test('onClose is called for every close, with the code and reason', async () => {
    server = await startWsServer();
    const { ws, log } = build({ backoff: { baseMs: 1, capMs: 5 } });
    ws.start();
    const first = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    first.closeWith(4001, 'because');
    await waitUntil(() => log.closes.length === 1, 'the close');
    expect(log.closes[0]).toEqual({ code: 4001, reason: 'because' });
    const second = await server.accept();
    await waitUntil(() => log.opens === 2, 'reopen');
    second.drop();
    await waitUntil(() => log.closes.length === 2, 'the second close');
    expect(log.closes[1]?.code).toBe(1006);
  });

  test('onReconnected is not fired by the first connect that follows failed attempts', async () => {
    // A port that nothing listens on: a server that was started and stopped.
    const dead = await startWsServer();
    const deadUrl = dead.url;
    await dead.close();
    server = await startWsServer();
    const liveUrl = server.url;
    // The first two attempts go to the dead port, every later one to the live server.
    let attempts = 0;
    class FailFirst extends WsClient {
      constructor(_url: string) {
        attempts += 1;
        super(attempts <= 2 ? deadUrl : liveUrl);
      }
    }
    const { ws, log } = build({
      WebSocketImpl: FailFirst as unknown as typeof WebSocket,
      backoff: { baseMs: 5, capMs: 10 },
    });
    ws.start();
    await waitUntil(() => log.opens === 1, 'first successful open');
    expect(log.closes.length).toBeGreaterThanOrEqual(2); // the failed attempts
    expect(log.reconnected).toBe(0);
    // A failed attempt is a transport error the caller can see.
    expect(log.errors[0]).toBeInstanceOf(TransportError);
  });

  test('start() is idempotent', async () => {
    server = await startWsServer();
    const { ws, log } = build();
    ws.start();
    ws.start();
    await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    ws.start();
    await settle();
    expect(server.connections).toHaveLength(1);
    expect(log.opens).toBe(1);
  });
});

describe('backoff', () => {
  /**
   * Drops `conn` from the server, waits for the client to see it, and checks that the client
   * reconnects after exactly `delayMs` of (fake) time: not a millisecond sooner. Returns the
   * new connection. Only `setTimeout` is faked, so the sockets stay real.
   */
  async function expectReconnectAfter(
    log: Log,
    drop: (conn: ServerConnection) => void,
    conn: ServerConnection,
    delayMs: number,
  ): Promise<ServerConnection> {
    const seen = server.connections.length;
    const closes = log.closes.length;
    const opens = log.opens;
    drop(conn);
    await waitUntil(() => log.closes.length === closes + 1, 'the close');
    if (delayMs > 0) {
      vi.advanceTimersByTime(delayMs - 1);
      await settle();
      expect(server.connections).toHaveLength(seen); // not yet
    }
    vi.advanceTimersByTime(delayMs > 0 ? 1 : 0);
    const next = await server.accept();
    // The server accepting does not mean the client has processed its 'open' yet.
    await waitUntil(() => log.opens === opens + 1, 'the client to open');
    return next;
  }

  test('with the random source at its maximum the delays are 250, 500, 1000, ... capped at 30000', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server = await startWsServer();
    const { ws, log } = build({ random: () => 1 });
    ws.start();
    let conn = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    const expected = [
      250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ];
    for (const delay of expected) {
      conn = await expectReconnectAfter(log, (c) => c.drop(), conn, delay);
    }
    expect(log.reconnected).toBe(expected.length); // one per reconnect, none for the first connect
  });

  test('with the random source at its minimum the reconnect is immediate', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server = await startWsServer();
    const { ws, log } = build({ random: () => 0 });
    ws.start();
    let conn = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    for (let i = 0; i < 3; i += 1) {
      conn = await expectReconnectAfter(log, (c) => c.drop(), conn, 0);
    }
  });

  test('the delay is full jitter: random() scales the ceiling', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server = await startWsServer();
    const { ws, log } = build({ random: () => 0.5 });
    ws.start();
    let conn = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    // floor(0.5 * 250), floor(0.5 * 500), floor(0.5 * 1000)
    for (const delay of [125, 250, 500]) {
      conn = await expectReconnectAfter(log, (c) => c.drop(), conn, delay);
    }
  });

  test('base and cap are configurable', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server = await startWsServer();
    const { ws, log } = build({
      backoff: { baseMs: 100, capMs: 300 },
      random: () => 1,
    });
    ws.start();
    let conn = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    for (const delay of [100, 200, 300, 300]) {
      conn = await expectReconnectAfter(log, (c) => c.drop(), conn, delay);
    }
  });

  test('the attempt counter resets once a connection stayed open for 30 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server = await startWsServer();
    // A 50 s ping interval keeps the silence watchdog (2.5 intervals) out of the 30 s window.
    const { ws, log } = build({ random: () => 1, pingIntervalMs: 50_000 });
    ws.start();
    let conn = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    conn = await expectReconnectAfter(log, (c) => c.drop(), conn, 250);
    conn = await expectReconnectAfter(log, (c) => c.drop(), conn, 500);
    // Stay connected for the full 30 s: the next drop starts again at 250.
    vi.advanceTimersByTime(30_000);
    conn = await expectReconnectAfter(log, (c) => c.drop(), conn, 250);
    conn = await expectReconnectAfter(log, (c) => c.drop(), conn, 500);
  });

  test('a connection that closes after 29.999 s does not reset the counter', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server = await startWsServer();
    const { ws, log } = build({ random: () => 1, pingIntervalMs: 50_000 });
    ws.start();
    let conn = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    conn = await expectReconnectAfter(log, (c) => c.drop(), conn, 250);
    conn = await expectReconnectAfter(log, (c) => c.drop(), conn, 500);
    vi.advanceTimersByTime(29_999);
    conn = await expectReconnectAfter(log, (c) => c.drop(), conn, 1_000);
  });

  test('stableAfterMs shortens the stability window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server = await startWsServer();
    const { ws, log } = build({ random: () => 1, stableAfterMs: 1_000 });
    ws.start();
    let conn = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    conn = await expectReconnectAfter(log, (c) => c.drop(), conn, 250);
    conn = await expectReconnectAfter(log, (c) => c.drop(), conn, 500);
    vi.advanceTimersByTime(1_000);
    conn = await expectReconnectAfter(log, (c) => c.drop(), conn, 250);
  });

  test('backoff is validated', () => {
    const make = (backoff: unknown) =>
      new ReconnectingWs({
        url: 'ws://127.0.0.1:1',
        WebSocketImpl: WsImpl,
        backoff: backoff as { baseMs: number; capMs: number },
        onOpen: () => {},
        onMessage: () => {},
      });
    for (const bad of [
      { baseMs: 0, capMs: 100 },
      { baseMs: -1, capMs: 100 },
      { baseMs: 100, capMs: 50 },
      { baseMs: Number.NaN, capMs: 50 },
      { baseMs: 10, capMs: Number.POSITIVE_INFINITY },
      { baseMs: '10', capMs: 50 },
      { baseMs: 10 },
      null,
      7,
    ]) {
      expect(() => make(bad)).toThrow(UserInputError);
    }
    expect(() => make({ baseMs: 5, capMs: 5 })).not.toThrow();
  });
});

describe('close code 1008 (max_ws_connections_exceeded)', () => {
  test('emits an error with that code; the next delay is at least 1 s even when jitter says 0', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server = await startWsServer();
    const { ws, log } = build({ random: () => 0 });
    ws.start();
    const first = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');

    first.closeWith(1008, 'max_ws_connections_exceeded');
    await waitUntil(() => log.closes.length === 1, 'the close');
    expect(log.closes[0]).toEqual({
      code: 1008,
      reason: 'max_ws_connections_exceeded',
    });
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]).toBeInstanceOf(XoError);
    expect(log.errors[0]?.code).toBe('max_ws_connections_exceeded');
    expect(log.errors[0]?.service).toBe('orderbook');

    vi.advanceTimersByTime(999);
    await settle();
    expect(server.connections).toHaveLength(1); // no tight reconnect loop
    vi.advanceTimersByTime(1);
    await server.accept();
    await waitUntil(() => log.opens === 2, 'reconnect after the floor');
  });

  test('repeated 1008s keep the floor and keep doubling', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server = await startWsServer({
      onConnection: (c) => c.closeWith(1008, 'max_ws_connections_exceeded'),
    });
    const { ws, log } = build({ random: () => 1 });
    ws.start();
    await server.accept();
    // Each connection opens, then is refused at once. The ceilings are 250, 500, 1000, 2000,
    // 4000, ...; the 1 s floor lifts the first three to 1000.
    for (const delay of [1_000, 1_000, 1_000, 2_000, 4_000, 8_000]) {
      const closes = log.closes.length;
      await waitUntil(() => log.closes.length === closes + 1, 'the close');
      const seen = server.connections.length;
      vi.advanceTimersByTime(delay - 1);
      await settle();
      expect(server.connections).toHaveLength(seen);
      vi.advanceTimersByTime(1);
      await server.accept();
    }
    expect(log.errors.map((e) => e.code)).toEqual(
      Array(6).fill('max_ws_connections_exceeded'),
    );
  });

  test('an opened-then-refused connection does not reset the attempt counter', async () => {
    // The gateway accepts the upgrade and then closes with 1008, so onOpen runs every time. If
    // the counter reset on open, the delay would never grow.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server = await startWsServer({
      onConnection: (c) => c.closeWith(1008, 'max_ws_connections_exceeded'),
    });
    const { ws, log } = build({ random: () => 1 });
    ws.start();
    await server.accept();
    for (let i = 0; i < 4; i += 1) {
      const closes = log.closes.length;
      await waitUntil(() => log.closes.length === closes + 1, 'the close');
      vi.advanceTimersByTime(i < 3 ? 1_000 : 2_000);
      await server.accept();
    }
    expect(log.opens).toBeGreaterThanOrEqual(4);
  });

  test('another close code is not an error event', async () => {
    server = await startWsServer();
    const { ws, log } = build({ backoff: { baseMs: 1, capMs: 5 } });
    ws.start();
    const first = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    first.closeWith(1001, 'going away');
    await server.accept();
    await waitUntil(() => log.opens === 2, 'reconnect');
    expect(log.errors).toEqual([]);
  });
});

describe('close()', () => {
  test('stops reconnecting: closing during the reconnect wait means no further connects', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server = await startWsServer();
    const { ws, log } = build({ random: () => 1 });
    ws.start();
    const conn = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    conn.drop();
    await waitUntil(() => log.closes.length === 1, 'the close');
    expect(vi.getTimerCount()).toBeGreaterThan(0); // the reconnect is pending

    await ws.close(); // resolves at once: there is no socket
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    await settle();
    expect(server.connections).toHaveLength(1);
    expect(log.opens).toBe(1);
  });

  test('closes the socket with code 1000 and resolves after it has closed', async () => {
    server = await startWsServer();
    const { ws, log } = build();
    ws.start();
    const conn = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    await ws.close();
    // onClose already ran by the time close() resolved.
    expect(log.closes).toEqual([{ code: 1000, reason: 'client_closed' }]);
    expect(await conn.closed).toEqual({ code: 1000, reason: 'client_closed' });
    await settle();
    expect(server.connections).toHaveLength(1);
  });

  test('is idempotent and returns the same promise', async () => {
    server = await startWsServer();
    const { ws, log } = build();
    ws.start();
    await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    const first = ws.close();
    const second = ws.close();
    expect(second).toBe(first);
    await first;
    await ws.close();
    expect(log.closes).toHaveLength(1);
  });

  test('resolves at once when nothing was started', async () => {
    server = await startWsServer();
    const { ws, log } = build();
    await expect(ws.close()).resolves.toBeUndefined();
    expect(log.closes).toEqual([]);
  });

  test('after close(), start() does nothing', async () => {
    server = await startWsServer();
    const { ws } = build();
    await ws.close();
    ws.start();
    await settle();
    expect(server.connections).toHaveLength(0);
  });

  test('no callback fires after close() resolves', async () => {
    server = await startWsServer();
    const { ws, log } = build();
    ws.start();
    const conn = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    await ws.close();
    const snapshot = JSON.stringify({ ...log, sends: log.sends.length });
    // Late traffic on a socket that is already closed.
    try {
      conn.send('late');
    } catch {
      // the server socket may refuse
    }
    await settle();
    expect(JSON.stringify({ ...log, sends: log.sends.length })).toBe(snapshot);
  });

  test('close() called from inside onOpen stops the connect cleanly', async () => {
    server = await startWsServer();
    let reconnectedCalls = 0;
    let closing: Promise<void> | undefined;
    const { ws, log } = build({
      backoff: { baseMs: 1, capMs: 5 },
      onOpen: () => {
        closing = ws?.close();
      },
      onReconnected: () => {
        reconnectedCalls += 1;
      },
    });
    ws.start();
    await server.accept();
    await waitUntil(() => closing !== undefined, 'close() to be called');
    await closing;
    await settle();
    expect(reconnectedCalls).toBe(0);
    expect(server.connections).toHaveLength(1);
    expect(log.closes.length).toBeLessThanOrEqual(1);
  });

  test('close() while the socket is still connecting', async () => {
    server = await startWsServer();
    const { ws, log } = build();
    ws.start(); // no await: the handshake is in flight
    await ws.close();
    await settle();
    expect(log.opens).toBe(0);
    expect(log.errors).toEqual([]); // the aborted handshake is not reported
  });

  test.each([
    ['open', true],
    ['still connecting', false],
  ])(
    'resolves even when the peer never completes the close handshake (%s), with no timer left',
    async (_state, opened) => {
      const instances: FakeSocket[] = [];
      class HangingSocket extends FakeSocket {
        constructor(url: string) {
          super(url);
          instances.push(this);
        }
        override close(): void {
          this.readyState = 2; // CLOSING, and no 'close' event ever comes
        }
      }
      // Every timer is faked, so the count shows what close() left behind: the ping interval,
      // the stability timer, the silence watchdog and the connect timer must all be gone.
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
      });
      server = await startWsServer();
      const closes: Array<[number, string]> = [];
      const hanging = new ReconnectingWs({
        url: server.url,
        WebSocketImpl: HangingSocket as unknown as typeof WebSocket,
        closeTimeoutMs: 40,
        onOpen: () => {},
        onMessage: () => {},
        onClose: (code, reason) => closes.push([code, reason]),
      });
      hanging.start();
      if (opened) {
        instances[0]?.open();
      }
      const closing = hanging.close();
      if (opened) {
        vi.advanceTimersByTime(40); // the give-up timer
      }
      await closing;
      // A socket that never opened is not waited for: it is dropped at once.
      expect(closes).toEqual([
        [1006, opened ? 'close_timeout' : 'client_closed'],
      ]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe('send()', () => {
  test('before start() throws UserInputError', async () => {
    server = await startWsServer();
    const { ws } = build();
    expect(() => ws.send('x')).toThrow(UserInputError);
    expect(() => ws.send('x')).toThrow(/onOpen/);
  });

  test('while the socket is still connecting throws UserInputError', async () => {
    server = await startWsServer();
    const { ws } = build();
    ws.start();
    expect(() => ws.send('x')).toThrow(UserInputError);
  });

  test('between a drop and the reconnect throws UserInputError', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server = await startWsServer();
    const { ws, log } = build({ random: () => 1 });
    ws.start();
    const conn = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    conn.drop();
    await waitUntil(() => log.closes.length === 1, 'the close');
    expect(() => ws.send('x')).toThrow(UserInputError);
  });

  test('after close() throws UserInputError', async () => {
    server = await startWsServer();
    const { ws, log } = build();
    ws.start();
    await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    await ws.close();
    expect(() => ws.send('x')).toThrow(UserInputError);
  });

  test('works once open, and a non-string is rejected', async () => {
    server = await startWsServer();
    const { ws, log } = build();
    ws.start();
    const conn = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    ws.send('hello');
    await waitUntil(() => conn.received.length === 1, 'the frame');
    expect(conn.received).toEqual(['hello']);
    expect(() => ws.send(5 as never)).toThrow(UserInputError);
  });

  test('a send function kept from an earlier onOpen sends on the current socket', async () => {
    server = await startWsServer();
    const { ws, log } = build({ backoff: { baseMs: 1, capMs: 5 } });
    ws.start();
    const first = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    first.drop();
    const second = await server.accept();
    await waitUntil(() => log.opens === 2, 'reopen');
    log.sends[0]?.('from the old send');
    await waitUntil(() => second.received.length === 1, 'the frame');
    expect(second.received).toEqual(['from the old send']);
  });
});

describe('messages', () => {
  test('text frames are delivered in order; binary frames are ignored', async () => {
    server = await startWsServer();
    const { ws, log } = build();
    ws.start();
    const conn = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    conn.send('one');
    conn.sendBinary(new TextEncoder().encode('binary'));
    conn.send('two');
    await waitUntil(() => log.messages.length === 2, 'two messages');
    expect(log.messages).toEqual(['one', 'two']);
  });

  test('a callback that throws is reported and does not break the connection', async () => {
    server = await startWsServer();
    const seen: string[] = [];
    const { ws, log } = build({
      onMessage: (data) => {
        seen.push(data);
        if (data === 'bad') {
          throw new Error('handler bug');
        }
      },
    });
    ws.start();
    const conn = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    conn.send('bad');
    conn.send('good');
    await waitUntil(() => seen.length === 2, 'both messages');
    expect(seen).toEqual(['bad', 'good']);
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]?.code).toBe('ws_callback_failed');
    expect(log.errors[0]?.cause).toEqual(new Error('handler bug'));
  });

  test('an onError that throws cannot break the connection either', async () => {
    server = await startWsServer();
    const { ws, log } = build({
      onMessage: () => {
        throw new Error('handler bug');
      },
      onError: () => {
        throw new Error('observer bug');
      },
    });
    ws.start();
    const conn = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    conn.send('x');
    conn.send('y');
    await settle();
    ws.send('still open');
    await waitUntil(() => conn.received.length === 1, 'the frame');
  });
});

describe('WebSocketImpl', () => {
  test('defaults to globalThis.WebSocket', async () => {
    server = await startWsServer();
    const instances: FakeSocket[] = [];
    class StubSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        instances.push(this);
      }
    }
    vi.stubGlobal('WebSocket', StubSocket);
    const instance = new ReconnectingWs({
      url: server.url,
      onOpen: () => {},
      onMessage: () => {},
    });
    ws = instance;
    instance.start();
    expect(instances).toHaveLength(1);
    expect(instances[0]?.url).toBe(server.url);
  });

  test('the option wins over the global', async () => {
    server = await startWsServer();
    const globalCalls: string[] = [];
    class GlobalSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        globalCalls.push(url);
      }
    }
    vi.stubGlobal('WebSocket', GlobalSocket);
    const { ws, log } = build();
    ws.start();
    await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    expect(globalCalls).toEqual([]);
  });

  test("works with Node's own global WebSocket (no WebSocketImpl given)", async () => {
    server = await startWsServer({ echo: true });
    expect(typeof globalThis.WebSocket).toBe('function');
    const { ws, log } = build({
      WebSocketImpl: undefined,
      onOpen: (send) => send('hi'),
    });
    ws.start();
    const conn = await server.accept();
    await waitUntil(() => log.messages.length === 1, 'the echo');
    expect(log.messages).toEqual(['hi']);
    expect(conn.received).toEqual(['hi']);
    await ws.close();
    expect((await conn.closed).code).toBe(1000);
  });

  test('throws a UserInputError naming WebSocketImpl when there is none', async () => {
    server = await startWsServer();
    vi.stubGlobal('WebSocket', undefined);
    const make = () =>
      new ReconnectingWs({
        url: server.url,
        onOpen: () => {},
        onMessage: () => {},
      });
    expect(make).toThrow(UserInputError);
    expect(make).toThrow(/WebSocketImpl/);
  });

  test('throws a UserInputError when WebSocketImpl is not a constructor', async () => {
    server = await startWsServer();
    expect(
      () =>
        new ReconnectingWs({
          url: server.url,
          WebSocketImpl: 'nope' as never,
          onOpen: () => {},
          onMessage: () => {},
        }),
    ).toThrow(/WebSocketImpl/);
  });

  test('an implementation that throws on construction is a reported transport error, then retried', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server = await startWsServer();
    let constructed = 0;
    class Throwing {
      constructor() {
        constructed += 1;
        throw new Error('cannot construct');
      }
    }
    const { ws, log } = build({
      WebSocketImpl: Throwing as unknown as typeof WebSocket,
      random: () => 1,
    });
    ws.start();
    expect(constructed).toBe(1);
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]).toBeInstanceOf(TransportError);
    expect(log.errors[0]?.cause).toEqual(new Error('cannot construct'));
    vi.advanceTimersByTime(250);
    expect(constructed).toBe(2);
    expect(log.opens).toBe(0);
  });
});

describe('sockets that fail or close before they open (Node 22)', () => {
  const node22 = (overrides: Partial<ReconnectingWsOptions> = {}) => {
    Node22Socket.instances = [];
    return build({
      WebSocketImpl: Node22Socket as unknown as typeof WebSocket,
      random: () => 1,
      ...overrides,
    });
  };

  test('an error before the socket opens ends the attempt at once: one transport_error, one onClose, a reconnect after the normal backoff, no connect timeout later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server = await startWsServer();
    const { ws, log } = node22();
    ws.start();
    Node22Socket.instances[0]?.fail();
    expect(log.errors.map((e) => e.code)).toEqual(['transport_error']);
    expect(log.errors[0]).toBeInstanceOf(TransportError);
    expect(log.closes).toEqual([{ code: 1006, reason: 'ws_connect_failed' }]);
    expect(Node22Socket.instances[0]?.closeCalls).toBe(1);
    vi.advanceTimersByTime(249);
    expect(Node22Socket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(Node22Socket.instances).toHaveLength(2);
    // The second attempt opens; the first one's connect timer is gone.
    Node22Socket.instances[1]?.open();
    vi.advanceTimersByTime(10_000);
    expect(log.errors.map((e) => e.code)).toEqual(['transport_error']);
    expect(log.opens).toBe(1);
  });

  test('a late close after that error (Node 24, ws) is not counted again: one onClose, one reconnect, the backoff grows once per attempt', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server = await startWsServer();
    const { ws, log } = node22();
    ws.start();
    Node22Socket.instances[0]?.fail();
    Node22Socket.instances[0]?.lateClose();
    expect(log.closes).toHaveLength(1);
    vi.advanceTimersByTime(250);
    expect(Node22Socket.instances).toHaveLength(2);
    Node22Socket.instances[1]?.fail();
    Node22Socket.instances[1]?.lateClose();
    // 250 ms, then 500 ms: each attempt counted once.
    vi.advanceTimersByTime(499);
    expect(Node22Socket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(Node22Socket.instances).toHaveLength(3);
    expect(log.closes).toHaveLength(2);
    expect(log.errors.map((e) => e.code)).toEqual([
      'transport_error',
      'transport_error',
    ]);
  });

  test('close() while connecting resolves at once although no close event ever comes: one onClose, no error, no timer left', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    server = await startWsServer();
    const { ws, log } = node22();
    ws.start();
    await ws.close(); // no timer advanced
    expect(log.closes).toEqual([{ code: 1006, reason: 'client_closed' }]);
    expect(log.errors).toEqual([]);
    expect(Node22Socket.instances[0]?.closeCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    // A late error or close of that socket reaches nothing.
    Node22Socket.instances[0]?.fail();
    Node22Socket.instances[0]?.lateClose();
    expect(log.closes).toHaveLength(1);
    expect(log.errors).toEqual([]);
  });

  test('an error on an open socket is reported and its close still drives the reconnect', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server = await startWsServer();
    const { ws, log } = node22();
    ws.start();
    const socket = Node22Socket.instances[0];
    socket?.open();
    socket?.dispatchEvent(new Event('error'));
    expect(log.errors.map((e) => e.code)).toEqual(['transport_error']);
    expect(log.closes).toEqual([]);
    socket?.close(1006, '');
    await settle();
    expect(log.closes).toEqual([{ code: 1006, reason: '' }]);
    vi.advanceTimersByTime(250);
    expect(Node22Socket.instances).toHaveLength(2);
  });
});

describe("Node's global WebSocket (the default implementation)", () => {
  test('a server drop reconnects, resubscribes and fires onReconnected', async () => {
    server = await startWsServer();
    const { ws, log } = build({
      WebSocketImpl: undefined,
      backoff: { baseMs: 5, capMs: 20 },
      onOpen: (send) => send('resubscribe'),
    });
    ws.start();
    const first = await server.accept();
    await waitUntil(() => first.received.length === 1, 'first subscribe');
    first.drop();
    const second = await server.accept();
    await waitUntil(() => second.received.length === 1, 'second subscribe');
    await waitUntil(() => log.reconnected === 1, 'onReconnected');
    expect(log.closes[0]?.code).toBe(1006);
  });

  test('a close with code 1008 is reported with its code and reason', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server = await startWsServer();
    const { ws, log } = build({ WebSocketImpl: undefined, random: () => 0 });
    ws.start();
    const conn = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    conn.closeWith(1008, 'max_ws_connections_exceeded');
    await waitUntil(() => log.closes.length === 1, 'the close');
    expect(log.closes[0]).toEqual({
      code: 1008,
      reason: 'max_ws_connections_exceeded',
    });
    expect(log.errors.map((e) => e.code)).toEqual([
      'max_ws_connections_exceeded',
    ]);
  });

  test('a refused connection is a transport error, then retried', async () => {
    server = await startWsServer();
    const url = server.url;
    await server.close(); // nothing listens there now
    const { ws, log } = build({
      url,
      WebSocketImpl: undefined,
      backoff: { baseMs: 5, capMs: 10 },
    });
    ws.start();
    await waitUntil(() => log.closes.length >= 2, 'two failed attempts');
    expect(log.opens).toBe(0);
    expect(log.errors[0]).toBeInstanceOf(TransportError);
    await ws.close();
  });

  test('close() while the socket is still connecting resolves at once', async () => {
    server = await startWsServer();
    const { ws, log } = build({ WebSocketImpl: undefined });
    ws.start();
    const started = performance.now();
    await ws.close();
    expect(performance.now() - started).toBeLessThan(1_000);
    await settle();
    expect(log.opens).toBe(0);
    expect(log.errors).toEqual([]);
  });
});

describe('stale-socket watchdog', () => {
  /** Fakes every timer the watchdog and the keepalive use; the sockets stay real. */
  const fakeAllTimers = () =>
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'performance',
      ],
    });

  test('a server that accepts but never answers: ws_stale at 2.5 intervals, then a reconnect with onOpen again', async () => {
    fakeAllTimers();
    // Takes the connection, ignores every PING, sends nothing.
    server = await startWsServer({ pong: false });
    const { ws, log } = build({ random: () => 1 });
    ws.start();
    const first = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');

    vi.advanceTimersByTime(24_999); // 2.5 x 10 s, less a millisecond
    await waitUntil(() => first.received.length === 2, 'two PINGs sent');
    expect(first.received).toEqual(['PING', 'PING']); // pings went out, nothing came back
    expect(log.errors).toEqual([]);
    expect(log.closes).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]).toBeInstanceOf(XoError);
    expect(log.errors[0]?.code).toBe('ws_stale');
    expect(log.errors[0]?.service).toBe('orderbook');
    // onClose reports the abandoned socket as an abnormal closure.
    expect(log.closes).toEqual([{ code: 1006, reason: 'ws_stale' }]);
    // The dead socket is closed with an application code, not left open.
    expect(await first.closed).toEqual({ code: 4000, reason: 'ws_stale' });
    expect(() => ws.send('x')).toThrow(UserInputError);

    // Normal backoff: random() = 1 gives the ceiling, 250 ms for the first reconnect.
    vi.advanceTimersByTime(249);
    await settle();
    expect(server.connections).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await server.accept();
    await waitUntil(() => log.opens === 2, 'onOpen again');
    await waitUntil(() => log.reconnected === 1, 'onReconnected');
  });

  test('a stale reconnect keeps backing off: 250 ms, then 500 ms', async () => {
    fakeAllTimers();
    server = await startWsServer({ pong: false });
    const { ws, log } = build({ random: () => 1 });
    ws.start();
    await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    vi.advanceTimersByTime(25_000);
    expect(log.errors.map((e) => e.code)).toEqual(['ws_stale']);
    vi.advanceTimersByTime(250);
    await server.accept();
    await waitUntil(() => log.opens === 2, 'second open');
    vi.advanceTimersByTime(25_000);
    expect(log.errors.map((e) => e.code)).toEqual(['ws_stale', 'ws_stale']);
    vi.advanceTimersByTime(499);
    await settle();
    expect(server.connections).toHaveLength(2);
    vi.advanceTimersByTime(1);
    await server.accept();
    await waitUntil(() => log.opens === 3, 'third open');
  });

  test('the deadline follows pingIntervalMs: 2.5 x 2000 ms = 5000 ms', async () => {
    fakeAllTimers();
    server = await startWsServer({ pong: false });
    const { ws, log } = build({ pingIntervalMs: 2_000 });
    ws.start();
    await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    vi.advanceTimersByTime(4_999);
    expect(log.errors).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(log.errors.map((e) => e.code)).toEqual(['ws_stale']);
  });

  test('every frame resets the deadline, a text frame and a binary frame alike', async () => {
    fakeAllTimers();
    server = await startWsServer({ pong: false });
    const { ws, log } = build();
    ws.start();
    const conn = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');

    vi.advanceTimersByTime(20_000);
    conn.send('hello');
    await waitUntil(() => log.messages.length === 1, 'the text frame');
    vi.advanceTimersByTime(24_999); // 20 s + 24.999 s, past the original 25 s mark
    expect(log.errors).toEqual([]);

    conn.sendBinary(new TextEncoder().encode('bin')); // ignored by onMessage, but it is a frame
    await settle();
    vi.advanceTimersByTime(24_999);
    expect(log.errors).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(log.errors.map((e) => e.code)).toEqual(['ws_stale']);
  });

  test('"PONG" resets the deadline: a healthy keepalive never goes stale', async () => {
    fakeAllTimers();
    server = await startWsServer(); // answers every PING with PONG
    const { ws, log } = build();
    ws.start();
    const conn = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    // Two minutes of silence apart from the PONGs, ten seconds at a time.
    for (let step = 1; step <= 12; step += 1) {
      vi.advanceTimersByTime(10_000);
      await waitUntil(() => conn.received.length === step, `PING ${step}`);
      await settle(20); // the PONG travels back
    }
    expect(log.errors).toEqual([]);
    expect(log.messages).toEqual([]); // PONG is still never surfaced
    expect(server.connections).toHaveLength(1);
  });

  test('close() cancels the watchdog', async () => {
    fakeAllTimers();
    server = await startWsServer({ pong: false });
    const { ws, log } = build();
    ws.start();
    const conn = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    // The ping interval, the stability timer and the watchdog.
    expect(vi.getTimerCount()).toBe(3);
    await ws.close();
    // The test server runs in this process and its own `ws` close timer is faked too, so let
    // the server side finish closing before counting what is left.
    await conn.closed;
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(log.errors).toEqual([]);
  });

  test('a stale error is not reported after close()', async () => {
    fakeAllTimers();
    server = await startWsServer({ pong: false });
    const { ws, log } = build({ onClose: undefined });
    ws.start();
    await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    vi.advanceTimersByTime(24_999);
    await ws.close();
    vi.advanceTimersByTime(60_000);
    expect(log.errors).toEqual([]);
  });
});

describe('connect timeout', () => {
  test('an attempt that never opens is abandoned after 10 s with ws_connect_timeout, then retried', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    silent = await startSilentTcpServer(); // takes the TCP connection, never answers the upgrade
    server = await startWsServer();
    const { ws, log } = build({ url: silent.url, random: () => 1 });
    ws.start();
    await waitUntil(() => silent?.accepted() === 1, 'the first TCP connection');

    vi.advanceTimersByTime(9_999);
    await settle();
    expect(log.errors).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]).toBeInstanceOf(XoError);
    expect(log.errors[0]?.code).toBe('ws_connect_timeout');
    expect(log.errors[0]?.service).toBe('orderbook');
    expect(log.closes).toEqual([{ code: 1006, reason: 'ws_connect_timeout' }]);
    expect(log.opens).toBe(0);
    // The abandoned attempt does not hold its TCP connection: the server sees it end.
    await waitUntil(
      () => silent?.closed() === 1,
      'the TCP connection to be released',
    );

    // Retried with the normal backoff (250 ms at the ceiling), and times out again.
    vi.advanceTimersByTime(249);
    await settle();
    expect(silent.accepted()).toBe(1);
    vi.advanceTimersByTime(1);
    await waitUntil(() => silent?.accepted() === 2, 'the retry');
    vi.advanceTimersByTime(10_000);
    expect(log.errors.map((e) => e.code)).toEqual([
      'ws_connect_timeout',
      'ws_connect_timeout',
    ]);
    // 250 ms, then 500 ms.
    vi.advanceTimersByTime(499);
    await settle();
    expect(silent.accepted()).toBe(2);
    vi.advanceTimersByTime(1);
    await waitUntil(() => silent?.accepted() === 3, 'the second retry');
  });

  test('connectTimeoutMs sets the wait (real timers)', async () => {
    silent = await startSilentTcpServer();
    server = await startWsServer();
    const { ws, log } = build({
      url: silent.url,
      connectTimeoutMs: 40,
      backoff: { baseMs: 5, capMs: 10 },
    });
    ws.start();
    await waitUntil(
      () =>
        log.errors.filter((e) => e.code === 'ws_connect_timeout').length >= 2,
      'two connect timeouts',
      5_000,
    );
    expect(silent.accepted()).toBeGreaterThanOrEqual(2);
    expect(log.opens).toBe(0);
  });

  test('a connection that opens in time is not abandoned later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server = await startWsServer();
    const { ws, log } = build({ pingIntervalMs: 50_000 });
    ws.start();
    await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    vi.advanceTimersByTime(60_000);
    expect(log.errors).toEqual([]);
    expect(server.connections).toHaveLength(1);
  });

  test('a connect timeout is recoverable: a good server on the retry opens normally', async () => {
    // First attempt hangs; after the timeout the owner is pointed at nothing new, so use a
    // failing then working implementation instead of two servers.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server = await startWsServer();
    silent = await startSilentTcpServer();
    let attempts = 0;
    class HangFirst extends WsClient {
      constructor(url: string) {
        attempts += 1;
        super(attempts === 1 ? (silent?.url ?? url) : url);
      }
    }
    const { ws, log } = build({
      WebSocketImpl: HangFirst as unknown as typeof WebSocket,
      random: () => 0,
    });
    ws.start();
    await waitUntil(() => silent?.accepted() === 1, 'the hanging attempt');
    vi.advanceTimersByTime(10_000);
    expect(log.errors.map((e) => e.code)).toEqual(['ws_connect_timeout']);
    // A zero delay scheduled from inside a timer callback is due 1 ms later in fake time.
    vi.advanceTimersByTime(1);
    await server.accept();
    await waitUntil(() => log.opens === 1, 'the working attempt');
    expect(log.reconnected).toBe(0); // the first successful open is not a reconnect
  });

  test('close() cancels the connect timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    silent = await startSilentTcpServer();
    server = await startWsServer();
    const { ws, log } = build({ url: silent.url });
    ws.start();
    await waitUntil(() => silent?.accepted() === 1, 'the TCP connection');
    expect(vi.getTimerCount()).toBe(1); // the connect timer
    await ws.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(log.errors).toEqual([]);
    expect(silent.accepted()).toBe(1);
  });

  test('connectTimeoutMs must be a positive whole number', () => {
    const make = (connectTimeoutMs: unknown) =>
      new ReconnectingWs({
        url: 'ws://127.0.0.1:1',
        WebSocketImpl: WsImpl,
        connectTimeoutMs: connectTimeoutMs as number,
        onOpen: () => {},
        onMessage: () => {},
      });
    for (const bad of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '10',
    ]) {
      expect(() => make(bad)).toThrow(UserInputError);
      expect(() => make(bad)).toThrow(/connectTimeoutMs/);
    }
    expect(() => make(1)).not.toThrow();
    expect(() => make(undefined)).not.toThrow();
  });
});

describe('abandoned sockets', () => {
  const fakeAllTimers = () =>
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'performance',
      ],
    });

  /** A socket that never completes the closing handshake started with the abandon code. */
  class SelectiveSocket extends FakeSocket {
    static instances: SelectiveSocket[] = [];
    constructor(url: string) {
      super(url);
      SelectiveSocket.instances.push(this);
    }
    override close(code = 1000, reason = ''): void {
      if (code === 4000) {
        this.readyState = 2; // CLOSING, and the 'close' event never comes by itself
        return;
      }
      super.close(code, reason);
    }
    finishClosing(): void {
      this.readyState = 3;
      this.dispatchEvent(
        Object.assign(new Event('close'), { code: 1006, reason: '' }),
      );
    }
  }

  test('a stale ws socket is terminated at once; its late close does not reach onClose again', async () => {
    fakeAllTimers();
    server = await startWsServer({ pong: false });
    const sockets: WsClient[] = [];
    class Capture extends WsClient {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
    const { ws, log } = build({
      WebSocketImpl: Capture as unknown as typeof WebSocket,
      random: () => 1,
    });
    ws.start();
    const conn = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    conn.stopReading(); // the peer hangs: it will never answer anything, a close frame included

    vi.advanceTimersByTime(25_000);
    expect(log.errors.map((e) => e.code)).toEqual(['ws_stale']);
    // close() alone leaves a ws socket CLOSING until its 30 s close timeout; terminate() frees it.
    await waitUntil(
      () => sockets[0]?.readyState === WsClient.CLOSED,
      'the stale socket to be terminated',
    );
    await settle();
    // onClose ran once, when the socket was abandoned. The late close event is not reported.
    expect(log.closes).toEqual([{ code: 1006, reason: 'ws_stale' }]);
  });

  test('close() resolves within about closeTimeoutMs when the peer stops reading, and terminates the ws socket', async () => {
    server = await startWsServer();
    const sockets: WsClient[] = [];
    class Capture extends WsClient {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
    const { ws, log } = build({
      WebSocketImpl: Capture as unknown as typeof WebSocket,
      closeTimeoutMs: 100,
    });
    ws.start();
    const conn = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    conn.stopReading();

    const started = performance.now();
    await ws.close();
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(90);
    expect(waited).toBeLessThan(2_000);
    expect(log.closes).toEqual([{ code: 1006, reason: 'close_timeout' }]);
    // The give-up also terminates the socket instead of leaving it to the 30 s close timeout.
    await waitUntil(
      () => sockets[0]?.readyState === WsClient.CLOSED,
      'the socket to be terminated',
    );
    await settle();
    expect(log.closes).toHaveLength(1); // its late close is not reported twice
  });

  test('close() waits for an abandoned socket, but only for closeTimeoutMs', async () => {
    fakeAllTimers();
    SelectiveSocket.instances = [];
    server = await startWsServer();
    const closes: Array<[number, string]> = [];
    const stuck = new ReconnectingWs({
      url: server.url,
      WebSocketImpl: SelectiveSocket as unknown as typeof WebSocket,
      closeTimeoutMs: 40,
      random: () => 1,
      onOpen: () => {},
      onMessage: () => {},
      onClose: (code, reason) => closes.push([code, reason]),
    });
    stuck.start();
    SelectiveSocket.instances[0]?.open();
    vi.advanceTimersByTime(25_000); // stale: abandoned, a reconnect is pending
    expect(closes).toEqual([[1006, 'ws_stale']]);

    let done = false;
    const closing = stuck.close().then(() => {
      done = true;
    });
    await settle(10);
    expect(done).toBe(false); // the abandoned socket has not finished closing
    vi.advanceTimersByTime(39);
    await settle(10);
    expect(done).toBe(false);
    vi.advanceTimersByTime(1); // closeTimeoutMs
    await closing;
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(closes).toEqual([[1006, 'ws_stale']]);
  });

  test('close() resolves as soon as the active socket AND the abandoned one have closed', async () => {
    fakeAllTimers();
    SelectiveSocket.instances = [];
    server = await startWsServer();
    const closes: Array<[number, string]> = [];
    const stuck = new ReconnectingWs({
      url: server.url,
      WebSocketImpl: SelectiveSocket as unknown as typeof WebSocket,
      closeTimeoutMs: 5_000,
      random: () => 1,
      onOpen: () => {},
      onMessage: () => {},
      onClose: (code, reason) => closes.push([code, reason]),
    });
    stuck.start();
    SelectiveSocket.instances[0]?.open();
    vi.advanceTimersByTime(25_000); // the first socket is abandoned and hangs
    vi.advanceTimersByTime(250); // the reconnect
    expect(SelectiveSocket.instances).toHaveLength(2);
    SelectiveSocket.instances[1]?.open();

    let done = false;
    const closing = stuck.close().then(() => {
      done = true;
    });
    await settle(10); // the active socket closes normally...
    expect(closes).toEqual([
      [1006, 'ws_stale'],
      [1000, 'client_closed'],
    ]);
    expect(done).toBe(false); // ...but the abandoned one has not
    SelectiveSocket.instances[0]?.finishClosing(); // now it has
    await closing;
    expect(done).toBe(true);
    expect(closes).toHaveLength(2); // the late close of the abandoned socket is not reported
  });

  test('a connect-timeout socket never opened, so close() does not wait for it', async () => {
    fakeAllTimers();
    SelectiveSocket.instances = [];
    server = await startWsServer();
    const closes: Array<[number, string]> = [];
    const stuck = new ReconnectingWs({
      url: server.url,
      WebSocketImpl: SelectiveSocket as unknown as typeof WebSocket,
      closeTimeoutMs: 40,
      onOpen: () => {},
      onMessage: () => {},
      onClose: (code, reason) => closes.push([code, reason]),
    });
    stuck.start(); // never opens
    vi.advanceTimersByTime(10_000);
    await stuck.close(); // no timer advanced: it resolves at once
    expect(closes).toEqual([[1006, 'ws_connect_timeout']]);
    // Its late close changes nothing.
    SelectiveSocket.instances[0]?.finishClosing();
    await settle();
    expect(closes).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('callback errors are throttled', () => {
  test('a callback that throws on every message is reported at most once a second per socket', async () => {
    vi.useFakeTimers({ toFake: ['performance'] }); // only the clock; the sockets and timers stay real
    server = await startWsServer();
    let calls = 0;
    const { ws, log } = build({
      backoff: { baseMs: 1, capMs: 5 },
      onMessage: () => {
        calls += 1;
        throw new Error('bug');
      },
    });
    ws.start();
    const first = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    for (let i = 0; i < 20; i += 1) {
      first.send(`m${i}`);
    }
    await waitUntil(() => calls === 20, 'twenty deliveries');
    expect(log.errors.map((e) => e.code)).toEqual(['ws_callback_failed']);

    vi.advanceTimersByTime(999);
    first.send('again');
    await waitUntil(() => calls === 21, 'one more');
    expect(log.errors).toHaveLength(1);

    vi.advanceTimersByTime(1); // a full second since the first report
    first.send('and again');
    await waitUntil(() => calls === 22, 'and one more');
    expect(log.errors).toHaveLength(2);

    // The limit is per socket: a new connection reports its first failure at once.
    first.drop();
    const second = await server.accept();
    await waitUntil(() => log.opens === 2, 'reconnect');
    second.send('fresh');
    await waitUntil(() => calls === 23, 'a delivery on the new socket');
    const callbackErrors = log.errors.filter(
      (e) => e.code === 'ws_callback_failed',
    );
    expect(callbackErrors).toHaveLength(3);
  });
});

describe('reconnect()', () => {
  test('drops the open socket, reports onClose(1006, reason) at once and reconnects: onOpen, then onReconnected', async () => {
    server = await startWsServer();
    const { ws, log } = build({
      backoff: { baseMs: 1, capMs: 5 },
      onOpen: (send) => send('subscribe'),
    });
    ws.start();
    const first = await server.accept();
    await waitUntil(() => first.received.length === 1, 'first subscribe');

    ws.reconnect('ws_subscribe_refused');
    // onClose runs synchronously: the owner can rely on it before the next open.
    expect(log.closes).toEqual([
      { code: 1006, reason: 'ws_subscribe_refused' },
    ]);
    const closed = await first.closed;
    expect(closed.code).toBe(4000);

    const second = await server.accept();
    await waitUntil(() => log.reconnected === 1, 'onReconnected');
    // onOpen ran again on the new socket (the override replaces the counting one).
    expect(second.received).toEqual(['subscribe']);
    expect(first.received).toEqual(['subscribe']);
    // The owner asked for it: no error is reported.
    expect(log.errors).toEqual([]);
  });

  test('follows the normal backoff, and the attempt counter keeps growing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server = await startWsServer();
    // The ceiling doubles: 250, then 500. random() = 1 makes each delay the ceiling.
    const { ws, log } = build({ random: () => 1 });
    ws.start();
    await server.accept();
    await waitUntil(() => log.opens === 1, 'open');

    ws.reconnect('again');
    vi.advanceTimersByTime(249);
    await settle();
    expect(server.connections).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await server.accept();
    await waitUntil(() => log.opens === 2, 'second open');

    ws.reconnect('again');
    vi.advanceTimersByTime(499);
    await settle();
    expect(server.connections).toHaveLength(2);
    vi.advanceTimersByTime(1);
    await server.accept();
    await waitUntil(() => log.opens === 3, 'third open');
  });

  test('is a no-op before start(), while waiting to reconnect, and after close()', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server = await startWsServer();
    const { ws, log } = build({ random: () => 1 });
    ws.reconnect('early');
    await settle();
    expect(server.connections).toHaveLength(0);

    ws.start();
    const first = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    first.drop();
    await waitUntil(() => log.closes.length === 1, 'drop seen');
    ws.reconnect('while waiting'); // no socket: nothing to drop
    expect(log.closes).toHaveLength(1);

    await ws.close();
    ws.reconnect('after close');
    vi.advanceTimersByTime(60_000);
    await settle();
    expect(server.connections).toHaveLength(1);
  });

  test('the reason must be a string; a long one is cut to 123 bytes of UTF-8 on a character boundary', async () => {
    server = await startWsServer();
    const { ws, log } = build({ backoff: { baseMs: 1, capMs: 5 } });
    expect(() => ws.reconnect(42 as never)).toThrow(UserInputError);
    ws.start();
    const first = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');

    // 'é' is 2 bytes and '😀' is 4 (a surrogate pair): neither may be split.
    const long = `${'é'.repeat(60)}😀😀`;
    ws.reconnect(long);
    const cut = `${'é'.repeat(60)}`; // 120 bytes; one more emoji would be 124
    expect(new TextEncoder().encode(cut).length).toBe(120);
    expect(log.closes).toEqual([{ code: 1006, reason: cut }]);
    expect(await first.closed).toEqual({ code: 4000, reason: cut });

    const second = await server.accept();
    await waitUntil(() => log.opens === 2, 'second open');
    ws.reconnect('x'.repeat(200));
    expect(log.closes[1]).toEqual({ code: 1006, reason: 'x'.repeat(123) });
    expect((await second.closed).reason).toBe('x'.repeat(123));
  });

  test('close() waits for the dropped socket like any abandoned one', async () => {
    server = await startWsServer();
    const { ws, log } = build({ backoff: { baseMs: 1, capMs: 5 } });
    ws.start();
    const first = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    ws.reconnect('drop');
    await server.accept();
    await waitUntil(() => log.opens === 2, 'second open');
    await ws.close();
    await first.closed;
    expect(log.closes.map((c) => c.reason)).toEqual(['drop', 'client_closed']);
  });
});

describe('timers', () => {
  test('none is unref()ed: a live connection keeps the process alive', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    server = await startWsServer();
    const { ws, log } = build({ random: () => 1 });
    ws.start();
    const conn = await server.accept();
    await waitUntil(() => log.opens === 1, 'open');
    conn.drop();
    await waitUntil(() => log.closes.length === 1, 'the close');
    // The ping timer, the stability timer, and the reconnect timer that is now pending.
    const handles = [...intervals.mock.results, ...timeouts.mock.results].map(
      (r) => r.value as { hasRef(): boolean },
    );
    expect(intervals.mock.results).toHaveLength(1);
    expect(handles.length).toBeGreaterThanOrEqual(3);
    for (const handle of handles) {
      expect(handle.hasRef()).toBe(true);
    }
  });
});

describe('options', () => {
  test('url must be a ws:// or wss:// URL', () => {
    for (const bad of ['', 'not a url', 'http://example.com', 'https://x', 5]) {
      expect(
        () =>
          new ReconnectingWs({
            url: bad as string,
            WebSocketImpl: WsImpl,
            onOpen: () => {},
            onMessage: () => {},
          }),
      ).toThrow(UserInputError);
    }
    for (const good of ['ws://localhost:1', 'wss://example.com/ws/market']) {
      expect(
        () =>
          new ReconnectingWs({
            url: good,
            WebSocketImpl: WsImpl,
            onOpen: () => {},
            onMessage: () => {},
          }),
      ).not.toThrow();
    }
  });

  test('timer options are capped at 2_147_483_647 ms, the largest delay setTimeout honours', () => {
    const MAX = 2_147_483_647;
    const make = (extra: Partial<ReconnectingWsOptions>) =>
      new ReconnectingWs({
        url: 'ws://127.0.0.1:1',
        WebSocketImpl: WsImpl,
        onOpen: () => {},
        onMessage: () => {},
        ...extra,
      });
    const cases: Array<[string, (value: number) => void]> = [
      ['backoff.capMs', (v) => make({ backoff: { baseMs: 1, capMs: v } })],
      ['stableAfterMs', (v) => make({ stableAfterMs: v })],
      ['closeTimeoutMs', (v) => make({ closeTimeoutMs: v })],
      ['connectTimeoutMs', (v) => make({ connectTimeoutMs: v })],
    ];
    for (const [name, build] of cases) {
      expect(() => build(MAX + 1), name).toThrow(UserInputError);
      expect(() => build(MAX + 1), name).toThrow(new RegExp(name));
      expect(() => build(MAX), name).not.toThrow();
    }
  });

  test('onOpen and onMessage are required functions', () => {
    const base = { url: 'ws://localhost:1', WebSocketImpl: WsImpl };
    expect(
      () => new ReconnectingWs({ ...base, onMessage: () => {} } as never),
    ).toThrow(UserInputError);
    expect(
      () => new ReconnectingWs({ ...base, onOpen: () => {} } as never),
    ).toThrow(UserInputError);
  });

  test('constructing starts nothing: no socket, no timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    server = await startWsServer();
    build();
    await settle();
    expect(server.connections).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * A minimal stand-in for a WebSocket, for the few tests that need an implementation that
 * misbehaves (never closes, throws). It never touches the network.
 */
class FakeSocket extends EventTarget {
  readyState = 0;
  readonly sent: string[] = [];
  constructor(readonly url: string) {
    super();
  }
  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
  send(text: string): void {
    this.sent.push(text);
  }
  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    queueMicrotask(() =>
      this.dispatchEvent(Object.assign(new Event('close'), { code, reason })),
    );
  }
}

/**
 * A socket that fails as Node 22's global WebSocket does: a refused connection fires `error` and
 * never `close`, and `close()` while connecting fires nothing at all. `lateClose()` adds the
 * `close` that Node 24 and the `ws` package fire after such an error.
 */
class Node22Socket extends FakeSocket {
  static instances: Node22Socket[] = [];
  closeCalls = 0;
  constructor(url: string) {
    super(url);
    Node22Socket.instances.push(this);
  }
  override close(code = 1000, reason = ''): void {
    this.closeCalls += 1;
    if (this.readyState !== 1) {
      this.readyState = 3; // and no event, ever
      return;
    }
    super.close(code, reason);
  }
  fail(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event('error'));
  }
  lateClose(): void {
    this.dispatchEvent(
      Object.assign(new Event('close'), { code: 1006, reason: '' }),
    );
  }
}
