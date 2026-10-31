// Response schemas of the liquidity-rewards routes (`/public/liquidity-rewards` and
// `/liquidity-rewards`). The conventions are those of `schemas.ts`.
//
// **The case of a field is the backend's, and it is not one case.** Some answers are the
// backend's own presenters (camelCase: the earning pools, the wallet summary, the XO profile,
// the leaderboard, the market-day order markets); the rest are what the rewards service sends
// and the backend passes through (snake_case: configs, epochs, makers, orders, programmes). One
// payload can mix them (`opening_size_micro` and `openingSizeShares` are on the same order).
// Nothing is renamed: a field is read where the backend wrote it.
//
// **Money.** A reward, pool, budget, payout or price is a whole-unit `DecimalString` (CP and
// USDC both: `"68.75"`, `"1004.000000"`), whether it is a bare string or a `{ amount, currency }`.
// A size in micro-shares (`opening_size_micro`, `sizeMicro`, `totalMicroShares`) is a
// `RawUnitsString`: `"1000000000"` is 1,000 shares. A JSON number in a money field is converted
// exactly; a string is kept as it is.
//
// **Scores and shares of the pot are not money.** A `score` (the maker's integral of liquidity
// over time, in micro-share-seconds), a `score_share` (a fraction of the pot) and
// `total_scored_liquidity` are exact decimals that do not fit a float
// (`"385300915998620.312037"` has 21 digits): they are kept as the text the backend sends, typed
// `string`. What the backend sends as a JSON number (counts, ticks, ranks, milliseconds, ids, the
// share counts `openingSizeShares`, a profile's `cpPoints`) stays a number.
//
// **Not money, so not a `DecimalString`.** `maxDistanceCents` (`"5"`, cents from the midpoint),
// `singleSidedFactor` (`"3"`, a multiplier) and `estimatedApr` (`"3664600.00"`, a percent) are
// scoring parameters and a rate, not amounts of CP or USDC: the brand would say "whole-unit
// money" about numbers that are none. They stay plain `string`, as the backend sends them
// (`estimatedApr` is `null` for CP, with `estimatedAprUnavailableReason: "not_applicable_for_cp"`).
// The band (`twoSidedBandLow`/`High`) and `maxAvgPrice` are probabilities between 0 and 1, which
// `DecimalString` does cover.
//
// **"Today's earnings" is two different things.** The summary's `today` fields are what has
// been *settled* today (`today_credited` for CP, `today_paid` for USDC), not what the open day
// has accrued. The live accrual of the day in progress is `currentEpoch.effective` and
// `currentEpoch.estimate` of each rail: see {@link RewardsSummaryAmount} and
// {@link RewardsWalletSummary}.
//
// The schemas follow the backend's answers and are checked against live responses. The rewards
// service can send a field before the backend lists it, so a few such fields are there too, as
// optional (`projected`, `estimated_apr_basis`, `terms_set_at`…).

import { z } from 'zod';
import {
  defineSchema,
  type EnumFactory,
  type ObjFactory,
} from '../core/schema';
import type { DecimalString, RawUnitsString } from '../core/types';
import {
  decimalString,
  type PageMeta,
  pageMetaSchema,
  rawUnits,
} from './schemas';

/** An exact number kept as the text the backend sent: a score, a share of the pot. Not money. */
const exactText: z.ZodType<string> = decimalString;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

const CURRENCIES = ['CP', 'USDC'] as const;
const PROGRAM_STATUSES = ['SCHEDULED', 'LIVE', 'ENDED'] as const;
const INACTIVE_REASONS = [
  'reward_disabled',
  'no_daily_pool',
  'outside_program_window',
  'budget_exhausted',
  'before_term',
  'window_elapsed',
  'not_configured',
  'misconfigured',
] as const;
const PAYOUT_STATUSES = [
  'pending',
  'paid',
  'dropped_below_min',
  'dropped_flagged',
  'failed_transfer',
  'none',
  'projected',
] as const;
const DAY_STATUSES = ['scored', 'settling', 'settled', 'projected'] as const;
const EXIT_KINDS = ['filled', 'cancelled'] as const;
const WINDOW_STATES = [
  'waiting_for_window',
  'accruing',
  'no_longer_accruing',
] as const;
const SCORING_STATUSES = [
  'scoring',
  'previously_scored',
  'not_scoring',
] as const;
const LIVE_STATUSES = [
  'applied',
  'partial',
  'unavailable',
  'not_configured',
  'closed_day',
] as const;
const BONUS_KINDS = ['IN_GAME', 'EVENT', 'AD_HOC'] as const;
const BONUS_STATUSES = ['LIVE', 'SCHEDULED', 'ENDED'] as const;
const LEADERBOARD_PERIODS = ['daily', 'weekly', 'seasonal'] as const;

/** A reward rail. Other values the backend may add later are kept (see `EnumFactory`). */
export type RewardsRail = (typeof CURRENCIES)[number] | (string & {});
/** Where a rewards programme is in its life. Other values the backend may add later are kept. */
export type RewardsProgramStatus =
  | (typeof PROGRAM_STATUSES)[number]
  | (string & {});
/** Why a reward rail does not pay today (`inactiveReason`). Other values the backend may add later are kept. */
export type RewardsInactiveReason =
  | (typeof INACTIVE_REASONS)[number]
  | (string & {});
/** Where a maker's day sits in the payout: `'paid'` once credited, `'projected'` while open. */
export type RewardsPayoutStatus =
  | (typeof PAYOUT_STATUSES)[number]
  | (string & {});
/** Where a rewards day is: scored, settling, settled or projected. Other values the backend may add later are kept. */
export type RewardsDayStatus = (typeof DAY_STATUSES)[number] | (string & {});
/** How a rewarded order ended (`exit_kind`): filled or cancelled. Other values the backend may add later are kept. */
export type RewardsExitKind = (typeof EXIT_KINDS)[number] | (string & {});

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** A reward amount in whole units of its rail: `{ amount: "68.75", currency: "CP" }`. */
export interface RewardAmount {
  amount: DecimalString;
  currency: RewardsRail;
}

const amountSchema = (obj: ObjFactory, enumOf: EnumFactory) =>
  obj({ amount: decimalString, currency: enumOf(CURRENCIES) });

/** The XO profile of a wallet's owner, attached to the wallet routes (`null` for a stranger). */
export interface RewardsUser {
  id: number;
  username: string;
  name: string | null;
  profilePictureUrl: string | null;
  roosterColor: string | null;
  verified: boolean;
  achievements: string[];
  cpPoints: number;
  tier: string;
}

const userSchema = (obj: ObjFactory) =>
  obj({
    id: z.number(),
    username: z.string(),
    name: z.string().nullable(),
    profilePictureUrl: z.string().nullable(),
    roosterColor: z.string().nullable(),
    verified: z.boolean(),
    achievements: z.array(z.string()),
    cpPoints: z.number(),
    tier: z.string(),
  });

/** A bonus window as the rewards service sends it (config, market and group detail): snake_case. */
export interface RewardsBonusWindow {
  window_id: string;
  currency: RewardsRail;
  /** `LIVE` in `active_bonus`, `SCHEDULED` in `upcoming_bonus`, `ENDED` in `ended_bonus`. */
  status: 'LIVE' | 'SCHEDULED' | 'ENDED' | (string & {});
  /** The whole window's pool as written; a stop never changes it. */
  amount: RewardAmount;
  /** Still on offer from now to the effective end; zero on an ended window. */
  remaining: RewardAmount;
  /** The part of `amount` offered inside the current UTC day. */
  today_pool: RewardAmount;
  starts_at_ms: number;
  starts_at: string;
  ends_at_ms: number;
  ends_at: string;
  stopped_at_ms: number | null;
  stopped_at: string | null;
  label: string | null;
  kind: 'IN_GAME' | 'EVENT' | 'AD_HOC' | (string & {}) | null;
  allocation_method: string;
}

const bonusWindowSchema = (obj: ObjFactory, enumOf: EnumFactory) =>
  obj({
    window_id: z.string(),
    currency: enumOf(CURRENCIES),
    status: enumOf(BONUS_STATUSES),
    amount: amountSchema(obj, enumOf),
    remaining: amountSchema(obj, enumOf),
    today_pool: amountSchema(obj, enumOf),
    starts_at_ms: z.number(),
    starts_at: z.string(),
    ends_at_ms: z.number(),
    ends_at: z.string(),
    stopped_at_ms: z.number().nullable(),
    stopped_at: z.string().nullable(),
    label: z.string().nullable(),
    kind: enumOf(BONUS_KINDS).nullable(),
    allocation_method: z.string(),
  });

