import type { Address } from 'viem';
import { isDecimalString, numberToDecimal } from '../core/decimal';
import type { ConditionId, DecimalString } from '../core/types';
import type {
  RewardsBonusWindow as RawBonusWindow,
  EarningPool as RawEarningPool,
  EarningPoolBonusWindow as RawEarningPoolBonus,
  EarningPoolRailTerms as RawEarningPoolTerms,
  RewardsGroupProduct as RawGroupProduct,
  RewardsLeaderboardRow as RawLeaderboardRow,
  RewardsLifetime as RawLifetime,
  RewardsMaker as RawMaker,
  RewardsMakerOrder as RawMakerOrder,
  RewardsMarketOrder as RawMarketOrder,
  RewardsRailState as RawRailState,
  RewardAmount as RawRewardAmount,
  RewardsGroup as RawRewardsGroup,
  RewardsGroupDetail as RawRewardsGroupDetail,
  RewardsMarket as RawRewardsMarket,
  RewardsMarketEpoch as RawRewardsMarketEpoch,
  RewardsUser as RawRewardsUser,
  RewardsSummaryAmount as RawSummaryAmount,
  RewardsSummaryEpoch as RawSummaryEpoch,
  RewardsUsdcMaker as RawUsdcMaker,
  RewardsWalletEpoch as RawWalletEpoch,
  RewardsWalletSummary as RawWalletSummary,
} from '../data/rewardsSchemas';
import {
  addressOf,
  conditionIdOf,
  priceOfTick,
  requireIsoFromMilliseconds,
  wholeUnitsOf,
} from './convert';
import { OrderSide } from './enums';

// The public liquidity-rewards models. XO pays makers for resting orders that stay close to
// the midpoint of a market, in two currencies: conviction points (`CP`) and `USDC`. Each
// currency has its own programme, so the models list programmes by currency instead of
// naming a field per currency. Rewards are counted per UTC day, called an epoch: the number
// of days since 1970-01-01. Every amount is a whole-unit decimal in the currency it is for,
// and a time is an ISO 8601 string.

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** What a reward is paid in: `CP` (conviction points) or `USDC`. A currency added later reads as its own string. */
export type RewardCurrency = 'CP' | 'USDC' | (string & {});

/** Where a programme is in its life: `SCHEDULED`, `LIVE` or `ENDED`. */
export type RewardProgrammeStatus =
  | 'SCHEDULED'
  | 'LIVE'
  | 'ENDED'
  | (string & {});

/**
 * Why a programme does not pay today: `reward_disabled`, `no_daily_pool`,
 * `outside_program_window`, `budget_exhausted`, `before_term`, `window_elapsed`,
 * `not_configured` or `misconfigured`. A reason added later reads as its own string.
 */
export type RewardInactiveReason =
  | 'reward_disabled'
  | 'no_daily_pool'
  | 'outside_program_window'
  | 'budget_exhausted'
  | 'before_term'
  | 'window_elapsed'
  | 'not_configured'
  | 'misconfigured'
  | (string & {});

/**
 * Where a maker's payout for a day stands: `projected` while the day is open, `paid` once it
 * is credited, `none` when nothing is due. `pending`, `dropped_below_min`, `dropped_flagged`
 * and `failed_transfer` say why a payout is waiting or was not made. A status added later
 * reads as its own string.
 */
export type RewardPayoutStatus =
  | 'projected'
  | 'pending'
  | 'paid'
  | 'dropped_below_min'
  | 'dropped_flagged'
  | 'failed_transfer'
  | 'none'
  | (string & {});

/** Where a market's reward day is: `scored`, `settling`, `settled` or `projected`. A status added later reads as its own string. */
export type RewardDayStatus =
  | 'scored'
  | 'settling'
  | 'settled'
  | 'projected'
  | (string & {});

/** An amount of one currency, in whole units. */
export type RewardAmount = {
  /** What the amount is in. */
  currency: RewardCurrency;
  /** The amount. */
  amount: DecimalString;
};

/** A UTC day of rewards. */
export type RewardsDay = {
  /** The day's number: whole days since 1970-01-01 (UTC). */
  epoch: number;
  /** When the day opens, as an ISO 8601 time. */
  opensAt: string;
  /** When the day closes, as an ISO 8601 time. */
  closesAt: string;
};

/** How a programme scores resting orders. A term XO does not state is `null`. */
export type RewardTerms = {
  /** How far from the midpoint, in cents, an order still scores. */
  maxDistanceCents: number | null;
  /** The multiplier on the score of a one-sided order. */
  singleSidedFactor: number | null;
  /** The low end of the scoring band, as a price between 0 and 1. */
  twoSidedBandLow: DecimalString | null;
  /** The high end of the scoring band, as a price between 0 and 1. */
  twoSidedBandHigh: DecimalString | null;
  /** Orders score nothing when the midpoint is above this price (or below 1 minus it), in dollars between 0 and 1. */
  maxAvgPrice: DecimalString | null;
  /** How long an order must rest before it scores, in milliseconds. */
  minOrderRestMs: number | null;
  /** The smallest order that scores, in shares. */
  minOrderSize: DecimalString | null;
  /** The smallest payout that is made, in the programme's currency. */
  minPayout: DecimalString | null;
};

