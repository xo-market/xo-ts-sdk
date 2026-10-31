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
import { BridgeClient } from '../../src/bridge/client';
import { BRIDGE_BASE, bridgeRequest } from '../../src/bridge/internal';
import { BridgeAssetsSchema } from '../../src/bridge/schemas';
import { resolveEnvironment } from '../../src/core/env';
import {
  AuthRequiredError,
  RequestRejectedError,
  UnexpectedResponseError,
  UserInputError,
  type XoError,
} from '../../src/core/errors';
import type { ResponseIssue } from '../../src/core/schema';
import { API_KEY, caught } from '../helpers/dataRig';
import { exceptionResponse } from '../helpers/mockBackend';
import {
  assetFixture,
  BASE_USDC,
  bridgeRig,
  expectNoRequest,
} from '../helpers/mockBridge';
import { eoaIdentity, OWNER, ownerSigner } from '../helpers/railChain';
import { rejectedWith } from '../helpers/rejections';
import { testEnv } from '../helpers/testEnv';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

const PATH = '/api/bridge/halliday/assets';

describe('bridge.assets', () => {
  test.each(['deposit', 'withdraw'] as const)(
    'assets(%s) sends a GET to the assets route with that direction and the session key, and returns the data array',
    async (direction) => {
      const { bridge, backend } = bridgeRig(server);
      const assets = await bridge.assets(direction);

      expect(assets).toEqual(backend.fixtures.assets[direction]);
      expect(assets.length).toBeGreaterThan(0);
      expect(backend.requests).toEqual([
        {
          method: 'GET',
          path: PATH,
          query: { direction },
          body: undefined,
          authorization: `Bearer ${API_KEY}`,
          sdk: 'ts/9.9.9',
        },
      ]);
    },
  );

  test('every field of an asset reaches the caller, a null chainId and imageUrl included', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.fixtures.assets.deposit = [
      assetFixture({ asset: BASE_USDC }),
      assetFixture({
        asset: 'solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        chain: 'solana',
        chainId: null,
        addressFamily: 'SOLANA',
        address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        imageUrl: null,
      }),
    ];
    const [base, solana] = await bridge.assets('deposit');
    expect(base).toEqual({
      asset: BASE_USDC,
      chain: 'base',
      chainId: '8453',
      addressFamily: 'EVM',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      isNative: false,
      imageUrl: 'https://assets.example.com/usdc.png',
    });
    expect(solana?.chainId).toBeNull();
    expect(solana?.imageUrl).toBeNull();
  });

  test("a chainId is a decimal string, even one no JavaScript number can hold (the bridge's 'lighter')", async () => {
    const LIGHTER =
      '15612896610276392836160245705657308592300226117149160863833114727361512420537';
    const { bridge, backend } = bridgeRig(server);
    backend.fixtures.assets.withdraw = [
      assetFixture({ asset: BASE_USDC, chainId: '8453' }),
      assetFixture({ asset: 'lighter:3', chain: 'lighter', chainId: LIGHTER }),
    ];
    const [base, lighter] = await bridge.assets('withdraw');
    expect(base?.chainId).toBe('8453');
    expect(lighter?.chainId).toBe(LIGHTER);
  });

  test('a chainId the backend sends as a JSON number reaches the caller as its decimal string', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.fixtures.assets.deposit = [
      assetFixture({ asset: BASE_USDC, chainId: 8453 }),
    ];
    const [base] = await bridge.assets('deposit');
    expect(base?.chainId).toBe('8453');
  });

  test.each([
    '0x2105',
    '8453.0',
    '-1',
    '',
    ' 8453',
    '1e3',
    '1'.repeat(79),
    8453.5,
    -1,
    Number.MAX_SAFE_INTEGER + 2,
  ])(
    'a chainId that is not a plain decimal of at most 78 digits, nor a safe non-negative integer (%j) → UnexpectedResponseError',
    async (bad) => {
      const { bridge, backend } = bridgeRig(server);
      backend.fixtures.assets.deposit = [
        assetFixture({ asset: BASE_USDC, chainId: bad }),
      ];
      const error = await caught(() => bridge.assets('deposit'));
      expect(error).toBeInstanceOf(UnexpectedResponseError);
      expect((error as XoError).mayHaveLanded).toBe(false);
    },
  );

  test('an empty list is a list', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.fixtures.assets.withdraw = [];
    expect(await bridge.assets('withdraw')).toEqual([]);
  });

  test.each(['sideways', '', 'DEPOSIT', undefined, null, 42, {}])(
    'assets(%j) → UserInputError, mayHaveLanded false, and no request',
    async (bad) => {
      const { bridge, backend } = bridgeRig(server);
      const error = await caught(() => bridge.assets(bad as never));
      expect(error).toBeInstanceOf(UserInputError);
      expect((error as UserInputError).code).toBe('invalid_input');
      expect((error as UserInputError).mayHaveLanded).toBe(false);
      expectNoRequest(backend);
    },
  );
});

