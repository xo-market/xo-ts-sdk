import { HttpResponse, http } from 'msw';
import type { SetupServer } from 'msw/node';
import { exceptionResponse } from './mockBackend';
import { testEnv } from './testEnv';

// A fake of the backend's public read routes, for the msw tests of the DataClient:
// markets, events, series, pulse markets and the taxonomy. It is written from the backend's
// behaviour, not from the SDK, so a test that reads against it checks the SDK's
// requests against an independent version:
//
// - the routes and their access, as the backend's route index has it today:
//   everything below is `public` (or unguarded) except GET /api/markets/clob/trading-status,
//   which is `shared` (a session or an `xo_sk` key). A public route ignores any
//   credential; the fake records the Authorization header of every request so a test can
//   assert that none was sent.
// - the query checks: a query key the route does not know is `400 property <key> should not
//   exist`, and the backend's ranges are enforced (page 1..10000, take 1..50 for markets,
//   1..1000 elsewhere). The activity feeds clamp `take` to 50 instead of refusing it.
// - the answers: `{ data, meta: PageMeta }` for the page/take lists, `{ data }` for single
//   objects and the event and series reads, a bare array for price history, categories,
//   tokens and the pulse batch, `{ data, meta: { page, limit, total, totalPages, ... } }`
//   for pulse markets, `{ items, total, page, limit, totalPages, hasNext, hasPrev }` for
//   the paginated subcategories.
// - errors: failures come out as the backend's error handler writes them (see exceptionResponse in
//   mockBackend.ts); a missing market, event or series is a 404.
//
// The fixtures are built to be consistent with each other: market ids 1..14, of which the CLOB
// markets (types 2 and 3) are ids 1, 2, 3, 4, 8, 9, 10, 11 and 12.

const env = testEnv;
export const BASE = `${env.backendUrl}/api`;

export const SERIES_ID = '0d9f3a5e-2b3c-4d4e-8f50-6a7b8c9d0e1f';
export const SERIES_SLUG = 'world-cup-2026';
export const EVENT_ID = '5b7c1a2e-9c4d-4e8f-a1b2-3c4d5e6f7a8b';
export const EVENT_SLUG = 'argentina-vs-france';
export const SUB_EVENT_ID = '8e9f0a1b-2c3d-4e5f-8a6b-7c8d9e0f1a2b';
export const OTHER_EVENT_ID = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
export const MISSING_UUID = '00000000-0000-4000-8000-000000000000';
export const PULSE_ADDRESS = `0x${'ab'.repeat(20)}`;
export const PULSE_ADDRESS_2 = `0x${'cd'.repeat(20)}`;

/** The market type of each market id, 1-based. 2 and 3 are the CLOB types. */
const TYPES = [2, 3, 2, 3, 4, 0, 1, 2, 3, 2, 3, 2, 4, 0];
export const MARKET_COUNT = TYPES.length;
/** A CLOB market that is closed and resolved (it has a winning outcome). */
export const RESOLVED_MARKET_ID = 12;
export const CLOB_MARKET_IDS = TYPES.flatMap((type, index) =>
  type === 2 || type === 3 ? [index + 1] : [],
);
export const STANDARD_MARKET_IDS = TYPES.flatMap((type, index) =>
  type === 0 ? [index + 1] : [],
);

/** The condition id of a market (`0x` and 64 hex digits). */
export const conditionIdOf = (id: number): string =>
  `0x${id.toString(16).padStart(2, '0').repeat(32)}`;
/** The 20-byte contract address of a legacy market. */
export const addressOf = (id: number): string =>
  `0x${id.toString(16).padStart(2, '0').repeat(20)}`;
export const slugOf = (id: number): string => `market-${id}`;

const TS = '2026-10-01T12:00:00.000Z';

// Token rows (`GET /tokens`, a market's `collateralToken`) have been seen to carry no
// createdAt or updatedAt, and the logo can be an empty string (live check).
export function tokenFixture(): Record<string, unknown> {
  return {
    id: 1,
    symbol: 'USDC',
    name: 'Bridged USDC (Lucid)',
    tokenAddress: `0x${'0f'.repeat(20)}`,
    decimals: 6,
    isActive: true,
    networkId: 1,
    logoUrl: '',
  };
}

// Outcomes have been seen to carry the market's numeric database id as `marketId` and no
// createdAt or updatedAt (live check).
function outcomeFixture(
  marketId: number,
  id: number,
  index: number,
): Record<string, unknown> {
  return {
    id,
    marketId,
    outcomeTokenAddress: `0x${'e0'.repeat(20)}`,
    outcomeTokenId: `${71321045679252212594626385532706912750332728571942532289631379312455583992563n + BigInt(id)}`,
    title: index === 0 ? 'YES' : 'NO',
    index,
    currentPrice: index === 0 ? '570000' : '430000',
    volumeTraded: '12000000',
    volumeTradedInUSD: '12.00',
    notionalTraded: '24000000',
  };
}

/** The fee config of a market, as the detail routes and `fee-config/effective` send it. */
export function feeConfigFixture(id: number): Record<string, unknown> {
  const type = TYPES[id - 1] ?? 2;
  return type === 0 || type === 1
    ? {
        eligible: false,
        curveModel: 'LEGACY_CREATOR_BPS',
        takerFeeBps: 0,
        makerFeeBps: 0,
        configId: null,
        configName: null,
        splitSummary: null,
      }
    : {
        eligible: true,
        curveModel: 'FLAT_BPS',
        takerFeeBps: 200,
        makerFeeBps: 0,
        configId: 5,
        configName: 'default',
        splitSummary: {
          creatorShareBps: 5000,
          makerShareBps: 2500,
          platformShareBps: 2500,
        },
        resolutionPath: ['category:1', 'default'],
        orderbookConfigId: null,
        configVersion: null,
        latestPublishedVersion: null,
      };
}