/** The reward programme of one currency on a market or a group. */
export type RewardProgramme = {
  /** What the programme pays in. */
  currency: RewardCurrency;
  /** Whether the programme pays today. `null` when XO does not say. */
  active: boolean | null;
  /** Why it does not pay today. `null` while it does, or when XO gives no reason. */
  inactiveReason: RewardInactiveReason | null;
  /** Where the programme is in its life. */
  status: RewardProgrammeStatus | null;
  /** What is paid out per day, in `currency`. */
  dailyPool: DecimalString | null;
  /** The whole programme's budget, in `currency`. */
  budgetTotal: DecimalString | null;
  /** What is left of the budget, in `currency`. */
  budgetRemaining: DecimalString | null;
  /** How many days the programme still runs. */
  daysRemaining: number | null;
  /** When the programme starts, as an ISO 8601 time. */
  startsAt: string | null;
  /** When the programme ends, as an ISO 8601 time. `null` while it has no end yet. */
  endsAt: string | null;
  /** The estimated annual return in percent, from the daily pool against the liquidity it attracts. `null` for `CP`, and when XO cannot estimate it. */
  estimatedApr: DecimalString | null;
  /** How resting orders are scored. */
  terms: RewardTerms;
};

/** An extra reward pool that is paid on top of a programme for a set time. */
export type RewardBonus = {
  /** XO's id for the bonus window. */
  windowId: string;
  /** What the bonus pays in. */
  currency: RewardCurrency;
  /** Whether the window is `LIVE`, `SCHEDULED` or `ENDED`. */
  status: RewardProgrammeStatus;
  /** The whole window's pool, in `currency`. */
  amount: DecimalString;
  /** What is still on offer, in `currency`. Zero once the window ended. */
  remaining: DecimalString;
  /** The part of the pool offered in the current UTC day, in `currency`. */
  todayPool: DecimalString;
  /** When the window starts, as an ISO 8601 time. */
  startsAt: string;
  /** When the window ends, as an ISO 8601 time. */
  endsAt: string;
  /** When the window was stopped early, as an ISO 8601 time. `null` when it was not. */
  stoppedAt: string | null;
  /** A name for the window. */
  label: string | null;
  /** `IN_GAME`, `EVENT` or `AD_HOC`. A kind added later reads as its own string. */
  kind: 'IN_GAME' | 'EVENT' | 'AD_HOC' | (string & {}) | null;
  /** How the pool is shared out, such as `pro_rata`. */
  allocationMethod: string;
};

/** What a programme has scored and paid over its life, in one currency. */
export type RewardLifetime = {
  /** The currency. */
  currency: RewardCurrency;
  /** How many days have been scored. */
  scoredEpochs: number;
  /** The most recent scored day. */
  latestEpoch: number;
  /** The liquidity scored in all, as an exact decimal text (share-seconds). */
  totalScoredLiquidity: string;
  /** What was allocated over the programme's life, in `currency`. */
  allocated: DecimalString;
  /** What was distributed over the programme's life, in `currency`. */
  distributed: DecimalString;
  /** The part of `allocated` that came from the base programme. `null` when XO does not split it. */
  baseAllocated: DecimalString | null;
  /** The part of `allocated` that came from bonus windows. `null` when XO does not split it. */
  bonusAllocated: DecimalString | null;
  /** On how many days only a bonus window paid. `null` when XO does not say. */
  bonusOnlyEpochs: number | null;
};

/** The profile of the XO user behind a rewards wallet. */
export type RewardsUserProfile = {
  /** XO's id for the user. */
  userId: string;
  /** The user's unique name. */
  username: string;
  /** The user's display name. */
  name: string | null;
  /** The user's picture. */
  profileImage: string | null;
  /** Whether the user is verified. */
  verifiedBadge: boolean;
  /** The keys of the badges the user earned. */
  achievements: string[];
  /** The user's conviction points, as an exact decimal. */
  convictionPoints: DecimalString;
  /** The user's tier, such as `Believer`. */
  tier: string;
};

function dayOf(
  epoch: number,
  openMs: number,
  closeMs: number,
  field = 'day',
): RewardsDay {
  return {
    epoch,
    opensAt: requireIsoFromMilliseconds(openMs, `${field}.opensAt`),
    closesAt: requireIsoFromMilliseconds(closeMs, `${field}.closesAt`),
  };
}

/** A time given as text, or else in milliseconds, or `null` when neither is given. */
function timeOf(
  text: string | null | undefined,
  ms: number | null | undefined,
  field: string,
): string | null {
  if (typeof text === 'string' && text !== '') {
    return text;
  }
  return typeof ms === 'number' ? requireIsoFromMilliseconds(ms, field) : null;
}

/** A parameter XO sends as text (`"5"`) as a number, or `null` when it is missing or not a decimal. */
function numberOrNull(value: string | null | undefined): number | null {
  return typeof value === 'string' && isDecimalString(value)
    ? Number(value)
    : null;
}

/** A decimal, or `null` when it is missing or not a plain decimal. */
function decimalOrNull(value: string | null | undefined): DecimalString | null {
  return typeof value === 'string' && isDecimalString(value) ? value : null;
}