/** The three bonus lists a target (market, group) carries. */
export interface RewardsBonusLists {
  active_bonus?: RewardsBonusWindow[];
  upcoming_bonus?: RewardsBonusWindow[];
  ended_bonus?: RewardsBonusWindow[];
}

const bonusListsShape = (obj: ObjFactory, enumOf: EnumFactory) => ({
  active_bonus: z.array(bonusWindowSchema(obj, enumOf)).optional(),
  upcoming_bonus: z.array(bonusWindowSchema(obj, enumOf)).optional(),
  ended_bonus: z.array(bonusWindowSchema(obj, enumOf)).optional(),
});

// ---------------------------------------------------------------------------
// Earning pools (the backend's presenter: camelCase)
// ---------------------------------------------------------------------------

/** The live book of one outcome of a market, as the earning pool carries it. */
export interface EarningPoolBook {
  /** The outcome's title: `Yes` or `No`, or a name on a multi-outcome market. */
  outcome: string;
  /** Engine ticks (1 tick = 0.001), `null` for an empty side. */
  bestBid: number | null;
  bestAsk: number | null;
  restingLevels: number;
  /** All resting size of the book, in micro-shares. */
  totalMicroShares: RawUnitsString;
  bids: Array<{ priceTick: number; sizeMicro: RawUnitsString }>;
  asks: Array<{ priceTick: number; sizeMicro: RawUnitsString }>;
}

/** The market of an earning pool. */
export interface EarningPoolMarket {
  title: string | null;
  contractMarketId: string | null;
  /** The market's condition id: what every `conditionId` argument of `rewards` takes. */
  conditionId: string | null;
  status: string | null;
  category?: string | null;
  eventId?: string | null;
  eventSlug?: string | null;
  rootEventSlug?: string | null;
  /** The market's numeric database id. */
  id?: number | null;
  slug?: string | null;
  imageUrl?: string | null;
  /** The market type code (0 standard, 1 pulse, 2 CLOB, 3 CLOB pulse, 4 conviction). */
  type?: number | null;
  expiresAt?: string | null;
  outcomes?: Array<{
    outcomeTokenId: string;
    index: number;
    title: string | null;
  }> | null;
  /** The Yes and No mids from the live book, 0 to 1. `null` before the book lands. */
  prices?: { yes: DecimalString; no: DecimalString } | null;
  bookSnapshot?: {
    isFlush: boolean;
    books: EarningPoolBook[];
    sourceSeq?: number;
  } | null;
  bookSnapshotUpdatedAt?: string | null;
}

/** The epoch a CP rail is accruing in (the day in progress). */
export interface EarningPoolCpEpoch {
  epoch: number;
  dayOpenMs: number;
  dayCloseMs: number;
  currency: string | null;
  pool: DecimalString | null;
  status: string | null;
  totalScore: string;
  makerCount: number;
  allocatedCp: DecimalString;
  creditedCp: DecimalString | null;
}

/** The terms and the schedule that the CP and USDC rails of an earning pool share. */
export interface EarningPoolRailTerms {
  configured: boolean;
  eligible: boolean;
  /**
   * Cents from the midpoint within which a resting order scores. A parameter, not an amount, so
   * plain text like `singleSidedFactor` (see the header of this file).
   */
  maxDistanceCents: string | null;
  /** Resting-time gate in milliseconds. */
  minOrderRestMs: number | null;
  /** Deprecated: `minOrderRestMs` rounded up to whole seconds. */
  minOrderRestSeconds: number | null;
  minOrderSizeShares: number | null;
  minPayout: DecimalString | null;
  /** The scoring band, as probabilities. */
  twoSidedBandLow: DecimalString | null;
  twoSidedBandHigh: DecimalString | null;
  /** The multiplier on a one-sided order's score. A parameter: plain text. */
  singleSidedFactor: string | null;
  /** Near-resolved guard: midpoints above it (or below 1 minus it) score 0. */
  maxAvgPrice?: DecimalString | null;
  /** When the rail started scoring (ms), `null` before the first payout. */
  programStartsAtMs?: number | null;
  programStartsAt?: string | null;
  /** The forecast end of scoring. */
  programEndsAtMs?: number | null;
  programEndsAt?: string | null;
  programStatus?: RewardsProgramStatus | null;
  /** Whether the rail pays today. */
  active?: boolean | null;
  inactiveReason?: RewardsInactiveReason | null;
  /** The configured daily rate before today's fee credits. */
  baseDailyPool?: DecimalString | null;
  budgetRemaining?: DecimalString | null;
  durationDays?: number | null;
  daysRemaining?: number | null;
}

/** The conviction-points rail of an earning pool. */
export interface EarningPoolCp extends EarningPoolRailTerms {
  rewardEnabled: boolean;
  tierName: string | null;
  currency: string | null;
  /** The daily pool, in CP: the base rate plus today's fee credits. */
  dailyPool: DecimalString | null;
  /** The whole programme's budget. */
  budgetTotal?: DecimalString | null;
  /**
   * An annualised rate in percent. A rate, not an amount: plain text. Always `null` for CP
   * (`estimatedAprUnavailableReason` is then `"not_applicable_for_cp"`).
   */
  estimatedApr?: string | null;
  estimatedAprUnavailableReason?: string | null;
  currentEpoch?: EarningPoolCpEpoch | null;
}

/** The USDC rail of an earning pool. */
export interface EarningPoolUsdc extends EarningPoolRailTerms {
  /** USDC held in escrow for the programme. */
  escrowed: DecimalString | null;
  /** USDC paid out so far. */
  distributed: DecimalString | null;
  /** The daily rate, in USDC. */
  dailyRate: DecimalString | null;
  budgetTotal?: DecimalString | null;
  /**
   * The estimated annual rate in percent (the pool against the liquidity it attracts). A rate,
   * not an amount: plain text (`"3664600.00"`).
   */
  estimatedApr: string | null;
  estimatedAprUnavailableReason?: string | null;
}

/** A bonus window of an earning pool: the backend's presenter, camelCase, amounts in text. */
export interface EarningPoolBonusWindow {
  windowId: string;
  currency: RewardsRail;
  status: 'LIVE' | 'SCHEDULED' | 'ENDED' | (string & {});
  /** The whole window's pool as written. */
  amount: DecimalString;
  remaining: DecimalString;
  /** The part of `amount` offered inside the current UTC day. */
  todayPool: DecimalString;
  startsAtMs: number;
  startsAt: string;
  endsAtMs: number;
  endsAt: string;
  stoppedAtMs?: number | null;
  stoppedAt?: string | null;
  label?: string | null;
  kind?: 'IN_GAME' | 'EVENT' | 'AD_HOC' | (string & {}) | null;
  allocationMethod: string;
}

/** One market (or Pulse window) of the earnings page, with its CP and USDC rails. */
export interface EarningPool {
  /** The market's condition id. On a Pulse group row, the window accruing now. */
  marketId: string;
  market?: EarningPoolMarket | null;
  cp?: EarningPoolCp | null;
  usdc?: EarningPoolUsdc | null;
  /** Set on a Pulse group row: the daily pool is the group's shared pot. */
  group?: { groupId: string; activeFromMs: number; activeToMs: number } | null;
  activeBonus: EarningPoolBonusWindow[];
  upcomingBonus: EarningPoolBonusWindow[];
  endedBonus: EarningPoolBonusWindow[];
}

/** The epoch the earnings page is drawn for. */
export interface EarningPoolsMeta {
  itemCount: number;
  /** The UTC-day index of today. */
  currentEpoch: number;
  dayOpenMs: number;
  dayCloseMs: number;
  /** Milliseconds until the day closes. */
  endsInMs: number;
}

/** The answer of the earning pools route: the pools and the epoch they are drawn for. */
export interface EarningPoolsPage {
  data: EarningPool[];
  meta: EarningPoolsMeta;
}

const earningPoolsMetaSchema = (obj: ObjFactory) =>
  obj({
    itemCount: z.number(),
    currentEpoch: z.number(),
    dayOpenMs: z.number(),
    dayCloseMs: z.number(),
    endsInMs: z.number(),
  });

const railTermsShape = (enumOf: EnumFactory) => ({
  configured: z.boolean(),
  eligible: z.boolean(),
  maxDistanceCents: z.string().nullable(),
  minOrderRestMs: z.number().nullable(),
  minOrderRestSeconds: z.number().nullable(),
  minOrderSizeShares: z.number().nullable(),
  minPayout: decimalString.nullable(),
  twoSidedBandLow: decimalString.nullable(),
  twoSidedBandHigh: decimalString.nullable(),
  singleSidedFactor: z.string().nullable(),
  maxAvgPrice: decimalString.nullish(),
  programStartsAtMs: z.number().nullish(),
  programStartsAt: z.string().nullish(),
  programEndsAtMs: z.number().nullish(),
  programEndsAt: z.string().nullish(),
  programStatus: enumOf(PROGRAM_STATUSES).nullish(),
  active: z.boolean().nullish(),
  inactiveReason: enumOf(INACTIVE_REASONS).nullish(),
  baseDailyPool: decimalString.nullish(),
  budgetRemaining: decimalString.nullish(),
  durationDays: z.number().nullish(),
  daysRemaining: z.number().nullish(),
});

