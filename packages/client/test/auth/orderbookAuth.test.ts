import { inspect } from 'node:util';
import { HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import {
  type Address,
  type Hex,
  hashTypedData,
  recoverAddress,
  recoverTypedDataAddress,
  size,
  slice,
} from 'viem';
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
  OrderbookAuth,
  type OrderbookAuthOptions,
} from '../../src/auth/orderbookAuth';
import { Clock } from '../../src/core/clock';
import { type EnvironmentConfig, resolveEnvironment } from '../../src/core/env';
import {
  type RequestRejectedError,
  UnexpectedResponseError,
  UserInputError,
  XoError,
} from '../../src/core/errors';
import { Transport } from '../../src/core/transport';
import { clobAuthTypedData } from '../../src/signing/clobAuth';
import { kernelWrapTypedData } from '../../src/signing/kernel';
import {
  resolveTradingIdentity,
  type TradingIdentity,
} from '../../src/wallet/identity';
import type { InternalSigner } from '../../src/wallet/signer';
import {
  CREATE_PATH,
  DERIVE_PATH,
  gatewayError,
  installOrderbook,
  L1_WINDOW_SEC,
  type Orderbook,
  type OrderbookOptions,
  seedKey,
} from '../helpers/mockOrderbook';
import { rejectedWith, serverFailure } from '../helpers/rejections';
import { keySigner } from '../helpers/signers';
import { testEnv } from '../helpers/testEnv';
import { clobAuthVector, kernelVector } from '../signing/helpers';

const env = testEnv;
// The vector pins a signature for the chain it was made on, so the tests that compare with it
// run on that chain.
const vectorEnv = resolveEnvironment({
  ...testEnv,
  chainId: clobAuthVector.inputs.chainId,
});
const DERIVE = `GET ${DERIVE_PATH}`;
const CREATE = `POST ${CREATE_PATH}`;

// The public test vector key from test-vectors/clobAuth.json. Never fund it.
const KEY = clobAuthVector.inputs.privateKey;
const OWNER = clobAuthVector.inputs.address;
const ACCOUNT = kernelVector.createAccount.expectedAccount;
/** The vector's timestamp, so the headers of an EOA login can be compared with the vector. */
const SEC = Number(clobAuthVector.inputs.timestamp);
const NOW_MS = SEC * 1000 + 500;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const unusedRead = async (): Promise<Hex> => {
  throw new Error('the EOA identity reads nothing');
};

/** The factory's answer for the vector account: an address left-padded to 32 bytes. */
const paddedAccount =
  `0x${'00'.repeat(12)}${ACCOUNT.slice(2).toLowerCase()}` as Hex;

/** A clock that reads `nowMs` and is never synced (a sync here would be a bug). */
const fixedClock = (nowMs = NOW_MS) =>
  new Clock({
    fetchServerTimeSec: async () => {
      throw new Error('the clock must not be synced in this test');
    },
    now: () => nowMs,
  });

interface RigOptions {
  /** The environment the login runs on. Defaults to the test environment. */
  env?: EnvironmentConfig;
  type?: 'eoa' | 'smart_wallet';
  orderbook?: OrderbookOptions;
  auth?: OrderbookAuthOptions;
  clock?: Clock;
  maxRetries?: number;
  /** Wraps the (spied) signer, for a test that needs another signer. */
  wrap?: (signer: InternalSigner) => InternalSigner;
}

async function rig(o: RigOptions = {}) {
  const env = o.env ?? testEnv;
  const base = keySigner(KEY);
  const signTypedData = vi.fn<InternalSigner['signTypedData']>((td) =>
    base.signTypedData(td),
  );
  const signMessage = vi.fn<InternalSigner['signMessage']>((message) =>
    base.signMessage(message),
  );
  const spied: InternalSigner = {
    address: base.address,
    signTypedData,
    signMessage,
  };
  const signer = o.wrap?.(spied) ?? spied;
  const identity =
    o.type === 'smart_wallet'
      ? await resolveTradingIdentity(
          base,
          { type: 'smart_wallet', index: 0 },
          env,
          async () => paddedAccount,
        )
      : await resolveTradingIdentity(base, { type: 'eoa' }, env, unusedRead);
  // A provider that must never be asked for anything: the L1 headers are explicit.
  const provider = {
    headers: vi.fn(async () => ({ 'x-provider': 'must-not-be-sent' })),
    onUnauthorized: vi.fn(async () => true),
  };
  const transport = new Transport({
    env,
    version: '9.9.9',
    auth: provider,
    ...(o.maxRetries === undefined ? {} : { maxRetries: o.maxRetries }),
  });
  const clock = o.clock ?? fixedClock();
  const orderbook = installOrderbook(server, {
    now: () => NOW_MS,
    ...(o.type === 'smart_wallet'
      ? { smartAccounts: { [ACCOUNT.toLowerCase()]: { owner: OWNER } } }
      : {}),
    ...o.orderbook,
  });
  const auth = new OrderbookAuth(
    transport,
    signer,
    identity,
    env,
    clock,
    o.auth,
  );
  return {
    auth,
    orderbook,
    identity,
    signer,
    signTypedData,
    signMessage,
    provider,
    clock,
    transport,
  };
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

/** Everything a caller could log or print from an error and its cause chain. */
function dump(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && depth < 10; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.name, current.message, current.stack ?? '');
      try {
        parts.push(JSON.stringify(current));
      } catch {
        // not serialisable; the fields above already cover it
      }
      parts.push(inspect(current, { depth: null, showHidden: true }));
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join('\n');
}

// 32 bytes whose standard base64 has both + and /, so the two alphabets differ.
const SECRET_BYTES = Buffer.concat([
  Buffer.from([0xfb, 0xef, 0xbe, 0xff, 0xff, 0xff]),
  Buffer.alloc(26, 0x41),
]);
const STANDARD = SECRET_BYTES.toString('base64');
const URL_SAFE = STANDARD.replaceAll('+', '-').replaceAll('/', '_');

