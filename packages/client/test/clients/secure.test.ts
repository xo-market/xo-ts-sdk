import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { type Address, getAddress, type Hex, pad } from 'viem';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { fileStore } from '../../src/auth/fileStore';
import {
  type CredentialStore,
  credentialKey,
  memoryStore,
} from '../../src/auth/store';
import { isPublicClient, isSecureClient } from '../../src/clients/guards';
import { resetProcessState, setClientSeams } from '../../src/clients/internal';
import {
  createSecureClient,
  type SecureClient,
  type SecureClientOptions,
} from '../../src/clients/secure';
import {
  RequestRejectedError,
  TransactionFailedError,
  UserInputError,
  XoError,
} from '../../src/core/errors';
import { Transport, type TransportRequest } from '../../src/core/transport';
import { OrderbookClient } from '../../src/orderbook/client';
import { kernelCreateAccountCalldata } from '../../src/signing/kernel';
import { privateKey } from '../../src/wallet/publicSigner';
import {
  API_KEYS_URL,
  type Backend,
  installBackend,
  seedBackendKey,
} from '../helpers/mockBackend';
import {
  type CredentialRecord,
  gatewayError,
  installOrderbook,
  type Orderbook,
  seedKey,
} from '../helpers/mockOrderbook';
import {
  OWNER,
  OWNER_PK,
  type RailChainStub,
  railChain,
  SMART_WALLET,
  TX_HASH,
} from '../helpers/railChain';
import { installSponsor, type SponsorLog } from '../helpers/secureRig';
import { testEnv } from '../helpers/testEnv';

// The secure client: the wallet it trades from, signing in when it is created, and the two
// ways it ends: close() for this process, endAuthentication() to sign the wallet out. msw
// stands in for XO's backend and order book; a chain stub (the client's test seam) for the
// smart wallet factory.

const env = testEnv;
const TIME = 'GET /time';
const NONCE = 'POST /api/auth/api-keys/nonce';
const CREATE_KEY = 'POST /api/auth/api-keys';
const LIST_KEYS = 'GET /api/auth/api-keys';
const ME = 'GET /api/users/me';
const DERIVE = 'GET /auth/derive-api-key';
const CREATE = 'POST /auth/api-key';
const DELETE_ORDERBOOK_KEY = 'DELETE /auth/api-key';
const SPONSOR = 'POST /v1/sponsor/send';
const revokeOf = (id: number | string) => `DELETE /api/auth/api-keys/${id}`;
const UNRELATED: Address = getAddress(
  '0x00000000000000000000000000000000000bad01',
);

/** Every request that reached msw, as "METHOD /path". */
const wire: string[] = [];
const count = (call: string) => wire.filter((c) => c === call).length;

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
  server.events.on('request:start', ({ request }) => {
    wire.push(`${request.method} ${new URL(request.url).pathname}`);
  });
});
afterAll(() => server.close());

const clients: SecureClient[] = [];
const dirs: string[] = [];
let chain: RailChainStub;

