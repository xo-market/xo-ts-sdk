import { inspect } from 'node:util';
import { setupServer } from 'msw/node';
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
import { Session } from '../../src/auth/session';
import { Clock } from '../../src/core/clock';
import type { EnvironmentConfig } from '../../src/core/env';
import {
  AuthRequiredError,
  RateLimitError,
  RequestRejectedError,
  SigningError,
  TimeoutError,
  TransportError,
  UnexpectedResponseError,
  UserInputError,
  XoError,
} from '../../src/core/errors';
import { Transport } from '../../src/core/transport';
import { OrderbookClient } from '../../src/orderbook/client';
import {
  type MarketChannelEvent,
  OrderbookRealtime,
  type OrderbookRealtimeOptions,
  type UserChannelEvent,
} from '../../src/realtime/orderbookWs';
import type { Subscription } from '../../src/realtime/subscription';
import type { OrderbookCredential } from '../../src/signing/hmac';
import {
  CONDITION_A,
  CONDITION_B,
  type FixtureMarket,
  installMarketData,
  type MarketData,
  TOKEN_NO,
  TOKEN_YES,
} from '../helpers/mockMarketData';
import { installOrderbook, seedKey } from '../helpers/mockOrderbook';
import { installTrading } from '../helpers/mockTrading';
import { refuseRealHosts } from '../helpers/networkGuard';
import { rejectedWith } from '../helpers/rejections';
import { testEnv } from '../helpers/testEnv';
import {
  type ServerConnection,
  settle,
  startWsServer,
  type WsTestServer,
  waitUntil,
} from '../helpers/wsServer';

// The orderbook channels against a local `ws` server that stands in for the gateway's
// /ws/market and /ws/user, and msw for the REST reads
// (the token lookup of the market channel and the resync helpers). No live endpoint.

const WsImpl = WsClient as unknown as typeof WebSocket;

const mswServer = setupServer();
beforeAll(() =>
  mswServer.listen({
    // The WebSocket upgrades go to the local `ws` server: let them through, and error the rest,
    // so that nothing unhandled reaches a real host (see test/helpers/networkGuard.ts).
    onUnhandledRequest: refuseRealHosts(),
  }),
);
afterAll(() => mswServer.close());

const servers: WsTestServer[] = [];
const subs: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const sub of subs.splice(0)) {
    await sub.close();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
  mswServer.resetHandlers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures: credentials, and frames as the gateway emits them
// ---------------------------------------------------------------------------

/** Realistic shapes: a UUID, 32 bytes as padded base64url, 32 bytes as hex. */
const CREDS: OrderbookCredential = {
  apiKey: '7f3c2a10-5b7e-4c8a-9d2e-1f0a6b3c4d5e',
  secret: 'c2VjcmV0LXZhbHVlLXRoYXQtbXVzdC1uZXZlci1sZWFrIQ==',
  passphrase:
    '9b1f0c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c',
};
const ROTATED: OrderbookCredential = {
  apiKey: '11111111-2222-4333-8444-555555555555',
  secret: 'cm90YXRlZC1zZWNyZXQtdmFsdWUtZm9yLXRoZS10ZXN0cw==',
  passphrase: 'aa'.repeat(32),
};

const OWNER = `0x${'0a'.repeat(20)}`;
const ORDER_HASH = `0x${'4e'.repeat(32)}`;
const MAKER_HASH = `0x${'5f'.repeat(32)}`;
const TRADE_ID = `0x${'7d'.repeat(32)}`;
const MS = '1800000000123';
const SEC = '1800000000';

/** A condition id made from a number, for the tests that need many markets. */
const cid = (i: number): string => `0x${i.toString(16).padStart(64, '0')}`;
const range = (n: number, from = 0): string[] =>
  Array.from({ length: n }, (_, i) => cid(from + i));

// A live book snapshot, with last_update_id.
const BOOK_FRAME = {
  event_type: 'book',
  asset_id: TOKEN_YES,
  market: CONDITION_A,
  bids: [{ price: '0.550', size: '100' }],
  asks: [{ price: '0.560', size: '80.123456' }],
  timestamp: MS,
  hash: 'ab12cd',
  last_update_id: 42,
};
// The initial dump has no last_update_id.
const INITIAL_BOOK_FRAME = {
  event_type: 'book',
  asset_id: TOKEN_NO,
  market: CONDITION_A,
  bids: [],
  asks: [{ price: '0.450', size: '5' }],
  timestamp: MS,
  hash: 'ef34',
};
// A price change and its entries.
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
      hash: 'h1',
      best_bid: '',
      best_ask: '0.45',
    },
  ],
  timestamp: MS,
};
// The best bid and ask.
const BEST_BID_ASK_FRAME = {
  event_type: 'best_bid_ask',
  market: CONDITION_A,
  asset_id: TOKEN_YES,
  best_bid: '0.55',
  best_ask: '0.56',
  spread: '0.01',
  timestamp: MS,
};
// The last trade price of a fill: the fill's own time, in SECONDS.
const LAST_TRADE_FRAME = {
  event_type: 'last_trade_price',
  asset_id: TOKEN_YES,
  market: CONDITION_A,
  price: '0.555',
  side: 'BUY',
  size: '10',
  fee_rate_bps: '0',
  timestamp: SEC,
};
// A new market, and a resolved one.
const NEW_MARKET_FRAME = {
  event_type: 'new_market',
  id: CONDITION_A,
  question: '',
  market: CONDITION_A,
  slug: '',
  description: '',
  assets_ids: [],
  outcomes: ['Yes', 'No'],
  timestamp: MS,
  status: 'ACTIVE',
};
const MARKET_RESOLVED_FRAME = {
  event_type: 'market_resolved',
  id: CONDITION_A,
  market: CONDITION_A,
  assets_ids: [],
  outcomes: ['Yes', 'No'],
  winning_asset_id: '0',
  winning_outcome: '',
  timestamp: MS,
  status: 'RESOLVED',
};
// The trading state.
const tradingState = (source: string, state = 'active') => ({
  event_type: 'trading_state_changed',
  state,
  source,
  timestamp: MS,
});

// The user channel's events.
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
  order_type: 'GTC',
  expiration: '0',
  created_at: 1_800_000_000,
  last_update: MS,
  timestamp: MS,
};
const ORDER_UPDATE = {
  event_type: 'order',
  id: ORDER_HASH,
  owner: OWNER,
  maker_address: OWNER,
  market: CONDITION_A,
  asset_id: TOKEN_YES,
  side: 'BUY',
  original_size: '10',
  size_matched: '4',
  price: '0.5',
  type: 'UPDATE',
  status: 'LIVE',
  outcome: 'YES',
  timestamp: MS,
};
const ORDER_FILLED = { ...ORDER_UPDATE, size_matched: '10', status: 'MATCHED' };
const ORDER_CANCELLATION = {
  event_type: 'order',
  id: ORDER_HASH,
  owner: OWNER,
  maker_address: OWNER,
  market: CONDITION_A,
  asset_id: TOKEN_YES,
  side: 'BUY',
  price: '0.5',
  outcome: 'YES',
  type: 'CANCELLATION',
  status: 'CANCELED',
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
  id: TRADE_ID,
  taker_order_id: ORDER_HASH,
  maker_order_id: MAKER_HASH,
  market: CONDITION_A,
  asset_id: TOKEN_YES,
  side: 'BUY',
  size: '10',
  price: '0.5',
  fee_rate_bps: '0',
  status: 'MATCHED' as const,
  outcome: 'YES',
  maker_address: `0x${'0b'.repeat(20)}`,
  trader_side: 'TAKER',
  match_type: 'COMPLEMENTARY',
  last_update: '1800000000000',
  timestamp: '1800000000000',
};
const TRADE_CONFIRMED = {
  event_type: 'trade',
  id: TRADE_ID,
  market: CONDITION_A,
  status: 'CONFIRMED' as const,
  timestamp: MS,
};
// The gateway's own `orders_rebalanced` message.
const ORDERS_REBALANCED = {
  type: 'orders_rebalanced',
  cancelled_count: 2,
  cancelled_order_ids: [ORDER_HASH, MAKER_HASH],
};

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

/**
 * The gateway's answer to a subscribe frame: `{type: "subscribed", markets: <the ids sent>}`.
 * An unsubscribe gets no answer.
 */
function gatewayAnswer(text: string): string | undefined {
  let frame: unknown;
  try {
    frame = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof frame !== 'object' || frame === null) {
    return undefined;
  }
  const { operation, assets_ids, markets } = frame as Record<string, unknown>;
  const ids = assets_ids ?? markets;
  if (operation === 'unsubscribe' || !Array.isArray(ids)) {
    return undefined;
  }
  return JSON.stringify({ type: 'subscribed', markets: ids });
}

interface RigOptions {
  strict?: boolean;
  markets?: FixtureMarket[];
  ensureOrderbook?: () => Promise<OrderbookCredential>;
  onUnauthorized?: Session['onUnauthorized'];
  noSession?: boolean;
  connection?: OrderbookRealtimeOptions['connection'];
  /** Answer subscribe frames with `subscribed`, as the gateway does. Default true. */
  answer?: boolean;
}

interface Rig {
  rt: OrderbookRealtime;
  server: WsTestServer;
  market: MarketData;
  ensureOrderbook: ReturnType<typeof vi.fn<() => Promise<OrderbookCredential>>>;
  onUnauthorized: ReturnType<typeof vi.fn<Session['onUnauthorized']>>;
  env: EnvironmentConfig;
}

