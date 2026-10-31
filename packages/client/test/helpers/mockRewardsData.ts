import { http } from 'msw';
import type { SetupServer } from 'msw/node';
import { OWNER } from './mockAccountData';
import { exceptionResponse } from './mockBackend';
import {
  BASE,
  type BackendData,
  badRequest,
  conditionIdOf,
  notFound,
  pageMeta,
  type RouteArgs,
  routing,
} from './mockBackendData';

// A fake of the backend's liquidity-rewards routes, for the msw tests of the DataClient.
// Like the other fakes it is written from the backend's behaviour, and its payloads from live
// responses (trimmed, with a made-up profile):
//
// - access, as the backend's route index has it today: `/api/public/liquidity-
//   rewards/*` has no guard (public); `/api/liquidity-rewards/*` is `shared` (an `xo_sk`
//   key or a Privy session). A public route ignores any credential; the fake records
//   the Authorization header of every request so a test can assert that none was sent.
// - the market id of a path is a CLOB condition id, matched exactly (the backend answers 404
//   for the same id in upper case, and for a numeric backend id); the epoch must be an integer on
//   the public routes and an integer from 0 to 10,000,000 on the shared ones, and the rewards
//   service refuses an epoch outside 0..10000000 with a 400.
// - a query key a route does not know is a 400. The public `makers` and `orders` of a market
//   read their query by hand and take any key.
// - paging is 0-based (`page`, `page_size`) except the leaderboard (`page`, `take`, 1-based,
//   with a `PageMeta`).
// - the fields keep the case of their presenter: camelCase for the backend's own presenters
//   (earning pools, wallet summary, user profile, leaderboard) and snake_case for what
//   the rewards service sends through.

/** The root of the public routes (no guard) and of the account's own (shared). */
export const PUBLIC = `${BASE}/public/liquidity-rewards`;
export const MINE = `${BASE}/liquidity-rewards`;

/** A market with both rails, a Pulse window paid by a group, and one that is not enrolled. */
export const REWARD_MARKET = conditionIdOf(1);
export const REWARD_MARKET_2 = conditionIdOf(2);
export const UNENROLLED_MARKET = conditionIdOf(9);
export const REWARD_GROUP = `0x${'b9'.repeat(32)}`;
export const UNKNOWN_GROUP = `0x${'c8'.repeat(32)}`;
/** A maker with scored days, a wallet that has none, and the account of the fake's keys. */
export const MAKER = `0x${'34'.repeat(20)}`;
export const STRANGER = `0x${'12'.repeat(20)}`;
export const OWNER_WALLET = OWNER.wallet.toLowerCase();

export const MS_DAY = 86_400_000;
/** The settled day the fixtures score, and the day in progress. */
export const SCORED_EPOCH = 20_743;
export const TODAY_EPOCH = 20_744;
export const MAKERS_TOTAL = 5;
export const ORDERS_TOTAL = 5;
export const GROUPS_TOTAL = 3;
export const HISTORY_TOTAL = 3;
export const LEADERBOARD_TOTAL = 5;
/** The rank of the account in the leaderboard fixture. */
export const OWNER_RANK = 3;

const dayOpen = (epoch: number) => epoch * MS_DAY;
const dayClose = (epoch: number) => (epoch + 1) * MS_DAY;

const money = (amount: string, currency: 'CP' | 'USDC' = 'CP') => ({
  amount,
  currency,
});

const lowerWallet = (wallet: string) => wallet.toLowerCase();
const walletAt = (n: number) =>
  `0x${n.toString(16).padStart(2, '0').repeat(20)}`;

/** The XO profile the wallet routes attach (made up). */
export function userFixture(): Record<string, unknown> {
  return {
    id: 138,
    username: 'xouser1148',
    name: null,
    profilePictureUrl: 'https://img.example/profile.jpg',
    roosterColor: '#CC8855',
    verified: false,
    achievements: [],
    cpPoints: 19604.9,
    tier: 'Believer',
  };
}

// ---------------------------------------------------------------------------
// Public: earning pools
// ---------------------------------------------------------------------------

function bookFixture(): Record<string, unknown> {
  const book = (outcome: string, bid: number, ask: number) => ({
    asks: [
      { priceTick: ask, sizeMicro: '50000000' },
      { priceTick: ask + 40, sizeMicro: '50000000' },
    ],
    bids: [
      { priceTick: bid, sizeMicro: '287960000' },
      { priceTick: bid - 140, sizeMicro: '41000000' },
    ],
    bestAsk: ask,
    bestBid: bid,
    outcome,
    restingLevels: 4,
    totalMicroShares: '428960000',
  });
  return {
    books: [book('Yes', 500, 520), book('No', 480, 500)],
    isFlush: false,
  };
}

function bonusWindowCamel(
  id: string,
  currency: 'CP' | 'USDC',
  status: 'LIVE' | 'SCHEDULED' | 'ENDED',
): Record<string, unknown> {
  const digits = currency === 'CP' ? 2 : 6;
  const fixed = (n: number) => n.toFixed(digits);
  return {
    windowId: id,
    currency,
    status,
    amount: fixed(50),
    remaining: fixed(status === 'ENDED' ? 0 : 25),
    todayPool: fixed(6.19),
    startsAtMs: 1_792_054_500_000,
    startsAt: '2026-10-15T08:55:00Z',
    endsAtMs: 1_792_313_700_000,
    endsAt: '2026-10-18T08:55:00Z',
    stoppedAtMs: null,
    stoppedAt: null,
    label: status === 'LIVE' ? 'Derby day' : null,
    kind: 'AD_HOC',
    allocationMethod: 'pro_rata',
  };
}