const bookSchema = (obj: ObjFactory) =>
  obj({
    outcome: z.string(),
    bestBid: z.number().nullable(),
    bestAsk: z.number().nullable(),
    restingLevels: z.number(),
    totalMicroShares: rawUnits,
    bids: z.array(obj({ priceTick: z.number(), sizeMicro: rawUnits })),
    asks: z.array(obj({ priceTick: z.number(), sizeMicro: rawUnits })),
  });

const earningPoolSchema = (obj: ObjFactory, enumOf: EnumFactory) => {
  const bonus = obj({
    windowId: z.string(),
    currency: enumOf(CURRENCIES),
    status: enumOf(BONUS_STATUSES),
    amount: decimalString,
    remaining: decimalString,
    todayPool: decimalString,
    startsAtMs: z.number(),
    startsAt: z.string(),
    endsAtMs: z.number(),
    endsAt: z.string(),
    stoppedAtMs: z.number().nullish(),
    stoppedAt: z.string().nullish(),
    label: z.string().nullish(),
    kind: enumOf(BONUS_KINDS).nullish(),
    allocationMethod: z.string(),
  });
  return obj({
    marketId: z.string(),
    market: obj({
      title: z.string().nullable(),
      contractMarketId: z.string().nullable(),
      conditionId: z.string().nullable(),
      status: z.string().nullable(),
      category: z.string().nullish(),
      eventId: z.string().nullish(),
      eventSlug: z.string().nullish(),
      rootEventSlug: z.string().nullish(),
      id: z.number().nullish(),
      slug: z.string().nullish(),
      imageUrl: z.string().nullish(),
      type: z.number().nullish(),
      expiresAt: z.string().nullish(),
      outcomes: z
        .array(
          obj({
            outcomeTokenId: z.string(),
            index: z.number(),
            title: z.string().nullable(),
          }),
        )
        .nullish(),
      prices: obj({ yes: decimalString, no: decimalString }).nullish(),
      bookSnapshot: obj({
        isFlush: z.boolean(),
        books: z.array(bookSchema(obj)),
        sourceSeq: z.number().optional(),
      }).nullish(),
      bookSnapshotUpdatedAt: z.string().nullish(),
    }).nullish(),
    cp: obj({
      ...railTermsShape(enumOf),
      rewardEnabled: z.boolean(),
      tierName: z.string().nullable(),
      currency: z.string().nullable(),
      dailyPool: decimalString.nullable(),
      budgetTotal: decimalString.nullish(),
      estimatedApr: z.string().nullish(),
      estimatedAprUnavailableReason: z.string().nullish(),
      currentEpoch: obj({
        epoch: z.number(),
        dayOpenMs: z.number(),
        dayCloseMs: z.number(),
        currency: z.string().nullable(),
        pool: decimalString.nullable(),
        status: z.string().nullable(),
        totalScore: exactText,
        makerCount: z.number(),
        allocatedCp: decimalString,
        creditedCp: decimalString.nullable(),
      }).nullish(),
    }).nullish(),
    usdc: obj({
      ...railTermsShape(enumOf),
      escrowed: decimalString.nullable(),
      distributed: decimalString.nullable(),
      dailyRate: decimalString.nullable(),
      budgetTotal: decimalString.nullish(),
      estimatedApr: z.string().nullable(),
      estimatedAprUnavailableReason: z.string().nullish(),
    }).nullish(),
    group: obj({
      groupId: z.string(),
      activeFromMs: z.number(),
      activeToMs: z.number(),
    }).nullish(),
    activeBonus: z.array(bonus),
    upcomingBonus: z.array(bonus),
    endedBonus: z.array(bonus),
  });
};

export const EarningPoolsPageSchema = defineSchema<EarningPoolsPage>(
  (obj, enumOf) =>
    obj({
      data: z.array(earningPoolSchema(obj, enumOf)),
      meta: earningPoolsMetaSchema(obj),
    }),
);

// ---------------------------------------------------------------------------
// Market programmes: config and detail (the rewards service: snake_case)
// ---------------------------------------------------------------------------

/** One rail (CP or USDC) of a market's configuration. */
export interface RewardsProgramme {
  currency: RewardsRail;
  reward_enabled: boolean;
  /** Whether the rail pays today. */
  active: boolean;
  inactive_reason: RewardsInactiveReason | null;
  daily_pool: DecimalString | null;
  /** The whole programme's budget. */
  budget_total: DecimalString | null;
  duration_days: number | null;
  program_starts_at_ms: number | null;
  program_starts_at: string | null;
  program_ends_at_ms: number | null;
  program_ends_at: string | null;
  status: RewardsProgramStatus | null;
  /** Cents from the midpoint within which a resting order scores. */
  max_distance_cents: string;
  single_sided_factor: string;
  /** The scoring band, as probabilities. */
  two_sided_band_low: DecimalString;
  two_sided_band_high: DecimalString;
  max_avg_price?: DecimalString | null;
  /** Resting-time gate in milliseconds. */
  min_order_rest_ms: number;
  min_order_rest_seconds: number;
  min_order_size_shares: number;
  min_payout: DecimalString;
}

/**
 * A market's reward configuration (`markets/:marketId/config`): one programme per rail, the
 * Pulse group that pays it if any, and its bonus windows.
 */
export interface RewardsMarketConfig {
  /** The condition id. */
  market_id: string;
  /** The Pulse group whose programme pays this window; `null` for a standalone market. */
  group_id: string | null;
  programmes: RewardsProgramme[];
  active_bonus: RewardsBonusWindow[];
  upcoming_bonus: RewardsBonusWindow[];
  ended_bonus: RewardsBonusWindow[];
}

export const RewardsMarketConfigSchema = defineSchema<RewardsMarketConfig>(
  (obj, enumOf) =>
    obj({
      market_id: z.string(),
      group_id: z.string().nullable(),
      programmes: z.array(
        obj({
          currency: enumOf(CURRENCIES),
          reward_enabled: z.boolean(),
          active: z.boolean(),
          inactive_reason: enumOf(INACTIVE_REASONS).nullable(),
          daily_pool: decimalString.nullable(),
          budget_total: decimalString.nullable(),
          duration_days: z.number().nullable(),
          program_starts_at_ms: z.number().nullable(),
          program_starts_at: z.string().nullable(),
          program_ends_at_ms: z.number().nullable(),
          program_ends_at: z.string().nullable(),
          status: enumOf(PROGRAM_STATUSES).nullable(),
          max_distance_cents: z.string(),
          single_sided_factor: z.string(),
          two_sided_band_low: decimalString,
          two_sided_band_high: decimalString,
          max_avg_price: decimalString.nullish(),
          min_order_rest_ms: z.number(),
          min_order_rest_seconds: z.number(),
          min_order_size_shares: z.number(),
          min_payout: decimalString,
        }),
      ),
      active_bonus: z.array(bonusWindowSchema(obj, enumOf)),
      upcoming_bonus: z.array(bonusWindowSchema(obj, enumOf)),
      ended_bonus: z.array(bonusWindowSchema(obj, enumOf)),
    }),
);

/** The terms of a rail: the scoring rules. */
export interface RewardsRailConfig {
  max_distance_cents: string;
  single_sided_factor: string;
  two_sided_band_low: DecimalString;
  two_sided_band_high: DecimalString;
  max_avg_price?: DecimalString;
  min_order_rest_ms?: number;
  min_order_rest_seconds: number;
  min_order_size_shares: number;
  min_payout: RewardAmount;
}

/** The inputs of a USDC rail's estimated APR. */
export interface RewardsAprBasis {
  epoch: number;
  effective_daily_reward: RewardAmount;
  average_qualifying_liquidity_usd: DecimalString;
  liquidity_source: string;
  carried_liquidity_usd?: DecimalString;
  annualisation_days: number;
}

