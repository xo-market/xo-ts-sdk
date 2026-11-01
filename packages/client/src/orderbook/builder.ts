import { type Hex, zeroAddress } from 'viem';
import { normalizeAddress } from '../core/address';
import {
  fromMicro,
  priceToTick,
  toMicro,
  type WholeUnits,
} from '../core/decimal';
import type { EnvironmentConfig } from '../core/env';
import { UserInputError } from '../core/errors';
import { parseTokenId } from '../core/ids';
import type {
  OrderHash,
  OrderType,
  RawUnitsString,
  Side,
  TokenId,
} from '../core/types';
import type { OrderType as PublicOrderType } from '../models/enums';
import { assertHexBytes, assertUint } from '../signing/internal';
import {
  hashOrder,
  type OrderStruct,
  orderDomain,
  orderTypedData,
  toWireOrder,
  type WireOrder,
} from '../signing/order';
import { signAsTrader, type TradingIdentity } from '../wallet/identity';
import type { InternalSigner } from '../wallet/signer';
import {
  deriveAmounts,
  gatewayTick,
  MIN_SIZE_MICRO,
  TICK_DENOM,
  validateOrderSize,
} from './amounts';

/**
 * A limit order, as the caller states it. Price and size are whole-unit decimals: a
 * {@link RawUnitsString} (a micro-unit amount the orderbook or the data client returns, such
 * as `"5000000"` for 5 shares) is refused at compile time when the object is passed to
 * `createOrder` or `placeOrder` directly. Convert one first, for example with viem's
 * `formatUnits(BigInt(raw), 6)`.
 * `P` and `S` are inferred from the call; there is no need to write them.
 */
export interface LimitOrderArgs<
  P extends string | number = string | number,
  S extends string | number = string | number,
> {
  /** The outcome token: a decimal string (uint256). A number would lose precision and is refused. */
  tokenId: TokenId | string;
  side: Side;
  /** USDC per share, `0.001` to `0.999` and a multiple of the market's tick size. */
  price: WholeUnits<P>;
  /** Shares, at least 1 and at most 6 decimals. */
  size: WholeUnits<S>;
  /** Defaults to `'GTC'`. */
  type?: OrderType;
  /** Defaults to `false`. Only allowed with `'GTC'` and `'GTD'`. */
  postOnly?: boolean;
  /**
   * When a `'GTD'` order ends. Required for `'GTD'` and refused for every other type.
   * A `Date`, or a number of unix **seconds** (milliseconds are refused).
   */
  expiration?: Date | number;
  /** Defaults to 64 random bits. Must be a `bigint` in `[0, 2^256)`. */
  salt?: bigint;
  /** bytes16. Defaults to all zeros. */
  identifier?: Hex;
  /** bytes32. Defaults to all zeros. */
  metadata?: Hex;
}

/**
 * A market order. It is a limit order at the worst price the caller accepts: `maxPrice` for
 * BUY and `minPrice` for SELL, or 0.999 and 0.001 without one. The amount is whole units: a
 * {@link RawUnitsString} is refused at compile time, as for {@link LimitOrderArgs}.
 */
export interface MarketOrderArgs<A extends string | number = string | number> {
  /** The outcome token: a decimal string (uint256). A number would lose precision and is refused. */
  tokenId: TokenId | string;
  side: Side;
  /** BUY: the USDC to spend. SELL: the shares to sell (at least 1). At most 6 decimals. */
  amount: WholeUnits<A>;
  /**
   * BUY only: the highest price per share to pay, `0.001` to `0.999` and a multiple of the
   * market's tick size. Defaults to 0.999.
   */
  maxPrice?: number | string;
  /**
   * SELL only: the lowest price per share to take, `0.001` to `0.999` and a multiple of the
   * market's tick size. Defaults to 0.001.
   */
  minPrice?: number | string;
  /** Defaults to `'FAK'`. */
  type?: 'FAK' | 'FOK';
}

/**
 * A signed order, ready to place. The builders return it deeply frozen: changing it would
 * break its signature, and `postOrder` refuses an order whose hash no longer matches.
 */