/**
 * A market as the list routes send it (live check): no `visible`, no `collateralToken`,
 * no `effectiveFeeConfig` and no `winningOutcome` until the market resolves. The detail
 * routes add those (see `marketDetail`).
 */
export function marketFixture(id: number): Record<string, unknown> {
  const type = TYPES[id - 1] ?? 2;
  const clob = type !== 0 && type !== 1;
  const contractMarketId = clob ? conditionIdOf(id) : addressOf(id);
  return {
    id,
    createdAt: TS,
    updatedAt: TS,
    contractMarketId,
    conditionId: clob ? conditionIdOf(id) : null,
    marketContractAddress: clob ? `0x${'99'.repeat(20)}` : addressOf(id),
    versionId: clob ? 3 : 2,
    createMarketBlockTimestamp: TS,
    creatorId: 7,
    title: `Will thing ${id} happen?`,
    slug: slugOf(id),
    rules: { source: 'official' },
    description: 'Resolves YES if it does.',
    categoryPath: [{ id: 1, name: 'Sports', slug: 'sports' }],
    marketTags: [{ key: 'league', value: 'wc' }],
    type,
    totalVolume: '1500000000',
    totalVolumeInUSD: '1500.00',
    totalNotional: '2500000000',
    totalNotionalInUSD: '2500.00',
    status: id === RESOLVED_MARKET_ID ? 'CLOSED' : 'ACTIVE',
    startsAt: TS,
    expiresAt: '2026-12-01T00:00:00.000Z',
    resolvedAt: id === RESOLVED_MARKET_ID ? TS : null,
    metadataUri: 'ipfs://meta',
    imageUrl: 'https://cdn.example/m.png',
    resolutionEvidence: '',
    resolutionSources: ['https://example.com'],
    resolverAddress: `0x${'77'.repeat(20)}`,
    resolutionType: 'MANUAL',
    resolutionFlagCount: 0,
    priorityScore: 0,
    likes: 3,
    cpEnabled: true,
    cpMultiplier: 1,
    creatorBps: 100,
    initialCollateral: '100000000',
    redeemableAmountPerShare: '1000000',
    eventId: type === 4 ? EVENT_ID : undefined,
    isFeatured: false,
    featuredOrder: null,
    creator: {
      id: 7,
      walletPublicKey: `0x${'11'.repeat(20)}`,
      username: 'maker',
      profilePictureUrl: null,
      achievements: [],
      verified: false,
      isOg: false,
      cpPoints: 0,
      tier: 'Spectator',
    },
    // Left out until the market resolves, as the backend does.
    ...(id === RESOLVED_MARKET_ID
      ? {
          winningOutcomeId: id * 10 + 1,
          winningOutcome: outcomeFixture(id, id * 10 + 1, 1),
        }
      : {}),
    outcomes: [
      outcomeFixture(id, id * 10, 0),
      outcomeFixture(id, id * 10 + 1, 1),
    ],
    reviewStatus: null,
  };
}

/**
 * The detail routes (and the event and series market lists) add the collateral token, the
 * fee config, the conviction seed of CLOB markets and the root event slug.
 */
function marketDetail(id: number): Record<string, unknown> {
  const type = TYPES[id - 1] ?? 2;
  const clob = type !== 0 && type !== 1;
  return {
    ...marketFixture(id),
    collateralTokenId: 1,
    collateralToken: tokenFixture(),
    effectiveFeeConfig: feeConfigFixture(id),
    ...(clob
      ? {
          convictionSeed: {
            conditionId: conditionIdOf(id),
            creator: null,
            commitment: null,
          },
        }
      : {}),
    rootEventSlug: type === 4 ? EVENT_SLUG : null,
  };
}

export function activityFixture(
  id: number,
  market: boolean,
): Record<string, unknown> {
  return {
    id,
    activityType: 'USER_TRADE',
    positionType: id % 2 === 0 ? 'SELL' : 'BUY',
    collateralAmount: '1000000',
    initialCollateral: '995000',
    shareAmount: '1750000',
    volumeInUSD: '1.00',
    priceAtExecution: '570000',
    transactionHash: `0x${'ee'.repeat(32)}`,
    cpEarned: '3.50',
    lifetimeEarnedCp: '250.00',
    avgEntryValue: 100,
    avgCurrentValue: 120.5,
    avgPnl: 20.5,
    avgPnlPercentage: 20.5,
    avgEntryPrice: '500000',
    executedAt: TS,
    createdAt: TS,
    user: {
      id: 21,
      username: 'trader',
      roosterColor: '#5588CC',
      profilePictureUrl: null,
      achievements: [],
      verified: false,
      isOg: false,
      cpPoints: 5000,
      tier: 'Believer',
    },
    outcome: {
      id: 10,
      title: 'YES',
      index: 0,
      currentPrice: '570000',
      volumeTradedInUSD: '12.00',
    },
    market: market
      ? {
          id: 1,
          contractMarketId: conditionIdOf(1),
          title: 'Will thing 1 happen?',
          slug: slugOf(1),
          eventId: null,
          eventSlug: null,
          imageUrl: 'https://cdn.example/m.png',
          status: 'ACTIVE',
          expiresAt: '2026-12-01T00:00:00.000Z',
          creatorBps: 100,
          totalVolumeInUSD: '1500.00',
          cpEnabled: true,
          collateralToken: {
            id: 1,
            tokenAddress: `0x${'0f'.repeat(20)}`,
            decimals: 6,
            symbol: 'USDC',
            logoUrl: 'https://cdn.example/usdc.png',
          },
        }
      : null,
    userPositions: [],
    creatorFee: { creatorFeeBps: 100, creatorFeePercentage: 1 },
    tradingFee: {
      feeAmount: '5000',
      feeInUSD: '0.0050',
      isTaker: true,
      netCollateralAmount: '1005000',
    },
    netFeeUSD: '-0.0050',
  };
}

