// Response schemas of the data client (the backend's read routes under `/api`): the shared
// building blocks and markets. Market activity is in `activitySchemas.ts`; events, series,
// browse, pulse markets and the taxonomy are in `catalogSchemas.ts`.
//
// Each schema mirrors one answer of the backend, which sends its objects as they are, so
// the field names are the backend's own (camelCase) and a response can be compared with the
// backend's API docs and logs one to one.
//
// Money-like fields (prices, sizes, amounts, volumes, PnL, rewards) come in two kinds, which
// the types keep apart:
// - whole units (`DecimalString`): a probability such as "0.57", dollars such as "1500.00",
//   shares, the `...InUSD` fields;
// - a token's raw smallest units (`RawUnitsString`, a brand on `string`): "570000" for 0.57 of
//   a 6-decimal USDC. These are the indexer's amounts (`totalVolume`, an outcome's
//   `currentPrice`, an activity's `collateralAmount` and `shareAmount`). The brand keeps one
//   from being passed where whole units are expected (`priceToTick` refuses it).
// The backend mostly sends both as strings already; a string passes through after a shape
// check (an exponent form is expanded in the text), and a JSON number is converted exactly
// (`numberToDecimal`), so a number never reaches the caller as a float. Counts, ids, indexes,
// basis points and timestamps stay numbers. Dates are ISO-8601 strings, as JSON carries them.
//
// A field that the backend fills from an optional property is optional here, and
// nullable where the database column is: the backend sends `null` for an unset column and
// leaves out an `undefined` one.

import { z } from 'zod';
import {
  decimalString,
  defineSchema,
  type EnumFactory,
  type ObjFactory,
  type PageMeta,
  rawUnits,
} from '../core/schema';
import type { DecimalString, RawUnitsString } from '../core/types';

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

// `decimalString` and `rawUnits` live in `core/schema.ts`: the orderbook client's micro-unit
// fields use `rawUnits` too.
export { decimalString, rawUnits };

/** An ISO-8601 timestamp, as the backend serializes a `Date`. */
const timestamp = z.string();

/** A free-form JSON object the backend stores as is (`metadata`, `rules`). */
const jsonObject = z.record(z.string(), z.unknown());

// The backend's `PageMeta` (`PageMetaSchema` in `core/schema.ts`), re-exported for the data
// modules.
export type { PageMeta };

// The fields of `PageMetaSchema`, built with the `obj` of the flavour being built so a strict
// parse also rejects an unknown meta field. `pageOf` below declares its `meta` as `PageMeta`,
// which ties it to the core type: if one changes, this stops compiling.
export const pageMetaSchema = (obj: ObjFactory) =>
  obj({
    page: z.number(),
    take: z.number(),
    itemCount: z.number(),
    pageCount: z.number(),
    hasPreviousPage: z.boolean(),
    hasNextPage: z.boolean(),
  });

/** The `{ data, meta }` envelope of the page/take routes, around `item`. */
export function pageOf<T>(
  item: (obj: ObjFactory, enumOf: EnumFactory) => z.ZodType<T>,
) {
  return defineSchema<{ data: T[]; meta: PageMeta }>((obj, enumOf) =>
    obj({
      data: z.array(item(obj, enumOf)),
      meta: pageMetaSchema(obj),
    }),
  );
}

/** The `{ data }` envelope of the single-object routes. */
export function dataOf<T>(
  item: (obj: ObjFactory, enumOf: EnumFactory) => z.ZodType<T>,
) {
  return defineSchema<{ data: T }>((obj, enumOf) =>
    obj({ data: item(obj, enumOf) }),
  );
}

/** A bare JSON array of `item`. */
export function arrayOf<T>(
  item: (obj: ObjFactory, enumOf: EnumFactory) => z.ZodType<T>,
) {
  return defineSchema<T[]>((obj, enumOf) => z.array(item(obj, enumOf)));
}

// ---------------------------------------------------------------------------
// Tokens, outcomes, taxonomy fragments
// ---------------------------------------------------------------------------

/** A collateral token: a row of `GET /tokens`, and a market's `collateralToken`. */
export interface Token {
  id: number;
  /** May be absent: `GET /tokens` rows and a market's `collateralToken` can leave it out. */
  createdAt?: string;
  updatedAt?: string;
  symbol: string;
  name: string;
  /** The token contract address. */
  tokenAddress: string;
  decimals: number;
  isActive: boolean;
  networkId: number;
  logoUrl?: string | null;
  /** On `GET /tokens` only. */
  description?: string | null;
  /** On `GET /tokens` only. */
  priceTrackingEnabled?: boolean | null;
}

