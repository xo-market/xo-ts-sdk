import type { Address } from 'viem';
import { isRecord, processShared } from '../core/shared';

// The send queue of each executor (`serializeByExecutor`) and the accepted-nonce tracker below
// it.
//
// Everything here is internal: the rails reach `serializeByExecutor`,
// `nextNonce` and `markAccepted` directly or through `./internal`, the tests reach
// `resetNonceTracking` and `setNonceClock` through `./internal`, and no public barrel exports
// anything from this module (never `export *` it).

/** The last nonce the network took from an executor, and when (the record clock, ms). */
interface Accepted {
  lastAccepted: bigint;
  setAtMs: number;
}

/** The monotonic clock in milliseconds: a wall-clock change cannot move it. */
const monotonicNow = (): number => performance.now();

/**
 * The tail of each executor's queue, by lower-case address: one per process even when the
 * package is loaded twice (an ESM and a CommonJS copy), so both copies serialize one
 * executor's sends. Each entry settles when the last task queued for that executor settles,
 * and never rejects. Its key is stable and never bumped: a version bump of the record below
 * must never split the queue between copies.
 */
const inFlight = processShared(
  'executor-queue',
  () => new Map<string, Promise<void>>(),
  (value): value is Map<string, Promise<void>> => value instanceof Map,
);

/** The accepted-nonce record and its clock (see below), one per process like the queue. */
const state = processShared(
  'nonce-record.v1',
  () => ({
    /** The last accepted nonce per `${chainId}:${executor in lower case}`. */
    accepted: new Map<string, Accepted>(),
    /**
     * The one clock every record is set and aged on. It is not a rail
     * option: the record is shared by every rail, so its ages only compare on one time base.
     */
    now: monotonicNow as () => number,
  }),
  (value): value is { accepted: Map<string, Accepted>; now: () => number } =>
    isRecord(value) &&
    value.accepted instanceof Map &&
    typeof value.now === 'function',
);
const { accepted } = state;

/**
 * Runs `task` once every task queued earlier for the same executor has settled, whatever
 * their outcome, and returns its result.
 *
 * A transaction carries the executor's account nonce, read as `'pending'`. Two sends from the
 * same executor that run at the same time read the same nonce and collide: the node refuses
 * the second or it replaces the first. Running build, sign and submit one after another per
 * executor means the next transaction reads the nonce only after the previous one was handed
 * to the network.
 *
 * - The key is the address in lower case, so any spelling of one executor shares a queue.
 * - A failed task releases the queue: the next one runs, and reads the nonce again.
 * - The scope is this JavaScript context only. Another process using the same key is not
 *   serialized; its collision surfaces as a sponsor or node rejection, and is never retried
 *   (a rebuild cannot tell "another transaction took my nonce" from "mine already landed").
 */
export function serializeByExecutor<T>(
  executor: Address,
  task: () => Promise<T>,
): Promise<T> {
  const key = executor.toLowerCase();
  const prev = inFlight.get(key) ?? Promise.resolve();

  // Run `task` once the previous task settles, whatever its outcome.
  const result = prev.then(task, task);

  // A settled-only copy, for chaining and cleanup, so a rejection is never left unhandled here
  // (the caller handles the rejection of `result`).
  const tracked: Promise<void> = result
    .then(
      () => {},
      () => {},
    )
    .finally(() => {
      if (inFlight.get(key) === tracked) {
        inFlight.delete(key);
      }
    });
  inFlight.set(key, tracked);

  return result;
}

// ---------------------------------------------------------------------------
// Accepted nonces
// ---------------------------------------------------------------------------

// The accepted-nonce record (`state.accepted`): the last accepted nonce per chain and
// executor. Every rail shares it (sponsored and direct, EOA and smart wallet: the executor is always
// the owner).
//
// Why: the `'pending'` count of an RPC can lag behind the node the sponsor submitted to. Right
// after send A (nonce n) was accepted, send B could read n again, and the node would refuse it
// as underpriced (a 5xx the SDK must report as "may have landed" for a transaction that cannot
// have) or, with different fees, replace A.

function trackKey(chainId: number, executor: Address): string {
  return `${chainId}:${executor.toLowerCase()}`;
}

