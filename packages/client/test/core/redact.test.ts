import { describe, expect, test } from 'vitest';
import { UserInputError } from '../../src/core/errors';
import { redact } from '../../src/core/redact';

const KEY = 'xo_sk_data_abcd1234_x';

describe('redact', () => {
  test('redact hides keys and secrets', () => {
    expect(
      JSON.stringify(
        redact({
          headers: { Authorization: 'Bearer xo_sk_data_abcd1234_x' },
          secret: 's',
        }),
      ),
    ).not.toMatch(/xo_sk_|"s"/);
  });

  test('replaces the whole value of sensitive keys, case-insensitively', () => {
    const out = redact({
      secret: 'a',
      Passphrase: 'b',
      KEY: 'c',
      privateKey: 'd',
      PRIVATEKEY: 'e',
      Signature: 'f',
      apikey: 'g',
      apiKey: 'h',
      TOKEN: 'i',
      authorization: 'j',
      Authorization: 'k',
    });
    expect(out).toEqual({
      secret: '[redacted]',
      Passphrase: '[redacted]',
      KEY: '[redacted]',
      privateKey: '[redacted]',
      PRIVATEKEY: '[redacted]',
      Signature: '[redacted]',
      apikey: '[redacted]',
      apiKey: '[redacted]',
      TOKEN: '[redacted]',
      authorization: '[redacted]',
      Authorization: '[redacted]',
    });
  });

  test('replaces whole value even when it is an object, array or number', () => {
    expect(
      redact({ token: { a: 1 }, signature: [1, 2], key: 42, secret: null }),
    ).toEqual({
      token: '[redacted]',
      signature: '[redacted]',
      key: '[redacted]',
      secret: '[redacted]',
    });
  });

  test('does not redact keys that merely contain a sensitive word', () => {
    const out = redact({
      keyboard: 'k',
      monkey: 'm',
      tokenCount: 3,
      name: 'n',
    });
    expect(out).toEqual({
      keyboard: 'k',
      monkey: 'm',
      tokenCount: 3,
      name: 'n',
    });
  });

  test('replaces only the matched xo_sk substring in other strings', () => {
    expect(redact({ msg: `Bearer ${KEY} sent` })).toEqual({
      msg: 'Bearer [redacted] sent',
    });
    expect(redact({ msg: `a ${KEY} b ${KEY}` })).toEqual({
      msg: 'a [redacted] b [redacted]',
    });
    expect(redact('no secrets here')).toBe('no secrets here');
    expect(redact(`token=${KEY}`)).toBe('token=[redacted]');
    expect(redact(KEY)).toBe('[redacted]');
  });

  test('recurses through nested objects', () => {
    const out = redact({
      a: { b: { c: { token: 't', note: `see ${KEY}`, ok: 1 } } },
    });
    expect(out).toEqual({
      a: { b: { c: { token: '[redacted]', note: 'see [redacted]', ok: 1 } } },
    });
  });

  test('recurses through arrays', () => {
    const out = redact([{ secret: 's' }, [`k ${KEY}`, 5], 'plain']);
    expect(out).toEqual([
      { secret: '[redacted]' },
      ['k [redacted]', 5],
      'plain',
    ]);
  });

  test('passes primitives through', () => {
    expect(redact(1)).toBe(1);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
    expect(redact(10n)).toBe(10n);
  });

  test('never mutates its input', () => {
    const input = {
      secret: 's',
      nested: { token: 't', msg: KEY },
      list: [{ key: 'k' }, KEY],
    };
    const snapshot = structuredClone(input);
    const out = redact(input) as typeof input;
    expect(input).toEqual(snapshot);
    expect(out).not.toBe(input);
    expect(out.nested).not.toBe(input.nested);
    expect(out.list).not.toBe(input.list);
  });

  test('is cycle-safe for objects', () => {
    const a: Record<string, unknown> = { name: 'a', secret: 's' };
    a.self = a;
    const out = redact(a) as Record<string, unknown>;
    expect(out.name).toBe('a');
    expect(out.secret).toBe('[redacted]');
    expect(out.self).toBe('[Circular]');
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  test('is cycle-safe for arrays and mutual references', () => {
    const arr: unknown[] = [1];
    arr.push(arr);
    expect(() => redact(arr)).not.toThrow();

    const x: Record<string, unknown> = { id: 'x' };
    const y: Record<string, unknown> = { id: 'y', x };
    x.y = y;
    const out = redact(x) as Record<string, unknown>;
    expect(out.id).toBe('x');
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  test('does not treat shared (non-cyclic) references as cycles', () => {
    const shared = { note: KEY };
    const out = redact({ a: shared, b: shared });
    expect(out).toEqual({
      a: { note: '[redacted]' },
      b: { note: '[redacted]' },
    });
  });

  test('handles Headers instances', () => {
    const headers = new Headers({
      Authorization: `Bearer ${KEY}`,
      'X-Api-Key': 'abc',
      'Content-Type': 'application/json',
      'X-Trace': `trace ${KEY}`,
    });
    const out = redact(headers) as Record<string, unknown>;
    expect(out).toEqual({
      authorization: '[redacted]',
      'x-api-key': '[redacted]',
      'content-type': 'application/json',
      'x-trace': 'trace [redacted]',
    });
    expect(JSON.stringify(out)).not.toContain('xo_sk_');
  });

  test('handles Headers nested inside objects', () => {
    const out = redact({
      req: {
        headers: new Headers({ authorization: 'Bearer z', accept: '*/*' }),
      },
    });
    expect(out).toEqual({
      req: { headers: { authorization: '[redacted]', accept: '*/*' } },
    });
  });

  test('handles the XO L1/L2 headers in a Headers instance', () => {
    const headers = new Headers({
      XO_API_KEY: 'k',
      XO_PASSPHRASE: 'p',
      XO_TIMESTAMP: '1700000000',
      XO_SIGNATURE: 'sig',
      XO_ADDRESS: '0x00000000000000000000000000000000000000b2',
    });
    expect(redact(headers)).toEqual({
      xo_api_key: '[redacted]',
      xo_passphrase: '[redacted]',
      xo_timestamp: '1700000000',
      xo_signature: '[redacted]',
      xo_address: '0x00000000000000000000000000000000000000b2',
    });
  });

  test('passes functions through unchanged', () => {
    const fn = () => 1;
    const out = redact({ fn }) as { fn: () => number };
    expect(out.fn).toBe(fn);
  });
});

describe('redact key matching', () => {
  const redactedKeys = [
    // exact matches after lower-casing and removing - and _
    'secret',
    'passphrase',
    'key',
    'KEY',
    'privateKey',
    'private_key',
    'signature',
    'apiKey',
    'api_key',
    'token',
    'authorization',
    'Authorization',
    'cookie',
    'Cookie',
    'Set-Cookie',
    'set_cookie',
    // suffix matches
    'XO_API_KEY',
    'XO_PASSPHRASE',
    'XO_SIGNATURE',
    'x-api-key',
    'X-Api-Key',
    'accessToken',
    'refresh_token',
    'x-auth-token',
    'clientSecret',
    'XO_API_SECRET',
    'Proxy-Authorization',
    'userPassphrase',
    'walletPrivateKey',
  ];
  const visibleKeys = [
    'monkey',
    'keyboard',
    'tokenCount',
    'tokens',
    'XO_TIMESTAMP',
    'XO_ADDRESS',
    'name',
    'secretary',
    'cookies',
    'content-type',
  ];

  test.each(redactedKeys)('redacts the value of key %s', (key) => {
    expect(redact({ [key]: 'value' })).toEqual({ [key]: '[redacted]' });
  });

  test.each(visibleKeys)('keeps the value of key %s', (key) => {
    expect(redact({ [key]: 'value' })).toEqual({ [key]: 'value' });
  });

  test('redacts a whole nested value under a suffix-matched key', () => {
    expect(redact({ accessToken: { a: 1 }, clientSecret: [1, 2] })).toEqual({
      accessToken: '[redacted]',
      clientSecret: '[redacted]',
    });
  });
});

describe('redact non-plain objects', () => {
  test('Error becomes a plain object with a redacted message and stack', () => {
    const err = new Error(`bad key ${KEY} here`);
    const out = redact(err) as Record<string, unknown>;
    expect(out).not.toBeInstanceOf(Error);
    expect(out.name).toBe('Error');
    expect(out.message).toBe('bad key [redacted] here');
    expect(typeof out.stack).toBe('string');
    expect(out.stack as string).not.toContain('xo_sk_');
    expect(out.stack as string).toContain('bad key [redacted] here');
    expect(JSON.stringify(out)).not.toContain('xo_sk_');
  });

  test('Error with a sensitive own prop and a cause chain', () => {
    const root = new Error(`root ${KEY}`);
    const middle = new TypeError('middle', { cause: root });
    const err = Object.assign(new Error('outer', { cause: middle }), {
      token: 't',
      code: 'E_X',
      detail: { apiKey: 'k', note: KEY },
    });
    const out = redact(err) as Record<string, unknown>;
    expect(out.message).toBe('outer');
    expect(out.token).toBe('[redacted]');
    expect(out.code).toBe('E_X');
    expect(out.detail).toEqual({ apiKey: '[redacted]', note: '[redacted]' });

    const cause = out.cause as Record<string, unknown>;
    expect(cause.name).toBe('TypeError');
    expect(cause.message).toBe('middle');
    const rootOut = cause.cause as Record<string, unknown>;
    expect(rootOut.message).toBe('root [redacted]');
    expect(JSON.stringify(out)).not.toContain('xo_sk_');
  });

  test('Error cause may be a non-Error value', () => {
    const err = new Error('x', { cause: { secret: 's', msg: KEY } });
    const out = redact(err) as Record<string, unknown>;
    expect(out.cause).toEqual({ secret: '[redacted]', msg: '[redacted]' });
    expect(redact(new Error('y', { cause: `c ${KEY}` }))).toMatchObject({
      cause: 'c [redacted]',
    });
  });

  test('Error subclasses keep their name', () => {
    class AppError extends Error {
      code = 'APP';
      constructor(message: string) {
        super(message);
        this.name = 'AppError';
      }
    }
    const out = redact(new AppError(`oops ${KEY}`)) as Record<string, unknown>;
    expect(out.name).toBe('AppError');
    expect(out.code).toBe('APP');
    expect(out.message).toBe('oops [redacted]');

    const v = redact(new UserInputError(`bad ${KEY}`)) as Record<
      string,
      unknown
    >;
    expect(v.name).toBe('UserInputError');
    expect(v.message).toBe('bad [redacted]');
  });

  test('Error without a cause has no cause property', () => {
    const out = redact(new Error('plain')) as Record<string, unknown>;
    expect('cause' in out).toBe(false);
  });

  test('Errors nested in objects and arrays are redacted', () => {
    const out = redact({
      error: new Error(`a ${KEY}`),
      list: [new Error(`b ${KEY}`)],
    });
    expect(JSON.stringify(out)).not.toContain('xo_sk_');
    expect(out).toMatchObject({
      error: { message: 'a [redacted]' },
      list: [{ message: 'b [redacted]' }],
    });
  });

  test('Error cause cycles are cut', () => {
    const err = new Error('loop');
    err.cause = err;
    const out = redact(err) as Record<string, unknown>;
    expect(out.cause).toBe('[Circular]');
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  test('does not mutate an Error', () => {
    const err = Object.assign(new Error(`m ${KEY}`), { token: 't' });
    const stack = err.stack;
    redact(err);
    expect(err.message).toBe(`m ${KEY}`);
    expect(err.stack).toBe(stack);
    expect((err as unknown as { token: string }).token).toBe('t');
  });

  test('class instance becomes a plain object of its own props, redacted', () => {
    class Credentials {
      apiKey = 'k';
      label = 'main';
      header = `Bearer ${KEY}`;
      nested = { passphrase: 'p', ok: 1 };
      describe() {
        return this.label;
      }
    }
    const input = new Credentials();
    const out = redact(input) as Record<string, unknown>;
    expect(out).not.toBeInstanceOf(Credentials);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out).toEqual({
      apiKey: '[redacted]',
      label: 'main',
      header: 'Bearer [redacted]',
      nested: { passphrase: '[redacted]', ok: 1 },
    });
    expect(input.apiKey).toBe('k');
  });

  test('Map becomes a plain object of redacted entries', () => {
    const map = new Map<unknown, unknown>([
      ['token', 't'],
      ['note', `n ${KEY}`],
      ['nested', { secret: 's', ok: 1 }],
      [1, 'one'],
    ]);
    const out = redact(map);
    expect(out).not.toBeInstanceOf(Map);
    expect(out).toEqual({
      token: '[redacted]',
      note: 'n [redacted]',
      nested: { secret: '[redacted]', ok: 1 },
      '1': 'one',
    });
    expect(map.get('token')).toBe('t');
    expect(map.size).toBe(4);
  });

  test('Map keys that are not strings go through String(key)', () => {
    const sym = Symbol('s');
    const out = redact(
      new Map<unknown, unknown>([
        [sym, 'a'],
        [true, 'b'],
        [null, 'c'],
      ]),
    );
    expect(out).toEqual({ 'Symbol(s)': 'a', true: 'b', null: 'c' });
  });

  test('Set becomes an array of redacted values', () => {
    const set = new Set<unknown>([KEY, { secret: 's' }, 3, 'plain']);
    const out = redact(set);
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual(['[redacted]', { secret: '[redacted]' }, 3, 'plain']);
    expect(set.size).toBe(4);
    expect(set.has(KEY)).toBe(true);
  });

  test('Map and Set cycles are cut', () => {
    const map = new Map<string, unknown>([['id', 'm']]);
    map.set('self', map);
    expect(redact(map)).toEqual({ id: 'm', self: '[Circular]' });

    const set = new Set<unknown>([1]);
    set.add(set);
    expect(redact(set)).toEqual([1, '[Circular]']);
  });

  test('Date passes through unchanged', () => {
    const date = new Date(0);
    expect(redact(date)).toBe(date);
    const out = redact({ when: date }) as { when: Date };
    expect(out.when).toBe(date);
  });
});
