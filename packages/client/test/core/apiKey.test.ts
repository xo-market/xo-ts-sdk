import { describe, expect, test } from 'vitest';
import {
  BACKEND_KEY_PATTERN,
  HEADER_VALUE_PATTERN,
  isBackendKey,
  isHeaderValue,
} from '../../src/core/apiKey';

describe('isBackendKey', () => {
  test.each(['xo_sk_data_abcd1234_0123456789abcdef', 'xo_sk_x', 'xo_sk_!~'])(
    '%j is a backend key',
    (key) => {
      expect(isBackendKey(key)).toBe(true);
      expect(BACKEND_KEY_PATTERN.test(key)).toBe(true);
    },
  );

  test.each([
    ['empty', ''],
    ['only the prefix', 'xo_sk_'],
    ['another prefix', 'sk_live_abcdef'],
    ['upper-case prefix', 'XO_SK_data_abc'],
    ['leading space', ' xo_sk_data_abc'],
    ['trailing space', 'xo_sk_data_abc '],
    ['inner space', 'xo_sk_data abc'],
    ['newline', 'xo_sk_data_abc\n'],
    ['tab', 'xo_sk_data_\tabc'],
    ['NUL', 'xo_sk_data_\u0000abc'],
    ['DEL', 'xo_sk_data_\u007fabc'],
    ['non-ASCII', 'xo_sk_data_éabc'],
    ['a number', 12345],
    ['null', null],
    ['undefined', undefined],
    ['an object', { key: 'xo_sk_data_abc' }],
  ])('%s is not a backend key', (_label, value) => {
    expect(isBackendKey(value)).toBe(false);
  });
});

describe('isHeaderValue', () => {
  test.each([
    ['one character', 'a'],
    ['the whole visible range', '!~'],
    ['a UUID', '3f9c1c2e-8f0a-4b7e-9d7a-0a1b2c3d4e5f'],
    ['256 characters', 'x'.repeat(256)],
  ])('%s is a header value', (_label, value) => {
    expect(isHeaderValue(value)).toBe(true);
    expect(HEADER_VALUE_PATTERN.test(value)).toBe(true);
  });

  test.each([
    ['empty', ''],
    ['257 characters', 'x'.repeat(257)],
    ['a space', 'ab cd'],
    ['a leading space', ' abcd'],
    ['a trailing newline', 'abcd\n'],
    ['a carriage return', 'ab\rcd'],
    ['a tab', 'ab\tcd'],
    ['a NUL', 'ab\u0000cd'],
    ['a DEL', 'ab\u007fcd'],
    ['non-ASCII', 'a\u00e9b'],
    ['a number', 12345],
    ['null', null],
    ['undefined', undefined],
    ['an object', { toString: () => 'abc' }],
  ])('%s is not a header value', (_label, value) => {
    expect(isHeaderValue(value)).toBe(false);
  });
});
