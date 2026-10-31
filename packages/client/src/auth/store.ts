import type { Address } from 'viem';
import { z } from 'zod';
import { normalizeAddress } from '../core/address';
import { UserInputError } from '../core/errors';
import type { OrderbookCredential } from '../signing/hmac';

/** The `xo_sk_data_...` bearer key a SIWE login returns. */
export interface BackendCredential {
  /** The key's id on the backend. */
  id: string;
  /** The secret bearer key itself. */
  key: string;
  /** The non-secret start of `key`, which the backend lists. */
  prefix: string;
  scopes: string[];
  /** ISO-8601 time. The store never reads it: the session decides when a key is stale. */
  expiresAt: string;
}

/** Everything stored for one `(env, trading address)` pair. Each kind is optional. */
export interface StoredCredentials {
  backend?: BackendCredential;
  orderbook?: OrderbookCredential;
  /**
   * Not a secret. Set by a session whose backend key request may have created a key it did
   * not get (its answer was lost or could not be used), and removed when a key is stored:
   * when that happened (`atMs`, unix milliseconds by the local clock) and how long logins
   * stay paused after it (`pauseMs`). A session that starts later honours what is left of
   * the pause, and asks for a 1-day key until a mint succeeds. A record without it, or with
   * a malformed one, loads as before.
   */
  mintPause?: { atMs: number; pauseMs: number };
}

/**
 * Keeps credentials between calls. Everything in a store is a secret (except `mintPause`):
 * an implementation must never log a value, and no error it throws may contain one.
 */
export interface CredentialStore {
  /** `true` when values outlive the process. A session issues longer-lived keys then. */
  readonly persistent: boolean;
  /** The stored value, or `undefined` when there is none or it cannot be used. */
  get(key: string): Promise<StoredCredentials | undefined>;
  /** Stores `value` under `key`, replacing what was there. */
  set(key: string, value: StoredCredentials): Promise<void>;
  /** Removes a key. A key that is not there is not an error. */
  delete(key: string): Promise<void>;
}

// Internal: not re-exported from `src/index.ts` or `src/node.ts`.
export const BackendCredentialSchema = z.object({
  id: z.string(),
  key: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string(),
});

export const OrderbookCredentialSchema = z.object({
  apiKey: z.string(),
  secret: z.string(),
  passphrase: z.string(),
});

export const MintPauseSchema = z.object({
  atMs: z.number().nonnegative(),
  pauseMs: z.number().nonnegative(),
});

/**
 * Unknown fields are stripped, not rejected. A malformed `mintPause` is dropped (it is only
 * a note), so it can never cost the record its credentials.
 */
export const StoredCredentialsSchema = z
  .object({
    backend: BackendCredentialSchema.optional(),
    orderbook: OrderbookCredentialSchema.optional(),
    mintPause: MintPauseSchema.optional().catch(undefined),
  })
  // A dropped note leaves no `mintPause: undefined` key behind.
  .transform(
    ({ mintPause, ...rest }): StoredCredentials =>
      mintPause === undefined ? rest : { ...rest, mintPause },
  );

// Compile-time only. Each pair must be the same type, so a field added to a schema but
// not to its interface (or the other way round) fails `tsc`. Plain mutual assignability
// would let an extra optional field through, so the types are compared for identity.
type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type MustBeTrue<T extends true> = T;
type _SchemasMatchInterfaces = [
  MustBeTrue<Same<z.infer<typeof BackendCredentialSchema>, BackendCredential>>,
  MustBeTrue<
    Same<z.infer<typeof OrderbookCredentialSchema>, OrderbookCredential>
  >,
  MustBeTrue<Same<z.infer<typeof StoredCredentialsSchema>, StoredCredentials>>,
];

// A fixed message. The zod issues and the value are never repeated, because the value
// is a secret.
const INVALID_CREDENTIALS =
  'value must be { backend?: BackendCredential; orderbook?: OrderbookCredential } with string fields';

/**
 * Checks a value about to be stored and returns a fresh copy that holds only the known
 * fields. Throws a `UserInputError` with a fixed message that contains no part of the
 * value, whatever the value is (even a getter that throws).
 */
export function parseStoredCredentials(value: unknown): StoredCredentials {
  let parsed: ReturnType<typeof StoredCredentialsSchema.safeParse>;
  try {
    parsed = StoredCredentialsSchema.safeParse(value);
  } catch {
    throw new UserInputError(INVALID_CREDENTIALS);
  }
  if (!parsed.success) {
    throw new UserInputError(INVALID_CREDENTIALS);
  }
  return parsed.data;
}

/**
 * Keeps credentials in memory for the life of the process. `set` checks the value and
 * keeps only the known fields; values are copied in and out.
 */
export function memoryStore(): CredentialStore {
  const entries = new Map<string, StoredCredentials>();
  return {
    persistent: false,
    async get(key) {
      const value = entries.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
    async set(key, value) {
      // `parseStoredCredentials` returns a new object tree, so later changes to `value`
      // do not reach the store.
      entries.set(key, parseStoredCredentials(value));
    },
    async delete(key) {
      entries.delete(key);
    },
  };
}

const ENV_NAME = /^[a-z0-9-]+$/;

/**
 * The store key for one environment and trading address: `<env>:<0x address, lower-case>`.
 * Any casing of a valid address gives the same key.
 * `envName` may only hold `a-z`, `0-9` and `-`.
 */
export function credentialKey(
  envName: string,
  tradingAddress: Address,
): string {
  if (typeof envName !== 'string' || !ENV_NAME.test(envName)) {
    throw new UserInputError('envName must match /^[a-z0-9-]+$/');
  }
  const address = normalizeAddress(tradingAddress, 'tradingAddress');
  return `${envName}:${address.toLowerCase()}`;
}
