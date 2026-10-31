import { type Address, type Hex, isHash } from 'viem';
import type { ConditionId, DecimalString, TokenId } from '../core/types';
import type { MarketActivity as RawMarketActivity } from '../data/activitySchemas';
import type {
  Commitment as RawCommitment,
  ConvictionMarket as RawConvictionMarket,
  LastTradePrice as RawLastTradePrice,
  LastTradePriceEntry as RawLastTradePriceEntry,
  MarketCapacity as RawMarketCapacity,
  PricePoint as RawPricePoint,
  PricesBySide as RawPricesBySide,
} from '../orderbook/schemas';
import {
  addressOf,
  conditionIdOf,
  conditionIdOrNull,
  priceOrNull,
  textOrNull,
  tokenIdOf,
  unexpectedField,
  wholeUnitsOf,
} from './convert';
import { OrderSide } from './enums';

// The small public models of the order book's market data: the last trade of a token, a point
// of its price history, a conviction market, what an account can commit in a market, and a
// fill of the public trade feed. The books themselves are in `orderBook.ts`. Prices, sizes and
// amounts are whole-unit decimals.

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

/**
 * The best price of one outcome token on each side of its book, in dollars between 0 and 1.
 * Only the sides that were asked for are there.
 */
export type PricesBySide = {
  /** The best bid: the highest price a buyer offers. `null` when nobody bids. */
  BUY?: DecimalString | null;
  /** The best ask: the lowest price a seller wants. `null` when nobody asks. */
  SELL?: DecimalString | null;
};

/** The entries of an answer by token id, keyed by the token id without leading zeros. */
function byToken<T>(raw: Record<string, T>): Map<string, T> {
  return new Map(
    Object.entries(raw).map(([tokenId, value]) => [tokenIdOf(tokenId), value]),
  );
}

/**
 * Maps the midpoints of several tokens to one entry for each token asked: the midpoint, or
 * `null` when the token has none (a side of its book is empty, which the order book prints as
 * `"0.000"`, or the order book does not know the token).
 *
 * @internal
 */
export function toMidpoints(
  assetIds: readonly string[],
  raw: Record<string, DecimalString>,
): Record<string, DecimalString | null> {
  const found = byToken(raw);
  const midpoints: Record<string, DecimalString | null> = {};
  for (const assetId of assetIds.map(tokenIdOf)) {
    const midpoint = found.get(assetId);
    midpoints[assetId] = midpoint === undefined ? null : priceOrNull(midpoint);
  }
  return midpoints;
}

/**
 * Maps the spreads of several tokens to one entry for each token asked: the spread, or `null`
 * when the token has none. The order book leaves out a token whose book has an empty side, and
 * one it does not know, so a spread it lists is a spread, `"0"` included.
 *
 * @internal
 */
export function toSpreads(
  assetIds: readonly string[],
  raw: Record<string, DecimalString>,
): Record<string, DecimalString | null> {
  const found = byToken(raw);
  const spreads: Record<string, DecimalString | null> = {};
  for (const assetId of assetIds.map(tokenIdOf)) {
    spreads[assetId] = found.get(assetId) ?? null;
  }
  return spreads;
}

/**
 * Maps the prices of several tokens to one entry for each token asked, with each side asked
 * for: the price, or `null` when that side of the book is empty (which the order book prints as
 * `"0.000"`) or the order book does not know the token.
 *
 * @internal
 */
export function toPrices(
  requests: readonly { assetId: string; side: 'BUY' | 'SELL' }[],
  raw: Record<string, RawPricesBySide>,
): Record<string, PricesBySide> {
  const found = byToken(raw);
  const prices: Record<string, PricesBySide> = {};
  for (const request of requests) {
    const assetId = tokenIdOf(request.assetId);
    const price = found.get(assetId)?.[request.side];
    prices[assetId] = {
      ...prices[assetId],
      [request.side]: price === undefined ? null : priceOrNull(price),
    };
  }
  return prices;
}

// ---------------------------------------------------------------------------
// Last trade
// ---------------------------------------------------------------------------

/** The last trade of an outcome token. */
export type LastTradePrice = {
  /** The trade's price in dollars between 0 and 1. */
  price: DecimalString;
  /** The side of the order that took the liquidity. */
  side: OrderSide;
};

/** The last trade of one outcome token in a list of them. */
export type LastTradePriceForAsset = {
  /** The outcome token the trade is for. */
  assetId: TokenId;
  /** The trade's price in dollars between 0 and 1. */
  price: DecimalString;
  /** The side of the order that took the liquidity. */
  side: OrderSide;
};

/**
 * Maps the last trade of a token to the {@link LastTradePrice} model. A token that has not
 * traded answers a placeholder price and no side: that is `null`, never a price.
 *
 * @internal
 */
export function toLastTradePrice(
  raw: RawLastTradePrice,
): LastTradePrice | null {
  return raw.side === ''
    ? null
    : { price: raw.price, side: raw.side as OrderSide };
}

/**
 * Maps one entry of the last trades of several tokens to the {@link LastTradePriceForAsset}
 * model. `undefined` for an entry without a side, which is no trade.
 *
 * @internal
 */
