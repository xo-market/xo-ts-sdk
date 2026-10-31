import { HttpResponse, http } from 'msw';
import type { SetupServer } from 'msw/node';
import { exceptionResponse } from './mockBackend';
import {
  BASE,
  type BackendData,
  badRequest,
  conditionIdOf,
  EVENT_ID,
  EVENT_SLUG,
  notFound,
  pageMeta,
  queryProblem,
  type RouteArgs,
  routing,
  SERIES_ID,
  slice,
} from './mockBackendData';
import { testEnv } from './testEnv';

// A fake of the backend's account routes, for the msw tests of the DataClient: the
// portfolio, PnL, activity, account and profile routes. Like `mockBackendData.ts` it is
// written from the backend's behaviour, not from the SDK:
//
// - access, as the backend's route index has it today: every `/users/me/*`, the
//   `/user/pnl*` routes and `/auth/api-keys` are `shared` (an `xo_sk` key or a Privy
//   session); `/users/portfolio` and `/profiles/*` have no guard. A public route
//   ignores any credential, and the fake records the Authorization header of every request.
// - query checks: a query key the route does not know is `400 property <key> should not
//   exist`; the backend's ranges and enums are enforced.
// - shapes: the portfolio rows are written from a live response; the other routes are the
//   documented answers.
// - `marketScope`: the backend's market types per scope (`default` is 0 and 2 on the activity
//   routes, and 0, 2 and 4 in the portfolio).

/** The account the fake's `xo_sk` keys belong to. */
export const OWNER = {
  id: 77,
  username: 'bot_one',
  wallet: `0x${'ab'.repeat(20)}`,
} as const;

/** The id the fake gives the key that `dataRig` uses (`API_KEY`), and its public prefix. */
export const OWN_KEY_ID = 12;
export const OWN_KEY_PREFIX = '0123456789abcdef';
export const OTHER_KEY_ID = 13;

/** The username (and wallet) of a public profile the fake knows. */
export const PUBLIC_USER = {
  id: 320,
  username: 'xouser1330',
  wallet: `0x${'cd'.repeat(20)}`,
} as const;

const TS = '2026-10-01T12:00:00.000Z';
const TOKEN = {
  id: 1,
  tokenAddress: testEnv.contracts.usdc,
  decimals: 6,
};

/** The market type of each portfolio market, by market id. */
const MARKET_TYPE: Record<number, number> = {
  1: 2,
  2: 3,
  5: 4,
  6: 0,
  12: 2,
};
const MARKET_STATUS: Record<number, string> = {
  1: 'ACTIVE',
  2: 'ACTIVE',
  5: 'ACTIVE',
  6: 'ACTIVE',
  12: 'RESOLVED',
};
const PORTFOLIO_MARKETS = [1, 2, 5, 6, 12];

/** The market types of each scope on the portfolio routes, as the backend maps them. */
const PORTFOLIO_SCOPE_TYPES: Record<string, number[] | undefined> = {
  default: [0, 2, 4],
  withClob: [0, 2, 3, 4],
  withPulse: undefined,
  onlyPulse: [1],
  onlyClob: [2, 3],
  onlyClobPulse: [3],
  onlyConviction: [4],
};
/** The market types of each scope on the activity routes, as the backend maps them. */
const ACTIVITY_SCOPE_TYPES: Record<string, number[] | undefined> = {
  default: [0, 2],
  withClob: [0, 2, 3],
  withPulse: undefined,
  onlyPulse: [1],
  onlyClob: [2, 3],
  onlyClobPulse: [3],
  onlyConviction: [4],
};
const SCOPES = Object.keys(PORTFOLIO_SCOPE_TYPES);

function marketInfo(id: number): Record<string, unknown> {
  const resolved = MARKET_STATUS[id] === 'RESOLVED';
  return {
    id,
    contractMarketId: conditionIdOf(id),
    conditionId: MARKET_TYPE[id] === 0 ? null : conditionIdOf(id),
    contractAddress: conditionIdOf(id),
    type: MARKET_TYPE[id],
    slug: `market-${id}`,
    title: `Market ${id}`,
    imageUrl: 'https://img.example/market.png',
    status: MARKET_STATUS[id],
    expiresAt: '2026-12-31T23:59:59.000Z',
    redeemableAmountPerShare: resolved ? '1000000' : null,
    initialSharesPerOutcome: id === 5 ? '429261248' : null,
    creatorBps: 150,
    cpEnabled: true,
    creator: { id: 94 },
    collateralToken: TOKEN,
    ...(resolved ? { winningOutcomeId: 900 + id } : {}),
  };
}