/** A programme rail (CP or USDC) of a market or a group, with its live state and its terms. */
export interface RewardsRailState {
  reward_enabled: boolean;
  active: boolean;
  inactive_reason: RewardsInactiveReason | null;
  daily_pool: RewardAmount | null;
  /** The configured rate before today's fee credits. */
  base_daily_pool?: RewardAmount | null;
  budget_total?: RewardAmount | null;
  base_budget_total?: RewardAmount | null;
  budget_remaining?: RewardAmount | null;
  duration_days?: number | null;
  days_remaining?: number | null;
  program_starts_at_ms: number | null;
  program_starts_at?: string | null;
  program_ends_at_ms: number | null;
  program_ends_at?: string | null;
  status?: RewardsProgramStatus | null;
  terms_set_at_ms?: number | null;
  terms_set_at?: string | null;
  /** An annualised rate in percent. */
  estimated_apr?: string | null;
  estimated_apr_unavailable_reason?: string | null;
  estimated_apr_basis?: RewardsAprBasis | null;
  config: RewardsRailConfig;
}

/** What a rail has scored and paid over its life. */
export interface RewardsLifetime {
  currency: RewardsRail;
  scored_epochs: number;
  latest_epoch: number;
  total_scored_liquidity: string;
  allocated: RewardAmount;
  distributed: RewardAmount;
  base_allocated?: RewardAmount;
  bonus_allocated?: RewardAmount;
  bonus_only_epochs?: number;
}

/** A market's rewards (`markets/:marketId`): both rails, what they paid, the day in progress. */
export interface RewardsMarket extends RewardsBonusLists {
  /** The condition id. */
  market_id: string;
  active: boolean;
  cp: RewardsRailState | null;
  usdc: RewardsRailState | null;
  current_epoch: number;
  current_epoch_open_ms: number;
  current_epoch_close_ms: number;
  current_epoch_ends_in_ms: number;
  total_scored_liquidity: string;
  lifetime_by_currency: RewardsLifetime[];
}

const railStateSchema = (obj: ObjFactory, enumOf: EnumFactory) => {
  const amount = amountSchema(obj, enumOf);
  return obj({
    reward_enabled: z.boolean(),
    active: z.boolean(),
    inactive_reason: enumOf(INACTIVE_REASONS).nullable(),
    daily_pool: amount.nullable(),
    base_daily_pool: amount.nullish(),
    budget_total: amount.nullish(),
    base_budget_total: amount.nullish(),
    budget_remaining: amount.nullish(),
    duration_days: z.number().nullish(),
    days_remaining: z.number().nullish(),
    program_starts_at_ms: z.number().nullable(),
    program_starts_at: z.string().nullish(),
    program_ends_at_ms: z.number().nullable(),
    program_ends_at: z.string().nullish(),
    status: enumOf(PROGRAM_STATUSES).nullish(),
    terms_set_at_ms: z.number().nullish(),
    terms_set_at: z.string().nullish(),
    estimated_apr: z.string().nullish(),
    estimated_apr_unavailable_reason: z.string().nullish(),
    estimated_apr_basis: obj({
      epoch: z.number(),
      effective_daily_reward: amount,
      average_qualifying_liquidity_usd: decimalString,
      liquidity_source: z.string(),
      carried_liquidity_usd: decimalString.optional(),
      annualisation_days: z.number(),
    }).nullish(),
    config: obj({
      max_distance_cents: z.string(),
      single_sided_factor: z.string(),
      two_sided_band_low: decimalString,
      two_sided_band_high: decimalString,
      max_avg_price: decimalString.optional(),
      min_order_rest_ms: z.number().optional(),
      min_order_rest_seconds: z.number(),
      min_order_size_shares: z.number(),
      min_payout: amount,
    }),
  });
};

const lifetimeSchema = (obj: ObjFactory, enumOf: EnumFactory) => {
  const amount = amountSchema(obj, enumOf);
  return obj({
    currency: enumOf(CURRENCIES),
    scored_epochs: z.number(),
    latest_epoch: z.number(),
    total_scored_liquidity: exactText,
    allocated: amount,
    distributed: amount,
    base_allocated: amount.optional(),
    bonus_allocated: amount.optional(),
    bonus_only_epochs: z.number().optional(),
  });
};

export const RewardsMarketSchema = defineSchema<RewardsMarket>((obj, enumOf) =>
  obj({
    market_id: z.string(),
    active: z.boolean(),
    cp: railStateSchema(obj, enumOf).nullable(),
    usdc: railStateSchema(obj, enumOf).nullable(),
    current_epoch: z.number(),
    current_epoch_open_ms: z.number(),
    current_epoch_close_ms: z.number(),
    current_epoch_ends_in_ms: z.number(),
    total_scored_liquidity: exactText,
    lifetime_by_currency: z.array(lifetimeSchema(obj, enumOf)),
    ...bonusListsShape(obj, enumOf),
  }),
);

// ---------------------------------------------------------------------------
// Groups (Pulse products)
// ---------------------------------------------------------------------------

/** The catalogue label of a Pulse group's product (the backend adds it: the rewards service knows the hash). */
export interface RewardsGroupProduct {
  categoryId: number;
  name: string;
  /** `null` for a category with no slug. */
  slug: string | null;
  depth: number;
  path: string[];
  productId: string;
}

const productSchema = (obj: ObjFactory) =>
  obj({
    categoryId: z.number(),
    name: z.string(),
    slug: z.string().nullable(),
    depth: z.number(),
    path: z.array(z.string()),
    productId: z.string(),
  });

/** One Pulse product of the group list: one pot per product, not per five-minute window. */
export interface RewardsGroup extends RewardsBonusLists {
  /** The bytes32 group id. */
  group_id: string;
  active: boolean;
  cp: RewardsRailState | null;
  usdc: RewardsRailState | null;
  /** How many windows of the product accrue today. */
  member_markets_today: number;
  /** `null` when the catalogue has no label for the group. */
  product: RewardsGroupProduct | null;
}

/** The group list with the epoch it is drawn for. */
export interface RewardsGroupsPage {
  page: number;
  page_size: number;
  total: number;
  truncated: boolean;
  current_epoch: number;
  current_epoch_open_ms: number;
  current_epoch_close_ms: number;
  current_epoch_ends_in_ms: number;
  groups: RewardsGroup[];
}

/** One group (`groups/:groupId`): the live rails and what they paid over their life. */
export interface RewardsGroupDetail extends RewardsBonusLists {
  group_id: string;
  active: boolean;
  cp: RewardsRailState | null;
  usdc: RewardsRailState | null;
  current_epoch: number;
  current_epoch_open_ms: number;
  current_epoch_close_ms: number;
  current_epoch_ends_in_ms: number;
  member_markets_today: number;
  total_scored_liquidity: string;
  lifetime_by_currency: RewardsLifetime[];
  product: RewardsGroupProduct | null;
}

export const RewardsGroupsPageSchema = defineSchema<RewardsGroupsPage>(
  (obj, enumOf) =>
    obj({
      page: z.number(),
      page_size: z.number(),
      total: z.number(),
      truncated: z.boolean(),
      current_epoch: z.number(),
      current_epoch_open_ms: z.number(),
      current_epoch_close_ms: z.number(),
      current_epoch_ends_in_ms: z.number(),
      groups: z.array(
        obj({
          group_id: z.string(),
          active: z.boolean(),
          cp: railStateSchema(obj, enumOf).nullable(),
          usdc: railStateSchema(obj, enumOf).nullable(),
          member_markets_today: z.number(),
          ...bonusListsShape(obj, enumOf),
          product: productSchema(obj).nullable(),
        }),
      ),
    }),
);

export const RewardsGroupDetailSchema = defineSchema<RewardsGroupDetail>(
  (obj, enumOf) =>
    obj({
      group_id: z.string(),
      active: z.boolean(),
      cp: railStateSchema(obj, enumOf).nullable(),
      usdc: railStateSchema(obj, enumOf).nullable(),
      current_epoch: z.number(),
      current_epoch_open_ms: z.number(),
      current_epoch_close_ms: z.number(),
      current_epoch_ends_in_ms: z.number(),
      member_markets_today: z.number(),
      total_scored_liquidity: exactText,
      lifetime_by_currency: z.array(lifetimeSchema(obj, enumOf)),
      ...bonusListsShape(obj, enumOf),
      product: productSchema(obj).nullable(),
    }),
);

// ---------------------------------------------------------------------------
// A market-day: epoch rollup, makers, orders (the rewards service: snake_case)
// ---------------------------------------------------------------------------

/** A maker's share of a market-day. */
export interface RewardsMaker {
  /** The maker's wallet. */
  user_id: string;
  /** The maker's liquidity score for the day. Not money: kept as exact text. */
  score: string;
  /** The score as a fraction of the market's total, `"0.00000000"` to `"1.00000000"`. */
  score_share: string;
  /** What the maker earns for the day, in CP. */
  effective_cp: DecimalString;
  allocated_cp: DecimalString;
  /** What has been credited so far; `null` before settlement. */
  credited_cp: DecimalString | null;
  status: RewardsPayoutStatus;
}

/**
 * A maker's share of a market-day on the USDC rail: the same line as {@link RewardsMaker}, with
 * the money renamed to USDC (6 decimals, floored). The score, the share and the status keep
 * their bare names.
 */