export const tokenSchema = (obj: ObjFactory) =>
  obj({
    id: z.number(),
    createdAt: timestamp.optional(),
    updatedAt: timestamp.optional(),
    symbol: z.string(),
    name: z.string(),
    tokenAddress: z.string(),
    decimals: z.number(),
    isActive: z.boolean(),
    networkId: z.number(),
    logoUrl: z.string().nullish(),
    description: z.string().nullish(),
    priceTrackingEnabled: z.boolean().nullish(),
  });

export const TokensSchema = arrayOf<Token>(tokenSchema);

/**
 * One outcome of a market. `currentPrice`, `volumeTraded` and `notionalTraded` are in the
 * collateral token's raw units (`RawUnitsString`): with a 6-decimal USDC, `"500000"` is a
 * probability of 0.5. `volumeTradedInUSD` is whole dollars.
 */
export interface MarketOutcome {
  id: number;
  /**
   * The market: its numeric database id (`Market.id`), or the `contractMarketId` string,
   * which the backend's mapper can also pass.
   */
  marketId: number | string;
  outcomeTokenAddress?: string | null;
  /** The outcome's ERC-1155 token id, a decimal string. */
  outcomeTokenId?: string | null;
  title: string;
  /** 0 for YES, 1 for NO, and so on. */
  index: number;
  currentPrice?: RawUnitsString | null;
  volumeTraded?: RawUnitsString | null;
  volumeTradedInUSD?: DecimalString | null;
  notionalTraded?: RawUnitsString | null;
  /** May be absent: the outcomes of a market row can leave it out. */
  createdAt?: string;
  updatedAt?: string;
}

const outcomeSchema = (obj: ObjFactory) =>
  obj({
    id: z.number(),
    marketId: z.union([z.number(), z.string()]),
    outcomeTokenAddress: z.string().nullish(),
    outcomeTokenId: z.string().nullish(),
    title: z.string(),
    index: z.number(),
    currentPrice: rawUnits.nullish(),
    volumeTraded: rawUnits.nullish(),
    volumeTradedInUSD: decimalString.nullish(),
    notionalTraded: rawUnits.nullish(),
    createdAt: timestamp.optional(),
    updatedAt: timestamp.optional(),
  });

/** One node of a market's taxonomy path (category, then subcategories). */
export interface CategoryPathSegment {
  id: number;
  name: string;
  slug?: string | null;
}

/** A structured tag on a market. */
export interface MarketTag {
  key: string | null;
  value: string;
}

/** The public profile of a market's creator. */
export interface MarketCreator {
  id: number;
  walletPublicKey: string;
  name?: string | null;
  username?: string | null;
  bio?: string | null;
  profilePictureUrl?: string | null;
  roosterColor?: string | null;
  achievements?: string[];
  verified?: boolean;
  isOg: boolean;
  cpPoints?: number;
  tier?: string;
}

// ---------------------------------------------------------------------------
// Fee config and conviction seed
// ---------------------------------------------------------------------------

/** How the fee is split among receivers, in basis points of the fee. */
export interface FeeSplitSummary {
  creatorShareBps: number;
  makerShareBps: number;
  platformShareBps: number;
}

/**
 * The fee policy that applies to a market. Markets that are not CLOB markets
 * (`eligible: false`) pay the legacy creator fee (`Market.creatorBps`) instead.
 */
export interface EffectiveFeeConfig {
  eligible: boolean;
  curveModel:
    | 'CONVICTION_CURVE'
    | 'FLAT_BPS'
    | 'LEGACY_CREATOR_BPS'
    | (string & {});
  /** The base taker rate, in basis points, before any conviction price curve. */
  takerFeeBps: number;
  makerFeeBps: number;
  configId: number | null;
  configName: string | null;
  splitSummary: FeeSplitSummary | null;
  /** How the config was resolved, such as `category:12 → default`. */
  resolutionPath?: string[];
  orderbookConfigId?: string | null;
  configVersion?: number | null;
  latestPublishedVersion?: number | null;
}

