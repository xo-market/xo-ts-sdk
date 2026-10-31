import { inspect } from 'node:util';
import { delay, HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { type Address, type Hex, recoverMessageAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage, type SiweMessage } from 'viem/siwe';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import {
  BackendAuth,
  type BackendAuthOptions,
  MintedKeyError,
} from '../../src/auth/backendAuth';
import type { BackendCredential } from '../../src/auth/store';
import {
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
import {
  resolveTradingIdentity,
  type TradingIdentity,
} from '../../src/wallet/identity';
import type { InternalSigner } from '../../src/wallet/signer';
import {
  API_KEYS_URL,
  type Backend,
  type BackendOptions,
  badRequest,
  DAY_MS,
  exceptionResponse,
  type Issued,
  installBackend as installMockBackend,
  invalidCredentials,
  invalidSignature,
  KEY_TYPE_MESSAGE,
  type KeyRecord,
  type NonceBody,
  OLD_WALLET_URL,
  SIGN_IN_STATEMENT,
} from '../helpers/mockBackend';
import { rejectedWith, serverFailure } from '../helpers/rejections';
import { keySigner } from '../helpers/signers';
import { testEnv } from '../helpers/testEnv';
import { clobAuthVector } from '../signing/helpers';

const env = testEnv;
const HOUR_MS = 3_600_000;
const CREATE_KEY_PATH = '/api/auth/api-keys';

// The public test vector key from test-vectors/clobAuth.json. Never fund it.
const VECTOR_KEY = clobAuthVector.inputs.privateKey;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

const installBackend = (options?: BackendOptions) =>
  installMockBackend(server, options);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const unusedRead = async (): Promise<Hex> => {
  throw new Error('the EOA identity reads nothing');
};

/** A transport with a provider that must never be asked for anything. */
function makeTransport(maxRetries?: number) {
  const provider = {
    headers: vi.fn(async () => ({ 'x-provider': 'must-not-be-sent' })),
    onUnauthorized: vi.fn(async () => true),
  };
  const transport = new Transport({
    env,
    version: '9.9.9',
    auth: provider,
    ...(maxRetries === undefined ? {} : { maxRetries }),
  });
  return Object.assign(transport, { provider });
}

/** Wraps a signer so a test can see exactly what it was asked to sign. */
function spied(signer: InternalSigner): {
  signer: InternalSigner;
  signMessage: ReturnType<typeof vi.fn<InternalSigner['signMessage']>>;
} {
  const signMessage = vi.fn<InternalSigner['signMessage']>((message) =>
    signer.signMessage(message),
  );
  return { signer: { ...signer, signMessage }, signMessage };
}

async function eoaRig(
  overrides: Partial<BackendAuthOptions> = {},
  wrapSigner: (signer: InternalSigner) => InternalSigner = (signer) => signer,
  maxRetries?: number,
) {
  const base = keySigner(VECTOR_KEY);
  const { signer: spiedSigner, signMessage } = spied(base);
  const signer = wrapSigner(spiedSigner);
  const identity = await resolveTradingIdentity(
    base,
    { type: 'eoa' },
    env,
    unusedRead,
  );
  const transport = makeTransport(maxRetries);
  const auth = new BackendAuth(transport, signer, identity, {
    env,
    persistent: true,
    ...overrides,
  });
  return { auth, transport, signer, signMessage, identity, base };
}

const pad32 = (address: string): Hex =>
  `0x${'00'.repeat(12)}${address.slice(2)}` as Hex;

async function smartWalletRig(
  index: number | bigint = 0,
  overrides: Partial<BackendAuthOptions> = {},
) {
  const ownerSigner = keySigner(generatePrivateKey());
  const account = privateKeyToAccount(generatePrivateKey()).address;
  const identity = await resolveTradingIdentity(
    ownerSigner,
    { type: 'smart_wallet', index },
    env,
    async () => pad32(account.toLowerCase()),
  );
  const { signer, signMessage } = spied(ownerSigner);
  const transport = makeTransport();
  const auth = new BackendAuth(transport, signer, identity, {
    env,
    persistent: true,
    ...overrides,
  });
  return {
    auth,
    transport,
    signer,
    signMessage,
    identity,
    owner: ownerSigner.address,
    account,
    backendOptions: {
      smartAccounts: {
        [account.toLowerCase()]: {
          owner: ownerSigner.address,
          index: BigInt(index),
        },
      },
    } satisfies BackendOptions,
  };
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

/** Everything a caller could print or log from an error. */
function shown(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && depth < 10; depth += 1) {
    if (current instanceof Error) {
      parts.push(
        current.name,
        current.message,
        current.stack ?? '',
        inspect(current, { depth: null, showHidden: true }),
      );
      try {
        parts.push(JSON.stringify(current));
      } catch {
        // not serialisable
      }
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join('\n');
}

function expectNoLeak(error: unknown, ...secrets: string[]): void {
  const text = shown(error);
  for (const secret of secrets) {
    expect(text).not.toContain(secret);
  }
}

/** The key bytes after `xo_sk_`: what a partial leak would contain. */
const secretPart = (key: string): string => key.split('_').slice(-1)[0] ?? key;

/** A real EIP-4361 message, as the backend would issue it unless `over` changes it. */
function siwe(address: Address, over: Partial<SiweMessage> = {}): string {
  return createSiweMessage({
    address,
    chainId: env.chainId,
    domain: env.siweDomain,
    uri: env.siweUri,
    nonce: 'abcd1234efgh5678',
    version: '1',
    statement: SIGN_IN_STATEMENT,
    issuedAt: new Date(),
    expirationTime: new Date(Date.now() + 300_000),
    ...over,
  });
}

/** A canonical message that is exactly `length` characters long (the nonce is padded). */
function siweOfLength(address: Address, length: number): string {
  const short = siwe(address);
  return siwe(address, {
    nonce: 'a'.repeat(16 + length - short.length),
  });
}

function credentialWith(over: Partial<BackendCredential>): BackendCredential {
  return {
    id: '7',
    key: 'xo_sk_data_ABCDEFGH_0123456789',
    prefix: 'ABCDEFGH',
    scopes: ['account:read', 'account:write'],
    expiresAt: '2030-01-01T00:00:00.000Z',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// login: EOA
// ---------------------------------------------------------------------------

describe('login (eoa)', () => {
  test('sends the nonce {address}, signs the returned message byte for byte, posts the exact body', async () => {
    const backend = installBackend();
    const { auth, signMessage, identity, base } = await eoaRig();

    const credential = await auth.login();

    // One key route, POST /api/auth/api-keys; the old /wallet path answers 404.
    expect(backend.calls).toEqual([
      'POST /api/auth/api-keys/nonce',
      'POST /api/auth/api-keys',
    ]);
    expect(backend.nonceBodies).toEqual([{ address: identity.address }]);
    const issued = backend.issued[0];
    expect(issued).toBeDefined();
    const message = (issued as Issued).message;
    expect(message).toContain('\n');
    expect(message).not.toContain('\r');

    // The handler received exactly the message the nonce response carried.
    expect(backend.walletBodies).toHaveLength(1);
    const body = backend.walletBodies[0] as Record<string, unknown>;
    expect(body.message).toBe(message);
    expect(signMessage).toHaveBeenCalledTimes(1);
    expect(signMessage).toHaveBeenCalledWith(message);

    // The type names the proof; signatureType is not a field any more (400).
    expect(body.type).toBe('eoa');
    expect(body).not.toHaveProperty('signatureType');
    expect(body.scopes).toEqual(['account:read', 'account:write']);
    expect(body.expiresInDays).toBe(90);
    // Exactly these fields: the mock answers 400 to any other field, as the backend does, so
    // a login that succeeded sent no unknown field, and none of signer or index (EOA).
    expect(Object.keys(body).sort()).toEqual([
      'expiresInDays',
      'message',
      'name',
      'scopes',
      'signature',
      'type',
    ]);

    // The signature is the owner's EIP-191 signature of that message.
    await expect(
      recoverMessageAddress({
        message,
        signature: body.signature as Hex,
      }),
    ).resolves.toBe(base.address);
    expect(body.signature).toMatch(/^0x[0-9a-f]{130}$/);

    // The credential is the minted key.
    const minted = backend.minted[0];
    expect(credential).toEqual({
      id: String(minted?.record.id),
      key: minted?.key,
      prefix: minted?.record.prefix,
      scopes: ['account:read', 'account:write'],
      expiresAt: minted?.record.expiresAt,
    });
    expect(typeof credential.id).toBe('string');
    expect(Object.keys(credential).sort()).toEqual([
      'expiresAt',
      'id',
      'key',
      'prefix',
      'scopes',
    ]);
  });

  test('the nonce and wallet requests carry no credentials and the provider is never asked', async () => {
    const backend = installBackend();
    const { auth, transport } = await eoaRig();
    await auth.login();
    expect(backend.nonceAuth).toEqual([null]);
    expect(backend.walletAuth).toEqual([null]);
    expect(transport.provider.headers).not.toHaveBeenCalled();
    expect(transport.provider.onUnauthorized).not.toHaveBeenCalled();
  });

  test('signs a canonical message with a long nonce exactly as it came', async () => {
    const backend = installBackend();
    const { auth, signMessage, identity, base } = await eoaRig();
    const message = siwe(identity.address, { nonce: 'Zz09'.repeat(50) });
    backend.nonceHook = (nonce) => ({ ...nonce, message });
    await auth.login();
    expect(signMessage).toHaveBeenCalledWith(message);
    expect(backend.walletBodies[0]?.message).toBe(message);
    await expect(
      recoverMessageAddress({
        message,
        signature: backend.walletBodies[0]?.signature as Hex,
      }),
    ).resolves.toBe(base.address);
  });

  test('accepts a nonce address in another letter case', async () => {
    const backend = installBackend();
    backend.nonceHook = (nonce) => ({
      ...nonce,
      address: String(nonce.address).toLowerCase(),
    });
    const { auth } = await eoaRig();
    await expect(auth.login()).resolves.toMatchObject({
      prefix: expect.any(String),
    });
  });

  test('name is xo-sdk:default:<yyyymmdd> and a label replaces default', async () => {
    const backend = installBackend();
    const first = await eoaRig();
    await first.auth.login();
    expect(backend.walletBodies[0]?.name).toMatch(/^xo-sdk:default:\d{8}$/);

    const second = await eoaRig({ label: 'market-maker_1.v2-a' });
    await second.auth.login();
    expect(backend.walletBodies[1]?.name).toMatch(
      /^xo-sdk:market-maker_1\.v2-a:\d{8}$/,
    );
  });

  test('the date in the name is the UTC date of o.now', async () => {
    const backend = installBackend();
    const cases: Array<[string, string]> = [
      ['2026-03-04T23:59:59.999Z', '20260304'],
      ['2026-03-05T00:00:00.000Z', '20260305'],
      // 23:30 at UTC-5 is already the next day in UTC.
      ['2026-12-31T23:30:00-05:00', '20270101'],
      ['2026-01-01T00:30:00+05:00', '20251231'],
    ];
    for (const [at, expected] of cases) {
      const { auth } = await eoaRig({ now: () => new Date(at) });
      await auth.login();
      expect(backend.walletBodies.at(-1)?.name).toBe(
        `xo-sdk:default:${expected}`,
      );
    }
  });

  test.each([
    ['an invalid Date', () => new Date('not a date')],
    ['a number', () => Date.now()],
    ['undefined', () => undefined],
  ])(
    'a clock that returns %s fails before any request',
    async (_label, clock) => {
      const backend = installBackend();
      const { auth, signMessage } = await eoaRig({
        now: clock as unknown as () => Date,
      });
      await expect(auth.login()).rejects.toBeInstanceOf(UserInputError);
      expect(backend.calls).toEqual([]);
      expect(signMessage).not.toHaveBeenCalled();
    },
  );

  test('persistent: false asks for a 1-day key', async () => {
    const backend = installBackend();
    const { auth } = await eoaRig({ persistent: false });
    const credential = await auth.login();
    expect(backend.walletBodies[0]?.expiresInDays).toBe(1);
    const left = Date.parse(credential.expiresAt) - Date.now();
    expect(left).toBeGreaterThan(DAY_MS - 60_000);
    expect(left).toBeLessThanOrEqual(DAY_MS + 60_000);
  });

  test('login({ shortLived: true }) asks a persistent auth for a 1-day key; the next plain login asks for 90 days', async () => {
    const backend = installBackend();
    const { auth } = await eoaRig({ persistent: true });
    const short = await auth.login({ shortLived: true });
    const left = Date.parse(short.expiresAt) - Date.now();
    expect(left).toBeGreaterThan(DAY_MS - 60_000);
    expect(left).toBeLessThanOrEqual(DAY_MS + 60_000);
    await auth.login();
    await auth.login({ shortLived: false });
    expect(backend.walletBodies.map((b) => b.expiresInDays)).toEqual([
      1, 90, 90,
    ]);
  });

  test('a short-lived login keeps a key whose expiresAt is not ISO-8601 for 1 day', async () => {
    const NOW = new Date('2026-06-01T12:00:00.000Z');
    const backend = installBackend();
    backend.createdHook = (body) => ({ ...body, expiresAt: 'soon' });
    const { auth } = await eoaRig({ persistent: true, now: () => NOW });
    const credential = await auth.login({ shortLived: true });
    expect(credential.expiresAt).toBe(
      new Date(NOW.getTime() + DAY_MS).toISOString(),
    );
  });

  test('a shortLived option that is not a boolean is a UserInputError and nothing is requested', async () => {
    const backend = installBackend();
    const { auth, signMessage } = await eoaRig();
    for (const options of [{ shortLived: 'yes' }, 'short', null]) {
      await expect(auth.login(options as never)).rejects.toBeInstanceOf(
        UserInputError,
      );
    }
    expect(backend.calls).toEqual([]);
    expect(signMessage).not.toHaveBeenCalled();
  });

  test('the scopes option is sent as given, and is copied at construction', async () => {
    const backend = installBackend();
    const scopes: Array<'account:read' | 'account:write'> = ['account:read'];
    const { auth } = await eoaRig({ scopes });
    scopes.push('account:write');
    await auth.login();
    expect(backend.walletBodies[0]?.scopes).toEqual(['account:read']);
    expect(backend.minted[0]?.record.scopes).toEqual(['account:read']);
  });

  test('two logins mint two keys, each with its own single-use nonce', async () => {
    const backend = installBackend();
    const { auth } = await eoaRig();
    const a = await auth.login();
    const b = await auth.login();
    expect(a.key).not.toBe(b.key);
    expect(a.id).not.toBe(b.id);
    expect(backend.issued.map((i) => i.message)).toHaveLength(2);
    expect(backend.issued[0]?.message).not.toBe(backend.issued[1]?.message);
  });
});

// ---------------------------------------------------------------------------
// login: smart wallet
// ---------------------------------------------------------------------------

describe('login (smart_wallet)', () => {
  test('posts type smart_wallet with signer: owner and a string index; the owner signs plain EIP-191', async () => {
    const rig = await smartWalletRig(0);
    const backend = installBackend(rig.backendOptions);

    const credential = await rig.auth.login();

    // The nonce is for the smart wallet, not for the owner.
    expect(backend.nonceBodies).toEqual([{ address: rig.account }]);
    expect(rig.account).not.toBe(rig.owner);
    expect(backend.calls).toEqual([
      'POST /api/auth/api-keys/nonce',
      'POST /api/auth/api-keys',
    ]);

    const body = backend.walletBodies[0] as Record<string, unknown>;
    expect(body.type).toBe('smart_wallet');
    expect(body).not.toHaveProperty('signatureType');
    expect(body.signer).toBe(rig.owner);
    expect(body.index).toBe('0');
    expect(typeof body.index).toBe('string');
    expect(Object.keys(body).sort()).toEqual([
      'expiresInDays',
      'index',
      'message',
      'name',
      'scopes',
      'signature',
      'signer',
      'type',
    ]);

    const message = backend.issued[0]?.message as string;
    expect(body.message).toBe(message);
    expect(rig.signMessage).toHaveBeenCalledWith(message);
    // The signature recovers to the OWNER (not the smart wallet): plain
    // personal_sign, not ERC-1271.
    await expect(
      recoverMessageAddress({ message, signature: body.signature as Hex }),
    ).resolves.toBe(rig.owner);
    expect(credential.key).toBe(backend.minted[0]?.key);
  });

  test.each([
    [5, '5'],
    [5n, '5'],
    [Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)],
    [(1n << 256n) - 1n, ((1n << 256n) - 1n).toString()],
  ])('index %s is sent as the decimal string %s', async (index, expected) => {
    const rig = await smartWalletRig(index);
    const backend = installBackend(rig.backendOptions);
    await rig.auth.login();
    expect(backend.walletBodies[0]?.index).toBe(expected);
  });

  test('the nonce response must be for the smart wallet', async () => {
    const rig = await smartWalletRig(0);
    const backend = installBackend(rig.backendOptions);
    backend.nonceHook = (nonce) => ({ ...nonce, address: rig.owner });
    const error = await errorOf(rig.auth.login());
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(rig.signMessage).not.toHaveBeenCalled();
    expect(backend.walletBodies).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The key route of the fake, as the backend has it: the bodies the SDK
// must not send are refused there, so a login test that passes sent none of them.
// ---------------------------------------------------------------------------

describe('the key route of the fake backend', () => {
  const OWNER = '0x1234567890abcdef1234567890abcdef12345678';
  const valid = {
    message: 'example.test wants you to sign in with your Ethereum account:',
    signature: `0x${'11'.repeat(65)}`,
    name: 'xo-sdk:default:20261019',
    scopes: ['account:read'],
    expiresInDays: 1,
  };
  const post = (url: string, body: unknown) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  test.each([
    ['no type', valid, KEY_TYPE_MESSAGE],
    ['an unknown type', { ...valid, type: 'wallet' }, KEY_TYPE_MESSAGE],
    ['a type that is not a string', { ...valid, type: 0 }, KEY_TYPE_MESSAGE],
    [
      'signatureType with eoa',
      { ...valid, type: 'eoa', signatureType: 0 },
      'property signatureType should not exist',
    ],
    [
      'signatureType with smart_wallet',
      { ...valid, type: 'smart_wallet', signer: OWNER, signatureType: 3 },
      'property signatureType should not exist',
    ],
    [
      'signer with eoa',
      { ...valid, type: 'eoa', signer: OWNER },
      'property signer should not exist',
    ],
    [
      'index with eoa',
      { ...valid, type: 'eoa', index: '0' },
      'property index should not exist',
    ],
    [
      'smart_wallet without signer',
      { ...valid, type: 'smart_wallet', index: '0' },
      'signer must be 0x followed by 40 hex digits',
    ],
  ])(
    'a body with %s is a flat 400 and no proof is checked',
    async (_label, body, message) => {
      const backend = installBackend();
      const response = await post(API_KEYS_URL, body);
      expect(response.status).toBe(400);
      // The shape of the backend's validation 400: flat, message an array of strings.
      expect(await response.json()).toEqual({
        statusCode: 400,
        message: [message],
        error: 'Bad Request',
      });
      expect(backend.calls).toEqual(['POST /api/auth/api-keys']);
      expect(backend.walletBodies).toHaveLength(0);
    },
  );

  test('a body of either wallet type with its own fields passes the DTO check', async () => {
    const backend = installBackend();
    // A made-up proof: past the DTO, the same 401 as any other proof failure.
    for (const body of [
      { ...valid, type: 'eoa' },
      { ...valid, type: 'smart_wallet', signer: OWNER },
      { ...valid, type: 'smart_wallet', signer: OWNER, index: 7 },
    ]) {
      const response = await post(API_KEYS_URL, body);
      expect(response.status).toBe(401);
    }
    expect(backend.walletBodies).toHaveLength(3);
  });

  test('the removed POST /api/auth/api-keys/wallet answers 404', async () => {
    const backend = installBackend();
    const response = await post(OLD_WALLET_URL, {
      ...valid,
      signatureType: 0,
    });
    expect(response.status).toBe(404);
    expect(backend.calls).toEqual(['POST /api/auth/api-keys/wallet']);
    expect(backend.walletBodies).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The nonce response is checked before anything is signed
// ---------------------------------------------------------------------------

describe('nonce response checks', () => {
  async function expectRefused(
    change: (nonce: NonceBody) => NonceBody | Response,
  ): Promise<unknown> {
    const backend = installBackend();
    backend.nonceHook = change;
    const { auth, signMessage } = await eoaRig();
    const error = await errorOf(auth.login());
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(signMessage).not.toHaveBeenCalled();
    expect(backend.walletBodies).toHaveLength(0);
    expect(backend.calls).toEqual(['POST /api/auth/api-keys/nonce']);
    return error;
  }

  test('a nonce for a different address signs nothing and posts nothing', async () => {
    const other = privateKeyToAccount(generatePrivateKey()).address;
    await expectRefused((nonce) => ({ ...nonce, address: other }));
  });

  test('a nonce for a different chain signs nothing and posts nothing', async () => {
    const error = await expectRefused((nonce) => ({
      ...nonce,
      chainId: env.chainId + 1,
    }));
    // The message names the chain this client uses, never the one the server sent.
    expect((error as XoError).message).toContain(String(env.chainId));
    expect((error as XoError).message).not.toContain(String(env.chainId + 1));
  });

  test('a chain id as a string is not a match', async () => {
    await expectRefused((nonce) => ({
      ...nonce,
      chainId: String(env.chainId),
    }));
  });

  test.each([
    ['an empty message', ''],
    ['a message with a carriage return', 'line one\r\nline two'],
    ['a lone carriage return', 'line one\rline two'],
    ['a number', 42],
    ['null', null],
    ['an object', { text: 'x' }],
    ['no message at all', undefined],
  ])('%s signs nothing and posts nothing', async (_label, message) => {
    await expectRefused((nonce) => {
      const copy = { ...nonce, message } as Record<string, unknown>;
      if (message === undefined) {
        delete copy.message;
      }
      return copy as unknown as NonceBody;
    });
  });

  test('a canonical message of exactly 2000 characters is signed', async () => {
    const backend = installBackend();
    const { auth, signMessage, identity } = await eoaRig();
    const message = siweOfLength(identity.address, 2000);
    expect(message).toHaveLength(2000);
    backend.nonceHook = (nonce) => ({ ...nonce, message });
    await auth.login();
    expect(signMessage).toHaveBeenCalledWith(message);
  });

  test('a canonical message of 2001 characters is refused before signing', async () => {
    const backend = installBackend();
    const { auth, signMessage, identity } = await eoaRig();
    const message = siweOfLength(identity.address, 2001);
    expect(message).toHaveLength(2001);
    backend.nonceHook = (nonce) => ({ ...nonce, message });
    const error = await errorOf(auth.login());
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(signMessage).not.toHaveBeenCalled();
    expect(backend.walletBodies).toHaveLength(0);
  });

  test.each(['address', 'chainId', 'message'])(
    'a nonce response without %s is refused before signing',
    async (field) => {
      await expectRefused((nonce) => {
        const copy = { ...nonce } as Record<string, unknown>;
        delete copy[field];
        return copy as unknown as NonceBody;
      });
    },
  );

  test('fields the SDK does not read may be missing', async () => {
    const backend = installBackend();
    backend.nonceHook = (nonce) =>
      ({
        address: nonce.address,
        chainId: nonce.chainId,
        message: nonce.message,
      }) as NonceBody;
    const { auth } = await eoaRig();
    await expect(auth.login()).resolves.toBeDefined();
  });

  test.each([
    'nonce',
    'domain',
    'uri',
    'issuedAt',
    'expirationTime',
    'statement',
    'version',
  ])('a wrong-typed %s is refused before signing', async (field) => {
    await expectRefused(
      (nonce) => ({ ...nonce, [field]: 12345 }) as unknown as NonceBody,
    );
  });

  test('a body that is not an object is refused before signing', async () => {
    await expectRefused(() => HttpResponse.json(['nope']));
    await expectRefused(() => HttpResponse.json(null));
  });

  test('the error does not echo the received message', async () => {
    const backend = installBackend();
    backend.nonceHook = (nonce) => ({
      ...nonce,
      message: 'secret-looking\r\ntext',
    });
    const { auth } = await eoaRig();
    const error = await errorOf(auth.login());
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expectNoLeak(error, 'secret-looking');
  });

  test('strict responses reject a field the nonce schema does not know', async () => {
    const backend = installBackend();
    backend.nonceHook = (nonce) => ({ ...nonce, extra: 1 }) as NonceBody;
    const lenient = await eoaRig();
    await expect(lenient.auth.login()).resolves.toBeDefined();

    const strict = await eoaRig({ strictResponses: true });
    const error = await errorOf(strict.auth.login());
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(strict.signMessage).not.toHaveBeenCalled();
    expect(backend.walletBodies).toHaveLength(1);
  });

  test('a 429, a 503 and a 400 from the nonce route pass through and are not retried', async () => {
    const nonceUrlPath = '/api/auth/api-keys/nonce';
    for (const [status, respond, type] of [
      [
        429,
        () =>
          exceptionResponse(nonceUrlPath, 429, {
            message: 'ThrottlerException: Too Many Requests',
          }),
        RateLimitError,
      ],
      [
        503,
        () =>
          HttpResponse.json(
            {
              statusCode: 503,
              timestamp: new Date().toISOString(),
              path: nonceUrlPath,
            },
            { status: 503 },
          ),
        RequestRejectedError,
      ],
      [
        400,
        () =>
          exceptionResponse(nonceUrlPath, 400, {
            error: 'Bad Request',
            message: ['address must be 0x followed by 40 hex digits'],
          }),
        RequestRejectedError,
      ],
    ] as const) {
      const backend = installBackend();
      backend.nonceHook = respond;
      const { auth, signMessage } = await eoaRig();
      const error = await errorOf(auth.login());
      expect(error).toBeInstanceOf(type);
      expect((error as XoError).status).toBe(status);
      expect(backend.nonceBodies).toHaveLength(1);
      expect(signMessage).not.toHaveBeenCalled();
      server.resetHandlers();
    }
  });
});

// ---------------------------------------------------------------------------
// Only the canonical XO sign-in message is signed
// ---------------------------------------------------------------------------

describe('only the canonical XO sign-in message is signed', () => {
  /**
   * The nonce response keeps the right JSON side fields (address, chainId) but its
   * `message` is `makeMessage(address)`. Nothing may be signed and no wallet request sent.
   */
  async function expectNotSigned(
    makeMessage: (address: Address) => string,
    type: 'eoa' | 'smart_wallet' = 'eoa',
    /** A fragment of the reason the error names, to tell the checks apart. */
    reason?: string,
  ): Promise<unknown> {
    const rig = type === 'eoa' ? await eoaRig() : await smartWalletRig(0);
    const backend = installBackend(
      type === 'smart_wallet'
        ? (rig as { backendOptions: BackendOptions }).backendOptions
        : undefined,
    );
    const message = makeMessage(rig.identity.address);
    backend.nonceHook = (nonce) => ({ ...nonce, message });
    const error = await errorOf(rig.auth.login());
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(rig.signMessage).not.toHaveBeenCalled();
    expect(backend.walletBodies).toHaveLength(0);
    expect(backend.calls).toEqual(['POST /api/auth/api-keys/nonce']);
    if (reason !== undefined) {
      expect((error as XoError).message).toContain(reason);
    }
    // Which check failed may be named; the text of the message is not echoed.
    expectNoLeak(error, 'abcd1234efgh5678', 'Create an XO API key', message);
    return error;
  }

  test('a 32-character ASCII string (the size of a userOpHash) is not signed', async () => {
    await expectNotSigned(() => '0123456789abcdef0123456789abcdef');
  });

  test('a 0x-prefixed 32-byte hash as text is not signed', async () => {
    await expectNotSigned(() => `0x${'ab'.repeat(32)}`);
  });

  test('for a smart wallet, arbitrary text is not signed by the owner either', async () => {
    await expectNotSigned(
      () => '0123456789abcdef0123456789abcdef',
      'smart_wallet',
    );
  });

  test('for a smart wallet, a message for the owner instead of the smart wallet is not signed', async () => {
    const rig = await smartWalletRig(0);
    const backend = installBackend(rig.backendOptions);
    backend.nonceHook = (nonce) => ({ ...nonce, message: siwe(rig.owner) });
    await expect(rig.auth.login()).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
    expect(rig.signMessage).not.toHaveBeenCalled();
    expect(backend.walletBodies).toHaveLength(0);
  });

  test('a SIWE message for another address is not signed', async () => {
    const other = privateKeyToAccount(generatePrivateKey()).address;
    await expectNotSigned(() => siwe(other));
  });

  test('a SIWE message for another chain is not signed', async () => {
    const error = await expectNotSigned((address) =>
      siwe(address, { chainId: env.chainId + 1 }),
    );
    expect(String(error)).not.toContain(String(env.chainId + 1));
  });

  test.each([
    ['another domain', { domain: 'evil.example.com' }, 'another domain'],
    [
      'a look-alike domain',
      { domain: `${env.siweDomain}.evil.com` },
      'another domain',
    ],
    [
      'the domain with a port',
      { domain: `${env.siweDomain}:8443` },
      'another domain',
    ],
    ['another uri', { uri: 'https://evil.example.com' }, 'another URI'],
    [
      'the uri with a trailing slash',
      { uri: `${env.siweUri}/` },
      'another URI',
    ],
    [
      'the uri over http',
      { uri: env.siweUri.replace('https:', 'http:') },
      'another URI',
    ],
    ['another statement', { statement: 'Sign in to Evil.' }, 'statement'],
    [
      'the statement with a trailing space',
      { statement: `${SIGN_IN_STATEMENT} ` },
      'statement',
    ],
    ['no statement', { statement: undefined }, 'statement'],
    [
      'a Resources list',
      { resources: ['https://evil.example.com/x'] },
      'never sets',
    ],
    ['a Not Before time', { notBefore: new Date() }, 'never sets'],
    ['a Request ID', { requestId: 'abc' }, 'never sets'],
    ['a scheme', { scheme: 'https' }, 'never sets'],
    ['no Expiration Time', { expirationTime: undefined }, 'complete'],
  ] as Array<[string, Partial<SiweMessage>, string]>)(
    'a SIWE message with %s is not signed',
    async (_label, over, reason) => {
      await expectNotSigned((address) => siwe(address, over), 'eoa', reason);
    },
  );

  test.each([
    ['trailing text', (m: string) => `${m}\nTransfer all my funds.`],
    ['a trailing newline', (m: string) => `${m}\n`],
    ['a trailing space', (m: string) => `${m} `],
    ['text before it', (m: string) => `Please sign this.\n${m}`],
    ['a blank line inside', (m: string) => m.replace('\n\n', '\n\n\n')],
    ['CRLF line ends', (m: string) => m.replaceAll('\n', '\r\n')],
    ['another version', (m: string) => m.replace('Version: 1', 'Version: 2')],
    ['a short nonce', (m: string) => m.replace('abcd1234efgh5678', 'abc')],
    [
      'a lower-case address',
      (m: string) => m.replace(/0x[0-9a-fA-F]{40}/, (a) => a.toLowerCase()),
    ],
  ])('a valid SIWE message with %s is not signed', async (_label, change) => {
    await expectNotSigned((address) => change(siwe(address)));
  });

  test('the message is checked against the environment it was given, not a fixed one', async () => {
    const local = {
      ...env,
      siweDomain: 'localhost:3000',
      siweUri: 'http://localhost:3000',
    };
    // The backend issues for the environment's own domain; this client is configured for localhost.
    const refusing = await eoaRig({ env: local });
    installBackend();
    await expect(refusing.auth.login()).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
    expect(refusing.signMessage).not.toHaveBeenCalled();
    server.resetHandlers();

    // A backend that issues for localhost is accepted by the same configuration.
    const backend = installBackend();
    const accepting = await eoaRig({ env: local });
    backend.nonceHook = (nonce) => ({
      ...nonce,
      message: siwe(accepting.identity.address, {
        domain: local.siweDomain,
        uri: local.siweUri,
      }),
    });
    await expect(accepting.auth.login()).resolves.toBeDefined();
    expect(accepting.signMessage).toHaveBeenCalledTimes(1);
  });

  test('the genuine message the mock backend issues is signed', async () => {
    const backend = installBackend();
    const { auth, signMessage } = await eoaRig();
    await auth.login();
    expect(signMessage).toHaveBeenCalledTimes(1);
    expect(backend.issued[0]?.message).toContain(env.siweDomain);
    expect(backend.issued[0]?.message).toContain(SIGN_IN_STATEMENT);
  });
});

// ---------------------------------------------------------------------------
// The signature
// ---------------------------------------------------------------------------

describe('signature checks', () => {
  const signing =
    (sign: (message: string, real: InternalSigner) => Promise<unknown>) =>
    (real: InternalSigner): InternalSigner => ({
      ...real,
      signMessage: (message: string) => sign(message, real) as Promise<Hex>,
    });

  test.each([
    ['an empty string', '0x'],
    ['too short (64 bytes)', `0x${'ab'.repeat(64)}`],
    ['too long (66 bytes)', `0x${'ab'.repeat(66)}`],
    ['not hex', `0x${'zz'.repeat(65)}`],
    ['no 0x prefix', 'ab'.repeat(65)],
    ['a number', 12345],
    ['undefined', undefined],
    ['null', null],
  ])(
    '%s is a SigningError, sent nowhere, and not echoed',
    async (_label, bad) => {
      const backend = installBackend();
      const { auth } = await eoaRig(
        {},
        signing(async () => bad),
      );
      const error = await errorOf(auth.login());
      expect(error).toBeInstanceOf(SigningError);
      expect(backend.walletBodies).toHaveLength(0);
      expect(backend.calls).toEqual(['POST /api/auth/api-keys/nonce']);
      if (typeof bad === 'string' && bad.length > 6) {
        expectNoLeak(error, bad.slice(2, 40));
      }
    },
  );

  test('a recovery byte of 0 or 1 is sent as 27 or 28 and the backend accepts it', async () => {
    const backend = installBackend();
    let real: Hex | undefined;
    // Re-encode a genuine signature with the parity byte (0 or 1) instead of 27 or 28.
    const { auth } = await eoaRig(
      {},
      signing(async (message, signer) => {
        real = await signer.signMessage(message);
        return `${real.slice(0, -2)}${real.endsWith('1b') ? '00' : '01'}`;
      }),
    );
    await expect(auth.login()).resolves.toBeDefined();
    const sent = backend.walletBodies[0]?.signature as string;
    expect(sent).toBe(real);
    expect(['1b', '1c']).toContain(sent.slice(-2));
  });

  test('a signature that already ends in 1b or 1c is sent unchanged', async () => {
    const backend = installBackend();
    const { auth, base } = await eoaRig();
    await auth.login();
    const message = backend.issued[0]?.message as string;
    expect(backend.walletBodies[0]?.signature).toBe(
      await base.signMessage(message),
    );
  });

  test('a recovery byte that is none of 0, 1, 27, 28 is a SigningError', async () => {
    const backend = installBackend();
    const { auth } = await eoaRig(
      {},
      signing(async (message, real) => {
        const sig = await real.signMessage(message);
        return `${sig.slice(0, -2)}1d`;
      }),
    );
    const error = await errorOf(auth.login());
    expect(error).toBeInstanceOf(SigningError);
    expect(backend.walletBodies).toHaveLength(0);
  });

  test('an error thrown by the signer propagates unchanged and nothing is posted', async () => {
    const backend = installBackend();
    const boom = new XoError('user rejected', { code: 'user_rejected' });
    const { auth } = await eoaRig(
      {},
      signing(async () => {
        throw boom;
      }),
    );
    await expect(auth.login()).rejects.toBe(boom);
    expect(backend.walletBodies).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Failures of the wallet route
// ---------------------------------------------------------------------------

describe('login errors', () => {
  test('401 invalid_signature is a 401 rejection and is not retried', async () => {
    const backend = installBackend();
    backend.walletHook = () => invalidSignature();
    const { auth, transport } = await eoaRig();
    const error = await errorOf(auth.login());
    expect(error).toSatisfy(rejectedWith(401));
    expect((error as RequestRejectedError).code).toBe('invalid_signature');
    expect((error as RequestRejectedError).status).toBe(401);
    expect((error as RequestRejectedError).service).toBe('backend');
    expect(backend.walletBodies).toHaveLength(1);
    expect(transport.provider.onUnauthorized).not.toHaveBeenCalled();
  });

  // The backend's 409 with a message that says what to do.
  test('409 api_key_limit_reached is an actionable 409 rejection, and no revoke is attempted', async () => {
    const backend = installBackend();
    backend.limitReached = true;
    const { auth } = await eoaRig();

    const error = await errorOf(auth.login());

    expect(error).toSatisfy(rejectedWith(409));
    const failure = error as RequestRejectedError;
    expect(failure.code).toBe('api_key_limit_reached');
    expect(failure.status).toBe(409);
    expect(failure.service).toBe('backend');
    expect(failure.message).toMatch(/10 active/);
    expect(failure.message).toMatch(/expired|expire/i);
    expect(failure.message).toMatch(/revoked/i);
    expect(failure.message).toContain('persistent');
    expect(failure.message).toContain('fileStore');
    expect(failure.message).toContain('@xomarket/client/node');
    // A Privy web session may revoke any key with
    // DELETE /api/auth/api-keys/:id, but the website has no key-management page yet, so the
    // way out today is to ask XO or let keys expire. POST /api/auth/api-keys creates keys.
    expect(failure.message).toContain('website');
    expect(failure.message).toContain('Privy');
    expect(failure.message).toContain('DELETE /api/auth/api-keys/:id');
    expect(failure.message).toContain('no key-management page yet');
    expect(failure.message).toMatch(/ask XO/);
    expect(failure.message).toMatch(/can only revoke itself/);
    expect(failure.message).not.toContain('POST /api/auth/api-keys');

    // The proof that was sent is not echoed back.
    const signature = backend.walletBodies[0]?.signature as string;
    expectNoLeak(error, signature, signature.slice(2, 40));

    // Only the nonce and the wallet request were made. No list, no revoke.
    expect(backend.calls).toEqual([
      'POST /api/auth/api-keys/nonce',
      'POST /api/auth/api-keys',
    ]);
    expect(backend.keyAuth).toEqual([]);
  });

  test('a 409 with another code is still a 409 rejection', async () => {
    const backend = installBackend();
    backend.walletHook = () =>
      exceptionResponse(CREATE_KEY_PATH, 409, {
        error: 'something_else',
        message: 'conflict',
      });
    const { auth } = await eoaRig();
    const error = await errorOf(auth.login());
    expect(error).toSatisfy(rejectedWith(409));
    expect((error as XoError).code).toBe('something_else');
  });

  test('403 banned passes through as a 403 rejection', async () => {
    const backend = installBackend();
    backend.walletHook = () =>
      exceptionResponse(CREATE_KEY_PATH, 403, {
        error: 'Account Banned',
        message: 'Your account has been banned',
      });
    const { auth } = await eoaRig();
    const error = await errorOf(auth.login());
    expect(error).toSatisfy(rejectedWith(403));
    expect((error as XoError).status).toBe(403);
    expect(backend.walletBodies).toHaveLength(1);
  });

  test('a 503 without a code may have minted: MintedKeyError with the 503 as cause, not retried', async () => {
    const backend = installBackend();
    // The filter writes only statusCode, timestamp and path for a 5xx: no error code.
    backend.walletHook = () =>
      HttpResponse.json(
        {
          statusCode: 503,
          timestamp: new Date().toISOString(),
          path: CREATE_KEY_PATH,
        },
        { status: 503 },
      );
    const { auth } = await eoaRig();
    const error = await errorOf(auth.login());
    expect(error).toBeInstanceOf(MintedKeyError);
    expect((error as MintedKeyError).mayHaveMinted).toBe(true);
    expect((error as Error).cause).toSatisfy(serverFailure);
    expect((error as XoError).status).toBe(503);
    expect(backend.walletBodies).toHaveLength(1);
  });

  test('429 passes through as RateLimitError and is not retried', async () => {
    const backend = installBackend();
    backend.walletHook = () =>
      exceptionResponse(CREATE_KEY_PATH, 429, {
        message: 'ThrottlerException: Too Many Requests',
      });
    const { auth } = await eoaRig();
    const error = await errorOf(auth.login());
    expect(error).toBeInstanceOf(RateLimitError);
    expect(backend.walletBodies).toHaveLength(1);
  });

  test('a network failure on the wallet route may have minted: MintedKeyError with the TransportError as cause, not retried', async () => {
    const backend = installBackend();
    backend.walletHook = () => HttpResponse.error();
    const { auth } = await eoaRig();
    const error = await errorOf(auth.login());
    expect(error).toBeInstanceOf(MintedKeyError);
    expect((error as MintedKeyError).mayHaveMinted).toBe(true);
    expect((error as Error).cause).toBeInstanceOf(TransportError);
    expect(backend.walletBodies).toHaveLength(1);
    expect(backend.calls).toEqual([
      'POST /api/auth/api-keys/nonce',
      'POST /api/auth/api-keys',
    ]);
    // The message names the key route as it is now.
    expect((error as Error).message).toMatch(
      /^POST \/api\/auth\/api-keys failed \(/,
    );
    expect((error as Error).message).not.toContain('/wallet');
  });
});

// ---------------------------------------------------------------------------
// The wallet response
// ---------------------------------------------------------------------------

describe('wallet response', () => {
  /**
   * The minted key's id, which every failure after a successful 201 names so the user can
   * find and revoke the orphaned key. The key itself is never named.
   */
  function expectNamesKey(
    error: unknown,
    backend: Backend,
    index = backend.minted.length - 1,
  ): void {
    const minted = backend.minted[index];
    expect(minted).toBeDefined();
    const { key, record } = minted as { key: string; record: KeyRecord };
    expect((error as XoError).message).toContain(`API key id ${record.id}`);
    expectNoLeak(error, key, secretPart(key), record.prefix);
  }

  test('a key without the xo_sk_ prefix is refused, names the key id, and is never echoed', async () => {
    const backend = installBackend();
    backend.createdHook = (body) => ({
      ...body,
      key: 'sk_live_NOTOURKEY_zzz999',
    });
    const { auth } = await eoaRig();
    const error = await errorOf(auth.login());
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expectNamesKey(error, backend);
    expectNoLeak(error, 'NOTOURKEY', 'zzz999');
    // The message names the key route as it is now.
    expect((error as Error).message).toMatch(
      /^Unexpected backend response for \/api\/auth\/api-keys: key: /,
    );
  });

  test.each([
    ['a space', 'xo_sk_data_ab cd_NOTOURKEY'],
    ['a newline', 'xo_sk_data_abcd_NOTOURKEY\n'],
    ['a tab', 'xo_sk_data_abcd\t_NOTOURKEY'],
    ['non-ASCII', 'xo_sk_data_abcd_\u00e9NOTOURKEY'],
    ['only the prefix', 'xo_sk_'],
  ])(
    'a key with %s fails the same key pattern as the transport',
    async (_label, key) => {
      const backend = installBackend();
      backend.createdHook = (body) => ({ ...body, key });
      const { auth } = await eoaRig();
      const error = await errorOf(auth.login());
      expect(error).toBeInstanceOf(UnexpectedResponseError);
      expectNamesKey(error, backend);
      expectNoLeak(error, 'NOTOURKEY');
    },
  );

  test.each([
    [
      'a missing key',
      (b: Record<string, unknown>) => ({ ...b, key: undefined }),
    ],
    ['a numeric key', (b: Record<string, unknown>) => ({ ...b, key: 12345 })],
    ['an empty key', (b: Record<string, unknown>) => ({ ...b, key: '' })],
  ])('%s is refused and names the key id', async (_label, change) => {
    const backend = installBackend();
    backend.createdHook = change;
    const { auth } = await eoaRig();
    const error = await errorOf(auth.login());
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as XoError).message).toContain(
      `API key id ${backend.minted[0]?.record.id}`,
    );
  });

  test.each([
    ['prefix', (b: Record<string, unknown>) => ({ ...b, prefix: 7 })],
    [
      'scopes',
      (b: Record<string, unknown>) => ({ ...b, scopes: 'account:read' }),
    ],
    [
      'expiresAt',
      (b: Record<string, unknown>) => ({ ...b, expiresAt: 20300101 }),
    ],
  ])(
    'a wrong-typed %s is refused, names the key id, and does not echo the key',
    async (_field, change) => {
      const backend = installBackend();
      backend.createdHook = change;
      const { auth } = await eoaRig();
      const error = await errorOf(auth.login());
      expect(error).toBeInstanceOf(UnexpectedResponseError);
      expectNamesKey(error, backend);
    },
  );

  test('a wrong-typed id is refused; the id is not known, so none is named', async () => {
    const backend = installBackend();
    backend.createdHook = (b) => ({ ...b, id: '7' });
    const { auth } = await eoaRig();
    const error = await errorOf(auth.login());
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as XoError).message).not.toContain('API key id');
    const minted = backend.minted[0]?.key as string;
    expectNoLeak(error, minted, secretPart(minted));
  });

  test('a response that is not an object is refused and names no id', async () => {
    const backend = installBackend();
    backend.createdHook = () => 'nope' as unknown as Record<string, unknown>;
    const { auth } = await eoaRig();
    const error = await errorOf(auth.login());
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as XoError).message).not.toContain('API key id');
  });

  // Lenient mode reads five fields (id, prefix, scopes, expiresAt, key). A field it never
  // reads cannot be allowed to discard a key that is already minted and counts toward the 10.
  describe('fields the SDK never reads', () => {
    const wrongTyped: Array<[string, Record<string, unknown>]> = [
      ['name', { name: 12345 }],
      ['lastUsedAt', { lastUsedAt: 5 }],
      ['lastUsedIp', { lastUsedIp: 5 }],
      ['revokedAt', { revokedAt: 5 }],
      ['createdVia', { createdVia: 7 }],
      ['createdAt', { createdAt: 5 }],
      [
        'all of them at once',
        { name: 1, lastUsedAt: 1, createdVia: 1, createdAt: 1 },
      ],
    ];

    test.each(wrongTyped)(
      'a wrong-typed %s does not discard the minted key in lenient mode',
      async (_label, change) => {
        const backend = installBackend();
        backend.createdHook = (body) => ({ ...body, ...change });
        const { auth } = await eoaRig();
        const credential = await auth.login();
        const minted = backend.minted[0];
        expect(credential).toEqual({
          id: String(minted?.record.id),
          key: minted?.key,
          prefix: minted?.record.prefix,
          scopes: ['account:read', 'account:write'],
          expiresAt: minted?.record.expiresAt,
        });
      },
    );

    test.each(wrongTyped)(
      'a wrong-typed %s is a response error in strict mode, and names the key id',
      async (_label, change) => {
        const backend = installBackend();
        backend.createdHook = (body) => ({ ...body, ...change });
        const { auth } = await eoaRig({ strictResponses: true });
        const error = await errorOf(auth.login());
        expect(error).toBeInstanceOf(UnexpectedResponseError);
        expectNamesKey(error, backend);
      },
    );
  });

  // The key is already minted and counts toward the 10, so refusing it would leak
  // an active key nobody tracks. Lenient mode keeps it with the requested lifetime.
  describe('an expiresAt that is not an ISO-8601 time', () => {
    const NOW = new Date('2026-06-01T12:00:00.000Z');
    const cases: Array<[string, string]> = [
      ['empty', ''],
      ['text', 'tomorrow-ish'],
      ['a bare number', '3'],
      ['an impossible date', '2026-13-45T00:00:00.000Z'],
      ['a date without a time', '2026-09-01'],
      ['a US date', '12/31/2999'],
    ];

    test.each(cases)(
      'lenient: %s keeps the key and sets now + the requested days',
      async (_label, expiresAt) => {
        for (const [persistent, days] of [
          [true, 90],
          [false, 1],
        ] as const) {
          const backend = installBackend();
          backend.createdHook = (body) => ({ ...body, expiresAt });
          const { auth } = await eoaRig({ persistent, now: () => NOW });

          const credential = await auth.login();

          const minted = backend.minted.at(-1);
          expect(credential).toEqual({
            id: String(minted?.record.id),
            key: minted?.key,
            prefix: minted?.record.prefix,
            scopes: ['account:read', 'account:write'],
            expiresAt: new Date(NOW.getTime() + days * DAY_MS).toISOString(),
          });
          expect(backend.walletBodies.at(-1)?.expiresInDays).toBe(days);
          // The local expiry is a usable ISO time: no rotation at the start.
          expect(auth.needsRotation(credential)).toBe(false);
          server.resetHandlers();
        }
      },
    );

    test.each(cases)(
      'strict: %s throws and does not echo the key',
      async (_label, expiresAt) => {
        const backend = installBackend();
        backend.createdHook = (body) => ({ ...body, expiresAt });
        const { auth } = await eoaRig({ strictResponses: true });
        const error = await errorOf(auth.login());
        expect(error).toBeInstanceOf(UnexpectedResponseError);
        expectNamesKey(error, backend);
      },
    );

    test('a valid ISO expiresAt from the backend is used as it is, in both modes', async () => {
      for (const strictResponses of [false, true]) {
        const backend = installBackend();
        const { auth } = await eoaRig({ strictResponses, now: () => NOW });
        const credential = await auth.login();
        expect(credential.expiresAt).toBe(backend.minted[0]?.record.expiresAt);
        server.resetHandlers();
      }
    });

    test('a wrong-typed expiresAt is still a response error in both modes', async () => {
      for (const strictResponses of [false, true]) {
        const backend = installBackend();
        backend.createdHook = (body) => ({ ...body, expiresAt: 20300101 });
        const { auth } = await eoaRig({ strictResponses });
        await expect(auth.login()).rejects.toBeInstanceOf(
          UnexpectedResponseError,
        );
        expect(backend.minted).toHaveLength(1);
        server.resetHandlers();
      }
    });
  });

  test('fields the SDK does not use may be missing (the key is already minted)', async () => {
    const backend = installBackend();
    backend.createdHook = (body) => {
      const copy = { ...body };
      for (const field of [
        'name',
        'lastUsedAt',
        'lastUsedIp',
        'revokedAt',
        'createdVia',
        'createdAt',
      ]) {
        delete copy[field];
      }
      return copy;
    };
    const { auth } = await eoaRig();
    const credential = await auth.login();
    expect(credential.key).toBe(backend.minted[0]?.key);
  });

  test('unknown fields are ignored by default and rejected with strictResponses', async () => {
    const backend = installBackend();
    backend.createdHook = (body) => ({ ...body, brandNew: true });

    const lenient = await eoaRig();
    const credential = await lenient.auth.login();
    expect(credential).not.toHaveProperty('brandNew');

    const strict = await eoaRig({ strictResponses: true });
    const error = await errorOf(strict.auth.login());
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expectNamesKey(error, backend);
  });

  test('strictResponses accepts the full, real response shape', async () => {
    installBackend();
    const { auth } = await eoaRig({ strictResponses: true });
    await expect(auth.login()).resolves.toBeDefined();
  });

  test('strictResponses rejects a scope the SDK does not know', async () => {
    const backend = installBackend();
    backend.createdHook = (body) => ({
      ...body,
      scopes: ['account:read', 'admin:all'],
    });
    const lenient = await eoaRig();
    await expect(lenient.auth.login()).resolves.toMatchObject({
      scopes: ['account:read', 'admin:all'],
    });
    const strict = await eoaRig({ strictResponses: true });
    await expect(strict.auth.login()).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('list', () => {
  test("GET /api/auth/api-keys with the key's own Authorization header; newest first, mapped", async () => {
    const backend = installBackend();
    const { auth, transport } = await eoaRig();
    const older = await auth.login();
    const newer = await auth.login();
    // Revoke the older key from the backend side to see a revoked row.
    const olderRecord = backend.keys.get(older.key) as KeyRecord;
    olderRecord.revokedAt = '2026-02-02T00:00:00.000Z';

    const items = await auth.list(newer);

    expect(backend.keyAuth).toEqual([`Bearer ${newer.key}`]);
    expect(backend.calls.at(-1)).toBe('GET /api/auth/api-keys');
    expect(items).toEqual([
      {
        id: newer.id,
        name: backend.keys.get(newer.key)?.name,
        prefix: newer.prefix,
        expiresAt: newer.expiresAt,
        revokedAt: null,
      },
      {
        id: older.id,
        name: olderRecord.name,
        prefix: older.prefix,
        expiresAt: older.expiresAt,
        revokedAt: '2026-02-02T00:00:00.000Z',
      },
    ]);
    for (const item of items) {
      expect(typeof item.id).toBe('string');
      expect(Object.keys(item).sort()).toEqual([
        'expiresAt',
        'id',
        'name',
        'prefix',
        'revokedAt',
      ]);
    }
    expect(JSON.stringify(items)).not.toContain(newer.key);
    expect(JSON.stringify(items)).not.toContain(older.key);
    // The explicit key bypasses the provider.
    expect(transport.provider.headers).not.toHaveBeenCalled();
    expect(transport.provider.onUnauthorized).not.toHaveBeenCalled();
  });

  test('an empty list is an empty array', async () => {
    installBackend();
    server.use(http.get(API_KEYS_URL, () => HttpResponse.json([])));
    const { auth } = await eoaRig();
    await expect(auth.list(credentialWith({}))).resolves.toEqual([]);
  });

  test('a revoked key gets a 401 rejection and no re-login', async () => {
    const backend = installBackend();
    const { auth, transport } = await eoaRig();
    const credential = await auth.login();
    (backend.keys.get(credential.key) as KeyRecord).revokedAt = 'x';
    const error = await errorOf(auth.list(credential));
    expect(error).toSatisfy(rejectedWith(401));
    expect((error as RequestRejectedError).code).toBe('invalid_credentials');
    expect(transport.provider.onUnauthorized).not.toHaveBeenCalled();
    expect(backend.calls.filter((c) => c.endsWith('/nonce'))).toHaveLength(1);
  });

  test('a key without account:read gets a 403 rejection', async () => {
    installBackend();
    const { auth } = await eoaRig({ scopes: ['account:write'] });
    const credential = await auth.login();
    const error = await errorOf(auth.list(credential));
    expect(error).toSatisfy(rejectedWith(403));
    expect((error as XoError).code).toBe('insufficient_scope');
  });

  test('a malformed list is an UnexpectedResponseError that does not echo the key', async () => {
    installBackend();
    const credential = credentialWith({});
    server.use(http.get(API_KEYS_URL, () => HttpResponse.json({ items: [] })));
    const { auth } = await eoaRig();
    const error = await errorOf(auth.list(credential));
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expectNoLeak(error, credential.key, secretPart(credential.key));
  });

  test('an item with a wrong-typed field is refused', async () => {
    installBackend();
    server.use(
      http.get(API_KEYS_URL, () =>
        HttpResponse.json([
          { id: '1', name: 'a', prefix: 'p', expiresAt: 'x', revokedAt: null },
        ]),
      ),
    );
    const { auth } = await eoaRig();
    await expect(auth.list(credentialWith({}))).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });

  test('strictResponses rejects unknown fields in an item; lenient ignores them', async () => {
    installBackend();
    const row = {
      id: 1,
      name: 'a',
      prefix: 'p',
      scopes: ['account:read'],
      expiresAt: '2030-01-01T00:00:00.000Z',
      lastUsedAt: null,
      lastUsedIp: null,
      revokedAt: null,
      createdVia: 'wallet_signature',
      createdAt: '2029-01-01T00:00:00.000Z',
      surprise: true,
    };
    server.use(http.get(API_KEYS_URL, () => HttpResponse.json([row])));
    const lenient = await eoaRig();
    await expect(lenient.auth.list(credentialWith({}))).resolves.toEqual([
      {
        id: '1',
        name: 'a',
        prefix: 'p',
        expiresAt: '2030-01-01T00:00:00.000Z',
        revokedAt: null,
      },
    ]);
    const strict = await eoaRig({ strictResponses: true });
    await expect(strict.auth.list(credentialWith({}))).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });

  test('a key that is not an xo_sk_ key is a UserInputError that sends nothing and does not echo it', async () => {
    const backend = installBackend();
    const { auth } = await eoaRig();
    const error = await errorOf(
      auth.list(credentialWith({ key: 'not-a-real-key-LEAKME' })),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect(backend.calls).toEqual([]);
    expectNoLeak(error, 'LEAKME');
  });

  test('a non-object credential is a UserInputError', async () => {
    installBackend();
    const { auth } = await eoaRig();
    for (const bad of [undefined, null, 'xo_sk_data_x', 42]) {
      await expect(
        auth.list(bad as unknown as BackendCredential),
      ).rejects.toBeInstanceOf(UserInputError);
    }
  });

  test('a read is retried on a 503 with the same key', async () => {
    installBackend();
    const credential = credentialWith({});
    const seen: Array<string | null> = [];
    let calls = 0;
    server.use(
      http.get(API_KEYS_URL, ({ request }) => {
        seen.push(request.headers.get('authorization'));
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ statusCode: 503 }, { status: 503 })
          : HttpResponse.json([]);
      }),
    );
    const { auth } = await eoaRig();
    await expect(auth.list(credential)).resolves.toEqual([]);
    expect(seen).toEqual([
      `Bearer ${credential.key}`,
      `Bearer ${credential.key}`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// revoke
// ---------------------------------------------------------------------------

describe('revoke', () => {
  test("uses the key's own Authorization header and resolves with nothing", async () => {
    const backend = installBackend();
    const { auth, transport } = await eoaRig();
    const credential = await auth.login();

    await expect(auth.revoke(credential)).resolves.toBeUndefined();

    expect(backend.keyAuth).toEqual([`Bearer ${credential.key}`]);
    expect(backend.calls.at(-1)).toBe(
      `DELETE /api/auth/api-keys/${credential.id}`,
    );
    expect(backend.keys.get(credential.key)?.revokedAt).not.toBeNull();
    expect(transport.provider.headers).not.toHaveBeenCalled();
    expect(transport.provider.onUnauthorized).not.toHaveBeenCalled();
    // The revoked key no longer works.
    await expect(auth.list(credential)).rejects.toSatisfy(rejectedWith(401));
  });

  test('during a rotation the old key revokes itself while the new one stays valid', async () => {
    const backend = installBackend();
    const { auth } = await eoaRig();
    const oldKey = await auth.login();
    const newKey = await auth.login();

    await auth.revoke(oldKey);

    expect(backend.keyAuth.at(-1)).toBe(`Bearer ${oldKey.key}`);
    expect(backend.keys.get(oldKey.key)?.revokedAt).not.toBeNull();
    expect(backend.keys.get(newKey.key)?.revokedAt).toBeNull();
    await expect(auth.list(newKey)).resolves.toHaveLength(2);
  });

  test('a key cannot revoke another key: the 403 passes through', async () => {
    installBackend();
    const { auth } = await eoaRig();
    const a = await auth.login();
    const b = await auth.login();
    const error = await errorOf(auth.revoke({ ...a, id: b.id }));
    expect(error).toSatisfy(rejectedWith(403));
    expect((error as XoError).code).toBe('api_key_can_only_revoke_itself');
  });

  // The key is unusable either way, so the goal of revoke() is met.
  test('resolves when the backend answers 401 invalid_credentials (already revoked)', async () => {
    const backend = installBackend();
    const { auth } = await eoaRig();
    const credential = await auth.login();
    await auth.revoke(credential);
    // The second call authenticates with a revoked key: 401 invalid_credentials.
    await expect(auth.revoke(credential)).resolves.toBeUndefined();
    expect(backend.calls.filter((c) => c.startsWith('DELETE'))).toHaveLength(2);
  });

  test('resolves for a key the backend does not know (401 invalid_credentials)', async () => {
    installBackend();
    const { auth } = await eoaRig();
    await expect(
      auth.revoke(credentialWith({ id: '55' })),
    ).resolves.toBeUndefined();
  });

  test('a lost 204 followed by the retry (401 invalid_credentials) resolves', async () => {
    const backend = installBackend();
    const { auth } = await eoaRig();
    const credential = await auth.login();
    let hits = 0;
    server.use(
      http.delete(`${API_KEYS_URL}/:id`, ({ request }) => {
        hits += 1;
        if (hits === 1) {
          // The backend revokes the key, but the answer never arrives.
          (backend.keys.get(credential.key) as KeyRecord).revokedAt = 'now';
          return HttpResponse.error();
        }
        return invalidCredentials(new URL(request.url).pathname);
      }),
    );
    await expect(auth.revoke(credential)).resolves.toBeUndefined();
    expect(hits).toBe(2);
  });

  test('a 401 with another code is still a 401 rejection', async () => {
    installBackend();
    server.use(
      http.delete(`${API_KEYS_URL}/55`, () =>
        exceptionResponse('/api/auth/api-keys/55', 401, {
          error: 'authentication_required',
          message: 'Authentication required',
        }),
      ),
    );
    const { auth } = await eoaRig();
    const error = await errorOf(auth.revoke(credentialWith({ id: '55' })));
    expect(error).toSatisfy(rejectedWith(401));
    expect((error as RequestRejectedError).code).toBe(
      'authentication_required',
    );
  });

  test.each([
    '',
    '0',
    '-1',
    '01',
    '1.5',
    '1e3',
    '+1',
    ' 1',
    '1 ',
    'abc',
    '1/2',
    '../1',
    '1?x=1',
    '1#x',
    '2147483648',
    '9999999999',
    '12345678901',
  ])('id %j is refused before any request', async (id) => {
    const backend = installBackend();
    const { auth } = await eoaRig();
    const credential = credentialWith({ id });
    const error = await errorOf(auth.revoke(credential));
    expect(error).toBeInstanceOf(UserInputError);
    expect(backend.calls).toEqual([]);
    expectNoLeak(error, credential.key, secretPart(credential.key));
  });

  test.each(['1', '9', '10', '2147483647', '1000000000'])(
    'id %s is accepted',
    async (id) => {
      installBackend();
      let path = '';
      server.use(
        http.delete(`${API_KEYS_URL}/:id`, ({ request }) => {
          path = new URL(request.url).pathname;
          return new HttpResponse(null, { status: 204 });
        }),
      );
      const { auth } = await eoaRig();
      await auth.revoke(credentialWith({ id }));
      expect(path).toBe(`/api/auth/api-keys/${id}`);
    },
  );

  test("revoke is idempotent, so it is retried (retry: 'read') with the same key", async () => {
    installBackend();
    const credential = credentialWith({ id: '55' });
    const seen: Array<string | null> = [];
    let calls = 0;
    server.use(
      http.delete(`${API_KEYS_URL}/55`, ({ request }) => {
        seen.push(request.headers.get('authorization'));
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ statusCode: 503 }, { status: 503 })
          : new HttpResponse(null, { status: 204 });
      }),
    );
    const { auth } = await eoaRig();
    await expect(auth.revoke(credential)).resolves.toBeUndefined();
    expect(seen).toEqual([
      `Bearer ${credential.key}`,
      `Bearer ${credential.key}`,
    ]);
  });

  test('a 404 passes through', async () => {
    installBackend();
    server.use(
      http.delete(`${API_KEYS_URL}/55`, () =>
        HttpResponse.json(
          { statusCode: 404, message: 'Not Found' },
          { status: 404 },
        ),
      ),
    );
    const { auth } = await eoaRig();
    const error = await errorOf(auth.revoke(credentialWith({ id: '55' })));
    expect((error as XoError).status).toBe(404);
  });

  test('a bad key is a UserInputError that sends nothing and does not echo it', async () => {
    const backend = installBackend();
    const { auth } = await eoaRig();
    const error = await errorOf(
      auth.revoke(credentialWith({ key: 'xo_sk_data bad key LEAKME' })),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect(backend.calls).toEqual([]);
    expectNoLeak(error, 'LEAKME');
  });

  test('a non-object credential or a non-string id is a UserInputError', async () => {
    installBackend();
    const { auth } = await eoaRig();
    for (const bad of [
      undefined,
      null,
      7,
      credentialWith({ id: 7 as never }),
    ]) {
      await expect(
        auth.revoke(bad as unknown as BackendCredential),
      ).rejects.toBeInstanceOf(UserInputError);
    }
  });
});

// ---------------------------------------------------------------------------
// needsRotation
// ---------------------------------------------------------------------------

describe('needsRotation', () => {
  const NOW = new Date('2026-06-01T12:00:00.000Z');
  const left = (ms: number): BackendCredential =>
    credentialWith({ expiresAt: new Date(NOW.getTime() + ms).toISOString() });

  async function auth(persistent: boolean, now: () => Date = () => NOW) {
    const rig = await eoaRig({ persistent, now });
    return rig.auth;
  }

  test('persistent: true at 6 days left', async () => {
    expect((await auth(true)).needsRotation(left(6 * DAY_MS))).toBe(true);
  });

  test('persistent: true at 7 days left or more is not due', async () => {
    const a = await auth(true);
    expect(a.needsRotation(left(7 * DAY_MS))).toBe(false);
    expect(a.needsRotation(left(7 * DAY_MS + 1))).toBe(false);
    expect(a.needsRotation(left(90 * DAY_MS))).toBe(false);
    expect(a.needsRotation(left(7 * DAY_MS - 1))).toBe(true);
  });

  test('short-lived at 1 hour left', async () => {
    expect((await auth(false)).needsRotation(left(HOUR_MS))).toBe(true);
  });

  test('short-lived at 2 hours left or more is not due', async () => {
    const a = await auth(false);
    expect(a.needsRotation(left(2 * HOUR_MS))).toBe(false);
    expect(a.needsRotation(left(2 * HOUR_MS - 1))).toBe(true);
    expect(a.needsRotation(left(23 * HOUR_MS))).toBe(false);
  });

  test('the threshold depends on the mode: 6 days is fine short-lived, 1 hour is not fine persistent', async () => {
    expect((await auth(false)).needsRotation(left(6 * DAY_MS))).toBe(false);
    expect((await auth(true)).needsRotation(left(HOUR_MS))).toBe(true);
  });

  test('a short-lived key in a persistent store is judged by the 2-hour window', async () => {
    const a = await auth(true);
    const short = { shortLived: true };
    expect(a.needsRotation(left(3 * HOUR_MS), short)).toBe(false);
    expect(a.needsRotation(left(2 * HOUR_MS), short)).toBe(false);
    expect(a.needsRotation(left(2 * HOUR_MS - 1), short)).toBe(true);
    expect(a.needsRotation(left(-DAY_MS), short)).toBe(true);
    // Without the option, the persistent window applies.
    expect(a.needsRotation(left(3 * HOUR_MS))).toBe(true);
    expect(a.needsRotation(left(3 * HOUR_MS), { shortLived: false })).toBe(
      true,
    );
  });

  test('an expired key needs rotation', async () => {
    for (const persistent of [true, false]) {
      const a = await auth(persistent);
      expect(a.needsRotation(left(0))).toBe(true);
      expect(a.needsRotation(left(-DAY_MS))).toBe(true);
    }
  });

  test.each([
    ['empty', ''],
    ['text', 'garbage'],
    ['a bare number', '3'],
    ['a US date', '12/31/2999'],
    ['an impossible date', '2999-13-45T00:00:00.000Z'],
    ['a date without a time', '2999-01-01'],
    ['undefined', undefined],
    ['null', null],
    ['a number', 32503680000000],
  ])('an expiresAt that is %s needs rotation', async (_label, expiresAt) => {
    for (const persistent of [true, false]) {
      const a = await auth(persistent);
      expect(
        a.needsRotation(credentialWith({ expiresAt: expiresAt as never })),
      ).toBe(true);
    }
  });

  test('accepts the ISO forms the backend can send', async () => {
    const a = await auth(true);
    expect(
      a.needsRotation(credentialWith({ expiresAt: '2999-01-01T00:00:00Z' })),
    ).toBe(false);
    expect(
      a.needsRotation(
        credentialWith({ expiresAt: '2999-01-01T00:00:00.123Z' }),
      ),
    ).toBe(false);
    expect(
      a.needsRotation(
        credentialWith({ expiresAt: '2999-01-01T00:00:00+02:00' }),
      ),
    ).toBe(false);
  });

  test('reads the clock through o.now on every call', async () => {
    let at = NOW;
    const a = await auth(true, () => at);
    const credential = left(10 * DAY_MS);
    expect(a.needsRotation(credential)).toBe(false);
    at = new Date(NOW.getTime() + 4 * DAY_MS);
    expect(a.needsRotation(credential)).toBe(true);
  });

  test('defaults to the real clock', async () => {
    const rig = await eoaRig({ persistent: true });
    const soon = new Date(Date.now() + 3 * DAY_MS).toISOString();
    const later = new Date(Date.now() + 30 * DAY_MS).toISOString();
    expect(rig.auth.needsRotation(credentialWith({ expiresAt: soon }))).toBe(
      true,
    );
    expect(rig.auth.needsRotation(credentialWith({ expiresAt: later }))).toBe(
      false,
    );
    const short = await eoaRig({ persistent: false });
    const oneHour = new Date(Date.now() + HOUR_MS).toISOString();
    expect(
      short.auth.needsRotation(credentialWith({ expiresAt: oneHour })),
    ).toBe(true);
  });

  test.each([
    ['an invalid Date', () => new Date('not a date')],
    ['a string', () => '2026-06-01T12:00:00.000Z'],
    ['a number', () => Date.now()],
    ['undefined', () => undefined],
    ['null', () => null],
    ['an object with getTime', () => ({ getTime: () => 0 })],
  ])(
    'a clock that returns %s needs rotation instead of throwing',
    async (_label, clock) => {
      for (const persistent of [true, false]) {
        const a = await auth(persistent, clock as unknown as () => Date);
        expect(a.needsRotation(left(365 * DAY_MS))).toBe(true);
      }
    },
  );

  test('makes no request', async () => {
    const backend = installBackend();
    const a = await auth(true);
    a.needsRotation(left(DAY_MS));
    expect(backend.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Options and identity are checked up front
// ---------------------------------------------------------------------------

describe('construction', () => {
  const build = async (over: Record<string, unknown>) => {
    const signer = keySigner(VECTOR_KEY);
    const identity = await resolveTradingIdentity(
      signer,
      { type: 'eoa' },
      env,
      unusedRead,
    );
    return () =>
      new BackendAuth(makeTransport(), signer, identity, {
        env,
        persistent: true,
        ...over,
      } as BackendAuthOptions);
  };

  test.each([
    ['empty', ''],
    ['65 characters', 'a'.repeat(65)],
    ['a space', 'my bot'],
    ['a colon', 'a:b'],
    ['a slash', 'a/b'],
    ['a newline', 'a\nb'],
    ['non-ASCII', 'b\u00f6t'],
    ['a path', '../x'],
    ['a number', 7],
    ['null', null],
  ])('a label with %s is a UserInputError', async (_name, label) => {
    const backend = installBackend();
    const make = await build({ label });
    expect(make).toThrow(UserInputError);
    expect(backend.calls).toEqual([]);
  });

  test('labels of 1 and 64 allowed characters are accepted', async () => {
    expect(await build({ label: 'a' })).not.toThrow();
    expect(
      await build({ label: 'Az09._-'.repeat(9).slice(0, 64) }),
    ).not.toThrow();
  });

  test.each([
    ['empty', []],
    ['a duplicate', ['account:read', 'account:read']],
    ['an unknown scope', ['account:read', 'admin']],
    ['only an unknown scope', ['admin']],
    ['not an array', 'account:read'],
    ['a non-string entry', [1]],
    ['null', null],
  ])('scopes that are %s are a UserInputError', async (_name, scopes) => {
    expect(await build({ scopes })).toThrow(UserInputError);
  });

  test.each([
    ['account:read'],
    ['account:write'],
    ['account:read', 'account:write'],
    ['account:write', 'account:read'],
  ])('scopes %j are accepted', async (...scopes) => {
    expect(await build({ scopes })).not.toThrow();
  });

  test.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    String(env.chainId),
    undefined,
    null,
  ])('env.chainId %s is a UserInputError', async (chainId) => {
    expect(await build({ env: { ...env, chainId } })).toThrow(UserInputError);
  });

  test.each([
    ['siweDomain', undefined],
    ['siweDomain', ''],
    ['siweDomain', 7],
    ['siweUri', undefined],
    ['siweUri', ''],
    ['siweUri', 7],
  ])('env.%s of %j is a UserInputError', async (field, value) => {
    expect(await build({ env: { ...env, [field]: value } })).toThrow(
      UserInputError,
    );
  });

  test.each([undefined, null, 'mainnet', 42])(
    'env %j is a UserInputError',
    async (value) => {
      expect(await build({ env: value })).toThrow(UserInputError);
    },
  );

  test('the full environment is accepted, and so is the test environment as a plain object', async () => {
    expect(await build({ env })).not.toThrow();
    expect(await build({ env: { ...env } })).not.toThrow();
  });

  test.each([undefined, null, 'yes', 1])(
    'persistent %s is a UserInputError',
    async (persistent) => {
      expect(await build({ persistent })).toThrow(UserInputError);
    },
  );

  test('now must be a function', async () => {
    expect(await build({ now: 'later' })).toThrow(UserInputError);
    expect(await build({ now: undefined })).not.toThrow();
  });

  test('a signer that is not the owner of the identity is refused, with nothing requested', async () => {
    const backend = installBackend();
    const owner = keySigner(VECTOR_KEY);
    const identity = await resolveTradingIdentity(
      owner,
      { type: 'eoa' },
      env,
      unusedRead,
    );
    const stranger = keySigner(generatePrivateKey());
    let error: unknown;
    try {
      new BackendAuth(makeTransport(), stranger, identity, {
        env,
        persistent: true,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).code).toBe('signer_mismatch');
    expect(backend.calls).toEqual([]);
  });

  test('a smart wallet identity without an index is refused', async () => {
    const owner = keySigner(VECTOR_KEY);
    const account = privateKeyToAccount(generatePrivateKey()).address;
    const identity = {
      type: 'smart_wallet',
      owner: owner.address,
      address: account,
      signatureType: 3,
    } as TradingIdentity;
    expect(
      () =>
        new BackendAuth(makeTransport(), owner, identity, {
          env,
          persistent: true,
        }),
    ).toThrow(UserInputError);
  });

  test.each([
    ['the old kernel type', { type: 'kernel', signatureType: 3, index: 0n }],
    [
      'the old mode field',
      { mode: 'kernel', signatureType: 3, kernelIndex: 0n },
    ],
  ])('an identity with %s is refused', async (_label, fields) => {
    const owner = keySigner(VECTOR_KEY);
    const account = privateKeyToAccount(generatePrivateKey()).address;
    const identity = {
      owner: owner.address,
      address: account,
      ...fields,
    } as unknown as TradingIdentity;
    expect(
      () =>
        new BackendAuth(makeTransport(), owner, identity, {
          env,
          persistent: true,
        }),
    ).toThrow('identity.type must be "eoa" or "smart_wallet"');
  });

  test('an identity whose signatureType does not fit its type is refused', async () => {
    const owner = keySigner(VECTOR_KEY);
    const identity = {
      type: 'eoa',
      owner: owner.address,
      address: owner.address,
      signatureType: 3,
    } as TradingIdentity;
    expect(
      () =>
        new BackendAuth(makeTransport(), owner, identity, {
          env,
          persistent: true,
        }),
    ).toThrow(UserInputError);
  });
});

// ---------------------------------------------------------------------------
// The key never leaks
// ---------------------------------------------------------------------------

describe('secrets', () => {
  const KEY = 'xo_sk_data_LEAKPFX1_SUPERSECRETKEYMATERIAL0123456789';
  const credential = credentialWith({ id: '31', key: KEY });

  function expectClean(error: unknown): void {
    expectNoLeak(error, KEY, 'SUPERSECRETKEYMATERIAL', 'LEAKPFX1_SUPER');
  }

  test('a server that echoes the key in an error body', async () => {
    installBackend();
    server.use(
      http.get(API_KEYS_URL, () =>
        HttpResponse.json(
          {
            statusCode: 401,
            error: 'invalid_credentials',
            message: `bad ${KEY}`,
          },
          { status: 401 },
        ),
      ),
      http.delete(`${API_KEYS_URL}/31`, () =>
        HttpResponse.json(
          { statusCode: 500, message: `boom ${KEY}` },
          { status: 500 },
        ),
      ),
    );
    const { auth } = await eoaRig({}, undefined, 0);
    const listed = await errorOf(auth.list(credential));
    expect(listed).toSatisfy(rejectedWith(401));
    expectClean(listed);
    const revoked = await errorOf(auth.revoke(credential));
    expect(revoked).toSatisfy(serverFailure);
    expectClean(revoked);
  });

  test('network failures and timeouts', async () => {
    installBackend();
    server.use(
      http.get(API_KEYS_URL, () => HttpResponse.error()),
      http.delete(`${API_KEYS_URL}/31`, () => HttpResponse.error()),
    );
    const { auth } = await eoaRig({}, undefined, 0);
    for (const call of [auth.list(credential), auth.revoke(credential)]) {
      const error = await errorOf(call);
      expect(error).toBeInstanceOf(TransportError);
      expectClean(error);
    }
  });

  test('a freshly minted key never shows up in an error from the response check', async () => {
    const backend = installBackend();
    backend.createdHook = (body) => ({ ...body, id: 'not-a-number' });
    const { auth } = await eoaRig();
    const error = await errorOf(auth.login());
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    const minted = backend.minted[0]?.key as string;
    expectNoLeak(
      error,
      minted,
      secretPart(minted),
      backend.minted[0]?.record.prefix ?? 'x',
    );
  });

  test('BackendAuth holds no key and shows no signer secret to JSON or inspect', async () => {
    installBackend();
    const { auth } = await eoaRig();
    const minted = await auth.login();
    const text = [
      JSON.stringify(auth),
      inspect(auth, { depth: null, showHidden: true, getters: true }),
    ].join('\n');
    expect(text.toLowerCase()).not.toContain(VECTOR_KEY.slice(2).toLowerCase());
    expect(text).not.toContain(minted.key);
  });

  test('errors of every login failure mode are free of the signature and the message body', async () => {
    const backend = installBackend();
    backend.walletHook = () => invalidSignature();
    const { auth } = await eoaRig();
    const error = await errorOf(auth.login());
    const signature = backend.walletBodies[0]?.signature as string;
    expectNoLeak(error, signature, signature.slice(2, 40));
  });
});

// ---------------------------------------------------------------------------
// A failure after the 201 carries the minted key's id as data
// ---------------------------------------------------------------------------

describe('post-mint errors', () => {
  test('a failure after the 201 is a MintedKeyError with a structured keyId, never the key', async () => {
    const backend = installBackend();
    backend.createdHook = (body) => ({
      ...body,
      key: 'xo_sk_data_ab cd_NOTOURKEY',
    });
    const { auth } = await eoaRig();
    const error = await errorOf(auth.login());
    const minted = backend.minted[0] as { key: string; record: KeyRecord };
    expect(error).toBeInstanceOf(MintedKeyError);
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as MintedKeyError).keyId).toBe(String(minted.record.id));
    expect((error as MintedKeyError).name).toBe('UnexpectedResponseError');
    expect((error as XoError).code).toBe('unexpected_response');
    expect((error as XoError).message).toContain(
      `API key id ${minted.record.id}`,
    );
    expect((error as XoError).toJSON().keyId).toBe(String(minted.record.id));
    expectNoLeak(error, minted.key, secretPart(minted.key), 'NOTOURKEY');
  });

  test('a failure after a 201 with no usable id is a MintedKeyError without a keyId', async () => {
    const backend = installBackend();
    backend.createdHook = (b) => ({ ...b, id: '7' });
    const { auth } = await eoaRig();
    const error = await errorOf(auth.login());
    expect(error).toBeInstanceOf(MintedKeyError);
    expect((error as MintedKeyError).keyId).toBeUndefined();
    expect((error as XoError).toJSON()).not.toHaveProperty('keyId');
    expect((error as XoError).message).not.toContain('API key id');
    expect((error as XoError).message).toMatch(
      /^Unexpected backend response for \/api\/auth\/api-keys: /,
    );
  });

  test('a failure before the 201 is not a MintedKeyError', async () => {
    const backend = installBackend();
    backend.walletHook = () => invalidSignature();
    const { auth } = await eoaRig();
    const error = await errorOf(auth.login());
    expect(error).toSatisfy(rejectedWith(401));
    expect(error).not.toBeInstanceOf(MintedKeyError);
  });
});

// ---------------------------------------------------------------------------
// A wallet request that fails without saying whether a key was created
// ---------------------------------------------------------------------------

describe('ambiguous wallet failures', () => {
  async function expectMayHaveMinted(error: unknown, cause: unknown) {
    expect(error).toBeInstanceOf(MintedKeyError);
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as MintedKeyError).mayHaveMinted).toBe(true);
    expect((error as MintedKeyError).keyId).toBeUndefined();
    expect((error as Error).cause).toBeInstanceOf(cause as never);
    expect((error as XoError).toJSON()).toMatchObject({ mayHaveMinted: true });
  }

  test('a 504 on the wallet route', async () => {
    const backend = installBackend();
    backend.walletHook = () =>
      HttpResponse.json({ statusCode: 504 }, { status: 504 });
    const { auth } = await eoaRig();
    const error = await errorOf(auth.login());
    await expectMayHaveMinted(error, RequestRejectedError);
    expect((error as XoError).status).toBe(504);
    expect(backend.walletBodies).toHaveLength(1);
  });

  test('a 201 whose JSON body cannot be parsed', async () => {
    const backend = installBackend();
    backend.walletHook = () =>
      new HttpResponse('{', {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    const { auth } = await eoaRig();
    const error = await errorOf(auth.login());
    await expectMayHaveMinted(error, UnexpectedResponseError);
    expect((error as XoError).status).toBe(201);
    expect(backend.walletBodies).toHaveLength(1);
  });

  test('a 201 that arrives after the timeout', async () => {
    installBackend();
    server.use(
      http.post(API_KEYS_URL, async () => {
        await delay(200);
        return HttpResponse.json({}, { status: 201 });
      }),
    );
    const base = keySigner(VECTOR_KEY);
    const identity = await resolveTradingIdentity(
      base,
      { type: 'eoa' },
      env,
      unusedRead,
    );
    const transport = new Transport({
      env,
      version: '9.9.9',
      defaultTimeoutMs: 50,
    });
    const auth = new BackendAuth(transport, base, identity, {
      env,
      persistent: true,
    });
    const error = await errorOf(auth.login());
    await expectMayHaveMinted(error, TimeoutError);
  });

  test('a 500 on the key route may still have minted: MintedKeyError with the 500 as cause', async () => {
    const backend = installBackend();
    // The filter writes only statusCode, timestamp and path for a 5xx.
    backend.walletHook = () =>
      HttpResponse.json(
        {
          statusCode: 500,
          timestamp: new Date().toISOString(),
          path: CREATE_KEY_PATH,
        },
        { status: 500 },
      );
    const { auth } = await eoaRig();
    const error = await errorOf(auth.login());
    await expectMayHaveMinted(error, RequestRejectedError);
    expect((error as XoError).status).toBe(500);
    expect(backend.walletBodies).toHaveLength(1);
  });

  test.each([
    [
      404,
      () =>
        exceptionResponse(CREATE_KEY_PATH, 404, {
          error: 'Not Found',
          message: `Cannot POST ${CREATE_KEY_PATH}`,
        }),
    ],
    [
      405,
      () =>
        HttpResponse.json(
          { statusCode: 405, message: 'Method Not Allowed' },
          { status: 405 },
        ),
    ],
  ])(
    'a %i means the backend has no key route at that path, so nothing was minted: key_route_not_found, not a MintedKeyError',
    async (status, respond) => {
      const backend = installBackend();
      backend.walletHook = respond;
      const { auth } = await eoaRig();
      const error = await errorOf(auth.login());
      expect(error).toBeInstanceOf(XoError);
      expect(error).not.toBeInstanceOf(MintedKeyError);
      expect(error).not.toBeInstanceOf(UnexpectedResponseError);
      const failure = error as XoError;
      expect(failure.code).toBe('key_route_not_found');
      expect(failure.status).toBe(status);
      expect(failure.service).toBe('backend');
      expect(failure.cause).toBeInstanceOf(XoError);
      expect(failure.message).toContain('POST /api/auth/api-keys');
      expect(failure.message).toContain('no key-creation route');
      expect(failure.message).toContain('out of date');
      expect(failure.toJSON()).not.toHaveProperty('mayHaveMinted');
      const signature = backend.walletBodies[0]?.signature as string;
      expectNoLeak(error, signature, signature.slice(2, 40));
    },
  );

  test('definitive refusals (400, 401, 403, 409, 413, 429) pass through as they are', async () => {
    const cases: Array<[number, () => Response, unknown]> = [
      [
        400,
        () => badRequest('name must be 1 to 100 characters'),
        RequestRejectedError,
      ],
      [401, () => invalidSignature(), RequestRejectedError],
      [
        403,
        () =>
          exceptionResponse(CREATE_KEY_PATH, 403, {
            error: 'account_banned',
            message: 'no',
          }),
        RequestRejectedError,
      ],
      [
        409,
        () =>
          exceptionResponse(CREATE_KEY_PATH, 409, {
            error: 'conflict',
            message: 'no',
          }),
        RequestRejectedError,
      ],
      [
        // Answered before the throttler, the guards and validation (small-body-parser).
        413,
        () =>
          HttpResponse.json(
            {
              statusCode: 413,
              error: 'payload_too_large',
              message: 'Request body is too large',
            },
            { status: 413 },
          ),
        RequestRejectedError,
      ],
      [
        429,
        () =>
          exceptionResponse(CREATE_KEY_PATH, 429, {
            message: 'Too Many Requests',
          }),
        RateLimitError,
      ],
    ];
    for (const [status, respond, type] of cases) {
      const backend = installBackend();
      backend.walletHook = respond;
      const { auth } = await eoaRig();
      const error = await errorOf(auth.login());
      expect(error).toBeInstanceOf(type as never);
      expect(error).not.toBeInstanceOf(MintedKeyError);
      expect((error as XoError).status).toBe(status);
      server.resetHandlers();
    }
  });
});
