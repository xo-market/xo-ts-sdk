import { getEventListeners } from 'node:events';
import { HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { BridgeClient } from '../../src/bridge/client';
import type { BridgePayment } from '../../src/bridge/schemas';
import {
  RateLimitError,
  RequestRejectedError,
  TimeoutError,
  TransactionFailedError,
  TransportError,
  UnexpectedResponseError,
  UserInputError,
  XoError,
} from '../../src/core/errors';
import { Transport } from '../../src/core/transport';
import { API_KEY, caught } from '../helpers/dataRig';
import { exceptionResponse } from '../helpers/mockBackend';
import {
  type BridgeBackend,
  bridgeRig,
  expectNoRequest,
  paymentFixture,
} from '../helpers/mockBridge';
import { eoaIdentity } from '../helpers/railChain';
import { rejectedWith, serverFailure } from '../helpers/rejections';
import { testEnv } from '../helpers/testEnv';

// `xo.bridge.wait()`: polls a payment until it is final. Fake timers drive the 10 s poll and
// the deadline; only setTimeout, setInterval and Date are faked, so msw (which runs on promises
// and the real event loop) keeps working, and `AbortSignal.timeout` of the transport stays real.

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
/** The fake clock starts here, so "ms since the call" is `Date.now() - CLOCK_START`. */
const CLOCK_START = Date.parse('2026-10-21T12:00:00.000Z');
beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
    ],
    now: CLOCK_START,
  });
});
afterEach(() => {
  vi.useRealTimers();
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

const BASE = '/api/bridge/halliday';
const POLL_MS = 10_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** One turn of the real event loop (`setImmediate` is not faked here). */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The real `setTimeout`, taken before any test fakes it: for waiting out a real timer. */
const realSetTimeout = globalThis.setTimeout;
const realDelay = (ms: number) =>
  new Promise<void>((resolve) => realSetTimeout(resolve, ms));

/** Lets msw and the transport run until `condition` holds. */
async function until(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 2000; i += 1) {
    if (condition()) {
      return;
    }
    await tick();
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Lets pending promises and requests run, for a check that nothing more happens. */
async function settleIO(): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    await tick();
  }
}

/** A promise watched from the start, so a fake-timer test never leaks a rejection. */
interface Tracked<T> {
  done: boolean;
  value: T | undefined;
  error: unknown;
}

function track<T>(promise: Promise<T>): Tracked<T> {
  const state: Tracked<T> = { done: false, value: undefined, error: undefined };
  promise.then(
    (value) => {
      state.done = true;
      state.value = value;
    },
    (error: unknown) => {
      state.done = true;
      state.error = error;
    },
  );
  return state;
}

/** What one read answers with. A factory, because a `Response` can be read once. */
type Answer = () => Response;

/** The payment `pay_1` in `status`. */
const inStatus =
  (status: string, over: Record<string, unknown> = {}): Answer =>
  () =>
    HttpResponse.json(paymentFixture({ paymentId: 'pay_1', status, ...over }));
const unavailable: Answer = () =>
  exceptionResponse(`${BASE}/payments/pay_1`, 503, {
    error: 'halliday_unavailable',
    message: 'down',
  });
const lostConnection: Answer = () => HttpResponse.error();
const notFound: Answer = () =>
  exceptionResponse(`${BASE}/payments/pay_1`, 404, {
    error: 'payment_not_found',
    message: 'Payment not found',
  });

/**
 * Answers the reads of the payment one after the other (the last answer repeats), and records
 * when each read arrived, in ms since CLOCK_START.
 */
function script(backend: BridgeBackend, answers: Answer[]): number[] {
  const arrivals: number[] = [];
  backend.override('payment', () => {
    const answer = answers[Math.min(arrivals.length, answers.length - 1)];
    arrivals.push(Date.now() - CLOCK_START);
    return (answer as Answer)();
  });
  return arrivals;
}

/** `vi.getTimerCount()` is 0 and the signal holds no listener of ours. */
function expectNothingLeft(signal?: AbortSignal): void {
  expect(vi.getTimerCount()).toBe(0);
  if (signal !== undefined) {
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  }
}

describe('bridge.wait: polling', () => {
  test('AWAITING_FUNDS → PROCESSING → COMPLETE resolves at the third read, 10 s apart, and onUpdate fires on each change', async () => {
    const { bridge, backend } = bridgeRig(server);
    const reads = script(backend, [
      inStatus('AWAITING_FUNDS'),
      inStatus('PROCESSING'),
      inStatus('COMPLETE', { completedAt: '2026-10-21T12:09:00.000Z' }),
    ]);
    const seen: string[] = [];
    const wait = track(
      bridge.wait('pay_1', {
        onUpdate: (payment) => seen.push(payment.status),
      }),
    );

    await until(() => seen.length === 1, 'the first read');
    expect(reads).toEqual([0]);
    expect(wait.done).toBe(false);

    // Nothing happens before the poll interval is over.
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    await settleIO();
    expect(reads).toEqual([0]);

    await vi.advanceTimersByTimeAsync(1);
    await until(() => seen.length === 2, 'the second read');
    expect(reads).toEqual([0, POLL_MS]);
    expect(wait.done).toBe(false);

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await until(() => wait.done, 'the third read');
    expect(reads).toEqual([0, POLL_MS, 2 * POLL_MS]);
    expect(seen).toEqual(['AWAITING_FUNDS', 'PROCESSING', 'COMPLETE']);
    expect(wait.error).toBeUndefined();
    expect(wait.value).toMatchObject({
      paymentId: 'pay_1',
      status: 'COMPLETE',
      completedAt: '2026-10-21T12:09:00.000Z',
    });
    expectNothingLeft();

    // Done means done: no read after the last one.
    await vi.advanceTimersByTimeAsync(5 * POLL_MS);
    await settleIO();
    expect(reads).toHaveLength(3);
  });

  test('each read is GET /payments/:paymentId with the session key', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.payments.set(
      'pay_1',
      paymentFixture({ paymentId: 'pay_1', status: 'COMPLETE' }),
    );
    await bridge.wait('pay_1');
    expect(backend.requests).toHaveLength(1);
    expect(backend.requests[0]).toMatchObject({
      method: 'GET',
      path: `${BASE}/payments/pay_1`,
      query: {},
    });
    expect(backend.requests[0]?.authorization).toMatch(/^Bearer xo_sk_/);
  });

  test('onUpdate fires on a change of status only, not on every read', async () => {
    const { bridge, backend } = bridgeRig(server);
    const reads = script(backend, [
      inStatus('AWAITING_FUNDS'),
      inStatus('AWAITING_FUNDS', { updatedAt: '2026-10-21T12:00:10.000Z' }),
      inStatus('PROCESSING'),
      inStatus('PROCESSING'),
      inStatus('COMPLETE'),
    ]);
    const seen: BridgePayment[] = [];
    const wait = track(bridge.wait('pay_1', { onUpdate: (p) => seen.push(p) }));
    for (let n = 1; n <= 5; n += 1) {
      await until(() => reads.length === n, `read ${n}`);
      await settleIO();
      await vi.advanceTimersByTimeAsync(POLL_MS);
    }
    await until(() => wait.done, 'the end');
    expect(seen.map((payment) => payment.status)).toEqual([
      'AWAITING_FUNDS',
      'PROCESSING',
      'COMPLETE',
    ]);
    // The payment that ends the wait is the one the callback saw last.
    expect(wait.value).toBe(seen[2]);
  });

  test('a payment that is final at the first read resolves at once: one read, onUpdate once, no timer', async () => {
    const { bridge, backend } = bridgeRig(server);
    const reads = script(backend, [inStatus('COMPLETE')]);
    const onUpdate = vi.fn();
    const payment = await bridge.wait('pay_1', { onUpdate });
    expect(payment.status).toBe('COMPLETE');
    expect(reads).toEqual([0]);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expectNothingLeft();
  });

  test.each([['EXPIRED'], ['TAINTED']])(
    '%s is final: the wait resolves with it',
    async (status) => {
      const { bridge, backend } = bridgeRig(server);
      const reads = script(backend, [inStatus('PROCESSING'), inStatus(status)]);
      const onUpdate = vi.fn();
      const wait = track(bridge.wait('pay_1', { onUpdate }));
      await until(() => reads.length === 1, 'the first read');
      await vi.advanceTimersByTimeAsync(POLL_MS);
      await until(() => wait.done, 'the final read');
      expect(wait.error).toBeUndefined();
      expect(wait.value).toMatchObject({ paymentId: 'pay_1', status });
      expect(onUpdate).toHaveBeenCalledTimes(2);
      expectNothingLeft();
    },
  );

  test.each([
    ['QUOTED'],
    ['CONFIRM_UNKNOWN'],
    ['NEEDS_VERIFICATION'],
    ['AWAITING_FUNDS'],
    ['PROCESSING'],
    ['HALTED'],
    ['A_STATUS_FROM_A_LATER_BACKEND'],
  ])(
    '%s is not final: the wait goes on until the payment ends',
    async (status) => {
      const { bridge, backend } = bridgeRig(server);
      const reads = script(backend, [
        inStatus(status),
        inStatus(status),
        inStatus('COMPLETE'),
      ]);
      const wait = track(bridge.wait('pay_1'));
      for (let n = 1; n <= 2; n += 1) {
        await until(() => reads.length === n, `read ${n}`);
        await settleIO();
        expect(wait.done).toBe(false);
        await vi.advanceTimersByTimeAsync(POLL_MS);
      }
      await until(() => wait.done, 'the final read');
      expect(wait.value).toMatchObject({ status: 'COMPLETE' });
      expect(reads).toEqual([0, POLL_MS, 2 * POLL_MS]);
    },
  );
});