describe('the bridge gate', () => {
  test('a config without a bridge → UserInputError bridge_not_available, mayHaveLanded false, and no request', async () => {
    const { bridge, backend } = bridgeRig(server, { env: testEnv });
    const error = await caught(() => bridge.assets('deposit'));
    expect(error).toBeInstanceOf(UserInputError);
    const xo = error as XoError;
    expect(xo.code).toBe('bridge_not_available');
    expect(xo.service).toBe('sdk');
    expect(xo.mayHaveLanded).toBe(false);
    expect(xo.message).toContain(`The ${testEnv.name} environment`);
    expectNoRequest(backend);
  });

  test('a config without a bridge: the gate is the first thing a method does: before the input check and before the credential check', async () => {
    const { bridge, backend } = bridgeRig(server, {
      env: testEnv,
      session: 'none',
    });
    const error = await caught(() => bridge.assets('sideways' as never));
    expect((error as XoError).code).toBe('bridge_not_available');
    expectNoRequest(backend);
  });

  test('a config with bridge: false fails the gate the same way, nothing sent', async () => {
    const { bridge, backend } = bridgeRig(server, {
      env: resolveEnvironment({ ...testEnv, bridge: false }),
    });
    const error = await caught(() => bridge.assets('deposit'));
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as XoError).code).toBe('bridge_not_available');
    expect((error as XoError).mayHaveLanded).toBe(false);
    expectNoRequest(backend);
  });

  test('an environment with bridge: true passes the gate', async () => {
    const { bridge, backend } = bridgeRig(server, {
      env: resolveEnvironment({ ...testEnv, bridge: true }),
    });
    await bridge.assets('deposit');
    expect(backend.requests).toHaveLength(1);
  });
});

describe('credentials', () => {
  test.each(['none', false] as const)(
    'a session with neither a signer nor a key (%s) → AuthRequiredError, mayHaveLanded false, and no request',
    async (session) => {
      const { bridge, backend } = bridgeRig(server, { session });
      const error = await caught(() => bridge.assets('deposit'));
      expect(error).toBeInstanceOf(AuthRequiredError);
      const xo = error as XoError;
      expect(xo.code).toBe('auth_required');
      expect(xo.service).toBe('backend');
      expect(xo.mayHaveLanded).toBe(false);
      expect(xo.message).toContain('signer');
      expectNoRequest(backend);
    },
  );

  test('a bad direction is refused before the credential check', async () => {
    const { bridge, backend } = bridgeRig(server, { session: 'none' });
    const error = await caught(() => bridge.assets('sideways' as never));
    expect(error).toBeInstanceOf(UserInputError);
    expectNoRequest(backend);
  });
});

