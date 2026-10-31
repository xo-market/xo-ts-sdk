import { describe, expect, test } from 'vitest';
import { UserInputError } from '../../src/core/errors';
import { normalizeTimestamp } from '../../src/realtime/normalize';

describe('normalizeTimestamp', () => {
  test("normalizeTimestamp('1700000000', 's') === 1_700_000_000_000", () => {
    expect(normalizeTimestamp('1700000000', 's')).toBe(1_700_000_000_000);
  });

  test('seconds are multiplied by 1000, milliseconds are kept', () => {
    expect(normalizeTimestamp(1_700_000_000, 's')).toBe(1_700_000_000_000);
    expect(normalizeTimestamp(1_700_000_000_123, 'ms')).toBe(1_700_000_000_123);
    expect(normalizeTimestamp('1700000000123', 'ms')).toBe(1_700_000_000_123);
  });

  test('zero is valid in both units, and never negative zero', () => {
    expect(normalizeTimestamp(0, 'ms')).toBe(0);
    expect(normalizeTimestamp('0', 's')).toBe(0);
    expect(Object.is(normalizeTimestamp(-0, 's'), 0)).toBe(true);
    expect(Object.is(normalizeTimestamp(-0, 'ms'), 0)).toBe(true);
  });

  test('a digit string may have leading zeros', () => {
    expect(normalizeTimestamp('0001700000000', 's')).toBe(1_700_000_000_000);
  });

  test('the largest safe value is accepted in ms', () => {
    expect(normalizeTimestamp(Number.MAX_SAFE_INTEGER, 'ms')).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(normalizeTimestamp(String(Number.MAX_SAFE_INTEGER), 'ms')).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  test.each([
    ['a negative number', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an unsafe integer', 2 ** 53],
    ['an empty string', ''],
    ['a string with a space', ' 1'],
    ['a string with a trailing newline', '1\n'],
    ['a decimal string', '1.5'],
    ['a negative string', '-1'],
    ['an exponent string', '1e3'],
    ['a hex string', '0x10'],
    ['a plus sign', '+1'],
    ['non-ASCII digits', '١٢٣'],
    ['a word', 'abc'],
    ['a digit string beyond the safe range', '9007199254740993'],
    ['null', null],
    ['undefined', undefined],
    ['a bigint', 10n],
    ['an object', {}],
  ])('rejects %s', (_name, raw) => {
    expect(() => normalizeTimestamp(raw as never, 'ms')).toThrow(
      UserInputError,
    );
  });

  test('rejects seconds whose millisecond value would not be a safe integer', () => {
    expect(() => normalizeTimestamp(9_007_199_254_741, 's')).toThrow(
      UserInputError,
    );
    expect(() => normalizeTimestamp('9007199254741', 's')).toThrow(
      UserInputError,
    );
    // The largest value that still fits.
    expect(normalizeTimestamp(9_007_199_254_740, 's')).toBe(
      9_007_199_254_740_000,
    );
  });

  test('rejects an unknown unit', () => {
    expect(() => normalizeTimestamp(1, 'us' as never)).toThrow(UserInputError);
  });

  test('the error says what was wrong without echoing a long input', () => {
    const long = '9'.repeat(500);
    try {
      normalizeTimestamp(long, 'ms');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UserInputError);
      expect((error as UserInputError).message.length).toBeLessThan(200);
    }
  });
});
