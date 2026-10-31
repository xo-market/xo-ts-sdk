import { SHORT_LIVED_WARNING } from '../auth/sessionInternal';
import { isRecord, processShared } from './shared';

// The `warn` of every session the SDK wires itself (a secure client's): the recommendation of
// a persistent store goes out once per process. Internal: the tests reset it through
// `clients/internal`.

const state = processShared(
  'short-lived-warning.v1',
  () => ({ warned: false }),
  (value): value is { warned: boolean } =>
    isRecord(value) && typeof value.warned === 'boolean',
);

/**
 * `console.warn`, except that the short-lived-key warning (the session's recommendation of
 * `fileStore`) goes out once per process, not once per session: across clients, and across an
 * ESM and a CommonJS copy of the package. Every other message goes out each time. Never
 * receives a secret.
 */
export function processWarn(message: string): void {
  if (message === SHORT_LIVED_WARNING) {
    if (state.warned) {
      return;
    }
    state.warned = true;
  }
  console.warn(message);
}

/** Forgets that the warning went out. Test-only, internal. */
export function resetProcessWarning(): void {
  state.warned = false;
}
