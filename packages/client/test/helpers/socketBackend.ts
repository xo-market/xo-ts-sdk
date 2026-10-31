import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleepReal } from 'node:timers/promises';
import { Server, type Socket as ServerSocket } from 'socket.io';
import { fixtures } from './mockAccountData';
import { activityFixture, pageMeta } from './mockBackendData';

// An in-process Socket.IO server that stands in for the backend's `/portfolio` and
// `/market-activity` namespaces. It is the `socket.io` package, a devDependency only: it
// never reaches `src` or the published bundle. It listens on 127.0.0.1 on a free port, so no
// test touches an external network.
//
// It mirrors the backend's gateways:
// - `/portfolio`: message handlers are bound at once, the handshake is checked asynchronously
//   afterwards, so a message that arrives first is answered with the `exception`
//   "Authentication required". A refusal is `portfolio_error {message}` (no code) then
//   `disconnect(true)`. A key is deleted from `handshake.auth` once it is accepted.
//   `portfolio_subscribe` checks the rate limit, the user, the `account:read` scope and the
//   filters, emits `portfolio_snapshot` and acknowledges `{ ok: true }`. A failure that has a
//   code is a `portfolio_error {message, code}` followed by an `exception` with the same
//   message, and no acknowledgement.
// - `/market-activity`: the optional handshake, then `market_activity_connection_ack`;
//   `market_activity_subscribe` emits `market_activity_snapshot` or `market_activity_error`
//   plus an `exception`.
//
// Tests drive it through the hooks (`portfolioAuth`, `authDelayMs`, `onPortfolioSubscribe`,
// ...) and read what each connection received.

/** The backend's UUID check of `eventId`. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PortfolioUser {
  userId: number;
  scopes: string[];
}

/** What a namespace connection saw, as it arrived (before the server forgot the key). */
export interface SeenHandshake {
  auth: Record<string, unknown>;
  query: Record<string, unknown>;
  headers: Record<string, unknown>;
  url: string;
}

export interface Received {
  event: string;
  payload: unknown;
  /** `performance.now()` when the server got it. */
  at: number;
}

export interface MockConnection {
  readonly namespace: '/portfolio' | '/market-activity';
  readonly socket: ServerSocket;
  readonly handshake: SeenHandshake;
  /** `performance.now()` of the server's `connection` event. */
  readonly connectedAt: number;
  /** Every event the client sent on this connection, in order. */
  readonly received: Received[];
  /** Resolves with the server-side disconnect reason. */
  readonly closed: Promise<string>;
  /** `/portfolio`: the user once the handshake is accepted. */
  user: PortfolioUser | undefined;
  /** `/market-activity`: the viewer (a Privy id) when one was resolved. */
  viewer: string | undefined;
  /** The subscribe payloads received, in order. */
  subscribes(): unknown[];
  /** Ends the engine connection at once: the client sees `transport close` and must reconnect. */
  drop(): void;
}

/** What a hook answers for a subscribe: `'default'` lets the mock handle it as the gateway does. */
export type SubscribeHook = (
  conn: MockConnection,
  payload: unknown,
  ack: ((value: unknown) => void) | undefined,
) => 'default' | 'handled' | Promise<'default' | 'handled'>;

export interface MockSocketBackend {
  /** `http://127.0.0.1:<port>`, the `backendSocketUrl` of the tests. */
  readonly url: string;
  readonly io: Server;
  /** Every namespace connection so far, in arrival order. */
  readonly connections: readonly MockConnection[];
  /** Resolves with the next connection of `namespace` nobody has taken yet, in arrival order. */
  accept(
    namespace?: '/portfolio' | '/market-activity',
  ): Promise<MockConnection>;
  /**
   * `/portfolio`: decides each handshake from the token it carries. A string is a refusal
   * message. Defaults to accepting any token with `account:read`, and refusing none with
   * "Authentication required".
   */
  portfolioAuth: (
    token: string | undefined,
    conn: MockConnection,
  ) => PortfolioUser | string | Promise<PortfolioUser | string>;
  /**
   * `/market-activity`: the viewer of a token, or undefined for anonymous. Defaults to
   * `privy:<token>` for any token.
   */
  marketActivityAuth: (token: string | undefined) => string | undefined;
  /** How long the asynchronous handshake check takes (ms). Default 20. */
  authDelayMs: number | ((conn: MockConnection) => number);
  /** Runs before the default handling of `portfolio_subscribe`. */
  onPortfolioSubscribe: SubscribeHook | undefined;
  /** Runs before the default handling of `market_activity_subscribe`. */
  onMarketActivitySubscribe: SubscribeHook | undefined;
  /** Replaces the `market_activity_connection_ack` payload (the default is the gateway's). */
  marketActivityAck:
    | ((conn: MockConnection, authenticated: boolean) => unknown)
    | undefined;
  /**
   * The `data` rows of a market activity snapshot, for the normalized filters (the default is
   * two order fills). The gateway's `userTradesOnly` branch for an authenticated viewer lists
   * every kind of history row of the account.
   */
  marketActivityRows:
    | ((filters: Record<string, unknown>, conn: MockConnection) => unknown[])
    | undefined;
  /** The `data` rows of a portfolio snapshot for the normalized filters. */
  portfolioRows: (filters: Record<string, unknown>) => unknown[];
  /** Emits a snapshot as the gateway does, for the connection's last filters. */
  pushPortfolioSnapshot(conn: MockConnection): void;
  close(): Promise<void>;
}

