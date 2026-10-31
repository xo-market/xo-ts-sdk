import { inspect } from 'node:util';
import { delay, HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import type { EnvironmentConfig } from '../../src/core/env';
import {
  AuthRequiredError,
  RateLimitError,
  RequestAbortedError,
  RequestRejectedError,
  TimeoutError,
  TransportError,
  UnexpectedResponseError,
  UserInputError,
  XoError,
} from '../../src/core/errors';
import {
  type CallOptions,
  parseRequestOptions,
} from '../../src/core/requestOptions';
import { backoffMs } from '../../src/core/retry';
import {
  type AuthProvider,
  type InternalTransportRequest,
  type RateLimitUpdate,
  Transport,
  type TransportRequest,
  wasNotSent,
} from '../../src/core/transport';
import {
  rejectedWith,
  serverFailure,
  tradingPaused,
} from '../helpers/rejections';
import { testEnv } from '../helpers/testEnv';

const env = testEnv;
const BACKEND = env.backendUrl;
const ORDERBOOK = env.orderbookUrl;
const SPONSOR = env.sponsorUrl as string;

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Method = 'get' | 'head' | 'post' | 'put' | 'patch' | 'delete';

interface Hit {
  url: URL;
  method: string;
  headers: Headers;
  body: string;
}

type Reply = () => Response | Promise<Response>;

/**
 * Serves `replies` in order for one route (the last one repeats) and records every
 * request. Returns the live list of hits.
 */
function serve(method: Method, url: string, ...replies: Reply[]): Hit[] {
  const hits: Hit[] = [];
  server.use(
    http[method](url, async ({ request }) => {
      hits.push({
        url: new URL(request.url),
        method: request.method,
        headers: request.headers,
        body: await request.text(),
      });
      const reply = replies[Math.min(hits.length, replies.length) - 1];
      if (reply === undefined) {
        throw new Error('serve() needs at least one reply');
      }
      return reply();
    }),
  );
  return hits;
}

const ok =
  (body: unknown = { ok: true }): Reply =>
  () =>
    HttpResponse.json(body as Record<string, unknown>);

const fail =
  (
    status: number,
    body: unknown = { error: 'boom' },
    headers: Record<string, string> = {},
  ): Reply =>
  () =>
    HttpResponse.json(body as Record<string, unknown>, { status, headers });

const networkError: Reply = () => HttpResponse.error();
const hang: Reply = () => delay('infinite').then(() => HttpResponse.json({}));

const encoder = new TextEncoder();

interface FakeFetch {
  fetch: typeof fetch;
  /** Every init the transport passed, one per attempt. */
  inits: RequestInit[];
}

/**
 * A fetch that returns a response head at once and a body built by `makeBody`. It lets
 * a test fail or stall the body read, which msw cannot do.
 */
function fakeFetch(
  makeBody: (signal: AbortSignal) => ReadableStream<Uint8Array>,
  status = 200,
): FakeFetch {
  const inits: RequestInit[] = [];
  const fakeFetchFn = async (
    _input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    inits.push(init ?? {});
    const signal = init?.signal as AbortSignal;
    return new Response(makeBody(signal), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fakeFetchFn as typeof fetch, inits };
}

/** A body whose connection drops after the response head. */
const droppedBody = (): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new TypeError('terminated'));
    },
  });

/** A body that sends one chunk and then stalls until the request is aborted. */
const stalledBody = (signal: AbortSignal): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('{"a":'));
      signal.addEventListener('abort', () => controller.error(signal.reason), {
        once: true,
      });
    },
  });

function makeTransport(
  overrides: Partial<ConstructorParameters<typeof Transport>[0]> = {},
): Transport {
  return new Transport({ env, version: '9.9.9', ...overrides });
}

interface AuthStub extends AuthProvider {
  headers: ReturnType<typeof vi.fn<AuthProvider['headers']>>;
  onUnauthorized: ReturnType<typeof vi.fn<AuthProvider['onUnauthorized']>>;
}

function makeAuth(
  onUnauthorized: AuthProvider['onUnauthorized'] = async () => true,
  headers?: AuthProvider['headers'],
): AuthStub {
  let n = 0;
  return {
    headers: vi.fn<AuthProvider['headers']>(
      headers ??
        (async () => {
          n += 1;
          return { 'x-test-sig': `sig-${n}` };
        }),
    ),
    onUnauthorized: vi.fn<AuthProvider['onUnauthorized']>(onUnauthorized),
  };
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** A promise that always resolves, so a fake-timer test never leaks a rejection. */
function settle<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  const outcome = await settle(promise);
  if (outcome.ok) {
    throw new Error('expected the request to fail');
  }
  return outcome.error;
}

/** One turn of the real event loop (setImmediate is never faked in these tests). */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Real wait budget for `until` and `drain`, under vitest's 5 s test timeout. Bounded by time,
 * not by a count of turns: a turn that waits on a socket or libuv's threadpool is empty and
 * takes microseconds, so a loaded runner can use up any fixed count before the work is done.
 * Timed with `performance.now()`, which no test here fakes.
 */
const REAL_WAIT_MS = 3_000;

async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + REAL_WAIT_MS;
  while (!condition()) {
    if (performance.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await tick();
  }
}

/** Fakes only the timers the retry delay uses; msw and the sockets stay real. */
function fakeTimers(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}

/** Waits until the transport is sleeping before a retry. */
async function untilSleeping(): Promise<void> {
  await until(() => vi.getTimerCount() > 0, 'the retry delay to start');
}

/** Runs fake time forward until the request settles (for up to `REAL_WAIT_MS` of real time). */
async function drain<T>(promise: Promise<T>): Promise<Outcome<T>> {
  const outcome = settle(promise);
  let done = false;
  void outcome.then(() => {
    done = true;
  });
  const deadline = performance.now() + REAL_WAIT_MS;
  while (!done && performance.now() < deadline) {
    await vi.advanceTimersByTimeAsync(5000);
    await tick();
  }
  return outcome;
}

/** Everything a caller could log or print from an error and its cause chain. */
function dump(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && depth < 10; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.name, current.message, current.stack ?? '');
      try {
        parts.push(JSON.stringify(current));
      } catch {
        // not serialisable; the fields above already cover it
      }
      current = current.cause;
    } else {
      parts.push(String(current));
      try {
        parts.push(JSON.stringify(current));
      } catch {
        // ignore
      }
      break;
    }
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// backoffMs
// ---------------------------------------------------------------------------

describe('backoffMs', () => {
  test('backoffMs(attempt, 250, 30000, () => 1) === min(30000, 250 * 2 ** attempt)', () => {
    for (let attempt = 0; attempt <= 12; attempt += 1) {
      expect(backoffMs(attempt, 250, 30000, () => 1)).toBe(
        Math.min(30000, 250 * 2 ** attempt),
      );
    }
  });

  test('backoffMs(..., () => 0) === 0', () => {
    for (let attempt = 0; attempt <= 12; attempt += 1) {
      expect(backoffMs(attempt, 250, 30000, () => 0)).toBe(0);
    }
  });

  test('is full jitter: a random fraction of the capped exponential', () => {
    expect(backoffMs(0, 250, 2000, () => 0.5)).toBe(125);
    expect(backoffMs(2, 250, 2000, () => 0.5)).toBe(500);
    expect(backoffMs(5, 250, 2000, () => 0.5)).toBe(1000);
  });

  test('never exceeds the cap, even for huge attempt numbers', () => {
    expect(backoffMs(5000, 250, 2000, () => 1)).toBe(2000);
    expect(backoffMs(5000, 250, 2000, () => 0.999999)).toBeLessThan(2000);
  });

  test('uses Math.random by default and stays within [0, ceiling)', () => {
    for (let i = 0; i < 50; i += 1) {
      const delayMs = backoffMs(3, 250, 2000);
      expect(delayMs).toBeGreaterThanOrEqual(0);
      expect(delayMs).toBeLessThan(2000);
      expect(Number.isInteger(delayMs)).toBe(true);
    }
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(backoffMs(1, 250, 2000)).toBe(250);
  });
});

// ---------------------------------------------------------------------------
// Requests: URLs, headers, query, body
// ---------------------------------------------------------------------------

describe('request building', () => {
  test('sends X-XO-SDK: ts/<version> on every call', async () => {
    const backend = serve('get', `${BACKEND}/api/ping`, ok());
    const orderbook = serve('post', `${ORDERBOOK}/orders`, ok());
    const sponsor = serve('get', `${SPONSOR}/health`, ok());
    const t = makeTransport({ version: '1.2.3' });

    await t.request({ service: 'backend', method: 'GET', path: '/api/ping' });
    await t.request({
      service: 'orderbook',
      method: 'POST',
      path: '/orders',
      body: { a: 1 },
    });
    await t.request({ service: 'sponsor', method: 'GET', path: '/health' });

    for (const hits of [backend, orderbook, sponsor]) {
      expect(hits).toHaveLength(1);
      expect(hits[0]?.headers.get('x-xo-sdk')).toBe('ts/1.2.3');
      expect(hits[0]?.headers.get('accept')).toBe('application/json');
    }
  });

  test('uses each service base URL verbatim, with the full path from the caller', async () => {
    const backend = serve('get', `${BACKEND}/api/data/markets`, ok());
    const orderbook = serve('get', `${ORDERBOOK}/time`, ok());
    const sponsor = serve('post', `${SPONSOR}/sponsor`, ok());
    const t = makeTransport();

    await t.request({
      service: 'backend',
      method: 'GET',
      path: '/api/data/markets',
    });
    await t.request({ service: 'orderbook', method: 'GET', path: '/time' });
    await t.request({ service: 'sponsor', method: 'POST', path: '/sponsor' });

    expect(backend[0]?.url.href).toBe(`${BACKEND}/api/data/markets`);
    expect(orderbook[0]?.url.href).toBe(`${ORDERBOOK}/time`);
    expect(sponsor[0]?.url.href).toBe(`${SPONSOR}/sponsor`);
  });

  test('strips one trailing slash from a base URL', async () => {
    const hits = serve('get', 'https://api.example.test/api/ping', ok());
    const custom: EnvironmentConfig = {
      ...env,
      backendUrl: 'https://api.example.test/',
    };
    await makeTransport({ env: custom }).request({
      service: 'backend',
      method: 'GET',
      path: '/api/ping',
    });
    expect(hits[0]?.url.href).toBe('https://api.example.test/api/ping');
  });

  test('a sponsor request without sponsorUrl throws UserInputError sponsor_not_configured', async () => {
    const hits = serve('get', `${SPONSOR}/health`, ok());
    const { sponsorUrl: _omitted, ...withoutSponsor } = env;
    const t = makeTransport({ env: withoutSponsor });

    const error = await errorOf(
      t.request({ service: 'sponsor', method: 'GET', path: '/health' }),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).code).toBe('sponsor_not_configured');
    expect(hits).toHaveLength(0);
  });

  test('a path without a leading slash is a UserInputError, not a broken URL', async () => {
    const error = await errorOf(
      makeTransport().request({
        service: 'backend',
        method: 'GET',
        path: 'api/ping',
      }),
    );
    expect(error).toBeInstanceOf(UserInputError);
  });

  test.each([
    '/data/orders?market=0xabc',
    '/data/orders#frag',
    '/data/orders?market=0xabc#frag',
    '/data/orders?',
  ])(
    'a path containing "?" or "#" (%s) is a UserInputError before any I/O',
    async (path) => {
      const hits = serve('get', `${BACKEND}/data/orders`, ok());
      const auth = makeAuth();
      const error = await errorOf(
        makeTransport({ auth }).request({
          service: 'backend',
          method: 'GET',
          path,
          auth: 'backend',
        }),
      );
      expect(error).toBeInstanceOf(UserInputError);
      expect((error as UserInputError).message).toContain('query');
      expect((error as UserInputError).message).toContain('GET /data/orders');
      expect((error as UserInputError).message).not.toContain('0xabc');
      expect(hits).toHaveLength(0);
      expect(auth.headers).not.toHaveBeenCalled();
    },
  );

  test.each(['GET', 'HEAD'] as const)(
    'a %s request with a body is a UserInputError before any I/O',
    async (method) => {
      const hits = serve(
        method === 'GET' ? 'get' : 'head',
        `${BACKEND}/api/x`,
        ok(),
      );
      const auth = makeAuth();
      const toJSON = vi.fn(() => ({ a: 1 }));
      for (const body of [{ a: 1 }, { toJSON }, null, '', 0]) {
        const error = await errorOf(
          makeTransport({ auth }).request({
            service: 'backend',
            method,
            path: '/api/x',
            body,
            auth: 'backend',
          }),
        );
        expect(error).toBeInstanceOf(UserInputError);
        expect((error as UserInputError).message).toContain(method);
        expect((error as UserInputError).message).toContain('body');
      }
      expect(hits).toHaveLength(0);
      expect(auth.headers).not.toHaveBeenCalled();
      expect(toJSON).not.toHaveBeenCalled();
    },
  );

  test('a GET with body: undefined is fine', async () => {
    const hits = serve('get', `${BACKEND}/api/x`, ok());
    await makeTransport().request({
      service: 'backend',
      method: 'GET',
      path: '/api/x',
      body: undefined,
    });
    expect(hits).toHaveLength(1);
  });

  test("fetch is told never to follow redirects (redirect: 'error')", async () => {
    const fake = fakeFetch(
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('{"ok":true}'));
            controller.close();
          },
        }),
    );
    await makeTransport({ fetch: fake.fetch }).request({
      service: 'backend',
      method: 'GET',
      path: '/api/x',
    });
    expect(fake.inits).toHaveLength(1);
    expect(fake.inits[0]?.redirect).toBe('error');
  });

  test('a redirect response is not followed, so no auth headers reach the other origin', async () => {
    const other = serve('get', 'https://elsewhere.example.test/stolen', ok());
    const first = serve(
      'get',
      `${BACKEND}/api/x`,
      () =>
        new HttpResponse(null, {
          status: 302,
          headers: { location: 'https://elsewhere.example.test/stolen' },
        }),
    );
    const auth = makeAuth(undefined, async () => ({ 'X-XO-Key': 'k1' }));
    const error = await errorOf(
      makeTransport({ auth, maxRetries: 0 }).request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
        auth: 'backend',
      }),
    );
    expect(error).toBeInstanceOf(XoError);
    expect(first).toHaveLength(1);
    expect(other).toHaveLength(0);
  });

  test('query is appended to URL but not passed to auth.headers path', async () => {
    const hits = serve('get', `${BACKEND}/data/orders`, ok());
    const auth = makeAuth();
    const t = makeTransport({ auth });

    await t.request({
      service: 'backend',
      method: 'GET',
      path: '/data/orders',
      query: { market: '0xabc' },
      auth: 'backend',
    });

    expect(hits[0]?.url.pathname).toBe('/data/orders');
    expect(hits[0]?.url.search).toBe('?market=0xabc');
    expect(auth.headers).toHaveBeenCalledTimes(1);
    expect(auth.headers).toHaveBeenCalledWith('backend', {
      method: 'GET',
      path: '/data/orders',
      body: '',
    });
  });

  test('query skips undefined values and stringifies booleans and numbers', async () => {
    const hits = serve('get', `${BACKEND}/api/q`, ok());
    await makeTransport().request({
      service: 'backend',
      method: 'GET',
      path: '/api/q',
      query: {
        a: 'x',
        skipped: undefined,
        yes: true,
        no: false,
        n: 5,
        zero: 0,
        s: 'a b&c',
      },
    });
    const params = hits[0]?.url.searchParams;
    expect([...(params?.keys() ?? [])]).toEqual([
      'a',
      'yes',
      'no',
      'n',
      'zero',
      's',
    ]);
    expect(params?.get('yes')).toBe('true');
    expect(params?.get('no')).toBe('false');
    expect(params?.get('n')).toBe('5');
    expect(params?.get('zero')).toBe('0');
    expect(params?.get('s')).toBe('a b&c');
    expect(params?.has('skipped')).toBe(false);
  });

  test('a query of only undefined values adds no "?"', async () => {
    const hits = serve('get', `${BACKEND}/api/q`, ok());
    await makeTransport().request({
      service: 'backend',
      method: 'GET',
      path: '/api/q',
      query: { a: undefined },
    });
    expect(hits[0]?.url.search).toBe('');
    expect(hits[0]?.url.href).toBe(`${BACKEND}/api/q`);
  });

  test('serializes body once and passes the same string to auth.headers and fetch', async () => {
    const hits = serve('post', `${ORDERBOOK}/orders`, ok());
    const auth = makeAuth();
    const t = makeTransport({ auth });
    const payload = { b: 2, a: [1, 'x'], nested: { k: null } };

    await t.request({
      service: 'orderbook',
      method: 'POST',
      path: '/orders',
      body: payload,
      auth: 'orderbook',
    });

    const seen = auth.headers.mock.calls[0]?.[1].body;
    expect(typeof seen).toBe('string');
    expect(hits[0]?.body).toBe(seen);
    expect(seen).toBe(JSON.stringify(payload));
    expect(hits[0]?.headers.get('content-type')).toBe('application/json');
  });

  test('calls JSON.stringify once per request, even when the request is sent twice', async () => {
    let serialized = 0;
    const payload = {
      toJSON() {
        serialized += 1;
        return { z: 1, y: 2 };
      },
    };
    const hits = serve('post', `${ORDERBOOK}/orders`, fail(401, {}), ok());
    const auth = makeAuth();
    await makeTransport({ auth }).request({
      service: 'orderbook',
      method: 'POST',
      path: '/orders',
      body: payload,
      auth: 'orderbook',
    });

    expect(serialized).toBe(1);
    expect(hits).toHaveLength(2);
    expect(hits[0]?.body).toBe('{"z":1,"y":2}');
    expect(hits[1]?.body).toBe('{"z":1,"y":2}');
    expect(auth.headers.mock.calls.map((c) => c[1].body)).toEqual([
      '{"z":1,"y":2}',
      '{"z":1,"y":2}',
    ]);
  });

  test('without a body: auth sees "", no body and no content-type are sent', async () => {
    const hits = serve('get', `${BACKEND}/api/x`, ok());
    const auth = makeAuth();
    await makeTransport({ auth }).request({
      service: 'backend',
      method: 'GET',
      path: '/api/x',
      auth: 'backend',
    });
    expect(auth.headers.mock.calls[0]?.[1].body).toBe('');
    expect(hits[0]?.body).toBe('');
    expect(hits[0]?.headers.has('content-type')).toBe(false);
  });

  test('a body that cannot be serialized is a UserInputError and sends nothing', async () => {
    const hits = serve('post', `${BACKEND}/api/x`, ok());
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const body of [circular, 10n]) {
      const error = await errorOf(
        makeTransport().request({
          service: 'backend',
          method: 'POST',
          path: '/api/x',
          body,
        }),
      );
      expect(error).toBeInstanceOf(UserInputError);
    }
    expect(hits).toHaveLength(0);
  });

  test('a falsy body (0, "", false, null) is still sent', async () => {
    const hits = serve('post', `${BACKEND}/api/x`, ok());
    const t = makeTransport();
    for (const body of [0, '', false, null]) {
      await t.request({
        service: 'backend',
        method: 'POST',
        path: '/api/x',
        body,
      });
    }
    expect(hits.map((h) => h.body)).toEqual(['0', '""', 'false', 'null']);
  });
});

