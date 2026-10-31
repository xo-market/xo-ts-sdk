import { vi } from 'vitest';
import { Session } from '../../src/auth/session';
import type { BackendCredential } from '../../src/auth/store';
import type { EnvironmentConfig } from '../../src/core/env';
import type { XoError } from '../../src/core/errors';
import {
  BackendRealtime,
  type BackendRealtimeOptions,
} from '../../src/realtime/socketio';
import type { Subscription } from '../../src/realtime/subscription';
import { fixtures as accountFixtures } from './mockAccountData';
import {
  type MockConnection,
  type MockSocketBackend,
  startSocketBackend,
} from './socketBackend';
import { testEnv } from './testEnv';
import { waitUntil } from './wsServer';

// The rig of the backend Socket.IO tests: a fake session, a channel factory over an
// in-process `socket.io` server (socketBackend.ts), and a recorder of what a subscription
// emits. Each test file registers `afterEach(cleanupSockets)`.

export const KEY_1 = `xo_sk_test_${'a'.repeat(40)}`;
export const KEY_2 = `xo_sk_test_${'b'.repeat(40)}`;
/** A key with characters the generic `xo_sk_` redaction does not cover. */
export const KEY_ODD = `xo_sk_odd-key.${'c'.repeat(30)}`;

export const backends: MockSocketBackend[] = [];
export const subs: Array<{ close(): Promise<void> }> = [];

/** The `afterEach` of every socket test file: closes the subscriptions, then the servers. */
export async function cleanupSockets(): Promise<void> {
  for (const sub of subs.splice(0)) {
    await sub.close();
  }
  for (const backend of backends.splice(0)) {
    await backend.close();
  }
  vi.restoreAllMocks();
}

export function credential(key: string): BackendCredential {
  return {
    id: '12',
    key,
    prefix: key.slice(0, 16),
    scopes: ['account:read'],
    expiresAt: '2030-01-01T00:00:00.000Z',
  };
}

export interface FakeSessionOptions {
  keys?: string[];
  ensureBackend?: () => Promise<BackendCredential>;
  onUnauthorized?: Session['onUnauthorized'];
  signer?: boolean;
  held?: boolean;
}

export interface FakeSession {
  session: Session;
  ensureBackend: ReturnType<typeof vi.fn<() => Promise<BackendCredential>>>;
  onUnauthorized: ReturnType<typeof vi.fn<Session['onUnauthorized']>>;
}

/** The parts of a Session the channels use. Keys are handed out in order, the last one repeats. */
export function fakeSession(o: FakeSessionOptions = {}): FakeSession {
  const keys = o.keys ?? [KEY_1];
  let next = 0;
  const ensureBackend = vi.fn<() => Promise<BackendCredential>>(
    o.ensureBackend ??
      (async () => {
        const key = keys[Math.min(next, keys.length - 1)] as string;
        next += 1;
        return credential(key);
      }),
  );
  const onUnauthorized = vi.fn<Session['onUnauthorized']>(
    o.onUnauthorized ?? (async () => true),
  );
  const session = {
    ensureBackend,
    onUnauthorized,
    hasSigner: () => o.signer ?? true,
    hasBackendCredential: () => o.held ?? false,
    toJSON: () => ({ closed: false }),
  } as unknown as Session;
  return { session, ensureBackend, onUnauthorized };
}

export interface RigOptions {
  session?: FakeSession | 'none' | Session;
  strict?: boolean;
  connection?: BackendRealtimeOptions['connection'];
}

export interface Rig {
  backend: MockSocketBackend;
  rt: BackendRealtime;
  fake: FakeSession | undefined;
  env: EnvironmentConfig;
}

export async function rig(o: RigOptions = {}): Promise<Rig> {
  const backend = await startSocketBackend();
  backends.push(backend);
  const env: EnvironmentConfig = {
    ...testEnv,
    backendSocketUrl: backend.url,
  };
  const fake =
    o.session === undefined
      ? fakeSession()
      : o.session === 'none' || o.session instanceof Session
        ? undefined
        : o.session;
  const session =
    o.session === 'none'
      ? undefined
      : o.session instanceof Session
        ? o.session
        : fake?.session;
  const rt = new BackendRealtime({
    env,
    ...(session === undefined ? {} : { session }),
    strictResponses: o.strict ?? false,
    connection: { backoff: { baseMs: 1, capMs: 5 }, ...o.connection },
  });
  return { backend, rt, fake, env };
}

export interface Log<E> {
  events: E[];
  errors: XoError[];
  reconnected: number;
  closed: number;
  /** Everything in arrival order: event types, 'reconnected', 'error:<code>' and 'closed'. */
  order: string[];
}

/** Records everything a subscription emits, and closes it after the test. */
export function watch<E extends { type: string }>(
  sub: Subscription<E>,
): Log<E> {
  subs.push(sub);
  const log: Log<E> = {
    events: [],
    errors: [],
    reconnected: 0,
    closed: 0,
    order: [],
  };
  void (async () => {
    for await (const event of sub) {
      log.events.push(event);
      log.order.push(event.type);
    }
  })();
  sub.on('error', (error) => {
    log.errors.push(error);
    log.order.push(`error:${error.code}`);
  });
  sub.on('reconnected', () => {
    log.reconnected += 1;
    log.order.push('reconnected');
  });
  sub.on('closed', () => {
    log.closed += 1;
    log.order.push('closed');
  });
  return log;
}

/** Waits for the n-th subscribe of a connection and returns its payload and arrival time. */
export async function nthSubscribe(
  conn: MockConnection,
  n = 1,
  timeoutMs = 4_000,
): Promise<{ payload: unknown; at: number }> {
  await waitUntil(
    () =>
      conn.received.filter((entry) => entry.event.endsWith('_subscribe'))
        .length >= n,
    `subscribe #${n}`,
    timeoutMs,
  );
  const entry = conn.received.filter((e) => e.event.endsWith('_subscribe'))[
    n - 1
  ];
  return { payload: entry?.payload, at: entry?.at ?? 0 };
}

/** What emitSnapshotToSocket does when the build fails: no code, no exception, and still `ok`. */
export function failSnapshot(
  conn: MockConnection,
  ack: ((value: unknown) => void) | undefined,
): 'handled' {
  conn.socket.emit('portfolio_error', {
    message: 'Failed to build portfolio snapshot',
  });
  ack?.({ ok: true });
  return 'handled';
}

export async function caught(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

/** Every string an error exposes: message, code, JSON form and cause. */
export function surface(error: XoError): string {
  return `${error.message} ${error.code} ${JSON.stringify(error.toJSON())} ${JSON.stringify(error.cause ?? null)}`;
}

/** A summary row of the account mock data (market 1). */
export function summaryRow(): Record<string, unknown> {
  return accountFixtures.portfolioMarketRow(1);
}