/** Where the backend reads the key: query.token, then auth.token, then `Authorization: Bearer`. */
function readToken(handshake: SeenHandshake): string | undefined {
  const strip = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== ''
      ? value.replace(/^bearer\s+/i, '')
      : undefined;
  const header = handshake.headers.authorization;
  return (
    strip(handshake.query.token) ??
    strip(handshake.auth.token) ??
    (typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice(7) || undefined
      : undefined)
  );
}

const asInt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return undefined;
};

/** The backend's filter normalization, with undefined keys dropped. */
export function normalizePortfolioFilters(
  raw: unknown,
): Record<string, unknown> {
  const input = (raw ?? {}) as Record<string, unknown>;
  const page = asInt(input.page) ?? 1;
  const rawTake = asInt(input.take) ?? 10;
  const eventId =
    typeof input.eventId === 'string' && input.eventId.trim().length > 0
      ? input.eventId.trim()
      : undefined;
  const maxTake = eventId ? 50 : 100;
  const pick = <T>(value: unknown, allowed: readonly T[]): T | undefined =>
    allowed.includes(value as T) ? (value as T) : undefined;
  const out: Record<string, unknown> = {
    page: page > 0 ? page : 1,
    take: Math.min(Math.max(rawTake, 1), maxTake),
    marketId: asInt(input.marketId),
    search:
      typeof input.search === 'string' && input.search.length > 0
        ? input.search
        : undefined,
    sortOrder: pick(input.sortOrder, ['ASC', 'DESC']),
    sortBy: pick(input.sortBy, ['pnl', 'value', 'expiry', 'createdAt']),
    status: pick(input.status, ['active', 'closed', 'all', 'resolved']),
    marketScope:
      typeof input.marketScope === 'string' ? input.marketScope : undefined,
    contractMarketId:
      typeof input.contractMarketId === 'string' &&
      input.contractMarketId.length > 0
        ? input.contractMarketId
        : undefined,
    marketStatus:
      typeof input.marketStatus === 'string' && input.marketStatus.length > 0
        ? input.marketStatus
        : undefined,
    eventId,
    includeSubEvents:
      typeof input.includeSubEvents === 'boolean'
        ? input.includeSubEvents
        : undefined,
  };
  return Object.fromEntries(
    Object.entries(out).filter(([, value]) => value !== undefined),
  );
}

/** The backend's filter checks. */
function filterError(
  filters: Record<string, unknown>,
): { error: string; code: string } | undefined {
  const eventId = filters.eventId as string | undefined;
  const take = filters.take as number;
  if (
    eventId &&
    (filters.marketId != null || filters.contractMarketId != null)
  ) {
    return {
      error: 'eventId cannot be combined with marketId or contractMarketId',
      code: 'INVALID_FILTER',
    };
  }
  if (eventId && !UUID_RE.test(eventId)) {
    return { error: 'eventId must be a valid UUID', code: 'INVALID_EVENT_ID' };
  }
  if (eventId && take > 50) {
    return {
      error: 'take cannot exceed 50 for event subscriptions',
      code: 'TAKE_LIMIT',
    };
  }
  if (!eventId && take > 100) {
    return { error: 'take cannot exceed 100', code: 'TAKE_LIMIT' };
  }
  return undefined;
}

