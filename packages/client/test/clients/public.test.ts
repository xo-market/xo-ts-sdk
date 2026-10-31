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
import * as account from '../../src/actions/account';
import * as catalog from '../../src/actions/catalog';
import * as events from '../../src/actions/events';
import * as marketData from '../../src/actions/marketData';
import * as markets from '../../src/actions/markets';
import * as profiles from '../../src/actions/profiles';
import * as rewards from '../../src/actions/rewards';
import * as wallets from '../../src/actions/wallets';
import { isPublicClient, isSecureClient } from '../../src/clients/guards';
import { createPublicClient } from '../../src/clients/public';
import { production, resolveEnvironment } from '../../src/core/env';
import { RateLimitError, UserInputError } from '../../src/core/errors';
import type { RateLimitUpdate } from '../../src/core/transport';
import { installAccountData } from '../helpers/mockAccountData';
import { installBackendData } from '../helpers/mockBackendData';
import { installMarketData, TOKEN_YES } from '../helpers/mockMarketData';
import { installRewardsData } from '../helpers/mockRewardsData';
import { testEnv } from '../helpers/testEnv';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

const ACTION_MODULES = [
  account,
  catalog,
  events,
  marketData,
  markets,
  profiles,
  rewards,
  wallets,
] as const;

/** The names of the functions a module exports, which are the public actions. */
function actionNames(module: Record<string, unknown>): string[] {
  return Object.entries(module)
    .filter(
      ([name, value]) =>
        typeof value === 'function' && /^(fetch|list)/.test(name),
    )
    .map(([name]) => name);
}

/** What a fetch spy needs to answer: a JSON body and headers. */
function answer(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** The URL a `fetch` call was given, whether it got a string, a URL or a Request. */
function urlOf(input: unknown): string {
  if (input instanceof Request) {
    return input.url;
  }
  return String(input);
}

describe('createPublicClient', () => {
  test('is synchronous and makes no request, however it is built', () => {
    const spy = vi.fn(async () => answer({}));
    const client = createPublicClient({ fetch: spy });
    createPublicClient({ environment: testEnv, fetch: spy });
    createPublicClient();
    expect(client).toBeDefined();
    expect(spy).not.toHaveBeenCalled();
  });

  test('defaults to XO mainnet, which is the exported production config', async () => {
    const spy = vi.fn(async (_input: unknown) => answer({ state: 'active' }));
    const client = createPublicClient({ fetch: spy as typeof fetch });
    expect(await client.fetchTradingState()).toBe('active');
    expect(urlOf(spy.mock.calls[0]?.[0])).toBe(
      `${production.orderbookUrl}/trading-state`,
    );
    expect(production.orderbookUrl).toBe('https://orderbooks.xo.market');
  });

  test('an environment config sends every request to its hosts', async () => {
    const custom = resolveEnvironment({
      ...testEnv,
      name: 'custom',
      backendUrl: 'https://api.custom.test',
      backendSocketUrl: 'https://api.custom.test',
      orderbookUrl: 'https://book.custom.test',
    });
    const seen: string[] = [];
    const spy = vi.fn(async (input: unknown) => {
      seen.push(urlOf(input));
      return answer(
        seen.length === 1 ? { state: 'paused' } : { message: 'nope' },
      );
    });
    const client = createPublicClient({
      environment: custom,
      fetch: spy as typeof fetch,
    });
    expect(await client.fetchTradingState()).toBe('paused');
    await client.fetchPublicProfile({ username: 'someone' }).catch(() => {});
    expect(seen[0]).toBe('https://book.custom.test/trading-state');
    expect(
      seen[1]?.startsWith('https://api.custom.test/api/profiles/someone'),
    ).toBe(true);
  });

  test('reads market data through the engines, as camelCase models', async () => {
    const data = installMarketData(server);
    const client = createPublicClient({ environment: testEnv });
    const book = await client.fetchOrderBook({ assetId: TOKEN_YES });
    expect(book.assetId).toBe(TOKEN_YES);
    expect(book.minimumTickSize).toBe('0.001');
    expect(book.bids.at(-1)).toEqual({ price: '0.550', size: '100' });
    // No credentials are ever sent.
    expect(data.requests[0]?.headers.get('authorization')).toBeNull();
    expect(data.requests[0]?.headers.get('x-xo-sdk')).toMatch(/^ts\//);
  });

  test('listPriceHistory is a single page with nothing more to read', async () => {
    installMarketData(server);
    const client = createPublicClient({ environment: testEnv });
    const page = await client
      .listPriceHistory({ assetId: TOKEN_YES, interval: 'max' })
      .firstPage();
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeUndefined();
    expect(page.items).toHaveLength(3);
  });

  test('reads the backend and the rewards routes with no credentials', async () => {
    const backend = installBackendData(server, { validKeys: [] });
    installAccountData(server, backend);
    installRewardsData(server, backend);
    const client = createPublicClient({ environment: testEnv });
    const pools = await client.listRewardPools().firstPage();
    expect(pools.items.length).toBeGreaterThan(0);
    const page = await client.listMarkets({ pageSize: 2 }).firstPage();
    expect(page.items.length).toBeGreaterThan(0);
    for (const request of backend.requests) {
      expect(request.authorization).toBeNull();
    }
  });

  test('onRateLimitUpdate hears the rate limits, with retryAfter in milliseconds', async () => {
    const updates: RateLimitUpdate[] = [];
    let calls = 0;
    const spy = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? answer({ state: 'active' }, { 'X-RateLimit-Remaining': '4' })
        : new Response(JSON.stringify({ error: 'rate limit exceeded' }), {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'Retry-After': '30',
            },
          });
    });
    const client = createPublicClient({
      environment: testEnv,
      fetch: spy as typeof fetch,
      onRateLimitUpdate: (update) => updates.push(update),
    });
    await client.fetchTradingState();
    expect(updates).toEqual([
      { service: 'orderbook', path: '/trading-state', remaining: 4 },
    ]);
    const error = await client
      .fetchTradingState({ retries: 0 })
      .catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(updates.at(-1)).toMatchObject({
      service: 'orderbook',
      path: '/trading-state',
      retryAfter: 30_000,
    });
    expect(updates.at(-1)).not.toHaveProperty('retryAfterMs');
  });

  test('closeSubscriptions resolves, and again', async () => {
    const client = createPublicClient({ environment: testEnv });
    await expect(client.closeSubscriptions()).resolves.toBeUndefined();
    await expect(client.closeSubscriptions()).resolves.toBeUndefined();
  });
});