describe('bridge.wait: errors of a read', () => {
  test('a 503, then a lost connection, then COMPLETE: the wait resolves', async () => {
    const { bridge, backend } = bridgeRig(server);
    const reads = script(backend, [
      unavailable,
      lostConnection,
      inStatus('COMPLETE'),
    ]);
    const onUpdate = vi.fn();
    const wait = track(bridge.wait('pay_1', { onUpdate }));

    await until(() => reads.length === 1, 'the 503');
    await settleIO();
    expect(wait.done).toBe(false);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await until(() => reads.length === 2, 'the lost connection');
    await settleIO();
    expect(wait.done).toBe(false);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await until(() => wait.done, 'COMPLETE');

    expect(wait.error).toBeUndefined();
    expect(wait.value).toMatchObject({ status: 'COMPLETE' });
    expect(reads).toEqual([0, POLL_MS, 2 * POLL_MS]);
    // The errors never reached the callback, and it saw the first status once.
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expectNothingLeft();
  });

  test('a blip between two statuses does not repeat or hide a change', async () => {
    const { bridge, backend } = bridgeRig(server);
    const reads = script(backend, [
      inStatus('PROCESSING'),
      unavailable,
      inStatus('PROCESSING'),
      inStatus('COMPLETE'),
    ]);
    const seen: string[] = [];
    const wait = track(
      bridge.wait('pay_1', { onUpdate: (p) => seen.push(p.status) }),
    );
    for (let n = 1; n <= 3; n += 1) {
      await until(() => reads.length === n, `read ${n}`);
      await settleIO();
      await vi.advanceTimersByTimeAsync(POLL_MS);
    }
    await until(() => wait.done, 'the end');
    expect(seen).toEqual(['PROCESSING', 'COMPLETE']);
  });

  test('a 429 is transient too', async () => {
    const { bridge, backend } = bridgeRig(server);
    const reads = script(backend, [
      () =>
        exceptionResponse(`${BASE}/payments/pay_1`, 429, {
          error: 'rate_limited',
          message: 'slow down',
        }),
      inStatus('COMPLETE'),
    ]);
    const wait = track(bridge.wait('pay_1'));
    await until(() => reads.length === 1, 'the 429');
    await settleIO();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await until(() => wait.done, 'COMPLETE');
    expect(wait.value).toMatchObject({ status: 'COMPLETE' });
  });

  // The failures `wait()` rides out, and the ones it does not: the wait ends at the first of
  // those.
  const transient: Array<[string, () => XoError]> = [
    [
      'RequestRejectedError 503',
      () =>
        new RequestRejectedError('down', {
          status: 503,
          code: 'service_unavailable',
        }),
    ],
    ['RateLimitError', () => new RateLimitError('slow down')],
    ['TimeoutError of a request', () => new TimeoutError('GET timed out')],
    [
      'TransportError (no response)',
      () => new TransportError('GET /x got no response from backend'),
    ],
  ];
  const final: Array<[string, () => XoError]> = [
    [
      'RequestRejectedError 404',
      () =>
        new RequestRejectedError('gone', {
          status: 404,
          code: 'payment_not_found',
        }),
    ],
    [
      'RequestRejectedError 401',
      () =>
        new RequestRejectedError('no', { status: 401, code: 'unauthorized' }),
    ],
    [
      'RequestRejectedError 403',
      () => new RequestRejectedError('no', { status: 403, code: 'forbidden' }),
    ],
    [
      'RequestRejectedError 409',
      () => new RequestRejectedError('no', { status: 409, code: 'conflict' }),
    ],
    ['UserInputError', () => new UserInputError('no')],
    [
      'UnexpectedResponseError',
      () => new UnexpectedResponseError('odd', { issues: [] }),
    ],
    [
      'XoError session_closed',
      () => new XoError('closed', { code: 'session_closed' }),
    ],
    [
      'TransportError "was aborted"',
      () => new TransportError('GET /x was aborted'),
    ],
  ];

  test.each(transient)(
    '%s is swallowed: the next poll goes on',
    async (_, make) => {
      const { bridge, transport } = bridgeRig(server);
      const request = vi
        .spyOn(transport, 'request')
        .mockRejectedValueOnce(make())
        .mockResolvedValueOnce(paymentFixture({ status: 'COMPLETE' }));
      const wait = track(bridge.wait('pay_1'));
      await until(() => request.mock.calls.length === 1, 'the failed read');
      await settleIO();
      expect(wait.done).toBe(false);
      await vi.advanceTimersByTimeAsync(POLL_MS);
      await until(() => wait.done, 'COMPLETE');
      expect(wait.error).toBeUndefined();
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  test.each(final)(
    '%s ends the wait at once, with the paymentId',
    async (_, make) => {
      const { bridge, transport } = bridgeRig(server);
      const request = vi.spyOn(transport, 'request').mockRejectedValue(make());
      const error = await caught(() => bridge.wait('pay_1'));
      expect(error).toBeInstanceOf(XoError);
      expect((error as XoError).paymentId).toBe('pay_1');
      // A read moves nothing.
      expect((error as XoError).mayHaveLanded).toBe(false);
      expect(request).toHaveBeenCalledTimes(1);
      expectNothingLeft();
    },
  );

  test('a 404 payment_not_found rejects at once: one read, the paymentId, mayHaveLanded false, no timer', async () => {
    const { bridge, backend } = bridgeRig(server);
    const reads = script(backend, [notFound]);
    const error = await caught(() => bridge.wait('pay_1'));
    expect(error).toSatisfy(rejectedWith(404));
    expect(error).toMatchObject({
      code: 'payment_not_found',
      paymentId: 'pay_1',
      mayHaveLanded: false,
    });
    expect(reads).toEqual([0]);
    expectNothingLeft();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settleIO();
    expect(reads).toHaveLength(1);
  });

  test('a 404 after good reads ends the wait too', async () => {
    const { bridge, backend } = bridgeRig(server);
    const reads = script(backend, [inStatus('PROCESSING'), notFound]);
    const wait = track(bridge.wait('pay_1'));
    await until(() => reads.length === 1, 'the first read');
    await settleIO();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await until(() => wait.done, 'the 404');
    expect(wait.error).toSatisfy(rejectedWith(404));
    expect((wait.error as XoError).paymentId).toBe('pay_1');
    expectNothingLeft();
  });

  test('an answer that does not match the schema rejects at once', async () => {
    const { bridge, backend } = bridgeRig(server);
    const reads = script(backend, [
      () => HttpResponse.json({ nonsense: true }),
    ]);
    const error = await caught(() => bridge.wait('pay_1'));
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as XoError).paymentId).toBe('pay_1');
    expect(reads).toHaveLength(1);
  });

  test('a key the backend refuses (401) rejects at once', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.fixtures.validKeys.clear();
    const error = await caught(() => bridge.wait('pay_1'));
    expect(error).toBeInstanceOf(XoError);
    expect((error as XoError).paymentId).toBe('pay_1');
    expect((error as XoError).status).toBe(401);
    expectNothingLeft();
  });

  test('a session without credentials rejects at once with auth_required, nothing sent', async () => {
    const { bridge, backend } = bridgeRig(server, { session: 'none' });
    const error = await caught(() => bridge.wait('pay_1'));
    expect((error as XoError).code).toBe('auth_required');
    expect((error as XoError).mayHaveLanded).toBe(false);
    expect((error as XoError).paymentId).toBe('pay_1');
    expectNoRequest(backend);
    expectNothingLeft();
  });

  test('a TransportError that is an abort the signal did not ask for (the fetch gave up) ends the wait; a network failure does not', async () => {
    const rig = bridgeRig(server);
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      // The first call is a network failure, the second an AbortError of the fetch itself.
      throw calls === 1
        ? new TypeError('fetch failed')
        : new DOMException('The operation was aborted', 'AbortError');
    }) as unknown as typeof fetch;
    const transport = new Transport({
      env: rig.env,
      version: '9.9.9',
      maxRetries: 0,
      fetch: fetchImpl,
    });
    transport.setAuth(rig.session);
    const bridge = new BridgeClient({
      env: rig.env,
      transport,
      session: rig.session,
      identity: async () => eoaIdentity(),
      chain: rig.chain.reader,
      account: rig.account,
    });
    const wait = track(bridge.wait('pay_1'));
    await until(() => calls === 1, 'the network failure');
    await settleIO();
    expect(wait.done).toBe(false);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await until(() => wait.done, 'the abort');
    expect(wait.error).toBeInstanceOf(TransportError);
    expect(calls).toBe(2);
    expect((wait.error as XoError).paymentId).toBe('pay_1');
    expectNothingLeft();
  });

  test('a request that times out is transient: the next poll reads again', async () => {
    const rig = bridgeRig(server);
    let calls = 0;
    // The first request never answers until its own timeout (the transport's, real) aborts it.
    const fetchImpl = ((_: unknown, init?: RequestInit) => {
      calls += 1;
      if (calls > 1) {
        return Promise.resolve(
          Response.json(paymentFixture({ status: 'COMPLETE' })),
        );
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason),
          {
            once: true,
          },
        );
      });
    }) as unknown as typeof fetch;
    const transport = new Transport({
      env: rig.env,
      version: '9.9.9',
      maxRetries: 0,
      defaultTimeoutMs: 20,
      fetch: fetchImpl,
    });
    transport.setAuth(rig.session);
    const bridge = new BridgeClient({
      env: rig.env,
      transport,
      session: rig.session,
      identity: async () => eoaIdentity(),
      chain: rig.chain.reader,
      account: rig.account,
    });
    const wait = track(bridge.wait('pay_1'));
    await until(() => calls === 1, 'the first request');
    // The transport's 20 ms timeout is real time (`AbortSignal.timeout` is not faked): give it
    // real time, however loaded the machine is, until the wait sleeps.
    for (let i = 0; i < 300 && vi.getTimerCount() === 0; i += 1) {
      await realDelay(10);
    }
    expect(vi.getTimerCount()).toBe(1);
    expect(wait.done).toBe(false);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await until(() => wait.done, 'COMPLETE');
    expect(wait.error).toBeUndefined();
    expect(calls).toBe(2);
  });
});