const L1_NAMES = [
  'XO_ADDRESS',
  'XO_SIGNATURE',
  'XO_TIMESTAMP',
  'XO_NONCE',
] as const;

function l1Of(orderbook: Orderbook, index: number) {
  const headers = orderbook.requests[index]?.headers;
  return Object.fromEntries(
    L1_NAMES.map((name) => [name, headers?.get(name) ?? null]),
  );
}

const clobTd = (
  address: Address,
  timestamp = String(SEC),
  chainId = env.chainId,
) =>
  clobAuthTypedData({
    address,
    timestamp,
    nonce: 0n,
    chainId,
  });

// ---------------------------------------------------------------------------
// EOA
// ---------------------------------------------------------------------------

describe('OrderbookAuth: EOA', () => {
  test('derive 200 returns the existing credentials and makes no create call', async () => {
    const { auth, orderbook } = await rig();
    const existing = seedKey(orderbook, OWNER);
    const credential = await auth.login();
    expect(credential).toEqual(existing);
    expect(Object.keys(credential).sort()).toEqual([
      'apiKey',
      'passphrase',
      'secret',
    ]);
    expect(orderbook.calls).toEqual([DERIVE]);
  });

  test('derive 404 calls create, and the next login derives the same credentials', async () => {
    const { auth, orderbook } = await rig();
    const created = await auth.login();
    expect(orderbook.calls).toEqual([DERIVE, CREATE]);
    expect(orderbook.keys.get(OWNER.toLowerCase())).toEqual([created]);
    // The shapes the gateway makes: a UUID, 44 characters of base64url, 32 hex digits.
    expect(created.apiKey).toHaveLength(36);
    expect(created.secret).toHaveLength(44);
    expect(created.secret.endsWith('=')).toBe(true);
    expect(created.passphrase).toHaveLength(32);

    expect(await auth.login()).toEqual(created);
    expect(orderbook.calls).toEqual([DERIVE, CREATE, DERIVE]);
  });

  test('XO_ADDRESS is the trading address, XO_TIMESTAMP is clock.nowSecString(), XO_NONCE is 0', async () => {
    const clock = fixedClock();
    const { auth, orderbook } = await rig({ clock });
    await auth.login();
    const headers = l1Of(orderbook, 0);
    expect(headers.XO_ADDRESS).toBe(OWNER);
    expect(headers.XO_TIMESTAMP).toBe(clock.nowSecString());
    expect(headers.XO_TIMESTAMP).toBe(String(SEC));
    expect(headers.XO_NONCE).toBe('0');
  });

  test('the headers are exactly the vector headers (the signature is deterministic)', async () => {
    const { auth, orderbook } = await rig({
      env: vectorEnv,
      orderbook: { chainId: vectorEnv.chainId },
    });
    await auth.login();
    expect(l1Of(orderbook, 0)).toEqual(clobAuthVector.expectedHeaders);
  });

  test('XO_SIGNATURE recovers to the owner over the ClobAuth typed data', async () => {
    const { auth, orderbook } = await rig();
    await auth.login();
    const { XO_SIGNATURE } = l1Of(orderbook, 0);
    expect(
      await recoverTypedDataAddress({
        ...clobTd(OWNER),
        signature: XO_SIGNATURE as Hex,
      }),
    ).toBe(OWNER);
    // And the digest is the gateway's, pinned by the vector.
    expect(
      hashTypedData(
        clobTd(OWNER, clobAuthVector.inputs.timestamp, vectorEnv.chainId),
      ),
    ).toBe(clobAuthVector.expectedDigest);
  });

  test('a create after a 404 reuses the same L1 headers and the wallet signs once', async () => {
    const { auth, orderbook, signTypedData, signMessage } = await rig();
    await auth.login();
    expect(orderbook.calls).toEqual([DERIVE, CREATE]);
    expect(l1Of(orderbook, 1)).toEqual(l1Of(orderbook, 0));
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(signMessage).not.toHaveBeenCalled();
  });

  test('signs only the locally built ClobAuth typed data', async () => {
    const { auth, signTypedData, signMessage } = await rig();
    await auth.login();
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(signTypedData).toHaveBeenCalledWith(clobTd(OWNER));
    expect(signMessage).not.toHaveBeenCalled();
  });

  test('derive has no query string, create has no body and no content type', async () => {
    const { auth, orderbook } = await rig();
    await auth.login();
    const [derive, create] = orderbook.requests;
    expect(derive?.search).toBe('');
    expect(derive?.body).toBe('');
    expect(create?.search).toBe('');
    expect(create?.body).toBe('');
    expect(create?.headers.get('content-type')).toBeNull();
  });

  test('never asks the AuthProvider and sends no other credentials', async () => {
    const { auth, orderbook, provider } = await rig();
    await auth.login();
    expect(provider.headers).not.toHaveBeenCalled();
    expect(provider.onUnauthorized).not.toHaveBeenCalled();
    for (const request of orderbook.requests) {
      expect(request.headers.get('x-provider')).toBeNull();
      expect(request.headers.get('authorization')).toBeNull();
      expect(request.headers.get('xo_api_key')).toBeNull();
      expect(request.headers.get('xo_passphrase')).toBeNull();
      expect(request.headers.get('x-xo-sdk')).toBe('ts/9.9.9');
    }
  });

  test('a derive that fails with 503 is retried with the same L1 headers and the wallet signs once', async () => {
    const { auth, orderbook, signTypedData } = await rig();
    seedKey(orderbook, OWNER);
    let first = true;
    orderbook.override = (route) => {
      if (route === 'derive' && first) {
        first = false;
        return HttpResponse.json(
          { error: 'busy', retry_after_ms: 0 },
          { status: 503 },
        );
      }
      return undefined;
    };
    await auth.login();
    expect(orderbook.calls).toEqual([DERIVE, DERIVE]);
    expect(l1Of(orderbook, 1)).toEqual(l1Of(orderbook, 0));
    expect(signTypedData).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Smart wallet
// ---------------------------------------------------------------------------

describe('OrderbookAuth: smart_wallet', () => {
  test('XO_ADDRESS is the smart wallet, not the owner', async () => {
    const { auth, orderbook } = await rig({ type: 'smart_wallet' });
    await auth.login();
    expect(l1Of(orderbook, 0).XO_ADDRESS).toBe(ACCOUNT);
    expect(l1Of(orderbook, 0).XO_ADDRESS).not.toBe(OWNER);
    expect(orderbook.keys.has(ACCOUNT.toLowerCase())).toBe(true);
    expect(orderbook.keys.has(OWNER.toLowerCase())).toBe(false);
  });

  test('the signature starts with 0x00 and its 65-byte tail recovers the owner over the Kernel-wrapped ClobAuth digest', async () => {
    const { auth, orderbook } = await rig({ type: 'smart_wallet' });
    await auth.login();
    const signature = l1Of(orderbook, 0).XO_SIGNATURE as Hex;
    expect(signature.startsWith('0x00')).toBe(true);
    expect(size(signature)).toBe(66);
    const tail = slice(signature, 1);
    expect(size(tail)).toBe(65);

    const clobHash = hashTypedData(clobTd(ACCOUNT));
    const wrapped = hashTypedData(
      kernelWrapTypedData(clobHash, ACCOUNT, env.chainId),
    );
    expect(await recoverAddress({ hash: wrapped, signature: tail })).toBe(
      OWNER,
    );
    // It is not a signature over the raw ClobAuth digest.
    expect(await recoverAddress({ hash: clobHash, signature: tail })).not.toBe(
      OWNER,
    );
  });

  test('the gateway accepts it (EIP-1271 on a deployed account) and issues credentials', async () => {
    const { auth, orderbook } = await rig({ type: 'smart_wallet' });
    const credential = await auth.login();
    expect(orderbook.calls).toEqual([DERIVE, CREATE]);
    expect(orderbook.keys.get(ACCOUNT.toLowerCase())).toEqual([credential]);
  });

  test('signs only the locally built Kernel wrap of the ClobAuth digest', async () => {
    const { auth, signTypedData, signMessage } = await rig({
      type: 'smart_wallet',
    });
    await auth.login();
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(signTypedData).toHaveBeenCalledWith(
      kernelWrapTypedData(hashTypedData(clobTd(ACCOUNT)), ACCOUNT, env.chainId),
    );
    expect(signMessage).not.toHaveBeenCalled();
  });

  test('without isDeployed, an undeployed account is the gateway 401, and create is not tried', async () => {
    const { auth, orderbook } = await rig({
      type: 'smart_wallet',
      orderbook: { smartAccounts: {} },
    });
    const error = await caught(() => auth.login());
    expect(error).toSatisfy(rejectedWith(401));
    expect((error as RequestRejectedError).status).toBe(401);
    expect((error as RequestRejectedError).message).toContain('EIP-1271');
    expect(orderbook.calls).toEqual([DERIVE]);
  });

  describe('isDeployed', () => {
    test('a deployed account logs in; isDeployed is asked once with the smart wallet', async () => {
      const isDeployed = vi.fn(async (_address: Address) => true);
      const { auth, orderbook } = await rig({
        type: 'smart_wallet',
        auth: { isDeployed },
      });
      await auth.login();
      expect(isDeployed).toHaveBeenCalledTimes(1);
      expect(isDeployed).toHaveBeenCalledWith(ACCOUNT);
      expect(orderbook.calls).toEqual([DERIVE, CREATE]);
    });

    test('an undeployed account is smart_wallet_not_deployed after 3 reads: nothing is signed and no request is made', async () => {
      const isDeployed = vi.fn(async (_address: Address) => false);
      const { auth, orderbook, signTypedData, signMessage } = await rig({
        type: 'smart_wallet',
        auth: { isDeployed, deployRecheckMs: [0, 0] },
        orderbook: { smartAccounts: {} },
      });
      const error = await caught(() => auth.login());
      expect(error).toBeInstanceOf(XoError);
      const xo = error as XoError;
      expect(xo.code).toBe('smart_wallet_not_deployed');
      expect(xo.service).toBe('chain');
      expect(xo.cause).toBeUndefined();
      expect(xo.message).toContain(
        `the smart wallet ${ACCOUNT} is not deployed; the orderbook verifies smart wallet signatures on chain (EIP-1271). createSecureClient deploys a new smart wallet before it signs in, so the chain read may be lagging behind: try again in a moment`,
      );
      expect(signTypedData).not.toHaveBeenCalled();
      expect(signMessage).not.toHaveBeenCalled();
      expect(orderbook.calls).toEqual([]);
      expect(isDeployed).toHaveBeenCalledTimes(3);
    });

    test('is checked on every login, so a later deployment is noticed', async () => {
      let deployed = false;
      const isDeployed = vi.fn(async () => deployed);
      const { auth } = await rig({
        type: 'smart_wallet',
        auth: { isDeployed, deployRecheckMs: [0, 0] },
      });
      await expect(auth.login()).rejects.toMatchObject({
        code: 'smart_wallet_not_deployed',
      });
      deployed = true;
      await expect(auth.login()).resolves.toBeDefined();
      expect(isDeployed).toHaveBeenCalledTimes(4);
    });

    test('an RPC node that lags behind a deploy: false, false, then true logs in, with one signature', async () => {
      const answers = [false, false, true];
      const isDeployed = vi.fn(async () => answers.shift() ?? true);
      const { auth, orderbook, signTypedData } = await rig({
        type: 'smart_wallet',
        auth: { isDeployed, deployRecheckMs: [0, 0] },
      });
      await expect(auth.login()).resolves.toBeDefined();
      expect(isDeployed).toHaveBeenCalledTimes(3);
      expect(signTypedData).toHaveBeenCalledTimes(1);
      expect(orderbook.calls).toEqual([DERIVE, CREATE]);
    });

    test('by default the 3 reads take about 6 s: at 0, 2 and 6 s, then smart_wallet_not_deployed', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const isDeployed = vi.fn(async () => false);
        const { auth, signTypedData } = await rig({
          type: 'smart_wallet',
          auth: { isDeployed },
        });
        let settled = false;
        const login = caught(() => auth.login()).finally(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(isDeployed).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(isDeployed).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(3_999);
        expect(isDeployed).toHaveBeenCalledTimes(2);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await login).toMatchObject({
          code: 'smart_wallet_not_deployed',
        });
        expect(isDeployed).toHaveBeenCalledTimes(3);
        expect(signTypedData).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    test('a read that throws while rechecking is smart_wallet_deployment_unknown at once', async () => {
      const isDeployed = vi
        .fn<(address: Address) => Promise<boolean>>()
        .mockResolvedValueOnce(false)
        .mockRejectedValueOnce(new Error('rpc down'));
      const { auth } = await rig({
        type: 'smart_wallet',
        auth: { isDeployed, deployRecheckMs: [0, 0] },
      });
      await expect(auth.login()).rejects.toMatchObject({
        code: 'smart_wallet_deployment_unknown',
      });
      expect(isDeployed).toHaveBeenCalledTimes(2);
    });

    test.each([
      [
        'an Error',
        new RangeError('rpc https://node.example/v1/SECRETRPCKEY failed'),
        'RangeError',
      ],
      [
        'a custom error',
        Object.assign(new Error('SECRETRPCKEY'), { name: 'RpcRequestError' }),
        'RpcRequestError',
      ],
      ['a string', 'SECRETRPCKEY', 'unknown'],
      ['undefined', undefined, 'unknown'],
      [
        'an object whose name throws',
        {
          get name(): string {
            throw new Error('SECRETRPCKEY');
          },
        },
        'Error',
      ],
      [
        'an error with a hostile name',
        Object.assign(new Error('x'), { name: 'Bad Name SECRETRPCKEY' }),
        'Error',
      ],
    ])(
      'a throwing isDeployed (%s) is smart_wallet_deployment_unknown, naming only the error name, with no cause',
      async (_label, thrown, name) => {
        const isDeployed = vi.fn(
          async (_address: Address): Promise<boolean> => {
            throw thrown;
          },
        );
        const { auth, orderbook, signTypedData } = await rig({
          type: 'smart_wallet',
          auth: { isDeployed },
        });
        const error = await caught(() => auth.login());
        expect(error).toBeInstanceOf(XoError);
        const xo = error as XoError;
        expect(xo.code).toBe('smart_wallet_deployment_unknown');
        expect(xo.service).toBe('chain');
        expect(xo.cause).toBeUndefined();
        expect(xo.message).toContain(`(${name})`);
        expect(xo.message).toContain(ACCOUNT);
        expect(dump(error)).not.toContain('SECRETRPCKEY');
        expect(signTypedData).not.toHaveBeenCalled();
        expect(orderbook.calls).toEqual([]);
      },
    );

    test.each([
      ['undefined', undefined],
      ['null', null],
      ['a string', 'true'],
      ['a number', 1],
    ])(
      'an isDeployed that resolves %s is smart_wallet_deployment_unknown, not "deployed"',
      async (_label, answer) => {
        const isDeployed = vi.fn(
          async (_address: Address) => answer as unknown as boolean,
        );
        const { auth, orderbook, signTypedData } = await rig({
          type: 'smart_wallet',
          auth: { isDeployed },
        });
        await expect(auth.login()).rejects.toMatchObject({
          code: 'smart_wallet_deployment_unknown',
          service: 'chain',
        });
        expect(signTypedData).not.toHaveBeenCalled();
        expect(orderbook.calls).toEqual([]);
      },
    );

    test('an EOA never calls isDeployed', async () => {
      const isDeployed = vi.fn(async (_address: Address) => false);
      const { auth, orderbook } = await rig({ auth: { isDeployed } });
      await auth.login();
      expect(isDeployed).not.toHaveBeenCalled();
      expect(orderbook.calls).toEqual([DERIVE, CREATE]);
    });
  });
});

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

describe('OrderbookAuth: the server-synced clock', () => {
  const serverMs = NOW_MS;

  test('with the local clock 90 s ahead, a synced clock puts the server second in XO_TIMESTAMP', async () => {
    const localMs = serverMs + 90_000;
    const clock = new Clock({
      fetchServerTimeSec: async () => Math.floor(serverMs / 1000),
      now: () => localMs,
    });
    // Without the sync the timestamp would be 90 s ahead of the server.
    expect(clock.nowSecString()).toBe(String(SEC + 90));
    await clock.sync();
    const { auth, orderbook } = await rig({ clock });
    await auth.login();
    expect(l1Of(orderbook, 0).XO_TIMESTAMP).toBe(String(SEC));
    expect(l1Of(orderbook, 0).XO_TIMESTAMP).toBe(clock.nowSecString());
  });

  test('a local clock far outside the window is a 401 until the clock is synced', async () => {
    const localMs = serverMs + (L1_WINDOW_SEC + 30) * 1000;
    const clock = new Clock({
      fetchServerTimeSec: async () => Math.floor(serverMs / 1000),
      now: () => localMs,
    });
    const { auth, orderbook } = await rig({ clock });
    const error = await caught(() => auth.login());
    expect(error).toSatisfy(rejectedWith(401));
    expect((error as RequestRejectedError).message).toContain('timestamp');
    expect(orderbook.calls).toEqual([DERIVE]);

    await clock.sync();
    await expect(auth.login()).resolves.toBeDefined();
    expect(l1Of(orderbook, 1).XO_TIMESTAMP).toBe(String(SEC));
  });

  test.each([
    ['not digits', 'NaN'],
    ['empty', ''],
    ['not a string', 1700000000],
  ])(
    'a clock that returns a timestamp that is %s is a UserInputError: nothing is signed or requested',
    async (_label, value) => {
      const clock = { nowSecString: () => value } as unknown as Clock;
      const { auth, orderbook, signTypedData } = await rig({ clock });
      await expect(auth.login()).rejects.toBeInstanceOf(UserInputError);
      expect(signTypedData).not.toHaveBeenCalled();
      expect(orderbook.calls).toEqual([]);
    },
  );

  test('login does not sync the clock itself', async () => {
    const fetchServerTimeSec = vi.fn(async () => SEC);
    const clock = new Clock({ fetchServerTimeSec, now: () => NOW_MS });
    const { auth } = await rig({ clock });
    await auth.login();
    expect(fetchServerTimeSec).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe('OrderbookAuth: errors', () => {
  test('a 401 on derive is a 401 rejection, not retried, and create is not tried', async () => {
    const { auth, orderbook, provider } = await rig({
      // A gateway on another chain: the signature recovers to another address.
      orderbook: { chainId: env.chainId + 1 },
    });
    const error = await caught(() => auth.login());
    expect(error).toSatisfy(rejectedWith(401));
    expect((error as RequestRejectedError).status).toBe(401);
    expect((error as RequestRejectedError).service).toBe('orderbook');
    expect(orderbook.calls).toEqual([DERIVE]);
    expect(provider.onUnauthorized).not.toHaveBeenCalled();
  });

  test('a 401 on create is a 401 rejection, and derive is not called again', async () => {
    const { auth, orderbook } = await rig();
    orderbook.override = (route) =>
      route === 'create'
        ? gatewayError(401, 'L1 signature invalid')
        : undefined;
    const error = await caught(() => auth.login());
    expect(error).toSatisfy(rejectedWith(401));
    expect(orderbook.calls).toEqual([DERIVE, CREATE]);
  });

  test('a 400 on create (the key limit) is a 400 RequestRejectedError with the gateway message, and is not retried', async () => {
    const { auth, orderbook } = await rig({ orderbook: { maxKeysPerUser: 0 } });
    const error = await caught(() => auth.login());
    expect(error).toSatisfy(rejectedWith(400));
    const validation = error as RequestRejectedError;
    expect(validation.status).toBe(400);
    expect(validation.service).toBe('orderbook');
    expect(validation.message).toBe('maximum 0 API keys per user reached');
    expect(orderbook.calls).toEqual([DERIVE, CREATE]);
  });

  test('a 403 on derive propagates as a 403 rejection, and create is not tried', async () => {
    const { auth, orderbook } = await rig();
    orderbook.override = () => gatewayError(403, 'forbidden');
    await expect(auth.login()).rejects.toSatisfy(rejectedWith(403));
    expect(orderbook.calls).toEqual([DERIVE]);
  });

  test('a 500 on derive propagates as a 5xx rejection, and create is not tried', async () => {
    const { auth, orderbook } = await rig();
    orderbook.override = () => gatewayError(500, 'engine unavailable');
    await expect(auth.login()).rejects.toSatisfy(serverFailure);
    expect(orderbook.calls).toEqual([DERIVE]);
  });

  test('a 503 on create is not retried: one create call', async () => {
    const { auth, orderbook } = await rig();
    orderbook.override = (route) =>
      route === 'create'
        ? HttpResponse.json(
            { error: 'busy', retry_after_ms: 0 },
            { status: 503 },
          )
        : undefined;
    await expect(auth.login()).rejects.toSatisfy(serverFailure);
    expect(orderbook.calls).toEqual([DERIVE, CREATE]);
  });

  test('a 404 on create propagates as a 404 rejection: no third call', async () => {
    const { auth, orderbook } = await rig();
    orderbook.override = () => gatewayError(404, 'not found');
    await expect(auth.login()).rejects.toSatisfy(rejectedWith(404));
    expect(orderbook.calls).toEqual([DERIVE, CREATE]);
  });

  test('an error from the signer propagates as it is, and no request is made', async () => {
    const failure = new Error('user rejected the signature');
    const { auth, orderbook } = await rig({
      wrap: (signer) => ({
        ...signer,
        signTypedData: async () => {
          throw failure;
        },
      }),
    });
    await expect(auth.login()).rejects.toBe(failure);
    expect(orderbook.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The credential response
// ---------------------------------------------------------------------------

describe.each(['derive', 'create'] as const)(
  'OrderbookAuth: the %s response',
  (route) => {
    // Every value carries a marker, so any echo of a received value is caught.
    const LEAK = {
      apiKey: 'LEAKAPIKEY-1111-2222',
      secret: 'LEAKSECRETAAAA',
      passphrase: 'LEAKPASSPHRASE',
    };
    const MARKERS = ['LEAKAPIKEY', 'LEAKSECRET', 'LEAKPASSPHRASE'];
    // `secret` is 14 characters of base64: not a multiple of 4 but a possible length, so
    // it decodes, and a test that breaks another field breaks only that field.

    /** Sets up the gateway so `route` is the one that answers with `shaped`. */
    async function login(shaped: unknown, o: RigOptions = {}) {
      const r = await rig(o);
      if (route === 'derive') {
        seedKey(r.orderbook, OWNER);
      }
      r.orderbook.shape = (which) => (which === route ? shaped : undefined);
      const outcome = await r.auth.login().then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      return { ...r, ...outcome };
    }

    const expectedCalls = route === 'derive' ? [DERIVE] : [DERIVE, CREATE];

    function expectNoLeak(error: unknown): void {
      const text = dump(error);
      for (const marker of MARKERS) {
        expect(text).not.toContain(marker);
      }
      expect(text).not.toContain(KEY.slice(2));
    }

    test.each([
      ['a character outside the alphabet', 'LEAKSECRET!bad'],
      ['a space', 'LEAKSECRET with space'],
      ['a trailing newline', 'LEAKSECRETAAAA\n'],
      ['an impossible length', 'LEAKSECRETABC'],
      ['one = on a short body', 'LEAKSECRET='],
      ['too much padding', 'LEAKSECRETAA==='],
      ['padding in front', '=LEAKSECRET'],
      ['a non-ASCII character', 'LEAKSECRETé'],
      ['an empty string', ''],
    ])(
      'a secret with %s is an UnexpectedResponseError that leaks nothing',
      async (_label, secret) => {
        const result = await login({ ...LEAK, secret });
        const error = (result as { error?: unknown }).error;
        expect(error).toBeInstanceOf(UnexpectedResponseError);
        expect((error as UnexpectedResponseError).service).toBe('orderbook');
        expect((error as UnexpectedResponseError).message).toContain('secret');
        expectNoLeak(error);
        // Not retried and not repeated.
        expect(result.orderbook.calls).toEqual(expectedCalls);
      },
    );

    test.each([
      [
        'a missing apiKey',
        { secret: LEAK.secret, passphrase: LEAK.passphrase },
        'apiKey',
      ],
      [
        'a missing secret',
        { apiKey: LEAK.apiKey, passphrase: LEAK.passphrase },
        'secret',
      ],
      [
        'a missing passphrase',
        { apiKey: LEAK.apiKey, secret: LEAK.secret },
        'passphrase',
      ],
      ['an empty apiKey', { ...LEAK, apiKey: '' }, 'apiKey'],
      ['an empty passphrase', { ...LEAK, passphrase: '' }, 'passphrase'],
      [
        'a passphrase with a trailing newline',
        { ...LEAK, passphrase: 'LEAKPASSPHRASE\n' },
        'passphrase',
      ],
      [
        'a passphrase with a tab inside',
        { ...LEAK, passphrase: 'LEAKPASS\tPHRASE' },
        'passphrase',
      ],
      [
        'an apiKey with a leading space',
        { ...LEAK, apiKey: ' LEAKAPIKEY' },
        'apiKey',
      ],
      [
        'an apiKey with a space inside',
        { ...LEAK, apiKey: 'LEAKAPIKEY 1111' },
        'apiKey',
      ],
      [
        'an apiKey with a non-ASCII character',
        { ...LEAK, apiKey: 'a\u00e9b' },
        'apiKey',
      ],
      [
        'a passphrase with a non-ASCII character',
        { ...LEAK, passphrase: 'a\u00e9b' },
        'passphrase',
      ],
      [
        'an apiKey with a NUL',
        { ...LEAK, apiKey: 'LEAKAPIKEY\u0000' },
        'apiKey',
      ],
      [
        'an apiKey of 257 characters',
        { ...LEAK, apiKey: 'LEAKAPIKEY'.padEnd(257, 'x') },
        'apiKey',
      ],
      [
        'a passphrase of 257 characters',
        { ...LEAK, passphrase: 'LEAKPASSPHRASE'.padEnd(257, 'x') },
        'passphrase',
      ],
      ['a numeric secret', { ...LEAK, secret: 123456789 }, 'secret'],
      ['a null secret', { ...LEAK, secret: null }, 'secret'],
      ['a numeric apiKey', { ...LEAK, apiKey: 42 }, 'apiKey'],
      [
        'an object passphrase',
        { ...LEAK, passphrase: { LEAKPASSPHRASE: 1 } },
        'passphrase',
      ],
    ])(
      '%s is an UnexpectedResponseError that names the field and leaks nothing',
      async (_label, shaped, field) => {
        const result = await login(shaped);
        const error = (result as { error?: unknown }).error;
        expect(error).toBeInstanceOf(UnexpectedResponseError);
        expect((error as UnexpectedResponseError).message).toContain(field);
        expectNoLeak(error);
        expect(result.orderbook.calls).toEqual(expectedCalls);
      },
    );

    test.each([
      ['an array', [LEAK]],
      ['a string', 'LEAKSECRET plain'],
      ['null', null],
      ['a number', 7],
    ])(
      'a body that is %s is an UnexpectedResponseError that leaks nothing',
      async (_label, shaped) => {
        const result = await login(shaped);
        const error = (result as { error?: unknown }).error;
        expect(error).toBeInstanceOf(UnexpectedResponseError);
        expectNoLeak(error);
      },
    );

    test('an empty body and a plain-text body are UnexpectedResponseErrors that leak nothing', async () => {
      for (const response of [
        new Response('', { status: 200 }),
        new Response(`${LEAK.apiKey} ${LEAK.secret} ${LEAK.passphrase}`, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
      ]) {
        const result = await login(response);
        const error = (result as { error?: unknown }).error;
        expect(error).toBeInstanceOf(UnexpectedResponseError);
        expectNoLeak(error);
      }
    });

    test('a body that is not valid JSON is an UnexpectedResponseError that leaks nothing', async () => {
      const result = await login(
        new Response(`{"secret":"${LEAK.secret}",`, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      const error = (result as { error?: unknown }).error;
      expect(error).toBeInstanceOf(UnexpectedResponseError);
      expectNoLeak(error);
    });

    test.each([
      ['padded base64url (what the gateway sends)', URL_SAFE],
      ['unpadded base64url', URL_SAFE.replace(/=+$/, '')],
      ['standard base64 with + and /', STANDARD],
      ['unpadded standard base64', STANDARD.replace(/=+$/, '')],
      ['two = of padding', 'dGVzdA=='],
    ])(
      'a secret in %s form is accepted and returned unchanged',
      async (_label, secret) => {
        const shaped = { ...LEAK, secret };
        const result = await login(shaped);
        expect((result as { value?: unknown }).value).toEqual(shaped);
      },
    );

    test.each([
      ['1 character', 'a', '~'],
      ['256 characters', 'x'.repeat(256), '!'.repeat(256)],
    ])(
      'an apiKey and a passphrase of %s are accepted',
      async (_label, apiKey, passphrase) => {
        const shaped = { apiKey, secret: 'dGVzdA==', passphrase };
        const result = await login(shaped);
        expect((result as { value?: unknown }).value).toEqual(shaped);
      },
    );

    test('lenient mode drops an unknown field; the credential has exactly three fields', async () => {
      const result = await login({ ...LEAK, secret: 'dGVzdA==', extra: 'x' });
      expect((result as { value?: unknown }).value).toEqual({
        apiKey: LEAK.apiKey,
        secret: 'dGVzdA==',
        passphrase: LEAK.passphrase,
      });
    });

    test('strict mode rejects an unknown field, naming the field and leaking no value', async () => {
      const result = await login(
        { ...LEAK, secret: 'dGVzdA==', surprise: 'LEAKSECRET' },
        { auth: { strictResponses: true } },
      );
      const error = (result as { error?: unknown }).error;
      expect(error).toBeInstanceOf(UnexpectedResponseError);
      expect((error as UnexpectedResponseError).message).toContain('surprise');
      expectNoLeak(error);
    });

    test('strict mode accepts exactly the three fields', async () => {
      const shaped = { ...LEAK, secret: 'dGVzdA==' };
      const result = await login(shaped, { auth: { strictResponses: true } });
      expect((result as { value?: unknown }).value).toEqual(shaped);
    });

    test('the auth object holds no credential after a login', async () => {
      const shaped = { ...LEAK, secret: 'dGVzdA==' };
      const result = await login(shaped);
      const text = `${inspect(result.auth, { depth: null, showHidden: true })}${JSON.stringify(result.auth)}`;
      for (const marker of MARKERS) {
        expect(text).not.toContain(marker);
      }
    });
  },
);

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('OrderbookAuth: construction', () => {
  async function parts() {
    const base = keySigner(KEY);
    const identity = await resolveTradingIdentity(
      base,
      { type: 'eoa' },
      env,
      unusedRead,
    );
    const transport = new Transport({ env, version: '9.9.9' });
    return { base, identity, transport, clock: fixedClock() };
  }

  const bad = (v: unknown) => v as never;

  test('a signer that is not the owner is a signer_mismatch UserInputError, before any request', async () => {
    const { identity, transport, clock } = await parts();
    const other = keySigner(`0x${'11'.repeat(32)}`);
    const orderbook = installOrderbook(server, { now: () => NOW_MS });
    const error = await caught(async () => {
      new OrderbookAuth(transport, other, identity, env, clock);
    });
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).code).toBe('signer_mismatch');
    expect(orderbook.calls).toEqual([]);
  });

  test.each([
    ['no identity', undefined],
    ['an identity with another type', { type: 'safe' }],
    [
      'an identity with the old kernel type',
      { type: 'kernel', signatureType: 3, address: ACCOUNT },
    ],
    ['an EOA identity with signatureType 3', { type: 'eoa', signatureType: 3 }],
    [
      'an EOA identity that trades from another address',
      { type: 'eoa', signatureType: 0, address: ACCOUNT },
    ],
    [
      'a smart wallet identity with signatureType 0',
      { type: 'smart_wallet', signatureType: 0, address: ACCOUNT },
    ],
  ])('rejects %s', async (_label, override) => {
    const { base, identity, transport, clock } = await parts();
    const broken =
      override === undefined
        ? undefined
        : { ...identity, owner: base.address, ...override };
    await expect(
      caught(async () => {
        new OrderbookAuth(transport, base, bad(broken), env, clock);
      }),
    ).resolves.toBeInstanceOf(UserInputError);
  });

  test.each([
    ['a signer without signTypedData', { address: OWNER }],
    ['no signer', undefined],
  ])('rejects %s', async (_label, signer) => {
    const { identity, transport, clock } = await parts();
    await expect(
      caught(async () => {
        new OrderbookAuth(transport, bad(signer), identity, env, clock);
      }),
    ).resolves.toBeInstanceOf(UserInputError);
  });

  test.each([
    ['no clock', undefined],
    ['a clock without nowSecString', { nowSec: () => 1 }],
  ])('rejects %s', async (_label, clock) => {
    const { base, identity, transport } = await parts();
    await expect(
      caught(async () => {
        new OrderbookAuth(transport, base, identity, env, bad(clock));
      }),
    ).resolves.toBeInstanceOf(UserInputError);
  });

  test.each([
    ['no env', undefined],
    ['an env without a chainId', {}],
    ['a chainId of 0', { chainId: 0 }],
    ['a chainId that is not an integer', { chainId: 1.5 }],
  ])('rejects %s', async (_label, badEnv) => {
    const { base, identity, transport, clock } = await parts();
    await expect(
      caught(async () => {
        new OrderbookAuth(transport, base, identity, bad(badEnv), clock);
      }),
    ).resolves.toBeInstanceOf(UserInputError);
  });

  test.each([
    ['options that are null', null],
    ['an isDeployed that is not a function', { isDeployed: 'yes' }],
    ['strictResponses that is not a boolean', { strictResponses: 'yes' }],
    ['deployRecheckMs that is not an array', { deployRecheckMs: 2000 }],
    ['deployRecheckMs that is null', { deployRecheckMs: null }],
    ['deployRecheckMs with a negative wait', { deployRecheckMs: [-1] }],
    ['deployRecheckMs with three waits', { deployRecheckMs: [1, 1, 1] }],
  ])('rejects %s', async (_label, options) => {
    const { base, identity, transport, clock } = await parts();
    await expect(
      caught(async () => {
        new OrderbookAuth(transport, base, identity, env, clock, bad(options));
      }),
    ).resolves.toBeInstanceOf(UserInputError);
  });

  test('copies the identity: changing it afterwards changes nothing', async () => {
    const { base, transport, clock } = await parts();
    const identity = {
      type: 'eoa',
      owner: OWNER,
      address: OWNER,
      signatureType: 0,
    } as { -readonly [K in keyof TradingIdentity]: TradingIdentity[K] };
    const orderbook = installOrderbook(server, { now: () => NOW_MS });
    const auth = new OrderbookAuth(transport, base, identity, env, clock);
    identity.address = ACCOUNT;
    identity.type = 'smart_wallet';
    await auth.login();
    expect(orderbook.requests[0]?.headers.get('XO_ADDRESS')).toBe(OWNER);
  });
});

// ---------------------------------------------------------------------------
// Every field is read once
// ---------------------------------------------------------------------------

describe('OrderbookAuth: reads every field once', () => {
  /** A getter that answers `first` on its first read and `later` on every read after that. */
  function flips(first: unknown, later: unknown) {
    let reads = 0;
    return { get: () => (reads++ === 0 ? first : later), reads: () => reads };
  }
  type Flip = ReturnType<typeof flips>;

  /** A fresh object whose listed properties are getters. */
  function withGetters(getters: Record<string, Flip>): object {
    const o = {};
    for (const [key, flip] of Object.entries(getters)) {
      Object.defineProperty(o, key, { get: flip.get, enumerable: true });
    }
    return o;
  }

  function readsOf(getters: Record<string, Flip>) {
    return Object.fromEntries(
      Object.entries(getters).map(([key, flip]) => [key, flip.reads()]),
    );
  }
  const ONCE = (getters: Record<string, Flip>) =>
    Object.fromEntries(Object.keys(getters).map((key) => [key, 1]));

  const base = keySigner(KEY);
  const transport = () => new Transport({ env, version: '9.9.9' });

  test('an identity that is an EOA on the first read is an EOA for good', async () => {
    const getters = {
      type: flips('eoa', 'smart_wallet'),
      owner: flips(OWNER, ACCOUNT),
      address: flips(OWNER, ACCOUNT),
      signatureType: flips(0, 3),
      index: flips(undefined, 5n),
    };
    const identity = withGetters(getters) as TradingIdentity;
    const orderbook = installOrderbook(server, {
      now: () => NOW_MS,
      chainId: vectorEnv.chainId,
    });
    const isDeployed = vi.fn(async () => false);
    const auth = new OrderbookAuth(
      transport(),
      base,
      identity,
      vectorEnv,
      fixedClock(),
      { isDeployed },
    );
    expect(readsOf(getters)).toEqual(ONCE(getters));

    await auth.login();
    // The identity is not read again, and the login is the EOA login of the first read.
    expect(readsOf(getters)).toEqual(ONCE(getters));
    expect(isDeployed).not.toHaveBeenCalled();
    expect(l1Of(orderbook, 0)).toEqual(clobAuthVector.expectedHeaders);
  });

  test('an identity that is a smart wallet on the first read is a smart wallet for good', async () => {
    const getters = {
      type: flips('smart_wallet', 'eoa'),
      owner: flips(OWNER, ACCOUNT),
      address: flips(ACCOUNT, OWNER),
      signatureType: flips(3, 0),
      index: flips(0n, undefined),
    };
    const identity = withGetters(getters) as TradingIdentity;
    const orderbook = installOrderbook(server, {
      now: () => NOW_MS,
      smartAccounts: { [ACCOUNT.toLowerCase()]: { owner: OWNER } },
    });
    const isDeployed = vi.fn(async () => true);
    const auth = new OrderbookAuth(
      transport(),
      base,
      identity,
      env,
      fixedClock(),
      { isDeployed },
    );
    expect(readsOf(getters)).toEqual(ONCE(getters));

    await auth.login();
    expect(readsOf(getters)).toEqual(ONCE(getters));
    expect(isDeployed).toHaveBeenCalledWith(ACCOUNT);
    expect(l1Of(orderbook, 0).XO_ADDRESS).toBe(ACCOUNT);
    expect((l1Of(orderbook, 0).XO_SIGNATURE as Hex).startsWith('0x00')).toBe(
      true,
    );
  });

  test('the options are read once: isDeployed and strictResponses keep their first value', async () => {
    const isDeployed = vi.fn(async () => true);
    const getters = {
      isDeployed: flips(isDeployed, 'not a function'),
      strictResponses: flips(true, false),
    };
    const smartWallet = await resolveTradingIdentity(
      base,
      { type: 'smart_wallet', index: 0 },
      env,
      async () => paddedAccount,
    );
    const orderbook = installOrderbook(server, {
      now: () => NOW_MS,
      smartAccounts: { [ACCOUNT.toLowerCase()]: { owner: OWNER } },
    });
    // The create answer has a field the schema does not know: strict mode refuses it.
    orderbook.shape = (route, body) =>
      route === 'create' ? { ...body, surprise: 'x' } : undefined;
    const auth = new OrderbookAuth(
      transport(),
      base,
      smartWallet,
      env,
      fixedClock(),
      withGetters(getters) as OrderbookAuthOptions,
    );
    expect(readsOf(getters)).toEqual(ONCE(getters));

    await expect(auth.login()).rejects.toBeInstanceOf(UnexpectedResponseError);
    expect(readsOf(getters)).toEqual(ONCE(getters));
    expect(isDeployed).toHaveBeenCalledTimes(1);
  });
});