/** Event placement context, as `resolvePortfolioEventContextByContractMarketIds` builds it. */
export function eventContextFixture(): Record<string, unknown> {
  return {
    rootEventId: EVENT_ID,
    rootEventSlug: EVENT_SLUG,
    rootEventTitle: 'Argentina vs France',
    rootMetadata: { kickoffAt: TS, teamLeft: 'Argentina', teamRight: 'France' },
    seriesId: SERIES_ID,
    seriesSlug: 'world-cup-2026',
    placementEventId: EVENT_ID,
    subEventId: null,
    subEventSlug: null,
    subEventTitle: null,
    groupTitle: 'Argentina vs France',
    eventSortOrder: 0,
    eventMedia: [
      {
        id: '09ed54d3-6ec8-4d08-ad13-b94c3a8ad6f3',
        role: 'icon',
        url: 'https://img.example/icon.png',
        alt: 'Argentina vs France',
        sortOrder: 0,
        metadata: {},
      },
    ],
  };
}

/** One position of a market, as the repository maps it and `enrichPosition…` completes it. */
function positionFixture(
  marketId: number,
  index: number,
  mode: 'summary' | 'detail',
): Record<string, unknown> {
  const outcomeId = 800 + marketId + index;
  const resolved = MARKET_STATUS[marketId] === 'RESOLVED';
  const base: Record<string, unknown> = {
    id: 46_000 + marketId * 10 + index,
    collateralAmount: '331000002',
    shareAmount: '662000004',
    status: resolved ? 'CLOSED' : 'ACTIVE',
    positionType: 'BUY',
    totalPnlInCollateral: index === 0 ? '0' : '-50000',
    entryPrice: '500000',
    createdAt: TS,
    updatedAt: TS,
    userAddress: OWNER.wallet,
    userId: OWNER.id,
    marketId,
    outcomeId,
    market: {
      ...marketInfo(marketId),
      ...(mode === 'detail' ? { event: null } : {}),
    },
    outcome: {
      id: outcomeId,
      title: index === 0 ? 'Yes' : 'No',
      index,
      currentPrice: '900000',
      outcomeTokenId:
        '73921699981071296078090952507533822950204573800942628120869',
    },
    initialCollateral: '331000002',
    entryValue: 331.000002,
    currentValue: 595.800003,
    pnl: 264.80000099999995,
    pnlPercentage: 79.9999998187311,
    hasClaimed: false,
    effectivePnl: 264.80000099999995,
    effectivePnlPercentage: 79.9999998187311,
    effectiveCurrentValue: 595.800003,
    unsettledCp: '0.00',
    lifetimeEarnedCp: '0.00',
  };
  if (mode === 'summary') {
    base.currentPrice = '900000';
    base.positionPerformance = '80.0000';
  }
  return base;
}

/** A summary-mode row: the market, its positions, the totals and the event. */
function portfolioMarketRow(marketId: number): Record<string, unknown> {
  return {
    ...marketInfo(marketId),
    positions: [0, 1].map((index) =>
      positionFixture(marketId, index, 'summary'),
    ),
    totalStake: 662.000004,
    totalPnL: 529.6000019999999,
    transactionCounts: 2,
    event: marketId === 1 ? eventContextFixture() : null,
  };
}

function typesOf(
  scope: string | undefined,
  table: Record<string, number[] | undefined>,
): number[] | undefined {
  return table[scope ?? 'default'];
}

function inScope(
  marketId: number,
  scope: string | undefined,
  table: Record<string, number[] | undefined>,
): boolean {
  const types = typesOf(scope, table);
  return types === undefined || types.includes(MARKET_TYPE[marketId] ?? -1);
}

/** The enum and range problems of a query, as the backend's validation words them. */
function enumProblems(
  query: Record<string, string>,
  enums: Record<string, readonly string[]>,
): string[] {
  const problems: string[] = [];
  for (const [key, values] of Object.entries(enums)) {
    const value = query[key];
    if (value !== undefined && !values.includes(value)) {
      problems.push(
        `${key} must be one of the following values: ${values.join(', ')}`,
      );
    }
  }
  return problems;
}

function withProblems(
  path: string,
  query: Record<string, string>,
  allowed: string[],
  limits: { takeMax?: number },
  enums: Record<string, readonly string[]> = {},
): Response | undefined {
  const base = queryProblem(path, query, allowed, limits);
  if (base !== undefined) return base;
  const extra = enumProblems(query, enums);
  return extra.length === 0 ? undefined : badRequest(path, extra);
}