beforeEach(() => {
  chain = railChain();
  // The factory gives the owner a smart wallet per index; SMART_WALLET is number 3.
  chain.read = ({ to, data }) => {
    if (to.toLowerCase() !== env.contracts.kernelFactory.toLowerCase()) {
      return new Error('execution reverted');
    }
    for (let index = 0n; index < 10n; index += 1n) {
      if (
        data.toLowerCase() ===
        kernelCreateAccountCalldata(OWNER, index, env.contracts.ecdsaValidator)
      ) {
        const address =
          index === 3n
            ? SMART_WALLET
            : getAddress(
                `0x${(0xa000n + index).toString(16).padStart(40, '0')}`,
              );
        return pad(address.toLowerCase() as Hex, { size: 32 });
      }
    }
    return new Error('execution reverted');
  };
  setClientSeams({ chain: chain.reader });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((c) => c.close()));
  server.resetHandlers();
  vi.restoreAllMocks();
  setClientSeams({});
  resetProcessState();
  wire.length = 0;
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** The owner's signer, each method a spy. */
function spiedSigner() {
  const base = privateKey(OWNER_PK);
  return {
    getAddress: vi.fn(() => base.getAddress()),
    signMessage: vi.fn((message: string) => base.signMessage(message)),
    signTypedData: vi.fn((td: Parameters<typeof base.signTypedData>[0]) =>
      base.signTypedData(td),
    ),
    signHash: vi.fn((hash: Hex) =>
      (base.signHash as (h: Hex) => Promise<Hex>)(hash),
    ),
  };
}

/** A client that the test's cleanup closes. */
async function secure(
  o: Partial<SecureClientOptions> = {},
): Promise<SecureClient> {
  const client = await createSecureClient({
    environment: env,
    signer: privateKey(OWNER_PK),
    ...o,
  });
  clients.push(client);
  return client;
}

/** The order book's clock. */
function serverTime(): void {
  server.use(
    http.get(`${env.orderbookUrl}/time`, () =>
      HttpResponse.json(Math.floor(Date.now() / 1000)),
    ),
  );
}

/** XO's backend and order book, with the clock. */
function services(o: Parameters<typeof installBackend>[1] = {}): {
  backend: Backend;
  orderbook: Orderbook;
} {
  serverTime();
  return {
    backend: installBackend(server, o),
    orderbook: installOrderbook(server),
  };
}

/** A memory store that says it is persistent, as a file store would. */
function persistentStore(): CredentialStore {
  const inner = memoryStore();
  return {
    persistent: true,
    get: (key) => inner.get(key),
    set: (key, value) => inner.set(key, value),
    delete: (key) => inner.delete(key),
  };
}

async function tempStore(): Promise<CredentialStore> {
  const dir = await mkdtemp(join(tmpdir(), 'xo-secure-'));
  dirs.push(dir);
  return fileStore(dir);
}

/** What `fn` threw or rejected with. */
async function caught(fn: () => unknown): Promise<XoError> {
  try {
    await fn();
  } catch (error) {
    return error as XoError;
  }
  throw new Error('expected a throw');
}

const STORE_KEY = credentialKey(env.name, OWNER);

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

describe('createSecureClient: options', () => {
  test('a signer is required: a JS caller without one gets a UserInputError, and nothing is read or sent', async () => {
    services();
    for (const options of [{}, { environment: env }, { signer: undefined }]) {
      const error = await caught(() =>
        createSecureClient(options as unknown as SecureClientOptions),
      );
      expect(error).toBeInstanceOf(UserInputError);
      expect(error.message).toContain('signer is required');
    }
    const error = await caught(() =>
      createSecureClient(undefined as unknown as SecureClientOptions),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect(wire).toEqual([]);
    expect(chain.log).toEqual([]);
  });

  test('an unknown option is refused before anything is read, and its value is not repeated', async () => {
    services();
    const secret = `xo_sk_data_${'s'.repeat(8)}_${'t'.repeat(48)}`;
    const error = await caught(() =>
      createSecureClient({
        signer: privateKey(OWNER_PK),
        apiKey: secret,
      } as unknown as SecureClientOptions),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect(error.message).toContain('apiKey');
    expect(error.message).not.toContain(secret);
    expect(wire).toEqual([]);
  });

  test('credentials are checked first, and never repeated', async () => {
    services();
    const secret = 'not a key, but a SECRET value';
    for (const credentials of [
      { backend: { apiKey: secret } },
      { orderbook: { apiKey: secret, secret, passphrase: 'p' } },
      { backend: { apiKey: secret }, other: secret },
    ]) {
      const error = await caught(() =>
        createSecureClient({
          environment: env,
          signer: privateKey(OWNER_PK),
          credentials: credentials as SecureClientOptions['credentials'],
        }),
      );
      expect(error).toBeInstanceOf(UserInputError);
      expect(error.message).not.toContain(secret);
    }
    expect(wire).toEqual([]);
    expect(chain.log).toEqual([]);
  });

  test.each([
    [
      'an id that is not a key id',
      { apiKey: `xo_sk_data_${'a'.repeat(8)}_${'b'.repeat(48)}`, id: '0x1' },
    ],
    [
      'an expiry that is not a time',
      {
        apiKey: `xo_sk_data_${'a'.repeat(8)}_${'b'.repeat(48)}`,
        expiresAt: 'soon',
      },
    ],
    [
      'an unknown field',
      { apiKey: `xo_sk_data_${'a'.repeat(8)}_${'b'.repeat(48)}`, scopes: [] },
    ],
  ])(
    'a given API key with %s is refused before anything is read',
    async (_, backend) => {
      services();
      const error = await caught(() =>
        createSecureClient({
          environment: env,
          signer: privateKey(OWNER_PK),
          credentials: { backend } as SecureClientOptions['credentials'],
        }),
      );
      expect(error).toBeInstanceOf(UserInputError);
      expect(error.message).not.toContain('b'.repeat(48));
      expect(wire).toEqual([]);
    },
  );

  test.each([
    ['rail', { rail: 'bundler' }],
    ['shutdownHooks', { shutdownHooks: 'yes' }],
    ['strictResponses', { strictResponses: 1 }],
    ['label', { label: 'has spaces' }],
    ['store', { store: { persistent: true } }],
    ['wallet', { wallet: 42 }],
    ['fetch', { fetch: 'fetch' }],
  ])(
    'a %s of the wrong type is refused before anything is read',
    async (_, extra) => {
      services();
      const error = await caught(() =>
        createSecureClient({
          environment: env,
          signer: privateKey(OWNER_PK),
          ...(extra as Partial<SecureClientOptions>),
        }),
      );
      expect(error).toBeInstanceOf(UserInputError);
      expect(wire).toEqual([]);
      expect(chain.log).toEqual([]);
    },
  );

  test("rail 'direct' with a smart wallet is refused with direct_rail_eoa_only, before anything is sent", async () => {
    services();
    const error = await caught(() =>
      createSecureClient({
        environment: env,
        signer: privateKey(OWNER_PK),
        wallet: SMART_WALLET,
        rail: 'direct',
      }),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect(error.code).toBe('direct_rail_eoa_only');
    expect(wire).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The wallet
// ---------------------------------------------------------------------------

describe('the wallet option', () => {
  test("without it, the client trades from the signer's own address", async () => {
    const { backend } = services();
    const client = await secure();
    expect(client.wallet).toBe(OWNER);
    expect(backend.walletBodies[0]?.type).toBe('eoa');
  });

  test('the signer address in lower case is the plain wallet', async () => {
    const { backend } = services();
    const client = await secure({ wallet: OWNER.toLowerCase() });
    expect(client.wallet).toBe(OWNER);
    expect(backend.walletBodies[0]?.type).toBe('eoa');
    expect(chain.count('readContract')).toBe(0);
  });

  test('a smart wallet of the signer (number 3): the client signs in for it and trades from it', async () => {
    serverTime();
    const backend = installBackend(server, {
      smartAccounts: {
        [SMART_WALLET.toLowerCase()]: { owner: OWNER, index: 3n },
      },
    });
    const orderbook = installOrderbook(server);
    orderbook.smartAccounts.set(SMART_WALLET.toLowerCase(), OWNER);
    const client = await secure({ wallet: SMART_WALLET.toLowerCase() });
    expect(client.wallet).toBe(SMART_WALLET);
    expect(backend.walletBodies[0]).toMatchObject({
      type: 'smart_wallet',
      index: '3',
    });
    expect(orderbook.keys.get(SMART_WALLET.toLowerCase())).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(client))).toMatchObject({
      wallet: SMART_WALLET,
      walletType: 'smart_wallet',
    });
  });

  test('an address the signer does not own: wallet_not_owned, with no request to XO and no signature', async () => {
    services();
    const signer = spiedSigner();
    const hooks = [
      process.listenerCount('SIGINT'),
      process.listenerCount('beforeExit'),
    ];
    const error = await caught(() =>
      createSecureClient({ environment: env, signer, wallet: UNRELATED }),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect(error.code).toBe('wallet_not_owned');
    // Not one request reached XO's backend or order book, the clock included.
    expect(wire).toEqual([]);
    expect(signer.signMessage).not.toHaveBeenCalled();
    expect(signer.signTypedData).not.toHaveBeenCalled();
    expect(signer.signHash).not.toHaveBeenCalled();
    // Only the smart wallet factory was read: indexes 0 to 9.
    expect(chain.log.map((c) => c.method)).toEqual(
      Array.from({ length: 10 }, () => 'readContract'),
    );
    // Nothing was installed for a client that does not exist.
    expect([
      process.listenerCount('SIGINT'),
      process.listenerCount('beforeExit'),
    ]).toEqual(hooks);
  });
});

// ---------------------------------------------------------------------------
// A smart wallet that is not deployed yet
// ---------------------------------------------------------------------------

describe('a smart wallet that is not deployed yet', () => {
  /** XO's services and the sponsor for SMART_WALLET, which has no code until it is mined. */
  function smartWalletServices(o: { deployed?: boolean } = {}) {
    serverTime();
    const backend = installBackend(server, {
      smartAccounts: {
        [SMART_WALLET.toLowerCase()]: { owner: OWNER, index: 3n },
      },
    });
    const orderbook = installOrderbook(server);
    orderbook.smartAccounts.set(SMART_WALLET.toLowerCase(), OWNER);
    const sponsor = installSponsor(server, env);
    if (o.deployed !== true) {
      chain.code.delete(SMART_WALLET.toLowerCase());
    }
    // The deployment lands when its transaction is mined.
    chain.receipt = (hash) => {
      chain.code.set(SMART_WALLET.toLowerCase(), '0x6000');
      return { txHash: hash, status: 'success', blockNumber: 42n };
    };
    return { backend, orderbook, sponsor };
  }

  const hooks = () => [
    process.listenerCount('SIGINT'),
    process.listenerCount('SIGTERM'),
    process.listenerCount('beforeExit'),
  ];

  test('it is deployed once, through the sponsor, before the client signs in; then the client works', async () => {
    const { backend, orderbook, sponsor } = smartWalletServices();
    const client = await secure({ wallet: SMART_WALLET });

    expect(count(SPONSOR)).toBe(1);
    expect(sponsor.bodies).toHaveLength(1);
    const [deploy, execute] = sponsor.bodies[0]?.tx.calls ?? [];
    // The factory deploys the signer's smart wallet 3, in the transaction of the trading setup.
    expect(deploy?.to?.toLowerCase()).toBe(
      env.contracts.kernelFactory.toLowerCase(),
    );
    expect(deploy?.data).toBe(
      kernelCreateAccountCalldata(OWNER, 3n, env.contracts.ecdsaValidator),
    );
    expect(execute?.to?.toLowerCase()).toBe(SMART_WALLET.toLowerCase());
    // Sent before anything signs in, and never again.
    const sent = wire.indexOf(SPONSOR);
    expect(sent).toBeLessThan(wire.indexOf(NONCE));
    expect(sent).toBeLessThan(wire.indexOf(DERIVE));

    expect(client.wallet).toBe(SMART_WALLET);
    expect(backend.minted).toHaveLength(1);
    expect(orderbook.keys.get(SMART_WALLET.toLowerCase())).toHaveLength(1);
    const before = wire.length;
    const credentials = await client.exportCredentials();
    expect(wire.length).toBe(before);
    expect(credentials.orderbook).toEqual(
      orderbook.keys.get(SMART_WALLET.toLowerCase())?.[0],
    );
    expect(count(SPONSOR)).toBe(1);
  });

  test('a smart wallet that is deployed already is sent nothing', async () => {
    const { orderbook, sponsor } = smartWalletServices({ deployed: true });
    const client = await secure({ wallet: SMART_WALLET });
    expect(client.wallet).toBe(SMART_WALLET);
    expect(sponsor.bodies).toEqual([]);
    expect(count(SPONSOR)).toBe(0);
    expect(orderbook.keys.get(SMART_WALLET.toLowerCase())).toHaveLength(1);
  });

  test("the signer's own address: no deployment is read or sent", async () => {
    services();
    const sponsor = installSponsor(server, env);
    const client = await secure();
    expect(client.wallet).toBe(OWNER);
    expect(chain.count('getCode')).toBe(0);
    expect(sponsor.bodies).toEqual([]);
    expect(count(SPONSOR)).toBe(0);
  });

  test.each([
    [
      "the sponsor's answer is lost",
      (sponsor: SponsorLog) => {
        sponsor.reply = () => HttpResponse.error();
      },
      { code: 'sponsor_outcome_unknown', transactionHash: undefined },
    ],
    [
      'its receipt does not come',
      () => {
        chain.receipt = () => new Error('the node is down');
      },
      { code: 'receipt_unavailable', transactionHash: TX_HASH },
    ],
  ])(
    'a deployment whose outcome is unknown (%s) throws with mayHaveLanded true; it is not sent again, no client is made and no key is left',
    async (_, fail, expected) => {
      const { backend, orderbook, sponsor } = smartWalletServices();
      fail(sponsor);
      const signer = spiedSigner();
      const held = hooks();

      const error = await caught(() =>
        createSecureClient({ environment: env, signer, wallet: SMART_WALLET }),
      );

      expect(error).toBeInstanceOf(TransactionFailedError);
      expect(error).toMatchObject({ mayHaveLanded: true, ...expected });
      expect(count(SPONSOR)).toBe(1);
      expect(sponsor.bodies).toHaveLength(1);
      // The executor nonce the transaction was signed with, to look it up by.
      expect((error as TransactionFailedError).nonce).toBe(
        BigInt(sponsor.bodies[0]?.tx.nonce as string),
      );
      // Signed once, as the executor of the deployment; nothing signed in.
      expect(signer.signHash).toHaveBeenCalledTimes(1);
      expect(signer.signMessage).not.toHaveBeenCalled();
      expect(signer.signTypedData).not.toHaveBeenCalled();
      expect(count(NONCE)).toBe(0);
      expect(count(DERIVE)).toBe(0);
      expect(backend.minted).toEqual([]);
      expect(orderbook.keys.get(SMART_WALLET.toLowerCase()) ?? []).toEqual([]);
      expect(hooks()).toEqual(held);
    },
  );

  test('credentials of another account are refused before the smart wallet is deployed: nothing is sent', async () => {
    const { backend, sponsor } = smartWalletServices();
    const key = seedBackendKey(backend, { wallet: UNRELATED });
    const error = await caught(() =>
      secure({
        wallet: SMART_WALLET,
        credentials: { backend: { apiKey: key.key } },
      }),
    );
    expect(error.code).toBe('credentials_not_owned');
    expect(sponsor.bodies).toEqual([]);
    expect(count(SPONSOR)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Signing in at creation
// ---------------------------------------------------------------------------

describe('signing in at creation', () => {
  test('the API key is signed in for and the order book credentials derived before it resolves', async () => {
    const { backend, orderbook } = services();
    const client = await secure();
    expect(backend.minted).toHaveLength(1);
    expect(orderbook.keys.get(OWNER.toLowerCase())).toHaveLength(1);
    // The order book had no key for the wallet: derive (404), then create.
    expect(wire.indexOf(NONCE)).toBeLessThan(wire.indexOf(CREATE_KEY));
    expect(wire.indexOf(CREATE_KEY)).toBeLessThan(wire.indexOf(DERIVE));
    expect(wire.indexOf(DERIVE)).toBeLessThan(wire.indexOf(CREATE));

    // Signed in: the credentials are in hand, with no further request.
    const before = wire.length;
    const credentials = await client.exportCredentials();
    expect(wire.length).toBe(before);
    const minted = backend.minted[0];
    // The shape the credentials option takes, with the key's metadata.
    expect(credentials.backend).toEqual({
      apiKey: minted?.key,
      id: String(minted?.record.id),
      expiresAt: minted?.record.expiresAt,
    });
    expect(credentials.orderbook).toEqual(
      orderbook.keys.get(OWNER.toLowerCase())?.[0],
    );
  });

  test('an order book key the wallet already has is derived, not created', async () => {
    const { orderbook } = services();
    const existing = seedKey(orderbook, OWNER);
    const client = await secure();
    expect(count(DERIVE)).toBe(1);
    expect(count(CREATE)).toBe(0);
    expect((await client.exportCredentials()).orderbook).toEqual(existing);
  });

  test("credentials given are checked to be the wallet's, then used: no key is signed in for", async () => {
    const { backend, orderbook } = services();
    const key = seedBackendKey(backend, { wallet: OWNER });
    const ob = seedKey(orderbook, OWNER);
    const signer = spiedSigner();
    const client = await secure({
      signer,
      credentials: { backend: { apiKey: key.key }, orderbook: ob },
    });
    // One read of the key's account, one derive to check the order book credentials.
    expect(wire.filter((c) => c !== TIME)).toEqual([ME, DERIVE]);
    expect(signer.signMessage).not.toHaveBeenCalled();
    expect(signer.signTypedData).toHaveBeenCalledTimes(1);
    expect(orderbook.keys.get(OWNER.toLowerCase())).toEqual([ob]);
    // A key given without its metadata is exported without it: no placeholders.
    expect(await client.exportCredentials()).toEqual({
      backend: { apiKey: key.key },
      orderbook: ob,
    });
  });

  test('an API key of another account: credentials_not_owned after one read of it; nothing is signed, stored or revoked', async () => {
    const { backend } = services();
    const key = seedBackendKey(backend, { wallet: UNRELATED });
    const signer = spiedSigner();
    const store = persistentStore();
    const before = process.listenerCount('beforeExit');
    const error = await caught(() =>
      createSecureClient({
        environment: env,
        signer,
        store,
        credentials: { backend: { apiKey: key.key } },
      }),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect(error.code).toBe('credentials_not_owned');
    expect(error.message).toContain('credentials.backend');
    expect(JSON.stringify(error)).not.toContain(key.key);
    expect(inspect(error, { depth: 10 })).not.toContain(key.key);
    // The read of the key's account is the last request: nothing is signed in for or revoked.
    expect(wire.at(-1)).toBe(ME);
    expect(count(ME)).toBe(1);
    expect(wire.filter((c) => c !== TIME && c !== ME)).toEqual([]);
    expect(key.record.revokedAt).toBeNull();
    expect(signer.signMessage).not.toHaveBeenCalled();
    expect(signer.signTypedData).not.toHaveBeenCalled();
    expect(await store.get(STORE_KEY)).toBeUndefined();
    expect(process.listenerCount('beforeExit')).toBe(before);
  });

  test.each([
    ['the wallet has no order book key', false],
    ['the wallet has a key of its own', true],
  ])(
    'order book credentials of another wallet (%s): credentials_not_owned after one derive; nothing is stored, created or deleted',
    async (_, ownKey) => {
      const { backend, orderbook } = services();
      const own = ownKey ? seedKey(orderbook, OWNER) : undefined;
      const foreign = seedKey(orderbook, UNRELATED);
      const signer = spiedSigner();
      const store = persistentStore();
      const error = await caught(() =>
        createSecureClient({
          environment: env,
          signer,
          store,
          credentials: { orderbook: foreign },
        }),
      );
      expect(error).toBeInstanceOf(UserInputError);
      expect(error.code).toBe('credentials_not_owned');
      expect(error.message).toContain('credentials.orderbook');
      for (const value of [
        foreign.apiKey,
        foreign.secret,
        foreign.passphrase,
      ]) {
        expect(JSON.stringify(error)).not.toContain(value);
      }
      // The derive is the last request: no API key is signed in for, no order book key created.
      expect(wire.at(-1)).toBe(DERIVE);
      expect(wire.filter((c) => c !== TIME)).toEqual([DERIVE]);
      expect(backend.minted).toEqual([]);
      expect(signer.signMessage).not.toHaveBeenCalled();
      expect(signer.signTypedData).toHaveBeenCalledTimes(1);
      expect(orderbook.deleted).toEqual([]);
      expect(orderbook.keys.get(UNRELATED.toLowerCase())).toEqual([foreign]);
      expect(orderbook.keys.get(OWNER.toLowerCase()) ?? []).toEqual(
        own === undefined ? [] : [own],
      );
      expect(await store.get(STORE_KEY)).toBeUndefined();
    },
  );

  test("the wallet's own order book key that is not its default one (what derive gives) is refused too", async () => {
    const { orderbook } = services();
    seedKey(orderbook, OWNER);
    const second = seedKey(orderbook, OWNER);
    const error = await caught(() =>
      secure({ credentials: { orderbook: second } }),
    );
    expect(error.code).toBe('credentials_not_owned');
    expect(orderbook.deleted).toEqual([]);
  });

  test('an export passed to a new client works as it is: no new key, nothing derived but the check, and close() keeps it', async () => {
    const { backend, orderbook } = services();
    const first = await secure({ store: persistentStore() });
    const credentials = await first.exportCredentials();
    wire.length = 0;
    const signer = spiedSigner();
    const second = await secure({ signer, credentials });
    expect(wire.filter((c) => c !== TIME)).toEqual([ME, DERIVE]);
    expect(signer.signMessage).not.toHaveBeenCalled();
    expect(backend.minted).toHaveLength(1);
    expect(orderbook.keys.get(OWNER.toLowerCase())).toHaveLength(1);
    expect(await second.exportCredentials()).toEqual(credentials);
    await second.close();
    expect(backend.minted[0]?.record.revokedAt).toBeNull();
    expect(wire.filter((c) => c.startsWith('DELETE '))).toEqual([]);
  });

  test('every request that signs the wallet in or out has a 15 s timeout of its own', async () => {
    services();
    const request = vi.spyOn(Transport.prototype, 'request');
    await secure();
    const signIn = request.mock.calls
      .map(([o]) => o as TransportRequest)
      .filter((o) =>
        [
          '/api/auth/api-keys/nonce',
          '/api/auth/api-keys',
          '/auth/derive-api-key',
          '/auth/api-key',
        ].includes(o.path),
      );
    expect(signIn.map((o) => `${o.method} ${o.path}`)).toEqual([
      NONCE,
      CREATE_KEY,
      DERIVE,
      CREATE,
    ]);
    for (const o of signIn) {
      expect(o.timeoutMs).toBe(15_000);
    }

    // And so does every request that signs it out.
    request.mockClear();
    await (clients.at(-1) as SecureClient).endAuthentication();
    const signOut = request.mock.calls.map(([o]) => o as TransportRequest);
    expect(signOut.map((o) => o.method)).toEqual(['DELETE', 'DELETE']);
    for (const o of signOut) {
      expect(o.timeoutMs).toBe(15_000);
    }
  });

  test('a sign-in that fails after the API key was signed in for revokes that key before the error', async () => {
    const { backend, orderbook } = services();
    orderbook.override = (route) =>
      route === 'derive' ? gatewayError(400, 'bad request') : undefined;
    const before = process.listenerCount('beforeExit');
    const error = await caught(() => secure());
    expect(error).toBeInstanceOf(RequestRejectedError);
    expect(backend.minted).toHaveLength(1);
    const minted = backend.minted[0];
    expect(backend.calls).toContain(revokeOf(minted?.record.id as number));
    expect(minted?.record.revokedAt).not.toBeNull();
    // The hooks it held for that key are released.
    expect(process.listenerCount('beforeExit')).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

describe('secret redaction', () => {
  test('JSON.stringify and util.inspect show the wallet address and no credential', async () => {
    const { backend, orderbook } = services();
    const minted = await secure();
    const given = seedBackendKey(backend, { wallet: OWNER });
    // Given order book credentials must be the wallet's own: the ones the first client derived.
    const derived = orderbook.keys.get(OWNER.toLowerCase())?.[0];
    const givenOrderbook = derived as CredentialRecord;
    const withGiven = await secure({
      credentials: {
        backend: { apiKey: given.key, id: String(given.record.id) },
        orderbook: givenOrderbook,
      },
    });
    const secrets = [
      backend.minted[0]?.key,
      derived?.apiKey,
      derived?.secret,
      derived?.passphrase,
      given.key,
      givenOrderbook.apiKey,
      givenOrderbook.secret,
      givenOrderbook.passphrase,
      OWNER_PK.slice(2),
    ] as string[];
    for (const value of secrets) {
      expect(value.length).toBeGreaterThan(8);
    }
    for (const client of [minted, withGiven]) {
      for (const shown of [
        JSON.stringify(client),
        inspect(client, { depth: 20 }),
        inspect(client, { depth: 20, showHidden: true }),
        JSON.stringify({ wrapped: [client] }),
      ]) {
        expect(shown).toContain(OWNER);
        for (const value of secrets) {
          expect(shown).not.toContain(value);
        }
      }
    }
    expect(JSON.parse(JSON.stringify(minted))).toEqual({
      environment: 'test',
      wallet: OWNER,
      walletType: 'eoa',
      rail: 'sponsored',
      credentials: { backend: 'session', orderbook: 'session' },
      state: 'open',
    });
    expect(JSON.parse(JSON.stringify(withGiven)).credentials).toEqual({
      backend: 'provided',
      orderbook: 'provided',
    });
  });
});

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

/** The members that refuse once the client is closed: every one but the lifecycle. */
function refusingMembers(client: SecureClient): string[] {
  return Object.keys(client).filter(
    (name) =>
      typeof (client as unknown as Record<string, unknown>)[name] ===
        'function' && !['close', 'endAuthentication'].includes(name),
  );
}

/** Every member of a closed client refuses with client_closed, and sends nothing. */
async function expectRefusesEverything(client: SecureClient): Promise<void> {
  const before = wire.length;
  const members = refusingMembers(client);
  expect(members).toContain('fetchTradingState');
  expect(members).toContain('listMarkets');
  expect(members).toContain('rotateCredentials');
  expect(members).toContain('exportCredentials');
  expect(members).toContain('subscribe');
  expect(members).toContain('closeSubscriptions');
  for (const name of members) {
    const member = (
      client as unknown as Record<string, (...a: unknown[]) => unknown>
    )[name] as (...a: unknown[]) => unknown;
    let error: unknown;
    if (name.startsWith('list') || name === 'startOrderHeartbeat') {
      // A list and a running heartbeat are returned at once, so they throw at once.
      try {
        member({});
      } catch (e) {
        error = e;
      }
    } else {
      error = await (member({}) as Promise<unknown>).then(
        () => undefined,
        (e: unknown) => e,
      );
    }
    expect(error, name).toBeInstanceOf(UserInputError);
    expect((error as XoError).code, name).toBe('client_closed');
    expect((error as XoError).mayHaveLanded, name).toBe(false);
  }
  expect(wire.length).toBe(before);
}

describe('close()', () => {
  test('revokes a minted 1-day key, keeps the order book key, and refuses every call afterwards', async () => {
    const { backend, orderbook } = services();
    const refuse = vi.spyOn(OrderbookClient.prototype, 'refuseNewOrders');
    const stop = vi.spyOn(OrderbookClient.prototype, 'stopHeartbeat');
    const client = await secure();
    const minted = backend.minted[0];

    const closing = client.close();
    expect(client.close()).toBe(closing);
    // New orders are refused from the moment close() is called.
    expect(refuse).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    await closing;

    expect(backend.calls).toContain(revokeOf(minted?.record.id as number));
    expect(minted?.record.revokedAt).not.toBeNull();
    // The order book key is not this process's alone: close() keeps it.
    expect(count(DELETE_ORDERBOOK_KEY)).toBe(0);
    expect(orderbook.keys.get(OWNER.toLowerCase())).toHaveLength(1);
    await client.close();
    expect(backend.calls.filter((c) => c.startsWith('DELETE '))).toHaveLength(
      1,
    );

    await expectRefusesEverything(client);
    expect(JSON.parse(JSON.stringify(client)).state).toBe('closed');
  });

  test('a key from a persistent store survives close() for the next run', async () => {
    const { backend } = services();
    const store = await tempStore();
    const first = await secure({ store });
    const key = (await first.exportCredentials()).backend;
    await first.close();
    expect(backend.calls.filter((c) => c.startsWith('DELETE '))).toEqual([]);
    expect((await store.get(STORE_KEY))?.backend?.key).toBe(key?.apiKey);

    // The next run loads it: no sign-in for a new key.
    wire.length = 0;
    const second = await secure({ store });
    expect(count(NONCE)).toBe(0);
    expect((await second.exportCredentials()).backend?.apiKey).toBe(
      key?.apiKey,
    );
  });

  test('credentials given are left active', async () => {
    const { backend, orderbook } = services();
    const key = seedBackendKey(backend, { wallet: OWNER });
    const ob = seedKey(orderbook, OWNER);
    const client = await secure({
      credentials: { backend: { apiKey: key.key }, orderbook: ob },
    });
    await client.close();
    expect(key.record.revokedAt).toBeNull();
    expect(wire.filter((c) => c.startsWith('DELETE '))).toEqual([]);
  });

  test('endAuthentication after close() is refused with client_closed, and revokes nothing', async () => {
    const { backend } = services();
    const store = persistentStore();
    const client = await secure({ store });
    await client.close();
    const error = await caught(() => client.endAuthentication());
    expect(error).toBeInstanceOf(UserInputError);
    expect(error.code).toBe('client_closed');
    expect(backend.calls.filter((c) => c.startsWith('DELETE '))).toEqual([]);
    expect(count(DELETE_ORDERBOOK_KEY)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// endAuthentication()
// ---------------------------------------------------------------------------

describe('endAuthentication()', () => {
  test('revokes the API key and deletes the order book key; the public client it returns works; the old one refuses every call', async () => {
    const { backend, orderbook } = services();
    server.use(
      http.get(`${env.orderbookUrl}/trading-state`, () =>
        HttpResponse.json({ state: 'active' }),
      ),
    );
    const client = await secure();
    const minted = backend.minted[0];
    const derived = orderbook.keys.get(OWNER.toLowerCase())?.[0];

    const ending = client.endAuthentication();
    expect(client.endAuthentication()).toBe(ending);
    const publicClient = await ending;

    expect(backend.calls).toContain(revokeOf(minted?.record.id as number));
    expect(minted?.record.revokedAt).not.toBeNull();
    // Deleted with itself: the gateway checked the L2 signature over the body it names.
    expect(count(DELETE_ORDERBOOK_KEY)).toBe(1);
    const request = orderbook.requests.find(
      (r) => `${r.method} ${r.path}` === DELETE_ORDERBOOK_KEY,
    );
    expect(JSON.parse(request?.body ?? '')).toEqual({
      apiKey: derived?.apiKey,
    });
    expect(request?.headers.get('XO_API_KEY')).toBe(derived?.apiKey);
    expect(orderbook.deleted).toEqual([derived?.apiKey]);
    expect(orderbook.keys.get(OWNER.toLowerCase())).toEqual([]);

    expect(isPublicClient(publicClient)).toBe(true);
    expect(isSecureClient(publicClient)).toBe(false);
    expect(await publicClient.fetchTradingState()).toBe('active');

    await expectRefusesEverything(client);
    expect(JSON.parse(JSON.stringify(client)).state).toBe('signed_out');
    // close() afterwards has nothing left to do.
    const settled = wire.length;
    await client.close();
    expect(wire.length).toBe(settled);
  });

  test('revokes a key loaded from a persistent store, and deletes it from the store', async () => {
    const { backend, orderbook } = services();
    const store = await tempStore();
    const first = await secure({ store });
    await first.close();
    const stored = await store.get(STORE_KEY);
    expect(stored?.backend).toBeDefined();
    expect(stored?.orderbook).toBeDefined();

    const second = await secure({ store });
    expect(backend.minted).toHaveLength(1); // loaded, not signed in for again
    await second.endAuthentication();

    const record = backend.minted[0]?.record;
    expect(backend.calls).toContain(revokeOf(record?.id as number));
    expect(record?.revokedAt).not.toBeNull();
    expect(orderbook.deleted).toEqual([stored?.orderbook?.apiKey]);
    expect(await store.get(STORE_KEY)).toBeUndefined();
  });

  test('revokes an API key given in credentials, found in the key listing by its prefix', async () => {
    const { backend, orderbook } = services();
    const other = seedBackendKey(backend);
    const key = seedBackendKey(backend, { wallet: OWNER });
    const ob = seedKey(orderbook, OWNER);
    const client = await secure({
      credentials: { backend: { apiKey: key.key }, orderbook: ob },
    });
    await client.endAuthentication();
    expect(backend.calls).toContain(LIST_KEYS);
    expect(backend.calls).toContain(revokeOf(key.record.id));
    expect(key.record.revokedAt).not.toBeNull();
    expect(other.record.revokedAt).toBeNull();
    expect(orderbook.deleted).toEqual([ob.apiKey]);
  });

  test('a given API key with its id revokes itself by that id, without the listing', async () => {
    const { backend } = services();
    const key = seedBackendKey(backend, { wallet: OWNER });
    const client = await secure({
      credentials: {
        backend: { apiKey: key.key, id: String(key.record.id) },
      },
    });
    await client.endAuthentication();
    expect(backend.calls).not.toContain(LIST_KEYS);
    expect(backend.calls).toContain(revokeOf(key.record.id));
    expect(key.record.revokedAt).not.toBeNull();
  });

  test("a given id that is not the key's falls back to the listing", async () => {
    const { backend } = services();
    const other = seedBackendKey(backend);
    const key = seedBackendKey(backend, { wallet: OWNER });
    const client = await secure({
      credentials: {
        backend: { apiKey: key.key, id: String(other.record.id) },
      },
    });
    await client.endAuthentication();
    expect(backend.calls).toContain(LIST_KEYS);
    expect(key.record.revokedAt).not.toBeNull();
    expect(other.record.revokedAt).toBeNull();
  });

  test('a given API key the listing does not show: api_key_not_listed, and the client is closed anyway', async () => {
    const { backend, orderbook } = services();
    const key = seedBackendKey(backend, { wallet: OWNER });
    const ob = seedKey(orderbook, OWNER);
    const client = await secure({
      credentials: { backend: { apiKey: key.key }, orderbook: ob },
    });
    server.use(http.get(API_KEYS_URL, () => HttpResponse.json([])));
    const error = await caught(() => client.endAuthentication());
    expect(error).toBeInstanceOf(XoError);
    expect(error.code).toBe('api_key_not_listed');
    expect(error.message).not.toContain(key.key);
    // Every other step still ran.
    expect(orderbook.deleted).toEqual([ob.apiKey]);
    await expectRefusesEverything(client);
  });

  test('an order book key the gateway does not know (404) is gone already: the sign-out succeeds, and the key is never repeated', async () => {
    const { orderbook } = services();
    const client = await secure();
    const derived = orderbook.keys.get(OWNER.toLowerCase())?.[0];
    orderbook.deleteOverride = () =>
      gatewayError(404, `API key not found: ${derived?.apiKey}`);
    await expect(client.endAuthentication()).resolves.toBeDefined();
    expect(count(DELETE_ORDERBOOK_KEY)).toBe(1);
  });

  test('an order book key the gateway no longer accepts (401 even after a clock sync) is gone already', async () => {
    const { orderbook } = services();
    const client = await secure();
    // Another process trading for the same wallet signed it out first.
    orderbook.keys.set(OWNER.toLowerCase(), []);
    const times = count(TIME);
    await expect(client.endAuthentication()).resolves.toBeDefined();
    expect(count(DELETE_ORDERBOOK_KEY)).toBe(2);
    expect(count(TIME)).toBe(times + 1);
  });

  test('an order book key that belongs to another wallet (403): RequestRejectedError, without the key; the API key is revoked and the client closed anyway', async () => {
    const { backend, orderbook } = services();
    const client = await secure();
    const derived = orderbook.keys.get(OWNER.toLowerCase())?.[0];
    orderbook.deleteOverride = () =>
      gatewayError(
        403,
        `API key does not belong to the authenticated caller ${derived?.apiKey}`,
      );
    const error = await caught(() => client.endAuthentication());
    expect(error).toBeInstanceOf(RequestRejectedError);
    expect(error.status).toBe(403);
    expect(error.service).toBe('orderbook');
    expect(JSON.stringify(error)).not.toContain(derived?.apiKey);
    expect(inspect(error, { depth: 10 })).not.toContain(derived?.apiKey);
    expect(backend.minted[0]?.record.revokedAt).not.toBeNull();
    await expectRefusesEverything(client);
    await client.close();
  });

  test('a stored key whose revoke fails stays in the store, so a later sign-out can try again', async () => {
    const { backend, orderbook } = services();
    const store = persistentStore();
    const first = await secure({ store });
    const record = backend.minted[0]?.record;
    let refusing = true;
    server.use(
      http.delete(`${API_KEYS_URL}/:id`, () =>
        refusing
          ? HttpResponse.json({ statusCode: 400 }, { status: 400 })
          : undefined,
      ),
    );
    const error = await caught(() => first.endAuthentication());
    expect(error).toBeInstanceOf(RequestRejectedError);
    expect(error.service).toBe('backend');
    expect(record?.revokedAt).toBeNull();
    const kept = await store.get(STORE_KEY);
    expect(kept?.backend?.id).toBe(String(record?.id));
    // The order book key was deleted, so it is not kept.
    expect(kept?.orderbook).toBeUndefined();
    expect(orderbook.deleted).toHaveLength(1);

    // Once the backend accepts it again, a new client signs the wallet out.
    refusing = false;
    const second = await secure({ store });
    expect(backend.minted).toHaveLength(1); // the stored key, loaded
    await second.endAuthentication();
    expect(record?.revokedAt).not.toBeNull();
    expect(await store.get(STORE_KEY)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The shutdown hooks
// ---------------------------------------------------------------------------

describe('the shutdown hooks', () => {
  const listeners = () => ({
    int: process.listenerCount('SIGINT'),
    term: process.listenerCount('SIGTERM'),
    exit: process.listenerCount('beforeExit'),
  });

  test('a client that signs in for a 1-day key holds SIGINT, SIGTERM and beforeExit, once per process; close releases them', async () => {
    services();
    const before = listeners();
    const a = await secure();
    const one = {
      int: before.int + 1,
      term: before.term + 1,
      exit: before.exit + 1,
    };
    expect(listeners()).toEqual(one);
    const b = await secure();
    expect(listeners()).toEqual(one);
    await a.close();
    expect(listeners()).toEqual(one);
    await b.endAuthentication();
    expect(listeners()).toEqual(before);
  });

  test.each([
    ['a persistent store', async () => ({ store: persistentStore() })],
    ['shutdownHooks: false', async () => ({ shutdownHooks: false })],
  ])('none with %s', async (_, extra) => {
    services();
    const before = listeners();
    await secure(await extra());
    expect(listeners()).toEqual(before);
  });

  test('none with an API key given in credentials', async () => {
    const { backend } = services();
    const key = seedBackendKey(backend, { wallet: OWNER });
    const before = listeners();
    await secure({ credentials: { backend: { apiKey: key.key } } });
    expect(listeners()).toEqual(before);
  });

  test('when the process is about to exit normally, the 1-day key is revoked, once', async () => {
    type Listener = () => void;
    let onExit: Listener | undefined;
    const realOnce = process.once.bind(process);
    vi.spyOn(process, 'once').mockImplementation(((
      event: string,
      listener: Listener,
    ) => {
      if (event === 'beforeExit') {
        onExit = listener;
        return process;
      }
      return realOnce(event, listener);
    }) as typeof process.once);
    const realRemove = process.removeListener.bind(process);
    vi.spyOn(process, 'removeListener').mockImplementation(((
      event: string,
      listener: Listener,
    ) => {
      if (event === 'beforeExit') {
        if (onExit === listener) {
          onExit = undefined;
        }
        return process;
      }
      return realRemove(event, listener);
    }) as typeof process.removeListener);

    const { backend } = services();
    const client = await secure();
    const minted = backend.minted[0];
    expect(onExit).toBeDefined();
    const exit = onExit as Listener;
    // Node emits beforeExit again once the revoke is done; the hook runs once.
    exit();
    exit();
    await vi.waitFor(() => expect(minted?.record.revokedAt).not.toBeNull());
    expect(
      backend.calls.filter((c) => c === revokeOf(minted?.record.id as number)),
    ).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(client)).state).toBe('closed');
  });
});

// ---------------------------------------------------------------------------
// Rotating and exporting the credentials
// ---------------------------------------------------------------------------

describe('rotateCredentials() and exportCredentials()', () => {
  test('rotates the API key: a new one is used and the old one revoked', async () => {
    const { backend } = services();
    const client = await secure();
    const old = backend.minted[0];
    await client.rotateCredentials();
    expect(backend.minted).toHaveLength(2);
    expect(old?.record.revokedAt).not.toBeNull();
    expect((await client.exportCredentials()).backend?.apiKey).toBe(
      backend.minted[1]?.key,
    );
  });

  test('a key given in credentials is never rotated: credentials_provided', async () => {
    const { backend } = services();
    const key = seedBackendKey(backend, { wallet: OWNER });
    const client = await secure({
      credentials: { backend: { apiKey: key.key } },
    });
    const error = await caught(() => client.rotateCredentials());
    expect(error.code).toBe('credentials_provided');
    expect(key.record.revokedAt).toBeNull();
  });
});

describe('the guards', () => {
  test('a secure client is a secure client, not a public one; a copy is neither', async () => {
    services();
    const client = await secure();
    expect(isSecureClient(client)).toBe(true);
    expect(isPublicClient(client)).toBe(false);
    expect(isSecureClient({ ...client })).toBe(false);
  });
});
