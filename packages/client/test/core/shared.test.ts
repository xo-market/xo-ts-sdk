import { afterEach, describe, expect, test, vi } from 'vitest';
import { OWNER } from '../helpers/railChain';

// The dual-package hazard: an ESM and a CommonJS copy of the package in one process are two
// module instances. `vi.resetModules()` gives a second instance of the same source, which is
// what the second copy is. The process-wide state must be one object for both,
// keyed per state with a shape check, and never break an import in a hardened realm.

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

/** Two independent instances of one module, as two copies of the package would load it. */
async function twice<M>(load: () => Promise<M>): Promise<[M, M]> {
  const a = await load();
  vi.resetModules();
  const b = await load();
  return [a, b];
}

const key = (name: string) => Symbol.for(`@xomarket/client/${name}`);
const globals = globalThis as unknown as Record<symbol, unknown>;
const isBox = (value: unknown): value is { from: string } =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { from?: unknown }).from === 'string';

describe('processShared', () => {
  test('gives every copy the same object for a name, under a hidden registered symbol', async () => {
    const [a, b] = await twice(() => import('../../src/core/shared'));
    expect(a.processShared).not.toBe(b.processShared);
    const first = a.processShared(
      'shared-test.v1',
      () => ({ from: 'a' }),
      isBox,
    );
    const second = b.processShared(
      'shared-test.v1',
      () => ({ from: 'b' }),
      isBox,
    );
    expect(second).toBe(first);
    expect(second.from).toBe('a');
    expect(globals[key('shared-test.v1')]).toBe(first);
    expect(Object.keys(globalThis)).not.toContain('shared-test.v1');
  });

  test('an object of another shape under the key is left alone: a module-local state instead', async () => {
    const { processShared } = await import('../../src/core/shared');
    const target = {};
    const foreign = { from: 42 };
    Object.defineProperty(target, key('shape-test.v1'), { value: foreign });
    const mine = processShared(
      'shape-test.v1',
      () => ({ from: 'mine' }),
      isBox,
      target,
    );
    expect(mine).toEqual({ from: 'mine' });
    expect(mine).not.toBe(foreign);
    // The foreign object is untouched, and each call is local: nothing is shared through it.
    expect((target as Record<symbol, unknown>)[key('shape-test.v1')]).toBe(
      foreign,
    );
    expect(
      processShared('shape-test.v1', () => ({ from: 'other' }), isBox, target),
    ).not.toBe(mine);
  });

  test.each([
    ['frozen', () => Object.freeze({})],
    ['non-extensible', () => Object.preventExtensions({})],
    [
      'a proxy that refuses to define',
      () => new Proxy({}, { defineProperty: () => false }),
    ],
    [
      'a proxy that throws on read',
      () =>
        new Proxy(
          {},
          {
            get: () => {
              throw new Error('no reads here');
            },
          },
        ),
    ],
  ])('a %s global: a module-local state, and no throw', async (_, make) => {
    const { processShared } = await import('../../src/core/shared');
    const target = make();
    const state = processShared(
      'hardened.v1',
      () => ({ from: 'local' }),
      isBox,
      target,
    );
    expect(state).toEqual({ from: 'local' });
  });
});