async function rig(o: RigOptions = {}): Promise<Rig> {
  const server = await startWsServer(
    o.answer === false ? {} : { reply: gatewayAnswer },
  );
  servers.push(server);
  const env: EnvironmentConfig = {
    ...testEnv,
    orderbookMarketWsUrl: `${server.url}/ws/market`,
    orderbookUserWsUrl: `${server.url}/ws/user`,
  };
  const market = installMarketData(
    mswServer,
    o.markets === undefined ? {} : { markets: o.markets },
  );
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
  const ensureOrderbook = vi.fn<() => Promise<OrderbookCredential>>(
    o.ensureOrderbook ?? (async () => ({ ...CREDS })),
  );
  const onUnauthorized = vi.fn<Session['onUnauthorized']>(
    o.onUnauthorized ?? (async () => true),
  );
  const rt = new OrderbookRealtime({
    env,
    orderbook,
    ...(o.noSession === true
      ? {}
      : {
          session: { ensureOrderbook, onUnauthorized } as unknown as Session,
        }),
    WebSocketImpl: WsImpl,
    strictResponses: o.strict ?? false,
    connection: { backoff: { baseMs: 1, capMs: 5 }, ...o.connection },
  });
  return { rt, server, market, ensureOrderbook, onUnauthorized, env };
}

interface Log<E> {
  events: E[];
  errors: XoError[];
  reconnected: number;
  closed: number;
}

/** Records everything a subscription emits, and closes it after the test. */
function watch<E extends { type: string }>(sub: Subscription<E>): Log<E> {
  subs.push(sub);
  const log: Log<E> = { events: [], errors: [], reconnected: 0, closed: 0 };
  // The iterator sees every event pushed after this point; nothing can arrive before.
  void (async () => {
    for await (const event of sub) {
      log.events.push(event);
    }
  })();
  sub.on('error', (error) => {
    log.errors.push(error);
  });
  sub.on('reconnected', () => {
    log.reconnected += 1;
  });
  sub.on('closed', () => {
    log.closed += 1;
  });
  return log;
}

/** The JSON frames a connection received, without the keepalive PINGs. */
const framesOf = (conn: ServerConnection): Array<Record<string, unknown>> =>
  conn.received
    .filter((text) => text !== 'PING')
    .map((text) => JSON.parse(text) as Record<string, unknown>);

async function frameCount(conn: ServerConnection, n: number): Promise<void> {
  await waitUntil(() => framesOf(conn).length >= n, `${n} frame(s)`);
}

async function firstFrame(
  conn: ServerConnection,
): Promise<Record<string, unknown>> {
  await frameCount(conn, 1);
  return framesOf(conn)[0] as Record<string, unknown>;
}

const sendFrame = (conn: ServerConnection, frame: unknown): void =>
  conn.send(JSON.stringify(frame));