// ---------------------------------------------------------------------------
// Auth hooks
// ---------------------------------------------------------------------------

describe('auth', () => {
  test('auth headers are merged into the request', async () => {
    const hits = serve('get', `${BACKEND}/api/x`, ok());
    const auth = makeAuth(undefined, async () => ({
      'X-XO-Key': 'k1',
      'X-XO-Signature': 's1',
    }));
    await makeTransport({ auth }).request({
      service: 'backend',
      method: 'GET',
      path: '/api/x',
      auth: 'backend',
    });
    expect(hits[0]?.headers.get('x-xo-key')).toBe('k1');
    expect(hits[0]?.headers.get('x-xo-signature')).toBe('s1');
    expect(hits[0]?.headers.get('x-xo-sdk')).toBe('ts/9.9.9');
  });

  test("auth: 'none' (the default) never calls the auth provider", async () => {
    serve('get', `${BACKEND}/api/x`, ok());
    const auth = makeAuth();
    const t = makeTransport({ auth });
    await t.request({ service: 'backend', method: 'GET', path: '/api/x' });
    await t.request({
      service: 'backend',
      method: 'GET',
      path: '/api/x',
      auth: 'none',
    });
    expect(auth.headers).not.toHaveBeenCalled();
  });

  test.each(['backend', 'orderbook'] as const)(
    'a %s request without an AuthProvider throws AuthRequiredError',
    async (kind) => {
      const hits = serve('get', `${BACKEND}/api/x`, ok());
      const error = await errorOf(
        makeTransport().request({
          service: 'backend',
          method: 'GET',
          path: '/api/x',
          auth: kind,
        }),
      );
      expect(error).toBeInstanceOf(AuthRequiredError);
      expect(hits).toHaveLength(0);
    },
  );

  test('an error from headers() before the first attempt is marked as not sent, even with a status', async () => {
    const hits = serve('post', `${ORDERBOOK}/order`, ok());
    const failure = new RequestRejectedError('derive failed', {
      code: 'service_unavailable',
      status: 503,
      service: 'orderbook',
    });
    const auth = makeAuth(undefined, async () => {
      throw failure;
    });
    const error = await errorOf(
      makeTransport({ auth }).request({
        service: 'orderbook',
        method: 'POST',
        path: '/order',
        body: {},
        auth: 'orderbook',
      }),
    );
    expect(error).toBe(failure);
    expect(wasNotSent(error)).toBe(true);
    expect(hits).toHaveLength(0);
  });

  test('an error from onUnauthorized after a 401 is marked as not sent: the 401 means it was not processed', async () => {
    const hits = serve('post', `${ORDERBOOK}/order`, fail(401, {}));
    const failure = new TimeoutError('derive timed out', {
      service: 'orderbook',
    });
    const auth = makeAuth(async () => {
      throw failure;
    });
    const error = await errorOf(
      makeTransport({ auth }).request({
        service: 'orderbook',
        method: 'POST',
        path: '/order',
        body: {},
        auth: 'orderbook',
      }),
    );
    expect(error).toBe(failure);
    expect(wasNotSent(error)).toBe(true);
    expect(hits).toHaveLength(1);
  });

  test('an error from the attempt itself, or from headers() after an attempt that may have run, is not marked', async () => {
    serve('post', `${ORDERBOOK}/order`, networkError);
    const sent = await errorOf(
      makeTransport({ auth: makeAuth() }).request({
        service: 'orderbook',
        method: 'POST',
        path: '/order',
        body: {},
        auth: 'orderbook',
      }),
    );
    expect(sent).toBeInstanceOf(TransportError);
    expect(wasNotSent(sent)).toBe(false);

    // A read retried after a 503: the first attempt may have run when headers() fails.
    serve('get', `${ORDERBOOK}/data/orders`, fail(503, {}), ok());
    let calls = 0;
    const failure = new Error('store unavailable');
    const auth = makeAuth(undefined, async () => {
      calls += 1;
      if (calls === 2) {
        throw failure;
      }
      return { 'x-test-sig': 'sig' };
    });
    const error = await errorOf(
      makeTransport({ auth, maxRetries: 1 }).request({
        service: 'orderbook',
        method: 'GET',
        path: '/data/orders',
        auth: 'orderbook',
      }),
    );
    expect(error).toBe(failure);
    expect(wasNotSent(error)).toBe(false);
    expect(wasNotSent(undefined)).toBe(false);
    expect(wasNotSent('a string')).toBe(false);
  });

  test('setAuth installs the provider for later requests', async () => {
    const hits = serve('get', `${BACKEND}/api/x`, ok());
    const t = makeTransport();
    const first = await errorOf(
      t.request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
        auth: 'backend',
      }),
    );
    expect(first).toBeInstanceOf(AuthRequiredError);

    t.setAuth(makeAuth(undefined, async () => ({ 'x-late': 'yes' })));
    await t.request({
      service: 'backend',
      method: 'GET',
      path: '/api/x',
      auth: 'backend',
    });
    expect(hits[0]?.headers.get('x-late')).toBe('yes');
  });

  test('auth.headers is called again, with fresh output, on each retry', async () => {
    fakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const hits = serve('get', `${BACKEND}/api/x`, fail(503), fail(503), ok());
    const auth = makeAuth();
    const outcome = await drain(
      makeTransport({ auth }).request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
        auth: 'backend',
      }),
    );
    expect(outcome.ok).toBe(true);
    expect(auth.headers).toHaveBeenCalledTimes(3);
    expect(hits.map((h) => h.headers.get('x-test-sig'))).toEqual([
      'sig-1',
      'sig-2',
      'sig-3',
    ]);
  });

  test('calls onUnauthorized once on 401 and retries once; second 401 throws a 401 rejection', async () => {
    const hits = serve(
      'post',
      `${ORDERBOOK}/orders`,
      fail(401, { error: 'invalid_signature' }),
      fail(401, { error: 'invalid_signature' }),
      ok(),
    );
    const auth = makeAuth(async () => true);
    const error = await errorOf(
      makeTransport({ auth }).request({
        service: 'orderbook',
        method: 'POST',
        path: '/orders',
        body: { a: 1 },
        auth: 'orderbook',
      }),
    );
    expect(error).toSatisfy(rejectedWith(401));
    expect((error as RequestRejectedError).code).toBe('invalid_signature');
    expect((error as RequestRejectedError).status).toBe(401);
    expect(hits).toHaveLength(2);
    expect(auth.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(auth.onUnauthorized).toHaveBeenCalledWith('orderbook', {
      headers: { 'x-test-sig': 'sig-1' },
    });
    expect(auth.headers).toHaveBeenCalledTimes(2);
  });

  test('a 401 followed by success returns the second response, with fresh headers', async () => {
    const hits = serve('post', `${BACKEND}/api/x`, fail(401, {}), ok({ n: 2 }));
    const auth = makeAuth(async () => true);
    const result = await makeTransport({ auth }).request({
      service: 'backend',
      method: 'POST',
      path: '/api/x',
      body: {},
      auth: 'backend',
    });
    expect(result).toEqual({ n: 2 });
    expect(hits.map((h) => h.headers.get('x-test-sig'))).toEqual([
      'sig-1',
      'sig-2',
    ]);
    expect(auth.onUnauthorized).toHaveBeenCalledWith('backend', {
      headers: { 'x-test-sig': 'sig-1' },
    });
  });

  test('onUnauthorized returning false throws the 401 rejection with a single hit', async () => {
    const hits = serve('get', `${BACKEND}/api/x`, fail(401, {}), ok());
    const auth = makeAuth(async () => false);
    const error = await errorOf(
      makeTransport({ auth }).request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
        auth: 'backend',
      }),
    );
    expect(error).toSatisfy(rejectedWith(401));
    expect(hits).toHaveLength(1);
    expect(auth.onUnauthorized).toHaveBeenCalledTimes(1);
  });

  test('the 401 refresh does not use up the retry budget', async () => {
    fakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const hits = serve(
      'get',
      `${BACKEND}/api/x`,
      fail(401, {}),
      fail(503),
      fail(503),
      ok({ done: true }),
    );
    const auth = makeAuth(async () => true);
    const outcome = await drain(
      makeTransport({ auth }).request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
        auth: 'backend',
      }),
    );
    expect(outcome).toEqual({ ok: true, value: { done: true } });
    expect(hits).toHaveLength(4);
    expect(auth.onUnauthorized).toHaveBeenCalledTimes(1);
  });

  test('a 401 after retries still calls onUnauthorized only once per request', async () => {
    fakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const hits = serve(
      'get',
      `${BACKEND}/api/x`,
      fail(503),
      fail(401, {}),
      fail(401, {}),
      ok(),
    );
    const auth = makeAuth(async () => true);
    const outcome = await drain(
      makeTransport({ auth }).request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
        auth: 'backend',
      }),
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toSatisfy(rejectedWith(401));
    expect(hits).toHaveLength(3);
    expect(auth.onUnauthorized).toHaveBeenCalledTimes(1);
  });

  test("a 401 on an unauthenticated (auth: 'none') request is a 401 rejection without a refresh", async () => {
    const hits = serve('get', `${BACKEND}/api/x`, fail(401, {}));
    const auth = makeAuth();
    const error = await errorOf(
      makeTransport({ auth }).request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
      }),
    );
    expect(error).toSatisfy(rejectedWith(401));
    expect(hits).toHaveLength(1);
    expect(auth.onUnauthorized).not.toHaveBeenCalled();
  });

  test('an error thrown by onUnauthorized propagates', async () => {
    serve('get', `${BACKEND}/api/x`, fail(401, {}));
    const boom = new XoError('refresh failed');
    const auth = makeAuth(async () => {
      throw boom;
    });
    const error = await errorOf(
      makeTransport({ auth }).request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
        auth: 'backend',
      }),
    );
    expect(error).toBe(boom);
  });
});