/** One row of `GET /public/liquidity-rewards/earning-pools`. */
export function earningPoolFixture(
  marketId: string,
  o: { group?: boolean } = {},
): Record<string, unknown> {
  return {
    marketId,
    market: {
      title: 'Will AC Milan lose at least 10 matches in 2026/2027 Serie A?',
      contractMarketId: marketId,
      conditionId: marketId,
      status: 'ACTIVE',
      category: 'SPORTS',
      eventId: '5bd30f87-2771-466d-9a24-3e7aec60f1ed',
      eventSlug: 'will-ac-milan-lose-at-least-10-matches-in-20262027-1131',
      rootEventSlug: 'will-ac-milan-lose-at-least-10-matches-in-20262027-1131',
      id: 69_781,
      slug: 'will-ac-milan-lose-at-least-10-matches-in-20262027-7688',
      imageUrl: 'https://img.example/market.webp',
      type: 4,
      expiresAt: '2027-05-30T23:59:59.000Z',
      outcomes: [
        {
          outcomeTokenId:
            '54990793763205657334775137797319518526629942448278863151007938803815934267470',
          index: 0,
          title: 'Yes',
        },
        {
          outcomeTokenId:
            '46926672911953873987746996450150170534393909329219844209288466463792580032935',
          index: 1,
          title: 'No',
        },
      ],
      prices: { yes: '0.51', no: '0.49' },
      bookSnapshot: bookFixture(),
      bookSnapshotUpdatedAt: '2026-10-16T18:42:46.987Z',
    },
    cp: {
      configured: true,
      rewardEnabled: true,
      tierName: 'pulse',
      eligible: true,
      currency: 'CP',
      dailyPool: '200.00',
      budgetTotal: '1000.00',
      maxDistanceCents: '5',
      minOrderRestMs: 500,
      minOrderRestSeconds: 1,
      minOrderSizeShares: 5,
      minPayout: '1.00',
      twoSidedBandLow: '0.499',
      twoSidedBandHigh: '0.501',
      singleSidedFactor: '3',
      maxAvgPrice: '0.98',
      programStartsAtMs: 1_792_131_300_000,
      programStartsAt: '2026-10-16T06:15:00Z',
      programEndsAtMs: 1_792_563_299_999,
      programEndsAt: '2026-10-21T06:14:59Z',
      programStatus: 'LIVE',
      active: true,
      inactiveReason: null,
      baseDailyPool: '200.00',
      budgetRemaining: '1000.00',
      durationDays: 5,
      daysRemaining: 4,
      estimatedApr: null,
      estimatedAprUnavailableReason: 'not_applicable_for_cp',
      currentEpoch: {
        epoch: TODAY_EPOCH,
        dayOpenMs: dayOpen(TODAY_EPOCH),
        dayCloseMs: dayClose(TODAY_EPOCH),
        currency: 'CP',
        pool: '200.00',
        status: 'projected',
        totalScore: '35277817245000.000000',
        makerCount: 1,
        allocatedCp: '68.75',
        creditedCp: null,
      },
    },
    usdc: {
      configured: true,
      eligible: false,
      escrowed: '1004.00',
      distributed: '0.00',
      dailyRate: '1004.000000',
      budgetTotal: '1004.018060',
      estimatedApr: '3664600.00',
      estimatedAprUnavailableReason: null,
      maxDistanceCents: '5',
      minOrderRestMs: 500,
      minOrderRestSeconds: 1,
      minOrderSizeShares: 5,
      minPayout: '0.010000',
      twoSidedBandLow: '0.499',
      twoSidedBandHigh: '0.501',
      singleSidedFactor: '3',
      maxAvgPrice: '0.98',
      programStartsAtMs: 1_792_131_147_000,
      programStartsAt: '2026-10-16T06:12:27Z',
      programEndsAtMs: null,
      programEndsAt: null,
      programStatus: 'ENDED',
      active: false,
      inactiveReason: 'window_elapsed',
      baseDailyPool: '1004.000000',
      budgetRemaining: '1004.000000',
      durationDays: 1,
      daysRemaining: 0,
    },
    group: o.group
      ? {
          groupId: REWARD_GROUP,
          activeFromMs: 1_792_332_600_000,
          activeToMs: 1_792_332_900_000,
        }
      : null,
    activeBonus: o.group
      ? [
          bonusWindowCamel(
            '1427f50e-b91f-4c19-a9f5-7e2b849fbea4',
            'USDC',
            'LIVE',
          ),
        ]
      : [],
    upcomingBonus: [],
    endedBonus: [
      bonusWindowCamel('5ce306d5-a4f0-4b1e-83ec-b07bce8e5274', 'CP', 'ENDED'),
    ],
  };
}

export function earningPoolsFixture(): Record<string, unknown> {
  const data = [
    earningPoolFixture(REWARD_MARKET),
    earningPoolFixture(REWARD_MARKET_2, { group: true }),
  ];
  return {
    data,
    meta: {
      itemCount: data.length,
      currentEpoch: TODAY_EPOCH,
      dayOpenMs: dayOpen(TODAY_EPOCH),
      dayCloseMs: dayClose(TODAY_EPOCH),
      endsInMs: 35_399_843,
    },
  };
}

// ---------------------------------------------------------------------------
// Public: market configuration and detail (the rewards service, snake_case)
// ---------------------------------------------------------------------------

function bonusWindowSnake(
  id: string,
  currency: 'CP' | 'USDC',
  status: 'LIVE' | 'SCHEDULED' | 'ENDED',
): Record<string, unknown> {
  const digits = currency === 'CP' ? 2 : 6;
  const fixed = (n: number) => money(n.toFixed(digits), currency);
  return {
    window_id: id,
    currency,
    status,
    amount: fixed(50),
    remaining: fixed(status === 'ENDED' ? 0 : 25),
    today_pool: fixed(6.19),
    starts_at_ms: 1_792_054_500_000,
    starts_at: '2026-10-15T08:55:00Z',
    ends_at_ms: 1_792_313_700_000,
    ends_at: '2026-10-18T08:55:00Z',
    stopped_at_ms: null,
    stopped_at: null,
    label: null,
    kind: 'AD_HOC',
    allocation_method: 'pro_rata',
  };
}

/** `GET /public/liquidity-rewards/markets/:marketId/config`. */
export function marketConfigFixture(marketId: string): Record<string, unknown> {
  const programme = (currency: 'CP' | 'USDC') => ({
    currency,
    reward_enabled: true,
    active: currency === 'CP',
    inactive_reason: currency === 'CP' ? null : 'window_elapsed',
    daily_pool: currency === 'CP' ? '200' : '1004',
    budget_total: currency === 'CP' ? '1000' : '1004.01806',
    duration_days: currency === 'CP' ? 5 : 1,
    program_starts_at_ms: 1_792_131_300_000,
    program_starts_at: '2026-10-16T06:15:00Z',
    program_ends_at_ms: currency === 'CP' ? 1_792_563_299_999 : null,
    program_ends_at: currency === 'CP' ? '2026-10-21T06:14:59Z' : null,
    status: currency === 'CP' ? 'LIVE' : 'ENDED',
    max_distance_cents: '5',
    single_sided_factor: '3',
    two_sided_band_low: '0.499',
    two_sided_band_high: '0.501',
    max_avg_price: '0.98',
    min_order_rest_ms: 500,
    min_order_rest_seconds: 1,
    min_order_size_shares: 5,
    min_payout: currency === 'CP' ? '1' : '0.01',
  });
  return {
    market_id: marketId,
    group_id: null,
    programmes: [programme('CP'), programme('USDC')],
    active_bonus: [],
    upcoming_bonus: [],
    ended_bonus: [
      bonusWindowSnake('5ce306d5-a4f0-4b1e-83ec-b07bce8e5274', 'CP', 'ENDED'),
      bonusWindowSnake('eef35562-7689-4be5-8088-f009c1812c5d', 'USDC', 'ENDED'),
    ],
  };
}

