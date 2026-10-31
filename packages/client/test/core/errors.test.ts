import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  AuthRequiredError,
  isRejected,
  isServerFailure,
  makeErrorGuard,
  PaginationLimitError,
  parseServiceError,
  RateLimitError,
  RequestAbortedError,
  RequestRejectedError,
  SigningError,
  TimeoutError,
  TransactionFailedError,
  TransportError,
  UnexpectedResponseError,
  UserInputError,
  XoError,
} from '../../src/core/errors';
import type { Service } from '../../src/core/types';

const KEY = 'xo_sk_data_abc123_x';

function parse(
  service: Service,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): XoError {
  return parseServiceError({
    service,
    status,
    body,
    headers: new Headers(headers),
  });
}

/** True only for an instance of exactly this class, not of a subclass. */
function isExactly(error: unknown, cls: { prototype: object }): boolean {
  return Object.getPrototypeOf(error) === cls.prototype;
}

describe('XoError classes', () => {
  const cases: Array<{
    name: string;
    code: string;
    make: () => XoError;
    cls: new (...args: never[]) => XoError;
  }> = [
    {
      name: 'UserInputError',
      code: 'invalid_input',
      make: () => new UserInputError('m'),
      cls: UserInputError,
    },
    {
      name: 'AuthRequiredError',
      code: 'auth_required',
      make: () => new AuthRequiredError('m'),
      cls: AuthRequiredError,
    },
    {
      name: 'RequestRejectedError',
      code: 'http_404',
      make: () => new RequestRejectedError('m', { status: 404 }),
      cls: RequestRejectedError,
    },
    {
      name: 'RateLimitError',
      code: 'rate_limited',
      make: () => new RateLimitError('m'),
      cls: RateLimitError,
    },
    {
      name: 'TransportError',
      code: 'transport_error',
      make: () => new TransportError('m'),
      cls: TransportError,
    },
    {
      name: 'TimeoutError',
      code: 'timeout',
      make: () => new TimeoutError('m'),
      cls: TimeoutError,
    },
    {
      name: 'UnexpectedResponseError',
      code: 'unexpected_response',
      make: () => new UnexpectedResponseError('m', { issues: [] }),
      cls: UnexpectedResponseError,
    },
    {
      name: 'RequestAbortedError',
      code: 'request_aborted',
      make: () => new RequestAbortedError('m'),
      cls: RequestAbortedError,
    },
    {
      name: 'PaginationLimitError',
      code: 'pagination_limit',
      make: () => new PaginationLimitError('m'),
      cls: PaginationLimitError,
    },
    {
      name: 'SigningError',
      code: 'signing_failed',
      make: () => new SigningError('m'),
      cls: SigningError,
    },
    {
      name: 'TransactionFailedError',
      code: 'transaction_failed',
      make: () => new TransactionFailedError('m', { mayHaveLanded: false }),
      cls: TransactionFailedError,
    },
  ];

  test('the base class defaults to code xo_error, service sdk and name XoError', () => {
    const e = new XoError('boom');
    expect(e.code).toBe('xo_error');
    expect(e.service).toBe('sdk');
    expect(e.name).toBe('XoError');
    expect(e.message).toBe('boom');
    expect(e.status).toBeUndefined();
    expect(e.requestId).toBeUndefined();
    expect(e.cause).toBeUndefined();
  });

  test.each(cases)(
    '$name has its default code and a fixed name',
    ({ name, code, make }) => {
      const e = make();
      expect(e.name).toBe(name);
      expect(e.code).toBe(code);
      expect(e.service).toBe('sdk');
      expect(e.message).toBe('m');
    },
  );

  test.each(cases)(
    '$name is an instance of its class, XoError and Error',
    ({ make, cls }) => {
      const e = make();
      expect(e).toBeInstanceOf(cls);
      expect(e).toBeInstanceOf(XoError);
      expect(e).toBeInstanceOf(Error);
      for (const other of cases) {
        if (other.cls !== cls) {
          expect(e).not.toBeInstanceOf(other.cls);
        }
      }
    },
  );

  test('the base class is not an instance of any subclass', () => {
    const e = new XoError('m');
    for (const { cls } of cases) {
      expect(e).not.toBeInstanceOf(cls);
    }
  });

  test('options set code, service, status and requestId', () => {
    const e = new RequestRejectedError('m', {
      code: 'order_in_delay_window',
      service: 'orderbook',
      status: 409,
      requestId: 'req-1',
    });
    expect(e.code).toBe('order_in_delay_window');
    expect(e.service).toBe('orderbook');
    expect(e.status).toBe(409);
    expect(e.requestId).toBe('req-1');
  });

  test('an explicit undefined code falls back to the default code', () => {
    expect(new UserInputError('m', { code: undefined }).code).toBe(
      'invalid_input',
    );
    expect(
      new RequestRejectedError('m', { status: 502, code: undefined }).code,
    ).toBe('http_502');
    expect(new XoError('m', { code: undefined }).code).toBe('xo_error');
  });

  test('works with just a message', () => {
    const e = new UserInputError('size must not be negative');
    expect(e.message).toBe('size must not be negative');
    expect(e).toBeInstanceOf(UserInputError);
  });

  test('cause is passed through the standard Error options', () => {
    const cause = new Error('socket hang up');
    const e = new TransportError('request failed', { cause });
    expect(e.cause).toBe(cause);
    expect(Object.hasOwn(e, 'cause')).toBe(true);
    expect(new TransportError('request failed').cause).toBeUndefined();
    expect(Object.hasOwn(new TransportError('x'), 'cause')).toBe(false);
  });

  test('a non-Error cause is passed through unchanged', () => {
    const cause = { reason: 'weird' };
    expect(new XoError('m', { cause }).cause).toBe(cause);
    expect(new XoError('m', { cause: 'text' }).cause).toBe('text');
  });

  test('subclass fields are stored', () => {
    expect(new RateLimitError('m', { retryAfter: 1500 }).retryAfter).toBe(1500);
    expect(new RateLimitError('m').retryAfter).toBeUndefined();
    expect(
      new RequestRejectedError('m', { status: 503, retryAfter: 60_000 })
        .retryAfter,
    ).toBe(60_000);
    expect(
      new RequestRejectedError('m', { status: 503 }).retryAfter,
    ).toBeUndefined();
    expect(new RequestRejectedError('m', { status: 418 }).status).toBe(418);
    const issues = [{ path: ['a'], message: 'bad' }];
    expect(new UnexpectedResponseError('m', { issues }).issues).toBe(issues);
    const landed = new TransactionFailedError('m', {
      mayHaveLanded: true,
      transactionHash: '0xabc',
    });
    expect(landed.mayHaveLanded).toBe(true);
    expect(landed.transactionHash).toBe('0xabc');
    const notLanded = new TransactionFailedError('m', { mayHaveLanded: false });
    expect(notLanded.mayHaveLanded).toBe(false);
    expect(notLanded.transactionHash).toBeUndefined();
  });
});

