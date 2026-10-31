import { isConditionId } from '../core/ids';
import type { ConditionId, DecimalString } from '../core/types';
import type { PulseMarket as RawPulseMarket } from '../data/catalogSchemas';
import type { PulseStats as RawPulseStats } from '../data/schemas';
import { conditionIdOf } from './convert';

// The public models of pulse markets: short, recurring markets on a price, such as `BTC 5 min`.
// Only the rounds that trade on the order book are modelled.

/** Where a pulse round is, in XO's words, such as `active`, `resolved` or `closed`. */
export type PulseStatus = 'active' | 'resolved' | 'closed' | (string & {});

/** One round of a pulse market, which trades on the order book like any CLOB market. */
export type PulseMarket = {
  /** XO's id for the round. */
  id: string;
  /** The round's id on the order book. */
  conditionId: ConditionId;
  /** The name of the pulse market the round belongs to, such as `BTC 5 min`. */
  name: string;
  /** Where the round is. */
  status: PulseStatus;
  /** The round's number within its pulse market. */
  cycle: number;
  /** When the round starts, as an ISO 8601 time. */
  startDate: string;
  /** When the round ends, as an ISO 8601 time. */
  endDate: string;
  /** When the window in which XO samples the price opens, as an ISO 8601 time. */
  observationStartDate: string;
  /** When the window in which XO samples the price closes, as an ISO 8601 time. */
  observationEndDate: string;
  /** When the round resolved, as an ISO 8601 time. `null` until it does. */
  resolvedAt: string | null;
  /** When the round closed, as an ISO 8601 time. `null` until it does. */
  closedAt: string | null;
  /** The reference price at the start of the round. `null` until it is known. */
  openingPrice: DecimalString | null;
  /** The reference price at the end of the round. `null` until it is known. */
  closingPrice: DecimalString | null;
  /** The side that won, once the round has resolved. */
  winningOutcome: 'yes' | 'no' | null;
  /** How many price samples XO has taken in the round so far. */
  sampleCount: number;
  /** Extra data XO keeps on the pulse market, such as the asset's symbol. */
  metadata: Record<string, unknown>;
};

/** The winning side: the first outcome is yes and the second is no, as in every market. */
function winnerOf(index: number | null | undefined): 'yes' | 'no' | null {
  if (index === 0) {
    return 'yes';
  }
  return index === 1 ? 'no' : null;
}

/**
 * Maps a pulse round to the {@link PulseMarket} model.
 *
 * Returns `undefined` for a round without a condition id: those of the older pricing-curve
 * kind do not trade on the order book and are not part of the model.
 *
 * @internal
 */
export function toPulseMarket(raw: RawPulseMarket): PulseMarket | undefined {
  if (!isConditionId(raw.conditionId)) {
    return undefined;
  }
  return {
    id: String(raw.id),
    conditionId: conditionIdOf(raw.conditionId),
    name: raw.marketConfigName,
    status: raw.status,
    cycle: raw.cycleNumber,
    startDate: raw.startsAt,
    endDate: raw.expiresAt,
    observationStartDate: raw.observationStartsAt,
    observationEndDate: raw.observationEndsAt,
    resolvedAt: raw.resolvedAt ?? null,
    closedAt: raw.closedAt ?? null,
    openingPrice: raw.openingPrice ?? null,
    closingPrice: raw.closingPrice ?? null,
    winningOutcome: winnerOf(raw.winningOutcome),
    sampleCount: raw.sampleCount,
    metadata: { ...raw.marketMetadata },
  };
}

/** Totals over the pulse markets that trade on the order book. */
export type PulseStats = {
  /** The total volume, in dollars. */
  volume: DecimalString;
  /** How many trades have been made. */
  tradeCount: number;
  /** How many different traders have traded. */
  traderCount: number;
  /** How many pulse markets the totals cover. */
  marketCount: number;
  /** The value of all open positions, in dollars. */
  positionsValue: DecimalString;
  /** The collateral the rounds were opened with, in tokens. */
  initialCollateral: DecimalString;
};

/**
 * Maps the pulse totals to the {@link PulseStats} model.
 *
 * @internal
 */
export function toPulseStats(raw: RawPulseStats): PulseStats {
  return {
    volume: raw.totalVolume,
    tradeCount: raw.totalTrades,
    traderCount: raw.uniqueTraders,
    marketCount: raw.totalMarkets,
    positionsValue: raw.currentPositionsValue,
    initialCollateral: raw.initialCollateral,
  };
}
