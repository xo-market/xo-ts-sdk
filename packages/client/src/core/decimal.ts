import { UserInputError } from './errors';
import type { DecimalString, RawUnitsString } from './types';

/** 10^6: every on-chain amount and price uses 6 decimals. */
export const MICRO = 1_000_000n;

const TICK_MICRO = 1_000n; // one tick = 0.001 = 1_000 micro
const MIN_TICK = 1n;
const MAX_TICK = 999n;

// Plain decimal, up to 6 decimals. No sign, exponent, whitespace, or bare dot.
const DECIMAL_GRAMMAR = /^\d+(\.\d{1,6})?$/;

/**
 * Refuses a {@link RawUnitsString} at compile time: a raw token-unit amount (`"570000"`) is
 * not a whole-unit value (`"0.57"`), and passing one where whole units are expected is the
 * mistake the brand exists to catch. Any other type passes through unchanged.
 */
export type WholeUnits<T> = T extends RawUnitsString ? never : T;

/**
 * Converts a whole-unit amount to micro-units (6 decimals) without floating-point
 * arithmetic. `5n` -> `5_000_000n`, `'0.57'` -> `570_000n`, `153.641122` -> `153_641_122n`.
 *
 * Numbers go through `String(value)` and then the same grammar as strings, so
 * exponent forms (`1e-7`, `1e21`) and values with more than 6 decimals are rejected.
 * A {@link RawUnitsString} is refused at compile time.
 */
export function toMicro<V extends string | number | bigint>(
  value: WholeUnits<V>,
  field: string,
): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new UserInputError(`${field} must not be negative`);
    }
    return value * MICRO;
  }

  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new UserInputError(`${field} must be a finite number`);
    }
    text = String(value);
  } else if (typeof value === 'string') {
    text = value;
  } else {
    throw new UserInputError(
      `${field} must be a decimal string, number or bigint`,
    );
  }

  if (!DECIMAL_GRAMMAR.test(text)) {
    throw new UserInputError(
      `${field} must be a non-negative decimal with at most 6 decimal places (no sign, exponent or whitespace)`,
    );
  }

  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, '0'));
}

/**
 * Converts a whole-unit amount of a token with `decimals` decimals to its base units, without
 * floating-point arithmetic: with 18 decimals, `'1.5'` is 1.5 × 10^18. A number goes through
 * `String(value)` first, so an exponent form (`1e-7`) is refused, as is a value with more
 * fraction digits than the token has, a sign or whitespace. A {@link RawUnitsString} is refused
 * at compile time. With 6 decimals it is {@link toMicro} for strings and numbers.
 *
 * @throws {UserInputError} When `value` is not a plain decimal with at most `decimals` fraction
 *   digits. The message names `field` and never the value.
 */
export function toUnits<V extends string | number>(
  value: WholeUnits<V>,
  decimals: number,
  field: string,
): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new UserInputError(
      `${field}: the token's decimals must be a whole number from 0 to 255`,
    );
  }
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new UserInputError(`${field} must be a finite number`);
    }
    text = String(value);
  } else if (typeof value === 'string') {
    text = value;
  } else {
    throw new UserInputError(`${field} must be a decimal string or a number`);
  }
  const grammar =
    decimals === 0 ? /^\d+$/ : new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`);
  if (!grammar.test(text)) {
    throw new UserInputError(
      `${field} must be a non-negative decimal with at most ${decimals} decimal places (no sign, exponent or whitespace)`,
    );
  }
  const [whole = '0', fraction = ''] = text.split('.');
  const scale = 10n ** BigInt(decimals);
  return BigInt(whole) * scale + BigInt(fraction.padEnd(decimals, '0') || '0');
}

/**
 * Formats base units of a token with `decimals` decimals as a whole-unit decimal string,
 * trimming trailing zeros: with 18 decimals, 1.5 × 10^18 is `'1.5'`.
 */
export function fromUnits(units: bigint, decimals: number): DecimalString {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const fraction =
    decimals === 0
      ? ''
      : (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}`;
}

/**
 * Formats micro-units as a whole-unit decimal string, trimming trailing zeros and
 * dropping the dot when nothing is left: `500_000n` -> `'0.5'`, `1_000_000n` -> `'1'`.
 */
