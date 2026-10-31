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
import { coverage, FRONTEND_ONLY } from '../../src/data/coverage';
import { routes } from '../../src/data/routes';
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
  SERIES_ID,
} from '../helpers/mockBackendData';
import {
  MAKER,
  REWARD_GROUP,
  REWARD_MARKET,
  SCORED_EPOCH,
} from '../helpers/mockRewardsData';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

// The routes the coverage map lists, as the backend's route index lists them, with their
// declared access today (`none (no guard)` is public): every public or shared route of the
// index, and the frontend ones of the areas of this client, which are skipped as
// frontend-only. One frontend route of another area stays listed: the conviction report
// (`POST /api/convictions/:eventId/reports`) refuses API keys like seven writes of the
// client's areas, so it is skipped as frontend-only like them. The areas of the client are
// markets, events, series, pulse and the taxonomy, the account routes (`/users`, `/user/pnl`,
// `/profiles`, `/auth`, `/user-notifications`, `/user-market-assets`), the liquidity rewards,
// points and open-orders section (`/liquidity-rewards`, `/public/liquidity-rewards`,
// `/points`), and the public routes of other areas that the market routes brought up
// (`/charts`, `/market-comments`, `/contests/:slug/markets`). The last block is the public or
// shared routes of every other area (skipped as another area, not part of the SDK yet). The route
// coverage check compares the live registry with `coverage`; this snapshot keeps the list honest in
// between.
const REGISTRY: Array<[string, string, 'public' | 'shared' | 'frontend']> = [
  ['GET', '/api/categories', 'public'],
  ['GET', '/api/categories/:id', 'frontend'],
  ['GET', '/api/categories/volume', 'public'],
  ['GET', '/api/markets', 'public'],
  ['GET', '/api/markets/:id', 'public'],
  ['GET', '/api/markets/:id/activity', 'public'],
  ['GET', '/api/markets/:id/analytics', 'frontend'],
  ['GET', '/api/markets/:id/contests', 'public'],
  ['GET', '/api/markets/:id/cp-rate', 'public'],
  ['GET', '/api/markets/:id/latest-prices', 'frontend'],
  ['POST', '/api/markets/:id/like', 'frontend'],
  ['GET', '/api/markets/:id/participants', 'frontend'],
  ['GET', '/api/markets/:id/price-history', 'public'],
  ['GET', '/api/markets/:id/reviewed', 'frontend'],
  ['GET', '/api/markets/:id/statuses', 'public'],
  ['POST', '/api/markets/:id/unlike', 'frontend'],
  ['POST', '/api/markets/:marketId/dispute', 'frontend'],
  ['GET', '/api/markets/:marketId/disputes', 'public'],
  ['GET', '/api/markets/:marketId/resolution-flags', 'shared'],
  ['POST', '/api/markets/:marketId/signal-resolution', 'frontend'],
  ['GET', '/api/markets/activities', 'public'],
  ['GET', '/api/markets/browse', 'public'],
  ['GET', '/api/markets/clob/trading-status', 'shared'],
  ['GET', '/api/markets/contract/:contractAddress', 'public'],
  ['GET', '/api/markets/fee-config/effective', 'public'],
  ['GET', '/api/markets/pulse/stats', 'public'],
  ['GET', '/api/markets/slug/:slug', 'public'],
  ['GET', '/api/pulse/markets', 'public'],
  ['GET', '/api/pulse/markets/:address', 'public'],
  ['GET', '/api/pulse/markets/batch', 'public'],
  ['GET', '/api/pulse/twap/adapters/:adapterConfigId', 'public'],
  ['GET', '/api/pulse/twap/adapters/:adapterConfigId/points', 'public'],
  ['GET', '/api/subcategories', 'public'],
  ['GET', '/api/subcategories/:id', 'public'],
  ['GET', '/api/subcategories/active', 'public'],
  ['GET', '/api/subcategories/category/:categoryId', 'public'],
  ['GET', '/api/tokens', 'public'],
  ['GET', '/api/v1/events', 'public'],
  ['GET', '/api/v1/events/:eventId', 'public'],
  ['GET', '/api/v1/events/:eventId/activity', 'public'],
  ['GET', '/api/v1/events/:eventId/charts/points', 'public'],
  ['GET', '/api/v1/events/:eventId/comments', 'public'],
  ['POST', '/api/v1/events/:eventId/comments', 'frontend'],
  ['GET', '/api/v1/events/:eventId/leaderboard', 'public'],
  ['GET', '/api/v1/events/:eventId/leaderboard/me', 'shared'],
  ['GET', '/api/v1/events/:eventId/markets', 'public'],
  ['GET', '/api/v1/events/:eventId/media', 'public'],
  ['GET', '/api/v1/events/:eventId/portfolio', 'shared'],
  ['GET', '/api/v1/events/:eventId/score', 'public'],
  ['GET', '/api/v1/events/:eventId/subevents', 'public'],
  ['GET', '/api/v1/events/slug/:slug', 'public'],
  ['GET', '/api/v1/events/sports', 'public'],
  ['GET', '/api/v1/series', 'public'],
  ['GET', '/api/v1/series/:seriesId', 'public'],
  ['GET', '/api/v1/series/:seriesId/leaderboard', 'public'],
  ['GET', '/api/v1/series/:seriesId/leaderboard/me', 'shared'],
  ['GET', '/api/v1/series/:seriesId/markets', 'public'],
  ['GET', '/api/v1/series/:seriesId/portfolio', 'shared'],
  ['GET', '/api/v1/series/slug/:slug', 'public'],
  ['POST', '/api/auth/activate', 'frontend'],
  ['GET', '/api/auth/api-keys', 'shared'],
  ['POST', '/api/auth/api-keys', 'frontend'],
  ['DELETE', '/api/auth/api-keys/:id', 'shared'],
  ['POST', '/api/auth/api-keys/nonce', 'public'],
  ['GET', '/api/auth/user/me', 'frontend'],
  ['GET', '/api/charts/:marketId', 'public'],
  ['GET', '/api/charts/:marketId/current', 'public'],
  ['POST', '/api/charts/current', 'public'],
  ['GET', '/api/charts/market/:id/points', 'public'],
  ['GET', '/api/contests/:slug/markets', 'public'],
  ['GET', '/api/contests/:slug/markets/browse', 'public'],
  ['GET', '/api/liquidity-rewards/earning-pools', 'shared'],
  ['GET', '/api/liquidity-rewards/groups/:groupId/me', 'shared'],
  ['GET', '/api/liquidity-rewards/leaderboard', 'shared'],
  ['GET', '/api/liquidity-rewards/leaderboard/me', 'shared'],
  ['GET', '/api/liquidity-rewards/markets/:marketId/config', 'shared'],
  ['GET', '/api/liquidity-rewards/markets/:marketId/me', 'shared'],
  ['GET', '/api/liquidity-rewards/me/epochs/:epoch', 'shared'],
  ['GET', '/api/liquidity-rewards/me/group-history', 'shared'],
  ['GET', '/api/liquidity-rewards/me/orders', 'shared'],
  ['GET', '/api/liquidity-rewards/me/summary', 'shared'],
  ['POST', '/api/points/calculate', 'shared'],
  ['GET', '/api/points/market', 'shared'],
  ['GET', '/api/public/liquidity-rewards/earning-pools', 'public'],
  ['GET', '/api/public/liquidity-rewards/groups', 'public'],
  ['GET', '/api/public/liquidity-rewards/groups/:groupId', 'public'],
  ['GET', '/api/public/liquidity-rewards/markets/:marketId', 'public'],
  ['GET', '/api/public/liquidity-rewards/markets/:marketId/config', 'public'],
  [
    'GET',
    '/api/public/liquidity-rewards/markets/:marketId/epochs/:epoch',
    'public',
  ],
  [
    'GET',
    '/api/public/liquidity-rewards/markets/:marketId/epochs/:epoch/makers',
    'public',
  ],
  [
    'GET',
    '/api/public/liquidity-rewards/markets/:marketId/epochs/:epoch/orders',
    'public',
  ],
  [
    'GET',
    '/api/public/liquidity-rewards/markets/:marketId/wallets/:walletAddress',
    'public',
  ],
  [
    'GET',
    '/api/public/liquidity-rewards/wallets/:walletAddress/epochs/:epoch',
    'public',
  ],
  [
    'GET',
    '/api/public/liquidity-rewards/wallets/:walletAddress/orders',
    'public',
  ],
  [
    'GET',
    '/api/public/liquidity-rewards/wallets/:walletAddress/summary',
    'public',
  ],
  ['GET', '/api/market-comments', 'public'],
  ['POST', '/api/market-comments', 'frontend'],
  ['GET', '/api/market-comments/:id', 'public'],
  ['GET', '/api/market-comments/recent/pulse', 'public'],
  ['GET', '/api/profiles/:username', 'public'],
  ['GET', '/api/profiles/:username/activities', 'public'],
  ['GET', '/api/profiles/:username/badges', 'public'],
  ['GET', '/api/profiles/:username/clob-pulse-pnl', 'public'],
  ['GET', '/api/profiles/:username/pnl-history', 'public'],
  ['GET', '/api/profiles/:username/portfolio', 'public'],
  ['GET', '/api/profiles/:username/pulse-pnl', 'public'],
  ['GET', '/api/profiles/:username/stats', 'public'],
  ['GET', '/api/profiles/:username/won-markets/count', 'public'],
  ['POST', '/api/user-market-assets/upload-image', 'frontend'],
  ['POST', '/api/user-market-assets/upload-metadata', 'frontend'],
  ['GET', '/api/user-notifications', 'shared'],
  ['POST', '/api/user-notifications/:id/read', 'frontend'],
  ['POST', '/api/user-notifications/read-all', 'frontend'],
  ['GET', '/api/user-notifications/unread-count', 'shared'],
  ['GET', '/api/user/pnl', 'shared'],
  ['GET', '/api/user/pnl/market/:marketId', 'shared'],
  ['GET', '/api/user/pnl/position/:positionId', 'shared'],
  ['POST', '/api/users/achievement-mint-signature', 'frontend'],
  ['GET', '/api/users/active-markets', 'shared'],
  ['GET', '/api/users/activity', 'shared'],
  ['GET', '/api/users/creator/history', 'shared'],
  ['GET', '/api/users/leaderboard', 'shared'],
  ['GET', '/api/users/leaderboard/me', 'shared'],
  ['GET', '/api/users/leaderboard/resolution', 'shared'],
  ['GET', '/api/users/me', 'shared'],
  ['GET', '/api/users/me/activities', 'shared'],
  ['GET', '/api/users/me/activities/composite', 'shared'],
  ['GET', '/api/users/me/badges', 'shared'],
  ['GET', '/api/users/me/ban-status', 'shared'],
  ['GET', '/api/users/me/boarding-pass-claim', 'frontend'],
  ['POST', '/api/users/me/boarding-pass-claim/claim', 'frontend'],
  ['POST', '/api/users/me/boarding-pass-claim/confirm', 'frontend'],
  ['PATCH', '/api/users/me/boarding-pass-claim/steps', 'frontend'],
  ['GET', '/api/users/me/bridge-activities', 'shared'],
  ['POST', '/api/users/me/claim-username', 'frontend'],
  ['GET', '/api/users/me/claimable-fees', 'shared'],
  ['GET', '/api/users/me/claimable-markets', 'shared'],
  ['GET', '/api/users/me/clob-pulse-pnl', 'shared'],
  ['GET', '/api/users/me/clob-pulse-volume', 'shared'],
  ['GET', '/api/users/me/cp-summary', 'shared'],
  ['GET', '/api/users/me/cp-unsettled', 'shared'],
  ['GET', '/api/users/me/creator-analytics', 'shared'],
  ['GET', '/api/users/me/fees/by-market', 'shared'],
  ['GET', '/api/users/me/fees/history', 'shared'],
  ['GET', '/api/users/me/fees/summary', 'shared'],
  ['GET', '/api/users/me/invite-codes', 'shared'],
  ['POST', '/api/users/me/invite-codes', 'frontend'],
  ['GET', '/api/users/me/invite-codes/stats', 'shared'],
  ['GET', '/api/users/me/invited-users', 'shared'],
  ['GET', '/api/users/me/market-activities', 'shared'],
  ['GET', '/api/users/me/markets', 'shared'],
  ['GET', '/api/users/me/markets/:marketId/creator-analytics', 'shared'],
  ['GET', '/api/users/me/markets/:marketId/engagement', 'shared'],
  ['GET', '/api/users/me/missions', 'shared'],
  ['POST', '/api/users/me/missions/:missionId/claim', 'frontend'],
  ['GET', '/api/users/me/open-orders', 'shared'],
  ['GET', '/api/users/me/partner-referrals/kols', 'shared'],
  [
    'GET',
    '/api/users/me/partner-referrals/kols/:kolUserId/referred-users',
    'shared',
  ],
  ['GET', '/api/users/me/partner-referrals/network', 'shared'],
  ['GET', '/api/users/me/pinned-markets', 'shared'],
  ['DELETE', '/api/users/me/pinned-markets/:marketId', 'frontend'],
  ['POST', '/api/users/me/pinned-markets/:marketId', 'frontend'],
  ['GET', '/api/users/me/portfolio', 'shared'],
  ['GET', '/api/users/me/portfolio-value', 'shared'],
  ['GET', '/api/users/me/privacy', 'shared'],
  ['PUT', '/api/users/me/privacy', 'shared'],
  ['PATCH', '/api/users/me/profile', 'shared'],
  ['GET', '/api/users/me/pulse-pnl', 'shared'],
  ['GET', '/api/users/me/redeemable-positions', 'shared'],
  ['GET', '/api/users/me/referral-stats', 'shared'],
  ['GET', '/api/users/me/referral2-stats', 'shared'],
  ['GET', '/api/users/me/referral2-stats/config', 'shared'],
  ['GET', '/api/users/me/referral2-stats/referred-users', 'shared'],
  ['GET', '/api/users/me/referral2-stats/usdc-payouts', 'shared'],
  ['GET', '/api/users/me/requests', 'frontend'],
  ['POST', '/api/users/me/restore-username', 'frontend'],
  ['GET', '/api/users/me/rewards/history', 'shared'],
  ['GET', '/api/users/me/squad', 'frontend'],
  ['GET', '/api/users/me/stats', 'shared'],
  ['GET', '/api/users/me/streak', 'shared'],
  ['GET', '/api/users/me/streak/weekly', 'shared'],
  ['GET', '/api/users/me/trading-fees/history', 'shared'],
  ['GET', '/api/users/me/twitter-username', 'frontend'],
  ['GET', '/api/users/me/wallet/balance', 'shared'],
  ['GET', '/api/users/me/won-markets/count', 'shared'],
  ['GET', '/api/users/me/xo-catalyst-badge/eligibility', 'shared'],
  ['GET', '/api/users/my-markets', 'shared'],
  ['GET', '/api/users/notifications/unread-count', 'shared'],
  ['POST', '/api/users/peckin', 'frontend'],
  ['GET', '/api/users/portfolio', 'public'],
  ['PUT', '/api/users/profile', 'shared'],
  ['GET', '/api/users/redeems', 'shared'],
  // Outside the areas of the client
  ['GET', '/api/ambassador/application', 'shared'],
  ['GET', '/api/ambassador/earnings', 'shared'],
  ['GET', '/api/ambassador/links', 'shared'],
  ['GET', '/api/ambassador/markets/eligible', 'shared'],
  ['POST', '/api/ambassador/public/track-click', 'public'],
  ['GET', '/api/ambassador/stats', 'shared'],
  ['GET', '/api/ambassador/tiers', 'shared'],
  ['GET', '/api/badges', 'shared'],
  ['GET', '/api/badges/:tokenId', 'shared'],
  ['GET', '/api/badges/:tokenId/eligibility', 'shared'],
  ['GET', '/api/bridge/has-bridged', 'shared'],
  ['GET', '/api/bridge/halliday/assets', 'shared'],
  ['GET', '/api/bridge/halliday/payments', 'shared'],
  ['POST', '/api/bridge/halliday/payments', 'shared'],
  ['GET', '/api/bridge/halliday/payments/:paymentId', 'shared'],
  ['POST', '/api/bridge/halliday/payments/:paymentId/funding-claim', 'shared'],
  ['POST', '/api/bridge/halliday/payments/:paymentId/verification', 'shared'],
  ['POST', '/api/bridge/halliday/quotes', 'shared'],
  ['GET', '/api/contests', 'public'],
  ['GET', '/api/contests/:slug', 'public'],
  ['GET', '/api/contests/:slug/leaderboard', 'public'],
  ['GET', '/api/contests/:slug/me', 'shared'],
  ['GET', '/api/contests/:slug/me/fills', 'shared'],
  ['GET', '/api/convictions', 'public'],
  ['GET', '/api/convictions/:conditionId', 'shared'],
  ['POST', '/api/convictions/:eventId/reports', 'frontend'],
  ['GET', '/api/demo/twap', 'public'],
  ['GET', '/api/demo/twap/opening', 'public'],
  ['GET', '/api/me/disputes', 'shared'],
  ['GET', '/api/me/resolution-signals', 'shared'],
  ['GET', '/api/metrics/analytics/global', 'public'],
  ['GET', '/api/missions', 'public'],
  ['GET', '/api/missions/:id', 'public'],
  ['GET', '/api/parlays', 'shared'],
  ['GET', '/api/parlays/:id', 'shared'],
  ['GET', '/api/parlays/:id/entries/my', 'shared'],
  ['GET', '/api/parlays/:id/leaderboard', 'public'],
  ['GET', '/api/parlays/featured', 'shared'],
  ['GET', '/api/parlays/history/me', 'shared'],
  ['GET', '/api/parlays/waitlist/access', 'shared'],
  ['GET', '/api/parlays/waitlist/status', 'shared'],
  ['GET', '/api/public/user-referral/competition-leaderboard', 'public'],
  ['GET', '/api/public/users/referral/volume', 'public'],
  ['GET', '/api/rewards-config', 'public'],
  ['GET', '/api/squads', 'public'],
  ['GET', '/api/squads/:id', 'public'],
  ['GET', '/api/squads/:id/members', 'public'],
  ['GET', '/api/squads/:id/stats', 'public'],
  ['GET', '/api/squads/leaderboard', 'public'],
  ['GET', '/api/stories/fixtures', 'public'],
  ['GET', '/api/stories/fixtures/:id/markets', 'public'],
  ['GET', '/api/stories/mine', 'shared'],
  ['POST', '/api/stories/quotes', 'shared'],
  ['GET', '/api/stories/quotes/:id', 'shared'],
  ['POST', '/api/stories/quotes/:id/accept', 'shared'],
  ['GET', '/api/stories/quotes/preview', 'public'],
  ['POST', '/api/waitlist/signup', 'public'],
];

