import { type Address, getAddress, isAddress } from 'viem';
import { fromMicro, isDecimalString, numberToDecimal } from '../core/decimal';
import { UnexpectedResponseError } from '../core/errors';
import { isConditionId, normalizeTokenId } from '../core/ids';
import type { ConditionId, DecimalString, TokenId } from '../core/types';
import type { RewardsMarketConfig as RawRewardsConfig } from '../data/rewardsSchemas';
import type {
  EffectiveFeeConfig as RawFeeConfig,
  Market as RawMarket,
  MarketOutcome as RawOutcome,
} from '../data/schemas';
import { MIN_SIZE_MICRO } from '../orderbook/amounts';
import type { MarketToken, OrderbookMarket } from '../orderbook/schemas';
import { priceOrNull } from './convert';

// The one public market model. A market is read from up to four places: the market listing
// (every field of a list row), the order book (tick size, whether orders are accepted, live
// prices, the outcome tokens), the fee policy and the rewards programme. A list row has only
// the first, so the fields only the others carry are `null` on a row; `toMarket` fills them
// when the caller joined them in.
//
// Only CLOB markets with exactly two outcomes are modelled, so the market type never shows,
// and a market's two outcomes are named `yes` and `no`.

/**
 * The type code of a CLOB market. Other kinds of market (the older pricing-curve markets,
 * the short pulse rounds, conviction markets) are not part of the market model.
 *
 * @internal
 */
export const CLOB_MARKET_TYPE = 2;

/**
 * The smallest order the SDK places: one share, whatever the market.
 *
 * @internal
 */
export const MINIMUM_ORDER_SIZE: DecimalString = fromMicro(MIN_SIZE_MICRO);

/**
 * Where a market is in its life, in XO's words. A status added later reads as its own string.
 *
 * - `PENDING`: created, not open yet.
 * - `ACTIVE`: open for trading. A market past its end time reads `ACTIVE` until its outcome
 *   is set.
 * - `PAUSED`: trading is paused.
 * - `RESOLVED`: the outcome is decided.
 * - `CLOSED`: the outcome is decided and the market is final; it was `RESOLVED` first (see
 *   {@link MarketState.closed}).
 * - `CANCELLED`, `VOIDED`, `VOIDED_CLOSED`: the market was called off.
 * - `DISPUTED`, `DEFAULTED`, `UPDATE_REQUIRED`: a resolution problem or an edit under review.
 */
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

/** The statuses of a market that has ended. */
const CLOSED_STATUSES: ReadonlySet<string> = new Set([
  'CLOSED',
  'RESOLVED',
  'VOIDED',
  'VOIDED_CLOSED',
]);

/** Whether a market takes orders and where it is in its life. */
export type MarketState = {
  /** The market is open for trading: its status is `ACTIVE`. */
  active: boolean;
  /** The market has ended: its status is `CLOSED`, `RESOLVED`, `VOIDED` or `VOIDED_CLOSED`. */
  closed: boolean;
  /** XO's own status. A market that has passed `endDate` can still read `ACTIVE` until XO closes it. */
  status: MarketStatus;
  /** Whether the order book takes orders now. `null` until the order book is read. */
  acceptingOrders: boolean | null;
  /** When trading opens, as an ISO 8601 time. */
  startDate: string | null;
  /** When trading ends, as an ISO 8601 time. */
  endDate: string | null;
};

/**
 * One side of a market: its outcome token and its price.
 *
 * `tokenId` is the id to trade and to read the book with (`assetId` in a request).
 */
export type MarketOutcome = {
  /** The outcome's name, such as `YES`. */
  label: string;
  /** The outcome token, or `null` when no source gave one. */
  tokenId: TokenId | null;
  /**
   * The price in dollars between 0 and 1: the order book's midpoint, or its last trade when
   * a side is empty. `null` while the order book has neither, and `null` until the order
   * book is read.
   */
  price: DecimalString | null;
};

/** The two outcomes of a market. `yes` is the first outcome and `no` the second. */
export type MarketOutcomes = {
  /** The YES outcome. */
  yes: MarketOutcome;
  /** The NO outcome. */
  no: MarketOutcome;
};

/** How much has traded on a market. */
export type MarketMetrics = {
  /** The total volume in dollars, as XO prints it (two decimals). */
  volume: DecimalString;
};

/** How fees are split among the parties that earn them, in basis points of the fee. */
export type MarketFeeSplit = {
  /** The share that goes to the market's creator. */
  creatorShareBps: number;
  /** The share that goes to makers. */
  makerShareBps: number;
  /** The share that goes to XO. */
  platformShareBps: number;
};