describe('XoError secrets', () => {
  test('the constructor redacts an API key in the message', () => {
    const e = new XoError(`bad key ${KEY} rejected`);
    expect(e.message).not.toContain('xo_sk_');
    expect(e.message).toBe('bad key [redacted] rejected');
  });

  test('every subclass redacts an API key in the message', () => {
    expect(new UserInputError(`k ${KEY}`).message).not.toContain('xo_sk_');
    expect(
      new RequestRejectedError(`k ${KEY}`, { status: 401 }).message,
    ).not.toContain('xo_sk_');
    expect(new TransportError(`k ${KEY}`).message).not.toContain('xo_sk_');
    expect(
      new TransactionFailedError(`k ${KEY}`, { mayHaveLanded: false }).message,
    ).not.toContain('xo_sk_');
  });

  test('the stack does not carry the key either', () => {
    expect(new XoError(`bad key ${KEY}`).stack ?? '').not.toContain('xo_sk_');
  });

  test('toJSON redacts', () => {
    const e = new XoError(`bad key ${KEY}`, {
      code: 'bad_key',
      service: 'backend',
      status: 401,
      requestId: 'c1',
      cause: new Error(`upstream said Bearer ${KEY}`),
    });
    const json = e.toJSON();
    expect(JSON.stringify(json)).not.toContain('xo_sk_');
    expect(json.message).toBe('bad key [redacted]');
    expect(json.name).toBe('XoError');
    expect(json.code).toBe('bad_key');
    expect(json.service).toBe('backend');
    expect(json.status).toBe(401);
    expect(json.requestId).toBe('c1');
    expect(json.cause).toMatchObject({
      name: 'Error',
      message: 'upstream said Bearer [redacted]',
    });
  });

  test('toJSON redacts a structured cause by key and by content', () => {
    const e = new TransportError('failed', {
      cause: {
        headers: { Authorization: `Bearer ${KEY}` },
        apiKey: 'hunter2',
        note: `see ${KEY}`,
      },
    });
    const text = JSON.stringify(e.toJSON());
    expect(text).not.toContain('xo_sk_');
    expect(text).not.toContain('hunter2');
    expect(text).toContain('[redacted]');
  });

  test('JSON.stringify(error) goes through toJSON', () => {
    const e = new RequestRejectedError(`nope ${KEY}`, {
      code: 'frontend_only',
      status: 403,
    });
    const parsed = JSON.parse(JSON.stringify(e));
    expect(parsed.name).toBe('RequestRejectedError');
    expect(parsed.code).toBe('frontend_only');
    expect(parsed.message).toBe('nope [redacted]');
    expect(JSON.stringify(e)).not.toContain('xo_sk_');
  });

  test('toJSON omits undefined fields', () => {
    const json = new UserInputError('gone').toJSON();
    expect(json).toEqual({
      name: 'UserInputError',
      code: 'invalid_input',
      service: 'sdk',
      message: 'gone',
    });
    expect(Object.keys(json)).not.toContain('status');
    expect(Object.keys(json)).not.toContain('requestId');
    expect(Object.keys(json)).not.toContain('cause');
  });

  test('toJSON includes the subclass fields', () => {
    expect(
      new RateLimitError('slow down', { retryAfter: 1500 }).toJSON(),
    ).toMatchObject({ name: 'RateLimitError', retryAfter: 1500 });
    expect(
      new UnexpectedResponseError('drift', {
        issues: [{ path: ['price'], note: `saw ${KEY}` }],
      }).toJSON(),
    ).toMatchObject({
      name: 'UnexpectedResponseError',
      issues: [{ path: ['price'], note: 'saw [redacted]' }],
    });
    expect(
      new TransactionFailedError('unsure', {
        mayHaveLanded: true,
        transactionHash: '0xabc',
      }).toJSON(),
    ).toMatchObject({
      name: 'TransactionFailedError',
      mayHaveLanded: true,
      transactionHash: '0xabc',
    });
    expect(
      new TransactionFailedError('sure', { mayHaveLanded: false }).toJSON(),
    ).toMatchObject({ mayHaveLanded: false });
    // The nonce is a bigint on the error and a decimal string in JSON (bigints do not stringify).
    const withNonce = new TransactionFailedError('unsure', {
      mayHaveLanded: true,
      nonce: 7n,
    });
    expect(withNonce.nonce).toBe(7n);
    expect(withNonce.toJSON()).toMatchObject({ nonce: '7' });
    expect(JSON.parse(JSON.stringify(withNonce))).toMatchObject({ nonce: '7' });
    expect(
      'nonce' in
        new TransactionFailedError('m', { mayHaveLanded: false }).toJSON(),
    ).toBe(false);
  });

  test('a TransactionFailedError has no userOpHash: an extra option is not kept, and toJSON never shows one', () => {
    const hash = `0x${'5e'.repeat(32)}` as const;
    const legacy = new TransactionFailedError('unsure', {
      mayHaveLanded: true,
      code: 'receipt_timeout',
      transactionHash: hash,
      userOpHash: hash,
    } as ConstructorParameters<typeof TransactionFailedError>[1]);
    expect('userOpHash' in legacy).toBe(false);
    expect('userOpHash' in legacy.toJSON()).toBe(false);
    expect(Object.keys(legacy.toJSON()).sort()).toEqual([
      'code',
      'mayHaveLanded',
      'message',
      'name',
      'service',
      'transactionHash',
    ]);
    const plain = new TransactionFailedError('m', { mayHaveLanded: false });
    expect('userOpHash' in plain).toBe(false);
    expect('userOpHash' in plain.toJSON()).toBe(false);
  });

  test('toJSON includes paymentId when the error has one, next to mayHaveLanded, and leaves it out otherwise', () => {
    const e = new TransactionFailedError('unsure', { mayHaveLanded: true });
    Object.defineProperty(e, 'paymentId', {
      value: 'pay_1',
      enumerable: true,
      configurable: true,
    });
    expect(e.paymentId).toBe('pay_1');
    expect(e.toJSON()).toMatchObject({
      name: 'TransactionFailedError',
      mayHaveLanded: true,
      paymentId: 'pay_1',
    });
    expect(JSON.parse(JSON.stringify(e))).toMatchObject({
      paymentId: 'pay_1',
    });
    expect('paymentId' in new XoError('m').toJSON()).toBe(false);
    expect(new XoError('m').paymentId).toBeUndefined();
  });

  test('toJSON returns a fresh object each time', () => {
    const e = new XoError('m');
    const first = e.toJSON();
    first.message = 'changed';
    expect(e.toJSON().message).toBe('m');
    expect(e.message).toBe('m');
  });

  test('parseServiceError redacts an API key echoed by the server', () => {
    const e = parse('backend', 401, {
      statusCode: 401,
      response: { error: 'unauthorized', message: `bad key ${KEY}` },
    });
    expect(e.message).not.toContain('xo_sk_');
    expect(JSON.stringify(e.toJSON())).not.toContain('xo_sk_');
  });

  test('parseServiceError does not keep the raw body on the error', () => {
    const e = parse('backend', 403, {
      statusCode: 403,
      response: { error: 'frontend_only', message: 'x' },
      internal: 'RAW_BODY_MARKER',
    });
    expect(Object.keys(e)).not.toContain('body');
    expect(JSON.stringify(e)).not.toContain('RAW_BODY_MARKER');
    expect(JSON.stringify(e.toJSON())).not.toContain('RAW_BODY_MARKER');
    for (const value of Object.values(e)) {
      expect(JSON.stringify(value) ?? '').not.toContain('RAW_BODY_MARKER');
    }
  });
});

