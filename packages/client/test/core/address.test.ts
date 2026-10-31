import { getAddress } from 'viem';
import { describe, expect, test } from 'vitest';
import { isSameAddress, normalizeAddress } from '../../src/core/address';
import { UserInputError } from '../../src/core/errors';

const LOWER = '0x00000000000000000000000000000000000000b2';

describe('normalizeAddress', () => {
  test('normalizeAddress fixes bad mixed-case checksums', () => {
    expect(normalizeAddress('0x00000000000000000000000000000000000000B2')).toBe(
      getAddress('0x00000000000000000000000000000000000000b2'),
    );
    expect(() => normalizeAddress('0x123')).toThrow(UserInputError);
  });

  test('returns the EIP-55 checksummed form of a lower-case address', () => {
    const addr = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
    expect(normalizeAddress(addr)).toBe(
      '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    );
  });

  test('fixes a deliberately wrong mixed-case checksum instead of rejecting it', () => {
    const badChecksum = '0xD8Da6bf26964aF9D7eEd9e03E53415D37aA96045';
    expect(normalizeAddress(badChecksum)).toBe(
      '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    );
  });

  test('is idempotent', () => {
    const once = normalizeAddress(LOWER);
    expect(normalizeAddress(once)).toBe(once);
  });

  test('rejects anything that is not 0x plus 40 hex characters', () => {
    const bad = [
      '',
      '0x',
      '0x123',
      '00000000000000000000000000000000000000b2',
      '0X00000000000000000000000000000000000000b2',
      '0x00000000000000000000000000000000000000b',
      '0x00000000000000000000000000000000000000b22',
      '0x00000000000000000000000000000000000000zz',
      ' 0x00000000000000000000000000000000000000b2',
      '0x00000000000000000000000000000000000000b2 ',
      'vitalik.eth',
    ];
    for (const b of bad) {
      expect(() => normalizeAddress(b)).toThrow(UserInputError);
    }
  });

  test('rejects non-string input', () => {
    for (const bad of [null, undefined, 123, {}]) {
      // biome-ignore lint/suspicious/noExplicitAny: deliberately feeding invalid input
      expect(() => normalizeAddress(bad as any)).toThrow(UserInputError);
    }
  });

  test('error message mentions the field when given', () => {
    expect(() => normalizeAddress('0x123', 'maker')).toThrow(/maker/);
  });

  test('error message works without a field', () => {
    expect(() => normalizeAddress('0x123')).toThrow(/address/i);
  });
});

describe('isSameAddress', () => {
  test('compares case-insensitively', () => {
    expect(isSameAddress(LOWER, LOWER.toUpperCase().replace('0X', '0x'))).toBe(
      true,
    );
    expect(isSameAddress(LOWER, getAddress(LOWER))).toBe(true);
    expect(
      isSameAddress(
        '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
        '0xD8DA6BF26964AF9D7EED9E03E53415D37AA96045',
      ),
    ).toBe(true);
  });

  test('returns false for different addresses', () => {
    expect(
      isSameAddress(LOWER, '0x00000000000000000000000000000000000000b3'),
    ).toBe(false);
  });

  test('returns false for invalid input and never throws', () => {
    expect(isSameAddress('0x123', '0x123')).toBe(false);
    expect(isSameAddress(LOWER, 'nope')).toBe(false);
    expect(isSameAddress('nope', LOWER)).toBe(false);
    expect(isSameAddress('', '')).toBe(false);
    // biome-ignore lint/suspicious/noExplicitAny: deliberately feeding invalid input
    expect(isSameAddress(null as any, undefined as any)).toBe(false);
  });
});
