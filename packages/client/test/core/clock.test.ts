import { afterEach, describe, expect, test, vi } from 'vitest';
import { Clock } from '../../src/core/clock';
import { UnexpectedResponseError, UserInputError } from '../../src/core/errors';

/** A server time in unix seconds that passes validation (about 2023-11-14). */
const SERVER_SEC = 1_700_000_000;
const SERVER_MS = SERVER_SEC * 1000;
const TEN_MINUTES = 600_000;

/** A mutable fake time. The clock under test reads it through `now`. */
function fakeTime(startMs: number) {
  const state = { ms: startMs };
  return {
    now: () => state.ms,
    set: (ms: number) => {
      state.ms = ms;
    },
    advance: (ms: number) => {
      state.ms += ms;
    },
  };
}

/** A promise the test settles by hand, to hold a fetch in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets pending promise callbacks run, including chains several promises deep. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  unhandled.length = 0;
});

describe('Clock offset', () => {
  test('before any sync nowSec uses the local time', () => {
    const time = fakeTime(SERVER_MS + 90_000);
    const fetchServerTimeSec = vi.fn(async () => SERVER_SEC);
    const clock = new Clock({ fetchServerTimeSec, now: time.now });

    expect(clock.nowSec()).toBe(SERVER_SEC + 90);
    expect(fetchServerTimeSec).not.toHaveBeenCalled();
  });

  test('corrects a local clock that runs 90 s ahead', async () => {
    const time = fakeTime(SERVER_MS + 90_000);
    const clock = new Clock({
      fetchServerTimeSec: async () => SERVER_SEC,
      now: time.now,
    });

    await clock.sync();

    expect(Math.abs(clock.nowSec() - SERVER_SEC)).toBeLessThanOrEqual(1);
  });

  test('corrects a local clock that runs 90 s behind', async () => {
    const time = fakeTime(SERVER_MS - 90_000);
    const clock = new Clock({
      fetchServerTimeSec: async () => SERVER_SEC,
      now: time.now,
    });

    await clock.sync();

    expect(Math.abs(clock.nowSec() - SERVER_SEC)).toBeLessThanOrEqual(1);
  });

  test('keeps the offset as local time moves on', async () => {
    const time = fakeTime(SERVER_MS + 90_000);
    const clock = new Clock({
      fetchServerTimeSec: async () => SERVER_SEC,
      now: time.now,
    });
    await clock.sync();

    time.advance(30_000);

    expect(clock.nowSec()).toBe(SERVER_SEC + 30);
  });

  test('uses the midpoint of the round trip', async () => {
    const time = fakeTime(SERVER_MS);
    // The request takes 2000 ms, so the server read its clock about 1000 ms in.
    const clock = new Clock({
      fetchServerTimeSec: async () => {
        time.advance(2000);
        return SERVER_SEC;
      },
      now: time.now,
    });

    await clock.sync();

    // t0 = SERVER_MS, t1 = SERVER_MS + 2000, midpoint = SERVER_MS + 1000, so the local
    // clock is 1000 ms ahead of the server and the offset is -1000 ms.
    time.set(SERVER_MS + 5000);
    expect(clock.nowSec()).toBe(SERVER_SEC + 4);
    time.set(SERVER_MS + 5999);
    expect(clock.nowSec()).toBe(SERVER_SEC + 4);
    time.set(SERVER_MS + 6000);
    expect(clock.nowSec()).toBe(SERVER_SEC + 5);
  });

  test('nowSec rounds down to whole seconds', async () => {
    const time = fakeTime(SERVER_MS);
    const clock = new Clock({
      fetchServerTimeSec: async () => SERVER_SEC,
      now: time.now,
    });
    await clock.sync();

    time.set(SERVER_MS + 999);
    expect(clock.nowSec()).toBe(SERVER_SEC);
    time.set(SERVER_MS + 1000);
    expect(clock.nowSec()).toBe(SERVER_SEC + 1);
  });

  test('nowSecString is the decimal string of nowSec', async () => {
    const time = fakeTime(SERVER_MS + 90_000);
    const clock = new Clock({
      fetchServerTimeSec: async () => SERVER_SEC,
      now: time.now,
    });

    expect(typeof clock.nowSecString()).toBe('string');
    expect(clock.nowSecString()).toMatch(/^\d+$/);
    expect(clock.nowSecString()).toBe(String(SERVER_SEC + 90));

    await clock.sync();

    expect(clock.nowSecString()).toMatch(/^\d+$/);
    expect(clock.nowSecString()).toBe(String(SERVER_SEC));
  });

  test('defaults now to Date.now', async () => {
    const clock = new Clock({
      fetchServerTimeSec: async () => Math.floor(Date.now() / 1000) + 90,
    });
    expect(
      Math.abs(clock.nowSec() - Math.floor(Date.now() / 1000)),
    ).toBeLessThanOrEqual(1);

    await clock.sync();

    expect(
      Math.abs(clock.nowSec() - (Math.floor(Date.now() / 1000) + 90)),
    ).toBeLessThanOrEqual(1);
  });

  test('the default now is late-bound: fake timers installed after construction apply', () => {
    const real = Date.now();
    const fetchServerTimeSec = vi.fn(async () => SERVER_SEC);
    const clock = new Clock({ fetchServerTimeSec });

    vi.useFakeTimers();
    try {
      // 5 s ahead of the real time, so a `Date.now` captured at construction would
      // read 5 s lower, and no resync is due.
      vi.setSystemTime(real + 5000);
      expect(clock.nowSec()).toBe(Math.floor((real + 5000) / 1000));
      expect(fetchServerTimeSec).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Clock.sync', () => {
  test('a failed sync rejects and keeps the previous offset', async () => {
    const time = fakeTime(SERVER_MS + 90_000);
    const fetchServerTimeSec = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(SERVER_SEC)
      .mockRejectedValueOnce(new Error('network down'));
    const clock = new Clock({ fetchServerTimeSec, now: time.now });
    await clock.sync();
    expect(clock.nowSec()).toBe(SERVER_SEC);

    await expect(clock.sync()).rejects.toThrow('network down');

    expect(clock.nowSec()).toBe(SERVER_SEC);
  });

  test('a failed first sync leaves the offset at zero', async () => {
    const time = fakeTime(SERVER_MS + 90_000);
    const clock = new Clock({
      fetchServerTimeSec: async () => {
        throw new Error('network down');
      },
      now: time.now,
    });

    await expect(clock.sync()).rejects.toThrow('network down');

    expect(clock.nowSec()).toBe(SERVER_SEC + 90);
  });

  test('a fetch that throws synchronously is a rejected sync', async () => {
    const time = fakeTime(SERVER_MS);
    const clock = new Clock({
      fetchServerTimeSec: () => {
        throw new Error('boom');
      },
      now: time.now,
    });

    await expect(clock.sync()).rejects.toThrow('boom');
  });

  test('is single-flight: concurrent calls share one fetch', async () => {
    const time = fakeTime(SERVER_MS);
    const gate = deferred<number>();
    const fetchServerTimeSec = vi.fn(() => gate.promise);
    const clock = new Clock({ fetchServerTimeSec, now: time.now });

    const first = clock.sync();
    const second = clock.sync();
    gate.resolve(SERVER_SEC);
    await Promise.all([first, second]);

    expect(fetchServerTimeSec).toHaveBeenCalledTimes(1);
  });

  test('concurrent callers all see the same failure', async () => {
    const time = fakeTime(SERVER_MS);
    const gate = deferred<number>();
    const fetchServerTimeSec = vi.fn(() => gate.promise);
    const clock = new Clock({ fetchServerTimeSec, now: time.now });

    const first = clock.sync();
    const second = clock.sync();
    gate.reject(new Error('network down'));

    await expect(first).rejects.toThrow('network down');
    await expect(second).rejects.toThrow('network down');
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(1);
  });

  test('a sync after the previous one settled fetches again', async () => {
    const time = fakeTime(SERVER_MS);
    const fetchServerTimeSec = vi.fn(async () => SERVER_SEC);
    const clock = new Clock({ fetchServerTimeSec, now: time.now });

    await clock.sync();
    await clock.sync();

    expect(fetchServerTimeSec).toHaveBeenCalledTimes(2);
  });

  test('a sync after a failed one fetches again', async () => {
    const time = fakeTime(SERVER_MS);
    const fetchServerTimeSec = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(SERVER_SEC);
    const clock = new Clock({ fetchServerTimeSec, now: time.now });

    await expect(clock.sync()).rejects.toThrow('network down');
    await clock.sync();

    expect(fetchServerTimeSec).toHaveBeenCalledTimes(2);
    expect(clock.nowSec()).toBe(SERVER_SEC);
  });

  describe('re-entrancy', () => {
    test('a fetcher that calls sync() and nowSec() synchronously causes one fetch', async () => {
      const time = fakeTime(SERVER_MS);
      let clock: Clock | undefined;
      let inner: Promise<void> | undefined;
      let seen: number | undefined;
      const fetchServerTimeSec = vi.fn((): Promise<number> => {
        // A plain function, so these calls happen before the fetch returns.
        inner = clock?.sync();
        seen = clock?.nowSec();
        return Promise.resolve(SERVER_SEC);
      });
      clock = new Clock({ fetchServerTimeSec, now: time.now });

      const outer = clock.sync();
      await outer;

      expect(fetchServerTimeSec).toHaveBeenCalledTimes(1);
      expect(inner).toBe(outer);
      expect(seen).toBe(SERVER_SEC);
    });

    test('a fetcher that calls nowSec() when a resync is due does not recurse', async () => {
      const time = fakeTime(SERVER_MS);
      let clock: Clock | undefined;
      let reentrant = false;
      const fetchServerTimeSec = vi.fn((): Promise<number> => {
        if (reentrant) {
          clock?.nowSec();
          void clock?.sync();
        }
        return Promise.resolve(SERVER_SEC);
      });
      clock = new Clock({ fetchServerTimeSec, now: time.now });
      await clock.sync();
      expect(fetchServerTimeSec).toHaveBeenCalledTimes(1);

      reentrant = true;
      time.advance(TEN_MINUTES);
      clock.nowSec();
      await flush();

      expect(fetchServerTimeSec).toHaveBeenCalledTimes(2);
    });

    test('a fetcher that calls nowSec() on a never-synced clock with a resync due does not recurse', async () => {
      const time = fakeTime(SERVER_MS);
      let clock: Clock | undefined;
      const fetchServerTimeSec = vi.fn((): Promise<number> => {
        clock?.nowSec();
        return Promise.resolve(SERVER_SEC);
      });
      clock = new Clock({ fetchServerTimeSec, now: time.now });

      time.advance(TEN_MINUTES);
      clock.nowSec();
      await flush();

      expect(fetchServerTimeSec).toHaveBeenCalledTimes(1);
    });

    test('a re-entrant call during a failing fetch sees the same rejection', async () => {
      const time = fakeTime(SERVER_MS);
      let clock: Clock | undefined;
      let inner: Promise<void> | undefined;
      const fetchServerTimeSec = vi.fn((): Promise<number> => {
        inner = clock?.sync();
        return Promise.reject(new Error('network down'));
      });
      clock = new Clock({ fetchServerTimeSec, now: time.now });

      const outer = clock.sync();

      await expect(outer).rejects.toThrow('network down');
      expect(inner).toBe(outer);
      expect(fetchServerTimeSec).toHaveBeenCalledTimes(1);
    });

    test('a fetcher that throws synchronously leaves no sync stuck in flight', async () => {
      const time = fakeTime(SERVER_MS);
      const fetchServerTimeSec = vi
        .fn<() => Promise<number>>()
        .mockImplementationOnce(() => {
          throw new Error('boom');
        })
        .mockResolvedValueOnce(SERVER_SEC);
      const clock = new Clock({ fetchServerTimeSec, now: time.now });

      await expect(clock.sync()).rejects.toThrow('boom');
      await clock.sync();

      expect(fetchServerTimeSec).toHaveBeenCalledTimes(2);
      expect(clock.nowSec()).toBe(SERVER_SEC);
    });
  });

  describe('server value validation', () => {
    const invalid: Array<[string, unknown]> = [
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['a numeric string', '1700000000'],
      ['a negative number', -1_700_000_000],
      ['zero', 0],
      ['milliseconds by mistake', SERVER_MS],
      ['exactly 1e9 (exclusive lower bound)', 1e9],
      ['exactly 1e11 (exclusive upper bound)', 1e11],
      ['null', null],
      ['undefined', undefined],
      ['an object', { time: SERVER_SEC }],
    ];

    test.each(invalid)(
      '%s fails the sync and keeps the offset',
      async (_name, value) => {
        const time = fakeTime(SERVER_MS + 90_000);
        const fetchServerTimeSec = vi
          .fn<() => Promise<number>>()
          .mockResolvedValueOnce(SERVER_SEC)
          .mockResolvedValueOnce(value as number);
        const clock = new Clock({ fetchServerTimeSec, now: time.now });
        await clock.sync();
        expect(clock.nowSec()).toBe(SERVER_SEC);

        const failure = await clock.sync().then(
          () => undefined,
          (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(UnexpectedResponseError);
        expect(clock.nowSec()).toBe(SERVER_SEC);
        const error = failure as UnexpectedResponseError;
        expect(error.message).not.toContain(String(value));
        expect(JSON.stringify(error.toJSON())).not.toContain(String(value));
        expect(JSON.stringify(error.issues)).not.toContain(String(value));
      },
    );

    test('the error message names no value', async () => {
      const clock = new Clock({
        fetchServerTimeSec: async () => 1_234_567_890_123,
        now: fakeTime(SERVER_MS).now,
      });

      const failure = await clock.sync().then(
        () => undefined,
        (error: unknown) => error as UnexpectedResponseError,
      );

      expect(failure).toBeInstanceOf(UnexpectedResponseError);
      expect(failure?.message).not.toMatch(/\d{4,}/);
      expect(JSON.stringify(failure?.toJSON())).not.toMatch(/\d{6,}/);
      expect(failure?.service).toBe('orderbook');
    });

    test('values just inside the bounds are accepted', async () => {
      const time = fakeTime(1_000_000_000_000);
      const clock = new Clock({
        fetchServerTimeSec: vi
          .fn<() => Promise<number>>()
          .mockResolvedValueOnce(1_000_000_001)
          .mockResolvedValueOnce(99_999_999_999),
        now: time.now,
      });

      await expect(clock.sync()).resolves.toBeUndefined();
      await expect(clock.sync()).resolves.toBeUndefined();
    });
  });
});

describe('Clock lazy resync', () => {
  test('starts one background sync once resyncMs has passed since the last sync', async () => {
    const time = fakeTime(SERVER_MS);
    const fetchServerTimeSec = vi.fn(async () => SERVER_SEC);
    const clock = new Clock({
      fetchServerTimeSec,
      now: time.now,
      resyncMs: TEN_MINUTES,
    });
    await clock.sync();
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(1);

    time.advance(TEN_MINUTES - 1);
    clock.nowSec();
    await flush();
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(1);

    time.advance(1);
    clock.nowSec();
    await flush();
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(2);

    // The resync succeeded, so the next one is a whole interval away.
    clock.nowSec();
    await flush();
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(2);
  });

  test('the default interval is ten minutes', async () => {
    const time = fakeTime(SERVER_MS);
    const fetchServerTimeSec = vi.fn(async () => SERVER_SEC);
    const clock = new Clock({ fetchServerTimeSec, now: time.now });
    await clock.sync();

    time.advance(TEN_MINUTES - 1);
    clock.nowSec();
    await flush();
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(1);

    time.advance(1);
    clock.nowSec();
    await flush();
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(2);
  });

  test('nowSec never waits for the background sync and returns the old offset', async () => {
    const time = fakeTime(SERVER_MS + 90_000);
    const second = deferred<number>();
    const fetchServerTimeSec = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(SERVER_SEC)
      .mockReturnValueOnce(second.promise);
    const clock = new Clock({ fetchServerTimeSec, now: time.now });
    await clock.sync();

    time.advance(TEN_MINUTES);
    const during = clock.nowSec();
    expect(typeof during).toBe('number');
    expect(during).toBe(SERVER_SEC + TEN_MINUTES / 1000);
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(2);

    // The server clock has stepped 30 s since; the new offset applies once it lands.
    second.resolve(SERVER_SEC + TEN_MINUTES / 1000 + 30);
    await flush();
    expect(clock.nowSec()).toBe(SERVER_SEC + TEN_MINUTES / 1000 + 30);
  });

  test('concurrent nowSec calls during an in-flight sync start no second fetch', async () => {
    const time = fakeTime(SERVER_MS);
    const gate = deferred<number>();
    const fetchServerTimeSec = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(SERVER_SEC)
      .mockReturnValueOnce(gate.promise);
    const clock = new Clock({ fetchServerTimeSec, now: time.now });
    await clock.sync();

    time.advance(TEN_MINUTES);
    clock.nowSec();
    clock.nowSec();
    clock.nowSec();
    time.advance(TEN_MINUTES);
    clock.nowSec();

    expect(fetchServerTimeSec).toHaveBeenCalledTimes(2);
    gate.resolve(SERVER_SEC + 2 * (TEN_MINUTES / 1000));
    await flush();
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(2);
  });

  test('an explicit sync during a background sync shares its fetch', async () => {
    const time = fakeTime(SERVER_MS);
    const gate = deferred<number>();
    const fetchServerTimeSec = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(SERVER_SEC)
      .mockReturnValueOnce(gate.promise);
    const clock = new Clock({ fetchServerTimeSec, now: time.now });
    await clock.sync();

    time.advance(TEN_MINUTES);
    clock.nowSec();
    const explicit = clock.sync();
    gate.resolve(SERVER_SEC + TEN_MINUTES / 1000);
    await explicit;

    expect(fetchServerTimeSec).toHaveBeenCalledTimes(2);
  });

  test('with no successful sync it starts one after resyncMs from construction', async () => {
    const time = fakeTime(SERVER_MS);
    const fetchServerTimeSec = vi.fn(async () => SERVER_SEC);
    const clock = new Clock({
      fetchServerTimeSec,
      now: time.now,
      resyncMs: 1000,
    });

    clock.nowSec();
    time.advance(999);
    clock.nowSec();
    await flush();
    expect(fetchServerTimeSec).not.toHaveBeenCalled();

    time.advance(1);
    clock.nowSec();
    await flush();
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(1);
  });

  test('a first background sync applies its offset', async () => {
    const time = fakeTime(SERVER_MS + 90_000);
    const clock = new Clock({
      fetchServerTimeSec: async () => SERVER_SEC + 60,
      now: time.now,
      resyncMs: 60_000,
    });

    time.advance(60_000);
    clock.nowSec();
    await flush();

    expect(clock.nowSec()).toBe(SERVER_SEC + 60);
  });

  test('a failing background sync is swallowed, throttled and retried after resyncMs', async () => {
    process.on('unhandledRejection', onUnhandled);
    const time = fakeTime(SERVER_MS);
    const fetchServerTimeSec = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(SERVER_SEC)
      .mockRejectedValue(new Error('endpoint down'));
    const clock = new Clock({
      fetchServerTimeSec,
      now: time.now,
      resyncMs: 1000,
    });
    await clock.sync();

    time.advance(1000);
    clock.nowSec();
    await flush();
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(2);

    // Many calls inside the next interval do not fetch.
    for (let i = 0; i < 20; i += 1) {
      time.advance(40);
      clock.nowSec();
    }
    await flush();
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(2);

    // Once another full interval has passed since the failure, it tries again.
    time.advance(1000);
    clock.nowSec();
    await flush();
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(3);

    // That failure throttles the next attempt too.
    for (let i = 0; i < 20; i += 1) {
      time.advance(40);
      clock.nowSec();
    }
    await flush();
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(3);

    // Let Node run its own unhandled-rejection check before asserting.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
    // The offset from the one good sync is still in force.
    expect(clock.nowSec()).toBe(Math.floor(time.now() / 1000));
  });

  test('a never-synced clock with a broken endpoint fetches once per interval', async () => {
    process.on('unhandledRejection', onUnhandled);
    const time = fakeTime(SERVER_MS);
    const fetchServerTimeSec = vi.fn(async (): Promise<number> => {
      throw new Error('endpoint down');
    });
    const clock = new Clock({
      fetchServerTimeSec,
      now: time.now,
      resyncMs: 1000,
    });

    time.advance(1000);
    for (let i = 0; i < 50; i += 1) {
      clock.nowSec();
      await flush();
    }
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(1);

    time.advance(1000);
    for (let i = 0; i < 50; i += 1) {
      clock.nowSec();
      await flush();
    }
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(2);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  });

  test('a background sync returning an invalid value is swallowed and keeps the offset', async () => {
    process.on('unhandledRejection', onUnhandled);
    const time = fakeTime(SERVER_MS + 90_000);
    const fetchServerTimeSec = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(SERVER_SEC)
      .mockResolvedValueOnce(SERVER_MS);
    const clock = new Clock({
      fetchServerTimeSec,
      now: time.now,
      resyncMs: 1000,
    });
    await clock.sync();

    time.advance(1000);
    clock.nowSec();
    await flush();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(fetchServerTimeSec).toHaveBeenCalledTimes(2);
    expect(unhandled).toEqual([]);
    expect(clock.nowSec()).toBe(SERVER_SEC + 1);
  });

  test('a background fetch that throws synchronously is swallowed', async () => {
    process.on('unhandledRejection', onUnhandled);
    const time = fakeTime(SERVER_MS);
    const clock = new Clock({
      fetchServerTimeSec: () => {
        throw new Error('boom');
      },
      now: time.now,
      resyncMs: 1000,
    });

    time.advance(1000);
    expect(() => clock.nowSec()).not.toThrow();
    await flush();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(unhandled).toEqual([]);
  });

  test('a failed explicit sync also throttles the lazy resync', async () => {
    process.on('unhandledRejection', onUnhandled);
    const time = fakeTime(SERVER_MS);
    const fetchServerTimeSec = vi.fn(async (): Promise<number> => {
      throw new Error('endpoint down');
    });
    const clock = new Clock({
      fetchServerTimeSec,
      now: time.now,
      resyncMs: 1000,
    });

    time.advance(5000);
    await expect(clock.sync()).rejects.toThrow('endpoint down');
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(1);

    clock.nowSec();
    await flush();
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(1);

    time.advance(1000);
    clock.nowSec();
    await flush();
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(2);
  });

  test('a local clock stepped backwards after a sync triggers a resync', async () => {
    const time = fakeTime(SERVER_MS);
    const fetchServerTimeSec = vi.fn(async () => SERVER_SEC);
    const clock = new Clock({ fetchServerTimeSec, now: time.now });
    await clock.sync();

    time.advance(-3_600_000);
    clock.nowSec();
    await flush();

    expect(fetchServerTimeSec).toHaveBeenCalledTimes(2);
    // That attempt is the new reference point, so it is throttled again.
    clock.nowSec();
    await flush();
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(2);
  });

  test('the interval runs from the end of the round trip, not its start', async () => {
    const time = fakeTime(SERVER_MS);
    // Each fetch takes 2000 ms of fake time, so t1 = t0 + 2000.
    const fetchServerTimeSec = vi.fn(async () => {
      time.advance(2000);
      return SERVER_SEC;
    });
    const clock = new Clock({
      fetchServerTimeSec,
      now: time.now,
      resyncMs: 10_000,
    });
    await clock.sync();
    const t1 = time.now();
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(1);

    // Measured from t0 the resync would already be due at t0 + 10_000 = t1 + 8000.
    time.set(t1 + 9999);
    clock.nowSec();
    await flush();
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(1);

    time.set(t1 + 10_000);
    clock.nowSec();
    await flush();
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(2);
  });

  test('a failed round trip throttles from when it failed, not when it started', async () => {
    process.on('unhandledRejection', onUnhandled);
    const time = fakeTime(SERVER_MS);
    const fetchServerTimeSec = vi.fn(async (): Promise<number> => {
      time.advance(2000);
      throw new Error('endpoint down');
    });
    const clock = new Clock({
      fetchServerTimeSec,
      now: time.now,
      resyncMs: 10_000,
    });

    time.advance(10_000);
    clock.nowSec();
    await flush();
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(1);
    const failedAt = time.now();

    time.set(failedAt + 9999);
    clock.nowSec();
    await flush();
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(1);

    time.set(failedAt + 10_000);
    clock.nowSec();
    await flush();
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(2);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  });

  test('a failing background resync that an explicit sync() also awaits rejects the caller and leaks nothing', async () => {
    process.on('unhandledRejection', onUnhandled);
    const time = fakeTime(SERVER_MS);
    const gate = deferred<number>();
    const fetchServerTimeSec = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(SERVER_SEC)
      .mockReturnValueOnce(gate.promise);
    const clock = new Clock({ fetchServerTimeSec, now: time.now });
    await clock.sync();

    time.advance(TEN_MINUTES);
    clock.nowSec();
    const explicit = clock.sync();
    const outcome = explicit.then(
      () => 'resolved',
      (error: unknown) => error,
    );
    gate.reject(new Error('endpoint down'));

    expect(await outcome).toEqual(new Error('endpoint down'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(2);
    expect(unhandled).toEqual([]);
  });

  test('creates no timers', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const time = fakeTime(SERVER_MS);
      const clock = new Clock({
        fetchServerTimeSec: async () => SERVER_SEC,
        now: time.now,
        resyncMs: 1000,
      });
      await clock.sync();
      time.advance(1000);
      clock.nowSec();
      await flush();

      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(setTimeoutSpy).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });
});

describe('Clock maxRttMs', () => {
  /** A fetcher that takes `rttMs` of fake time to answer with `SERVER_SEC`. */
  function slowFetcher(time: ReturnType<typeof fakeTime>, rttMs: () => number) {
    return vi.fn(async () => {
      time.advance(rttMs());
      return SERVER_SEC;
    });
  }

  test('a round trip over the limit fails the sync and keeps the offset', async () => {
    const time = fakeTime(SERVER_MS + 90_000);
    let rtt = 100;
    const fetchServerTimeSec = slowFetcher(time, () => rtt);
    const clock = new Clock({ fetchServerTimeSec, now: time.now });
    await clock.sync();
    const before = clock.nowSec();

    rtt = 5001;
    const failure = await clock.sync().then(
      () => undefined,
      (error: unknown) => error as UnexpectedResponseError,
    );

    expect(failure).toBeInstanceOf(UnexpectedResponseError);
    expect(failure?.service).toBe('orderbook');
    // The sample was thrown away, so the local clock still maps through the old offset.
    expect(clock.nowSec()).toBe(before + Math.floor(5001 / 1000));
  });

  test('the default limit is 5000 ms and a round trip of exactly that is accepted', async () => {
    const time = fakeTime(SERVER_MS);
    const clock = new Clock({
      fetchServerTimeSec: slowFetcher(time, () => 5000),
      now: time.now,
    });

    await expect(clock.sync()).resolves.toBeUndefined();
  });

  test('a custom limit is honoured', async () => {
    const time = fakeTime(SERVER_MS);
    let rtt = 100;
    const clock = new Clock({
      fetchServerTimeSec: slowFetcher(time, () => rtt),
      now: time.now,
      maxRttMs: 100,
    });
    await expect(clock.sync()).resolves.toBeUndefined();

    rtt = 101;
    await expect(clock.sync()).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  test('a failed first sync over the limit leaves the offset at zero', async () => {
    const time = fakeTime(SERVER_MS + 90_000);
    const clock = new Clock({
      fetchServerTimeSec: slowFetcher(time, () => 60_000),
      now: time.now,
    });

    await expect(clock.sync()).rejects.toBeInstanceOf(UnexpectedResponseError);

    // Offset 0: the local time, which moved on by the 60 s the fetch took.
    expect(clock.nowSec()).toBe(SERVER_SEC + 90 + 60);
  });

  test('the error names no value', async () => {
    const time = fakeTime(SERVER_MS);
    const clock = new Clock({
      fetchServerTimeSec: slowFetcher(time, () => 123_456),
      now: time.now,
    });

    const failure = await clock.sync().then(
      () => undefined,
      (error: unknown) => error as UnexpectedResponseError,
    );

    expect(failure).toBeInstanceOf(UnexpectedResponseError);
    for (const text of [
      failure?.message,
      JSON.stringify(failure?.toJSON()),
      JSON.stringify(failure?.issues),
    ]) {
      expect(text).not.toContain('123456');
      expect(text).not.toContain(String(SERVER_SEC));
      expect(text).not.toMatch(/\d{4,}/);
    }
  });

  test('a lazy resync that fails on the round trip is swallowed and throttled like any failure', async () => {
    process.on('unhandledRejection', onUnhandled);
    const time = fakeTime(SERVER_MS);
    let rtt = 100;
    const fetchServerTimeSec = slowFetcher(time, () => rtt);
    const clock = new Clock({
      fetchServerTimeSec,
      now: time.now,
      resyncMs: 10_000,
    });
    await clock.sync();

    rtt = 6000;
    time.advance(10_000);
    clock.nowSec();
    await flush();
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(2);
    const failedAt = time.now();

    for (let i = 0; i < 20; i += 1) {
      time.set(failedAt + i * 400);
      clock.nowSec();
    }
    await flush();
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(2);

    time.set(failedAt + 10_000);
    clock.nowSec();
    await flush();
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(3);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  });

  test('a negative round trip (local clock stepped back mid-request) fails the sync and keeps the offset', async () => {
    const time = fakeTime(SERVER_MS + 90_000);
    let rtt = 100;
    const fetchServerTimeSec = slowFetcher(time, () => rtt);
    const clock = new Clock({ fetchServerTimeSec, now: time.now });
    await clock.sync();
    const before = clock.nowSec();
    expect(before).toBe(SERVER_SEC);

    rtt = -1;
    const failure = await clock.sync().then(
      () => undefined,
      (error: unknown) => error as UnexpectedResponseError,
    );

    expect(failure).toBeInstanceOf(UnexpectedResponseError);
    expect(failure?.service).toBe('orderbook');
    // The sample was thrown away, so the local clock (now 1 ms back) still maps
    // through the old offset.
    expect(clock.nowSec()).toBe(before);
  });

  test('a zero round trip is accepted', async () => {
    const time = fakeTime(SERVER_MS);
    const clock = new Clock({
      fetchServerTimeSec: slowFetcher(time, () => 0),
      now: time.now,
    });

    await expect(clock.sync()).resolves.toBeUndefined();
  });

  test('a failed first sync with a negative round trip leaves the offset at zero', async () => {
    const time = fakeTime(SERVER_MS + 90_000);
    const clock = new Clock({
      fetchServerTimeSec: slowFetcher(time, () => -60_000),
      now: time.now,
    });

    await expect(clock.sync()).rejects.toBeInstanceOf(UnexpectedResponseError);

    // Offset 0: the local time, which went back by the 60 s during the fetch.
    expect(clock.nowSec()).toBe(SERVER_SEC + 90 - 60);
  });

  test('the negative round trip error names no value', async () => {
    const time = fakeTime(SERVER_MS);
    const clock = new Clock({
      fetchServerTimeSec: slowFetcher(time, () => -123_456),
      now: time.now,
    });

    const failure = await clock.sync().then(
      () => undefined,
      (error: unknown) => error as UnexpectedResponseError,
    );

    expect(failure).toBeInstanceOf(UnexpectedResponseError);
    for (const text of [
      failure?.message,
      JSON.stringify(failure?.toJSON()),
      JSON.stringify(failure?.issues),
    ]) {
      expect(text).not.toContain('123456');
      expect(text).not.toContain(String(SERVER_SEC));
      expect(text).not.toMatch(/\d{4,}/);
    }
  });

  test('a lazy resync that fails on a negative round trip is swallowed and throttled', async () => {
    process.on('unhandledRejection', onUnhandled);
    const time = fakeTime(SERVER_MS);
    let rtt = 100;
    const fetchServerTimeSec = slowFetcher(time, () => rtt);
    const clock = new Clock({
      fetchServerTimeSec,
      now: time.now,
      resyncMs: 10_000,
    });
    await clock.sync();

    rtt = -500;
    time.advance(10_000);
    clock.nowSec();
    await flush();
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(2);
    const failedAt = time.now();
    // The first sync's offset (-50 ms, from its 100 ms round trip) is still in force.
    expect(clock.nowSec()).toBe(Math.floor((failedAt - 50) / 1000));

    for (let i = 0; i < 20; i += 1) {
      time.set(failedAt + i * 400);
      clock.nowSec();
    }
    await flush();
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(2);

    time.set(failedAt + 10_000);
    clock.nowSec();
    await flush();
    expect(fetchServerTimeSec).toHaveBeenCalledTimes(3);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  });

  const bad: Array<[string, number]> = [
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ];

  test.each(bad)('rejects %s as maxRttMs', (_name, maxRttMs) => {
    expect(
      () =>
        new Clock({
          fetchServerTimeSec: async () => SERVER_SEC,
          maxRttMs,
        }),
    ).toThrow(UserInputError);
  });

  test('accepts a small positive maxRttMs', () => {
    expect(
      () =>
        new Clock({
          fetchServerTimeSec: async () => SERVER_SEC,
          maxRttMs: 1,
        }),
    ).not.toThrow();
  });
});

describe('Clock resyncMs validation', () => {
  const bad: Array<[string, number]> = [
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ];

  test.each(bad)('rejects %s', (_name, resyncMs) => {
    expect(
      () =>
        new Clock({
          fetchServerTimeSec: async () => SERVER_SEC,
          resyncMs,
        }),
    ).toThrow(UserInputError);
  });

  test('accepts a small positive value', () => {
    expect(
      () =>
        new Clock({
          fetchServerTimeSec: async () => SERVER_SEC,
          resyncMs: 1,
        }),
    ).not.toThrow();
  });
});