export interface SignedOrder {
  readonly order: Readonly<OrderStruct>;
  readonly orderHash: OrderHash;
  readonly wire: Readonly<WireOrder>;
  /** How long the order lives: `OrderType.GTC`, `GTD`, `FOK` or `FAK`. */
  readonly orderType: PublicOrderType;
  readonly postOnly: boolean;
}

/** What the builders need to know about the trader and the market. */
export interface BuilderContext {
  env: EnvironmentConfig;
  identity: TradingIdentity;
  signer: InternalSigner;
  /** The trader's current exchange nonce (`CTFExchange.nonces(maker)`). Called once per build. */
  nonce: () => Promise<bigint>;
  /**
   * The market's tick size as a decimal string, such as `"0.001"`. Called once per limit build,
   * and once per market build with a worst price other than the extreme one.
   */
  tickSize: (tokenId: string) => Promise<string>;
  /** The server-synced clock, in unix seconds. Every "now" check uses it, never `Date.now`. */
  nowSec: () => number;
}

const ORDER_TYPES: readonly OrderType[] = ['GTC', 'GTD', 'FOK', 'FAK'];
const MARKET_ORDER_TYPES: readonly OrderType[] = ['FAK', 'FOK'];

/** A unix time in seconds stays below this for thousands of years; milliseconds are far above. */
const MAX_UNIX_SECONDS = 1e11;
/** The gateway requires a GTD expiration at least this far after its own clock. */
const MIN_GTD_LIFETIME_SEC = 1;

/** A market BUY is a limit BUY at the highest tick, 0.999. */
const MARKET_BUY_TICK = 999n;
/** A market SELL is a limit SELL at the lowest tick, 0.001. */
const MARKET_SELL_TICK = 1n;

/** The gateway and the matching engine hold sizes and amounts as u64. */
const U64_MAX = 2n ** 64n - 1n;

const ZERO_IDENTIFIER: Hex = `0x${'00'.repeat(16)}`;
const ZERO_METADATA: Hex = `0x${'00'.repeat(32)}`;

function assertArgs(a: unknown): void {
  if (typeof a !== 'object' || a === null) {
    throw new UserInputError('order arguments must be an object');
  }
}

function parseSide(value: unknown): Side {
  if (value !== 'BUY' && value !== 'SELL') {
    throw new UserInputError("side must be 'BUY' or 'SELL'");
  }
  return value;
}

function parseOrderType(
  value: unknown,
  allowed: readonly OrderType[],
): OrderType {
  if (!allowed.includes(value as OrderType)) {
    throw new UserInputError(`type must be one of ${allowed.join(', ')}`);
  }
  return value as OrderType;
}

function parsePostOnly(value: unknown, type: OrderType): boolean {
  if (value === undefined) {
    return false;
  }
  if (typeof value !== 'boolean') {
    throw new UserInputError('postOnly must be a boolean');
  }
  if (value && type !== 'GTC' && type !== 'GTD') {
    throw new UserInputError(
      `postOnly is only allowed with GTC or GTD orders, not ${type}`,
    );
  }
  return value;
}

/** The unix seconds of a `Date`, or of a number that already is seconds. */
function toUnixSeconds(value: unknown): number {
  if (
    value instanceof Date ||
    Object.prototype.toString.call(value) === '[object Date]'
  ) {
    const ms = (value as Date).getTime();
    if (!Number.isFinite(ms)) {
      throw new UserInputError('expiration is an invalid Date');
    }
    return Math.floor(ms / 1000);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new UserInputError('expiration must be a finite number');
    }
    if (value > MAX_UNIX_SECONDS) {
      throw new UserInputError(
        'expiration looks like milliseconds; pass unix seconds, or a Date',
      );
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new UserInputError(
        'expiration must be a non-negative integer number of unix seconds',
      );
    }
    return value;
  }
  throw new UserInputError(
    'expiration must be a Date or a number of unix seconds',
  );
}

/**
 * The `expiration` to sign: 0 for GTC, FOK and FAK, and for GTD the given time in unix
 * seconds, which must be at least {@link MIN_GTD_LIFETIME_SEC} after the server's clock.
 */
