import { type Address, type Hex, isHash } from 'viem';
import type { TxResult as RawTxResult } from '../account/chain';
import type { SetupAction } from '../account/client';
import { CLOB_MARKET_TYPES } from '../account/settle';
import { numberToDecimal } from '../core/decimal';
import type { XoError } from '../core/errors';
import type { ConditionId, DecimalString, TokenId } from '../core/types';
import type {
  AccountProfile as RawAccountProfile,
  ApiKeyInfo as RawApiKeyInfo,
  ProfileBadge as RawProfileBadge,
  PublicProfile as RawPublicProfile,
  UserSocials as RawUserSocials,
  UserStats as RawUserStats,
} from '../data/accountSchemas';
import type { UserMarketActivity as RawUserMarketActivity } from '../data/activitySchemas';
import type { EventPlacement as RawEventPlacement } from '../data/catalogSchemas';
import type {
  PnlMarket as RawPnlMarket,
  PnlPosition as RawPnlPosition,
  PnlSummary as RawPnlSummary,
  PortfolioMarket as RawPortfolioMarket,
  PortfolioMarketPosition as RawPortfolioMarketPosition,
  PortfolioPosition as RawPortfolioPosition,
  PortfolioValue as RawPortfolioValue,
} from '../data/portfolioSchemas';
import type { Positions as RawPositions } from '../orderbook/schemas';
import {
  addressOf,
  conditionIdOrNull,
  signedWholeUnitsOf,
  textOrNull,
  tokenIdOf,
  wholeUnitsOf,
} from './convert';
import { OrderSide } from './enums';
import type { MarketStatus } from './market';

// The public account models: the positions an account holds, its activity, portfolio value,
// profit and loss, statistics and profile, its balances and approvals, and the handle of an
// on-chain transaction. Every amount is a whole-unit decimal (dollars, shares); the
// indexer's raw units are converted exactly, and a value XO does not give is `null`.

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

/** An amount in the indexer's raw units as whole units, or `null` when it is missing. */
function wholeOrNull(
  value: string | null | undefined,
  field: string,
): DecimalString | null {
  return value === undefined || value === null
    ? null
    : wholeUnitsOf(value, field, 'backend');
}

/** Statuses of a market whose positions pay out or refund once the market is settled. */
const SETTLED_STATUSES: ReadonlySet<string> = new Set([
  'RESOLVED',
  'VOIDED',
  'VOIDED_CLOSED',
]);

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

/**
 * Where a position is, in XO's words. A status added later reads as its own string.
 *
 * - `OPEN`: the account holds shares of the outcome.
 * - `REDEEMABLE`: the market has resolved (or been voided) and the winnings of the position
 *   are not claimed yet. Whether the SDK can redeem them is {@link Position.redeemable}.
 * - `CLOSED`: XO reports the position closed, and there is nothing left to redeem.
 */
export type PositionStatus = 'OPEN' | 'REDEEMABLE' | 'CLOSED' | (string & {});

/**
 * What the account holds in one outcome of one market, with its value and profit.
 *
 * `positionId` and `marketId` are XO's own ids, for reads that take them (`fetchUserPnl`).
 * A field XO has no value for is `null`.
 */
