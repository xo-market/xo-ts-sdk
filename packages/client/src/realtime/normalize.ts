import { UserInputError } from '../core/errors';

/** A whole number of seconds or milliseconds, written as decimal digits only. */
const DIGITS = /^\d+$/;

/** How many milliseconds one unit of each kind is. */
const MS_PER_UNIT = { ms: 1, s: 1000 } as const;

function shown(raw: unknown): string {
  // Never echo a long or exotic input into an error message.
  return typeof raw === 'string'
    ? JSON.stringify(raw.slice(0, 40))
    : typeof raw;
}

/**
 * Turns a timestamp from a realtime event into milliseconds since the Unix epoch.
 *
 * The gateway mixes units: `last_trade_price` carries seconds, every other timestamp is in
 * milliseconds, and some arrive as decimal strings. `unit` says what `raw` is in. The SDK keeps
 * the untouched value next to the normalised one (`rawTimestamp`).
 *
 * `raw` must be a non-negative safe integer, or a string of decimal digits only (`/^\d+$/`)
 * that parses to one. The result must be a safe integer too, so a number of seconds above
 * 9_007_199_254_740 is refused rather than silently rounded. Anything else (a negative or
 * fractional number, `NaN`, a string with a sign, a space, an exponent or a decimal point, a
 * `bigint`, `null`) throws a `UserInputError`.
 *
 * @example
 * normalizeTimestamp('1700000000', 's'); // 1_700_000_000_000
 * normalizeTimestamp(1_700_000_000_123, 'ms'); // 1_700_000_000_123
 */
export function normalizeTimestamp(
  raw: string | number,
  unit: 'ms' | 's',
): number {
  if (unit !== 'ms' && unit !== 's') {
    throw new UserInputError(`unit must be 'ms' or 's', got ${shown(unit)}`);
  }
  let value: number;
  if (typeof raw === 'number') {
    value = raw;
  } else if (typeof raw === 'string' && DIGITS.test(raw)) {
    value = Number(raw);
  } else {
    throw new UserInputError(
      `A timestamp must be a non-negative whole number or a string of digits, got ${shown(raw)}`,
    );
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new UserInputError(
      `A timestamp must be a non-negative safe integer, got ${shown(raw)}`,
    );
  }
  const ms = value * MS_PER_UNIT[unit];
  if (!Number.isSafeInteger(ms)) {
    throw new UserInputError(
      `The timestamp ${shown(raw)} is too large: in milliseconds it is not a safe integer`,
    );
  }
  // `-0` passes the checks above and must not leak out.
  return ms === 0 ? 0 : ms;
}
