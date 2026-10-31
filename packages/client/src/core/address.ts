import type { Address } from 'viem';
import { getAddress, isAddress } from 'viem';
import { UserInputError } from './errors';

// strict: false -> shape check only (0x + 40 hex chars); the checksum is not enforced.
const isHexAddress = (value: unknown): value is string =>
  typeof value === 'string' && isAddress(value, { strict: false });

/**
 * Returns the EIP-55 checksummed form of an address. The input is lower-cased first,
 * so a wrong mixed-case checksum is repaired instead of rejected. Anything that is not
 * `0x` plus 40 hex characters throws a `UserInputError`.
 */
export function normalizeAddress(addr: string, field?: string): Address {
  if (!isHexAddress(addr)) {
    const subject = field ?? 'address';
    throw new UserInputError(
      `${subject} must be a 0x-prefixed 20-byte hex address`,
    );
  }
  return getAddress(addr.toLowerCase());
}

/** Case-insensitive address equality. Returns `false` for invalid input; never throws. */
export function isSameAddress(a: string, b: string): boolean {
  if (!isHexAddress(a) || !isHexAddress(b)) {
    return false;
  }
  return a.toLowerCase() === b.toLowerCase();
}