export function fromMicro(micro: bigint): DecimalString {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const whole = abs / MICRO;
  const fraction = (abs % MICRO).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}`;
}

/**
 * Converts a price to its tick (1..999, where one tick is 0.001). The price must be an
 * exact multiple of 0.001 within 0.001..0.999. A {@link RawUnitsString} (`"570000"`, a raw
 * price from the data client) is refused at compile time.
 */
export function priceToTick<P extends string | number>(
  price: WholeUnits<P>,
  field = 'price',
): bigint {
  const micro = toMicro(price, field);
  if (micro % TICK_MICRO !== 0n) {
    throw new UserInputError(`${field} must be a multiple of 0.001`);
  }
  const tick = micro / TICK_MICRO;
  if (tick < MIN_TICK || tick > MAX_TICK) {
    throw new UserInputError(`${field} must be between 0.001 and 0.999`);
  }
  return tick;
}

/** Formats a tick (1..999) as a price with exactly 3 decimals: `570n` -> `'0.570'`. */
export function tickToPrice(tick: bigint): DecimalString {
  if (typeof tick !== 'bigint' || tick < MIN_TICK || tick > MAX_TICK) {
    throw new UserInputError('tick must be a bigint between 1 and 999');
  }
  return `0.${tick.toString().padStart(3, '0')}`;
}

// A plain decimal of any length: digits, an optional fraction, an optional leading minus.
// No exponent, plus sign, whitespace, or bare dot.
const DECIMAL_SHAPE = /^-?\d+(\.\d+)?$/;

/** Whether `value` is a string in the plain decimal shape (see {@link DecimalString}). */
export function isDecimalString(value: unknown): value is DecimalString {
  return typeof value === 'string' && DECIMAL_SHAPE.test(value);
}

/**
 * Moves the decimal point of `mantissa` (digits with an optional fraction, no sign) by
 * `exponent` places, in the text, and returns a plain decimal without leading zeros in the
 * integer part. No arithmetic and no rounding: only digits and zeros are written.
 */
function shiftPoint(mantissa: string, exponent: number): string {
  const [whole = '0', fraction = ''] = mantissa.split('.');
  const digits = whole + fraction;
  // Where the decimal point sits within `digits` once the exponent is applied.
  const point = whole.length + exponent;
  let integer: string;
  let fractional = '';
  if (point <= 0) {
    integer = '0';
    fractional = '0'.repeat(-point) + digits;
  } else if (point >= digits.length) {
    integer = digits + '0'.repeat(point - digits.length);
  } else {
    integer = digits.slice(0, point);
    fractional = digits.slice(point);
  }
  integer = integer.replace(/^0+(?=\d)/, '');
  return fractional === '' ? integer : `${integer}.${fractional}`;
}

/**
 * Turns a JSON number into a plain decimal string without losing or inventing digits.
 *
 * The digits are the shortest ones that parse back to the same number (what `String(n)`
 * prints), and an exponent form (`1e-7`, `1.5e+21`) is expanded by moving the decimal point
 * in the text. It never goes through `toFixed`, which rounds, nor through arithmetic.
 * `0.57` is `"0.57"`, `1e-7` is `"0.0000001"`, `1e21` is `"1000000000000000000000"`, and
 * `-0` is `"0"`.
 *
 * A number that already lost digits before it was serialized (a long integer above 2^53)
 * stays as inexact as the server made it: this recovers what the number says, not what the
 * server meant.
 *
 * @throws {UserInputError} When `value` is not finite.
 */
export function numberToDecimal(value: number, field = 'value'): DecimalString {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new UserInputError(`${field} must be a finite number`);
  }
  if (value === 0) {
    return '0';
  }
  const text = String(value);
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const expAt = body.indexOf('e');
  if (expAt === -1) {
    return text;
  }
  const plain = shiftPoint(body.slice(0, expAt), Number(body.slice(expAt + 1)));
  return negative ? `-${plain}` : plain;
}

// A decimal in exponent form: digits, an optional fraction, then `e` or `E` and a signed
// exponent. A JSON serializer on the server side can print a tiny or huge value this way.
const EXPONENT_SHAPE = /^(-?)(\d+(?:\.\d+)?)[eE]([+-]?\d+)$/;

/**
 * The largest exponent a string is expanded for. A finite double goes from `e-324` to
 * `e308`, so nothing real needs more, and a hostile `1e999999999` must not become a
 * gigabyte of zeros.
 */
const MAX_EXPONENT = 400;

/**
 * Reads a money-like field from a server answer. A plain decimal string passes through
 * unchanged (`"0.570"` keeps its padding). A string in exponent form (`"1e-7"`, `"1.5E+21"`)
 * is expanded in the text exactly as {@link numberToDecimal} expands a number, and a number
 * is converted with it. The message names the field and never the value.
 *
 * @throws {UserInputError} When `value` is neither, or an exponent is beyond +/-400.
 */
export function toDecimalString(value: unknown, field: string): DecimalString {
  if (typeof value === 'string') {
    if (DECIMAL_SHAPE.test(value)) {
      return value;
    }
    const match = EXPONENT_SHAPE.exec(value);
    if (match === null) {
      throw new UserInputError(`${field} must be a plain decimal string`);
    }
    const [, sign = '', mantissa = '0', exponent = '0'] = match;
    const shift = Number(exponent);
    if (!Number.isFinite(shift) || Math.abs(shift) > MAX_EXPONENT) {
      throw new UserInputError(`${field} has an exponent out of range`);
    }
    return `${sign}${shiftPoint(mantissa, shift)}`;
  }
  if (typeof value === 'number') {
    return numberToDecimal(value, field);
  }
  throw new UserInputError(`${field} must be a decimal string or a number`);
}
