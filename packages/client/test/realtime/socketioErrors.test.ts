import { afterEach, describe, expect, test, vi } from 'vitest';
import { Session } from '../../src/auth/session';
import { Clock } from '../../src/core/clock';
import {
  AuthRequiredError,
  TransportError,
  XoError,
} from '../../src/core/errors';
import { Transport } from '../../src/core/transport';
import { BackendRealtime } from '../../src/realtime/socketio';
import {
  type MockConnection,
  startSocketBackend,
} from '../helpers/socketBackend';
import {
  backends,
  caught,
  cleanupSockets,
  credential,
  fakeSession,
  KEY_1,
  KEY_2,
  KEY_ODD,
  rig,
  summaryRow,
  surface,
  watch,
} from '../helpers/socketRig';
import { testEnv } from '../helpers/testEnv';
import { settle, waitUntil } from '../helpers/wsServer';

// The backend's Socket.IO channels: `/portfolio` refusals, coded errors,
// credentials, reconnects and close, against the in-process server of
// test/helpers/socketBackend.ts. No live endpoint.

// Every test waits out at least one 1000 ms subscribe delay, some several.
vi.setConfig({ testTimeout: 15_000 });

afterEach(cleanupSockets);

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('portfolioChannel: refusals', () => {
  test("'Authentication failed': onUnauthorized with the sent key, then one reconnect with the new key", async () => {
    const r = await rig({ session: fakeSession({ keys: [KEY_1, KEY_2] }) });
    r.backend.portfolioAuth = (token) =>
      token === KEY_1
        ? 'Authentication failed'
        : { userId: 7, scopes: ['account:read'] };
    const log = watch(r.rt.portfolioChannel());
    await r.backend.accept('/portfolio');
    const second = await r.backend.accept('/portfolio');
    expect(second.handshake.auth).toEqual({ token: KEY_2 });
    expect(r.fake?.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(r.fake?.onUnauthorized).toHaveBeenCalledWith('backend', {
      headers: { Authorization: `Bearer ${KEY_1}` },
    });
    await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
    expect(log.errors.map((e) => e.code)).toEqual(['ws_auth_refused']);
    expect(log.reconnected).toBe(0);
  });

  test("'Authentication failed' that the session cannot refresh is permanent: reported once, closed", async () => {
    const r = await rig({
      session: fakeSession({ onUnauthorized: async () => false }),
    });
    r.backend.portfolioAuth = () => 'Authentication failed';
    const log = watch(r.rt.portfolioChannel());
    await r.backend.accept('/portfolio');
    await waitUntil(() => log.closed === 1, 'closed');
    expect(log.errors.map((e) => e.code)).toEqual(['ws_auth_unrecoverable']);
    expect(log.errors[0]?.message).toContain('Authentication failed');
    await settle(100);
    expect(r.backend.connections).toHaveLength(1);
    expect(r.fake?.ensureBackend).toHaveBeenCalledTimes(1);
  });

  test("'Authentication failed' with a real Session and a provided key (no signer): permanent", async () => {
    const transport = new Transport({ env: testEnv, version: 't' });
    const session = new Session({
      env: testEnv,
      transport,
      clock: new Clock({
        fetchServerTimeSec: async () => Math.floor(Date.now() / 1000),
      }),
      credentials: { backend: { apiKey: KEY_1 } },
      readContract: async () => '0x',
      warn: vi.fn(),
    });
    const refresh = vi.spyOn(session, 'onUnauthorized');
    const r = await rig({ session });
    r.backend.portfolioAuth = () => 'Authentication failed';
    const log = watch(r.rt.portfolioChannel());
    const conn = await r.backend.accept('/portfolio');
    expect(conn.handshake.auth).toEqual({ token: KEY_1 });
    await waitUntil(() => log.closed === 1, 'closed');
    expect(await refresh.mock.results[0]?.value).toBe(false);
    expect(log.errors.map((e) => e.code)).toEqual(['ws_auth_unrecoverable']);
    await settle(100);
    expect(r.backend.connections).toHaveLength(1);
  });

  test("'Authentication failed' when the refresh throws: transient retries, anything else stops", async () => {
    let attempt = 0;
    const r = await rig({
      session: fakeSession({
        onUnauthorized: async () => {
          attempt += 1;
          throw attempt === 1
            ? new TransportError('login failed')
            : new AuthRequiredError('no signer');
        },
      }),
    });
    r.backend.portfolioAuth = () => 'Authentication failed';
    const log = watch(r.rt.portfolioChannel());
    await waitUntil(() => log.closed === 1, 'closed', 4_000);
    expect(log.errors.map((e) => e.code)).toEqual([
      'ws_auth_failed',
      'ws_auth_unrecoverable',
    ]);
    expect(r.backend.connections).toHaveLength(2);
  });

  test("'Authentication unavailable' retries with the backoff", async () => {
    const r = await rig();
    r.backend.portfolioAuth = (_token, conn) =>
      conn === r.backend.connections[0]
        ? 'Authentication unavailable'
        : { userId: 7, scopes: ['account:read'] };
    const log = watch(r.rt.portfolioChannel());
    await r.backend.accept('/portfolio');
    await r.backend.accept('/portfolio');
    await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
    expect(log.errors.map((e) => e.code)).toEqual(['ws_auth_failed']);
    expect(log.errors[0]?.message).toContain('Authentication unavailable');
    expect(r.fake?.onUnauthorized).not.toHaveBeenCalled();
  });

  test("'Authentication required' on connect retries with the backoff", async () => {
    const r = await rig();
    r.backend.portfolioAuth = (_token, conn) =>
      conn === r.backend.connections[0]
        ? 'Authentication required'
        : { userId: 7, scopes: ['account:read'] };
    const log = watch(r.rt.portfolioChannel());
    await r.backend.accept('/portfolio');
    await r.backend.accept('/portfolio');
    await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
    expect(log.errors.map((e) => e.code)).toEqual(['ws_auth_failed']);
  });

  for (const message of ['User not found', 'Account restricted']) {
    test(`'${message}' is permanent: reported once, stopped and closed`, async () => {
      const r = await rig();
      r.backend.portfolioAuth = () => message;
      const log = watch(r.rt.portfolioChannel());
      await r.backend.accept('/portfolio');
      await waitUntil(() => log.closed === 1, 'closed');
      expect(log.errors).toHaveLength(1);
      expect(log.errors[0]?.code).toBe('ws_auth_unrecoverable');
      expect(log.errors[0]?.message).toContain(message);
      await settle(100);
      expect(r.backend.connections).toHaveLength(1);
      expect(r.fake?.onUnauthorized).not.toHaveBeenCalled();
    });
  }

  test('an unknown uncoded refusal degrades to a backoff reconnect, never a stop', async () => {
    const r = await rig();
    r.backend.portfolioAuth = (_token, conn) =>
      conn === r.backend.connections[0]
        ? 'Something new went wrong'
        : { userId: 7, scopes: ['account:read'] };
    const log = watch(r.rt.portfolioChannel());
    await r.backend.accept('/portfolio');
    await r.backend.accept('/portfolio');
    await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
    expect(log.errors.map((e) => e.code)).toEqual(['ws_server_error']);
    expect(log.closed).toBe(0);
  });

  test('API_KEY_INVALID (the key was revoked): reported with its code, the key refreshed, reconnected', async () => {
    const r = await rig({ session: fakeSession({ keys: [KEY_1, KEY_2] }) });
    const log = watch(r.rt.portfolioChannel());
    const first = await r.backend.accept('/portfolio');
    await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
    // The backend's key monitor: the error, then a server disconnect.
    first.socket.emit('portfolio_error', {
      message: 'API key is no longer valid',
      code: 'API_KEY_INVALID',
    });
    first.socket.disconnect(true);
    const second = await r.backend.accept('/portfolio');
    expect(second.handshake.auth).toEqual({ token: KEY_2 });
    await waitUntil(() => log.events.length === 2, 'the new snapshot');
    expect(r.fake?.onUnauthorized).toHaveBeenCalledWith('backend', {
      headers: { Authorization: `Bearer ${KEY_1}` },
    });
    expect(log.errors.map((e) => e.code)).toEqual(['API_KEY_INVALID']);
    expect(log.reconnected).toBe(1);
  });

  test('a key refused right after a successful refresh: the session is asked once, then the channel stops', async () => {
    const r = await rig({
      session: fakeSession({
        keys: [KEY_1, KEY_2, `xo_sk_test_${'c'.repeat(40)}`],
        onUnauthorized: async () => true,
      }),
    });
    r.backend.portfolioAuth = () => 'Authentication failed';
    const log = watch(r.rt.portfolioChannel());
    await waitUntil(() => log.closed === 1, 'closed', 4_000);
    expect(r.fake?.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(log.errors.map((e) => e.code)).toEqual([
      'ws_auth_refused',
      'ws_auth_unrecoverable',
    ]);
    expect(log.errors[1]?.message).toContain(
      'right after the session replaced it',
    );
    expect(r.backend.connections.map((c) => c.handshake.auth.token)).toEqual([
      KEY_1,
      KEY_2,
    ]);
    await settle(100);
    expect(r.backend.connections).toHaveLength(2);
  });

  test('a refresh guard ends with a confirmed subscription: a later refusal asks the session again', async () => {
    const r = await rig({
      session: fakeSession({ keys: [KEY_1, KEY_2, KEY_ODD] }),
    });
    // KEY_1 is refused, KEY_2 works, then is revoked; KEY_ODD works.
    r.backend.portfolioAuth = (token) =>
      token === KEY_1
        ? 'Authentication failed'
        : { userId: 7, scopes: ['account:read'] };
    const log = watch(r.rt.portfolioChannel());
    await r.backend.accept('/portfolio');
    const second = await r.backend.accept('/portfolio');
    await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
    second.socket.emit('portfolio_error', {
      message: 'API key is no longer valid',
      code: 'API_KEY_INVALID',
    });
    second.socket.disconnect(true);
    const third = await r.backend.accept('/portfolio');
    expect(third.handshake.auth).toEqual({ token: KEY_ODD });
    await waitUntil(() => log.events.length === 2, 'the next snapshot');
    expect(r.fake?.onUnauthorized).toHaveBeenCalledTimes(2);
    expect(log.closed).toBe(0);
  });

  test("after a drop, exactly one new connection: Socket.IO's own reconnection is off", async () => {
    const r = await rig();
    const log = watch(r.rt.portfolioChannel());
    const first = await r.backend.accept('/portfolio');
    await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
    first.drop();
    await r.backend.accept('/portfolio');
    // Socket.IO's own reconnection would come back within 0.5 to 1.5 s, on top.
    await settle(2_500);
    expect(r.backend.connections).toHaveLength(2);
    expect(log.reconnected).toBe(1);
  });

  test('the backoff grows while connections fail, and starts over once one stayed up stableAfterMs', async () => {
    const r = await rig({
      connection: {
        backoff: { baseMs: 300, capMs: 10_000 },
        // The ceiling itself: 300, 600, 1200, 2400 ms.
        random: () => 1,
        stableAfterMs: 100,
      },
    });
    r.backend.portfolioAuth = (_token, conn) =>
      r.backend.connections.indexOf(conn) < 3
        ? 'Authentication unavailable'
        : { userId: 7, scopes: ['account:read'] };
    const log = watch(r.rt.portfolioChannel());
    const conns: MockConnection[] = [];
    for (let i = 0; i < 4; i += 1) {
      conns.push(await r.backend.accept('/portfolio'));
    }
    const at = (i: number): number => (conns[i] as MockConnection).connectedAt;
    expect(at(1) - at(0)).toBeGreaterThanOrEqual(300);
    expect(at(2) - at(1)).toBeGreaterThanOrEqual(600);
    expect(at(3) - at(2)).toBeGreaterThanOrEqual(1_200);
    // The fourth stays up well past 100 ms: the count starts over.
    await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
    const droppedAt = performance.now();
    conns[3]?.drop();
    const fifth = await r.backend.accept('/portfolio');
    // 300 ms (n = 0) again, not 2400 ms (n = 3).
    expect(fifth.connectedAt - droppedAt).toBeGreaterThanOrEqual(250);
    expect(fifth.connectedAt - droppedAt).toBeLessThan(1_500);
  });

  test('an unexpected failure while opening a connection is reported and retried with the backoff', async () => {
    let checks = 0;
    const fake = fakeSession({ held: true });
    const session = {
      ...(fake.session as unknown as Record<string, unknown>),
      hasBackendCredential: () => {
        checks += 1;
        if (checks === 2) {
          throw new Error('unexpected');
        }
        return true;
      },
    } as unknown as Session;
    const backend = await startSocketBackend();
    backends.push(backend);
    const rt = new BackendRealtime({
      env: { ...testEnv, backendSocketUrl: backend.url },
      session,
      connection: { backoff: { baseMs: 1, capMs: 5 } },
    });
    const log = watch(rt.marketActivityChannel({ marketId: 1 }));
    const first = await backend.accept('/market-activity');
    await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
    first.drop();
    await backend.accept('/market-activity');
    await waitUntil(() => log.events.length === 2, 'the next snapshot', 4_000);
    expect(log.errors.map((e) => e.code)).toEqual(['ws_channel_failed']);
    expect(log.errors[0]?.service).toBe('sdk');
    expect(checks).toBe(3);
    expect(log.reconnected).toBe(1);
  });

  test('a server disconnect without a refusal reconnects with the backoff', async () => {
    const r = await rig();
    const log = watch(r.rt.portfolioChannel());
    const first = await r.backend.accept('/portfolio');
    await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
    first.socket.disconnect(true);
    await r.backend.accept('/portfolio');
    await waitUntil(() => log.reconnected === 1, 'reconnected', 4_000);
    expect(log.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Coded errors on a subscribe
// ---------------------------------------------------------------------------

describe('portfolioChannel: coded errors', () => {
  test('RATE_LIMITED is reported with its code once, and the connection restarts to subscribe again', async () => {
    const r = await rig();
    r.backend.onPortfolioSubscribe = (conn) => {
      if (conn === r.backend.connections[0]) {
        const message = 'Portfolio subscribe rate limit exceeded';
        conn.socket.emit('portfolio_error', { message, code: 'RATE_LIMITED' });
        conn.socket.emit('exception', { status: 'error', message });
        return 'handled';
      }
      return 'default';
    };
    const log = watch(r.rt.portfolioChannel());
    await r.backend.accept('/portfolio');
    await r.backend.accept('/portfolio');
    await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
    expect(log.errors.map((e) => e.code)).toEqual(['RATE_LIMITED']);
  });

  for (const [code, message] of [
    ['EVENT_TOO_LARGE', 'Event has 80 CLOB markets; maximum supported is 64'],
    [
      'INVALID_FILTER',
      'eventId cannot be combined with marketId or contractMarketId',
    ],
    ['TAKE_LIMIT', 'take cannot exceed 100'],
    ['INVALID_EVENT_ID', 'eventId must be a valid UUID'],
  ] as const) {
    test(`${code} is permanent for the subscription: reported once, closed`, async () => {
      const r = await rig();
      r.backend.onPortfolioSubscribe = (conn) => {
        conn.socket.emit('portfolio_error', { message, code });
        conn.socket.emit('exception', { status: 'error', message });
        return 'handled';
      };
      const log = watch(r.rt.portfolioChannel());
      await r.backend.accept('/portfolio');
      await waitUntil(() => log.closed === 1, 'closed', 4_000);
      expect(log.errors.map((e) => e.code)).toEqual([code]);
      expect(log.errors[0]?.message).toContain(message);
      if (code === 'EVENT_TOO_LARGE') {
        expect(log.errors[0]?.message).toContain('narrow marketScope');
        expect(log.errors[0]?.message).toContain("'onlyClob'");
      }
      await settle(100);
      expect(r.backend.connections).toHaveLength(1);
    });
  }

  test('the same uncoded `exception` three times in a row is permanent: reported, then one stop', async () => {
    const r = await rig();
    r.backend.onPortfolioSubscribe = (conn) => {
      conn.socket.emit('exception', {
        status: 'error',
        message: 'Event not found',
      });
      return 'handled';
    };
    const log = watch(r.rt.portfolioChannel());
    await waitUntil(() => log.closed === 1, 'closed', 10_000);
    expect(log.errors.map((e) => e.code)).toEqual([
      'ws_subscribe_failed',
      'ws_subscribe_unrecoverable',
    ]);
    expect(log.errors[1]?.message).toContain('Event not found');
    expect(r.backend.connections).toHaveLength(3);
    await settle(100);
    expect(r.backend.connections).toHaveLength(3);
  });

  test('"Internal server error" stays transient: five in a row keep reconnecting, the channel stays open', async () => {
    const r = await rig();
    r.backend.onPortfolioSubscribe = (conn) => {
      if (r.backend.connections.indexOf(conn) < 5) {
        conn.socket.emit('exception', {
          status: 'error',
          message: 'Internal server error',
        });
        return 'handled';
      }
      return 'default';
    };
    const log = watch(r.rt.portfolioChannel());
    await waitUntil(() => log.events.length === 1, 'the snapshot', 13_000);
    expect(log.errors.map((e) => e.code)).toEqual(
      Array(5).fill('ws_subscribe_failed'),
    );
    expect(r.backend.connections).toHaveLength(6);
    expect(log.closed).toBe(0);
  });

  test('a different failure in between starts the count again', async () => {
    const r = await rig();
    const messages = [
      'Event not found',
      'Event not found',
      'Internal server error',
      'Event not found',
    ];
    r.backend.onPortfolioSubscribe = (conn) => {
      const index = r.backend.connections.indexOf(conn);
      const message = messages[index];
      if (message === undefined) {
        return 'default';
      }
      conn.socket.emit('exception', { status: 'error', message });
      return 'handled';
    };
    const log = watch(r.rt.portfolioChannel());
    await waitUntil(() => log.events.length === 1, 'the snapshot', 12_000);
    expect(log.errors.map((e) => e.code)).toEqual([
      'ws_subscribe_failed',
      'ws_subscribe_failed',
      'ws_subscribe_failed',
    ]);
    expect(log.closed).toBe(0);
  });

  test('an uncoded `exception` answering the subscribe (an unknown event) is reported and restarts', async () => {
    const r = await rig();
    r.backend.onPortfolioSubscribe = (conn) => {
      if (conn === r.backend.connections[0]) {
        conn.socket.emit('exception', {
          status: 'error',
          message: 'Event not found',
        });
        return 'handled';
      }
      return 'default';
    };
    const log = watch(r.rt.portfolioChannel());
    await r.backend.accept('/portfolio');
    await r.backend.accept('/portfolio');
    await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
    expect(log.errors.map((e) => e.code)).toEqual(['ws_subscribe_failed']);
    expect(log.errors[0]?.message).toContain('Event not found');
  });
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

describe('portfolioChannel: credentials', () => {
  test('no session, or a session that cannot get a key: AuthRequiredError at once', async () => {
    const none = await rig({ session: 'none' });
    expect(await caught(() => none.rt.portfolioChannel())).toBeInstanceOf(
      AuthRequiredError,
    );
    const empty = await rig({
      session: fakeSession({ signer: false, held: false }),
    });
    expect(await caught(() => empty.rt.portfolioChannel())).toBeInstanceOf(
      AuthRequiredError,
    );
    await settle(50);
    expect(none.backend.connections).toHaveLength(0);
    expect(empty.backend.connections).toHaveLength(0);
  });

  test('ensureBackend: a transient failure is retried; anything else stops without connecting', async () => {
    let calls = 0;
    const transient = await rig({
      session: fakeSession({
        ensureBackend: async () => {
          calls += 1;
          if (calls === 1) {
            throw new TransportError('the login request failed');
          }
          return credential(KEY_1);
        },
      }),
    });
    const log = watch(transient.rt.portfolioChannel());
    await transient.backend.accept('/portfolio');
    await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
    expect(log.errors.map((e) => e.code)).toEqual(['ws_auth_failed']);

    const permanent = await rig({
      session: fakeSession({
        ensureBackend: async () => {
          throw new XoError('The session is closed', {
            code: 'session_closed',
          });
        },
      }),
    });
    const stopped = watch(permanent.rt.portfolioChannel());
    await waitUntil(() => stopped.closed === 1, 'closed');
    expect(stopped.errors.map((e) => e.code)).toEqual([
      'ws_auth_unrecoverable',
    ]);
    expect(stopped.errors[0]?.cause).toEqual({
      name: 'XoError',
      code: 'session_closed',
    });
    await settle(100);
    expect(permanent.backend.connections).toHaveLength(0);
  });

  test('the key never appears in an error, even when the server echoes it', async () => {
    for (const key of [KEY_1, KEY_ODD]) {
      const r = await rig({ session: fakeSession({ keys: [key] }) });
      r.backend.portfolioAuth = (_token, conn) =>
        conn === r.backend.connections[0]
          ? `Authentication unavailable for ${key}`
          : { userId: 7, scopes: ['account:read'] };
      r.backend.onPortfolioSubscribe = (conn) => {
        if (conn.subscribes().length === 1) {
          conn.socket.emit('portfolio_error', {
            message: `token ${key} is odd`,
            code: 'SOMETHING_NEW',
          });
          conn.socket.emit('exception', {
            status: 'error',
            message: `Bad ${key}`,
          });
          return 'handled';
        }
        return 'default';
      };
      const log = watch(r.rt.portfolioChannel());
      await waitUntil(() => log.errors.length >= 3, 'three errors', 5_000);
      for (const error of log.errors) {
        expect(surface(error)).not.toContain(key);
        expect(surface(error)).not.toContain(key.slice(10));
      }
      expect(log.errors.some((e) => e.message.includes('[redacted]'))).toBe(
        true,
      );
    }
  });

  test('a snapshot that echoes the key is dropped unread', async () => {
    const r = await rig({ session: fakeSession({ keys: [KEY_ODD] }) });
    r.backend.portfolioRows = () => [
      { ...summaryRow(), title: `leaked ${KEY_ODD}` },
    ];
    const log = watch(r.rt.portfolioChannel());
    await waitUntil(() => log.errors.length === 1, 'the error', 4_000);
    expect(log.errors[0]?.code).toBe('ws_frame_invalid');
    expect(log.events).toEqual([]);
    expect(surface(log.errors[0] as XoError)).not.toContain(KEY_ODD);
  });

  test('close() disconnects and stops reconnecting', async () => {
    const r = await rig();
    const sub = r.rt.portfolioChannel();
    const log = watch(sub);
    const conn = await r.backend.accept('/portfolio');
    await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
    await sub.close();
    expect(await conn.closed).toBe('client namespace disconnect');
    expect(log.closed).toBe(1);
    await settle(200);
    expect(r.backend.connections).toHaveLength(1);
    // Closed while reconnecting: a socket still in its handshake at that moment is dropped,
    // and nothing connects afterwards.
    const r2 = await rig();
    r2.backend.portfolioAuth = () => 'Authentication unavailable';
    const sub2 = r2.rt.portfolioChannel();
    const log2 = watch(sub2);
    await r2.backend.accept('/portfolio');
    await waitUntil(() => log2.errors.length === 1, 'the refusal');
    await sub2.close();
    await settle(100);
    const seen = r2.backend.connections.length;
    const calls = r2.fake?.ensureBackend.mock.calls.length;
    await settle(300);
    expect(r2.backend.connections).toHaveLength(seen);
    expect(r2.fake?.ensureBackend.mock.calls.length).toBe(calls);
    for (const conn of r2.backend.connections) {
      expect(conn.socket.connected).toBe(false);
    }
  });

  test('close() while the server is still checking the handshake of a reconnect', async () => {
    const r = await rig();
    // The second connection's handshake check never finishes in time.
    r.backend.authDelayMs = (conn) =>
      conn === r.backend.connections[1] ? 60_000 : 20;
    const sub = r.rt.portfolioChannel();
    const log = watch(sub);
    const first = await r.backend.accept('/portfolio');
    await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
    first.drop();
    const second = await r.backend.accept('/portfolio');
    // The client has its `connect` by now; the server is still checking the key.
    await settle(150);
    expect(second.user).toBeUndefined();
    await sub.close();
    expect(await second.closed).toBe('client namespace disconnect');
    expect(second.subscribes()).toHaveLength(0);
    await settle(300);
    expect(r.backend.connections).toHaveLength(2);
    expect(log.closed).toBe(1);
    expect(log.reconnected).toBe(0);
  });

  test('two channels are independent: closing one leaves the other streaming', async () => {
    const r = await rig();
    const subA = r.rt.portfolioChannel();
    const a = watch(subA);
    const connA = await r.backend.accept('/portfolio');
    const b = watch(r.rt.portfolioChannel({ filters: { take: 3 } }));
    const connB = await r.backend.accept('/portfolio');
    await waitUntil(
      () => a.events.length === 1 && b.events.length === 1,
      'both snapshots',
      4_000,
    );
    // Separate Socket.IO managers: separate engine connections.
    expect(connA.socket.conn).not.toBe(connB.socket.conn);
    await subA.close();
    expect(await connA.closed).toBe('client namespace disconnect');
    expect(connB.socket.connected).toBe(true);
    r.backend.pushPortfolioSnapshot(connB);
    await waitUntil(() => b.events.length === 2, 'the pushed snapshot');
    expect(a.events).toHaveLength(1);
    expect(b.closed).toBe(0);
    expect(b.errors).toEqual([]);
  });

  test('closed before the first connect: nothing connects', async () => {
    const r = await rig();
    const sub = r.rt.portfolioChannel();
    await sub.close();
    await settle(200);
    expect(r.backend.connections).toHaveLength(0);
  });
});
