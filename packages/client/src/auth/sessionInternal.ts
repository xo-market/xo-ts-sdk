// Helpers of the Session (src/auth/session.ts). Internal: not re-exported from any barrel.

import { isBackendKey, isHeaderValue } from '../core/apiKey';
import type { Clock } from '../core/clock';
import {
  isRejected,
  RateLimitError,
  UserInputError,
  XoError,
} from '../core/errors';
import { isValidSecret, type OrderbookCredential } from '../signing/hmac';
import type { WalletInput } from '../wallet/identity';
import { errorName, isObject, WALLET_SHAPE_MESSAGE } from '../wallet/internal';
import type { InternalSigner } from '../wallet/signer';
import { MintedKeyError } from './backendAuth';
import {
  type BackendCredential,
  BackendCredentialSchema,
  type CredentialStore,
  MintPauseSchema,
  OrderbookCredentialSchema,
  type StoredCredentials,
} from './store';

/**
 * What a session that mints a short-lived backend key (no persistent store) passes to `warn`,
 * once per session. The secure client forwards it once per process, so it
 * compares messages with this constant.
 */
export const SHORT_LIVED_WARNING =
  '@xomarket/client: no persistent credential store is set, so this session minted a short-lived (1-day) backend API key and revokes it on close(). ' +
  'An account can hold only 10 active keys, so a process that restarts often can use them up. ' +
  'Pass a persistent store, such as fileStore from @xomarket/client/node, so one key is reused across restarts.';

/** What the orderbook client reads from a session. The signer holds no key material, only functions. */
export interface SessionInternals {
  readonly signer: InternalSigner | undefined;
  readonly clock: Clock;
  /** Whether orderbook credentials were passed in (`credentials.orderbook`): L2 works without a signer. */
  readonly providedOrderbook: boolean;
}

/**
 * The signer and the server clock of each Session, for the orderbook client: it signs
 * orders and EIP-712 cancels as the trader and checks GTD expirations against the server's
 * time. A Session registers a getter here in its constructor. The map is module-scoped and
 * keyed weakly, so nothing outside the SDK can reach a session's signer by reflection, and a
 * session that is garbage-collected leaves no entry.
 */
const SESSION_INTERNALS = new WeakMap<object, () => SessionInternals>();

/** Called once, by the Session constructor. */
export function registerSessionInternals(
  session: object,
  read: () => SessionInternals,
): void {
  if (SESSION_INTERNALS.has(session)) {
    throw new UserInputError('a session registers its internals once');
  }
  SESSION_INTERNALS.set(session, read);
}

/**
 * The signer and clock of a Session, or `undefined` for an object that is not one.
 * @throws XoError `session_closed` after the session's `close()`.
 */
export function sessionInternals(
  session: object,
): SessionInternals | undefined {
  return SESSION_INTERNALS.get(session)?.();
}

export interface Flight<T> {
  kind: 'ensure' | 'rotate' | 'recover';
  promise: Promise<T>;
}

/** The one login (or rotation, or recovery) of a credential kind that is under way. */
export class SingleFlight<T> {
  current: Flight<T> | undefined;

  start(kind: Flight<T>['kind'], task: () => Promise<T>): Promise<T> {
    // Registered before the task starts, so a call the task makes re-entrantly joins it.
    const promise: Promise<T> = Promise.resolve()
      .then(task)
      .finally(() => {
        if (this.current?.promise === promise) {
          this.current = undefined;
        }
      });
    this.current = { kind, promise };
    return promise;
  }
}

/** A safe name for a failure: the error's code for an `XoError` (already redacted), else its class name. */
export function reasonOf(error: unknown): string {
  return error instanceof XoError ? error.code : errorName(error);
}

export function isUsableOrderbook(c: OrderbookCredential): boolean {
  return (
    isHeaderValue(c.apiKey) &&
    isHeaderValue(c.passphrase) &&
    isValidSecret(c.secret)
  );
}