describe('the nonce queue and record, and the facade lifecycle, across two copies', () => {
  test('the accepted-nonce record and its clock are one', async () => {
    const [a, b] = await twice(() => import('../../src/account/nonceQueue'));
    expect(a.markAccepted).not.toBe(b.markAccepted);
    a.resetNonceTracking();
    try {
      a.markAccepted({ chainId: 1, executor: OWNER, nonce: 7n });
      expect(
        b.nextNonce({
          chainId: 1,
          executor: OWNER,
          pending: 3n,
          ttlMs: 60_000,
        }),
      ).toBe(8n);
      // One clock: a copy that moves it moves the other's ages too.
      let now = 1_000;
      b.setNonceClock(() => now);
      a.markAccepted({ chainId: 1, executor: OWNER, nonce: 9n });
      now += 60_000;
      expect(
        b.nextNonce({
          chainId: 1,
          executor: OWNER,
          pending: 3n,
          ttlMs: 60_000,
        }),
      ).toBe(3n);
    } finally {
      a.setNonceClock(undefined);
      a.resetNonceTracking();
    }
  });

  test('the executor queue is one, under its own stable key (never versioned)', async () => {
    const [a, b] = await twice(() => import('../../src/account/nonceQueue'));
    const queue = globals[key('executor-queue')];
    expect(queue).toBeInstanceOf(Map);
    // The record has its own versioned key: bumping it can never split the queue.
    expect(globals[key('nonce-record.v1')]).toBeDefined();
    expect(globals[key('nonce-record.v1')]).not.toBe(queue);

    const order: string[] = [];
    let release: () => void = () => {};
    const first = a.serializeByExecutor(
      OWNER,
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            order.push('a');
            resolve();
          };
        }),
    );
    expect((queue as Map<string, unknown>).has(OWNER.toLowerCase())).toBe(true);
    const second = b.serializeByExecutor(OWNER, async () => {
      order.push('b');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['a', 'b']);
  });

  test('one warning and one set of shutdown hooks', async () => {
    const [warnA, warnB] = await twice(() => import('../../src/core/warn'));
    const [a, b] = await twice(() => import('../../src/clients/lifecycle'));
    const { SHORT_LIVED_WARNING } = await import(
      '../../src/auth/sessionInternal'
    );
    a.resetProcessState();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      warnA.processWarn(SHORT_LIVED_WARNING);
      warnB.processWarn(SHORT_LIVED_WARNING);
      expect(warn).toHaveBeenCalledTimes(1);

      const before = process.listenerCount('SIGINT');
      const releaseA = a.holdShutdownHooks(async () => {});
      const releaseB = b.holdShutdownHooks(async () => {});
      expect(process.listenerCount('SIGINT')).toBe(before + 1);
      releaseA();
      expect(process.listenerCount('SIGINT')).toBe(before + 1);
      releaseB();
      expect(process.listenerCount('SIGINT')).toBe(before);
    } finally {
      a.resetProcessState();
    }
  });
});

describe('a hardened realm', () => {
  const NAMES = [
    'executor-queue',
    'nonce-record.v1',
    'short-lived-warning.v1',
    'shutdown-hooks.v1',
  ];

  test('when the globals cannot be defined, the entries still import and work on local state', async () => {
    // Take the shared states off globalThis (put back below), and refuse to define them again,
    // as a frozen or non-extensible globalThis would.
    const saved = NAMES.map((name) => [name, globals[key(name)]] as const);
    for (const name of NAMES) {
      delete globals[key(name)];
    }
    const define = Object.defineProperty;
    vi.spyOn(Object, 'defineProperty').mockImplementation(((
      target: object,
      property: PropertyKey,
      descriptor: PropertyDescriptor,
    ) => {
      if (
        target === globalThis &&
        typeof property === 'symbol' &&
        property.description?.startsWith('@xomarket/client/')
      ) {
        throw new TypeError('Cannot define property: object is not extensible');
      }
      return define(target, property, descriptor);
    }) as typeof Object.defineProperty);
    try {
      vi.resetModules();
      const main = await import('../../src/index');
      const queue = await import('../../src/account/nonceQueue');
      expect(typeof main.createPublicClient).toBe('function');
      for (const name of NAMES) {
        expect(globals[key(name)], name).toBeUndefined();
      }
      // The module-local state works: a record and a queue of its own.
      queue.markAccepted({ chainId: 1, executor: OWNER, nonce: 4n });
      expect(
        queue.nextNonce({
          chainId: 1,
          executor: OWNER,
          pending: 0n,
          ttlMs: 60_000,
        }),
      ).toBe(5n);
      expect(await queue.serializeByExecutor(OWNER, async () => 'ran')).toBe(
        'ran',
      );
      queue.resetNonceTracking();
    } finally {
      vi.restoreAllMocks();
      for (const [name, value] of saved) {
        if (value !== undefined) {
          Object.defineProperty(globalThis, key(name), {
            value,
            configurable: true,
            enumerable: false,
            writable: false,
          });
        }
      }
    }
  });
});
