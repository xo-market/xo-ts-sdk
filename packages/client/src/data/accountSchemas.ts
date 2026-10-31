// Response schemas of the account routes: the account's own profile (`GET /users/me`), its
// API keys, the public profile of any user and the trading statistics. The conventions are
// those of `schemas.ts`; the money-like fields (`userVolume`, PnL, volume) are whole-unit
// USD `DecimalString`s, and conviction points are decimal text or numbers as the backend
// sends them.

import { z } from 'zod';
import { defineSchema, type ObjFactory } from '../core/schema';
import type { DecimalString } from '../core/types';
import { arrayOf, decimalString } from './schemas';

const timestamp = z.string();

// ---------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------

/** The connected social handles of a user, without the `@`; `null` is not connected. */
export interface UserSocials {
  /** X (Twitter). */
  x: string | null;
  tiktok: string | null;
  instagram: string | null;
  discord: string | null;
}

const socialsSchema = (obj: ObjFactory) =>
  obj({
    x: z.string().nullable(),
    tiktok: z.string().nullable(),
    instagram: z.string().nullable(),
    discord: z.string().nullable(),
  });

/** A market whose conviction points are accruing and not yet settled. */
export interface UnsettledCpMarket {
  marketId: number;
  contractMarketId: string;
  title: string | null;
  status: string | null;
  unsettledCp: DecimalString;
  lifetimeEarnedCp: DecimalString;
}

/**
 * The account, as `GET /users/me` answers by default: the identity, the points, the liked
 * markets and the conviction-point accrual. The positions and the history are left out (the
 * route fills them only for its legacy `view=full`): use `portfolio.mine()`,
 * `activity.stats()` and `activity.mine()`.
 */
export interface AccountProfile {
  id: number;
  username: string;
  name?: string | null;
  /** The account's wallet address. */
  walletPublicKey: string;
  /** The Privy user id (`did:privy:…`). */
  privyId?: string | null;
  status: 'ACTIVE' | 'SUSPENDED' | 'BANNED' | 'INACTIVE' | (string & {});
  verified: boolean;
  /** Holds the OG role (top 5% of the daily leaderboard). */
  isOg: boolean;
  isAmbassador: boolean;
  socials: UserSocials;
  referralCode?: string | null;
  bio?: string | null;
  profilePictureUrl: string | null;
  roosterColor: string;
  /**
   * Whether the account has access; the backend answers 403 `User does not have access` to an
   * account without it. The auth review of 19 October 2026 agreed to remove the has-access
   * logic, so the backend may stop sending it.
   */
  hasAccess?: boolean;
  /** Whether the profile is hidden from the public routes. */
  isPrivate: boolean;
  /** The invite code the account signed up with. */
  usedInviteCode?: string | null;
  /** May be missing: the same review agreed to remove the invitation logic. */
  inviteCodeId?: string | null;
  hasEnteredReferralCode: boolean;
  lastActiveAt?: string | null;
  lastLoginAt?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Total volume in USD. */
  userVolume: DecimalString;
  /** Database ids of the markets the account liked. */
  likedMarketIds: number[];
  /** Always empty here: the SDK asks for the slim profile (see `activity.mine()`). */
  positionHistory: unknown[];
  /** Always empty here: the SDK asks for the slim profile (see `portfolio.mine()`). */
  currentPositions: unknown[];
  userPoints: {
    currentPoints: DecimalString;
    totalPointsEarned: DecimalString;
  };
  /** Zeros here: the SDK asks for the slim profile. */
  stats: {
    totalPositions: number;
    activePositions: number;
    totalVolumeTraded: DecimalString;
    totalRedeemed: DecimalString;
    marketsParticipated: number;
    totalComments: number;
    totalRedeems: number;
  };
  /** Conviction points. */
  cpPoints: number;
  tier: string;
  score: number;
  totalUnsettledCp?: DecimalString;
  cpAccrualMarketsCount?: number;
  unsettledCpMarkets?: UnsettledCpMarket[];
}

export const AccountProfileSchema = defineSchema<AccountProfile>(
  (obj, enumOf) =>
    obj({
      id: z.number(),
      username: z.string(),
      name: z.string().nullish(),
      walletPublicKey: z.string(),
      privyId: z.string().nullish(),
      status: enumOf(['ACTIVE', 'SUSPENDED', 'BANNED', 'INACTIVE']),
      verified: z.boolean(),
      isOg: z.boolean(),
      isAmbassador: z.boolean(),
      socials: socialsSchema(obj),
      referralCode: z.string().nullish(),
      bio: z.string().nullish(),
      profilePictureUrl: z.string().nullable(),
      roosterColor: z.string(),
      hasAccess: z.boolean().optional(),
      isPrivate: z.boolean(),
      usedInviteCode: z.string().nullish(),
      inviteCodeId: z.string().nullish(),
      hasEnteredReferralCode: z.boolean(),
      lastActiveAt: timestamp.nullish(),
      lastLoginAt: timestamp.nullish(),
      createdAt: timestamp,
      updatedAt: timestamp,
      userVolume: decimalString,
      likedMarketIds: z.array(z.number()),
      positionHistory: z.array(z.unknown()),
      currentPositions: z.array(z.unknown()),
      userPoints: obj({
        currentPoints: decimalString,
        totalPointsEarned: decimalString,
      }),
      stats: obj({
        totalPositions: z.number(),
        activePositions: z.number(),
        totalVolumeTraded: decimalString,
        totalRedeemed: decimalString,
        marketsParticipated: z.number(),
        totalComments: z.number(),
        totalRedeems: z.number(),
      }),
      cpPoints: z.number(),
      tier: z.string(),
      score: z.number(),
      totalUnsettledCp: decimalString.optional(),
      cpAccrualMarketsCount: z.number().optional(),
      unsettledCpMarkets: z
        .array(
          obj({
            marketId: z.number(),
            contractMarketId: z.string(),
            title: z.string().nullable(),
            status: z.string().nullable(),
            unsettledCp: decimalString,
            lifetimeEarnedCp: decimalString,
          }),
        )
        .optional(),
    }),
);

