import { describe, expect, test } from 'vitest';
import { normalizeAddress } from '../../src/core/address';
import {
  type EnvironmentConfig,
  production,
  resolveEnvironment,
} from '../../src/core/env';
import { UserInputError } from '../../src/core/errors';
import { testEnv } from '../helpers/testEnv';

/** The mainnet contract addresses, checksummed exactly as the built-in preset holds them. */
const CONTRACTS = {
  ctfExchange: '0x4bC5E872256D12E6017dfe466E04c867DC761B77',
  usdc: '0x80c12230ce677e6f304027a14780Edd2A829ab0c',
  conditionalTokens: '0xCcf1b2C676E2f9A13e5674be0e0DdFF6d0B13909',
  clobMarketManager: '0xE1654812Ac8896A69Efa3b6Aa71090E4b44Eb307',
  kernelFactory: '0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419',
  ecdsaValidator: '0x845ADb2C711129d4f3966735eD98a9F09fC4cE57',
} as const;

/** XO's production sponsor: the gas path of mainnet, for plain wallets and smart wallets alike. */
const MAINNET_SPONSOR_URL = 'https://sponsor.xo.market';

/** The exchange XO retired. Mainnet must never name it. */
const LEGACY_EXCHANGE = '0xcf4509b2d036bfa0e8b775b079164f7c827d4d5b';

function lowerCased(addresses: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(addresses).map(([key, value]) => [key, value.toLowerCase()]),
  );
}

/** A valid custom environment on local gateways, with lower-case contract addresses. */
const LOCAL_BASE = {
  name: 'local',
  chainId: 31337,
  backendUrl: 'http://localhost:18080',
  backendSocketUrl: 'http://localhost:18080',
  orderbookUrl: 'http://localhost:18081',
  orderbookMarketWsUrl: 'ws://localhost:18081/ws/market',
  orderbookUserWsUrl: 'ws://localhost:18081/ws/user',
  sponsorUrl: 'http://localhost:18082',
  rpcUrl: 'http://localhost:8545',
  siweDomain: 'localhost:3000',
  siweUri: 'http://localhost:3000',
  contracts: lowerCased(CONTRACTS),
  kernelVersion: '0.3.1',
};

/** A fresh custom environment. `patch` overrides any field, including `contracts`. */
function localEnv(patch: Record<string, unknown> = {}): EnvironmentConfig {
  return {
    ...LOCAL_BASE,
    contracts: { ...LOCAL_BASE.contracts },
    ...patch,
  } as unknown as EnvironmentConfig;
}

/** Passes input the type forbids, so the runtime checks are what get exercised. */
function resolveUnchecked(input: unknown): EnvironmentConfig {
  return resolveEnvironment(input as EnvironmentConfig);
}

/** Returns whatever `fn` throws, or `undefined` when it does not throw. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Asserts the input is rejected with a UserInputError whose message names `field`. */
function expectRejected(input: unknown, field: string): void {
  const error = thrownBy(() => resolveUnchecked(input));
  expect(error).toBeInstanceOf(UserInputError);
  expect((error as UserInputError).message).toContain(field);
}

describe('production', () => {
  test('holds the confirmed mainnet values', () => {
    expect(production).toEqual({
      name: 'mainnet',
      chainId: 3223,
      backendUrl: 'https://api-mainnet.xo.market',
      backendSocketUrl: 'https://api-mainnet.xo.market',
      orderbookUrl: 'https://orderbooks.xo.market',
      orderbookMarketWsUrl: 'wss://orderbooks.xo.market/ws/market',
      orderbookUserWsUrl: 'wss://orderbooks.xo.market/ws/user',
      sponsorUrl: MAINNET_SPONSOR_URL,
      bridge: true,
      rpcUrl: 'https://rpc-mainnet-2.xo.market',
      siweDomain: 'beta.xo.market',
      siweUri: 'https://beta.xo.market',
      contracts: CONTRACTS,
      kernelVersion: '0.3.1',
    });
  });

  test("has XO's production sponsor and no bundler: one gas path, for both wallet types", () => {
    expect(production.sponsorUrl).toBe(MAINNET_SPONSOR_URL);
    expect('bundler' in production).toBe(false);
  });

  test('never names the legacy exchange', () => {
    for (const address of Object.values(production.contracts)) {
      expect(address.toLowerCase()).not.toBe(LEGACY_EXCHANGE);
    }
    expect(production.contracts.ctfExchange.toLowerCase()).toBe(
      CONTRACTS.ctfExchange.toLowerCase(),
    );
  });

  test('is deep-frozen: the preset and its contracts', () => {
    expect(Object.isFrozen(production)).toBe(true);
    expect(Object.isFrozen(production.contracts)).toBe(true);
  });

  test('has the bridge', () => {
    expect(production.bridge).toBe(true);
  });

  test('every contract address is already EIP-55 checksummed', () => {
    for (const [field, address] of Object.entries(production.contracts)) {
      expect(normalizeAddress(address, field)).toBe(address);
    }
  });

  test('passes its own validation unchanged', () => {
    const mainnet = production;
    const copy = resolveUnchecked({
      ...mainnet,
      contracts: { ...mainnet.contracts },
    });
    expect(copy).toEqual(mainnet);
    expect(copy).not.toBe(mainnet);
  });
});

