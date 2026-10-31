// Response schemas of the account's portfolio and PnL routes: the positions, the portfolio
// value, the claimable winnings, the open orders and the PnL calculations. The conventions
// are those of `schemas.ts`: the backend's own field names, ISO-8601 timestamps, and the
// money-like fields as strings of one of two kinds, classified here per presenter:
//
// - **whole units** (`DecimalString`): USD amounts and shares in dollars or shares (`pnl`,
//   `entryValue`, `claimableAmountUSD`, an order's `price` and `originalSize`). The backend
//   sends these as JSON numbers (floats), which become the exact shortest decimal text;
// - **the token's raw units** (`RawUnitsString`): the indexer's amounts (`collateralAmount`,
//   `shareAmount`, `entryPrice`, `claimableAmountWei`, the open orders' `...Micro` fields).
//
// Percentages (`pnlPercentage`), counts, ids, ticks and millisecond timestamps stay numbers.
//
// The portfolio rows are the backend's records as they are, not a documented answer (the
// backend's API docs describe another shape), so their shape was taken from what the backend
// sends and checked against live responses.

import { z } from 'zod';
import {
  defineSchema,
  type EnumFactory,
  type ObjFactory,
} from '../core/schema';
import type { DecimalString, RawUnitsString } from '../core/types';
import { type EventPlacement, eventPlacementSchema } from './catalogSchemas';
import { decimalString, type MarketStatus, pageOf, rawUnits } from './schemas';

const timestamp = z.string();

const MARKET_STATUS_VALUES = [
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
] as const;

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

/** The collateral token of a portfolio market. */
export interface PortfolioToken {
  id: number;
  tokenAddress: string;
  decimals: number;
}

/**
 * The market of a portfolio row, as the position repository maps it (only the fields the
 * portfolio needs). `contractMarketId` is the indexer's key; a CLOB market's `conditionId` is
 * the orderbook's `market_id`.
 */
export interface PortfolioMarketInfo {
  id: number;
  contractMarketId: string;
  conditionId: string | null;
  /** The same as `contractMarketId` (an alias the backend keeps for clients). */
  contractAddress: string;
  /** 0 standard (LMSR), 1 pulse, 2 CLOB, 3 CLOB pulse, 4 CLOB conviction. */
  type: number;
  slug: string;
  title: string;
  imageUrl: string | null;
  status: MarketStatus;
  expiresAt: string | null;
  /** What a winning share redeems for, in raw token units, once the market resolves. */
  redeemableAmountPerShare: RawUnitsString | null;
  /** In raw share units. */
  initialSharesPerOutcome: RawUnitsString | null;
  /** The creator fee, in basis points. */
  creatorBps: number;
  cpEnabled: boolean;
  creator?: { id: number; cpPoints?: number; tier?: string } | null;
  collateralToken: PortfolioToken;
  /** Only once the market has resolved. */
  winningOutcomeId?: number | null;
  /**
   * The event the market is placed on. Set on a summary row and on a detail row's market,
   * and absent on the market nested in a summary row's positions.
   */
  event?: EventPlacement | null;
}

/** The outcome a position is in. */
export interface PortfolioOutcome {
  id: number;
  title: string;
  index: number;
  /** In raw token units: `"570000"` is 0.57 of a 6-decimal token. */
  currentPrice?: RawUnitsString | null;
  /** The ERC-1155 token id, a decimal string. */
  outcomeTokenId?: string | null;
}

/**
 * One position of the account in one outcome, with its financial figures. This is a detail
 * row (`portfolio.mine({ marketId })`); in a summary row (see {@link PortfolioMarket}) it is
 * a {@link PortfolioMarketPosition}.
 */