export function toLastTradePriceForAsset(
  raw: RawLastTradePriceEntry,
): LastTradePriceForAsset | undefined {
  return raw.side === ''
    ? undefined
    : {
        assetId: tokenIdOf(raw.token_id),
        price: raw.price,
        side: raw.side as OrderSide,
      };
}

// ---------------------------------------------------------------------------
// Price history
// ---------------------------------------------------------------------------

/** One point of a token's price history: the price of a trade. */
export type PricePoint = {
  /** When the trade happened, in Unix milliseconds. */
  timestamp: number;
  /** The trade's price in dollars between 0 and 1, as printed, such as `"0.520"`. */
  price: DecimalString;
};

/**
 * Maps a point of the price history to the {@link PricePoint} model: the order book counts
 * seconds, the model milliseconds.
 *
 * @internal
 */
export function toPricePoint(raw: RawPricePoint): PricePoint {
  return { timestamp: raw.t * 1000, price: raw.p };
}

// ---------------------------------------------------------------------------
// Conviction market
// ---------------------------------------------------------------------------

/** One outcome of a conviction market. */
export type ConvictionOutcome = {
  /** The outcome's token, the id to read its book with. */
  tokenId: TokenId;
  /** The outcome's price: the midpoint, else the last trade. `null` when it has neither. */
  price: DecimalString | null;
};

/**
 * The order a market's creator committed to when making it. The order book keeps no detail
 * once the order has left the book, so those fields are `null` then.
 */
export type ConvictionCommitment = {
  /** The commitment's order id. */
  orderId: string;
  /** `resting` while the order is on the book, `spent_tombstone` after it left. */
  status: 'resting' | 'spent_tombstone' | (string & {});
  /** The outcome the commitment is on, `yes` or `no`. */
  outcome: 'yes' | 'no' | (string & {});
  /** Whether the commitment buys or sells. */
  side: OrderSide | null;
  /** The commitment's price in dollars between 0 and 1. */
  price: DecimalString | null;
  /** The commitment's size in shares. */
  size: DecimalString | null;
  /** The shares of the commitment still resting. */
  remaining: DecimalString | null;
};

/** A market with the metadata of a conviction market: who created it and what they committed. */
export type ConvictionMarket = {
  /** The market's id on the order book. */
  conditionId: ConditionId;
  /** Whether the market is taking orders. */
  active: boolean;
  /** The kind of market: `clob`, `clob_pulse` or `conviction`. A kind added later reads as its own string. */
  variant: 'clob' | 'clob_pulse' | 'conviction' | (string & {});
  /** The wallet that created the market. `null` for a market that is not a conviction market. */
  creator: Address | null;
  /** The creator's commitment. `null` for a market that is not a conviction market, or when the slot is empty. */
  commitment: ConvictionCommitment | null;
  /** The two outcomes. */
  outcomes: { yes: ConvictionOutcome; no: ConvictionOutcome };
};

function commitmentOf(raw: RawCommitment): ConvictionCommitment {
  let side: OrderSide | null = null;
  if (raw.side === 'buy') {
    side = OrderSide.BUY;
  } else if (raw.side === 'sell') {
    side = OrderSide.SELL;
  }
  return {
    orderId: raw.order_id,
    status: raw.status,
    outcome: raw.outcome,
    side,
    price: raw.price ?? null,
    size: raw.size ?? null,
    remaining: raw.remaining ?? null,
  };
}

/**
 * Maps a conviction market to the {@link ConvictionMarket} model. The two outcomes are found
 * by their names, `Yes` and `No`.
 *
 * @throws {UnexpectedResponseError} When the market does not list a `Yes` and a `No` outcome.
 * @internal
 */
export function toConvictionMarket(raw: RawConvictionMarket): ConvictionMarket {
  const named = (name: string) =>
    raw.tokens.find((token) => token.outcome.toLowerCase() === name);
  const yes = named('yes');
  const no = named('no');
  if (yes === undefined || no === undefined) {
    throw unexpectedField(
      'outcomes',
      'a Yes outcome and a No outcome',
      'orderbook',
    );
  }
  return {
    conditionId: conditionIdOf(raw.condition_id),
    active: raw.active,
    variant: raw.variant,
    creator: raw.creator === null ? null : addressOf(raw.creator),
    commitment: raw.commitment === null ? null : commitmentOf(raw.commitment),
    outcomes: {
      yes: { tokenId: tokenIdOf(yes.token_id), price: priceOrNull(yes.price) },
      no: { tokenId: tokenIdOf(no.token_id), price: priceOrNull(no.price) },
    },
  };
}

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

/** What an account can still commit of one outcome's shares. */
export type PositionCapacity = {
  /** The outcome token. */
  assetId: TokenId;
  /** The outcome, `YES` or `NO`. */
  outcome: 'YES' | 'NO' | (string & {});
  /** The shares the account holds, settled. */
  balance: DecimalString;
  /** The shares reserved by resting sell orders. */
  reserved: DecimalString;
  /** The shares matched in a trade that has not settled yet. */
  pendingSettlement: DecimalString;
  /** The shares a new sell order may use. */
  free: DecimalString;
};