describe('bridge.wait: the deadline', () => {
  test('timeoutMs 25 s on a payment that stays PROCESSING: bridge_wait_timeout at 25 s, after reads at 0, 10, 20 and a last one at the deadline', async () => {
    const { bridge, backend } = bridgeRig(server);
    const reads = script(backend, [inStatus('PROCESSING')]);
    const wait = track(bridge.wait('pay_1', { timeoutMs: 25_000 }));

    await until(() => reads.length === 1, 'read 1');
    await settleIO();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await until(() => reads.length === 2, 'read 2');
    await settleIO();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await until(() => reads.length === 3, 'read 3');
    await settleIO();
    expect(wait.done).toBe(false);
    // The last sleep is only the 5 s that remain.
    await vi.advanceTimersByTimeAsync(4_999);
    await settleIO();
    expect(reads).toEqual([0, 10_000, 20_000]);
    expect(wait.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => wait.done, 'the timeout');

    expect(reads).toEqual([0, 10_000, 20_000, 25_000]);
    const error = wait.error as TimeoutError;
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toMatchObject({
      name: 'TimeoutError',
      code: 'bridge_wait_timeout',
      service: 'sdk',
      mayHaveLanded: true,
      paymentId: 'pay_1',
    });
    // The last read was fine, so there is no error to point at.
    expect(error.cause).toBeUndefined();
    expect(error.message).toContain('pay_1');
    expect(error.message).toContain('PROCESSING');
    expect(error.message).toContain('25000');
    expect(error.message).toContain('fetchBridgePayment(');
    expect(JSON.parse(JSON.stringify(error))).toMatchObject({
      code: 'bridge_wait_timeout',
      paymentId: 'pay_1',
      mayHaveLanded: true,
    });
    expectNothingLeft();
  });

  test('when the deadline passes on a transient error, the timeout carries that error as its cause', async () => {
    const { bridge, backend } = bridgeRig(server);
    const reads = script(backend, [inStatus('PROCESSING'), unavailable]);
    const wait = track(bridge.wait('pay_1', { timeoutMs: 25_000 }));
    for (let n = 1; n <= 3; n += 1) {
      await until(() => reads.length === n, `read ${n}`);
      await settleIO();
      await vi.advanceTimersByTimeAsync(n < 3 ? POLL_MS : 5_000);
    }
    await until(() => wait.done, 'the timeout');
    expect(reads).toEqual([0, 10_000, 20_000, 25_000]);
    const error = wait.error as TimeoutError;
    expect(error).toMatchObject({
      code: 'bridge_wait_timeout',
      mayHaveLanded: true,
      paymentId: 'pay_1',
    });
    expect(error.cause).toSatisfy(serverFailure);
    expect((error.cause as XoError).code).toBe('bridge_unavailable');
    expect(error.message).toContain('PROCESSING');
    expectNothingLeft();
  });

  test('a wait that never read a payment says so, with the last error as cause', async () => {
    const { bridge, backend } = bridgeRig(server);
    const reads = script(backend, [lostConnection]);
    const wait = track(bridge.wait('pay_1', { timeoutMs: 15_000 }));
    for (let n = 1; n <= 2; n += 1) {
      await until(() => reads.length === n, `read ${n}`);
      await settleIO();
      await vi.advanceTimersByTimeAsync(n < 2 ? POLL_MS : 5_000);
    }
    await until(() => wait.done, 'the timeout');
    const error = wait.error as TimeoutError;
    expect(error.code).toBe('bridge_wait_timeout');
    expect(error.cause).toBeInstanceOf(TransportError);
    expect(error.message).not.toContain('undefined');
  });

  test('a timeout shorter than the poll interval: one read, one short sleep, one last read', async () => {
    const { bridge, backend } = bridgeRig(server);
    const reads = script(backend, [inStatus('PROCESSING')]);
    const wait = track(bridge.wait('pay_1', { timeoutMs: 3_000 }));
    await until(() => reads.length === 1, 'read 1');
    await settleIO();
    await vi.advanceTimersByTimeAsync(2_999);
    await settleIO();
    expect(wait.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => wait.done, 'the timeout');
    expect(reads).toEqual([0, 3_000]);
    expect((wait.error as XoError).code).toBe('bridge_wait_timeout');
  });

  test('a payment that completes in the last read before the deadline is a result, not a timeout', async () => {
    const { bridge, backend } = bridgeRig(server);
    const reads = script(backend, [
      inStatus('PROCESSING'),
      inStatus('COMPLETE'),
    ]);
    const wait = track(bridge.wait('pay_1', { timeoutMs: 5_000 }));
    await until(() => reads.length === 1, 'read 1');
    await settleIO();
    await vi.advanceTimersByTimeAsync(5_000);
    await until(() => wait.done, 'the end');
    expect(wait.error).toBeUndefined();
    expect(wait.value).toMatchObject({ status: 'COMPLETE' });
  });

  test('the deadline counts from the call, so a slow read takes from the time left', async () => {
    const { bridge, transport } = bridgeRig(server);
    const reads: number[] = [];
    vi.spyOn(transport, 'request').mockImplementation(async () => {
      reads.push(Date.now() - CLOCK_START);
      if (reads.length === 1) {
        // The first read itself takes 20 s.
        vi.setSystemTime(Date.now() + 20_000);
      }
      return paymentFixture({ status: 'PROCESSING' });
    });
    const wait = track(bridge.wait('pay_1', { timeoutMs: 25_000 }));
    await until(() => reads.length === 1, 'the slow read');
    await settleIO();
    expect(wait.done).toBe(false);
    // 5 s are left, not 10.
    await vi.advanceTimersByTimeAsync(5_000);
    await until(() => wait.done, 'the timeout');
    expect(reads).toEqual([0, 25_000]);
    expect((wait.error as XoError).code).toBe('bridge_wait_timeout');
  });

  test('a read that ends after the deadline ends the wait without sleeping', async () => {
    const { bridge, transport } = bridgeRig(server);
    vi.spyOn(transport, 'request').mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 60_000);
      return paymentFixture({ status: 'PROCESSING' });
    });
    const error = await caught(() =>
      bridge.wait('pay_1', { timeoutMs: 30_000 }),
    );
    expect((error as XoError).code).toBe('bridge_wait_timeout');
    expectNothingLeft();
  });

  test('the default timeout is one hour: a read every 10 s, the timeout at 3 600 s', async () => {
    const { bridge, transport } = bridgeRig(server);
    const reads: number[] = [];
    vi.spyOn(transport, 'request').mockImplementation(async () => {
      reads.push(Date.now() - CLOCK_START);
      return paymentFixture({ status: 'PROCESSING' });
    });
    const wait = track(bridge.wait('pay_1'));
    await vi.advanceTimersByTimeAsync(HOUR_MS - 1);
    expect(wait.done).toBe(false);
    expect(reads).toHaveLength(360);
    await vi.advanceTimersByTimeAsync(1);
    expect(wait.done).toBe(true);
    expect(reads).toHaveLength(361);
    expect(reads.at(-1)).toBe(HOUR_MS);
    expect((wait.error as XoError).code).toBe('bridge_wait_timeout');
    expect((wait.error as XoError).message).toContain(String(HOUR_MS));
    expectNothingLeft();
  });

  test('24 h is the longest timeout', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.payments.set(
      'pay_1',
      paymentFixture({ paymentId: 'pay_1', status: 'COMPLETE' }),
    );
    expect(await bridge.wait('pay_1', { timeoutMs: DAY_MS })).toMatchObject({
      status: 'COMPLETE',
    });
  });
});