// ---------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------

describe('retries', () => {
  test('retries GET on 503 twice then throws a 5xx rejection', async () => {
    fakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const hits = serve('get', `${BACKEND}/api/x`, fail(503, { error: 'busy' }));
    const outcome = await drain(
      makeTransport().request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
      }),
    );
    expect(hits).toHaveLength(3);
    expect(outcome.ok).toBe(false);
    const error = !outcome.ok ? outcome.error : undefined;
    expect(error).toSatisfy(serverFailure);
    expect((error as RequestRejectedError).status).toBe(503);
    expect((error as RequestRejectedError).code).toBe('busy');
  });

  test("does not retry when retry: 'none'", async () => {
    const hits = serve('get', `${BACKEND}/api/x`, fail(503), ok());
    const error = await errorOf(
      makeTransport().request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
        retry: 'none',
      }),
    );
    expect(error).toSatisfy(serverFailure);
    expect(hits).toHaveLength(1);
  });

  test.each(['post', 'put', 'patch', 'delete'] as const)(
    'a %s request is not retried by default',
    async (method) => {
      const hits = serve(method, `${BACKEND}/api/x`, fail(503), ok());
      const error = await errorOf(
        makeTransport().request({
          service: 'backend',
          method: method.toUpperCase() as 'POST' | 'PUT' | 'PATCH' | 'DELETE',
          path: '/api/x',
        }),
      );
      expect(error).toSatisfy(serverFailure);
      expect(hits).toHaveLength(1);
    },
  );

  test("a POST with retry: 'read' is retried", async () => {
    fakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const hits = serve('post', `${BACKEND}/api/x`, fail(503), ok({ v: 1 }));
    const outcome = await drain(
      makeTransport().request({
        service: 'backend',
        method: 'POST',
        path: '/api/x',
        body: {},
        retry: 'read',
      }),
    );
    expect(outcome).toEqual({ ok: true, value: { v: 1 } });
    expect(hits).toHaveLength(2);
  });

  test('HEAD is retried by default, like GET', async () => {
    fakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const hits = serve('head', `${BACKEND}/api/x`, fail(503), () => {
      return new HttpResponse(null, { status: 200 });
    });
    const outcome = await drain(
      makeTransport().request({
        service: 'backend',
        method: 'HEAD',
        path: '/api/x',
      }),
    );
    expect(outcome).toEqual({ ok: true, value: undefined });
    expect(hits).toHaveLength(2);
  });

  test.each([429, 502, 503, 504])(
    'GET retries on %i and then succeeds',
    async (status) => {
      fakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const hits = serve(
        'get',
        `${BACKEND}/api/x`,
        fail(status),
        ok({ v: status }),
      );
      const outcome = await drain(
        makeTransport().request({
          service: 'backend',
          method: 'GET',
          path: '/api/x',
        }),
      );
      expect(outcome).toEqual({ ok: true, value: { v: status } });
      expect(hits).toHaveLength(2);
    },
  );

  test.each([400, 403, 404, 409, 500, 501])(
    'GET does not retry on %i',
    async (status) => {
      const hits = serve('get', `${BACKEND}/api/x`, fail(status), ok());
      const error = await errorOf(
        makeTransport().request({
          service: 'backend',
          method: 'GET',
          path: '/api/x',
        }),
      );
      expect(error).toBeInstanceOf(XoError);
      expect((error as XoError).status).toBe(status);
      expect(hits).toHaveLength(1);
    },
  );

  test('retries a GET after a network error and returns the later success', async () => {
    fakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const hits = serve('get', `${BACKEND}/api/x`, networkError, ok({ v: 1 }));
    const outcome = await drain(
      makeTransport().request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
      }),
    );
    expect(outcome).toEqual({ ok: true, value: { v: 1 } });
    expect(hits).toHaveLength(2);
  });

  test('a GET that keeps failing at the network level throws TransportError after 3 hits', async () => {
    fakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const hits = serve('get', `${BACKEND}/api/x`, networkError);
    const outcome = await drain(
      makeTransport().request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
      }),
    );
    expect(hits).toHaveLength(3);
    const error = !outcome.ok ? outcome.error : undefined;
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).service).toBe('backend');
    expect((error as TransportError).cause).toBeInstanceOf(Error);
  });

  test('a POST network error is not retried', async () => {
    const hits = serve('post', `${BACKEND}/api/x`, networkError, ok());
    const error = await errorOf(
      makeTransport().request({
        service: 'backend',
        method: 'POST',
        path: '/api/x',
        body: {},
      }),
    );
    expect(error).toBeInstanceOf(TransportError);
    expect(hits).toHaveLength(1);
  });

  test('maxRetries bounds the number of retries', async () => {
    fakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    for (const [maxRetries, expected] of [
      [0, 1],
      [1, 2],
      [4, 5],
    ] as const) {
      const hits = serve('get', `${BACKEND}/api/x`, fail(503));
      const outcome = await drain(
        makeTransport({ maxRetries }).request({
          service: 'backend',
          method: 'GET',
          path: '/api/x',
        }),
      );
      expect(outcome.ok).toBe(false);
      expect(hits).toHaveLength(expected);
      server.resetHandlers();
    }
  });

  test('backs off with jitter between retries: backoffMs(attempt, 250, 2000)', async () => {
    fakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const hits = serve('get', `${BACKEND}/api/x`, fail(503));
    const outcome = settle(
      makeTransport().request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
      }),
    );

    await untilSleeping();
    await vi.advanceTimersByTimeAsync(249);
    expect(hits).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => hits.length === 2, 'the first retry');

    await untilSleeping();
    await vi.advanceTimersByTimeAsync(499);
    expect(hits).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => hits.length === 3, 'the second retry');

    expect((await outcome).ok).toBe(false);
  });

  test('honours a retry_after_ms of exactly 5000 ms', async () => {
    fakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const hits = serve(
      'get',
      `${ORDERBOOK}/book`,
      fail(503, { error: 'overloaded', retry_after_ms: 5_000 }),
      ok({ v: 1 }),
    );
    const outcome = settle(
      makeTransport().request({
        service: 'orderbook',
        method: 'GET',
        path: '/book',
      }),
    );

    await untilSleeping();
    await vi.advanceTimersByTimeAsync(4999);
    expect(hits).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toEqual({ ok: true, value: { v: 1 } });
    expect(hits).toHaveLength(2);
  });

  test('honours a retry_after_ms below the cap exactly', async () => {
    fakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const hits = serve(
      'get',
      `${ORDERBOOK}/book`,
      fail(429, { error: 'rate limit exceeded', retry_after_ms: 1200 }),
      ok({ v: 1 }),
    );
    const outcome = settle(
      makeTransport().request({
        service: 'orderbook',
        method: 'GET',
        path: '/book',
      }),
    );

    await untilSleeping();
    await vi.advanceTimersByTimeAsync(1199);
    expect(hits).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toEqual({ ok: true, value: { v: 1 } });
  });

  test('a wait above 5000 ms is not slept: the error goes back with its retryAfter', async () => {
    fakeTimers();
    for (const [service, url, reply, status, retryAfter] of [
      [
        'orderbook',
        `${ORDERBOOK}/book`,
        fail(503, { error: 'overloaded', retry_after_ms: 5_001 }),
        503,
        5_001,
      ],
      [
        'backend',
        `${BACKEND}/book`,
        fail(503, {}, { 'Retry-After': '120' }),
        503,
        120_000,
      ],
      [
        'backend',
        `${BACKEND}/book`,
        fail(429, {}, { 'Retry-After': '6' }),
        429,
        6_000,
      ],
    ] as const) {
      const hits = serve('get', url, reply, ok({ v: 1 }));
      const error = await errorOf(
        makeTransport().request({ service, method: 'GET', path: '/book' }),
      );
      expect(hits).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      expect((error as XoError).status).toBe(status);
      expect(error).toBeInstanceOf(
        status === 429 ? RateLimitError : RequestRejectedError,
      );
      expect((error as RateLimitError).retryAfter).toBe(retryAfter);
      server.resetHandlers();
    }
  });

  test('honours a short Retry-After on a 502 exactly', async () => {
    fakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const hits = serve(
      'get',
      `${BACKEND}/api/x`,
      fail(502, {}, { 'Retry-After': '2' }),
      ok({ v: 1 }),
    );
    const outcome = settle(
      makeTransport().request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
      }),
    );

    await untilSleeping();
    await vi.advanceTimersByTimeAsync(1999);
    expect(hits).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toEqual({ ok: true, value: { v: 1 } });
  });

  test('a Retry-After of 0 retries without waiting for the backoff', async () => {
    fakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const hits = serve(
      'get',
      `${BACKEND}/api/x`,
      fail(503, {}, { 'Retry-After': '0' }),
      ok({ v: 1 }),
    );
    const outcome = settle(
      makeTransport().request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
      }),
    );
    await untilSleeping();
    await vi.advanceTimersByTimeAsync(0);
    expect(await outcome).toEqual({ ok: true, value: { v: 1 } });
    expect(hits).toHaveLength(2);
  });

  test('a 503 trading_paused with Retry-After is retried for a read and keeps its type when it gives up', async () => {
    fakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    serve(
      'get',
      `${ORDERBOOK}/book`,
      fail(503, { error: 'trading_paused' }, { 'Retry-After': '1' }),
    );
    const outcome = await drain(
      makeTransport().request({
        service: 'orderbook',
        method: 'GET',
        path: '/book',
      }),
    );
    const error = !outcome.ok ? outcome.error : undefined;
    expect(error).toSatisfy(tradingPaused);
    expect((error as RequestRejectedError).retryAfter).toBe(1000);
  });

  test('a 429 that exhausts the retries throws RateLimitError', async () => {
    fakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const hits = serve(
      'get',
      `${BACKEND}/api/x`,
      fail(429, { message: 'slow' }),
    );
    const outcome = await drain(
      makeTransport().request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
      }),
    );
    expect(hits).toHaveLength(3);
    expect(!outcome.ok && outcome.error).toBeInstanceOf(RateLimitError);
  });
});

// ---------------------------------------------------------------------------
// Rate-limit reporting
// ---------------------------------------------------------------------------

