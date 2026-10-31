// Response schemas of the trade feeds: the public ones (`GET /markets/:id/activity` and
// `GET /markets/activities`: one fill of a market, with its fees and the trader), the
// account's own market feed (`GET /users/me/market-activities`: the same plus the trade's
// PnL) and the account's activity history (`GET /users/me/activities`). Markets and the
// shared building blocks are in `schemas.ts`. The conventions are the same: the backend's own
// field names, money-like fields as `DecimalString` or `RawUnitsString`, ISO-8601
// timestamps.

import { z } from 'zod';
import type { EnumFactory, ObjFactory } from '../core/schema';
import type { DecimalString, RawUnitsString } from '../core/types';
import { type EventPlacement, eventPlacementSchema } from './catalogSchemas';
import {
  decimalString,
  type EffectiveFeeConfig,
  effectiveFeeConfigSchema,
  pageOf,
  rawUnits,
} from './schemas';

const timestamp = z.string();

/**
 * What a row of the account's position history can be, so what the account's own trade feeds'
 * `positionType` can say:
 * - `BUY`, `SELL`, `REDEEM`: the backend's own history types;
 * - `SPLIT`, `MERGE`, `TRANSFER_IN`, `TRANSFER_OUT`, `REFUND`: written by the indexer. The
 *   backend has been seen to answer the first three of them on `GET /users/me/activities` and
 *   `/users/me/market-activities`.
 *
 * The backend also names `REBALANCE_*` and `CREATOR_*` families without their members, so they
 * are not listed: strict mode reports one as an unknown value, lenient mode passes it on.
 */
export const HISTORY_POSITION_TYPES = [
  'BUY',
  'SELL',
  'REDEEM',
  'SPLIT',
  'MERGE',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'REFUND',
] as const;

/**
 * What the public REST trade feeds (`markets.activity`, `markets.allActivity`) can say: order
 * fills, `BUY` and `SELL`. The backend has been seen to list and count only these two on its
 * public activity feeds, for the user rows and the creator rows alike, and an explicit
 * `positionType` filter is `BUY`, `SELL` or `all`. So `REDEEM` cannot appear on these feeds,
 * nor can a split, merge, transfer or refund: strict mode refuses them. (The market activity
 * channel is not bound by this list: its `userTradesOnly` snapshots list the account's own history,
 * see `socketioEvents.ts`.)
 */
const FEED_POSITION_TYPES = ['BUY', 'SELL'] as const;

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

/** The trader of an activity row. */
export interface ActivityUser {
  id: number;
  username: string;
  roosterColor?: string | null;
  profilePictureUrl?: string | null;
  achievements?: string[];
  verified?: boolean;
  isOg: boolean;
  cpPoints?: number;
  tier?: string;
}

/** A position a trader holds, attached to an activity row. */
export interface ActivityPosition {
  id: number;
  positionType: string;
  /** In the collateral token's raw units. */
  collateralAmount: RawUnitsString;
  /** In raw share units. */
  shareAmount: RawUnitsString;
  status: string;
  outcome: { id: number; title: string; index: number } | null;
  market: { id: number; title: string } | null;
}

/** The on-chain CLOB fee of one fill. */
export interface ActivityTradingFee {
  /** In raw token units. */
  feeAmount: RawUnitsString;
  feeInUSD: DecimalString | null;
  isTaker: boolean | null;
  /** Collateral actually moved (principal plus or minus fee), in raw token units. */
  netCollateralAmount: RawUnitsString | null;
}

/** The fee share a wallet earned on a transaction. */
export interface ActivityFeeEarned {
  /** In raw token units. */
  amount: RawUnitsString;
  amountInUSD: DecimalString | null;
}

