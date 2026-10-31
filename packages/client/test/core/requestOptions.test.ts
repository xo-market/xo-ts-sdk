import { describe, expect, test } from 'vitest';
import { UserInputError } from '../../src/core/errors';
import {
  type CallOptions,
  parseRequestOptions,
  type RequestOptions,
} from '../../src/core/requestOptions';

function refusal(input: unknown): UserInputError {
  try {
    parseRequestOptions(input as RequestOptions);
  } catch (error) {
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).code).toBe('invalid_request_options');
    return error as UserInputError;
  }
  throw new Error('expected the options to be refused');
}

describe('parseRequestOptions', () => {
  test('defaults: a 30 s timeout per attempt and 2 retries', () => {
    const expected: CallOptions = { timeoutMs: 30_000, retries: 2 };
    expect(parseRequestOptions()).toEqual(expected);
    expect(parseRequestOptions({})).toEqual(expected);
    expect(parseRequestOptions().signal).toBeUndefined();
  });

  test('keys set to undefined count as left out', () => {
    expect(
      parseRequestOptions({
        signal: undefined,
        timeout: undefined,
        retries: undefined,
      }),
    ).toEqual({ timeoutMs: 30_000, retries: 2 });
  });

  test('retries from 0 to 5 are kept', () => {
    for (const retries of [0, 1, 2, 3, 4, 5]) {
      expect(parseRequestOptions({ retries }).retries).toBe(retries);
    }
  });

  test.each([6, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '2', null])(
    'retries: %s is refused with invalid_request_options',
    (retries) => {
      expect(refusal({ retries }).message).toContain('retries');
    },
  );

  test('a timeout in whole milliseconds is kept', () => {
    expect(parseRequestOptions({ timeout: 1 }).timeoutMs).toBe(1);
    expect(parseRequestOptions({ timeout: 5_000 }).timeoutMs).toBe(5_000);
    expect(parseRequestOptions({ timeout: 2 ** 31 - 1 }).timeoutMs).toBe(
      2 ** 31 - 1,
    );
  });

  test('timeout: false disables the timeout', () => {
    expect(parseRequestOptions({ timeout: false })).toEqual({
      timeoutMs: false,
      retries: 2,
    });
  });

  test.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2 ** 31,
    true,
    '100',
  ])('timeout: %s is refused with invalid_request_options', (timeout) => {
    expect(refusal({ timeout }).message).toContain('timeout');
  });

  test('the signal is passed on as it is', () => {
    const controller = new AbortController();
    const call = parseRequestOptions({ signal: controller.signal, retries: 0 });
    expect(call.signal).toBe(controller.signal);
    expect(call).toEqual({
      signal: controller.signal,
      timeoutMs: 30_000,
      retries: 0,
    });
  });

  test('a signal that is not an AbortSignal is refused', () => {
    expect(refusal({ signal: { aborted: false } }).message).toContain('signal');
  });

  test('an unknown key is refused, so a typo is not ignored', () => {
    expect(refusal({ retry: 3 }).message).toContain('retry');
    expect(refusal({ timeoutMs: 100 }).message).toContain('timeoutMs');
  });

  test.each([null, 5, 'fast', [1]])(
    'options that are not an object (%s) are refused',
    (input) => {
      refusal(input);
    },
  );

  test('a refusal never quotes the value it refused', () => {
    expect(refusal({ retries: 'xo_sk_secret' }).message).not.toContain(
      'xo_sk_secret',
    );
    expect(refusal({ timeout: 'xo_sk_secret' }).message).not.toContain(
      'xo_sk_secret',
    );
  });
});