describe('rate-limit reporting', () => {
  test('reports rate-limit info from X-RateLimit-* headers and 429 bodies', async () => {
    const onRateLimit = vi.fn<(info: RateLimitUpdate) => void>();
    serve('get', `${BACKEND}/api/ok`, () =>
      HttpResponse.json(
        { ok: true },
        {
          headers: {
            'X-RateLimit-Limit': '100',
            'X-RateLimit-Remaining': '7',
            'X-RateLimit-Reset': '30',
          },
        },
      ),
    );
    serve(
      'post',
      `${ORDERBOOK}/orders`,
      fail(429, { error: 'rate limit exceeded', retry_after_ms: 1500 }),
    );
    const t = makeTransport({ onRateLimit });

    await t.request({ service: 'backend', method: 'GET', path: '/api/ok' });
    expect(onRateLimit).toHaveBeenCalledTimes(1);
    expect(onRateLimit).toHaveBeenLastCalledWith({
      service: 'backend',
      path: '/api/ok',
      limit: 100,
      remaining: 7,
      resetMs: 30_000,
    });

    const error = await errorOf(
      t.request({
        service: 'orderbook',
        method: 'POST',
        path: '/orders',
        body: {},
      }),
    );
    expect(error).toBeInstanceOf(RateLimitError);
    expect(onRateLimit).toHaveBeenCalledTimes(2);
    expect(onRateLimit).toHaveBeenLastCalledWith({
      service: 'orderbook',
      path: '/orders',
      retryAfter: 1500,
    });
  });

  test('a 429 with both headers and a body reports everything', async () => {
    const onRateLimit = vi.fn<(info: RateLimitUpdate) => void>();
    serve(
      'post',
      `${BACKEND}/api/x`,
      fail(
        429,
        { statusCode: 429, message: 'Too Many Requests' },
        {
          'X-RateLimit-Limit': '10',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': '2',
          'Retry-After': '2',
        },
      ),
    );
    await errorOf(
      makeTransport({ onRateLimit }).request({
        service: 'backend',
        method: 'POST',
        path: '/api/x',
        query: { secret: 'not-in-the-report' },
        body: {},
      }),
    );
    expect(onRateLimit).toHaveBeenCalledWith({
      service: 'backend',
      path: '/api/x',
      limit: 10,
      remaining: 0,
      resetMs: 2000,
      retryAfter: 2000,
    });
  });

  test('reports any single X-RateLimit header', async () => {
    const onRateLimit = vi.fn<(info: RateLimitUpdate) => void>();
    serve('get', `${BACKEND}/api/a`, () =>
      HttpResponse.json({}, { headers: { 'X-RateLimit-Remaining': '3' } }),
    );
    await makeTransport({ onRateLimit }).request({
      service: 'backend',
      method: 'GET',
      path: '/api/a',
    });
    expect(onRateLimit).toHaveBeenCalledWith({
      service: 'backend',
      path: '/api/a',
      remaining: 3,
    });
  });

  test('is not called for ordinary responses without those headers', async () => {
    const onRateLimit = vi.fn<(info: RateLimitUpdate) => void>();
    serve('get', `${BACKEND}/api/ok`, ok());
    serve('get', `${BACKEND}/api/gone`, fail(404, {}));
    const t = makeTransport({ onRateLimit });
    await t.request({ service: 'backend', method: 'GET', path: '/api/ok' });
    await errorOf(
      t.request({ service: 'backend', method: 'GET', path: '/api/gone' }),
    );
    expect(onRateLimit).not.toHaveBeenCalled();
  });

  test('is called for a 429 that is then retried', async () => {
    fakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const onRateLimit = vi.fn<(info: RateLimitUpdate) => void>();
    serve('get', `${BACKEND}/api/x`, fail(429, { message: 'slow' }), ok());
    const outcome = await drain(
      makeTransport({ onRateLimit }).request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
      }),
    );
    expect(outcome.ok).toBe(true);
    expect(onRateLimit).toHaveBeenCalledTimes(1);
  });

  test('a throwing onRateLimit is ignored', async () => {
    const onRateLimit = vi.fn(() => {
      throw new Error('listener bug');
    });
    serve('get', `${BACKEND}/api/ok`, () =>
      HttpResponse.json({ ok: 1 }, { headers: { 'X-RateLimit-Limit': '5' } }),
    );
    serve('post', `${BACKEND}/api/limited`, fail(429, {}));
    const t = makeTransport({ onRateLimit });

    expect(
      await t.request({ service: 'backend', method: 'GET', path: '/api/ok' }),
    ).toEqual({ ok: 1 });
    const error = await errorOf(
      t.request({
        service: 'backend',
        method: 'POST',
        path: '/api/limited',
        body: {},
      }),
    );
    expect(error).toBeInstanceOf(RateLimitError);
    expect(onRateLimit).toHaveBeenCalledTimes(2);
  });

  test('an onRateLimit that returns a rejected promise causes no unhandled rejection', async () => {
    // A plain function, not vi.fn(): the mock records its return value and would
    // handle the rejection itself, hiding the bug this test is for.
    let calls = 0;
    const onRateLimit = async () => {
      calls += 1;
      throw new Error('async listener bug');
    };
    serve('get', `${BACKEND}/api/ok`, () =>
      HttpResponse.json({ ok: 1 }, { headers: { 'X-RateLimit-Limit': '5' } }),
    );
    const result = await makeTransport({ onRateLimit }).request({
      service: 'backend',
      method: 'GET',
      path: '/api/ok',
    });
    expect(result).toEqual({ ok: 1 });
    await tick();
    await tick();
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Timeouts and aborts
// ---------------------------------------------------------------------------

describe('body-read failures', () => {
  test('a connection dropped while reading a read response is retried, with its own message', async () => {
    fakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fake = fakeFetch(droppedBody, 200);
    const outcome = await drain(
      makeTransport({ fetch: fake.fetch }).request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
        query: { token: 'query-secret' },
      }),
    );
    expect(fake.inits).toHaveLength(3);
    const error = !outcome.ok ? outcome.error : undefined;
    expect(error).toBeInstanceOf(TransportError);
    const e = error as TransportError;
    expect(e.message).toBe(
      'GET /api/x: response 200 received but its body could not be read',
    );
    expect(e.message).not.toContain('got no response');
    expect(e.service).toBe('backend');
    expect((e.cause as Error).message).toBe('terminated');
    expect(dump(e)).not.toContain('query-secret');
  });

  test('a body-read failure on a read can be retried into a success', async () => {
    fakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(droppedBody(), { status: 200 });
      }
      return Response.json({ v: 1 });
    }) as typeof fetch;
    const outcome = await drain(
      makeTransport({ fetch: fetchImpl }).request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
      }),
    );
    expect(outcome).toEqual({ ok: true, value: { v: 1 } });
    expect(calls).toBe(2);
  });

  test('a body-read failure on a non-read method is not retried and names the status', async () => {
    const fake = fakeFetch(droppedBody, 201);
    const error = await errorOf(
      makeTransport({ fetch: fake.fetch }).request({
        service: 'orderbook',
        method: 'POST',
        path: '/orders',
        body: { a: 1 },
      }),
    );
    expect(fake.inits).toHaveLength(1);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).message).toBe(
      'POST /orders: response 201 received but its body could not be read',
    );
    expect((error as TransportError).service).toBe('orderbook');
    expect(((error as TransportError).cause as Error).message).toBe(
      'terminated',
    );
  });

  test('a failure before the response head still says there was no response', async () => {
    const hits = serve('post', `${BACKEND}/api/x`, networkError);
    const error = await errorOf(
      makeTransport().request({
        service: 'backend',
        method: 'POST',
        path: '/api/x',
        body: {},
      }),
    );
    expect((error as TransportError).message).toContain('got no response');
    expect(hits).toHaveLength(1);
  });
});

describe('timeouts and aborts', () => {
  test('timeout → TimeoutError', async () => {
    const hits = serve('get', `${BACKEND}/api/slow`, hang);
    const error = await errorOf(
      makeTransport().request({
        service: 'backend',
        method: 'GET',
        path: '/api/slow',
        timeoutMs: 40,
      }),
    );
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as TimeoutError).service).toBe('backend');
    expect((error as TimeoutError).message).toContain('/api/slow');
    // A timeout is an abort: it is not retried, even for a GET.
    expect(hits).toHaveLength(1);
  });

  test('a timeout with a live, unfired caller signal is a TimeoutError, not a TransportError', async () => {
    const hits = serve('get', `${BACKEND}/api/slow`, hang);
    const controller = new AbortController();
    const error = await errorOf(
      makeTransport().request({
        service: 'backend',
        method: 'GET',
        path: '/api/slow',
        signal: controller.signal,
        timeoutMs: 30,
      }),
    );
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).not.toBeInstanceOf(TransportError);
    expect(controller.signal.aborted).toBe(false);
    expect(hits).toHaveLength(1);
  });

  test('a timeout during the body read is a TimeoutError, and a read is not retried', async () => {
    const fake = fakeFetch(stalledBody);
    const controller = new AbortController();
    for (const signal of [undefined, controller.signal]) {
      fake.inits.length = 0;
      const error = await errorOf(
        makeTransport({ fetch: fake.fetch }).request({
          service: 'backend',
          method: 'GET',
          path: '/api/x',
          signal,
          timeoutMs: 30,
        }),
      );
      expect(error).toBeInstanceOf(TimeoutError);
      expect(error).not.toBeInstanceOf(TransportError);
      expect(fake.inits).toHaveLength(1);
    }
  });

  test('a timeout is not retried even for a read', async () => {
    const hits = serve('get', `${BACKEND}/api/slow`, hang, ok());
    const error = await errorOf(
      makeTransport({ maxRetries: 5 }).request({
        service: 'backend',
        method: 'GET',
        path: '/api/slow',
        timeoutMs: 30,
      }),
    );
    expect(error).toBeInstanceOf(TimeoutError);
    expect(hits).toHaveLength(1);
  });

  test('defaultTimeoutMs applies, and a per-request timeoutMs overrides it', async () => {
    serve('get', `${BACKEND}/api/slow`, async () => {
      await delay(120);
      return HttpResponse.json({ done: true });
    });
    const t = makeTransport({ defaultTimeoutMs: 30 });

    const error = await errorOf(
      t.request({ service: 'backend', method: 'GET', path: '/api/slow' }),
    );
    expect(error).toBeInstanceOf(TimeoutError);

    const result = await t.request({
      service: 'backend',
      method: 'GET',
      path: '/api/slow',
      timeoutMs: 5000,
    });
    expect(result).toEqual({ done: true });
  });

  test('abort signal → RequestAbortedError with cause AbortError', async () => {
    const hits = serve('get', `${BACKEND}/api/slow`, hang);
    const controller = new AbortController();
    const pending = errorOf(
      makeTransport().request({
        service: 'backend',
        method: 'GET',
        path: '/api/slow',
        signal: controller.signal,
      }),
    );
    await until(() => hits.length === 1, 'the request to reach the server');
    controller.abort();

    const error = await pending;
    expect(error).toBeInstanceOf(RequestAbortedError);
    expect(error).not.toBeInstanceOf(TimeoutError);
    expect((error as RequestAbortedError).cause).toBe(controller.signal.reason);
    expect(((error as RequestAbortedError).cause as Error).name).toBe(
      'AbortError',
    );
    expect(hits).toHaveLength(1);
  });

  test('the abort reason is the cause', async () => {
    const hits = serve('get', `${BACKEND}/api/slow`, hang);
    const controller = new AbortController();
    const reason = new Error('user navigated away');
    const pending = errorOf(
      makeTransport().request({
        service: 'backend',
        method: 'GET',
        path: '/api/slow',
        signal: controller.signal,
      }),
    );
    await until(() => hits.length === 1, 'the request to reach the server');
    controller.abort(reason);

    const error = await pending;
    expect(error).toBeInstanceOf(RequestAbortedError);
    expect((error as RequestAbortedError).cause).toBe(reason);
    expect((error as RequestAbortedError).message).toContain('aborted');
    expect((error as RequestAbortedError).message).toContain('GET /api/slow');
  });

  test('a caller abort of a POST is a RequestAbortedError with the abort reason, not a network error', async () => {
    const hits = serve('post', `${BACKEND}/api/slow`, hang);
    const controller = new AbortController();
    const reason = new Error('cancelled by user');
    const pending = errorOf(
      makeTransport().request({
        service: 'backend',
        method: 'POST',
        path: '/api/slow',
        body: {},
        signal: controller.signal,
      }),
    );
    await until(() => hits.length === 1, 'the request to reach the server');
    controller.abort(reason);

    const error = await pending;
    expect(error).toBeInstanceOf(RequestAbortedError);
    expect((error as RequestAbortedError).cause).toBe(reason);
    expect((error as RequestAbortedError).message).toContain('aborted');
  });

  test('an already-aborted signal fails fast without a request or an auth call', async () => {
    const hits = serve('get', `${BACKEND}/api/x`, ok());
    const auth = makeAuth();
    const controller = new AbortController();
    controller.abort();
    const error = await errorOf(
      makeTransport({ auth }).request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
        auth: 'backend',
        signal: controller.signal,
      }),
    );
    expect(error).toBeInstanceOf(RequestAbortedError);
    expect(((error as RequestAbortedError).cause as Error).name).toBe(
      'AbortError',
    );
    expect(hits).toHaveLength(0);
    expect(auth.headers).not.toHaveBeenCalled();
  });

  test('does not retry after a caller abort', async () => {
    const hits = serve('get', `${BACKEND}/api/x`, hang);
    const controller = new AbortController();
    const pending = errorOf(
      makeTransport({ maxRetries: 5 }).request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
        signal: controller.signal,
      }),
    );
    await until(() => hits.length === 1, 'the request to reach the server');
    controller.abort();
    expect(await pending).toBeInstanceOf(RequestAbortedError);
    await tick();
    expect(hits).toHaveLength(1);
  });

  test('aborting during the retry delay stops the retry', async () => {
    fakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const hits = serve('get', `${BACKEND}/api/x`, fail(503), ok());
    const controller = new AbortController();
    const outcome = settle(
      makeTransport().request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
        signal: controller.signal,
      }),
    );
    await untilSleeping();
    controller.abort();
    const result = await outcome;
    expect(result.ok).toBe(false);
    const error = !result.ok ? result.error : undefined;
    expect(error).toBeInstanceOf(RequestAbortedError);
    expect((error as RequestAbortedError).cause).toBe(controller.signal.reason);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hits).toHaveLength(1);
  });

  test('an unrelated, unfired caller signal does not interfere', async () => {
    serve('get', `${BACKEND}/api/x`, ok({ v: 1 }));
    const controller = new AbortController();
    const result = await makeTransport().request({
      service: 'backend',
      method: 'GET',
      path: '/api/x',
      signal: controller.signal,
    });
    expect(result).toEqual({ v: 1 });
  });
});

// ---------------------------------------------------------------------------
// Per-call options (`call`)
// ---------------------------------------------------------------------------