describe('bridge.wait: abort', () => {
  test('a signal that is already aborted rejects with its reason, before any request', async () => {
    const { bridge, backend } = bridgeRig(server);
    const reason = new Error('stop');
    const controller = new AbortController();
    controller.abort(reason);
    const error = await caught(() =>
      bridge.wait('pay_1', { signal: controller.signal }),
    );
    expect(error).toBe(reason);
    expectNoRequest(backend);
    expectNothingLeft(controller.signal);
  });

  test("the default reason of abort() is passed on as it is (a DOMException 'AbortError')", async () => {
    const { bridge, backend } = bridgeRig(server);
    const controller = new AbortController();
    controller.abort();
    const error = await caught(() =>
      bridge.wait('pay_1', { signal: controller.signal }),
    );
    expect(error).toBe(controller.signal.reason);
    expect((error as Error).name).toBe('AbortError');
    expectNoRequest(backend);
  });

  test('aborting during a sleep rejects with the reason, no timer is left, and no further read is made', async () => {
    const { bridge, backend } = bridgeRig(server);
    const reads = script(backend, [inStatus('PROCESSING')]);
    const reason = new Error('the user left');
    const controller = new AbortController();
    const wait = track(bridge.wait('pay_1', { signal: controller.signal }));
    await until(() => reads.length === 1, 'the first read');
    await until(() => vi.getTimerCount() === 1, 'the sleep');
    await vi.advanceTimersByTimeAsync(4_000);

    controller.abort(reason);
    await until(() => wait.done, 'the abort');

    expect(wait.error).toBe(reason);
    expectNothingLeft(controller.signal);
    await vi.advanceTimersByTimeAsync(10 * POLL_MS);
    await settleIO();
    expect(reads).toHaveLength(1);
  });

  test('aborting during a request rejects with the reason, not with the transport error', async () => {
    const { bridge, backend } = bridgeRig(server);
    let arrived = false;
    backend.override('payment', async () => {
      arrived = true;
      // Never answers: only the abort ends the request.
      return new Promise<Response>(() => undefined);
    });
    const reason = new Error('cancelled by the app');
    const controller = new AbortController();
    const wait = track(bridge.wait('pay_1', { signal: controller.signal }));
    await until(() => arrived, 'the request');

    controller.abort(reason);
    await until(() => wait.done, 'the abort');

    expect(wait.error).toBe(reason);
    expectNothingLeft(controller.signal);
  });

  test('aborting during a request, with the default reason', async () => {
    const { bridge, backend } = bridgeRig(server);
    let arrived = false;
    backend.override('payment', async () => {
      arrived = true;
      return new Promise<Response>(() => undefined);
    });
    const controller = new AbortController();
    const wait = track(bridge.wait('pay_1', { signal: controller.signal }));
    await until(() => arrived, 'the request');
    controller.abort();
    await until(() => wait.done, 'the abort');
    expect(wait.error).toBe(controller.signal.reason);
  });

  test('a signal that aborts while a transient error is being waited out stops it too', async () => {
    const { bridge, backend } = bridgeRig(server);
    const reads = script(backend, [unavailable]);
    const controller = new AbortController();
    const wait = track(bridge.wait('pay_1', { signal: controller.signal }));
    await until(() => reads.length === 1, 'the 503');
    await until(() => vi.getTimerCount() === 1, 'the sleep');
    const reason = new Error('enough');
    controller.abort(reason);
    await until(() => wait.done, 'the abort');
    expect(wait.error).toBe(reason);
    expectNothingLeft(controller.signal);
  });

  test('an abort that comes after the end changes nothing', async () => {
    const { bridge, backend } = bridgeRig(server);
    script(backend, [inStatus('COMPLETE')]);
    const controller = new AbortController();
    const payment = await bridge.wait('pay_1', { signal: controller.signal });
    expect(payment.status).toBe('COMPLETE');
    expectNothingLeft(controller.signal);
    controller.abort();
  });

  test('the signal is left clean when the wait ends in a timeout or in an error', async () => {
    const { bridge, backend } = bridgeRig(server);
    const controller = new AbortController();
    const reads = script(backend, [inStatus('PROCESSING')]);
    const wait = track(
      bridge.wait('pay_1', { signal: controller.signal, timeoutMs: 15_000 }),
    );
    await until(() => reads.length === 1, 'read 1');
    await settleIO();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await until(() => reads.length === 2, 'read 2');
    await settleIO();
    await vi.advanceTimersByTimeAsync(5_000);
    await until(() => wait.done, 'the timeout');
    expect((wait.error as XoError).code).toBe('bridge_wait_timeout');
    expectNothingLeft(controller.signal);

    const other = new AbortController();
    script(backend, [notFound]);
    const error = await caught(() =>
      bridge.wait('pay_1', { signal: other.signal }),
    );
    expect(error).toSatisfy(rejectedWith(404));
    expectNothingLeft(other.signal);
  });
});