describe('the backend says no', () => {
  test('404 bridge_not_available → 404 rejection with that code, mayHaveLanded false', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.override('assets', ({ request }) =>
      exceptionResponse(request.path, 404, {
        error: 'bridge_not_available',
        message: 'The bridge is not available',
      }),
    );
    const error = await caught(() => bridge.assets('deposit'));
    expect(error).toSatisfy(rejectedWith(404));
    const xo = error as XoError;
    expect(xo.code).toBe('bridge_not_available');
    expect(xo.status).toBe(404);
    expect(xo.service).toBe('backend');
    // A read moves nothing.
    expect(xo.mayHaveLanded).toBe(false);
    expect(backend.requests).toHaveLength(1);
  });

  test('a 503 is not retried by the test transport and carries mayHaveLanded false', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.override('assets', ({ request }) =>
      exceptionResponse(request.path, 503, {
        error: 'halliday_unavailable',
        message: 'down',
      }),
    );
    const error = await caught(() => bridge.assets('withdraw'));
    expect((error as XoError).code).toBe('bridge_unavailable');
    expect((error as XoError).mayHaveLanded).toBe(false);
    expect(backend.requests).toHaveLength(1);
  });

  test('the flat 400 of a DTO that failed has the default code and mayHaveLanded false', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.override('assets', () =>
      Response.json(
        {
          statusCode: 400,
          message: ['direction must be one of the following values'],
          error: 'Bad Request',
        },
        { status: 400 },
      ),
    );
    const error = await caught(() => bridge.assets('deposit'));
    expect(error).toSatisfy(rejectedWith(400));
    expect((error as XoError).mayHaveLanded).toBe(false);
  });
});

describe("the bridge provider's failures", () => {
  /** A backend answer whose message names the provider, as the backend's text may. */
  const failure = (path: string, status: number, code: string) =>
    new Response(
      JSON.stringify({
        statusCode: status,
        response: { error: code, message: 'Halliday is unavailable' },
        path,
      }),
      {
        status,
        headers: { 'Retry-After': '7', 'x-correlation-id': 'corr-7' },
      },
    );

  test.each([
    ['halliday_unavailable', 503, 'bridge_unavailable'],
    ['bridge_unavailable', 503, 'bridge_unavailable'],
    ['halliday_rejected', 502, 'bridge_rejected'],
    ['bridge_rejected', 502, 'bridge_rejected'],
  ] as const)(
    'the backend code %s (status %i) reaches the caller as %s, with every other field kept',
    async (backendCode, status, code) => {
      const { bridge, backend } = bridgeRig(server);
      backend.override('assets', ({ request }) =>
        failure(request.path, status, backendCode),
      );
      const error = await caught(() => bridge.assets('deposit'));
      expect(error).toBeInstanceOf(RequestRejectedError);
      expect(error).toSatisfy(rejectedWith(status));
      const xo = error as RequestRejectedError;
      expect(xo.code).toBe(code);
      expect(xo.status).toBe(status);
      expect(xo.service).toBe('backend');
      expect(xo.requestId).toBe('corr-7');
      expect(xo.retryAfter).toBe(7000);
      expect(xo.mayHaveLanded).toBe(false);
      expect(backend.requests).toHaveLength(1);
    },
  );

  test.each([
    ['halliday_unavailable', 503, 'The bridge provider is unavailable'],
    ['bridge_unavailable', 503, 'The bridge provider is unavailable'],
    ['halliday_rejected', 502, 'The bridge provider refused the request'],
    ['bridge_rejected', 502, 'The bridge provider refused the request'],
  ] as const)(
    "the backend code %s gets the SDK's own message, which never names the provider",
    async (backendCode, status, message) => {
      const { bridge, backend } = bridgeRig(server);
      backend.override('assets', ({ request }) =>
        failure(request.path, status, backendCode),
      );
      const error = (await caught(() => bridge.assets('deposit'))) as XoError;
      // The backend's text is gone: nothing on the error, its cause included, carries it.
      expect(error.message).toBe(message);
      expect(String(error)).toBe(`RequestRejectedError: ${message}`);
      expect(error.cause).toBeUndefined();
      expect(error.toJSON()).toEqual({
        name: 'RequestRejectedError',
        code: error.code,
        service: 'backend',
        status,
        requestId: 'corr-7',
        message,
        retryAfter: 7000,
        mayHaveLanded: false,
      });
    },
  );

  test('any other code keeps its code and the backend message', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.override('assets', ({ request }) =>
      exceptionResponse(request.path, 400, {
        error: 'asset_not_supported',
        message: 'Asset is not supported',
      }),
    );
    const error = (await caught(() => bridge.assets('deposit'))) as XoError;
    expect(error.code).toBe('asset_not_supported');
    expect(error.message).toBe('Asset is not supported');
  });
});