describe('per-call options', () => {
  const getX = (t: Transport, call: CallOptions) =>
    t.request({ service: 'backend', method: 'GET', path: '/api/x', call });

  test('retries: 0 makes one attempt on a 503', async () => {
    const hits = serve('get', `${BACKEND}/api/x`, fail(503), ok());
    const error = await errorOf(
      getX(makeTransport(), parseRequestOptions({ retries: 0 })),
    );
    expect(error).toSatisfy(serverFailure);
    expect(hits).toHaveLength(1);
  });

  test('retries: 3 makes four attempts', async () => {
    fakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const hits = serve('get', `${BACKEND}/api/x`, fail(503));
    const outcome = await drain(
      getX(makeTransport(), parseRequestOptions({ retries: 3 })),
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toSatisfy(serverFailure);
    expect(hits).toHaveLength(4);
  });

  test('retries overrides the transport default in both directions', async () => {
    fakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    for (const [maxRetries, retries, expected] of [
      [5, 1, 2],
      [0, 2, 3],
    ] as const) {
      const hits = serve('get', `${BACKEND}/api/x`, networkError);
      const outcome = await drain(
        getX(makeTransport({ maxRetries }), parseRequestOptions({ retries })),
      );
      expect(!outcome.ok && outcome.error).toBeInstanceOf(TransportError);
      expect(hits).toHaveLength(expected);
      server.resetHandlers();
    }
  });

  test('aborting before the request rejects with RequestAbortedError and sends nothing', async () => {
    const hits = serve('get', `${BACKEND}/api/x`, ok());
    const auth = makeAuth();
    const controller = new AbortController();
    const reason = new Error('not needed any more');
    controller.abort(reason);
    const error = await errorOf(
      makeTransport({ auth }).request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
        auth: 'backend',
        call: parseRequestOptions({ signal: controller.signal }),
      }),
    );
    expect(error).toBeInstanceOf(RequestAbortedError);
    expect((error as RequestAbortedError).code).toBe('request_aborted');
    expect((error as RequestAbortedError).service).toBe('backend');
    expect((error as RequestAbortedError).cause).toBe(reason);
    expect((error as RequestAbortedError).message).toBe(
      'GET /api/x was aborted',
    );
    expect(hits).toHaveLength(0);
    expect(auth.headers).not.toHaveBeenCalled();
  });

  test("aborting during the wait between retries rejects within 50 ms with RequestAbortedError whose cause is the signal's reason", async () => {
    fakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const hits = serve('get', `${BACKEND}/api/x`, fail(503), ok());
    const controller = new AbortController();
    const reason = new Error('user left the page');
    const outcome = settle(
      getX(makeTransport(), parseRequestOptions({ signal: controller.signal })),
    );
    await untilSleeping();
    const started = performance.now();
    controller.abort(reason);
    const result = await outcome;
    expect(performance.now() - started).toBeLessThan(50);
    const error = !result.ok ? result.error : undefined;
    expect(error).toBeInstanceOf(RequestAbortedError);
    expect((error as RequestAbortedError).cause).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hits).toHaveLength(1);
  });

  test('aborting during the attempt rejects with RequestAbortedError and is not retried', async () => {
    const hits = serve('get', `${BACKEND}/api/x`, hang, ok());
    const controller = new AbortController();
    const reason = new Error('stop');
    const pending = errorOf(
      getX(
        makeTransport(),
        parseRequestOptions({ signal: controller.signal, retries: 5 }),
      ),
    );
    await until(() => hits.length === 1, 'the request to reach the server');
    controller.abort(reason);
    const error = await pending;
    expect(error).toBeInstanceOf(RequestAbortedError);
    expect(error).not.toBeInstanceOf(TimeoutError);
    expect((error as RequestAbortedError).cause).toBe(reason);
    await tick();
    expect(hits).toHaveLength(1);
  });

  test('aborting while the body is read rejects with RequestAbortedError, not TimeoutError', async () => {
    const fake = fakeFetch(stalledBody);
    const controller = new AbortController();
    const reason = new Error('enough');
    const pending = errorOf(
      getX(
        makeTransport({ fetch: fake.fetch }),
        parseRequestOptions({ signal: controller.signal }),
      ),
    );
    await until(() => fake.inits.length === 1, 'the response head');
    await tick();
    controller.abort(reason);
    const error = await pending;
    expect(error).toBeInstanceOf(RequestAbortedError);
    expect(error).not.toBeInstanceOf(TimeoutError);
    expect(error).not.toBeInstanceOf(TransportError);
    expect((error as RequestAbortedError).cause).toBe(reason);
    expect(fake.inits).toHaveLength(1);
  });

  test('timeout: 100 on a hanging server rejects with TimeoutError after ~100 ms per attempt', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    // The first attempt takes 80 ms and gets a 503; the second one hangs. A timer per attempt
    // lets the first one finish and stops the second 100 ms after it started.
    const hits = serve(
      'get',
      `${BACKEND}/api/x`,
      async () => {
        await delay(80);
        return HttpResponse.json({ error: 'busy' }, { status: 503 });
      },
      hang,
    );
    const controller = new AbortController();
    const started = performance.now();
    const error = await errorOf(
      getX(
        makeTransport(),
        parseRequestOptions({ timeout: 100, signal: controller.signal }),
      ),
    );
    const elapsed = performance.now() - started;
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).not.toBeInstanceOf(RequestAbortedError);
    expect((error as TimeoutError).message).toBe(
      'GET /api/x timed out after 100 ms',
    );
    expect(hits).toHaveLength(2);
    expect(controller.signal.aborted).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(170);
    expect(elapsed).toBeLessThan(2_000);
  });

  test('timeout: false disables the per-attempt timer', async () => {
    serve('get', `${BACKEND}/api/x`, async () => {
      await delay(120);
      return HttpResponse.json({ done: true });
    });
    const t = makeTransport({ defaultTimeoutMs: 30 });
    expect(await getX(t, parseRequestOptions({ timeout: false }))).toEqual({
      done: true,
    });
  });

  test('a per-call timeout overrides the transport default', async () => {
    serve('get', `${BACKEND}/api/x`, async () => {
      await delay(120);
      return HttpResponse.json({ done: true });
    });
    const t = makeTransport({ defaultTimeoutMs: 30 });
    expect(await getX(t, parseRequestOptions({ timeout: 5_000 }))).toEqual({
      done: true,
    });
  });

  test('the transport waits 30 s per attempt by default', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    serve('get', `${BACKEND}/api/x`, ok());
    await makeTransport().request({
      service: 'backend',
      method: 'GET',
      path: '/api/x',
    });
    expect(timeout).toHaveBeenCalledWith(30_000);
  });

  test('a POST marked as a write never retries even with retries: 5', async () => {
    const hits = serve('post', `${BACKEND}/api/x`, fail(503), ok());
    const error = await errorOf(
      makeTransport().request({
        service: 'backend',
        method: 'POST',
        path: '/api/x',
        body: {},
        call: parseRequestOptions({ retries: 5 }),
      }),
    );
    expect(error).toSatisfy(serverFailure);
    expect(hits).toHaveLength(1);

    server.resetHandlers();
    const lost = serve('post', `${BACKEND}/api/x`, networkError, ok());
    const failure = await errorOf(
      makeTransport().request({
        service: 'backend',
        method: 'POST',
        path: '/api/x',
        body: {},
        retry: 'none',
        call: parseRequestOptions({ retries: 5 }),
      }),
    );
    expect(failure).toBeInstanceOf(TransportError);
    expect(lost).toHaveLength(1);
  });

  test('Retry-After of 7 s is not slept: RateLimitError with retryAfter 7000', async () => {
    const hits = serve(
      'get',
      `${BACKEND}/api/x`,
      fail(429, { message: 'slow down' }, { 'Retry-After': '7' }),
      ok(),
    );
    const started = performance.now();
    const error = await errorOf(
      getX(makeTransport(), parseRequestOptions({ retries: 5 })),
    );
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfter).toBe(7_000);
    expect(hits).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('an abort while the auth provider builds the headers is seen once it returns: nothing is sent', async () => {
    const hits = serve('get', `${BACKEND}/api/x`, ok());
    const controller = new AbortController();
    const reason = new Error('stop');
    let release: (() => void) | undefined;
    const auth = makeAuth(undefined, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { 'x-test-sig': 'sig' };
    });
    const pending = errorOf(
      makeTransport({ auth }).request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
        auth: 'backend',
        call: parseRequestOptions({ signal: controller.signal }),
      }),
    );
    await until(() => release !== undefined, 'the auth provider');
    controller.abort(reason);
    // The provider is not cancelled: it may be minting a credential, which is a write.
    await tick();
    release?.();
    const error = await pending;
    expect(error).toBeInstanceOf(RequestAbortedError);
    expect((error as RequestAbortedError).cause).toBe(reason);
    expect(auth.headers).toHaveBeenCalledTimes(1);
    expect(hits).toHaveLength(0);
  });

  test('an abort during the refresh after a 401 is seen once it returns: nothing more is sent', async () => {
    const hits = serve('get', `${BACKEND}/api/x`, fail(401), ok());
    const controller = new AbortController();
    const reason = new Error('stop');
    let release: ((again: boolean) => void) | undefined;
    const auth = makeAuth(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const pending = errorOf(
      makeTransport({ auth }).request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
        auth: 'backend',
        call: parseRequestOptions({ signal: controller.signal }),
      }),
    );
    await until(() => release !== undefined, 'the refresh');
    controller.abort(reason);
    release?.(true);
    const error = await pending;
    expect(error).toBeInstanceOf(RequestAbortedError);
    expect((error as RequestAbortedError).cause).toBe(reason);
    expect(hits).toHaveLength(1);
    expect(auth.headers).toHaveBeenCalledTimes(1);
  });

  test('per-call options built by hand out of range are refused before anything is sent', async () => {
    const hits = serve('get', `${BACKEND}/api/x`, ok());
    for (const call of [
      { timeoutMs: 30_000, retries: 6 },
      { timeoutMs: 30_000, retries: Number.POSITIVE_INFINITY },
      { timeoutMs: 0, retries: 2 },
      { timeoutMs: 2 ** 31, retries: 2 },
      { timeoutMs: true, retries: 2 },
      { timeoutMs: 30_000, retries: 2, signal: { aborted: true } },
      null,
    ]) {
      const error = await errorOf(
        getX(makeTransport(), call as unknown as CallOptions),
      );
      expect(error).toBeInstanceOf(UserInputError);
      expect((error as UserInputError).code).toBe('invalid_request_options');
    }
    expect(hits).toHaveLength(0);
  });

  test('without call, a read keeps the transport defaults', async () => {
    fakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const hits = serve('get', `${BACKEND}/api/x`, fail(503));
    const outcome = await drain(
      makeTransport().request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
        call: undefined,
      }),
    );
    expect(outcome.ok).toBe(false);
    expect(hits).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

describe('responses', () => {
  test('a JSON response is parsed', async () => {
    serve('get', `${BACKEND}/api/x`, ok({ a: [1, 2], b: { c: 'd' } }));
    expect(
      await makeTransport().request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
      }),
    ).toEqual({ a: [1, 2], b: { c: 'd' } });
  });

  test('any content-type containing "json" is parsed', async () => {
    serve('get', `${BACKEND}/api/x`, () =>
      HttpResponse.text('{"a":1}', {
        headers: { 'content-type': 'application/vnd.api+json; charset=utf-8' },
      }),
    );
    expect(
      await makeTransport().request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
      }),
    ).toEqual({ a: 1 });
  });

  test('a plain-text 2xx returns the text (orderbook /time)', async () => {
    serve('get', `${ORDERBOOK}/time`, () => HttpResponse.text('1760000000'));
    expect(
      await makeTransport().request<string>({
        service: 'orderbook',
        method: 'GET',
        path: '/time',
      }),
    ).toBe('1760000000');
  });

  test('a 2xx with an empty body returns undefined', async () => {
    serve(
      'delete',
      `${BACKEND}/api/a`,
      () => new HttpResponse(null, { status: 204 }),
    );
    serve(
      'get',
      `${BACKEND}/api/b`,
      () => new HttpResponse('', { status: 200 }),
    );
    serve(
      'get',
      `${BACKEND}/api/c`,
      () =>
        new HttpResponse('', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const t = makeTransport();
    expect(
      await t.request({ service: 'backend', method: 'DELETE', path: '/api/a' }),
    ).toBeUndefined();
    expect(
      await t.request({ service: 'backend', method: 'GET', path: '/api/b' }),
    ).toBeUndefined();
    expect(
      await t.request({ service: 'backend', method: 'GET', path: '/api/c' }),
    ).toBeUndefined();
  });

  test('a falsy JSON value is returned as is', async () => {
    serve('get', `${BACKEND}/api/x`, () => HttpResponse.json(null));
    expect(
      await makeTransport().request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
      }),
    ).toBeNull();
  });

  test('invalid JSON with a json content-type throws UnexpectedResponseError with issues', async () => {
    serve(
      'get',
      `${BACKEND}/api/x`,
      () =>
        new HttpResponse('{"broken": SECRET-BODY-MARKER', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const error = await errorOf(
      makeTransport().request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
      }),
    );
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    const e = error as UnexpectedResponseError;
    expect(e.service).toBe('backend');
    expect(e.status).toBe(200);
    expect(Array.isArray(e.issues)).toBe(true);
    expect((e.issues as unknown[]).length).toBeGreaterThan(0);
    // The raw body never goes onto the error.
    expect(dump(e)).not.toContain('SECRET-BODY-MARKER');
  });

  test('a non-JSON error body still maps by status', async () => {
    serve('get', `${ORDERBOOK}/a`, () =>
      HttpResponse.text('Not Found', { status: 404 }),
    );
    serve('get', `${ORDERBOOK}/b`, () =>
      HttpResponse.text('<html>Bad Gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );
    serve(
      'post',
      `${ORDERBOOK}/c`,
      () => new HttpResponse(null, { status: 400 }),
    );
    const t = makeTransport({ maxRetries: 0 });

    const notFound = await errorOf(
      t.request({ service: 'orderbook', method: 'GET', path: '/a' }),
    );
    expect(notFound).toSatisfy(rejectedWith(404));
    expect((notFound as RequestRejectedError).status).toBe(404);
    expect((notFound as RequestRejectedError).service).toBe('orderbook');

    const badGateway = await errorOf(
      t.request({ service: 'orderbook', method: 'GET', path: '/b' }),
    );
    expect(badGateway).toSatisfy(serverFailure);
    expect((badGateway as RequestRejectedError).status).toBe(502);

    const bad = await errorOf(
      t.request({ service: 'orderbook', method: 'POST', path: '/c', body: {} }),
    );
    expect(bad).toSatisfy(rejectedWith(400));
  });

  test('error bodies are parsed by service: code, message and correlation id', async () => {
    serve('get', `${BACKEND}/api/x`, () =>
      HttpResponse.json(
        {
          statusCode: 403,
          response: { error: 'frontend_only', message: 'not for api keys' },
        },
        { status: 403, headers: { 'x-correlation-id': 'corr-1' } },
      ),
    );
    const error = (await errorOf(
      makeTransport().request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
      }),
    )) as XoError;
    expect(error.name).toBe('RequestRejectedError');
    expect(error.status).toBe(403);
    expect(error.code).toBe('frontend_only');
    expect(error.message).toBe('not for api keys');
    expect(error.requestId).toBe('corr-1');
    expect(error.service).toBe('backend');
  });

  test('the sponsor service name goes onto its errors', async () => {
    serve('post', `${SPONSOR}/sponsor`, () =>
      HttpResponse.json(
        { error: { code: 'not_eligible', message: 'no' } },
        { status: 422 },
      ),
    );
    const error = (await errorOf(
      makeTransport().request({
        service: 'sponsor',
        method: 'POST',
        path: '/sponsor',
        body: {},
      }),
    )) as XoError;
    expect(error).toSatisfy(rejectedWith(422));
    expect(error.code).toBe('not_eligible');
    expect(error.service).toBe('sponsor');
  });
});

// ---------------------------------------------------------------------------
// No secret leaks
// ---------------------------------------------------------------------------