describe('bridge.wait: a closed client', () => {
  test('after the session is closed: session_closed at once, nothing sent, mayHaveLanded false', async () => {
    const { bridge, backend, session } = bridgeRig(server);
    await session.close();
    const error = await caught(() => bridge.wait('pay_1'));
    expect(error).toBeInstanceOf(XoError);
    expect(error).toMatchObject({
      code: 'session_closed',
      mayHaveLanded: false,
      paymentId: 'pay_1',
    });
    expectNoRequest(backend);
    expectNothingLeft();
  });

  test('a client closed in the middle of a wait ends it at the next poll with session_closed', async () => {
    const { bridge, backend, session } = bridgeRig(server);
    const reads = script(backend, [inStatus('PROCESSING')]);
    const wait = track(bridge.wait('pay_1'));
    await until(() => reads.length === 1, 'the first read');
    await until(() => vi.getTimerCount() === 1, 'the sleep');

    await session.close();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await until(() => wait.done, 'the poll after the close');

    expect(wait.error).toBeInstanceOf(XoError);
    expect(wait.error).toMatchObject({
      code: 'session_closed',
      mayHaveLanded: false,
      paymentId: 'pay_1',
    });
    // The closed session sent nothing more.
    expect(reads).toHaveLength(1);
    expectNothingLeft();
  });
});