export const effectiveFeeConfigSchema = (
  obj: ObjFactory,
  enumOf: EnumFactory,
) =>
  obj({
    eligible: z.boolean(),
    curveModel: enumOf(['CONVICTION_CURVE', 'FLAT_BPS', 'LEGACY_CREATOR_BPS']),
    takerFeeBps: z.number(),
    makerFeeBps: z.number(),
    configId: z.number().nullable(),
    configName: z.string().nullable(),
    splitSummary: obj({
      creatorShareBps: z.number(),
      makerShareBps: z.number(),
      platformShareBps: z.number(),
    }).nullable(),
    resolutionPath: z.array(z.string()).optional(),
    orderbookConfigId: z.string().nullish(),
    configVersion: z.number().nullish(),
    latestPublishedVersion: z.number().nullish(),
  });

export const EffectiveFeeConfigSchema = dataOf<EffectiveFeeConfig>(
  effectiveFeeConfigSchema,
);

/**
 * A conviction market creator's seed commitment. A resting seed has every field; a spent
 * tombstone keeps what the orderbook froze at placement.
 */
export interface ConvictionCommitment {
  orderId: string;
  status: 'resting' | 'spent_tombstone' | (string & {});
  outcome?: 'yes' | 'no' | (string & {});
  side?: 'buy' | 'sell' | (string & {});
  price?: DecimalString;
  /** The seed size in shares. */
  size?: DecimalString;
  remaining?: DecimalString;
}

/** The seed of a conviction market: its condition, creator and commitment. */
export interface ConvictionSeed {
  conditionId: string;
  creator: string | null;
  commitment: ConvictionCommitment | null;
}

const convictionSeedSchema = (obj: ObjFactory, enumOf: EnumFactory) =>
  obj({
    conditionId: z.string(),
    creator: z.string().nullable(),
    commitment: obj({
      orderId: z.string(),
      status: enumOf(['resting', 'spent_tombstone']),
      outcome: enumOf(['yes', 'no']).optional(),
      side: enumOf(['buy', 'sell']).optional(),
      price: decimalString.optional(),
      size: decimalString.optional(),
      remaining: decimalString.optional(),
    }).nullable(),
  });

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------

/** The market statuses of the backend; a status added later reads as its own string. */
export type MarketStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'PAUSED'
  | 'CANCELLED'
  | 'RESOLVED'
  | 'DISPUTED'
  | 'CLOSED'
  | 'DEFAULTED'
  | 'UPDATE_REQUIRED'
  | 'VOIDED'
  | 'VOIDED_CLOSED'
  | (string & {});

/**
 * A market.
 *
 * The orderbook identifies a CLOB market by `conditionId`; `contractMarketId` is the
 * indexer's key (the condition id for V3 CLOB markets, the contract address for older ones).
 * `type` is the deployment type: 0 standard (LMSR), 1 pulse, 2 CLOB, 3 CLOB pulse, 4 CLOB
 * conviction. Only types 2, 3 and 4 trade on the orderbook.
 */