describe('resolveEnvironment', () => {
  test('a custom object passes validation', () => {
    const env = resolveEnvironment(localEnv());
    expect(env.name).toBe('local');
    expect(env.chainId).toBe(31337);
    expect(env.backendUrl).toBe('http://localhost:18080');
    expect(env.orderbookMarketWsUrl).toBe('ws://localhost:18081/ws/market');
    expect(env.kernelVersion).toBe('0.3.1');
  });

  test('a custom object on public https and wss hosts passes validation', () => {
    const env = resolveEnvironment(
      localEnv({
        backendUrl: 'https://api.example.com',
        backendSocketUrl: 'https://api.example.com',
        orderbookUrl: 'https://orderbooks.example.com',
        orderbookMarketWsUrl: 'wss://orderbooks.example.com/ws/market',
        orderbookUserWsUrl: 'wss://orderbooks.example.com/ws/user',
        sponsorUrl: 'https://sponsor.example.com',
        rpcUrl: 'https://rpc.example.com',
      }),
    );
    expect(env.sponsorUrl).toBe('https://sponsor.example.com');
  });

  test('a custom object with a malformed contract address is rejected and the field is named', () => {
    expectRejected(
      localEnv({ contracts: { ...LOCAL_BASE.contracts, usdc: '0x123' } }),
      'contracts.usdc',
    );
  });

  test('a custom object with a missing contract address is rejected and the field is named', () => {
    expectRejected(
      localEnv({
        contracts: { ...LOCAL_BASE.contracts, ecdsaValidator: undefined },
      }),
      'contracts.ecdsaValidator',
    );
  });

  test('contracts that are not an object are rejected', () => {
    expectRejected(localEnv({ contracts: null }), 'contracts');
    expectRejected(localEnv({ contracts: CONTRACTS.ctfExchange }), 'contracts');
  });

  test('a lower-case address comes back checksummed', () => {
    const env = resolveEnvironment(localEnv());
    expect(env.contracts).toEqual(CONTRACTS);
  });

  test('the returned config and its contracts are frozen', () => {
    const env = resolveEnvironment(localEnv());
    expect(Object.isFrozen(env)).toBe(true);
    expect(Object.isFrozen(env.contracts)).toBe(true);
    expect(() => {
      (env as { name: string }).name = 'changed';
    }).toThrow(TypeError);
    expect(() => {
      (env.contracts as { usdc: string }).usdc = CONTRACTS.usdc;
    }).toThrow(TypeError);
  });

  test('does not mutate the input object', () => {
    const input = localEnv();
    const before = JSON.stringify(input);

    const env = resolveEnvironment(input);

    expect(env).not.toBe(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.contracts)).toBe(false);
    expect(input.contracts.usdc).toBe(CONTRACTS.usdc.toLowerCase());
  });

  test('a custom config named like another environment still works', () => {
    const env = resolveEnvironment({ ...testEnv, name: 'staging' });
    expect(env.name).toBe('staging');
    expect(env.backendUrl).toBe(testEnv.backendUrl);
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['true', true],
    ['an array', []],
    ['the name "mainnet"', 'mainnet'],
    ['another name', 'staging'],
  ])(
    'a non-object input (%s) is refused: only a config object is an environment',
    (_, input) => {
      const error = thrownBy(() => resolveUnchecked(input));
      expect(error).toBeInstanceOf(UserInputError);
      expect((error as UserInputError).message).toBe(
        'environment must be an environment config object',
      );
    },
  );
});

