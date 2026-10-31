import { UserInputError } from './errors';
import type { ConditionId, TokenId } from './types';

// Validators for the two identifiers the orderbook takes from callers. The order builder
// and the orderbook client share them, so a bad id is refused the same way (and before
// any request) everywhere.

const TOKEN_ID_PATTERN = /^[0-9]{1,78}$/;
const UINT256_LIMIT = 1n << 256n;
const CONDITION_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;
/** The same, with the `X` of the prefix in either case. */
const CONDITION_ID_ANY_PREFIX = /^0[xX][0-9a-fA-F]{64}$/;

/**
 * Reads an outcome token id: a decimal string of digits that fits a uint256. A number is
 * refused because it would lose precision. `field` names the argument in the message.
 *
 * @throws {UserInputError} When `value` is not such a string.
 */
export function parseTokenId(value: unknown, field = 'tokenId'): bigint {
  if (typeof value !== 'string' || !TOKEN_ID_PATTERN.test(value)) {
    throw new UserInputError(
      `${field} must be a decimal string of digits (a number would lose precision)`,
    );
  }
  const tokenId = BigInt(value);
  if (tokenId >= UINT256_LIMIT) {
    throw new UserInputError(`${field} must be below 2^256`);
  }
  return tokenId;
}

/**
 * Validates an outcome token id (see {@link parseTokenId}) and returns its canonical
 * decimal form: no leading zeros.
 */
export function normalizeTokenId(value: unknown, field = 'tokenId'): TokenId {
  return parseTokenId(value, field).toString() as TokenId;
}

/**
 * Whether `value` is a market condition id as {@link normalizeConditionId} takes it: `0x`
 * (lower case) followed by 64 hex digits in any case. With `{ upperCaseX: true }` a `0X`
 * prefix is accepted too (market resolution reads a pasted id that way, then lower-cases it).
 */
export function isConditionId(
  value: unknown,
  o: { upperCaseX?: boolean } = {},
): value is string {
  return (
    typeof value === 'string' &&
    (o.upperCaseX === true
      ? CONDITION_ID_ANY_PREFIX
      : CONDITION_ID_PATTERN
    ).test(value)
  );
}

/**
 * Validates a market condition id, `0x` followed by 64 hex digits, and returns it in
 * lower case. The `0x` must be lower case.
 *
 * This is stricter than some gateway read routes, which take any opaque market id. Every
 * production condition id is a 32-byte hex value, but a non-production gateway whose
 * markets have ids such as `market-1` is unreachable through this check.
 *
 * @throws {UserInputError} When `value` is not such a string.
 */
export function normalizeConditionId(
  value: unknown,
  field = 'conditionId',
): ConditionId {
  if (!isConditionId(value)) {
    throw new UserInputError(
      `${field} must be 0x followed by 64 hex characters`,
    );
  }
  return value.toLowerCase() as ConditionId;
}