/** The market activity filters the gateway builds. */
export function normalizeActivityFilters(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const page = asInt(input.page) ?? 1;
  const take = asInt(input.take) ?? 10;
  const pick = <T>(value: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(value as T) ? (value as T) : fallback;
  const out: Record<string, unknown> = {
    page: page > 0 ? page : 1,
    take: take > 0 ? Math.min(take, 50) : 10,
    sortBy: pick(
      input.sortBy,
      [
        'executedAt',
        'volumeInUSD',
        'collateralAmount',
        'shareAmount',
        'createdAt',
      ],
      'executedAt',
    ),
    sortOrder: input.sortOrder === 'ASC' ? 'ASC' : 'DESC',
    positionType: pick(input.positionType, ['BUY', 'SELL', 'all'], 'all'),
    userId: asInt(input.userId),
    outcomeId: asInt(input.outcomeId),
    outcomeIndex: asInt(input.outcomeIndex),
    userTradesOnly:
      input.userTradesOnly === true || input.userTradesOnly === 'true',
  };
  return Object.fromEntries(
    Object.entries(out).filter(([, value]) => value !== undefined),
  );
}

/** What the backend's socket gateways send for a thrown error. */
function exception(socket: ServerSocket, message: string): void {
  socket.emit('exception', { status: 'error', message });
}

export async function startSocketBackend(): Promise<MockSocketBackend> {
  const http = createServer();
  const io = new Server(http, {
    // Short keepalive, so a client that vanished is noticed quickly.
    pingInterval: 2_000,
    pingTimeout: 2_000,
  });
  const connections: MockConnection[] = [];
  const taken = new Set<MockConnection>();
  const waiters: Array<{
    namespace: string | undefined;
    resolve: (conn: MockConnection) => void;
  }> = [];
  const lastFilters = new WeakMap<MockConnection, Record<string, unknown>>();

  const backend: MockSocketBackend = {
    url: '',
    io,
    connections,
    accept(namespace) {
      const ready = connections.find(
        (conn) =>
          !taken.has(conn) &&
          (namespace === undefined || conn.namespace === namespace),
      );
      if (ready !== undefined) {
        taken.add(ready);
        return Promise.resolve(ready);
      }
      return new Promise((resolve) => waiters.push({ namespace, resolve }));
    },
    portfolioAuth: (token) =>
      token === undefined
        ? 'Authentication required'
        : { userId: 7, scopes: ['account:read'] },
    marketActivityAuth: (token) =>
      token === undefined ? undefined : `privy:${token}`,
    authDelayMs: 20,
    onPortfolioSubscribe: undefined,
    onMarketActivitySubscribe: undefined,
    marketActivityAck: undefined,
    marketActivityRows: undefined,
    portfolioRows: (filters) =>
      filters.marketId === undefined
        ? [fixtures.portfolioMarketRow(1)]
        : [fixtures.positionFixture(filters.marketId as number, 0, 'detail')],
    pushPortfolioSnapshot(conn) {
      const filters = lastFilters.get(conn) ?? normalizePortfolioFilters({});
      const data = backend.portfolioRows(filters);
      conn.socket.emit('portfolio_snapshot', {
        type: 'portfolio_snapshot',
        data,
        meta: pageMeta(
          filters.page as number,
          filters.take as number,
          data.length,
        ),
        filters,
        emittedAt: new Date().toISOString(),
      });
    },
    close: () =>
      new Promise<void>((resolve) => {
        io.disconnectSockets(true);
        io.close(() => resolve());
      }),
  };

  function record(
    socket: ServerSocket,
    namespace: MockConnection['namespace'],
  ): MockConnection {
    const { handshake } = socket;
    const seen: SeenHandshake = {
      auth: { ...(handshake.auth as Record<string, unknown>) },
      query: { ...(handshake.query as Record<string, unknown>) },
      headers: { ...(handshake.headers as Record<string, unknown>) },
      url: handshake.url,
    };
    const received: Received[] = [];
    const conn: MockConnection = {
      namespace,
      socket,
      handshake: seen,
      connectedAt: performance.now(),
      received,
      closed: new Promise((resolve) =>
        socket.once('disconnect', (reason) => resolve(reason)),
      ),
      user: undefined,
      viewer: undefined,
      subscribes: () =>
        received
          .filter((entry) => entry.event.endsWith('_subscribe'))
          .map((entry) => entry.payload),
      drop: () => socket.conn.close(),
    };
    socket.onAny((event: string, ...args: unknown[]) => {
      received.push({ event, payload: args[0], at: performance.now() });
    });
    connections.push(conn);
    const index = waiters.findIndex(
      (waiter) =>
        waiter.namespace === undefined || waiter.namespace === namespace,
    );
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      taken.add(conn);
      waiter?.resolve(conn);
    }
    return conn;
  }

  const delayOf = (conn: MockConnection): number =>
    typeof backend.authDelayMs === 'function'
      ? backend.authDelayMs(conn)
      : backend.authDelayMs;

  io.of('/portfolio').on('connection', (socket) => {
    const conn = record(socket, '/portfolio');

    socket.on('portfolio_subscribe', async (raw: unknown, ack: unknown) => {
      const reply =
        typeof ack === 'function' ? (ack as (v: unknown) => void) : undefined;
      const hook = backend.onPortfolioSubscribe;
      if (hook !== undefined && (await hook(conn, raw, reply)) === 'handled') {
        return;
      }
      if (conn.user === undefined) {
        exception(socket, 'Authentication required');
        return;
      }
      if (!conn.user.scopes.includes('account:read')) {
        const message = 'Missing scope: account:read';
        socket.emit('portfolio_error', { message, code: 'INSUFFICIENT_SCOPE' });
        exception(socket, message);
        return;
      }
      const filters = normalizePortfolioFilters(raw);
      const invalid = filterError(filters);
      if (invalid !== undefined) {
        socket.emit('portfolio_error', {
          message: invalid.error,
          code: invalid.code,
        });
        exception(socket, invalid.error);
        return;
      }
      lastFilters.set(conn, filters);
      backend.pushPortfolioSnapshot(conn);
      reply?.({ ok: true });
    });

    void (async () => {
      await sleepReal(delayOf(conn));
      try {
        const result = await backend.portfolioAuth(
          readToken(conn.handshake),
          conn,
        );
        if (typeof result === 'string') {
          socket.emit('portfolio_error', { message: result });
          socket.disconnect(true);
          return;
        }
        delete (socket.handshake.auth as Record<string, unknown>).token;
        if (!socket.connected) {
          return;
        }
        conn.user = result;
      } catch {
        socket.emit('portfolio_error', { message: 'Authentication failed' });
        socket.disconnect(true);
      }
    })();
  });

  io.of('/market-activity').on('connection', (socket) => {
    const conn = record(socket, '/market-activity');

    socket.on(
      'market_activity_subscribe',
      async (raw: unknown, ack: unknown) => {
        const reply =
          typeof ack === 'function' ? (ack as (v: unknown) => void) : undefined;
        const hook = backend.onMarketActivitySubscribe;
        if (
          hook !== undefined &&
          (await hook(conn, raw, reply)) === 'handled'
        ) {
          return;
        }
        const payload = (raw ?? {}) as Record<string, unknown>;
        const marketId = asInt(payload.marketId);
        if (marketId === undefined) {
          const message = 'marketId is required';
          socket.emit('market_activity_error', { message });
          exception(socket, message);
          return;
        }
        const source =
          (payload.filters as Record<string, unknown> | undefined) ?? payload;
        const filters = normalizeActivityFilters(source);
        const data = backend.marketActivityRows?.(filters, conn) ?? [
          activityFixture(1, true),
          activityFixture(2, true),
        ];
        socket.emit('market_activity_snapshot', {
          type: 'market_activity_snapshot',
          marketId,
          data,
          meta: pageMeta(
            filters.page as number,
            filters.take as number,
            data.length,
          ),
          filters,
          emittedAt: new Date().toISOString(),
        });
        reply?.({ ok: true });
      },
    );

    void (async () => {
      await sleepReal(delayOf(conn));
      conn.viewer = backend.marketActivityAuth(readToken(conn.handshake));
      delete (socket.handshake.auth as Record<string, unknown>).token;
      const authenticated = conn.viewer !== undefined;
      socket.emit(
        'market_activity_connection_ack',
        backend.marketActivityAck?.(conn, authenticated) ?? {
          message: 'Connected to Market Activity Service',
          authenticated,
          timestamp: new Date().toISOString(),
        },
      );
    })();
  });

  await new Promise<void>((resolve, reject) => {
    http.once('listening', resolve);
    http.once('error', reject);
    http.listen(0, '127.0.0.1');
  });
  const { port } = http.address() as AddressInfo;
  (backend as { url: string }).url = `http://127.0.0.1:${port}`;
  return backend;
}