describe('bridge.wait: onUpdate', () => {
  test('is called with the payment of each change, before the wait looks at the status', async () => {
    const { bridge, backend } = bridgeRig(server);
    script(backend, [inStatus('EXPIRED')]);
    const order: string[] = [];
    const payment = await bridge.wait('pay_1', {
      onUpdate: (p) => {
        order.push(`update ${p.status}`);
      },
    });
    order.push(`result ${payment.status}`);
    expect(order).toEqual(['update EXPIRED', 'result EXPIRED']);
  });

  test('an XoError it throws stops the wait: it comes out with the paymentId and mayHaveLanded false, and no timer is left', async () => {
    const { bridge, backend } = bridgeRig(server);
    const reads = script(backend, [inStatus('PROCESSING')]);
    const boom = new XoError('the callback failed', { code: 'mine' });
    const error = await caught(() =>
      bridge.wait('pay_1', {
        onUpdate: () => {
          throw boom;
        },
      }),
    );
    expect(error).toBeInstanceOf(XoError);
    expect(error).toMatchObject({
      code: 'mine',
      message: 'the callback failed',
      paymentId: 'pay_1',
      mayHaveLanded: false,
    });
    expect(reads).toEqual([0]);
    expectNothingLeft();
    await vi.advanceTimersByTimeAsync(3 * POLL_MS);
    await settleIO();
    expect(reads).toHaveLength(1);
  });

  test('an Error that is not an XoError leaves as bridge_wait_callback_failed: the original is the cause, mayHaveLanded false, the paymentId, service sdk, and its message is not quoted', async () => {
    const { bridge, backend } = bridgeRig(server);
    const reads = script(backend, [inStatus('PROCESSING')]);
    // What the callback threw holds a key in its text and a secret in a field named like one.
    const boom = Object.assign(
      new TypeError(`text of the callback ${API_KEY}`),
      { apiKey: 'SECRET-123' },
    );
    const error = await caught(() =>
      bridge.wait('pay_1', {
        onUpdate: () => {
          throw boom;
        },
      }),
    );
    expect(error).not.toBe(boom);
    expect(error).toBeInstanceOf(XoError);
    expect(error).toMatchObject({
      name: 'XoError',
      code: 'bridge_wait_callback_failed',
      service: 'sdk',
      paymentId: 'pay_1',
      mayHaveLanded: false,
    });
    expect((error as XoError).cause).toBe(boom);
    // Only the class of what was thrown, never its message.
    expect((error as XoError).message).toContain('TypeError');
    expect((error as XoError).message).toContain('pay_1');
    expect((error as XoError).message).not.toContain('text of the callback');
    expect((error as XoError).message).not.toContain(API_KEY);
    expect((error as XoError).message).not.toContain('SECRET-123');
    // The cause is kept, and redacted like any error's: the key and the secret field do not
    // survive `JSON.stringify` (the logs).
    const json = JSON.stringify(error);
    expect(JSON.parse(json)).toMatchObject({
      code: 'bridge_wait_callback_failed',
      paymentId: 'pay_1',
      mayHaveLanded: false,
      cause: { name: 'TypeError' },
    });
    expect(json).not.toContain('SECRET-123');
    expect(json).not.toContain(API_KEY);
    expect(reads).toEqual([0]);
    expectNothingLeft();
    await vi.advanceTimersByTimeAsync(3 * POLL_MS);
    await settleIO();
    expect(reads).toHaveLength(1);
  });

  test('a callback that returns a rejected promise stops the wait too, wrapped the same way, with no unhandled rejection', async () => {
    const { bridge, backend } = bridgeRig(server);
    const reads = script(backend, [inStatus('PROCESSING')]);
    const boom = new Error('async failure');
    const error = await caught(() =>
      bridge.wait('pay_1', {
        onUpdate: async () => {
          throw boom;
        },
      }),
    );
    expect(error).toBeInstanceOf(XoError);
    expect(error).toMatchObject({
      code: 'bridge_wait_callback_failed',
      service: 'sdk',
      paymentId: 'pay_1',
      mayHaveLanded: false,
    });
    expect((error as XoError).cause).toBe(boom);
    expect(reads).toEqual([0]);
    expectNothingLeft();
  });

  test.each([
    ['a string', 'just text SECRET-123', 'unknown'],
    ['undefined', undefined, 'unknown'],
    ['null', null, 'unknown'],
    ['a number', 42, 'unknown'],
    ['a plain object', { reason: 'no' }, 'Error'],
    [
      'an object whose name getter throws',
      Object.defineProperty({}, 'name', {
        get() {
          throw new Error('getter');
        },
      }),
      'Error',
    ],
  ])(
    '%s thrown by the callback is wrapped too, and its text is not quoted',
    async (_, thrown, named) => {
      const { bridge, backend } = bridgeRig(server);
      script(backend, [inStatus('PROCESSING')]);
      const sync = await caught(() =>
        bridge.wait('pay_1', {
          onUpdate: () => {
            throw thrown;
          },
        }),
      );
      const rejected = await caught(() =>
        bridge.wait('pay_1', {
          onUpdate: () => Promise.reject(thrown),
        }),
      );
      for (const error of [sync, rejected]) {
        expect(error).toBeInstanceOf(XoError);
        expect(error).toMatchObject({
          code: 'bridge_wait_callback_failed',
          service: 'sdk',
          paymentId: 'pay_1',
          mayHaveLanded: false,
        });
        expect((error as XoError).cause).toBe(thrown);
        expect((error as XoError).message).toContain(`(${named})`);
        expect((error as XoError).message).not.toContain('SECRET-123');
      }
      expectNothingLeft();
    },
  );

  test('an XoError the callback throws is not wrapped: it keeps its code and a mayHaveLanded it already has', async () => {
    const { bridge, backend } = bridgeRig(server);
    script(backend, [inStatus('PROCESSING')]);
    const own = new TransactionFailedError('mine', {
      code: 'mine',
      mayHaveLanded: true,
    });
    const error = await caught(() =>
      bridge.wait('pay_1', {
        onUpdate: () => {
          throw own;
        },
      }),
    );
    expect(error).toBe(own);
    expect(error).toMatchObject({
      code: 'mine',
      mayHaveLanded: true,
      paymentId: 'pay_1',
    });
  });

  test("a callback that rejects with the caller's own signal.reason leaves wait() with exactly that reason: not wrapped, no flag, no paymentId", async () => {
    const { bridge, backend } = bridgeRig(server);
    const reads = script(backend, [inStatus('PROCESSING')]);
    const reason = new Error('the user left');
    const controller = new AbortController();
    let entered = false;
    const wait = track(
      bridge.wait('pay_1', {
        signal: controller.signal,
        // Like an `await fetch(url, { signal })`: it rejects with the signal's reason on abort.
        onUpdate: () =>
          new Promise<void>((_resolve, reject) => {
            entered = true;
            controller.signal.addEventListener(
              'abort',
              () => reject(controller.signal.reason),
              { once: true },
            );
          }),
      }),
    );
    await until(() => entered, 'the callback');
    expect(wait.done).toBe(false);

    controller.abort(reason);
    await until(() => wait.done, 'the abort');

    expect(wait.error).toBe(reason);
    expect(wait.error).not.toHaveProperty('paymentId');
    expect(wait.error).not.toHaveProperty('mayHaveLanded');
    expect(reads).toEqual([0]);
    expectNothingLeft(controller.signal);
  });

  test('the same with the default reason of abort(), and with a callback that throws it synchronously', async () => {
    const { bridge, backend } = bridgeRig(server);
    script(backend, [inStatus('PROCESSING')]);
    const viaPromise = new AbortController();
    let entered = false;
    const rejected = track(
      bridge.wait('pay_1', {
        signal: viaPromise.signal,
        onUpdate: () =>
          new Promise<void>((_resolve, reject) => {
            entered = true;
            viaPromise.signal.addEventListener(
              'abort',
              () => reject(viaPromise.signal.reason),
              { once: true },
            );
          }),
      }),
    );
    await until(() => entered, 'the callback');
    viaPromise.abort();
    await until(() => rejected.done, 'the abort');
    expect(rejected.error).toBe(viaPromise.signal.reason);
    expect((rejected.error as Error).name).toBe('AbortError');

    const viaThrow = new AbortController();
    const thrown = await caught(() =>
      bridge.wait('pay_1', {
        signal: viaThrow.signal,
        onUpdate: () => {
          viaThrow.abort();
          throw viaThrow.signal.reason;
        },
      }),
    );
    expect(thrown).toBe(viaThrow.signal.reason);
    expectNothingLeft(viaThrow.signal);
  });

  test('an XoError given as the signal reason passes through as it is too: no paymentId, no flag added', async () => {
    const { bridge, backend } = bridgeRig(server);
    script(backend, [inStatus('PROCESSING')]);
    const reason = new XoError('stopped by the app', { code: 'mine' });
    const controller = new AbortController();
    const error = await caught(() =>
      bridge.wait('pay_1', {
        signal: controller.signal,
        onUpdate: () => {
          controller.abort(reason);
          throw reason;
        },
      }),
    );
    expect(error).toBe(reason);
    expect(error).not.toHaveProperty('paymentId');
    expect(error).not.toHaveProperty('mayHaveLanded');
  });

  test('another error thrown after the signal aborted is still wrapped', async () => {
    const { bridge, backend } = bridgeRig(server);
    script(backend, [inStatus('PROCESSING')]);
    const reason = new Error('the user left');
    const other = new Error('the callback broke');
    const controller = new AbortController();
    const error = await caught(() =>
      bridge.wait('pay_1', {
        signal: controller.signal,
        onUpdate: async () => {
          controller.abort(reason);
          throw other;
        },
      }),
    );
    expect(error).not.toBe(reason);
    expect(error).not.toBe(other);
    expect(error).toMatchObject({
      code: 'bridge_wait_callback_failed',
      service: 'sdk',
      paymentId: 'pay_1',
      mayHaveLanded: false,
    });
    expect((error as XoError).cause).toBe(other);
    expectNothingLeft(controller.signal);
  });

  test('a look-alike of the reason is not the reason: an AbortError thrown after an abort with another reason is wrapped', async () => {
    const { bridge, backend } = bridgeRig(server);
    script(backend, [inStatus('PROCESSING')]);
    const controller = new AbortController();
    const lookAlike = new DOMException(
      'This operation was aborted',
      'AbortError',
    );
    const error = await caught(() =>
      bridge.wait('pay_1', {
        signal: controller.signal,
        onUpdate: () => {
          controller.abort(new Error('the real reason'));
          throw lookAlike;
        },
      }),
    );
    expect((error as XoError).code).toBe('bridge_wait_callback_failed');
    expect((error as XoError).cause).toBe(lookAlike);
  });

  test('a callback that throws the reason of a signal that did not abort is wrapped: only an aborted signal exempts it', async () => {
    const { bridge, backend } = bridgeRig(server);
    script(backend, [inStatus('PROCESSING')]);
    const controller = new AbortController();
    const reason = new Error('not the signal reason');
    const error = await caught(() =>
      bridge.wait('pay_1', {
        signal: controller.signal,
        onUpdate: () => {
          throw reason;
        },
      }),
    );
    expect((error as XoError).code).toBe('bridge_wait_callback_failed');
    expect((error as XoError).cause).toBe(reason);
  });

  test('a later change that throws stops the wait there', async () => {
    const { bridge, backend } = bridgeRig(server);
    const reads = script(backend, [
      inStatus('AWAITING_FUNDS'),
      inStatus('PROCESSING'),
    ]);
    const wait = track(
      bridge.wait('pay_1', {
        onUpdate: (p) => {
          if (p.status === 'PROCESSING') {
            throw new XoError('stop here', { code: 'mine' });
          }
        },
      }),
    );
    await until(() => reads.length === 1, 'read 1');
    await settleIO();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await until(() => wait.done, 'the throw');
    expect((wait.error as XoError).paymentId).toBe('pay_1');
    expect((wait.error as XoError).mayHaveLanded).toBe(false);
    expect(reads).toHaveLength(2);
    expectNothingLeft();
  });
});

