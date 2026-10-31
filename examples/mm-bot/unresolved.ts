// The never-resend latch of mm-bot.
//
// When a placement fails with `mayHaveLanded: true`, its orders may be resting on the book, or
// may even have filled, without the bot knowing. If the bot then placed a fresh pair, the old
// pair could stay on the book unseen: an orphan the bot never cancels. So it latches:
//
// - While any order's outcome is unknown, or the bot's view of its resting quotes is stale (a
//   cancel whose effect is unknown, a stream that reconnected), the bot places nothing.
// - It only asks the orderbook where things are (`reconcileOrder`, then the open orders), and
//   waits longer after each attempt that fails: 1 s, 2 s, 4 s and so on, capped at 30 s. The
//   same fault that made the placement ambiguous often makes these reads fail for a while.
// - An attempt counts only as a whole: nothing leaves the latch until every pending order has a
//   definite answer AND the open orders were read and agree with it. A `not_found` halts the
//   bot at once (it is not proof that the order was never placed).
// - After MAX_ATTEMPTS failed attempts in a row the bot gives up: it halts.
//
// `pass()` is the bot's pass with this rule built in. It needs no SDK: the tests run it against
// a fake orderbook.

/** The pause after the first failed attempt. It doubles after each one. */
export const FIRST_RETRY_MS = 1000;
/** The longest pause between two attempts. */
export const MAX_RETRY_MS = 30_000;
/** How many failed attempts in a row before the bot halts (about 2 minutes). */
export const MAX_ATTEMPTS = 8;

export class Unresolved {
  readonly #pending = new Set<string>();
  #stale = false;
  /** Grows with every reason to distrust the view, so a resync can tell it is out of date. */
  #epoch = 0;
  #failures = 0;
  #nextAttemptAt = 0;

  /** Orders whose outcome is unknown. Their placement may also have cancelled others: stale. */
  add(hashes: Iterable<string>): void {
    for (const hash of hashes) {
      this.#pending.add(hash.toLowerCase());
    }
    this.markStale();
  }

  /** The bot's view of its resting quotes cannot be trusted until the open orders are read. */
  markStale(): void {
    this.#stale = true;
    this.#epoch += 1;
  }

  /** Whether the bot must not place anything. */
  get blocked(): boolean {
    return this.#pending.size > 0 || this.#stale;
  }

  /** The orders whose outcome is still unknown. */
  get pending(): string[] {
    return [...this.#pending];
  }

  /** Read it before a resync starts, and hand it to {@link resynced}. */
  get epoch(): number {
    return this.#epoch;
  }

  /** When the next attempt may run (milliseconds; 0 means now). */
  get nextAttemptAt(): number {
    return this.#nextAttemptAt;
  }

  /** Whether an attempt may run at `now` (milliseconds). */
  due(now: number): boolean {
    return now >= this.#nextAttemptAt;
  }

  /** A definite answer for one order: it leaves the latch. */
  settle(hash: string): void {
    this.#pending.delete(hash.toLowerCase());
  }

  /**
   * The open orders were read, by a resync that started at `epochAtStart`. The view is fresh
   * again only if nothing made it stale since (a reconnect during the read keeps it stale).
   * Once nothing is pending or stale, the failure count starts over.
   */
  resynced(epochAtStart: number): void {
    if (epochAtStart === this.#epoch) {
      this.#stale = false;
    }
    if (!this.blocked) {
      this.#failures = 0;
      this.#nextAttemptAt = 0;
    }
  }

  /**
   * An attempt failed (a reconcile or a resync threw, or they disagreed): the next one waits
   * longer. Answers whether the bot should give up and halt.
   */
  failed(now: number): boolean {
    this.#failures += 1;
    const pause = Math.min(
      MAX_RETRY_MS,
      FIRST_RETRY_MS * 2 ** (this.#failures - 1),
    );
    this.#nextAttemptAt = now + pause;
    return this.#failures >= MAX_ATTEMPTS;
  }
}

/** What the latch needs from the bot: reads only, never a placement. */
export interface SettleDeps {
  /** Where one order is (the SDK's `reconcileOrder`). */
  reconcileOrder(hash: string): Promise<{ state: string }>;
  /** Reads the open orders, rebuilds the bot's view from them, and answers their ids. */
  resync(): Promise<ReadonlySet<string>>;
  now(): number;
}

/** What one attempt to settle the latch came to. */
export type SettleOutcome =
  /** Nothing is unresolved any more: the bot may quote again. */
  | { kind: 'clear' }
  /** Still blocked: try again at `at` (after `error`, when the attempt failed). */
  | { kind: 'wait'; at: number; error?: unknown }
  /** Stop the bot (cancel everything, place nothing more). */
  | { kind: 'halt'; reason: string; error?: unknown };

/**
 * One attempt to settle the latch: a reconcile per pending order, then a resync. Nothing is
 * settled unless the whole attempt succeeds, so a failure half-way loses no verdict:
 * - `not_found` halts at once, before the resync and before any later call can throw;
 * - an order reported `resting` must be among the open orders the resync read, or the
 *   attempt fails (and is tried again later);
 * - only then do all the pending orders leave the latch, and the view is fresh if nothing
 *   made it stale during the attempt.
 */
export async function settle(
  latch: Unresolved,
  deps: SettleDeps,
): Promise<SettleOutcome> {
  const now = deps.now();
  if (!latch.due(now)) {
    return { kind: 'wait', at: latch.nextAttemptAt };
  }
  const epoch = latch.epoch;
  const pending = latch.pending;
  try {
    const resting: string[] = [];
    for (const hash of pending) {
      const found = await deps.reconcileOrder(hash);
      if (found.state === 'not_found') {
        return {
          kind: 'halt',
          reason: `order ${hash} may have been placed but is not found: it is never sent again, and it may still land after the bot stops (check the open orders later)`,
        };
      }
      if (found.state === 'resting') {
        resting.push(hash);
      }
    }
    const open = await deps.resync();
    const ids = new Set([...open].map((id) => id.toLowerCase()));
    const missing = resting.filter((hash) => !ids.has(hash));
    if (missing.length > 0) {
      throw new Error(
        `${missing.length} order(s) reported resting are not among the open orders yet`,
      );
    }
    for (const hash of pending) {
      latch.settle(hash);
    }
    latch.resynced(epoch);
    // Made stale again during the attempt (a reconnect): read once more, at once.
    return latch.blocked ? { kind: 'wait', at: deps.now() } : { kind: 'clear' };
  } catch (error) {
    if (latch.failed(deps.now())) {
      return {
        kind: 'halt',
        reason:
          pending.length > 0
            ? `still cannot tell where ${pending.length} order(s) are after ${MAX_ATTEMPTS} attempts`
            : `still cannot read the open orders after ${MAX_ATTEMPTS} attempts`,
        error,
      };
    }
    return { kind: 'wait', at: latch.nextAttemptAt, error };
  }
}

/**
 * One pass of the bot with the never-resend rule built in: while the latch is blocked, the
 * pass only settles it; `quote` (which may place orders) runs only once it is clear. `quote`
 * must check `latch.blocked` again right before it sends, since the latch can close while it
 * signs.
 */
export async function pass(
  latch: Unresolved,
  deps: SettleDeps & { quote(): Promise<void> },
): Promise<SettleOutcome | { kind: 'quoted' }> {
  if (latch.blocked) {
    const outcome = await settle(latch, deps);
    if (outcome.kind !== 'clear') {
      return outcome;
    }
  }
  await deps.quote();
  return { kind: 'quoted' };
}