/** The market of an activity row. */
export interface MarketActivityMarket {
  id: number;
  contractMarketId: string;
  title?: string | null;
  slug?: string | null;
  eventId?: string | null;
  eventSlug?: string | null;
  imageUrl?: string | null;
  status?: string | null;
  expiresAt?: string | null;
  creatorBps?: number | null;
  totalVolumeInUSD?: DecimalString | null;
  cpEnabled?: boolean;
  collateralToken?: {
    id: number;
    tokenAddress: string;
    decimals: number;
    symbol: string;
    logoUrl: string;
  } | null;
}

/** One fill (or creator unlock) of the public trade feeds. */
export interface MarketActivity {
  id: number;
  activityType: 'USER_TRADE' | 'CREATOR_UNLOCK' | (string & {});
  /**
   * The public feeds list order fills only: `BUY` and `SELL` (see `FEED_POSITION_TYPES` in
   * activitySchemas.ts). The account's own feed lists more kinds ({@link UserMarketActivity}).
   */
  positionType: 'BUY' | 'SELL' | (string & {});
  /** The collateral moved, in raw token units (includes fees). Negative on a sell. */
  collateralAmount: RawUnitsString;
  /** `collateralAmount` without fees, in raw token units. */
  initialCollateral: RawUnitsString;
  /** Shares, in raw units. */
  shareAmount: RawUnitsString;
  volumeInUSD: DecimalString;
  /** The price at execution, in raw units. */
  priceAtExecution?: RawUnitsString | null;
  transactionHash?: string | null;
  /** Conviction points earned by the trade. */
  cpEarned?: DecimalString;
  lifetimeEarnedCp?: DecimalString;
  avgEntryValue?: DecimalString;
  avgCurrentValue?: DecimalString;
  avgPnl?: DecimalString;
  avgPnlPercentage?: number;
  /** The average entry price, in raw token units. */
  avgEntryPrice?: RawUnitsString;
  executedAt: string;
  createdAt: string;
  user: ActivityUser | null;
  outcome: {
    id: number;
    title: string;
    index: number;
    /** In raw token units. */
    currentPrice: RawUnitsString;
    volumeTradedInUSD: DecimalString;
  } | null;
  /**
   * The market of the row. `null` when the row carries none: the per-market feed leaves it
   * out, since the market is in the URL.
   */
  market: MarketActivityMarket | null;
  userPositions: ActivityPosition[];
  creatorFee: { creatorFeeBps: number; creatorFeePercentage: number };
  /** The on-chain CLOB fee of this fill, when indexed. */
  tradingFee?: ActivityTradingFee | null;
  feeEarned?: ActivityFeeEarned | null;
  /** Signed net fee in USD: negative paid (taker), positive earned. */
  netFeeUSD?: DecimalString | null;
  marketEffectiveFeeConfig?: EffectiveFeeConfig | null;
}

const marketFields = (obj: ObjFactory) => ({
  id: z.number(),
  contractMarketId: z.string(),
  title: z.string().nullish(),
  slug: z.string().nullish(),
  eventId: z.string().nullish(),
  eventSlug: z.string().nullish(),
  imageUrl: z.string().nullish(),
  status: z.string().nullish(),
  expiresAt: timestamp.nullish(),
  creatorBps: z.number().nullish(),
  totalVolumeInUSD: decimalString.nullish(),
  cpEnabled: z.boolean().optional(),
  collateralToken: obj({
    id: z.number(),
    tokenAddress: z.string(),
    decimals: z.number(),
    symbol: z.string(),
    logoUrl: z.string(),
  }).nullish(),
});

const tradingFeeSchema = (obj: ObjFactory) =>
  obj({
    feeAmount: rawUnits,
    feeInUSD: decimalString.nullable(),
    isTaker: z.boolean().nullable(),
    netCollateralAmount: rawUnits.nullable(),
  });

const feeEarnedSchema = (obj: ObjFactory) =>
  obj({
    amount: rawUnits,
    amountInUSD: decimalString.nullable(),
  });

