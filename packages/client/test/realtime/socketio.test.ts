import { afterEach, describe, expect, test, vi } from 'vitest';
import { UserInputError, type XoError } from '../../src/core/errors';
import { BackendRealtime } from '../../src/realtime/socketio';
import { EVENT_ID } from '../helpers/mockBackendData';
import { startSocketBackend } from '../helpers/socketBackend';
import {
  caught,
  cleanupSockets,
  failSnapshot,
  fakeSession,
  KEY_1,
  KEY_2,
  nthSubscribe,
  rig,
  subs,
  summaryRow,
  surface,
  watch,
} from '../helpers/socketRig';
import { testEnv } from '../helpers/testEnv';
import { settle, waitUntil } from '../helpers/wsServer';

// The backend's Socket.IO channels against an in-process `socket.io` server that mirrors
// the backend's `/portfolio` and `/market-activity` gateways (see
// test/helpers/socketBackend.ts). No live endpoint. The SDK waits 1000 ms after `connect`
// before it subscribes, so most tests take a little over a second. This file: the
// handshake and subscribe, snapshots and filters, the early subscribe, transport and options. The
// refusals and errors are in socketioErrors.test.ts, `/market-activity` in
// socketioMarketActivity.test.ts.

// Every test waits out at least one 1000 ms subscribe delay, some several.
vi.setConfig({ testTimeout: 15_000 });

afterEach(cleanupSockets);

// ---------------------------------------------------------------------------
// The brief's tests
// ---------------------------------------------------------------------------