const key = (method: string, path: string) => `${method} ${path}`;

/** Every client method, called once with valid arguments. */
async function callEverything(client: DataClient): Promise<void> {
  await client.markets.list().firstPage();
  await client.markets.browse().firstPage();
  await client.markets.get(1);
  await client.markets.bySlug('market-1');
  await client.markets.byContract(conditionIdOf(1));
  await client.markets.priceHistory(1).toArray(200);
  await client.markets.statuses(1);
  await client.markets.activity(1).firstPage();
  await client.markets.allActivity().firstPage();
  await client.markets.feeConfig(conditionIdOf(1));
  await client.markets.tradingStatus();
  await client.markets.pulseStats();
  await client.events.list().firstPage();
  await client.events.get(EVENT_ID);
  await client.events.bySlug('argentina-vs-france');
  await client.events.markets(EVENT_ID).firstPage();
  await client.events.subevents(EVENT_ID).toArray(200);
  await client.series.list().toArray(200);
  await client.series.get(SERIES_ID);
  await client.series.bySlug('world-cup-2026');
  await client.series.markets(SERIES_ID).firstPage();
  await client.pulse.list().firstPage();
  await client.pulse.batch([PULSE_ADDRESS]).toArray(200);
  await client.pulse.get(PULSE_ADDRESS);
  await client.taxonomy.categories().toArray(200);
  await client.taxonomy.subcategories().toArray(200);
  await client.taxonomy.tokens().toArray(200);
  await client.portfolio.mine().firstPage();
  await client.portfolio.value();
  await client.portfolio.redeemable().firstPage();
  await client.portfolio.claimableMarkets().firstPage();
  await client.portfolio.openOrders().firstPage();
  await client.portfolio
    .ofWallet({ username: PUBLIC_USER.username })
    .firstPage();
  await client.pnl.summary();
  await client.pnl.market(PNL_MARKET_ID);
  await client.pnl.position(PNL_POSITION_ID);
  await client.activity.mine().firstPage();
  await client.activity.marketActivities().firstPage();
  await client.activity.stats();
  await client.account.me();
  await client.account.apiKeys().toArray(200);
  await client.rewards.earningPools().firstPage();
  await client.rewards.groups().firstPage();
  await client.rewards.group(REWARD_GROUP);
  await client.rewards.marketConfig(REWARD_MARKET);
  await client.rewards.market(REWARD_MARKET);
  await client.rewards.marketEpoch(REWARD_MARKET, SCORED_EPOCH);
  await client.rewards
    .marketEpochMakers(REWARD_MARKET, SCORED_EPOCH)
    .firstPage();
  await client.rewards
    .marketEpochOrders(REWARD_MARKET, SCORED_EPOCH)
    .firstPage();
  await client.rewards.marketWallet(REWARD_MARKET, MAKER);
  await client.rewards.wallet(MAKER);
  await client.rewards.walletEpoch(MAKER, SCORED_EPOCH);
  await client.rewards.walletOrders(MAKER).firstPage();
  await client.rewards.mySummary();
  await client.rewards.myEpoch(SCORED_EPOCH);
  await client.rewards.myOrders().firstPage();
  await client.rewards.myGroupHistory().firstPage();
  await client.rewards.myMarket(REWARD_MARKET);
  await client.rewards.myGroup(REWARD_GROUP);
  await client.rewards.leaderboard().firstPage();
  await client.rewards.myRank();
  await client.profiles.get(PUBLIC_USER.username);
  await client.profiles.stats(PUBLIC_USER.username);
}