function resolveExpiration(
  type: OrderType,
  expiration: unknown,
  nowSec: () => number,
): bigint {
  if (type !== 'GTD') {
    if (expiration !== undefined) {
      throw new UserInputError(
        `expiration is only for GTD orders; it is 0 for ${type}`,
      );
    }
    return 0n;
  }
  if (expiration === undefined) {
    throw new UserInputError(
      'expiration is required for GTD orders: a Date, or unix seconds',
    );
  }
  const seconds = toUnixSeconds(expiration);
  const now = nowSec();
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new UserInputError(
      'nowSec() must return the server time as a finite number of unix seconds',
    );
  }
  if (seconds < now + MIN_GTD_LIFETIME_SEC) {
    throw new UserInputError(
      `expiration must be at least ${MIN_GTD_LIFETIME_SEC} second after the server time (expiration ${seconds}, server time ${now})`,
    );
  }
  return BigInt(seconds);
}

/** 64 random bits, read big-endian. */
function randomSalt(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getBigUint64(0);
}

/**
 * Builds the order struct from the validated pieces, signs it as the trader, and returns it
 * with its hash and its wire form. The nonce is the only value read here, and the struct
 * is fully validated (`orderTypedData`) before the signer sees it. Everything signed is
 * built locally.
 */
async function signOrder(
  ctx: BuilderContext,
  fields: {
    tokenId: bigint;
    side: Side;
    makerAmount: bigint;
    takerAmount: bigint;
    expiration: bigint;
    salt: bigint;
    identifier: Hex;
    metadata: Hex;
    orderType: OrderType;
    postOnly: boolean;
  },
): Promise<SignedOrder> {
  const trader = normalizeAddress(ctx.identity.address, 'identity.address');
  const order: OrderStruct = {
    salt: fields.salt,
    maker: trader,
    signer: trader,
    beneficiary: zeroAddress,
    tokenId: fields.tokenId,
    makerAmount: fields.makerAmount,
    takerAmount: fields.takerAmount,
    expiration: fields.expiration,
    nonce: await ctx.nonce(),
    identifier: fields.identifier,
    metadata: fields.metadata,
    side: fields.side === 'BUY' ? 0 : 1,
    signatureType: ctx.identity.signatureType,
  };
  const domain = orderDomain(ctx.env.chainId, ctx.env.contracts.ctfExchange);
  const typedData = orderTypedData(order, domain);
  const signature = await signAsTrader(
    ctx.identity,
    ctx.signer,
    typedData,
    ctx.env.chainId,
  );
  // Deeply frozen: every field is a primitive once `order` and `wire` are frozen.
  return Object.freeze({
    order: Object.freeze(order),
    orderHash: hashOrder(order, domain),
    wire: Object.freeze(toWireOrder(order, signature)),
    orderType: fields.orderType as PublicOrderType,
    postOnly: fields.postOnly,
  });
}

/**
 * Builds and signs a limit order.
 *
 * Nothing is rounded. A price that is not an exact multiple of the market's tick size, or
 * a size with more than 6 decimals, is refused with a `UserInputError`, and so is
 * everything else the gateway would reject (a size under 1 share, `postOnly` with FOK or
 * FAK, a GTD without an expiration at least 1 second in the future). Every check that
 * needs no lookup runs before `ctx.tickSize` is called, the tick-size check runs before
 * `ctx.nonce` is called, and everything is validated before anything is signed.
 *
 * @throws {UserInputError} For any invalid input, starting with the field name.
 */