function railFixture(currency: 'CP' | 'USDC'): Record<string, unknown> {
  const digits = currency === 'CP' ? 2 : 6;
  const amount = (n: number) => money(n.toFixed(digits), currency);
  return {
    reward_enabled: true,
    active: currency === 'CP',
    inactive_reason: currency === 'CP' ? null : 'window_elapsed',
    daily_pool: amount(200),
    base_daily_pool: amount(200),
    budget_total: amount(1000),
    base_budget_total: amount(1000),
    budget_remaining: amount(1000),
    duration_days: 5,
    days_remaining: 4,
    program_starts_at_ms: 1_792_131_300_000,
    program_starts_at: '2026-10-16T06:15:00Z',
    program_ends_at_ms: 1_792_563_299_999,
    program_ends_at: '2026-10-21T06:14:59Z',
    status: currency === 'CP' ? 'LIVE' : 'ENDED',
    terms_set_at_ms: 1_792_131_089_201,
    terms_set_at: '2026-10-16T06:11:29Z',
    estimated_apr: currency === 'CP' ? null : '3664600.00',
    estimated_apr_unavailable_reason:
      currency === 'CP' ? 'not_applicable_for_cp' : null,
    estimated_apr_basis:
      currency === 'CP'
        ? null
        : {
            epoch: TODAY_EPOCH,
            effective_daily_reward: amount(200),
            average_qualifying_liquidity_usd: '10.00',
            liquidity_source: 'default_minimum',
            carried_liquidity_usd: '167.98',
            annualisation_days: 365,
          },
    config: {
      max_distance_cents: '5',
      single_sided_factor: '3',
      two_sided_band_low: '0.499',
      two_sided_band_high: '0.501',
      max_avg_price: '0.98',
      min_order_rest_ms: 500,
      min_order_rest_seconds: 1,
      min_order_size_shares: 5,
      min_payout: money(currency === 'CP' ? '1.00' : '0.010000', currency),
    },
  };
}

function lifetimeFixture(currency: 'CP' | 'USDC'): Record<string, unknown> {
  const digits = currency === 'CP' ? 2 : 6;
  const amount = (n: number) => money(n.toFixed(digits), currency);
  return {
    currency,
    scored_epochs: 6,
    latest_epoch: SCORED_EPOCH,
    total_scored_liquidity: '385300915998620.312037',
    allocated: amount(2149.99),
    distributed: amount(1980.5),
    base_allocated: amount(2049.99),
    bonus_allocated: amount(100),
    bonus_only_epochs: 0,
  };
}

/** `GET /public/liquidity-rewards/markets/:marketId`. */
export function marketDetailFixture(marketId: string): Record<string, unknown> {
  return {
    market_id: marketId,
    active: true,
    usdc: railFixture('USDC'),
    cp: railFixture('CP'),
    current_epoch: TODAY_EPOCH,
    current_epoch_open_ms: dayOpen(TODAY_EPOCH),
    current_epoch_close_ms: dayClose(TODAY_EPOCH),
    current_epoch_ends_in_ms: 35_399_134,
    total_scored_liquidity: '385300915998620.312037',
    lifetime_by_currency: [lifetimeFixture('CP'), lifetimeFixture('USDC')],
    active_bonus: [],
    upcoming_bonus: [],
    ended_bonus: [],
  };
}

// ---------------------------------------------------------------------------
// Public: market-days
// ---------------------------------------------------------------------------

function makerLine(n: number): Record<string, unknown> {
  const scored = n === 0;
  return {
    user_id: n === 0 ? MAKER : walletAt(0x40 + n),
    score: scored ? '35277817245000.000000' : '0.000000',
    score_share: scored ? '1.00000000' : '0.00000000',
    effective_cp: scored ? '68.75' : '0.00',
    allocated_cp: scored ? '68.75' : '0.00',
    credited_cp: scored ? '0.00' : null,
    status: scored ? 'paid' : 'none',
  };
}

/** A line of the USDC board of a market-day: the CP line with the money renamed (6 dp). */
function usdcMakerLine(n: number, projected: boolean): Record<string, unknown> {
  const scored = n === 0;
  return {
    user_id: n === 0 ? MAKER : walletAt(0x40 + n),
    score: scored ? '12345678901234.500000' : '0.000000',
    score_share: scored ? '1.00000000' : '0.00000000',
    effective_usdc: scored ? '200.008826' : '0.000000',
    allocated_usdc: scored ? '200.008826' : '0.000000',
    credited_usdc: scored && !projected ? '200.008826' : null,
    status: scored ? (projected ? 'projected' : 'paid') : 'none',
  };
}

/**
 * `GET .../markets/:marketId/epochs/:epoch`: both rails of the day. The CP rail keeps the
 * bare names and the USDC rail sits beside it under `_usdc` names. `{ usdc: false }` is a
 * response without the USDC rail: no USDC fields, and `omitted_rails` names the rail it
 * leaves out.
 */
export function marketEpochFixture(
  marketId: string,
  epoch: number,
  options: { usdc?: boolean } = {},
): Record<string, unknown> {
  const projected = epoch === TODAY_EPOCH;
  const cp = {
    market_id: marketId,
    epoch,
    day_open_ms: dayOpen(epoch),
    day_close_ms: dayClose(epoch),
    currency: 'CP',
    pool: '200.00',
    status: projected ? 'projected' : 'settled',
    total_score: '35277817245000.000000',
    maker_count: MAKERS_TOTAL,
    allocated_cp: '68.75',
    credited_cp: projected ? '0.00' : '68.75',
    projected,
    projected_through_ms: projected ? 1_792_332_596_709 : null,
  };
  if (options.usdc === false) {
    return {
      ...cp,
      omitted_rails: ['USDC'],
      bonus_only: false,
      top_makers: [makerLine(0), makerLine(1)],
    };
  }
  return {
    ...cp,
    pool_usdc: '500.000000',
    status_usdc: projected ? 'projected' : 'settled',
    total_score_usdc: '12345678901234.500000',
    maker_count_usdc: 2,
    allocated_usdc: '200.008826',
    credited_usdc: projected ? '0.000000' : '200.008826',
    projected_usdc: projected,
    projected_through_ms_usdc: projected ? 1_792_332_596_709 : null,
    bonus_only: false,
    top_makers: [makerLine(0), makerLine(1)],
    top_makers_usdc: [usdcMakerLine(0, projected), usdcMakerLine(1, projected)],
  };
}