describe('bridgeRequest: what is retried', () => {
  const unavailable = (path: string) =>
    new Response(
      JSON.stringify({
        statusCode: 503,
        response: { error: 'halliday_unavailable', message: 'down' },
        path,
      }),
      { status: 503, headers: { 'Retry-After': '0' } },
    );

  test('a GET is retried like a read: 503, then the answer', async () => {
    const { bridge, backend } = bridgeRig(server, { maxRetries: 2 });
    let attempts = 0;
    backend.override('assets', ({ request }) => {
      attempts += 1;
      return attempts === 1
        ? unavailable(request.path)
        : Response.json({ data: [assetFixture()] });
    });
    expect(await bridge.assets('deposit')).toEqual([assetFixture()]);
    expect(backend.requests).toHaveLength(2);
  });

  test('a POST is sent once, whatever the transport allows, and its error is left for the method to classify', async () => {
    const { backend, env, transport, session } = bridgeRig(server, {
      maxRetries: 2,
    });
    backend.override('quotes', ({ request }) => unavailable(request.path));
    const error = await caught(() =>
      bridgeRequest(
        { env, transport, session, strict: false },
        {
          method: 'POST',
          path: `${BRIDGE_BASE}/quotes`,
          body: { direction: 'deposit' },
          schema: BridgeAssetsSchema,
        },
      ),
    );
    expect((error as XoError).code).toBe('bridge_unavailable');
    expect((error as XoError).mayHaveLanded).toBeUndefined();
    expect(backend.requests).toHaveLength(1);
    expect(backend.requests[0]).toMatchObject({
      method: 'POST',
      path: `${BRIDGE_BASE}/quotes`,
      body: { direction: 'deposit' },
      authorization: `Bearer ${API_KEY}`,
    });
  });

  test("a POST's failure of the bridge provider leaves under the bridge's code, mayHaveLanded left for the method", async () => {
    const { backend, env, transport, session } = bridgeRig(server);
    backend.override('quotes', ({ request }) => unavailable(request.path));
    const error = await caught(() =>
      bridgeRequest(
        { env, transport, session, strict: false },
        {
          method: 'POST',
          path: `${BRIDGE_BASE}/quotes`,
          body: { direction: 'deposit' },
          schema: BridgeAssetsSchema,
        },
      ),
    );
    expect(error).toBeInstanceOf(RequestRejectedError);
    expect((error as XoError).code).toBe('bridge_unavailable');
    expect((error as XoError).mayHaveLanded).toBeUndefined();
  });

  test('a config without a bridge: the gate and the credential check still come first for a POST, with mayHaveLanded false', async () => {
    const off = bridgeRig(server, { env: testEnv });
    const gated = await caught(() =>
      bridgeRequest(
        { ...off, strict: false },
        {
          method: 'POST',
          path: `${BRIDGE_BASE}/quotes`,
          schema: BridgeAssetsSchema,
        },
      ),
    );
    expect((gated as XoError).code).toBe('bridge_not_available');
    const none = bridgeRig(server, { session: 'none' });
    const refused = await caught(() =>
      bridgeRequest(
        { ...none, strict: false },
        {
          method: 'POST',
          path: `${BRIDGE_BASE}/quotes`,
          schema: BridgeAssetsSchema,
        },
      ),
    );
    expect(refused).toBeInstanceOf(AuthRequiredError);
    expect((refused as XoError).mayHaveLanded).toBe(false);
    expectNoRequest(off.backend);
    expectNoRequest(none.backend);
  });
});