export interface PortfolioPosition {
  id: number;
  /** What was paid in, fees included, in raw token units. */
  collateralAmount: RawUnitsString;
  /** In raw share units. */
  shareAmount: RawUnitsString;
  status: 'ACTIVE' | 'CLOSED' | (string & {});
  positionType: 'BUY' | 'SELL' | 'REDEEM' | (string & {});
  /** The realised PnL, in raw token units (negative for a loss). */
  totalPnlInCollateral: RawUnitsString | null;
  /** The average entry price, in raw token units. */
  entryPrice: RawUnitsString | null;
  createdAt: string;
  updatedAt: string;
  /** The account's wallet address. */
  userAddress: string;
  userId?: number;
  marketId: number;
  outcomeId?: number;
  market: PortfolioMarketInfo;
  outcome?: PortfolioOutcome | null;
  /** The paid-in amount without fees, in raw token units. */
  initialCollateral: RawUnitsString;
  /** In USD: shares times the average entry price. */
  entryValue: DecimalString;
  /** In USD. */
  currentValue: DecimalString;
  /** In USD: `currentValue - entryValue`. */
  pnl: DecimalString;
  /** In percent. */
  pnlPercentage: number;
  /** Whether the winnings of this position are claimed (or there is nothing to claim). */
  hasClaimed: boolean;
  /** The curve-aware PnL in USD (the same as `pnl` outside pulse markets). */
  effectivePnl: DecimalString;
  effectivePnlPercentage: number;
  effectiveCurrentValue: DecimalString;
  /** Conviction points accrued and not yet settled in this market. */
  unsettledCp: DecimalString;
  lifetimeEarnedCp: DecimalString;
}

/** A position inside a summary row: it also carries the current price and its performance. */
export interface PortfolioMarketPosition extends PortfolioPosition {
  /** The outcome's current price, in raw token units. */
  currentPrice: RawUnitsString;
  /** The position's performance in percent, as text with 4 decimals. */
  positionPerformance: string;
}

/**
 * One row of the portfolio summary (`portfolio.mine()` without `marketId`): a market with
 * the account's positions in it and the totals.
 */
export interface PortfolioMarket extends PortfolioMarketInfo {
  positions: PortfolioMarketPosition[];
  /** Total entry value of the positions, in USD. */
  totalStake: DecimalString;
  /** Total PnL of the positions, in USD. */
  totalPnL: DecimalString;
  transactionCounts: number;
}

const portfolioToken = (obj: ObjFactory) =>
  obj({
    id: z.number(),
    tokenAddress: z.string(),
    decimals: z.number(),
  });

const marketInfoFields = (obj: ObjFactory, enumOf: EnumFactory) => ({
  id: z.number(),
  contractMarketId: z.string(),
  conditionId: z.string().nullable(),
  contractAddress: z.string(),
  type: z.number(),
  slug: z.string(),
  title: z.string(),
  imageUrl: z.string().nullable(),
  status: enumOf(MARKET_STATUS_VALUES),
  expiresAt: timestamp.nullable(),
  redeemableAmountPerShare: rawUnits.nullable(),
  initialSharesPerOutcome: rawUnits.nullable(),
  creatorBps: z.number(),
  cpEnabled: z.boolean(),
  creator: obj({
    id: z.number(),
    cpPoints: z.number().optional(),
    tier: z.string().optional(),
  }).nullish(),
  collateralToken: portfolioToken(obj),
  winningOutcomeId: z.number().nullish(),
  event: eventPlacementSchema(obj).nullish(),
});

const positionFields = (obj: ObjFactory, enumOf: EnumFactory) => ({
  id: z.number(),
  collateralAmount: rawUnits,
  shareAmount: rawUnits,
  status: enumOf(['ACTIVE', 'CLOSED']),
  // A holding, not a history row: the backend's position types for a current position,
  // exactly. The indexer's other kinds (SPLIT, TRANSFER_IN, ...) are history rows only.
  positionType: enumOf(['BUY', 'SELL', 'REDEEM']),
  totalPnlInCollateral: rawUnits.nullable(),
  entryPrice: rawUnits.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  userAddress: z.string(),
  userId: z.number().optional(),
  marketId: z.number(),
  outcomeId: z.number().optional(),
  market: obj(marketInfoFields(obj, enumOf)),
  outcome: obj({
    id: z.number(),
    title: z.string(),
    index: z.number(),
    currentPrice: rawUnits.nullish(),
    outcomeTokenId: z.string().nullish(),
  }).nullish(),
  initialCollateral: rawUnits,
  entryValue: decimalString,
  currentValue: decimalString,
  pnl: decimalString,
  pnlPercentage: z.number(),
  hasClaimed: z.boolean(),
  effectivePnl: decimalString,
  effectivePnlPercentage: z.number(),
  effectiveCurrentValue: decimalString,
  unsettledCp: decimalString,
  lifetimeEarnedCp: decimalString,
});