// The backend documents icon, banner and background, but `hero` rows have been seen too (live
// check), so the fixture carries one.
const EVENT_MEDIA = [
  {
    id: 'a0000000-0000-4000-8000-000000000001',
    role: 'banner',
    url: 'https://cdn.example/banner.png',
    alt: 'hero',
    sortOrder: 0,
    metadata: {},
  },
  {
    id: 'a0000000-0000-4000-8000-000000000002',
    role: 'hero',
    url: 'https://cdn.example/hero.jpg',
    alt: null,
    sortOrder: 1,
    metadata: {},
  },
];

// The backend leaves `media` out when there is none (live check), so a fixture
// without media has no `media` key. Event trees always have the key (possibly empty).
function eventBase(
  id: string,
  slug: string,
  parent: string | null,
  media = true,
): Record<string, unknown> {
  return {
    id,
    seriesId: SERIES_ID,
    categoryId: 1,
    category: { id: 1, name: 'Sports', description: null, isActive: true },
    parentEventId: parent,
    slug,
    title: slug.replaceAll('-', ' '),
    subtitle: null,
    description: null,
    metadata: { kickoffAt: '2026-11-20T18:00:00Z' },
    sortOrder: 0,
    createdAt: TS,
    updatedAt: TS,
    priorityScore: 0,
    type: null,
    graduatedAt: null,
    creatorId: null,
    creator: null,
    ...(media ? { media: EVENT_MEDIA } : {}),
  };
}

function placement(marketId: number, eventId: string): Record<string, unknown> {
  return {
    liquidityRewards: {
      currency: 'USDC',
      eligible: true,
      dailyPool: '1000',
      maxDistanceCents: '3',
      minOrderRestMs: 2500,
      minOrderRestSeconds: 3,
      minOrderSizeShares: 5,
      minPayout: '1.00',
      maxAvgPrice: '0.98',
    },
    eventId,
    eventSortOrder: 0,
    groupTitle: 'Argentina',
    market: marketDetail(marketId),
  };
}

export function seriesFixture(): Record<string, unknown> {
  return {
    id: SERIES_ID,
    categoryId: 1,
    category: { id: 1, name: 'Sports', description: null, isActive: true },
    slug: SERIES_SLUG,
    title: 'World Cup 2026',
    subtitle: null,
    description: null,
    active: true,
    sortOrder: 0,
    createdAt: TS,
    updatedAt: TS,
  };
}

function subEventFixture(): Record<string, unknown> {
  return {
    ...eventBase(SUB_EVENT_ID, 'first-half-winner', EVENT_ID, false),
    cpEnabled: true,
    markets: [placement(2, SUB_EVENT_ID)],
  };
}

/** A root event with its media, one direct market and one sub-event (`GET /events/:id`). */
export function eventTreeFixture(): Record<string, unknown> {
  return {
    ...eventBase(EVENT_ID, EVENT_SLUG, null),
    media: EVENT_MEDIA,
    cpEnabled: true,
    markets: [placement(1, EVENT_ID)],
    subEvents: [subEventFixture()],
  };
}

/** A row of the event list: counts, no markets. */
export function eventListItem(
  id: string,
  slug: string,
): Record<string, unknown> {
  return {
    // Only the first event has media.
    ...eventBase(id, slug, null, id === EVENT_ID),
    subEventCount: id === EVENT_ID ? 1 : 0,
    marketCount: 2,
    directMarketCount: 1,
  };
}

const EVENT_ROWS: Array<[string, string]> = [
  [EVENT_ID, EVENT_SLUG],
  [OTHER_EVENT_ID, 'brazil-vs-spain'],
  ['d2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f6a', 'england-vs-germany'],
];
export const EVENT_COUNT = EVENT_ROWS.length;

// An AMM pulse market has a marketAddress and TWAPs; a CLOB pulse market has a null
// marketAddress, a conditionId and opening and closing prices (live check).
function pulseMarketFixture(id: number): Record<string, unknown> {
  const amm = id <= 2;
  return {
    id,
    marketConfigId: 3,
    adapterConfigId: 4,
    marketConfigName: amm ? 'BTC 1h' : 'BTC 5 min',
    marketAddress: amm ? (id === 1 ? PULSE_ADDRESS : PULSE_ADDRESS_2) : null,
    conditionId: amm ? null : conditionIdOf(id),
    status: 'active',
    cycleNumber: 12,
    startsAt: TS,
    expiresAt: '2026-10-01T13:00:00.000Z',
    observationStartsAt: TS,
    observationEndsAt: '2026-10-01T12:55:00.000Z',
    resolvedAt: null,
    closedAt: null,
    openingTwap: amm ? '64250.5' : null,
    closingTwap: null,
    openingPrice: amm ? null : '81918.80912067',
    closingPrice: null,
    winningOutcome: null,
    sampleCount: 17,
    resolutionData: null,
    marketMetadata: { symbol: 'BTC' },
    createdAt: TS,
    updatedAt: TS,
  };
}
export const PULSE_COUNT = 5;
/** The condition id of a CLOB pulse market (ids 3 to 5). */
export const pulseConditionIdOf = (id: number): string => conditionIdOf(id);