/** The fees charged on a market, in basis points. */
export type MarketFeeSchedule = {
  /**
   * The taker's base fee. For the `CONVICTION_CURVE` fee type this is the rate before the
   * price curve is applied.
   */
  takerFeeBps: number;
  /** The maker's fee. */
  makerFeeBps: number;
  /** How the fee is shared out, or `null` when XO gave no split. */
  split: MarketFeeSplit | null;
};

/** The rules for trading a market. Each is `null` until the source that has it is read. */
export type MarketTrading = {
  /** The smallest order the SDK places, in shares: 1. `null` until the order book is read. */
  minimumOrderSize: DecimalString | null;
  /** The smallest price step, such as `"0.001"`. `null` until the order book is read. */
  minimumTickSize: DecimalString | null;
  /** Whether the market charges a taker or maker fee. `null` until the fee policy is read. */
  feesEnabled: boolean | null;
  /** The fee model, such as `FLAT_BPS` or `CONVICTION_CURVE`. `null` until the fee policy is read. */
  feeType: string | null;
  /** The fee rates, or `null` when fees do not apply or the fee policy was not read. */
  feeSchedule: MarketFeeSchedule | null;
};

/** How a market is resolved, and what it resolved to. */
export type MarketResolution = {
  /** The side that won, once the market has resolved. `null` while it is open or when it was voided. */
  winningOutcome: 'yes' | 'no' | null;
  /** When the market resolved, as an ISO 8601 time. */
  resolvedAt: string | null;
  /** The address that resolves the market. */
  resolvedBy: Address | null;
  /** How the market resolves: `AUTOMATIC`, `MANUAL` or `ORACLE`. */
  resolutionType: 'AUTOMATIC' | 'MANUAL' | 'ORACLE' | (string & {}) | null;
  /** The pages the resolution is based on. */
  sources: string[];
  /** The evidence the resolver gave, if any. */
  evidence: string | null;
};

/** The liquidity rewards one programme pays on a market, in one currency. */
export type MarketRewardsProgramme = {
  /** What it pays in: `CP` (conviction points) or `USDC`. */
  currency: 'CP' | 'USDC' | (string & {});
  /** Whether the programme pays today. */
  active: boolean;
  /** The whole programme's budget in `currency`. */
  rewardsAmount: DecimalString | null;
  /** What is paid out per day in `currency`. */
  rewardsDailyRate: DecimalString | null;
  /** When the programme starts, as an ISO 8601 time. */
  startDate: string | null;
  /** When the programme ends, as an ISO 8601 time. `null` while it has no end yet. */
  endDate: string | null;
};

/** The liquidity rewards on a market. Every field is `null` until the rewards programme is read. */
export type MarketRewards = {
  /** One entry per currency the market pays in. Empty when the market has no programme. */
  clobRewards: MarketRewardsProgramme[] | null;
  /** The smallest resting order that earns, in shares. */
  rewardsMinSize: DecimalString | null;
  /** How far from the midpoint an order still earns, in cents. */
  rewardsMaxSpread: number | null;
};

/** The event a market is placed on. */
export type MarketEvent = {
  /** The event's id. */
  id: string;
  /** The event's URL name, when XO gave it. */
  slug: string | null;
};

/** A label on a market, such as `league: wc`. */
export type MarketTag = {
  /** What the tag is about, or `null` for a plain label. */
  key: string | null;
  /** The tag's value. */
  value: string;
};

/**
 * A CLOB market with two outcomes: what it asks, its outcome tokens, its state, rules and
 * rewards.
 *
 * A market in a listing has only what the listing carries; the fields that need the order
 * book, the fee policy or the rewards programme are `null` there. Fetching the market joins
 * them all.
 */
export type Market = {
  /** XO's id for the market. */
  id: string;
  /** The market's URL name. */
  slug: string;
  /** The market's id on the order book, or `null` when XO gave none. */
  conditionId: ConditionId | null;
  /** What the market asks. */
  question: string;
  /**
   * The market's label within its event, such as a team or candidate name. `null` when the
   * market is not shown inside an event.
   */
  groupItemTitle: string | null;
  /** The market's rules and background. */
  description: string | null;
  /** The market's category, such as `Sports`. */
  category: string | null;
  /** The market's picture. */
  image: string | null;
  /** Whether the market is open and takes orders. */
  state: MarketState;
  /** The two outcomes and their prices. */
  outcomes: MarketOutcomes;
  /** How much has traded. */
  metrics: MarketMetrics;
  /** Tick size, order size and fees. */
  trading: MarketTrading;
  /** How the market resolves and what it resolved to. */
  resolution: MarketResolution;
  /** The liquidity rewards. */
  rewards: MarketRewards;
  /** The event the market is placed on: empty when it stands alone. */
  events: MarketEvent[];
  /** The market's tags. */
  tags: MarketTag[];
};

