import { UserInputError } from './errors';

// The shutdown hooks: on SIGINT or SIGTERM, close the session first, so a
// short-lived backend key is revoked, then end the process the way the signal would have.
//
// Runtime-agnostic: the process is reached only through `globalThis.process`,
// found by feature detection, with no `node:` import and no Node types. The universal entry
// can therefore reach this module (the secure client installs the hooks), and `src/node.ts`
// re-exports this one implementation.

/** How long a signal waits for `close()` before the process ends anyway. */
const SHUTDOWN_TIMEOUT_MS = 5000;
const SIGNALS = ['SIGINT', 'SIGTERM'] as const;
type Signal = (typeof SIGNALS)[number];

/** The part of Node's `process` the hooks use. */
interface SignalProcess {
  readonly pid: number;
  on(event: string, listener: () => void): unknown;
  once(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
  kill(pid: number, signal: string): unknown;
}

/**
 * The process, when this runtime has signals (Node, Bun, Deno's Node layer): a
 * `globalThis.process` with `on`, `once`, `removeListener`, `kill` and a numeric `pid`.
 * `undefined` in a browser or a worker. Read on every call, never cached.
 */
function signalProcess(): SignalProcess | undefined {
  const candidate: unknown = (globalThis as { process?: unknown }).process;
  if (typeof candidate !== 'object' || candidate === null) {
    return undefined;
  }
  const p = candidate as Record<string, unknown>;
  return typeof p.on === 'function' &&
    typeof p.once === 'function' &&
    typeof p.removeListener === 'function' &&
    typeof p.kill === 'function' &&
    typeof p.pid === 'number'
    ? (candidate as SignalProcess)
    : undefined;
}

/** Whether this runtime has process signals, so {@link installShutdownHooks} can install them. */
export function hasShutdownSignals(): boolean {
  return signalProcess() !== undefined;
}

/**
 * Runs `close` (for example `session.close()`, which revokes a short-lived backend key) when
 * the process gets SIGINT or SIGTERM, then ends the process the way the signal would have.
 *
 * On the first of the two signals both handlers are removed, `close()` is awaited for at
 * most 5 s (a failure is ignored), and the same signal is sent to the process again. With no
 * other listener left, Node then terminates with the signal's default behaviour; a second
 * Ctrl-C during the wait ends the process at once. A listener of your own for the same
 * signal is called again by the re-sent signal.
 *
 * The process is found by feature detection (`globalThis.process` with `on`, `once`,
 * `removeListener` and `kill`). Where there is none (a browser, a worker) nothing is
 * installed and the function returned does nothing.
 *
 * Install it once per process. `createSecureClient` installs it for you (one set per process,
 * for every client that holds it) when the client signs in for a 1-day API key: no
 * `credentials.backend`, no persistent `store`, a runtime with process signals, and
 * `shutdownHooks` not `false`. Call it yourself only for a client created with
 * `shutdownHooks: false`.
 *
 * @returns A function that removes both handlers. Calling it again does nothing.
 * @throws {UserInputError} if `close` is not a function.
 * @example
 * const client = await createSecureClient({ signer, shutdownHooks: false });
 * const uninstall = installShutdownHooks(() => client.close());
 */
export function installShutdownHooks(close: () => Promise<void>): () => void {
  if (typeof close !== 'function') {
    throw new UserInputError('close must be a function');
  }
  const target = signalProcess();
  if (target === undefined) {
    return () => {};
  }
  const handlers = new Map<Signal, () => void>();
  let installed = true;

  const uninstall = (): void => {
    if (!installed) {
      return;
    }
    installed = false;
    for (const [signal, handler] of handlers) {
      target.removeListener(signal, handler);
    }
  };

  const shutdown = async (signal: Signal): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        // Starts close() at once; a synchronous throw becomes a rejection.
        new Promise<void>((resolve) => resolve(close())),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
        }),
      ]);
    } catch {
      // The process ends either way.
    } finally {
      clearTimeout(timer);
    }
    target.kill(target.pid, signal);
  };

  for (const signal of SIGNALS) {
    const handler = (): void => {
      uninstall();
      void shutdown(signal);
    };
    handlers.set(signal, handler);
    target.once(signal, handler);
  }
  return uninstall;
}

/**
 * Runs `close` once when the process is about to exit normally: on Node's `beforeExit`, which
 * is emitted when the event loop has nothing left to do (it is not emitted for
 * `process.exit()`, a signal or an uncaught exception). `close` may start requests, such as
 * revoking a short-lived backend key: they keep the process alive until they finish. The
 * handler is installed with `once` and runs `close` at most once, even when the event is
 * emitted again after that work.
 *
 * Where there is no process (a browser, a worker) nothing is installed and the function
 * returned does nothing.
 *
 * @returns A function that removes the handler. Calling it again does nothing.
 * @throws UserInputError if `close` is not a function.
 */
export function installExitHook(close: () => Promise<void>): () => void {
  if (typeof close !== 'function') {
    throw new UserInputError('close must be a function');
  }
  const target = signalProcess();
  if (target === undefined) {
    return () => {};
  }
  let installed = true;
  let ran = false;
  const handler = (): void => {
    installed = false;
    if (ran) {
      return;
    }
    ran = true;
    // Starts close() at once; a synchronous throw or a rejection is ignored.
    void new Promise<void>((resolve) => resolve(close())).catch(
      () => undefined,
    );
  };
  target.once('beforeExit', handler);
  return () => {
    if (!installed) {
      return;
    }
    installed = false;
    target.removeListener('beforeExit', handler);
  };
}