const activityFields = <const P extends readonly [string, ...string[]]>(
  obj: ObjFactory,
  enumOf: EnumFactory,
  positionTypes: P,
) => ({
  id: z.number(),
  activityType: enumOf(['USER_TRADE', 'CREATOR_UNLOCK']),
  positionType: enumOf(positionTypes),
  collateralAmount: rawUnits,
  initialCollateral: rawUnits,
  shareAmount: rawUnits,
  volumeInUSD: decimalString,
  priceAtExecution: rawUnits.nullish(),
  transactionHash: z.string().nullish(),
  cpEarned: decimalString.optional(),
  lifetimeEarnedCp: decimalString.optional(),
  avgEntryValue: decimalString.optional(),
  avgCurrentValue: decimalString.optional(),
  avgPnl: decimalString.optional(),
  avgPnlPercentage: z.number().optional(),
  avgEntryPrice: rawUnits.optional(),
  executedAt: timestamp,
  createdAt: timestamp,
  user: obj({
    id: z.number(),
    username: z.string(),
    roosterColor: z.string().nullish(),
    profilePictureUrl: z.string().nullish(),
    achievements: z.array(z.string()).optional(),
    verified: z.boolean().optional(),
    isOg: z.boolean(),
    cpPoints: z.number().optional(),
    tier: z.string().optional(),
  }).nullable(),
  outcome: obj({
    id: z.number(),
    title: z.string(),
    index: z.number(),
    currentPrice: rawUnits,
    volumeTradedInUSD: decimalString,
  }).nullable(),
  market: obj(marketFields(obj)).nullable(),
  userPositions: z.array(
    obj({
      id: z.number(),
      positionType: z.string(),
      collateralAmount: rawUnits,
      shareAmount: rawUnits,
      status: z.string(),
      outcome: obj({
        id: z.number(),
        title: z.string(),
        index: z.number(),
      }).nullable(),
      market: obj({ id: z.number(), title: z.string() }).nullable(),
    }),
  ),
  creatorFee: obj({
    creatorFeeBps: z.number(),
    creatorFeePercentage: z.number(),
  }),
  tradingFee: tradingFeeSchema(obj).nullish(),
  feeEarned: feeEarnedSchema(obj).nullish(),
  netFeeUSD: decimalString.nullish(),
  marketEffectiveFeeConfig: effectiveFeeConfigSchema(obj, enumOf).nullish(),
});

/**
 * A row of a trade feed that shares the public presenter. By default the public REST feeds' row:
 * fills only (`FEED_POSITION_TYPES`). A channel that can carry the account's own history passes
 * `HISTORY_POSITION_TYPES` (the market activity snapshot, see `socketioEvents.ts`).
 */
export const activitySchema = <
  const P extends readonly [string, ...string[]] = typeof FEED_POSITION_TYPES,
>(
  obj: ObjFactory,
  enumOf: EnumFactory,
  positionTypes: P = FEED_POSITION_TYPES as unknown as P,
) => obj(activityFields(obj, enumOf, positionTypes));

export const MarketActivitiesPageSchema =
  pageOf<MarketActivity>(activitySchema);

// ---------------------------------------------------------------------------
// The account's own feeds
// ---------------------------------------------------------------------------

/** The market of a row of the account's market feed: the CLOB pulse round is `cycleNumber`. */
export interface UserMarketActivityMarket extends MarketActivityMarket {
  /** The CLOB pulse round id; only for CLOB pulse markets. */
  cycleNumber?: number;
}

/**
 * One trade of the account in `GET /users/me/market-activities`: the public feed's row plus
 * the trade's realised PnL.
 */
