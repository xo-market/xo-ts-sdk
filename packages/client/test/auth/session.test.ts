import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { delay, HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import type { Hex } from 'viem';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { MintedKeyError } from '../../src/auth/backendAuth';
import { fileStore } from '../../src/auth/fileStore';
import { Session, type SessionOptions } from '../../src/auth/session';
import {
  type BackendCredential,
  type CredentialStore,
  credentialKey,
  memoryStore,
} from '../../src/auth/store';
import { Clock } from '../../src/core/clock';
import {
  AuthRequiredError,
  RateLimitError,
  RequestRejectedError,
  TransportError,
  UnexpectedResponseError,
  UserInputError,
  XoError,
} from '../../src/core/errors';
import { Transport } from '../../src/core/transport';
import { installShutdownHooks } from '../../src/node';
import type { InternalSigner } from '../../src/wallet/signer';
import {
  API_KEYS_URL,
  type Backend,
  DAY_MS,
  exceptionResponse,
  installBackend as installMockBackend,
  invalidCredentials,
  invalidSignature,
  type KeyRecord,
  ME_PATH,
  ME_URL,
  NONCE_URL,
  seedBackendKey,
} from '../helpers/mockBackend';
import {
  CREATE_PATH,
  DERIVE_PATH,
  DERIVE_URL,
  gatewayError,
  installOrderbook as installMockOrderbook,
  ORDERS_PATH,
  ORDERS_URL,
  type Orderbook,
  type OrderbookOptions,
  seedKey,
} from '../helpers/mockOrderbook';
import { rejectedWith } from '../helpers/rejections';
import { keySigner } from '../helpers/signers';
import { testEnv } from '../helpers/testEnv';
import { clobAuthVector, kernelVector } from '../signing/helpers';

const env = testEnv;
const NONCE = 'POST /api/auth/api-keys/nonce';
const CREATE_KEY = 'POST /api/auth/api-keys';
const ME = `GET ${ME_PATH}`;
const DERIVE = `GET ${DERIVE_PATH}`;
const CREATE = `POST ${CREATE_PATH}`;
const ORDERS = `GET ${ORDERS_PATH}`;
const revokeCall = (id: string | number) => `DELETE /api/auth/api-keys/${id}`;

// The public test vector key from test-vectors/clobAuth.json. Never fund it.
const KEY = clobAuthVector.inputs.privateKey;
const OWNER = clobAuthVector.inputs.address;
const ACCOUNT = kernelVector.createAccount.expectedAccount;
const BASE = keySigner(KEY);
const EOA_STORE_KEY = credentialKey(env.name, OWNER);

/** Every request that left the SDK, as "METHOD /path", plus "sync" for each clock fetch. */
const wire: string[] = [];

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
  server.events.on('request:start', ({ request }) => {
    wire.push(`${request.method} ${new URL(request.url).pathname}`);
  });
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
  vi.useRealTimers();
  wire.length = 0;
});
afterAll(() => server.close());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const installBackend = (
  options?: Parameters<typeof installMockBackend>[1],
): Backend => installMockBackend(server, options);
const installOrderbook = (options?: OrderbookOptions): Orderbook =>
  installMockOrderbook(server, options);

const unusedRead = async (): Promise<Hex> => {
  throw new Error('the EOA identity reads nothing');
};

const paddedAccount =
  `0x${'00'.repeat(12)}${ACCOUNT.slice(2).toLowerCase()}` as Hex;

function spiedSigner() {
  return {
    address: BASE.address,
    signMessage: vi.fn<InternalSigner['signMessage']>((m) =>
      BASE.signMessage(m),
    ),
    signTypedData: vi.fn<InternalSigner['signTypedData']>((td) =>
      BASE.signTypedData(td),
    ),
  };
}
type SpiedSigner = ReturnType<typeof spiedSigner>;

interface RigOptions {
  /** `null`: no signer. Defaults to a spied signer for the vector key. */
  signer?: SpiedSigner | null;
  wallet?: SessionOptions['wallet'];
  store?: CredentialStore;
  credentials?: SessionOptions['credentials'];
  isDeployed?: SessionOptions['isDeployed'];
  now?: () => number;
  readContract?: SessionOptions['readContract'];
  /** The server time the clock reads, in ms. Defaults to `Date.now()`. */
  serverNow?: () => number;
  /** Makes a clock fetch fail while it returns true. */
  syncFails?: () => boolean;
  /** The transport's per-attempt timeout. */
  timeoutMs?: number;
  /** The clock's local time in ms (to skew this machine). Defaults to `Date.now()`. */
  clockNow?: () => number;
}

function rig(o: RigOptions = {}) {
  const signer = o.signer === null ? undefined : (o.signer ?? spiedSigner());
  const transport = new Transport({
    env,
    version: '0.0.0-test',
    ...(o.timeoutMs === undefined ? {} : { defaultTimeoutMs: o.timeoutMs }),
  });
  const fetchServerTimeSec = vi.fn(async () => {
    wire.push('sync');
    if (o.syncFails?.() === true) {
      throw new Error('time unavailable');
    }
    return Math.floor((o.serverNow?.() ?? Date.now()) / 1000);
  });
  const clock = new Clock({
    fetchServerTimeSec,
    ...(o.clockNow === undefined ? {} : { now: o.clockNow }),
  });
  const warn = vi.fn<(message: string) => void>();
  const session = new Session({
    env,
    transport,
    clock,
    signer,
    wallet: o.wallet,
    store: o.store,
    credentials: o.credentials,
    label: 'test',
    readContract: o.readContract ?? unusedRead,
    warn,
    now: o.now,
    isDeployed: o.isDeployed,
  });
  transport.setAuth(session);
  return {
    session,
    transport,
    clock,
    fetchServerTimeSec,
    warn,
    signer: signer as SpiedSigner,
  };
}

const getMe = (t: Transport) =>
  t.request({
    service: 'backend',
    method: 'GET',
    path: ME_PATH,
    auth: 'backend',
  });
const getOrders = (t: Transport) =>
  t.request({
    service: 'orderbook',
    method: 'GET',
    path: ORDERS_PATH,
    auth: 'orderbook',
  });

const count = (calls: readonly string[], call: string) =>
  calls.filter((c) => c === call).length;

const credentialOf = (seeded: {
  key: string;
  record: KeyRecord;
}): BackendCredential => ({
  id: String(seeded.record.id),
  key: seeded.key,
  prefix: seeded.record.prefix,
  scopes: [...seeded.record.scopes],
  expiresAt: seeded.record.expiresAt,
});

/** A memory store that says it is persistent, as a file store would. */
function persistentStore(): CredentialStore & { inner: CredentialStore } {
  const inner = memoryStore();
  return {
    inner,
    persistent: true,
    get: (key) => inner.get(key),
    set: (key, value) => inner.set(key, value),
    delete: (key) => inner.delete(key),
  };
}

