import { HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { type Address, encodeAbiParameters, type Hex } from 'viem';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  type Mock,
  test,
  vi,
} from 'vitest';
import { Session } from '../../src/auth/session';
import { Clock } from '../../src/core/clock';
import {
  AuthRequiredError,
  RequestRejectedError,
  TimeoutError,
  TransportError,
  UnexpectedResponseError,
  UserInputError,
  XoError,
} from '../../src/core/errors';
import {
  type AuthProvider,
  Transport,
  type TransportRequest,
} from '../../src/core/transport';
import {
  type ContractReader,
  type HeartbeatHandle,
  type HeartbeatOptions,
  OrderbookClient,
} from '../../src/orderbook/client';
import { installMarketData, TOKEN_YES } from '../helpers/mockMarketData';
import { installOrderbook, seedKey } from '../helpers/mockOrderbook';
import { installTrading, type Trading } from '../helpers/mockTrading';
import { serverFailure } from '../helpers/rejections';
import { keySigner } from '../helpers/signers';
import { testEnv } from '../helpers/testEnv';
import { clobAuthVector, kernelVector } from '../signing/helpers';

const env = testEnv;
const BASE = env.orderbookUrl;

// The public test vector key from test-vectors/clobAuth.json. Never fund it.
const BASE_SIGNER = keySigner(clobAuthVector.inputs.privateKey);
const OWNER = BASE_SIGNER.address;
const ACCOUNT = kernelVector.createAccount.expectedAccount;
const PADDED_ACCOUNT =
  `0x${'00'.repeat(12)}${ACCOUNT.slice(2).toLowerCase()}` as Hex;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

/** Every loop a test starts, so one test never leaks a running heartbeat into the next. */
const started: HeartbeatHandle[] = [];
afterEach(() => {
  for (const handle of started.splice(0)) {
    handle.stop();
  }
  server.resetHandlers();
  // Fake timers go first: restoring a spy on a faked global before uninstalling the fakes
  // would make the uninstall delete `setTimeout` for every later test. These tests never
  // spy on a timer that is faked.
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROUTE = 'POST /v1/heartbeats';

/** One turn of the real event loop (setImmediate is never faked in these tests). */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Real event-loop turns until `condition` holds, for up to 3 s of real time (under vitest's
 * 5 s test timeout, so a hang still names what it waited for). Bounded by time, not by a count
 * of turns: the HMAC is computed on libuv's threadpool, and while it runs each turn is empty
 * and takes microseconds, so a loaded runner can use up any fixed count before a beat is sent.
 * Timed with `performance.now()`, which no test here fakes (a test may fake `Date`).
 */
async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 3_000;
  while (!condition()) {
    if (performance.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await tick();
  }
}

/**
 * Lets msw traffic that is already under way finish: real event-loop turns for ~20 ms.
 * Timed with `performance.now()`, which no test here fakes (a test may fake `Date`).
 */
async function settle(): Promise<void> {
  const end = performance.now() + 20;
  do {
    await tick();
  } while (performance.now() < end);
}

/**
 * Fakes the timers of the loop (setImmediate stays real, so `settle()` and `until()` work).
 * The stub-transport tests also fake setInterval, so that a regression to it is counted by
 * `vi.getTimerCount()`.
 */
const fakeTimers = () =>
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });

/** Microtasks only: for the tests whose transport is a stub. */
const flush = () => vi.advanceTimersByTimeAsync(0);

/** Enough microtask turns for a stub request to answer and its beat to finish. */
async function microtasks(): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    await Promise.resolve();
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Starts a heartbeat and remembers it for the cleanup. */
function start(
  client: OrderbookClient,
  options?: HeartbeatOptions,
): HeartbeatHandle {
  const handle = client.startHeartbeat(options);
  started.push(handle);
  return handle;
}

/** An `onMissed` that records what it was called with. */
function recorder(): { missed: XoError[]; onMissed: (error: XoError) => void } {
  const missed: XoError[] = [];
  return { missed, onMissed: (error) => missed.push(error) };
}

const OK = { status: 'ok', tracked: true };

function newSession(transport: Transport, smartWallet = false): Session {
  return new Session({
    env,
    transport,
    clock: new Clock({
      fetchServerTimeSec: async () => Math.floor(Date.now() / 1000),
    }),
    signer: BASE_SIGNER,
    wallet: smartWallet ? { type: 'smart_wallet', index: 0 } : { type: 'eoa' },
    readContract: async () => PADDED_ACCOUNT,
    warn: vi.fn(),
  });
}

// ---------------------------------------------------------------------------
// Stub transport: scheduling logic, without a network
// ---------------------------------------------------------------------------

const STUB_SESSION = newSession(new Transport({ env, version: '0.0.0-test' }));

interface Stub {
  client: OrderbookClient;
  request: Mock<(o: TransportRequest) => Promise<unknown>>;
}

/** A client whose transport answers with `respond(callNumber)` (1-based). */
function stubbed(
  respond: (
    call: number,
    o: TransportRequest,
  ) => unknown | Promise<unknown> = () => OK,
): Stub {
  let calls = 0;
  const request = vi.fn(async (o: TransportRequest): Promise<unknown> => {
    calls += 1;
    return respond(calls, o);
  });
  const client = new OrderbookClient({
    transport: { request } as unknown as Transport,
    env,
    session: STUB_SESSION,
    strictResponses: true,
  });
  return { client, request };
}

const optionsOf = (stub: Stub, call = 0): TransportRequest => {
  const entry = stub.request.mock.calls[call];
  if (entry === undefined) {
    throw new Error(`request call ${call} was never made`);
  }
  return entry[0];
};