async function caught(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** `count` binary markets with distinct tokens, for the market-data fake. */
function manyMarkets(count: number): FixtureMarket[] {
  return Array.from({ length: count }, (_, i) => ({
    condition_id: cid(i),
    yes: String(10_000 + 2 * i),
    no: String(10_001 + 2 * i),
    active: true,
  }));
}

// ---------------------------------------------------------------------------
// Market channel
// ---------------------------------------------------------------------------

describe('market channel: subscribe frames', () => {
  test('market subscribe frame is {type:"market", assets_ids:[...], initial_dump:true, custom_feature_enabled:false}', async () => {
    const r = await rig();
    watch(r.rt.marketChannel({ conditionIds: [CONDITION_A] }));
    const conn = await r.server.accept();
    expect(conn.path).toBe('/ws/market');
    // assets_ids carries token ids, so the gateway sends a book snapshot per
    // token (initial_dump). The tokens come from GET /markets/{condition_id}.
    expect(await firstFrame(conn)).toEqual({
      type: 'market',
      assets_ids: [TOKEN_YES, TOKEN_NO],
      initial_dump: true,
      custom_feature_enabled: false,
    });
    expect(r.market.calls).toEqual([`GET /markets/${CONDITION_A}`]);
    await settle();
    expect(framesOf(conn)).toHaveLength(1);
    expect(r.server.connections).toHaveLength(1);
  });

  test('customFeatures: true and initialDump: false; without an initial dump the frame carries condition ids and nothing is looked up', async () => {
    const r = await rig();
    watch(
      r.rt.marketChannel({
        conditionIds: [`0x${CONDITION_A.slice(2).toUpperCase()}`, CONDITION_B],
        customFeatures: true,
        initialDump: false,
      }),
    );
    const conn = await r.server.accept();
    expect(await firstFrame(conn)).toEqual({
      type: 'market',
      assets_ids: [CONDITION_A, CONDITION_B],
      initial_dump: false,
      custom_feature_enabled: true,
    });
    expect(r.market.calls).toEqual([]);
  });

  test('a market whose tokens cannot be looked up is subscribed by condition id, with one ws_tokens_unresolved error', async () => {
    const r = await rig();
    const unknown = `0x${'cd'.repeat(32)}`;
    const log = watch(
      r.rt.marketChannel({ conditionIds: [CONDITION_A, unknown] }),
    );
    const conn = await r.server.accept();
    expect(await firstFrame(conn)).toEqual({
      type: 'market',
      assets_ids: [TOKEN_YES, TOKEN_NO, unknown],
      initial_dump: true,
      custom_feature_enabled: false,
    });
    await waitUntil(() => log.errors.length === 1, 'the lookup error');
    const error = log.errors[0] as XoError;
    expect(error).toBeInstanceOf(XoError);
    expect(error.code).toBe('ws_tokens_unresolved');
    expect(error.service).toBe('orderbook');
    expect(error.message).toContain(unknown);
    expect(error.cause).toSatisfy(rejectedWith(404));
  });

  test('condition ids are validated and de-duplicated; options are closed', async () => {
    const r = await rig();
    expect(() => r.rt.marketChannel({ conditionIds: ['0x12'] })).toThrow(
      UserInputError,
    );
    expect(() =>
      r.rt.marketChannel({ conditionIds: CONDITION_A as never }),
    ).toThrow(UserInputError);
    expect(() =>
      r.rt.marketChannel({ conditionIds: [], extra: 1 } as never),
    ).toThrow(UserInputError);
    expect(() =>
      r.rt.marketChannel({ conditionIds: [], initialDump: 'yes' as never }),
    ).toThrow(UserInputError);
    expect(() =>
      r.rt.marketChannel({ conditionIds: [], customFeatures: 1 as never }),
    ).toThrow(UserInputError);
    expect(() => r.rt.marketChannel(undefined as never)).toThrow(
      UserInputError,
    );
    await settle();
    expect(r.server.connections).toHaveLength(0);

    watch(
      r.rt.marketChannel({
        conditionIds: [CONDITION_A, `0x${CONDITION_A.slice(2).toUpperCase()}`],
        initialDump: false,
      }),
    );
    const conn = await r.server.accept();
    expect((await firstFrame(conn)).assets_ids).toEqual([CONDITION_A]);
  });

  test('conditionIds: [] opens no connection until subscribe adds a market', async () => {
    const r = await rig();
    const sub = r.rt.marketChannel({ conditionIds: [], initialDump: false });
    watch(sub);
    await settle();
    expect(r.server.connections).toHaveLength(0);
    await r.rt.subscribe(sub, [CONDITION_B]);
    const conn = await r.server.accept();
    expect((await firstFrame(conn)).assets_ids).toEqual([CONDITION_B]);
  });
});

// ---------------------------------------------------------------------------
// User channel
// ---------------------------------------------------------------------------

describe('user channel', () => {
  test('user subscribe frame carries auth {apiKey,secret,passphrase} and markets', async () => {
    const r = await rig();
    watch(r.rt.userChannel({ conditionIds: [CONDITION_A, CONDITION_B] }));
    const conn = await r.server.accept();
    expect(conn.path).toBe('/ws/user');
    // Type "user", auth {apiKey, secret, passphrase}, markets = condition ids.
    expect(await firstFrame(conn)).toEqual({
      type: 'user',
      auth: {
        apiKey: CREDS.apiKey,
        secret: CREDS.secret,
        passphrase: CREDS.passphrase,
      },
      markets: [CONDITION_A, CONDITION_B],
    });
    expect(r.ensureOrderbook).toHaveBeenCalledTimes(1);
    // No market lookup: the user channel takes condition ids as they are.
    expect(r.market.calls).toEqual([]);
    await settle();
    expect(framesOf(conn)).toHaveLength(1);
    expect(r.server.connections).toHaveLength(1);
    expect(r.ensureOrderbook).toHaveBeenCalledTimes(1);
  });

  test('without conditionIds it covers every market (markets: []), and subscribe/unsubscribe are refused', async () => {
    const r = await rig();
    const sub = r.rt.userChannel();
    watch(sub);
    const conn = await r.server.accept();
    expect((await firstFrame(conn)).markets).toEqual([]);
    expect(
      await caught(() => r.rt.subscribe(sub, [CONDITION_A])),
    ).toBeInstanceOf(UserInputError);
    expect(
      await caught(() => r.rt.unsubscribe(sub, [CONDITION_A])),
    ).toBeInstanceOf(UserInputError);
    await settle();
    expect(framesOf(conn)).toHaveLength(1);
  });

  test('conditionIds: [] opens no connection: an empty market list would mean every market to the gateway', async () => {
    const r = await rig();
    const sub = r.rt.userChannel({ conditionIds: [] });
    watch(sub);
    await settle();
    expect(r.server.connections).toHaveLength(0);
    expect(r.ensureOrderbook).not.toHaveBeenCalled();
    await r.rt.subscribe(sub, [CONDITION_A]);
    const conn = await r.server.accept();
    expect((await firstFrame(conn)).markets).toEqual([CONDITION_A]);
  });

  test('userChannel throws UserInputError code browser_secret_refused when globalThis.window exists, unless allowBrowserSecrets: true', async () => {
    const r = await rig();
    vi.stubGlobal('window', {});
    const error = await caught(() =>
      r.rt.userChannel({ conditionIds: [CONDITION_A] }),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).code).toBe('browser_secret_refused');
    expect(await caught(() => r.rt.userChannel())).toBeInstanceOf(
      UserInputError,
    );
    await settle();
    expect(r.server.connections).toHaveLength(0);
    expect(r.ensureOrderbook).not.toHaveBeenCalled();
    expect(() =>
      r.rt.userChannel({ allowBrowserSecrets: 'yes' as never }),
    ).toThrow(UserInputError);

    watch(
      r.rt.userChannel({
        conditionIds: [CONDITION_A],
        allowBrowserSecrets: true,
      }),
    );
    const conn = await r.server.accept();
    expect((await firstFrame(conn)).type).toBe('user');
    // The market channel carries no secret, so the guard does not apply to it.
    watch(r.rt.marketChannel({ conditionIds: [CONDITION_A] }));
    await r.server.accept();
  });

  test('userChannel without a session throws AuthRequiredError; options are closed', async () => {
    const r = await rig({ noSession: true });
    expect(() => r.rt.userChannel()).toThrow(AuthRequiredError);
    const s = await rig();
    expect(() => s.rt.userChannel({ markets: [] } as never)).toThrow(
      UserInputError,
    );
    expect(() => s.rt.userChannel({ conditionIds: ['nope'] })).toThrow(
      UserInputError,
    );
  });

  test('credentials are fetched again on every reconnect: rotated credentials go in the second frame', async () => {
    const issued = [CREDS, ROTATED];
    let calls = 0;
    const r = await rig({
      ensureOrderbook: async () => ({
        ...(issued[Math.min(calls++, 1)] as OrderbookCredential),
      }),
    });
    const log = watch(r.rt.userChannel({ conditionIds: [CONDITION_A] }));
    const first = await r.server.accept();
    expect((await firstFrame(first)).auth).toEqual({ ...CREDS });
    first.drop();
    const second = await r.server.accept();
    expect(await firstFrame(second)).toEqual({
      type: 'user',
      auth: { ...ROTATED },
      markets: [CONDITION_A],
    });
    expect(framesOf(first)).toHaveLength(1);
    expect(r.ensureOrderbook).toHaveBeenCalledTimes(2);
    await waitUntil(() => log.reconnected === 1, 'reconnected');

    // The rotated-out credentials are still never let into an event.
    sendFrame(second, { event_type: 'debug', old: CREDS.secret });
    await waitUntil(() => log.errors.length === 1, 'the dropped frame');
    expect(log.errors[0]?.code).toBe('ws_frame_invalid');
    expect(log.events).toEqual([]);
  });

  test('a change made while the credentials are pending goes into the subscribe frame, never ahead of it', async () => {
    const late = deferred<OrderbookCredential>();
    const r = await rig({ ensureOrderbook: () => late.promise });
    const sub = r.rt.userChannel({ conditionIds: [CONDITION_A] });
    watch(sub);
    const conn = await r.server.accept();
    await waitUntil(() => r.ensureOrderbook.mock.calls.length === 1, 'asked');
    // A dynamic frame before the auth frame would count twice against the gateway's 100.
    await r.rt.subscribe(sub, [CONDITION_B]);
    await r.rt.subscribe(sub, [cid(3)]);
    await r.rt.unsubscribe(sub, [cid(3)]);
    await settle();
    expect(framesOf(conn)).toEqual([]);
    late.resolve({ ...CREDS });
    expect((await firstFrame(conn)).markets).toEqual([
      CONDITION_A,
      CONDITION_B,
    ]);
    await settle();
    expect(framesOf(conn)).toHaveLength(1);
  });

  test('a socket that drops before its credentials arrive never sends them; the new socket sends its own', async () => {
    const late = deferred<OrderbookCredential>();
    let calls = 0;
    const r = await rig({
      ensureOrderbook: () => {
        calls += 1;
        return calls === 1 ? late.promise : Promise.resolve({ ...ROTATED });
      },
    });
    watch(r.rt.userChannel({ conditionIds: [CONDITION_A] }));
    const first = await r.server.accept();
    await waitUntil(() => calls === 1, 'the first credential request');
    first.drop();
    const second = await r.server.accept();
    expect((await firstFrame(second)).auth).toEqual({ ...ROTATED });

    // The first socket's credentials arrive late: they must not go out on any socket.
    late.resolve({ ...CREDS });
    await settle(50);
    expect(framesOf(second)).toHaveLength(1);
    expect(framesOf(first)).toEqual([]);
  });

  test('credentials that arrive after close() are never sent', async () => {
    const late = deferred<OrderbookCredential>();
    const r = await rig({ ensureOrderbook: () => late.promise });
    const sub = r.rt.userChannel({ conditionIds: [CONDITION_A] });
    watch(sub);
    const conn = await r.server.accept();
    await waitUntil(() => r.ensureOrderbook.mock.calls.length === 1, 'asked');
    await sub.close();
    late.resolve({ ...CREDS });
    await settle(50);
    expect(framesOf(conn)).toEqual([]);
  });

  test("'reconnected' is emitted once the gateway confirms the user resubscription, not when the frame is written", async () => {
    const late = deferred<OrderbookCredential>();
    let calls = 0;
    const r = await rig({
      answer: false,
      ensureOrderbook: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve({ ...CREDS }) : late.promise;
      },
    });
    const log = watch(r.rt.userChannel({ conditionIds: [CONDITION_A] }));
    const first = await r.server.accept();
    await firstFrame(first);
    first.drop();
    const second = await r.server.accept();
    await waitUntil(() => calls === 2, 'the second credential request');
    await settle();
    expect(log.reconnected).toBe(0);
    late.resolve({ ...CREDS });
    await firstFrame(second);
    await settle();
    // Written, but not confirmed yet: a resync started now could still miss events.
    expect(log.reconnected).toBe(0);
    sendFrame(second, { type: 'subscribed', markets: [CONDITION_A] });
    await waitUntil(() => log.reconnected === 1, 'reconnected');
    // A later answer (to a dynamic subscribe) announces nothing more.
    sendFrame(second, { type: 'subscribed', markets: [CONDITION_A] });
    await settle();
    expect(log.reconnected).toBe(1);
  });

  test("'reconnected' on the market channel also waits for the gateway's answer", async () => {
    const r = await rig({ answer: false });
    const log = watch(
      r.rt.marketChannel({ conditionIds: [CONDITION_A], initialDump: false }),
    );
    const first = await r.server.accept();
    await firstFrame(first);
    first.drop();
    const second = await r.server.accept();
    await firstFrame(second);
    await settle();
    expect(log.reconnected).toBe(0);
    sendFrame(second, { type: 'subscribed', markets: [CONDITION_A] });
    await waitUntil(() => log.reconnected === 1, 'reconnected');
  });

  test("without an answer, 'reconnected' is emitted 5 s after the resubscription went out", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const r = await rig({ answer: false, connection: { random: () => 0 } });
    const log = watch(
      r.rt.marketChannel({ conditionIds: [CONDITION_A], initialDump: false }),
    );
    const first = await r.server.accept();
    await firstFrame(first);
    first.drop();
    // The reconnect delay (0 with this random source) is a faked timer too.
    await waitUntil(() => {
      vi.advanceTimersByTime(1);
      return r.server.connections.length === 2;
    }, 'the reconnect');
    const second = r.server.connections[1] as ServerConnection;
    await firstFrame(second);
    vi.advanceTimersByTime(4_990);
    await settle();
    expect(log.reconnected).toBe(0);
    vi.advanceTimersByTime(20);
    expect(log.reconnected).toBe(1);
    // The fallback fires once.
    vi.advanceTimersByTime(10_000);
    sendFrame(second, { type: 'subscribed', markets: [CONDITION_A] });
    await settle();
    expect(log.reconnected).toBe(1);
  });

  test.each([
    ['TransportError', () => new TransportError('derive failed')],
    ['TimeoutError', () => new TimeoutError('derive timed out')],
    ['RateLimitError', () => new RateLimitError('slow down', { status: 429 })],
    [
      'RequestRejectedError 503',
      () =>
        new RequestRejectedError('down', {
          code: 'service_unavailable',
          status: 503,
        }),
    ],
    ['a 5xx XoError', () => new XoError('bad gateway', { status: 502 })],
  ])(
    'a transient credential failure (%s) is one ws_auth_failed error without secrets, then the connection is retried',
    async (_name, make) => {
      let calls = 0;
      const thrown = make();
      const r = await rig({
        ensureOrderbook: async () => {
          calls += 1;
          if (calls === 1) {
            throw thrown;
          }
          return { ...CREDS };
        },
      });
      const log = watch(r.rt.userChannel({ conditionIds: [CONDITION_A] }));
      const first = await r.server.accept();
      await waitUntil(() => log.errors.length === 1, 'the error');
      const error = log.errors[0] as XoError;
      expect(error.code).toBe('ws_auth_failed');
      expect(error.service).toBe('orderbook');
      // Only the name and the code of the cause are kept, never the error itself.
      expect(error.cause).toEqual({ name: thrown.name, code: thrown.code });
      // The connection is dropped and retried with the backoff, which asks for credentials again.
      expect((await first.closed).code).toBe(4000);
      const second = await r.server.accept();
      expect((await firstFrame(second)).auth).toEqual({ ...CREDS });
      expect(framesOf(first)).toEqual([]);
      await waitUntil(() => log.reconnected === 1, 'reconnected');
      await settle();
      expect(log.errors).toHaveLength(1);
      expect(r.ensureOrderbook).toHaveBeenCalledTimes(2);
      expect(r.server.connections).toHaveLength(2);
    },
  );

  test.each([
    ['AuthRequiredError', () => new AuthRequiredError('no credentials')],
    [
      'smart_wallet_not_deployed',
      () =>
        new XoError('the smart wallet is not deployed', {
          code: 'smart_wallet_not_deployed',
          service: 'chain',
        }),
    ],
    ['a wallet rejection (SigningError)', () => new SigningError('rejected')],
    [
      'signer_mismatch',
      () => new UserInputError('wrong signer', { code: 'signer_mismatch' }),
    ],
    ['session_closed', () => new XoError('closed', { code: 'session_closed' })],
    [
      'a 401 rejection',
      () =>
        new RequestRejectedError('refused', {
          code: 'unauthorized',
          status: 401,
        }),
    ],
  ])(
    'a permanent credential failure (%s) is reported once: the socket is closed and ensureOrderbook runs only once',
    async (_name, make) => {
      const thrown = make();
      const r = await rig({
        ensureOrderbook: async () => {
          throw thrown;
        },
      });
      const sub = r.rt.userChannel({ conditionIds: [CONDITION_A] });
      const log = watch(sub);
      const conn = await r.server.accept();
      await waitUntil(() => log.errors.length === 1, 'the error');
      const error = log.errors[0] as XoError;
      expect(error.code).toBe('ws_auth_unrecoverable');
      expect(error.service).toBe('orderbook');
      expect(error.cause).toEqual({ name: thrown.name, code: thrown.code });
      expect(error.message).toContain('not retried');
      expect(error.message).toContain('1 market(s) are no longer subscribed');
      // The SDK closes the socket itself (code 1000), and nothing reconnects it.
      expect(await conn.closed).toEqual({
        code: 1000,
        reason: 'client_closed',
      });
      await settle(50);
      expect(r.server.connections).toHaveLength(1);
      expect(r.ensureOrderbook).toHaveBeenCalledTimes(1);
      expect(framesOf(conn)).toEqual([]);
      expect(log.errors).toHaveLength(1);
      expect(log.reconnected).toBe(0);
      // The market is free again: subscribing it opens a new connection (and tries once more).
      await r.rt.subscribe(sub, [CONDITION_A]);
      await r.server.accept();
      await waitUntil(() => log.errors.length === 2, 'tried once more');
      expect(r.ensureOrderbook).toHaveBeenCalledTimes(2);
    },
  );

  test('a refused user subscription: the session refreshes the credentials (onUnauthorized true), ws_subscribe_refused, scrubbed, and the connection restarts', async () => {
    const r = await rig({ answer: false });
    const log = watch(r.rt.userChannel({ conditionIds: [CONDITION_A] }));
    const first = await r.server.accept();
    await firstFrame(first);
    // The gateway answers a bad subscribe with an error frame and keeps the socket open: an
    // unauthenticated, silent stream.
    sendFrame(first, {
      type: 'error',
      message: `user channel auth failed: invalid credentials (${CREDS.secret} / ${CREDS.passphrase})`,
    });
    await waitUntil(() => log.errors.length === 1, 'the refusal');
    // The rejected key is named, so the session can tell a stale key from its current one.
    expect(r.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(r.onUnauthorized).toHaveBeenCalledWith('orderbook', {
      headers: { XO_API_KEY: CREDS.apiKey },
    });
    const error = log.errors[0] as XoError;
    expect(error.code).toBe('ws_subscribe_refused');
    expect(error.service).toBe('orderbook');
    expect(error.message).toContain('user channel auth failed');
    expect(error.message).toContain('refreshed');
    expect(error.message).not.toContain(CREDS.secret);
    expect(error.message).not.toContain(CREDS.passphrase);
    const second = await r.server.accept();
    expect((await firstFrame(second)).type).toBe('user');
    expect(r.ensureOrderbook).toHaveBeenCalledTimes(2);
    // A refused resubscription is never announced as 'reconnected'; the confirmed one is.
    expect(log.reconnected).toBe(0);
    sendFrame(second, { type: 'subscribed', markets: [CONDITION_A] });
    await waitUntil(() => log.reconnected === 1, 'reconnected');
  });

  test('a refusal the session cannot refresh (provided credentials) is reported once and stops: one connection, one ensureOrderbook', async () => {
    const r = await rig({ answer: false });
    // A real Session with the caller's credentials and no signer: onUnauthorized is false.
    const transport = new Transport({ env: testEnv, version: 't' });
    const session = new Session({
      env: testEnv,
      transport,
      clock: new Clock({
        fetchServerTimeSec: async () => Math.floor(Date.now() / 1000),
      }),
      credentials: { orderbook: { ...CREDS } },
      readContract: async () => '0x',
      warn: vi.fn(),
    });
    const ensure = vi.spyOn(session, 'ensureOrderbook');
    const refresh = vi.spyOn(session, 'onUnauthorized');
    const rt = new OrderbookRealtime({
      env: r.env,
      orderbook: new OrderbookClient({ transport, env: testEnv }),
      session,
      WebSocketImpl: WsImpl,
      connection: { backoff: { baseMs: 1, capMs: 5 } },
    });
    const log = watch(rt.userChannel({ conditionIds: [CONDITION_A] }));
    const conn = await r.server.accept();
    expect((await firstFrame(conn)).auth).toEqual({ ...CREDS });
    sendFrame(conn, {
      type: 'error',
      message: 'user channel auth failed: invalid credentials',
    });
    await waitUntil(() => log.errors.length === 1, 'the report');
    expect(await refresh.mock.results[0]?.value).toBe(false);
    expect(log.errors[0]?.code).toBe('ws_auth_unrecoverable');
    expect(log.errors[0]?.message).toContain('cannot refresh them');
    expect(await conn.closed).toEqual({ code: 1000, reason: 'client_closed' });
    await settle(50);
    expect(r.server.connections).toHaveLength(1);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(log.errors).toHaveLength(1);
  });

  test('a refresh that fails transiently restarts the connection; one that rejects for good stops it', async () => {
    let attempt = 0;
    const r = await rig({
      answer: false,
      onUnauthorized: async () => {
        attempt += 1;
        throw attempt === 1
          ? new TransportError('derive failed')
          : new SigningError('rejected');
      },
    });
    const log = watch(r.rt.userChannel({ conditionIds: [CONDITION_A] }));
    const refuse = (conn: ServerConnection) =>
      sendFrame(conn, {
        type: 'error',
        message: 'user channel auth failed: invalid credentials',
      });
    const first = await r.server.accept();
    await firstFrame(first);
    refuse(first);
    await waitUntil(() => log.errors.length === 1, 'the first refusal');
    expect(log.errors[0]?.code).toBe('ws_subscribe_refused');
    const second = await r.server.accept();
    await firstFrame(second);
    refuse(second);
    await waitUntil(() => log.errors.length === 2, 'the second refusal');
    expect(log.errors[1]?.code).toBe('ws_auth_unrecoverable');
    expect(log.errors[1]?.cause).toEqual({
      name: 'SigningError',
      code: 'signing_failed',
    });
    await settle(50);
    expect(r.server.connections).toHaveLength(2);
  });

  test('a refusal of the auth frame that is not about the credentials restarts without asking the session', async () => {
    const r = await rig({ answer: false });
    const log = watch(r.rt.userChannel({ conditionIds: [CONDITION_A] }));
    const first = await r.server.accept();
    await firstFrame(first);
    sendFrame(first, {
      type: 'error',
      message: 'user channel subscribe failed: engine unavailable: timeout',
    });
    await waitUntil(() => log.errors.length === 1, 'the refusal');
    expect(log.errors[0]?.code).toBe('ws_subscribe_refused');
    const second = await r.server.accept();
    await firstFrame(second);
    expect(r.onUnauthorized).not.toHaveBeenCalled();
  });

  test('orders_rebalanced frames are parsed on the user channel', async () => {
    const r = await rig();
    const log = watch(r.rt.userChannel({ conditionIds: [CONDITION_A] }));
    const conn = await r.server.accept();
    await firstFrame(conn);
    sendFrame(conn, { type: 'subscribed', markets: [CONDITION_A] });
    sendFrame(conn, ORDERS_REBALANCED);
    await waitUntil(() => log.events.length === 1, 'the event');
    expect(log.events[0]).toEqual({
      type: 'orders_rebalanced',
      cancelled_count: 2,
      cancelled_order_ids: [ORDER_HASH, MAKER_HASH],
    });
    expect(log.errors).toEqual([]);
  });

  test('leak check: no event or error carries the secret, the passphrase or the api key', async () => {
    let calls = 0;
    const r = await rig({
      ensureOrderbook: async () => {
        calls += 1;
        if (calls === 2) {
          throw new TransportError('derive failed', { service: 'orderbook' });
        }
        return { ...CREDS };
      },
      // The refusal below must answer the auth frame, as the gateway's would.
      answer: false,
    });
    const log = watch(r.rt.userChannel({ conditionIds: [CONDITION_A] }));
    const first = await r.server.accept();
    await firstFrame(first);
    const subscribeText = conn0Text(first);
    // A gateway that echoes the subscribe frame back (a bug, or a hostile proxy).
    first.send(conn0Text(first));
    // An unknown frame that happens to contain the passphrase, and one that names a secret.
    sendFrame(first, { event_type: 'debug', note: CREDS.passphrase });
    sendFrame(first, { event_type: 'debug2', auth: { secret: 'other-value' } });
    sendFrame(first, ORDER_PLACEMENT);
    sendFrame(first, TRADE_MATCHED);
    // A refusal that echoes the credentials.
    sendFrame(first, {
      type: 'error',
      message: `invalid credentials ${CREDS.apiKey} ${CREDS.secret} ${CREDS.passphrase}`,
    });
    // The restart asks for credentials again and fails once (ws_auth_failed), then works.
    const third = await r.server.accept().then(() => r.server.accept());
    await firstFrame(third);
    sendFrame(third, ORDER_CANCELLATION);
    third.send(`not even json ${CREDS.secret}`);
    // A JSON escape hides the secret from the raw text, not from the decoded frame.
    const escaped = `\\u${CREDS.secret.charCodeAt(0).toString(16).padStart(4, '0')}${CREDS.secret.slice(1)}`;
    expect(`{"x":"${escaped}"}`).not.toContain(CREDS.secret);
    third.send(`{"event_type":"debug3","note":"${escaped}"}`);
    sendFrame(third, { event_type: 'debug4' });
    await waitUntil(
      () =>
        log.events.some((e) => e.type === 'unknown' && e.rawType === 'debug4'),
      'the frame after the escaped one',
    );
    expect(
      log.events.some((e) => e.type === 'unknown' && e.rawType === 'debug3'),
    ).toBe(false);
    await waitUntil(
      () => log.events.filter((e) => e.type === 'order').length === 2,
      'events',
    );
    await settle();

    expect(subscribeText).toContain(CREDS.secret); // the frame itself does carry it
    expect(log.errors.map((e) => e.code)).toEqual(
      expect.arrayContaining([
        'ws_frame_invalid',
        'ws_subscribe_refused',
        'ws_auth_failed',
      ]),
    );
    const dump = [
      inspect(log.events, { depth: Number.POSITIVE_INFINITY }),
      inspect(log.errors, { depth: Number.POSITIVE_INFINITY }),
      JSON.stringify(log.events),
      JSON.stringify(log.errors.map((e) => e.toJSON())),
      log.errors.map((e) => `${e.message} ${String(e.stack)}`).join('\n'),
    ].join('\n');
    for (const value of [CREDS.secret, CREDS.passphrase, CREDS.apiKey]) {
      expect(dump).not.toContain(value);
    }
    // The unknown frame that named a secret is kept, with the value redacted.
    expect(log.events).toContainEqual({
      type: 'unknown',
      rawType: 'debug2',
      data: { event_type: 'debug2', auth: { secret: '[redacted]' } },
    });
  });
});