describe('coverage', () => {
  test('has no duplicate route, and a route is covered or skipped, never both', () => {
    const covered = coverage.covered.map((r) => key(r.method, r.path));
    const skipped = coverage.skipped.map((r) => key(r.method, r.path));
    expect(new Set(covered).size).toBe(covered.length);
    expect(new Set(skipped).size).toBe(skipped.length);
    expect(covered.filter((entry) => skipped.includes(entry))).toEqual([]);
  });

  test('every covered entry has a client method, named like its routes.ts key', () => {
    const { client } = dataRig(server);
    const keys = Object.keys(routes);
    expect(keys).toHaveLength(coverage.covered.length);
    for (const name of keys) {
      const [namespace, method] = name.split('.') as [keyof DataClient, string];
      const target = client[namespace] as unknown as Record<string, unknown>;
      expect(typeof target[method], `client.${name}`).toBe('function');
    }
    for (const entry of coverage.covered) {
      expect(
        Object.values(routes).some(
          (r) => r.method === entry.method && r.path === entry.path,
        ),
      ).toBe(true);
    }
  });

  test('every client method calls exactly the route coverage lists for it', async () => {
    const { client, backend } = dataRig(server, { session: true });
    await callEverything(client);
    // Turn each concrete path into the template that matches it, and check the sets agree.
    const templates = coverage.covered.map((entry) => ({
      key: key(entry.method, entry.path),
      pattern: new RegExp(`^${entry.path.replace(/:[A-Za-z]+/g, '[^/]+')}$`),
      method: entry.method,
    }));
    const hit = new Set<string>();
    for (const request of backend.requests) {
      const matches = templates.filter(
        (t) => t.method === request.method && t.pattern.test(request.path),
      );
      // A concrete path can fit several templates (/markets/slug/x fits /:id/activity?
      // no: segment counts differ), but never none.
      expect(
        matches.length,
        `${request.method} ${request.path}`,
      ).toBeGreaterThan(0);
      for (const match of matches) hit.add(match.key);
    }
    // A request carries the key exactly when its route is `shared`.
    for (const request of backend.requests) {
      const access = new Set(
        Object.values(routes)
          .filter(
            (r) =>
              r.method === request.method &&
              new RegExp(`^${r.path.replace(/:[A-Za-z]+/g, '[^/]+')}$`).test(
                request.path,
              ),
          )
          .map((r) => r.access),
      );
      expect(access.size, `${request.method} ${request.path}`).toBe(1);
      expect(request.authorization, `${request.method} ${request.path}`).toBe(
        access.has('shared') ? `Bearer ${API_KEY}` : null,
      );
    }
    // Every covered route was called by some method.
    expect([...hit].sort()).toEqual(
      coverage.covered.map((r) => key(r.method, r.path)).sort(),
    );
  });

  test('routes.ts access matches the registry: shared routes are the only ones sent with a key', () => {
    for (const entry of coverage.covered) {
      const registry = REGISTRY.find(
        ([method, path]) => method === entry.method && path === entry.path,
      );
      expect(registry, key(entry.method, entry.path)).toBeDefined();
      const route = Object.values(routes).find(
        (r) => r.method === entry.method && r.path === entry.path,
      );
      expect(route?.access, entry.path).toBe(registry?.[2]);
    }
  });

  test('every public or shared route of the registry is covered or skipped, and nothing else is listed', () => {
    const listed = new Set([
      ...coverage.covered.map((r) => key(r.method, r.path)),
      ...coverage.skipped.map((r) => key(r.method, r.path)),
    ]);
    const missing = REGISTRY.filter(
      ([method, path]) => !listed.has(key(method, path)),
    );
    expect(missing).toEqual([]);
    // And nothing is listed that the registry does not have.
    const known = new Set(REGISTRY.map(([method, path]) => key(method, path)));
    expect([...listed].filter((entry) => !known.has(entry))).toEqual([]);
    expect(listed.size).toBe(known.size);
  });

  test('the routes of the other areas are skipped as another area, with their area, and none is a frontend route', () => {
    const outside = coverage.skipped.filter((r) =>
      r.reason.endsWith(': another area, not part of the SDK yet'),
    );
    // 41: the conviction report is frontend, so it is skipped as frontend-only.
    expect(outside).toHaveLength(41);
    for (const entry of outside) {
      const row = REGISTRY.find(
        ([method, path]) => method === entry.method && path === entry.path,
      );
      expect(row?.[2], key(entry.method, entry.path)).toMatch(
        /^(public|shared)$/,
      );
      expect(entry.reason, key(entry.method, entry.path)).toMatch(
        /^[a-z ]+: another area, not part of the SDK yet$/,
      );
    }
    // A few, by area.
    const reasonOf = (method: string, path: string) =>
      coverage.skipped.find((r) => r.method === method && r.path === path)
        ?.reason;
    expect(reasonOf('GET', '/api/squads')).toBe(
      'squads: another area, not part of the SDK yet',
    );
    expect(reasonOf('GET', '/api/parlays/featured')).toBe(
      'parlays: another area, not part of the SDK yet',
    );
    expect(reasonOf('GET', '/api/contests/:slug')).toBe(
      'contests: another area, not part of the SDK yet',
    );
  });

  test('routes that are frontend today are skipped with the frontend-only reason, and only those', () => {
    // POST /api/auth/api-keys is declared frontend for its `privy` type (a web session), and
    // the SDK's sign-in calls it with `eoa` or `smart_wallet`, so its reason is the
    // sign-in.
    const SIGN_IN_ROUTE = key('POST', '/api/auth/api-keys');
    const frontend = REGISTRY.filter(([, , access]) => access === 'frontend')
      .map(([method, path]) => key(method, path))
      .filter((entry) => entry !== SIGN_IN_ROUTE);
    const withReason = coverage.skipped
      .filter((entry) => entry.reason === FRONTEND_ONLY)
      .map((entry) => key(entry.method, entry.path));
    expect(withReason.sort()).toEqual(frontend.sort());
    expect(
      REGISTRY.some(
        ([method, path, access]) =>
          key(method, path) === SIGN_IN_ROUTE && access === 'frontend',
      ),
    ).toBe(true);
    // The eight writes that refuse an API key.
    for (const [method, path] of [
      ['POST', '/api/users/me/pinned-markets/:marketId'],
      ['DELETE', '/api/users/me/pinned-markets/:marketId'],
      ['POST', '/api/markets/:id/like'],
      ['POST', '/api/markets/:id/unlike'],
      ['POST', '/api/user-notifications/:id/read'],
      ['POST', '/api/user-notifications/read-all'],
      ['POST', '/api/users/me/invite-codes'],
      ['POST', '/api/convictions/:eventId/reports'],
    ] as const) {
      expect(withReason, key(method, path)).toContain(key(method, path));
    }
    expect(FRONTEND_ONLY).toBe(
      'frontend-only today: a signed-in web session can call it, an API key cannot',
    );
    // A plain reason: no ticket id.
    expect(FRONTEND_ONLY).not.toMatch(/XO-\d+/);
  });

  test('the seven bridge routes are skipped because the bridge client calls them, not the data client', () => {
    const bridge = coverage.skipped.filter((r) =>
      r.path.startsWith('/api/bridge/halliday/'),
    );
    expect(bridge.map((r) => key(r.method, r.path)).sort()).toEqual([
      'GET /api/bridge/halliday/assets',
      'GET /api/bridge/halliday/payments',
      'GET /api/bridge/halliday/payments/:paymentId',
      'POST /api/bridge/halliday/payments',
      'POST /api/bridge/halliday/payments/:paymentId/funding-claim',
      'POST /api/bridge/halliday/payments/:paymentId/verification',
      'POST /api/bridge/halliday/quotes',
    ]);
    for (const entry of bridge) {
      expect(entry.reason, key(entry.method, entry.path)).toBe(
        'the bridge client (BridgeClient) calls it, not the data client',
      );
      // Skipped, never also covered.
      expect(
        coverage.covered.some(
          (r) => r.path === entry.path && r.method === entry.method,
        ),
      ).toBe(false);
    }
  });

  test('the seven Stories routes are skipped: they are not part of the SDK yet', () => {
    const stories = coverage.skipped.filter((r) =>
      r.path.startsWith('/api/stories/'),
    );
    expect(stories.map((r) => key(r.method, r.path)).sort()).toEqual([
      'GET /api/stories/fixtures',
      'GET /api/stories/fixtures/:id/markets',
      'GET /api/stories/mine',
      'GET /api/stories/quotes/:id',
      'GET /api/stories/quotes/preview',
      'POST /api/stories/quotes',
      'POST /api/stories/quotes/:id/accept',
    ]);
    for (const entry of stories) {
      expect(entry.reason, key(entry.method, entry.path)).toBe(
        'not part of the SDK yet',
      );
      // Skipped, never also covered.
      expect(
        coverage.covered.some(
          (r) => r.path === entry.path && r.method === entry.method,
        ),
      ).toBe(false);
    }
  });

  test('the email waitlist signup is skipped, with a plain reason', () => {
    const entry = coverage.skipped.find(
      (r) => r.method === 'POST' && r.path === '/api/waitlist/signup',
    );
    expect(entry?.reason).toBe('email waitlist signup: not part of the SDK');
  });

  test('every skipped route has a reason', () => {
    for (const entry of coverage.skipped) {
      expect(
        entry.reason.trim().length,
        key(entry.method, entry.path),
      ).toBeGreaterThan(10);
    }
  });

  test('the account routes are covered, the login and write routes are skipped for their reasons', () => {
    const covered = new Set(coverage.covered.map((r) => key(r.method, r.path)));
    for (const entry of [
      'GET /api/users/me/portfolio',
      'GET /api/users/me/portfolio-value',
      'GET /api/users/me/redeemable-positions',
      'GET /api/users/me/claimable-markets',
      'GET /api/users/me/open-orders',
      'GET /api/users/portfolio',
      // the singular /user/pnl, not /users/pnl
      'GET /api/user/pnl',
      'GET /api/user/pnl/market/:marketId',
      'GET /api/user/pnl/position/:positionId',
      'GET /api/users/me/activities',
      'GET /api/users/me/market-activities',
      'GET /api/users/me/stats',
      'GET /api/users/me',
      'GET /api/auth/api-keys',
      'GET /api/profiles/:username',
      'GET /api/profiles/:username/stats',
    ]) {
      expect(covered.has(entry), entry).toBe(true);
    }
    const reason = (method: string, path: string) =>
      coverage.skipped.find((r) => r.method === method && r.path === path)
        ?.reason;
    // One key route, POST /api/auth/api-keys; the /wallet path is gone.
    expect(reason('POST', '/api/auth/api-keys/wallet')).toBeUndefined();
    const signIn = reason('POST', '/api/auth/api-keys');
    expect(signIn).toMatch(/sign-in/);
    expect(signIn).toContain('eoa');
    expect(signIn).toContain('smart_wallet');
    expect(reason('POST', '/api/auth/api-keys/nonce')).toMatch(/sign-in/);
    // A key revokes only itself: the session does, on close.
    expect(reason('DELETE', '/api/auth/api-keys/:id')).toMatch(/sign-out/);
    // A key may still change the profile and the privacy setting: those stay write routes.
    for (const [method, path] of [
      ['PUT', '/api/users/me/privacy'],
      ['PATCH', '/api/users/me/profile'],
      ['PUT', '/api/users/profile'],
    ] as const) {
      expect(reason(method, path), `${method} ${path}`).toBe(
        'write route: the data client only reads',
      );
    }
    expect(reason('GET', '/api/profiles/:username/portfolio')).toBe(
      'covered by portfolio.ofWallet({ username })',
    );
  });

  test('the liquidity-rewards routes: every public one and the account’s own are covered, the shared twins are skipped because the public route is used', () => {
    const covered = new Set(coverage.covered.map((r) => key(r.method, r.path)));
    const reason = (method: string, path: string) =>
      coverage.skipped.find((r) => r.method === method && r.path === path)
        ?.reason;
    const PUBLIC = '/api/public/liquidity-rewards';
    const MINE = '/api/liquidity-rewards';
    for (const path of [
      `${PUBLIC}/earning-pools`,
      `${PUBLIC}/groups`,
      `${PUBLIC}/groups/:groupId`,
      `${PUBLIC}/markets/:marketId`,
      `${PUBLIC}/markets/:marketId/config`,
      `${PUBLIC}/markets/:marketId/epochs/:epoch`,
      `${PUBLIC}/markets/:marketId/epochs/:epoch/makers`,
      `${PUBLIC}/markets/:marketId/epochs/:epoch/orders`,
      `${PUBLIC}/markets/:marketId/wallets/:walletAddress`,
      `${PUBLIC}/wallets/:walletAddress/epochs/:epoch`,
      `${PUBLIC}/wallets/:walletAddress/orders`,
      `${PUBLIC}/wallets/:walletAddress/summary`,
      `${MINE}/groups/:groupId/me`,
      `${MINE}/leaderboard`,
      `${MINE}/leaderboard/me`,
      `${MINE}/markets/:marketId/me`,
      `${MINE}/me/epochs/:epoch`,
      `${MINE}/me/group-history`,
      `${MINE}/me/orders`,
      `${MINE}/me/summary`,
    ]) {
      expect(covered.has(key('GET', path)), path).toBe(true);
    }
    // The two shared routes that have a public twin: the public one is used, which needs no
    // credentials.
    expect(reason('GET', `${MINE}/earning-pools`)).toBe(
      'public twin used: rewards.earningPools() (GET /api/public/liquidity-rewards/earning-pools) needs no credentials; it has no sort (always by daily pool), so order by estimatedApr on the client',
    );
    expect(reason('GET', `${MINE}/markets/:marketId/config`)).toBe(
      'public twin used: rewards.marketConfig() (GET /api/public/liquidity-rewards/markets/:marketId/config) needs no credentials',
    );
    expect(covered.has(key('GET', `${MINE}/earning-pools`))).toBe(false);
    expect(covered.has(key('GET', `${MINE}/markets/:marketId/config`))).toBe(
      false,
    );
    // The public ones are public, the account's own are shared.
    for (const entry of coverage.covered.filter((r) =>
      r.path.includes('liquidity-rewards'),
    )) {
      const route = Object.values(routes).find(
        (r) => r.method === entry.method && r.path === entry.path,
      );
      expect(route?.access, entry.path).toBe(
        entry.path.startsWith(PUBLIC) ? 'public' : 'shared',
      );
    }
    // No liquidity-rewards route is frontend-only today, so none carries that reason.
    expect(
      coverage.skipped.filter(
        (r) =>
          r.path.includes('liquidity-rewards') && r.reason === FRONTEND_ONLY,
      ),
    ).toEqual([]);
    // The points routes sit in the same section of the index: they are not rewards reads.
    expect(reason('POST', '/api/points/calculate')).toMatch(
      /not part of the SDK yet/,
    );
    expect(reason('GET', '/api/points/market')).toMatch(
      /not part of the SDK yet/,
    );
  });

  test('the out-of-area public routes the market routes flagged are accounted for as not part of the SDK yet', () => {
    const outOfArea = coverage.skipped.filter(
      (r) =>
        r.path.startsWith('/api/charts') ||
        r.path.startsWith('/api/market-comments') ||
        r.path.startsWith('/api/contests/:slug/markets'),
    );
    expect(outOfArea.map((r) => key(r.method, r.path)).sort()).toEqual(
      [
        'GET /api/charts/:marketId',
        'GET /api/charts/:marketId/current',
        'POST /api/charts/current',
        'GET /api/charts/market/:id/points',
        'GET /api/market-comments',
        'POST /api/market-comments',
        'GET /api/market-comments/:id',
        'GET /api/market-comments/recent/pulse',
        'GET /api/contests/:slug/markets',
        'GET /api/contests/:slug/markets/browse',
      ].sort(),
    );
    for (const entry of outOfArea) {
      // The only frontend one (POST /market-comments) says so; every other names its area and
      // says it is not part of the SDK yet.
      expect(entry.reason, key(entry.method, entry.path)).toMatch(
        entry.reason === FRONTEND_ONLY
          ? /^frontend-only today/
          : /^(charts|market comments|contests): not part of the SDK yet( \(.+\))?$/,
      );
    }
  });

  test('the client exposes the same coverage object', () => {
    const { client } = dataRig(server);
    expect(client.coverage).toBe(coverage);
  });

  test('coverage is deeply frozen: the object, both lists and every entry', () => {
    expect(Object.isFrozen(coverage)).toBe(true);
    expect(Object.isFrozen(coverage.covered)).toBe(true);
    expect(Object.isFrozen(coverage.skipped)).toBe(true);
    for (const entry of [...coverage.covered, ...coverage.skipped]) {
      expect(Object.isFrozen(entry), key(entry.method, entry.path)).toBe(true);
    }
    expect(() => {
      (coverage.covered as unknown as unknown[]).push({});
    }).toThrow(TypeError);
    expect(() => {
      (coverage.skipped[0] as { reason: string }).reason = 'x';
    }).toThrow(TypeError);
    expect(() => {
      (coverage as unknown as { covered: unknown }).covered = [];
    }).toThrow(TypeError);
  });

  test('categories/volume is skipped for what it really does: it omits small categories', () => {
    const entry = coverage.skipped.find(
      (row) => row.path === '/api/categories/volume',
    );
    expect(entry?.reason).toBe(
      "legacy helper: omits categories with fewer than 5 markets; taxonomy.categories({ sortBy: 'marketsCount' }) lists all",
    );
  });

  test('the addresses used by the calls above are the fixtures’ (guards a stale fixture)', () => {
    expect(addressOf(6)).toMatch(/^0x(06){20}$/);
  });
});
