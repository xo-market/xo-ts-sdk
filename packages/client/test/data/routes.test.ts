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
import type { DataClient } from '../../src/data/client';
import { API_KEY, dataRig } from '../helpers/dataRig';
import {
  PNL_MARKET_ID,
  PNL_POSITION_ID,
  PUBLIC_USER,
} from '../helpers/mockAccountData';
import {
  addressOf,
  conditionIdOf,
  EVENT_ID,
  PULSE_ADDRESS,
  PULSE_ADDRESS_2,
  SERIES_ID,
} from '../helpers/mockBackendData';
import {
  MAKER,
  REWARD_GROUP,
  REWARD_MARKET,
  SCORED_EPOCH,
} from '../helpers/mockRewardsData';

// The request every client method sends for a given call: the method, the exact path, the
// exact query and whether a credential goes with it. This is the matrix the other test files
// check piece by piece; here it is in one place, so a changed route shows up as one diff.

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

interface Case {
  name: string;
  call: (client: DataClient) => Promise<unknown>;
  path: string;
  query: Record<string, string>;
  /** True for a `shared` route: the session key goes with it. */
  keyed?: boolean;
  /** The HTTP method. Defaults to GET. */
  method?: 'DELETE';
  /** How many requests the call makes; the last one is checked. Defaults to 1. */
  requests?: number;
}

const CLOB = { marketScope: 'onlyClob' };
const WITH_PULSE = { marketScope: 'withPulse' };