describe('secrets', () => {
  const AUTH_VALUE = 'Bearer SUPER-SECRET-authorization-value';
  const BODY_SECRET = 'body-secret-value-123';
  const QUERY_SECRET = 'query-secret-value-456';

  function leakyAuth(): AuthStub {
    return makeAuth(undefined, async () => ({
      Authorization: AUTH_VALUE,
      'X-XO-Signature': 'sig-secret-789',
    }));
  }

  function expectNoLeak(error: unknown): void {
    const text = dump(error);
    expect(text).not.toContain('SUPER-SECRET');
    expect(text).not.toContain(AUTH_VALUE);
    expect(text).not.toContain('sig-secret-789');
    expect(text).not.toContain(BODY_SECRET);
    expect(text).not.toContain(QUERY_SECRET);
  }

  const post = (t: Transport, signal?: AbortSignal, timeoutMs?: number) =>
    t.request({
      service: 'backend',
      method: 'POST',
      path: '/api/x',
      query: { token: QUERY_SECRET },
      body: { secret: BODY_SECRET },
      auth: 'backend',
      signal,
      timeoutMs,
    });

  test('error messages never contain the Authorization header value', async () => {
    serve('post', `${BACKEND}/api/x`, fail(500, { error: 'boom' }));
    const error = await errorOf(post(makeTransport({ auth: leakyAuth() })));
    expect(error).toSatisfy(serverFailure);
    expectNoLeak(error);
  });

  test('a rejected request (401 twice) leaks nothing', async () => {
    serve('post', `${BACKEND}/api/x`, fail(401, {}));
    const error = await errorOf(post(makeTransport({ auth: leakyAuth() })));
    expect(error).toSatisfy(rejectedWith(401));
    expectNoLeak(error);
  });

  test('a network error leaks nothing', async () => {
    serve('post', `${BACKEND}/api/x`, networkError);
    const error = await errorOf(post(makeTransport({ auth: leakyAuth() })));
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).message).toContain('POST');
    expect((error as TransportError).message).toContain('/api/x');
    expectNoLeak(error);
  });

  test('a body-read failure leaks nothing', async () => {
    const fake = fakeFetch(droppedBody, 200);
    const error = await errorOf(
      post(makeTransport({ auth: leakyAuth(), fetch: fake.fetch })),
    );
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).message).toContain(
      'response 200 received',
    );
    expectNoLeak(error);
  });

  test('a rejected path or body leaks no query', async () => {
    for (const request of [
      { method: 'GET', path: `/api/x?token=${QUERY_SECRET}` },
      { method: 'GET', path: `api/x?token=${QUERY_SECRET}` },
      { method: 'GET', path: '/api/x#frag', body: { secret: BODY_SECRET } },
    ] as const) {
      const error = await errorOf(
        makeTransport({ auth: leakyAuth() }).request({
          service: 'backend',
          auth: 'backend',
          ...request,
        }),
      );
      expect(error).toBeInstanceOf(UserInputError);
      expectNoLeak(error);
    }
  });

  test('a timeout leaks nothing', async () => {
    serve('post', `${BACKEND}/api/x`, hang);
    const error = await errorOf(
      post(makeTransport({ auth: leakyAuth() }), undefined, 30),
    );
    expect(error).toBeInstanceOf(TimeoutError);
    expectNoLeak(error);
  });

  test('a caller abort leaks nothing', async () => {
    const hits = serve('post', `${BACKEND}/api/x`, hang);
    const controller = new AbortController();
    const pending = errorOf(
      post(makeTransport({ auth: leakyAuth() }), controller.signal),
    );
    await until(() => hits.length === 1, 'the request to reach the server');
    controller.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(RequestAbortedError);
    expectNoLeak(error);
  });

  test('invalid JSON from the server leaks nothing', async () => {
    serve(
      'post',
      `${BACKEND}/api/x`,
      () =>
        new HttpResponse('nope', {
          headers: { 'content-type': 'application/json' },
        }),
    );
    const error = await errorOf(post(makeTransport({ auth: leakyAuth() })));
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expectNoLeak(error);
  });

  test('a body that cannot be serialized leaks nothing', async () => {
    const circular: Record<string, unknown> = { secret: BODY_SECRET };
    circular.self = circular;
    const error = await errorOf(
      makeTransport({ auth: leakyAuth() }).request({
        service: 'backend',
        method: 'POST',
        path: '/api/x',
        query: { token: QUERY_SECRET },
        body: circular,
        auth: 'backend',
      }),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expectNoLeak(error);
  });

  test('an API key the server echoes back is redacted from the error', async () => {
    serve(
      'get',
      `${BACKEND}/api/x`,
      fail(400, { message: 'bad key xo_sk_abc_def' }),
    );
    const error = await errorOf(
      makeTransport().request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
      }),
    );
    expect(dump(error)).not.toContain('xo_sk_abc_def');
  });
});

// ---------------------------------------------------------------------------
// Option validation
// ---------------------------------------------------------------------------

describe('option validation', () => {
  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'timeoutMs %s is a UserInputError and sends nothing',
    async (timeoutMs) => {
      const hits = serve('get', `${BACKEND}/api/x`, ok());
      const error = await errorOf(
        makeTransport().request({
          service: 'backend',
          method: 'GET',
          path: '/api/x',
          timeoutMs,
        }),
      );
      expect(error).toBeInstanceOf(UserInputError);
      expect(hits).toHaveLength(0);
    },
  );

  test('the constructor rejects a bad defaultTimeoutMs or maxRetries', () => {
    expect(() => makeTransport({ defaultTimeoutMs: 0 })).toThrow(
      UserInputError,
    );
    expect(() => makeTransport({ defaultTimeoutMs: Number.NaN })).toThrow(
      UserInputError,
    );
    expect(() => makeTransport({ maxRetries: -1 })).toThrow(UserInputError);
    expect(() => makeTransport({ maxRetries: 1.5 })).toThrow(UserInputError);
  });
});

// ---------------------------------------------------------------------------
// An explicit backend key
// ---------------------------------------------------------------------------