/** The pulse market a lowercase address or condition id names, or undefined. */
function pulseIdOf(key: string): number | undefined {
  if (key === PULSE_ADDRESS.toLowerCase()) return 1;
  if (key === PULSE_ADDRESS_2.toLowerCase()) return 2;
  return [3, 4, 5].find((id) => conditionIdOf(id) === key);
}

const CATEGORIES = [
  { id: 1, name: 'Sports' },
  { id: 2, name: 'Politics' },
  { id: 3, name: 'Finance' },
];

function categoryFixture(
  row: { id: number; name: string },
  overview: boolean,
): Record<string, unknown> {
  return {
    id: row.id,
    createdAt: TS,
    updatedAt: TS,
    name: row.name,
    description: null,
    isActive: true,
    ...(overview ? { marketsCount: 10 - row.id } : {}),
  };
}

const SUBCATEGORIES = [1, 2, 3, 4, 5].map((id) => ({
  id,
  createdAt: TS,
  updatedAt: TS,
  name: `Sub ${id}`,
  slug: `sub-${id}`,
  description: null,
  isActive: true,
  categoryId: id <= 3 ? 1 : 2,
  parentSubcategoryId: null,
  depth: 1,
  marketsCount: id,
}));
export const SUBCATEGORY_COUNT = SUBCATEGORIES.length;

// ---------------------------------------------------------------------------
// The query keys each route takes (any other is a 400)
// ---------------------------------------------------------------------------

const GLOBAL_KEYS = ['page', 'take', 'search', 'sortBy', 'sortOrder'];

/** The backend's market filter. `skip` is derived from `page`, not a key the route takes. */
const MARKET_FILTER_KEYS = [
  ...GLOBAL_KEYS,
  'marketScope',
  'marketType',
  'unplacedOnly',
  'graduated',
  'categories',
  'categoryId',
  'subcategoryId',
  'subcategoryUnassigned',
  'tagValue',
  'tagKey',
  'statuses',
  'excludedStatuses',
  'creatorId',
  'expiresAfter',
  'expiresBefore',
  'minVolume',
  'maxVolume',
  'volumeInToken',
  'collateralTokenIds',
  'isResolved',
  'creatorType',
  'isFeatureMarket',
  'includeAMM',
  'contractMarketIds',
];
const MARKET_ACTIVITY_KEYS = [
  ...GLOBAL_KEYS,
  'positionType',
  'userId',
  'outcomeId',
  'outcomeIndex',
  'userTradesOnly',
];
const ALL_ACTIVITY_KEYS = [
  ...GLOBAL_KEYS,
  'marketType',
  'marketScope',
  'positionType',
  'marketId',
];
const EVENTS_KEYS = [
  ...GLOBAL_KEYS,
  'metadataKey',
  'metadataAfter',
  'metadataBefore',
  'hasSubEvents',
  'seriesId',
  'rootsOnly',
  'categoryId',
  'withMarkets',
  'statuses',
  'excludedStatuses',
  'marketType',
];
const SCOPED_KEYS = [
  ...GLOBAL_KEYS,
  'includeSubEvents',
  'statuses',
  'excludedStatuses',
];
const PULSE_KEYS = [
  'page',
  'limit',
  'status',
  'marketConfigId',
  'adapterConfigId',
  'sortBy',
  'sortOrder',
];
const CATEGORY_KEYS = [
  'sortBy',
  'sort',
  'marketType',
  'marketScope',
  'status',
  'countScope',
];
/** The subcategory list leaves out sortOrder, sortBy and search of the list filter, and adds its own. */
const SUBCATEGORY_KEYS = [
  'page',
  'take',
  'search',
  'categoryId',
  'status',
  'sortBy',
  'sort',
  'marketType',
  'marketScope',
  'countScope',
];

const SCOPE_TYPES: Record<string, number[] | undefined> = {
  default: [0, 2],
  withClob: [0, 2, 3],
  withPulse: undefined,
  onlyPulse: [1],
  onlyClobPulse: [3],
  onlyClob: [2, 3],
  onlyConviction: [4],
};

export interface DataRequest {
  method: string;
  /** The pathname, without the query. */
  path: string;
  /** The raw query string, with the `?` or empty. */
  search: string;
  query: Record<string, string>;
  /** The Authorization header, or null when none was sent. */
  authorization: string | null;
  /** The X-XO-SDK header, or null. */
  sdk: string | null;
}

export interface BackendData {
  /** Every request that reached a handler, oldest first. */
  requests: DataRequest[];
  /** Answers instead of the normal handling when it returns a response. */
  override?: (request: DataRequest) => Response | undefined;
  /** The trading status the indexer holds. */
  tradingStatus: string;
  /** Extra fields to put on every market, to test strict and lenient parsing. */
  marketExtras: Record<string, unknown>;
  /** The `xo_sk` keys the `shared` route accepts. */
  validKeys: Set<string>;
}