export interface RewardsUsdcMaker {
  /** The maker's wallet. */
  user_id: string;
  /** The maker's liquidity score for the day. Not money: kept as exact text. */
  score: string;
  /** The score as a fraction of the market's total, `"0.00000000"` to `"1.00000000"`. */
  score_share: string;
  /** What the maker earns for the day, in USDC. */
  effective_usdc: DecimalString;
  allocated_usdc: DecimalString;
  /** What has been credited so far; `null` before settlement. */
  credited_usdc: DecimalString | null;
  status: RewardsPayoutStatus;
}

/**
 * A market's UTC day (`markets/:marketId/epochs/:epoch`): the pot, the score and the top makers
 * of both rails. The CP rail keeps the bare names (`pool`, `status`, `allocated_cp`,
 * `top_makers`…) and the USDC rail sits beside it under the `_usdc` names. The USDC fields are
 * optional: a response may omit the USDC rail, and `omitted_rails` then names it.
 */
export interface RewardsMarketEpoch {
  market_id: string;
  epoch: number;
  day_open_ms: number;
  day_close_ms: number;
  /** The CP rail's currency (`'CP'`, or `null`); never `'USDC'`: that rail has the `_usdc` fields. */
  currency: string | null;
  /** The day's CP pool. */
  pool: DecimalString | null;
  status: RewardsDayStatus | null;
  total_score: string;
  maker_count: number;
  allocated_cp: DecimalString;
  credited_cp: DecimalString | null;
  /** True for the day in progress: the figures are a live projection. */
  projected?: boolean;
  projected_through_ms?: number | null;
  /** The day's USDC pool; `null` where the market has no USDC programme that day. */
  pool_usdc?: DecimalString | null;
  status_usdc?: RewardsDayStatus | null;
  /** The USDC rail's total score. Not money: kept as exact text. */
  total_score_usdc?: string;
  maker_count_usdc?: number;
  allocated_usdc?: DecimalString;
  /** What the day has paid in USDC; `null` before settlement. */
  credited_usdc?: DecimalString | null;
  /** True for the day in progress: the USDC figures are a live projection. */
  projected_usdc?: boolean;
  projected_through_ms_usdc?: number | null;
  /** The rails this answer leaves out, when it leaves one out. */
  omitted_rails?: RewardsRail[];
  bonus_only?: boolean;
  top_makers: RewardsMaker[];
  top_makers_usdc?: RewardsUsdcMaker[];
}

/** One page of a market-day's makers. */
export interface RewardsMakersPage {
  market_id: string;
  epoch: number;
  page: number;
  page_size: number;
  total: number;
  projected?: boolean;
  projected_through_ms?: number | null;
  omitted_rails?: RewardsRail[];
  makers: RewardsMaker[];
}

/** A scored order of a market-day, with its maker (the market's view). */
export interface RewardsMarketOrder {
  order_id: string;
  /** The maker's wallet. */
  maker: string;
  outcome: string;
  side: 'Buy' | 'Sell' | (string & {});
  /** The order's engine tick (1 tick = 0.001). */
  price_tick: number;
  score: string;
  /** The order's share of its maker's score. */
  maker_score_share: string;
  effective_cp: DecimalString;
  /** Milliseconds the order qualified. */
  eligible_ms: number;
  first_seen_ms: number;
  last_seen_ms: number;
  created_at_ms: number;
  /** The size at the start of the day, in micro-shares (1_000_000 is one share). */
  opening_size_micro: RawUnitsString;
  closing_size_micro: RawUnitsString;
  exit_kind: RewardsExitKind | null;
}

/** One page of a market-day's scored orders. */
export interface RewardsMarketOrdersPage {
  market_id: string;
  epoch: number;
  maker?: string | null;
  page: number;
  page_size: number;
  total: number;
  truncated_orders: number;
  attributed_cp: DecimalString;
  unattributed_cp: DecimalString;
  projected?: boolean;
  projected_through_ms?: number | null;
  omitted_rails?: RewardsRail[];
  orders: RewardsMarketOrder[];
}

const makerSchema = (obj: ObjFactory, enumOf: EnumFactory) =>
  obj({
    user_id: z.string(),
    score: exactText,
    score_share: exactText,
    effective_cp: decimalString,
    allocated_cp: decimalString,
    credited_cp: decimalString.nullable(),
    status: enumOf(PAYOUT_STATUSES),
  });

const usdcMakerSchema = (obj: ObjFactory, enumOf: EnumFactory) =>
  obj({
    user_id: z.string(),
    score: exactText,
    score_share: exactText,
    effective_usdc: decimalString,
    allocated_usdc: decimalString,
    credited_usdc: decimalString.nullable(),
    status: enumOf(PAYOUT_STATUSES),
  });

const omittedRails = (enumOf: EnumFactory) =>
  z.array(enumOf(CURRENCIES)).optional();

export const RewardsMarketEpochSchema = defineSchema<RewardsMarketEpoch>(
  (obj, enumOf) =>
    obj({
      market_id: z.string(),
      epoch: z.number(),
      day_open_ms: z.number(),
      day_close_ms: z.number(),
      currency: z.string().nullable(),
      pool: decimalString.nullable(),
      status: enumOf(DAY_STATUSES).nullable(),
      total_score: exactText,
      maker_count: z.number(),
      allocated_cp: decimalString,
      credited_cp: decimalString.nullable(),
      projected: z.boolean().optional(),
      projected_through_ms: z.number().nullish(),
      pool_usdc: decimalString.nullish(),
      status_usdc: enumOf(DAY_STATUSES).nullish(),
      total_score_usdc: exactText.optional(),
      maker_count_usdc: z.number().optional(),
      allocated_usdc: decimalString.optional(),
      credited_usdc: decimalString.nullish(),
      projected_usdc: z.boolean().optional(),
      projected_through_ms_usdc: z.number().nullish(),
      omitted_rails: omittedRails(enumOf),
      bonus_only: z.boolean().optional(),
      top_makers: z.array(makerSchema(obj, enumOf)),
      top_makers_usdc: z.array(usdcMakerSchema(obj, enumOf)).optional(),
    }),
);

export const RewardsMakersPageSchema = defineSchema<RewardsMakersPage>(
  (obj, enumOf) =>
    obj({
      market_id: z.string(),
      epoch: z.number(),
      page: z.number(),
      page_size: z.number(),
      total: z.number(),
      projected: z.boolean().optional(),
      projected_through_ms: z.number().nullish(),
      omitted_rails: omittedRails(enumOf),
      makers: z.array(makerSchema(obj, enumOf)),
    }),
);

export const RewardsMarketOrdersPageSchema =
  defineSchema<RewardsMarketOrdersPage>((obj, enumOf) =>
    obj({
      market_id: z.string(),
      epoch: z.number(),
      maker: z.string().nullish(),
      page: z.number(),
      page_size: z.number(),
      total: z.number(),
      truncated_orders: z.number(),
      attributed_cp: decimalString,
      unattributed_cp: decimalString,
      projected: z.boolean().optional(),
      projected_through_ms: z.number().nullish(),
      omitted_rails: omittedRails(enumOf),
      orders: z.array(
        obj({
          order_id: z.string(),
          maker: z.string(),
          outcome: z.string(),
          side: enumOf(['Buy', 'Sell']),
          price_tick: z.number(),
          score: exactText,
          maker_score_share: exactText,
          effective_cp: decimalString,
          eligible_ms: z.number(),
          first_seen_ms: z.number(),
          last_seen_ms: z.number(),
          created_at_ms: z.number(),
          opening_size_micro: rawUnits,
          closing_size_micro: rawUnits,
          exit_kind: enumOf(EXIT_KINDS).nullable(),
        }),
      ),
    }),
  );

// ---------------------------------------------------------------------------
// A wallet (and the account): summary, epoch, orders, market-day
// ---------------------------------------------------------------------------

/**
 * A lifetime amount and what was **settled** today, in whole units, rounded to 2 decimals.
 *
 * `today` is the backend's `today_credited` (CP) or `today_paid` (USDC): money that has already
 * been credited or paid today. It is **not** the open day's accrual, which is on the rail's
 * `currentEpoch` (`effective` for what the maker earns, `estimate` for the projected payout).
 * A maker whose orders have scored all day but whose day has not settled reads `"0.00"` here.
 */
export interface RewardsSummaryAmount {
  lifetime: DecimalString;
  today: DecimalString;
}

/**
 * The day in progress for a rail, with its projection: the live accrual of "today", as opposed
 * to the `today` of {@link RewardsSummaryAmount}, which is only what has settled. Rounded to 2
 * decimals like the whole summary, so an accrual under half a cent reads `"0.00"` (the exact
 * amounts are on `myMarket()` / `marketWallet()` and in `myOrders().raw.payout_summary`).
 */