describe('parseServiceError', () => {
  describe('backend', () => {
    test('backend 4xx nests the code at response.error', () => {
      const e = parseServiceError({
        service: 'backend',
        status: 403,
        body: {
          statusCode: 403,
          response: { error: 'frontend_only', message: 'x' },
        },
        headers: new Headers(),
      });
      expect(isRejected(e, 403)).toBe(true);
      expect(e.code).toBe('frontend_only');
      expect(e.message).toBe('x');
      expect(e.service).toBe('backend');
      expect(e.status).toBe(403);
    });

    test('backend 401 invalid_signature → 401 RequestRejectedError', () => {
      const e = parse('backend', 401, {
        statusCode: 401,
        response: { error: 'invalid_signature', message: 'bad signature' },
      });
      expect(isRejected(e, 401)).toBe(true);
      expect(e.code).toBe('invalid_signature');
      expect(e.message).toBe('bad signature');
      expect(e.status).toBe(401);
    });

    test('backend 409 api_key_limit_reached → 409 RequestRejectedError', () => {
      const e = parse('backend', 409, {
        statusCode: 409,
        response: {
          error: 'api_key_limit_reached',
          message: 'limit reached',
        },
      });
      expect(isRejected(e, 409)).toBe(true);
      expect(e.code).toBe('api_key_limit_reached');
      expect(e.message).toBe('limit reached');
    });

    test('backend 5xx carries correlation id', () => {
      const e = parse('backend', 500, {
        error_type: 'internal',
        correlation_id: 'c1',
      });
      expect(isRejected(e, 500)).toBe(true);
      expect(e.requestId).toBe('c1');
      expect(e.code).toBe('http_500');
      expect(e.message).toBe('backend responded 500');
      expect(e.service).toBe('backend');
      expect(e.status).toBe(500);
    });

    test('backend 429 flat body + Retry-After header', () => {
      const e = parse(
        'backend',
        429,
        { statusCode: 429, message: 'ThrottlerException: Too Many Requests' },
        { 'Retry-After': '3' },
      );
      expect(e).toBeInstanceOf(RateLimitError);
      expect((e as RateLimitError).retryAfter).toBe(3000);
      expect(e.code).toBe('http_429');
      expect(e.message).toBe('ThrottlerException: Too Many Requests');
    });

    test('backend validation 400 joins a message array', () => {
      const e = parse('backend', 400, {
        statusCode: 400,
        message: ['price must be a string', 'size must not be empty'],
        error: 'Bad Request',
      });
      expect(isRejected(e, 400)).toBe(true);
      expect(e.message).toBe('price must be a string; size must not be empty');
      expect(e.code).toBe('http_400');
    });

    test('a message array nested at response.message is joined too', () => {
      const e = parse('backend', 400, {
        statusCode: 400,
        response: {
          error: 'validation_failed',
          message: ['a is required', 'b is required'],
        },
      });
      expect(e.code).toBe('validation_failed');
      expect(e.message).toBe('a is required; b is required');
    });

    test('backend 422 → 422 RequestRejectedError', () => {
      const e = parse('backend', 422, {
        statusCode: 422,
        response: { error: 'unprocessable', message: 'nope' },
      });
      expect(isRejected(e, 422)).toBe(true);
      expect(e.code).toBe('unprocessable');
    });

    test('backend 404 → 404 RequestRejectedError', () => {
      const e = parse('backend', 404, {
        statusCode: 404,
        response: { error: 'market_not_found', message: 'no such market' },
      });
      expect(isRejected(e, 404)).toBe(true);
      expect(e.code).toBe('market_not_found');
    });

    test('an x-correlation-id header is used when the body has none', () => {
      const e = parse(
        'backend',
        500,
        { error_type: 'internal' },
        { 'x-correlation-id': 'hdr-7' },
      );
      expect(e.requestId).toBe('hdr-7');
    });

    test('a body correlation_id wins over the header', () => {
      const e = parse(
        'backend',
        500,
        { error_type: 'internal', correlation_id: 'body-1' },
        { 'x-correlation-id': 'hdr-7' },
      );
      expect(e.requestId).toBe('body-1');
    });

    test('requestId is undefined when neither source has one', () => {
      expect(parse('backend', 500, {}).requestId).toBeUndefined();
    });
  });

  describe('orderbook', () => {
    test('orderbook 429 retry_after_ms', () => {
      const e = parse('orderbook', 429, {
        error: 'rate limit exceeded',
        retry_after_ms: 1500,
      });
      expect(e).toBeInstanceOf(RateLimitError);
      expect((e as RateLimitError).retryAfter).toBe(1500);
      expect(e.service).toBe('orderbook');
      expect(e.code).toBe('http_429');
      expect(e.message).toBe('rate limit exceeded');
    });

    test('retry_after_ms in the body wins over the Retry-After header', () => {
      const e = parse(
        'orderbook',
        429,
        { error: 'rate limit exceeded', retry_after_ms: 1500 },
        { 'Retry-After': '30' },
      );
      expect((e as RateLimitError).retryAfter).toBe(1500);
    });

    test('orderbook 503 trading_paused', () => {
      const e = parse(
        'orderbook',
        503,
        { error: 'trading_paused' },
        { 'Retry-After': '60' },
      );
      expect(isRejected(e, 503)).toBe(true);
      expect((e as RequestRejectedError).retryAfter).toBe(60_000);
      expect(e.code).toBe('trading_paused');
      expect(e.status).toBe(503);
    });

    test('503 with another code is an ordinary rejection', () => {
      const e = parse('orderbook', 503, { error: 'overloaded' });
      expect(isRejected(e, 503)).toBe(true);
      expect(e.code).toBe('overloaded');
    });

    test('trading_paused on a non-503 status keeps its status', () => {
      const e = parse('orderbook', 500, { error: 'trading_paused' });
      expect(isRejected(e, 500)).toBe(true);
      expect(isServerFailure(e)).toBe(true);
      expect(e.code).toBe('trading_paused');
    });

    test('502 and 504 are server failures', () => {
      expect(isServerFailure(parse('orderbook', 502, 'Bad Gateway'))).toBe(
        true,
      );
      expect(isServerFailure(parse('orderbook', 504, undefined))).toBe(true);
    });

    test('orderbook 409 code', () => {
      const e = parse('orderbook', 409, {
        error: 'order_in_delay_window',
        message: 'order is in the delay window',
      });
      expect(isRejected(e, 409)).toBe(true);
      expect(e.code).toBe('order_in_delay_window');
      expect(e.message).toBe('order is in the delay window');
    });

    test('a code-shaped body.error is not repeated as the message', () => {
      const e = parse('orderbook', 409, { error: 'order_in_delay_window' });
      expect(e.code).toBe('order_in_delay_window');
      expect(e.message).toBe('orderbook responded 409');
    });

    test('a 400 from the orderbook → 400 RequestRejectedError', () => {
      const e = parse('orderbook', 400, {
        error: 'invalid_price',
        message: 'price off tick',
      });
      expect(isRejected(e, 400)).toBe(true);
      expect(e.code).toBe('invalid_price');
      expect(e.message).toBe('price off tick');
    });
  });

  describe('sponsor', () => {
    test('sponsor envelope', () => {
      const e = parse('sponsor', 403, {
        error: { code: 'policy_rejected', message: 'not allowed' },
      });
      expect(isRejected(e, 403)).toBe(true);
      expect(e.code).toBe('policy_rejected');
      expect(e.message).toBe('not allowed');
      expect(e.service).toBe('sponsor');
      expect(e.status).toBe(403);
    });

    test('a sponsor envelope without a code falls back to http_<status>', () => {
      const e = parse('sponsor', 400, { error: { message: 'bad request' } });
      expect(isRejected(e, 400)).toBe(true);
      expect(e.code).toBe('http_400');
      expect(e.message).toBe('bad request');
    });
  });

  describe('code and message precedence', () => {
    test('response.error beats body.error and body.error.code', () => {
      const e = parse('backend', 400, {
        response: { error: 'from_response', message: 'r' },
        error: 'from_error',
      });
      expect(e.code).toBe('from_response');
    });

    test('a non-code response.error is skipped for the next candidate', () => {
      const e = parse('backend', 400, {
        response: { error: 'Bad Request', message: 'r' },
        error: 'from_error',
      });
      expect(e.code).toBe('from_error');
    });

    test('codes must be lower snake case', () => {
      for (const bad of ['Bad Request', 'BAD_CODE', '1abc', '_x', 'a-b', '']) {
        expect(parse('orderbook', 400, { error: bad }).code).toBe('http_400');
      }
      expect(parse('orderbook', 400, { error: 'a1_b2' }).code).toBe('a1_b2');
    });

    test('a non-string code is ignored', () => {
      expect(parse('orderbook', 400, { error: 42 }).code).toBe('http_400');
      expect(
        parse('backend', 400, { response: { error: { nested: true } } }).code,
      ).toBe('http_400');
      expect(parse('sponsor', 400, { error: { code: 7 } }).code).toBe(
        'http_400',
      );
    });

    test('response.message beats body.message', () => {
      const e = parse('backend', 400, {
        response: { error: 'e_code', message: 'inner' },
        message: 'outer',
      });
      expect(e.message).toBe('inner');
    });

    test('body.message beats body.error.message', () => {
      const e = parse('sponsor', 400, {
        message: 'outer',
        error: { code: 'c_code', message: 'inner' },
      });
      expect(e.message).toBe('outer');
    });

    test('body.error.message beats a non-code body.error string', () => {
      const e = parse('sponsor', 400, {
        error: { code: 'c_code', message: 'inner' },
      });
      expect(e.message).toBe('inner');
    });

    test('a non-code body.error string is the last message candidate', () => {
      const e = parse('orderbook', 400, { error: 'Something Went Wrong' });
      expect(e.message).toBe('Something Went Wrong');
    });

    test('an empty message falls through to the next candidate', () => {
      const e = parse('backend', 400, {
        response: { error: 'e_code', message: '' },
        message: 'outer',
      });
      expect(e.message).toBe('outer');
    });

    test('the default message names the service and status', () => {
      expect(parse('sponsor', 418, {}).message).toBe('sponsor responded 418');
    });
  });

  describe('Retry-After', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-18T12:00:00.000Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    test('integer seconds become milliseconds', () => {
      const e = parse('backend', 429, {}, { 'Retry-After': '3' });
      expect((e as RateLimitError).retryAfter).toBe(3000);
      expect(
        (parse('backend', 429, {}, { 'Retry-After': '0' }) as RateLimitError)
          .retryAfter,
      ).toBe(0);
    });

    test('an HTTP-date is converted to milliseconds from now', () => {
      const when = new Date(Date.now() + 5000).toUTCString();
      const e = parse('backend', 429, {}, { 'Retry-After': when });
      expect((e as RateLimitError).retryAfter).toBe(5000);
    });

    test('an HTTP-date in the past is clamped to 0', () => {
      const when = new Date(Date.now() - 60_000).toUTCString();
      const e = parse('backend', 429, {}, { 'Retry-After': when });
      expect((e as RateLimitError).retryAfter).toBe(0);
    });

    test('an HTTP-date works for trading_paused too', () => {
      const when = new Date(Date.now() + 90_000).toUTCString();
      const e = parse(
        'orderbook',
        503,
        { error: 'trading_paused' },
        { 'Retry-After': when },
      );
      expect(isRejected(e, 503)).toBe(true);
      expect((e as RequestRejectedError).retryAfter).toBe(90_000);
    });

    test('an unparseable Retry-After is ignored', () => {
      for (const bad of ['soon', '', '1.5', '-3', 'NaN']) {
        const e = parse('backend', 429, {}, { 'Retry-After': bad });
        expect(e).toBeInstanceOf(RateLimitError);
        expect((e as RateLimitError).retryAfter).toBeUndefined();
      }
    });

    test('a Retry-After too large to be finite is ignored', () => {
      const huge = '9'.repeat(400);
      const rateLimited = parse('backend', 429, {}, { 'Retry-After': huge });
      expect(rateLimited).toBeInstanceOf(RateLimitError);
      expect((rateLimited as RateLimitError).retryAfter).toBeUndefined();
      const paused = parse(
        'orderbook',
        503,
        { error: 'trading_paused' },
        { 'Retry-After': huge },
      );
      expect(isRejected(paused, 503)).toBe(true);
      expect((paused as RequestRejectedError).retryAfter).toBeUndefined();
      const down = parse('backend', 503, {}, { 'Retry-After': huge });
      expect(isRejected(down, 503)).toBe(true);
      expect((down as RequestRejectedError).retryAfter).toBeUndefined();
    });

    test('a large but finite Retry-After is kept', () => {
      const e = parse('backend', 429, {}, { 'Retry-After': '99999999999999' });
      expect((e as RateLimitError).retryAfter).toBe(99_999_999_999_999_000);
    });

    test('a 5xx carries retryAfter from the Retry-After header', () => {
      for (const status of [500, 502, 503, 504]) {
        const e = parse('backend', status, {}, { 'Retry-After': '2' });
        expect(isServerFailure(e)).toBe(true);
        expect((e as RequestRejectedError).retryAfter).toBe(2000);
      }
    });

    test('a 5xx carries retryAfter from the body, which wins over the header', () => {
      const e = parse(
        'orderbook',
        503,
        { error: 'overloaded', retry_after_ms: 750 },
        { 'Retry-After': '30' },
      );
      expect(isRejected(e, 503)).toBe(true);
      expect(e.code).toBe('overloaded');
      expect((e as RequestRejectedError).retryAfter).toBe(750);
    });

    test('a 5xx without any retry hint leaves retryAfter undefined', () => {
      const e = parse('backend', 502, 'Bad Gateway');
      expect((e as RequestRejectedError).retryAfter).toBeUndefined();
    });

    test('a 5xx HTTP-date Retry-After is converted to milliseconds', () => {
      const when = new Date(Date.now() + 4000).toUTCString();
      const e = parse('backend', 503, {}, { 'Retry-After': when });
      expect((e as RequestRejectedError).retryAfter).toBe(4000);
    });

    test('a missing Retry-After leaves retryAfter undefined', () => {
      const e = parse('backend', 429, {});
      expect(e).toBeInstanceOf(RateLimitError);
      expect((e as RateLimitError).retryAfter).toBeUndefined();
    });

    test('a non-numeric retry_after_ms falls back to the header', () => {
      const e = parse(
        'orderbook',
        429,
        { error: 'rate limit exceeded', retry_after_ms: '1500' },
        { 'Retry-After': '2' },
      );
      expect((e as RateLimitError).retryAfter).toBe(2000);
    });

    test('a negative retry_after_ms is clamped to 0', () => {
      const e = parse('orderbook', 429, { retry_after_ms: -5 });
      expect((e as RateLimitError).retryAfter).toBe(0);
    });
  });

  describe('status mapping', () => {
    test.each([400, 401, 403, 404, 409, 422, 500, 502, 503, 504, 599])(
      'status %i maps to a RequestRejectedError with that status',
      (status) => {
        const e = parse('backend', status, {});
        expect(isExactly(e, RequestRejectedError)).toBe(true);
        expect((e as RequestRejectedError).status).toBe(status);
        expect(e.status).toBe(status);
        expect(e.service).toBe('backend');
        expect(e.code).toBe(`http_${status}`);
      },
    );

    test('429 maps to a RateLimitError', () => {
      const e = parse('backend', 429, {});
      expect(isExactly(e, RateLimitError)).toBe(true);
      expect(e.status).toBe(429);
      expect(e.code).toBe('http_429');
    });

    test('503 trading_paused is no class of its own', () => {
      const e = parse('backend', 503, { error: 'trading_paused' });
      expect(isExactly(e, RequestRejectedError)).toBe(true);
      expect(e.code).toBe('trading_paused');
    });

    test.each([200, 301, 402, 405, 408, 410, 418, 451])(
      'status %i maps to a RequestRejectedError too',
      (status) => {
        const e = parse('orderbook', status, {});
        expect(isExactly(e, RequestRejectedError)).toBe(true);
        expect(e.status).toBe(status);
        expect(e.code).toBe(`http_${status}`);
      },
    );

    test('isRejected matches the exact status, isServerFailure any 5xx', () => {
      expect(isRejected(parse('backend', 404, {}), 404)).toBe(true);
      expect(isRejected(parse('backend', 404, {}), 403)).toBe(false);
      expect(isRejected(parse('backend', 429, {}), 429)).toBe(false);
      expect(isRejected(new XoError('m', { status: 404 }), 404)).toBe(false);
      expect(isRejected(undefined, 404)).toBe(false);
      expect(isServerFailure(parse('backend', 504, {}))).toBe(true);
      expect(isServerFailure(parse('backend', 499, {}))).toBe(false);
      expect(isServerFailure(parse('backend', 429, {}))).toBe(false);
      expect(isServerFailure(new Error('m'))).toBe(false);
    });

    test('the service is always set from the input', () => {
      for (const service of [
        'backend',
        'orderbook',
        'sponsor',
        'chain',
        'sdk',
      ] as const) {
        expect(parse(service, 500, {}).service).toBe(service);
      }
    });
  });

  describe('unexpected bodies', () => {
    test('unknown body → RequestRejectedError code http_<status>', () => {
      const e = parse('backend', 418, { teapot: true });
      expect(isExactly(e, RequestRejectedError)).toBe(true);
      expect(e.code).toBe('http_418');
      expect(e.status).toBe(418);
      expect(e.service).toBe('backend');
      expect(e.message).toBe('backend responded 418');
    });

    test('an HTML body → http_<status>', () => {
      const e = parse(
        'backend',
        502,
        '<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>',
      );
      expect(isRejected(e, 502)).toBe(true);
      expect(e.code).toBe('http_502');
      expect(e.message).toBe('backend responded 502');
      expect(e.message).not.toContain('<html>');
    });

    test('a plain-text body → http_<status>', () => {
      const e = parse('orderbook', 404, 'not found');
      expect(isRejected(e, 404)).toBe(true);
      expect(e.code).toBe('http_404');
      expect(e.message).toBe('orderbook responded 404');
    });

    test('never throws on odd bodies', () => {
      const bodies: unknown[] = [
        undefined,
        null,
        [],
        ['a', 'b'],
        [{ error: 'x_y' }],
        '',
        'text',
        0,
        42,
        Number.NaN,
        true,
        false,
        {},
        { response: null },
        { response: 'string' },
        { response: [] },
        { error: null },
        { error: [] },
        { error: { code: null, message: null } },
        { message: {} },
        { message: [1, 2, 3] },
        { message: [] },
        { retry_after_ms: Number.NaN },
        { retry_after_ms: Number.POSITIVE_INFINITY },
        { correlation_id: 123 },
        Object.create(null),
        new Map([['error', 'x_y']]),
        () => 'fn',
        Symbol('s'),
        10n,
      ];
      for (const body of bodies) {
        for (const status of [0, 200, 400, 429, 503, 500, 999]) {
          expect(() => parse('backend', status, body)).not.toThrow();
          const e = parse('backend', status, body);
          expect(e).toBeInstanceOf(XoError);
          expect(e.status).toBe(status);
          expect(e.service).toBe('backend');
          expect(typeof e.code).toBe('string');
          expect(typeof e.message).toBe('string');
        }
      }
    });

    test('never throws when reading the body throws', () => {
      const hostile = new Proxy(
        {},
        {
          get() {
            throw new Error('boom');
          },
          has() {
            throw new Error('boom');
          },
          ownKeys() {
            throw new Error('boom');
          },
        },
      );
      const nested = {
        get response(): unknown {
          throw new Error('boom');
        },
        get error(): unknown {
          throw new Error('boom');
        },
      };
      for (const body of [hostile, nested]) {
        const e = parse('backend', 500, body);
        expect(isRejected(e, 500)).toBe(true);
        expect(e.code).toBe('http_500');
      }
    });

    test('never throws when reading the headers throws', () => {
      const headers = {
        get() {
          throw new Error('boom');
        },
      } as unknown as Headers;
      const e = parseServiceError({
        service: 'backend',
        status: 429,
        body: {},
        headers,
      });
      expect(e).toBeInstanceOf(RateLimitError);
    });
  });
});