export async function buildLimitOrder(
  a: LimitOrderArgs,
  ctx: BuilderContext,
): Promise<SignedOrder> {
  assertArgs(a);
  const tokenId = parseTokenId(a.tokenId);
  const side = parseSide(a.side);
  const orderType =
    a.type === undefined ? 'GTC' : parseOrderType(a.type, ORDER_TYPES);
  const postOnly = parsePostOnly(a.postOnly, orderType);
  const expiration = resolveExpiration(orderType, a.expiration, ctx.nowSec);
  const salt =
    a.salt === undefined ? randomSalt() : assertUint(a.salt, 256, 'salt');
  const identifier =
    a.identifier === undefined
      ? ZERO_IDENTIFIER
      : assertHexBytes(a.identifier, 16, 'identifier');
  const metadata =
    a.metadata === undefined
      ? ZERO_METADATA
      : assertHexBytes(a.metadata, 32, 'metadata');

  const tick = priceToTick(a.price, 'price');
  const size = toMicro(a.size, 'size');
  if (size <= 0n) {
    throw new UserInputError('size must be greater than zero');
  }
  // Before deriveAmounts: below 1000 micro-units the derived amounts drift off the tick.
  validateOrderSize(side, tick, size);

  const tickSizeText = await ctx.tickSize(tokenId.toString());
  const step = priceToTick(tickSizeText, 'tickSize');
  if (tick % step !== 0n) {
    throw new UserInputError(
      `price must be a multiple of the market tick size ${tickSizeText}`,
    );
  }

  const { makerAmount, takerAmount } = deriveAmounts(side, tick, size);
  return signOrder(ctx, {
    tokenId,
    side,
    makerAmount,
    takerAmount,
    expiration,
    salt,
    identifier,
    metadata,
    orderType,
    postOnly,
  });
}

/** Ceiling division for a non-negative numerator and a positive denominator. */
function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * The smallest market BUY `amount` (micro-USDC) that buys the minimum size at the cap
 * `tick`: the least `m` with `floor(m * 1000 / tick) >= MIN_SIZE_MICRO`.
 */
const minMarketBuyAmount = (tick: bigint): bigint =>
  ceilDiv(MIN_SIZE_MICRO * tick, TICK_DENOM);

/**
 * Runs {@link validateOrderSize} on the order size behind a market `amount` and words a
 * failure in terms of `amount`: USDC for a BUY, shares for a SELL. The checks themselves
 * stay in `validateOrderSize`; this only decides what the caller reads.
 */
function validateAmountSize(side: Side, tick: bigint, size: bigint): void {
  try {
    validateOrderSize(side, tick, size);
  } catch (error) {
    if (!(error instanceof UserInputError)) {
      throw error;
    }
    let message: string;
    if (size < MIN_SIZE_MICRO) {
      message =
        side === 'BUY'
          ? `amount must be at least ${fromMicro(minMarketBuyAmount(tick))} USDC (1 share at the ${fromMicro((tick * 1_000_000n) / TICK_DENOM)} cap)`
          : 'amount must be at least 1 share';
    } else if (size > U64_MAX) {
      message = `amount is too large: it would exceed the u64 limit (${U64_MAX} micro-units)`;
    } else {
      message = `amount is outside the order limits (${error.message})`;
    }
    throw new UserInputError(message, { cause: error });
  }
}

/**
 * A post-condition, not an input check: the amounts that pass {@link validateAmountSize}
 * always read back from the gateway as the cap tick. It stays so a future change to the
 * derivation cannot sign an order at another price.
 */
function assertCapTick(
  side: Side,
  cap: bigint,
  makerAmount: bigint,
  takerAmount: bigint,
): void {
  if (gatewayTick(side, makerAmount, takerAmount) !== cap) {
    throw new UserInputError(
      `amount does not round-trip to the cap price for a market ${side}`,
    );
  }
}

/** BUY: spend `amount` USDC (the maker side) for as many shares as the cap buys, rounded down. */
function marketBuyAmounts(amount: bigint, cap: bigint) {
  const makerAmount = amount;
  const takerAmount = (makerAmount * TICK_DENOM) / cap;
  // First: it rejects a tiny amount (taker below 1 share) with a message the caller can act on.
  validateAmountSize('BUY', cap, takerAmount);
  assertCapTick('BUY', cap, makerAmount, takerAmount);
  return { makerAmount, takerAmount };
}

/** SELL: give `amount` shares (the maker side) for at least the cap each, rounded down. */
function marketSellAmounts(amount: bigint, cap: bigint) {
  validateAmountSize('SELL', cap, amount);
  const amounts = deriveAmounts('SELL', cap, amount);
  assertCapTick('SELL', cap, amounts.makerAmount, amounts.takerAmount);
  return amounts;
}