/** What an account can still commit in one market. */
export type MarketCapacity = {
  /** The market's id on the order book. */
  conditionId: ConditionId;
  /** The USDC a new buy order in this market may use, in dollars. */
  buyCapacity: DecimalString;
  /** What the account can sell of each outcome: the YES outcome, then the NO outcome. Empty for a market the order book does not know. */
  positions: PositionCapacity[];
};

/**
 * Maps what an account can commit in a market to the {@link MarketCapacity} model, converting
 * the micro-units to whole units.
 *
 * @throws {UnexpectedResponseError} When an amount is not a whole number of micro-units.
 * @internal
 */
export function toMarketCapacity(raw: RawMarketCapacity): MarketCapacity {
  return {
    conditionId: conditionIdOf(raw.market_id),
    buyCapacity: wholeUnitsOf(
      raw.free_market_capacity,
      'buyCapacity',
      'orderbook',
    ),
    positions: raw.positions.map((position, index) => {
      const at = `positions[${index}]`;
      return {
        assetId: tokenIdOf(position.token_id),
        outcome: position.outcome,
        balance: wholeUnitsOf(position.balance, `${at}.balance`, 'orderbook'),
        reserved: wholeUnitsOf(
          position.reserved,
          `${at}.reserved`,
          'orderbook',
        ),
        pendingSettlement: wholeUnitsOf(
          position.pending_settlement,
          `${at}.pendingSettlement`,
          'orderbook',
        ),
        free: wholeUnitsOf(position.free_position, `${at}.free`, 'orderbook'),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Public trades
// ---------------------------------------------------------------------------

/**
 * A fill of a market, as the public trade feed lists it. A field the feed does not give is
 * `null`: a single market's feed leaves out the market's own fields, which the caller knows.
 */
export type MarketTrade = {
  /** XO's id for the fill. */
  id: string;
  /** Whether the fill bought or sold shares. */
  side: OrderSide;
  /** XO's id for the market (the `id` of a `Market`). */
  marketId: string | null;
  /** The market's id on the order book. `null` in a single market's feed. */
  conditionId: ConditionId | null;
  /** The market's question. `null` in a single market's feed. */
  title: string | null;
  /** The market's URL name. `null` in a single market's feed. */
  slug: string | null;
  /** The URL name of the event the market is placed on. */
  eventSlug: string | null;
  /** The market's picture. `null` in a single market's feed. */
  icon: string | null;
  /** The outcome that traded, such as `YES`. */
  outcome: string | null;
  /** The outcome's index in the market: 0 for the first, 1 for the second. */
  outcomeIndex: number | null;
  /** The shares that changed hands. */
  size: DecimalString;
  /** The price per share, in dollars between 0 and 1. `null` when XO gave none. */
  price: DecimalString | null;
  /** The dollar value of the fill. */
  amount: DecimalString;
  /** When the fill was executed, as an ISO 8601 time. */
  timestamp: string;
  /** The settlement transaction. `null` when XO has none for the fill. */
  transactionHash: Hex | null;
  /** XO's id for the trader. `null` when the fill names none. */
  userId: string | null;
  /** The trader's username. */
  username: string | null;
  /** The trader's picture. */
  profileImage: string | null;
};

/**
 * Maps a row of the public trade feed to the {@link MarketTrade} model. `marketId` is the
 * market the caller asked for, used when the row carries no market of its own. `undefined` for
 * a row that is not a buy or a sell by a trader, such as a creator share unlock.
 *
 * @throws {UnexpectedResponseError} When the size or the price is not a whole number of micro-units.
 * @internal
 */
export function toMarketTrade(
  raw: RawMarketActivity,
  marketId?: string,
): MarketTrade | undefined {
  if (
    raw.activityType !== 'USER_TRADE' ||
    (raw.positionType !== 'BUY' && raw.positionType !== 'SELL')
  ) {
    return undefined;
  }
  const { market, user, outcome } = raw;
  return {
    id: String(raw.id),
    side: raw.positionType === 'BUY' ? OrderSide.BUY : OrderSide.SELL,
    marketId: market === null ? (marketId ?? null) : String(market.id),
    conditionId: conditionIdOrNull(market?.contractMarketId),
    title: textOrNull(market?.title),
    slug: textOrNull(market?.slug),
    eventSlug: textOrNull(market?.eventSlug),
    icon: textOrNull(market?.imageUrl),
    outcome: outcome?.title ?? null,
    outcomeIndex: outcome?.index ?? null,
    size: wholeUnitsOf(raw.shareAmount, 'size', 'backend'),
    price:
      raw.priceAtExecution === undefined || raw.priceAtExecution === null
        ? null
        : wholeUnitsOf(raw.priceAtExecution, 'price', 'backend'),
    amount: raw.volumeInUSD,
    timestamp: raw.executedAt,
    transactionHash:
      typeof raw.transactionHash === 'string' && isHash(raw.transactionHash)
        ? raw.transactionHash
        : null,
    userId: user === null ? null : String(user.id),
    username: user === null ? null : textOrNull(user.username),
    profileImage: user === null ? null : textOrNull(user.profilePictureUrl),
  };
}
