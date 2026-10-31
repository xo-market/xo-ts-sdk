import { describe, expect, test } from 'vitest';
import {
  FIRST_RETRY_MS,
  MAX_ATTEMPTS,
  MAX_RETRY_MS,
  pass,
  type SettleDeps,
  settle,
  Unresolved,
} from '../../examples/mm-bot/unresolved.js';

// The never-resend latch of mm-bot (examples/mm-bot/unresolved.ts): while an order's outcome
// is unknown, or the view of the resting quotes is stale, the bot places nothing. `settle` and
// `pass` run here against a fake orderbook.

const A = `0x${'a'.repeat(64)}`;
const B = `0x${'b'.repeat(64)}`;

type Answer = 'resting' | 'traded' | 'not_found' | Error;

/**
 * A fake orderbook: `answers[hash]` is the list of what `reconcileOrder` answers, call after
 * call (an Error is thrown); `open` is the list of what `resync` answers (an Error is thrown).
 * A fake clock, and a count of every call, placements (`quote`) included.
 */
function fake(o: {
  answers?: Record<string, Answer[]>;
  open?: (string[] | Error | (() => string[]))[];
}) {
  const calls = { reconcile: [] as string[], resync: 0, quote: 0 };
  let clock = 1_000_000;
  const answers = o.answers ?? {};
  const open = o.open ?? [];
  const deps: SettleDeps & { quote(): Promise<void> } = {
    reconcileOrder: async (hash) => {
      calls.reconcile.push(hash);
      const next = answers[hash]?.shift();
      if (next === undefined) {
        throw new Error(`no answer left for ${hash}`);
      }
      if (next instanceof Error) {
        throw next;
      }
      return { state: next };
    },
    resync: async () => {
      calls.resync += 1;
      const next = open.shift();
      if (next === undefined) {
        throw new Error('no open orders answer left');
      }
      if (next instanceof Error) {
        throw next;
      }
      return new Set(typeof next === 'function' ? next() : next);
    },
    now: () => clock,
    quote: async () => {
      calls.quote += 1;
    },
  };
  return {
    deps,
    calls,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('Unresolved', () => {
  test('starts open: nothing pending, nothing stale, an attempt is due', () => {
    const latch = new Unresolved();
    expect(latch.blocked).toBe(false);
    expect(latch.pending).toEqual([]);
    expect(latch.due(0)).toBe(true);
  });

  test('blocks until every order is settled AND a resync from the current epoch', () => {
    const latch = new Unresolved();
    latch.add([A, B.toUpperCase().replace('0X', '0x')]);
    expect(latch.pending).toEqual([A, B]);
    const epoch = latch.epoch;
    latch.settle(A);
    latch.settle(B);
    expect(latch.blocked).toBe(true);
    latch.resynced(epoch);
    expect(latch.blocked).toBe(false);
  });

  test('a resync alone does not release an order still pending', () => {
    const latch = new Unresolved();
    latch.add([A]);
    latch.resynced(latch.epoch);
    expect(latch.blocked).toBe(true);
    expect(latch.pending).toEqual([A]);
  });

  test('made stale during a resync (a reconnect), the view stays stale', () => {
    const latch = new Unresolved();
    latch.markStale();
    const epoch = latch.epoch;
    latch.markStale();
    latch.resynced(epoch);
    expect(latch.blocked).toBe(true);
    latch.resynced(latch.epoch);
    expect(latch.blocked).toBe(false);
  });

  test('failed attempts back off, doubling up to the cap, and give up after MAX_ATTEMPTS', () => {
    const latch = new Unresolved();
    latch.add([A]);
    const now = 1_000_000;
    const pauses: number[] = [];
    for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
      expect(latch.failed(now)).toBe(i === MAX_ATTEMPTS);
      pauses.push(latch.nextAttemptAt - now);
    }
    expect(pauses[0]).toBe(FIRST_RETRY_MS);
    expect(pauses[1]).toBe(2 * FIRST_RETRY_MS);
    expect(Math.max(...pauses)).toBe(MAX_RETRY_MS);
    expect(latch.due(now + MAX_RETRY_MS - 1)).toBe(false);
    expect(latch.due(now + MAX_RETRY_MS)).toBe(true);
  });

  test('once nothing is pending or stale, the failure count starts over', () => {
    const latch = new Unresolved();
    latch.add([A]);
    latch.failed(0);
    latch.failed(0);
    latch.settle(A);
    latch.resynced(latch.epoch);
    expect(latch.due(0)).toBe(true);
    latch.add([B]);
    expect(latch.failed(0)).toBe(false);
    expect(latch.nextAttemptAt).toBe(FIRST_RETRY_MS);
  });
});

describe('settle: a not_found verdict is never lost', () => {
  test('a not_found halts at once, before a later reconcile that would throw', async () => {
    const latch = new Unresolved();
    latch.add([A, B]);
    const f = fake({
      answers: { [A]: ['not_found'], [B]: [new Error('network down')] },
      open: [[]],
    });
    const outcome = await settle(latch, f.deps);
    expect(outcome.kind).toBe('halt');
    expect(f.calls.reconcile).toEqual([A]);
    expect(f.calls.resync).toBe(0);
    // Nothing was settled: the latch stays closed for good.
    expect(latch.pending).toEqual([A, B]);
    expect(latch.blocked).toBe(true);
  });

  test('a not_found after a resting order halts before the resync', async () => {
    const latch = new Unresolved();
    latch.add([A, B]);
    const f = fake({ answers: { [A]: ['resting'], [B]: ['not_found'] } });
    const outcome = await settle(latch, f.deps);
    expect(outcome).toMatchObject({ kind: 'halt' });
    expect(f.calls.resync).toBe(0);
  });

  test('a resync that throws settles nothing: the next attempt asks about every order again', async () => {
    const latch = new Unresolved();
    latch.add([A, B]);
    const f = fake({
      answers: { [A]: ['traded', 'traded'], [B]: ['resting', 'resting'] },
      open: [new Error('timeout'), [B]],
    });
    const first = await settle(latch, f.deps);
    expect(first).toMatchObject({
      kind: 'wait',
      at: 1_000_000 + FIRST_RETRY_MS,
    });
    expect(latch.pending).toEqual([A, B]);
    f.advance(FIRST_RETRY_MS);
    const second = await settle(latch, f.deps);
    expect(second.kind).toBe('clear');
    expect(f.calls.reconcile).toEqual([A, B, A, B]);
    expect(latch.blocked).toBe(false);
  });

  test('an order reported resting must be among the open orders, or the latch stays closed', async () => {
    const latch = new Unresolved();
    latch.add([A]);
    const f = fake({
      answers: { [A]: ['resting', 'resting'] },
      open: [[], [A]],
    });
    const first = await settle(latch, f.deps);
    expect(first.kind).toBe('wait');
    expect(latch.pending).toEqual([A]);
    f.advance(FIRST_RETRY_MS);
    expect((await settle(latch, f.deps)).kind).toBe('clear');
  });

  test('a stale view whose resync keeps failing halts with the right message', async () => {
    const latch = new Unresolved();
    latch.markStale();
    const f = fake({
      open: Array.from({ length: MAX_ATTEMPTS }, () => new Error('down')),
    });
    let outcome = await settle(latch, f.deps);
    for (let i = 1; i < MAX_ATTEMPTS; i += 1) {
      expect(outcome.kind).toBe('wait');
      f.advance(MAX_RETRY_MS);
      outcome = await settle(latch, f.deps);
    }
    expect(outcome.kind).toBe('halt');
    expect(outcome.kind === 'halt' && outcome.reason).toMatch(
      /cannot read the open orders/,
    );
    expect(outcome.kind === 'halt' && outcome.reason).not.toMatch(/0 order/);
  });
});

describe('pass: nothing is placed while the latch is blocked', () => {
  test('a clear latch quotes at once', async () => {
    const f = fake({});
    const outcome = await pass(new Unresolved(), f.deps);
    expect(outcome.kind).toBe('quoted');
    expect(f.calls.quote).toBe(1);
  });

  test('while reconciling keeps failing, no pass quotes; the first full success does', async () => {
    const latch = new Unresolved();
    latch.add([A]);
    const f = fake({
      answers: {
        [A]: [new Error('down'), new Error('down'), 'resting', 'resting'],
      },
      open: [new Error('still down'), [A]],
    });
    const kinds: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      kinds.push((await pass(latch, f.deps)).kind);
      if (kinds.at(-1) === 'quoted') {
        break;
      }
      // A pass that comes before the pause is over (a price_change) asks nothing at all.
      kinds.push((await pass(latch, f.deps)).kind);
      f.advance(MAX_RETRY_MS);
    }
    expect(kinds).toEqual([
      'wait',
      'wait',
      'wait',
      'wait',
      'wait',
      'wait',
      'quoted',
    ]);
    expect(f.calls.quote).toBe(1);
    expect(f.calls.reconcile).toHaveLength(4);
    expect(f.calls.resync).toBe(2);
  });

  test('a not_found halts the pass and never quotes, even when a later call would throw', async () => {
    const latch = new Unresolved();
    latch.add([A, B]);
    const f = fake({
      answers: { [A]: ['not_found'], [B]: [new Error('down')] },
      open: [new Error('down')],
    });
    expect((await pass(latch, f.deps)).kind).toBe('halt');
    expect(f.calls.quote).toBe(0);
  });

  test('a reconnect during the resync keeps the pass from quoting', async () => {
    const latch = new Unresolved();
    latch.markStale();
    const f = fake({
      open: [
        () => {
          latch.markStale(); // the user channel reconnected meanwhile
          return [];
        },
        [],
      ],
    });
    const first = await pass(latch, f.deps);
    expect(first).toMatchObject({ kind: 'wait', at: 1_000_000 });
    expect(f.calls.quote).toBe(0);
    expect(latch.blocked).toBe(true);
    expect((await pass(latch, f.deps)).kind).toBe('quoted');
    expect(f.calls.quote).toBe(1);
  });
});
