import { isRecord, processShared } from '../core/shared';
import {
  hasShutdownSignals,
  installExitHook,
  installShutdownHooks,
} from '../core/shutdown';
import { resetProcessWarning } from '../core/warn';

// What the clients keep per process, not per client: the one set of
// shutdown hooks, which closes every client that holds it. It lives on `globalThis`
// (`processShared`), so an ESM and a CommonJS copy of the package in one process install one
// set of hooks. (The once-per-process warning is `core/warn.ts`.) Internal: the tests reset it
// through `./internal`.

interface HookState {
  /** The `close()` of every client that holds the shutdown hooks, until it has closed. */
  holders: Set<() => Promise<void>>;
  /** Removes the installed hooks; `undefined` while none are installed. */
  uninstall: (() => void) | undefined;
}

const state = processShared(
  'shutdown-hooks.v1',
  (): HookState => ({ holders: new Set(), uninstall: undefined }),
  (value): value is HookState =>
    isRecord(value) &&
    value.holders instanceof Set &&
    (value.uninstall === undefined || typeof value.uninstall === 'function'),
);
const { holders } = state;

async function closeHolders(): Promise<void> {
  // A signal removed the handlers already: the next client installs them afresh.
  state.uninstall = undefined;
  await Promise.allSettled([...holders].map((close) => close()));
}

/**
 * Registers `close` with the process's one set of shutdown hooks (`installShutdownHooks`),
 * installing them for the first holder. On SIGINT or SIGTERM every holder is closed, then
 * the process ends. Does nothing, and returns a no-op, where the runtime has no process
 * signals or installing the hooks throws.
 *
 * @returns Releases this holder; the hooks are removed with the last one. Idempotent.
 */
export function holdShutdownHooks(close: () => Promise<void>): () => void {
  if (!hasShutdownSignals()) {
    return () => {};
  }
  if (state.uninstall === undefined) {
    try {
      state.uninstall = installShutdownHooks(closeHolders);
    } catch {
      // A runtime whose `process.once` throws: no hooks, and no holder to release.
      return () => {};
    }
  }
  // Only once the hooks are in place: a holder never waits on hooks that do not exist.
  holders.add(close);
  let held = true;
  return () => {
    if (!held) {
      return;
    }
    held = false;
    holders.delete(close);
    if (holders.size === 0 && state.uninstall !== undefined) {
      state.uninstall();
      state.uninstall = undefined;
    }
  };
}

/** The clients that close when the process is about to exit normally, and their one hook. */
const exitState = processShared(
  'exit-hook.v1',
  (): HookState => ({ holders: new Set(), uninstall: undefined }),
  (value): value is HookState =>
    isRecord(value) &&
    value.holders instanceof Set &&
    (value.uninstall === undefined || typeof value.uninstall === 'function'),
);

async function closeExitHolders(): Promise<void> {
  // The hook ran (it runs once): the next holder installs it afresh.
  exitState.uninstall = undefined;
  await Promise.allSettled([...exitState.holders].map((close) => close()));
}

/**
 * Registers `close` with the process's one exit hook (`installExitHook`): when the event loop
 * has nothing left to do (`beforeExit`), every holder is closed, once. Does nothing, and
 * returns a no-op, where the runtime has no process or installing the hook throws.
 *
 * @returns Releases this holder; the hook is removed with the last one. Idempotent.
 */
export function holdExitHook(close: () => Promise<void>): () => void {
  if (!hasShutdownSignals()) {
    return () => {};
  }
  if (exitState.uninstall === undefined) {
    try {
      exitState.uninstall = installExitHook(closeExitHolders);
    } catch {
      return () => {};
    }
  }
  exitState.holders.add(close);
  let held = true;
  return () => {
    if (!held) {
      return;
    }
    held = false;
    exitState.holders.delete(close);
    if (exitState.holders.size === 0 && exitState.uninstall !== undefined) {
      exitState.uninstall();
      exitState.uninstall = undefined;
    }
  };
}

/** Forgets the warning and removes the hooks. Test-only, internal. */
export function resetProcessState(): void {
  resetProcessWarning();
  holders.clear();
  state.uninstall?.();
  state.uninstall = undefined;
  exitState.holders.clear();
  exitState.uninstall?.();
  exitState.uninstall = undefined;
}
