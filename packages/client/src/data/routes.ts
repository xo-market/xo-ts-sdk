// Internal: the backend routes the data client calls, one entry per client method.
//
// The key is `<namespace>.<method>` exactly as on `DataClient`, the path is the backend's
// route template under the global `/api` prefix, and `access` is the route's access class
// today, as the backend's route index has it:
// - `public` routes are sent with no credentials, even when the client has a session;
// - `shared` routes accept a session or an `xo_sk` key and are sent with the backend key.
//   The client refuses them locally (`AuthRequiredError`, nothing sent) when its session has
//   neither a signer nor a key.
//
// `coverage.ts` is built from this table, so a covered route always has a method and a
// method never calls a route that coverage does not list.

export type RouteAccess = 'public' | 'shared';

export interface Route {
  method: 'GET';
  /** The backend route template: `:name` segments are filled from validated values. */
  path: string;
  access: RouteAccess;
}

const get = (path: string, access: RouteAccess = 'public'): Route => ({
  method: 'GET',
  path,
  access,
});

export const routes = {
  // Markets
  'markets.list': get('/api/markets'),
  'markets.browse': get('/api/markets/browse'),
  'markets.get': get('/api/markets/:id'),
  'markets.bySlug': get('/api/markets/slug/:slug'),
  'markets.byContract': get('/api/markets/contract/:contractAddress'),
  'markets.priceHistory': get('/api/markets/:id/price-history'),
  'markets.statuses': get('/api/markets/:id/statuses'),
  'markets.activity': get('/api/markets/:id/activity'),
  'markets.allActivity': get('/api/markets/activities'),
  'markets.feeConfig': get('/api/markets/fee-config/effective'),
  'markets.tradingStatus': get('/api/markets/clob/trading-status', 'shared'),
  'markets.pulseStats': get('/api/markets/pulse/stats'),
  // Events
  'events.list': get('/api/v1/events'),
  'events.get': get('/api/v1/events/:eventId'),
  'events.bySlug': get('/api/v1/events/slug/:slug'),
  'events.markets': get('/api/v1/events/:eventId/markets'),
  'events.subevents': get('/api/v1/events/:eventId/subevents'),
  // Series
  'series.list': get('/api/v1/series'),
  'series.get': get('/api/v1/series/:seriesId'),
  'series.bySlug': get('/api/v1/series/slug/:slug'),
  'series.markets': get('/api/v1/series/:seriesId/markets'),
  // Pulse
  'pulse.list': get('/api/pulse/markets'),
  'pulse.batch': get('/api/pulse/markets/batch'),
  'pulse.get': get('/api/pulse/markets/:address'),
  // Taxonomy
  'taxonomy.categories': get('/api/categories'),
  'taxonomy.subcategories': get('/api/subcategories'),
  'taxonomy.tokens': get('/api/tokens'),
  // Portfolio. The `me` routes are `shared` (account:read); `ofWallet` has no guard.
  'portfolio.mine': get('/api/users/me/portfolio', 'shared'),
  'portfolio.value': get('/api/users/me/portfolio-value', 'shared'),
  'portfolio.redeemable': get('/api/users/me/redeemable-positions', 'shared'),
  'portfolio.claimableMarkets': get(
    '/api/users/me/claimable-markets',
    'shared',
  ),
  'portfolio.openOrders': get('/api/users/me/open-orders', 'shared'),
  'portfolio.ofWallet': get('/api/users/portfolio'),
  // PnL (the controller is `user/pnl`, singular)
  'pnl.summary': get('/api/user/pnl', 'shared'),
  'pnl.market': get('/api/user/pnl/market/:marketId', 'shared'),
  'pnl.position': get('/api/user/pnl/position/:positionId', 'shared'),
  // Activity
  'activity.mine': get('/api/users/me/activities', 'shared'),
  'activity.marketActivities': get('/api/users/me/market-activities', 'shared'),
  'activity.stats': get('/api/users/me/stats', 'shared'),
  // Account. Listing needs account:read.
  'account.me': get('/api/users/me', 'shared'),
  'account.apiKeys': get('/api/auth/api-keys', 'shared'),
  // Public profiles
  'profiles.get': get('/api/profiles/:username'),
  'profiles.stats': get('/api/profiles/:username/stats'),
  // Liquidity rewards. `:marketId` is a CLOB condition id (the SDK's `conditionId`). Under
  // `/public/liquidity-rewards` there is no guard; the account's own reads under
  // `/liquidity-rewards` are `shared`. The shared `earning-pools` and `markets/:marketId/config`
  // have public twins, which the client uses instead (see coverage.ts).
  'rewards.earningPools': get('/api/public/liquidity-rewards/earning-pools'),
  'rewards.groups': get('/api/public/liquidity-rewards/groups'),
  'rewards.group': get('/api/public/liquidity-rewards/groups/:groupId'),
  'rewards.marketConfig': get(
    '/api/public/liquidity-rewards/markets/:marketId/config',
  ),
  'rewards.market': get('/api/public/liquidity-rewards/markets/:marketId'),
  'rewards.marketEpoch': get(
    '/api/public/liquidity-rewards/markets/:marketId/epochs/:epoch',
  ),
  'rewards.marketEpochMakers': get(
    '/api/public/liquidity-rewards/markets/:marketId/epochs/:epoch/makers',
  ),
  'rewards.marketEpochOrders': get(
    '/api/public/liquidity-rewards/markets/:marketId/epochs/:epoch/orders',
  ),
  'rewards.marketWallet': get(
    '/api/public/liquidity-rewards/markets/:marketId/wallets/:walletAddress',
  ),
  'rewards.wallet': get(
    '/api/public/liquidity-rewards/wallets/:walletAddress/summary',
  ),
  'rewards.walletEpoch': get(
    '/api/public/liquidity-rewards/wallets/:walletAddress/epochs/:epoch',
  ),
  'rewards.walletOrders': get(
    '/api/public/liquidity-rewards/wallets/:walletAddress/orders',
  ),
  'rewards.mySummary': get('/api/liquidity-rewards/me/summary', 'shared'),
  'rewards.myEpoch': get('/api/liquidity-rewards/me/epochs/:epoch', 'shared'),
  'rewards.myOrders': get('/api/liquidity-rewards/me/orders', 'shared'),
  'rewards.myGroupHistory': get(
    '/api/liquidity-rewards/me/group-history',
    'shared',
  ),
  'rewards.myMarket': get(
    '/api/liquidity-rewards/markets/:marketId/me',
    'shared',
  ),
  'rewards.myGroup': get('/api/liquidity-rewards/groups/:groupId/me', 'shared'),
  'rewards.leaderboard': get('/api/liquidity-rewards/leaderboard', 'shared'),
  'rewards.myRank': get('/api/liquidity-rewards/leaderboard/me', 'shared'),
} as const satisfies Record<string, Route>;

export type RouteKey = keyof typeof routes;

/**
 * Fills the `:name` segments of a route template. The values must already be validated and
 * percent-encoded by the caller (see `params.ts`); a missing or unused value is a bug in
 * the SDK, not in the caller's input.
 */
export function expandPath(
  template: string,
  values: Record<string, string> = {},
): string {
  const used = new Set<string>();
  const path = template.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw new Error(`route ${template}: no value for :${name}`);
    }
    used.add(name);
    return value;
  });
  for (const name of Object.keys(values)) {
    if (!used.has(name)) {
      throw new Error(`route ${template}: unused value ${name}`);
    }
  }
  return path;
}
