import { afterEach, describe, expect, test, vi } from 'vitest';
import { UserInputError } from '../../src/core/errors';
import {
  hmacSignature,
  l2Headers,
  type OrderbookCredential,
} from '../../src/signing/hmac';
import { expectInvalidAsync, hmacVector } from './helpers';

const { inputs, cases, alphabetCase, utf8Case } = hmacVector;
const POST_ORDER = cases[0];
const GET_ORDERS = cases[1];

// Distinctive strings, so that a leak is found by searching for any 6-character window.
const LEAKY_PASSPHRASE = 'pAss-Phr4se-Zq9Xv7';
const LEAKY_API_KEY = 'xo_sk_test_Kd82Lm41Qw';

/** True when any 6-character window of `secret` appears in `haystack`. */
function leaks(haystack: string, secret: string): boolean {
  for (let i = 0; i + 6 <= secret.length; i++) {
    if (haystack.includes(secret.slice(i, i + 6))) {
      return true;
    }
  }
  return false;
}

/** The error's message, JSON form and stack must contain nothing of the secrets. */
function expectNoLeak(error: Error, ...secrets: string[]): void {
  const surfaces = [error.message, JSON.stringify(error), error.stack ?? ''];
  for (const secret of secrets) {
    for (const surface of surfaces) {
      expect(leaks(surface, secret)).toBe(false);
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('hmacSignature vectors', () => {
  test('the vector has the two expected cases', () => {
    expect(POST_ORDER?.method).toBe('POST');
    expect(GET_ORDERS?.method).toBe('GET');
    expect(GET_ORDERS?.body).toBe('');
  });

  test.each(cases)('matches the vector: $name', async (c) => {
    const signature = await hmacSignature(
      inputs.secret,
      inputs.timestamp,
      c.method,
      c.path,
      c.body,
    );
    expect(signature).toBe(c.expectedSignature);
  });

  test('keeps the = padding and uses the URL-safe alphabet', async () => {
    const signature = await hmacSignature(
      inputs.secret,
      inputs.timestamp,
      'POST',
      '/order',
      '{"orderType":"GTC"}',
    );
    // The standard-base64 form of this digest has a "/" where the URL-safe form has "_".
    expect(signature).toContain('_');
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}=$/);
    expect(signature).not.toMatch(/[+/]/);
  });

  test('a lower-case method signs the same as the upper-case one', async () => {
    const signature = await hmacSignature(
      inputs.secret,
      inputs.timestamp,
      'post',
      '/order',
      '{"orderType":"GTC"}',
    );
    expect(signature).toBe(POST_ORDER?.expectedSignature);
    expect(
      await hmacSignature(
        inputs.secret,
        inputs.timestamp,
        'Get',
        '/data/orders',
        '',
      ),
    ).toBe(GET_ORDERS?.expectedSignature);
  });
});

describe('secret decoding', () => {
  const { secrets, timestamp, method, path, body, expectedSignature } =
    alphabetCase;

  test.each(Object.entries(secrets))(
    'the secret as %s gives the same signature',
    async (_name, secret) => {
      expect(await hmacSignature(secret, timestamp, method, path, body)).toBe(
        expectedSignature,
      );
    },
  );

  test('the vector secret without its padding gives the vector signature', async () => {
    const unpadded = inputs.secret.replace(/=+$/, '');
    expect(unpadded).not.toBe(inputs.secret);
    expect(
      await hmacSignature(
        unpadded,
        inputs.timestamp,
        'GET',
        '/data/orders',
        '',
      ),
    ).toBe(GET_ORDERS?.expectedSignature);
  });

  test.each([
    [
      'a "-" for the first "+" and a "/"',
      '-/iw+uIdFUzDwPiiqmVdFIuIwGpyraXcU1AIUjr17aQ=',
    ],
    [
      'a "+" for the first "-" and a "_"',
      '+_iw-uIdFUzDwPiiqmVdFIuIwGpyraXcU1AIUjr17aQ=',
    ],
    [
      'mixed alphabets and no padding',
      '-/iw+uIdFUzDwPiiqmVdFIuIwGpyraXcU1AIUjr17aQ',
    ],
  ])(
    'a secret that mixes the alphabets decodes like the pure ones: %s',
    async (_name, secret) => {
      // + and - are the same digit, and so are / and _, so a mix is unambiguous. It is
      // accepted on purpose (see the decoder's comment).
      expect(secret).not.toBe(secrets.standardPadded);
      expect(secret).not.toBe(secrets.urlSafePadded);
      expect(await hmacSignature(secret, timestamp, method, path, body)).toBe(
        expectedSignature,
      );
    },
  );

  // Each secret is unusual enough that a 6-character window cannot appear in a message
  // by chance.
  const BAD_SECRETS: Array<[string, string]> = [
    ['a space', 'Zq9Xv7Lm2Pw4 Rk8Tn5YbAQIDBAUGBwgJCgsMDQ4='],
    ['a dot', 'Zq9Xv7Lm2Pw4.Rk8Tn5YbAQIDBAUGBwgJCgsMDQ4='],
    ['a star', 'Zq9Xv7Lm2Pw4*Rk8Tn5YbAQIDBAUGBwgJCgsMDQ4='],
    ['a trailing newline', 'Zq9Xv7Lm2Pw4Rk8Tn5YbAQIDBAUGBwgJCgsMDQ4=\n'],
    ['a leading space', ' Zq9Xv7Lm2Pw4Rk8Tn5YbAQIDBAUGBwgJCgsMDQ4='],
    ['a tab', 'Zq9Xv7Lm2Pw4\tRk8Tn5YbAQIDBAUGBwgJCgsMDQ4='],
    ['a non-ASCII letter', 'Zq9Xv7Lm2Pw4éRk8Tn5YbAQIDBAUGBwgJCgsMDQ4='],
    ['a comma', 'Zq9Xv7Lm2Pw4,Rk8Tn5YbAQIDBAUGBwgJCgsMDQ4='],
    ['padding in the middle', 'Zq9Xv7Lm2Pw4=Rk8Tn5YbAQIDBAUGBwgJCgsMDQ4='],
    ['three padding characters', 'Zq9Xv7Lm2Pw4Rk8Tn5YbAQIDBAUGBwgJCgsMD==='],
    [
      'padding that does not fit the length',
      'Zq9Xv7Lm2Pw4Rk8Tn5YbAQIDBAUGBwgJCgsMDQ4==',
    ],
    [
      'padding on an impossible length',
      'Zq9Xv7Lm2Pw4Rk8Tn5YbAQIDBAUGBwgJCgsMD=',
    ],
    // 41 characters: len % 4 === 1, which no byte string encodes to.
    ['an impossible length', 'Zq9Xv7Lm2Pw4Rk8Tn5YbAQIDBAUGBwgJCgsMDQ4QR'],
    ['an impossible length of 1', 'Z'],
    ['an empty secret', ''],
  ];

  test('the bad secrets differ from a valid one only by the fault named', async () => {
    // The base of every bad secret above is itself a valid secret.
    const control = 'Zq9Xv7Lm2Pw4Rk8Tn5YbAQIDBAUGBwgJCgsMDQ4=';
    await expect(
      hmacSignature(control, '1700000000', 'GET', '/data/orders', ''),
    ).resolves.toMatch(/=$/);
    await expect(
      hmacSignature(control.slice(0, -1), '1700000000', 'GET', '/', ''),
    ).resolves.toMatch(/=$/);
  });

  test.each(BAD_SECRETS)('rejects a secret with %s', async (_name, secret) => {
    const error = await expectInvalidAsync(
      () => hmacSignature(secret, '1700000000', 'GET', '/data/orders', ''),
      'secret',
    );
    expect(error.code).toBe('invalid_input');
    expectNoLeak(error, secret);
  });

  test('the message says that whitespace and newlines are not trimmed', async () => {
    const error = await expectInvalidAsync(
      () =>
        hmacSignature(
          'Zq9Xv7Lm2Pw4Rk8Tn5YbAQIDBAUGBwgJCgsMDQ4=\n',
          '1700000000',
          'GET',
          '/data/orders',
          '',
        ),
      'secret',
    );
    expect(error.message).toMatch(/whitespace and newlines are not trimmed/i);
  });

  test.each([
    ['undefined', undefined],
    ['a number', 12345],
    ['null', null],
    ['a Uint8Array', new Uint8Array(32)],
  ])('rejects a secret that is %s', async (_name, secret) => {
    await expectInvalidAsync(
      () =>
        hmacSignature(
          secret as unknown as string,
          '1700000000',
          'GET',
          '/data/orders',
          '',
        ),
      'secret',
    );
  });

  test('a bad secret does not make the error carry a cause that holds the secret', async () => {
    const secret = BAD_SECRETS[0]?.[1] ?? '';
    const error = await expectInvalidAsync(
      () => hmacSignature(secret, '1700000000', 'GET', '/data/orders', ''),
      'secret',
    );
    expect(error.cause).toBeUndefined();
  });
});

describe('key handling', () => {
  const sign = () =>
    hmacSignature(
      inputs.secret,
      inputs.timestamp,
      'POST',
      '/order',
      '{"orderType":"GTC"}',
    );

  test('imports the key as non-extractable, for signing only', async () => {
    const spy = vi.spyOn(crypto.subtle, 'importKey');
    await sign();
    expect(spy).toHaveBeenCalledTimes(1);
    const [format, , algorithm, extractable, usages] = spy.mock.calls[0] ?? [];
    expect(format).toBe('raw');
    expect(algorithm).toEqual({ name: 'HMAC', hash: 'SHA-256' });
    expect(extractable).toBe(false);
    expect(usages).toEqual(['sign']);
  });

  test('zeroes the decoded key bytes once they are imported', async () => {
    const spy = vi.spyOn(crypto.subtle, 'importKey');
    // The call goes through, so the signature is still the vector's.
    expect(await sign()).toBe(POST_ORDER?.expectedSignature);
    const bytes = spy.mock.calls[0]?.[1] as Uint8Array;
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(32);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  test('zeroes the decoded key bytes when the import fails', async () => {
    const spy = vi
      .spyOn(crypto.subtle, 'importKey')
      .mockRejectedValueOnce(new Error('import failed'));
    await expect(sign()).rejects.toThrow('import failed');
    const bytes = spy.mock.calls[0]?.[1] as Uint8Array;
    expect(bytes.length).toBe(32);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  test('the importKey spies are restored after each test', () => {
    expect(vi.isMockFunction(crypto.subtle.importKey)).toBe(false);
  });
});

describe('hmacSignature validation', () => {
  const sign = (
    over: Partial<{
      secret: string;
      timestamp: string;
      method: string;
      path: string;
      body: string;
    }> = {},
  ) => {
    const p = {
      secret: inputs.secret,
      timestamp: inputs.timestamp,
      method: 'GET',
      path: '/data/orders',
      body: '',
      ...over,
    };
    return hmacSignature(p.secret, p.timestamp, p.method, p.path, p.body);
  };

  test.each([
    ['empty', ''],
    ['no leading slash', 'data/orders'],
    ['a full URL', 'https://clob.example/data/orders'],
    ['a query string', '/data/orders?market=0xabc&next_cursor=MA=='],
    ['a bare question mark', '/data/orders?'],
    ['a fragment', '/data/orders#top'],
    ['a query after a fragment', '/data/orders#top?x=1'],
  ])('rejects a path that is %s', async (_name, path) => {
    const error = await expectInvalidAsync(() => sign({ path }), 'path');
    // The path, and so the query, is never echoed.
    expect(error.message).not.toContain('market');
    expect(error.message).not.toContain('0xabc');
    expect(error.message).not.toContain('next_cursor');
    expect(error.message).not.toContain('top');
    expect(error.message).not.toContain('example');
  });

  test('accepts a path with a trailing slash and encoded characters', async () => {
    await expect(sign({ path: '/data/orders/' })).resolves.toMatch(/=$/);
    await expect(sign({ path: '/market/a%2Fb/book' })).resolves.toMatch(/=$/);
  });

  test.each([
    ['empty', ''],
    ['a decimal', '1700000000.5'],
    ['negative', '-1700000000'],
    ['an exponent', '17e8'],
    ['padded with a space', ' 1700000000'],
    ['trailing newline', '1700000000\n'],
    ['hex', '0x65'],
    ['full-width digits', '１７００００００００'],
  ])('rejects a timestamp that is %s', async (_name, timestamp) => {
    await expectInvalidAsync(() => sign({ timestamp }), 'timestamp');
  });

  test('rejects a timestamp that is not a string', async () => {
    await expectInvalidAsync(
      () => sign({ timestamp: 1700000000 as unknown as string }),
      'timestamp',
    );
  });

  test.each([
    ['empty', ''],
    ['a number', 7],
    ['undefined', undefined],
  ])('rejects a method that is %s', async (_name, method) => {
    await expectInvalidAsync(
      () => sign({ method: method as unknown as string }),
      'method',
    );
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['an object', {}],
  ])('rejects a body that is %s', async (_name, body) => {
    await expectInvalidAsync(
      () => sign({ body: body as unknown as string }),
      'body',
    );
  });

  test('signs a non-ASCII body as UTF-8, not Latin-1 (vector)', async () => {
    const { secret, timestamp, method, path, body } = utf8Case;
    // The body holds U+00E9: two bytes in UTF-8 and one byte in Latin-1.
    expect(body).toContain('\u00e9');
    const signature = await hmacSignature(
      secret,
      timestamp,
      method,
      path,
      body,
    );
    expect(signature).toBe(utf8Case.expectedSignature);
    expect(signature).not.toBe(utf8Case.latin1WrongSignature);
  });

  test('the body is signed exactly as given, with no trimming', async () => {
    const plain = await sign({ method: 'POST', body: '{}' });
    const spaced = await sign({ method: 'POST', body: '{} ' });
    expect(plain).not.toBe(spaced);
  });
});

describe('l2Headers', () => {
  const cred: OrderbookCredential = {
    apiKey: LEAKY_API_KEY,
    secret: inputs.secret,
    passphrase: LEAKY_PASSPHRASE,
  };

  test('returns exactly the four L2 headers', async () => {
    const headers = await l2Headers(
      cred,
      inputs.timestamp,
      'POST',
      '/order',
      '{"orderType":"GTC"}',
    );
    expect(Object.keys(headers).sort()).toEqual([
      'XO_API_KEY',
      'XO_PASSPHRASE',
      'XO_SIGNATURE',
      'XO_TIMESTAMP',
    ]);
    expect(headers).toEqual({
      XO_API_KEY: LEAKY_API_KEY,
      XO_PASSPHRASE: LEAKY_PASSPHRASE,
      XO_TIMESTAMP: '1700000000',
      XO_SIGNATURE: POST_ORDER?.expectedSignature,
    });
  });

  test('XO_SIGNATURE equals hmacSignature for the same inputs', async () => {
    const headers = await l2Headers(
      cred,
      inputs.timestamp,
      'get',
      '/data/orders',
      '',
    );
    expect(headers.XO_SIGNATURE).toBe(
      await hmacSignature(
        inputs.secret,
        inputs.timestamp,
        'GET',
        '/data/orders',
        '',
      ),
    );
  });

  test('never sends the secret in a header', async () => {
    const headers = await l2Headers(
      cred,
      inputs.timestamp,
      'GET',
      '/data/orders',
      '',
    );
    expect(Object.values(headers)).not.toContain(inputs.secret);
  });

  test('a bad secret fails locally, without the secret or the passphrase in the error', async () => {
    const secret = 'Zq9Xv7Lm2Pw4*Rk8Tn5YbAQIDBAUGBwgJCgsMDQ4=';
    const error = await expectInvalidAsync(
      () =>
        l2Headers(
          { ...cred, secret },
          inputs.timestamp,
          'GET',
          '/data/orders',
          '',
        ),
      'secret',
    );
    expectNoLeak(error, secret, LEAKY_PASSPHRASE, LEAKY_API_KEY);
  });

  test('a bad path or timestamp does not put the credentials in the error', async () => {
    const path = await expectInvalidAsync(
      () => l2Headers(cred, inputs.timestamp, 'GET', '/data/orders?x=1', ''),
      'path',
    );
    expectNoLeak(path, inputs.secret, LEAKY_PASSPHRASE, LEAKY_API_KEY);
    const timestamp = await expectInvalidAsync(
      () => l2Headers(cred, 'now', 'GET', '/data/orders', ''),
      'timestamp',
    );
    expectNoLeak(timestamp, inputs.secret, LEAKY_PASSPHRASE, LEAKY_API_KEY);
  });

  test.each([
    ['apiKey', { apiKey: '' }],
    ['apiKey', { apiKey: undefined }],
    ['apiKey', { apiKey: 42 }],
    ['passphrase', { passphrase: '' }],
    ['passphrase', { passphrase: undefined }],
    ['passphrase', { passphrase: null }],
    ['secret', { secret: '' }],
    ['secret', { secret: undefined }],
  ])('rejects a credential with a bad %s', async (field, over) => {
    const error = await expectInvalidAsync(
      () =>
        l2Headers(
          { ...cred, ...over } as OrderbookCredential,
          inputs.timestamp,
          'GET',
          '/data/orders',
          '',
        ),
      field,
    );
    expectNoLeak(error, inputs.secret, LEAKY_PASSPHRASE, LEAKY_API_KEY);
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'xo_sk_abc'],
  ])('rejects a credential that is %s', async (_name, value) => {
    const error = await expectInvalidAsync(
      () =>
        l2Headers(
          value as unknown as OrderbookCredential,
          inputs.timestamp,
          'GET',
          '/data/orders',
          '',
        ),
      'credential',
    );
    expect(error).toBeInstanceOf(UserInputError);
  });

  test('never logs, on success or on failure', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
      (level) => vi.spyOn(console, level).mockImplementation(() => {}),
    );
    await l2Headers(cred, inputs.timestamp, 'GET', '/data/orders', '');
    await expect(
      l2Headers(
        { ...cred, secret: 'not base64!' },
        inputs.timestamp,
        'GET',
        '/data/orders',
        '',
      ),
    ).rejects.toBeInstanceOf(UserInputError);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