describe('URL protocols', () => {
  test('https fields reject plain http on a public host', () => {
    const fields = [
      'backendUrl',
      'backendSocketUrl',
      'orderbookUrl',
      'rpcUrl',
      'sponsorUrl',
    ];
    for (const field of fields) {
      expectRejected(localEnv({ [field]: 'http://example.com' }), field);
    }
  });

  test('wss fields reject https and plain ws on a public host', () => {
    expectRejected(
      localEnv({
        orderbookMarketWsUrl: 'https://orderbooks.example.com/ws/market',
      }),
      'orderbookMarketWsUrl',
    );
    expectRejected(
      localEnv({
        orderbookUserWsUrl: 'https://orderbooks.example.com/ws/user',
      }),
      'orderbookUserWsUrl',
    );
    expectRejected(
      localEnv({ orderbookMarketWsUrl: 'ws://example.com/ws/market' }),
      'orderbookMarketWsUrl',
    );
  });

  test('http://localhost:18080 is accepted and http://example.com is rejected', () => {
    expect(() =>
      resolveUnchecked(localEnv({ backendUrl: 'http://localhost:18080' })),
    ).not.toThrow();
    expectRejected(
      localEnv({ backendUrl: 'http://example.com' }),
      'backendUrl',
    );
  });

  test('http: and ws: are accepted for localhost, 127.0.0.1 and [::1]', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const env = localEnv({
        backendUrl: `http://${host}:18080`,
        backendSocketUrl: `http://${host}:18080`,
        orderbookUrl: `http://${host}:18081`,
        orderbookMarketWsUrl: `ws://${host}:18081/ws/market`,
        orderbookUserWsUrl: `ws://${host}:18081/ws/user`,
        sponsorUrl: `http://${host}:18082`,
        rpcUrl: `http://${host}:8545`,
      });
      expect(() => resolveUnchecked(env)).not.toThrow();
    }
  });

  test('https is accepted on localhost too', () => {
    expect(() =>
      resolveUnchecked(localEnv({ backendUrl: 'https://localhost:8443' })),
    ).not.toThrow();
  });

  test('look-alike hosts do not get the local exception', () => {
    expectRejected(
      localEnv({ backendUrl: 'http://localhost.example.com:18080' }),
      'backendUrl',
    );
    expectRejected(
      localEnv({ orderbookMarketWsUrl: 'ws://127.0.0.2:18081/ws/market' }),
      'orderbookMarketWsUrl',
    );
  });

  test('an unparsable URL throws a UserInputError that names the field', () => {
    expectRejected(localEnv({ backendUrl: 'not a url' }), 'backendUrl');
    expectRejected(
      localEnv({ orderbookMarketWsUrl: '' }),
      'orderbookMarketWsUrl',
    );
    expectRejected(localEnv({ rpcUrl: 42 }), 'rpcUrl');
  });

  test('sponsorUrl may be omitted, and the result then has no sponsorUrl', () => {
    const env = resolveEnvironment(localEnv({ sponsorUrl: undefined }));
    expect(env.sponsorUrl).toBeUndefined();
    expect('sponsorUrl' in env).toBe(false);
  });

  test('a sponsorUrl that is present but invalid is rejected', () => {
    expectRejected(localEnv({ sponsorUrl: '' }), 'sponsorUrl');
  });
});

describe('bridge', () => {
  test('may be omitted, and the result then has no bridge', () => {
    const env = resolveEnvironment(localEnv());
    expect(env.bridge).toBeUndefined();
    expect('bridge' in env).toBe(false);
    expect(
      'bridge' in resolveEnvironment(localEnv({ bridge: undefined })),
    ).toBe(false);
  });

  test.each([true, false])('%s is kept, in a deep-frozen copy', (bridge) => {
    const env = resolveEnvironment(localEnv({ bridge }));
    expect(env.bridge).toBe(bridge);
    expect('bridge' in env).toBe(true);
    expect(Object.isFrozen(env)).toBe(true);
  });

  test.each([
    ['an object', { provider: 'other' }],
    ['an empty object', {}],
    ['null', null],
    ['a string', 'true'],
    ['a number', 1],
    ['an array', [true]],
  ])('%s is rejected: the message says it must be a boolean', (_, bridge) => {
    const error = thrownBy(() => resolveUnchecked(localEnv({ bridge })));
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).message).toBe('bridge must be a boolean');
  });
});

