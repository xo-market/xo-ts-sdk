import type { Hex } from 'viem';
import { describe, expect, test } from 'vitest';
import { SigningError } from '../../src/core/errors';
import { isObject, normalizeSignature } from '../../src/wallet/internal';

const RS = `0x${'ab'.repeat(32)}${'cd'.repeat(32)}`;
const sig = (v: string): Hex => `${RS}${v}` as Hex;

describe('normalizeSignature', () => {
  test.each([
    ['1b', '1b'],
    ['1c', '1c'],
    ['00', '1b'],
    ['01', '1c'],
  ])('a recovery byte of 0x%s comes back as 0x%s', (v, expected) => {
    expect(normalizeSignature(sig(v))).toBe(sig(expected));
  });

  test('r and s are kept as they are, in any letter case', () => {
    const upper = `0x${'AB'.repeat(32)}${'Cd'.repeat(32)}00` as Hex;
    expect(normalizeSignature(upper)).toBe(
      `0x${'AB'.repeat(32)}${'Cd'.repeat(32)}1b`,
    );
    expect(normalizeSignature(sig('1B'))).toBe(sig('1B'));
  });

  test.each(['02', '1a', '1d', '1f', 'ff'])(
    'a recovery byte of 0x%s is a SigningError that does not quote the signature',
    (v) => {
      const bad = sig(v);
      let error: unknown;
      try {
        normalizeSignature(bad);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(SigningError);
      expect(JSON.stringify(error)).not.toContain('abab');
      expect((error as SigningError).message).not.toContain('abab');
    },
  );

  test.each([
    [
      'too short (64 bytes, a compact EIP-2098 signature)',
      `0x${'ab'.repeat(64)}`,
    ],
    ['too long', `0x${'ab'.repeat(66)}`],
    ['no 0x', 'ab'.repeat(65)],
    ['not hex', `0x${'zz'.repeat(65)}`],
    ['empty', ''],
    ['a number', 7],
    ['null', null],
    ['undefined', undefined],
    ['an object', { signature: RS }],
  ])('%s is a SigningError', (_label, bad) => {
    expect(() => normalizeSignature(bad)).toThrow(SigningError);
  });
});

describe('isObject', () => {
  test('is true for objects and class instances, false for the rest', () => {
    expect(isObject({})).toBe(true);
    expect(isObject(new Map())).toBe(true);
    expect(isObject([])).toBe(false);
    expect(isObject(null)).toBe(false);
    expect(isObject('x')).toBe(false);
  });
});