const GLOBAL_KEYS = ['page', 'take', 'search', 'sortBy', 'sortOrder'];
const PORTFOLIO_KEYS = [
  ...GLOBAL_KEYS,
  'marketScope',
  'status',
  'marketStatus',
  'marketId',
  'contractMarketId',
  'refresh',
  'claimableFirst',
];
const ACTIVITY_KEYS = [
  ...GLOBAL_KEYS,
  'marketScope',
  'positionType',
  'marketId',
  'dateFrom',
  'dateTo',
  'cpMin',
  'cpMax',
];
const CLAIMABLE_KEYS = ['marketScope', 'page', 'take', 'sortBy', 'sortOrder'];
const MARKET_STATUSES = [
  'PENDING',
  'ACTIVE',
  'PAUSED',
  'CANCELLED',
  'RESOLVED',
  'DISPUTED',
  'CLOSED',
  'DEFAULTED',
  'UPDATE_REQUIRED',
  'VOIDED',
  'VOIDED_CLOSED',
];

/** How many open orders, claimables, redeemables and activity rows the fake holds. */
export const OPEN_ORDER_COUNT = 5;
export const CLAIMABLE_COUNT = 3;
export const ACTIVITY_COUNT = 6;
export const PNL_POSITION_ID = 46_010;
export const PNL_MARKET_ID = 1;

function openOrderFixture(n: number): Record<string, unknown> {
  return {
    marketId: conditionIdOf(1),
    orderId: String(9000 + n),
    outcome: n % 2 === 1 ? 'Yes' : 'No',
    outcomeLabel: n % 2 === 1 ? 'Yes' : 'No',
    side: 'Buy',
    price: 0.57,
    priceTick: 570,
    originalSize: 12.5,
    remainingSize: 7.5,
    notionalUsd: 7.125,
    originalSizeMicro: 12_500_000,
    remainingSizeMicro: 7_500_000,
    notionalMicro: 7_125_000,
    status: 'partial',
    timePriority: 1_760_000_000_000 + n,
    isSeed: false,
    schemaVersion: 1,
    createdAtMs: 1_760_000_000_000 + n,
    lastFillAtMs: null,
    endedAtMs: null,
    market: {
      title: 'Market 1',
      slug: 'market-1',
      imageUrl: null,
      contractMarketId: conditionIdOf(1),
      marketType: 2,
      status: 'ACTIVE',
      eventId: EVENT_ID,
      eventSlug: EVENT_SLUG,
      rootEventSlug: EVENT_SLUG,
      rootEventTitle: 'Argentina vs France',
      outcomes: [
        { outcomeTokenId: '111', index: 0, title: 'Yes' },
        { outcomeTokenId: '222', index: 1, title: 'No' },
      ],
    },
  };
}

function claimableFixture(n: number): Record<string, unknown> {
  return {
    marketId: 12,
    contractMarketId: conditionIdOf(12),
    marketContractAddress: conditionIdOf(12),
    title: `Market 12 (${n})`,
    slug: 'market-12',
    description: 'A resolved market',
    imageUrl: 'https://img.example/market.png',
    status: 'RESOLVED',
    type: 2,
    closedAt: TS,
    claimableAmountWei: '1500000',
    claimableAmountUSD: 1.5,
    winningOutcome: { id: 912, title: 'Yes', contractOutcomeId: '111' },
    userPosition: {
      outcomeId: 912,
      shareAmount: '1500000',
      shareAmountFormatted: 1.5,
    },
    collateralToken: TOKEN,
  };
}

function redeemableFixture(
  n: number,
  role: 'user' | 'creator',
): Record<string, unknown> {
  return {
    role,
    marketId: 12,
    contractMarketId: conditionIdOf(12),
    marketContractAddress: conditionIdOf(12),
    title: `Market 12 (${n})`,
    slug: 'market-12',
    imageUrl: 'https://img.example/market.png',
    status: 'RESOLVED',
    type: 2,
    closedAt: TS,
    redeemableAmountPerShare: '1000000',
    claimableAmountWei: '1500000',
    claimableAmountUSD: 1.5,
    winningOutcome: {
      id: 912,
      title: 'Yes',
      index: 0,
      outcomeTokenId: '111',
    },
    outcome: { id: 912, title: 'Yes', index: 0, outcomeTokenId: '111' },
    position: {
      id: 46_100 + n,
      status: 'CLOSED',
      positionType: 'BUY',
      outcomeId: 912,
      shareAmount: '1500000',
      shareAmountFormatted: 1.5,
      collateralAmount: '900000',
    },
    collateralToken: { ...TOKEN, symbol: 'USDC' },
  };
}