/**
 * The worst price the caller set for a market order, as a tick: `maxPrice` for a BUY,
 * `minPrice` for a SELL, or `undefined` without one. The field of the other side is refused.
 */
function marketCap(
  side: Side,
  a: MarketOrderArgs,
): { tick: bigint; field: 'maxPrice' | 'minPrice' } | undefined {
  if (side === 'BUY' && a.minPrice !== undefined) {
    throw new UserInputError(
      'minPrice is for a market sell; a market buy takes maxPrice',
    );
  }
  if (side === 'SELL' && a.maxPrice !== undefined) {
    throw new UserInputError(
      'maxPrice is for a market buy; a market sell takes minPrice',
    );
  }
  const field = side === 'BUY' ? 'maxPrice' : 'minPrice';
  const value = a[field];
  return value === undefined
    ? undefined
    : { tick: priceToTick(value, field), field };
}

/**
 * Builds and signs a market order: a limit order at the worst price the caller accepts, so
 * it fills at the best prices available and never above or below it. The worst price is
 * `maxPrice` for a BUY and `minPrice` for a SELL, or the extremes 0.999 and 0.001 without
 * them. The type is `'FAK'` unless `'FOK'` is given, `postOnly` is never set and the
 * expiration is 0.
 *
 * - BUY: `amount` is USDC. `makerAmount = amount` and `takerAmount =
 *   floor(makerAmount * 1000 / cap)`, which the gateway reads back as the cap tick.
 * - SELL: `amount` is shares, at least 1. `makerAmount = amount` and `takerAmount =
 *   floor(makerAmount * cap / 1000)`, which the gateway reads back as the cap tick.
 *
 * Nothing is rounded: an amount with more than 6 decimals, or a worst price that is not a
 * multiple of the market's tick size, is refused. Only a worst price other than the extreme
 * one needs the tick-size lookup; it runs after every other check and before anything is
 * signed. A worst price of 0.999 to buy or 0.001 to sell is the same order as none.
 *
 * @throws {UserInputError} For any invalid input, starting with the field name.
 */
export async function buildMarketOrder(
  a: MarketOrderArgs,
  ctx: BuilderContext,
): Promise<SignedOrder> {
  assertArgs(a);
  const tokenId = parseTokenId(a.tokenId);
  const side = parseSide(a.side);
  const orderType =
    a.type === undefined ? 'FAK' : parseOrderType(a.type, MARKET_ORDER_TYPES);
  // Not in the type, but a plain-JS caller could pass them, and ignoring them would hide it.
  const extra = a as unknown as Record<string, unknown>;
  if (extra.postOnly !== undefined && extra.postOnly !== false) {
    throw new UserInputError('postOnly is not supported for market orders');
  }
  if (extra.expiration !== undefined) {
    throw new UserInputError('expiration is not supported for market orders');
  }
  const cap = marketCap(side, a);
  const extreme = side === 'BUY' ? MARKET_BUY_TICK : MARKET_SELL_TICK;
  const tick = cap?.tick ?? extreme;

  const amount = toMicro(a.amount, 'amount');
  if (amount <= 0n) {
    throw new UserInputError('amount must be greater than zero');
  }
  const { makerAmount, takerAmount } =
    side === 'BUY'
      ? marketBuyAmounts(amount, tick)
      : marketSellAmounts(amount, tick);

  if (cap !== undefined && cap.tick !== extreme) {
    const tickSizeText = await ctx.tickSize(tokenId.toString());
    const step = priceToTick(tickSizeText, 'tickSize');
    if (cap.tick % step !== 0n) {
      throw new UserInputError(
        `${cap.field} must be a multiple of the market tick size ${tickSizeText}`,
      );
    }
  }

  return signOrder(ctx, {
    tokenId,
    side,
    makerAmount,
    takerAmount,
    expiration: 0n,
    salt: randomSalt(),
    identifier: ZERO_IDENTIFIER,
    metadata: ZERO_METADATA,
    orderType,
    postOnly: false,
  });
}