function termsOf(raw: {
  maxDistanceCents?: string | null;
  singleSidedFactor?: string | null;
  twoSidedBandLow?: DecimalString | null;
  twoSidedBandHigh?: DecimalString | null;
  maxAvgPrice?: DecimalString | null;
  minOrderRestMs?: number | null;
  minOrderSizeShares?: number | null;
  minPayout?: DecimalString | null;
}): RewardTerms {
  return {
    maxDistanceCents: numberOrNull(raw.maxDistanceCents),
    singleSidedFactor: numberOrNull(raw.singleSidedFactor),
    twoSidedBandLow: raw.twoSidedBandLow ?? null,
    twoSidedBandHigh: raw.twoSidedBandHigh ?? null,
    maxAvgPrice: raw.maxAvgPrice ?? null,
    minOrderRestMs: raw.minOrderRestMs ?? null,
    minOrderSize:
      raw.minOrderSizeShares == null
        ? null
        : numberToDecimal(raw.minOrderSizeShares, 'terms.minOrderSize'),
    minPayout: raw.minPayout ?? null,
  };
}

function poolRail(
  currency: RewardCurrency,
  raw: RawEarningPoolTerms,
  dailyPool: DecimalString | null,
  budgetTotal: DecimalString | null | undefined,
  estimatedApr: string | null | undefined,
): RewardProgramme {
  return {
    currency,
    active: raw.active ?? null,
    inactiveReason: raw.inactiveReason ?? null,
    status: raw.programStatus ?? null,
    dailyPool,
    budgetTotal: budgetTotal ?? null,
    budgetRemaining: raw.budgetRemaining ?? null,
    daysRemaining: raw.daysRemaining ?? null,
    startsAt: timeOf(
      raw.programStartsAt,
      raw.programStartsAtMs,
      'programme.startsAt',
    ),
    endsAt: timeOf(raw.programEndsAt, raw.programEndsAtMs, 'programme.endsAt'),
    estimatedApr: decimalOrNull(estimatedApr),
    terms: termsOf({
      maxDistanceCents: raw.maxDistanceCents,
      singleSidedFactor: raw.singleSidedFactor,
      twoSidedBandLow: raw.twoSidedBandLow,
      twoSidedBandHigh: raw.twoSidedBandHigh,
      maxAvgPrice: raw.maxAvgPrice,
      minOrderRestMs: raw.minOrderRestMs,
      minOrderSizeShares: raw.minOrderSizeShares,
      minPayout: raw.minPayout,
    }),
  };
}

function railState(
  currency: RewardCurrency,
  raw: RawRailState,
): RewardProgramme {
  return {
    currency,
    active: raw.active,
    inactiveReason: raw.inactive_reason,
    status: raw.status ?? null,
    dailyPool: raw.daily_pool?.amount ?? null,
    budgetTotal: raw.budget_total?.amount ?? null,
    budgetRemaining: raw.budget_remaining?.amount ?? null,
    daysRemaining: raw.days_remaining ?? null,
    startsAt: timeOf(
      raw.program_starts_at,
      raw.program_starts_at_ms,
      'programme.startsAt',
    ),
    endsAt: timeOf(
      raw.program_ends_at,
      raw.program_ends_at_ms,
      'programme.endsAt',
    ),
    estimatedApr: decimalOrNull(raw.estimated_apr),
    terms: termsOf({
      maxDistanceCents: raw.config.max_distance_cents,
      singleSidedFactor: raw.config.single_sided_factor,
      twoSidedBandLow: raw.config.two_sided_band_low,
      twoSidedBandHigh: raw.config.two_sided_band_high,
      maxAvgPrice: raw.config.max_avg_price,
      minOrderRestMs: raw.config.min_order_rest_ms,
      minOrderSizeShares: raw.config.min_order_size_shares,
      minPayout: raw.config.min_payout.amount,
    }),
  };
}

/** The programmes of a market or a group: the `CP` one first, then `USDC`, each only when XO has it. */
function programmesOf(raw: {
  cp: RawRailState | null;
  usdc: RawRailState | null;
}): RewardProgramme[] {
  return [
    ...(raw.cp === null ? [] : [railState('CP', raw.cp)]),
    ...(raw.usdc === null ? [] : [railState('USDC', raw.usdc)]),
  ];
}

function bonusOfWindow(raw: RawBonusWindow): RewardBonus {
  return {
    windowId: raw.window_id,
    currency: raw.currency,
    status: raw.status,
    amount: raw.amount.amount,
    remaining: raw.remaining.amount,
    todayPool: raw.today_pool.amount,
    startsAt: raw.starts_at,
    endsAt: raw.ends_at,
    stoppedAt: raw.stopped_at,
    label: raw.label,
    kind: raw.kind,
    allocationMethod: raw.allocation_method,
  };
}

function bonusOfPool(raw: RawEarningPoolBonus): RewardBonus {
  return {
    windowId: raw.windowId,
    currency: raw.currency,
    status: raw.status,
    amount: raw.amount,
    remaining: raw.remaining,
    todayPool: raw.todayPool,
    startsAt: raw.startsAt,
    endsAt: raw.endsAt,
    stoppedAt: raw.stoppedAt ?? null,
    label: raw.label ?? null,
    kind: raw.kind ?? null,
    allocationMethod: raw.allocationMethod,
  };
}

/** The live windows first, then the scheduled ones, then the ended ones. */
function bonusesOf(raw: {
  active_bonus?: RawBonusWindow[];
  upcoming_bonus?: RawBonusWindow[];
  ended_bonus?: RawBonusWindow[];
}): RewardBonus[] {
  return [
    ...(raw.active_bonus ?? []),
    ...(raw.upcoming_bonus ?? []),
    ...(raw.ended_bonus ?? []),
  ].map(bonusOfWindow);
}