/** The subscribe frame a connection received (its first non-PING frame), as text. */
function conn0Text(conn: ServerConnection): string {
  return conn.received.find((text) => text !== 'PING') ?? '';
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

describe('frames', () => {
  async function marketConn(o: RigOptions = {}) {
    const r = await rig(o);
    const log = watch(
      r.rt.marketChannel({ conditionIds: [CONDITION_A], initialDump: false }),
    );
    const conn = await r.server.accept();
    await firstFrame(conn);
    return { r, log, conn };
  }

  async function userConn(o: RigOptions = {}) {
    const r = await rig(o);
    const log = watch(r.rt.userChannel({ conditionIds: [CONDITION_A] }));
    const conn = await r.server.accept();
    await firstFrame(conn);
    return { r, log, conn };
  }

  test('every market event_type parses to its event: event_type becomes type, the gateway field names stay', async () => {
    const { log, conn } = await marketConn();
    for (const frame of [
      tradingState('snapshot'),
      BOOK_FRAME,
      INITIAL_BOOK_FRAME,
      PRICE_CHANGE_FRAME,
      BEST_BID_ASK_FRAME,
      LAST_TRADE_FRAME,
      NEW_MARKET_FRAME,
      MARKET_RESOLVED_FRAME,
    ]) {
      sendFrame(conn, frame);
    }
    await waitUntil(() => log.events.length === 8, 'eight events');
    expect(log.errors).toEqual([]);
    const ms = Number(MS);
    expect(log.events).toEqual([
      {
        type: 'trading_state_changed',
        state: 'active',
        source: 'snapshot',
        timestamp: ms,
        rawTimestamp: MS,
      },
      {
        type: 'book',
        asset_id: TOKEN_YES,
        market: CONDITION_A,
        bids: [{ price: '0.550', size: '100' }],
        asks: [{ price: '0.560', size: '80.123456' }],
        hash: 'ab12cd',
        last_update_id: 42,
        timestamp: ms,
        rawTimestamp: MS,
      },
      {
        type: 'book',
        asset_id: TOKEN_NO,
        market: CONDITION_A,
        bids: [],
        asks: [{ price: '0.450', size: '5' }],
        hash: 'ef34',
        timestamp: ms,
        rawTimestamp: MS,
      },
      {
        type: 'price_change',
        market: CONDITION_A,
        price_changes: PRICE_CHANGE_FRAME.price_changes,
        timestamp: ms,
        rawTimestamp: MS,
      },
      {
        type: 'best_bid_ask',
        market: CONDITION_A,
        asset_id: TOKEN_YES,
        best_bid: '0.55',
        best_ask: '0.56',
        spread: '0.01',
        timestamp: ms,
        rawTimestamp: MS,
      },
      {
        type: 'last_trade_price',
        asset_id: TOKEN_YES,
        market: CONDITION_A,
        price: '0.555',
        side: 'BUY',
        size: '10',
        fee_rate_bps: '0',
        timestamp: 1_800_000_000_000,
        rawTimestamp: SEC,
      },
      {
        type: 'new_market',
        id: CONDITION_A,
        question: '',
        market: CONDITION_A,
        slug: '',
        description: '',
        assets_ids: [],
        outcomes: ['Yes', 'No'],
        status: 'ACTIVE',
        timestamp: ms,
        rawTimestamp: MS,
      },
      {
        type: 'market_resolved',
        id: CONDITION_A,
        market: CONDITION_A,
        assets_ids: [],
        outcomes: ['Yes', 'No'],
        winning_asset_id: '0',
        winning_outcome: '',
        status: 'RESOLVED',
        timestamp: ms,
        rawTimestamp: MS,
      },
    ] satisfies MarketChannelEvent[]);
  });

  test('user frames: the order type becomes kind; trades are MATCHED or a status transition', async () => {
    const { log, conn } = await userConn();
    for (const frame of [
      ORDER_PLACEMENT,
      ORDER_UPDATE,
      ORDER_FILLED,
      ORDER_CANCELLATION,
      ORDER_REJECTED,
      TRADE_MATCHED,
      TRADE_CONFIRMED,
      tradingState('on_chain', 'paused'),
    ]) {
      sendFrame(conn, frame);
    }
    await waitUntil(() => log.events.length === 8, 'eight events');
    expect(log.errors).toEqual([]);
    const ms = Number(MS);
    const { event_type: _p, type: _pt, ...placement } = ORDER_PLACEMENT;
    const { event_type: _u, type: _ut, ...update } = ORDER_UPDATE;
    const { event_type: _f, type: _ft, ...filled } = ORDER_FILLED;
    const { event_type: _c, type: _ct, ...cancel } = ORDER_CANCELLATION;
    const { event_type: _r, type: _rt, ...rejected } = ORDER_REJECTED;
    const { event_type: _t, ...matched } = TRADE_MATCHED;
    const { event_type: _s, ...confirmed } = TRADE_CONFIRMED;
    expect(log.events).toEqual([
      {
        type: 'order',
        kind: 'PLACEMENT',
        ...placement,
        timestamp: ms,
        rawTimestamp: MS,
      },
      {
        type: 'order',
        kind: 'UPDATE',
        ...update,
        timestamp: ms,
        rawTimestamp: MS,
      },
      {
        type: 'order',
        kind: 'UPDATE',
        ...filled,
        timestamp: ms,
        rawTimestamp: MS,
      },
      {
        type: 'order',
        kind: 'CANCELLATION',
        ...cancel,
        timestamp: ms,
        rawTimestamp: MS,
      },
      {
        type: 'order',
        kind: 'REJECTED',
        ...rejected,
        timestamp: ms,
        rawTimestamp: MS,
      },
      {
        type: 'trade',
        ...matched,
        timestamp: 1_800_000_000_000,
        rawTimestamp: '1800000000000',
      },
      { type: 'trade', ...confirmed, timestamp: ms, rawTimestamp: MS },
      {
        type: 'trading_state_changed',
        state: 'paused',
        source: 'on_chain',
        timestamp: ms,
        rawTimestamp: MS,
      },
    ] satisfies UserChannelEvent[]);
  });

  test('last_trade_price timestamp (seconds) normalized to ms, raw kept as rawTimestamp', async () => {
    const { log, conn } = await marketConn();
    sendFrame(conn, { ...LAST_TRADE_FRAME, timestamp: '1700000001' });
    // Every timestamp is read by its magnitude: should the gateway switch this one to
    // milliseconds, it still comes out right.
    sendFrame(conn, { ...LAST_TRADE_FRAME, timestamp: '1700000001234' });
    // Every other event too, an order included.
    sendFrame(conn, { ...PRICE_CHANGE_FRAME, timestamp: SEC });
    await waitUntil(() => log.events.length === 3, 'the events');
    expect(log.events[0]).toMatchObject({
      type: 'last_trade_price',
      timestamp: 1_700_000_001_000,
      rawTimestamp: '1700000001',
    });
    expect(log.events[1]).toMatchObject({
      type: 'last_trade_price',
      timestamp: 1_700_000_001_234,
      rawTimestamp: '1700000001234',
    });
    expect(log.events[2]).toMatchObject({
      type: 'price_change',
      timestamp: 1_800_000_000_000,
      rawTimestamp: SEC,
    });
    expect(log.errors).toEqual([]);
  });

  test('book and best_bid_ask are stamped in ms, or in seconds when a fill caused them: the unit follows the magnitude', async () => {
    const { log, conn } = await marketConn();
    // The book and best_bid_ask frames of a fill carry the fill's time (seconds); those of an
    // accepted or cancelled order carry the current time in milliseconds.
    sendFrame(conn, { ...BOOK_FRAME, timestamp: SEC });
    sendFrame(conn, { ...BOOK_FRAME, timestamp: MS });
    sendFrame(conn, { ...BEST_BID_ASK_FRAME, timestamp: SEC });
    sendFrame(conn, { ...BEST_BID_ASK_FRAME, timestamp: MS });
    await waitUntil(() => log.events.length === 4, 'four events');
    expect(
      log.events.map((e) => [
        (e as { timestamp: number }).timestamp,
        (e as { rawTimestamp: string }).rawTimestamp,
      ]),
    ).toEqual([
      [1_800_000_000_000, SEC],
      [1_800_000_000_123, MS],
      [1_800_000_000_000, SEC],
      [1_800_000_000_123, MS],
    ]);
  });

  test('an unknown event_type is emitted as {type:"unknown", rawType, data} in lenient mode', async () => {
    const { log, conn } = await marketConn();
    const tick = {
      event_type: 'tick_size_change',
      asset_id: TOKEN_YES,
      new_tick_size: '0.01',
    };
    sendFrame(conn, tick);
    // A user-channel event on the market channel is not one of its events either.
    sendFrame(conn, ORDER_PLACEMENT);
    // Nor is a message of the gateway's own on the combined /ws.
    sendFrame(conn, {
      type: 'order_accepted',
      order_id: ORDER_HASH,
      market_id: CONDITION_A,
    });
    await waitUntil(() => log.events.length === 3, 'three events');
    expect(log.events).toEqual([
      { type: 'unknown', rawType: 'tick_size_change', data: tick },
      { type: 'unknown', rawType: 'order', data: ORDER_PLACEMENT },
      {
        type: 'unknown',
        rawType: 'order_accepted',
        data: {
          type: 'order_accepted',
          order_id: ORDER_HASH,
          market_id: CONDITION_A,
        },
      },
    ]);
    expect(log.errors).toEqual([]);
  });

  test('an order kind or trade status the SDK does not know is an unknown event too', async () => {
    const { log, conn } = await userConn();
    const expired = { ...ORDER_PLACEMENT, type: 'EXPIRED' };
    const settled = { ...TRADE_CONFIRMED, status: 'SETTLED' };
    sendFrame(conn, expired);
    sendFrame(conn, settled);
    await waitUntil(() => log.events.length === 2, 'two events');
    expect(log.events).toEqual([
      { type: 'unknown', rawType: 'order', data: expired },
      { type: 'unknown', rawType: 'trade', data: settled },
    ]);
  });

  test('with strictResponses an unknown event_type is an error, not an event', async () => {
    const { log, conn } = await marketConn({ strict: true });
    sendFrame(conn, { event_type: 'tick_size_change', asset_id: TOKEN_YES });
    sendFrame(conn, BOOK_FRAME);
    await waitUntil(() => log.events.length === 1, 'the book');
    expect(log.events[0]?.type).toBe('book');
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]).toBeInstanceOf(UnexpectedResponseError);
    expect(log.errors[0]?.code).toBe('ws_unknown_event');
    expect(log.errors[0]?.message).toContain('tick_size_change');
  });

  test('strictResponses refuses unknown fields; lenient mode keeps them', async () => {
    const lenient = await marketConn();
    sendFrame(lenient.conn, { ...BOOK_FRAME, tick_size: '0.001' });
    await waitUntil(() => lenient.log.events.length === 1, 'lenient book');
    expect(lenient.log.events[0]).toMatchObject({
      type: 'book',
      tick_size: '0.001',
    });

    const strict = await marketConn({ strict: true });
    sendFrame(strict.conn, { ...BOOK_FRAME, tick_size: '0.001' });
    sendFrame(strict.conn, { ...LAST_TRADE_FRAME, side: 'HOLD' });
    await waitUntil(() => strict.log.errors.length === 1, 'strict error');
    expect(strict.log.errors[0]?.code).toBe('ws_frame_invalid');
    await settle();
    expect(strict.log.events).toEqual([]);
    // In lenient mode an unknown enum value passes.
    sendFrame(lenient.conn, { ...LAST_TRADE_FRAME, side: 'HOLD' });
    await waitUntil(() => lenient.log.events.length === 2, 'lenient trade');
    expect(lenient.log.events[1]).toMatchObject({ side: 'HOLD' });
  });

  test('a frame that fails to parse is one ws_frame_invalid error, it is dropped, the subscription survives, and errors are throttled to one per second', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { log, conn } = await marketConn();
    sendFrame(conn, { event_type: 'book', market: CONDITION_A });
    await waitUntil(() => log.errors.length === 1, 'the first error');
    const error = log.errors[0] as UnexpectedResponseError;
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(error.code).toBe('ws_frame_invalid');
    expect(error.service).toBe('orderbook');
    expect(error.message).toContain('book');

    sendFrame(conn, { ...LAST_TRADE_FRAME, timestamp: 'yesterday' });
    sendFrame(conn, { ...BOOK_FRAME, timestamp: '99999999999999999999' });
    sendFrame(conn, BOOK_FRAME);
    await waitUntil(() => log.events.length === 1, 'the valid book');
    expect(log.events[0]?.type).toBe('book');
    expect(log.errors).toHaveLength(1);

    vi.advanceTimersByTime(999);
    sendFrame(conn, { event_type: 'price_change' });
    sendFrame(conn, BOOK_FRAME);
    await waitUntil(() => log.events.length === 2, 'another book');
    expect(log.errors).toHaveLength(1);

    vi.advanceTimersByTime(1);
    sendFrame(conn, { event_type: 'price_change' });
    await waitUntil(() => log.errors.length === 2, 'the next error');
  });

  test('non-JSON text is ignored; JSON that is not an event object is invalid', async () => {
    const { log, conn } = await marketConn();
    conn.send('hello');
    sendFrame(conn, BOOK_FRAME);
    await waitUntil(() => log.events.length === 1, 'the book');
    expect(log.errors).toEqual([]);
    conn.send('[1, 2]');
    await waitUntil(() => log.errors.length === 1, 'the error');
    expect(log.errors[0]?.code).toBe('ws_frame_invalid');
  });

  test('subscribed answers are swallowed; an error frame is ws_subscribe_refused when it answers a subscribe, else ws_server_error, and the connection restarts either way', async () => {
    const { r, log, conn } = await marketConn({ answer: false });
    sendFrame(conn, { type: 'error', message: 'subscription limit exceeded' });
    await waitUntil(() => log.errors.length === 1, 'refused');
    expect(log.errors[0]?.code).toBe('ws_subscribe_refused');
    expect(log.errors[0]?.message).toContain('subscription limit exceeded');
    const second = await r.server.accept();
    await firstFrame(second);
    sendFrame(second, { type: 'subscribed', markets: [CONDITION_A] });
    sendFrame(second, { type: 'error', message: 'rate limit exceeded' });
    await waitUntil(() => log.errors.length === 2, 'server error');
    expect(log.errors[1]?.code).toBe('ws_server_error');
    // The gateway dropped a frame of ours: the whole subscription is sent again.
    const third = await r.server.accept();
    expect((await firstFrame(third)).assets_ids).toEqual([CONDITION_A]);
    expect(log.events).toEqual([]);
  });

  test('a second trading_state_changed snapshot on a socket means the gateway dropped events: ws_events_dropped', async () => {
    const { r, log, conn } = await marketConn();
    // Every connection starts with a snapshot. After a broadcast lag the gateway sends
    // another one: events were dropped.
    sendFrame(conn, tradingState('snapshot'));
    sendFrame(conn, { type: 'subscribed', markets: [CONDITION_A] });
    sendFrame(conn, tradingState('on_chain'));
    await waitUntil(() => log.events.length === 2, 'two events');
    expect(log.errors).toEqual([]);
    sendFrame(conn, tradingState('snapshot'));
    await waitUntil(() => log.errors.length === 1, 'the gap');
    expect(log.errors[0]?.code).toBe('ws_events_dropped');
    await waitUntil(() => log.events.length === 3, 'the snapshot event too');

    // A new connection starts over: its first snapshot is the connect snapshot.
    conn.drop();
    const second = await r.server.accept();
    await firstFrame(second);
    sendFrame(second, tradingState('snapshot'));
    await waitUntil(() => log.events.length === 4, 'the new snapshot');
    await settle();
    expect(log.errors).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Connection splitting and routing
// ---------------------------------------------------------------------------

describe('connection splitting', () => {
  test('>100 ids splits across two connections', async () => {
    const r = await rig();
    const ids = range(101);
    watch(r.rt.marketChannel({ conditionIds: ids, initialDump: false }));
    const a = await r.server.accept();
    const b = await r.server.accept();
    // At most 100 subscriptions per connection.
    expect((await firstFrame(a)).assets_ids).toEqual(ids.slice(0, 100));
    expect((await firstFrame(b)).assets_ids).toEqual(ids.slice(100));
    await settle();
    expect(r.server.connections).toHaveLength(2);
  });

  test('with initial dumps every token counts against the 100: 51 binary markets split 50 + 1', async () => {
    const markets = manyMarkets(51);
    const r = await rig({ markets });
    watch(r.rt.marketChannel({ conditionIds: range(51) }));
    const a = await r.server.accept();
    const b = await r.server.accept();
    const tokens = markets.flatMap((m) => [m.yes, m.no]);
    // The gateway checks subscribed + ids-in-frame <= 100, per id sent.
    expect((await firstFrame(a)).assets_ids).toEqual(tokens.slice(0, 100));
    expect((await firstFrame(b)).assets_ids).toEqual(tokens.slice(100));
  });

  test('subscribe beyond 100 opens a second connection, and unsubscribe routes to the owning connection', async () => {
    const r = await rig();
    const sub = r.rt.marketChannel({
      conditionIds: range(100),
      initialDump: false,
    });
    watch(sub);
    const a = await r.server.accept();
    await firstFrame(a);

    await r.rt.subscribe(sub, [cid(100)]);
    const b = await r.server.accept();
    expect(await firstFrame(b)).toEqual({
      type: 'market',
      assets_ids: [cid(100)],
      initial_dump: false,
      custom_feature_enabled: false,
    });

    await r.rt.unsubscribe(sub, [cid(5)]);
    await frameCount(a, 2);
    expect(framesOf(a)[1]).toEqual({
      operation: 'unsubscribe',
      assets_ids: [cid(5)],
    });
    // The freed slot is used before a new connection is opened.
    await r.rt.subscribe(sub, [cid(101)]);
    await frameCount(a, 3);
    expect(framesOf(a)[2]).toEqual({
      operation: 'subscribe',
      assets_ids: [cid(101)],
      initial_dump: false,
    });
    // Ids that are already subscribed, or not subscribed, change nothing.
    await r.rt.subscribe(sub, [cid(0), cid(100)]);
    await r.rt.unsubscribe(sub, [cid(500)]);
    await settle();
    expect(framesOf(a)).toHaveLength(3);
    expect(framesOf(b)).toHaveLength(1);
    expect(r.server.connections).toHaveLength(2);
  });

  test('unsubscribe sends condition ids', async () => {
    const r = await rig();
    const sub = r.rt.marketChannel({
      conditionIds: [CONDITION_A, CONDITION_B],
    });
    watch(sub);
    const conn = await r.server.accept();
    expect((await firstFrame(conn)).assets_ids).toEqual([
      TOKEN_YES,
      TOKEN_NO,
      '111',
      '222',
    ]);
    // The gateway resolves token ids to the market on subscribe, but removes the raw id on
    // unsubscribe: only the condition id matches what it stored.
    await r.rt.unsubscribe(sub, [CONDITION_A]);
    await frameCount(conn, 2);
    expect(framesOf(conn)[1]).toEqual({
      operation: 'unsubscribe',
      assets_ids: [CONDITION_A],
    });

    const user = r.rt.userChannel({ conditionIds: [CONDITION_A, CONDITION_B] });
    watch(user);
    const userConn = await r.server.accept();
    await firstFrame(userConn);
    await r.rt.unsubscribe(user, [CONDITION_B]);
    await frameCount(userConn, 2);
    expect(framesOf(userConn)[1]).toEqual({
      operation: 'unsubscribe',
      markets: [CONDITION_B],
    });
    await r.rt.subscribe(user, [cid(7)]);
    await frameCount(userConn, 3);
    expect(framesOf(userConn)[2]).toEqual({
      operation: 'subscribe',
      markets: [cid(7)],
    });
  });

  test('subscribe on an open market connection sends the new tokens with initial_dump', async () => {
    const r = await rig();
    const sub = r.rt.marketChannel({ conditionIds: [CONDITION_A] });
    watch(sub);
    const conn = await r.server.accept();
    await firstFrame(conn);
    await r.rt.subscribe(sub, [CONDITION_B]);
    await frameCount(conn, 2);
    expect(framesOf(conn)[1]).toEqual({
      operation: 'subscribe',
      assets_ids: ['111', '222'],
      initial_dump: true,
    });
    await settle();
    expect(framesOf(conn)).toHaveLength(2);
    expect(r.server.connections).toHaveLength(1);
  });

  test('unsubscribing the last market of a connection closes it rather than leave an empty subscription', async () => {
    const r = await rig();
    const sub = r.rt.userChannel({ conditionIds: [CONDITION_A] });
    watch(sub);
    const conn = await r.server.accept();
    await firstFrame(conn);
    await r.rt.unsubscribe(sub, [CONDITION_A]);
    // An empty market set on /ws/user means EVERY market: never send it.
    expect(await conn.closed).toEqual({ code: 1000, reason: 'client_closed' });
    expect(framesOf(conn)).toHaveLength(1);
    await r.rt.subscribe(sub, [CONDITION_B]);
    const next = await r.server.accept();
    expect((await firstFrame(next)).markets).toEqual([CONDITION_B]);
  });

  test('a 1008 on one of two split user connections is reported; the other keeps delivering; the refused one resubscribes its own ids', async () => {
    // A user connection takes a WS slot once its auth frame is accepted: that
    // is where the gateway's 1008 comes from. The market channel takes no slot.
    const r = await rig({ connection: { random: () => 0 } });
    const ids = range(101);
    const log = watch(r.rt.userChannel({ conditionIds: ids }));
    const a = await r.server.accept();
    const b = await r.server.accept();
    expect((await firstFrame(a)).markets).toEqual(ids.slice(0, 100));
    expect((await firstFrame(b)).markets).toEqual(ids.slice(100));

    a.closeWith(1008, 'max_ws_connections_exceeded');
    await waitUntil(() => log.errors.length === 1, 'the 1008 error');
    expect(log.errors[0]?.code).toBe('max_ws_connections_exceeded');

    sendFrame(b, { ...ORDER_PLACEMENT, market: cid(100) });
    await waitUntil(() => log.events.length === 1, 'b still delivers');
    expect(log.events[0]).toMatchObject({ type: 'order', market: cid(100) });

    // At least 1 s after a 1008, then the refused connection's own subscription again,
    // with credentials fetched again.
    const again = await r.server.accept();
    expect(await firstFrame(again)).toEqual({
      type: 'user',
      auth: { ...CREDS },
      markets: ids.slice(0, 100),
    });
    await waitUntil(() => log.reconnected === 1, 'reconnected');
    expect(r.ensureOrderbook).toHaveBeenCalledTimes(3);
    await settle();
    expect(framesOf(b)).toHaveLength(1);
    expect(r.server.connections).toHaveLength(3);
    expect(log.errors).toHaveLength(1);
  });

  test('close() closes every connection', async () => {
    const r = await rig();
    const sub = r.rt.marketChannel({
      conditionIds: range(101),
      initialDump: false,
    });
    const log = watch(sub);
    const a = await r.server.accept();
    const b = await r.server.accept();
    await firstFrame(a);
    await firstFrame(b);
    await sub.close();
    expect(await a.closed).toEqual({ code: 1000, reason: 'client_closed' });
    expect(await b.closed).toEqual({ code: 1000, reason: 'client_closed' });
    expect(log.closed).toBe(1);
    // After close() subscribe does nothing.
    await r.rt.subscribe(sub, [cid(300)]);
    await settle();
    expect(r.server.connections).toHaveLength(2);
  });

  test('close() during a token lookup opens nothing', async () => {
    const r = await rig();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const getMarket = vi.spyOn(OrderbookClient.prototype, 'getMarket');
    getMarket.mockImplementation(async () => {
      await gate;
      throw new Error('never used');
    });
    const sub = r.rt.marketChannel({ conditionIds: [CONDITION_A] });
    watch(sub);
    await waitUntil(() => getMarket.mock.calls.length === 1, 'the lookup');
    await sub.close();
    release();
    await settle(50);
    expect(r.server.connections).toHaveLength(0);
  });

  test('subscribe and unsubscribe check their arguments', async () => {
    const r = await rig();
    const sub = r.rt.marketChannel({ conditionIds: [], initialDump: false });
    watch(sub);
    expect(await caught(() => r.rt.subscribe(sub, ['0x1']))).toBeInstanceOf(
      UserInputError,
    );
    expect(
      await caught(() => r.rt.unsubscribe(sub, CONDITION_A as never)),
    ).toBeInstanceOf(UserInputError);
    const other = await rig();
    expect(
      await caught(() => other.rt.subscribe(sub, [CONDITION_A])),
    ).toBeInstanceOf(UserInputError);
    expect(
      await caught(() => r.rt.subscribe({} as never, [CONDITION_A])),
    ).toBeInstanceOf(UserInputError);
  });
});

// ---------------------------------------------------------------------------
// Reconnect
// ---------------------------------------------------------------------------

describe('account-wide events come from the primary connection', () => {
  const count = (events: Array<{ type: string }>, type: string) =>
    events.filter((e) => e.type === type).length;

  test('user channel: two split connections that both receive trading_state_changed and orders_rebalanced produce one event each', async () => {
    const r = await rig();
    const log = watch(r.rt.userChannel({ conditionIds: range(101) }));
    const a = await r.server.accept();
    const b = await r.server.accept();
    await firstFrame(a);
    await firstFrame(b);
    // The gateway sends both to every connection of the account.
    for (const conn of [a, b]) {
      sendFrame(conn, tradingState('snapshot'));
      sendFrame(conn, ORDERS_REBALANCED);
    }
    // Market events come from the connection that holds the market, primary or not.
    sendFrame(b, { ...ORDER_PLACEMENT, market: cid(100) });
    // An unknown frame is account-wide unless it names a market.
    sendFrame(b, { event_type: 'debug', note: 'b' });
    sendFrame(b, { event_type: 'debug', market: cid(100) });
    sendFrame(a, { event_type: 'debug', note: 'a' });
    await waitUntil(() => log.events.length === 5, 'five events');
    await settle();
    expect(log.events).toHaveLength(5);
    expect(count(log.events, 'trading_state_changed')).toBe(1);
    expect(count(log.events, 'orders_rebalanced')).toBe(1);
    expect(log.events).toContainEqual(
      expect.objectContaining({ type: 'order', market: cid(100) }),
    );
    const unknown = log.events
      .filter((e) => e.type === 'unknown')
      .map((e) => (e as { data: Record<string, unknown> }).data);
    expect(unknown).toHaveLength(2);
    expect(unknown).toContainEqual({ event_type: 'debug', note: 'a' });
    expect(unknown).toContainEqual({ event_type: 'debug', market: cid(100) });
    expect(log.errors).toEqual([]);
  });

  test('market channel: trading_state_changed from two split connections is one event', async () => {
    const r = await rig();
    const log = watch(
      r.rt.marketChannel({ conditionIds: range(101), initialDump: false }),
    );
    const a = await r.server.accept();
    const b = await r.server.accept();
    await firstFrame(a);
    await firstFrame(b);
    sendFrame(a, tradingState('snapshot'));
    sendFrame(b, tradingState('snapshot'));
    sendFrame(b, { ...BOOK_FRAME, market: cid(100) });
    await waitUntil(() => log.events.length === 2, 'two events');
    await settle();
    expect(log.events.map((e) => e.type).sort()).toEqual([
      'book',
      'trading_state_changed',
    ]);
  });

  test('when the primary connection is closed because its markets were removed, the next one is promoted', async () => {
    const r = await rig();
    const sub = r.rt.userChannel({ conditionIds: range(101) });
    const log = watch(sub);
    const a = await r.server.accept();
    const b = await r.server.accept();
    await firstFrame(a);
    await firstFrame(b);
    sendFrame(b, tradingState('snapshot'));
    sendFrame(b, { ...ORDER_PLACEMENT, market: cid(100) });
    await waitUntil(() => log.events.length === 1, 'the order');
    expect(log.events[0]?.type).toBe('order');

    await r.rt.unsubscribe(sub, range(100));
    expect((await a.closed).code).toBe(1000);
    sendFrame(b, tradingState('on_chain', 'paused'));
    sendFrame(b, ORDERS_REBALANCED);
    await waitUntil(() => log.events.length === 3, 'promoted');
    expect(log.events.slice(1)).toEqual([
      expect.objectContaining({
        type: 'trading_state_changed',
        state: 'paused',
      }),
      expect.objectContaining({ type: 'orders_rebalanced' }),
    ]);
  });

  test('while the primary connection is down, account-wide events pause until it reconnects', async () => {
    // A 200 ms reconnect delay keeps the primary down long enough to look.
    const r = await rig({
      connection: { backoff: { baseMs: 200, capMs: 200 }, random: () => 1 },
    });
    const log = watch(
      r.rt.marketChannel({ conditionIds: range(101), initialDump: false }),
    );
    const a = await r.server.accept();
    const b = await r.server.accept();
    await firstFrame(a);
    await firstFrame(b);
    a.drop();
    await settle(50);
    // Paused: the secondary's account-wide frames are not surfaced while the primary is down.
    sendFrame(b, tradingState('snapshot', 'active'));
    sendFrame(b, tradingState('on_chain', 'active'));
    sendFrame(b, { ...BOOK_FRAME, market: cid(100) });
    await waitUntil(() => log.events.length === 1, 'the book');
    expect(log.events[0]?.type).toBe('book');
    expect(r.server.connections).toHaveLength(2); // the primary is still down

    const again = await r.server.accept();
    await firstFrame(again);
    await waitUntil(() => log.reconnected === 1, 'reconnected');
    // The pause ends: the reconnected primary's frames are surfaced again...
    sendFrame(again, tradingState('snapshot', 'paused'));
    sendFrame(again, tradingState('on_chain', 'active'));
    await waitUntil(() => log.events.length === 3, 'the primary again');
    expect(log.events.slice(1)).toEqual([
      expect.objectContaining({
        type: 'trading_state_changed',
        source: 'snapshot',
        state: 'paused',
      }),
      expect.objectContaining({
        type: 'trading_state_changed',
        source: 'on_chain',
        state: 'active',
      }),
    ]);
    // ...and the secondary's still are not.
    sendFrame(b, tradingState('on_chain', 'paused'));
    sendFrame(b, { ...BOOK_FRAME, market: cid(100) });
    await waitUntil(() => log.events.length === 4, 'the second book');
    await settle();
    expect(log.events[3]?.type).toBe('book');
    expect(log.events).toHaveLength(4);
    expect(log.errors).toEqual([]);
  });

  test('a lag snapshot on a secondary connection is still reported as ws_events_dropped', async () => {
    const r = await rig();
    const log = watch(
      r.rt.marketChannel({ conditionIds: range(101), initialDump: false }),
    );
    const a = await r.server.accept();
    const b = await r.server.accept();
    await firstFrame(a);
    await firstFrame(b);
    sendFrame(b, tradingState('snapshot'));
    sendFrame(b, { type: 'subscribed', markets: [cid(100)] });
    sendFrame(b, tradingState('snapshot'));
    await waitUntil(() => log.errors.length === 1, 'the gap');
    expect(log.errors[0]?.code).toBe('ws_events_dropped');
    await settle();
    expect(log.events).toEqual([]);
  });
});

describe('token lookups', () => {
  test('two channels on the same market share one lookup', async () => {
    const r = await rig();
    watch(r.rt.marketChannel({ conditionIds: [CONDITION_A] }));
    watch(r.rt.marketChannel({ conditionIds: [CONDITION_A] }));
    const a = await r.server.accept();
    const b = await r.server.accept();
    expect((await firstFrame(a)).assets_ids).toEqual([TOKEN_YES, TOKEN_NO]);
    expect((await firstFrame(b)).assets_ids).toEqual([TOKEN_YES, TOKEN_NO]);
    expect(r.market.calls).toEqual([`GET /markets/${CONDITION_A}`]);
  });
});

describe('reconnect', () => {
  test("on reconnect the same subscriptions are re-sent and 'reconnected' is emitted", async () => {
    const r = await rig();
    const sub = r.rt.marketChannel({ conditionIds: [CONDITION_A] });
    const log = watch(sub);
    const first = await r.server.accept();
    await firstFrame(first);
    await r.rt.subscribe(sub, [CONDITION_B, cid(9)]);
    await r.rt.unsubscribe(sub, [cid(9)]);
    await frameCount(first, 3);
    expect(log.reconnected).toBe(0);

    first.drop();
    const second = await r.server.accept();
    expect(await firstFrame(second)).toEqual({
      type: 'market',
      assets_ids: [TOKEN_YES, TOKEN_NO, '111', '222'],
      initial_dump: true,
      custom_feature_enabled: false,
    });
    await waitUntil(() => log.reconnected === 1, 'reconnected');
    await settle();
    expect(framesOf(second)).toHaveLength(1);
    expect(log.reconnected).toBe(1);
    // The tokens were looked up once per market: the reconnect used the cache.
    expect(r.market.calls).toEqual([
      `GET /markets/${CONDITION_A}`,
      `GET /markets/${CONDITION_B}`,
      `GET /markets/${cid(9)}`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Resync
// ---------------------------------------------------------------------------

describe('resync (msw)', () => {
  test('resyncMyOrders() pages through getOpenOrders with L2 (msw)', async () => {
    const env = testEnv;
    const transport = new Transport({ env, version: '0.0.0-test' });
    const orderbookFake = installOrderbook(mswServer);
    installMarketData(mswServer);
    const trading = installTrading(mswServer, orderbookFake, { pageLimit: 2 });
    const credential = seedKey(orderbookFake, OWNER);
    const session = new Session({
      env,
      transport,
      clock: new Clock({
        fetchServerTimeSec: async () => Math.floor(Date.now() / 1000),
      }),
      credentials: { orderbook: credential },
      readContract: async () => '0x',
      warn: vi.fn(),
    });
    transport.setAuth(session);
    const orderbook = new OrderbookClient({
      transport,
      env,
      session,
      strictResponses: true,
    });
    const hashes = [1, 2, 3].map((i) => `0x${String(i).repeat(64)}`);
    hashes.forEach((hash, i) => {
      trading.orders.push({
        hash,
        numericId: i + 1,
        owner: OWNER.toLowerCase(),
        market: CONDITION_A,
        tokenId: TOKEN_YES,
        outcome: 'YES',
        side: 'BUY',
        tick: 500 - i,
        size: 10_000_000n,
        orderType: 'GTC',
        expiration: '0',
        createdAt: 1_800_000_000,
      });
    });
    const rt = new OrderbookRealtime({
      env,
      orderbook,
      session,
      WebSocketImpl: WsImpl,
    });
    const orders = await rt.resyncMyOrders();
    expect(orders.map((o) => o.id)).toEqual(hashes);
    const sent = trading.requests.filter((q) => q.path === '/data/orders');
    expect(sent).toHaveLength(2);
    for (const request of sent) {
      expect(request.headers.get('XO_API_KEY')).toBe(credential.apiKey);
      expect(request.headers.get('XO_SIGNATURE')).toMatch(/^[A-Za-z0-9_=-]+$/);
    }
    // The getOpenOrders filters pass through.
    expect((await rt.resyncMyOrders({ conditionId: CONDITION_B })).length).toBe(
      0,
    );
  });

  test('resyncBooks(tokenIds) returns getBooks(tokenIds)', async () => {
    const r = await rig();
    const books = await r.rt.resyncBooks([TOKEN_YES, TOKEN_NO]);
    expect(books.map((b) => b.asset_id)).toEqual([TOKEN_YES, TOKEN_NO]);
    expect(r.market.calls).toEqual(['POST /books']);
  });
});

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

describe('options', () => {
  test('the constructor checks its options, including the connection tuning, at once', async () => {
    const r = await rig();
    const base: OrderbookRealtimeOptions = {
      env: r.env,
      orderbook: new OrderbookClient({
        transport: new Transport({ env: testEnv, version: 't' }),
        env: testEnv,
      }),
      WebSocketImpl: WsImpl,
    };
    expect(() => new OrderbookRealtime(undefined as never)).toThrow(
      UserInputError,
    );
    expect(
      () => new OrderbookRealtime({ ...base, env: undefined as never }),
    ).toThrow(UserInputError);
    expect(
      () => new OrderbookRealtime({ ...base, orderbook: {} as never }),
    ).toThrow(UserInputError);
    expect(
      () => new OrderbookRealtime({ ...base, strictResponses: 'no' as never }),
    ).toThrow(UserInputError);
    expect(
      () => new OrderbookRealtime({ ...base, session: {} as never }),
    ).toThrow(UserInputError);
    expect(
      () =>
        new OrderbookRealtime({ ...base, connection: { pingIntervalMs: 5 } }),
    ).toThrow(UserInputError);
    expect(
      () =>
        new OrderbookRealtime({
          ...base,
          connection: { url: 'ws://x' } as never,
        }),
    ).toThrow(UserInputError);
    expect(
      () => new OrderbookRealtime({ ...base, extra: true } as never),
    ).toThrow(UserInputError);

    vi.stubGlobal('WebSocket', undefined);
    const { WebSocketImpl: _impl, ...withoutImpl } = base;
    const error = await caught(() => new OrderbookRealtime(withoutImpl));
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).message).toContain('WebSocketImpl');
  });
});