describe('bridge.wait: arguments', () => {
  test('on a config without a bridge: bridge_not_available first, whatever else is wrong, nothing sent', async () => {
    const { bridge, backend } = bridgeRig(server, { env: testEnv });
    const error = await caught(() =>
      bridge.wait('bad id', { timeoutMs: -1, signal: 5 } as never),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect(error).toMatchObject({
      code: 'bridge_not_available',
      service: 'sdk',
      mayHaveLanded: false,
    });
    expectNoRequest(backend);
    expectNothingLeft();
  });

  test.each([
    ['a path', 'p1/verification'],
    ['a query', 'p1?x=1'],
    ['a space', 'p 1'],
    ['empty', ''],
    ['129 characters', 'a'.repeat(129)],
    ['a number', 5],
    ['null', null],
    ['undefined', undefined],
  ])(
    'a paymentId that is %s → UserInputError, mayHaveLanded false, nothing sent',
    async (_, id) => {
      const { bridge, backend } = bridgeRig(server);
      const error = await caught(() => bridge.wait(id as never));
      expect(error).toBeInstanceOf(UserInputError);
      expect((error as XoError).code).toBe('invalid_input');
      expect((error as XoError).mayHaveLanded).toBe(false);
      expect((error as XoError).message).toContain('paymentId');
      expectNoRequest(backend);
      expectNothingLeft();
    },
  );

  test.each([
    ['zero', { timeoutMs: 0 }, 'timeoutMs'],
    ['negative', { timeoutMs: -1 }, 'timeoutMs'],
    ['NaN', { timeoutMs: Number.NaN }, 'timeoutMs'],
    ['Infinity', { timeoutMs: Number.POSITIVE_INFINITY }, 'timeoutMs'],
    ['a string', { timeoutMs: '5000' }, 'timeoutMs'],
    ['null', { timeoutMs: null }, 'timeoutMs'],
    ['over 24 h', { timeoutMs: DAY_MS + 1 }, 'timeoutMs'],
    ['a signal that is not one', { signal: {} }, 'signal'],
    ['a signal that is a string', { signal: 'abort' }, 'signal'],
    ['a signal that is null', { signal: null }, 'signal'],
    ['an onUpdate that is not a function', { onUpdate: 'log' }, 'onUpdate'],
    ['an onUpdate that is null', { onUpdate: null }, 'onUpdate'],
    ['an unknown option', { pollMs: 1 }, 'pollMs'],
    ['options that are null', null, 'options'],
    ['options that are a string', 'fast', 'options'],
    ['options that are an array', [], 'options'],
  ])(
    '%s → UserInputError, mayHaveLanded false, nothing sent',
    async (_, options, field) => {
      const { bridge, backend } = bridgeRig(server);
      const error = await caught(() => bridge.wait('pay_1', options as never));
      expect(error).toBeInstanceOf(UserInputError);
      expect((error as XoError).code).toBe('invalid_input');
      expect((error as XoError).mayHaveLanded).toBe(false);
      expect((error as XoError).message).toContain(field);
      expectNoRequest(backend);
      expectNothingLeft();
    },
  );

  test('a message never holds the value that was refused', async () => {
    const { bridge } = bridgeRig(server);
    const error = await caught(() =>
      bridge.wait('pay_1', { timeoutMs: 'SECRET-VALUE-123' } as never),
    );
    expect((error as XoError).message).not.toContain('SECRET-VALUE-123');
  });

  test('options may be left out or empty, and undefined fields count as left out', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.payments.set(
      'pay_1',
      paymentFixture({ paymentId: 'pay_1', status: 'COMPLETE' }),
    );
    expect(await bridge.wait('pay_1')).toMatchObject({ status: 'COMPLETE' });
    expect(await bridge.wait('pay_1', {})).toMatchObject({
      status: 'COMPLETE',
    });
    expect(
      await bridge.wait('pay_1', {
        timeoutMs: undefined,
        signal: undefined,
        onUpdate: undefined,
      }),
    ).toMatchObject({ status: 'COMPLETE' });
  });
});