function lifetimeOf(raw: RawLifetime): RewardLifetime {
  return {
    currency: raw.currency,
    scoredEpochs: raw.scored_epochs,
    latestEpoch: raw.latest_epoch,
    totalScoredLiquidity: raw.total_scored_liquidity,
    allocated: raw.allocated.amount,
    distributed: raw.distributed.amount,
    baseAllocated: raw.base_allocated?.amount ?? null,
    bonusAllocated: raw.bonus_allocated?.amount ?? null,
    bonusOnlyEpochs: raw.bonus_only_epochs ?? null,
  };
}

function profileOf(raw: RawRewardsUser): RewardsUserProfile {
  return {
    userId: String(raw.id),
    username: raw.username,
    name: raw.name,
    profileImage: raw.profilePictureUrl,
    verifiedBadge: raw.verified,
    achievements: [...raw.achievements],
    convictionPoints: numberToDecimal(raw.cpPoints, 'convictionPoints'),
    tier: raw.tier,
  };
}

function amountOf(raw: RawRewardAmount): RewardAmount {
  return { currency: raw.currency, amount: raw.amount };
}

// ---------------------------------------------------------------------------
// Pools and groups
// ---------------------------------------------------------------------------

/** The market a reward pool is for. A field XO does not have is `null`. */
export type RewardPoolMarket = {
  /** XO's id for the market (the `id` of a `Market`). */
  id: string | null;
  /** The market's question. */
  title: string | null;
  /** The market's URL name. */
  slug: string | null;
  /** The market's picture. */
  image: string | null;
  /** The market's category, such as `SPORTS`. */
  category: string | null;
  /** Where the market is in its life, such as `ACTIVE`. */
  status: string | null;
  /** When the market ends, as an ISO 8601 time. */
  endDate: string | null;
  /** The midpoint prices of the two outcomes, in dollars between 0 and 1. `null` before the order book has them. */
  prices: { yes: DecimalString; no: DecimalString } | null;
};

/**
 * A market (or, for a Pulse group, the window accruing now) that pays liquidity rewards,
 * with its programme in each currency.
 */
export type RewardPool = {
  /** The market's id on the order book. */
  conditionId: ConditionId;
  /** The market. `null` when XO gave none. */
  market: RewardPoolMarket | null;
  /** The Pulse group whose shared pool pays this window. `null` for a market with its own pool. */
  groupId: string | null;
  /** The programme in each currency, `CP` first. */
  programmes: RewardProgramme[];
  /** The bonus windows: live, scheduled, then ended. */
  bonuses: RewardBonus[];
};

/**
 * Maps a market that pays rewards to the {@link RewardPool} model.
 *
 * @throws {UnexpectedResponseError} When a time in milliseconds is not a time.
 * @internal
 */
export function toRewardPool(raw: RawEarningPool): RewardPool {
  const { market, cp, usdc } = raw;
  return {
    conditionId: conditionIdOf(raw.marketId),
    market:
      market == null
        ? null
        : {
            id: market.id == null ? null : String(market.id),
            title: market.title,
            slug: market.slug ?? null,
            image: market.imageUrl ?? null,
            category: market.category ?? null,
            status: market.status,
            endDate: market.expiresAt ?? null,
            prices:
              market.prices == null
                ? null
                : { yes: market.prices.yes, no: market.prices.no },
          },
    groupId: raw.group?.groupId ?? null,
    programmes: [
      ...(cp == null
        ? []
        : [poolRail('CP', cp, cp.dailyPool, cp.budgetTotal, cp.estimatedApr)]),
      ...(usdc == null
        ? []
        : [
            poolRail(
              'USDC',
              usdc,
              usdc.dailyRate,
              usdc.budgetTotal,
              usdc.estimatedApr,
            ),
          ]),
    ],
    bonuses: [...raw.activeBonus, ...raw.upcomingBonus, ...raw.endedBonus].map(
      bonusOfPool,
    ),
  };
}

/** The kind of Pulse market a group pays for. */
export type RewardGroupProduct = {
  /** The product's name, such as `5m Up/Down`. */
  name: string;
  /** The product's URL name. */
  slug: string | null;
  /** The product's place in the catalogue, from the top. */
  path: string[];
};

/**
 * A Pulse group: one shared reward pool for all the short rounds of a product.
 *
 * A group read from a listing has only what the listing carries; `day`,
 * `totalScoredLiquidity` and `lifetime` are `null` there.
 */
export type RewardGroup = {
  /** XO's id for the group. */
  groupId: string;
  /** Whether the group pays today. */
  active: boolean;
  /** What the group is for. `null` when XO has no label for it. */
  product: RewardGroupProduct | null;
  /** How many windows of the product accrue today. */
  activeMarkets: number;
  /** The programme in each currency, `CP` first. */
  programmes: RewardProgramme[];
  /** The bonus windows: live, scheduled, then ended. */
  bonuses: RewardBonus[];
  /** The day in progress. `null` in a listing. */
  day: RewardsDay | null;
  /** The liquidity scored in all, as an exact decimal text (share-seconds). `null` in a listing. */
  totalScoredLiquidity: string | null;
  /** What the group scored and paid over its life, per currency. `null` in a listing. */
  lifetime: RewardLifetime[] | null;
};

function productOf(raw: RawGroupProduct | null): RewardGroupProduct | null {
  return raw === null
    ? null
    : { name: raw.name, slug: raw.slug, path: [...raw.path] };
}

/**
 * Maps a Pulse group, from a listing or in full, to the {@link RewardGroup} model.
 *
 * @throws {UnexpectedResponseError} When a time in milliseconds is not a time.
 * @internal
 */