describe('the rejection classes', () => {
  test.each([
    [400, { error: 'invalid_price', message: 'price off tick' }],
    [401, { error: 'invalid_signature', message: 'bad signature' }],
    [403, { error: 'frontend_only', message: 'x' }],
    [404, { error: 'market_not_found', message: 'no such market' }],
    [409, { error: 'order_in_delay_window', message: 'in the window' }],
    [422, { error: 'unprocessable', message: 'nope' }],
    [500, { error: 'internal_error', message: 'boom' }],
    [502, { error: 'bad_gateway', message: 'upstream' }],
    [503, { error: 'overloaded', message: 'busy' }],
  ])(
    'parseServiceError maps %i to a RequestRejectedError with status and code',
    (status, body) => {
      const e = parse('orderbook', status, body);
      expect(e).toBeInstanceOf(RequestRejectedError);
      expect(isExactly(e, RequestRejectedError)).toBe(true);
      expect((e as RequestRejectedError).status).toBe(status);
      expect((e as RequestRejectedError).code).toBe(body.error);
      expect(e.message).toBe(body.message);
      expect(e.service).toBe('orderbook');
    },
  );

  test('a 404 market_not_found body gives the code and status as named', () => {
    const e = parse('backend', 404, { error: 'market_not_found' });
    expect(e).toBeInstanceOf(RequestRejectedError);
    expect((e as RequestRejectedError).status).toBe(404);
    expect(e.code).toBe('market_not_found');
  });

  test('503 trading_paused is a RequestRejectedError with code trading_paused and retryAfter from retry_after_ms', () => {
    const e = parse('orderbook', 503, {
      error: 'trading_paused',
      retry_after_ms: 60_000,
    });
    expect(isExactly(e, RequestRejectedError)).toBe(true);
    expect(e.code).toBe('trading_paused');
    expect((e as RequestRejectedError).status).toBe(503);
    expect((e as RequestRejectedError).retryAfter).toBe(60_000);
  });

  test('429 is a RateLimitError with retryAfter in milliseconds', () => {
    const fromBody = parse('orderbook', 429, {
      error: 'rate limit exceeded',
      retry_after_ms: 1500,
    });
    expect(isExactly(fromBody, RateLimitError)).toBe(true);
    expect((fromBody as RateLimitError).retryAfter).toBe(1500);
    const fromHeader = parse('backend', 429, {}, { 'Retry-After': '3' });
    expect(fromHeader).toBeInstanceOf(RateLimitError);
    expect((fromHeader as RateLimitError).retryAfter).toBe(3000);
    expect(fromHeader.status).toBe(429);
  });

  test('a RequestRejectedError and a RateLimitError are XoErrors, and not each other', () => {
    const rejected = new RequestRejectedError('m', { status: 400 });
    const limited = new RateLimitError('m');
    expect(rejected).toBeInstanceOf(XoError);
    expect(limited).toBeInstanceOf(XoError);
    expect(rejected).not.toBeInstanceOf(RateLimitError);
    expect(limited).not.toBeInstanceOf(RequestRejectedError);
    expect(rejected.name).toBe('RequestRejectedError');
    expect(rejected.retryAfter).toBeUndefined();
  });

  test('toJSON includes retryAfter and leaves it out when absent', () => {
    expect(
      new RequestRejectedError('paused', {
        status: 503,
        code: 'trading_paused',
        retryAfter: 60_000,
      }).toJSON(),
    ).toMatchObject({
      name: 'RequestRejectedError',
      code: 'trading_paused',
      status: 503,
      retryAfter: 60_000,
    });
    expect(
      'retryAfter' in new RequestRejectedError('m', { status: 404 }).toJSON(),
    ).toBe(false);
    expect(new RateLimitError('m', { retryAfter: 9 }).toJSON()).toMatchObject({
      name: 'RateLimitError',
      retryAfter: 9,
    });
  });
});