export const portfolioPositionSchema = (obj: ObjFactory, enumOf: EnumFactory) =>
  obj(positionFields(obj, enumOf));

export const portfolioMarketSchema = (obj: ObjFactory, enumOf: EnumFactory) =>
  obj({
    ...marketInfoFields(obj, enumOf),
    positions: z.array(
      obj({
        ...positionFields(obj, enumOf),
        currentPrice: rawUnits,
        positionPerformance: z.string(),
      }),
    ),
    totalStake: decimalString,
    totalPnL: decimalString,
    transactionCounts: z.number(),
  });

export const PortfolioSummaryPageSchema = pageOf<PortfolioMarket>(
  portfolioMarketSchema,
);

export const PortfolioDetailPageSchema = pageOf<PortfolioPosition>(
  portfolioPositionSchema,
);

/** The account-wide cash and portfolio figures, in USD. */
export interface PortfolioValue {
  /** Spendable USDC in the wallet. */
  cashUSD: DecimalString;
  /** Mark-to-market value of every open position. */
  positionsValueUSD: DecimalString;
  /** Settled winnings not yet redeemed. */
  claimableAmountUSD: DecimalString;
  /** `cashUSD + positionsValueUSD + claimableAmountUSD`. */
  portfolioValueUSD: DecimalString;
  currency: string;
  /** Open positions valued at cost for want of a price; above 0 the total is an estimate. */
  unpricedPositionCount: number;
}

export const PortfolioValueSchema = defineSchema<PortfolioValue>((obj) =>
  obj({
    cashUSD: decimalString,
    positionsValueUSD: decimalString,
    claimableAmountUSD: decimalString,
    portfolioValueUSD: decimalString,
    currency: z.string(),
    unpricedPositionCount: z.number(),
  }),
);

// ---------------------------------------------------------------------------
// Claimable winnings
// ---------------------------------------------------------------------------

/** A resolved market in which the account has winnings to claim. */
export interface ClaimableMarket {
  marketId: number;
  contractMarketId: string;
  /** Where the claim transaction goes. */
  marketContractAddress?: string | null;
  title: string;
  slug: string;
  description?: string | null;
  imageUrl?: string | null;
  status: MarketStatus;
  /** 0 standard (LMSR), 1 pulse, 2 CLOB, 3 CLOB pulse, 4 CLOB conviction. */
  type: number;
  closedAt?: string | null;
  /** In raw token units. */
  claimableAmountWei: RawUnitsString;
  claimableAmountUSD: DecimalString;
  winningOutcome?: {
    id: number;
    title: string;
    contractOutcomeId: string;
  } | null;
  userPosition: {
    outcomeId: number;
    /** In raw share units. */
    shareAmount: RawUnitsString;
    /** In whole shares. */
    shareAmountFormatted: DecimalString;
  };
  collateralToken?: PortfolioToken | null;
}