export interface RewardsSummaryEpoch {
  /** Allocated for the open UTC day (may be projected). */
  allocated: DecimalString;
  /** What the maker earns for the open day: the live accrual. */
  effective: DecimalString;
  /** Already paid for the day. */
  paid: DecimalString;
  /** The projected payout of the open day before settlement. */
  estimate: DecimalString | null;
  /** Credited once the day is terminal. */
  credited: DecimalString | null;
  /** True when the figures are a live projection of the open day. */
  projected?: boolean;
  projectedThroughMs?: number | null;
  status?: RewardsPayoutStatus;
  /** The base-pool half of `effective`. */
  baseAmount: DecimalString | null;
  /** The bonus-window half of `effective`. */
  bonusAmount: DecimalString | null;
}

/**
 * A wallet's reward totals (`wallets/:walletAddress/summary`, `me/summary`).
 *
 * **Reading "today's earnings".** Two fields answer two questions:
 * - what has *settled* today: `me.cp.liquidity.today` (`today_credited`) and
 *   `me.usdc.liquidityRewards.today` (`today_paid`), plus `me.usdc.makerRebates.today`;
 * - what the open day has *accrued so far*: `me.cp.currentEpoch` and `me.usdc.currentEpoch`,
 *   `effective` (what the maker earns) and `estimate` (the projected payout), with
 *   `projected: true` and `projectedThroughMs` saying how fresh the projection is.
 *
 * **Every figure is rounded to 2 decimals** (the backend formats the whole summary with
 * `Number(x).toFixed(2)`), USDC included, so a first-hour accrual under half a cent reads
 * `"0.00"`. The exact amounts (USDC has 6 decimals) are on `myMarket()` / `marketWallet()`
 * (`projected_payout`, `base_amount`, `bonus_amount`) and on `myOrders().raw.payout_summary`
 * (cast `Page.raw` to {@link RewardsMakerOrdersPage}).
 *
 * The backend caches a wallet's summary, about 60 s fresh and up to 5 min stale, and `me/summary`
 * and the public `wallets/:walletAddress/summary` of the same wallet share that cache, so a figure
 * can lag the orders by a minute or more.
 */
export interface RewardsWalletSummary {
  meta: EarningPoolsMeta;
  /** Whether the maker is flagged by the liquidity programme's enforcement. */
  flagged: boolean;
  /** `null` only when the account's wallet is blank. */
  me: {
    usdc: {
      /** Maker rebates plus USDC liquidity rewards, lifetime. */
      totalReceived: DecimalString;
      makerRebates: RewardsSummaryAmount;
      liquidityRewards: RewardsSummaryAmount;
      currentEpoch: RewardsSummaryEpoch;
    };
    cp: {
      /** Lifetime liquidity CP credited. */
      totalReceived: DecimalString;
      liquidity: RewardsSummaryAmount;
      creatorBonus: { lifetime: DecimalString };
      currentEpoch: RewardsSummaryEpoch;
    };
  } | null;
}

const summaryAmountSchema = (obj: ObjFactory) =>
  obj({ lifetime: decimalString, today: decimalString });

const summaryEpochSchema = (obj: ObjFactory, enumOf: EnumFactory) =>
  obj({
    allocated: decimalString,
    effective: decimalString,
    paid: decimalString,
    estimate: decimalString.nullable(),
    credited: decimalString.nullable(),
    projected: z.boolean().optional(),
    projectedThroughMs: z.number().nullish(),
    status: enumOf(PAYOUT_STATUSES).optional(),
    baseAmount: decimalString.nullable(),
    bonusAmount: decimalString.nullable(),
  });

export const RewardsWalletSummarySchema = defineSchema<RewardsWalletSummary>(
  (obj, enumOf) =>
    obj({
      meta: earningPoolsMetaSchema(obj),
      flagged: z.boolean(),
      me: obj({
        usdc: obj({
          totalReceived: decimalString,
          makerRebates: summaryAmountSchema(obj),
          liquidityRewards: summaryAmountSchema(obj),
          currentEpoch: summaryEpochSchema(obj, enumOf),
        }),
        cp: obj({
          totalReceived: decimalString,
          liquidity: summaryAmountSchema(obj),
          creatorBonus: obj({ lifetime: decimalString }),
          currentEpoch: summaryEpochSchema(obj, enumOf),
        }),
      }).nullable(),
    }),
);

/** One market's line of a wallet's day. */
export interface RewardsWalletEpochMarket {
  market_id: string;
  currency: string;
  score: string;
  score_share: string;
  effective_cp: DecimalString;
  allocated_cp: DecimalString;
  credited_cp: DecimalString | null;
  status: RewardsPayoutStatus;
}

/** A wallet's UTC day across every market (`wallets/:walletAddress/epochs/:epoch`, `me/epochs/:epoch`). */
export interface RewardsWalletEpoch {
  user_id: string;
  epoch: number;
  day_open_ms: number;
  day_close_ms: number;
  flagged: boolean;
  effective_cp: DecimalString;
  allocated_cp: DecimalString;
  credited_cp: DecimalString | null;
  markets: RewardsWalletEpochMarket[];
  /** The XO profile of the wallet's owner; `null` for a wallet with no XO account. */
  user?: RewardsUser | null;
}

export const RewardsWalletEpochSchema = defineSchema<RewardsWalletEpoch>(
  (obj, enumOf) =>
    obj({
      user_id: z.string(),
      epoch: z.number(),
      day_open_ms: z.number(),
      day_close_ms: z.number(),
      flagged: z.boolean(),
      effective_cp: decimalString,
      allocated_cp: decimalString,
      credited_cp: decimalString.nullable(),
      markets: z.array(
        obj({
          market_id: z.string(),
          currency: z.string(),
          score: exactText,
          score_share: exactText,
          effective_cp: decimalString,
          allocated_cp: decimalString,
          credited_cp: decimalString.nullable(),
          status: enumOf(PAYOUT_STATUSES),
        }),
      ),
      user: userSchema(obj).nullish(),
    }),
);

/** A scored (or live, `unscored`) order of a maker, with its payouts per rail. */
export interface RewardsMakerOrder {
  /** The market's condition id. */
  market_id: string;
  order_id: string;
  outcome: string;
  side: 'Buy' | 'Sell' | (string & {});
  /** The order's engine tick (1 tick = 0.001). */
  price_tick: number;
  /** For an `unscored` order, a placeholder `"0"`: not yet scored, not zero. */
  score: string;
  maker_score_share: string;
  payouts: RewardAmount[];
  projected: boolean;
  eligible_ms: number;
  first_seen_ms: number;
  last_seen_ms: number;
  created_at_ms: number;
  /** The size at the start of the day, in micro-shares (1_000_000 is one share). */
  opening_size_micro: RawUnitsString;
  closing_size_micro: RawUnitsString;
  exit_kind: RewardsExitKind | null;
  /**
   * The opening size in shares (`opening_size_micro` / 1e6), computed by the backend as a
   * float: for display. For exact arithmetic use `opening_size_micro` / `closing_size_micro`,
   * which are exact integers.
   */
  openingSizeShares: number;
  /** As `openingSizeShares`: a float. Use `closing_size_micro` for exact arithmetic. */
  closingSizeShares: number;
  /** The Pulse reward group the market belongs to; `null` for an ordinary market. */
  group_id: string | null;
  /** The member window, clipped to the day (ms). Group members only. */
  active_from_ms: number | null;
  active_to_ms: number | null;
  window_state:
    | 'waiting_for_window'
    | 'accruing'
    | 'no_longer_accruing'
    | (string & {})
    | null;
  scoring_status:
    | 'scoring'
    | 'previously_scored'
    | 'not_scoring'
    | (string & {})
    | null;
  /** True on a resting order the live overlay added before the scorer folded it. */
  unscored: boolean;
}

/** What the maker is paid on one market over the whole scope (not the page). */
export interface RewardsMarketPayout {
  market_id: string;
  group_id: string | null;
  score: string;
  payouts: RewardAmount[];
  /** True on a Pulse member: a display slice of the group's payout. The group entry is paid. */
  derived: boolean;
  projected: boolean;
}

/** What the maker is paid by one Pulse group over the whole scope. */
export interface RewardsGroupPayout {
  group_id: string;
  score: string;
  payouts: RewardAmount[];
  projected: boolean;
}

/** The catalogue slice of a market on a maker's orders. */
export interface RewardsOrderMarket {
  title?: string | null;
  slug?: string | null;
  eventSlug?: string | null;
  rootEventSlug?: string | null;
  imageUrl?: string | null;
  status?: string | null;
  expiresAt?: string | null;
  prices?: { yes: DecimalString; no: DecimalString } | null;
  cp?: RewardsOrderMarketRail | null;
  usdc?: RewardsOrderMarketRail | null;
}