describe('the local classes', () => {
  test('a UserInputError is local input and carries code invalid_input', () => {
    const e = new UserInputError('size must not be negative');
    expect(e.code).toBe('invalid_input');
    expect(e.name).toBe('UserInputError');
    expect(e.service).toBe('sdk');
    expect(e.status).toBeUndefined();
    expect(e).toBeInstanceOf(XoError);
  });

  test('a RequestAbortedError says the caller aborted', () => {
    const e = new RequestAbortedError('aborted');
    expect(e.code).toBe('request_aborted');
    expect(e.name).toBe('RequestAbortedError');
    expect(e).toBeInstanceOf(XoError);
    expect(e).not.toBeInstanceOf(TimeoutError);
  });

  test('a PaginationLimitError has a default code and keeps the one it is given', () => {
    const e = new PaginationLimitError('past the depth cap', {
      code: 'custom_limit',
    });
    expect(e.code).toBe('custom_limit');
    expect(e.name).toBe('PaginationLimitError');
    expect(e).toBeInstanceOf(XoError);
    expect(new PaginationLimitError('m').code).toBe('pagination_limit');
  });
});

describe('makeErrorGuard', () => {
  const guard = makeErrorGuard(RateLimitError, TimeoutError);

  test('isError is true for an instance of any listed class', () => {
    expect(guard.isError(new TimeoutError('t'))).toBe(true);
    expect(guard.isError(new RateLimitError('r'))).toBe(true);
  });

  test('isError is false for another XoError, a plain Error and a non-error', () => {
    expect(guard.isError(new UserInputError('u'))).toBe(false);
    expect(guard.isError(new XoError('x'))).toBe(false);
    expect(guard.isError(new Error())).toBe(false);
    expect(guard.isError(undefined)).toBe(false);
    expect(guard.isError('timeout')).toBe(false);
  });

  test('isError narrows to the union of the instances', () => {
    const caught: unknown = new RateLimitError('r', { retryAfter: 5 });
    if (guard.isError(caught)) {
      const narrowed: RateLimitError | TimeoutError = caught;
      expect(narrowed).toBe(caught);
    } else {
      throw new Error('expected the guard to accept a RateLimitError');
    }
  });
});

describe('TransactionFailedError', () => {
  test('keeps mayHaveLanded and transactionHash', () => {
    const hash = `0x${'ab'.repeat(32)}` as const;
    const e = new TransactionFailedError('unsure', {
      mayHaveLanded: true,
      transactionHash: hash,
      nonce: 7n,
    });
    expect(e.mayHaveLanded).toBe(true);
    expect(e.transactionHash).toBe(hash);
    expect(e.nonce).toBe(7n);
    expect(e.name).toBe('TransactionFailedError');
    expect(e.code).toBe('transaction_failed');
    expect(e.toJSON()).toMatchObject({
      name: 'TransactionFailedError',
      mayHaveLanded: true,
      transactionHash: hash,
      nonce: '7',
    });
    expect('txHash' in e).toBe(false);
  });
});
