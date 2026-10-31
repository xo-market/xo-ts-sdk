// Which backend routes the data client covers, and which it deliberately skips.
//
// The route coverage check compares this with the backend's route index: every `public` or
// `shared` route of the index must be here, as `covered` or as `skipped` with a reason,
// whatever its area. The areas of the client are the markets, events, series, pulse and taxonomy
// routes, the account routes (`/users`, `/user/pnl`, `/profiles`, `/auth`, `/user-notifications`,
// `/user-market-assets`), the liquidity rewards, points and open-orders section
// (`/liquidity-rewards`, `/public/liquidity-rewards`, `/points`) and the public routes of other
// areas that the market routes brought up (`/charts`, `/market-comments`,
// `/contests/:slug/markets`). A public or shared route of any other area (the ambassador
// programme, badges, parlays, squads, ...) is skipped with `<area>: another area, not part of
// the SDK yet`. The
// bridge's deposit and withdraw routes are the bridge client's:
// they are skipped with `BRIDGE`, whatever their method. Paths are the backend's route templates
// under `/api`, spelled as the registry spells them.
//
// `covered` is built from `routes.ts`, the table the client methods call, so a covered route
// always has a method.
//
// A route that is `frontend` today (Privy session only) is skipped with `FRONTEND_ONLY` even
// when the access proposal would open it to API keys: the SDK works against what the backend
// serves now, and the nightly strict e2e run notices when a route migrates (the backend
// plans to open some of them to API keys). A key may change only the profile and the privacy
// setting, so the pin, like, notification, invite-code and conviction-report writes are
// frontend-only too. The one frontend route skipped for another reason is
// `POST /api/auth/api-keys`: the index declares it `frontend` for its `privy` type, and the
// SDK's sign-in calls it with `eoa` or `smart_wallet`.

import { routes } from './routes';

/** A backend route, by method and path. */
export interface CoveredRoute {
  readonly method: string;
  readonly path: string;
}

/** A backend route the data client leaves out, and why. */
export interface SkippedRoute extends CoveredRoute {
  readonly reason: string;
}

/** Deeply frozen: the object, both lists and every entry. */
export interface DataCoverage {
  readonly covered: readonly CoveredRoute[];
  readonly skipped: readonly SkippedRoute[];
}

/** The reason of every route a Privy session reaches and an API key does not. */
export const FRONTEND_ONLY =
  'frontend-only today: a signed-in web session can call it, an API key cannot';
const WRITE = 'write route: the data client only reads';
const SIGN_IN =
  'wallet sign-in: the session (auth layer) calls it to mint the backend key, not a data route';
/** `DELETE /api/auth/api-keys/:id`: a key can revoke only itself, which the session does on close. */
const SIGN_OUT =
  'sign-out: the session (auth layer) revokes its own key with it on close, not a data route';
/** `POST /api/auth/api-keys`, the one route that creates a key. */
const SIGN_IN_KEY = `${SIGN_IN} (types eoa and smart_wallet; type privy is a web session)`;
/** A route the SDK has no method for yet: the Stories routes, and reads of the covered areas. */
const NOT_YET = 'not part of the SDK yet';
const CHARTS = `charts: ${NOT_YET} (the orderbook client has the price history)`;
const COMMENTS = `market comments: ${NOT_YET} (a social feature)`;
const CONTESTS = `contests: ${NOT_YET}`;
/** A public or shared route of an area outside the client's areas. */
const outside = (area: string) => `${area}: another area, ${NOT_YET}`;
/** The bridge's deposit and withdraw routes: the bridge client sends them. */
const BRIDGE = 'the bridge client (BridgeClient) calls it, not the data client';
/** `POST /api/waitlist/signup`: it writes an email address, so the data client has no use for it. */
const WAITLIST = 'email waitlist signup: not part of the SDK';

const skip = (method: string, path: string, reason: string): SkippedRoute => ({
  method,
  path,
  reason,
});