export const ClaimableMarketsPageSchema = pageOf<ClaimableMarket>(
  (obj, enumOf) =>
    obj({
      marketId: z.number(),
      contractMarketId: z.string(),
      marketContractAddress: z.string().nullish(),
      title: z.string(),
      slug: z.string(),
      description: z.string().nullish(),
      imageUrl: z.string().nullish(),
      status: enumOf(MARKET_STATUS_VALUES),
      type: z.number(),
      closedAt: timestamp.nullish(),
      claimableAmountWei: rawUnits,
      claimableAmountUSD: decimalString,
      winningOutcome: obj({
        id: z.number(),
        title: z.string(),
        contractOutcomeId: z.string(),
      }).nullish(),
      userPosition: obj({
        outcomeId: z.number(),
        shareAmount: rawUnits,
        shareAmountFormatted: decimalString,
      }),
      collateralToken: portfolioToken(obj).nullish(),
    }),
);

/** An outcome of a redeemable position. */
export interface RedeemableOutcome {
  id: number;
  title?: string;
  index?: number;
  outcomeTokenId?: string;
}

/** A position the account can redeem, as a trader or as the market's creator. */
export interface RedeemablePosition {
  role: 'user' | 'creator' | (string & {});
  marketId: number;
  contractMarketId: string;
  marketContractAddress?: string | null;
  title?: string;
  slug?: string;
  imageUrl?: string | null;
  status: MarketStatus;
  /** 0 standard (LMSR), 1 pulse, 2 CLOB, 3 CLOB pulse, 4 CLOB conviction. */
  type: number;
  closedAt?: string | null;
  /** What a winning share redeems for, in raw token units. */
  redeemableAmountPerShare?: RawUnitsString | null;
  /** In raw token units. */
  claimableAmountWei: RawUnitsString;
  claimableAmountUSD: DecimalString;
  winningOutcome?: RedeemableOutcome | null;
  outcome?: RedeemableOutcome | null;
  position: {
    id: number;
    status: 'ACTIVE' | 'CLOSED' | (string & {});
    positionType: 'BUY' | 'SELL' | 'REDEEM' | (string & {});
    outcomeId: number;
    /** In raw share units. */
    shareAmount: RawUnitsString;
    /** In whole shares. */
    shareAmountFormatted: DecimalString;
    /** In raw token units. */
    collateralAmount?: RawUnitsString | null;
  };
  collateralToken?: {
    id: number;
    tokenAddress?: string;
    decimals: number;
    symbol?: string;
  } | null;
}

const redeemableOutcome = (obj: ObjFactory) =>
  obj({
    id: z.number(),
    title: z.string().optional(),
    index: z.number().optional(),
    outcomeTokenId: z.string().optional(),
  });

export const RedeemablePositionsPageSchema = pageOf<RedeemablePosition>(
  (obj, enumOf) =>
    obj({
      role: enumOf(['user', 'creator']),
      marketId: z.number(),
      contractMarketId: z.string(),
      marketContractAddress: z.string().nullish(),
      title: z.string().optional(),
      slug: z.string().optional(),
      imageUrl: z.string().nullish(),
      status: enumOf(MARKET_STATUS_VALUES),
      type: z.number(),
      closedAt: timestamp.nullish(),
      redeemableAmountPerShare: rawUnits.nullish(),
      claimableAmountWei: rawUnits,
      claimableAmountUSD: decimalString,
      winningOutcome: redeemableOutcome(obj).nullish(),
      outcome: redeemableOutcome(obj).nullish(),
      position: obj({
        id: z.number(),
        status: enumOf(['ACTIVE', 'CLOSED']),
        // The position types of a current position, as above.
        positionType: enumOf(['BUY', 'SELL', 'REDEEM']),
        outcomeId: z.number(),
        shareAmount: rawUnits,
        shareAmountFormatted: decimalString,
        collateralAmount: rawUnits.nullish(),
      }),
      collateralToken: obj({
        id: z.number(),
        tokenAddress: z.string().optional(),
        decimals: z.number(),
        symbol: z.string().optional(),
      }).nullish(),
    }),
);

// ---------------------------------------------------------------------------
// Open orders
// ---------------------------------------------------------------------------

/** An outcome of the market of an open order. */
export interface OpenOrderOutcome {
  outcomeTokenId: string;
  index: number;
  title: string | null;
}