describe('startHeartbeat: scheduling (stub transport)', () => {
  test('sends a heartbeat at once, then one every 10 s by default', async () => {
    fakeTimers();
    const stub = stubbed();
    start(stub.client);
    expect(stub.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(stub.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(stub.request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stub.request).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stub.request).toHaveBeenCalledTimes(6);
  });

  test.each([1_000, 2_500, 20_000])('intervalMs %i is honoured', async (ms) => {
    fakeTimers();
    const stub = stubbed();
    start(stub.client, { intervalMs: ms });
    expect(stub.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ms - 1);
    expect(stub.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(stub.request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(ms);
    expect(stub.request).toHaveBeenCalledTimes(3);
  });

  test('the request is POST /v1/heartbeats with orderbook auth, no retry and no body', async () => {
    fakeTimers();
    const stub = stubbed();
    start(stub.client);
    const sent = optionsOf(stub);
    expect(sent).toEqual({
      service: 'orderbook',
      method: 'POST',
      path: '/v1/heartbeats',
      auth: 'orderbook',
      retry: 'none',
      timeoutMs: 5_000,
      signal: expect.any(AbortSignal),
    });
    // Not even an undefined `body` or `query`: the transport signs '' for a request without one.
    expect(Object.keys(sent).sort()).toEqual([
      'auth',
      'method',
      'path',
      'retry',
      'service',
      'signal',
      'timeoutMs',
    ]);
  });

  test.each([
    [1_000, 1_000],
    [2_000, 2_000],
    [4_999, 4_999],
    [5_000, 5_000],
    [10_000, 5_000],
    [20_000, 5_000],
  ])(
    'intervalMs %i: the request timeout is min(intervalMs, 5000) = %i',
    (intervalMs, expected) => {
      fakeTimers();
      const stub = stubbed();
      start(stub.client, { intervalMs });
      expect(optionsOf(stub).timeoutMs).toBe(expected);
      expect(optionsOf(stub).timeoutMs).toBeLessThanOrEqual(
        Math.min(intervalMs, 5_000),
      );
    },
  );

  test('is a setTimeout chain: never setInterval, and exactly one pending timer', async () => {
    // setInterval is left real on purpose, and refused: a regression to it fails loudly.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockImplementation(() => {
        throw new Error('setInterval must not be used');
      });
    const stub = stubbed();
    start(stub.client);
    // The next tick, and the deadline of the beat in flight.
    expect(vi.getTimerCount()).toBe(2);
    await flush();
    // The beat was answered, so its deadline is gone: only the chain is left.
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(55_000);
    expect(stub.request).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(1);
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  test('requests never overlap: a tick that finds one in flight skips it', async () => {
    fakeTimers();
    // intervalMs 2000: the request timeout is 2000 ms and the deadline 3000 ms, so a slow
    // answer can outlive one tick (with the default 10 s interval the deadline is 6 s and
    // no answer can be in flight at the next tick).
    const gate = deferred<unknown>();
    const stub = stubbed((call) => (call === 1 ? gate.promise : OK));
    start(stub.client, { intervalMs: 2_000 });
    expect(stub.request).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000); // the tick at 2 s finds the first in flight
    expect(stub.request).toHaveBeenCalledTimes(1);
    // The chain keeps ticking meanwhile, next to the deadline of the beat in flight.
    expect(vi.getTimerCount()).toBe(2);

    await vi.advanceTimersByTimeAsync(500); // the slow answer arrives at 2.5 s
    gate.resolve(OK);
    await flush();
    // No catch-up burst for the skipped tick: the next beat waits for the next tick.
    expect(stub.request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_500); // 4 s
    expect(stub.request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stub.request).toHaveBeenCalledTimes(3);
  });

  test('a second startHeartbeat while one is running throws UserInputError', async () => {
    fakeTimers();
    const stub = stubbed();
    const first = start(stub.client);
    let error: unknown;
    try {
      stub.client.startHeartbeat({ intervalMs: 5_000 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).code).toBe('heartbeat_already_running');
    // The refused call changed nothing: the first loop runs on, with one request so far.
    expect(first.running).toBe(true);
    expect(stub.request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(2); // the tick and the beat's deadline, still just one loop
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stub.request).toHaveBeenCalledTimes(2);
  });

  test('without a session it throws AuthRequiredError and schedules nothing', () => {
    fakeTimers();
    const request = vi.fn();
    const client = new OrderbookClient({
      transport: { request } as unknown as Transport,
      env,
    });
    expect(() => client.startHeartbeat()).toThrow(AuthRequiredError);
    expect(request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('startHeartbeat: the watchdog (stub transport)', () => {
  test('a beat that never answers is abandoned after timeoutMs + 1000 ms: aborted, reported, and the next tick sends a new beat', async () => {
    fakeTimers();
    const stub = stubbed(() => new Promise(() => {}));
    const { missed, onMissed } = recorder();
    // Default interval 10 s: the request timeout is 5 s, so the deadline is 6 s.
    const handle = start(stub.client, { onMissed });
    expect(stub.request).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_999);
    expect(missed).toEqual([]);
    expect(optionsOf(stub).signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1); // 6 s
    expect(missed).toHaveLength(1);
    const miss = missed[0] as XoError;
    expect(miss).toBeInstanceOf(TimeoutError);
    expect(miss.service).toBe('orderbook');
    expect(miss.message).toContain('6000 ms');
    expect(optionsOf(stub).signal?.aborted).toBe(true);
    // Freed, but not re-sent early: the next beat is the next tick's.
    expect(stub.request).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_000); // 10 s: the next tick
    expect(stub.request).toHaveBeenCalledTimes(2);
    expect(optionsOf(stub, 1).signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(6_000); // 16 s: the second beat is abandoned too
    expect(missed).toHaveLength(2);
    expect(optionsOf(stub, 1).signal?.aborted).toBe(true);
    expect(handle.running).toBe(true);
  });

  test.each([
    [1_000, 2_000],
    [2_000, 3_000],
    [4_999, 5_999],
    [5_000, 6_000],
    [10_000, 6_000],
    [20_000, 6_000],
  ])(
    'intervalMs %i: the deadline is min(intervalMs, 5000) + 1000 = %i ms',
    async (intervalMs, deadline) => {
      fakeTimers();
      const stub = stubbed(() => new Promise(() => {}));
      const { missed, onMissed } = recorder();
      start(stub.client, { intervalMs, onMissed });
      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(missed).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(missed).toHaveLength(1);
      expect(missed[0]).toBeInstanceOf(TimeoutError);
    },
  );

  test('a late answer of an abandoned beat is ignored, and cannot free the beat that replaced it', async () => {
    fakeTimers();
    const gates = [
      deferred<unknown>(),
      deferred<unknown>(),
      deferred<unknown>(),
    ];
    const stub = stubbed(
      (call) => (gates[call - 1] as { promise: Promise<unknown> }).promise,
    );
    const { missed, onMissed } = recorder();
    // intervalMs 5000: request timeout 5 s, deadline 6 s.
    start(stub.client, { intervalMs: 5_000, onMissed });
    await vi.advanceTimersByTimeAsync(5_000); // the tick finds beat 1 in flight
    expect(stub.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000); // 6 s: beat 1 is abandoned
    expect(missed).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4_000); // 10 s: beat 2 starts
    expect(stub.request).toHaveBeenCalledTimes(2);

    // Beat 1 finally answers (as a miss, if anyone were listening) at 12 s.
    await vi.advanceTimersByTimeAsync(2_000);
    gates[0]?.resolve({ status: 'ok', tracked: false });
    await flush();
    expect(missed).toHaveLength(1);

    // It did not free beat 2: the tick at 15 s still finds it in flight.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(stub.request).toHaveBeenCalledTimes(2);
    // Beat 2 is abandoned at 16 s, and the tick at 20 s sends beat 3.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(missed).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(stub.request).toHaveBeenCalledTimes(3);
    // Beat 2's late answer is ignored as well, and does not end beat 3 either.
    gates[1]?.reject(new TransportError('late failure'));
    await flush();
    expect(missed).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stub.request).toHaveBeenCalledTimes(3); // 25 s: beat 3 still in flight, tick skipped
  });

  test('the abort that follows an abandoned beat is not reported a second time', async () => {
    fakeTimers();
    const stub = stubbed(
      (_call, o) =>
        new Promise((_resolve, reject) => {
          o.signal?.addEventListener('abort', () =>
            reject(new TransportError('POST /v1/heartbeats was aborted')),
          );
        }),
    );
    const { missed, onMissed } = recorder();
    start(stub.client, { onMissed });
    await vi.advanceTimersByTimeAsync(6_000);
    await flush();
    expect(missed).toHaveLength(1);
    expect(missed[0]).toBeInstanceOf(TimeoutError);
  });

  test('a beat that answers in time clears its deadline: no miss, no stray timer', async () => {
    fakeTimers();
    const stub = stubbed();
    const { missed, onMissed } = recorder();
    start(stub.client, { onMissed });
    await vi.advanceTimersByTimeAsync(100_000);
    expect(missed).toEqual([]);
    expect(vi.getTimerCount()).toBe(1); // the chain; no deadline is pending
  });

  test('stop() cancels the deadline: nothing is reported after it', async () => {
    fakeTimers();
    const stub = stubbed(() => new Promise(() => {}));
    const { missed, onMissed } = recorder();
    const handle = start(stub.client, { onMissed });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(vi.getTimerCount()).toBe(2);
    handle.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(missed).toEqual([]);
    expect(stub.request).toHaveBeenCalledTimes(1);
  });

  test('a first tick that throws leaves nothing running and nothing "already running"', () => {
    fakeTimers();
    const stub = stubbed();
    vi.stubGlobal('setTimeout', () => {
      throw new Error('no timers today');
    });
    expect(() => stub.client.startHeartbeat()).toThrow('no timers today');
    expect(stub.request).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    const handle = start(stub.client);
    expect(handle.running).toBe(true);
    expect(stub.request).toHaveBeenCalledTimes(1);
  });
});

describe('startHeartbeat: stop() and running (stub transport)', () => {
  test('stop() halts: no request after it, and the pending timer is cancelled', async () => {
    fakeTimers();
    const stub = stubbed();
    const handle = start(stub.client);
    expect(handle.running).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stub.request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    handle.stop();
    expect(handle.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(stub.request).toHaveBeenCalledTimes(2);
  });

  test('stop() is idempotent and running reflects the state', async () => {
    fakeTimers();
    const stub = stubbed();
    const handle = start(stub.client);
    expect(handle.running).toBe(true);
    handle.stop();
    handle.stop();
    handle.stop();
    expect(handle.running).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stub.request).toHaveBeenCalledTimes(1);
  });

  test('stop() right after start(): only the first beat was sent, nothing is scheduled', () => {
    fakeTimers();
    const stub = stubbed();
    start(stub.client).stop();
    expect(stub.request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('stop() during an in-flight request: its result is ignored and nothing new is scheduled', async () => {
    fakeTimers();
    const gate = deferred<unknown>();
    const stub = stubbed(() => gate.promise);
    const { missed, onMissed } = recorder();
    const handle = start(stub.client, { onMissed });
    expect(stub.request).toHaveBeenCalledTimes(1);

    handle.stop();
    // The request is cancelled too, so it does not linger.
    expect(optionsOf(stub).signal?.aborted).toBe(true);

    // The late answer is a miss, but the loop is stopped: nobody is told, nothing is armed.
    gate.resolve({ status: 'ok', tracked: false });
    await flush();
    expect(missed).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(stub.request).toHaveBeenCalledTimes(1);
    expect(missed).toEqual([]);
  });

  test('stop() during an in-flight request that then fails: onMissed is not called', async () => {
    fakeTimers();
    const gate = deferred<unknown>();
    const stub = stubbed(() => gate.promise);
    const { missed, onMissed } = recorder();
    const handle = start(stub.client, { onMissed });
    handle.stop();
    gate.reject(new TransportError('boom'));
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(missed).toEqual([]);
    expect(stub.request).toHaveBeenCalledTimes(1);
  });

  test('stop() called from onMissed stops the loop cleanly', async () => {
    fakeTimers();
    const stub = stubbed(() => ({ status: 'ok', tracked: false }));
    let handle: HeartbeatHandle | undefined;
    const onMissed = vi.fn(() => handle?.stop());
    handle = start(stub.client, { onMissed });
    await flush();
    expect(onMissed).toHaveBeenCalledTimes(1);
    expect(handle.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stub.request).toHaveBeenCalledTimes(1);
  });

  test('after stop() a new loop can start, and the old handle cannot stop the new one', async () => {
    fakeTimers();
    const stub = stubbed();
    const first = start(stub.client);
    first.stop();
    const second = start(stub.client);
    expect(second).not.toBe(first);
    expect(first.running).toBe(false);
    expect(second.running).toBe(true);

    first.stop(); // a stale handle: a no-op for the loop that replaced it
    expect(second.running).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    // first beat of each loop, plus the second loop's tick
    expect(stub.request).toHaveBeenCalledTimes(3);

    second.stop();
    expect(second.running).toBe(false);
    // Free again.
    expect(start(stub.client).running).toBe(true);
  });
});

describe('startHeartbeat: misses and onMissed (stub transport)', () => {
  test('onMissed fires on failure and keeps trying', async () => {
    fakeTimers();
    const failure = new TransportError('connection reset');
    const stub = stubbed((call) => {
      if (call <= 2) {
        throw failure;
      }
      return OK;
    });
    const { missed, onMissed } = recorder();
    const handle = start(stub.client, { onMissed });
    await flush();
    expect(missed).toEqual([failure]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(missed).toEqual([failure, failure]);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    // Recovered: two successes, no new miss, still running.
    expect(stub.request).toHaveBeenCalledTimes(4);
    expect(missed).toHaveLength(2);
    expect(handle.running).toBe(true);
  });

  test('a transport or HTTP failure is passed to onMissed as the error it is', async () => {
    fakeTimers();
    const errors = [
      new RequestRejectedError('down', {
        code: 'service_unavailable',
        service: 'orderbook',
        status: 503,
      }),
      new TimeoutError('timed out', { service: 'orderbook' }),
      new TransportError('no response', { service: 'orderbook' }),
      new AuthRequiredError('no credentials', { service: 'orderbook' }),
    ];
    const stub = stubbed((call) => {
      throw errors[call - 1];
    });
    const { missed, onMissed } = recorder();
    start(stub.client, { onMissed });
    for (let i = 0; i < errors.length; i += 1) {
      await vi.advanceTimersByTimeAsync(i === 0 ? 0 : 10_000);
    }
    expect(missed).toHaveLength(errors.length);
    missed.forEach((error, i) => {
      expect(error).toBe(errors[i]);
    });
  });

  test('tracked:false is a miss: heartbeat_not_tracked, service orderbook, never a success', async () => {
    fakeTimers();
    const stub = stubbed(() => ({ status: 'ok', tracked: false }));
    const { missed, onMissed } = recorder();
    const handle = start(stub.client, { onMissed });
    await flush();
    expect(missed).toHaveLength(1);
    const error = missed[0] as XoError;
    expect(error).toBeInstanceOf(XoError);
    expect(error.constructor).toBe(XoError);
    expect(error.code).toBe('heartbeat_not_tracked');
    expect(error.service).toBe('orderbook');
    // It is a miss every time, and the loop keeps beating: the account is not protected.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(missed).toHaveLength(3);
    expect(handle.running).toBe(true);
    expect(stub.request).toHaveBeenCalledTimes(3);
  });

  test.each([
    ['no tracked field', { status: 'ok' }],
    ['tracked is a string', { status: 'ok', tracked: 'true' }],
    ['tracked is a number', { status: 'ok', tracked: 1 }],
    ['tracked is null', { status: 'ok', tracked: null }],
    ['an empty object', {}],
    ['null', null],
    ['a string', 'ok'],
    ['an array', [{ tracked: true }]],
  ])(
    'an answer that does not say tracked:true is a miss: %s',
    async (_name, body) => {
      fakeTimers();
      const stub = stubbed(() => body);
      const { missed, onMissed } = recorder();
      start(stub.client, { onMissed });
      await flush();
      expect(missed).toHaveLength(1);
      // One code to switch on, with the parse error as the cause.
      const error = missed[0] as XoError;
      expect(error.constructor).toBe(XoError);
      expect(error.code).toBe('heartbeat_not_tracked');
      expect(error.service).toBe('orderbook');
      expect(error.cause).toBeInstanceOf(UnexpectedResponseError);
    },
  );

  test('a 200 whose body is not JSON (the transport raises UnexpectedResponseError) is heartbeat_not_tracked too', async () => {
    fakeTimers();
    const cause = new UnexpectedResponseError(
      'POST /v1/heartbeats returned a body that is not valid JSON',
      { service: 'orderbook', status: 200, issues: [] },
    );
    const stub = stubbed(() => {
      throw cause;
    });
    const { missed, onMissed } = recorder();
    start(stub.client, { onMissed });
    await flush();
    expect(missed).toHaveLength(1);
    const error = missed[0] as XoError;
    expect(error.code).toBe('heartbeat_not_tracked');
    expect(error.cause).toBe(cause);
  });

  test('a throw that is not an XoError is wrapped in one (heartbeat_failed) with the cause', async () => {
    fakeTimers();
    const cause = new TypeError('fetch failed');
    const stub = stubbed(() => {
      throw cause;
    });
    const { missed, onMissed } = recorder();
    start(stub.client, { onMissed });
    await flush();
    expect(missed).toHaveLength(1);
    const error = missed[0] as XoError;
    expect(error).toBeInstanceOf(XoError);
    expect(error.code).toBe('heartbeat_failed');
    expect(error.service).toBe('orderbook');
    expect(error.cause).toBe(cause);
  });

  test('failures without an onMissed are silent and the loop goes on', async () => {
    fakeTimers();
    const stub = stubbed(() => {
      throw new TransportError('down');
    });
    const handle = start(stub.client);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stub.request).toHaveBeenCalledTimes(4);
    expect(handle.running).toBe(true);
  });

  test('an onMissed that throws is swallowed and the loop keeps beating', async () => {
    fakeTimers();
    const stub = stubbed(() => {
      throw new TransportError('down');
    });
    const onMissed = vi.fn(() => {
      throw new Error('the observer is broken');
    });
    const handle = start(stub.client, { onMissed });
    await flush();
    expect(onMissed).toHaveBeenCalledTimes(1);
    expect(handle.running).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onMissed).toHaveBeenCalledTimes(3);
    expect(stub.request).toHaveBeenCalledTimes(3);
    expect(handle.running).toBe(true);
  });

  test('an async onMissed that rejects does not become an unhandled rejection', async () => {
    fakeTimers();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const stub = stubbed(() => {
        throw new TransportError('down');
      });
      // A plain function: vi.fn() would attach its own handler to the returned promise and
      // hide the very rejection this test looks for.
      let calls = 0;
      const onMissed = async (): Promise<void> => {
        calls += 1;
        throw new Error('async observer failed');
      };
      const handle = start(stub.client, { onMissed });
      await flush();
      await vi.advanceTimersByTimeAsync(10_000);
      // Unhandled rejections surface on a later turn of the real event loop.
      await settle();
      await settle();
      expect(calls).toBe(2);
      expect(unhandled).toEqual([]);
      expect(handle.running).toBe(true);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });
});

describe('startHeartbeat: options (stub transport)', () => {
  test.each([
    ['999', 999],
    ['20001', 20_001],
    ['0', 0],
    ['negative', -10_000],
    ['fractional', 10_000.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a numeric string', '10000'],
    ['null', null],
    ['a boolean', true],
    ['a bigint', 10_000n],
  ])(
    'intervalMs %s is a UserInputError, with no request and no timer',
    (_name, value) => {
      fakeTimers();
      const stub = stubbed();
      expect(() =>
        stub.client.startHeartbeat({ intervalMs: value as number }),
      ).toThrow(UserInputError);
      expect(stub.request).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      // Nothing is left "running": a valid start works.
      expect(start(stub.client).running).toBe(true);
    },
  );

  test('intervalMs 1000 and 20000 are accepted', () => {
    fakeTimers();
    for (const intervalMs of [1_000, 20_000]) {
      const stub = stubbed();
      expect(start(stub.client, { intervalMs }).running).toBe(true);
    }
  });

  test('the message names the field and the range', () => {
    const stub = stubbed();
    let message = '';
    try {
      stub.client.startHeartbeat({ intervalMs: 30_000 });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('intervalMs');
    expect(message).toContain('1000');
    expect(message).toContain('20000');
  });

  test('an unknown option, a non-function onMissed or non-object options are refused', () => {
    fakeTimers();
    const stub = stubbed();
    const call = (options: unknown) => () =>
      stub.client.startHeartbeat(options as HeartbeatOptions);
    expect(call({ interval: 5_000 })).toThrow(UserInputError);
    expect(call({ onMissed: 'log' })).toThrow(UserInputError);
    expect(call({ onMissed: null })).toThrow(UserInputError);
    expect(call(null)).toThrow(UserInputError);
    expect(call('fast')).toThrow(UserInputError);
    expect(call([])).toThrow(UserInputError);
    expect(stub.request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('no argument, {} and explicit undefined values all mean the defaults', async () => {
    fakeTimers();
    for (const options of [
      undefined,
      {},
      { intervalMs: undefined, onMissed: undefined },
    ]) {
      const stub = stubbed();
      const handle = start(stub.client, options);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(stub.request).toHaveBeenCalledTimes(2);
      handle.stop();
    }
  });
});

describe('startHeartbeat: timers (a heartbeat never keeps the process alive)', () => {
  test('unref() is called on every timer that has it: the ticks and the deadlines', async () => {
    const unrefs: Array<ReturnType<typeof vi.fn>> = [];
    const fire: Array<() => void> = [];
    vi.stubGlobal('setTimeout', (fn: () => void) => {
      const unref = vi.fn();
      unrefs.push(unref);
      fire.push(fn);
      return { unref };
    });
    const clear = vi.fn();
    vi.stubGlobal('clearTimeout', clear);

    const stub = stubbed();
    const handle = start(stub.client);
    expect(unrefs).toHaveLength(2); // the tick and the deadline of the first beat
    await microtasks(); // the first beat is answered; its deadline is cleared
    expect(clear).toHaveBeenCalledTimes(1);
    fire.shift()?.(); // the interval elapses
    expect(unrefs).toHaveLength(4); // the re-armed tick and the second beat's deadline
    expect(stub.request).toHaveBeenCalledTimes(2);
    for (const unref of unrefs) {
      expect(unref).toHaveBeenCalledTimes(1);
    }

    handle.stop();
    expect(clear).toHaveBeenCalledTimes(3); // the pending tick and deadline are cancelled
  });

  test('a timer without unref (a browser id) is fine', async () => {
    let id = 0;
    const fire: Array<() => void> = [];
    vi.stubGlobal('setTimeout', (fn: () => void) => {
      fire.push(fn);
      id += 1;
      return id;
    });
    vi.stubGlobal('clearTimeout', vi.fn());

    const stub = stubbed();
    const handle = start(stub.client);
    await microtasks();
    fire.shift()?.();
    expect(stub.request).toHaveBeenCalledTimes(2);
    expect(handle.running).toBe(true);
  });

  test('a real Node timer is not ref()ed', () => {
    const realSetTimeout = globalThis.setTimeout;
    const timers: Array<{ hasRef(): boolean }> = [];
    vi.stubGlobal('setTimeout', (fn: () => void, ms?: number) => {
      const timer = realSetTimeout(fn, ms);
      timers.push(timer);
      return timer;
    });
    const stub = stubbed();
    const handle = start(stub.client);
    expect(timers).toHaveLength(2); // the tick and the deadline of the first beat
    for (const timer of timers) {
      expect(timer.hasRef()).toBe(false);
    }
    handle.stop();
  });
});

// ---------------------------------------------------------------------------
// The wire: msw, the fake gateway and the real transport + session
// ---------------------------------------------------------------------------

interface RigOptions {
  smartWallet?: boolean;
  strict?: boolean;
  /** `false`: no session on the client. */
  session?: false;
  /** The transport's auth provider, built around the session. */
  auth?: (session: Session) => AuthProvider;
}

function rig(o: RigOptions = {}) {
  const transport = new Transport({
    env,
    version: '0.0.0-test',
    maxRetries: 2,
  });
  const orderbook = installOrderbook(server, {
    smartAccounts: o.smartWallet
      ? { [ACCOUNT.toLowerCase()]: { owner: OWNER } }
      : {},
  });
  installMarketData(server);
  const trading = installTrading(server, orderbook);
  const trader: Address = o.smartWallet ? ACCOUNT : OWNER;
  const credential = seedKey(orderbook, trader);
  const session = newSession(transport, o.smartWallet);
  transport.setAuth(o.auth === undefined ? session : o.auth(session));
  const chain: ContractReader = {
    readContract: async () =>
      encodeAbiParameters([{ type: 'uint128' }], [7n]) as Hex,
  };
  const client = new OrderbookClient({
    transport,
    env,
    ...(o.session === false ? {} : { session }),
    chain,
    strictResponses: o.strict ?? true,
  });
  return { client, trading, credential, trader };
}

/** The heartbeat requests that reached the fake gateway. */
const beats = (trading: Trading) =>
  trading.requests.filter((r) => `${r.method} ${r.path}` === ROUTE);

/** Waits until `n` heartbeats were received, then lets the last answer be processed. */
async function untilBeats(trading: Trading, n: number): Promise<void> {
  await until(() => beats(trading).length >= n, `${n} heartbeat(s)`);
  await settle();
}

/** Signs over the legacy path while posting to the canonical one: a mis-signed request. */
const signsWrongPath = (session: Session): AuthProvider => ({
  headers: (kind, req) =>
    session.headers(kind, { ...req, path: '/heartbeats' }),
  onUnauthorized: (kind, ctx) => session.onUnauthorized(kind, ctx),
});

/** Sends no credentials at all. */
const sendsNothing = (): AuthProvider => ({
  headers: async () => ({}),
  onUnauthorized: async () => false,
});

describe('the fake gateway', () => {
  test('a heartbeat without a valid HMAC is a 200 with tracked:false, never a 401', async () => {
    const { trading } = rig();
    const bare = await fetch(`${BASE}/v1/heartbeats`, { method: 'POST' });
    expect(bare.status).toBe(200);
    expect(await bare.json()).toEqual({ status: 'ok', tracked: false });
    const garbled = await fetch(`${BASE}/v1/heartbeats`, {
      method: 'POST',
      headers: {
        XO_API_KEY: 'unknown',
        XO_PASSPHRASE: 'x',
        XO_TIMESTAMP: '1',
        XO_SIGNATURE: 'x',
      },
    });
    expect(garbled.status).toBe(200);
    expect(await garbled.json()).toEqual({ status: 'ok', tracked: false });
    expect(trading.heartbeats.size).toBe(0);
  });
});

describe('startHeartbeat: opt-in', () => {
  test('no heartbeat request is ever sent unless startHeartbeat is called', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, trading } = rig();

    // A client at work: it reads, it signs, it places an order.
    const placed = await client.placeOrder({
      tokenId: TOKEN_YES,
      side: 'BUY',
      price: '0.5',
      size: '10',
    });
    expect(placed.orderHash).toMatch(/^0x[0-9a-f]{64}$/);
    await client.getClaimable();
    expect(trading.calls).toContain('POST /order');

    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();

    expect(beats(trading)).toHaveLength(0);
    expect(trading.calls.filter((c) => /heartbeats/.test(c))).toEqual([]);
    expect(trading.heartbeats.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('constructing the client and its session sends nothing either', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { trading } = rig();
    await vi.advanceTimersByTimeAsync(120_000);
    await settle();
    expect(trading.calls).toEqual([]);
  });
});

describe('startHeartbeat: the request, on the wire', () => {
  test('POST /v1/heartbeats, L2-signed over that exact path with an empty body, is tracked', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, trading, credential, trader } = rig();
    const { missed, onMissed } = recorder();
    start(client, { onMissed });
    await untilBeats(trading, 1);

    const sent = beats(trading)[0];
    expect(sent?.method).toBe('POST');
    expect(sent?.path).toBe('/v1/heartbeats');
    expect(sent?.search).toBe('');
    expect(sent?.body).toBe('');
    expect(sent?.headers.get('content-type')).toBeNull();
    expect(sent?.headers.get('XO_API_KEY')).toBe(credential.apiKey);
    expect(sent?.headers.get('XO_PASSPHRASE')).toBe(credential.passphrase);

    // The fake verified the HMAC over '/v1/heartbeats' + '' (as the gateway does): the
    // account is tracked, which a different path or body would not have achieved.
    expect(trading.heartbeats.has(trader.toLowerCase())).toBe(true);
    expect(missed).toEqual([]);
    // Only the canonical path, never the legacy alias.
    expect(trading.calls.filter((c) => c.includes('heartbeats'))).toEqual([
      ROUTE,
    ]);
  });

  test('sends every 10 s, each beat signed with a fresh timestamp (Date faked over 5 minutes)', async () => {
    // Date is faked too, so the fake gateway's 30 s L2 window moves with the beats: a header
    // signed once and reused would be stale after 30 s and the beat would be a miss.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { client, trading, trader } = rig();
    const { missed, onMissed } = recorder();
    const handle = start(client, { onMissed });
    await untilBeats(trading, 1);

    await vi.advanceTimersByTimeAsync(9_999);
    await settle();
    expect(beats(trading)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await untilBeats(trading, 2);
    expect(beats(trading)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    await untilBeats(trading, 3);
    await vi.advanceTimersByTimeAsync(10_000);
    await untilBeats(trading, 4);
    expect(beats(trading)).toHaveLength(4);

    // Go on to five minutes: 31 beats in all.
    for (let n = 5; n <= 31; n += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      await untilBeats(trading, n);
    }
    expect(beats(trading)).toHaveLength(31);
    expect(missed).toEqual([]);
    expect(handle.running).toBe(true);

    const stamps = beats(trading).map((r) =>
      Number(r.headers.get('XO_TIMESTAMP')),
    );
    const first = stamps[0] as number;
    stamps.forEach((stamp, i) => {
      // One beat per 10 s of fake time, each signed at its own time (to the second).
      expect(Math.abs(stamp - (first + 10 * i))).toBeLessThanOrEqual(1);
    });
    expect(new Set(stamps).size).toBe(stamps.length);
    // The fake registered every beat: the last one is current as of the fake clock.
    expect(trading.heartbeats.get(trader.toLowerCase())).toBeGreaterThan(
      Date.now() - 1_000,
    );
  });

  test('stop() halts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, trading } = rig();
    const handle = start(client);
    await untilBeats(trading, 1);
    await vi.advanceTimersByTimeAsync(10_000);
    await untilBeats(trading, 2);

    handle.stop();
    expect(handle.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    await settle();
    expect(beats(trading)).toHaveLength(2);
  });

  test('a smart wallet heartbeats as the smart wallet: the smart wallet is the one that trades', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, trading, trader } = rig({ smartWallet: true });
    const { missed, onMissed } = recorder();
    start(client, { onMissed });
    await untilBeats(trading, 1);
    expect(trader).toBe(ACCOUNT);
    expect([...trading.heartbeats.keys()]).toEqual([ACCOUNT.toLowerCase()]);
    expect(missed).toEqual([]);
  });

  test('without a session: AuthRequiredError at once, and no request is made', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, trading } = rig({ session: false });
    expect(() => client.startHeartbeat()).toThrow(AuthRequiredError);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(trading.calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('startHeartbeat: misses, on the wire', () => {
  test.each([
    ['signed over the wrong path', signsWrongPath],
    ['sent without any credentials', sendsNothing],
  ])(
    'a mis-authenticated heartbeat is a miss, not a success: %s',
    async (_name, auth) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { client, trading } = rig({ auth });
      const { missed, onMissed } = recorder();
      const handle = start(client, { onMissed });
      await untilBeats(trading, 1);
      await until(() => missed.length >= 1, 'a miss');

      // The gateway said 200: the SDK did not take that for success.
      expect(trading.heartbeats.size).toBe(0);
      const error = missed[0] as XoError;
      expect(error).toBeInstanceOf(XoError);
      expect(error.code).toBe('heartbeat_not_tracked');
      expect(error.service).toBe('orderbook');
      // It keeps trying: the next beat is a miss again.
      await vi.advanceTimersByTimeAsync(10_000);
      await untilBeats(trading, 2);
      await until(() => missed.length >= 2, 'a second miss');
      expect(handle.running).toBe(true);
    },
  );

  test('the heartbeat_not_tracked error carries no secrets', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, trading, credential } = rig({ auth: signsWrongPath });
    const { missed, onMissed } = recorder();
    start(client, { onMissed });
    await untilBeats(trading, 1);
    await until(() => missed.length >= 1, 'a miss');

    const sent = beats(trading)[0];
    const everything = [
      (missed[0] as XoError).message,
      JSON.stringify(missed[0]),
      String((missed[0] as XoError).stack),
      String((missed[0] as XoError).cause),
    ].join('\n');
    for (const secret of [
      credential.apiKey,
      credential.secret,
      credential.passphrase,
      sent?.headers.get('XO_SIGNATURE') ?? 'unreachable-signature',
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  test('onMissed fires on failure and keeps trying', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, trading, trader } = rig();
    let failures = 2;
    trading.override = (route) => {
      if (route === ROUTE && failures > 0) {
        failures -= 1;
        return HttpResponse.json(
          { error: 'service_unavailable', retry_after_ms: 0 },
          { status: 503 },
        );
      }
      return undefined;
    };
    const { missed, onMissed } = recorder();
    const handle = start(client, { onMissed });
    await untilBeats(trading, 1);
    await until(() => missed.length === 1, 'the first miss');
    expect(missed[0]).toSatisfy(serverFailure);

    await vi.advanceTimersByTimeAsync(10_000);
    await untilBeats(trading, 2);
    await until(() => missed.length === 2, 'the second miss');

    // The third beat gets through, and nothing new is reported.
    await vi.advanceTimersByTimeAsync(10_000);
    await untilBeats(trading, 3);
    expect(trading.heartbeats.has(trader.toLowerCase())).toBe(true);
    expect(missed).toHaveLength(2);
    expect(handle.running).toBe(true);
    // Heartbeats are never retried inside a beat: one request per beat, even on a 503.
    expect(beats(trading)).toHaveLength(3);
  });

  test('a network failure is a miss (TransportError) and the next beat is tried', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, trading, trader } = rig();
    let down = true;
    trading.override = (route) =>
      route === ROUTE && down ? HttpResponse.error() : undefined;
    const { missed, onMissed } = recorder();
    start(client, { onMissed });
    await untilBeats(trading, 1);
    await until(() => missed.length === 1, 'the miss');
    expect(missed[0]).toBeInstanceOf(TransportError);

    down = false;
    await vi.advanceTimersByTimeAsync(10_000);
    await untilBeats(trading, 2);
    expect(trading.heartbeats.has(trader.toLowerCase())).toBe(true);
    expect(missed).toHaveLength(1);
  });

  /** Runs one beat against a gateway that answers with `respond()`, and returns the misses. */
  async function missesFor(
    respond: () => Response,
    strict = false,
  ): Promise<XoError[]> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, trading } = rig({ strict });
    trading.override = (route) => (route === ROUTE ? respond() : undefined);
    const { missed, onMissed } = recorder();
    const handle = start(client, { onMissed });
    await untilBeats(trading, 1);
    handle.stop();
    server.resetHandlers();
    return missed;
  }

  test.each([
    ['no tracked field', () => HttpResponse.json({ status: 'ok' })],
    ['tracked null', () => HttpResponse.json({ status: 'ok', tracked: null })],
    ['tracked a string', () => HttpResponse.json({ tracked: 'true' })],
    ['an empty body', () => new HttpResponse(null, { status: 200 })],
    [
      'plain text',
      () =>
        new HttpResponse('ok', { headers: { 'content-type': 'text/plain' } }),
    ],
    [
      'invalid JSON',
      () =>
        new HttpResponse('{"tracked": tru', {
          headers: { 'content-type': 'application/json' },
        }),
    ],
  ])(
    'an answer that is not { tracked: boolean } is heartbeat_not_tracked, with the parse error as cause: %s',
    async (_name, respond) => {
      const missed = await missesFor(respond);
      expect(missed).toHaveLength(1);
      const error = missed[0] as XoError;
      expect(error.constructor).toBe(XoError);
      expect(error.code).toBe('heartbeat_not_tracked');
      expect(error.service).toBe('orderbook');
      expect(error.cause).toBeInstanceOf(UnexpectedResponseError);
    },
  );

  test('lenient mode keeps unknown fields: only tracked is required', async () => {
    const missed = await missesFor(
      () => HttpResponse.json({ tracked: true, shard: 'eu-1' }),
      false,
    );
    expect(missed).toEqual([]);
  });

  test('strict mode (contract tests): an unknown field is reported as a miss, a safe-direction false alarm', async () => {
    const missed = await missesFor(
      () => HttpResponse.json({ status: 'ok', tracked: true, shard: 'eu-1' }),
      true,
    );
    expect(missed).toHaveLength(1);
    expect((missed[0] as XoError).code).toBe('heartbeat_not_tracked');
    expect((missed[0] as XoError).cause).toBeInstanceOf(
      UnexpectedResponseError,
    );
  });
});

describe('startHeartbeat: a hung auth provider, on the wire', () => {
  test('the watchdog abandons the beat (nothing reaches the gateway) and the next tick tries again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // The transport runs `headers()` outside its timeout and its abort signal: only the
    // watchdog can end a beat that is stuck there.
    let headerCalls = 0;
    const hangs = (): AuthProvider => ({
      headers: () => {
        headerCalls += 1;
        return new Promise(() => {});
      },
      onUnauthorized: async () => false,
    });
    const { client, trading } = rig({ auth: hangs });
    const { missed, onMissed } = recorder();
    start(client, { onMissed });
    await until(() => headerCalls === 1, 'the first headers() call');

    await vi.advanceTimersByTimeAsync(5_999);
    expect(missed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); // 6 s
    expect(missed).toHaveLength(1);
    expect(missed[0]).toBeInstanceOf(TimeoutError);

    await vi.advanceTimersByTimeAsync(4_000); // 10 s: a new attempt, not a stalled loop
    await until(() => headerCalls === 2, 'the second headers() call');
    await vi.advanceTimersByTimeAsync(6_000); // 16 s
    expect(missed).toHaveLength(2);
    expect(trading.calls).toEqual([]); // no heartbeat ever got out
  });
});

describe('startHeartbeat: a slow gateway, on the wire', () => {
  // This proves the overlap guard under fake time, with real traffic: a gateway that holds
  // the first request past one tick gets no second request. The bound on how long a request
  // may be held is the transport's `AbortSignal.timeout`, which runs on real time and so does
  // not move with the fake clock here (the real-timer test below covers it); the loop's own
  // watchdog is fake-time and is covered above.
  test('a response slower than intervalMs (but within its deadline) gives one request in flight and no pile-up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, trading, trader } = rig();
    const gate = deferred();
    trading.heartbeatGate = gate.promise;
    const { missed, onMissed } = recorder();
    // intervalMs 2000: the deadline is 3000 ms, so the tick at 2000 ms finds the beat in flight.
    start(client, { intervalMs: 2_000, onMissed });
    await until(() => beats(trading).length === 1, 'the first request');

    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    expect(beats(trading)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(500);
    gate.resolve();
    await settle();
    expect(trading.heartbeats.has(trader.toLowerCase())).toBe(true);
    expect(beats(trading)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_500); // 4 s: the next tick
    await untilBeats(trading, 2);
    expect(missed).toEqual([]);
  });

  test('stop() during an in-flight request means no further requests and no report', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Mis-signed, so the late answer would be a miss if anyone listened to it.
    const { client, trading } = rig({ auth: signsWrongPath });
    const gate = deferred();
    trading.heartbeatGate = gate.promise;
    const { missed, onMissed } = recorder();
    const handle = start(client, { onMissed });
    await until(() => beats(trading).length === 1, 'the first request');

    handle.stop();
    gate.resolve();
    await settle();
    await vi.advanceTimersByTimeAsync(120_000);
    await settle();
    expect(beats(trading)).toHaveLength(1);
    expect(missed).toEqual([]);
    expect(handle.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('startHeartbeat: a gateway that never answers (real timers)', () => {
  test('the request times out after min(intervalMs, 5000) and is reported as a miss', async () => {
    const { client, trading } = rig();
    trading.heartbeatGate = new Promise(() => {}); // the request is received, never answered
    const { missed, onMissed } = recorder();
    const began = Date.now();
    start(client, { intervalMs: 1_000, onMissed });
    while (missed.length === 0 && Date.now() - began < 4_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(missed.length).toBeGreaterThanOrEqual(1);
    const error = missed[0];
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as XoError).message).toContain('1000 ms');
    // Real time: about one timeout, not the transport's 15 s default.
    expect(Date.now() - began).toBeLessThan(3_000);
  });
});