/** The terms of one rail of a market on a maker's orders. */
export interface RewardsOrderMarketRail {
  maxDistanceCents?: string | null;
  minOrderSizeShares?: number | null;
  minPayout?: DecimalString | null;
  singleSidedFactor?: string | null;
  twoSidedBandLow?: DecimalString | null;
  twoSidedBandHigh?: DecimalString | null;
  maxAvgPrice?: DecimalString | null;
  /** The pool's daily reward on this rail. */
  dailyReward?: DecimalString | null;
}

/**
 * The answer of a maker's orders route (`wallets/:walletAddress/orders`, `me/orders`). The
 * paginator lists `orders`; the rest is on `Page.raw`.
 */
export interface RewardsMakerOrdersPage {
  maker: string;
  flagged: boolean;
  market_id: string | null;
  epoch: number;
  day_open_ms: number;
  day_close_ms: number;
  projected: boolean;
  projected_through_ms: number | null;
  page: number;
  page_size: number;
  total: number;
  truncated_orders: number;
  /** True when the day's Pulse orders are narrowed to the windows accruing now. */
  live_markets_only: boolean;
  live_status:
    | 'applied'
    | 'partial'
    | 'unavailable'
    | 'not_configured'
    | 'closed_day'
    | (string & {})
    | null;
  live_through_ms: number | null;
  /** Unscored rows over the whole scope (not the page). */
  unscored_orders: number | null;
  orders: RewardsMakerOrder[];
  /** The money behind the list over the whole scope, per market and per Pulse group. */
  payout_summary: {
    markets: RewardsMarketPayout[];
    groups: RewardsGroupPayout[];
  };
  /** The catalogue slice of the markets on the page, by condition id. */
  markets: Record<string, RewardsOrderMarket>;
  user?: RewardsUser | null;
}

const orderMarketRailSchema = (obj: ObjFactory) =>
  obj({
    maxDistanceCents: z.string().nullish(),
    minOrderSizeShares: z.number().nullish(),
    minPayout: decimalString.nullish(),
    singleSidedFactor: z.string().nullish(),
    twoSidedBandLow: decimalString.nullish(),
    twoSidedBandHigh: decimalString.nullish(),
    maxAvgPrice: decimalString.nullish(),
    dailyReward: decimalString.nullish(),
  });

export const RewardsMakerOrdersPageSchema =
  defineSchema<RewardsMakerOrdersPage>((obj, enumOf) => {
    const amount = amountSchema(obj, enumOf);
    return obj({
      maker: z.string(),
      flagged: z.boolean(),
      market_id: z.string().nullable(),
      epoch: z.number(),
      day_open_ms: z.number(),
      day_close_ms: z.number(),
      projected: z.boolean(),
      projected_through_ms: z.number().nullable(),
      page: z.number(),
      page_size: z.number(),
      total: z.number(),
      truncated_orders: z.number(),
      live_markets_only: z.boolean(),
      live_status: enumOf(LIVE_STATUSES).nullable(),
      live_through_ms: z.number().nullable(),
      unscored_orders: z.number().nullable(),
      orders: z.array(
        obj({
          market_id: z.string(),
          order_id: z.string(),
          outcome: z.string(),
          side: enumOf(['Buy', 'Sell']),
          price_tick: z.number(),
          score: exactText,
          maker_score_share: exactText,
          payouts: z.array(amount),
          projected: z.boolean(),
          eligible_ms: z.number(),
          first_seen_ms: z.number(),
          last_seen_ms: z.number(),
          created_at_ms: z.number(),
          opening_size_micro: rawUnits,
          closing_size_micro: rawUnits,
          exit_kind: enumOf(EXIT_KINDS).nullable(),
          openingSizeShares: z.number(),
          closingSizeShares: z.number(),
          group_id: z.string().nullable(),
          active_from_ms: z.number().nullable(),
          active_to_ms: z.number().nullable(),
          window_state: enumOf(WINDOW_STATES).nullable(),
          scoring_status: enumOf(SCORING_STATUSES).nullable(),
          unscored: z.boolean(),
        }),
      ),
      payout_summary: obj({
        markets: z.array(
          obj({
            market_id: z.string(),
            group_id: z.string().nullable(),
            score: exactText,
            payouts: z.array(amount),
            derived: z.boolean(),
            projected: z.boolean(),
          }),
        ),
        groups: z.array(
          obj({
            group_id: z.string(),
            score: exactText,
            payouts: z.array(amount),
            projected: z.boolean(),
          }),
        ),
      }),
      markets: z.record(
        z.string(),
        obj({
          title: z.string().nullish(),
          slug: z.string().nullish(),
          eventSlug: z.string().nullish(),
          rootEventSlug: z.string().nullish(),
          imageUrl: z.string().nullish(),
          status: z.string().nullish(),
          expiresAt: z.string().nullish(),
          prices: obj({ yes: decimalString, no: decimalString }).nullish(),
          cp: orderMarketRailSchema(obj).nullish(),
          usdc: orderMarketRailSchema(obj).nullish(),
        }),
      ),
      user: userSchema(obj).nullish(),
    });
  });

/** A qualifying order on a maker's market-day: the order with its payout on the day's rail. */
export interface RewardsQualifyingOrder {
  order_id: string;
  outcome: string;
  side: 'Buy' | 'Sell' | (string & {});
  price_tick: number;
  score: string;
  maker_score_share: string;
  payout: RewardAmount;
  eligible_ms: number;
  first_seen_ms: number;
  last_seen_ms: number;
  created_at_ms: number;
  opening_size_micro: RawUnitsString;
  closing_size_micro: RawUnitsString;
  exit_kind: RewardsExitKind | null;
}

/** One bonus window's share of a maker's day. */
export interface RewardsBonusShare {
  window_id: string;
  amount: RewardAmount;
  allocated: RewardAmount;
  credited: RewardAmount | null;
  status: RewardsPayoutStatus;
}

/**
 * A maker on one market-day (`markets/:marketId/wallets/:walletAddress`, `markets/:marketId/me`):
 * the score, the payout on one rail, and the qualifying orders.
 */
export interface RewardsMarketDay {
  market_id: string;
  /** The maker's wallet. */
  maker: string;
  flagged: boolean;
  epoch: number;
  day_open_ms: number;
  day_close_ms: number;
  /** False when the day has no scoring for this maker (a stranger, or a day not yet scored). */
  scored: boolean;
  projected?: boolean;
  projected_through_ms?: number | null;
  currency: RewardsRail | null;
  score: string;
  score_share: string;
  /** The payout the maker is due: `base_amount` + `bonus_amount`. `null` when nothing is due. */
  projected_payout: RewardAmount | null;
  credited: RewardAmount | null;
  status: RewardsPayoutStatus;
  order_count: number;
  cancel_count: number;
  fill_count: number;
  eligible_ms: number;
  /** One page of the qualifying orders (`page`, `page_size` params). */
  qualifying_orders: {
    page: number;
    page_size: number;
    total: number;
    truncated_orders: number;
    attributed: RewardAmount;
    unattributed: RewardAmount;
    orders: RewardsQualifyingOrder[];
  };
  base_amount?: RewardAmount | null;
  bonus_amount?: RewardAmount | null;
  bonus_by_window?: RewardsBonusShare[];
  /** The rail had no base programme that day; the money is all bonus. */
  bonus_only?: boolean;
  allocation_method?: string;
  rail_active_from_ms?: number | null;
  rail_active_to_ms?: number | null;
}

export const RewardsMarketDaySchema = defineSchema<RewardsMarketDay>(
  (obj, enumOf) => {
    const amount = amountSchema(obj, enumOf);
    return obj({
      market_id: z.string(),
      maker: z.string(),
      flagged: z.boolean(),
      epoch: z.number(),
      day_open_ms: z.number(),
      day_close_ms: z.number(),
      scored: z.boolean(),
      projected: z.boolean().optional(),
      projected_through_ms: z.number().nullish(),
      currency: enumOf(CURRENCIES).nullable(),
      score: exactText,
      score_share: exactText,
      projected_payout: amount.nullable(),
      credited: amount.nullable(),
      status: enumOf(PAYOUT_STATUSES),
      order_count: z.number(),
      cancel_count: z.number(),
      fill_count: z.number(),
      eligible_ms: z.number(),
      qualifying_orders: obj({
        page: z.number(),
        page_size: z.number(),
        total: z.number(),
        truncated_orders: z.number(),
        attributed: amount,
        unattributed: amount,
        orders: z.array(
          obj({
            order_id: z.string(),
            outcome: z.string(),
            side: enumOf(['Buy', 'Sell']),
            price_tick: z.number(),
            score: exactText,
            maker_score_share: exactText,
            payout: amount,
            eligible_ms: z.number(),
            first_seen_ms: z.number(),
            last_seen_ms: z.number(),
            created_at_ms: z.number(),
            opening_size_micro: rawUnits,
            closing_size_micro: rawUnits,
            exit_kind: enumOf(EXIT_KINDS).nullable(),
          }),
        ),
      }),
      base_amount: amount.nullish(),
      bonus_amount: amount.nullish(),
      bonus_by_window: z
        .array(
          obj({
            window_id: z.string(),
            amount,
            allocated: amount,
            credited: amount.nullable(),
            status: enumOf(PAYOUT_STATUSES),
          }),
        )
        .optional(),
      bonus_only: z.boolean().optional(),
      allocation_method: z.string().optional(),
      rail_active_from_ms: z.number().nullish(),
      rail_active_to_ms: z.number().nullish(),
    });
  },
);