describe('a bundler block', () => {
  const REFUSED =
    "bundler is not supported: XO's chains send through the sponsor (sponsorUrl)";

  /** A `bundler` block, as a custom environment might carry one. */
  const BUNDLER = {
    url: 'https://bundler.example.com/',
    entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    paymaster: '0x2353B23D8F329fD3cEC0d21652F14208248A439d',
  };

  test('a config without it passes, and the result has no bundler key', () => {
    expect('bundler' in resolveEnvironment(localEnv())).toBe(false);
  });

  test('bundler: undefined is ignored: the config passes, and the result has no bundler key', () => {
    const env = resolveUnchecked(localEnv({ bundler: undefined }));
    expect('bundler' in env).toBe(false);
    expect(env.sponsorUrl).toBe('http://localhost:18082');
  });

  test.each([
    ['a bundler block next to a sponsorUrl', localEnv({ bundler: BUNDLER })],
    [
      'a bundler block in place of the sponsorUrl',
      localEnv({ sponsorUrl: undefined, bundler: BUNDLER }),
    ],
    [
      'production with a bundler block added',
      { ...production, bundler: BUNDLER },
    ],
    ['null', localEnv({ bundler: null })],
    ['an empty object', localEnv({ bundler: {} })],
    ['a string', localEnv({ bundler: 'https://bundler.example.com/' })],
    ['false', localEnv({ bundler: false })],
  ])('%s is refused with a UserInputError: it is not ignored', (_, input) => {
    const error = thrownBy(() => resolveUnchecked(input));
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).message).toBe(REFUSED);
    expect((error as UserInputError).code).toBe('invalid_input');
  });

  test('it is refused before any other field is checked', () => {
    const error = thrownBy(() =>
      resolveUnchecked({ bundler: BUNDLER, kernelVersion: '0.2.4' }),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).message).toBe(REFUSED);
  });
});

describe('chainId, name and kernelVersion', () => {
  test('a positive safe integer chainId is accepted', () => {
    expect(resolveUnchecked(localEnv({ chainId: 1 })).chainId).toBe(1);
  });

  test.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2 ** 53,
    '3223',
    null,
  ])('chainId %s is rejected', (chainId) => {
    expectRejected(localEnv({ chainId }), 'chainId');
  });

  test('name must be a non-empty string', () => {
    expectRejected(localEnv({ name: '' }), 'name');
    expectRejected(localEnv({ name: '   ' }), 'name');
    expectRejected(localEnv({ name: 7 }), 'name');
  });

  test('kernelVersion must be exactly 0.3.1', () => {
    expectRejected(localEnv({ kernelVersion: '0.3.0' }), 'kernelVersion');
    expectRejected(localEnv({ kernelVersion: '0.3.1 ' }), 'kernelVersion');
  });
});

describe('siweDomain and siweUri', () => {
  test('a custom config keeps both as written', () => {
    const env = resolveEnvironment(localEnv());
    expect(env.siweDomain).toBe('localhost:3000');
    expect(env.siweUri).toBe('http://localhost:3000');
  });

  test('both are required', () => {
    expectRejected(localEnv({ siweDomain: undefined }), 'siweDomain');
    expectRejected(localEnv({ siweUri: undefined }), 'siweUri');
  });

  test.each([
    'app-beta.example.com',
    'app.example.com',
    'example.com:8443',
    'localhost',
    'localhost:3000',
    '127.0.0.1:3000',
    'a',
    'xn--bcher-kva.example',
  ])('siweDomain %j is accepted', (siweDomain) => {
    expect(resolveUnchecked(localEnv({ siweDomain })).siweDomain).toBe(
      siweDomain,
    );
  });

  test.each([
    ['empty', ''],
    ['upper case', 'App.Example.com'],
    ['a scheme', 'https://app.example.com'],
    ['a path', 'app.example.com/login'],
    ['a trailing slash', 'app.example.com/'],
    ['a space', 'app example.com'],
    ['a trailing space', 'app.example.com '],
    ['a newline', 'app.example.com\nattacker.example'],
    ['userinfo', 'user@app.example.com'],
    ['an underscore', 'app_beta.example.com'],
    ['a port with 6 digits', 'app.example.com:123456'],
    ['an empty port', 'app.example.com:'],
    ['a non-numeric port', 'app.example.com:http'],
    ['two ports', 'app.example.com:80:80'],
    ['non-ASCII', 'b\u00fccher.example'],
    ['a number', 42],
    ['null', null],
  ])('siweDomain that is %s is rejected and named', (_label, siweDomain) => {
    expectRejected(localEnv({ siweDomain }), 'siweDomain');
  });

  test('siweUri follows the URL rules: https, or http on a local host only', () => {
    expect(
      resolveUnchecked(localEnv({ siweUri: 'https://app.example.com' }))
        .siweUri,
    ).toBe('https://app.example.com');
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(() =>
        resolveUnchecked(localEnv({ siweUri: `http://${host}:3000` })),
      ).not.toThrow();
    }
    expectRejected(localEnv({ siweUri: 'http://app.example.com' }), 'siweUri');
    expectRejected(
      localEnv({ siweUri: 'http://localhost.example.com' }),
      'siweUri',
    );
    expectRejected(localEnv({ siweUri: 'ws://localhost:3000' }), 'siweUri');
    expectRejected(localEnv({ siweUri: 'app.example.com' }), 'siweUri');
    expectRejected(localEnv({ siweUri: '' }), 'siweUri');
    expectRejected(localEnv({ siweUri: 42 }), 'siweUri');
  });
});
