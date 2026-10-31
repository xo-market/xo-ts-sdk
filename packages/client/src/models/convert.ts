import { type Address, getAddress, isAddress } from 'viem';
import { fromMicro, isDecimalString } from '../core/decimal';
import { UnexpectedResponseError } from '../core/errors';
import { isConditionId, normalizeTokenId } from '../core/ids';
import type { ConditionId, DecimalString, TokenId } from '../core/types';

// The small conversions the order book, order and trade models share. They never throw for
// an id or an address they cannot read (the value passes through, so one odd row does not
// hide a whole listing); a time or an amount the model cannot hold is an unexpected response.

/** The text, or `null` when it is missing or empty. */
export function textOrNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

/** Zero, as XO prints it where there is no price: `"0"`, `"0.000"`. */
const NO_PRICE = /^0+(\.0+)?$/;

/**
 * A price as XO prints it, or `null` where there is none. A price is above 0, so XO's zero
 * (`"0.000"` for an empty side of a book) is no price, never a price. A value that is not a
 * plain decimal is `null` too.
 */
export function priceOrNull(value: string): DecimalString | null {
  return isDecimalString(value) && !NO_PRICE.test(value) ? value : null;
}

/** A condition id in lower case, or `null` when the value is missing or is not one. */
export function conditionIdOrNull(
  value: string | null | undefined,
): ConditionId | null {
  return typeof value === 'string' && isConditionId(value)
    ? conditionIdOf(value)
    : null;
}

/** The condition id in lower case; a value that is not one passes through unchanged. */
export function conditionIdOf(value: string): ConditionId {
  return (isConditionId(value) ? value.toLowerCase() : value) as ConditionId;
}

/** The token id without leading zeros; a value that is not one passes through unchanged. */
export function tokenIdOf(value: string): TokenId {
  try {
    return normalizeTokenId(value);
  } catch {
    return value as TokenId;
  }
}

/** The checksummed address; a value that is not one passes through unchanged. */
export function addressOf(value: string): Address {
  return (
    isAddress(value, { strict: false })
      ? getAddress(value.toLowerCase())
      : value
  ) as Address;
}

/**
 * Unix seconds, given as a number or as digits, as an ISO 8601 time. `null` when the value
 * is not whole seconds, or is too far from today for a date.
 */
export function isoFromSeconds(value: number | string): string | null {
  const seconds =
    typeof value === 'number'
      ? value
      : /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    return null;
  }
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The service an answer came from: it is named on the error of a value the model cannot hold. */
export type AnswerService = 'backend' | 'orderbook';

/** The error for a value the model cannot hold. It names the field and never the value. */
export function unexpectedField(
  field: string,
  expected: string,
  service: AnswerService,
): UnexpectedResponseError {
  return new UnexpectedResponseError(`${field} is not ${expected}`, {
    service,
    issues: [
      { path: field, code: 'invalid_value', message: `Expected ${expected}` },
    ],
  });
}

/**
 * A time in Unix milliseconds as an ISO 8601 time. `null` when the value is not a whole,
 * non-negative number of milliseconds, or is too far from today for a date.
 */
export function isoFromMilliseconds(value: number): string | null {
  if (!Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * {@link isoFromMilliseconds} for a field that must have a time.
 *
 * @throws {UnexpectedResponseError} When the value is not a time.
 */
export function requireIsoFromMilliseconds(
  value: number,
  field: string,
  service: AnswerService = 'backend',
): string {
  const iso = isoFromMilliseconds(value);
  if (iso === null) {
    throw unexpectedField(field, 'a time in unix milliseconds', service);
  }
  return iso;
}

/**
 * {@link isoFromSeconds} for a field that must have a time.
 *
 * @throws {UnexpectedResponseError} When the value is not a time.
 */
export function requireIso(
  value: number | string,
  field: string,
  service: AnswerService = 'orderbook',
): string {
  const iso = isoFromSeconds(value);
  if (iso === null) {
    throw unexpectedField(field, 'a time in unix seconds', service);
  }
  return iso;
}

/** The longest run of digits an amount may have: a uint256 has 78. */
const MAX_AMOUNT_DIGITS = 78;

/**
 * Micro-units (6 decimals, as digits) as whole units, exactly: `"570000"` is `"0.57"`. An
 * empty amount is zero.
 *
 * @throws {UnexpectedResponseError} When `micro` is not digits.
 */
export function wholeUnitsOf(
  micro: string,
  field: string,
  service: AnswerService = 'orderbook',
): DecimalString {
  if (micro === '') {
    return '0';
  }
  if (micro.length > MAX_AMOUNT_DIGITS || !/^\d+$/.test(micro)) {
    throw unexpectedField(field, 'a whole number of micro-units', service);
  }
  return fromMicro(BigInt(micro));
}

/**
 * {@link wholeUnitsOf} for an amount that can be negative, such as a loss: `"-50000"` is
 * `"-0.05"`.
 *
 * @throws {UnexpectedResponseError} When `micro` is not digits, with an optional leading `-`.
 */
export function signedWholeUnitsOf(
  micro: string,
  field: string,
  service: AnswerService = 'orderbook',
): DecimalString {
  if (micro.startsWith('-')) {
    if (micro === '-') {
      throw unexpectedField(field, 'a whole number of micro-units', service);
    }
    const magnitude = wholeUnitsOf(micro.slice(1), field, service);
    return magnitude === '0' ? '0' : `-${magnitude}`;
  }
  return wholeUnitsOf(micro, field, service);
}

/**
 * The price of an engine tick (1 tick is 0.001): `890` is `"0.89"`. A tick runs from 0 to
 * 1000.
 *
 * @throws {UnexpectedResponseError} When `tick` is not a whole number from 0 to 1000.
 */
export function priceOfTick(
  tick: number,
  field: string,
  service: AnswerService = 'backend',
): DecimalString {
  if (!Number.isInteger(tick) || tick < 0 || tick > 1000) {
    throw unexpectedField(field, 'a price tick from 0 to 1000', service);
  }
  return fromMicro(BigInt(tick) * 1000n);
}