/** A row of `/users/me/activities` (and of a public profile's activities). */
function userActivityFixture(n: number): Record<string, unknown> {
  const creator = n === ACTIVITY_COUNT;
  const positionType = creator
    ? 'BUY'
    : (['BUY', 'SELL', 'REDEEM'][n % 3] ?? 'BUY');
  return {
    marketTitle: 'Market 1',
    marketId: 1,
    description: 'Bought 10.0000 Yes shares @ $0.57000',
    picture: 'https://img.example/market.png',
    slug: 'market-1',
    date: TS,
    cpEarned: '3.50',
    unsettledCp: '0.00',
    lifetimeEarnedCp: '0.00',
    cpEnabled: true,
    ...(creator
      ? {}
      : {
          avgEntryValue: 5.7,
          avgCurrentValue: 6,
          avgPnl: 0.3,
          avgPnlPercentage: 5.26,
          avgEntryPrice: '570000',
        }),
    activityType: creator ? 'creator' : 'user',
    positionType,
    volumeInUSD: '5.7',
    ...(creator
      ? {}
      : {
          tradingFee: {
            feeAmount: '99640',
            feeInUSD: '0.09964',
            isTaker: true,
            netCollateralAmount: '4600360',
          },
          netFeeUSD: '-0.0996',
        }),
    contractMarketId: conditionIdOf(1),
    event: null,
  };
}

/** A row of `/users/me/market-activities`: the merged activity plus `pnlInUSD`. */
function marketActivityFixture(n: number): Record<string, unknown> {
  return {
    id: 5000 + n,
    activityType: 'USER_TRADE',
    positionType: ['BUY', 'SELL', 'REDEEM'][n % 3],
    collateralAmount: '5700000',
    initialCollateral: '5600000',
    shareAmount: '10000000',
    volumeInUSD: '5.70',
    priceAtExecution: '570000',
    transactionHash: `0x${'ee'.repeat(32)}`,
    cpEarned: '3.50',
    lifetimeEarnedCp: '0.00',
    executedAt: TS,
    createdAt: TS,
    user: {
      id: OWNER.id,
      username: OWNER.username,
      roosterColor: '#0088CC',
      profilePictureUrl: null,
      achievements: [],
      verified: false,
      isOg: false,
      cpPoints: 0,
      tier: 'Spectator',
    },
    outcome: {
      id: 801,
      title: 'Yes',
      index: 0,
      currentPrice: '570000',
      volumeTradedInUSD: '12.00',
    },
    market: {
      id: 1,
      contractMarketId: conditionIdOf(1),
      title: 'BTC 5min Pulse',
      slug: 'btc-5min-pulse-5018',
      imageUrl: 'https://img.example/market.png',
      status: 'CLOSED',
      expiresAt: TS,
      creatorBps: 0,
      totalVolumeInUSD: '99.999999',
      cpEnabled: false,
      cycleNumber: 5018,
      collateralToken: { ...TOKEN, symbol: 'USDC', logoUrl: '' },
    },
    userPositions: [],
    creatorFee: { creatorFeeBps: 0, creatorFeePercentage: 0 },
    tradingFee: {
      feeAmount: '99640',
      feeInUSD: '0.09964',
      isTaker: true,
      netCollateralAmount: '4600360',
    },
    netFeeUSD: '-0.0996',
    pnlInUSD: n % 3 === 0 ? '0.00' : '-12.50',
  };
}

function pnlPosition(id: number): Record<string, unknown> {
  return {
    positionId: id,
    marketId: PNL_MARKET_ID,
    marketTitle: 'Market 1',
    marketStatus: 'ACTIVE',
    outcomeTitle: 'Yes',
    entryValue: 500,
    currentValue: 623.45,
    pnl: 123.45,
    pnlPercentage: 24.69,
    calculationType: 'ACTIVE',
    shareAmount: '2000000',
    entryPrice: '500000',
    calculatedAt: TS,
  };
}