/**
 * What {@link toMarket} joins to a listed market. Each is optional; a missing one leaves its
 * fields `null`.
 *
 * @internal
 */
export interface MarketExtras {
  /** The order book's view of the market: tick size, accepting orders, live prices, tokens. */
  orderbook?: OrderbookMarket;
  /** The fee policy that applies to the market. */
  fees?: RawFeeConfig;
  /** The rewards programmes of the market. */
  rewards?: RawRewardsConfig;
}

/** The text, or `null` when it is missing or empty. */
function textOrNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

/** A decimal uint256 token id, or `null` when the value is missing or is not one. */
function tokenIdOrNull(value: string | null | undefined): TokenId | null {
  if (typeof value !== 'string') {
    return null;
  }
  try {
    return normalizeTokenId(value);
  } catch {
    return null;
  }
}

/** A checksummed address, or `null` when the value is missing or is not an address. */
function addressOrNull(value: string | null | undefined): Address | null {
  return typeof value === 'string' && isAddress(value, { strict: false })
    ? getAddress(value.toLowerCase())
    : null;
}

/** The two outcomes of a binary market, or `undefined` when it has any other shape. */
function binaryOutcomes(
  raw: RawMarket,
): { yes: RawOutcome; no: RawOutcome } | undefined {
  const outcomes = raw.outcomes ?? [];
  if (outcomes.length !== 2) {
    return undefined;
  }
  const yes = outcomes.find((outcome) => outcome.index === 0);
  const no = outcomes.find((outcome) => outcome.index === 1);
  return yes === undefined || no === undefined ? undefined : { yes, no };
}

/** The order book token of an outcome: by token id, or by its YES/NO name when it has no id. */
function bookToken(
  book: OrderbookMarket | undefined,
  outcome: RawOutcome,
  name: 'yes' | 'no',
): MarketToken | undefined {
  if (book === undefined) {
    return undefined;
  }
  const id = textOrNull(outcome.outcomeTokenId);
  return id === null
    ? book.tokens.find((token) => token.outcome.trim().toLowerCase() === name)
    : book.tokens.find((token) => token.token_id === id);
}

function outcomeOf(
  outcome: RawOutcome,
  book: OrderbookMarket | undefined,
  name: 'yes' | 'no',
): MarketOutcome {
  const token = bookToken(book, outcome, name);
  return {
    label: outcome.title,
    tokenId:
      tokenIdOrNull(outcome.outcomeTokenId) ?? tokenIdOrNull(token?.token_id),
    price: token === undefined ? null : priceOrNull(token.price),
  };
}

function stateOf(
  raw: RawMarket,
  book: OrderbookMarket | undefined,
): MarketState {
  return {
    active: raw.status === 'ACTIVE',
    closed: CLOSED_STATUSES.has(raw.status),
    status: raw.status,
    acceptingOrders: book === undefined ? null : book.active,
    startDate: raw.startsAt ?? null,
    endDate: raw.expiresAt ?? null,
  };
}

function tradingOf(
  book: OrderbookMarket | undefined,
  fees: RawFeeConfig | undefined,
): MarketTrading {
  const schedule: MarketFeeSchedule | null =
    fees === undefined || !fees.eligible
      ? null
      : {
          takerFeeBps: fees.takerFeeBps,
          makerFeeBps: fees.makerFeeBps,
          split:
            fees.splitSummary === null
              ? null
              : {
                  creatorShareBps: fees.splitSummary.creatorShareBps,
                  makerShareBps: fees.splitSummary.makerShareBps,
                  platformShareBps: fees.splitSummary.platformShareBps,
                },
        };
  return {
    minimumOrderSize: book === undefined ? null : MINIMUM_ORDER_SIZE,
    minimumTickSize: book === undefined ? null : book.minimum_tick_size,
    feesEnabled:
      fees === undefined
        ? null
        : fees.eligible && (fees.takerFeeBps > 0 || fees.makerFeeBps > 0),
    feeType: fees === undefined ? null : fees.curveModel,
    feeSchedule: schedule,
  };
}

function winnerOf(
  raw: RawMarket,
  outcomes: { yes: RawOutcome; no: RawOutcome },
): 'yes' | 'no' | null {
  const id = raw.winningOutcome?.id ?? raw.winningOutcomeId;
  if (id === undefined || id === null) {
    return null;
  }
  if (id === outcomes.yes.id) {
    return 'yes';
  }
  return id === outcomes.no.id ? 'no' : null;
}