/** The market of an open order, with the event it sits on. */
export interface OpenOrderMarket {
  title?: string | null;
  slug?: string | null;
  imageUrl?: string | null;
  contractMarketId: string;
  marketType?: number | null;
  status?: string | null;
  eventId?: string | null;
  eventSlug?: string | null;
  rootEventSlug?: string | null;
  rootEventTitle?: string | null;
  outcomes?: OpenOrderOutcome[] | null;
}

/**
 * A maker order of the account on the orderbook (proxied from the CLOB aggregator). The USD
 * and share figures are whole units; the `...Micro` ones are the same in micro-units (1e6 is
 * 1 share or 1 dollar).
 */
export interface OpenOrder {
  /** The market's condition id. */
  marketId: string;
  /**
   * The order's id, as a decimal string: the larger ids exceed 2^53, which a number cannot
   * hold exactly.
   */
  orderId: string;
  outcome: 'Yes' | 'No' | (string & {});
  /** The catalogue's outcome title when it has one, else Yes or No. */
  outcomeLabel?: string | null;
  side: 'Buy' | 'Sell' | (string & {});
  /** The limit price as a probability, 0 to 1. */
  price: DecimalString;
  /** The engine tick, 0 to 1000. */
  priceTick: number;
  /** In shares. */
  originalSize: DecimalString;
  /** In shares; null if the producer never stated the size. */
  remainingSize?: DecimalString | null;
  /** The order's original value, in USD. */
  notionalUsd: DecimalString;
  originalSizeMicro: RawUnitsString;
  remainingSizeMicro?: RawUnitsString | null;
  notionalMicro: RawUnitsString;
  status: 'resting' | 'partial' | 'filled' | (string & {});
  timePriority?: number | null;
  isSeed: boolean;
  schemaVersion: number;
  /** Milliseconds since the epoch. */
  createdAtMs: number;
  lastFillAtMs?: number | null;
  endedAtMs?: number | null;
  market?: OpenOrderMarket | null;
}

/** One answer of the open-orders route: the orders and the cursor of the next page. */
export interface OpenOrdersPage {
  /** The maker wallet, echoed from the session-bound upstream call. */
  userId: string;
  query: {
    sort: 'latest' | 'oldest' | 'size' | (string & {});
    status: Array<'resting' | 'partial' | 'filled' | (string & {})>;
    limit: number;
  };
  orders: OpenOrder[];
  /** The cursor of the next page; null on the last one. */
  nextCursor?: string | null;
}

export const OpenOrdersPageSchema = defineSchema<OpenOrdersPage>(
  (obj, enumOf) =>
    obj({
      userId: z.string(),
      query: obj({
        sort: enumOf(['latest', 'oldest', 'size']),
        status: z.array(enumOf(['resting', 'partial', 'filled'])),
        limit: z.number(),
      }),
      orders: z.array(
        obj({
          marketId: z.string(),
          // The server sends a string. A JSON integer is read as its decimal string; one of 2^53
          // or more is refused, because the JSON parse may already have rounded it to another id.
          orderId: z.union([z.string(), z.number().int()]).transform(String),
          outcome: enumOf(['Yes', 'No']),
          outcomeLabel: z.string().nullish(),
          side: enumOf(['Buy', 'Sell']),
          price: decimalString,
          priceTick: z.number(),
          originalSize: decimalString,
          remainingSize: decimalString.nullish(),
          notionalUsd: decimalString,
          originalSizeMicro: rawUnits,
          remainingSizeMicro: rawUnits.nullish(),
          notionalMicro: rawUnits,
          status: enumOf(['resting', 'partial', 'filled']),
          timePriority: z.number().nullish(),
          isSeed: z.boolean(),
          schemaVersion: z.number(),
          createdAtMs: z.number(),
          lastFillAtMs: z.number().nullish(),
          endedAtMs: z.number().nullish(),
          market: obj({
            title: z.string().nullish(),
            slug: z.string().nullish(),
            imageUrl: z.string().nullish(),
            contractMarketId: z.string(),
            marketType: z.number().nullish(),
            status: z.string().nullish(),
            eventId: z.string().nullish(),
            eventSlug: z.string().nullish(),
            rootEventSlug: z.string().nullish(),
            rootEventTitle: z.string().nullish(),
            outcomes: z
              .array(
                obj({
                  outcomeTokenId: z.string(),
                  index: z.number(),
                  title: z.string().nullable(),
                }),
              )
              .nullish(),
          }).nullish(),
        }),
      ),
      nextCursor: z.string().nullish(),
    }),
);

