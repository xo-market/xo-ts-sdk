import { describe, expect, test } from 'vitest';
import { UserInputError } from '../../src/core/errors';
import {
  isConditionId,
  normalizeConditionId,
  normalizeTokenId,
  parseTokenId,
} from '../../src/core/ids';

const UINT256_MAX = 2n ** 256n - 1n;
const CONDITION = `0x${'ab'.repeat(32)}`;

function message(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(UserInputError);
    return (error as UserInputError).message;
  }
  throw new Error('expected the call to throw');
}

describe('parseTokenId', () => {
  test('a decimal string becomes a bigint exactly, up to 2^256 - 1', () => {
    expect(parseTokenId('4660')).toBe(4660n);
    expect(parseTokenId(UINT256_MAX.toString())).toBe(UINT256_MAX);
    expect(parseTokenId('0')).toBe(0n);
  });

  test.each([
    ['a number', 4660],
    ['a bigint', 4660n],
    ['hex', '0x1234'],
    ['empty', ''],
    ['signed', '-1'],
    ['with a plus', '+1'],
    ['with a dot', '1.5'],
    ['with whitespace', ' 1'],
    ['an exponent', '1e3'],
    ['79 digits', '1'.repeat(79)],
    ['2^256', (2n ** 256n).toString()],
    ['undefined', undefined],
    ['null', null],
  ])('%s is refused, naming the field', (_name, value) => {
    expect(message(() => parseTokenId(value))).toMatch(/^tokenId /);
    expect(message(() => parseTokenId(value, 'tokenIds[2]'))).toMatch(
      /^tokenIds\[2\] /,
    );
  });

  test('the messages are the ones the order builder has always used', () => {
    expect(message(() => parseTokenId(5))).toBe(
      'tokenId must be a decimal string of digits (a number would lose precision)',
    );
    expect(message(() => parseTokenId((2n ** 256n).toString()))).toBe(
      'tokenId must be below 2^256',
    );
  });
});

describe('normalizeTokenId', () => {
  test('returns the canonical decimal string, without leading zeros', () => {
    expect(normalizeTokenId('0007')).toBe('7');
    expect(normalizeTokenId(UINT256_MAX.toString())).toBe(
      UINT256_MAX.toString(),
    );
  });

  test('refuses what parseTokenId refuses', () => {
    expect(message(() => normalizeTokenId(12))).toMatch(/^tokenId /);
    expect(message(() => normalizeTokenId('x', 'tokenIds[0]'))).toMatch(
      /^tokenIds\[0\] /,
    );
  });
});

describe('normalizeConditionId', () => {
  test('keeps a lower-case 0x + 64 hex id', () => {
    expect(normalizeConditionId(CONDITION)).toBe(CONDITION);
  });

  test('lower-cases an upper or mixed-case id', () => {
    const mixed = `0x${'AB'.repeat(16)}${'cd'.repeat(16)}`;
    expect(normalizeConditionId(mixed)).toBe(
      `0x${'ab'.repeat(16)}${'cd'.repeat(16)}`,
    );
    expect(normalizeConditionId(`0x${'AB'.repeat(32)}`)).toBe(CONDITION);
  });

  test.each([
    ['empty', ''],
    ['no prefix', 'ab'.repeat(32)],
    ['an upper-case prefix', `0X${'ab'.repeat(32)}`],
    ['63 hex digits', `0x${'a'.repeat(63)}`],
    ['65 hex digits', `0x${'a'.repeat(65)}`],
    ['a 20-byte address', `0x${'a'.repeat(40)}`],
    ['a non-hex digit', `0x${'g'.repeat(64)}`],
    ['whitespace around', ` ${CONDITION}`],
    ['a path segment', `${CONDITION}/../x`],
    ['a number', 5],
    ['a bigint', 5n],
    ['undefined', undefined],
    ['null', null],
  ])('%s is refused, naming the field', (_name, value) => {
    expect(message(() => normalizeConditionId(value))).toMatch(/^conditionId /);
    expect(message(() => normalizeConditionId(value, 'ids[1]'))).toMatch(
      /^ids\[1\] /,
    );
  });
});

describe('isConditionId', () => {
  test.each([
    ['lower case', CONDITION, true],
    ['upper-case digits', `0x${'AB'.repeat(32)}`, true],
    ['mixed-case digits', `0x${'aB'.repeat(32)}`, true],
    ['an upper-case prefix', `0X${'ab'.repeat(32)}`, false],
    ['no prefix', 'ab'.repeat(32), false],
    ['63 hex digits', `0x${'a'.repeat(63)}`, false],
    ['65 hex digits', `0x${'a'.repeat(65)}`, false],
    ['a 20-byte address', `0x${'a'.repeat(40)}`, false],
    ['a non-hex digit', `0x${'g'.repeat(64)}`, false],
    ['whitespace around', ` ${CONDITION}`, false],
    ['a number', 5, false],
    ['null', null, false],
  ])('%s → %s, as normalizeConditionId takes it', (_name, value, expected) => {
    expect(isConditionId(value)).toBe(expected);
    let accepted = true;
    try {
      normalizeConditionId(value);
    } catch {
      accepted = false;
    }
    expect(accepted).toBe(expected);
  });

  test('{ upperCaseX: true } also takes a 0X prefix, and nothing else more', () => {
    expect(isConditionId(`0X${'ab'.repeat(32)}`, { upperCaseX: true })).toBe(
      true,
    );
    expect(isConditionId(CONDITION, { upperCaseX: true })).toBe(true);
    expect(isConditionId(`0x${'a'.repeat(63)}`, { upperCaseX: true })).toBe(
      false,
    );
    expect(isConditionId(`1x${'ab'.repeat(32)}`, { upperCaseX: true })).toBe(
      false,
    );
    expect(isConditionId(42, { upperCaseX: true })).toBe(false);
  });
});