describe('explicit backend key', () => {
  const KEY = 'xo_sk_data_TESTKEYabc_0123456789abcdef';
  const explicit = { kind: 'backend', key: KEY } as const;

  const get = (t: Transport, auth: TransportRequest['auth'] = explicit) =>
    t.request({ service: 'backend', method: 'GET', path: '/api/x', auth });

  test('sends Authorization: Bearer <key> and the usual headers', async () => {
    const hits = serve('get', `${BACKEND}/api/x`, ok());
    await get(makeTransport());
    expect(hits).toHaveLength(1);
    expect(hits[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(hits[0]?.headers.get('x-xo-sdk')).toBe('ts/9.9.9');
  });

  test('works with a body and a non-GET method', async () => {
    const hits = serve('post', `${BACKEND}/api/x`, ok());
    await makeTransport().request({
      service: 'backend',
      method: 'POST',
      path: '/api/x',
      body: { a: 1 },
      auth: explicit,
    });
    expect(hits[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(hits[0]?.body).toBe('{"a":1}');
  });

  test('needs no AuthProvider on the transport', async () => {
    const hits = serve('get', `${BACKEND}/api/x`, ok());
    await expect(get(makeTransport())).resolves.toEqual({ ok: true });
    expect(hits).toHaveLength(1);
  });

  test('never consults the AuthProvider, and adds none of its headers', async () => {
    const hits = serve('get', `${BACKEND}/api/x`, ok());
    const auth = makeAuth();
    await get(makeTransport({ auth }));
    expect(auth.headers).not.toHaveBeenCalled();
    expect(auth.onUnauthorized).not.toHaveBeenCalled();
    expect(hits[0]?.headers.get('x-test-sig')).toBeNull();
    expect(hits[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
  });

  test('a 401 is a plain 401 rejection: one hit, no refresh, no provider call', async () => {
    const hits = serve('get', `${BACKEND}/api/x`, fail(401, {}));
    const auth = makeAuth();
    const error = await errorOf(get(makeTransport({ auth })));
    expect(error).toSatisfy(rejectedWith(401));
    expect((error as RequestRejectedError).status).toBe(401);
    expect(hits).toHaveLength(1);
    expect(auth.onUnauthorized).not.toHaveBeenCalled();
    expect(auth.headers).not.toHaveBeenCalled();
  });

  test('a 401 without any provider is the same 401 rejection, not AuthRequiredError', async () => {
    const hits = serve('get', `${BACKEND}/api/x`, fail(401, {}));
    const error = await errorOf(get(makeTransport()));
    expect(error).toSatisfy(rejectedWith(401));
    expect(error).not.toBeInstanceOf(AuthRequiredError);
    expect(hits).toHaveLength(1);
  });

  test('keeps the retry policy of the method: a GET is retried with the same key, a POST is not', async () => {
    fakeTimers();
    const getHits = serve('get', `${BACKEND}/api/x`, fail(503), ok());
    const read = await drain(get(makeTransport()));
    expect(read.ok).toBe(true);
    expect(getHits).toHaveLength(2);
    for (const hit of getHits) {
      expect(hit.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    }

    const postHits = serve('post', `${BACKEND}/api/x`, fail(503));
    const write = await drain(
      makeTransport().request({
        service: 'backend',
        method: 'POST',
        path: '/api/x',
        auth: explicit,
      }),
    );
    expect(!write.ok && write.error).toSatisfy(serverFailure);
    expect(postHits).toHaveLength(1);
  });

  test("a DELETE with retry: 'read' is retried with the same key", async () => {
    fakeTimers();
    const hits = serve('delete', `${BACKEND}/api/x`, fail(503), ok());
    const outcome = await drain(
      makeTransport().request({
        service: 'backend',
        method: 'DELETE',
        path: '/api/x',
        auth: explicit,
        retry: 'read',
      }),
    );
    expect(outcome.ok).toBe(true);
    expect(hits).toHaveLength(2);
    expect(hits[1]?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
  });

  test.each(['orderbook', 'sponsor'] as const)(
    'is refused for the %s service, before any request',
    async (service) => {
      const hits = serve('get', `${ORDERBOOK}/api/x`, ok());
      serve('get', `${SPONSOR}/api/x`, ok());
      const error = await errorOf(
        makeTransport().request({
          service,
          method: 'GET',
          path: '/api/x',
          auth: explicit,
        }),
      );
      expect(error).toBeInstanceOf(UserInputError);
      expect(hits).toHaveLength(0);
      expect(dump(error)).not.toContain(KEY);
      expect(dump(error)).not.toContain('TESTKEY');
    },
  );

  test.each([
    ['no prefix', 'TESTKEY-no-prefix-secret'],
    ['the wrong prefix', 'sk_live_TESTKEY-wrong-secret'],
    ['only the prefix', 'xo_sk_'],
    ['a space', 'xo_sk_data_TESTKEY secret'],
    ['a leading space', ' xo_sk_data_TESTKEY-secret'],
    ['a trailing newline', 'xo_sk_data_TESTKEY-secret\n'],
    ['a carriage return', 'xo_sk_data_TESTKEY\r-secret'],
    ['a tab', 'xo_sk_data_TESTKEY\t-secret'],
    ['a NUL', 'xo_sk_data_TESTKEY\u0000-secret'],
    ['a DEL', 'xo_sk_data_TESTKEY\u007f-secret'],
    ['a non-ASCII character', 'xo_sk_data_TESTKEY-é-secret'],
    ['an empty string', ''],
    ['a number', 12345],
    ['undefined', undefined],
  ])('rejects a key with %s without echoing it', async (_label, key) => {
    const hits = serve('get', `${BACKEND}/api/x`, ok());
    const auth = makeAuth();
    const error = await errorOf(
      get(makeTransport({ auth }), {
        kind: 'backend',
        key,
      } as unknown as TransportRequest['auth']),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect(hits).toHaveLength(0);
    expect(auth.headers).not.toHaveBeenCalled();
    const text = dump(error);
    expect(text).not.toContain('TESTKEY');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('12345');
  });

  test.each([
    ['an orderbook kind', { kind: 'orderbook', key: KEY }],
    ['a missing key', { kind: 'backend' }],
    ['null', null],
    ['an array', [KEY]],
    ['a number', 7],
  ])('rejects an auth option that is %s', async (_label, option) => {
    const hits = serve('get', `${BACKEND}/api/x`, ok());
    const error = await errorOf(
      get(makeTransport({ auth: makeAuth() }), option as never),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect(hits).toHaveLength(0);
    expect(dump(error)).not.toContain('TESTKEY');
  });

  test('the string kinds still go through the provider (unchanged)', async () => {
    const hits = serve('get', `${BACKEND}/api/x`, ok());
    const auth = makeAuth();
    await get(makeTransport({ auth }), 'backend');
    expect(auth.headers).toHaveBeenCalledTimes(1);
    expect(hits[0]?.headers.get('x-test-sig')).toBe('sig-1');
    expect(hits[0]?.headers.get('authorization')).toBeNull();
  });

  describe('the key never leaks', () => {
    function expectNoLeak(error: unknown): void {
      const text = dump(error);
      expect(text).not.toContain(KEY);
      expect(text).not.toContain('TESTKEYabc');
      expect(text).not.toContain('0123456789abcdef');
      expect(inspect(error, { depth: null, showHidden: true })).not.toContain(
        'TESTKEYabc',
      );
    }

    test('a server error', async () => {
      serve('get', `${BACKEND}/api/x`, fail(500, { error: 'boom' }));
      const error = await errorOf(get(makeTransport({ maxRetries: 0 })));
      expect(error).toSatisfy(serverFailure);
      expectNoLeak(error);
    });

    test('a server that echoes the key back', async () => {
      serve(
        'get',
        `${BACKEND}/api/x`,
        fail(401, { message: `bad key ${KEY}`, error: 'invalid_credentials' }),
      );
      const error = await errorOf(get(makeTransport()));
      expect(error).toSatisfy(rejectedWith(401));
      expectNoLeak(error);
    });

    test('a network error', async () => {
      serve('get', `${BACKEND}/api/x`, networkError);
      const error = await errorOf(get(makeTransport({ maxRetries: 0 })));
      expect(error).toBeInstanceOf(TransportError);
      expectNoLeak(error);
    });

    test('a timeout', async () => {
      serve('get', `${BACKEND}/api/x`, hang);
      const error = await errorOf(
        makeTransport().request({
          service: 'backend',
          method: 'GET',
          path: '/api/x',
          auth: explicit,
          timeoutMs: 30,
        }),
      );
      expect(error).toBeInstanceOf(TimeoutError);
      expectNoLeak(error);
    });

    test('a body-read failure', async () => {
      const fake = fakeFetch(droppedBody, 200);
      const error = await errorOf(
        get(makeTransport({ fetch: fake.fetch, maxRetries: 0 })),
      );
      expect(error).toBeInstanceOf(TransportError);
      expectNoLeak(error);
    });

    test('a caller abort', async () => {
      const hits = serve('get', `${BACKEND}/api/x`, hang);
      const controller = new AbortController();
      const pending = errorOf(
        makeTransport().request({
          service: 'backend',
          method: 'GET',
          path: '/api/x',
          auth: explicit,
          signal: controller.signal,
        }),
      );
      await until(() => hits.length === 1, 'the request to reach the server');
      controller.abort();
      const error = await pending;
      expect(error).toBeInstanceOf(RequestAbortedError);
      expectNoLeak(error);
    });

    test('a rejected path and a rejected body', async () => {
      for (const request of [
        { method: 'GET', path: '/api/x?token=1' },
        { method: 'GET', path: 'api/x' },
        { method: 'GET', path: '/api/x', body: { a: 1 } },
      ] as const) {
        const error = await errorOf(
          makeTransport().request({
            service: 'backend',
            auth: explicit,
            ...request,
          }),
        );
        expect(error).toBeInstanceOf(UserInputError);
        expectNoLeak(error);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Explicit orderbook L1 headers
// ---------------------------------------------------------------------------

describe('explicit orderbook L1 headers', () => {
  // '5a' repeated is a marker: no error, message, JSON or inspect output may contain it.
  const SIGNATURE = `0x${'5a'.repeat(64)}1b`;
  const MARKER = '5a5a5a5a';
  const ADDRESS = '0x14791697260E4c9A71f18484C9f997B308e59325';
  const NAMES = [
    'XO_ADDRESS',
    'XO_SIGNATURE',
    'XO_TIMESTAMP',
    'XO_NONCE',
  ] as const;
  const L1: Record<(typeof NAMES)[number], string> = {
    XO_ADDRESS: ADDRESS,
    XO_SIGNATURE: SIGNATURE,
    XO_TIMESTAMP: '1700000000',
    XO_NONCE: '0',
  };
  const explicit = { kind: 'orderbookL1', headers: L1 } as const;
  const URL_X = `${ORDERBOOK}/auth/x`;

  const get = (t: Transport, auth: TransportRequest['auth'] = explicit) =>
    t.request({ service: 'orderbook', method: 'GET', path: '/auth/x', auth });

  function expectL1(hit: Hit | undefined, expected = L1): void {
    for (const name of NAMES) {
      expect(hit?.headers.get(name)).toBe(expected[name]);
    }
  }

  test('sends the four L1 headers and the usual headers', async () => {
    const hits = serve('get', URL_X, ok());
    await get(makeTransport());
    expect(hits).toHaveLength(1);
    expectL1(hits[0]);
    expect(hits[0]?.headers.get('x-xo-sdk')).toBe('ts/9.9.9');
    expect(hits[0]?.headers.get('accept')).toBe('application/json');
    expect(hits[0]?.headers.get('authorization')).toBeNull();
  });

  test('works for a POST with no body, and sends no content type', async () => {
    const hits = serve('post', URL_X, ok());
    await makeTransport().request({
      service: 'orderbook',
      method: 'POST',
      path: '/auth/x',
      auth: explicit,
    });
    expectL1(hits[0]);
    expect(hits[0]?.body).toBe('');
    expect(hits[0]?.headers.get('content-type')).toBeNull();
  });

  test('works for a POST with a body', async () => {
    const hits = serve('post', URL_X, ok());
    await makeTransport().request({
      service: 'orderbook',
      method: 'POST',
      path: '/auth/x',
      body: { a: 1 },
      auth: explicit,
    });
    expectL1(hits[0]);
    expect(hits[0]?.body).toBe('{"a":1}');
  });

  test('keeps the query', async () => {
    const hits = serve('get', URL_X, ok());
    await makeTransport().request({
      service: 'orderbook',
      method: 'GET',
      path: '/auth/x',
      query: { page: 2 },
      auth: explicit,
    });
    expect(hits[0]?.url.search).toBe('?page=2');
    expectL1(hits[0]);
  });

  test('needs no AuthProvider on the transport', async () => {
    const hits = serve('get', URL_X, ok());
    await expect(get(makeTransport())).resolves.toEqual({ ok: true });
    expect(hits).toHaveLength(1);
  });

  test('never consults the AuthProvider, and adds none of its headers', async () => {
    const hits = serve('get', URL_X, ok());
    const auth = makeAuth();
    await get(makeTransport({ auth }));
    expect(auth.headers).not.toHaveBeenCalled();
    expect(auth.onUnauthorized).not.toHaveBeenCalled();
    expect(hits[0]?.headers.get('x-test-sig')).toBeNull();
    expectL1(hits[0]);
  });

  test('a 401 is a plain 401 rejection: one hit, no refresh, no provider call', async () => {
    const hits = serve(
      'get',
      URL_X,
      fail(401, { error: 'L1 signature invalid' }),
    );
    const auth = makeAuth();
    const error = await errorOf(get(makeTransport({ auth })));
    expect(error).toSatisfy(rejectedWith(401));
    expect((error as RequestRejectedError).status).toBe(401);
    expect((error as RequestRejectedError).service).toBe('orderbook');
    expect(hits).toHaveLength(1);
    expect(auth.onUnauthorized).not.toHaveBeenCalled();
    expect(auth.headers).not.toHaveBeenCalled();
  });

  test('a 401 without any provider is the same 401 rejection, not AuthRequiredError', async () => {
    const hits = serve(
      'get',
      URL_X,
      fail(401, { error: 'L1 signature invalid' }),
    );
    const error = await errorOf(get(makeTransport()));
    expect(error).toSatisfy(rejectedWith(401));
    expect(error).not.toBeInstanceOf(AuthRequiredError);
    expect(hits).toHaveLength(1);
  });

  test('keeps the retry policy of the method: a GET is retried with the same four headers each time, a POST is not', async () => {
    fakeTimers();
    const getHits = serve('get', URL_X, fail(503), fail(503), ok());
    const read = await drain(get(makeTransport()));
    expect(read.ok).toBe(true);
    expect(getHits).toHaveLength(3);
    for (const hit of getHits) {
      expectL1(hit);
    }

    const postHits = serve('post', URL_X, fail(503));
    const write = await drain(
      makeTransport().request({
        service: 'orderbook',
        method: 'POST',
        path: '/auth/x',
        auth: explicit,
      }),
    );
    expect(!write.ok && write.error).toSatisfy(serverFailure);
    expect(postHits).toHaveLength(1);
  });

  test("a GET with retry: 'none' is not retried", async () => {
    const hits = serve('get', URL_X, fail(503));
    const error = await errorOf(
      makeTransport().request({
        service: 'orderbook',
        method: 'GET',
        path: '/auth/x',
        auth: explicit,
        retry: 'none',
      }),
    );
    expect(error).toSatisfy(serverFailure);
    expect(hits).toHaveLength(1);
  });

  test('reads the headers once: changing the object during a retry changes nothing', async () => {
    fakeTimers();
    const mutable = { ...L1 };
    const hits = serve(
      'get',
      URL_X,
      () => {
        mutable.XO_TIMESTAMP = '1700000999';
        mutable.XO_SIGNATURE = '0xchanged';
        return HttpResponse.json({}, { status: 503 });
      },
      ok(),
    );
    const outcome = await drain(
      get(makeTransport(), { kind: 'orderbookL1', headers: mutable }),
    );
    expect(outcome.ok).toBe(true);
    expect(hits).toHaveLength(2);
    expectL1(hits[0]);
    expectL1(hits[1]);
  });

  test.each(['backend', 'sponsor'] as const)(
    'is refused for the %s service, before any request',
    async (service) => {
      const backend = serve('get', `${BACKEND}/api/x`, ok());
      const sponsor = serve('get', `${SPONSOR}/api/x`, ok());
      const error = await errorOf(
        makeTransport().request({
          service,
          method: 'GET',
          path: '/api/x',
          auth: explicit,
        }),
      );
      expect(error).toBeInstanceOf(UserInputError);
      expect(backend).toHaveLength(0);
      expect(sponsor).toHaveLength(0);
      expect(dump(error)).not.toContain(MARKER);
      expect(dump(error)).not.toContain(ADDRESS);
    },
  );

  test.each([
    ['a space inside', 'ab cd'],
    ['a leading space', ' abcd'],
    ['a trailing space', 'abcd '],
    ['a trailing newline', 'abcd\n'],
    ['a carriage return', 'ab\rcd'],
    ['a tab', 'ab\tcd'],
    ['a NUL', 'ab\u0000cd'],
    ['a DEL', 'ab\u007fcd'],
    ['a non-ASCII character', 'abécd'],
    ['an empty string', ''],
    ['a number', 12345],
    ['null', null],
    ['undefined', undefined],
  ])(
    'rejects a value with %s, in every header, without echoing it',
    async (_label, bad) => {
      for (const name of NAMES) {
        const hits = serve('get', URL_X, ok());
        const auth = makeAuth();
        // The valid values carry the marker, so a message that echoed any of them is caught.
        const headers = { ...L1, [name]: bad };
        const error = await errorOf(
          get(makeTransport({ auth }), {
            kind: 'orderbookL1',
            headers,
          } as unknown as TransportRequest['auth']),
        );
        expect(error).toBeInstanceOf(UserInputError);
        expect(hits).toHaveLength(0);
        expect(auth.headers).not.toHaveBeenCalled();
        const text = dump(error);
        expect(text).not.toContain(MARKER);
        expect(text).not.toContain(ADDRESS);
        expect(text).not.toContain('abcd');
        expect(text).not.toContain('12345');
      }
    },
  );

  test.each([
    ['a missing XO_ADDRESS', { ...L1, XO_ADDRESS: undefined }],
    ['an extra header', { ...L1, XO_API_KEY: 'k' }],
    [
      'lower-case names',
      {
        xo_address: ADDRESS,
        xo_signature: SIGNATURE,
        xo_timestamp: '1',
        xo_nonce: '0',
      },
    ],
    ['an array', [ADDRESS, SIGNATURE, '1', '0']],
    ['null', null],
    ['a string', SIGNATURE],
    ['no value', undefined],
    ['inherited values only', Object.create(L1) as object],
    ['an empty object', {}],
  ])('rejects headers that are %s', async (_label, headers) => {
    const hits = serve('get', URL_X, ok());
    const auth = makeAuth();
    const error = await errorOf(
      get(makeTransport({ auth }), {
        kind: 'orderbookL1',
        headers,
      } as unknown as TransportRequest['auth']),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect(hits).toHaveLength(0);
    expect(auth.headers).not.toHaveBeenCalled();
    expect(dump(error)).not.toContain(MARKER);
  });

  test('rejects each of the four headers when it is missing', async () => {
    for (const name of NAMES) {
      const hits = serve('get', URL_X, ok());
      const headers: Record<string, string> = { ...L1 };
      delete headers[name];
      const error = await errorOf(
        get(makeTransport(), {
          kind: 'orderbookL1',
          headers,
        } as unknown as TransportRequest['auth']),
      );
      expect(error).toBeInstanceOf(UserInputError);
      expect(hits).toHaveLength(0);
    }
  });

  test('the string kind "orderbook" still goes through the provider (unchanged)', async () => {
    const hits = serve('get', URL_X, ok());
    const auth = makeAuth();
    await get(makeTransport({ auth }), 'orderbook');
    expect(auth.headers).toHaveBeenCalledTimes(1);
    expect(hits[0]?.headers.get('x-test-sig')).toBe('sig-1');
    expect(hits[0]?.headers.get('xo_signature')).toBeNull();
  });

  test('a malformed auth object still names the options and nothing else', async () => {
    const error = await errorOf(
      get(makeTransport(), { kind: 'orderbookL2' } as never),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as Error).message).toContain('orderbookL1');
  });

  describe('the signature never leaks', () => {
    function expectNoLeak(error: unknown): void {
      const text = dump(error);
      expect(text).not.toContain(SIGNATURE);
      expect(text).not.toContain(MARKER);
      expect(inspect(error, { depth: null, showHidden: true })).not.toContain(
        MARKER,
      );
    }

    test('a server error', async () => {
      serve('get', URL_X, fail(500, { error: 'boom' }));
      const error = await errorOf(get(makeTransport({ maxRetries: 0 })));
      expect(error).toSatisfy(serverFailure);
      expectNoLeak(error);
    });

    test('a 401', async () => {
      serve('get', URL_X, fail(401, { error: 'L1 signature invalid' }));
      const error = await errorOf(get(makeTransport()));
      expect(error).toSatisfy(rejectedWith(401));
      expectNoLeak(error);
    });

    test('a network error', async () => {
      serve('get', URL_X, networkError);
      const error = await errorOf(get(makeTransport({ maxRetries: 0 })));
      expect(error).toBeInstanceOf(TransportError);
      expectNoLeak(error);
    });

    test('a timeout', async () => {
      serve('get', URL_X, hang);
      const error = await errorOf(
        makeTransport().request({
          service: 'orderbook',
          method: 'GET',
          path: '/auth/x',
          auth: explicit,
          timeoutMs: 30,
        }),
      );
      expect(error).toBeInstanceOf(TimeoutError);
      expectNoLeak(error);
    });

    test('a body-read failure', async () => {
      const fake = fakeFetch(droppedBody, 200);
      const error = await errorOf(
        get(makeTransport({ fetch: fake.fetch, maxRetries: 0 })),
      );
      expect(error).toBeInstanceOf(TransportError);
      expectNoLeak(error);
    });

    test('a caller abort', async () => {
      const hits = serve('get', URL_X, hang);
      const controller = new AbortController();
      const pending = errorOf(
        makeTransport().request({
          service: 'orderbook',
          method: 'GET',
          path: '/auth/x',
          auth: explicit,
          signal: controller.signal,
        }),
      );
      await until(() => hits.length === 1, 'the request to reach the server');
      controller.abort();
      const error = await pending;
      expect(error).toBeInstanceOf(RequestAbortedError);
      expectNoLeak(error);
    });

    test('a rejected path and a rejected body', async () => {
      for (const request of [
        { method: 'GET', path: '/auth/x?token=1' },
        { method: 'GET', path: 'auth/x' },
        { method: 'GET', path: '/auth/x', body: { a: 1 } },
      ] as const) {
        const error = await errorOf(
          makeTransport().request({
            service: 'orderbook',
            auth: explicit,
            ...request,
          }),
        );
        expect(error).toBeInstanceOf(UserInputError);
        expectNoLeak(error);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Explicit orderbook L2 headers
// ---------------------------------------------------------------------------

describe('explicit orderbook L2 headers', () => {
  const MARKER = 'L2SECRETMARKER';
  const URL_K = `${ORDERBOOK}/auth/api-key`;
  type L2 = Record<
    'XO_API_KEY' | 'XO_PASSPHRASE' | 'XO_TIMESTAMP' | 'XO_SIGNATURE',
    string
  >;

  /** A signer of L2 headers that numbers its signatures and records what it signed. */
  function l2Signer() {
    const signed: Array<{ method: string; path: string; body: string }> = [];
    const sign = vi.fn(
      async (req: {
        method: string;
        path: string;
        body: string;
      }): Promise<L2> => {
        signed.push(req);
        return {
          XO_API_KEY: 'key-1',
          XO_PASSPHRASE: `pass-${MARKER}`,
          XO_TIMESTAMP: String(1_700_000_000 + signed.length),
          XO_SIGNATURE: `sig-${signed.length}`,
        };
      },
    );
    return { sign, signed };
  }

  const del = (
    t: Transport,
    sign: (req: { method: string; path: string; body: string }) => Promise<L2>,
    o: Partial<InternalTransportRequest> = {},
  ) =>
    t.request({
      service: 'orderbook',
      method: 'DELETE',
      path: '/auth/api-key',
      body: { apiKey: 'key-1' },
      auth: { kind: 'orderbookL2', sign },
      ...o,
    });

  test('sends the headers it signs over the exact method, path and body that are sent', async () => {
    const hits = serve('delete', URL_K, ok({ deleted: true }));
    const { sign, signed } = l2Signer();
    await expect(del(makeTransport(), sign)).resolves.toEqual({
      deleted: true,
    });
    expect(signed).toEqual([
      { method: 'DELETE', path: '/auth/api-key', body: '{"apiKey":"key-1"}' },
    ]);
    expect(hits[0]?.body).toBe('{"apiKey":"key-1"}');
    expect(hits[0]?.headers.get('XO_API_KEY')).toBe('key-1');
    expect(hits[0]?.headers.get('XO_SIGNATURE')).toBe('sig-1');
    expect(hits[0]?.headers.get('XO_TIMESTAMP')).toBe('1700000001');
  });

  test('signs afresh for each attempt of a request retried like a read', async () => {
    const hits = serve(
      'delete',
      URL_K,
      fail(503, { error: 'busy' }),
      ok({ deleted: true }),
    );
    const { sign } = l2Signer();
    await del(makeTransport(), sign, { retry: 'read' });
    expect(sign).toHaveBeenCalledTimes(2);
    expect(hits.map((h) => h.headers.get('XO_SIGNATURE'))).toEqual([
      'sig-1',
      'sig-2',
    ]);
  });

  test('never consults the AuthProvider: a 401 is a plain rejection, with no refresh', async () => {
    const hits = serve(
      'delete',
      URL_K,
      fail(401, { error: 'unknown API key' }),
    );
    const auth = makeAuth();
    const { sign } = l2Signer();
    const error = await errorOf(del(makeTransport({ auth }), sign));
    expect(error).toSatisfy(rejectedWith(401));
    expect(hits).toHaveLength(1);
    expect(auth.headers).not.toHaveBeenCalled();
    expect(auth.onUnauthorized).not.toHaveBeenCalled();
    expect(hits[0]?.headers.get('x-test-sig')).toBeNull();
  });

  test('only for the orderbook service: refused for the backend, before anything is signed or sent', async () => {
    const hits = serve('delete', `${env.backendUrl}/auth/api-key`, ok());
    const { sign } = l2Signer();
    const error = await errorOf(
      del(makeTransport(), sign, { service: 'backend' }),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect(sign).not.toHaveBeenCalled();
    expect(hits).toHaveLength(0);
  });

  test.each([
    [
      'a missing header',
      { XO_API_KEY: 'k', XO_PASSPHRASE: 'p', XO_TIMESTAMP: '1' },
    ],
    [
      'an extra header',
      {
        XO_API_KEY: 'k',
        XO_PASSPHRASE: 'p',
        XO_TIMESTAMP: '1',
        XO_SIGNATURE: 's',
        XO_ADDRESS: 'a',
      },
    ],
    [
      'a value with whitespace',
      {
        XO_API_KEY: 'k',
        XO_PASSPHRASE: `p ${MARKER}`,
        XO_TIMESTAMP: '1',
        XO_SIGNATURE: 's',
      },
    ],
    ['not an object', null],
  ])(
    'headers with %s are refused, nothing is sent, and no value is repeated',
    async (_, headers) => {
      const hits = serve('delete', URL_K, ok());
      const error = await errorOf(
        del(makeTransport(), async () => headers as unknown as L2),
      );
      expect(error).toBeInstanceOf(UserInputError);
      expect(wasNotSent(error)).toBe(true);
      expect(dump(error)).not.toContain(MARKER);
      expect(hits).toHaveLength(0);
    },
  );

  test('a signer that throws: its error, and nothing is sent', async () => {
    const hits = serve('delete', URL_K, ok());
    const failure = new Error('no key');
    const error = await errorOf(
      del(makeTransport(), async () => {
        throw failure;
      }),
    );
    expect(error).toBe(failure);
    expect(hits).toHaveLength(0);
  });

  test('an auth object without a sign function names the forms, and nothing else', async () => {
    const error = await errorOf(
      makeTransport().request({
        service: 'orderbook',
        method: 'DELETE',
        path: '/auth/api-key',
        auth: { kind: 'orderbookL2', sign: MARKER } as never,
      }),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as Error).message).toContain('orderbookL2');
    expect((error as Error).message).not.toContain(MARKER);
  });
});

// ---------------------------------------------------------------------------
// Credentials are only sent over a safe URL
// ---------------------------------------------------------------------------

describe('credentials need a safe URL', () => {
  const KEY = 'xo_sk_data_TESTKEYabc_0123456789abcdef';
  const L1 = {
    XO_ADDRESS: '0x14791697260E4c9A71f18484C9f997B308e59325',
    XO_SIGNATURE: `0x${'5a'.repeat(64)}1b`,
    XO_TIMESTAMP: '1700000000',
    XO_NONCE: '0',
  };
  type Form = [
    label: string,
    service: TransportRequest['service'],
    auth: InternalTransportRequest['auth'],
  ];
  const FORMS: Form[] = [
    ["the 'backend' provider kind", 'backend', 'backend'],
    ["the 'orderbook' provider kind", 'orderbook', 'orderbook'],
    ['a provider kind on the sponsor service', 'sponsor', 'orderbook'],
    ['an explicit backend key', 'backend', { kind: 'backend', key: KEY }],
    ['explicit L1 headers', 'orderbook', { kind: 'orderbookL1', headers: L1 }],
    [
      'explicit L2 headers',
      'orderbook',
      {
        kind: 'orderbookL2',
        sign: async () => ({
          XO_API_KEY: 'k',
          XO_PASSPHRASE: 'p',
          XO_TIMESTAMP: '1',
          XO_SIGNATURE: 's',
        }),
      },
    ],
  ];

  /** A hand-built environment, as one that skipped resolveEnvironment would be. */
  const envAt = (url: string): EnvironmentConfig => ({
    ...env,
    backendUrl: url,
    orderbookUrl: url,
    sponsorUrl: url,
  });

  function spyTransport(url: string) {
    const fetchSpy = vi.fn(
      async (_input: unknown, _init?: RequestInit) =>
        new Response('{"ok":true}', {
          headers: { 'content-type': 'application/json' },
        }),
    );
    const auth = makeAuth();
    const transport = new Transport({
      env: envAt(url),
      version: '9.9.9',
      fetch: fetchSpy as unknown as typeof fetch,
      auth,
    });
    return { transport, fetchSpy, auth };
  }

  const UNSAFE: Array<[string, string]> = [
    ['http to another host', 'http://evil.example'],
    ['http to another host and port', 'http://evil.example:8080'],
    ['http to a sub-domain of localhost', 'http://localhost.evil.example'],
    ['http to a sub-domain of 127.0.0.1', 'http://127.0.0.1.evil.example'],
    ['http with localhost as the user name', 'http://localhost@evil.example'],
    [
      'http with a password in the URL',
      'http://user:LEAKUSERINFO@evil.example',
    ],
    ['http to 0.0.0.0', 'http://0.0.0.0:8080'],
    ['http to another IPv6 address', 'http://[::2]:8080'],
    ['ws to localhost', 'ws://localhost:8080'],
    ['ftp to localhost', 'ftp://localhost'],
    ['a URL that does not parse', 'not a url'],
    ['an empty URL', ''],
  ];

  const SAFE: Array<[string, string]> = [
    ['https to any host', 'https://api.example.com'],
    ['http to localhost', 'http://localhost:3000'],
    ['http to localhost without a port', 'http://localhost'],
    ['http to 127.0.0.1', 'http://127.0.0.1:8080'],
    ['http to [::1]', 'http://[::1]:8080'],
    ['http to LOCALHOST in capitals', 'HTTP://LOCALHOST:3000'],
  ];

  test.each(UNSAFE)(
    'refuses every credential form for %s, before any I/O, without echoing a credential',
    async (_label, url) => {
      for (const [, service, auth] of FORMS) {
        const { transport, fetchSpy, auth: provider } = spyTransport(url);
        const error = await errorOf(
          transport.request({ service, method: 'GET', path: '/api/x', auth }),
        );
        expect(error).toBeInstanceOf(UserInputError);
        expect((error as UserInputError).code).toBe('insecure_transport');
        expect((error as UserInputError).service).toBe(service);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(provider.headers).not.toHaveBeenCalled();
        expect(provider.onUnauthorized).not.toHaveBeenCalled();
        const text = dump(error);
        for (const secret of [
          KEY,
          'TESTKEY',
          L1.XO_SIGNATURE,
          'LEAKUSERINFO',
        ]) {
          expect(text).not.toContain(secret);
        }
      }
    },
  );

  test.each(SAFE)('sends every credential form to %s', async (_label, url) => {
    for (const [, service, auth] of FORMS) {
      const { transport, fetchSpy } = spyTransport(url);
      await expect(
        transport.request({ service, method: 'GET', path: '/api/x', auth }),
      ).resolves.toEqual({ ok: true });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const sent = fetchSpy.mock.calls[0]?.[1]?.headers as Headers;
      if (typeof auth === 'string') {
        expect(sent.get('x-test-sig')).toBe('sig-1');
      } else if (auth?.kind === 'backend') {
        expect(sent.get('authorization')).toBe(`Bearer ${KEY}`);
      } else if (auth?.kind === 'orderbookL2') {
        expect(sent.get('xo_api_key')).toBe('k');
      } else {
        expect(sent.get('xo_signature')).toBe(L1.XO_SIGNATURE);
      }
    }
  });

  test.each(UNSAFE)(
    'a request with no credentials is unaffected by %s',
    async (_label, url) => {
      for (const auth of [undefined, 'none'] as const) {
        const { transport, fetchSpy, auth: provider } = spyTransport(url);
        const outcome = await settle(
          transport.request({
            service: 'backend',
            method: 'GET',
            path: '/api/x',
            auth,
          }),
        );
        expect(outcome.ok).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(provider.headers).not.toHaveBeenCalled();
        const sent = fetchSpy.mock.calls[0]?.[1]?.headers as Headers;
        expect(sent.get('x-test-sig')).toBeNull();
        expect(sent.get('authorization')).toBeNull();
      }
    },
  );

  test('a missing provider on an unsafe URL is still a refusal, not a send', async () => {
    const fetchSpy = vi.fn();
    const transport = new Transport({
      env: envAt('http://evil.example'),
      version: '9.9.9',
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const error = await errorOf(
      transport.request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
        auth: 'backend',
      }),
    );
    expect(error).toBeInstanceOf(XoError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe('an L1 header value is 1 to 256 characters', () => {
    const URL_X = `${ORDERBOOK}/auth/x`;
    const send = (value: string) =>
      makeTransport().request({
        service: 'orderbook',
        method: 'GET',
        path: '/auth/x',
        auth: { kind: 'orderbookL1', headers: { ...L1, XO_SIGNATURE: value } },
      });

    test('256 characters are sent', async () => {
      const hits = serve('get', URL_X, ok());
      await send('x'.repeat(256));
      expect(hits[0]?.headers.get('xo_signature')).toBe('x'.repeat(256));
    });

    test('257 characters are refused without a request or an echo', async () => {
      const hits = serve('get', URL_X, ok());
      const error = await errorOf(send(`LEAKLONG${'x'.repeat(249)}`));
      expect(error).toBeInstanceOf(UserInputError);
      expect(hits).toHaveLength(0);
      expect(dump(error)).not.toContain('LEAKLONG');
    });
  });
});

describe('onUnauthorized context', () => {
  test('ctx.headers equals what headers() returned for the attempt that got the 401', async () => {
    fakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    serve('get', `${BACKEND}/api/x`, fail(503), fail(401, {}), ok({ n: 1 }));
    const auth = makeAuth(async () => true);
    const outcome = await drain(
      makeTransport({ auth }).request({
        service: 'backend',
        method: 'GET',
        path: '/api/x',
        auth: 'backend',
      }),
    );
    expect(outcome).toEqual({ ok: true, value: { n: 1 } });
    expect(auth.headers).toHaveBeenCalledTimes(3);
    expect(auth.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(auth.onUnauthorized).toHaveBeenCalledWith('backend', {
      headers: { 'x-test-sig': 'sig-2' },
    });
  });

  test('ctx.headers is a copy: the provider changing its object later changes nothing', async () => {
    serve('post', `${ORDERBOOK}/orders`, fail(401, {}), ok());
    const shared: Record<string, string> = { XO_API_KEY: 'key-1' };
    let seen: Record<string, string> | undefined;
    const auth = makeAuth(
      async (_kind, ctx) => {
        shared.XO_API_KEY = 'changed';
        seen = ctx.headers;
        return true;
      },
      async () => shared,
    );
    await makeTransport({ auth }).request({
      service: 'orderbook',
      method: 'POST',
      path: '/orders',
      body: {},
      auth: 'orderbook',
    });
    expect(seen).toEqual({ XO_API_KEY: 'key-1' });
    expect(seen).not.toBe(shared);
  });
});