export function toRewardGroup(
  raw: RawRewardsGroup | RawRewardsGroupDetail,
): RewardGroup {
  const detail = 'current_epoch' in raw;
  return {
    groupId: raw.group_id,
    active: raw.active,
    product: productOf(raw.product),
    activeMarkets: raw.member_markets_today,
    programmes: programmesOf(raw),
    bonuses: bonusesOf(raw),
    day: detail
      ? dayOf(
          raw.current_epoch,
          raw.current_epoch_open_ms,
          raw.current_epoch_close_ms,
        )
      : null,
    totalScoredLiquidity: detail ? raw.total_scored_liquidity : null,
    lifetime: detail ? raw.lifetime_by_currency.map(lifetimeOf) : null,
  };
}

// ---------------------------------------------------------------------------
// A market's rewards
// ---------------------------------------------------------------------------

/** The rewards of one market: its programmes, the day in progress and what it paid so far. */
export type MarketRewardsDetails = {
  /** The market's id on the order book. */
  conditionId: ConditionId;
  /** Whether the market's rewards are active. */
  active: boolean;
  /** The programme in each currency, `CP` first. */
  programmes: RewardProgramme[];
  /** The bonus windows: live, scheduled, then ended. */
  bonuses: RewardBonus[];
  /** The day in progress. */
  day: RewardsDay;
  /** The liquidity scored in all, as an exact decimal text (share-seconds). */
  totalScoredLiquidity: string;
  /** What the market scored and paid over its life, per currency. */
  lifetime: RewardLifetime[];
};

/**
 * Maps the rewards of a market to the {@link MarketRewardsDetails} model.
 *
 * @throws {UnexpectedResponseError} When a time in milliseconds is not a time.
 * @internal
 */
export function toMarketRewardsDetails(
  raw: RawRewardsMarket,
): MarketRewardsDetails {
  return {
    conditionId: conditionIdOf(raw.market_id),
    active: raw.active,
    programmes: programmesOf(raw),
    bonuses: bonusesOf(raw),
    day: dayOf(
      raw.current_epoch,
      raw.current_epoch_open_ms,
      raw.current_epoch_close_ms,
    ),
    totalScoredLiquidity: raw.total_scored_liquidity,
    lifetime: raw.lifetime_by_currency.map(lifetimeOf),
  };
}

/** A maker's share of a market's reward day. */
export type RewardsMaker = {
  /** The maker's wallet. */
  wallet: Address;
  /** The maker's liquidity score for the day, as an exact decimal text. */
  score: string;
  /** The score as a fraction of the market's total, from `"0"` to `"1"`. */
  scoreShare: string;
  /** What the maker earns for the day, in the rail's currency. */
  effective: DecimalString;
  /** What was allocated to the maker, in the rail's currency. */
  allocated: DecimalString;
  /** What has been paid so far, in the rail's currency. `null` before settlement. */
  credited: DecimalString | null;
  /** Where the maker's payout stands. */
  status: RewardPayoutStatus;
};

/** One currency's side of a market's reward day. */
export type RewardsEpochRail = {
  /** The currency. */
  currency: RewardCurrency;
  /** The day's pool, in `currency`. `null` where the market has no programme that day. */
  pool: DecimalString | null;
  /** Where the day is. */
  status: RewardDayStatus | null;
  /** The liquidity score of all makers, as an exact decimal text. */
  totalScore: string;
  /** How many makers scored. */
  makerCount: number;
  /** What was allocated to makers, in `currency`. */
  allocated: DecimalString;
  /** What has been paid, in `currency`. `null` before settlement. */
  credited: DecimalString | null;
  /** Whether the figures are a live projection of the open day. */
  projected: boolean;
  /** How fresh the projection is, as an ISO 8601 time. `null` for a day that is not projected. */
  projectedThrough: string | null;
  /** The makers with the highest scores. */
  makers: RewardsMaker[];
};

/** A market's reward day: one rail per currency. */
export type MarketRewardsEpoch = {
  /** The market's id on the order book. */
  conditionId: ConditionId;
  /** The day. */
  day: RewardsDay;
  /** One entry per currency in the answer, `CP` first. */
  rails: RewardsEpochRail[];
  /** The currencies the answer leaves out. */
  omittedRails: RewardCurrency[];
  /** Whether only a bonus window paid that day. */
  bonusOnly: boolean;
};

/**
 * Maps a maker of a market's reward day to the {@link RewardsMaker} model, for either
 * currency.
 *
 * @internal
 */
export function toRewardsMaker(raw: RawMaker | RawUsdcMaker): RewardsMaker {
  const usdc = 'effective_usdc' in raw;
  return {
    wallet: addressOf(raw.user_id),
    score: raw.score,
    scoreShare: raw.score_share,
    effective: usdc ? raw.effective_usdc : raw.effective_cp,
    allocated: usdc ? raw.allocated_usdc : raw.allocated_cp,
    credited: usdc ? raw.credited_usdc : raw.credited_cp,
    status: raw.status,
  };
}

function projectedThroughOf(ms: number | null | undefined): string | null {
  return ms == null
    ? null
    : requireIsoFromMilliseconds(ms, 'rail.projectedThrough');
}

/**
 * Maps a market's reward day to the {@link MarketRewardsEpoch} model.
 *
 * @throws {UnexpectedResponseError} When a time in milliseconds is not a time.
 * @internal
 */