export function marketMakersFixture(
  marketId: string,
  epoch: number,
  page: number,
  pageSize: number,
): Record<string, unknown> {
  const all = Array.from({ length: MAKERS_TOTAL }, (_, n) => makerLine(n));
  return {
    market_id: marketId,
    epoch,
    page,
    page_size: pageSize,
    total: MAKERS_TOTAL,
    projected: false,
    projected_through_ms: null,
    omitted_rails: ['USDC'],
    makers: all.slice(page * pageSize, (page + 1) * pageSize),
  };
}

function marketOrderLine(n: number): Record<string, unknown> {
  return {
    order_id: String(101_407_907 + n),
    maker: n < 3 ? MAKER : STRANGER,
    outcome: n % 2 === 0 ? 'Yes' : 'No',
    side: 'Buy',
    price_tick: 890 + n,
    score: '5835224679864.586035',
    maker_score_share: '0.16540776',
    effective_cp: '11.37',
    eligible_ms: 59_400_000,
    first_seen_ms: dayOpen(SCORED_EPOCH),
    last_seen_ms: dayClose(SCORED_EPOCH),
    created_at_ms: 1_789_325_522_000,
    opening_size_micro: '1000000000',
    closing_size_micro: '961219812',
    exit_kind: n === 4 ? 'filled' : null,
  };
}

export function marketOrdersFixture(
  marketId: string,
  epoch: number,
  page: number,
  pageSize: number,
  maker: string | undefined,
): Record<string, unknown> {
  const all = Array.from({ length: ORDERS_TOTAL }, (_, n) =>
    marketOrderLine(n),
  );
  const rows =
    maker === undefined
      ? all
      : all.filter((row) => row.maker === maker.toLowerCase());
  return {
    market_id: marketId,
    epoch,
    maker: maker ?? null,
    page,
    page_size: pageSize,
    total: rows.length,
    truncated_orders: 0,
    attributed_cp: '68.75',
    unattributed_cp: '0.00',
    projected: false,
    projected_through_ms: null,
    omitted_rails: ['USDC'],
    orders: rows.slice(page * pageSize, (page + 1) * pageSize),
  };
}

// ---------------------------------------------------------------------------
// Wallet and account (the same presenters under `/wallets/:w` and `/me`)
// ---------------------------------------------------------------------------

const hasActivity = (wallet: string) =>
  wallet === MAKER || wallet === OWNER_WALLET;

function summaryEpoch(active: boolean): Record<string, unknown> {
  return {
    allocated: '0.00',
    effective: '0.00',
    paid: '0.00',
    estimate: active ? '12.50' : '0.00',
    credited: null,
    projected: active,
    projectedThroughMs: active ? 1_792_332_596_709 : null,
    status: active ? 'projected' : 'none',
    baseAmount: '0.00',
    bonusAmount: '0.00',
  };
}

/** `GET .../wallets/:walletAddress/summary` and `GET /liquidity-rewards/me/summary`. */
export function walletSummaryFixture(wallet: string): Record<string, unknown> {
  const active = hasActivity(wallet);
  return {
    meta: {
      itemCount: 0,
      currentEpoch: TODAY_EPOCH,
      dayOpenMs: dayOpen(TODAY_EPOCH),
      dayCloseMs: dayClose(TODAY_EPOCH),
      endsInMs: 35_035_248,
    },
    flagged: false,
    me: {
      usdc: {
        totalReceived: active ? '378.43' : '0.00',
        makerRebates: { lifetime: active ? '7.80' : '0.00', today: '0.00' },
        liquidityRewards: {
          lifetime: active ? '370.63' : '0.00',
          today: active ? '20.00' : '0.00',
        },
        currentEpoch: summaryEpoch(active),
      },
      cp: {
        totalReceived: active ? '7833.97' : '0.00',
        liquidity: {
          lifetime: active ? '7833.97' : '0.00',
          today: active ? '100.00' : '0.00',
        },
        creatorBonus: { lifetime: '0.00' },
        currentEpoch: summaryEpoch(active),
      },
    },
  };
}

/** `GET .../wallets/:walletAddress/epochs/:epoch` and `GET /liquidity-rewards/me/epochs/:epoch`. */
export function walletEpochFixture(
  wallet: string,
  epoch: number,
): Record<string, unknown> {
  const active = hasActivity(wallet);
  return {
    user_id: wallet,
    epoch,
    day_open_ms: dayOpen(epoch),
    day_close_ms: dayClose(epoch),
    flagged: false,
    effective_cp: active ? '133.19' : '0.00',
    allocated_cp: active ? '133.19' : '0.00',
    credited_cp: '0.00',
    markets: active
      ? [
          {
            market_id: REWARD_MARKET,
            currency: 'CP',
            score: '38666666666666.666667',
            score_share: '1.00000000',
            effective_cp: '64.44',
            allocated_cp: '64.44',
            credited_cp: '0.00',
            status: 'paid',
          },
          {
            market_id: REWARD_MARKET_2,
            currency: 'CP',
            score: '35277817245000.000000',
            score_share: '1.00000000',
            effective_cp: '68.75',
            allocated_cp: '68.75',
            credited_cp: null,
            status: 'pending',
          },
        ]
      : [],
    user: active ? userFixture() : null,
  };
}

function makerOrderLine(n: number, group: boolean): Record<string, unknown> {
  return {
    market_id: group ? REWARD_MARKET_2 : REWARD_MARKET,
    order_id: String(101_401_037 + n),
    outcome: n % 2 === 0 ? 'Yes' : 'No',
    side: 'Buy',
    price_tick: 790 - n * 10,
    score: '19333333333333.333333',
    maker_score_share: '0.20000000',
    payouts: [money('32.22', 'CP'), money('2.500000', 'USDC')],
    projected: false,
    eligible_ms: 55_680_000,
    first_seen_ms: dayOpen(SCORED_EPOCH),
    last_seen_ms: dayClose(SCORED_EPOCH),
    created_at_ms: 1_789_324_083_746,
    opening_size_micro: '1000000000',
    closing_size_micro: '1000000000',
    exit_kind: null,
    openingSizeShares: 1000,
    closingSizeShares: 1000,
    group_id: group ? REWARD_GROUP : null,
    active_from_ms: group ? 1_792_332_600_000 : null,
    active_to_ms: group ? 1_792_332_900_000 : null,
    window_state: group ? 'accruing' : null,
    scoring_status: 'previously_scored',
    unscored: false,
  };
}

