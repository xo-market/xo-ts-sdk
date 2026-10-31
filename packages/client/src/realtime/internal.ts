import {
  RateLimitError,
  TimeoutError,
  TransportError,
  UserInputError,
  XoError,
} from '../core/errors';

// Internal: helpers the realtime channels share (the orderbook WebSocket and the backend
// Socket.IO). Not re-exported from any barrel.

/**
 * A failure worth retrying: the network, a timeout, a 429, or a 5xx. Anything else (a
 * refused or missing signer, an undeployed smart wallet, a closed session, a bad option)
 * will fail again the same way.
 */
export function isTransient(error: unknown): boolean {
  return (
    error instanceof TransportError ||
    error instanceof TimeoutError ||
    error instanceof RateLimitError ||
    (error instanceof XoError &&
      error.status !== undefined &&
      error.status >= 500)
  );
}

/**
 * The name and code of an error, and nothing else: the `cause` of a credential error. The
 * original may come from deep inside a login, so neither it nor its message is kept.
 */
export function scrubbedCause(error: unknown): { name: string; code?: string } {
  return {
    name: error instanceof Error ? error.name : typeof error,
    ...(error instanceof XoError ? { code: error.code } : {}),
  };
}

export function readFlag(
  value: unknown,
  field: string,
  fallback: boolean,
): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new UserInputError(`${field} must be true or false`);
  }
  return value;
}

export function hasMethods(value: unknown, names: readonly string[]): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    names.every(
      (name) => typeof (value as Record<string, unknown>)[name] === 'function',
    )
  );
}
