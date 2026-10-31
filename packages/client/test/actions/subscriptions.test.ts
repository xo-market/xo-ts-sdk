import { setupServer } from 'msw/node';
import { getAddress } from 'viem';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { WebSocket as WsClient } from 'ws';
import type { ChainReader } from '../../src/account/chain';
import {
  closeSubscriptions,
  secureSubscribe,
  subscribe,
} from '../../src/actions/subscriptions';
import type { Session } from '../../src/auth/session';
import type { ActionContext, SecureParts } from '../../src/clients/context';
import { resetProcessState, setClientSeams } from '../../src/clients/internal';
import { createPublicClient } from '../../src/clients/public';
import type { SecureClient } from '../../src/clients/secure';
import type { Clock } from '../../src/core/clock';
import type { EnvironmentConfig } from '../../src/core/env';
import {
  AuthRequiredError,
  UserInputError,
  type XoError,
} from '../../src/core/errors';
import { Transport } from '../../src/core/transport';
import type { DataClient } from '../../src/data/client';
import type {
  SubscriptionEvent,
  SubscriptionHandle,
} from '../../src/models/realtime';
import { OrderbookClient } from '../../src/orderbook/client';
import { RealtimeHub } from '../../src/realtime/merged';
import { ReconnectingWs } from '../../src/realtime/reconnectingWs';
import { pageMeta } from '../helpers/mockBackendData';
import {
  CONDITION_A,
  CONDITION_B,
  installMarketData,
  TOKEN_NO,
  TOKEN_YES,
} from '../helpers/mockMarketData';
import { wireStyleKeys } from '../helpers/modelKeys';
import { refuseRealHosts } from '../helpers/networkGuard';
import { railChain } from '../helpers/railChain';
import {
  chainReads,
  defaultChainState,
  signedInClient,
} from '../helpers/secureRig';
import {
  type MockSocketBackend,
  startSocketBackend,
} from '../helpers/socketBackend';
import { fakeSession, nthSubscribe } from '../helpers/socketRig';
import { testEnv, testEnvWithBridge } from '../helpers/testEnv';
import {
  type ServerConnection,
  settle,
  startWsServer,
  type WsTestServer,
  waitUntil,
} from '../helpers/wsServer';

// `subscribe`: one handle over every live topic. A local `ws` server stands in for the order
// book's /ws/market and /ws/user, an in-process Socket.IO server for the backend's
// /portfolio and /market-activity, and msw for the token lookups of the market channel. No live
// endpoint.

const WsImpl = WsClient as unknown as typeof WebSocket;

const mswServer = setupServer();
beforeAll(() => mswServer.listen({ onUnhandledRequest: refuseRealHosts() }));
afterAll(() => mswServer.close());

const servers: WsTestServer[] = [];
const backends: MockSocketBackend[] = [];
const handles: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    await handle.close();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const backend of backends.splice(0)) {
    await backend.close();
  }
  mswServer.resetHandlers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Frames, as the gateway sends them
// ---------------------------------------------------------------------------

const OWNER = `0x${'0a'.repeat(20)}`;
const ORDER_HASH = `0x${'4e'.repeat(32)}`;
const MS = '1800000000123';

const bookFrame = (asset = TOKEN_YES, market = CONDITION_A) => ({
  event_type: 'book',
  asset_id: asset,
  market,
  // Best first, as the gateway lists them.
  bids: [
    { price: '0.550', size: '100' },
    { price: '0.540', size: '5' },
  ],
  asks: [
    { price: '0.560', size: '80.123456' },
    { price: '0.570', size: '1' },
  ],
  timestamp: MS,
  hash: 'ab12cd',
});
const PRICE_CHANGE_FRAME = {
  event_type: 'price_change',
  market: CONDITION_A,
  price_changes: [
    {
      asset_id: TOKEN_YES,
      price: '0.55',
      size: '100',
      side: 'BUY',
      hash: 'h1',
      best_bid: '0.55',
      best_ask: '0.56',
    },
    {
      asset_id: TOKEN_NO,
      price: '0.45',
      size: '0',
      side: 'SELL',
      hash: 'h2',
      best_bid: '',
      best_ask: '0.45',
    },
  ],
  timestamp: MS,
};
const LAST_TRADE_FRAME = {
  event_type: 'last_trade_price',
  asset_id: TOKEN_YES,
  market: CONDITION_A,
  price: '0.555',
  side: 'BUY',
  size: '10',
  fee_rate_bps: '0',
  timestamp: '1800000000',
};
const ORDER_PLACEMENT = {
  event_type: 'order',
  id: ORDER_HASH,
  owner: OWNER,
  maker_address: OWNER,
  market: CONDITION_A,
  asset_id: TOKEN_YES,
  side: 'BUY',
  original_size: '10',
  size_matched: '0',
  price: '0.5',
  type: 'PLACEMENT',
  status: 'LIVE',
  outcome: 'YES',
  order_type: 'GTD',
  expiration: '1800000000',
  created_at: 1_800_000_000,
  last_update: MS,
  timestamp: MS,
};
const ORDER_REJECTED = {
  event_type: 'order',
  owner: OWNER,
  maker_address: OWNER,
  market: CONDITION_A,
  type: 'REJECTED',
  status: 'REJECTED',
  reason: 'insufficient balance',
  timestamp: MS,
};
const TRADE_MATCHED = {
  event_type: 'trade',
  id: `0x${'7d'.repeat(32)}`,
  taker_order_id: ORDER_HASH,
  maker_order_id: `0x${'5f'.repeat(32)}`,
  market: CONDITION_A,
  asset_id: TOKEN_YES,
  side: 'BUY',
  size: '10',
  price: '0.5',
  fee_rate_bps: '0',
  status: 'MATCHED',
  outcome: 'YES',
  maker_address: `0x${'0b'.repeat(20)}`,
  trader_side: 'TAKER',
  match_type: 'COMPLEMENTARY',
  last_update: MS,
  timestamp: MS,
};
const TRADE_CONFIRMED = {
  event_type: 'trade',
  id: `0x${'7d'.repeat(32)}`,
  market: CONDITION_A,
  status: 'CONFIRMED',
  timestamp: MS,
};