function orderMarketSlice(): Record<string, unknown> {
  const rail = (reward: string) => ({
    maxDistanceCents: '3',
    minOrderSizeShares: 5,
    minPayout: '1.00',
    singleSidedFactor: '3',
    twoSidedBandLow: '0.10',
    twoSidedBandHigh: '0.90',
    maxAvgPrice: '0.98',
    dailyReward: reward,
  });
  return {
    title: 'Will ETH touch $100k by 2030?',
    slug: 'will-eth-touch-100k-by-2030-6209',
    eventSlug: 'will-eth-touch-100k-by-2030-7574',
    rootEventSlug: 'will-eth-touch-100k-by-2030-7574',
    imageUrl: 'https://img.example/eth.webp',
    status: 'ACTIVE',
    expiresAt: '2030-12-31T23:59:59.000Z',
    prices: { yes: '0.795', no: '0.205' },
    cp: rail('200.00'),
    usdc: rail('1004.000000'),
  };
}

/** `GET .../wallets/:walletAddress/orders` and `GET /liquidity-rewards/me/orders`. */
export function walletOrdersFixture(
  wallet: string,
  q: {
    epoch?: number;
    page: number;
    pageSize: number;
    marketId?: string;
    live?: boolean;
  },
): Record<string, unknown> {
  const active = hasActivity(wallet);
  const epoch = q.epoch ?? TODAY_EPOCH;
  const settled = epoch !== TODAY_EPOCH;
  const all =
    active && settled
      ? Array.from({ length: ORDERS_TOTAL }, (_, n) =>
          makerOrderLine(n, n === 4),
        )
      : [];
  const rows =
    q.marketId === undefined
      ? all
      : all.filter((row) => row.market_id === q.marketId);
  return {
    maker: wallet,
    flagged: false,
    market_id: q.marketId ?? null,
    epoch,
    day_open_ms: dayOpen(epoch),
    day_close_ms: dayClose(epoch),
    projected: false,
    projected_through_ms: null,
    page: q.page,
    page_size: q.pageSize,
    total: rows.length,
    truncated_orders: 0,
    live_markets_only: !settled,
    live_status: q.live === false ? null : settled ? 'closed_day' : 'applied',
    live_through_ms: settled ? null : 1_792_332_970_874,
    unscored_orders: settled ? null : 0,
    orders: rows.slice(q.page * q.pageSize, (q.page + 1) * q.pageSize),
    payout_summary: {
      markets:
        rows.length === 0
          ? []
          : [
              {
                market_id: REWARD_MARKET,
                group_id: null,
                score: '38666666666666.666667',
                payouts: [money('64.44', 'CP')],
                derived: false,
                projected: false,
              },
              {
                market_id: REWARD_MARKET_2,
                group_id: REWARD_GROUP,
                score: '35277817245000.000000',
                payouts: [money('168.75', 'CP'), money('20.000000', 'USDC')],
                derived: true,
                projected: false,
              },
            ],
      groups:
        rows.length === 0
          ? []
          : [
              {
                group_id: REWARD_GROUP,
                score: '70000000000000.000000',
                payouts: [money('168.75', 'CP')],
                projected: false,
              },
            ],
    },
    markets: rows.length === 0 ? {} : { [REWARD_MARKET]: orderMarketSlice() },
    user: active ? userFixture() : null,
  };
}