const SKIPPED: readonly SkippedRoute[] = [
  // Markets
  skip('GET', '/api/markets/:id/analytics', FRONTEND_ONLY),
  skip('GET', '/api/markets/:id/latest-prices', FRONTEND_ONLY),
  skip('GET', '/api/markets/:id/participants', FRONTEND_ONLY),
  skip('GET', '/api/markets/:id/reviewed', FRONTEND_ONLY),
  skip('POST', '/api/markets/:marketId/dispute', FRONTEND_ONLY),
  skip('POST', '/api/markets/:marketId/signal-resolution', FRONTEND_ONLY),
  skip('GET', '/api/markets/:id/contests', `contests: ${NOT_YET}`),
  skip('GET', '/api/markets/:id/cp-rate', `conviction points rate: ${NOT_YET}`),
  skip('GET', '/api/markets/:marketId/disputes', `disputes: ${NOT_YET}`),
  skip(
    'GET',
    '/api/markets/:marketId/resolution-flags',
    `resolution signals: ${NOT_YET}`,
  ),
  skip('POST', '/api/markets/:id/like', FRONTEND_ONLY),
  skip('POST', '/api/markets/:id/unlike', FRONTEND_ONLY),
  // Events
  skip('POST', '/api/v1/events/:eventId/comments', FRONTEND_ONLY),
  skip('GET', '/api/v1/events/:eventId/activity', NOT_YET),
  skip('GET', '/api/v1/events/:eventId/charts/points', NOT_YET),
  skip('GET', '/api/v1/events/:eventId/comments', NOT_YET),
  skip('GET', '/api/v1/events/:eventId/leaderboard', NOT_YET),
  skip('GET', '/api/v1/events/:eventId/leaderboard/me', NOT_YET),
  skip('GET', '/api/v1/events/:eventId/media', NOT_YET),
  skip('GET', '/api/v1/events/:eventId/portfolio', NOT_YET),
  skip('GET', '/api/v1/events/:eventId/score', NOT_YET),
  skip('GET', '/api/v1/events/sports', NOT_YET),
  // Series
  skip('GET', '/api/v1/series/:seriesId/leaderboard', NOT_YET),
  skip('GET', '/api/v1/series/:seriesId/leaderboard/me', NOT_YET),
  skip('GET', '/api/v1/series/:seriesId/portfolio', NOT_YET),
  // Pulse
  skip(
    'GET',
    '/api/pulse/twap/adapters/:adapterConfigId',
    `TWAP adapter internals: ${NOT_YET}`,
  ),
  skip(
    'GET',
    '/api/pulse/twap/adapters/:adapterConfigId/points',
    `TWAP adapter internals: ${NOT_YET}`,
  ),
  // Taxonomy
  skip('GET', '/api/categories/:id', FRONTEND_ONLY),
  skip(
    'GET',
    '/api/categories/volume',
    "legacy helper: omits categories with fewer than 5 markets; taxonomy.categories({ sortBy: 'marketsCount' }) lists all",
  ),
  skip(
    'GET',
    '/api/subcategories/active',
    'covered by taxonomy.subcategories() in its overview mode',
  ),
  skip(
    'GET',
    '/api/subcategories/category/:categoryId',
    'covered by taxonomy.subcategories({ categoryId })',
  ),
  skip(
    'GET',
    '/api/subcategories/:id',
    'single-node lookup: list with taxonomy.subcategories() instead',
  ),
  // Account (/users)
  skip('POST', '/api/users/achievement-mint-signature', FRONTEND_ONLY),
  skip('GET', '/api/users/active-markets', NOT_YET),
  skip(
    'GET',
    '/api/users/activity',
    'legacy unpaginated twin of activity.mine()',
  ),
  skip('GET', '/api/users/creator/history', NOT_YET),
  skip('GET', '/api/users/leaderboard', NOT_YET),
  skip('GET', '/api/users/leaderboard/me', NOT_YET),
  skip('GET', '/api/users/leaderboard/resolution', NOT_YET),
  skip('GET', '/api/users/me/activities/composite', NOT_YET),
  skip('GET', '/api/users/me/badges', NOT_YET),
  skip('GET', '/api/users/me/ban-status', NOT_YET),
  skip('GET', '/api/users/me/boarding-pass-claim', FRONTEND_ONLY),
  skip('POST', '/api/users/me/boarding-pass-claim/claim', FRONTEND_ONLY),
  skip('POST', '/api/users/me/boarding-pass-claim/confirm', FRONTEND_ONLY),
  skip('PATCH', '/api/users/me/boarding-pass-claim/steps', FRONTEND_ONLY),
  skip('GET', '/api/users/me/bridge-activities', NOT_YET),
  skip('POST', '/api/users/me/claim-username', FRONTEND_ONLY),
  skip('GET', '/api/users/me/claimable-fees', NOT_YET),
  skip('GET', '/api/users/me/clob-pulse-pnl', NOT_YET),
  skip('GET', '/api/users/me/clob-pulse-volume', NOT_YET),
  skip('GET', '/api/users/me/cp-summary', NOT_YET),
  skip('GET', '/api/users/me/cp-unsettled', NOT_YET),
  skip('GET', '/api/users/me/creator-analytics', NOT_YET),
  skip('GET', '/api/users/me/fees/by-market', NOT_YET),
  skip('GET', '/api/users/me/fees/history', NOT_YET),
  skip('GET', '/api/users/me/fees/summary', NOT_YET),
  skip('GET', '/api/users/me/invite-codes', NOT_YET),
  skip('POST', '/api/users/me/invite-codes', FRONTEND_ONLY),
  skip('GET', '/api/users/me/invite-codes/stats', NOT_YET),
  skip('GET', '/api/users/me/invited-users', NOT_YET),
  skip('GET', '/api/users/me/markets', NOT_YET),
  skip('GET', '/api/users/me/markets/:marketId/creator-analytics', NOT_YET),
  skip('GET', '/api/users/me/markets/:marketId/engagement', NOT_YET),
  skip('GET', '/api/users/me/missions', NOT_YET),
  skip('POST', '/api/users/me/missions/:missionId/claim', FRONTEND_ONLY),
  skip('GET', '/api/users/me/partner-referrals/kols', NOT_YET),
  skip(
    'GET',
    '/api/users/me/partner-referrals/kols/:kolUserId/referred-users',
    NOT_YET,
  ),
  skip('GET', '/api/users/me/partner-referrals/network', NOT_YET),
  skip('GET', '/api/users/me/pinned-markets', NOT_YET),
  skip('DELETE', '/api/users/me/pinned-markets/:marketId', FRONTEND_ONLY),
  skip('POST', '/api/users/me/pinned-markets/:marketId', FRONTEND_ONLY),
  skip('GET', '/api/users/me/privacy', NOT_YET),
  skip('PUT', '/api/users/me/privacy', WRITE),
  skip('PATCH', '/api/users/me/profile', WRITE),
  skip('GET', '/api/users/me/pulse-pnl', NOT_YET),
  skip('GET', '/api/users/me/referral-stats', NOT_YET),
  skip('GET', '/api/users/me/referral2-stats', NOT_YET),
  skip('GET', '/api/users/me/referral2-stats/config', NOT_YET),
  skip('GET', '/api/users/me/referral2-stats/referred-users', NOT_YET),
  skip('GET', '/api/users/me/referral2-stats/usdc-payouts', NOT_YET),
  skip('GET', '/api/users/me/requests', FRONTEND_ONLY),
  skip('POST', '/api/users/me/restore-username', FRONTEND_ONLY),
  skip('GET', '/api/users/me/rewards/history', NOT_YET),
  skip('GET', '/api/users/me/squad', FRONTEND_ONLY),
  skip('GET', '/api/users/me/streak', NOT_YET),
  skip('GET', '/api/users/me/streak/weekly', NOT_YET),
  skip('GET', '/api/users/me/trading-fees/history', NOT_YET),
  skip('GET', '/api/users/me/twitter-username', FRONTEND_ONLY),
  skip('GET', '/api/users/me/wallet/balance', NOT_YET),
  skip('GET', '/api/users/me/won-markets/count', NOT_YET),
  skip('GET', '/api/users/me/xo-catalyst-badge/eligibility', NOT_YET),
  skip('GET', '/api/users/my-markets', NOT_YET),
  skip('GET', '/api/users/notifications/unread-count', NOT_YET),
  skip('POST', '/api/users/peckin', FRONTEND_ONLY),
  skip('PUT', '/api/users/profile', WRITE),
  skip(
    'GET',
    '/api/users/redeems',
    "redeem history: activity.mine({ positionType: 'REDEEM' }) lists the same rows with a page",
  ),
  // Profiles
  skip('GET', '/api/profiles/:username/activities', NOT_YET),
  skip('GET', '/api/profiles/:username/badges', NOT_YET),
  skip('GET', '/api/profiles/:username/clob-pulse-pnl', NOT_YET),
  skip('GET', '/api/profiles/:username/pnl-history', NOT_YET),
  skip(
    'GET',
    '/api/profiles/:username/portfolio',
    'covered by portfolio.ofWallet({ username })',
  ),
  skip('GET', '/api/profiles/:username/pulse-pnl', NOT_YET),
  skip('GET', '/api/profiles/:username/won-markets/count', NOT_YET),
  // Auth
  skip('POST', '/api/auth/activate', FRONTEND_ONLY),
  skip('POST', '/api/auth/api-keys', SIGN_IN_KEY),
  skip('POST', '/api/auth/api-keys/nonce', SIGN_IN),
  skip('DELETE', '/api/auth/api-keys/:id', SIGN_OUT),
  skip('GET', '/api/auth/user/me', FRONTEND_ONLY),
  // Notifications
  skip('GET', '/api/user-notifications', NOT_YET),
  skip('POST', '/api/user-notifications/:id/read', FRONTEND_ONLY),
  skip('POST', '/api/user-notifications/read-all', FRONTEND_ONLY),
  skip('GET', '/api/user-notifications/unread-count', NOT_YET),
  // Market assets
  skip('POST', '/api/user-market-assets/upload-image', FRONTEND_ONLY),
  skip('POST', '/api/user-market-assets/upload-metadata', FRONTEND_ONLY),
  // Liquidity rewards. Both shared routes below have a public twin that returns the same
  // programmes and needs no credentials, so the client calls the twin.
  skip(
    'GET',
    '/api/liquidity-rewards/earning-pools',
    'public twin used: rewards.earningPools() (GET /api/public/liquidity-rewards/earning-pools) needs no credentials; it has no sort (always by daily pool), so order by estimatedApr on the client',
  ),
  skip(
    'GET',
    '/api/liquidity-rewards/markets/:marketId/config',
    'public twin used: rewards.marketConfig() (GET /api/public/liquidity-rewards/markets/:marketId/config) needs no credentials',
  ),
  // Points (the same section of the index: not rewards reads)
  skip('POST', '/api/points/calculate', `points calculator: ${NOT_YET}`),
  skip(
    'GET',
    '/api/points/market',
    `the account's points on a market: ${NOT_YET}`,
  ),
  // Charts (out of area, but the market routes refer to them)
  skip('GET', '/api/charts/:marketId', CHARTS),
  skip('GET', '/api/charts/:marketId/current', CHARTS),
  skip('POST', '/api/charts/current', CHARTS),
  skip('GET', '/api/charts/market/:id/points', CHARTS),
  // Market comments (out of area, but the market routes refer to them)
  skip('GET', '/api/market-comments', COMMENTS),
  skip('POST', '/api/market-comments', FRONTEND_ONLY),
  skip('GET', '/api/market-comments/:id', COMMENTS),
  skip('GET', '/api/market-comments/recent/pulse', COMMENTS),
  // Contest markets (out of area, but the market routes refer to them)
  skip('GET', '/api/contests/:slug/markets', CONTESTS),
  skip('GET', '/api/contests/:slug/markets/browse', CONTESTS),
  // Another area: a route that refuses API keys, like the pin, like, notification and
  // invite-code writes above
  skip('POST', '/api/convictions/:eventId/reports', FRONTEND_ONLY),
  // Outside the areas of the client: public or shared routes of the other areas
  skip('GET', '/api/ambassador/application', outside('ambassador')),
  skip('GET', '/api/ambassador/earnings', outside('ambassador')),
  skip('GET', '/api/ambassador/links', outside('ambassador')),
  skip('GET', '/api/ambassador/markets/eligible', outside('ambassador')),
  skip('POST', '/api/ambassador/public/track-click', outside('ambassador')),
  skip('GET', '/api/ambassador/stats', outside('ambassador')),
  skip('GET', '/api/ambassador/tiers', outside('ambassador')),
  skip('GET', '/api/badges', outside('badges')),
  skip('GET', '/api/badges/:tokenId', outside('badges')),
  skip('GET', '/api/badges/:tokenId/eligibility', outside('badges')),
  skip('GET', '/api/bridge/halliday/assets', BRIDGE),
  skip('GET', '/api/bridge/halliday/payments', BRIDGE),
  skip('POST', '/api/bridge/halliday/payments', BRIDGE),
  skip('GET', '/api/bridge/halliday/payments/:paymentId', BRIDGE),
  skip(
    'POST',
    '/api/bridge/halliday/payments/:paymentId/funding-claim',
    BRIDGE,
  ),
  skip('POST', '/api/bridge/halliday/payments/:paymentId/verification', BRIDGE),
  skip('POST', '/api/bridge/halliday/quotes', BRIDGE),
  skip('GET', '/api/bridge/has-bridged', outside('bridge')),
  skip('GET', '/api/contests', outside('contests')),
  skip('GET', '/api/contests/:slug', outside('contests')),
  skip('GET', '/api/contests/:slug/leaderboard', outside('contests')),
  skip('GET', '/api/contests/:slug/me', outside('contests')),
  skip('GET', '/api/contests/:slug/me/fills', outside('contests')),
  skip('GET', '/api/convictions', outside('convictions')),
  skip('GET', '/api/convictions/:conditionId', outside('convictions')),
  skip('GET', '/api/demo/twap', outside('demo')),
  skip('GET', '/api/demo/twap/opening', outside('demo')),
  skip('GET', '/api/me/disputes', outside('disputes')),
  skip('GET', '/api/me/resolution-signals', outside('resolution signals')),
  skip('GET', '/api/metrics/analytics/global', outside('metrics')),
  skip('GET', '/api/missions', outside('missions')),
  skip('GET', '/api/missions/:id', outside('missions')),
  skip('GET', '/api/parlays', outside('parlays')),
  skip('GET', '/api/parlays/:id', outside('parlays')),
  skip('GET', '/api/parlays/:id/entries/my', outside('parlays')),
  skip('GET', '/api/parlays/:id/leaderboard', outside('parlays')),
  skip('GET', '/api/parlays/featured', outside('parlays')),
  skip('GET', '/api/parlays/history/me', outside('parlays')),
  skip('GET', '/api/parlays/waitlist/access', outside('parlays')),
  skip('GET', '/api/parlays/waitlist/status', outside('parlays')),
  skip(
    'GET',
    '/api/public/user-referral/competition-leaderboard',
    outside('referrals'),
  ),
  skip('GET', '/api/public/users/referral/volume', outside('referrals')),
  skip('GET', '/api/rewards-config', outside('rewards config')),
  skip('GET', '/api/squads', outside('squads')),
  skip('GET', '/api/squads/:id', outside('squads')),
  skip('GET', '/api/squads/:id/members', outside('squads')),
  skip('GET', '/api/squads/:id/stats', outside('squads')),
  skip('GET', '/api/squads/leaderboard', outside('squads')),
  // Stories, which the SDK does not have yet, and the email waitlist signup
  skip('GET', '/api/stories/fixtures', NOT_YET),
  skip('GET', '/api/stories/fixtures/:id/markets', NOT_YET),
  skip('GET', '/api/stories/mine', NOT_YET),
  skip('POST', '/api/stories/quotes', NOT_YET),
  skip('GET', '/api/stories/quotes/:id', NOT_YET),
  skip('POST', '/api/stories/quotes/:id/accept', NOT_YET),
  skip('GET', '/api/stories/quotes/preview', NOT_YET),
  skip('POST', '/api/waitlist/signup', WAITLIST),
];

export const coverage: DataCoverage = Object.freeze({
  covered: Object.freeze(
    Object.values(routes).map(({ method, path }) =>
      Object.freeze({ method, path }),
    ),
  ),
  skipped: Object.freeze(SKIPPED.map((entry) => Object.freeze({ ...entry }))),
});