export interface Market {
  id: number;
  createdAt: string;
  updatedAt: string;
  contractMarketId: string;
  /** The CTF condition id: the orderbook's `market_id` for CLOB markets. */
  conditionId?: string | null;
  marketContractAddress?: string | null;
  /** 2 for the CLOB wrapper, 3 for `XOClobMarketManager`. */
  versionId?: number | null;
  createMarketBlockTimestamp?: string | null;
  creatorId?: number | null;
  title: string;
  slug: string;
  rules?: Record<string, unknown> | null;
  description?: string | null;
  categoryPath?: CategoryPathSegment[];
  /** The indexer's raw category name, when no taxonomy node is assigned. */
  categoryNameRaw?: string;
  subcategoryNamesRaw?: string[];
  marketTags?: MarketTag[];
  /** 0 standard (LMSR), 1 pulse, 2 CLOB, 3 CLOB pulse, 4 CLOB conviction. */
  type: number;
  /** Total volume in the collateral token's raw units. */
  totalVolume: RawUnitsString;
  /** Total volume in USD, 2 decimals. */
  totalVolumeInUSD: DecimalString;
  /** Contract notional in raw units (1 share = $1 face). */
  totalNotional?: RawUnitsString;
  /** The headline market volume, in USD with 2 decimals. */
  totalNotionalInUSD?: DecimalString;
  /** On the detail routes and the event and series market lists, not on `list` or `browse` rows. */
  collateralTokenId?: number | null;
  collateralToken?: Token | null;
  status: MarketStatus;
  startsAt?: string | null;
  expiresAt?: string | null;
  resolvedAt?: string | null;
  metadataUri?: string | null;
  imageUrl?: string | null;
  resolutionEvidence?: string | null;
  /** Left out (not `null`) until the market resolves, with `winningOutcome`. */
  winningOutcomeId?: number | null;
  resolutionSources?: string[] | null;
  resolverAddress?: string | null;
  resolutionType?: 'AUTOMATIC' | 'MANUAL' | 'ORACLE' | (string & {}) | null;
  resolutionFlagCount: number;
  priorityScore: number;
  likes?: number;
  /** May be absent: the backend can leave it out. */
  visible?: boolean;
  /** Whether trading conviction points accrue on this market. */
  cpEnabled: boolean;
  /** The conviction points boost (1 is none). */
  cpMultiplier: number;
  /** The legacy creator fee in basis points (CLOB markets use `effectiveFeeConfig`). */
  creatorBps?: number | null;
  /** On the detail routes, not on `list` or `browse` rows. */
  effectiveFeeConfig?: EffectiveFeeConfig | null;
  /** On the detail routes: `{ conditionId, creator: null, commitment: null }` for a CLOB market with no seed. */
  convictionSeed?: ConvictionSeed | null;
  /** In the collateral token's raw units. */
  initialCollateral?: RawUnitsString | null;
  /** What a winning share redeems for, in raw units, once the market resolves. */
  redeemableAmountPerShare?: RawUnitsString | null;
  /** The catalogue event the market is placed on. */
  eventId?: string | null;
  /** On the detail routes: the root event slug of an event-placed market. */
  rootEventSlug?: string | null;
  isFeatured: boolean;
  featuredOrder?: number | null;
  creator?: MarketCreator | null;
  winningOutcome?: MarketOutcome | null;
  outcomes?: MarketOutcome[];
  notes?: string | null;
  reviewStatus?:
    | 'APPROVE'
    | 'REJECT'
    | 'UPDATE_REQUIRED'
    | (string & {})
    | null;
}

export const marketSchema = (obj: ObjFactory, enumOf: EnumFactory) =>
  obj({
    id: z.number(),
    createdAt: timestamp,
    updatedAt: timestamp,
    contractMarketId: z.string(),
    conditionId: z.string().nullish(),
    marketContractAddress: z.string().nullish(),
    versionId: z.number().nullish(),
    createMarketBlockTimestamp: timestamp.nullish(),
    creatorId: z.number().nullish(),
    title: z.string(),
    slug: z.string(),
    rules: jsonObject.nullish(),
    description: z.string().nullish(),
    categoryPath: z
      .array(
        obj({ id: z.number(), name: z.string(), slug: z.string().nullish() }),
      )
      .optional(),
    categoryNameRaw: z.string().optional(),
    subcategoryNamesRaw: z.array(z.string()).optional(),
    marketTags: z
      .array(obj({ key: z.string().nullable(), value: z.string() }))
      .optional(),
    type: z.number(),
    totalVolume: rawUnits,
    totalVolumeInUSD: decimalString,
    totalNotional: rawUnits.optional(),
    totalNotionalInUSD: decimalString.optional(),
    collateralTokenId: z.number().nullish(),
    collateralToken: tokenSchema(obj).nullish(),
    status: enumOf([
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
    ]),
    startsAt: timestamp.nullish(),
    expiresAt: timestamp.nullish(),
    resolvedAt: timestamp.nullish(),
    metadataUri: z.string().nullish(),
    imageUrl: z.string().nullish(),
    resolutionEvidence: z.string().nullish(),
    winningOutcomeId: z.number().nullish(),
    resolutionSources: z.array(z.string()).nullish(),
    resolverAddress: z.string().nullish(),
    resolutionType: enumOf(['AUTOMATIC', 'MANUAL', 'ORACLE']).nullish(),
    resolutionFlagCount: z.number(),
    priorityScore: z.number(),
    likes: z.number().optional(),
    visible: z.boolean().optional(),
    cpEnabled: z.boolean(),
    cpMultiplier: z.number(),
    creatorBps: z.number().nullish(),
    effectiveFeeConfig: effectiveFeeConfigSchema(obj, enumOf).nullish(),
    convictionSeed: convictionSeedSchema(obj, enumOf).nullish(),
    initialCollateral: rawUnits.nullish(),
    redeemableAmountPerShare: rawUnits.nullish(),
    eventId: z.string().nullish(),
    rootEventSlug: z.string().nullish(),
    isFeatured: z.boolean(),
    featuredOrder: z.number().nullish(),
    creator: obj({
      id: z.number(),
      walletPublicKey: z.string(),
      name: z.string().nullish(),
      username: z.string().nullish(),
      bio: z.string().nullish(),
      profilePictureUrl: z.string().nullish(),
      roosterColor: z.string().nullish(),
      achievements: z.array(z.string()).optional(),
      verified: z.boolean().optional(),
      isOg: z.boolean(),
      cpPoints: z.number().optional(),
      tier: z.string().optional(),
    }).nullish(),
    winningOutcome: outcomeSchema(obj).nullish(),
    outcomes: z.array(outcomeSchema(obj)).optional(),
    notes: z.string().nullish(),
    reviewStatus: enumOf(['APPROVE', 'REJECT', 'UPDATE_REQUIRED']).nullish(),
  });

