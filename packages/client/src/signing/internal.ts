import type { Hex, TypedDataDomain } from 'viem';
import { normalizeAddress } from '../core/address';
import { UserInputError } from '../core/errors';

// Helpers shared by the signing modules (order, cancel, clobAuth, hmac, kernel). This module is
// not part of the public API: the signing index must not re-export it.

/**
 * Checks that `value` is a `bigint` in `[0, 2^bits)` and returns it.
 * Throws a `UserInputError` that starts with `field`.
 */
export function assertUint(
  value: unknown,
  bits: number,
  field: string,
): bigint {
  if (typeof value !== 'bigint') {
    throw new UserInputError(`${field} must be a bigint, not ${typeof value}`);
  }
  if (value < 0n || value >= 1n << BigInt(bits)) {
    throw new UserInputError(`${field} must be in the range [0, 2^${bits})`);
  }
  return value;
}

/**
 * Checks that `value` is a non-empty string and returns it. The message names the field
 * only; it never echoes the value, so it is safe for credentials.
 */
export function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new UserInputError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Checks that `value` is a unix timestamp in seconds, written as a string of decimal
 * digits (`/^\d+$/`), and returns it. The gateway signs the string as it is, so it is
 * never parsed or reformatted. The message does not echo the value.
 */
export function assertTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new UserInputError(
      `${field} must be a string of decimal digits (unix seconds)`,
    );
  }
  return value;
}

const HEX_RE = /^0x[0-9a-fA-F]*$/;

/**
 * Checks for a `0x` hex string of exactly `bytes` bytes and returns it. Either case; the
 * case is kept. The message names the field and the length, never the value.
 */
export function assertHexBytes(
  value: unknown,
  bytes: number,
  field: string,
): Hex {
  if (
    typeof value !== 'string' ||
    value.length !== 2 + bytes * 2 ||
    !HEX_RE.test(value)
  ) {
    throw new UserInputError(
      `${field} must be a 0x-prefixed hex string of exactly ${bytes} bytes`,
    );
  }
  return value as Hex;
}

/**
 * Checks for a `0x` hex string of whole bytes (an even number of digits, so `0x` alone is
 * the empty byte string) and returns it. Either case; the case is kept.
 */
export function assertHexData(value: unknown, field: string): Hex {
  if (
    typeof value !== 'string' ||
    value.length % 2 !== 0 ||
    !HEX_RE.test(value)
  ) {
    throw new UserInputError(
      `${field} must be a 0x-prefixed hex string with an even number of digits`,
    );
  }
  return value as Hex;
}

/** Checks for a chain id that is a positive safe integer and returns it. */
export function assertChainId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new UserInputError('chainId must be a positive safe integer');
  }
  return value;
}

/** A raw domain's chain id: a positive safe integer, or a positive `bigint` below 2^256. */
function assertDomainChainId(value: unknown): number | bigint {
  const ok =
    typeof value === 'bigint'
      ? value > 0n && value < 1n << 256n
      : typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  if (!ok) {
    throw new UserInputError(
      'domain.chainId must be a positive safe integer or a bigint in [1, 2^256)',
    );
  }
  return value as number | bigint;
}

const DOMAIN_KEYS: ReadonlySet<string> = new Set([
  'name',
  'version',
  'chainId',
  'verifyingContract',
]);

/**
 * Validates a domain and returns a fresh one with exactly the keys `name`, `version`,
 * `chainId` and `verifyingContract`, the last one checksummed so a wrong mixed-case
 * checksum cannot make viem throw.
 *
 * The domain must have a non-empty `name` and `version`, a `chainId` (a positive safe
 * integer, or a positive `bigint` below 2^256) and a `verifyingContract`. It must have no
 * other key with a defined value, such as `salt`: viem would add that field to the domain
 * type, and the digest would silently differ from the exchange's. A key that is present
 * but `undefined` is ignored.
 *
 * Every typed-data builder in this package runs its domain through this.
 * @throws UserInputError starting with `domain.<field>` for the first field that is missing, malformed or not supported.
 */
export function normalizeDomain(domain: TypedDataDomain): TypedDataDomain {
  if (typeof domain !== 'object' || domain === null) {
    throw new UserInputError('domain must be an object');
  }
  const normalized: TypedDataDomain = {
    name: assertNonEmptyString(domain.name, 'domain.name'),
    version: assertNonEmptyString(domain.version, 'domain.version'),
    chainId: assertDomainChainId(domain.chainId),
    verifyingContract: normalizeAddress(
      domain.verifyingContract ?? '',
      'domain.verifyingContract',
    ),
  };
  for (const [key, value] of Object.entries(domain)) {
    if (!DOMAIN_KEYS.has(key) && value !== undefined) {
      throw new UserInputError(`domain.${key} is not supported`);
    }
  }
  return normalized;
}