describe('response checks', () => {
  test('a missing field → UnexpectedResponseError naming it, in lenient mode too', async () => {
    const { bridge, backend } = bridgeRig(server);
    const { symbol: _symbol, ...incomplete } = assetFixture();
    backend.override('assets', () => Response.json({ data: [incomplete] }));
    const error = await caught(() => bridge.assets('deposit'));
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    const failure = error as UnexpectedResponseError;
    expect(failure.service).toBe('backend');
    expect(
      (failure.issues as ResponseIssue[]).map((issue) => issue.path),
    ).toEqual(['data.0.symbol']);
    expect(failure.message).toContain(PATH);
    expect(failure.mayHaveLanded).toBe(false);
  });

  test('a wrong type → UnexpectedResponseError', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.override('assets', () =>
      Response.json({ data: [assetFixture({ decimals: '6' })] }),
    );
    const error = await caught(() => bridge.assets('deposit'));
    expect(error).toBeInstanceOf(UnexpectedResponseError);
  });

  test('an answer that is not wrapped in { data } → UnexpectedResponseError', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.override('assets', () => Response.json([assetFixture()]));
    const error = await caught(() => bridge.assets('deposit'));
    expect(error).toBeInstanceOf(UnexpectedResponseError);
  });

  test('an unknown field is kept in lenient mode and refused in strict mode', async () => {
    const extra = assetFixture({ riskScore: 3 });

    const lenient = bridgeRig(server);
    lenient.backend.override('assets', () => Response.json({ data: [extra] }));
    const [kept] = await lenient.bridge.assets('deposit');
    expect(kept).toMatchObject({ riskScore: 3 });

    const strict = bridgeRig(server, { strict: true });
    strict.backend.override('assets', () => Response.json({ data: [extra] }));
    const error = await caught(() => strict.bridge.assets('deposit'));
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(
      ((error as UnexpectedResponseError).issues as ResponseIssue[]).map(
        (issue) => issue.code,
      ),
    ).toEqual(['unrecognized_keys']);
  });

  test('strict mode accepts the backend answer as it is', async () => {
    const { bridge, backend } = bridgeRig(server, { strict: true });
    expect(await bridge.assets('deposit')).toEqual(
      backend.fixtures.assets.deposit,
    );
  });
});

describe('the environment field', () => {
  const custom = { ...testEnv, name: 'custom' };

  test('a bridge that is not a boolean is refused, as a bad field is', () => {
    for (const value of [{ provider: 'other' }, 'true', 1, null]) {
      const run = () =>
        resolveEnvironment({
          ...custom,
          bridge: value as never,
        });
      expect(run).toThrow(UserInputError);
      expect(run).toThrow('bridge must be a boolean');
    }
  });

  test('bridge: true is kept, and the copy is frozen', () => {
    const env = resolveEnvironment({ ...custom, bridge: true });
    expect(env.bridge).toBe(true);
    expect(Object.isFrozen(env)).toBe(true);
  });
});

describe('BridgeClient construction', () => {
  function parts() {
    const rig = bridgeRig(server);
    return {
      rig,
      options: {
        env: rig.env,
        transport: rig.transport,
        session: rig.session,
        identity: async () => eoaIdentity(),
        chain: rig.chain.reader,
        account: rig.account,
      },
    };
  }

  test('checks the options and requests nothing', () => {
    const { rig, options } = parts();
    expect(() => new BridgeClient(options)).not.toThrow();
    expect(
      () =>
        new BridgeClient({
          ...options,
          signer: ownerSigner(),
          strictResponses: true,
        }),
    ).not.toThrow();
    expectNoRequest(rig.backend);
  });

  test.each([
    'env',
    'transport',
    'session',
    'identity',
    'chain',
    'account',
  ] as const)('options without %s → UserInputError', (missing) => {
    const { options } = parts();
    const { [missing]: _left, ...rest } = options;
    expect(() => new BridgeClient(rest as never)).toThrow(UserInputError);
  });

  test.each([
    ['an unknown option', { store: 1 }],
    ['a signer that cannot sign', { signer: { address: OWNER } }],
    ['strictResponses that is not a boolean', { strictResponses: 'yes' }],
    ['an identity that is not a function', { identity: eoaIdentity() }],
    ['a transport that cannot request', { transport: {} }],
    ['a session that is not a Session', { session: {} }],
    ['an account without transferUsdc', { account: {} }],
    ['a chain without readContract', { chain: {} }],
  ])('%s → UserInputError', (_, patch) => {
    const { options } = parts();
    expect(() => new BridgeClient({ ...options, ...patch } as never)).toThrow(
      UserInputError,
    );
  });

  test.each([undefined, null, 'options', []])(
    'options %j → UserInputError',
    (bad) => {
      expect(() => new BridgeClient(bad as never)).toThrow(UserInputError);
    },
  );

  test('a message never holds a value', () => {
    const { options } = parts();
    try {
      new BridgeClient({
        ...options,
        strictResponses: 'secret-value',
      } as never);
      expect.unreachable();
    } catch (error) {
      expect((error as XoError).message).not.toContain('secret-value');
    }
  });
});