// ---------------------------------------------------------------------------
// PnL
// ---------------------------------------------------------------------------

/** The PnL calculation of one position. */
export interface PnlPosition {
  positionId: number;
  marketId: number;
  marketTitle: string;
  marketStatus: MarketStatus;
  outcomeTitle: string;
  /** In USD. */
  entryValue: DecimalString;
  /** In USD. */
  currentValue: DecimalString;
  /** In USD. */
  pnl: DecimalString;
  /** In percent. */
  pnlPercentage: number;
  calculationType: 'ACTIVE' | 'CLOSED' | (string & {});
  /** In raw share units. */
  shareAmount: RawUnitsString;
  /** In raw token units. */
  entryPrice: RawUnitsString;
  /** What a share redeems for in a closed market, in whole units. */
  redeemableAmount?: DecimalString | null;
  calculatedAt: string;
}

/** `GET /user/pnl`: the PnL of all positions that match the filter, with the totals in USD. */
export interface PnlSummary {
  totalPnl: DecimalString;
  /** In percent. */
  totalPnlPercentage: number;
  totalEntryValue: DecimalString;
  totalCurrentValue: DecimalString;
  activePositionsCount: number;
  closedPositionsCount: number;
  /** Positions the backend could not calculate. */
  calculationErrors: number;
  positions: PnlPosition[];
}

/** `GET /user/pnl/market/:marketId`: the PnL of the account's positions in one market. */
export interface PnlMarket {
  marketId: number;
  marketTitle: string;
  totalPnl: DecimalString;
  /** In percent. */
  totalPnlPercentage: number;
  positionsCount: number;
  positions: PnlPosition[];
}

/** `GET /user/pnl/position/:positionId`. */
export interface PnlPositionResult {
  position: PnlPosition;
}

const pnlPositionSchema = (obj: ObjFactory, enumOf: EnumFactory) =>
  obj({
    positionId: z.number(),
    marketId: z.number(),
    marketTitle: z.string(),
    marketStatus: enumOf(MARKET_STATUS_VALUES),
    outcomeTitle: z.string(),
    entryValue: decimalString,
    currentValue: decimalString,
    pnl: decimalString,
    pnlPercentage: z.number(),
    calculationType: enumOf(['ACTIVE', 'CLOSED']),
    shareAmount: rawUnits,
    entryPrice: rawUnits,
    redeemableAmount: decimalString.nullish(),
    calculatedAt: timestamp,
  });

export const PnlSummarySchema = defineSchema<PnlSummary>((obj, enumOf) =>
  obj({
    totalPnl: decimalString,
    totalPnlPercentage: z.number(),
    totalEntryValue: decimalString,
    totalCurrentValue: decimalString,
    activePositionsCount: z.number(),
    closedPositionsCount: z.number(),
    calculationErrors: z.number(),
    positions: z.array(pnlPositionSchema(obj, enumOf)),
  }),
);

export const PnlMarketSchema = defineSchema<PnlMarket>((obj, enumOf) =>
  obj({
    marketId: z.number(),
    marketTitle: z.string(),
    totalPnl: decimalString,
    totalPnlPercentage: z.number(),
    positionsCount: z.number(),
    positions: z.array(pnlPositionSchema(obj, enumOf)),
  }),
);

export const PnlPositionResultSchema = defineSchema<PnlPositionResult>(
  (obj, enumOf) => obj({ position: pnlPositionSchema(obj, enumOf) }),
);