describe('portfolioChannel: the handshake, the subscribe, a coded error and a reconnect', () => {
  test('token is sent in handshake auth, never in query', async () => {
    const r = await rig();
    const log = watch(r.rt.portfolioChannel());
    const conn = await r.backend.accept('/portfolio');
    expect(conn.handshake.auth).toEqual({ token: KEY_1 });
    expect(conn.handshake.query.token).toBeUndefined();
    expect(JSON.stringify(conn.handshake.query)).not.toContain(KEY_1);
    expect(conn.handshake.url).not.toContain(KEY_1);
    expect(conn.handshake.url).not.toContain('token');
    expect(conn.handshake.headers.authorization).toBeUndefined();
    expect(JSON.stringify(conn.handshake.headers)).not.toContain(KEY_1);
    await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
  });

  test('subscribe emitted ≥1000 ms after connect', async () => {
    const r = await rig();
    const log = watch(r.rt.portfolioChannel());
    const conn = await r.backend.accept('/portfolio');
    const { at } = await nthSubscribe(conn);
    expect(at - conn.connectedAt).toBeGreaterThanOrEqual(1_000);
    await waitUntil(() => log.events.length === 1, 'the snapshot');
    expect(log.errors).toEqual([]);
  });

  test("portfolio_error {code:'INSUFFICIENT_SCOPE'} surfaces as error event", async () => {
    const r = await rig();
    r.backend.portfolioAuth = () => ({ userId: 7, scopes: ['account:write'] });
    const log = watch(r.rt.portfolioChannel());
    const conn = await r.backend.accept('/portfolio');
    await waitUntil(() => log.closed === 1, 'the subscription to close', 4_000);
    // One error (the `exception` that repeats it is not reported again), then closed.
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]?.code).toBe('INSUFFICIENT_SCOPE');
    expect(log.errors[0]?.service).toBe('backend');
    expect(log.errors[0]?.message).toContain('account:read');
    expect(log.order).toEqual(['error:INSUFFICIENT_SCOPE', 'closed']);
    expect(await conn.closed).toBe('client namespace disconnect');
    await settle(100);
    // Permanent for that subscription: no new connection.
    expect(r.backend.connections).toHaveLength(1);
  });

  test("reconnect re-emits subscribe and 'reconnected'", async () => {
    const r = await rig({ session: fakeSession({ keys: [KEY_1, KEY_2] }) });
    const log = watch(r.rt.portfolioChannel({ filters: { take: 5 } }));
    const first = await r.backend.accept('/portfolio');
    await waitUntil(() => log.events.length === 1, 'the first snapshot', 4_000);
    expect(log.reconnected).toBe(0);
    first.drop();
    const second = await r.backend.accept('/portfolio');
    // Key rotation: every connect asks the session again, and sends what it gets.
    expect(second.handshake.auth).toEqual({ token: KEY_2 });
    expect(r.fake?.ensureBackend).toHaveBeenCalledTimes(2);
    const { payload, at } = await nthSubscribe(second);
    expect(at - second.connectedAt).toBeGreaterThanOrEqual(1_000);
    expect(payload).toEqual({ take: 5, marketScope: 'withPulse' });
    await waitUntil(() => log.events.length === 2, 'the second snapshot');
    // 'reconnected' only once the new subscription answered, before its snapshot.
    expect(log.reconnected).toBe(1);
    expect(log.order).toEqual([
      'portfolio_snapshot',
      'reconnected',
      'portfolio_snapshot',
    ]);
    expect(log.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Snapshots and filters
// ---------------------------------------------------------------------------

describe('portfolioChannel: snapshots and filters', () => {
  test('a summary snapshot is parsed: positions per market, the meta and the echoed filters', async () => {
    const r = await rig({ strict: true });
    const log = watch(r.rt.portfolioChannel());
    await r.backend.accept('/portfolio');
    await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
    const event = log.events[0];
    expect(event?.type).toBe('portfolio_snapshot');
    expect(event?.meta.itemCount).toBe(1);
    expect(event?.filters).toMatchObject({
      page: 1,
      take: 10,
      marketScope: 'withPulse',
    });
    const row = event?.data[0] as { positions: Array<{ pnl: string }> };
    expect(row.positions).toHaveLength(2);
    // Money as exact decimal strings, as the data client types them.
    expect(row.positions[0]?.pnl).toBe('264.80000099999995');
    expect(typeof event?.emittedAt).toBe('string');
    expect(log.errors).toEqual([]);
  });

  test('marketId selects the detail rows, which parse as positions', async () => {
    const r = await rig({ strict: true });
    const log = watch(r.rt.portfolioChannel({ filters: { marketId: 2 } }));
    const conn = await r.backend.accept('/portfolio');
    const { payload } = await nthSubscribe(conn);
    expect(payload).toEqual({ marketId: 2, marketScope: 'withPulse' });
    await waitUntil(() => log.events.length === 1, 'the snapshot');
    // Typed from the overload: the detail mode yields PortfolioPosition rows.
    const position = log.events[0]?.data[0];
    expect(position?.marketId).toBe(2);
    expect(position?.market.id).toBe(2);
    expect(log.errors).toEqual([]);
  });

  test('the holdings scope defaults to withPulse; a scope the caller passes wins', async () => {
    const r = await rig();
    watch(
      r.rt.portfolioChannel({
        filters: { marketScope: 'onlyClob', status: 'active', page: 2 },
      }),
    );
    const conn = await r.backend.accept('/portfolio');
    const { payload } = await nthSubscribe(conn);
    expect(payload).toEqual({
      marketScope: 'onlyClob',
      status: 'active',
      page: 2,
    });
  });

  test("an event subscription sends the event id, takes up to 50, and its scope defaults to 'onlyClob'", async () => {
    const r = await rig();
    watch(
      r.rt.portfolioChannel({
        filters: { eventId: EVENT_ID, take: 50, includeSubEvents: false },
      }),
    );
    const conn = await r.backend.accept('/portfolio');
    const { payload } = await nthSubscribe(conn);
    // The gateway counts the event's markets in the scope against its limit of 64.
    expect(payload).toEqual({
      eventId: EVENT_ID,
      take: 50,
      includeSubEvents: false,
      marketScope: 'onlyClob',
    });
    // A scope the caller passes wins, for an event too.
    const r2 = await rig();
    watch(
      r2.rt.portfolioChannel({
        filters: { eventId: EVENT_ID, marketScope: 'withPulse' },
      }),
    );
    const conn2 = await r2.backend.accept('/portfolio');
    expect((await nthSubscribe(conn2)).payload).toEqual({
      eventId: EVENT_ID,
      marketScope: 'withPulse',
    });
  });

  test('filters are checked against the gateway DTO before anything connects', async () => {
    const r = await rig();
    const bad: Array<[unknown, RegExp]> = [
      [{ take: 101 }, /take must be a whole number between 1 and 100/],
      [{ take: 0 }, /take/],
      [{ eventId: EVENT_ID, take: 51 }, /at most 50 .*eventId/],
      [{ eventId: 'not-a-uuid' }, /eventId must be/],
      // The backend's check: version 1 to 5, variant 8, 9, a or b.
      [{ eventId: '5b7c1a2e-9c4d-6e8f-a1b2-3c4d5e6f7a8b' }, /eventId must be/],
      [{ eventId: EVENT_ID, marketId: 3 }, /eventId cannot be combined/],
      [
        { eventId: EVENT_ID, contractMarketId: '42' },
        /eventId cannot be combined/,
      ],
      [{ marketScope: 'everything' }, /marketScope must be one of/],
      [{ status: 'open' }, /status must be one of/],
      [{ marketId: 1.5 }, /marketId/],
      [{ page: 10_001 }, /page/],
      [{ refresh: true }, /refresh is not available/],
      [{ claimableFirst: true }, /claimableFirst is not available/],
      [{ user: '0xabc' }, /user is not available/],
      [{ other: 1 }, /unknown param "other"/],
    ];
    for (const [filters, pattern] of bad) {
      const error = await caught(() =>
        r.rt.portfolioChannel({ filters } as never),
      );
      expect(error, JSON.stringify(filters)).toBeInstanceOf(UserInputError);
      expect((error as Error).message, JSON.stringify(filters)).toMatch(
        pattern,
      );
    }
    expect(
      await caught(() => r.rt.portfolioChannel({ other: 1 } as never)),
    ).toBeInstanceOf(UserInputError);
    expect(
      await caught(() => r.rt.portfolioChannel({ filters: null } as never)),
    ).toBeInstanceOf(UserInputError);
    await settle(100);
    expect(r.backend.connections).toHaveLength(0);
    expect(r.fake?.ensureBackend).not.toHaveBeenCalled();
  });

  test('lenient by default: an unknown field is kept; strict: it is an error and the stream survives', async () => {
    for (const strict of [false, true]) {
      const r = await rig({ strict });
      let extra = true;
      r.backend.portfolioRows = () => [
        { ...summaryRow(), ...(extra ? { addedLater: 1 } : {}) },
      ];
      const log = watch(r.rt.portfolioChannel());
      const conn = await r.backend.accept('/portfolio');
      if (strict) {
        await waitUntil(
          () => log.errors.length === 1,
          'the schema error',
          4_000,
        );
        expect(log.errors[0]?.code).toBe('ws_frame_invalid');
        expect(log.errors[0]?.message).toContain('addedLater');
        expect(log.events).toHaveLength(0);
        extra = false;
        r.backend.pushPortfolioSnapshot(conn);
        await waitUntil(() => log.events.length === 1, 'the next snapshot');
      } else {
        await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
        const row = log.events[0]?.data[0] as { addedLater?: number };
        expect(row.addedLater).toBe(1);
        expect(log.errors).toEqual([]);
      }
    }
  });

  test('a snapshot that does not match the schema is reported and dropped', async () => {
    const r = await rig();
    const log = watch(r.rt.portfolioChannel());
    const conn = await r.backend.accept('/portfolio');
    await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
    conn.socket.emit('portfolio_snapshot', { type: 'portfolio_snapshot' });
    await waitUntil(() => log.errors.length === 1, 'the error');
    expect(log.errors[0]?.code).toBe('ws_frame_invalid');
    r.backend.pushPortfolioSnapshot(conn);
    await waitUntil(() => log.events.length === 2, 'the next snapshot');
  });

  test("the subscribe's own snapshot fails: one re-subscribe 5 s later, nothing reported when it works", async () => {
    const r = await rig();
    r.backend.onPortfolioSubscribe = (conn, _raw, ack) =>
      conn.subscribes().length === 1 ? failSnapshot(conn, ack) : 'default';
    const log = watch(r.rt.portfolioChannel());
    const conn = await r.backend.accept('/portfolio');
    const first = await nthSubscribe(conn, 1);
    const second = await nthSubscribe(conn, 2, 8_000);
    // Outside the strictest rate-limit window the backend documents (5 s).
    expect(second.at - first.at).toBeGreaterThanOrEqual(5_000);
    await waitUntil(() => log.events.length === 1, 'the snapshot');
    expect(log.errors).toEqual([]);
    expect(log.reconnected).toBe(0);
    expect(r.backend.connections).toHaveLength(1);
  });

  test('both snapshots fail: reported once, the subscription stays, and a push delivers', async () => {
    const r = await rig();
    r.backend.onPortfolioSubscribe = (conn, _raw, ack) =>
      failSnapshot(conn, ack);
    const log = watch(r.rt.portfolioChannel());
    const conn = await r.backend.accept('/portfolio');
    await waitUntil(() => log.errors.length === 1, 'the error', 8_000);
    expect(log.errors[0]?.code).toBe('ws_snapshot_failed');
    expect(log.errors[0]?.message).toContain('close this subscription');
    expect(conn.subscribes()).toHaveLength(2);
    // A later push (a trade) delivers on the same socket.
    r.backend.pushPortfolioSnapshot(conn);
    await waitUntil(() => log.events.length === 1, 'the pushed snapshot');
    await settle(100);
    expect(r.backend.connections).toHaveLength(1);
    expect(conn.subscribes()).toHaveLength(2);
    expect(log.closed).toBe(0);
  });

  test('a pushed snapshot that fails is reported at once', async () => {
    const r = await rig();
    const log = watch(r.rt.portfolioChannel());
    const conn = await r.backend.accept('/portfolio');
    await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
    conn.socket.emit('portfolio_error', {
      message: 'Failed to build portfolio snapshot',
    });
    await waitUntil(() => log.errors.length === 1, 'the error');
    expect(log.errors[0]?.code).toBe('ws_snapshot_failed');
    await settle(100);
    expect(conn.subscribes()).toHaveLength(1);
  });

  test("after a reconnect, 'reconnected' waits for the outcome of the snapshot retry", async () => {
    const r = await rig();
    r.backend.onPortfolioSubscribe = (conn, _raw, ack) =>
      conn === r.backend.connections[1] && conn.subscribes().length === 1
        ? failSnapshot(conn, ack)
        : 'default';
    const log = watch(r.rt.portfolioChannel());
    const first = await r.backend.accept('/portfolio');
    await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
    first.drop();
    const second = await r.backend.accept('/portfolio');
    await nthSubscribe(second, 1);
    await settle(300);
    // The subscription answered `ok`, but with no snapshot: no 'reconnected' yet.
    expect(log.reconnected).toBe(0);
    await nthSubscribe(second, 2, 8_000);
    await waitUntil(() => log.events.length === 2, 'the retried snapshot');
    expect(log.order).toEqual([
      'portfolio_snapshot',
      'reconnected',
      'portfolio_snapshot',
    ]);
    expect(log.errors).toEqual([]);
  });

  test('a for-await loop sees the snapshots and ends on close()', async () => {
    const r = await rig();
    const sub = r.rt.portfolioChannel();
    subs.push(sub);
    const seen: string[] = [];
    const loop = (async () => {
      for await (const event of sub) {
        seen.push(event.type);
        await sub.close();
      }
    })();
    await r.backend.accept('/portfolio');
    await loop;
    expect(seen).toEqual(['portfolio_snapshot']);
  });
});

// ---------------------------------------------------------------------------
// The early-subscribe race
// ---------------------------------------------------------------------------

describe('portfolioChannel: the early subscribe', () => {
  test("an `exception` 'Authentication required' answering the subscribe re-emits it once, 1000 ms later", async () => {
    const r = await rig();
    // The handshake check finishes after the first subscribe arrives.
    r.backend.authDelayMs = 1_400;
    const log = watch(r.rt.portfolioChannel());
    const conn = await r.backend.accept('/portfolio');
    const first = await nthSubscribe(conn, 1);
    const second = await nthSubscribe(conn, 2, 4_000);
    expect(second.at - first.at).toBeGreaterThanOrEqual(1_000);
    await waitUntil(() => log.events.length === 1, 'the snapshot');
    expect(log.errors).toEqual([]);
    expect(r.backend.connections).toHaveLength(1);
  });

  test("a second 'Authentication required' restarts the connection with the backoff", async () => {
    const r = await rig();
    // The first connection never finishes authenticating; the next one does at once.
    r.backend.authDelayMs = (conn) =>
      conn === r.backend.connections[0] ? 60_000 : 20;
    const log = watch(r.rt.portfolioChannel());
    const first = await r.backend.accept('/portfolio');
    await nthSubscribe(first, 2, 4_000);
    await waitUntil(() => log.errors.length === 1, 'the error');
    expect(log.errors[0]?.code).toBe('ws_auth_failed');
    const second = await r.backend.accept('/portfolio');
    await nthSubscribe(second, 1);
    await waitUntil(() => log.events.length === 1, 'the snapshot');
    expect(first.subscribes()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

describe('transport and strictness', () => {
  test('a server that is not there: one transport_error per streak, retried with the backoff', async () => {
    const gone = await startSocketBackend();
    const url = gone.url;
    await gone.close();
    const fake = fakeSession();
    const rt = new BackendRealtime({
      env: { ...testEnv, backendSocketUrl: url },
      session: fake.session,
      connection: { backoff: { baseMs: 1, capMs: 5 } },
    });
    const log = watch(rt.portfolioChannel());
    await waitUntil(
      () => fake.ensureBackend.mock.calls.length >= 4,
      'several connect attempts',
    );
    expect(log.errors.map((e) => e.code)).toEqual(['transport_error']);
    expect(log.errors[0]?.service).toBe('backend');
    expect(surface(log.errors[0] as XoError)).not.toContain(KEY_1);
  });

  test('an event the SDK does not know: ignored when lenient, an error when strict', async () => {
    for (const strict of [false, true]) {
      const r = await rig({ strict });
      const log = watch(r.rt.portfolioChannel());
      const conn = await r.backend.accept('/portfolio');
      await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
      conn.socket.emit('portfolio_something_new', { a: 1 });
      r.backend.pushPortfolioSnapshot(conn);
      await waitUntil(() => log.events.length === 2, 'the next snapshot');
      expect(log.errors.map((e) => e.code)).toEqual(
        strict ? ['ws_unknown_event'] : [],
      );
    }
  });

  test('/market-activity subscribes without its connection ack after 5 s', async () => {
    const r = await rig({ session: 'none' });
    // The ack never comes in time.
    r.backend.authDelayMs = 60_000;
    const log = watch(r.rt.marketActivityChannel({ marketId: 1 }));
    const conn = await r.backend.accept('/market-activity');
    const { at } = await nthSubscribe(conn, 1, 7_000);
    expect(at - conn.connectedAt).toBeGreaterThanOrEqual(5_000);
    await waitUntil(() => log.events.length === 1, 'the snapshot');
  });
});

describe('BackendRealtime options', () => {
  test('every option is checked, and nothing connects', () => {
    const env = testEnv;
    const ok = { env };
    expect(() => new BackendRealtime(ok)).not.toThrow();
    const bad: unknown[] = [
      undefined,
      {},
      { env: { ...env, backendSocketUrl: 'ftp://x' } },
      { env: { ...env, backendSocketUrl: 'http://example.com' } },
      { env: { ...env, backendSocketUrl: 42 } },
      { env, session: {} },
      { env, strictResponses: 'yes' },
      { env, connection: { backoff: { baseMs: 0, capMs: 5 } } },
      { env, connection: { backoff: { baseMs: 10, capMs: 5 } } },
      { env, connection: { stableAfterMs: -1 } },
      { env, connection: { connectTimeoutMs: Number.NaN } },
      { env, connection: { random: 1 } },
      { env, connection: { pingIntervalMs: 1 } },
      { env, other: true },
    ];
    for (const options of bad) {
      expect(
        () => new BackendRealtime(options as never),
        JSON.stringify(options),
      ).toThrow(UserInputError);
    }
  });
});