export interface BackendDataOptions {
  validKeys?: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function badRequest(path: string, message: string | string[]): Response {
  return exceptionResponse(path, 400, {
    error: 'Bad Request',
    message: Array.isArray(message) ? message : [message],
  });
}

export function notFound(path: string, message: string): Response {
  return exceptionResponse(path, 404, { error: 'Not Found', message });
}

/** The backend's validation 400, or undefined when the query is fine. */
export function queryProblem(
  path: string,
  query: Record<string, string>,
  allowed: string[],
  limits: { takeMax?: number } = {},
): Response | undefined {
  const problems: string[] = [];
  for (const key of Object.keys(query)) {
    if (!allowed.includes(key)) {
      problems.push(`property ${key} should not exist`);
    }
  }
  const page = query.page;
  if (page !== undefined) {
    const n = Number(page);
    if (!Number.isInteger(n) || n < 1)
      problems.push('page must not be less than 1');
    else if (n > 10_000 && allowed.includes('take'))
      problems.push('page must not be greater than 10000');
  }
  const take = query.take;
  if (take !== undefined) {
    const n = Number(take);
    if (!Number.isInteger(n) || n < 1)
      problems.push('take must not be less than 1');
    else if (limits.takeMax !== undefined && n > limits.takeMax) {
      problems.push(`take must not be greater than ${limits.takeMax}`);
    }
  }
  const sortOrder = query.sortOrder;
  if (sortOrder !== undefined && sortOrder !== 'ASC' && sortOrder !== 'DESC') {
    problems.push('sortOrder must be one of the following values: ASC, DESC');
  }
  return problems.length === 0 ? undefined : badRequest(path, problems);
}

export function pageMeta(page: number, take: number, itemCount: number) {
  const pageCount = Math.ceil(itemCount / take);
  return {
    page,
    take,
    itemCount,
    pageCount,
    hasPreviousPage: page > 1,
    hasNextPage: page < pageCount,
  };
}

export function slice<T>(rows: T[], page: number, take: number): T[] {
  return rows.slice((page - 1) * take, page * take);
}

function paged<T>(
  rows: T[],
  query: Record<string, string>,
  defaults: { take: number; clamp?: number },
): { data: T[]; meta: ReturnType<typeof pageMeta> } {
  const page = Number(query.page ?? 1);
  const requested = Number(query.take ?? defaults.take);
  const take =
    defaults.clamp === undefined
      ? requested
      : Math.min(requested, defaults.clamp);
  return {
    data: slice(rows, page, take),
    meta: pageMeta(page, take, rows.length),
  };
}

function marketsForScope(
  query: Record<string, string>,
  list: boolean,
): number[] {
  const explicit = query.marketType
    ?.split(',')
    .map(Number)
    .filter((n) => Number.isFinite(n));
  let types: number[] | undefined;
  if (explicit !== undefined && explicit.length > 0) {
    types = explicit;
  } else {
    const scope = query.marketScope ?? 'default';
    types = SCOPE_TYPES[scope];
    // applyMarketsListFilter: GET /markets leaves the CLOB type out of the default scope.
    if (list && scope === 'default') {
      types = types?.filter((type) => type !== 2);
    }
  }
  return TYPES.flatMap((type, index) =>
    types === undefined || types.includes(type) ? [index + 1] : [],
  );
}

/** What a handler of the fake gets: the recorded request and the route's path params. */
export interface RouteArgs {
  request: DataRequest;
  params: Record<string, string>;
}

/**
 * The request log and the handler wrapper every route of the fakes goes through: it records
 * the request on `backend.requests`, lets `backend.override` answer instead, and turns a
 * returned object into a JSON response. The account routes (`mockAccountData.ts`) use it too,
 * so one log holds every request of a test.
 */
export function routing(backend: BackendData) {
  const record = (request: Request): DataRequest => {
    const url = new URL(request.url);
    const entry: DataRequest = {
      method: request.method,
      path: url.pathname,
      search: url.search,
      query: Object.fromEntries(url.searchParams),
      authorization: request.headers.get('authorization'),
      sdk: request.headers.get('x-xo-sdk'),
    };
    backend.requests.push(entry);
    return entry;
  };

  /** Wraps a handler: records the request, applies `override`, and gives it the parts. */
  const route =
    (
      handler: (r: RouteArgs) => Response | Record<string, unknown> | unknown[],
    ) =>
    ({
      request,
      params,
    }: {
      request: Request;
      params: Record<string, unknown>;
    }) => {
      const entry = record(request);
      const forced = backend.override?.(entry);
      if (forced !== undefined) {
        return forced;
      }
      const flat = Object.fromEntries(
        Object.entries(params).map(([key, value]) => [key, String(value)]),
      );
      const result = handler({ request: entry, params: flat });
      return result instanceof Response
        ? result
        : HttpResponse.json(result as never);
    };

  return { record, route };
}

/**
 * Installs the handlers on `server` and returns the live state of the fake backend. Call it
 * in a test, after `server.listen()`; `server.resetHandlers()` removes the handlers.
 */
export function installBackendData(
  server: SetupServer,
  options: BackendDataOptions = {},
): BackendData {
  const backend: BackendData = {
    requests: [],
    tradingStatus: 'active',
    marketExtras: {},
    validKeys: new Set(options.validKeys ?? []),
  };

  const { route } = routing(backend);

  const withExtras = (market: Record<string, unknown>) => ({
    ...market,
    ...backend.marketExtras,
  });

  // The order matters where one route is a prefix pattern of another, as in the backend's router.
  server.use(
    http.get(
      `${BASE}/markets/fee-config/effective`,
      route(({ request }) => {
        const problem = queryProblem(request.path, request.query, ['marketId']);
        if (problem) return problem;
        const marketId = request.query.marketId?.trim();
        if (!marketId)
          return badRequest(
            request.path,
            'marketId query parameter is required',
          );
        const id = CLOB_MARKET_IDS.find(
          (n) => conditionIdOf(n) === marketId.toLowerCase(),
        );
        if (id === undefined)
          return badRequest(
            request.path,
            `Market not found for id ${marketId}`,
          );
        return {
          data: feeConfigFixture(id) as never,
        };
      }),
    ),

    http.get(
      `${BASE}/markets/clob/trading-status`,
      route(({ request }) => {
        // The backend's key check: a session or an xo_sk key.
        const match = /^Bearer (.+)$/.exec(request.authorization ?? '');
        if (match?.[1] === undefined || !backend.validKeys.has(match[1])) {
          return exceptionResponse(request.path, 401, {
            error: 'invalid_credentials',
            message: 'Invalid credentials',
          });
        }
        return { data: { status: backend.tradingStatus } };
      }),
    ),

    http.get(
      `${BASE}/markets/pulse/stats`,
      route(({ request }) => {
        // Bare @Query('marketId') and @Query('marketScope'): no whitelist, no validation.
        void request;
        return {
          totalVolume: '1234567.89',
          totalTrades: 847,
          uniqueTraders: 12481,
          totalMarkets: 42,
          currentPositionsValue: '234567.89',
          initialCollateral: '50000.00',
        };
      }),
    ),

    http.get(
      `${BASE}/markets/browse`,
      route(({ request }) => {
        const problem = queryProblem(
          request.path,
          request.query,
          MARKET_FILTER_KEYS,
          { takeMax: 50 },
        );
        if (problem) return problem;
        const ids = marketsForScope(request.query, false);
        // One event card (the conviction market) and a standalone card per other market.
        const items = ids.map((id) =>
          TYPES[id - 1] === 4
            ? {
                kind: 'event',
                event: {
                  id: EVENT_ID,
                  parentEventId: null,
                  seriesId: SERIES_ID,
                  slug: EVENT_SLUG,
                  title: 'Argentina vs France',
                  subtitle: null,
                  metadata: {},
                  parentTitle: null,
                  parentSlug: null,
                  eventMedia: EVENT_MEDIA,
                  graduatedAt: null,
                  type: 4,
                },
                markets: [
                  {
                    groupTitle: null,
                    eventSortOrder: 0,
                    market: withExtras(marketFixture(id)),
                    liquidityRewards: null,
                  },
                ],
                marketCount: 1,
                totalVolumeInUSD: '1500.00',
                totalNotionalInUSD: '2500.00',
                expiresAt: '2026-12-01T00:00:00.000Z',
                cpEnabled: true,
              }
            : {
                kind: 'market',
                market: withExtras(marketFixture(id)),
                liquidityRewards: null,
              },
        );
        return paged(items, request.query, { take: 10 });
      }),
    ),

    http.get(
      `${BASE}/markets/activities`,
      route(({ request }) => {
        const problem = queryProblem(
          request.path,
          request.query,
          ALL_ACTIVITY_KEYS,
        );
        if (problem) return problem;
        const rows = marketsForScope(request.query, false).map((id) =>
          activityFixture(id, true),
        );
        return paged(rows, request.query, { take: 10, clamp: 50 });
      }),
    ),

    http.get(
      `${BASE}/markets/slug/:slug`,
      route(({ request, params }) => {
        const id = [...Array(MARKET_COUNT).keys()]
          .map((n) => n + 1)
          .find((n) => slugOf(n) === decodeURIComponent(params.slug ?? ''));
        if (id === undefined) {
          return notFound(
            request.path,
            `Market with slug ${params.slug} not found`,
          );
        }
        return withExtras(marketDetail(id));
      }),
    ),

    http.get(
      `${BASE}/markets/contract/:key`,
      route(({ request, params }) => {
        const key = params.key ?? '';
        if (!/^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(key)) {
          return badRequest(request.path, `Invalid market key: ${key}`);
        }
        const id = [...Array(MARKET_COUNT).keys()]
          .map((n) => n + 1)
          .find((n) => {
            const fixture = marketFixture(n);
            return (
              String(fixture.contractMarketId).toLowerCase() ===
              key.toLowerCase()
            );
          });
        if (id === undefined) {
          return notFound(
            request.path,
            `Market with contract id ${key} not found`,
          );
        }
        // The detail shape: the list shape plus the fee config.
        return withExtras({
          ...marketFixture(id),
          effectiveFeeConfig: feeConfigFixture(id),
        });
      }),
    ),

    http.get(
      `${BASE}/markets/:id/price-history`,
      route(({ request, params }) => {
        const id = Number(params.id);
        if (!Number.isInteger(id)) {
          return badRequest(
            request.path,
            'Validation failed (numeric string is expected)',
          );
        }
        if (id < 1 || id > MARKET_COUNT) {
          return notFound(request.path, `Market with ID ${id} not found`);
        }
        return [
          {
            timestamp: '2026-10-01T10:00:00.000Z',
            outcomes: [
              { outcomeId: id * 10, outcomeTitle: 'YES', price: '0.55' },
              { outcomeId: id * 10 + 1, outcomeTitle: 'NO', price: '0.45' },
            ],
          },
          {
            timestamp: '2026-10-01T11:00:00.000Z',
            outcomes: [
              { outcomeId: id * 10, outcomeTitle: 'YES', price: 0.57 },
              { outcomeId: id * 10 + 1, outcomeTitle: 'NO', price: 0.43 },
            ],
          },
        ];
      }),
    ),

    http.get(
      `${BASE}/markets/:id/statuses`,
      route(({ request, params }) => {
        const id = Number(params.id);
        if (!Number.isInteger(id)) {
          return badRequest(
            request.path,
            'Validation failed (numeric string is expected)',
          );
        }
        if (id < 1 || id > MARKET_COUNT) {
          return notFound(request.path, `Market with ID ${id} not found`);
        }
        return {
          marketId: id,
          contractMarketId: String(marketFixture(id).contractMarketId),
          title: `Will thing ${id} happen?`,
          status: 'ACTIVE',
          timestamps: {
            PENDING: TS,
            ACTIVE: TS,
            PAUSED: null,
            CLOSED: null,
            CANCELLED: null,
            RESOLVED: null,
            EXPIRED: '2026-12-01T00:00:00.000Z',
          },
        };
      }),
    ),

    http.get(
      `${BASE}/markets/:id/activity`,
      route(({ request, params }) => {
        const id = Number(params.id);
        if (!Number.isInteger(id)) {
          return badRequest(
            request.path,
            'Validation failed (numeric string is expected)',
          );
        }
        const problem = queryProblem(
          request.path,
          request.query,
          MARKET_ACTIVITY_KEYS,
        );
        if (problem) return problem;
        if (request.query.userTradesOnly === 'true') {
          // No Privy user on a public call.
          return exceptionResponse(request.path, 401, {
            error: 'Unauthorized',
            message: 'Authentication required for userTradesOnly filter',
          });
        }
        if (id < 1 || id > MARKET_COUNT) {
          return notFound(request.path, `Market with ID ${id} not found`);
        }
        // The rows of this route leave `market` out of the stub, as the use case does.
        const rows = Array.from({ length: 7 }, (_, index) =>
          activityFixture(index + 1, false),
        );
        return paged(rows, request.query, { take: 10, clamp: 50 });
      }),
    ),

    http.get(
      `${BASE}/markets/:id`,
      route(({ request, params }) => {
        const id = Number(params.id);
        if (!Number.isInteger(id)) {
          return badRequest(
            request.path,
            'Validation failed (numeric string is expected)',
          );
        }
        if (id < 1 || id > MARKET_COUNT) {
          return notFound(request.path, `Market with ID ${id} not found`);
        }
        return withExtras(marketDetail(id));
      }),
    ),

    http.get(
      `${BASE}/markets`,
      route(({ request }) => {
        const problem = queryProblem(
          request.path,
          request.query,
          MARKET_FILTER_KEYS,
          { takeMax: 50 },
        );
        if (problem) return problem;
        const rows = marketsForScope(request.query, true).map((id) =>
          withExtras(marketFixture(id)),
        );
        return paged(rows, request.query, { take: 10 });
      }),
    ),

    // Events
    http.get(
      `${BASE}/v1/events/slug/:slug`,
      route(({ request, params }) => {
        if (decodeURIComponent(params.slug ?? '') !== EVENT_SLUG) {
          return notFound(request.path, 'Event not found');
        }
        return { data: eventTreeFixture() };
      }),
    ),

    http.get(
      `${BASE}/v1/events/:eventId/subevents`,
      route(({ request, params }) => {
        if (!UUID.test(params.eventId ?? '')) {
          return badRequest(
            request.path,
            'Validation failed (uuid is expected)',
          );
        }
        if (params.eventId !== EVENT_ID) {
          return notFound(request.path, 'Event not found');
        }
        const {
          markets: _markets,
          cpEnabled: _cp,
          ...summary
        } = subEventFixture();
        return { data: [{ ...summary, marketCount: 1 }] };
      }),
    ),

    http.get(
      `${BASE}/v1/events/:eventId/markets`,
      route(({ request, params }) => {
        if (!UUID.test(params.eventId ?? '')) {
          return badRequest(
            request.path,
            'Validation failed (uuid is expected)',
          );
        }
        const problem = queryProblem(request.path, request.query, SCOPED_KEYS, {
          takeMax: 1000,
        });
        if (problem) return problem;
        if (params.eventId !== EVENT_ID) {
          return notFound(request.path, 'Event not found');
        }
        return paged(scopedRows(), request.query, { take: 10 });
      }),
    ),

    http.get(
      `${BASE}/v1/events/:eventId`,
      route(({ request, params }) => {
        if (!UUID.test(params.eventId ?? '')) {
          return badRequest(
            request.path,
            'Validation failed (uuid is expected)',
          );
        }
        if (params.eventId !== EVENT_ID) {
          return notFound(request.path, 'Event not found');
        }
        return { data: eventTreeFixture() };
      }),
    ),

    http.get(
      `${BASE}/v1/events`,
      route(({ request }) => {
        const problem = queryProblem(request.path, request.query, EVENTS_KEYS, {
          takeMax: 1000,
        });
        if (problem) return problem;
        const rows = EVENT_ROWS.map(([id, slug]) => eventListItem(id, slug));
        return paged(rows, request.query, { take: 10 });
      }),
    ),

    // Series
    http.get(
      `${BASE}/v1/series/slug/:slug`,
      route(({ request, params }) => {
        if (decodeURIComponent(params.slug ?? '') !== SERIES_SLUG) {
          return notFound(request.path, 'Series not found');
        }
        return { data: seriesFixture() };
      }),
    ),

    http.get(
      `${BASE}/v1/series/:seriesId/markets`,
      route(({ request, params }) => {
        if (!UUID.test(params.seriesId ?? '')) {
          return badRequest(
            request.path,
            'Validation failed (uuid is expected)',
          );
        }
        const problem = queryProblem(request.path, request.query, SCOPED_KEYS, {
          takeMax: 1000,
        });
        if (problem) return problem;
        if (params.seriesId !== SERIES_ID) {
          return notFound(request.path, 'Series not found');
        }
        return paged(scopedRows(), request.query, { take: 10 });
      }),
    ),

    http.get(
      `${BASE}/v1/series/:seriesId`,
      route(({ request, params }) => {
        if (!UUID.test(params.seriesId ?? '')) {
          return badRequest(
            request.path,
            'Validation failed (uuid is expected)',
          );
        }
        if (params.seriesId !== SERIES_ID) {
          return notFound(request.path, 'Series not found');
        }
        return { data: seriesFixture() };
      }),
    ),

    http.get(
      `${BASE}/v1/series`,
      route(({ request }) => {
        // The series filter takes the list filter's keys and adds `active`.
        const problem = queryProblem(
          request.path,
          request.query,
          [...GLOBAL_KEYS, 'active'],
          { takeMax: 1000 },
        );
        if (problem) return problem;
        const active = request.query.active !== 'false';
        return { data: active ? [seriesFixture()] : [] };
      }),
    ),

    // Pulse markets (proxied from perpetual-markets: no guard, no auth)
    http.get(
      `${BASE}/pulse/markets/batch`,
      route(({ request }) => {
        const wanted = (request.query.addresses ?? '')
          .split(',')
          .map((address) => address.trim().toLowerCase())
          .filter(Boolean);
        // The backend answers the values of a map keyed by what was asked: a market keyed by both
        // its address and its condition id comes out twice.
        return wanted.flatMap((key, index) => {
          const id = pulseIdOf(key);
          if (id === undefined) return [];
          const row = pulseMarketFixture(id);
          return index === 0 && id === 1 ? [row, row] : [row];
        });
      }),
    ),

    http.get(
      `${BASE}/pulse/markets/:address`,
      route(({ request, params }) => {
        const id = pulseIdOf((params.address ?? '').toLowerCase());
        if (id === undefined) {
          return notFound(request.path, 'Market not found');
        }
        return pulseMarketFixture(id);
      }),
    ),

    http.get(
      `${BASE}/pulse/markets`,
      route(({ request }) => {
        const problem = queryProblem(request.path, request.query, PULSE_KEYS);
        if (problem) return problem;
        const page = Number(request.query.page ?? 1);
        const limit = Number(request.query.limit ?? 10);
        const rows = Array.from({ length: PULSE_COUNT }, (_, index) =>
          pulseMarketFixture(index + 1),
        );
        const totalPages = Math.ceil(rows.length / limit);
        return {
          data: slice(rows, page, limit),
          meta: {
            page,
            limit,
            total: rows.length,
            totalPages,
            hasNextPage: page < totalPages,
            hasPreviousPage: page > 1,
          },
        };
      }),
    ),

    // Taxonomy
    http.get(
      `${BASE}/categories`,
      route(({ request }) => {
        const problem = queryProblem(
          request.path,
          request.query,
          CATEGORY_KEYS,
        );
        if (problem) return problem;
        const overview = [
          'sortBy',
          'marketType',
          'marketScope',
          'countScope',
        ].some((key) => request.query[key] !== undefined);
        if (request.query.status === 'inactive') return [];
        return CATEGORIES.map((row) => categoryFixture(row, overview));
      }),
    ),

    http.get(
      `${BASE}/subcategories`,
      route(({ request }) => {
        const problem = queryProblem(
          request.path,
          request.query,
          SUBCATEGORY_KEYS,
          { takeMax: 1000 },
        );
        if (problem) return problem;
        // sortOrder, sortBy (except marketsCount) and `search` of the list filter are left out:
        // `search` is re-added, sortOrder is not accepted.
        const overview = [
          'sortBy',
          'marketType',
          'marketScope',
          'countScope',
        ].some((key) => request.query[key] !== undefined);
        const categoryId = request.query.categoryId;
        const rows = SUBCATEGORIES.filter(
          (row) =>
            categoryId === undefined || row.categoryId === Number(categoryId),
        );
        if (overview) {
          return [...rows].sort((a, b) =>
            request.query.sort === 'asc'
              ? a.marketsCount - b.marketsCount
              : b.marketsCount - a.marketsCount,
          );
        }
        const page = Number(request.query.page ?? 1);
        const limit = Number(request.query.take ?? 20);
        const totalPages = Math.ceil(rows.length / limit);
        return {
          items: slice(rows, page, limit),
          total: rows.length,
          page,
          limit,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
        };
      }),
    ),

    http.get(
      `${BASE}/tokens`,
      route(() => [
        { ...tokenFixture(), description: null, priceTrackingEnabled: true },
      ]),
    ),
  );

  function scopedRows(): Array<Record<string, unknown>> {
    return [1, 2, 3].map((id) => ({
      eventId: id === 2 ? SUB_EVENT_ID : EVENT_ID,
      parentEventId: id === 2 ? EVENT_ID : null,
      eventTitle: 'Argentina vs France',
      eventSlug: EVENT_SLUG,
      eventMedia: EVENT_MEDIA,
      subEventId: id === 2 ? SUB_EVENT_ID : null,
      subEventTitle: id === 2 ? 'First half winner' : null,
      subEventSlug: id === 2 ? 'first-half-winner' : null,
      eventSortOrder: 0,
      rootEventSortOrder: 0,
      groupTitle: null,
      market: withExtras(marketDetail(id)),
      liquidityRewards: null,
    }));
  }

  return backend;
}