export function toMarketRewardsEpoch(
  raw: RawRewardsMarketEpoch,
): MarketRewardsEpoch {
  const rails: RewardsEpochRail[] = [
    {
      currency: 'CP',
      pool: raw.pool,
      status: raw.status,
      totalScore: raw.total_score,
      makerCount: raw.maker_count,
      allocated: raw.allocated_cp,
      credited: raw.credited_cp,
      projected: raw.projected ?? false,
      projectedThrough: projectedThroughOf(raw.projected_through_ms),
      makers: raw.top_makers.map(toRewardsMaker),
    },
  ];
  if (
    raw.total_score_usdc !== undefined &&
    raw.maker_count_usdc !== undefined &&
    raw.allocated_usdc !== undefined
  ) {
    rails.push({
      currency: 'USDC',
      pool: raw.pool_usdc ?? null,
      status: raw.status_usdc ?? null,
      totalScore: raw.total_score_usdc,
      makerCount: raw.maker_count_usdc,
      allocated: raw.allocated_usdc,
      credited: raw.credited_usdc ?? null,
      projected: raw.projected_usdc ?? false,
      projectedThrough: projectedThroughOf(raw.projected_through_ms_usdc),
      makers: (raw.top_makers_usdc ?? []).map(toRewardsMaker),
    });
  }
  return {
    conditionId: conditionIdOf(raw.market_id),
    day: dayOf(raw.epoch, raw.day_open_ms, raw.day_close_ms),
    rails,
    omittedRails: [...(raw.omitted_rails ?? [])],
    bonusOnly: raw.bonus_only ?? false,
  };
}

// ---------------------------------------------------------------------------
// Scored orders
// ---------------------------------------------------------------------------

/** How an order that scored ended. */
export type RewardsOrderExit = 'filled' | 'cancelled' | (string & {});

/**
 * An order that was scored for rewards on a day.
 *
 * The same model serves a market's orders (which name the `maker`) and the account's own
 * (which name the `conditionId`, the payouts per currency and how the order is scoring);
 * the fields only one of them has are `null` on the other.
 */
export type RewardsOrder = {
  /** The order's id. */
  orderId: string;
  /** The market's id on the order book. `null` in a market's list: the market is the one asked for. */
  conditionId: ConditionId | null;
  /** The wallet that placed the order. `null` in the account's own list. */
  maker: Address | null;
  /** The outcome the order is for, such as `Yes`. */
  outcome: string;
  /** Whether the order buys or sells. */
  side: OrderSide;
  /** The order's limit price in dollars between 0 and 1. */
  price: DecimalString;
  /** The order's liquidity score, as an exact decimal text. */
  score: string;
  /** The order's share of its maker's score, as an exact decimal text from `"0"` to `"1"`. */
  scoreShare: string;
  /** What the order earns, per currency. */
  payouts: RewardAmount[];
  /** How long the order qualified, in milliseconds. */
  eligibleMs: number;
  /** When the order was first seen on the day, as an ISO 8601 time. */
  firstSeenAt: string;
  /** When the order was last seen on the day, as an ISO 8601 time. */
  lastSeenAt: string;
  /** When the order was placed, as an ISO 8601 time. */
  createdAt: string;
  /** The order's size at the start of the day, in shares. */
  openingSize: DecimalString;
  /** The order's size at the end of the day, in shares. */
  closingSize: DecimalString;
  /** How the order ended. `null` while it still rests. */
  exit: RewardsOrderExit | null;
  /** Whether the order has a score yet: an order that was just placed shows a placeholder score of 0 until it is scored. */
  scored: boolean;
  /** Whether the figures are a live projection. `null` in a market's list. */
  projected: boolean | null;
  /** The Pulse group the order's market belongs to. `null` for an ordinary market, and in a market's list. */
  groupId: string | null;
  /** `scoring`, `previously_scored` or `not_scoring`. `null` in a market's list. */
  scoring:
    | 'scoring'
    | 'previously_scored'
    | 'not_scoring'
    | (string & {})
    | null;
};

function sideOf(raw: string): OrderSide {
  if (raw === 'Buy') {
    return OrderSide.BUY;
  }
  return raw === 'Sell' ? OrderSide.SELL : (raw.toUpperCase() as OrderSide);
}

/** The pieces of a scored order that both kinds of order have. */
function orderCommon(
  raw: RawMarketOrder | RawMakerOrder,
): Omit<
  RewardsOrder,
  | 'conditionId'
  | 'maker'
  | 'payouts'
  | 'scored'
  | 'projected'
  | 'groupId'
  | 'scoring'
> {
  return {
    orderId: raw.order_id,
    outcome: raw.outcome,
    side: sideOf(raw.side),
    price: priceOfTick(raw.price_tick, 'price'),
    score: raw.score,
    scoreShare: raw.maker_score_share,
    eligibleMs: raw.eligible_ms,
    firstSeenAt: requireIsoFromMilliseconds(raw.first_seen_ms, 'firstSeenAt'),
    lastSeenAt: requireIsoFromMilliseconds(raw.last_seen_ms, 'lastSeenAt'),
    createdAt: requireIsoFromMilliseconds(raw.created_at_ms, 'createdAt'),
    openingSize: wholeUnitsOf(raw.opening_size_micro, 'openingSize', 'backend'),
    closingSize: wholeUnitsOf(raw.closing_size_micro, 'closingSize', 'backend'),
    exit: raw.exit_kind,
  };
}

/**
 * Maps a scored order from a market's list of orders to the {@link RewardsOrder} model.
 *
 * @throws {UnexpectedResponseError} When a tick, a time or a size is not what it should be.
 * @internal
 */