/** `GET .../markets/:marketId/wallets/:walletAddress` and `GET /liquidity-rewards/markets/:marketId/me`. */
export function marketDayFixture(
  marketId: string,
  wallet: string,
  q: {
    epoch?: number;
    page: number;
    pageSize: number;
    currency?: 'CP' | 'USDC';
  },
): Record<string, unknown> {
  const active = hasActivity(wallet) && q.epoch === SCORED_EPOCH;
  const epoch = q.epoch ?? TODAY_EPOCH;
  const orders = active
    ? Array.from({ length: 3 }, (_, n) => ({
        order_id: String(101_407_907 + n),
        outcome: 'Yes',
        side: 'Buy',
        price_tick: 890 + n,
        score: '5835224679864.586035',
        maker_score_share: '0.16540776',
        payout: money('27.91', 'CP'),
        eligible_ms: 59_400_000,
        first_seen_ms: dayOpen(epoch),
        last_seen_ms: dayClose(epoch),
        created_at_ms: 1_789_325_522_000,
        opening_size_micro: '1000000000',
        closing_size_micro: '1000000000',
        exit_kind: null,
      }))
    : [];
  return {
    market_id: marketId,
    maker: wallet,
    flagged: false,
    epoch,
    day_open_ms: dayOpen(epoch),
    day_close_ms: dayClose(epoch),
    rail_active_from_ms: active ? dayOpen(epoch) : null,
    rail_active_to_ms: active ? 1_792_254_600_000 : null,
    scored: active,
    projected: false,
    projected_through_ms: null,
    currency: active ? (q.currency ?? 'CP') : null,
    score: active ? '35277817245000.000000' : '0.000000',
    score_share: active ? '1.00000000' : '0.00000000',
    projected_payout: active ? money('168.75', 'CP') : null,
    credited: active ? money('100.00', 'CP') : null,
    status: active ? 'paid' : 'none',
    base_amount: active ? money('68.75', 'CP') : null,
    bonus_amount: active ? money('100.00', 'CP') : null,
    bonus_by_window: active
      ? [
          {
            window_id: '09f1db23-6ed5-4f1d-92a2-cdf5ba5dc20b',
            amount: money('100.00', 'CP'),
            allocated: money('100.00', 'CP'),
            credited: money('100.00', 'CP'),
            status: 'paid',
          },
        ]
      : [],
    bonus_only: false,
    allocation_method: 'pro_rata',
    order_count: orders.length,
    cancel_count: 0,
    fill_count: 0,
    eligible_ms: active ? 59_400_000 : 0,
    qualifying_orders: {
      page: q.page,
      page_size: q.pageSize,
      total: orders.length,
      truncated_orders: 0,
      attributed: money(active ? '168.75' : '0.00', 'CP'),
      unattributed: money('0.00', 'CP'),
      orders: orders.slice(q.page * q.pageSize, (q.page + 1) * q.pageSize),
    },
  };
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export const PRODUCT = {
  categoryId: 24,
  name: '5m Up/Down',
  slug: '5m-up-down',
  depth: 2,
  path: ['PULSE', 'BTC', '5m Up/Down'],
  productId: 'category:24',
};

export const groupIdAt = (n: number): string =>
  n === 0 ? REWARD_GROUP : `0x${(0xb9 - n).toString(16).repeat(32)}`;

/** One group of the list (`product` is the label, or null when the group has none). */
export function groupFixture(n: number): Record<string, unknown> {
  return {
    group_id: groupIdAt(n),
    active: true,
    usdc: railFixture('USDC'),
    cp: railFixture('CP'),
    member_markets_today: 174,
    active_bonus: [
      bonusWindowSnake('1427f50e-b91f-4c19-a9f5-7e2b849fbea4', 'USDC', 'LIVE'),
    ],
    upcoming_bonus: [],
    ended_bonus: [
      bonusWindowSnake('04a26f09-5011-4b9c-bd99-4f0fe329dc12', 'CP', 'ENDED'),
    ],
    product: n === 0 ? PRODUCT : null,
  };
}

export function groupsFixture(
  page: number,
  pageSize: number,
): Record<string, unknown> {
  const all = Array.from({ length: GROUPS_TOTAL }, (_, n) => groupFixture(n));
  return {
    page,
    page_size: pageSize,
    total: GROUPS_TOTAL,
    truncated: false,
    current_epoch: TODAY_EPOCH,
    current_epoch_open_ms: dayOpen(TODAY_EPOCH),
    current_epoch_close_ms: dayClose(TODAY_EPOCH),
    current_epoch_ends_in_ms: 35_189_863,
    groups: all.slice(page * pageSize, (page + 1) * pageSize),
  };
}

export function groupDetailFixture(id: string): Record<string, unknown> {
  return {
    group_id: id,
    active: true,
    usdc: railFixture('USDC'),
    cp: railFixture('CP'),
    current_epoch: TODAY_EPOCH,
    current_epoch_open_ms: dayOpen(TODAY_EPOCH),
    current_epoch_close_ms: dayClose(TODAY_EPOCH),
    current_epoch_ends_in_ms: 35_189_863,
    member_markets_today: 174,
    total_scored_liquidity: '385300915998620.312037',
    lifetime_by_currency: [lifetimeFixture('CP'), lifetimeFixture('USDC')],
    active_bonus: [],
    upcoming_bonus: [],
    ended_bonus: [],
    product: PRODUCT,
  };
}

/** `GET /liquidity-rewards/groups/:groupId/me`: the rewards service's answer with the group's label. */
export function groupDayFixture(
  id: string,
  wallet: string,
  epoch: number | undefined,
): Record<string, unknown> {
  const e = epoch ?? TODAY_EPOCH;
  return {
    group_id: id,
    maker: wallet,
    flagged: false,
    epoch: e,
    day_open_ms: dayOpen(e),
    day_close_ms: dayClose(e),
    scored: false,
    projected: false,
    projected_through_ms: null,
    currency: null,
    score: '0.000000',
    score_share: '0.00000000',
    projected_payout: null,
    credited: null,
    status: 'none',
    product: PRODUCT,
  };
}

/** `GET /liquidity-rewards/me/group-history`: the rewards service's answer with the labels of the groups. */
export function groupHistoryFixture(
  wallet: string,
  page: number,
  pageSize: number,
): Record<string, unknown> {
  const all = Array.from({ length: HISTORY_TOTAL }, (_, n) => ({
    market_id: groupIdAt(0),
    group_id: groupIdAt(0),
    epoch: SCORED_EPOCH - n,
    day_open_ms: dayOpen(SCORED_EPOCH - n),
    day_close_ms: dayClose(SCORED_EPOCH - n),
    currency: 'CP',
    score: '35277817245000.000000',
    score_share: '1.00000000',
    allocated: money('68.75', 'CP'),
    effective: money('68.75', 'CP'),
    credited: money('68.75', 'CP'),
    status: 'paid',
    base_amount: money('68.75', 'CP'),
    bonus_amount: money('0.00', 'CP'),
  }));
  return {
    maker: wallet,
    flagged: false,
    page,
    page_size: pageSize,
    total: HISTORY_TOTAL,
    totals_by_currency: [
      {
        currency: 'CP',
        allocated: money('206.25', 'CP'),
        effective: money('206.25', 'CP'),
        credited: money('206.25', 'CP'),
        base_effective: money('206.25', 'CP'),
        bonus_effective: money('0.00', 'CP'),
        market_days: HISTORY_TOTAL,
      },
    ],
    lines: all.slice(page * pageSize, (page + 1) * pageSize),
    // The backend labels every group the catalogue knows, not only the groups of the lines
    products: Object.fromEntries(
      Array.from({ length: GROUPS_TOTAL }, (_, n) => [
        groupIdAt(n),
        n === 0 ? PRODUCT : null,
      ]),
    ),
  };
}

// ---------------------------------------------------------------------------
// Leaderboard (the backend's presenter, camelCase, with a PageMeta)
// ---------------------------------------------------------------------------

export function leaderboardRowFixture(rank: number): Record<string, unknown> {
  const mine = rank === OWNER_RANK;
  return {
    rank,
    walletAddress: mine ? OWNER_WALLET : walletAt(0x50 + rank),
    id: mine ? OWNER.id : null,
    username: mine ? OWNER.username : null,
    name: null,
    profilePictureUrl: null,
    roosterColor: null,
    liquidityCp: `${1250 - rank * 100}.50`,
    creditedCp: `${1200 - rank * 100}.50`,
    marketDays: 21,
    achievements: [],
    verified: false,
    isOg: rank === 1,
    cpPoints: 5000,
    tier: 'Believer',
  };
}

export function leaderboardFixture(
  period: string,
  page: number,
  take: number,
): Record<string, unknown> {
  const all = Array.from({ length: LEADERBOARD_TOTAL }, (_, n) =>
    leaderboardRowFixture(n + 1),
  );
  return {
    data: all.slice((page - 1) * take, page * take),
    period,
    fromEpoch: 20_737,
    toEpoch: 20_743,
    totalCp: '48210.75',
    meta: pageMeta(page, take, LEADERBOARD_TOTAL),
  };
}

// ---------------------------------------------------------------------------
// The handlers
// ---------------------------------------------------------------------------

export interface RewardsData {
  /** The account is not on the leaderboard: `leaderboard/me` answers 404. */
  unranked: boolean;
}

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const BYTES32 = /^0x[a-fA-F0-9]{64}$/;
const PERIODS = ['daily', 'weekly', 'seasonal'];
const CURRENCIES = ['CP', 'USDC'];
const MAX_EPOCH = 10_000_000;
const MAX_PAGE = 1_000_000;

const ENROLLED = new Set([REWARD_MARKET, REWARD_MARKET_2]);

/** An optional query value that must be an integer from `min` to `max`. */
function intProblem(
  query: Record<string, string>,
  name: string,
  min: number,
  max: number,
): string[] {
  const raw = query[name];
  if (raw === undefined) return [];
  const n = Number(raw);
  if (!Number.isInteger(n)) return [`${name} must be an integer number`];
  const problems: string[] = [];
  if (n > max) problems.push(`${name} must not be greater than ${max}`);
  if (n < min) problems.push(`${name} must not be less than ${min}`);
  return problems;
}

/** The backend's query check: unknown keys and the ranges. */
function dto(
  request: RouteArgs['request'],
  allowed: string[],
  o: {
    ints?: Array<[string, number, number]>;
    oneOf?: Record<string, string[]>;
    booleans?: string[];
  } = {},
): Response | undefined {
  const problems: string[] = [];
  for (const key of Object.keys(request.query)) {
    if (!allowed.includes(key))
      problems.push(`property ${key} should not exist`);
  }
  for (const [name, min, max] of o.ints ?? []) {
    problems.push(...intProblem(request.query, name, min, max));
  }
  for (const [name, values] of Object.entries(o.oneOf ?? {})) {
    const value = request.query[name];
    if (value !== undefined && !values.includes(value)) {
      problems.push(
        `${name} must be one of the following values: ${values.join(', ')}`,
      );
    }
  }
  for (const name of o.booleans ?? []) {
    const value = request.query[name];
    if (value !== undefined && value !== 'true' && value !== 'false') {
      problems.push(`${name} must be a boolean value`);
    }
  }
  return problems.length === 0 ? undefined : badRequest(request.path, problems);
}

/** The `epoch` path param: an integer, then the rewards service's range. */
function epochParam(
  request: RouteArgs['request'],
  value: string,
): { epoch: number } | Response {
  if (!/^-?\d+$/.test(value)) {
    return badRequest(
      request.path,
      'Validation failed (numeric string is expected)',
    );
  }
  const epoch = Number(value);
  if (epoch < 0 || epoch > MAX_EPOCH) {
    return exceptionResponse(request.path, 400, {
      error: 'invalid_request',
      message: 'epoch must be in 0..=10000000',
    });
  }
  return { epoch };
}

/** The manual `Number(page)` / `Number(page_size)` of the public makers and orders. */
function manualPage(
  request: RouteArgs['request'],
): { page: number; pageSize: number } | Response {
  const page =
    request.query.page === undefined ? 0 : Number(request.query.page);
  const pageSize =
    request.query.page_size === undefined
      ? 100
      : Number(request.query.page_size);
  if (!Number.isInteger(page) || page < 0) {
    return badRequest(request.path, 'page must be a non-negative integer');
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    return badRequest(request.path, 'page_size must be between 1 and 1000');
  }
  return { page, pageSize };
}

const WALLET_ORDER_KEYS = ['market_id', 'epoch', 'page', 'page_size', 'live'];
const MARKET_ME_KEYS = ['epoch', 'currency', 'page', 'page_size'];

/**
 * Installs the liquidity-rewards routes on `server`, recording into the same log as the rest
 * of the fake (`backend.requests`). The shared routes accept the keys in `backend.validKeys`;
 * the account behind them is the owner of {@link OWNER_WALLET}.
 */
export function installRewardsData(
  server: SetupServer,
  backend: BackendData,
): RewardsData {
  const state: RewardsData = { unranked: false };
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

  /** A market of the rewards ledger, matched exactly (the rewards service is case-sensitive). */
  const market = (
    path: string,
    id: string | undefined,
  ): Response | undefined =>
    id !== undefined && ENROLLED.has(id)
      ? undefined
      : notFound(path, `No liquidity reward config exists for market ${id}`);

  /** A wallet of a path: `requireWallet`. */
  const wallet = (path: string, value: string | undefined) =>
    value !== undefined && ADDRESS.test(value)
      ? lowerWallet(value)
      : badRequest(
          path,
          'walletAddress must be a 0x-prefixed 40-hex Ethereum address',
        );

  const intQuery = (value: string | undefined) =>
    value === undefined ? undefined : Number(value);

  server.use(
    // --- public ----------------------------------------------------------------------
    http.get(
      `${PUBLIC}/earning-pools`,
      route(() => earningPoolsFixture()),
    ),

    http.get(
      `${PUBLIC}/groups`,
      route(({ request }) => {
        const problem = dto(
          request,
          ['page', 'page_size', 'currency', 'include_zero'],
          {
            ints: [
              ['page', 0, MAX_PAGE],
              ['page_size', 1, 100],
            ],
            oneOf: { currency: CURRENCIES },
            booleans: ['include_zero'],
          },
        );
        if (problem) return problem;
        return groupsFixture(
          Number(request.query.page ?? 0),
          Number(request.query.page_size ?? 100),
        );
      }),
    ),

    http.get(
      `${PUBLIC}/groups/:groupId`,
      route(({ request, params }) => {
        const id = params.groupId ?? '';
        if (!BYTES32.test(id)) {
          return badRequest(
            request.path,
            'groupId must be a 0x-prefixed 32-byte hex string',
          );
        }
        // The backend lowercases the id before it asks the rewards service.
        if (id.toLowerCase() !== REWARD_GROUP) {
          return notFound(request.path, `Group ${id} not found`);
        }
        return groupDetailFixture(id.toLowerCase());
      }),
    ),

    http.get(
      `${PUBLIC}/markets/:marketId/config`,
      route(({ request, params }) => {
        const missing = market(request.path, params.marketId);
        if (missing) return missing;
        return marketConfigFixture(params.marketId as string);
      }),
    ),

    http.get(
      `${PUBLIC}/markets/:marketId/epochs/:epoch/makers`,
      route(({ request, params }) => {
        const epoch = epochParam(request, params.epoch as string);
        if (epoch instanceof Response) return epoch;
        const missing = market(request.path, params.marketId);
        if (missing) return missing;
        const paging = manualPage(request);
        if (paging instanceof Response) return paging;
        return marketMakersFixture(
          params.marketId as string,
          epoch.epoch,
          paging.page,
          paging.pageSize,
        );
      }),
    ),

    http.get(
      `${PUBLIC}/markets/:marketId/epochs/:epoch/orders`,
      route(({ request, params }) => {
        const epoch = epochParam(request, params.epoch as string);
        if (epoch instanceof Response) return epoch;
        const missing = market(request.path, params.marketId);
        if (missing) return missing;
        const paging = manualPage(request);
        if (paging instanceof Response) return paging;
        return marketOrdersFixture(
          params.marketId as string,
          epoch.epoch,
          paging.page,
          paging.pageSize,
          request.query.maker,
        );
      }),
    ),

    http.get(
      `${PUBLIC}/markets/:marketId/epochs/:epoch`,
      route(({ request, params }) => {
        const epoch = epochParam(request, params.epoch as string);
        if (epoch instanceof Response) return epoch;
        const missing = market(request.path, params.marketId);
        if (missing) return missing;
        return marketEpochFixture(params.marketId as string, epoch.epoch);
      }),
    ),

    http.get(
      `${PUBLIC}/markets/:marketId/wallets/:walletAddress`,
      route(({ request, params }) => {
        const who = wallet(request.path, params.walletAddress);
        if (who instanceof Response) return who;
        const problem = dto(request, MARKET_ME_KEYS, {
          ints: [
            ['epoch', 0, MAX_EPOCH],
            ['page', 0, MAX_PAGE],
            ['page_size', 1, 1000],
          ],
          oneOf: { currency: CURRENCIES },
        });
        if (problem) return problem;
        const missing = market(request.path, params.marketId);
        if (missing) return missing;
        return marketDayFixture(params.marketId as string, who, {
          epoch: intQuery(request.query.epoch),
          page: Number(request.query.page ?? 0),
          pageSize: Number(request.query.page_size ?? 100),
          currency: request.query.currency as 'CP' | 'USDC' | undefined,
        });
      }),
    ),

    http.get(
      `${PUBLIC}/markets/:marketId`,
      route(({ request, params }) => {
        const missing = market(request.path, params.marketId);
        if (missing) return missing;
        return marketDetailFixture(params.marketId as string);
      }),
    ),

    http.get(
      `${PUBLIC}/wallets/:walletAddress/summary`,
      route(({ request, params }) => {
        const who = wallet(request.path, params.walletAddress);
        if (who instanceof Response) return who;
        return walletSummaryFixture(who);
      }),
    ),

    http.get(
      `${PUBLIC}/wallets/:walletAddress/epochs/:epoch`,
      route(({ request, params }) => {
        const who = wallet(request.path, params.walletAddress);
        if (who instanceof Response) return who;
        const epoch = epochParam(request, params.epoch as string);
        if (epoch instanceof Response) return epoch;
        return walletEpochFixture(who, epoch.epoch);
      }),
    ),

    http.get(
      `${PUBLIC}/wallets/:walletAddress/orders`,
      route(({ request, params }) => {
        const who = wallet(request.path, params.walletAddress);
        if (who instanceof Response) return who;
        const problem = dto(request, WALLET_ORDER_KEYS, {
          ints: [
            ['epoch', 0, MAX_EPOCH],
            ['page', 0, MAX_PAGE],
            ['page_size', 1, 1000],
          ],
          booleans: ['live'],
        });
        if (problem) return problem;
        return walletOrdersFixture(who, {
          epoch: intQuery(request.query.epoch),
          page: Number(request.query.page ?? 0),
          pageSize: Number(request.query.page_size ?? 100),
          marketId: request.query.market_id,
          live:
            request.query.live === undefined
              ? undefined
              : request.query.live === 'true',
        });
      }),
    ),

    // --- shared: the account's own ----------------------------------------------------
    http.get(
      `${MINE}/me/summary`,
      shared(() => walletSummaryFixture(OWNER_WALLET)),
    ),

    http.get(
      `${MINE}/me/epochs/:epoch`,
      shared(({ request, params }) => {
        const epoch = epochParam(request, params.epoch as string);
        if (epoch instanceof Response) return epoch;
        return walletEpochFixture(OWNER_WALLET, epoch.epoch);
      }),
    ),

    http.get(
      `${MINE}/me/orders`,
      shared(({ request }) => {
        const problem = dto(request, WALLET_ORDER_KEYS, {
          ints: [
            ['epoch', 0, MAX_EPOCH],
            ['page', 0, MAX_PAGE],
            ['page_size', 1, 1000],
          ],
          booleans: ['live'],
        });
        if (problem) return problem;
        return walletOrdersFixture(OWNER_WALLET, {
          epoch: intQuery(request.query.epoch),
          page: Number(request.query.page ?? 0),
          pageSize: Number(request.query.page_size ?? 100),
          marketId: request.query.market_id,
          live:
            request.query.live === undefined
              ? undefined
              : request.query.live === 'true',
        });
      }),
    ),

    http.get(
      `${MINE}/me/group-history`,
      shared(({ request }) => {
        const problem = dto(request, ['page', 'page_size'], {
          ints: [
            ['page', 0, MAX_PAGE],
            ['page_size', 1, 100],
          ],
        });
        if (problem) return problem;
        return groupHistoryFixture(
          OWNER_WALLET,
          Number(request.query.page ?? 0),
          Number(request.query.page_size ?? 100),
        );
      }),
    ),

    http.get(
      `${MINE}/markets/:marketId/me`,
      shared(({ request, params }) => {
        const problem = dto(request, MARKET_ME_KEYS, {
          ints: [
            ['epoch', 0, MAX_EPOCH],
            ['page', 0, MAX_PAGE],
            ['page_size', 1, 1000],
          ],
          oneOf: { currency: CURRENCIES },
        });
        if (problem) return problem;
        const missing = market(request.path, params.marketId);
        if (missing) return missing;
        return marketDayFixture(params.marketId as string, OWNER_WALLET, {
          epoch: intQuery(request.query.epoch),
          page: Number(request.query.page ?? 0),
          pageSize: Number(request.query.page_size ?? 100),
          currency: request.query.currency as 'CP' | 'USDC' | undefined,
        });
      }),
    ),

    http.get(
      `${MINE}/groups/:groupId/me`,
      shared(({ request, params }) => {
        const problem = dto(request, ['epoch', 'currency'], {
          ints: [['epoch', 0, MAX_EPOCH]],
          oneOf: { currency: CURRENCIES },
        });
        if (problem) return problem;
        const id = params.groupId ?? '';
        if (!BYTES32.test(id)) {
          return badRequest(
            request.path,
            'groupId must be a 0x-prefixed 32-byte hex string',
          );
        }
        if (id.toLowerCase() !== REWARD_GROUP) {
          return notFound(request.path, `Group ${id} not found`);
        }
        return groupDayFixture(
          id.toLowerCase(),
          OWNER_WALLET,
          intQuery(request.query.epoch),
        );
      }),
    ),

    http.get(
      `${MINE}/leaderboard/me`,
      shared(({ request }) => {
        const problem = dto(request, ['period'], {
          oneOf: { period: PERIODS },
        });
        if (problem) return problem;
        if (state.unranked) {
          return notFound(request.path, 'User not ranked in this period');
        }
        return leaderboardRowFixture(OWNER_RANK);
      }),
    ),

    http.get(
      `${MINE}/leaderboard`,
      shared(({ request }) => {
        const problem = dto(
          request,
          ['page', 'take', 'search', 'sortBy', 'sortOrder', 'period'],
          {
            ints: [
              ['page', 1, 10_000],
              ['take', 1, 1000],
            ],
            oneOf: { period: PERIODS, sortOrder: ['ASC', 'DESC'] },
          },
        );
        if (problem) return problem;
        return leaderboardFixture(
          request.query.period ?? 'weekly',
          Number(request.query.page ?? 1),
          Number(request.query.take ?? 10),
        );
      }),
    ),
  );

  return state;
}
