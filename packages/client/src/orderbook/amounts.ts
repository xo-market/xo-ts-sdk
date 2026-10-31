import { UserInputError } from '../core/errors';
import type { Side } from '../core/types';

/** The smallest order the gateway admits: 1 share, in micro-units (6 decimals). */
export const MIN_SIZE_MICRO = 1_000_000n;
/** The smallest notional the gateway admits: 0.001 USDC, in micro-USDC. */
export const MIN_NOTIONAL_MICRO = 1000n;
/** Prices are ticks out of 1000: tick 570 is 0.570 USDC per share. */
export const TICK_DENOM = 1000n;

const MIN_TICK = 1n;
const MAX_TICK = 999n;
/** The gateway and the matching engine hold sizes and amounts as u64. */
const U64_MAX = 2n ** 64n - 1n;

function assertSide(side: Side): void {
  if (side !== 'BUY' && side !== 'SELL') {
    throw new UserInputError("side must be 'BUY' or 'SELL'");
  }
}

function assertTick(tick: bigint): void {
  if (typeof tick !== 'bigint' || tick < MIN_TICK || tick > MAX_TICK) {
    throw new UserInputError('tick must be a bigint between 1 and 999');
  }
}

function assertPositive(value: bigint, field: string): void {
  if (typeof value !== 'bigint' || value <= 0n) {
    throw new UserInputError(`${field} must be a positive bigint`);
  }
}

function assertU64(value: bigint, field: string): void {
  if (value > U64_MAX) {
    throw new UserInputError(
      `${field} must not exceed the u64 limit (${U64_MAX})`,
    );
  }
}

/** Ceiling division for a non-negative numerator and a positive denominator. */
function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Derives an order's on-chain `makerAmount` and `takerAmount` from its price tick and
 * size (micro-units).
 *
 * The gateway does not take the tick from us: it recomputes it from the two amounts
 * (see {@link gatewayTick}), rounding the opposite way. Our rounding has to oppose
 * its rounding, or the order lands one tick away from the price that was asked for:
 *
 * - BUY: `maker = ceil(tick * size / 1000)`, `taker = size`. The gateway floors, so
 *   rounding the maker up puts its floor back on the tick.
 * - SELL: `maker = size`, `taker = floor(tick * size / 1000)`. The gateway ceils, so
 *   rounding the taker down puts its ceil back on the tick.
 *
 * This does not enforce the gateway minimums, so callers run {@link validateOrderSize}
 * first. Below the minimums the result is not safe to sign:
 *
 * - A SELL can floor its taker to zero.
 * - A BUY (or a SELL) below 1000 micro-units lands on a different gateway tick than
 *   the one asked for in most cases, because the rounding remainder (up to 999) can
 *   then reach the size (see {@link gatewayTick}).
 *
 * @throws {UserInputError} If `side`, `tick` (1..999) or `sizeMicro` (positive) is
 * invalid, or if `makerAmount` or `takerAmount` would exceed the u64 limit.
 */
export function deriveAmounts(
  side: Side,
  tick: bigint,
  sizeMicro: bigint,
): { makerAmount: bigint; takerAmount: bigint } {
  assertSide(side);
  assertTick(tick);
  assertPositive(sizeMicro, 'sizeMicro');

  const amounts =
    side === 'BUY'
      ? {
          makerAmount: ceilDiv(tick * sizeMicro, TICK_DENOM),
          takerAmount: sizeMicro,
        }
      : {
          makerAmount: sizeMicro,
          takerAmount: (tick * sizeMicro) / TICK_DENOM,
        };
  assertU64(amounts.makerAmount, 'makerAmount');
  assertU64(amounts.takerAmount, 'takerAmount');
  return amounts;
}

/**
 * Recomputes the price tick the way the gateway does, from the two signed amounts:
 * BUY is `floor(maker * 1000 / taker)`, SELL is `ceil(taker * 1000 / maker)`.
 *
 * `gatewayTick(side, ...deriveAmounts(side, tick, size)) === tick` for every tick
 * 1..999 and every size >= 1000 micro-units, so for every size
 * {@link validateOrderSize} admits. The amounts that `deriveAmounts` produces differ
 * from the exact `tick * size / 1000` only by a rounding remainder of at most 999, and
 * the gateway's division by `size` therefore stays on the tick as long as that
 * remainder is less than the size. Below 1000 micro-units it can reach the size, and
 * the gateway tick can come back different.
 *
 * @throws {UserInputError} If `side` is invalid or either amount is not a positive bigint.
 */
export function gatewayTick(
  side: Side,
  makerAmount: bigint,
  takerAmount: bigint,
): bigint {
  assertSide(side);
  assertPositive(makerAmount, 'makerAmount');
  assertPositive(takerAmount, 'takerAmount');

  if (side === 'BUY') {
    return (makerAmount * TICK_DENOM) / takerAmount;
  }
  return ceilDiv(takerAmount * TICK_DENOM, makerAmount);
}

/**
 * The notional floor check, mirroring the gateway's own. The
 * notional of a tick is `floor(tick * size / 1000)`. The gateway requires it to be at
 * least {@link MIN_NOTIONAL_MICRO} on the order's own tick and on its complement
 * `1000 - tick`.
 *
 * @returns The notional that fails the floor (the own tick is checked first), or
 * `undefined` when both pass.
 * @throws {UserInputError} If `tick` is not a bigint in 1..999 or `sizeMicro` is not
 * a positive bigint.
 */
export function notionalBelowMinimum(
  tick: bigint,
  sizeMicro: bigint,
): bigint | undefined {
  assertTick(tick);
  assertPositive(sizeMicro, 'sizeMicro');

  const own = (tick * sizeMicro) / TICK_DENOM;
  if (own < MIN_NOTIONAL_MICRO) return own;
  const complement = ((TICK_DENOM - tick) * sizeMicro) / TICK_DENOM;
  if (complement < MIN_NOTIONAL_MICRO) return complement;
  return undefined;
}

/**
 * Checks an order against the gateway's admission floors, so it fails here with a
 * clear message and not as a gateway rejection.
 *
 * - The size must be at least 1 share ({@link MIN_SIZE_MICRO}) and at most the u64
 *   maximum, which is what the gateway and the matching engine hold sizes in.
 * - The notional must be at least {@link MIN_NOTIONAL_MICRO} on both the order's own
 *   tick and its complement (see {@link notionalBelowMinimum}).
 *
 * With today's constants the size floor already implies the notional floor for every
 * tick in 1..999 (`1 * 1_000_000 / 1000 === 1000`). The notional check stays so this
 * function keeps mirroring the gateway if either constant changes.
 *
 * @throws {UserInputError} If an input is invalid or the order is outside a limit.
 */
export function validateOrderSize(
  side: Side,
  tick: bigint,
  sizeMicro: bigint,
): void {
  assertSide(side);
  assertTick(tick);
  assertPositive(sizeMicro, 'sizeMicro');
  assertU64(sizeMicro, 'sizeMicro');

  if (sizeMicro < MIN_SIZE_MICRO) {
    throw new UserInputError(
      `size must be at least 1 share (${MIN_SIZE_MICRO} micro-units)`,
    );
  }

  if (notionalBelowMinimum(tick, sizeMicro) !== undefined) {
    throw new UserInputError(
      'order notional below the 0.001 USDC minimum at this price (own price or complement)',
    );
  }
}