function profileFixture(): Record<string, unknown> {
  return {
    id: PUBLIC_USER.id,
    username: PUBLIC_USER.username,
    profilePictureUrl: 'https://img.example/avatar.png',
    verified: false,
    isOg: false,
    isPrivate: false,
    cpPoints: 520_321.56,
    tier: 'Caller',
    bio: 'Testing testing',
    socials: { x: 'xouser1330', tiktok: null, instagram: null, discord: null },
    profileBadges: [
      { key: 'CATALYST', earned: true, isRevoked: false, tokenId: 1 },
      { key: 'HATCHLING', earned: false, isRevoked: false },
    ],
    boardingPassTiers: [
      {
        key: 'BOARDING_PASS_ECONOMY',
        tokenId: 2,
        earned: false,
        isRevoked: false,
      },
    ],
    badges: [{ type: 'XO-CATALYST', isRevoked: false }],
    achievements: ['CATALYST'],
  };
}

/** The slim `GET /users/me` (no `view=full`). */
export function currentUserFixture(): Record<string, unknown> {
  return {
    id: OWNER.id,
    username: OWNER.username,
    walletPublicKey: OWNER.wallet,
    status: 'ACTIVE',
    verified: false,
    isOg: false,
    isAmbassador: false,
    socials: { x: null, tiktok: null, instagram: null, discord: null },
    profilePictureUrl: null,
    roosterColor: '#FF5555',
    hasAccess: true,
    isPrivate: false,
    hasEnteredReferralCode: false,
    createdAt: TS,
    updatedAt: TS,
    userVolume: '1234.56',
    likedMarketIds: [1, 3],
    positionHistory: [],
    currentPositions: [],
    userPoints: { currentPoints: '15.75', totalPointsEarned: '47.25' },
    stats: {
      totalPositions: 0,
      activePositions: 0,
      totalVolumeTraded: '0',
      totalRedeemed: '0',
      marketsParticipated: 0,
      totalComments: 0,
      totalRedeems: 0,
    },
    cpPoints: 5000,
    tier: 'Believer',
    score: 5,
    totalUnsettledCp: '0.00',
    cpAccrualMarketsCount: 0,
    unsettledCpMarkets: [],
  };
}

/** One row of `GET /auth/api-keys`. */
function keyRow(id: number, prefix: string, revoked: boolean) {
  return {
    id,
    name: `xo-sdk:e2e:20261018`,
    prefix,
    scopes: ['account:read', 'account:write'],
    expiresAt: '2026-10-19T12:00:00.000Z',
    lastUsedAt: null,
    lastUsedIp: null,
    revokedAt: revoked ? TS : null,
    createdVia: 'wallet_signature',
    createdAt: TS,
  };
}

/** The state of the account fake that a test may read or change. */
export interface AccountData {
  /**
   * `GET /users/portfolio` answers the first page whatever `page` says, as the backend has been
   * seen to do. The meta still echoes the requested page. Set false for a backend that pages
   * properly.
   */
  publicPortfolioIgnoresPage: boolean;
  /** Keys revoked by a DELETE, by id. */
  revoked: Set<number>;
  /** Open orders in the fake, newest first. */
  openOrders: number;
}

/**
 * Installs the account routes on `server`, recording into the same log as the rest of the
 * fake (`backend.requests`). The shared routes accept the keys in `backend.validKeys`; the
 * key `API_KEY` of `dataRig` is the account's key number {@link OWN_KEY_ID}.
 */