/** One part of a stored record, parsed, or `undefined`. A throwing getter counts as missing. */
function part<T>(
  read: () => unknown,
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
): T | undefined {
  try {
    const parsed = schema.safeParse(read());
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The usable parts of a stored record. Each part is checked on its own, so a
 * malformed orderbook part does not throw away a good backend key, nor the other way round.
 * Anything malformed counts as missing and is never echoed.
 */
export function usable(value: unknown): StoredCredentials {
  if (!isObject(value)) {
    return {};
  }
  const out: StoredCredentials = {};
  const backend = part(() => value.backend, BackendCredentialSchema);
  if (backend !== undefined && isBackendKey(backend.key)) {
    out.backend = backend;
  }
  const orderbook = part(() => value.orderbook, OrderbookCredentialSchema);
  if (orderbook !== undefined && isUsableOrderbook(orderbook)) {
    out.orderbook = orderbook;
  }
  const mintPause = part(() => value.mintPause, MintPauseSchema);
  if (mintPause !== undefined) {
    out.mintPause = mintPause;
  }
  return out;
}

export function isExpired(c: BackendCredential, nowMs: number): boolean {
  const at = Date.parse(c.expiresAt);
  return Number.isFinite(at) && at <= nowMs;
}

export const copyBackend = (c: BackendCredential): BackendCredential => ({
  ...c,
  scopes: [...c.scopes],
});

export const presence = (provided: unknown, held: unknown) =>
  provided !== undefined ? 'provided' : held !== undefined ? 'session' : 'none';

/** A key id as the backend takes it: a positive 32-bit integer in plain decimal. */
const KEY_ID = /^[1-9]\d{0,9}$/;

/** What {@link readProvided} found: the given key, its metadata, and the order book credentials. */
export interface ReadProvided {
  backend?: string;
  /** The key's id, when it was given (as `exportCredentials()` gives it). */
  backendId?: string;
  /** The key's expiry, an ISO-8601 time, when it was given. */
  backendExpiresAt?: string;
  orderbook?: OrderbookCredential;
}

/** Checks the bring-your-own credentials once. Messages name the field, never a value. */
export function readProvided(credentials: unknown): ReadProvided {
  if (credentials === undefined) {
    return {};
  }
  if (!isObject(credentials)) {
    throw new UserInputError(
      'credentials must be { backend?: { apiKey }, orderbook?: { apiKey, secret, passphrase } }',
    );
  }
  const out: ReadProvided = {};
  const backend = credentials.backend;
  if (backend !== undefined) {
    const apiKey = isObject(backend) ? backend.apiKey : undefined;
    if (!isBackendKey(apiKey)) {
      throw new UserInputError(
        'credentials.backend.apiKey must be an API key: "xo_sk_" followed by visible ASCII characters only',
      );
    }
    out.backend = apiKey;
    const { id, expiresAt } = backend as { id?: unknown; expiresAt?: unknown };
    if (id !== undefined) {
      if (
        typeof id !== 'string' ||
        !KEY_ID.test(id) ||
        Number(id) > 2_147_483_647
      ) {
        throw new UserInputError(
          'credentials.backend.id must be the id of the key, 1 to 2147483647 as a string, as exportCredentials() gives it',
        );
      }
      out.backendId = id;
    }
    if (expiresAt !== undefined) {
      if (
        typeof expiresAt !== 'string' ||
        !Number.isFinite(Date.parse(expiresAt))
      ) {
        throw new UserInputError(
          'credentials.backend.expiresAt must be an ISO-8601 time, as exportCredentials() gives it',
        );
      }
      out.backendExpiresAt = expiresAt;
    }
  }
  const orderbook = credentials.orderbook;
  if (orderbook !== undefined) {
    if (!isObject(orderbook)) {
      throw new UserInputError(
        'credentials.orderbook must be { apiKey, secret, passphrase }',
      );
    }
    const { apiKey, secret, passphrase } = orderbook;
    for (const [field, value] of [
      ['apiKey', apiKey],
      ['passphrase', passphrase],
    ] as const) {
      if (!isHeaderValue(value)) {
        throw new UserInputError(
          `credentials.orderbook.${field} must be 1 to 256 visible ASCII characters without whitespace`,
        );
      }
    }
    if (typeof secret !== 'string' || !isValidSecret(secret)) {
      throw new UserInputError(
        'credentials.orderbook.secret must be base64 or base64url, with no whitespace',
      );
    }
    out.orderbook = Object.freeze({
      apiKey: apiKey as string,
      secret,
      passphrase: passphrase as string,
    });
  }
  return out;
}

const storeLocks = new WeakMap<CredentialStore, Map<string, Promise<void>>>();

/**
 * Runs `run` after every earlier call for the same store and key, in this process. The
 * backend and orderbook credentials share one record, so each read-merge-write must not
 * interleave with another.
 */
export function withStoreLock<T>(
  store: CredentialStore,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  let locks = storeLocks.get(store);
  if (locks === undefined) {
    locks = new Map();
    storeLocks.set(store, locks);
  }
  const byKey = locks;
  const result = (byKey.get(key) ?? Promise.resolve()).then(run);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  byKey.set(key, tail);
  tail.then(() => {
    if (byKey.get(key) === tail) {
      byKey.delete(key);
    }
  });
  return result;
}

/**
 * Whether a failed backend login must not be retried at once: it may have minted a
 * key (a {@link MintedKeyError}), or the backend asked to slow down (a `RateLimitError`).
 */
export function pausesLogin(error: unknown): boolean {
  return (
    error instanceof MintedKeyError ||
    error instanceof RateLimitError ||
    isKeyLimit(error)
  );
}

/** The backend's 409 `api_key_limit_reached`, as BackendAuth raises it. */
function isKeyLimit(error: unknown): boolean {
  return isRejected(error, 409) && error.code === 'api_key_limit_reached';
}

/** The one warn of a login pause. It names the key's id when known, never a secret. */
export function loginPauseWarning(error: unknown, pauseSec: number): string {
  if (isKeyLimit(error)) {
    return `@xomarket/client: the account already has 10 active API keys (api_key_limit_reached), so the session will not try to create another for ${pauseSec} s. The error explains how keys expire and how to free one.`;
  }
  if (!(error instanceof MintedKeyError)) {
    return `@xomarket/client: the backend rate-limited the API key login (${reasonOf(error)}), so the session will not log in again for ${pauseSec} s.`;
  }
  const which =
    error.keyId === undefined ? '(id unknown)' : `id ${error.keyId}`;
  return `@xomarket/client: the API key login may have created key ${which}, but its answer was lost or could not be used, so the session will not log in again for ${pauseSec} s, and until a login succeeds every key it asks for lasts 1 day. A key it created counts toward the 10 active keys until it expires. The XO website has no key-management page yet: ask XO to revoke it, or let it expire.`;
}

/**
 * Checks the wallet up front, with the rules `resolveTradingIdentity` applies later:
 * `{ type: 'eoa' }` (the default) or `{ type: 'smart_wallet', index? }` with a non-negative
 * index (a safe integer or a uint256 bigint), and no other key.
 */
export function checkWallet(wallet: unknown): WalletInput {
  if (wallet === undefined) {
    return { type: 'eoa' };
  }
  if (isObject(wallet)) {
    const keys = Object.keys(wallet);
    if (wallet.type === 'eoa' && keys.length === 1) {
      return wallet as WalletInput;
    }
    if (
      wallet.type === 'smart_wallet' &&
      keys.every((k) => k === 'type' || k === 'index')
    ) {
      const index = wallet.index;
      if (
        index === undefined ||
        (typeof index === 'number' &&
          Number.isSafeInteger(index) &&
          index >= 0) ||
        (typeof index === 'bigint' && index >= 0n && index < 1n << 256n)
      ) {
        return wallet as WalletInput;
      }
    }
  }
  throw new UserInputError(WALLET_SHAPE_MESSAGE);
}