/**
 * The metadata of one API key of the account (never the key itself). `id` is text, like
 * the `id` of a backend credential, so the two compare directly.
 */
export interface ApiKeyInfo {
  id: string;
  name: string;
  /** The first characters of the key, for recognising it in a list. */
  prefix: string;
  scopes: Array<'account:read' | 'account:write' | (string & {})>;
  expiresAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  /** `null` while the key is not revoked. */
  revokedAt: string | null;
  createdVia: 'privy' | 'wallet_signature' | (string & {});
  createdAt: string;
}

export const ApiKeysSchema = arrayOf<ApiKeyInfo>((obj, enumOf) =>
  obj({
    id: z.number().transform((id) => String(id)),
    name: z.string(),
    prefix: z.string(),
    scopes: z.array(enumOf(['account:read', 'account:write'])),
    expiresAt: timestamp,
    lastUsedAt: timestamp.nullable(),
    lastUsedIp: z.string().nullable(),
    revokedAt: timestamp.nullable(),
    createdVia: enumOf(['privy', 'wallet_signature']),
    createdAt: timestamp,
  }),
);

// ---------------------------------------------------------------------------
// Public profiles and statistics
// ---------------------------------------------------------------------------

/** A stable profile badge (Catalyst, or any boarding-pass tier as Hatchling). */
export interface ProfileBadge {
  key: 'CATALYST' | 'HATCHLING' | (string & {});
  /** Earned and not revoked. */
  earned: boolean;
  isRevoked: boolean;
  notes?: string;
  /** The on-chain achievement token id, when applicable. */
  tokenId?: number;
}

/** The state of one boarding-pass NFT tier. */
export interface BoardingPassTier {
  key:
    | 'BOARDING_PASS_ECONOMY'
    | 'BOARDING_PASS_BUSINESS'
    | 'BOARDING_PASS_FIRST'
    | 'BOARDING_PASS_PRIVATE'
    | (string & {});
  tokenId: number;
  earned: boolean;
  isRevoked: boolean;
  notes?: string;
}

/** A legacy on-chain badge record. */
export interface LegacyBadge {
  type: string;
  isRevoked: boolean;
  notes?: string;
}

/**
 * The public profile of a user. When the profile is private, the bio, the socials and the
 * badge lists come back `null` (or left out).
 */
export interface PublicProfile {
  id: number;
  username: string;
  name?: string | null;
  bio?: string | null;
  profilePictureUrl?: string | null;
  verified: boolean;
  /** Holds the OG role (top 5% of the daily leaderboard). */
  isOg: boolean;
  isPrivate: boolean;
  profileBadges?: ProfileBadge[] | null;
  boardingPassTiers?: BoardingPassTier[] | null;
  badges?: LegacyBadge[] | null;
  /** The earned badge keys. */
  achievements?: string[] | null;
  socials?: UserSocials | null;
  /** Conviction points. */
  cpPoints?: number;
  tier?: string;
}

export const PublicProfileSchema = defineSchema<PublicProfile>((obj, enumOf) =>
  obj({
    id: z.number(),
    username: z.string(),
    name: z.string().nullish(),
    bio: z.string().nullish(),
    profilePictureUrl: z.string().nullish(),
    verified: z.boolean(),
    isOg: z.boolean(),
    isPrivate: z.boolean(),
    profileBadges: z
      .array(
        obj({
          key: enumOf(['CATALYST', 'HATCHLING']),
          earned: z.boolean(),
          isRevoked: z.boolean(),
          notes: z.string().optional(),
          tokenId: z.number().optional(),
        }),
      )
      .nullish(),
    boardingPassTiers: z
      .array(
        obj({
          key: enumOf([
            'BOARDING_PASS_ECONOMY',
            'BOARDING_PASS_BUSINESS',
            'BOARDING_PASS_FIRST',
            'BOARDING_PASS_PRIVATE',
          ]),
          tokenId: z.number(),
          earned: z.boolean(),
          isRevoked: z.boolean(),
          notes: z.string().optional(),
        }),
      )
      .nullish(),
    badges: z
      .array(
        obj({
          type: z.string(),
          isRevoked: z.boolean(),
          notes: z.string().optional(),
        }),
      )
      .nullish(),
    achievements: z.array(z.string()).nullish(),
    socials: socialsSchema(obj).nullish(),
    cpPoints: z.number().optional(),
    tier: z.string().optional(),
  }),
);

/**
 * Trading statistics of an account: `pnl` and `volume` are USD amounts, and `null` when the
 * indexer has no figure. `winRate` is not computed yet and is always `null`.
 */
export interface UserStats {
  pnl: DecimalString | null;
  volume: DecimalString | null;
  marketsTraded: number | null;
  winRate: number | null;
}

export const UserStatsSchema = defineSchema<UserStats>((obj) =>
  obj({
    pnl: decimalString.nullable(),
    volume: decimalString.nullable(),
    marketsTraded: z.number().nullable(),
    winRate: z.number().nullable(),
  }),
);