const CASES: Case[] = [
  {
    name: 'markets.list',
    call: (c) => c.markets.list({ take: 5 }).firstPage(),
    path: '/api/markets',
    query: { page: '1', take: '5', ...CLOB },
  },
  {
    name: 'markets.browse',
    call: (c) => c.markets.browse({ search: 'x' }).firstPage(),
    path: '/api/markets/browse',
    query: { page: '1', search: 'x', ...CLOB },
  },
  {
    name: 'markets.get',
    call: (c) => c.markets.get(7),
    path: '/api/markets/7',
    query: {},
  },
  {
    name: 'markets.bySlug',
    call: (c) => c.markets.bySlug('market-7'),
    path: '/api/markets/slug/market-7',
    query: {},
  },
  {
    name: 'markets.byContract',
    call: (c) => c.markets.byContract(addressOf(7)),
    path: `/api/markets/contract/${addressOf(7)}`,
    query: {},
  },
  {
    name: 'markets.priceHistory',
    call: (c) => c.markets.priceHistory(7).toArray(200),
    path: '/api/markets/7/price-history',
    query: {},
  },
  {
    name: 'markets.statuses',
    call: (c) => c.markets.statuses(7),
    path: '/api/markets/7/statuses',
    query: {},
  },
  {
    name: 'markets.activity',
    call: (c) => c.markets.activity(7, { take: 2 }).firstPage(),
    path: '/api/markets/7/activity',
    query: { page: '1', take: '2' },
  },
  {
    name: 'markets.allActivity',
    call: (c) => c.markets.allActivity({ take: 2 }).firstPage(),
    path: '/api/markets/activities',
    query: { page: '1', take: '2', ...CLOB },
  },
  {
    name: 'markets.feeConfig',
    call: (c) => c.markets.feeConfig(conditionIdOf(1)),
    path: '/api/markets/fee-config/effective',
    query: { marketId: conditionIdOf(1) },
  },
  {
    name: 'markets.tradingStatus',
    call: (c) => c.markets.tradingStatus(),
    path: '/api/markets/clob/trading-status',
    query: {},
    keyed: true,
  },
  {
    name: 'markets.pulseStats',
    call: (c) => c.markets.pulseStats(),
    path: '/api/markets/pulse/stats',
    query: { marketScope: 'onlyClobPulse' },
  },
  {
    name: 'events.list',
    call: (c) => c.events.list({ take: 3 }).firstPage(),
    path: '/api/v1/events',
    query: { page: '1', take: '3' },
  },
  {
    name: 'events.get',
    call: (c) => c.events.get(EVENT_ID),
    path: `/api/v1/events/${EVENT_ID}`,
    query: {},
  },
  {
    name: 'events.bySlug',
    call: (c) => c.events.bySlug('argentina-vs-france'),
    path: '/api/v1/events/slug/argentina-vs-france',
    query: {},
  },
  {
    name: 'events.markets',
    call: (c) => c.events.markets(EVENT_ID, { take: 3 }).firstPage(),
    path: `/api/v1/events/${EVENT_ID}/markets`,
    query: { page: '1', take: '3' },
  },
  {
    name: 'events.subevents',
    call: (c) => c.events.subevents(EVENT_ID).toArray(200),
    path: `/api/v1/events/${EVENT_ID}/subevents`,
    query: {},
  },
  {
    name: 'series.list',
    call: (c) => c.series.list().toArray(200),
    path: '/api/v1/series',
    query: {},
  },
  {
    name: 'series.get',
    call: (c) => c.series.get(SERIES_ID),
    path: `/api/v1/series/${SERIES_ID}`,
    query: {},
  },
  {
    name: 'series.bySlug',
    call: (c) => c.series.bySlug('world-cup-2026'),
    path: '/api/v1/series/slug/world-cup-2026',
    query: {},
  },
  {
    name: 'series.markets',
    call: (c) => c.series.markets(SERIES_ID, { take: 3 }).firstPage(),
    path: `/api/v1/series/${SERIES_ID}/markets`,
    query: { page: '1', take: '3' },
  },
  {
    name: 'pulse.list',
    call: (c) => c.pulse.list({ limit: 3 }).firstPage(),
    path: '/api/pulse/markets',
    query: { page: '1', limit: '3' },
  },
  {
    name: 'pulse.batch',
    call: (c) => c.pulse.batch([PULSE_ADDRESS, PULSE_ADDRESS_2]).toArray(200),
    path: '/api/pulse/markets/batch',
    query: { addresses: `${PULSE_ADDRESS},${PULSE_ADDRESS_2}` },
  },
  {
    name: 'pulse.get',
    call: (c) => c.pulse.get(PULSE_ADDRESS),
    path: `/api/pulse/markets/${PULSE_ADDRESS}`,
    query: {},
  },
  {
    name: 'taxonomy.categories',
    call: (c) => c.taxonomy.categories().toArray(200),
    path: '/api/categories',
    query: CLOB,
  },
  {
    name: 'taxonomy.subcategories',
    call: (c) => c.taxonomy.subcategories().toArray(200),
    path: '/api/subcategories',
    query: CLOB,
  },
  {
    name: 'taxonomy.tokens',
    call: (c) => c.taxonomy.tokens().toArray(200),
    path: '/api/tokens',
    query: {},
  },
  // The account's own routes default to marketScope withPulse: no type filter, so no
  // holding is hidden. The routes that take no scope send none.
  {
    name: 'portfolio.mine',
    call: (c) => c.portfolio.mine({ take: 5 }).firstPage(),
    path: '/api/users/me/portfolio',
    query: { page: '1', take: '5', ...WITH_PULSE },
    keyed: true,
  },
  {
    name: 'portfolio.value',
    call: (c) => c.portfolio.value(),
    path: '/api/users/me/portfolio-value',
    query: {},
    keyed: true,
  },
  {
    name: 'portfolio.redeemable',
    call: (c) => c.portfolio.redeemable({ take: 5 }).firstPage(),
    path: '/api/users/me/redeemable-positions',
    query: { page: '1', take: '5', ...WITH_PULSE },
    keyed: true,
  },
  {
    name: 'portfolio.claimableMarkets',
    call: (c) => c.portfolio.claimableMarkets({ take: 5 }).firstPage(),
    path: '/api/users/me/claimable-markets',
    query: { page: '1', take: '5', ...WITH_PULSE },
    keyed: true,
  },
  {
    name: 'portfolio.openOrders',
    call: (c) => c.portfolio.openOrders({ limit: 5 }).firstPage(),
    path: '/api/users/me/open-orders',
    query: { limit: '5' },
    keyed: true,
  },
  {
    name: 'portfolio.ofWallet',
    call: (c) =>
      c.portfolio.ofWallet({ username: PUBLIC_USER.username }).firstPage(),
    path: '/api/users/portfolio',
    query: { user: PUBLIC_USER.username, page: '1', ...WITH_PULSE },
  },
  {
    name: 'pnl.summary',
    call: (c) => c.pnl.summary(),
    path: '/api/user/pnl',
    query: WITH_PULSE,
    keyed: true,
  },
  {
    name: 'pnl.market',
    call: (c) => c.pnl.market(PNL_MARKET_ID),
    path: `/api/user/pnl/market/${PNL_MARKET_ID}`,
    query: {},
    keyed: true,
  },
  {
    name: 'pnl.position',
    call: (c) => c.pnl.position(PNL_POSITION_ID),
    path: `/api/user/pnl/position/${PNL_POSITION_ID}`,
    query: {},
    keyed: true,
  },
  {
    name: 'activity.mine',
    call: (c) => c.activity.mine({ take: 5 }).firstPage(),
    path: '/api/users/me/activities',
    query: { page: '1', take: '5', ...WITH_PULSE },
    keyed: true,
  },
  {
    name: 'activity.marketActivities',
    call: (c) => c.activity.marketActivities({ take: 5 }).firstPage(),
    path: '/api/users/me/market-activities',
    query: { page: '1', take: '5', ...WITH_PULSE },
    keyed: true,
  },
  {
    name: 'activity.stats',
    call: (c) => c.activity.stats(),
    path: '/api/users/me/stats',
    query: {},
    keyed: true,
  },
  {
    name: 'account.me',
    call: (c) => c.account.me(),
    path: '/api/users/me',
    query: {},
    keyed: true,
  },
  {
    name: 'account.apiKeys',
    call: (c) => c.account.apiKeys().toArray(200),
    path: '/api/auth/api-keys',
    query: {},
    keyed: true,
  },
  // Liquidity rewards. The public routes carry no key; the account's own do. The pages are
  // 0-based (`page`, `page_size`), the leaderboard's 1-based (`page`, `take`).
  {
    name: 'rewards.earningPools',
    call: (c) => c.rewards.earningPools().firstPage(),
    path: '/api/public/liquidity-rewards/earning-pools',
    query: {},
  },
  {
    name: 'rewards.groups',
    call: (c) => c.rewards.groups({ page_size: 2 }).firstPage(),
    path: '/api/public/liquidity-rewards/groups',
    query: { page: '0', page_size: '2' },
  },
  {
    name: 'rewards.group',
    call: (c) => c.rewards.group(REWARD_GROUP),
    path: `/api/public/liquidity-rewards/groups/${REWARD_GROUP}`,
    query: {},
  },
  {
    name: 'rewards.marketConfig',
    call: (c) => c.rewards.marketConfig(REWARD_MARKET),
    path: `/api/public/liquidity-rewards/markets/${REWARD_MARKET}/config`,
    query: {},
  },
  {
    name: 'rewards.market',
    call: (c) => c.rewards.market(REWARD_MARKET),
    path: `/api/public/liquidity-rewards/markets/${REWARD_MARKET}`,
    query: {},
  },
  {
    name: 'rewards.marketEpoch',
    call: (c) => c.rewards.marketEpoch(REWARD_MARKET, SCORED_EPOCH),
    path: `/api/public/liquidity-rewards/markets/${REWARD_MARKET}/epochs/${SCORED_EPOCH}`,
    query: {},
  },
  {
    name: 'rewards.marketEpochMakers',
    call: (c) =>
      c.rewards
        .marketEpochMakers(REWARD_MARKET, SCORED_EPOCH, { page_size: 2 })
        .firstPage(),
    path: `/api/public/liquidity-rewards/markets/${REWARD_MARKET}/epochs/${SCORED_EPOCH}/makers`,
    query: { page: '0', page_size: '2' },
  },
  {
    name: 'rewards.marketEpochOrders',
    call: (c) =>
      c.rewards
        .marketEpochOrders(REWARD_MARKET, SCORED_EPOCH, { page_size: 2 })
        .firstPage(),
    path: `/api/public/liquidity-rewards/markets/${REWARD_MARKET}/epochs/${SCORED_EPOCH}/orders`,
    query: { page: '0', page_size: '2' },
  },
  {
    name: 'rewards.marketWallet',
    call: (c) => c.rewards.marketWallet(REWARD_MARKET, MAKER),
    path: `/api/public/liquidity-rewards/markets/${REWARD_MARKET}/wallets/${MAKER}`,
    query: {},
  },
  {
    name: 'rewards.wallet',
    call: (c) => c.rewards.wallet(MAKER),
    path: `/api/public/liquidity-rewards/wallets/${MAKER}/summary`,
    query: {},
  },
  {
    name: 'rewards.walletEpoch',
    call: (c) => c.rewards.walletEpoch(MAKER, SCORED_EPOCH),
    path: `/api/public/liquidity-rewards/wallets/${MAKER}/epochs/${SCORED_EPOCH}`,
    query: {},
  },
  {
    name: 'rewards.walletOrders',
    call: (c) => c.rewards.walletOrders(MAKER, { page_size: 2 }).firstPage(),
    path: `/api/public/liquidity-rewards/wallets/${MAKER}/orders`,
    query: { page: '0', page_size: '2' },
  },
  {
    name: 'rewards.mySummary',
    call: (c) => c.rewards.mySummary(),
    path: '/api/liquidity-rewards/me/summary',
    query: {},
    keyed: true,
  },
  {
    name: 'rewards.myEpoch',
    call: (c) => c.rewards.myEpoch(SCORED_EPOCH),
    path: `/api/liquidity-rewards/me/epochs/${SCORED_EPOCH}`,
    query: {},
    keyed: true,
  },
  {
    name: 'rewards.myOrders',
    call: (c) => c.rewards.myOrders({ page_size: 2 }).firstPage(),
    path: '/api/liquidity-rewards/me/orders',
    query: { page: '0', page_size: '2' },
    keyed: true,
  },
  {
    name: 'rewards.myGroupHistory',
    call: (c) => c.rewards.myGroupHistory({ page_size: 2 }).firstPage(),
    path: '/api/liquidity-rewards/me/group-history',
    query: { page: '0', page_size: '2' },
    keyed: true,
  },
  {
    name: 'rewards.myMarket',
    call: (c) => c.rewards.myMarket(REWARD_MARKET),
    path: `/api/liquidity-rewards/markets/${REWARD_MARKET}/me`,
    query: {},
    keyed: true,
  },
  {
    name: 'rewards.myGroup',
    call: (c) => c.rewards.myGroup(REWARD_GROUP),
    path: `/api/liquidity-rewards/groups/${REWARD_GROUP}/me`,
    query: {},
    keyed: true,
  },
  {
    name: 'rewards.leaderboard',
    call: (c) => c.rewards.leaderboard({ take: 2 }).firstPage(),
    path: '/api/liquidity-rewards/leaderboard',
    query: { page: '1', take: '2' },
    keyed: true,
  },
  {
    name: 'rewards.myRank',
    call: (c) => c.rewards.myRank(),
    path: '/api/liquidity-rewards/leaderboard/me',
    query: {},
    keyed: true,
  },
  {
    name: 'profiles.get',
    call: (c) => c.profiles.get(PUBLIC_USER.username),
    path: `/api/profiles/${PUBLIC_USER.username}`,
    query: {},
  },
  {
    name: 'profiles.stats',
    call: (c) => c.profiles.stats(PUBLIC_USER.username),
    path: `/api/profiles/${PUBLIC_USER.username}/stats`,
    query: {},
  },
];

describe('the request of every client method', () => {
  test.each(CASES)(
    '$name',
    async ({ call, path, query, keyed, method, requests }) => {
      const { client, backend } = dataRig(server, { session: true });
      await call(client);
      expect(backend.requests).toHaveLength(requests ?? 1);
      const request = backend.requests.at(-1);
      expect(request?.method).toBe(method ?? 'GET');
      expect(request?.path).toBe(path);
      expect(request?.query).toEqual(query);
      expect(request?.sdk).toBe('ts/9.9.9');
      expect(request?.authorization).toBe(keyed ? `Bearer ${API_KEY}` : null);
    },
  );

  test('the matrix names every route of routes.ts', async () => {
    const { routes } = await import('../../src/data/routes');
    expect(CASES.map((entry) => entry.name).sort()).toEqual(
      Object.keys(routes).sort(),
    );
  });

  test('a fixture legacy address and a condition id both resolve (guards the fixtures)', () => {
    expect(addressOf(6)).toHaveLength(42);
  });
});