function resolutionOf(
  raw: RawMarket,
  outcomes: { yes: RawOutcome; no: RawOutcome },
): MarketResolution {
  return {
    winningOutcome: winnerOf(raw, outcomes),
    resolvedAt: raw.resolvedAt ?? null,
    resolvedBy: addressOrNull(raw.resolverAddress),
    resolutionType: raw.resolutionType ?? null,
    sources: [...(raw.resolutionSources ?? [])],
    evidence: textOrNull(raw.resolutionEvidence),
  };
}

function rewardsOf(config: RawRewardsConfig | undefined): MarketRewards {
  if (config === undefined) {
    return { clobRewards: null, rewardsMinSize: null, rewardsMaxSpread: null };
  }
  // The scoring terms are the market's, the same on every currency's programme.
  const terms =
    config.programmes.find((programme) => programme.active) ??
    config.programmes[0];
  return {
    clobRewards: config.programmes.map((programme) => ({
      currency: programme.currency,
      active: programme.active,
      rewardsAmount: programme.budget_total,
      rewardsDailyRate: programme.daily_pool,
      startDate: programme.program_starts_at,
      endDate: programme.program_ends_at,
    })),
    rewardsMinSize:
      terms === undefined ? null : numberToDecimal(terms.min_order_size_shares),
    rewardsMaxSpread:
      terms === undefined || !isDecimalString(terms.max_distance_cents)
        ? null
        : Number(terms.max_distance_cents),
  };
}

function eventsOf(raw: RawMarket): MarketEvent[] {
  const id = textOrNull(raw.eventId);
  return id === null ? [] : [{ id, slug: textOrNull(raw.rootEventSlug) }];
}

function categoryOf(raw: RawMarket): string | null {
  return textOrNull(raw.categoryPath?.[0]?.name ?? raw.categoryNameRaw);
}

function build(
  raw: RawMarket,
  outcomes: { yes: RawOutcome; no: RawOutcome },
  extra: MarketExtras,
): Market {
  const { orderbook, rewards } = extra;
  // The fee policy the caller joined wins over the one a detail row carries.
  const fees = extra.fees ?? raw.effectiveFeeConfig ?? undefined;
  return {
    id: String(raw.id),
    slug: raw.slug,
    conditionId: isConditionId(raw.conditionId)
      ? (raw.conditionId.toLowerCase() as ConditionId)
      : null,
    question: raw.title,
    groupItemTitle: null,
    description: textOrNull(raw.description),
    category: categoryOf(raw),
    image: textOrNull(raw.imageUrl),
    state: stateOf(raw, orderbook),
    outcomes: {
      yes: outcomeOf(outcomes.yes, orderbook, 'yes'),
      no: outcomeOf(outcomes.no, orderbook, 'no'),
    },
    metrics: { volume: raw.totalVolumeInUSD },
    trading: tradingOf(orderbook, fees),
    resolution: resolutionOf(raw, outcomes),
    rewards: rewardsOf(rewards),
    events: eventsOf(raw),
    tags: (raw.marketTags ?? []).map((tag) => ({
      key: tag.key,
      value: tag.value,
    })),
  };
}

/**
 * Maps a row of a market listing to the {@link Market} model, without joining anything: the
 * fields that need the order book, the fee policy or the rewards programme are `null`.
 *
 * Returns `undefined` for a row that is not part of the model: not a CLOB market, or not
 * exactly two outcomes (indexes 0 and 1). A listing skips such rows.
 *
 * @internal
 */
export function toListedMarket(raw: RawMarket): Market | undefined {
  if (raw.type !== CLOB_MARKET_TYPE) {
    return undefined;
  }
  const outcomes = binaryOutcomes(raw);
  return outcomes === undefined ? undefined : build(raw, outcomes, {});
}

/**
 * Maps a market to the {@link Market} model and joins what the caller read next to it: the
 * order book's market, the fee policy and the rewards programmes. A fee policy the row itself
 * carries is used when `extra.fees` is not given.
 *
 * It does not look at the market type: a market asked for by its id is mapped as it is.
 *
 * @throws {UnexpectedResponseError} With code `market_not_binary` when the market does not
 *   have exactly two outcomes (indexes 0 and 1).
 * @internal
 */
export function toMarket(raw: RawMarket, extra: MarketExtras): Market {
  const outcomes = binaryOutcomes(raw);
  if (outcomes === undefined) {
    const count = raw.outcomes?.length ?? 0;
    throw new UnexpectedResponseError(
      `Market ${raw.id} is not a binary market: it lists ${count} outcomes`,
      {
        code: 'market_not_binary',
        service: 'backend',
        issues: [
          {
            path: 'outcomes',
            code: 'invalid_outcomes',
            message: 'Expected exactly two outcomes, with index 0 and 1',
          },
        ],
      },
    );
  }
  return build(raw, outcomes, extra);
}