// ---------------------------------------------------------------------------
// The account's Pulse group-days (the rewards service's answers, passed through untouched)
// ---------------------------------------------------------------------------

/**
 * The account on one Pulse group-day (`groups/:groupId/me`). The backend passes the rewards
 * service's answer through untouched, with the group's `product` label added, and owns no type for
 * it (`Record<string, unknown> & { group_id }`), so only `group_id` and `product` are checked and
 * the rest is kept as sent, whatever `strictResponses` says.
 *
 * The fields of a day for an account with no scoring, to read them by name: `maker`, `flagged`,
 * `epoch`, `day_open_ms`, `day_close_ms`, `rail_active_from_ms`, `rail_active_to_ms`, `scored`,
 * `projected`, `projected_through_ms`, `currency`, `score` and `score_share` (text),
 * `group_total_score`, `pool`, `allocated`, `effective`, `credited`, `base_amount`,
 * `bonus_amount` (`{ amount, currency }` or `null`), `status`, `bonus_by_window`, `bonus_only`,
 * `allocation_method`, `member_markets` and `member_markets_truncated`: the shape of a
 * {@link RewardsMarketDay} at group level. A day with scoring may differ: only `group_id` and
 * `product` are checked.
 */
export interface RewardsGroupDay {
  group_id: string;
  product: RewardsGroupProduct | null;
  [field: string]: unknown;
}

export const RewardsGroupDaySchema = defineSchema<RewardsGroupDay>((obj) =>
  // The rewards service owns this shape, so the object stays loose in both flavours: a strict parse
  // would reject a field the backend never promised.
  z.looseObject({
    group_id: z.string(),
    product: productSchema(obj).nullable(),
  }),
);

/**
 * One settled group-day of the account's history, as the rewards service sends it. Only the fields
 * every line has are required; the rest are checked when present. (These are the fields of
 * the backend's type of the rewards service's history line.)
 */
export interface RewardsGroupHistoryLine {
  /** The group id (the same as `group_id`). */
  market_id: string;
  group_id?: string | null;
  epoch: number;
  day_open_ms?: number;
  day_close_ms?: number;
  currency: RewardsRail;
  score?: string;
  score_share?: string;
  allocated?: RewardAmount;
  effective?: RewardAmount;
  credited?: RewardAmount | null;
  status: RewardsPayoutStatus;
  /** The two halves of `effective`. */
  base_amount?: RewardAmount;
  bonus_amount?: RewardAmount;
  [field: string]: unknown;
}

/** One rail's sums over the account's whole group history. */
export interface RewardsGroupHistoryTotals {
  currency: RewardsRail;
  allocated?: RewardAmount;
  effective?: RewardAmount;
  credited?: RewardAmount;
  /** The two halves of `effective`. */
  base_effective?: RewardAmount;
  bonus_effective?: RewardAmount;
  /** How many market-days (group-days) the sums cover. */
  market_days?: number;
  [field: string]: unknown;
}

/**
 * The account's settled Pulse group-days, newest first (`me/group-history`). The backend
 * passes the rewards service's answer through untouched with a `products` label map added (group id
 * to its {@link RewardsGroupProduct}); like {@link RewardsGroupDay} it stays loose. The paginator
 * lists `lines`; `totals_by_currency` (the sums per rail) and `products` are on `Page.raw`.
 */
export interface RewardsGroupHistory {
  maker: string;
  flagged?: boolean;
  page: number;
  page_size: number;
  total: number;
  /** The sums over the whole history, one row per rail. */
  totals_by_currency?: RewardsGroupHistoryTotals[];
  lines: RewardsGroupHistoryLine[];
  /**
   * The label of each group, by group id. It may list **every group the catalogue knows**, not
   * only the groups of this account's lines, even for an account with no history. A group with
   * no label is `null`.
   */
  products: Record<string, RewardsGroupProduct | null>;
  [field: string]: unknown;
}

const looseAmount = z.looseObject({
  amount: decimalString,
  currency: z.string(),
});

export const RewardsGroupHistorySchema = defineSchema<RewardsGroupHistory>(
  (obj) =>
    z.looseObject({
      maker: z.string(),
      flagged: z.boolean().optional(),
      page: z.number(),
      page_size: z.number(),
      total: z.number(),
      totals_by_currency: z
        .array(
          z.looseObject({
            currency: z.string(),
            allocated: looseAmount.optional(),
            effective: looseAmount.optional(),
            credited: looseAmount.optional(),
            base_effective: looseAmount.optional(),
            bonus_effective: looseAmount.optional(),
            market_days: z.number().optional(),
          }),
        )
        .optional(),
      lines: z.array(
        z.looseObject({
          market_id: z.string(),
          group_id: z.string().nullish(),
          epoch: z.number(),
          day_open_ms: z.number().optional(),
          day_close_ms: z.number().optional(),
          currency: z.string(),
          score: exactText.optional(),
          score_share: exactText.optional(),
          allocated: looseAmount.optional(),
          effective: looseAmount.optional(),
          credited: looseAmount.nullish(),
          status: z.string(),
          base_amount: looseAmount.optional(),
          bonus_amount: looseAmount.optional(),
        }),
      ),
      products: z.record(z.string(), productSchema(obj).nullable()),
    }),
);

// ---------------------------------------------------------------------------
// Leaderboard (the backend's presenter: camelCase)
// ---------------------------------------------------------------------------

/** A maker on the liquidity leaderboard, with the XO profile of its wallet when it has one. */
export interface RewardsLeaderboardRow {
  rank: number;
  walletAddress: string;
  /** The XO user id; `null` for a wallet with no XO account. */
  id: number | null;
  username: string | null;
  name: string | null;
  profilePictureUrl: string | null;
  roosterColor: string | null;
  /** The maker's effective CP for the period, in whole CP. */
  liquidityCp: DecimalString;
  /** The CP credited for the period. */
  creditedCp: DecimalString;
  /** Market-days the maker earned on in the window. */
  marketDays: number;
  achievements: string[];
  verified: boolean;
  /** Holds the OG role (top 5% of the daily leaderboard). */
  isOg: boolean;
  cpPoints: number;
  tier: string;
}

/** The leaderboard with its window; the paginator lists `data`. */
export interface RewardsLeaderboardPage {
  data: RewardsLeaderboardRow[];
  period: 'daily' | 'weekly' | 'seasonal' | (string & {});
  /** The first UTC day (epoch) of the window, inclusive. */
  fromEpoch: number;
  toEpoch: number;
  /** All effective CP in the window. */
  totalCp: DecimalString;
  meta: PageMeta;
}

const leaderboardRowSchema = (obj: ObjFactory) =>
  obj({
    rank: z.number(),
    walletAddress: z.string(),
    id: z.number().nullable(),
    username: z.string().nullable(),
    name: z.string().nullable(),
    profilePictureUrl: z.string().nullable(),
    roosterColor: z.string().nullable(),
    liquidityCp: decimalString,
    creditedCp: decimalString,
    marketDays: z.number(),
    achievements: z.array(z.string()),
    verified: z.boolean(),
    isOg: z.boolean(),
    cpPoints: z.number(),
    tier: z.string(),
  });

export const RewardsLeaderboardPageSchema =
  defineSchema<RewardsLeaderboardPage>((obj, enumOf) =>
    obj({
      data: z.array(leaderboardRowSchema(obj)),
      period: enumOf(LEADERBOARD_PERIODS),
      fromEpoch: z.number(),
      toEpoch: z.number(),
      totalCp: decimalString,
      meta: pageMetaSchema(obj),
    }),
  );

export const RewardsLeaderboardRowSchema = defineSchema<RewardsLeaderboardRow>(
  (obj) => leaderboardRowSchema(obj),
);