export function toMarketRewardsOrder(raw: RawMarketOrder): RewardsOrder {
  return {
    ...orderCommon(raw),
    conditionId: null,
    maker: addressOf(raw.maker),
    payouts: [{ currency: 'CP', amount: raw.effective_cp }],
    scored: true,
    projected: null,
    groupId: null,
    scoring: null,
  };
}

/**
 * Maps a scored order from the account's own list of orders to the {@link RewardsOrder}
 * model.
 *
 * @throws {UnexpectedResponseError} When a tick, a time or a size is not what it should be.
 * @internal
 */
export function toUserRewardsOrder(raw: RawMakerOrder): RewardsOrder {
  return {
    ...orderCommon(raw),
    conditionId: conditionIdOf(raw.market_id),
    maker: null,
    payouts: raw.payouts.map(amountOf),
    scored: !raw.unscored,
    projected: raw.projected,
    groupId: raw.group_id,
    scoring: raw.scoring_status,
  };
}

// ---------------------------------------------------------------------------
// A wallet's rewards
// ---------------------------------------------------------------------------

/** A lifetime total and what was paid today. */
export type UserRewardsTotal = {
  /** All that was paid or credited. */
  lifetime: DecimalString;
  /** What was paid or credited today. This is only what has settled; the day in progress is `currentDay`. */
  today: DecimalString;
};

/** What a wallet has earned on the open day, with its projection. */
export type UserRewardsDay = {
  /** What was allocated to the wallet for the open day. */
  allocated: DecimalString;
  /** What the wallet has earned so far on the open day. */
  effective: DecimalString;
  /** What was already paid for the day. */
  paid: DecimalString;
  /** The projected payout before settlement. `null` when there is no projection. */
  estimate: DecimalString | null;
  /** What was credited, once the day is over. `null` before that. */
  credited: DecimalString | null;
  /** Whether the figures are a live projection. */
  projected: boolean;
  /** How fresh the projection is, as an ISO 8601 time. `null` when there is no projection. */
  projectedThrough: string | null;
  /** Where the day's payout stands. `null` when XO gives no status. */
  status: RewardPayoutStatus | null;
  /** The part of `effective` that comes from the base programme. */
  baseAmount: DecimalString | null;
  /** The part of `effective` that comes from bonus windows. */
  bonusAmount: DecimalString | null;
};

/** A wallet's `USDC` rewards. Every figure is rounded to two decimals, in dollars. */
export type UserUsdcRewards = {
  /** Maker rebates and liquidity rewards, all time. */
  totalReceived: DecimalString;
  /** Maker rebates. */
  makerRebates: UserRewardsTotal;
  /** Rewards for resting orders. */
  liquidityRewards: UserRewardsTotal;
  /** The open day. */
  currentDay: UserRewardsDay;
};

/** A wallet's `CP` rewards. Every figure is rounded to two decimals. */
export type UserCpRewards = {
  /** Liquidity points credited, all time. */
  totalReceived: DecimalString;
  /** Points for resting orders. */
  liquidity: UserRewardsTotal;
  /** Creator bonus points, all time. */
  creatorBonus: DecimalString;
  /** The open day. */
  currentDay: UserRewardsDay;
};

/** What a wallet has earned from liquidity rewards. */
export type UserRewards = {
  /** Whether the wallet is flagged by the programme's enforcement. */
  flagged: boolean;
  /** The day the figures are drawn for. */
  day: RewardsDay;
  /** The `USDC` rewards. `null` when XO has no account for the wallet. */
  usdc: UserUsdcRewards | null;
  /** The `CP` rewards. `null` when XO has no account for the wallet. */
  cp: UserCpRewards | null;
};

function totalOf(raw: RawSummaryAmount): UserRewardsTotal {
  return { lifetime: raw.lifetime, today: raw.today };
}

function userDayOf(raw: RawSummaryEpoch): UserRewardsDay {
  return {
    allocated: raw.allocated,
    effective: raw.effective,
    paid: raw.paid,
    estimate: raw.estimate,
    credited: raw.credited,
    projected: raw.projected ?? false,
    projectedThrough: projectedThroughOf(raw.projectedThroughMs),
    status: raw.status ?? null,
    baseAmount: raw.baseAmount,
    bonusAmount: raw.bonusAmount,
  };
}

/**
 * Maps a wallet's rewards summary to the {@link UserRewards} model.
 *
 * @throws {UnexpectedResponseError} When a time in milliseconds is not a time.
 * @internal
 */
export function toUserRewards(raw: RawWalletSummary): UserRewards {
  const { me } = raw;
  return {
    flagged: raw.flagged,
    day: dayOf(raw.meta.currentEpoch, raw.meta.dayOpenMs, raw.meta.dayCloseMs),
    usdc:
      me === null
        ? null
        : {
            totalReceived: me.usdc.totalReceived,
            makerRebates: totalOf(me.usdc.makerRebates),
            liquidityRewards: totalOf(me.usdc.liquidityRewards),
            currentDay: userDayOf(me.usdc.currentEpoch),
          },
    cp:
      me === null
        ? null
        : {
            totalReceived: me.cp.totalReceived,
            liquidity: totalOf(me.cp.liquidity),
            creatorBonus: me.cp.creatorBonus.lifetime,
            currentDay: userDayOf(me.cp.currentEpoch),
          },
  };
}