/**
 * Replaces the clock of the accepted-nonce record; `undefined` restores the monotonic default
 * (`performance.now()`). Test-only, internal: reset it after each test that sets it.
 */
export function setNonceClock(clock: (() => number) | undefined): void {
  state.now = clock ?? monotonicNow;
}

/**
 * The nonce for the next transaction of `executor`: `max(pending, lastAccepted + 1)` while the
 * record is fresh, `pending` once it is `ttlMs` old or older.
 *
 * Read-only: it never changes the record. A read that finishes late (after its task
 * failed and the queue moved on) can therefore never wipe a newer record. An expired record is
 * ignored here and replaced by the next {@link markAccepted}; without the expiry, one
 * transaction that was accepted and then dropped from the mempool would leave every later
 * send behind a nonce gap for good. A negative age (a test clock that stepped back) counts as
 * fresh. The age is read on the module's one record clock (see {@link setNonceClock}).
 *
 * Call it inside the executor's {@link serializeByExecutor} task, after the pending count was
 * read: the clock is read here, so after the count too. Internal.
 */
export function nextNonce(o: {
  chainId: number;
  executor: Address;
  pending: bigint;
  ttlMs: number;
}): bigint {
  const entry = accepted.get(trackKey(o.chainId, o.executor));
  if (entry === undefined || state.now() - entry.setAtMs >= o.ttlMs) {
    return o.pending;
  }
  const next = entry.lastAccepted + 1n;
  return o.pending > next ? o.pending : next;
}

/**
 * Records that the network took `nonce` from `executor`: a sponsor 2xx with a valid hash and
 * the right executor, or a successful raw broadcast. Never call it for a refusal, an
 * ambiguous failure or an executor mismatch. Call it inside the executor's queued task,
 * before the task resolves. Internal.
 */
export function markAccepted(o: {
  chainId: number;
  executor: Address;
  nonce: bigint;
}): void {
  accepted.set(trackKey(o.chainId, o.executor), {
    lastAccepted: o.nonce,
    setAtMs: state.now(),
  });
}

// ---------------------------------------------------------------------------
// Handed-over nonces
// ---------------------------------------------------------------------------

// The handed-over record: the highest nonce this process handed to the sponsor or the node per
// chain and executor, unless the receiver refused it for sure (accepted, an unknown outcome, a
// receipt timeout all stay). It never expires (a TTL could let a withdrawal pay twice), and
// nothing but the chain clears it: a transaction counts as landed once the executor's `'latest'`
// nonce is past it. A definite refusal undoes its own mark (see {@link markHandedOver}). Only the sponsored rail's preflight reads it (the
// pre-claim guard of `bridge.withdraw()`); sends never do, so it cannot hold a send back.
// A key of its own, versioned like the accepted record: two copies of the package share it.
const handedOver = processShared(
  'handed-over-record.v1',
  () => new Map<string, bigint>(),
  (value): value is Map<string, bigint> => value instanceof Map,
);

/**
 * Records that a transaction of `executor` with `nonce` was handed to the sponsor or the node:
 * call it right before the request or broadcast, once the nonce is final. Keeps the highest
 * nonce. Returns the undo: it puts back the value the key had before this call (or removes the
 * key when it had none), for a send the receiver then refused for sure (`mayHaveLanded: false`),
 * which cannot land. The undo is exact only while no other mark of the executor came in between:
 * call both inside the executor's {@link serializeByExecutor} task, as the rails do. Internal.
 */
export function markHandedOver(o: {
  chainId: number;
  executor: Address;
  nonce: bigint;
}): () => void {
  const key = trackKey(o.chainId, o.executor);
  const previous = handedOver.get(key);
  if (previous === undefined || o.nonce > previous) {
    handedOver.set(key, o.nonce);
  }
  return () => {
    if (previous === undefined) {
      handedOver.delete(key);
    } else {
      handedOver.set(key, previous);
    }
  };
}

/** The highest nonce this process handed over for `executor` on `chainId`, if any. Internal. */
export function lastHandedOver(o: {
  chainId: number;
  executor: Address;
}): bigint | undefined {
  return handedOver.get(trackKey(o.chainId, o.executor));
}

/** Forgets every accepted and every handed-over nonce. Test-only, internal. */
export function resetNonceTracking(): void {
  accepted.clear();
  handedOver.clear();
}