export type Position = {
  /** XO's id for the position. Pass it as `positionId` to read the position's profit and loss. */
  positionId: string;
  /** XO's id for the position's market (the `id` of a `Market`). */
  marketId: string;
  /** The account's wallet address. */
  wallet: Address;
  /** The outcome token held, or `null` when XO gave none. */
  assetId: TokenId | null;
  /** The market's id on the order book, or `null` when XO gave none. */
  conditionId: ConditionId | null;
  /** The shares held. */
  currentSize: DecimalString;
  /** The average price paid per share, in dollars between 0 and 1. `null` when XO gave none. */
  avgPrice: DecimalString | null;
  /** The outcome's current price, in dollars between 0 and 1. `null` when XO gave none. */
  currentPrice: DecimalString | null;
  /** What the shares are worth now, in dollars. */
  currentValue: DecimalString;
  /** What the shares cost at the average entry price, in dollars. */
  entryCostUsdc: DecimalString;
  /** The profit or loss on the shares held: `currentValue - entryCostUsdc`, in dollars. */
  unrealizedPnl: DecimalString;
  /** The profit or loss already taken, in dollars (negative for a loss). `null` when XO gave none. */
  realizedPnl: DecimalString | null;
  /** The profit or loss on the shares held, in percent. */
  percentPnl: DecimalString;
  /** Where the position is. */
  status: PositionStatus;
  /**
   * Whether the SDK can redeem the position now (`redeemPositions`, `redeemAllPositions`): its
   * market is `RESOLVED`, `VOIDED` or `VOIDED_CLOSED`, the winnings are not claimed, and it is a
   * market of the order book. A settled position of an older market type, which pays out on that
   * market's own contract, reads `status: 'REDEEMABLE'` and `redeemable: false`.
   */
  redeemable: boolean;
  /** The market's question. */
  title: string;
  /** The market's URL name. */
  slug: string;
  /** The market's picture. */
  icon: string | null;
  /** The id of the event the market is placed on. `null` when it stands alone. */
  eventId: string | null;
  /** The URL name of the event the market is placed on. `null` when it stands alone. */
  eventSlug: string | null;
  /** The outcome held, such as `Yes`. `null` when XO gave none. */
  outcome: string | null;
  /** The outcome's index in the market: 0 for the first, 1 for the second. `null` when XO gave none. */
  outcomeIndex: number | null;
  /** When the market ends, as an ISO 8601 time. */
  endDate: string | null;
  /** When the position was opened, as an ISO 8601 time. */
  firstEntryAt: string;
  /** When the position last changed, as an ISO 8601 time. */
  lastEventAt: string;
};

function positionStatusOf(
  raw: RawPortfolioPosition,
): Pick<Position, 'status' | 'redeemable'> {
  const unclaimed = SETTLED_STATUSES.has(raw.market.status) && !raw.hasClaimed;
  if (unclaimed) {
    // A market of another type pays out on its own contract, which the SDK does not redeem on.
    return {
      status: 'REDEEMABLE',
      redeemable: CLOB_MARKET_TYPES.has(raw.market.type),
    };
  }
  return {
    status: raw.status === 'ACTIVE' ? 'OPEN' : 'CLOSED',
    redeemable: false,
  };
}

/**
 * Maps a portfolio position to the {@link Position} model. For a position inside a summary
 * row, pass the row's event placement: the position's own market does not carry it.
 *
 * @throws {UnexpectedResponseError} When an amount is not micro-units.
 * @internal
 */
export function toPosition(
  raw: RawPortfolioPosition | RawPortfolioMarketPosition,
  event?: RawEventPlacement | null,
): Position {
  const placement = event ?? raw.market.event ?? null;
  const currentPrice =
    'currentPrice' in raw ? raw.currentPrice : raw.outcome?.currentPrice;
  const outcome = raw.outcome ?? null;
  const tokenId = textOrNull(outcome?.outcomeTokenId);
  return {
    positionId: String(raw.id),
    marketId: String(raw.marketId),
    wallet: addressOf(raw.userAddress),
    assetId: tokenId === null ? null : tokenIdOf(tokenId),
    conditionId: conditionIdOrNull(raw.market.conditionId),
    currentSize: wholeUnitsOf(raw.shareAmount, 'currentSize', 'backend'),
    avgPrice: wholeOrNull(raw.entryPrice, 'avgPrice'),
    currentPrice: wholeOrNull(currentPrice, 'currentPrice'),
    currentValue: raw.currentValue,
    entryCostUsdc: raw.entryValue,
    unrealizedPnl: raw.pnl,
    realizedPnl:
      raw.totalPnlInCollateral === null
        ? null
        : signedWholeUnitsOf(
            raw.totalPnlInCollateral,
            'realizedPnl',
            'backend',
          ),
    percentPnl: numberToDecimal(raw.pnlPercentage, 'percentPnl'),
    ...positionStatusOf(raw),
    title: raw.market.title,
    slug: raw.market.slug,
    icon: textOrNull(raw.market.imageUrl),
    eventId: placement?.rootEventId ?? null,
    eventSlug: placement?.rootEventSlug ?? null,
    outcome: outcome?.title ?? null,
    outcomeIndex: outcome?.index ?? null,
    endDate: raw.market.expiresAt ?? null,
    firstEntryAt: raw.createdAt,
    lastEventAt: raw.updatedAt,
  };
}