/** The gateway's answer to a subscribe frame. An unsubscribe gets none. */
function gatewayAnswer(text: string): string | undefined {
  try {
    const frame = JSON.parse(text) as Record<string, unknown>;
    const ids = frame.assets_ids ?? frame.markets;
    return frame.operation === 'unsubscribe' || !Array.isArray(ids)
      ? undefined
      : JSON.stringify({ type: 'subscribed', markets: ids });
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

interface RigOptions {
  /** A context with the signed-in parts (a fake session). Default true. */
  signedIn?: boolean;
  bufferSize?: number;
  /** Start the Socket.IO backend too. */
  socket?: boolean;
  /** The session's order book credentials; by default a valid set. */
  ensureOrderbook?: () => Promise<unknown>;
}

interface Rig {
  ctx: ActionContext;
  server: WsTestServer;
  backend: MockSocketBackend | undefined;
  env: EnvironmentConfig;
}

async function rig(o: RigOptions = {}): Promise<Rig> {
  const server = await startWsServer({ reply: gatewayAnswer });
  servers.push(server);
  const backend = o.socket === true ? await startSocketBackend() : undefined;
  if (backend !== undefined) {
    backends.push(backend);
  }
  const env: EnvironmentConfig = {
    ...testEnv,
    orderbookMarketWsUrl: `${server.url}/ws/market`,
    orderbookUserWsUrl: `${server.url}/ws/user`,
    ...(backend === undefined ? {} : { backendSocketUrl: backend.url }),
  };
  installMarketData(mswServer);
  const transport = new Transport({
    env: testEnv,
    version: '0.0.0-test',
    maxRetries: 0,
  });
  const orderbook = new OrderbookClient({
    transport,
    env: testEnv,
    strictResponses: true,
  });
  const signedIn = o.signedIn ?? true;
  const session = {
    ...fakeSession().session,
    ensureOrderbook:
      o.ensureOrderbook ??
      (async () => ({
        apiKey: '7f3c2a10-5b7e-4c8a-9d2e-1f0a6b3c4d5e',
        secret: 'c2VjcmV0LXZhbHVlLXRoYXQtbXVzdC1uZXZlci1sZWFrIQ==',
        passphrase: 'aa'.repeat(32),
      })),
  } as unknown as Session;
  const fast = { backoff: { baseMs: 1, capMs: 5 } };
  const realtime = new RealtimeHub({
    env,
    orderbook,
    ...(signedIn ? { session } : {}),
    WebSocket: WsImpl,
    strict: false,
    orderbookConnection: fast,
    backendConnection: fast,
    ...(o.bufferSize === undefined ? {} : { bufferSize: o.bufferSize }),
  });
  const ctx: ActionContext = {
    env,
    orderbook,
    data: {} as DataClient,
    chain: {} as ChainReader,
    clock: {} as Clock,
    strict: false,
    realtime,
    ...(signedIn
      ? { secure: { session, assertOpen: () => {} } as unknown as SecureParts }
      : {}),
  };
  return { ctx, server, backend, env };
}

interface Log {
  events: SubscriptionEvent[];
  errors: XoError[];
  reconnected: number;
  /** The topic of each `'reconnected'`, in order. */
  reconnectedTopics: string[];
  closed: number;
  /** The loop ended. */
  done: boolean;
}

/** Reads everything a handle delivers, and closes it after the test. */
function watch(handle: SubscriptionHandle<SubscriptionEvent>): Log {
  handles.push(handle);
  const log: Log = {
    events: [],
    errors: [],
    reconnected: 0,
    reconnectedTopics: [],
    closed: 0,
    done: false,
  };
  handle.on('error', (error) => log.errors.push(error));
  handle.on('reconnected', ({ topic }) => {
    log.reconnected += 1;
    log.reconnectedTopics.push(topic);
  });
  handle.on('closed', () => {
    log.closed += 1;
  });
  void (async () => {
    for await (const event of handle) {
      log.events.push(event);
    }
    log.done = true;
  })();
  return log;
}

/** The connection of `path` among the next `count` the server accepts. */
async function acceptAll(
  server: WsTestServer,
  count: number,
): Promise<ServerConnection[]> {
  const out: ServerConnection[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(await server.accept());
  }
  return out;
}

const byPath = (conns: ServerConnection[], path: string): ServerConnection => {
  const conn = conns.find((c) => c.path === path);
  if (conn === undefined) {
    throw new Error(`no connection on ${path}`);
  }
  return conn;
};

/** The first frame a connection received, parsed. */
async function firstFrame(
  conn: ServerConnection,
): Promise<Record<string, unknown>> {
  await waitUntil(() => conn.received.length > 0, 'a subscribe frame');
  return JSON.parse(conn.received[0] as string) as Record<string, unknown>;
}

async function caught(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

// ---------------------------------------------------------------------------
// One handle, several topics
// ---------------------------------------------------------------------------

describe('one handle for every topic', () => {
  test('yields the events of two topics in the order they arrive', async () => {
    const r = await rig();
    const log = watch(
      await secureSubscribe(r.ctx, [
        { topic: 'market', assetIds: [TOKEN_YES] },
        { topic: 'user' },
      ]),
    );
    const conns = await acceptAll(r.server, 2);
    const market = byPath(conns, '/ws/market');
    const user = byPath(conns, '/ws/user');

    market.send(JSON.stringify(bookFrame()));
    await waitUntil(() => log.events.length === 1, 'the book');
    user.send(JSON.stringify(ORDER_PLACEMENT));
    await waitUntil(() => log.events.length === 2, 'the order');
    market.send(JSON.stringify(LAST_TRADE_FRAME));
    await waitUntil(() => log.events.length === 3, 'the trade price');
    user.send(JSON.stringify(TRADE_MATCHED));
    await waitUntil(() => log.events.length === 4, 'the trade');

    expect(log.events.map((e) => `${e.topic}:${e.type}`)).toEqual([
      'market:book',
      'user:order',
      'market:last_trade_price',
      'user:trade',
    ]);
    expect(log.errors).toEqual([]);
  });

  test('every event is camelCase: assetId, never asset_id', async () => {
    const r = await rig();
    const log = watch(
      await secureSubscribe(r.ctx, [
        { topic: 'market', assetIds: [TOKEN_YES] },
        { topic: 'user' },
      ]),
    );
    const conns = await acceptAll(r.server, 2);
    const market = byPath(conns, '/ws/market');
    const user = byPath(conns, '/ws/user');
    for (const frame of [bookFrame(), PRICE_CHANGE_FRAME, LAST_TRADE_FRAME]) {
      market.send(JSON.stringify(frame));
    }
    for (const frame of [
      ORDER_PLACEMENT,
      ORDER_REJECTED,
      TRADE_MATCHED,
      TRADE_CONFIRMED,
    ]) {
      user.send(JSON.stringify(frame));
    }
    await waitUntil(() => log.events.length === 7, 'every event');

    expect(wireStyleKeys(log.events)).toEqual([]);
    const book = log.events.find((e) => e.type === 'book');
    expect(book).toEqual({
      topic: 'market',
      type: 'book',
      assetId: TOKEN_YES,
      market: CONDITION_A,
      // Best last, as fetchOrderBook lists them.
      bids: [
        { price: '0.540', size: '5' },
        { price: '0.550', size: '100' },
      ],
      asks: [
        { price: '0.570', size: '1' },
        { price: '0.560', size: '80.123456' },
      ],
      hash: 'ab12cd',
      timestamp: 1_800_000_000_123,
    });
    expect(book).not.toHaveProperty('asset_id');
    // With assetIds, the entries of the market's other token are left out.
    expect(log.events.find((e) => e.type === 'price_change')).toEqual({
      topic: 'market',
      type: 'price_change',
      market: CONDITION_A,
      priceChanges: [
        {
          assetId: TOKEN_YES,
          price: '0.55',
          size: '100',
          side: 'BUY',
          hash: 'h1',
          bestBid: '0.55',
          bestAsk: '0.56',
        },
      ],
      timestamp: 1_800_000_000_123,
    });
    expect(log.events.find((e) => e.type === 'last_trade_price')).toEqual({
      topic: 'market',
      type: 'last_trade_price',
      assetId: TOKEN_YES,
      market: CONDITION_A,
      price: '0.555',
      side: 'BUY',
      size: '10',
      feeRateBps: '0',
      // Sent in seconds, read as milliseconds.
      timestamp: 1_800_000_000_000,
    });
    const orders = log.events.filter((e) => e.type === 'order');
    expect(orders[0]).toMatchObject({
      topic: 'user',
      kind: 'PLACEMENT',
      orderId: ORDER_HASH,
      assetId: TOKEN_YES,
      side: 'BUY',
      originalSize: '10',
      sizeMatched: '0',
      orderType: 'GTD',
      expiration: '2027-01-15T08:00:00.000Z',
      reason: null,
      owner: getAddress(OWNER),
      makerAddress: getAddress(OWNER),
    });
    expect(orders[1]).toMatchObject({
      kind: 'REJECTED',
      orderId: null,
      assetId: null,
      reason: 'insufficient balance',
    });
    const trades = log.events.filter((e) => e.type === 'trade');
    expect(trades[0]).toMatchObject({
      status: 'MATCHED',
      takerOrderId: ORDER_HASH,
      traderSide: 'TAKER',
      matchType: 'COMPLEMENTARY',
    });
    expect(trades[1]).toMatchObject({
      status: 'CONFIRMED',
      assetId: null,
      takerOrderId: null,
    });
  });

  test('a market followed by assetIds leaves out the other tokens of its market', async () => {
    const r = await rig();
    const log = watch(
      await subscribe(r.ctx, [{ topic: 'market', assetIds: [TOKEN_YES] }]),
    );
    const [market] = await acceptAll(r.server, 1);
    market?.send(JSON.stringify(bookFrame(TOKEN_NO)));
    market?.send(JSON.stringify(bookFrame(TOKEN_YES)));
    await waitUntil(() => log.events.length === 1, 'the book');
    await settle();
    expect(log.events.map((e) => e.type === 'book' && e.assetId)).toEqual([
      TOKEN_YES,
    ]);
  });

  test('markets are subscribed by their tokens, and every token of them is kept', async () => {
    const r = await rig({ signedIn: false });
    const log = watch(
      await subscribe(r.ctx, [
        {
          topic: 'market',
          markets: [CONDITION_A.toUpperCase().replace('0X', '0x')],
        },
      ]),
    );
    const [market] = await acceptAll(r.server, 1);
    const frame = await firstFrame(market as ServerConnection);
    expect(frame).toMatchObject({
      type: 'market',
      assets_ids: [TOKEN_YES, TOKEN_NO],
      initial_dump: true,
      custom_feature_enabled: false,
    });
    market?.send(JSON.stringify(bookFrame(TOKEN_NO)));
    market?.send(JSON.stringify(PRICE_CHANGE_FRAME));
    // Another market's event is never delivered.
    market?.send(JSON.stringify(bookFrame(TOKEN_YES, CONDITION_B)));
    await waitUntil(() => log.events.length === 2, 'the events');
    await settle();
    expect(log.events).toHaveLength(2);
    const change = log.events[1];
    expect(change?.type === 'price_change' && change.priceChanges).toHaveLength(
      2,
    );
  });

  test('the specs of one topic are merged: one market channel for every market spec', async () => {
    const r = await rig();
    watch(
      await secureSubscribe(r.ctx, [
        { topic: 'market', assetIds: [TOKEN_YES] },
        { topic: 'market', assetIds: [TOKEN_NO, TOKEN_YES] },
        { topic: 'user' },
        { topic: 'user' },
      ]),
    );
    const conns = await acceptAll(r.server, 2);
    await settle();
    expect(r.server.connections).toHaveLength(2);
    expect((await firstFrame(byPath(conns, '/ws/market'))).assets_ids).toEqual([
      TOKEN_YES,
      TOKEN_NO,
    ]);
    expect(await firstFrame(byPath(conns, '/ws/user'))).toMatchObject({
      type: 'user',
      markets: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('the life of a handle', () => {
  test('close() closes the sockets, ends the loop and emits closed once', async () => {
    const r = await rig();
    const handle = await secureSubscribe(r.ctx, [
      { topic: 'market', assetIds: [TOKEN_YES] },
      { topic: 'user' },
    ]);
    const log = watch(handle);
    const conns = await acceptAll(r.server, 2);
    const closing = handle.close();
    expect(handle.close()).toBe(closing);
    await closing;
    await Promise.all(conns.map((conn) => conn.closed));
    await waitUntil(() => log.done, 'the loop to end');
    expect(log.closed).toBe(1);
    // Nothing reconnects.
    await settle(50);
    expect(r.server.connections).toHaveLength(2);
    expect(r.ctx.realtime.handles.size).toBe(0);
  });

  test('a server drop emits reconnected once on the handle', async () => {
    const r = await rig();
    const log = watch(
      await subscribe(r.ctx, [{ topic: 'market', assetIds: [TOKEN_YES] }]),
    );
    const [first] = await acceptAll(r.server, 1);
    await firstFrame(first as ServerConnection);
    first?.drop();
    const [second] = await acceptAll(r.server, 1);
    expect(await firstFrame(second as ServerConnection)).toMatchObject({
      assets_ids: [TOKEN_YES],
    });
    await waitUntil(() => log.reconnected === 1, 'reconnected');
    await settle(50);
    expect(log.reconnected).toBe(1);
    expect(log.reconnectedTopics).toEqual(['market']);
    expect(log.done).toBe(false);
  });

  test('outcome tokens that cannot be subscribed: ws_subscribe_failed on the handle, with its topic', async () => {
    const r = await rig();
    vi.spyOn(ReconnectingWs.prototype, 'start').mockImplementationOnce(() => {
      throw new Error('the socket could not start');
    });
    const log = watch(
      await subscribe(r.ctx, [{ topic: 'market', assetIds: [TOKEN_YES] }]),
    );
    await waitUntil(() => log.errors.length === 1, 'the error');
    const error = log.errors[0] as XoError;
    expect(error.code).toBe('ws_subscribe_failed');
    expect(error.topic).toBe('market');
    expect((error.cause as Error).message).toBe('the socket could not start');
  });

  test('a slow loop is told its buffer overflowed', async () => {
    const r = await rig({ bufferSize: 2 });
    const handle = await subscribe(r.ctx, [
      { topic: 'market', assetIds: [TOKEN_YES] },
    ]);
    handles.push(handle);
    const errors: XoError[] = [];
    handle.on('error', (error) => errors.push(error));
    const [market] = await acceptAll(r.server, 1);
    // Nobody reads: the first loop's buffer holds two events, then drops the oldest.
    for (let i = 0; i < 4; i += 1) {
      market?.send(JSON.stringify({ ...bookFrame(), hash: `h${i}` }));
    }
    await waitUntil(() => errors.length === 1, 'the overflow');
    expect(errors[0]?.code).toBe('subscription_overflow');
    // About the whole handle: it names no topic.
    expect(errors[0]?.topic).toBeUndefined();
    const read: string[] = [];
    for await (const event of handle) {
      read.push(event.type === 'book' ? event.hash : '');
      if (read.length === 2) {
        break;
      }
    }
    expect(read).toEqual(['h2', 'h3']);
  });

  test('more than 100 tokens are split over several connections', async () => {
    const r = await rig();
    const tokens = Array.from({ length: 150 }, (_, i) => String(1000 + i));
    watch(await subscribe(r.ctx, [{ topic: 'market', assetIds: tokens }]));
    const conns = await acceptAll(r.server, 2);
    const frames = await Promise.all(conns.map(firstFrame));
    const sent = frames.map((f) => f.assets_ids as string[]);
    expect(sent.map((ids) => ids.length).sort()).toEqual([100, 50].sort());
    expect(sent.flat().sort()).toEqual([...tokens].sort());
  });

  test('a handle whose every stream stopped for good closes, so a loop never hangs', async () => {
    const r = await rig({ socket: true });
    const backend = r.backend as MockSocketBackend;
    backend.portfolioAuth = () => ({ userId: 7, scopes: [] });
    const log = watch(await secureSubscribe(r.ctx, [{ topic: 'portfolio' }]));
    await waitUntil(() => log.done, 'the loop to end', 6_000);
    expect(log.errors.map((e) => e.code)).toContain('INSUFFICIENT_SCOPE');
    expect(log.closed).toBe(1);
  });

  test('on() takes the lifecycle only; a closed listener added after the end still hears it', async () => {
    const r = await rig();
    const handle = await subscribe(r.ctx, [
      { topic: 'market', assetIds: [TOKEN_YES] },
    ]);
    handles.push(handle);
    const error = await caught(() =>
      handle.on('book' as 'closed', () => undefined),
    );
    expect(error).toBeInstanceOf(UserInputError);
    await handle.close();
    const late = vi.fn();
    handle.on('closed', late);
    await waitUntil(() => late.mock.calls.length === 1, 'the late closed');
    // A loop over a closed handle ends at once.
    const seen: unknown[] = [];
    for await (const event of handle) {
      seen.push(event);
    }
    expect(seen).toEqual([]);
  });

  test('closeSubscriptions closes every handle of the client', async () => {
    const r = await rig();
    const a = watch(
      await subscribe(r.ctx, [{ topic: 'market', assetIds: [TOKEN_YES] }]),
    );
    const b = watch(await secureSubscribe(r.ctx, [{ topic: 'user' }]));
    const conns = await acceptAll(r.server, 2);
    expect(r.ctx.realtime.handles.size).toBe(2);
    await closeSubscriptions(r.ctx);
    await Promise.all(conns.map((conn) => conn.closed));
    await waitUntil(() => a.done && b.done, 'both loops to end');
    expect([a.closed, b.closed]).toEqual([1, 1]);
    expect(r.ctx.realtime.handles.size).toBe(0);
    await expect(closeSubscriptions(r.ctx)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A topic that stops, and the topic of every signal
// ---------------------------------------------------------------------------

/** A session that can never give the order book credentials. */
const noCredentials = async (): Promise<never> => {
  throw new AuthRequiredError('no credentials');
};

describe('a topic that stops, and the topic of every signal', () => {
  test('credentials that cannot work: the error is on the handle, the loop ends, closed fires once', async () => {
    const r = await rig({ ensureOrderbook: noCredentials });
    const log = watch(await secureSubscribe(r.ctx, [{ topic: 'user' }]));
    const [conn] = await acceptAll(r.server, 1);
    await waitUntil(() => log.done, 'the loop to end');
    await waitUntil(() => log.closed === 1, 'closed');
    expect(log.errors.map((e) => e.code)).toEqual(['ws_auth_unrecoverable']);
    const error = log.errors[0] as XoError;
    expect(error.topic).toBe('user');
    // In the words of a subscription: subscribe again, not "open a new channel".
    expect(error.message).toContain('subscribe again once the cause is fixed');
    expect(error.message).not.toContain('new channel');
    expect(log.closed).toBe(1);
    await conn?.closed;
    await settle(50);
    expect(log.closed).toBe(1);
    expect(r.server.connections).toHaveLength(1);
    expect(r.ctx.realtime.handles.size).toBe(0);
  });

  test('market and user: the market goes on after the user topic stops, and the handle ends when both have', async () => {
    const r = await rig({ ensureOrderbook: noCredentials });
    const engine = r.ctx.realtime.orderbook();
    const open = engine.marketChannelOf.bind(engine);
    let marketStream: { close(): Promise<void> } | undefined;
    vi.spyOn(engine, 'marketChannelOf').mockImplementation((o) => {
      const sub = open(o);
      marketStream = sub;
      return sub;
    });
    const log = watch(
      await secureSubscribe(r.ctx, [
        { topic: 'market', assetIds: [TOKEN_YES] },
        { topic: 'user' },
      ]),
    );
    const conns = await acceptAll(r.server, 2);
    await waitUntil(() => log.errors.length === 1, 'the user topic to stop');
    await byPath(conns, '/ws/user').closed;
    await settle(50);
    expect(log.errors[0]?.topic).toBe('user');
    expect(log.done).toBe(false);
    expect(log.closed).toBe(0);

    byPath(conns, '/ws/market').send(JSON.stringify(bookFrame()));
    await waitUntil(() => log.events.length === 1, 'a market event');
    expect(log.events[0]?.topic).toBe('market');

    // The market stream ends too (closed underneath here): only now does the handle end.
    await marketStream?.close();
    await waitUntil(() => log.done, 'the loop to end');
    await waitUntil(() => log.closed === 1, 'closed');
  });

  test('one drop of every connection: reconnected once per topic, each naming its topic', async () => {
    const r = await rig();
    const log = watch(
      await secureSubscribe(r.ctx, [
        { topic: 'market', assetIds: [TOKEN_YES] },
        { topic: 'user' },
      ]),
    );
    const first = await acceptAll(r.server, 2);
    await Promise.all(first.map(firstFrame));
    for (const conn of first) {
      conn.drop();
    }
    const second = await acceptAll(r.server, 2);
    await Promise.all(second.map(firstFrame));
    await waitUntil(() => log.reconnected === 2, 'both reconnects');
    await settle(50);
    expect(log.reconnected).toBe(2);
    expect([...log.reconnectedTopics].sort()).toEqual(['market', 'user']);
    expect(log.done).toBe(false);
  });

  test('an error of a topic names it: ws_events_dropped from the market', async () => {
    const r = await rig();
    const log = watch(
      await secureSubscribe(r.ctx, [
        { topic: 'market', assetIds: [TOKEN_YES] },
        { topic: 'user' },
      ]),
    );
    const conns = await acceptAll(r.server, 2);
    const market = byPath(conns, '/ws/market');
    const snapshot = {
      event_type: 'trading_state_changed',
      state: 'active',
      source: 'snapshot',
      timestamp: MS,
    };
    // The first snapshot of a socket is its connect snapshot; another one is a lag.
    market.send(JSON.stringify(snapshot));
    market.send(JSON.stringify(snapshot));
    await waitUntil(() => log.errors.length === 1, 'the lag');
    const error = log.errors[0] as XoError;
    expect(error.code).toBe('ws_events_dropped');
    expect(error.topic).toBe('market');
    expect(error.toJSON()).toMatchObject({
      code: 'ws_events_dropped',
      topic: 'market',
    });
    // The state of the market topic is what to read again; nothing is said of the old helpers.
    expect(error.message).not.toMatch(/resyncBooks|resyncMyOrders/);
  });

  test('an event a topic cannot read is dropped, and the error names the topic', async () => {
    const r = await rig({ socket: true });
    const backend = r.backend as MockSocketBackend;
    backend.onPortfolioSubscribe = (conn, _payload, ack) => {
      conn.socket.emit('portfolio_snapshot', {
        type: 'portfolio_snapshot',
        data: [],
        meta: pageMeta(1, 100, 0),
        filters: { page: 1, take: 100 },
        emittedAt: 'not a time',
      });
      ack?.({ ok: true });
      return 'handled';
    };
    const log = watch(await secureSubscribe(r.ctx, [{ topic: 'portfolio' }]));
    await waitUntil(() => log.errors.length === 1, 'the error', 6_000);
    expect(log.errors[0]?.code).toBe('ws_frame_invalid');
    expect(log.errors[0]?.topic).toBe('portfolio');
    expect(log.events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The backend's topics
// ---------------------------------------------------------------------------

describe('the portfolio and activity topics', () => {
  test('positions and trades, camelCase, in one handle', async () => {
    const r = await rig({ socket: true });
    const backend = r.backend as MockSocketBackend;
    const log = watch(
      await secureSubscribe(r.ctx, [
        { topic: 'portfolio' },
        { topic: 'activity', marketId: '7' },
      ]),
    );
    await waitUntil(() => log.events.length === 2, 'both snapshots', 6_000);
    const portfolio = log.events.find((e) => e.topic === 'portfolio');
    const activity = log.events.find((e) => e.topic === 'activity');
    expect(portfolio).toMatchObject({ type: 'positions' });
    expect(
      portfolio?.type === 'positions' && portfolio.positions.length,
    ).toBeGreaterThan(0);
    expect(activity).toMatchObject({ type: 'trades', marketId: '7' });
    expect(activity?.type === 'trades' && activity.trades).toHaveLength(2);
    expect(typeof portfolio?.timestamp).toBe('number');
    expect(wireStyleKeys(log.events)).toEqual([]);

    const sent = await Promise.all(
      backend.connections.map((conn) => nthSubscribe(conn)),
    );
    const payloads = sent.map((s) => s.payload);
    // The listPositions default set: no status filter, every market type, 100 markets.
    expect(payloads).toContainEqual({ take: 100, marketScope: 'withPulse' });
    expect(payloads).toContainEqual({
      marketId: 7,
      filters: { take: 50, sortBy: 'executedAt', sortOrder: 'DESC' },
    });
  });

  test('activity needs no sign-in', async () => {
    const r = await rig({ socket: true, signedIn: false });
    const log = watch(
      await subscribe(r.ctx, [{ topic: 'activity', marketId: '12' }]),
    );
    await waitUntil(() => log.events.length === 1, 'the snapshot', 6_000);
    expect(log.events[0]).toMatchObject({ topic: 'activity', marketId: '12' });
  });
});

// ---------------------------------------------------------------------------
// What is refused
// ---------------------------------------------------------------------------

describe('what subscribe refuses, before anything connects', () => {
  test.each([
    ['user', { topic: 'user' }],
    ['portfolio', { topic: 'portfolio' }],
  ])(
    'a client without a wallet: the %s topic needs a sign-in',
    async (_name, spec) => {
      const r = await rig({ signedIn: false });
      for (const run of [
        () => subscribe(r.ctx, [spec] as never),
        () => secureSubscribe(r.ctx, [spec] as never),
        () =>
          subscribe(r.ctx, [
            { topic: 'market', assetIds: [TOKEN_YES] },
            spec,
          ] as never),
      ]) {
        const error = await caught(run);
        expect(error).toBeInstanceOf(UserInputError);
        expect((error as XoError).code).toBe('topic_needs_sign_in');
      }
      await settle();
      expect(r.server.connections).toHaveLength(0);
      expect(r.ctx.realtime.handles.size).toBe(0);
    },
  );

  test.each([
    ['no list', undefined, 'non-empty list'],
    ['an empty list', [], 'non-empty list'],
    ['an unknown topic', [{ topic: 'books' }], 'specs[0].topic must be one of'],
    [
      'a market without ids',
      [{ topic: 'market' }],
      'needs assetIds or markets',
    ],
    [
      'empty id lists',
      [{ topic: 'market', assetIds: [], markets: [] }],
      'needs assetIds or markets',
    ],
    [
      'a token id that is not one',
      [{ topic: 'market', assetIds: ['0xabc'] }],
      'assetIds.0',
    ],
    [
      'a condition id that is not one',
      [{ topic: 'market', markets: ['abc'] }],
      'markets.0',
    ],
    [
      'an unknown key',
      [{ topic: 'market', assetIds: [TOKEN_YES], channel: 'x' }],
      'unknown key "channel"',
    ],
    [
      'a market id that is not one',
      [{ topic: 'activity', marketId: '0' }],
      'marketId',
    ],
    [
      'detail, which the portfolio topic does not take',
      [{ topic: 'portfolio', detail: true }],
      'unknown key "detail"',
    ],
  ])('%s', async (_name, specs, message) => {
    const r = await rig();
    const error = await caught(() => secureSubscribe(r.ctx, specs as never));
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as XoError).code).toBe('invalid_input');
    expect((error as XoError).message).toContain(message);
    await settle();
    expect(r.server.connections).toHaveLength(0);
  });

  test('a channel that cannot open closes the ones opened before it', async () => {
    const r = await rig();
    const closes: unknown[] = [];
    const backend = r.ctx.realtime.backend();
    vi.spyOn(backend, 'portfolioChannel').mockImplementation(() => {
      throw new UserInputError('refused');
    });
    const market = r.ctx.realtime.orderbook();
    const open = market.marketChannelOf.bind(market);
    vi.spyOn(market, 'marketChannelOf').mockImplementation((o) => {
      const sub = open(o);
      const close = sub.close.bind(sub);
      vi.spyOn(sub, 'close').mockImplementation(() => {
        closes.push(o);
        return close();
      });
      return sub;
    });
    const error = await caught(() =>
      secureSubscribe(r.ctx, [
        { topic: 'market', assetIds: [TOKEN_YES] },
        { topic: 'portfolio' },
      ]),
    );
    expect((error as XoError).message).toBe('refused');
    expect(closes).toHaveLength(1);
    expect(r.ctx.realtime.handles.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// On the clients
// ---------------------------------------------------------------------------

describe('subscribe on the clients', () => {
  const clients: SecureClient[] = [];
  const fast = { backoff: { baseMs: 1, capMs: 5 } };

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((c) => c.close()));
    setClientSeams({});
    resetProcessState();
  });

  /** A ws server, and an environment whose order book sockets go to it. */
  async function wsEnv(base: EnvironmentConfig) {
    const server = await startWsServer({ reply: gatewayAnswer });
    servers.push(server);
    const env: EnvironmentConfig = {
      ...base,
      orderbookMarketWsUrl: `${server.url}/ws/market`,
      orderbookUserWsUrl: `${server.url}/ws/user`,
    };
    return { server, env };
  }

  async function signedIn() {
    const chain = railChain();
    chainReads(chain, testEnvWithBridge, defaultChainState(testEnvWithBridge));
    setClientSeams({
      chain: chain.reader,
      realtime: { orderbookConnection: fast },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { server, env } = await wsEnv(testEnvWithBridge);
    const { client } = await signedInClient(mswServer, {
      env,
      WebSocket: WsImpl,
    });
    clients.push(client);
    return { client, server };
  }

  test('a client without a wallet refuses the account topics: topic_needs_sign_in', async () => {
    const { server, env } = await wsEnv(testEnv);
    const client = createPublicClient({ environment: env, WebSocket: WsImpl });
    for (const spec of [{ topic: 'user' }, { topic: 'portfolio' }]) {
      const error = await caught(() => client.subscribe([spec] as never));
      expect(error).toBeInstanceOf(UserInputError);
      expect((error as XoError).code).toBe('topic_needs_sign_in');
    }
    await settle();
    expect(server.connections).toHaveLength(0);
  });

  test('a client without a wallet streams the market, and closeSubscriptions ends it', async () => {
    installMarketData(mswServer);
    const { server, env } = await wsEnv(testEnv);
    const client = createPublicClient({ environment: env, WebSocket: WsImpl });
    const log = watch(
      await client.subscribe([{ topic: 'market', assetIds: [TOKEN_YES] }]),
    );
    const [market] = await acceptAll(server, 1);
    market?.send(JSON.stringify(bookFrame()));
    await waitUntil(() => log.events.length === 1, 'the book');
    await client.closeSubscriptions();
    await market?.closed;
    await waitUntil(() => log.done, 'the loop to end');
    expect(log.closed).toBe(1);
    // It can subscribe again.
    watch(await client.subscribe([{ topic: 'market', assetIds: [TOKEN_NO] }]));
    await acceptAll(server, 1);
  });

  test.each(['close', 'endAuthentication'] as const)(
    '%s() ends every open handle, and a handle used afterwards ends at once',
    async (end) => {
      const { client, server } = await signedIn();
      const handle = await client.subscribe([
        { topic: 'market', assetIds: [TOKEN_YES] },
        { topic: 'user' },
      ]);
      const log = watch(handle);
      const conns = await acceptAll(server, 2);
      const user = byPath(conns, '/ws/user');
      expect(await firstFrame(user)).toMatchObject({ type: 'user' });
      user.send(JSON.stringify(ORDER_PLACEMENT));
      await waitUntil(() => log.events.length === 1, 'the order');

      // The subscriptions close whether the sign-out works or not (these fakes refuse its
      // revoke of the key): only that is checked here.
      await client[end]().then(
        () => undefined,
        () => undefined,
      );
      await Promise.all(conns.map((conn) => conn.closed));
      await waitUntil(() => log.done, 'the loop to end');
      expect(log.closed).toBe(1);

      const seen: unknown[] = [];
      for await (const event of handle) {
        seen.push(event);
      }
      expect(seen).toEqual([]);
      const late = vi.fn();
      handle.on('closed', late);
      await waitUntil(() => late.mock.calls.length === 1, 'the late closed');
      await expect(handle.close()).resolves.toBeUndefined();

      for (const run of [
        () => client.subscribe([{ topic: 'user' }]),
        () => client.closeSubscriptions(),
      ]) {
        const error = await caught(run);
        expect(error).toBeInstanceOf(UserInputError);
        expect((error as XoError).code).toBe('client_closed');
      }
      await settle(50);
      expect(server.connections).toHaveLength(2);
    },
  );
});