/** One market's line of a wallet's reward day. */
export type UserRewardsEpochMarket = {
  /** The market's id on the order book. */
  conditionId: ConditionId;
  /** What the amounts are in. */
  currency: RewardCurrency;
  /** The wallet's liquidity score on the market, as an exact decimal text. */
  score: string;
  /** The score as a fraction of the market's total, from `"0"` to `"1"`. */
  scoreShare: string;
  /** What the wallet earns, in `currency`. */
  effective: DecimalString;
  /** What was allocated to the wallet, in `currency`. */
  allocated: DecimalString;
  /** What has been paid so far, in `currency`. `null` before settlement. */
  credited: DecimalString | null;
  /** Where the payout stands. */
  status: RewardPayoutStatus;
};

/** A wallet's reward day across every market. */
export type UserRewardsEpoch = {
  /** The wallet. */
  wallet: Address;
  /** The day. */
  day: RewardsDay;
  /** Whether the wallet is flagged by the programme's enforcement. */
  flagged: boolean;
  /** What the wallet earns for the day, in `CP`, over all markets. */
  effectiveCp: DecimalString;
  /** What was allocated to the wallet, in `CP`. */
  allocatedCp: DecimalString;
  /** What has been paid so far, in `CP`. `null` before settlement. */
  creditedCp: DecimalString | null;
  /** The markets the wallet scored on. */
  markets: UserRewardsEpochMarket[];
  /** The XO user behind the wallet. `null` for a wallet with no XO account. */
  user: RewardsUserProfile | null;
};

/**
 * Maps a wallet's reward day to the {@link UserRewardsEpoch} model.
 *
 * @throws {UnexpectedResponseError} When a time in milliseconds is not a time.
 * @internal
 */
export function toUserRewardsEpoch(raw: RawWalletEpoch): UserRewardsEpoch {
  return {
    wallet: addressOf(raw.user_id),
    day: dayOf(raw.epoch, raw.day_open_ms, raw.day_close_ms),
    flagged: raw.flagged,
    effectiveCp: raw.effective_cp,
    allocatedCp: raw.allocated_cp,
    creditedCp: raw.credited_cp,
    markets: raw.markets.map((market) => ({
      conditionId: conditionIdOf(market.market_id),
      currency: market.currency,
      score: market.score,
      scoreShare: market.score_share,
      effective: market.effective_cp,
      allocated: market.allocated_cp,
      credited: market.credited_cp,
      status: market.status,
    })),
    user: raw.user == null ? null : profileOf(raw.user),
  };
}

// ---------------------------------------------------------------------------
// The leaderboard
// ---------------------------------------------------------------------------

/** A maker on the liquidity leaderboard, with the profile of its wallet when it has one. */
export type RewardsLeaderboardEntry = {
  /** The maker's rank. */
  rank: number;
  /** The maker's wallet. */
  wallet: Address;
  /** XO's id for the maker. `null` for a wallet with no XO account. */
  userId: string | null;
  /** The maker's unique name. */
  username: string | null;
  /** The maker's display name. */
  name: string | null;
  /** The maker's picture. */
  profileImage: string | null;
  /** The effective conviction points the maker earned in the period. */
  liquidityCp: DecimalString;
  /** The conviction points credited for the period. */
  creditedCp: DecimalString;
  /** On how many market-days the maker earned in the period. */
  marketDays: number;
  /** Whether the maker is verified. */
  verifiedBadge: boolean;
  /** Whether the maker holds the OG role (the top 5% of the daily leaderboard). */
  isOg: boolean;
  /** The keys of the badges the maker earned. */
  achievements: string[];
  /** The maker's conviction points, as an exact decimal. */
  convictionPoints: DecimalString;
  /** The maker's tier, such as `Believer`. */
  tier: string;
};

/** Where the account stands on the liquidity leaderboard. */
export type RewardsLeaderboardStanding = {
  /** The account's rank. */
  rank: number;
  /** The account's wallet. */
  wallet: Address;
  /** The effective conviction points the account earned in the period. */
  liquidityCp: DecimalString;
  /** The conviction points credited for the period. */
  creditedCp: DecimalString;
  /** On how many market-days the account earned in the period. */
  marketDays: number;
};

/**
 * Maps a row of the liquidity leaderboard to the {@link RewardsLeaderboardEntry} model.
 *
 * @internal
 */
export function toRewardsLeaderboardEntry(
  raw: RawLeaderboardRow,
): RewardsLeaderboardEntry {
  return {
    rank: raw.rank,
    wallet: addressOf(raw.walletAddress),
    userId: raw.id === null ? null : String(raw.id),
    username: raw.username,
    name: raw.name,
    profileImage: raw.profilePictureUrl,
    liquidityCp: raw.liquidityCp,
    creditedCp: raw.creditedCp,
    marketDays: raw.marketDays,
    verifiedBadge: raw.verified,
    isOg: raw.isOg,
    achievements: [...raw.achievements],
    convictionPoints: numberToDecimal(raw.cpPoints, 'convictionPoints'),
    tier: raw.tier,
  };
}

/**
 * Maps the account's row of the liquidity leaderboard to the
 * {@link RewardsLeaderboardStanding} model.
 *
 * @internal
 */
export function toRewardsLeaderboardStanding(
  raw: RawLeaderboardRow,
): RewardsLeaderboardStanding {
  return {
    rank: raw.rank,
    wallet: addressOf(raw.walletAddress),
    liquidityCp: raw.liquidityCp,
    creditedCp: raw.creditedCp,
    marketDays: raw.marketDays,
  };
}