/**
 * Maps a row of the portfolio summary (one market with the account's positions in it) to its
 * positions, in order, each with the row's event.
 *
 * @throws {UnexpectedResponseError} When an amount is not micro-units.
 * @internal
 */
export function toPositions(raw: RawPortfolioMarket): Position[] {
  return raw.positions.map((position) => toPosition(position, raw.event));
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

/**
 * What an activity row is, in XO's words. A kind added later reads as its own string.
 *
 * - `TRADE`: a buy or a sell (see {@link Activity.side}).
 * - `REDEEM`: winnings paid out for a resolved market.
 * - `SPLIT`, `MERGE`: collateral split into a complete set of outcome shares, or a set
 *   merged back into collateral.
 * - `TRANSFER_IN`, `TRANSFER_OUT`: shares moved into or out of the account.
 * - `REFUND`: a refund.
 * - `CREATOR_UNLOCK`: a creator share unlock.
 */
export type ActivityType =
  | 'TRADE'
  | 'REDEEM'
  | 'SPLIT'
  | 'MERGE'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT'
  | 'REFUND'
  | 'CREATOR_UNLOCK'
  | (string & {});

/**
 * One row of the account's history: a trade, a redemption, a split, a merge, a transfer or a
 * refund, with the market and outcome it concerns. A field XO has no value for is `null`.
 */
export type Activity = {
  /** XO's id for the row. */
  id: string;
  /** What the row is. */
  type: ActivityType;
  /** Whether a trade bought or sold. `null` for every other type. */
  side: OrderSide | null;
  /** When it happened, as an ISO 8601 time. */
  timestamp: string;
  /** The settlement transaction. `null` when XO has none for the row. */
  transactionHash: Hex | null;
  /** XO's id for the market (the `id` of a `Market`). */
  marketId: string | null;
  /** The market's id on the order book. `null` for a market that is not on the order book. */
  conditionId: ConditionId | null;
  /** The market's question. */
  title: string | null;
  /** The market's URL name. */
  slug: string | null;
  /** The URL name of the event the market is placed on. */
  eventSlug: string | null;
  /** The market's picture. */
  icon: string | null;
  /** The outcome the row concerns, such as `Yes`. */
  outcome: string | null;
  /** The outcome's index in the market: 0 for the first, 1 for the second. */
  outcomeIndex: number | null;
  /** The shares involved. */
  shares: DecimalString;
  /** The dollar value of the row: the notional of a trade, the payout of a redeem. */
  amount: DecimalString;
  /** The price per share at execution, in dollars between 0 and 1. `null` when XO gave none. */
  price: DecimalString | null;
  /** The net fee in dollars: negative when the account paid, positive when it earned. `null` when XO gave none. */
  netFee: DecimalString | null;
  /** The profit or loss the row realised, in dollars. Typically 0 on a buy. */
  realizedPnl: DecimalString;
};

function activitySide(raw: RawUserMarketActivity): OrderSide | null {
  if (raw.activityType === 'CREATOR_UNLOCK') {
    return null;
  }
  if (raw.positionType === 'BUY') {
    return OrderSide.BUY;
  }
  return raw.positionType === 'SELL' ? OrderSide.SELL : null;
}

function activityType(raw: RawUserMarketActivity): ActivityType {
  if (raw.activityType === 'CREATOR_UNLOCK') {
    return 'CREATOR_UNLOCK';
  }
  return raw.positionType === 'BUY' || raw.positionType === 'SELL'
    ? 'TRADE'
    : raw.positionType;
}

/**
 * Maps a row of the account's market activity to the {@link Activity} model.
 *
 * @throws {UnexpectedResponseError} When an amount is not micro-units.
 * @internal
 */
export function toActivity(raw: RawUserMarketActivity): Activity {
  return {
    id: String(raw.id),
    type: activityType(raw),
    side: activitySide(raw),
    timestamp: raw.executedAt,
    transactionHash:
      typeof raw.transactionHash === 'string' && isHash(raw.transactionHash)
        ? raw.transactionHash
        : null,
    marketId: raw.market === null ? null : String(raw.market.id),
    conditionId: conditionIdOrNull(raw.market?.contractMarketId),
    title: textOrNull(raw.market?.title),
    slug: textOrNull(raw.market?.slug),
    eventSlug: textOrNull(raw.market?.eventSlug),
    icon: textOrNull(raw.market?.imageUrl),
    outcome: raw.outcome?.title ?? null,
    outcomeIndex: raw.outcome?.index ?? null,
    shares: wholeUnitsOf(raw.shareAmount, 'shares', 'backend'),
    amount: raw.volumeInUSD,
    price: wholeOrNull(raw.priceAtExecution, 'price'),
    netFee: raw.netFeeUSD ?? null,
    realizedPnl: raw.pnlInUSD,
  };
}

// ---------------------------------------------------------------------------
// Portfolio value, profit and loss, statistics
// ---------------------------------------------------------------------------

/** The account's cash and portfolio figures, in dollars. */
export type PortfolioValue = {
  /** The whole portfolio: `cash + positionsValue + claimableAmount`. */
  value: DecimalString;
  /**
   * Spendable USDC in the wallet, as XO's portfolio value reports it. This is not the order
   * book's credit ({@link Balances.collateral}); the two can differ, for example right after
   * a deposit or before a withdrawal.
   */
  cash: DecimalString;
  /** What the open positions are worth. */
  positionsValue: DecimalString;
  /** Winnings that are settled and not redeemed yet. */
  claimableAmount: DecimalString;
  /** How many open positions were valued at cost for want of a price. Above 0 the total is an estimate. */
  unpricedPositionCount: number;
};

/**
 * Maps the account's portfolio value to the {@link PortfolioValue} model.
 *
 * @internal
 */
export function toPortfolioValue(raw: RawPortfolioValue): PortfolioValue {
  return {
    value: raw.portfolioValueUSD,
    cash: raw.cashUSD,
    positionsValue: raw.positionsValueUSD,
    claimableAmount: raw.claimableAmountUSD,
    unpricedPositionCount: raw.unpricedPositionCount,
  };
}

/** The profit and loss of one position. */
export type PositionPnl = {
  /** XO's id for the position (the `positionId` of a {@link Position}). */
  positionId: string;
  /** XO's id for the position's market. */
  marketId: string;
  /** The market's question. */
  marketTitle: string;
  /** Where the market is in its life. */
  marketStatus: MarketStatus;
  /** The outcome held, such as `Yes`. */
  outcome: string;
  /** `OPEN` while the shares are held, `CLOSED` once the position is over. */
  status: PositionStatus;
  /** The shares held. */
  shares: DecimalString;
  /** The average price paid per share, in dollars between 0 and 1. */
  avgPrice: DecimalString;
  /** What the shares cost at the average entry price, in dollars. */
  entryValue: DecimalString;
  /** What the shares are worth now, in dollars. */
  currentValue: DecimalString;
  /** The profit or loss: `currentValue - entryValue`, in dollars. */
  pnl: DecimalString;
  /** The profit or loss, in percent. */
  percentPnl: DecimalString;
  /** What a share redeems for in a closed market, in dollars. `null` when it does not apply. */
  redeemableAmount: DecimalString | null;
  /** When XO calculated it, as an ISO 8601 time. */
  calculatedAt: string;
};

/** The profit and loss of the whole account: the totals and the position behind them. */
export type UserPnl = {
  /** The total profit or loss, in dollars. */
  pnl: DecimalString;
  /** The total profit or loss, in percent. */
  percentPnl: DecimalString;
  /** What all the positions cost at their average entry prices, in dollars. */
  entryValue: DecimalString;
  /** What all the positions are worth now, in dollars. */
  currentValue: DecimalString;
  /** How many positions are open. */
  openPositions: number;
  /** How many positions are closed. */
  closedPositions: number;
  /** How many positions XO could not calculate. */
  failedCalculations: number;
  /** The positions behind the totals. */
  positions: PositionPnl[];
};

/** The profit and loss of the account's positions in one market. */
export type MarketPnl = {
  /** XO's id for the market. */
  marketId: string;
  /** The market's question. */
  title: string;
  /** The profit or loss on the market, in dollars. */
  pnl: DecimalString;
  /** The profit or loss on the market, in percent. */
  percentPnl: DecimalString;
  /** The account's positions in the market. */
  positions: PositionPnl[];
};

/**
 * Maps the profit and loss of one position to the {@link PositionPnl} model.
 *
 * @throws {UnexpectedResponseError} When an amount is not micro-units.
 * @internal
 */
export function toPositionPnl(raw: RawPnlPosition): PositionPnl {
  return {
    positionId: String(raw.positionId),
    marketId: String(raw.marketId),
    marketTitle: raw.marketTitle,
    marketStatus: raw.marketStatus,
    outcome: raw.outcomeTitle,
    status: raw.calculationType === 'ACTIVE' ? 'OPEN' : raw.calculationType,
    shares: wholeUnitsOf(raw.shareAmount, 'shares', 'backend'),
    avgPrice: wholeUnitsOf(raw.entryPrice, 'avgPrice', 'backend'),
    entryValue: raw.entryValue,
    currentValue: raw.currentValue,
    pnl: raw.pnl,
    percentPnl: numberToDecimal(raw.pnlPercentage, 'percentPnl'),
    redeemableAmount: raw.redeemableAmount ?? null,
    calculatedAt: raw.calculatedAt,
  };
}

/**
 * Maps the account's profit and loss to the {@link UserPnl} model.
 *
 * @throws {UnexpectedResponseError} When an amount is not micro-units.
 * @internal
 */
export function toUserPnl(raw: RawPnlSummary): UserPnl {
  return {
    pnl: raw.totalPnl,
    percentPnl: numberToDecimal(raw.totalPnlPercentage, 'percentPnl'),
    entryValue: raw.totalEntryValue,
    currentValue: raw.totalCurrentValue,
    openPositions: raw.activePositionsCount,
    closedPositions: raw.closedPositionsCount,
    failedCalculations: raw.calculationErrors,
    positions: raw.positions.map(toPositionPnl),
  };
}

/**
 * Maps the profit and loss of one market to the {@link MarketPnl} model.
 *
 * @throws {UnexpectedResponseError} When an amount is not micro-units.
 * @internal
 */
export function toMarketPnl(raw: RawPnlMarket): MarketPnl {
  return {
    marketId: String(raw.marketId),
    title: raw.marketTitle,
    pnl: raw.totalPnl,
    percentPnl: numberToDecimal(raw.totalPnlPercentage, 'percentPnl'),
    positions: raw.positions.map(toPositionPnl),
  };
}

/** A trader's statistics. A figure XO does not have yet is `null`. */
export type UserStats = {
  /** The total profit or loss, in dollars. */
  pnl: DecimalString | null;
  /** The total volume traded, in dollars. */
  volume: DecimalString | null;
  /** How many different markets the trader has traded. */
  tradedMarketCount: number | null;
};

/**
 * Maps a trader's statistics to the {@link UserStats} model.
 *
 * @internal
 */
export function toUserStats(raw: RawUserStats): UserStats {
  return {
    pnl: raw.pnl,
    volume: raw.volume,
    tradedMarketCount: raw.marketsTraded,
  };
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/** The social handles of a user, without the `@`. `null` means not connected. */
export type ProfileSocials = {
  /** The user's X handle. */
  x: string | null;
  /** The user's TikTok handle. */
  tiktok: string | null;
  /** The user's Instagram handle. */
  instagram: string | null;
  /** The user's Discord name. */
  discord: string | null;
};

/** A badge on a profile. */
export type ProfileBadge = {
  /** The badge, such as `CATALYST`. */
  key: string;
  /** Whether the user earned it. */
  earned: boolean;
  /** Whether it was taken back. */
  revoked: boolean;
};

/** Points the account has earned for its activity. */
export type ProfilePoints = {
  /** The points the account holds now. */
  current: DecimalString;
  /** The points the account has earned in all. */
  totalEarned: DecimalString;
};

/** The account's own profile. */
export type Profile = {
  /** XO's id for the account. */
  id: string;
  /** The account's unique name. */
  username: string;
  /** The account's display name. */
  name: string | null;
  /** The account's wallet address. */
  wallet: Address;
  /** The account's biography. */
  bio: string | null;
  /** The account's picture. */
  profileImage: string | null;
  /** Whether the account is verified. */
  verifiedBadge: boolean;
  /** Whether the account holds the OG role (the top 5% of the daily leaderboard). */
  isOg: boolean;
  /** Whether the account is an ambassador. */
  isAmbassador: boolean;
  /** Whether the profile is hidden from other users. */
  isPrivate: boolean;
  /** The account's standing, such as `ACTIVE`. */
  status: 'ACTIVE' | 'SUSPENDED' | 'BANNED' | 'INACTIVE' | (string & {});
  /** The account's connected social handles. */
  socials: ProfileSocials;
  /** The account's referral code. */
  referralCode: string | null;
  /** The account's conviction points, as an exact decimal. */
  convictionPoints: DecimalString;
  /** The account's tier, such as `Believer`. */
  tier: string;
  /** The points the account has earned. */
  points: ProfilePoints;
  /** The total volume the account has traded, in dollars. */
  volume: DecimalString;
  /** When the account was created, as an ISO 8601 time. */
  createdAt: string;
  /** When the account last changed, as an ISO 8601 time. */
  updatedAt: string;
  /** When the account was last active, as an ISO 8601 time. */
  lastActiveAt: string | null;
  /** When the account last signed in, as an ISO 8601 time. */
  lastLoginAt: string | null;
};

/** The profile of any user, as others see it. A private profile has `null` for what it hides. */
export type PublicProfile = {
  /** XO's id for the user. */
  id: string;
  /** The user's unique name. */
  username: string;
  /** The user's display name. */
  name: string | null;
  /** The user's biography. `null` on a private profile. */
  bio: string | null;
  /** The user's picture. */
  profileImage: string | null;
  /** Whether the user is verified. */
  verifiedBadge: boolean;
  /** Whether the user holds the OG role (the top 5% of the daily leaderboard). */
  isOg: boolean;
  /** Whether the profile is hidden. */
  isPrivate: boolean;
  /** The user's connected social handles. `null` on a private profile. */
  socials: ProfileSocials | null;
  /** The user's badges. `null` on a private profile. */
  badges: ProfileBadge[] | null;
  /** The keys of the badges the user earned. `null` on a private profile. */
  achievements: string[] | null;
  /** The user's conviction points, as an exact decimal. */
  convictionPoints: DecimalString | null;
  /** The user's tier, such as `Believer`. */
  tier: string | null;
};

function socialsOf(raw: RawUserSocials): ProfileSocials {
  return {
    x: raw.x,
    tiktok: raw.tiktok,
    instagram: raw.instagram,
    discord: raw.discord,
  };
}

function badgeOf(raw: RawProfileBadge): ProfileBadge {
  return { key: raw.key, earned: raw.earned, revoked: raw.isRevoked };
}

/**
 * Maps the account's own profile to the {@link Profile} model. The lists XO leaves empty on
 * this profile (positions, history) are not part of it.
 *
 * @internal
 */
export function toProfile(raw: RawAccountProfile): Profile {
  return {
    id: String(raw.id),
    username: raw.username,
    name: raw.name ?? null,
    wallet: addressOf(raw.walletPublicKey),
    bio: raw.bio ?? null,
    profileImage: raw.profilePictureUrl,
    verifiedBadge: raw.verified,
    isOg: raw.isOg,
    isAmbassador: raw.isAmbassador,
    isPrivate: raw.isPrivate,
    status: raw.status,
    socials: socialsOf(raw.socials),
    referralCode: raw.referralCode ?? null,
    convictionPoints: numberToDecimal(raw.cpPoints, 'convictionPoints'),
    tier: raw.tier,
    points: {
      current: raw.userPoints.currentPoints,
      totalEarned: raw.userPoints.totalPointsEarned,
    },
    volume: raw.userVolume,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    lastActiveAt: raw.lastActiveAt ?? null,
    lastLoginAt: raw.lastLoginAt ?? null,
  };
}

/**
 * Maps the public profile of a user to the {@link PublicProfile} model.
 *
 * @internal
 */
export function toPublicProfile(raw: RawPublicProfile): PublicProfile {
  return {
    id: String(raw.id),
    username: raw.username,
    name: raw.name ?? null,
    bio: raw.bio ?? null,
    profileImage: raw.profilePictureUrl ?? null,
    verifiedBadge: raw.verified,
    isOg: raw.isOg,
    isPrivate: raw.isPrivate,
    socials: raw.socials == null ? null : socialsOf(raw.socials),
    badges: raw.profileBadges == null ? null : raw.profileBadges.map(badgeOf),
    achievements: raw.achievements == null ? null : [...raw.achievements],
    convictionPoints:
      raw.cpPoints == null
        ? null
        : numberToDecimal(raw.cpPoints, 'convictionPoints'),
    tier: raw.tier ?? null,
  };
}

// ---------------------------------------------------------------------------
// Balances and approvals
// ---------------------------------------------------------------------------

/** The shares of one outcome token the order book credits to the account. */
export type PositionBalance = {
  /** The outcome token. */
  assetId: TokenId;
  /** The shares the account holds. */
  balance: DecimalString;
  /** Of those, the shares reserved by resting sell orders. */
  reserved: DecimalString;
};

/**
 * What the order book holds for the account: its credit in cash, and its outcome shares with
 * what resting sell orders reserve. These are the order book's records, not the balances at
 * the wallet address on chain, and the two can differ, for example right after a deposit or
 * before a withdrawal.
 */
export type Balances = {
  /**
   * The cash credit the order book holds for the account, in dollars. This is not the USDC at
   * the wallet address on chain, and the two can differ, for example right after a deposit or
   * before a withdrawal.
   */
  collateral: DecimalString;
  /** The outcome shares the account holds. Tokens with no balance are left out. */
  positions: PositionBalance[];
};

/**
 * Maps the order book's view of the account's holdings to the {@link Balances} model.
 *
 * @throws {UnexpectedResponseError} When an amount is not micro-units.
 * @internal
 */
export function toBalances(raw: RawPositions): Balances {
  return {
    collateral: wholeUnitsOf(raw.cash_balance, 'collateral'),
    positions: raw.positions.map((entry, index) => ({
      assetId: tokenIdOf(entry.token_id),
      balance: wholeUnitsOf(entry.balance, `positions[${index}].balance`),
      reserved: wholeUnitsOf(entry.reserved, `positions[${index}].reserved`),
    })),
  };
}

/** What the account has set up for trading. */
export type TradingApprovalsState = {
  /** Whether the trading account exists on chain. A plain wallet always does. */
  deployed: boolean;
  /** Whether the exchange may spend the account's USDC. */
  usdcApproved: boolean;
  /** Whether the exchange may move the account's outcome tokens. */
  conditionalTokensApproved: boolean;
  /** Whether the market manager may spend the account's USDC. `null` when it was not read. */
  marketManagerApproved: boolean | null;
  /** Whether the account can trade: it is deployed and the exchange is approved for USDC and outcome tokens. */
  ready: boolean;
};

/**
 * Builds the {@link TradingApprovalsState} from what setting the account up would still send.
 * Each missing step is one thing that is not in place yet.
 *
 * @param missing The steps setup would send, as the account client plans them.
 * @param includeMarketManager Whether the market manager's approval was checked.
 * @internal
 */
export function toTradingApprovalsState(
  missing: readonly SetupAction[],
  includeMarketManager: boolean,
): TradingApprovalsState {
  const deployed = !missing.includes('deploy');
  const usdcApproved = !missing.includes('approve_usdc');
  const conditionalTokensApproved = !missing.includes('approve_ctf');
  return {
    deployed,
    usdcApproved,
    conditionalTokensApproved,
    marketManagerApproved: includeMarketManager
      ? !missing.includes('approve_manager')
      : null,
    ready: deployed && usdcApproved && conditionalTokensApproved,
  };
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/** How a mined transaction ended. A revert is a result, not an error: check `status`. */
export type TransactionReceiptSummary = {
  /** The transaction's hash. */
  transactionHash: Hex;
  /** `success`, or `reverted` when the chain mined it and undid its effects. */
  status: 'success' | 'reverted';
  /** The block the transaction was mined in. */
  blockNumber: bigint;
};

/**
 * A transaction that was sent and mined. A call that sends one returns its handle once the
 * chain has mined it (it waits for the receipt, up to two minutes), so `wait` resolves at once
 * with how the transaction ended. When the receipt does not come in time, or cannot be read,
 * the call throws a `TransactionFailedError` with `mayHaveLanded: true` and the
 * `transactionHash` instead: never send again before you have looked that hash up.
 */
export interface TransactionHandle {
  /** The transaction's hash. Keep it: it is how you look the transaction up if you lose the handle. */
  readonly transactionHash: Hex;
  /**
   * Resolves with how the transaction ended: `status: 'success'`, or `'reverted'` when the chain
   * mined it and undid its effects. A revert is a result, not an error. It never rejects.
   */
  wait(): Promise<TransactionReceiptSummary>;
}

/**
 * Maps the result of a mined transaction to the {@link TransactionReceiptSummary} model.
 *
 * @internal
 */
export function toTransactionReceiptSummary(
  raw: RawTxResult,
): TransactionReceiptSummary {
  return {
    transactionHash: raw.txHash,
    status: raw.status,
    blockNumber: raw.blockNumber,
  };
}

/**
 * Makes the {@link TransactionHandle} of a sent transaction. `wait` is called each time the
 * handle's `wait` is, and is not remembered.
 *
 * @param transactionHash The transaction's hash.
 * @param wait Waits for the chain to mine the transaction.
 * @internal
 */
export function toTransactionHandle(
  transactionHash: Hex,
  wait: () => Promise<TransactionReceiptSummary>,
): TransactionHandle {
  return Object.freeze({ transactionHash, wait });
}

/**
 * The handle of a transaction the chain has mined: `wait` resolves with its receipt, at once.
 *
 * @internal
 */
export function minedTransactionHandle(raw: RawTxResult): TransactionHandle {
  const receipt = Object.freeze(toTransactionReceiptSummary(raw));
  return toTransactionHandle(raw.txHash, () => Promise.resolve(receipt));
}

/**
 * What became of one market of `redeemAllPositions`. `ok: true` when its redemption was sent
 * and mined: check `transaction.wait()` for a revert. `ok: false` when it was not redeemed,
 * with why in `error`: `mayHaveLanded: false` means nothing was sent for it (a check failed,
 * the market is not resolved on chain, or an earlier market's send may have landed and the
 * rest were held back with `skipped_after_ambiguous`); any other error may have landed, so
 * look its `transactionHash` (or `nonce`) up before you redeem that market again.
 */
export type RedemptionResult =
  | {
      /** The redemption was sent and mined. */
      ok: true;
      /** The market redeemed. */
      conditionId: ConditionId;
      /** The redemption's transaction. */
      transaction: TransactionHandle;
    }
  | {
      /** The market was not redeemed. */
      ok: false;
      /** The market. */
      conditionId: ConditionId;
      /** Why. Its `mayHaveLanded` says whether a transaction may have been sent. */
      error: XoError;
    };

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

/**
 * An API key of the account, as the account lists it: its metadata, never the key itself. A
 * key that is revoked or has expired is still listed.
 */
export type ApiKey = {
  /** The key's id. */
  id: string;
  /** The key's name. A key the SDK signs in for is named `xo-sdk:<label>:<yyyymmdd>`. */
  name: string;
  /** The first characters of the key, to recognise it. */
  prefix: string;
  /** What the key may do, such as `account:read`. A scope added later reads as its own string. */
  scopes: Array<'account:read' | 'account:write' | (string & {})>;
  /** When the key expires, as an ISO 8601 time. */
  expiresAt: string;
  /** When the key was last used, as an ISO 8601 time. `null` when it never was. */
  lastUsedAt: string | null;
  /** When the key was revoked, as an ISO 8601 time. `null` while it is not. */
  revokedAt: string | null;
  /** When the key was made, as an ISO 8601 time. */
  createdAt: string;
};

/**
 * Maps the metadata of an API key to the {@link ApiKey} model.
 *
 * @internal
 */
export function toApiKey(raw: RawApiKeyInfo): ApiKey {
  return {
    id: raw.id,
    name: raw.name,
    prefix: raw.prefix,
    scopes: [...raw.scopes],
    expiresAt: raw.expiresAt,
    lastUsedAt: raw.lastUsedAt,
    revokedAt: raw.revokedAt,
    createdAt: raw.createdAt,
  };
}
