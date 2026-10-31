import { afterEach, describe, expect, test, vi } from 'vitest';
import { TransportError, UserInputError } from '../../src/core/errors';
import { activityFixture } from '../helpers/mockBackendData';
import {
  caught,
  cleanupSockets,
  fakeSession,
  KEY_1,
  KEY_2,
  nthSubscribe,
  rig,
  watch,
} from '../helpers/socketRig';
import { settle, waitUntil } from '../helpers/wsServer';

// The backend's Socket.IO channels: `/market-activity`, against the in-process server of
// test/helpers/socketBackend.ts. No live endpoint.

// Every test waits out at least one 1000 ms subscribe delay, some several.
vi.setConfig({ testTimeout: 15_000 });

afterEach(cleanupSockets);

// ---------------------------------------------------------------------------
// /market-activity
// ---------------------------------------------------------------------------

describe('marketActivityChannel', () => {
  test('anonymous without a session: no token, subscribe after the ack and ≥1000 ms, parsed snapshot', async () => {
    const r = await rig({ session: 'none', strict: true });
    const log = watch(
      r.rt.marketActivityChannel({ marketId: 1, filters: { take: 5 } }),
    );
    const conn = await r.backend.accept('/market-activity');
    expect(conn.handshake.auth).toEqual({});
    const { payload, at } = await nthSubscribe(conn);
    expect(at - conn.connectedAt).toBeGreaterThanOrEqual(1_000);
    expect(payload).toEqual({ marketId: 1, filters: { take: 5 } });
    await waitUntil(() => log.events.length === 1, 'the snapshot');
    const event = log.events[0];
    expect(event?.type).toBe('market_activity_snapshot');
    expect(event?.marketId).toBe(1);
    expect(event?.data).toHaveLength(2);
    expect(event?.data[0]?.collateralAmount).toBe('1000000');
    expect(event?.filters).toMatchObject({
      page: 1,
      take: 5,
      sortBy: 'executedAt',
      userTradesOnly: false,
    });
    expect(conn.viewer).toBeUndefined();
    expect(log.errors).toEqual([]);
  });

  test('with a session it sends the key in auth.token, so the viewer is the account', async () => {
    const r = await rig();
    const log = watch(
      r.rt.marketActivityChannel({
        marketId: 2,
        filters: { userTradesOnly: true },
      }),
    );
    const conn = await r.backend.accept('/market-activity');
    expect(conn.handshake.auth).toEqual({ token: KEY_1 });
    expect(conn.handshake.url).not.toContain(KEY_1);
    expect(conn.handshake.headers.authorization).toBeUndefined();
    await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
    expect(conn.viewer).toBe(`privy:${KEY_1}`);
    expect(log.errors).toEqual([]);
  });

  test('strict: a userTradesOnly snapshot takes the account history kinds (REDEEM, SPLIT), not only the fills', async () => {
    // With an authenticated viewer and no outcomeIndex, userTradesOnly reads the account's
    // merged history with no type filter, so the snapshot lists every kind of the account's
    // history rows; the gateway builds it from the viewer's Privy id.
    const kinds = ['BUY', 'SELL', 'REDEEM', 'SPLIT', 'MERGE', 'REFUND'];
    const r = await rig({ strict: true });
    r.backend.marketActivityRows = () =>
      kinds.map((positionType, n) => ({
        ...activityFixture(n + 1, true),
        positionType,
      }));
    const log = watch(
      r.rt.marketActivityChannel({
        marketId: 1,
        filters: { userTradesOnly: true },
      }),
    );
    await r.backend.accept('/market-activity');
    await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
    expect(log.events[0]?.data.map((row) => row.positionType)).toEqual(kinds);
    expect(log.errors).toEqual([]);
  });

  test('strict: a kind the backend does not name is still a frame error', async () => {
    const r = await rig({ strict: true });
    r.backend.marketActivityRows = () => [
      { ...activityFixture(1, true), positionType: 'REBALANCE_SOMETHING' },
    ];
    const log = watch(r.rt.marketActivityChannel({ marketId: 1 }));
    await r.backend.accept('/market-activity');
    await waitUntil(() => log.errors.length === 1, 'the schema error', 4_000);
    expect(log.errors[0]?.code).toBe('ws_frame_invalid');
    expect(log.errors[0]?.message).toContain('positionType');
    expect(log.events).toEqual([]);
  });

  test('the subscribe waits for the connection ack', async () => {
    const r = await rig({ session: 'none' });
    r.backend.authDelayMs = 1_500;
    const log = watch(r.rt.marketActivityChannel({ marketId: 1 }));
    const conn = await r.backend.accept('/market-activity');
    const { at } = await nthSubscribe(conn);
    // The mock's own 1500 ms timer may fire a fraction of a millisecond early.
    expect(at - conn.connectedAt).toBeGreaterThanOrEqual(1_490);
    await waitUntil(() => log.events.length === 1, 'the snapshot');
  });

  test('userTradesOnly on an anonymous connection is reported (the key lacks account:read)', async () => {
    const r = await rig();
    r.backend.marketActivityAuth = () => undefined;
    const log = watch(
      r.rt.marketActivityChannel({
        marketId: 1,
        filters: { userTradesOnly: true },
      }),
    );
    await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
    expect(log.errors.map((e) => e.code)).toEqual(['ws_anonymous_viewer']);
  });

  test('userTradesOnly without a session is refused at once', async () => {
    const r = await rig({ session: 'none' });
    const error = await caught(() =>
      r.rt.marketActivityChannel({
        marketId: 1,
        filters: { userTradesOnly: true },
      }),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as Error).message).toContain('userTradesOnly');
  });

  test('a key the session cannot provide leaves the connection anonymous, reported', async () => {
    const r = await rig({
      session: fakeSession({
        held: true,
        ensureBackend: async () => {
          throw new TransportError('login failed');
        },
      }),
    });
    const log = watch(r.rt.marketActivityChannel({ marketId: 1 }));
    const conn = await r.backend.accept('/market-activity');
    expect(conn.handshake.auth).toEqual({});
    await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
    expect(log.errors.map((e) => e.code)).toEqual(['ws_auth_failed']);
  });

  test('a session that holds no key connects anonymously, silently: a public feed never logs in', async () => {
    for (const signer of [false, true]) {
      const r = await rig({ session: fakeSession({ signer, held: false }) });
      const log = watch(r.rt.marketActivityChannel({ marketId: 1 }));
      const conn = await r.backend.accept('/market-activity');
      expect(conn.handshake.auth).toEqual({});
      await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
      expect(r.fake?.ensureBackend).not.toHaveBeenCalled();
      expect(log.errors).toEqual([]);
    }
  });

  test('a session that holds a key sends it, without userTradesOnly too', async () => {
    const r = await rig({ session: fakeSession({ held: true }) });
    const log = watch(r.rt.marketActivityChannel({ marketId: 1 }));
    const conn = await r.backend.accept('/market-activity');
    expect(conn.handshake.auth).toEqual({ token: KEY_1 });
    await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
    expect(conn.viewer).toBe(`privy:${KEY_1}`);
  });

  test('market_activity_error with its exception is reported once and restarts', async () => {
    const r = await rig({ session: 'none' });
    r.backend.onMarketActivitySubscribe = (conn) => {
      if (conn === r.backend.connections[0]) {
        const message = 'marketId is required';
        conn.socket.emit('market_activity_error', { message });
        conn.socket.emit('exception', { status: 'error', message });
        return 'handled';
      }
      return 'default';
    };
    const log = watch(r.rt.marketActivityChannel({ marketId: 1 }));
    await r.backend.accept('/market-activity');
    await r.backend.accept('/market-activity');
    await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
    expect(log.errors.map((e) => e.code)).toEqual(['ws_server_error']);
  });

  test("'Failed to build market activity snapshot' twice: one retry, reported once, the subscription stays", async () => {
    const r = await rig({ session: 'none' });
    r.backend.onMarketActivitySubscribe = (conn, _raw, ack) => {
      conn.socket.emit('market_activity_error', {
        message: 'Failed to build market activity snapshot',
      });
      ack?.({ ok: true });
      return 'handled';
    };
    const log = watch(r.rt.marketActivityChannel({ marketId: 1 }));
    const conn = await r.backend.accept('/market-activity');
    await waitUntil(() => log.errors.length === 1, 'the error', 8_000);
    expect(log.errors[0]?.code).toBe('ws_snapshot_failed');
    expect(conn.subscribes()).toHaveLength(2);
    await settle(100);
    expect(r.backend.connections).toHaveLength(1);
  });

  test('the same market_activity_error three times in a row is permanent', async () => {
    const r = await rig({ session: 'none' });
    r.backend.onMarketActivitySubscribe = (conn) => {
      const message = 'Market with ID 1 not found';
      conn.socket.emit('market_activity_error', { message });
      conn.socket.emit('exception', { status: 'error', message });
      return 'handled';
    };
    const log = watch(r.rt.marketActivityChannel({ marketId: 1 }));
    await waitUntil(() => log.closed === 1, 'closed', 10_000);
    expect(log.errors.map((e) => e.code)).toEqual([
      'ws_server_error',
      'ws_subscribe_unrecoverable',
    ]);
    expect(r.backend.connections).toHaveLength(3);
  });

  test('strict: a malformed connection ack is a frame error, never a false ws_anonymous_viewer', async () => {
    const r = await rig({ strict: true });
    r.backend.marketActivityAck = () => ({ message: 'Connected' });
    const log = watch(
      r.rt.marketActivityChannel({
        marketId: 1,
        filters: { userTradesOnly: true },
      }),
    );
    const conn = await r.backend.accept('/market-activity');
    // The ack still counts as the ack: the subscribe does not wait for the 5 s fallback.
    const { at } = await nthSubscribe(conn);
    expect(at - conn.connectedAt).toBeLessThan(4_000);
    await waitUntil(() => log.events.length === 1, 'the snapshot');
    expect(log.errors.map((e) => e.code)).toEqual(['ws_frame_invalid']);
  });

  test('a reconnect re-fetches the key, re-subscribes, then emits reconnected', async () => {
    const r = await rig({
      session: fakeSession({ keys: [KEY_1, KEY_2], held: true }),
    });
    const log = watch(r.rt.marketActivityChannel({ marketId: 4 }));
    const first = await r.backend.accept('/market-activity');
    await waitUntil(() => log.events.length === 1, 'the snapshot', 4_000);
    first.drop();
    const second = await r.backend.accept('/market-activity');
    expect(second.handshake.auth).toEqual({ token: KEY_2 });
    const { payload } = await nthSubscribe(second);
    expect(payload).toEqual({ marketId: 4, filters: {} });
    await waitUntil(() => log.events.length === 2, 'the second snapshot');
    expect(log.order).toEqual([
      'market_activity_snapshot',
      'reconnected',
      'market_activity_snapshot',
    ]);
  });

  test('marketId and filters are checked before anything connects', async () => {
    const r = await rig({ session: 'none' });
    const bad: Array<[unknown, RegExp]> = [
      [{}, /marketId/],
      [{ marketId: 0 }, /marketId/],
      [{ marketId: '1' }, /marketId/],
      [{ marketId: 1, filters: { take: 51 } }, /take/],
      [{ marketId: 1, filters: { sortBy: 'price' } }, /sortBy/],
      [{ marketId: 1, filters: { positionType: 'REDEEM' } }, /positionType/],
      [{ marketId: 1, filters: { search: 'x' } }, /search is not available/],
      [{ marketId: 1, filters: { foo: 1 } }, /unknown param "foo"/],
      [{ marketId: 1, other: true }, /unknown key "other"/],
    ];
    for (const [options, pattern] of bad) {
      const error = await caught(() =>
        r.rt.marketActivityChannel(options as never),
      );
      expect(error, JSON.stringify(options)).toBeInstanceOf(UserInputError);
      expect((error as Error).message, JSON.stringify(options)).toMatch(
        pattern,
      );
    }
    await settle(100);
    expect(r.backend.connections).toHaveLength(0);
  });
});