/** Wraps a store, records the keys it is asked for and logs each `set` to `wire`. */
function recording(inner: CredentialStore) {
  const keys: string[] = [];
  const store: CredentialStore = {
    persistent: inner.persistent,
    async get(key) {
      keys.push(key);
      return inner.get(key);
    },
    async set(key, value) {
      keys.push(key);
      wire.push('store.set');
      return inner.set(key, value);
    },
    async delete(key) {
      keys.push(key);
      return inner.delete(key);
    },
  };
  return { store, keys };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

/** Everything a caller could print from a value. */
function dump(value: unknown): string {
  return [
    JSON.stringify(value),
    String(value),
    inspect(value, { depth: null, showHidden: true }),
    value instanceof Error ? (value.stack ?? '') : '',
  ].join('\n');
}

async function withTmpDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'xo-session-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Single flight
// ---------------------------------------------------------------------------

describe('single flight', () => {
  test('5 concurrent ensureBackend() calls → exactly 1 nonce request and 1 key', async () => {
    const backend = installBackend();
    const { session, signer } = rig();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => session.ensureBackend()),
    );
    expect(count(backend.calls, NONCE)).toBe(1);
    expect(count(backend.calls, CREATE_KEY)).toBe(1);
    expect(backend.minted).toHaveLength(1);
    expect(signer.signMessage).toHaveBeenCalledTimes(1);
    const minted = backend.minted[0]?.key;
    expect(results.map((c) => c.key)).toEqual(Array(5).fill(minted));
  });

  test('5 concurrent ensureOrderbook() calls → one derive and at most one create', async () => {
    const orderbook = installOrderbook();
    const { session, signer } = rig();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => session.ensureOrderbook()),
    );
    expect(count(orderbook.calls, DERIVE)).toBe(1);
    expect(count(orderbook.calls, CREATE)).toBe(1);
    expect(signer.signTypedData).toHaveBeenCalledTimes(1);
    const created = orderbook.keys.get(OWNER.toLowerCase());
    expect(created).toHaveLength(1);
    for (const result of results) {
      expect(result).toEqual(created?.[0]);
    }
  });

  test('5 concurrent ensureOrderbook() calls for a wallet with a key → one derive and no create', async () => {
    const orderbook = installOrderbook();
    const existing = seedKey(orderbook, OWNER);
    const { session } = rig();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => session.ensureOrderbook()),
    );
    expect(orderbook.calls).toEqual([DERIVE]);
    expect(results).toEqual(Array(5).fill(existing));
  });

  test('several API calls at startup produce one backend key and one orderbook login', async () => {
    const backend = installBackend();
    const orderbook = installOrderbook();
    const store = memoryStore();
    const { session, transport, signer } = rig({ store });
    await Promise.all([
      ...Array.from({ length: 5 }, () => getMe(transport)),
      ...Array.from({ length: 5 }, () => getOrders(transport)),
    ]);
    expect(count(backend.calls, NONCE)).toBe(1);
    expect(count(backend.calls, CREATE_KEY)).toBe(1);
    expect(count(orderbook.calls, DERIVE)).toBe(1);
    expect(count(orderbook.calls, CREATE)).toBeLessThanOrEqual(1);
    expect(signer.signMessage).toHaveBeenCalledTimes(1);
    expect(signer.signTypedData).toHaveBeenCalledTimes(1);
    const key = backend.minted[0]?.key;
    expect(backend.meAuth).toEqual(Array(5).fill(`Bearer ${key}`));
    expect(count(orderbook.calls, ORDERS)).toBe(5);
    const saved = await store.get(EOA_STORE_KEY);
    expect(saved?.backend?.key).toBe(key);
    expect(saved?.orderbook).toEqual(
      orderbook.keys.get(OWNER.toLowerCase())?.[0],
    );
    expect(session.hasBackendCredential()).toBe(true);
  });

  test('login() gets both credentials, the backend key first', async () => {
    installBackend();
    installOrderbook();
    const { session } = rig();
    await session.login();
    // The session's one clock sync comes before the first mint.
    expect(wire).toEqual(['sync', NONCE, CREATE_KEY, DERIVE, CREATE]);
    await session.login();
    expect(wire).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Persistence and restart
// ---------------------------------------------------------------------------

describe('persistence', () => {
  test('restart with fileStore containing valid creds → zero network calls before first API request', async () => {
    await withTmpDir(async (dir) => {
      const backend = installBackend();
      const orderbook = installOrderbook();
      const first = rig({ store: fileStore(dir) });
      await first.session.login();
      await first.session.close();
      // A persistent store keeps the key: close() does not revoke it.
      expect(wire.filter((call) => call.startsWith('DELETE'))).toEqual([]);
      wire.length = 0;

      const restarted = rig({ store: fileStore(dir) });
      expect(restarted.session.hasSigner()).toBe(true);
      await restarted.session.identity();
      expect(wire).toEqual([]);
      await getMe(restarted.transport);
      await getOrders(restarted.transport);
      expect(wire).toEqual([ME, ORDERS]);
      expect(restarted.signer.signMessage).not.toHaveBeenCalled();
      expect(restarted.signer.signTypedData).not.toHaveBeenCalled();
      expect(backend.meAuth).toEqual([`Bearer ${backend.minted[0]?.key}`]);
      expect(orderbook.requests.at(-1)?.headers.get('XO_API_KEY')).toBe(
        orderbook.keys.get(OWNER.toLowerCase())?.[0]?.apiKey,
      );
    });
  });

  test('a stored valid key and orderbook creds are used as they are', async () => {
    const backend = installBackend();
    const orderbook = installOrderbook();
    const seeded = seedBackendKey(backend);
    const ob = seedKey(orderbook, OWNER);
    const store = memoryStore();
    await store.set(EOA_STORE_KEY, {
      backend: credentialOf(seeded),
      orderbook: ob,
    });
    const { session } = rig({ store });
    expect(await session.ensureBackend()).toEqual(credentialOf(seeded));
    expect(await session.ensureOrderbook()).toEqual(ob);
    expect(wire).toEqual([]);
    expect(session.hasBackendCredential()).toBe(true);
  });

  test('expired backend creds in the store are discarded and replaced by a fresh login', async () => {
    const backend = installBackend();
    const seeded = seedBackendKey(backend, {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const store = persistentStore();
    await store.set(EOA_STORE_KEY, { backend: credentialOf(seeded) });
    const { session } = rig({ store });
    const fresh = await session.ensureBackend();
    expect(wire).toEqual(['sync', NONCE, CREATE_KEY]);
    expect(fresh.key).toBe(backend.minted[0]?.key);
    expect((await store.get(EOA_STORE_KEY))?.backend).toEqual(fresh);
  });

  test('the backend key is 90-day with a persistent store and 1-day with the default memory store', async () => {
    const backend = installBackend();
    await rig({ store: persistentStore() }).session.ensureBackend();
    await rig().session.ensureBackend();
    expect(backend.walletBodies.map((b) => b.expiresInDays)).toEqual([90, 1]);
    expect(backend.walletBodies[0]?.name).toMatch(/^xo-sdk:test:\d{8}$/);
    // An EOA session creates its key with type eoa and no signatureType.
    for (const body of backend.walletBodies) {
      expect(body.type).toBe('eoa');
      expect(body).not.toHaveProperty('signatureType');
    }
  });

  test('a credential_store_unavailable error from get propagates and nothing is minted', async () => {
    installBackend();
    installOrderbook();
    const store: CredentialStore = {
      persistent: true,
      get: async () => {
        throw new XoError(
          'credential store unavailable: read failed (EACCES)',
          {
            code: 'credential_store_unavailable',
          },
        );
      },
      set: async () => undefined,
      delete: async () => undefined,
    };
    const { session } = rig({ store });
    const error = await caught(() => session.ensureBackend());
    expect(error).toBeInstanceOf(XoError);
    expect((error as XoError).code).toBe('credential_store_unavailable');
    const again = await caught(() => session.ensureOrderbook());
    expect((again as XoError).code).toBe('credential_store_unavailable');
    expect(wire).toEqual([]);
  });

  test('a failed store write propagates, but the minted key is kept and not minted again', async () => {
    const backend = installBackend();
    let writes = 0;
    const inner = memoryStore();
    const store: CredentialStore = {
      persistent: true,
      get: (key) => inner.get(key),
      set: async () => {
        writes += 1;
        throw new XoError(
          'credential store unavailable: write failed (ENOSPC)',
          {
            code: 'credential_store_unavailable',
          },
        );
      },
      delete: (key) => inner.delete(key),
    };
    const { session } = rig({ store });
    const error = await caught(() => session.ensureBackend());
    expect((error as XoError).code).toBe('credential_store_unavailable');
    const kept = await session.ensureBackend();
    expect(kept.key).toBe(backend.minted[0]?.key);
    expect(count(backend.calls, NONCE)).toBe(1);
    // The next ensureBackend retried the write, best effort.
    expect(writes).toBe(2);
  });

  test('concurrent backend and orderbook writes both end up in the store', async () => {
    installBackend();
    installOrderbook();
    const inner = memoryStore();
    let active = 0;
    let maxActive = 0;
    const slow = async <T>(op: () => Promise<T>): Promise<T> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((r) => setTimeout(r, 25));
        return await op();
      } finally {
        active -= 1;
      }
    };
    const store: CredentialStore = {
      persistent: false,
      get: (key) => slow(() => inner.get(key)),
      set: (key, value) => slow(() => inner.set(key, value)),
      delete: (key) => inner.delete(key),
    };
    // Both logins wait at their signature and are released together, so both writes are
    // due at the same moment.
    const gate = deferred();
    const signer = spiedSigner();
    signer.signMessage.mockImplementationOnce(async (m) => {
      await gate.promise;
      return BASE.signMessage(m);
    });
    signer.signTypedData.mockImplementationOnce(async (td) => {
      await gate.promise;
      return BASE.signTypedData(td);
    });
    const { session } = rig({ store, signer });
    const both = Promise.all([
      session.ensureBackend(),
      session.ensureOrderbook(),
    ]);
    await vi.waitFor(() => {
      expect(signer.signMessage).toHaveBeenCalled();
      expect(signer.signTypedData).toHaveBeenCalled();
    });
    gate.resolve();
    const [backend, orderbook] = await both;
    const saved = await inner.get(EOA_STORE_KEY);
    expect(saved?.backend).toEqual(backend);
    expect(saved?.orderbook).toEqual(orderbook);
    expect(maxActive).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Store keying
// ---------------------------------------------------------------------------

describe('store keying', () => {
  test('store key uses env name + trading address (EOA → the wallet address)', async () => {
    installBackend();
    installOrderbook();
    const { store, keys } = recording(memoryStore());
    const { session } = rig({ store });
    await session.login();
    expect(new Set(keys)).toEqual(
      new Set([`${env.name}:${OWNER.toLowerCase()}`]),
    );
  });

  test('store key uses env name + trading address (smart_wallet → the smart wallet address)', async () => {
    const backend = installBackend({
      smartAccounts: { [ACCOUNT.toLowerCase()]: { owner: OWNER, index: 0n } },
    });
    const orderbook = installOrderbook({
      smartAccounts: { [ACCOUNT.toLowerCase()]: { owner: OWNER } },
    });
    const inner = memoryStore();
    const { store, keys } = recording(inner);
    const isDeployed = vi.fn(async () => true);
    const { session } = rig({
      store,
      wallet: { type: 'smart_wallet', index: 0 },
      readContract: async () => paddedAccount,
      isDeployed,
    });
    await session.login();
    const expected = `${env.name}:${ACCOUNT.toLowerCase()}`;
    expect(new Set(keys)).toEqual(new Set([expected]));
    expect((await session.identity()).address).toBe(ACCOUNT);
    expect(backend.nonceBodies).toEqual([{ address: ACCOUNT }]);
    // A smart wallet session creates its key with type smart_wallet, the owner as
    // signer and the index, and no signatureType.
    expect(count(backend.calls, CREATE_KEY)).toBe(1);
    expect(backend.walletBodies[0]).toMatchObject({
      type: 'smart_wallet',
      signer: OWNER,
      index: '0',
    });
    expect(backend.walletBodies[0]).not.toHaveProperty('signatureType');
    expect(isDeployed).toHaveBeenCalledWith(ACCOUNT);
    const saved = await inner.get(expected);
    expect(saved?.backend?.key).toBe(backend.minted[0]?.key);
    expect(saved?.orderbook).toEqual(
      orderbook.keys.get(ACCOUNT.toLowerCase())?.[0],
    );
  });
});

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

describe('rotation', () => {
  test('key with 6 days left (persistent) → rotation mints new key, swaps, revokes old with old key; concurrent requests during rotation wait', async () => {
    const backend = installBackend();
    const old = seedBackendKey(backend, {
      expiresAt: new Date(Date.now() + 6 * DAY_MS).toISOString(),
    });
    const persistent = persistentStore();
    await persistent.set(EOA_STORE_KEY, { backend: credentialOf(old) });
    const { store } = recording(persistent);

    const gate = deferred();
    const signer = spiedSigner();
    signer.signMessage.mockImplementationOnce(async (m) => {
      await gate.promise;
      return BASE.signMessage(m);
    });
    const { transport } = rig({ store, signer });

    const requests = Array.from({ length: 5 }, () => getMe(transport));
    await vi.waitFor(() => expect(signer.signMessage).toHaveBeenCalled());
    // The new key is being minted: no request has gone out with either key.
    expect(backend.meAuth).toEqual([]);
    gate.resolve();
    await Promise.all(requests);

    const fresh = backend.minted[0];
    expect(backend.minted).toHaveLength(1);
    // Sync the clock once, then mint, swap, store, and revoke the old key with itself.
    expect(wire.slice(0, 5)).toEqual([
      'sync',
      NONCE,
      CREATE_KEY,
      'store.set',
      revokeCall(old.record.id),
    ]);
    expect(backend.keyAuth).toEqual([`Bearer ${old.key}`]);
    expect(old.record.revokedAt).not.toBeNull();
    expect(backend.meAuth).toEqual(Array(5).fill(`Bearer ${fresh?.key}`));
    expect((await persistent.get(EOA_STORE_KEY))?.backend?.key).toBe(
      fresh?.key,
    );
  });

  test('a key with 8 days left (persistent) is not rotated', async () => {
    const backend = installBackend();
    const seeded = seedBackendKey(backend, {
      expiresAt: new Date(Date.now() + 8 * DAY_MS).toISOString(),
    });
    const store = persistentStore();
    await store.set(EOA_STORE_KEY, { backend: credentialOf(seeded) });
    const { transport } = rig({ store });
    await getMe(transport);
    expect(wire).toEqual([ME]);
  });

  test('rotateBackend() forces a rotation; concurrent calls share one rotation', async () => {
    const backend = installBackend();
    const store = persistentStore();
    const { session } = rig({ store });
    const first = await session.ensureBackend();
    await Promise.all([session.rotateBackend(), session.rotateBackend()]);
    expect(backend.minted).toHaveLength(2);
    expect(count(backend.calls, revokeCall(first.id))).toBe(1);
    const current = await session.ensureBackend();
    expect(current.key).toBe(backend.minted[1]?.key);
    expect((await store.get(EOA_STORE_KEY))?.backend).toEqual(current);
    expect(backend.minted[0]?.record.revokedAt).not.toBeNull();
  });

  test('a failed revoke of the old key is swallowed with one warn and not retried', async () => {
    const backend = installBackend();
    const old = seedBackendKey(backend, {
      expiresAt: new Date(Date.now() + 6 * DAY_MS).toISOString(),
    });
    const store = persistentStore();
    await store.set(EOA_STORE_KEY, { backend: credentialOf(old) });
    server.use(
      http.delete(`${API_KEYS_URL}/:id`, () =>
        exceptionResponse('/api/auth/api-keys/1', 403, {
          error: 'api_key_can_only_revoke_itself',
          message: 'An API key can only revoke itself.',
        }),
      ),
    );
    const { session, warn } = rig({ store });
    const fresh = await session.ensureBackend();
    expect(fresh.key).toBe(backend.minted[0]?.key);
    expect(count(wire, revokeCall(old.record.id))).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] ?? '';
    expect(message).toContain(String(old.record.id));
    expect(message).not.toContain(old.key);
    expect(message).not.toContain(fresh.key);
  });

  test('rotateBackend() refuses a bring-your-own key', async () => {
    const backend = installBackend();
    const byo = seedBackendKey(backend);
    const { session } = rig({ credentials: { backend: { apiKey: byo.key } } });
    const error = await caught(() => session.rotateBackend());
    expect(error).toBeInstanceOf(XoError);
    expect(dump(error)).not.toContain(byo.key);
    expect(wire).toEqual([]);
  });

  test('a bring-your-own key is never rotated, even when the session has a signer', async () => {
    const backend = installBackend();
    const byo = seedBackendKey(backend);
    const { session, transport } = rig({
      credentials: { backend: { apiKey: byo.key } },
    });
    await getMe(transport);
    await session.close();
    expect(wire).toEqual([ME]);
    expect(byo.record.revokedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 401 recovery
// ---------------------------------------------------------------------------

describe('401 recovery', () => {
  test('persisted backend key revoked externally → first request 401 → onUnauthorized logs in once → request succeeds; a second 401 throws a 401 rejection (no loop)', async () => {
    await withTmpDir(async (dir) => {
      const backend = installBackend();
      const seeded = seedBackendKey(backend);
      await fileStore(dir).set(EOA_STORE_KEY, {
        backend: credentialOf(seeded),
      });
      seeded.record.revokedAt = new Date().toISOString();

      const { transport } = rig({ store: fileStore(dir) });
      const me = await getMe(transport);
      expect(me).toMatchObject({ keyId: backend.minted[0]?.record.id });
      expect(backend.minted).toHaveLength(1);
      expect(count(backend.calls, NONCE)).toBe(1);
      expect(backend.meAuth).toEqual([
        `Bearer ${seeded.key}`,
        `Bearer ${backend.minted[0]?.key}`,
      ]);
      expect((await fileStore(dir).get(EOA_STORE_KEY))?.backend?.key).toBe(
        backend.minted[0]?.key,
      );

      // Every key is now refused.
      server.use(http.get(ME_URL, () => invalidCredentials(ME_PATH)));
      wire.length = 0;
      const error = await caught(() => getMe(transport));
      expect(error).toSatisfy(rejectedWith(401));
      expect((error as RequestRejectedError).code).toBe('invalid_credentials');
      expect(wire).toEqual([ME]);
      expect(count(backend.calls, NONCE)).toBe(1);
    });
  });

  test('a request that still gets 401 after the re-login throws a 401 rejection after exactly one login', async () => {
    const backend = installBackend();
    server.use(http.get(ME_URL, () => invalidCredentials(ME_PATH)));
    const { transport } = rig();
    const error = await caught(() => getMe(transport));
    expect(error).toSatisfy(rejectedWith(401));
    expect(count(backend.calls, NONCE)).toBe(2);
    expect(count(wire, ME)).toBe(2);
    // The replaced key was revoked with itself.
    expect(
      count(backend.calls, revokeCall(backend.minted[0]?.record.id ?? 0)),
    ).toBe(1);
    expect(backend.minted[0]?.record.revokedAt).not.toBeNull();
  });

  test('concurrent 401s share one re-login', async () => {
    const backend = installBackend();
    const seeded = seedBackendKey(backend);
    const store = persistentStore();
    await store.set(EOA_STORE_KEY, { backend: credentialOf(seeded) });
    seeded.record.revokedAt = new Date().toISOString();
    const { transport } = rig({ store });
    await Promise.all(Array.from({ length: 5 }, () => getMe(transport)));
    expect(count(backend.calls, NONCE)).toBe(1);
    expect(backend.minted).toHaveLength(1);
  });

  test('the backend re-login has a 60 s cooldown, doubled by a repeat 401', async () => {
    const backend = installBackend();
    const seeded = seedBackendKey(backend);
    const store = persistentStore();
    await store.set(EOA_STORE_KEY, { backend: credentialOf(seeded) });
    seeded.record.revokedAt = new Date().toISOString();
    let t = Date.now();
    const { transport } = rig({ store, now: () => t });

    await getMe(transport);
    expect(count(backend.calls, NONCE)).toBe(1);

    // The new key is revoked too. 30 s later: no new login.
    const second = backend.minted[0];
    if (second === undefined) throw new Error('no key minted');
    second.record.revokedAt = new Date().toISOString();
    t += 30_000;
    expect(await caught(() => getMe(transport))).toSatisfy(rejectedWith(401));
    expect(count(backend.calls, NONCE)).toBe(1);

    // The 401 30 s after the re-login doubled the cooldown: 61 s is not enough...
    t += 31_000;
    expect(await caught(() => getMe(transport))).toSatisfy(rejectedWith(401));
    expect(count(backend.calls, NONCE)).toBe(1);
    // ...121 s is.
    t += 60_000;
    await getMe(transport);
    expect(count(backend.calls, NONCE)).toBe(2);
  });

  test('a bring-your-own backend key is never re-logged: onUnauthorized returns false', async () => {
    const backend = installBackend();
    const byo = seedBackendKey(backend);
    byo.record.revokedAt = new Date().toISOString();
    const { session, transport } = rig({
      credentials: { backend: { apiKey: byo.key } },
    });
    expect(await session.onUnauthorized('backend')).toBe(false);
    const error = await caught(() => getMe(transport));
    expect(error).toSatisfy(rejectedWith(401));
    expect(wire).toEqual([ME]);
    expect(dump(error)).not.toContain(byo.key);
  });

  test('a bring-your-own orderbook credential is never re-derived: onUnauthorized returns false', async () => {
    const orderbook = installOrderbook();
    const byo = seedKey(orderbook, OWNER);
    orderbook.keys.clear();
    const { session, transport } = rig({ credentials: { orderbook: byo } });
    expect(await session.onUnauthorized('orderbook')).toBe(false);
    expect(await caught(() => getOrders(transport))).toSatisfy(
      rejectedWith(401),
    );
    expect(wire).toEqual([ORDERS]);
  });

  test('an orderbook 401 syncs the clock, re-derives once, and has a 60 s cooldown, doubled by a repeat 401', async () => {
    // The gateway is 100 s ahead: inside the L1 window (120 s), outside the L2 window (30 s).
    const skew = 100_000;
    const orderbook = installOrderbook({ now: () => Date.now() + skew });
    const ob = seedKey(orderbook, OWNER);
    const store = memoryStore();
    await store.set(EOA_STORE_KEY, { orderbook: ob });
    let t = Date.now();
    const { transport, signer } = rig({
      store,
      now: () => t,
      serverNow: () => Date.now() + skew,
    });

    await expect(getOrders(transport)).resolves.toEqual([]);
    expect(wire).toEqual([ORDERS, 'sync', DERIVE, ORDERS]);
    expect(signer.signTypedData).toHaveBeenCalledTimes(1);

    server.use(
      http.get(ORDERS_URL, () => gatewayError(401, 'invalid API key')),
    );
    wire.length = 0;
    t += 30_000;
    expect(await caught(() => getOrders(transport))).toSatisfy(
      rejectedWith(401),
    );
    expect(wire).toEqual([ORDERS]);

    // The repeat 401 at 30 s doubled the cooldown to 120 s.
    t += 31_000;
    wire.length = 0;
    expect(await caught(() => getOrders(transport))).toSatisfy(
      rejectedWith(401),
    );
    expect(wire).toEqual([ORDERS]);

    t += 60_000;
    wire.length = 0;
    expect(await caught(() => getOrders(transport))).toSatisfy(
      rejectedWith(401),
    );
    expect(wire).toEqual([ORDERS, 'sync', DERIVE, ORDERS]);
    // Derive returns the existing key: the gateway holds no new one.
    expect(orderbook.keys.get(OWNER.toLowerCase())).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Orderbook login
// ---------------------------------------------------------------------------

describe('orderbook login', () => {
  test('the clock is synced before the first orderbook login', async () => {
    installOrderbook();
    const { session } = rig();
    await session.ensureOrderbook();
    expect(wire).toEqual(['sync', DERIVE, CREATE]);
  });

  test('a failing clock sync does not block the login', async () => {
    const orderbook = installOrderbook();
    const { session } = rig({ syncFails: () => true });
    const credential = await session.ensureOrderbook();
    expect(credential).toEqual(orderbook.keys.get(OWNER.toLowerCase())?.[0]);
    expect(wire).toEqual(['sync', DERIVE, CREATE]);
  });

  test('a stale L1 timestamp (401) syncs the clock and retries the login exactly once', async () => {
    // The gateway is 200 s ahead, outside the L1 window. The first sync fails, so the first
    // login is signed with the local time.
    const skew = 200_000;
    const orderbook = installOrderbook({ now: () => Date.now() + skew });
    let syncs = 0;
    const { session, signer } = rig({
      serverNow: () => Date.now() + skew,
      syncFails: () => {
        syncs += 1;
        return syncs === 1;
      },
    });
    const credential = await session.ensureOrderbook();
    expect(wire).toEqual(['sync', DERIVE, 'sync', DERIVE, CREATE]);
    expect(signer.signTypedData).toHaveBeenCalledTimes(2);
    expect(credential).toEqual(orderbook.keys.get(OWNER.toLowerCase())?.[0]);
  });

  test('a login that keeps failing L1 is retried once, then throws a 401 rejection', async () => {
    installOrderbook();
    server.use(
      http.get(DERIVE_URL, () =>
        gatewayError(401, 'L1 timestamp too old or too far in future'),
      ),
    );
    const { session, signer } = rig();
    const error = await caught(() => session.ensureOrderbook());
    expect(error).toSatisfy(rejectedWith(401));
    expect(count(wire, DERIVE)).toBe(2);
    expect(count(wire, CREATE)).toBe(0);
    expect(signer.signTypedData).toHaveBeenCalledTimes(2);
  });

  test('smart_wallet with isDeployed false → smart_wallet_not_deployed propagates from ensureOrderbook, after 3 reads over 6 s', async () => {
    const orderbook = installOrderbook();
    const isDeployed = vi.fn(async () => false);
    const { session, signer } = rig({
      wallet: { type: 'smart_wallet', index: 0 },
      readContract: async () => paddedAccount,
      isDeployed,
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = caught(() => session.ensureOrderbook());
    await vi.advanceTimersByTimeAsync(6_000);
    const error = await pending;
    expect(error).toBeInstanceOf(XoError);
    expect((error as XoError).code).toBe('smart_wallet_not_deployed');
    expect(isDeployed).toHaveBeenCalledTimes(3);
    expect(isDeployed).toHaveBeenCalledWith(ACCOUNT);
    expect(signer.signTypedData).not.toHaveBeenCalled();
    expect(orderbook.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// No immediate retry of a login that failed after the key was minted
// ---------------------------------------------------------------------------

describe('post-mint login cooldown', () => {
  const CREATE_KEY_PATH = '/api/auth/api-keys';
  const tooMany = () =>
    exceptionResponse(CREATE_KEY_PATH, 429, {
      error: 'rate_limited',
      message: 'Too many requests',
    });
  const req = { method: 'GET', path: ME_PATH, body: '' };

  test('a broken 201, then 3 sequential ensureBackend calls within 60 s → exactly 1 mint; after 60 s one more attempt', async () => {
    const backend = installBackend();
    backend.createdHook = (body) => ({
      ...body,
      key: 'xo_sk_data_ab cd_LEAKED',
    });
    let t = Date.now();
    const { session, transport, warn } = rig({
      store: persistentStore(),
      now: () => t,
    });

    const first = await caught(() => session.ensureBackend());
    expect(first).toBeInstanceOf(UnexpectedResponseError);
    const minted = backend.minted[0];
    expect(minted).toBeDefined();
    for (const step of [10_000, 20_000, 29_000]) {
      t += step; // 10 s, 30 s, 59 s after the failure
      expect(await caught(() => session.ensureBackend())).toBe(first);
    }
    expect(await caught(() => session.headers('backend', req))).toBe(first);
    expect(await caught(() => getMe(transport))).toBe(first);
    expect(count(backend.calls, NONCE)).toBe(1);
    expect(count(backend.calls, CREATE_KEY)).toBe(1);
    expect(backend.minted).toHaveLength(1);

    // One warn for the cooldown, naming the orphaned key's id and nothing secret.
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] ?? '';
    expect(message).toContain(`id ${minted?.record.id}`);
    for (const secret of [
      minted?.key ?? '',
      minted?.record.prefix ?? '',
      'LEAKED',
    ]) {
      expect(secret).not.toBe('');
      expect(message).not.toContain(secret);
      expect(dump(first)).not.toContain(secret);
    }

    t += 2_000; // 61 s
    backend.createdHook = undefined;
    const fresh = await session.ensureBackend();
    expect(count(backend.calls, NONCE)).toBe(2);
    expect(fresh.key).toBe(backend.minted[1]?.key);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('a 429 on mint is cooled the same way', async () => {
    const backend = installBackend();
    backend.walletHook = tooMany;
    let t = Date.now();
    const { session, warn } = rig({ store: persistentStore(), now: () => t });

    const first = await caught(() => session.ensureBackend());
    expect(first).toBeInstanceOf(RateLimitError);
    t += 30_000;
    expect(await caught(() => session.ensureBackend())).toBe(first);
    expect(await caught(() => session.headers('backend', req))).toBe(first);
    expect(count(backend.calls, NONCE)).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('rate');

    t += 31_000;
    backend.walletHook = undefined;
    await session.ensureBackend();
    expect(count(backend.calls, NONCE)).toBe(2);
    expect(backend.minted).toHaveLength(1);
  });

  test('a network error before mint retries immediately', async () => {
    const backend = installBackend();
    server.use(
      http.post(NONCE_URL, () => HttpResponse.error(), { once: true }),
    );
    const { session, warn } = rig({ store: persistentStore() });
    expect(await caught(() => session.ensureBackend())).toBeInstanceOf(
      TransportError,
    );
    const credential = await session.ensureBackend();
    expect(count(wire, NONCE)).toBe(2);
    expect(credential.key).toBe(backend.minted[0]?.key);
    expect(warn).not.toHaveBeenCalled();
  });

  test('a 401 invalid_signature before mint retries immediately', async () => {
    const backend = installBackend();
    let rejected = false;
    backend.walletHook = () => {
      if (rejected) {
        return undefined;
      }
      rejected = true;
      return invalidSignature();
    };
    const { session, warn } = rig({ store: persistentStore() });
    expect(await caught(() => session.ensureBackend())).toSatisfy(
      rejectedWith(401),
    );
    await session.ensureBackend();
    expect(count(backend.calls, NONCE)).toBe(2);
    expect(backend.minted).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  test('a rotation that is cooled keeps the old key until the cooldown ends; rotateBackend() rethrows', async () => {
    const backend = installBackend();
    const old = seedBackendKey(backend, {
      expiresAt: new Date(Date.now() + 6 * DAY_MS).toISOString(),
    });
    const store = persistentStore();
    await store.set(EOA_STORE_KEY, { backend: credentialOf(old) });
    backend.walletHook = tooMany;
    let t = Date.now();
    const { session, transport } = rig({ store, now: () => t });

    expect((await session.ensureBackend()).key).toBe(old.key);
    await getMe(transport);
    expect(backend.meAuth).toEqual([`Bearer ${old.key}`]);
    t += 30_000;
    expect((await session.ensureBackend()).key).toBe(old.key);
    expect(await caught(() => session.rotateBackend())).toBeInstanceOf(
      RateLimitError,
    );
    expect(count(backend.calls, NONCE)).toBe(1);
    expect(old.record.revokedAt).toBeNull();

    t += 31_000;
    backend.walletHook = undefined;
    const fresh = await session.ensureBackend();
    expect(fresh.key).toBe(backend.minted[0]?.key);
    expect(count(backend.calls, NONCE)).toBe(2);
    expect(old.record.revokedAt).not.toBeNull();
  });
  test('a rotation that fails before mint keeps the old key, warns once, and waits 60 s to retry', async () => {
    const backend = installBackend();
    const old = seedBackendKey(backend, {
      expiresAt: new Date(Date.now() + 6 * DAY_MS).toISOString(),
    });
    const store = persistentStore();
    await store.set(EOA_STORE_KEY, { backend: credentialOf(old) });
    backend.walletHook = () => invalidSignature();
    let t = Date.now();
    const { session, warn } = rig({ store, now: () => t });

    expect((await session.ensureBackend()).key).toBe(old.key);
    t += 10_000;
    expect((await session.ensureBackend()).key).toBe(old.key);
    expect(count(backend.calls, NONCE)).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] ?? '';
    expect(message).toContain(`id ${old.record.id}`);
    expect(message).not.toContain(old.key);
    expect(message).not.toContain(old.record.prefix);

    t += 51_000;
    backend.walletHook = undefined;
    expect((await session.ensureBackend()).key).toBe(backend.minted[0]?.key);
    expect(count(backend.calls, NONCE)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// A wallet request that may have minted pauses logins too
// ---------------------------------------------------------------------------

describe('ambiguous wallet failures', () => {
  async function expectOneWalletRequest(o: {
    arrange: (backend: Backend) => void;
    cause: unknown;
    timeoutMs?: number;
  }) {
    const backend = installBackend();
    o.arrange(backend);
    let t = Date.now();
    const { session, warn } = rig({
      store: persistentStore(),
      now: () => t,
      timeoutMs: o.timeoutMs,
    });
    const first = await caught(() => session.ensureBackend());
    expect(first).toBeInstanceOf(MintedKeyError);
    expect((first as MintedKeyError).mayHaveMinted).toBe(true);
    expect((first as MintedKeyError).keyId).toBeUndefined();
    expect((first as Error).cause).toBeInstanceOf(o.cause as never);
    for (const step of [15_000, 20_000, 20_000]) {
      t += step;
      expect(await caught(() => session.ensureBackend())).toBe(first);
    }
    expect(count(wire, CREATE_KEY)).toBe(1);
    expect(count(wire, NONCE)).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] ?? '';
    expect(message).toContain('may have created');
    expect(message).toContain('id unknown');
  }

  test('a network error on the wallet request', async () => {
    await expectOneWalletRequest({
      arrange: (backend) => {
        backend.walletHook = () => HttpResponse.error();
      },
      cause: TransportError,
    });
  });

  test('a 500 on the key request', async () => {
    await expectOneWalletRequest({
      arrange: (backend) => {
        backend.walletHook = () =>
          HttpResponse.json({ statusCode: 500 }, { status: 500 });
      },
      cause: RequestRejectedError,
    });
  });

  test('a 504 on the wallet request', async () => {
    await expectOneWalletRequest({
      arrange: (backend) => {
        backend.walletHook = () =>
          HttpResponse.json({ statusCode: 504 }, { status: 504 });
      },
      cause: XoError,
    });
  });

  test('a 201 whose JSON body is "{"', async () => {
    await expectOneWalletRequest({
      arrange: (backend) => {
        backend.walletHook = () =>
          new HttpResponse('{', {
            status: 201,
            headers: { 'content-type': 'application/json' },
          });
      },
      cause: UnexpectedResponseError,
    });
  });

  test('a 201 delayed past the timeout', async () => {
    await expectOneWalletRequest({
      arrange: () => {
        server.use(
          http.post(API_KEYS_URL, async () => {
            await delay(400);
            return HttpResponse.json({}, { status: 201 });
          }),
        );
      },
      cause: XoError,
      timeoutMs: 100,
    });
  });

  test('a network error on the nonce request still retries immediately', async () => {
    const backend = installBackend();
    server.use(
      http.post(NONCE_URL, () => HttpResponse.error(), { once: true }),
    );
    const { session } = rig({ store: persistentStore() });
    expect(await caught(() => session.ensureBackend())).toBeInstanceOf(
      TransportError,
    );
    await session.ensureBackend();
    expect(count(wire, NONCE)).toBe(2);
    expect(count(wire, CREATE_KEY)).toBe(1);
    expect(backend.minted).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// A fresh key is never churned
// ---------------------------------------------------------------------------

describe('fresh keys', () => {
  for (const [label, expiresIn] of [
    ['1 h left (persistent: due for rotation at once)', 3_600_000],
    ['an expiry already in the past', -60_000],
  ] as const) {
    test(`a freshly minted key with ${label} is kept: 5 requests → 1 key request and one warn`, async () => {
      const backend = installBackend();
      backend.createdHook = (body) => ({
        ...body,
        expiresAt: new Date(Date.now() + expiresIn).toISOString(),
      });
      let t = Date.now();
      const { transport, warn } = rig({
        store: persistentStore(),
        now: () => t,
      });
      for (let i = 0; i < 5; i += 1) {
        await getMe(transport);
      }
      // Not later either: the key is not rotated automatically at all.
      t += 120_000;
      await getMe(transport);
      expect(count(backend.calls, CREATE_KEY)).toBe(1);
      expect(backend.meAuth).toEqual(
        Array(6).fill(`Bearer ${backend.minted[0]?.key}`),
      );
      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0]?.[0] ?? '';
      expect(message).toContain('clock skew or a short backend expiry');
      expect(message).not.toContain(backend.minted[0]?.key ?? '');
    });
  }

  test('a key minted less than 60 s ago is not rotated even if a clock sync makes it look due', async () => {
    const backend = installBackend();
    backend.createdHook = (body) => ({
      ...body,
      expiresAt: new Date(Date.now() + 8 * DAY_MS).toISOString(),
    });
    let ahead = 0;
    let t = Date.now();
    const { transport, clock, warn } = rig({
      store: persistentStore(),
      now: () => t,
      serverNow: () => Date.now() + ahead,
    });
    await getMe(transport);
    // The server turns out to be 2 days ahead: the key now has 6 days left, so it is due.
    ahead = 2 * DAY_MS;
    await clock.sync();
    for (let i = 0; i < 3; i += 1) {
      await getMe(transport);
    }
    expect(count(backend.calls, CREATE_KEY)).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    t += 61_000;
    await getMe(transport);
    expect(count(backend.calls, CREATE_KEY)).toBe(2);
  });

  test('expiry is judged by server time: a local clock 100 days ahead does not make a fresh key look expired', async () => {
    const backend = installBackend();
    const lag = 100 * DAY_MS;
    // The server's clock is 100 days behind this machine; its key lasts 90 server days.
    backend.createdHook = (body) => ({
      ...body,
      expiresAt: new Date(Date.now() - lag + 90 * DAY_MS).toISOString(),
    });
    const { transport, clock, warn } = rig({
      store: persistentStore(),
      serverNow: () => Date.now() - lag,
    });
    await clock.sync();
    for (let i = 0; i < 5; i += 1) {
      await getMe(transport);
    }
    expect(count(backend.calls, CREATE_KEY)).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    const serverDay = new Date(Date.now() - lag)
      .toISOString()
      .slice(0, 10)
      .replaceAll('-', '');
    expect(backend.walletBodies[0]?.name).toBe(`xo-sdk:test:${serverDay}`);
  });
});

// ---------------------------------------------------------------------------
// A 401 for an older credential is not a reason to log in again
// ---------------------------------------------------------------------------

describe('stale-credential 401s', () => {
  test('a K1 request that gets 401 after a rotation to K2 is retried with K2: no extra mint, K2 not revoked', async () => {
    const backend = installBackend();
    const { session, transport } = rig({ store: persistentStore() });
    const k1 = await session.ensureBackend();
    const entered = deferred();
    const release = deferred();
    server.use(
      http.get(
        ME_URL,
        async () => {
          entered.resolve();
          await release.promise;
          return invalidCredentials(ME_PATH);
        },
        { once: true },
      ),
    );
    const request = getMe(transport);
    await entered.promise;
    await session.rotateBackend();
    const k2 = backend.minted[1];
    expect(k2).toBeDefined();
    release.resolve();
    await expect(request).resolves.toMatchObject({ keyId: k2?.record.id });
    expect(backend.minted).toHaveLength(2);
    expect(count(backend.calls, NONCE)).toBe(2);
    expect(k2?.record.revokedAt).toBeNull();
    expect(backend.keyAuth).toEqual([`Bearer ${k1.key}`]);
    expect(backend.meAuth).toEqual([`Bearer ${k2?.key}`]);

    // No cooldown was started: a 401 on the current key recovers at once.
    if (k2 !== undefined) {
      k2.record.revokedAt = new Date().toISOString();
    }
    await getMe(transport);
    expect(count(backend.calls, NONCE)).toBe(3);
  });

  test('onUnauthorized with an older credential resolves true and does nothing else', async () => {
    installBackend();
    const orderbook = installOrderbook();
    const { session } = rig({ store: persistentStore() });
    await session.login();
    wire.length = 0;
    expect(
      await session.onUnauthorized('backend', {
        headers: { Authorization: 'Bearer xo_sk_data_an_older_key' },
      }),
    ).toBe(true);
    expect(
      await session.onUnauthorized('orderbook', {
        headers: { XO_API_KEY: 'an-older-api-key' },
      }),
    ).toBe(true);
    expect(wire).toEqual([]);
    expect(orderbook.keys.get(OWNER.toLowerCase())).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Keys the store failed to save
// ---------------------------------------------------------------------------

describe('unsaved keys', () => {
  function flakyStore(failures: number) {
    const inner = memoryStore();
    let left = failures;
    const store: CredentialStore = {
      persistent: true,
      get: (key) => inner.get(key),
      set: async (key, value) => {
        if (left > 0) {
          left -= 1;
          throw new XoError(
            'credential store unavailable: write failed (EACCES)',
            {
              code: 'credential_store_unavailable',
            },
          );
        }
        return inner.set(key, value);
      },
      delete: (key) => inner.delete(key),
    };
    return { store, inner };
  }

  test('a persistent store whose set fails: ensureBackend throws, then close() revokes the unsaved key', async () => {
    const backend = installBackend();
    const { store } = flakyStore(Number.POSITIVE_INFINITY);
    const { session } = rig({ store });
    const error = await caught(() => session.ensureBackend());
    expect((error as XoError).code).toBe('credential_store_unavailable');
    await session.close();
    const minted = backend.minted[0];
    expect(count(backend.calls, revokeCall(minted?.record.id ?? 0))).toBe(1);
    expect(minted?.record.revokedAt).not.toBeNull();
  });

  test('a later ensureBackend saves the key; close() then leaves it', async () => {
    const backend = installBackend();
    const { store, inner } = flakyStore(1);
    const { session } = rig({ store });
    await caught(() => session.ensureBackend());
    const kept = await session.ensureBackend();
    expect((await inner.get(EOA_STORE_KEY))?.backend).toEqual(kept);
    await session.close();
    expect(wire.filter((c) => c.startsWith('DELETE'))).toEqual([]);
    expect(backend.minted[0]?.record.revokedAt).toBeNull();
  });
});

describe('recovery backoff', () => {
  test('the cooldown doubles while recoveries do not hold, is capped at 1 h, and resets after 1 h without a 401', async () => {
    const backend = installBackend();
    server.use(http.get(ME_URL, () => invalidCredentials(ME_PATH)));
    let t = Date.now();
    const { transport } = rig({ store: persistentStore(), now: () => t });
    const nonces = () => count(backend.calls, NONCE);

    // The first request logs in (1) and recovers once (2).
    await caught(() => getMe(transport));
    expect(nonces()).toBe(2);
    let recoveredAt = t;
    let cooldown = 60_000;
    const HOUR = 3_600_000;
    for (let round = 0; round < 8; round += 1) {
      const doubled = Math.min(2 * cooldown, HOUR);
      // A 401 soon after the recovery: refused, and the next cooldown doubles (capped).
      t = recoveredAt + 1_000;
      await caught(() => getMe(transport));
      t = recoveredAt + doubled - 1_000;
      await caught(() => getMe(transport));
      expect(nonces()).toBe(2 + round);
      t = recoveredAt + doubled;
      await caught(() => getMe(transport));
      expect(nonces()).toBe(3 + round);
      recoveredAt = t;
      cooldown = doubled;
    }
    expect(cooldown).toBe(HOUR);

    // An hour without a 401: back to 60 s. A 401 2 min after the next recovery recovers.
    t = recoveredAt + HOUR + 1_000;
    await caught(() => getMe(transport));
    expect(nonces()).toBe(11);
    t += 125_000;
    await caught(() => getMe(transport));
    expect(nonces()).toBe(12);
  });
});

describe('login pauses, closing mid-login, up-front checks and partial records', () => {
  test('a 409 api_key_limit_reached pauses logins for 60 s', async () => {
    const backend = installBackend();
    backend.limitReached = true;
    let t = Date.now();
    const { session, warn } = rig({ store: persistentStore(), now: () => t });
    const first = await caught(() => session.ensureBackend());
    expect(first).toSatisfy(rejectedWith(409));
    expect((first as RequestRejectedError).code).toBe('api_key_limit_reached');
    for (const step of [10_000, 20_000, 29_000]) {
      t += step;
      expect(await caught(() => session.ensureBackend())).toBe(first);
    }
    expect(count(backend.calls, CREATE_KEY)).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('api_key_limit_reached');
    t += 2_000;
    backend.limitReached = false;
    await session.ensureBackend();
    expect(count(backend.calls, CREATE_KEY)).toBe(2);
  });

  test('close() before the mint step: the login stops with session_closed and mints nothing', async () => {
    installBackend();
    const gate = deferred();
    const inner = memoryStore();
    const store: CredentialStore = {
      persistent: true,
      get: async (key) => {
        await gate.promise;
        return inner.get(key);
      },
      set: (key, value) => inner.set(key, value),
      delete: (key) => inner.delete(key),
    };
    const { session } = rig({ store });
    const login = caught(() => session.ensureBackend());
    const closing = session.close();
    gate.resolve();
    await closing;
    expect(((await login) as XoError).code).toBe('session_closed');
    expect(wire).toEqual([]);
  });

  test('label, wallet and env.name are checked up front', () => {
    const transport = new Transport({ env, version: '0.0.0-test' });
    const clock = new Clock({ fetchServerTimeSec: async () => 0 });
    const base = {
      env,
      transport,
      clock,
      signer: BASE,
      readContract: unusedRead,
    };
    for (const bad of [
      { label: 'has space' },
      { label: 'x'.repeat(65) },
      { env: { ...env, name: 'Test Env' } },
    ]) {
      expect(() => new Session({ ...base, ...bad })).toThrow(UserInputError);
    }
    const asWallet = (value: unknown) => value as SessionOptions['wallet'];
    for (const wallet of [
      asWallet('smart'),
      asWallet('eoa'),
      asWallet(null),
      asWallet([]),
      asWallet({}),
      asWallet({ kernel: {} }),
      asWallet({ kernel: { index: 0 } }),
      asWallet({ type: 'kernel' }),
      asWallet({ type: 'EOA' }),
      asWallet({ type: 'eoa', index: 0 }),
      asWallet({ type: 'eoa', extra: true }),
      asWallet({ type: 'smart_wallet', other: 1 }),
      asWallet({ type: 'smart_wallet', index: '1' }),
      { type: 'smart_wallet', index: -1 } as const,
      { type: 'smart_wallet', index: 1.5 } as const,
      { type: 'smart_wallet', index: -1n } as const,
      { type: 'smart_wallet', index: 1n << 256n } as const,
    ]) {
      const error = (() => {
        try {
          new Session({ ...base, wallet });
        } catch (thrown) {
          return thrown;
        }
        throw new Error('expected the session to refuse the wallet');
      })();
      expect(error).toBeInstanceOf(UserInputError);
      expect((error as UserInputError).message).toBe(
        "wallet must be { type: 'eoa' } or { type: 'smart_wallet', index?: number | bigint } with a non-negative index",
      );
    }
    for (const wallet of [
      { type: 'eoa' },
      { type: 'smart_wallet' },
      { type: 'smart_wallet', index: undefined },
      { type: 'smart_wallet', index: 0 },
      { type: 'smart_wallet', index: (1n << 256n) - 1n },
    ] as const) {
      expect(() => new Session({ ...base, wallet })).not.toThrow();
    }
    expect(
      () =>
        new Session({
          ...base,
          label: 'bot-1.a_b',
          wallet: { type: 'smart_wallet', index: 2n },
        }),
    ).not.toThrow();
    // Without a signer the store is never used, so the env name is not checked.
    expect(
      () =>
        new Session({
          ...base,
          signer: undefined,
          env: { ...env, name: 'Test Env' },
          credentials: { orderbook: newOrderbookCredential() },
        }),
    ).not.toThrow();
  });

  test('a stored record with one malformed part keeps the other part', async () => {
    const backend = installBackend();
    const orderbook = installOrderbook();
    const seeded = seedBackendKey(backend);
    const inner = memoryStore();
    const writes: unknown[] = [];
    const store: CredentialStore = {
      persistent: true,
      get: async () =>
        ({
          backend: credentialOf(seeded),
          orderbook: { apiKey: 7, secret: null },
        }) as never,
      set: async (key, value) => {
        writes.push(value);
        return inner.set(key, value);
      },
      delete: (key) => inner.delete(key),
    };
    const { session } = rig({ store });
    expect((await session.ensureBackend()).key).toBe(seeded.key);
    expect(wire).toEqual([]);
    const ob = await session.ensureOrderbook();
    expect(wire).toEqual(['sync', DERIVE, CREATE]);
    expect(writes).toEqual([{ backend: credentialOf(seeded), orderbook: ob }]);
    expect(orderbook.keys.get(OWNER.toLowerCase())).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Post-mint backoff, the clock sync and the save retry
// ---------------------------------------------------------------------------

describe('post-mint backoff, the clock sync and the save retry', () => {
  test('consecutive post-mint failures back off (60 s, 2, 4, 8, 16 min, capped at 1 h); a successful mint resets it', async () => {
    const backend = installBackend();
    const fail = () => HttpResponse.json({ statusCode: 504 }, { status: 504 });
    backend.walletHook = fail;
    const start = Date.now();
    let t = start;
    const { session, warn } = rig({ store: persistentStore(), now: () => t });
    // A call every 30 s for 30 minutes.
    for (let sec = 0; sec < 30 * 60; sec += 30) {
      t = start + sec * 1000;
      await caught(() => session.ensureBackend());
    }
    // Attempts at 0 s, 60 s, 180 s, 420 s and 900 s; the next is due at 1860 s.
    expect(count(backend.calls, CREATE_KEY)).toBe(5);
    const pauses = () =>
      warn.mock.calls.map((call) => /for (\d+) s/.exec(call[0])?.[1]);
    expect(pauses()).toEqual(['60', '120', '240', '480', '960']);

    // The pause has run out: a successful mint resets the backoff.
    t = start + 1_860_000;
    backend.walletHook = undefined;
    await session.ensureBackend();
    expect(count(backend.calls, CREATE_KEY)).toBe(6);
    backend.walletHook = fail;
    await caught(() => session.rotateBackend());
    t += 30_000;
    await caught(() => session.rotateBackend());
    expect(count(backend.calls, CREATE_KEY)).toBe(7);
    t += 31_000;
    await caught(() => session.rotateBackend());
    expect(count(backend.calls, CREATE_KEY)).toBe(8);
    expect(pauses().slice(5)).toEqual(['60', '120']);
  });

  test('the login pause is capped at 1 h', async () => {
    const backend = installBackend();
    backend.walletHook = () =>
      HttpResponse.json({ statusCode: 504 }, { status: 504 });
    let t = Date.now();
    const { session, warn } = rig({ store: persistentStore(), now: () => t });
    const expected = [60, 120, 240, 480, 960, 1920, 3600, 3600, 3600];
    for (const pause of expected) {
      await caught(() => session.ensureBackend());
      t += pause * 1000 - 1000;
      await caught(() => session.ensureBackend());
      t += 1000;
    }
    expect(count(backend.calls, CREATE_KEY)).toBe(expected.length);
    expect(
      warn.mock.calls.map((call) => Number(/for (\d+) s/.exec(call[0])?.[1])),
    ).toEqual(expected);
  });

  test('a 429 keeps the plain 60 s pause, however often it repeats', async () => {
    const backend = installBackend();
    backend.walletHook = () =>
      exceptionResponse('/api/auth/api-keys', 429, {
        message: 'Too Many Requests',
      });
    const start = Date.now();
    let t = start;
    const { session } = rig({ store: persistentStore(), now: () => t });
    for (let sec = 0; sec < 5 * 61; sec += 61) {
      t = start + sec * 1000;
      await caught(() => session.ensureBackend());
    }
    expect(count(backend.calls, CREATE_KEY)).toBe(5);
  });

  test('a stored key that only looks expired because this clock is 2 days ahead is kept, after one sync', async () => {
    const backend = installBackend();
    const seeded = seedBackendKey(backend, {
      expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
    });
    // A memory store: 1 day left is not due for rotation (that is 2 h).
    const store = memoryStore();
    await store.set(EOA_STORE_KEY, { backend: credentialOf(seeded) });
    const { session, transport } = rig({
      store,
      clockNow: () => Date.now() + 2 * DAY_MS,
    });
    await getMe(transport);
    await getMe(transport);
    expect(wire).toEqual(['sync', ME, ME]);
    expect(backend.minted).toHaveLength(0);
    expect(backend.meAuth).toEqual(Array(2).fill(`Bearer ${seeded.key}`));
    expect(session.toJSON()).toMatchObject({
      credentials: { backend: 'session' },
    });
  });

  test('with /time failing, the local clock decides: the key is dropped without a revoke and a fresh one minted', async () => {
    const backend = installBackend();
    const seeded = seedBackendKey(backend, {
      expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
    });
    const store = memoryStore();
    await store.set(EOA_STORE_KEY, { backend: credentialOf(seeded) });
    const { transport } = rig({
      store,
      clockNow: () => Date.now() + 2 * DAY_MS,
      syncFails: () => true,
    });
    await getMe(transport);
    expect(wire).toEqual(['sync', NONCE, CREATE_KEY, ME]);
    expect(backend.minted).toHaveLength(1);
    expect(seeded.record.revokedAt).toBeNull();
  });

  test('a valid stored key is used without a sync; the first mint is preceded by one', async () => {
    const backend = installBackend();
    const seeded = seedBackendKey(backend);
    const store = memoryStore();
    await store.set(EOA_STORE_KEY, { backend: credentialOf(seeded) });
    const { transport, session } = rig({ store });
    await getMe(transport);
    expect(wire).toEqual([ME]);
    await session.rotateBackend();
    await session.rotateBackend();
    expect(wire.slice(1)).toEqual([
      'sync',
      NONCE,
      CREATE_KEY,
      revokeCall(seeded.record.id),
      NONCE,
      CREATE_KEY,
      revokeCall(backend.minted[0]?.record.id ?? 0),
    ]);
  });

  test('close() waits for a retried save: ensureBackend then throws session_closed and the saved key is not revoked', async () => {
    const backend = installBackend();
    const inner = memoryStore();
    let sets = 0;
    const entered = deferred();
    const gate = deferred();
    const store: CredentialStore = {
      persistent: true,
      get: (key) => inner.get(key),
      set: async (key, value) => {
        sets += 1;
        if (sets === 1) {
          throw new XoError(
            'credential store unavailable: write failed (EIO)',
            {
              code: 'credential_store_unavailable',
            },
          );
        }
        entered.resolve();
        await gate.promise;
        return inner.set(key, value);
      },
      delete: (key) => inner.delete(key),
    };
    const { session } = rig({ store });
    await caught(() => session.ensureBackend());
    const second = caught(() => session.ensureBackend());
    await entered.promise;
    const closing = session.close();
    gate.resolve();
    await closing;
    expect(((await second) as XoError).code).toBe('session_closed');
    expect(wire.filter((c) => c.startsWith('DELETE'))).toEqual([]);
    expect(backend.minted[0]?.record.revokedAt).toBeNull();
    expect((await inner.get(EOA_STORE_KEY))?.backend?.key).toBe(
      backend.minted[0]?.key,
    );
  });

  test('the save retry runs at most once per 60 s', async () => {
    installBackend();
    let writes = 0;
    const inner = memoryStore();
    const store: CredentialStore = {
      persistent: true,
      get: (key) => inner.get(key),
      set: async () => {
        writes += 1;
        throw new XoError('credential store unavailable: write failed (EIO)', {
          code: 'credential_store_unavailable',
        });
      },
      delete: (key) => inner.delete(key),
    };
    let t = Date.now();
    const { session } = rig({ store, now: () => t });
    await caught(() => session.ensureBackend());
    expect(writes).toBe(1);
    await session.ensureBackend();
    expect(writes).toBe(2);
    await session.ensureBackend();
    t += 30_000;
    await session.ensureBackend();
    expect(writes).toBe(2);
    t += 31_000;
    await session.ensureBackend();
    expect(writes).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Lost key answers: 1-day keys until a mint succeeds, and a pause that survives a restart
// ---------------------------------------------------------------------------

describe('lost key answers with a persistent store', () => {
  const HOUR = 3_600_000;
  const lostAnswer = () =>
    HttpResponse.json({ statusCode: 504 }, { status: 504 });
  const days = (backend: Backend) =>
    backend.walletBodies.map((body) => body.expiresInDays);

  test('after a lost answer the next mint asks for a 1-day key; it is kept, not pinned, and rotated in its 2-hour window to a 90-day key', async () => {
    const backend = installBackend();
    backend.walletHook = lostAnswer;
    let t = Date.now();
    let ahead = 0;
    const { session, transport, clock, warn } = rig({
      store: persistentStore(),
      now: () => t,
      serverNow: () => Date.now() + ahead,
    });
    const lost = await caught(() => session.ensureBackend());
    expect(lost).toBeInstanceOf(MintedKeyError);
    expect((lost as MintedKeyError).mayHaveMinted).toBe(true);

    t += 61_000;
    backend.walletHook = undefined;
    const short = await session.ensureBackend();
    expect(days(backend)).toEqual([90, 1]);
    for (let i = 0; i < 3; i += 1) {
      await getMe(transport);
    }
    t += 61_000;
    await getMe(transport);
    expect(count(backend.calls, CREATE_KEY)).toBe(2);
    // The pause's warn only: a 1-day key is not "already due" (no pinning warn).
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('1 day');

    // 22.5 h later by the server's clock, 1.5 h are left: the key is rotated, and the mint
    // after a successful one asks for the normal lifetime again.
    ahead = 22.5 * HOUR;
    await clock.sync();
    await getMe(transport);
    expect(days(backend)).toEqual([90, 1, 90]);
    expect(count(backend.calls, revokeCall(short.id))).toBe(1);
    expect(backend.meAuth.at(-1)).toBe(`Bearer ${backend.minted[1]?.key}`);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('a restarted session reads the saved pause, waits out what is left of it, then mints 1-day keys until one arrives', async () => {
    await withTmpDir(async (dir) => {
      const backend = installBackend();
      backend.walletHook = lostAnswer;
      const start = Date.now();
      let t = start;
      const first = rig({ store: fileStore(dir), now: () => t });
      expect(await caught(() => first.session.ensureBackend())).toBeInstanceOf(
        MintedKeyError,
      );
      expect((await fileStore(dir).get(EOA_STORE_KEY))?.mintPause).toEqual({
        atMs: start,
        pauseMs: 60_000,
      });

      // The process dies without close(). A new one starts 20 s later.
      t = start + 20_000;
      const restarted = rig({ store: fileStore(dir), now: () => t });
      const paused = await caught(() => restarted.session.ensureBackend());
      expect(paused).toBeInstanceOf(MintedKeyError);
      expect((paused as MintedKeyError).mayHaveMinted).toBe(true);
      expect(await caught(() => getMe(restarted.transport))).toBe(paused);
      t = start + 59_000;
      expect(await caught(() => restarted.session.ensureBackend())).toBe(
        paused,
      );
      expect(count(backend.calls, NONCE)).toBe(1);
      expect(count(backend.calls, CREATE_KEY)).toBe(1);
      expect(restarted.warn).toHaveBeenCalledTimes(1);
      expect(restarted.warn.mock.calls[0]?.[0]).toContain('40 s');
      expect(dump(paused)).not.toContain('xo_sk_');

      // The pause is over: a 1-day key is asked for. Its answer is lost too, so the pause
      // doubles (from the saved one) and the next mint asks for 1 day again.
      t = start + 61_000;
      expect(
        await caught(() => restarted.session.ensureBackend()),
      ).toBeInstanceOf(MintedKeyError);
      expect((await fileStore(dir).get(EOA_STORE_KEY))?.mintPause).toEqual({
        atMs: start + 61_000,
        pauseMs: 120_000,
      });
      t = start + 61_000 + 119_000;
      await caught(() => restarted.session.ensureBackend());
      expect(count(backend.calls, CREATE_KEY)).toBe(2);

      t = start + 61_000 + 121_000;
      backend.walletHook = undefined;
      const fresh = await restarted.session.ensureBackend();
      expect(days(backend)).toEqual([90, 1, 1]);
      const saved = await fileStore(dir).get(EOA_STORE_KEY);
      expect(saved?.backend).toEqual(fresh);
      expect(saved).not.toHaveProperty('mintPause');
    });
  });

  test('a restart after the pause ran out mints a 1-day key at once; a success clears the note and the next mint asks for 90 days', async () => {
    const backend = installBackend();
    backend.walletHook = lostAnswer;
    const store = persistentStore();
    const start = Date.now();
    let t = start;
    await caught(() => rig({ store, now: () => t }).session.ensureBackend());
    expect((await store.get(EOA_STORE_KEY))?.mintPause).toBeDefined();

    t = start + 10 * 60_000;
    backend.walletHook = undefined;
    const { session, warn } = rig({ store, now: () => t });
    await session.ensureBackend();
    expect(days(backend)).toEqual([90, 1]);
    expect(await store.get(EOA_STORE_KEY)).not.toHaveProperty('mintPause');
    expect(warn).not.toHaveBeenCalled();

    t += 61_000;
    await session.rotateBackend();
    expect(days(backend)).toEqual([90, 1, 90]);
  });

  test('a 201 that cannot be used counts as a lost answer too: the next mint asks for 1 day', async () => {
    const backend = installBackend();
    backend.createdHook = (body) => ({ ...body, key: 'not a key' });
    let t = Date.now();
    const { session } = rig({ store: persistentStore(), now: () => t });
    const broken = await caught(() => session.ensureBackend());
    expect(broken).toBeInstanceOf(MintedKeyError);
    expect((broken as MintedKeyError).mayHaveMinted).toBe(false);
    t += 61_000;
    backend.createdHook = undefined;
    await session.ensureBackend();
    expect(days(backend)).toEqual([90, 1]);
  });

  test('a 429 or a 409 is not a lost answer: no note is saved and the next mint asks for 90 days', async () => {
    const backend = installBackend();
    backend.walletHook = () =>
      exceptionResponse('/api/auth/api-keys', 429, {
        message: 'Too Many Requests',
      });
    const store = persistentStore();
    let t = Date.now();
    const { session } = rig({ store, now: () => t });
    expect(await caught(() => session.ensureBackend())).toBeInstanceOf(
      RateLimitError,
    );
    expect(await store.get(EOA_STORE_KEY)).toBeUndefined();
    t += 61_000;
    backend.walletHook = undefined;
    backend.limitReached = true;
    await caught(() => session.ensureBackend());
    expect(await store.get(EOA_STORE_KEY)).toBeUndefined();
    t += 61_000;
    backend.limitReached = false;
    await session.ensureBackend();
    expect(days(backend)).toEqual([90, 90, 90]);
  });

  test.each([404, 405])(
    'a %i from the key route means it does not exist, so nothing was minted: key_route_not_found, no pause, no note, and the next mint asks for 90 days',
    async (status) => {
      const backend = installBackend();
      backend.walletHook = () =>
        exceptionResponse('/api/auth/api-keys', status, {
          error: 'Not Found',
          message: 'Cannot POST /api/auth/api-keys',
        });
      const store = persistentStore();
      const t = Date.now();
      const { session, warn } = rig({ store, now: () => t });
      const first = await caught(() => session.ensureBackend());
      expect(first).toBeInstanceOf(XoError);
      expect(first).not.toBeInstanceOf(MintedKeyError);
      expect((first as XoError).code).toBe('key_route_not_found');
      expect((first as XoError).status).toBe(status);
      // No pause note in the store.
      expect(await store.get(EOA_STORE_KEY)).toBeUndefined();
      // No pause: the next call tries again at once, on the same clock.
      const second = await caught(() => session.ensureBackend());
      expect(second).not.toBe(first);
      expect((second as XoError).code).toBe('key_route_not_found');
      expect(count(backend.calls, CREATE_KEY)).toBe(2);
      expect(warn).not.toHaveBeenCalled();
      // No lifetime downgrade: the key minted once the route answers lasts 90 days.
      backend.walletHook = undefined;
      const fresh = await session.ensureBackend();
      expect(days(backend)).toEqual([90, 90, 90]);
      const saved = await store.get(EOA_STORE_KEY);
      expect(saved?.backend).toEqual(fresh);
      expect(saved).not.toHaveProperty('mintPause');
    },
  );

  test('a store that cannot save the note: one warn, the pause still holds in this process, and nothing is minted early', async () => {
    const backend = installBackend();
    backend.walletHook = lostAnswer;
    const inner = memoryStore();
    let refused = 0;
    const store: CredentialStore = {
      persistent: true,
      get: (key) => inner.get(key),
      set: async (key, value) => {
        if (value.mintPause !== undefined) {
          refused += 1;
          throw new XoError(
            'credential store unavailable: write failed (EACCES)',
            { code: 'credential_store_unavailable' },
          );
        }
        return inner.set(key, value);
      },
      delete: (key) => inner.delete(key),
    };
    let t = Date.now();
    const { session, warn } = rig({ store, now: () => t });
    const first = await caught(() => session.ensureBackend());
    expect(first).toBeInstanceOf(MintedKeyError);
    t += 30_000;
    expect(await caught(() => session.ensureBackend())).toBe(first);
    t += 31_000;
    const second = await caught(() => session.ensureBackend());
    expect(second).toBeInstanceOf(MintedKeyError);
    t += 119_000;
    expect(await caught(() => session.ensureBackend())).toBe(second);
    expect(count(backend.calls, CREATE_KEY)).toBe(2);
    expect(refused).toBe(2);
    const notes = warn.mock.calls
      .map((call) => call[0])
      .filter((message) => message.includes('could not save the login pause'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('credential_store_unavailable');

    t += 2_000;
    backend.walletHook = undefined;
    const fresh = await session.ensureBackend();
    expect(days(backend)).toEqual([90, 1, 1]);
    expect((await inner.get(EOA_STORE_KEY))?.backend).toEqual(fresh);
  });

  test('a record saved before the note existed loads as before: its key is used and nothing is requested', async () => {
    const backend = installBackend();
    const seeded = seedBackendKey(backend);
    await withTmpDir(async (dir) => {
      await writeFile(
        join(dir, `${EOA_STORE_KEY.replace(':', '-')}.json`),
        JSON.stringify({ backend: credentialOf(seeded) }),
      );
      const { session, warn } = rig({ store: fileStore(dir) });
      expect(await session.ensureBackend()).toEqual(credentialOf(seeded));
      expect(wire).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  test('a malformed note is ignored and keeps the stored key', async () => {
    const backend = installBackend();
    const seeded = seedBackendKey(backend);
    const inner = memoryStore();
    await inner.set(EOA_STORE_KEY, { backend: credentialOf(seeded) });
    const store: CredentialStore = {
      persistent: true,
      get: async (key) =>
        ({
          ...(await inner.get(key)),
          mintPause: { atMs: 'soon', pauseMs: -1 },
        }) as never,
      set: (key, value) => inner.set(key, value),
      delete: (key) => inner.delete(key),
    };
    const { session } = rig({ store });
    expect(await session.ensureBackend()).toEqual(credentialOf(seeded));
    expect(wire).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

describe('close', () => {
  test('memory store → close() revokes the session-minted key; bring-your-own key is never revoked', async () => {
    const backend = installBackend();
    const { session } = rig();
    const minted = await session.ensureBackend();
    await session.close();
    expect(count(backend.calls, revokeCall(minted.id))).toBe(1);
    expect(backend.keyAuth).toEqual([`Bearer ${minted.key}`]);
    expect(backend.minted[0]?.record.revokedAt).not.toBeNull();

    const byo = seedBackendKey(backend);
    wire.length = 0;
    const own = rig({ credentials: { backend: { apiKey: byo.key } } });
    await getMe(own.transport);
    await own.session.close();
    expect(wire).toEqual([ME]);
    expect(byo.record.revokedAt).toBeNull();
  });

  test('close() leaves a key loaded from the store, and any key in a persistent store', async () => {
    const backend = installBackend();
    const shared = memoryStore();
    const minter = rig({ store: shared });
    await minter.session.ensureBackend();
    const loader = rig({ store: shared });
    await loader.session.ensureBackend();
    await loader.session.close();
    expect(wire.filter((c) => c.startsWith('DELETE'))).toEqual([]);
    await minter.session.close();
    expect(wire.filter((c) => c.startsWith('DELETE'))).toHaveLength(1);

    wire.length = 0;
    const kept = rig({ store: persistentStore() });
    await kept.session.ensureBackend();
    await kept.session.close();
    expect(wire.filter((c) => c.startsWith('DELETE'))).toEqual([]);
    expect(backend.minted[1]?.record.revokedAt).toBeNull();
  });

  test('close() is idempotent; afterwards headers and ensure* throw session_closed', async () => {
    const backend = installBackend();
    installOrderbook();
    const { session, transport } = rig();
    await session.login();
    await Promise.all([session.close(), session.close()]);
    await session.close();
    expect(backend.calls.filter((c) => c.startsWith('DELETE'))).toHaveLength(1);

    for (const run of [
      () => session.headers('backend', { method: 'GET', path: '/', body: '' }),
      () =>
        session.headers('orderbook', { method: 'GET', path: '/', body: '' }),
      () => session.ensureBackend(),
      () => session.ensureOrderbook(),
      () => session.login(),
      () => session.rotateBackend(),
      () => getMe(transport),
    ]) {
      const error = await caught(run);
      expect(error).toBeInstanceOf(XoError);
      expect((error as XoError).code).toBe('session_closed');
    }
    expect(await session.onUnauthorized('backend')).toBe(false);
    expect(await session.onUnauthorized('orderbook')).toBe(false);
    expect(session.hasBackendCredential()).toBe(false);
  });

  test('close() during a login waits for it and revokes the key it minted', async () => {
    const backend = installBackend();
    const gate = deferred();
    const signer = spiedSigner();
    signer.signMessage.mockImplementationOnce(async (m) => {
      await gate.promise;
      return BASE.signMessage(m);
    });
    const { session } = rig({ signer });
    const login = session.ensureBackend();
    await vi.waitFor(() => expect(signer.signMessage).toHaveBeenCalled());
    const closing = session.close();
    gate.resolve();
    await closing;
    await login.catch(() => undefined);
    expect(backend.minted).toHaveLength(1);
    expect(backend.minted[0]?.record.revokedAt).not.toBeNull();
  });

  test('a failed revoke on close() is swallowed with a warn', async () => {
    installBackend();
    server.use(
      http.delete(`${API_KEYS_URL}/:id`, () =>
        exceptionResponse('/api/auth/api-keys/1', 403, {
          error: 'forbidden',
          message: 'no',
        }),
      ),
    );
    const { session, warn } = rig();
    const minted = await session.ensureBackend();
    warn.mockClear();
    await expect(session.close()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).not.toContain(minted.key);
  });
});

describe('signOut', () => {
  const DELETE_ORDERBOOK_KEY = `DELETE ${CREATE_PATH}`;

  test('revokes the API key and deletes the orderbook key, each with itself, and deletes the record', async () => {
    const backend = installBackend();
    const orderbook = installOrderbook();
    const store = persistentStore();
    const { session } = rig({ store });
    await session.login();
    const minted = backend.minted[0];
    const l2 = orderbook.keys.get(OWNER.toLowerCase())?.[0];
    await session.signOut();
    expect(count(backend.calls, revokeCall(minted?.record.id as number))).toBe(
      1,
    );
    expect(backend.keyAuth.at(-1)).toBe(`Bearer ${minted?.key}`);
    expect(minted?.record.revokedAt).not.toBeNull();
    expect(orderbook.deleted).toEqual([l2?.apiKey]);
    expect(count(wire, DELETE_ORDERBOOK_KEY)).toBe(1);
    expect(await store.get(EOA_STORE_KEY)).toBeUndefined();
    expect(session.toJSON().closed).toBe(true);
  });

  test('also signs out the keys of the record that the session never loaded', async () => {
    const backend = installBackend();
    const orderbook = installOrderbook();
    const store = persistentStore();
    const stored = seedBackendKey(backend);
    const storedL2 = seedKey(orderbook, OWNER);
    await store.set(EOA_STORE_KEY, {
      backend: credentialOf(stored),
      orderbook: storedL2,
    });
    const given = seedBackendKey(backend);
    const { session } = rig({
      store,
      credentials: { backend: { apiKey: given.key } },
    });
    await session.signOut();
    expect(stored.record.revokedAt).not.toBeNull();
    expect(given.record.revokedAt).not.toBeNull();
    expect(orderbook.deleted).toEqual([storedL2.apiKey]);
    expect(await store.get(EOA_STORE_KEY)).toBeUndefined();
  });

  test('waits for a login in flight, and signs out the key it mints', async () => {
    const backend = installBackend();
    installOrderbook();
    const gate = deferred();
    const signer = spiedSigner();
    signer.signMessage.mockImplementationOnce(async (m) => {
      await gate.promise;
      return BASE.signMessage(m);
    });
    const { session } = rig({ signer });
    const login = session.ensureBackend();
    await vi.waitFor(() => expect(signer.signMessage).toHaveBeenCalled());
    const signingOut = session.signOut();
    gate.resolve();
    await signingOut;
    await login.catch(() => undefined);
    expect(backend.minted).toHaveLength(1);
    expect(backend.minted[0]?.record.revokedAt).not.toBeNull();
  });

  test('shared by every call; close() afterwards resolves and revokes nothing more', async () => {
    const backend = installBackend();
    installOrderbook();
    const { session } = rig();
    await session.login();
    const first = session.signOut();
    expect(session.signOut()).toBe(first);
    await first;
    await session.close();
    expect(backend.calls.filter((c) => c.startsWith('DELETE'))).toHaveLength(1);
  });

  test('after close() it is refused with session_closed, and nothing is revoked', async () => {
    const backend = installBackend();
    installOrderbook();
    const store = persistentStore();
    const { session } = rig({ store });
    await session.login();
    await session.close();
    const error = await caught(() => session.signOut());
    expect((error as XoError).code).toBe('session_closed');
    expect(backend.calls.filter((c) => c.startsWith('DELETE'))).toEqual([]);
    expect((await store.get(EOA_STORE_KEY))?.backend).toBeDefined();
  });

  test('without a signer it is refused with AuthRequiredError, and the session stays open', async () => {
    const backend = installBackend();
    const given = seedBackendKey(backend);
    const { session } = rig({
      signer: null,
      credentials: { backend: { apiKey: given.key } },
    });
    const error = await caught(() => session.signOut());
    expect(error).toBeInstanceOf(AuthRequiredError);
    expect(session.toJSON().closed).toBe(false);
  });

  test('a close() while it runs waits for it and never rejects, even when the sign-out fails', async () => {
    installBackend();
    const orderbook = installOrderbook();
    const { session } = rig();
    await session.login();
    orderbook.deleteOverride = () => gatewayError(403, 'forbidden');
    const signingOut = session.signOut();
    await expect(session.close()).resolves.toBeUndefined();
    const error = await caught(() => signingOut);
    expect(error).toSatisfy(rejectedWith(403));
  });
});

// ---------------------------------------------------------------------------
// Modes and bring-your-own credentials
// ---------------------------------------------------------------------------

describe('modes', () => {
  test('data-only: credentials.backend only, no signer → backend headers work; ensureOrderbook throws AuthRequiredError', async () => {
    const backend = installBackend();
    const byo = seedBackendKey(backend);
    const { session, transport } = rig({
      signer: null,
      credentials: { backend: { apiKey: byo.key } },
    });
    expect(session.hasSigner()).toBe(false);
    expect(session.hasBackendCredential()).toBe(true);
    expect(
      await session.headers('backend', {
        method: 'GET',
        path: ME_PATH,
        body: '',
      }),
    ).toEqual({ Authorization: `Bearer ${byo.key}` });
    await expect(getMe(transport)).resolves.toEqual({ keyId: byo.record.id });
    expect(await caught(() => session.ensureOrderbook())).toBeInstanceOf(
      AuthRequiredError,
    );
    expect(await caught(() => getOrders(transport))).toBeInstanceOf(
      AuthRequiredError,
    );
    expect(await caught(() => session.identity())).toBeInstanceOf(
      AuthRequiredError,
    );
    expect(wire).toEqual([ME]);
  });

  test('no signer, no credentials → headers("backend") throws AuthRequiredError naming the signer and credentials options', async () => {
    installBackend();
    const { session, transport } = rig({ signer: null });
    const error = await caught(() =>
      session.headers('backend', { method: 'GET', path: ME_PATH, body: '' }),
    );
    expect(error).toBeInstanceOf(AuthRequiredError);
    expect((error as Error).message).toContain('signer');
    expect((error as Error).message).toContain('credentials');
    expect(await caught(() => getMe(transport))).toBeInstanceOf(
      AuthRequiredError,
    );
    expect(session.hasBackendCredential()).toBe(false);
    expect(await session.onUnauthorized('backend')).toBe(false);
    expect(wire).toEqual([]);
  });

  test('bring-your-own orderbook credentials sign L2 requests without a signer', async () => {
    const orderbook = installOrderbook();
    const byo = seedKey(orderbook, OWNER);
    const { transport } = rig({
      signer: null,
      credentials: { orderbook: byo },
    });
    await expect(getOrders(transport)).resolves.toEqual([]);
    expect(wire).toEqual([ORDERS]);
  });

  test('bring-your-own credentials are checked up front and never echoed', () => {
    const transport = new Transport({ env, version: '0.0.0-test' });
    const clock = new Clock({ fetchServerTimeSec: async () => 0 });
    const good = {
      apiKey: '6f1c2a4e-1111-4222-8333-944445555666',
      secret: 'c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlY3I=',
      passphrase: '0123456789abcdef0123456789abcdef',
    };
    const bad: Array<[SessionOptions['credentials'], string]> = [
      [{ backend: { apiKey: 'sk_live_LEAKME' } }, 'sk_live_LEAKME'],
      [{ backend: { apiKey: 'xo_sk_data_LEAK ME' } }, 'xo_sk_data_LEAK ME'],
      [{ backend: { apiKey: 4242424242 as unknown as string } }, '4242424242'],
      [{ orderbook: { ...good, passphrase: 'LEAK ME' } }, 'LEAK ME'],
      [{ orderbook: { ...good, apiKey: 'LEAK\nME' } }, 'LEAK\nME'],
      [{ orderbook: { ...good, secret: 'LEAK*ME' } }, 'LEAK*ME'],
      [
        { orderbook: { ...good, secret: ['LEAKSECRET'] as unknown as string } },
        'LEAKSECRET',
      ],
      [{ orderbook: 'LEAKOBJECT' as unknown as typeof good }, 'LEAKOBJECT'],
    ];
    for (const [credentials, secret] of bad) {
      let error: unknown;
      try {
        new Session({
          env,
          transport,
          clock,
          credentials,
          readContract: unusedRead,
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(UserInputError);
      expect(dump(error)).not.toContain(secret);
    }
    expect(
      () =>
        new Session({
          env,
          transport,
          clock,
          credentials: { orderbook: good },
          readContract: unusedRead,
        }),
    ).not.toThrow();
  });

  test('identity() is memoized and single-flight', async () => {
    const readContract = vi.fn(async () => paddedAccount);
    const { session } = rig({
      wallet: { type: 'smart_wallet', index: 0 },
      readContract,
    });
    const [a, b] = await Promise.all([session.identity(), session.identity()]);
    const c = await session.identity();
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(readContract).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Warnings and redaction
// ---------------------------------------------------------------------------

describe('warnings and redaction', () => {
  test('one warn per session when a short-lived key is minted; it recommends fileStore and holds no secret', async () => {
    const backend = installBackend();
    const { session, warn } = rig();
    const first = await session.ensureBackend();
    await session.rotateBackend();
    expect(backend.minted).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.[0] ?? '';
    expect(message).toContain('fileStore');
    expect(message).toContain('@xomarket/client/node');
    for (const minted of backend.minted) {
      expect(message).not.toContain(minted.key);
      expect(message).not.toContain(minted.record.prefix);
    }
    expect(message).not.toContain(first.key);

    const persistent = rig({ store: persistentStore() });
    await persistent.session.ensureBackend();
    expect(persistent.warn).not.toHaveBeenCalled();
  });

  test('toJSON and inspect leak nothing', async () => {
    const backend = installBackend();
    const orderbook = installOrderbook();
    const { session } = rig();
    const fresh = rig({ store: persistentStore() });
    // Before the identity is resolved, the type comes from the wallet option.
    expect(
      rig({ wallet: { type: 'smart_wallet' } }).session.toJSON(),
    ).toMatchObject({ type: 'smart_wallet', signer: true });
    expect(fresh.session.toJSON()).toEqual({
      type: 'eoa',
      signer: true,
      credentials: { backend: 'none', orderbook: 'none' },
      closed: false,
    });
    await session.login();
    const ob = orderbook.keys.get(OWNER.toLowerCase())?.[0];
    const key = backend.minted[0]?.key ?? '';
    expect(session.toJSON()).toEqual({
      type: 'eoa',
      address: OWNER,
      signer: true,
      credentials: { backend: 'session', orderbook: 'session' },
      closed: false,
    });
    const text = dump(session);
    for (const secret of [key, ob?.apiKey, ob?.secret, ob?.passphrase]) {
      expect(secret).toBeTruthy();
      expect(text).not.toContain(secret);
    }
    expect(Object.keys(session)).toEqual([]);

    const byo = seedBackendKey(backend);
    const own = rig({
      signer: null,
      credentials: {
        backend: { apiKey: byo.key },
        orderbook: newOrderbookCredential(),
      },
    });
    expect(own.session.toJSON()).toEqual({
      signer: false,
      credentials: { backend: 'provided', orderbook: 'provided' },
      closed: false,
    });
    expect(dump(own.session)).not.toContain(byo.key);
  });
});

function newOrderbookCredential() {
  return {
    apiKey: '6f1c2a4e-1111-4222-8333-944445555666',
    secret: 'c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlY3I=',
    passphrase: '0123456789abcdef0123456789abcdef',
  };
}

// ---------------------------------------------------------------------------
// installShutdownHooks
// ---------------------------------------------------------------------------

describe('installShutdownHooks', () => {
  type Listener = (...args: unknown[]) => void;

  /** Stubs process.once, removeListener and kill. Never sends a real signal. */
  function fakeProcess() {
    const listeners = new Map<string, Listener>();
    const realOnce = process.once.bind(process);
    const once = vi.spyOn(process, 'once').mockImplementation(((
      event: string,
      listener: Listener,
    ) => {
      if (event === 'SIGINT' || event === 'SIGTERM') {
        listeners.set(event, listener);
        return process;
      }
      return realOnce(event, listener);
    }) as typeof process.once);
    const removeListener = vi
      .spyOn(process, 'removeListener')
      .mockImplementation(((event: string, listener: Listener) => {
        if (listeners.get(event) === listener) {
          listeners.delete(event);
        }
        return process;
      }) as typeof process.removeListener);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    return { listeners, once, removeListener, kill };
  }

  test('a signal uninstalls both handlers, awaits close(), then re-sends the signal', async () => {
    const fake = fakeProcess();
    const closed = deferred();
    const close = vi.fn(() => closed.promise);
    installShutdownHooks(close);
    expect([...fake.listeners.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);

    fake.listeners.get('SIGTERM')?.('SIGTERM');
    expect(fake.listeners.size).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(fake.kill).not.toHaveBeenCalled();
    closed.resolve();
    await vi.waitFor(() =>
      expect(fake.kill).toHaveBeenCalledWith(process.pid, 'SIGTERM'),
    );
    expect(fake.kill).toHaveBeenCalledTimes(1);
  });

  test('close() is capped at 5 s', async () => {
    vi.useFakeTimers();
    const fake = fakeProcess();
    const close = vi.fn(() => new Promise<void>(() => undefined));
    installShutdownHooks(close);
    fake.listeners.get('SIGINT')?.('SIGINT');
    await vi.advanceTimersByTimeAsync(4999);
    expect(fake.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.kill).toHaveBeenCalledWith(process.pid, 'SIGINT');
  });

  test('a close() that throws still ends with the signal', async () => {
    const fake = fakeProcess();
    installShutdownHooks(async () => {
      throw new Error('revoke failed');
    });
    fake.listeners.get('SIGINT')?.('SIGINT');
    await vi.waitFor(() =>
      expect(fake.kill).toHaveBeenCalledWith(process.pid, 'SIGINT'),
    );
  });

  test('uninstall removes both handlers and can be called twice', () => {
    const fake = fakeProcess();
    const close = vi.fn(async () => undefined);
    const uninstall = installShutdownHooks(close);
    uninstall();
    uninstall();
    expect(fake.listeners.size).toBe(0);
    expect(fake.removeListener).toHaveBeenCalledTimes(2);
    expect(close).not.toHaveBeenCalled();
  });
});