export const MarketSchema = defineSchema<Market>(marketSchema);

export const MarketsPageSchema = pageOf<Market>(marketSchema);

// ---------------------------------------------------------------------------
// Price history and statuses
// ---------------------------------------------------------------------------

/** One outcome's price at a point of the history. */
export interface OutcomePrice {
  outcomeId: number;
  outcomeTitle?: string | null;
  /** A probability as a decimal string, such as `"0.7"`. */
  price: DecimalString;
}

/** The prices of every outcome at one timestamp. */
export interface PricePoint {
  timestamp: string;
  outcomes: OutcomePrice[];
}

const pricePointSchema = (obj: ObjFactory) =>
  obj({
    timestamp: timestamp,
    outcomes: z.array(
      obj({
        outcomeId: z.number(),
        outcomeTitle: z.string().nullish(),
        price: decimalString,
      }),
    ),
  });

export const PriceHistorySchema = arrayOf<PricePoint>(pricePointSchema);

/** When a market reached each lifecycle status; `null` where it has not. */
export interface MarketStatuses {
  marketId: number;
  contractMarketId: string;
  title: string;
  status: MarketStatus;
  timestamps: {
    PENDING: string | null;
    ACTIVE: string | null;
    PAUSED: string | null;
    CLOSED: string | null;
    CANCELLED: string | null;
    RESOLVED: string | null;
    EXPIRED: string | null;
  };
}

export const MarketStatusesSchema = defineSchema<MarketStatuses>(
  (obj, enumOf) =>
    obj({
      marketId: z.number(),
      contractMarketId: z.string(),
      title: z.string(),
      status: enumOf([
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
      ]),
      timestamps: obj({
        PENDING: timestamp.nullable(),
        ACTIVE: timestamp.nullable(),
        PAUSED: timestamp.nullable(),
        CLOSED: timestamp.nullable(),
        CANCELLED: timestamp.nullable(),
        RESOLVED: timestamp.nullable(),
        EXPIRED: timestamp.nullable(),
      }),
    }),
);

// ---------------------------------------------------------------------------
// Pulse stats and trading status
// ---------------------------------------------------------------------------

/** Aggregate statistics of the pulse markets. */
export interface PulseStats {
  /** Total volume in USD. */
  totalVolume: DecimalString;
  totalTrades: number;
  uniqueTraders: number;
  totalMarkets: number;
  /** The sum of all active positions' value in USD. */
  currentPositionsValue: DecimalString;
  /** All-time initial collateral of the pulse markets, in token units. */
  initialCollateral: DecimalString;
}

export const PulseStatsSchema = defineSchema<PulseStats>((obj) =>
  obj({
    totalVolume: decimalString,
    totalTrades: z.number(),
    uniqueTraders: z.number(),
    totalMarkets: z.number(),
    currentPositionsValue: decimalString,
    initialCollateral: decimalString,
  }),
);

/** The global CLOB trading status the indexer last saw. */
export interface ClobTradingStatus {
  /** `'active'` when nothing is indexed yet. */
  status: 'active' | 'paused' | (string & {});
}

export const ClobTradingStatusSchema = dataOf<ClobTradingStatus>(
  (obj, enumOf) => obj({ status: enumOf(['active', 'paused']) }),
);