export function installAccountData(
  server: SetupServer,
  backend: BackendData,
): AccountData {
  const state: AccountData = {
    publicPortfolioIgnoresPage: true,
    revoked: new Set(),
    openOrders: OPEN_ORDER_COUNT,
  };
  const { route } = routing(backend);

  /** The backend's key check: a key the backend knows, else 401. */
  const shared =
    (
      handler: (r: RouteArgs) => Response | Record<string, unknown> | unknown[],
    ) =>
    (args: { request: Request; params: Record<string, unknown> }) =>
      route((r) => {
        const match = /^Bearer (.+)$/.exec(r.request.authorization ?? '');
        if (match?.[1] === undefined || !backend.validKeys.has(match[1])) {
          return exceptionResponse(r.request.path, 401, {
            error: 'invalid_credentials',
            message: 'Invalid credentials',
          });
        }
        return handler(r);
      })(args);

  const pageOf = (
    rows: unknown[],
    query: Record<string, string>,
    defaultTake: number,
  ) => {
    const page = Number(query.page ?? 1);
    const take = Number(query.take ?? defaultTake);
    return {
      data: slice(rows, page, take),
      meta: pageMeta(page, take, rows.length),
    };
  };

  /** The page of the public portfolio, with the paging defect (see `AccountData`). */
  const publicPage = (rows: unknown[], query: Record<string, string>) => {
    const answer = pageOf(rows, query, 10);
    if (!state.publicPortfolioIgnoresPage) return answer;
    const take = Number(query.take ?? 10);
    return { data: slice(rows, 1, take), meta: answer.meta };
  };

  server.use(
    // --- portfolio -------------------------------------------------------------------
    http.get(
      `${BASE}/users/me/portfolio`,
      shared(({ request }) => {
        const problem = withProblems(
          request.path,
          request.query,
          PORTFOLIO_KEYS,
          { takeMax: 1000 },
          {
            marketScope: SCOPES,
            sortBy: ['pnl', 'value', 'expiry', 'createdAt'],
            sortOrder: ['ASC', 'DESC'],
            status: ['active', 'closed', 'all', 'resolved'],
          },
        );
        if (problem) return problem;
        const marketId = request.query.marketId;
        if (marketId !== undefined) {
          const id = Number(marketId);
          if (!PORTFOLIO_MARKETS.includes(id)) {
            return notFound(
              request.path,
              `Market with ID ${marketId} not found`,
            );
          }
          // Detail mode: flat position rows, and the scope still applies to the type.
          const rows = inScope(
            id,
            request.query.marketScope,
            PORTFOLIO_SCOPE_TYPES,
          )
            ? [0, 1].map((index) => positionFixture(id, index, 'detail'))
            : [];
          return pageOf(rows, request.query, 10);
        }
        const rows = PORTFOLIO_MARKETS.filter((id) =>
          inScope(id, request.query.marketScope, PORTFOLIO_SCOPE_TYPES),
        ).map(portfolioMarketRow);
        return pageOf(rows, request.query, 10);
      }),
    ),

    http.get(
      `${BASE}/users/me/portfolio-value`,
      shared(({ request }) => {
        // A bare @Query('refresh'): no whitelist.
        void request;
        return {
          cashUSD: 691.5,
          positionsValueUSD: 420.25,
          claimableAmountUSD: 25,
          portfolioValueUSD: 1136.75,
          currency: 'USD',
          unpricedPositionCount: 0,
        };
      }),
    ),

    http.get(
      `${BASE}/users/me/redeemable-positions`,
      shared(({ request }) => {
        const problem = withProblems(
          request.path,
          request.query,
          [...CLAIMABLE_KEYS, 'role'],
          { takeMax: 100 },
          {
            marketScope: SCOPES,
            sortBy: ['claimableAmount', 'closedAt'],
            sortOrder: ['ASC', 'DESC'],
            role: ['user', 'creator'],
          },
        );
        if (problem) return problem;
        const role = (request.query.role ?? 'user') as 'user' | 'creator';
        const rows = Array.from({ length: CLAIMABLE_COUNT }, (_, n) =>
          redeemableFixture(n + 1, role),
        );
        return pageOf(rows, request.query, 10);
      }),
    ),

    http.get(
      `${BASE}/users/me/claimable-markets`,
      shared(({ request }) => {
        const problem = withProblems(
          request.path,
          request.query,
          CLAIMABLE_KEYS,
          { takeMax: 100 },
          {
            marketScope: SCOPES,
            sortBy: ['claimableAmount', 'closedAt'],
            sortOrder: ['ASC', 'DESC'],
          },
        );
        if (problem) return problem;
        const rows = Array.from({ length: CLAIMABLE_COUNT }, (_, n) =>
          claimableFixture(n + 1),
        );
        return pageOf(rows, request.query, 10);
      }),
    ),

    http.get(
      `${BASE}/users/me/open-orders`,
      shared(({ request }) => {
        const query = request.query;
        const problems: string[] = [];
        for (const key of Object.keys(query)) {
          if (!['sort', 'status', 'limit', 'cursor'].includes(key)) {
            problems.push(`property ${key} should not exist`);
          }
        }
        if (
          query.sort !== undefined &&
          !['latest', 'oldest', 'size'].includes(query.sort)
        ) {
          problems.push(
            'sort must be one of the following values: latest, oldest, size',
          );
        }
        if (
          query.status !== undefined &&
          !/^(resting|partial|filled)(,(resting|partial|filled))*$/i.test(
            query.status,
          )
        ) {
          problems.push(
            'status must be a comma-separated subset of resting, partial, filled',
          );
        }
        if (query.limit !== undefined) {
          const limit = Number(query.limit);
          if (!Number.isInteger(limit) || limit < 1) {
            problems.push('limit must not be less than 1');
          } else if (limit > 200) {
            problems.push('limit must not be greater than 200');
          }
        }
        if (problems.length > 0) return badRequest(request.path, problems);
        const limit = Number(query.limit ?? 50);
        // Opaque cursor: the offset of the next order, behind a prefix.
        const offset =
          query.cursor === undefined
            ? 0
            : Number(query.cursor.replace('cur-', ''));
        const orders = Array.from({ length: state.openOrders }, (_, n) =>
          openOrderFixture(n + 1),
        ).slice(offset, offset + limit);
        const next = offset + limit;
        return {
          userId: OWNER.wallet,
          query: {
            sort: query.sort ?? 'latest',
            status: (query.status ?? 'resting,partial,filled').split(','),
            limit,
          },
          orders,
          nextCursor: next < state.openOrders ? `cur-${next}` : null,
        };
      }),
    ),

    // --- pnl -------------------------------------------------------------------------
    http.get(
      `${BASE}/user/pnl/market/:marketId`,
      shared(({ request, params }) => {
        const id = Number(params.marketId);
        if (!Number.isInteger(id)) {
          return badRequest(
            request.path,
            'Validation failed (numeric string is expected)',
          );
        }
        if (id !== PNL_MARKET_ID) {
          return notFound(request.path, `Market ${id} not found`);
        }
        return {
          marketId: id,
          marketTitle: 'Market 1',
          totalPnl: 123.45,
          totalPnlPercentage: 24.69,
          positionsCount: 1,
          positions: [pnlPosition(PNL_POSITION_ID)],
        };
      }),
    ),

    http.get(
      `${BASE}/user/pnl/position/:positionId`,
      shared(({ request, params }) => {
        const id = Number(params.positionId);
        if (!Number.isInteger(id)) {
          return badRequest(
            request.path,
            'Validation failed (numeric string is expected)',
          );
        }
        if (id !== PNL_POSITION_ID) {
          return notFound(
            request.path,
            `Position ${id} not found or not owned by user`,
          );
        }
        return { position: pnlPosition(id) };
      }),
    ),

    http.get(
      `${BASE}/user/pnl`,
      shared(({ request }) => {
        const problem = withProblems(
          request.path,
          request.query,
          ['marketScope', 'status', 'marketStatus'],
          {},
          {
            marketScope: SCOPES,
            status: ['active', 'closed', 'all'],
            marketStatus: MARKET_STATUSES,
          },
        );
        if (problem) return problem;
        return {
          totalPnl: 247.89,
          totalPnlPercentage: 15.67,
          totalEntryValue: 1580.5,
          totalCurrentValue: 1828.39,
          activePositionsCount: 5,
          closedPositionsCount: 3,
          calculationErrors: 0,
          positions: [pnlPosition(PNL_POSITION_ID)],
        };
      }),
    ),

    // --- activity --------------------------------------------------------------------
    http.get(
      `${BASE}/users/me/market-activities`,
      shared(({ request }) => {
        const problem = withProblems(
          request.path,
          request.query,
          [...ACTIVITY_KEYS, 'eventId', 'includeSubEvents', 'subEventId'],
          { takeMax: 1000 },
          {
            marketScope: SCOPES,
            sortBy: [
              'executedAt',
              'volumeInUSD',
              'collateralAmount',
              'shareAmount',
              'createdAt',
            ],
            sortOrder: ['ASC', 'DESC'],
            positionType: ['BUY', 'SELL', 'REDEEM', 'all'],
          },
        );
        if (problem) return problem;
        // The use case clamps take to 50, but the meta echoes the request.
        const rows = inScope(1, request.query.marketScope, ACTIVITY_SCOPE_TYPES)
          ? Array.from({ length: ACTIVITY_COUNT }, (_, n) =>
              marketActivityFixture(n + 1),
            )
          : [];
        const page = Number(request.query.page ?? 1);
        const take = Math.min(Number(request.query.take ?? 10), 50);
        return {
          data: slice(rows, page, take),
          meta: pageMeta(page, take, rows.length),
        };
      }),
    ),

    http.get(
      `${BASE}/users/me/activities`,
      shared(({ request }) => {
        const problem = withProblems(
          request.path,
          request.query,
          ACTIVITY_KEYS,
          { takeMax: 1000 },
          {
            marketScope: SCOPES,
            sortBy: [
              'executedAt',
              'volumeInUSD',
              'collateralAmount',
              'shareAmount',
              'createdAt',
            ],
            sortOrder: ['ASC', 'DESC'],
            positionType: ['BUY', 'SELL', 'REDEEM', 'all'],
          },
        );
        if (problem) return problem;
        // Every row is about market 1, a CLOB market (type 2).
        const rows = inScope(1, request.query.marketScope, ACTIVITY_SCOPE_TYPES)
          ? Array.from({ length: ACTIVITY_COUNT }, (_, n) =>
              userActivityFixture(n + 1),
            )
          : [];
        return pageOf(rows, request.query, 10);
      }),
    ),

    http.get(
      `${BASE}/users/me/stats`,
      shared(() => ({
        pnl: -1690.288222,
        volume: 5936.423181,
        marketsTraded: 52,
        winRate: null,
      })),
    ),

    // --- account ---------------------------------------------------------------------
    http.get(
      `${BASE}/users/me`,
      shared(({ request }) => {
        const problem = withProblems(request.path, request.query, ['view'], {});
        if (problem) return problem;
        return currentUserFixture();
      }),
    ),

    http.get(
      `${BASE}/auth/api-keys`,
      shared(() => [
        keyRow(OTHER_KEY_ID, 'zZ9yY8xX', state.revoked.has(OTHER_KEY_ID)),
        keyRow(OWN_KEY_ID, OWN_KEY_PREFIX, state.revoked.has(OWN_KEY_ID)),
      ]),
    ),

    http.delete(
      `${BASE}/auth/api-keys/:id`,
      shared(({ request, params }) => {
        const id = Number(params.id);
        if (!Number.isInteger(id)) {
          return badRequest(
            request.path,
            'Validation failed (numeric string is expected)',
          );
        }
        // An API key can only revoke itself, checked first.
        if (id !== OWN_KEY_ID) {
          return exceptionResponse(request.path, 403, {
            error: 'api_key_can_only_revoke_itself',
            message: 'An API key can only revoke itself.',
          });
        }
        state.revoked.add(id);
        return new HttpResponse(null, { status: 204 });
      }),
    ),

    // --- public ----------------------------------------------------------------------
    http.get(
      `${BASE}/users/portfolio`,
      route(({ request }) => {
        const problems: string[] = [];
        for (const key of Object.keys(request.query)) {
          if (key !== 'user' && !PORTFOLIO_KEYS.includes(key)) {
            problems.push(`property ${key} should not exist`);
          }
        }
        if (request.query.user === undefined || request.query.user === '') {
          problems.push('user should be string', 'user should not be empty');
        }
        const enumIssues = enumProblems(request.query, {
          marketScope: SCOPES,
          sortBy: ['pnl', 'value', 'expiry', 'createdAt'],
          sortOrder: ['ASC', 'DESC'],
          status: ['active', 'closed', 'all', 'resolved'],
        });
        problems.push(...enumIssues);
        if (problems.length > 0) return badRequest(request.path, problems);
        const user = request.query.user as string;
        if (
          user.toLowerCase() !== PUBLIC_USER.wallet.toLowerCase() &&
          user.toLowerCase() !== PUBLIC_USER.username.toLowerCase()
        ) {
          return notFound(request.path, 'User not found');
        }
        const marketId = request.query.marketId;
        if (marketId !== undefined) {
          const id = Number(marketId);
          const rows = PORTFOLIO_MARKETS.includes(id)
            ? [0, 1].map((index) => positionFixture(id, index, 'detail'))
            : [];
          return publicPage(rows, request.query);
        }
        const rows = PORTFOLIO_MARKETS.filter((id) =>
          inScope(id, request.query.marketScope, PORTFOLIO_SCOPE_TYPES),
        ).map(portfolioMarketRow);
        return publicPage(rows, request.query);
      }),
    ),

    http.get(
      `${BASE}/profiles/:username/stats`,
      route(({ request, params }) => {
        if (params.username?.toLowerCase() !== PUBLIC_USER.username) {
          return notFound(request.path, 'User not found');
        }
        return {
          pnl: -1690.288222,
          volume: 5936.423181,
          marketsTraded: 52,
          winRate: null,
        };
      }),
    ),

    http.get(
      `${BASE}/profiles/:username`,
      route(({ request, params }) => {
        if (params.username?.toLowerCase() !== PUBLIC_USER.username) {
          return notFound(request.path, 'User not found');
        }
        return profileFixture();
      }),
    ),
  );

  return state;
}

/** A page of every kind of fixture row, for tests that need to build their own answers. */
export const fixtures = {
  portfolioMarketRow,
  positionFixture,
  userActivityFixture,
  marketActivityFixture,
  openOrderFixture,
  claimableFixture,
  redeemableFixture,
  profileFixture,
  keyRow,
};
