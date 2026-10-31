import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { UserInputError } from '../../src/core/errors';
import {
  hasShutdownSignals,
  installShutdownHooks,
} from '../../src/core/shutdown';

// The runtime-agnostic shutdown hooks. The signal behaviour itself is tested in
// test/auth/session.test.ts (through the node entry, which re-exports this module).

/** Runs `run` with `globalThis.process` replaced, synchronously, then puts it back. */
function withProcess<T>(value: unknown, run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process');
  Object.defineProperty(globalThis, 'process', {
    value,
    configurable: true,
    writable: true,
  });
  try {
    return run();
  } finally {
    if (descriptor !== undefined) {
      Object.defineProperty(globalThis, 'process', descriptor);
    }
  }
}

afterEach(() => vi.restoreAllMocks());

describe('installShutdownHooks without Node', () => {
  test('finds Node by feature detection', () => {
    expect(hasShutdownSignals()).toBe(true);
  });

  test.each([
    ['no process at all', undefined],
    ['a process polyfill without signals', { env: {} }],
    [
      'a process without kill',
      { on() {}, once() {}, removeListener() {}, pid: 1 },
    ],
  ])('%s: installs nothing and returns a no-op', (_, fake) => {
    const close = vi.fn(async () => undefined);
    const [detected, uninstall] = withProcess(
      fake,
      () => [hasShutdownSignals(), installShutdownHooks(close)] as const,
    );
    expect(detected).toBe(false);
    expect(() => uninstall()).not.toThrow();
    expect(close).not.toHaveBeenCalled();
  });

  test('a close that is not a function → UserInputError, in any runtime', () => {
    expect(() => installShutdownHooks('close' as never)).toThrow(
      UserInputError,
    );
    const thrown = withProcess(undefined, () => {
      try {
        installShutdownHooks(42 as never);
        return undefined;
      } catch (error) {
        return error;
      }
    });
    expect(thrown).toBeInstanceOf(UserInputError);
  });

  test('the module names no Node type and imports no Node builtin', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/core/shutdown.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/\bNodeJS\./);
    expect(source).not.toMatch(/from\s+['"]node:/);
  });
});