describe('the members of a public client', () => {
  test('are every public action, subscribe and closeSubscriptions, and nothing that needs a wallet', () => {
    const client = createPublicClient({ environment: testEnv });
    const names = ACTION_MODULES.flatMap((module) =>
      actionNames(module),
    ).sort();
    // The actions that read the wallet of the account are not on a client without one.
    const signedInOnly = [
      'fetchMarketCapacity',
      'fetchPortfolioValue',
      'fetchUserPnl',
      'listActivity',
      'fetchProfile',
      'listApiKeys',
      'fetchBalances',
      'fetchTradingApprovalsState',
      'listRewardsLeaderboard',
      'fetchRewardsLeaderboardStanding',
    ];
    const expected = [
      ...names.filter((name) => !signedInOnly.includes(name)),
      'subscribe',
      'closeSubscriptions',
    ].sort();
    expect(Object.keys(client).sort()).toEqual(expected);
    for (const forbidden of [
      'placeLimitOrder',
      'listOpenOrders',
      'cancelOrder',
      'fetchBalances',
      'fetchPortfolioValue',
      'fetchMarketCapacity',
      'transferErc20',
      'withdraw',
      'listRewardsLeaderboard',
    ]) {
      expect(client).not.toHaveProperty(forbidden);
    }
  });

  test('every action runs bound to the same context: no `this`, no shared mutable state', async () => {
    installMarketData(server);
    const { fetchOrderBook } = createPublicClient({ environment: testEnv });
    const book = await fetchOrderBook({ assetId: TOKEN_YES });
    expect(book.assetId).toBe(TOKEN_YES);
  });

  test('is frozen', () => {
    const client = createPublicClient({ environment: testEnv });
    expect(Object.isFrozen(client)).toBe(true);
  });
});

describe('the options', () => {
  test.each([
    ['env', { env: production }],
    ['retries', { retries: 2 }],
    ['signer', { signer: {} }],
    ['apiKey', { apiKey: 'xo_sk_not_a_real_key' }],
    ['onRateLimit', { onRateLimit: () => {} }],
    ['credentials', { credentials: {} }],
    ['strictResponses', { strictResponses: true }],
  ])(
    'an unknown key (%s) is a UserInputError that never echoes a value',
    (key, options) => {
      let error: unknown;
      try {
        createPublicClient(options as never);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(UserInputError);
      const message = (error as UserInputError).message;
      expect(message).toContain(key);
      expect(message).toContain(
        'allowed: environment, fetch, WebSocket, onRateLimitUpdate',
      );
      expect(message).not.toContain('xo_sk_not_a_real_key');
    },
  );

  test.each([
    ['null', null],
    ['an array', []],
    ['a string', 'mainnet'],
    ['a number', 5],
  ])('options that are %s are refused', (_name, options) => {
    expect(() => createPublicClient(options as never)).toThrow(UserInputError);
  });

  test.each([
    ['the name of an environment', 'mainnet'],
    ['a number', 5],
    ['an array', []],
    ['an object that is not a config', { name: 'x' }],
    ['null', null],
  ])('an environment that is %s is refused', (_name, environment) => {
    expect(() => createPublicClient({ environment } as never)).toThrow(
      UserInputError,
    );
  });

  test('an environment with a bundler block is refused, as everywhere', () => {
    expect(() =>
      createPublicClient({ environment: { ...testEnv, bundler: {} } as never }),
    ).toThrow(UserInputError);
  });

  test.each(['fetch', 'WebSocket', 'onRateLimitUpdate'])(
    '%s must be a function',
    (key) => {
      expect(() => createPublicClient({ [key]: 'nope' } as never)).toThrow(
        `${key} must be a function`,
      );
    },
  );

  test('a key set to undefined counts as left out', () => {
    expect(() =>
      createPublicClient({
        environment: undefined,
        fetch: undefined,
        WebSocket: undefined,
        onRateLimitUpdate: undefined,
      }),
    ).not.toThrow();
    expect(() => createPublicClient(undefined)).not.toThrow();
  });
});

describe('isPublicClient, isSecureClient', () => {
  test('a public client is public and not secure', () => {
    const client = createPublicClient({ environment: testEnv });
    expect(isPublicClient(client)).toBe(true);
    expect(isSecureClient(client)).toBe(false);
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'client'],
    ['an empty object', {}],
    ['a copy of a client', { ...createPublicClient({ environment: testEnv }) }],
    ['a function', () => {}],
  ])('%s is neither', (_name, value) => {
    expect(isPublicClient(value)).toBe(false);
    expect(isSecureClient(value)).toBe(false);
  });

  test('they narrow the type', () => {
    const value: unknown = createPublicClient({ environment: testEnv });
    if (isPublicClient(value)) {
      expect(typeof value.fetchOrderBook).toBe('function');
    } else {
      throw new Error('not narrowed');
    }
  });
});