export interface UserMarketActivity
  extends Omit<MarketActivity, 'market' | 'positionType'> {
  market: UserMarketActivityMarket | null;
  /**
   * Every kind of position-history row: the fills, the redeems, and the transfers, splits
   * and merges too (see `HISTORY_POSITION_TYPES` in activitySchemas.ts).
   */
  positionType:
    | 'BUY'
    | 'SELL'
    | 'REDEEM'
    | 'SPLIT'
    | 'MERGE'
    | 'TRANSFER_IN'
    | 'TRANSFER_OUT'
    | 'REFUND'
    | (string & {});
  /** The realised PnL of the trade in USD: typically 0 on a buy, set on a sell or redeem. */
  pnlInUSD: DecimalString;
}

export const UserMarketActivitiesPageSchema = pageOf<UserMarketActivity>(
  (obj, enumOf) =>
    obj({
      ...activityFields(obj, enumOf, HISTORY_POSITION_TYPES),
      market: obj({
        ...marketFields(obj),
        cycleNumber: z.number().optional(),
      }).nullable(),
      pnlInUSD: decimalString,
    }),
);

/**
 * One row of the account's activity history (`GET /users/me/activities`): a trade
 * (`activityType` `'user'`) or a creator share unlock (`'creator'`), with a text summary.
 */
export interface UserActivity {
  marketTitle: string;
  marketId: number | null;
  /** A text summary, such as `Bought 2.1290 YES shares @ $0.58686`. */
  description: string;
  picture?: string | null;
  slug?: string | null;
  /** When the activity was executed. */
  date: string;
  /** Conviction points earned (trades only). */
  cpEarned: DecimalString;
  unsettledCp?: DecimalString | null;
  lifetimeEarnedCp?: DecimalString | null;
  cpEnabled?: boolean;
  /** Entry value in USD (shares times the average entry price), when a position exists. */
  avgEntryValue?: DecimalString | null;
  avgCurrentValue?: DecimalString | null;
  avgPnl?: DecimalString | null;
  /** In percent. */
  avgPnlPercentage?: number | null;
  /** The average entry price, in raw token units. */
  avgEntryPrice?: RawUnitsString | null;
  activityType: 'user' | 'creator' | (string & {});
  /** Every kind of position-history row (see `HISTORY_POSITION_TYPES` in activitySchemas.ts). */
  positionType:
    | 'BUY'
    | 'SELL'
    | 'REDEEM'
    | 'SPLIT'
    | 'MERGE'
    | 'TRANSFER_IN'
    | 'TRANSFER_OUT'
    | 'REFUND'
    | (string & {});
  /** The notional in USD; for a redeem the actual payout. */
  volumeInUSD: DecimalString;
  tradingFee?: ActivityTradingFee | null;
  feeEarned?: ActivityFeeEarned | null;
  /** Signed net fee in USD: negative paid (taker), positive earned. */
  netFeeUSD?: DecimalString | null;
  contractMarketId?: string | null;
  /** The event placement of the market; not set on this route today. */
  event?: EventPlacement | null;
}

export const UserActivitiesPageSchema = pageOf<UserActivity>((obj, enumOf) =>
  obj({
    marketTitle: z.string(),
    marketId: z.number().nullable(),
    description: z.string(),
    picture: z.string().nullish(),
    slug: z.string().nullish(),
    date: timestamp,
    cpEarned: decimalString,
    unsettledCp: decimalString.nullish(),
    lifetimeEarnedCp: decimalString.nullish(),
    cpEnabled: z.boolean().optional(),
    avgEntryValue: decimalString.nullish(),
    avgCurrentValue: decimalString.nullish(),
    avgPnl: decimalString.nullish(),
    avgPnlPercentage: z.number().nullish(),
    avgEntryPrice: rawUnits.nullish(),
    activityType: enumOf(['user', 'creator']),
    positionType: enumOf(HISTORY_POSITION_TYPES),
    volumeInUSD: decimalString,
    tradingFee: tradingFeeSchema(obj).nullish(),
    feeEarned: feeEarnedSchema(obj).nullish(),
    netFeeUSD: decimalString.nullish(),
    contractMarketId: z.string().nullish(),
    event: eventPlacementSchema(obj).nullish(),
  }),
);
