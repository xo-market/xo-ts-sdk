import { type Address, type Hex, zeroAddress } from 'viem';
import { z } from 'zod';
import { isSameAddress } from '../core/address';
import type { Clock } from '../core/clock';
import type { EnvironmentConfig } from '../core/env';
import {
  AuthRequiredError,
  isRejected,
  UserInputError,
  XoError,
} from '../core/errors';
import {
  defineSchema,
  parseResponse,
  type ResponseIssue,
} from '../core/schema';
import type {
  AuthKind,
  AuthProvider,
  Transport,
  UnauthorizedContext,
} from '../core/transport';
import { l2Headers, type OrderbookCredential } from '../signing/hmac';
import {
  resolveTradingIdentity,
  type TradingIdentity,
  type WalletInput,
} from '../wallet/identity';
import { isObject } from '../wallet/internal';
import type { InternalSigner } from '../wallet/signer';
import {
  BackendAuth,
  checkAuthTimeout,
  checkLabel,
  MintedKeyError,
} from './backendAuth';
import { deleteOrderbookKey, OrderbookAuth } from './orderbookAuth';
import {
  checkWallet,
  copyBackend,
  isExpired,
  loginPauseWarning,
  pausesLogin,
  presence,
  readProvided,
  reasonOf,
  registerSessionInternals,
  SHORT_LIVED_WARNING,
  SingleFlight,
  usable,
  withStoreLock,
} from './sessionInternal';
import {
  type BackendCredential,
  type CredentialStore,
  credentialKey,
  memoryStore,
  type StoredCredentials,
} from './store';

/**
 * Credentials the caller brings. The SDK uses them as they are: it never rotates them, and
 * revokes them only when the wallet signs out. A key may come with its `id` and `expiresAt`, as
 * an export gives them; without them a sign-out finds the key's id in the key listing.
 */
export interface ProvidedCredentials {
  backend?: { apiKey: string; id?: string; expiresAt?: string };
  orderbook?: OrderbookCredential;
}

/** The options of {@link Session}. The secure client builds one session from its own options. */
export interface SessionOptions {
  env: EnvironmentConfig;
  transport: Transport;
  clock: Clock;
  /** Logs in to the backend and the orderbook. Without it only `credentials` can authenticate. */
  signer?: InternalSigner;
  /** Defaults to `{ type: 'eoa' }`. */
  wallet?: WalletInput;
  /** Defaults to `memoryStore()`: 1-day backend keys, revoked on `close()`. */
  store?: CredentialStore;
  credentials?: ProvidedCredentials;
  /** Part of the backend key's name, `xo-sdk:<label>:<yyyymmdd>`. */
  label?: string;
  /**
   * A read-only `eth_call` of `data` on contract `to`, resolving with the raw return data. For
   * a smart wallet the session reads its address from the smart wallet factory with it.
   */
  readContract: (call: { to: Address; data: Hex }) => Promise<Hex>;
  /** For a smart wallet: whether it is deployed, asked before an orderbook login. */
  isDeployed?: (address: Address) => Promise<boolean>;
  /** Defaults to `console.warn`. Never receives a secret. */
  warn?: (message: string) => void;
  /** Reject response fields the schemas do not know (for contract tests). */
  strictResponses?: boolean;
  /**
   * The local clock in milliseconds, for the recovery cooldown and the login pause. Defaults
   * to `Date.now`. Key expiry is judged by the server's time, from `clock`.
   */
  now?: () => number;
  /**
   * The per-attempt timeout of the requests that sign the wallet in or out (the sign-in
   * message, the key request, the orderbook credential requests, and the revokes and the
   * deletion of a sign-out), in milliseconds. Defaults to the transport's.
   */
  authTimeoutMs?: number;
}

type Kind = Exclude<AuthKind, 'none'>;

/** A backend key the session holds, and whether this session minted it. */
interface HeldKey {
  credential: BackendCredential;
  origin: 'minted' | 'loaded';
  /** When this session minted it, by the local clock. */
  mintedAt?: number;
  /** Minted already looking expired or due: never rotated or replaced automatically. */
  pinned?: boolean;
  /**
   * A 1-day key minted after a lost key answer: judged by the 1-day key's 2-hour rotation
   * window even in a persistent store, so it is rotated (to a normal key) rather than pinned.
   */
  shortLived?: boolean;
  /** False while a minted key's store write has not succeeded. */
  saved: boolean;
}

/** The recovery cooldown of one credential kind. */
interface Recovery {
  /** When the last recovery ended, by the local clock. */
  at: number;
  /** How long after `at` another 401 is not recovered. */
  cooldown: number;
  /** Whether a 401 after this recovery has already doubled `cooldown`. */
  doubled: boolean;
  /** The last 401 on the current credential. */
  last401: number;
}

/**
 * After a 401 recovery, another 401 of the same kind within this window is not recovered.
 * A 401 within twice the window doubles it, up to 1 h; an hour without a 401 resets it.
 */
const RECOVERY_COOLDOWN_MS = 60_000;
const MAX_RECOVERY_COOLDOWN_MS = 3_600_000;
const RECOVERY_RESET_MS = 3_600_000;
/**
 * After a backend login that may have minted a key, or got a 429, no new login is tried for
 * this long. A failed rotation is retried no sooner either, while the old key is valid.
 */
const LOGIN_PAUSE_MS = 60_000;
/**
 * Each consecutive `MintedKeyError` doubles the login pause, up to this. A successful
 * mint resets it; a 429 or a 409 keeps the plain {@link LOGIN_PAUSE_MS}. The pause slows the
 * minting down but does not stop it, so until a mint succeeds every key asked for lasts
 * 1 day: a backend that keeps losing its answers then holds the account's 10 key slots for
 * about a day at most, not for 90 days. The pause is saved in the store, so a restarted
 * process honours it too.
 */
const MAX_LOGIN_PAUSE_MS = 3_600_000;
/** A failed store write of a minted key is retried at most this often. */
const SAVE_RETRY_MS = 60_000;
/** A key this session minted less than this long ago is never replaced or rotated automatically. */
const FRESH_KEY_MS = 60_000;

const NO_BACKEND =
  'This request needs a backend API key, but the session has neither a signer nor a key: pass the `signer` option to log in with a wallet, or `credentials: { backend: { apiKey } }` to use an existing key';
const NO_ORDERBOOK =
  'This request needs orderbook credentials, but the session has no signer to log in with: pass the `signer` option, or `credentials: { orderbook: { apiKey, secret, passphrase } }`';
const NO_SIGNER = 'A trading identity needs a wallet: pass the `signer` option';
const PROVIDED_NOT_ROTATED =
  'The backend key came from `credentials.backend`, so the SDK does not rotate it: create a new key yourself and pass it to a new session';
const PINNED_WARNING =
  '@xomarket/client: the backend API key just minted already looks expired or due for rotation (clock skew or a short backend expiry), so the session will not rotate it automatically; it keeps using it until the backend refuses it.';

/**
 * The credentials behind every authenticated request: the backend `xo_sk_` bearer key and
 * the orderbook L2 (HMAC) credentials. Install it with `transport.setAuth(session)`.
 *
 * - **Single flight.** Concurrent calls share one backend login and one orderbook login, so
 *   a burst of requests at startup mints one key. Rotation and 401 recovery share the same
 *   flight, and requests made meanwhile wait for it.
 * - **Persistence.** Credentials load from the store, keyed by environment and trading
 *   address (the smart wallet's own address when one trades). A valid key is used without
 *   any request; an expired one is replaced by a fresh login. With a persistent store backend keys last
 *   90 days and are rotated when fewer than 7 remain; with the default memory store they
 *   last 1 day and are revoked on `close()`, and so is a key a persistent store failed to
 *   save. Store access is serialized within this process only: sharing one `fileStore`
 *   directory between processes that run at the same time is not supported.
 * - **Rotation.** Mint a new key, switch to it, store it, then revoke the old one with the
 *   old key. A failed revoke is reported once through `warn` (the key expires on its own).
 * - **401 recovery.** Backend: log in again, then revoke the rejected key with itself.
 *   Orderbook: sync the clock and derive again (derive returns the existing credentials).
 *   Each kind recovers at most once per 60 s, because the account holds only 10 active
 *   backend keys; while recoveries keep being followed by another 401 the wait doubles, up
 *   to 1 h, and an hour without a 401 resets it. Credentials from `credentials` are never
 *   refreshed, rotated or revoked.
 * - **Login pause.** A backend login that may have created a key the
 *   session does not hold (a `MintedKeyError`: an unusable 201, or a key request lost to a
 *   network error, a timeout or a 5xx), or that got a 429 or a 409 `api_key_limit_reached`,
 *   is not retried for 60 s: until then every call that would log in rethrows that error,
 *   and one `warn` names the key's id when known. Each consecutive `MintedKeyError` doubles
 *   the pause, up to 1 h, until a mint succeeds, and until then every key asked for lasts
 *   1 day (rotated when fewer than 2 hours remain), even with a persistent store: a backend
 *   that keeps losing its answers holds the account's 10 key slots for about a day at most.
 *   The pause of a `MintedKeyError` is saved in the store (`mintPause`, not a secret) and
 *   cleared when a key is stored, so a session started later honours what is left of it
 *   (rethrowing a `MintedKeyError` meanwhile) and asks for a 1-day key too; a store that
 *   cannot save it gets one `warn`. Refusals (400, 401 `invalid_signature`, 403) and any
 *   failure of the nonce request are retried on the next call. A failed rotation keeps the
 *   old, still valid key and is retried after 60 s at the earliest.
 * - **Fresh keys.** Expiry is judged by the server's time (`clock`), so a skewed
 *   local clock cannot make a key look expired. The clock is synced once per session (best
 *   effort; on failure the local time is used) before the first decision that acts on an
 *   expiry (dropping, rotating or minting a key), so a valid stored key needs no request. A key this session minted less than
 *   60 s ago is never replaced or rotated automatically, and one that already looks expired
 *   or due when it arrives is never rotated automatically (one `warn`).
 * - **Stale 401s.** A 401 for a request that carried an older credential than the
 *   current one is retried with the current one: nothing is minted, revoked or cooled down.
 * - **Orderbook login.** The clock is synced first (best effort). The L1 timestamp must
 *   reach the gateway within 120 s of signing, so a wallet approval slower than that is
 *   refused with a 401: the session syncs the clock and signs once more (a second wallet
 *   prompt), and nothing further.
 *
 * Secrets live in private fields only: `toJSON()` and `util.inspect` show which
 * credentials are present, never their values. The session makes no wallet signature
 * itself (BackendAuth and OrderbookAuth do); it only adds the L2 HMAC of each request.
 *
 * Internal: an engine behind the two clients. No entry of the package exports it.
 */
export class Session implements AuthProvider {
  readonly #env: EnvironmentConfig;
  readonly #transport: Transport;
  readonly #clock: Clock;
  readonly #signer: InternalSigner | undefined;
  readonly #wallet: WalletInput;
  readonly #store: CredentialStore;
  readonly #persistent: boolean;
  readonly #label: string | undefined;
  readonly #readContract: SessionOptions['readContract'];
  readonly #isDeployed: SessionOptions['isDeployed'];
  readonly #warn: (message: string) => void;
  readonly #strict: boolean | undefined;
  readonly #now: () => number;
  readonly #providedBackend: string | undefined;
  readonly #providedBackendId: string | undefined;
  readonly #providedBackendExpiresAt: string | undefined;
  readonly #providedOrderbook: OrderbookCredential | undefined;
  readonly #authTimeoutMs: number | undefined;

  #identity: Promise<TradingIdentity> | undefined;
  #resolved: TradingIdentity | undefined;
  #backendAuth: BackendAuth | undefined;
  #orderbookAuth: OrderbookAuth | undefined;
  #loading: Promise<void> | undefined;
  #backend: HeldKey | undefined;
  #orderbook: OrderbookCredential | undefined;
  readonly #backendFlight = new SingleFlight<BackendCredential>();
  readonly #orderbookFlight = new SingleFlight<OrderbookCredential>();
  readonly #recovery: Partial<Record<Kind, Recovery>> = {};
  #saving: Promise<void> | undefined;
  #saveRetriedAt: number | undefined;
  #loginPause:
    | {
        error: unknown;
        at: number;
        ms: number;
        /** A pause read from the store warns when it first refuses a login. */
        warning?: string;
      }
    | undefined;
  /**
   * The pause of the last `MintedKeyError` since the last successful mint, from this
   * session or a saved one. While it is set, the next mint asks for a 1-day key.
   */
  #mintPauseMs: number | undefined;
  #warnedMintPause = false;
  #firstSync: Promise<void> | undefined;
  #rotationFailedAt: number | undefined;
  #warnedShortLived = false;
  #warnedPinned = false;
  #closed = false;
  #closing: Promise<void> | undefined;
  #signingOut: Promise<void> | undefined;

  /** @throws UserInputError for an invalid option or credential. Messages never contain a value. */
  constructor(o: SessionOptions) {
    if (!isObject(o)) {
      throw new UserInputError('options must be an object');
    }
    const { env, transport, clock, signer, wallet, store, credentials } = o;
    const { label, readContract, isDeployed, warn, strictResponses, now } = o;
    const authTimeoutMs = checkAuthTimeout(o.authTimeoutMs);
    if (!isObject(env)) {
      throw new UserInputError('env must be an environment config');
    }
    if (!isObject(transport) || typeof transport.request !== 'function') {
      throw new UserInputError('transport must be a Transport');
    }
    if (
      !isObject(clock) ||
      typeof clock.sync !== 'function' ||
      typeof clock.nowSec !== 'function' ||
      typeof clock.nowSecString !== 'function'
    ) {
      throw new UserInputError('clock must be a Clock');
    }
    if (
      signer !== undefined &&
      (!isObject(signer) ||
        typeof signer.signMessage !== 'function' ||
        typeof signer.signTypedData !== 'function')
    ) {
      throw new UserInputError('signer must be a Signer');
    }
    const chosen = store ?? memoryStore();
    if (
      !isObject(chosen) ||
      typeof chosen.persistent !== 'boolean' ||
      typeof chosen.get !== 'function' ||
      typeof chosen.set !== 'function' ||
      typeof chosen.delete !== 'function'
    ) {
      throw new UserInputError('store must be a CredentialStore');
    }
    if (typeof readContract !== 'function') {
      throw new UserInputError('readContract must be a function');
    }
    for (const [name, fn] of [
      ['isDeployed', isDeployed],
      ['warn', warn],
      ['now', now],
    ] as const) {
      if (fn !== undefined && typeof fn !== 'function') {
        throw new UserInputError(`${name} must be a function`);
      }
    }
    if (strictResponses !== undefined && typeof strictResponses !== 'boolean') {
      throw new UserInputError('strictResponses must be true or false');
    }
    if (label !== undefined) {
      checkLabel(label);
    }
    const checkedWallet = checkWallet(wallet);
    if (signer !== undefined) {
      // The name keys the credential store record, which only a signer's session uses.
      try {
        credentialKey(env.name, zeroAddress);
      } catch {
        throw new UserInputError(
          'env.name must hold only a-z, 0-9 and - (it names the credential store record)',
        );
      }
    }
    const provided = readProvided(credentials);
    this.#env = env;
    this.#transport = transport;
    this.#clock = clock;
    this.#signer = signer;
    this.#wallet = checkedWallet;
    this.#store = chosen;
    this.#persistent = chosen.persistent;
    this.#label = label;
    this.#readContract = readContract;
    this.#isDeployed = isDeployed;
    this.#warn = warn ?? ((message) => console.warn(message));
    this.#strict = strictResponses;
    this.#now = now ?? (() => Date.now());
    this.#providedBackend = provided.backend;
    this.#providedBackendId = provided.backendId;
    this.#providedBackendExpiresAt = provided.backendExpiresAt;
    this.#providedOrderbook = provided.orderbook;
    this.#authTimeoutMs = authTimeoutMs;
    // Package-internal: the orderbook client signs with the signer and reads the server
    // clock. Kept in a module-scoped WeakMap, not on the object (see sessionInternal.ts).
    registerSessionInternals(this, () => {
      this.#assertOpen();
      return {
        signer: this.#signer,
        clock: this.#clock,
        providedOrderbook: this.#providedOrderbook !== undefined,
      };
    });
  }

  /** Whether the session has a signer, so it can log in and sign. */
  hasSigner(): boolean {
    return this.#signer !== undefined;
  }

  /** Whether a backend key is held right now (provided, loaded or minted). A signer can still get one. */
  hasBackendCredential(): boolean {
    return (
      !this.#closed &&
      (this.#providedBackend !== undefined || this.#backend !== undefined)
    );
  }

  /** The trading identity of the signer, resolved once. @throws AuthRequiredError without a signer. */
  identity(): Promise<TradingIdentity> {
    const signer = this.#signer;
    if (signer === undefined) {
      return Promise.reject(new AuthRequiredError(NO_SIGNER));
    }
    if (this.#identity === undefined) {
      const pending: Promise<TradingIdentity> = resolveTradingIdentity(
        signer,
        this.#wallet,
        this.#env,
        this.#readContract,
      ).then(
        (identity) => {
          this.#resolved = identity;
          return identity;
        },
        (error: unknown) => {
          // Not memoized: a failed lookup (an RPC outage) may succeed later.
          if (this.#identity === pending) {
            this.#identity = undefined;
          }
          throw error;
        },
      );
      this.#identity = pending;
    }
    return this.#identity;
  }

  /**
   * The backend key: the provided one, else the held one, else the stored one, else a new
   * login. A held key that needs rotation is rotated first. Single-flight.
   * @throws AuthRequiredError without a signer or a provided key. XoError `session_closed` after `close()`.
   */
  async ensureBackend(): Promise<BackendCredential> {
    this.#assertOpen();
    if (this.#providedBackend !== undefined) {
      // Only the key is known for a provided key.
      return {
        id: '',
        key: this.#providedBackend,
        prefix: '',
        scopes: [],
        expiresAt: '',
      };
    }
    if (this.#signer === undefined) {
      throw new AuthRequiredError(NO_BACKEND);
    }
    const flight = this.#backendFlight.current;
    const held = this.#backend;
    const auth = this.#backendAuth;
    let credential: BackendCredential;
    if (flight !== undefined) {
      credential = await flight.promise;
    } else if (
      held !== undefined &&
      auth !== undefined &&
      (this.#keepsAsIs(held) || !this.#isDue(auth, held))
    ) {
      credential = held.credential;
    } else {
      credential = await this.#backendFlight.start('ensure', () =>
        this.#ensureBackendTask(),
      );
    }
    this.#assertOpen();
    const current = this.#backend;
    if (
      current !== undefined &&
      !current.saved &&
      current.credential === credential
    ) {
      await this.#retrySave(current);
      this.#assertOpen();
    }
    return copyBackend(credential);
  }

  /**
   * The orderbook L2 credentials: the provided ones, else the held ones, else the stored
   * ones, else a login. Single-flight.
   * @throws AuthRequiredError without a signer or provided credentials. XoError `smart_wallet_not_deployed` for a smart wallet when `isDeployed` says so. XoError `session_closed` after `close()`.
   */
  async ensureOrderbook(): Promise<OrderbookCredential> {
    this.#assertOpen();
    if (this.#providedOrderbook !== undefined) {
      return { ...this.#providedOrderbook };
    }
    if (this.#signer === undefined) {
      throw new AuthRequiredError(NO_ORDERBOOK);
    }
    const flight = this.#orderbookFlight.current;
    const held = this.#orderbook;
    let credential: OrderbookCredential;
    if (flight !== undefined) {
      credential = await flight.promise;
    } else if (held !== undefined) {
      credential = held;
    } else {
      credential = await this.#orderbookFlight.start('ensure', () =>
        this.#ensureOrderbookTask(),
      );
    }
    this.#assertOpen();
    return { ...credential };
  }

  /** Both credentials, the backend key first (one wallet prompt at a time). */
  async login(): Promise<void> {
    await this.ensureBackend();
    await this.ensureOrderbook();
  }

  /**
   * Checks that the credentials given in `credentials` are this wallet's, before they are used
   * for anything. Nothing is stored, held or revoked here, and a mismatch is never repeated.
   *
   * - A given API key reads the account it belongs to (`GET /api/users/me`, one request, no
   *   signature): the account's wallet must be the trading address (the smart wallet's own
   *   address when one trades).
   * - Given orderbook credentials must be the ones the wallet derives (one L1 signature and
   *   `GET /auth/derive-api-key`, the request a login without them starts with): the wallet's
   *   own default key. A wallet the gateway has no key for owns none.
   *
   * The API key is checked first, so a foreign key costs no signature.
   *
   * @throws UserInputError `credentials_not_owned` naming the credential that is not the
   *   wallet's.
   * @throws AuthRequiredError without a signer, when orderbook credentials were given.
   * @throws The errors of the read or the derive (a 401 for a key the backend no longer
   *   accepts, the signer's, the request errors), as they are.
   */
  async checkProvidedCredentials(): Promise<void> {
    this.#assertOpen();
    const given = this.#providedBackend;
    const givenOrderbook = this.#providedOrderbook;
    if (given === undefined && givenOrderbook === undefined) {
      return;
    }
    const identity = await this.identity();
    if (given !== undefined) {
      const raw = await this.#transport.request({
        service: 'backend',
        method: 'GET',
        path: ME_PATH,
        auth: { kind: 'backend', key: given },
        timeoutMs: this.#authTimeoutMs,
      });
      // Only the wallet is read, so the rest of the profile never fails the check.
      const { walletPublicKey } = parseResponse(AccountWalletSchema, raw, {
        strict: false,
        service: 'backend',
        path: ME_PATH,
      });
      if (!isSameAddress(walletPublicKey, identity.address)) {
        throw notOwned('backend');
      }
    }
    if (givenOrderbook !== undefined) {
      const auth = await this.#getOrderbookAuth();
      await this.#syncOnce();
      let derived: OrderbookCredential | undefined;
      try {
        derived = await auth.derive();
      } catch (error) {
        // As for a login: a stale L1 timestamp is fixed by a sync and one more signature.
        if (!isRejected(error, 401)) {
          throw error;
        }
        await this.#syncClock();
        derived = await auth.derive();
      }
      if (
        derived === undefined ||
        derived.apiKey !== givenOrderbook.apiKey ||
        derived.secret !== givenOrderbook.secret ||
        derived.passphrase !== givenOrderbook.passphrase
      ) {
        throw notOwned('orderbook');
      }
    }
  }

  /**
   * The credentials the session uses, signing in for any it does not hold yet, in the shape
   * `credentials` takes: the API key with its `id` and `expiresAt` when they are known (a key
   * given without them is exported without them), and the orderbook credentials. Secrets.
   *
   * @throws The errors of {@link ensureBackend} and {@link ensureOrderbook}.
   */
  async exportCredentials(): Promise<Required<ProvidedCredentials>> {
    const backend = await this.ensureBackend();
    const orderbook = await this.ensureOrderbook();
    const given = this.#providedBackend !== undefined;
    const id = given ? this.#providedBackendId : backend.id;
    const expiresAt = given
      ? this.#providedBackendExpiresAt
      : backend.expiresAt;
    return {
      backend: {
        apiKey: backend.key,
        ...(id === undefined || id === '' ? {} : { id }),
        ...(expiresAt === undefined || expiresAt === '' ? {} : { expiresAt }),
      },
      orderbook: {
        apiKey: orderbook.apiKey,
        secret: orderbook.secret,
        passphrase: orderbook.passphrase,
      },
    };
  }

  /**
   * Replaces the backend key now: mint, switch, store, then revoke the old key with itself.
   * Concurrent calls share one rotation.
   * @throws XoError `credentials_provided` for a provided key, which the SDK never rotates.
   */
  async rotateBackend(): Promise<void> {
    this.#assertOpen();
    if (this.#providedBackend !== undefined) {
      throw new XoError(PROVIDED_NOT_ROTATED, { code: 'credentials_provided' });
    }
    if (this.#signer === undefined) {
      throw new AuthRequiredError(NO_BACKEND);
    }
    for (;;) {
      const flight = this.#backendFlight.current;
      if (flight === undefined) {
        break;
      }
      if (flight.kind === 'rotate') {
        await flight.promise;
        return;
      }
      await flight.promise.catch(() => undefined);
      this.#assertOpen();
    }
    await this.#backendFlight.start('rotate', async () => {
      await this.#load();
      const auth = await this.#getBackendAuth();
      const held = this.#backend;
      const live =
        held !== undefined && !isExpired(held.credential, this.#serverNow())
          ? held.credential
          : undefined;
      return this.#replaceBackend(auth, live);
    });
  }

  /**
   * Ends the session. Waits for a login in flight, then revokes the backend key only if
   * this session minted it and the store is not persistent or failed to save it; a
   * loaded or provided key is left alone. A failed revoke is reported through `warn`.
   * Idempotent; afterwards `headers()` and `ensure*()` throw XoError `session_closed`.
   */
  close(): Promise<void> {
    this.#closing ??= this.#shutdown();
    return this.#closing;
  }

  /**
   * Signs the wallet out, for good, where {@link close} only ends this session. It needs the
   * signer. From the moment it is called the session is closed (`session_closed`, nothing new
   * is signed in); a login in flight is waited for, so a key it mints is revoked too. Then:
   *
   * - every backend key the session knows is revoked with itself: the one it holds (minted or
   *   loaded), the one in the store for this wallet, and the one given in `credentials`, whose
   *   id is found in the key listing by its public prefix. A key that is already revoked,
   *   expired or unknown counts as revoked;
   * - every orderbook API key it knows (held, stored or given) is deleted with itself. That key
   *   is shared by every process trading for the same wallet, so all of them lose it;
   * - the wallet's record is deleted from the store, or, when a stored key could not be
   *   revoked, rewritten with that key only, so that a later sign-out can try again.
   *
   * Every step is tried even when one fails, and the first failure is thrown at the end.
   * Calls share one sign-out; {@link close} afterwards resolves when it is done, and never
   * rejects.
   *
   * @throws AuthRequiredError without a signer, and XoError `session_closed` after `close()`:
   *   nothing is revoked then.
   * @throws XoError `api_key_not_listed` when the key given in `credentials` is not in the
   *   account's key listing (its 100 newest keys), so its id is unknown and it stays active.
   * @throws RequestRejectedError, RateLimitError, TimeoutError, TransportError or
   *   UnexpectedResponseError when a revoke, the deletion or the listing fails, and the store's
   *   error when the record cannot be deleted.
   */
  signOut(): Promise<void> {
    if (this.#signingOut === undefined) {
      if (this.#closed) {
        return Promise.reject(
          new XoError('The session is closed', { code: 'session_closed' }),
        );
      }
      if (this.#signer === undefined) {
        return Promise.reject(new AuthRequiredError(NO_SIGNER));
      }
      // Synchronously closed by the first line of #signOut, before anything is awaited.
      this.#signingOut = this.#signOut();
      this.#closing ??= this.#signingOut.then(
        () => undefined,
        () => undefined,
      );
    }
    return this.#signingOut;
  }

  async headers(
    kind: Exclude<AuthKind, 'none'>,
    req: { method: string; path: string; body: string },
  ): Promise<Record<string, string>> {
    this.#assertOpen();
    if (kind === 'backend') {
      const { key } = await this.ensureBackend();
      return { Authorization: `Bearer ${key}` };
    }
    if (kind === 'orderbook') {
      const credential = await this.ensureOrderbook();
      return l2Headers(
        credential,
        this.#clock.nowSecString(),
        req.method,
        req.path,
        req.body,
      );
    }
    throw new UserInputError('kind must be "backend" or "orderbook"');
  }

  /**
   * After a 401: refreshes the credentials once and resolves true so the request is sent
   * again, or resolves false. False for provided credentials, without a signer, after
   * `close()`, and within 60 s of the last recovery of the same kind.
   */
  async onUnauthorized(
    kind: Exclude<AuthKind, 'none'>,
    ctx?: UnauthorizedContext,
  ): Promise<boolean> {
    if (this.#closed || this.#signer === undefined) {
      return false;
    }
    if (kind === 'backend' && this.#providedBackend === undefined) {
      const rejected = this.#backend?.credential;
      const sent = ctx?.headers.Authorization;
      if (
        rejected !== undefined &&
        sent !== undefined &&
        sent !== `Bearer ${rejected.key}`
      ) {
        // The request carried an older key (a rotation or recovery replaced it since).
        return true;
      }
      // Log in again, then revoke the rejected key with itself (it may still be active).
      return this.#recover('backend', this.#backendFlight, async () =>
        this.#replaceBackend(await this.#getBackendAuth(), rejected),
      );
    }
    if (kind === 'orderbook' && this.#providedOrderbook === undefined) {
      const sent = ctx?.headers.XO_API_KEY;
      if (
        this.#orderbook !== undefined &&
        sent !== undefined &&
        sent !== this.#orderbook.apiKey
      ) {
        return true;
      }
      return this.#recover('orderbook', this.#orderbookFlight, async () => {
        // The 401 may be a skewed clock. Derive returns the existing credentials.
        await this.#syncClock();
        const auth = await this.#getOrderbookAuth();
        return this.#installOrderbook(await auth.login());
      });
    }
    return false;
  }

  /** Non-secret state only: the wallet type, the trading address once known, which credentials are held. */
  toJSON(): Record<string, unknown> {
    const json: Record<string, unknown> = {};
    if (this.#signer !== undefined) {
      json.type = this.#resolved?.type ?? this.#wallet.type;
    }
    if (this.#resolved !== undefined) {
      json.address = this.#resolved.address;
    }
    json.signer = this.#signer !== undefined;
    json.credentials = {
      backend: presence(this.#providedBackend, this.#backend),
      orderbook: presence(this.#providedOrderbook, this.#orderbook),
    };
    json.closed = this.#closed;
    return json;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): Record<string, unknown> {
    return this.toJSON();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new XoError('The session is closed', { code: 'session_closed' });
    }
  }

  /**
   * Joins the flight under way, or refreshes once unless the cooldown of `kind` is running.
   * The cooldown starts when a recovery ends, whether it worked or not. A 401 within twice
   * the cooldown after a recovery doubles it (once per recovery), up to 1 h; an hour without
   * a 401 resets it.
   */
  async #recover<T>(
    kind: Kind,
    flights: SingleFlight<T>,
    refresh: () => Promise<T>,
  ): Promise<boolean> {
    const flight = flights.current;
    if (flight !== undefined) {
      // A login, rotation or recovery is under way: retry with what it gives.
      await flight.promise;
      return !this.#closed;
    }
    const now = this.#now();
    // As elsewhere, a clock stepped back counts as elapsed time (Math.abs).
    let state = this.#recovery[kind];
    if (
      state !== undefined &&
      Math.abs(now - state.last401) >= RECOVERY_RESET_MS
    ) {
      state = undefined;
    }
    if (state !== undefined) {
      state.last401 = now;
      const since = Math.abs(now - state.at);
      if (!state.doubled && since < 2 * state.cooldown) {
        // The last recovery did not hold: wait twice as long before the next one.
        state.cooldown = Math.min(2 * state.cooldown, MAX_RECOVERY_COOLDOWN_MS);
        state.doubled = true;
      }
      if (since < state.cooldown) {
        return false;
      }
    }
    const cooldown = state?.cooldown ?? RECOVERY_COOLDOWN_MS;
    await flights.start('recover', async () => {
      try {
        return await refresh();
      } finally {
        this.#recovery[kind] = {
          at: this.#now(),
          cooldown,
          doubled: false,
          last401: now,
        };
      }
    });
    return !this.#closed;
  }

  /**
   * The session's one best-effort clock sync, awaited before the first decision that
   * needs server time. Later calls return at once, whether it worked or not.
   */
  async #syncOnce(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#firstSync ??= this.#syncClock();
    await this.#firstSync;
  }

  /** The server's time in milliseconds, by the synced clock: what key expiry is judged by. */
  #serverNow(): number {
    return this.#clock.nowSec() * 1000;
  }

  /** Whether a held key is due for rotation, by its own lifetime's window. */
  #isDue(auth: BackendAuth, held: HeldKey): boolean {
    return auth.needsRotation(held.credential, {
      shortLived: held.shortLived === true,
    });
  }

  /** A key this session minted that is never replaced or rotated automatically. */
  #keepsAsIs(held: HeldKey): boolean {
    return (
      held.origin === 'minted' &&
      (held.pinned === true ||
        Math.abs(this.#now() - (held.mintedAt ?? 0)) < FRESH_KEY_MS)
    );
  }

  #emitWarn(message: string): void {
    try {
      this.#warn(message);
    } catch {
      // A broken warn callback must not break authentication.
    }
  }

  async #syncClock(): Promise<void> {
    try {
      await this.#clock.sync();
      // A sync that worked counts as the session's first one too.
      this.#firstSync ??= Promise.resolve();
    } catch {
      // Best effort: the login goes ahead with the offset known so far.
    }
  }

  async #storeKey(): Promise<string> {
    return credentialKey(this.#env.name, (await this.identity()).address);
  }

  /** Reads the store once per session. A failed read is not memoized and propagates. */
  #load(): Promise<void> {
    if (this.#loading === undefined) {
      const pending: Promise<void> = this.#readStore().catch(
        (error: unknown) => {
          if (this.#loading === pending) {
            this.#loading = undefined;
          }
          throw error;
        },
      );
      this.#loading = pending;
    }
    return this.#loading;
  }

  async #readStore(): Promise<void> {
    const key = await this.#storeKey();
    const stored = usable(
      await withStoreLock(this.#store, key, () => this.#store.get(key)),
    );
    if (
      stored.backend !== undefined &&
      this.#backend === undefined &&
      this.#providedBackend === undefined
    ) {
      this.#backend = {
        credential: stored.backend,
        origin: 'loaded',
        saved: true,
      };
    }
    if (
      stored.orderbook !== undefined &&
      this.#orderbook === undefined &&
      this.#providedOrderbook === undefined
    ) {
      this.#orderbook = stored.orderbook;
    }
    if (stored.mintPause !== undefined && this.#mintPauseMs === undefined) {
      this.#restoreMintPause(stored.mintPause);
    }
  }

  /**
   * A key request of an earlier session (most likely an earlier run of this process) lost its
   * answer: honour what is left of its pause, and ask for a 1-day key until a mint succeeds.
   */
  #restoreMintPause(note: { atMs: number; pauseMs: number }): void {
    const ms = Math.min(
      Math.max(note.pauseMs, LOGIN_PAUSE_MS),
      MAX_LOGIN_PAUSE_MS,
    );
    this.#mintPauseMs = ms;
    // As for the in-process pause, a clock stepped back counts as elapsed time.
    const left = ms - Math.abs(this.#now() - note.atMs);
    if (left <= 0 || this.#loginPause !== undefined) {
      return;
    }
    const sec = Math.ceil(left / 1000);
    this.#loginPause = {
      error: storedPauseError(sec),
      at: note.atMs,
      ms,
      warning: storedPauseWarning(sec),
    };
  }

  /**
   * Saves the login pause of a `MintedKeyError`, so a restarted process honours it. A store
   * that cannot save it costs nothing else: one warn, and the pause holds in this process.
   */
  async #saveMintPause(mintPause: {
    atMs: number;
    pauseMs: number;
  }): Promise<void> {
    try {
      await this.#write((current) => ({ ...current, mintPause }));
    } catch (error) {
      if (!this.#warnedMintPause) {
        this.#warnedMintPause = true;
        this.#emitWarn(
          `@xomarket/client: could not save the login pause to the credential store (${reasonOf(error)}); this process still honours it, but a restarted one will not know about it.`,
        );
      }
    }
  }

  /** Read, merge and write the session's record, serialized with every other access to it. */
  async #write(
    change: (current: StoredCredentials) => StoredCredentials,
  ): Promise<void> {
    const key = await this.#storeKey();
    await withStoreLock(this.#store, key, async () => {
      const current = usable(await this.#store.get(key));
      await this.#store.set(key, change(current));
    });
  }

  async #getBackendAuth(): Promise<BackendAuth> {
    const identity = await this.identity();
    this.#backendAuth ??= new BackendAuth(
      this.#transport,
      this.#signer as InternalSigner,
      identity,
      {
        env: this.#env,
        persistent: this.#persistent,
        label: this.#label,
        now: () => new Date(this.#serverNow()),
        strictResponses: this.#strict,
        timeoutMs: this.#authTimeoutMs,
      },
    );
    return this.#backendAuth;
  }

  async #getOrderbookAuth(): Promise<OrderbookAuth> {
    const identity = await this.identity();
    this.#orderbookAuth ??= new OrderbookAuth(
      this.#transport,
      this.#signer as InternalSigner,
      identity,
      this.#env,
      this.#clock,
      {
        isDeployed: this.#isDeployed,
        strictResponses: this.#strict,
        timeoutMs: this.#authTimeoutMs,
      },
    );
    return this.#orderbookAuth;
  }

  async #ensureBackendTask(): Promise<BackendCredential> {
    await this.#load();
    const auth = await this.#getBackendAuth();
    const held = this.#backend;
    if (held !== undefined && this.#keepsAsIs(held)) {
      return held.credential;
    }
    if (
      held === undefined ||
      isExpired(held.credential, this.#serverNow()) ||
      this.#isDue(auth, held)
    ) {
      // About to drop, rotate or mint: judge by server time. A key that only looked
      // expired because this machine's clock runs ahead is kept after the sync.
      await this.#syncOnce();
    }
    if (held === undefined || isExpired(held.credential, this.#serverNow())) {
      // An expired key is dropped without a revoke: it no longer counts toward the 10.
      return this.#replaceBackend(auth, undefined);
    }
    if (!this.#isDue(auth, held)) {
      return held.credential;
    }
    const failedAt = this.#rotationFailedAt;
    if (
      failedAt !== undefined &&
      Math.abs(this.#now() - failedAt) < LOGIN_PAUSE_MS
    ) {
      return held.credential;
    }
    try {
      return await this.#replaceBackend(auth, held.credential);
    } catch (error) {
      if (this.#backend !== held) {
        // A new key was minted and is in use (the store write failed): report that.
        throw error;
      }
      // No new key, and the old one is still valid: keep it rather than fail requests.
      this.#rotationFailedAt = this.#now();
      if (!pausesLogin(error)) {
        this.#emitWarn(
          `@xomarket/client: could not rotate the backend API key (id ${held.credential.id}, ${reasonOf(error)}); the session keeps using it and tries again in ${LOGIN_PAUSE_MS / 1000} s.`,
        );
      }
      return held.credential;
    }
  }

  /** `auth.login()`, unless a recent login failure paused logins. */
  async #mint(
    auth: BackendAuth,
  ): Promise<{ credential: BackendCredential; shortLived: boolean }> {
    // close() may have started while this flight was loading: mint nothing then.
    this.#assertOpen();
    const pause = this.#loginPause;
    if (pause !== undefined) {
      // As for the recovery cooldown, a clock stepped back counts as elapsed time.
      if (Math.abs(this.#now() - pause.at) < pause.ms) {
        if (pause.warning !== undefined) {
          this.#emitWarn(pause.warning);
          pause.warning = undefined;
        }
        throw pause.error;
      }
      this.#loginPause = undefined;
    }
    // The new key's name and its expiry check use server time.
    await this.#syncOnce();
    this.#assertOpen();
    // Until a mint succeeds after a lost answer, every key asked for lasts 1 day.
    const shortLived = this.#mintPauseMs !== undefined;
    try {
      const credential = await auth.login({ shortLived });
      this.#mintPauseMs = undefined;
      return { credential, shortLived };
    } catch (error) {
      if (pausesLogin(error)) {
        let ms = LOGIN_PAUSE_MS;
        if (error instanceof MintedKeyError) {
          ms =
            this.#mintPauseMs === undefined
              ? LOGIN_PAUSE_MS
              : Math.min(2 * this.#mintPauseMs, MAX_LOGIN_PAUSE_MS);
          this.#mintPauseMs = ms;
        }
        const at = this.#now();
        this.#loginPause = { error, at, ms };
        this.#emitWarn(loginPauseWarning(error, ms / 1000));
        if (error instanceof MintedKeyError) {
          await this.#saveMintPause({ atMs: at, pauseMs: ms });
        }
      }
      throw error;
    }
  }

  /**
   * Mints a key, switches to it, stores it, then revokes `old` with `old` itself. The new
   * key is in use even if the store write fails; that error is thrown after the revoke.
   */
  async #replaceBackend(
    auth: BackendAuth,
    old: BackendCredential | undefined,
  ): Promise<BackendCredential> {
    const { credential, shortLived } = await this.#mint(auth);
    const held: HeldKey = {
      credential,
      origin: 'minted',
      mintedAt: this.#now(),
      saved: false,
      ...(shortLived ? { shortLived } : {}),
    };
    if (isExpired(credential, this.#serverNow()) || this.#isDue(auth, held)) {
      // Rotating it would only mint another key that looks the same.
      held.pinned = true;
      if (!this.#warnedPinned) {
        this.#warnedPinned = true;
        this.#emitWarn(PINNED_WARNING);
      }
    }
    this.#backend = held;
    if (!this.#persistent && !this.#warnedShortLived) {
      this.#warnedShortLived = true;
      this.#emitWarn(SHORT_LIVED_WARNING);
    }
    let failure: { error: unknown } | undefined;
    try {
      await this.#write((current) => withKey(current, credential));
      held.saved = true;
    } catch (error) {
      // Kept unsaved: ensureBackend retries the write and close() revokes the key.
      failure = { error };
    }
    if (old !== undefined && old.id !== credential.id) {
      try {
        await auth.revoke(old);
      } catch (error) {
        // Never retried: the old key expires on its own.
        this.#emitWarn(
          `@xomarket/client: could not revoke the previous backend API key (id ${old.id}, ${reasonOf(error)}); it stays active until it expires.`,
        );
      }
    }
    if (failure !== undefined) {
      throw failure.error;
    }
    return credential;
  }

  async #ensureOrderbookTask(): Promise<OrderbookCredential> {
    await this.#load();
    const held = this.#orderbook;
    if (held !== undefined) {
      return held;
    }
    const auth = await this.#getOrderbookAuth();
    await this.#syncOnce();
    let credential: OrderbookCredential;
    try {
      credential = await auth.login();
    } catch (error) {
      // An L1 401 never reaches onUnauthorized (explicit L1 auth bypasses the provider).
      // A stale timestamp (a skewed clock, or a wallet approval slower than 120 s) is
      // fixed by a sync and a fresh signature. Once.
      if (!isRejected(error, 401)) {
        throw error;
      }
      await this.#syncClock();
      credential = await auth.login();
    }
    return this.#installOrderbook(credential);
  }

  async #installOrderbook(
    credential: OrderbookCredential,
  ): Promise<OrderbookCredential> {
    this.#orderbook = credential;
    await this.#write((current) => ({ ...current, orderbook: credential }));
    return credential;
  }

  async #shutdown(): Promise<void> {
    this.#closed = true;
    // A login in flight may be minting a key: let it finish so that key is revoked too.
    await this.#backendFlight.current?.promise.catch(() => undefined);
    await this.#orderbookFlight.current?.promise.catch(() => undefined);
    // A retried save may be about to mark the key saved: read `saved` after it.
    await this.#saving;
    const held = this.#backend;
    const auth = this.#backendAuth;
    this.#backend = undefined;
    this.#orderbook = undefined;
    // A persistent store keeps the key for the next run, unless it failed to save it.
    if (
      held === undefined ||
      held.origin !== 'minted' ||
      (this.#persistent && held.saved) ||
      auth === undefined
    ) {
      return;
    }
    try {
      await auth.revoke(held.credential);
    } catch (error) {
      this.#emitWarn(
        `@xomarket/client: close() could not revoke this session's backend API key (id ${held.credential.id}, ${reasonOf(error)}); it stays active until it expires.`,
      );
    }
  }

  async #signOut(): Promise<void> {
    this.#closed = true;
    // A login in flight may be minting a key or deriving credentials: they are signed out too.
    await this.#backendFlight.current?.promise.catch(() => undefined);
    await this.#orderbookFlight.current?.promise.catch(() => undefined);
    await this.#saving;
    const held = this.#backend?.credential;
    const heldOrderbook = this.#orderbook;
    this.#backend = undefined;
    this.#orderbook = undefined;
    const failures: unknown[] = [];
    const attempt = async <T>(
      step: () => Promise<T>,
    ): Promise<T | undefined> => {
      try {
        return await step();
      } catch (error) {
        failures.push(error);
        return undefined;
      }
    };

    // The wallet's record, read once: it may hold keys this session never loaded (a session
    // given its credentials does not read the store).
    const storeKey = await attempt(() => this.#storeKey());
    const stored =
      storeKey === undefined
        ? undefined
        : await attempt(async () =>
            usable(
              await withStoreLock(this.#store, storeKey, () =>
                this.#store.get(storeKey),
              ),
            ),
          );
    const auth = await attempt(() => this.#getBackendAuth());

    // Backend keys, each once: the held one, the stored one, then the one given. A key whose
    // revoke failed stays in the record, so that a later sign-out can try again.
    const live = new Set<string>();
    const revoked = new Set<string>();
    for (const credential of [held, stored?.backend]) {
      if (credential === undefined || revoked.has(credential.key)) {
        continue;
      }
      revoked.add(credential.key);
      const ok =
        auth !== undefined &&
        (await attempt(async () => {
          await revokeKey(auth, credential);
          return true;
        })) === true;
      if (!ok) {
        live.add(credential.key);
      }
    }
    const given = this.#providedBackend;
    if (auth !== undefined && given !== undefined && !revoked.has(given)) {
      await attempt(() => revokeGivenKey(auth, given, this.#providedBackendId));
    }

    // Orderbook keys, each once, deleted with themselves.
    const deleted = new Set<string>();
    for (const credential of [
      heldOrderbook,
      stored?.orderbook,
      this.#providedOrderbook,
    ]) {
      if (credential === undefined || deleted.has(credential.apiKey)) {
        continue;
      }
      deleted.add(credential.apiKey);
      const ok = await attempt(async () => {
        await deleteOrderbookKey(
          this.#transport,
          credential,
          this.#clock,
          this.#authTimeoutMs,
        );
        return true;
      });
      if (ok !== true) {
        live.add(credential.apiKey);
      }
    }

    // The record goes, unless it still names a key that could not be revoked.
    if (storeKey !== undefined && stored !== undefined) {
      const keep: StoredCredentials = {};
      if (stored.backend !== undefined && live.has(stored.backend.key)) {
        keep.backend = stored.backend;
      }
      if (stored.orderbook !== undefined && live.has(stored.orderbook.apiKey)) {
        keep.orderbook = stored.orderbook;
      }
      await attempt(() =>
        withStoreLock(this.#store, storeKey, async () => {
          if (keep.backend === undefined && keep.orderbook === undefined) {
            await this.#store.delete(storeKey);
          } else {
            await this.#store.set(storeKey, keep);
          }
        }),
      );
    }
    if (failures.length > 0) {
      throw failures[0];
    }
  }

  /**
   * Best effort: writes a minted key whose store write failed. One write at a time,
   * at most once per 60 s, and only while that key is still the current one.
   */
  async #retrySave(held: HeldKey): Promise<void> {
    if (this.#saving === undefined) {
      const last = this.#saveRetriedAt;
      if (last !== undefined && Math.abs(this.#now() - last) < SAVE_RETRY_MS) {
        return;
      }
      this.#saveRetriedAt = this.#now();
    }
    this.#saving ??= this.#write((current) =>
      this.#backend === held ? withKey(current, held.credential) : current,
    )
      .then(
        () => {
          if (this.#backend === held) {
            held.saved = true;
          }
        },
        () => undefined,
      )
      .finally(() => {
        this.#saving = undefined;
      });
    await this.#saving;
  }
}

/** Revokes `credential` with itself. A key the backend does not find (404) is gone already. */
async function revokeKey(
  auth: BackendAuth,
  credential: BackendCredential,
): Promise<void> {
  try {
    await auth.revoke(credential);
  } catch (error) {
    if (!isRejected(error, 404)) {
      throw error;
    }
  }
}

/** The backend's refusal of an id that is not the calling key's own. */
function isOtherKeyRefusal(error: unknown): boolean {
  return (
    isRejected(error, 403) && error.code === 'api_key_can_only_revoke_itself'
  );
}

/** The route that reads the account of the key it is sent with. */
const ME_PATH = '/api/users/me';

/** What the ownership check reads of the account: its wallet, the address that holds the funds. */
const AccountWalletSchema = defineSchema<{ walletPublicKey: string }>((obj) =>
  obj({ walletPublicKey: z.string() }),
);

/** A given credential that is not the wallet's. It names the credential, never its value. */
function notOwned(which: 'backend' | 'orderbook'): UserInputError {
  return new UserInputError(
    which === 'backend'
      ? "credentials.backend is an API key of another account: the account it reads is not the wallet's. Pass this wallet's own key, or leave it out to sign in for one"
      : "credentials.orderbook are not this wallet's own order book credentials (the ones signing in derives, and exportCredentials() gives). Pass those, or leave them out to sign in for them",
    { code: 'credentials_not_owned' },
  );
}

const KEY_NOT_LISTED =
  "The API key given in `credentials` was not revoked: it is not in the account's key listing (its 100 newest keys), so its id is unknown. It stays active until it expires; ask XO to revoke it (the XO website has no key-management page yet)";

/**
 * Revokes a key given in `credentials.backend`. With its `id`, the key revokes itself by that
 * id. Without it, or when the backend refuses that id as another key's (a key may revoke only
 * itself: a 403), the key lists the account's keys, the rows with its public prefix (the part
 * after `xo_sk_<kind>_`) are its candidates, and it revokes itself by the id of the one the
 * backend accepts. A key the backend no longer accepts (`401 invalid_credentials`) or lists as
 * revoked is gone already.
 */
async function revokeGivenKey(
  auth: BackendAuth,
  key: string,
  id: string | undefined,
): Promise<void> {
  const given: BackendCredential = {
    id: '',
    key,
    prefix: '',
    scopes: [],
    expiresAt: '',
  };
  if (id !== undefined) {
    try {
      await revokeKey(auth, { ...given, id });
      return;
    } catch (error) {
      if (!isOtherKeyRefusal(error)) {
        throw error;
      }
    }
  }
  let rows: Awaited<ReturnType<BackendAuth['list']>>;
  try {
    rows = await auth.list(given);
  } catch (error) {
    if (isRejected(error, 401) && error.code === 'invalid_credentials') {
      return;
    }
    throw error;
  }
  const prefix = key.split('_')[3];
  const candidates =
    prefix === undefined || prefix === ''
      ? []
      : rows.filter((row) => row.prefix === prefix);
  for (const row of candidates) {
    if (row.revokedAt !== null) {
      continue;
    }
    try {
      await revokeKey(auth, { ...given, id: row.id });
      return;
    } catch (error) {
      if (!isOtherKeyRefusal(error)) {
        throw error;
      }
    }
  }
  // Not one of the active rows: the key is the revoked one, if the listing has one.
  if (candidates.some((row) => row.revokedAt !== null)) {
    return;
  }
  throw new XoError(KEY_NOT_LISTED, {
    code: 'api_key_not_listed',
    service: 'backend',
  });
}

/** The record with `credential` as its backend key. A stored key ends a login pause. */
function withKey(
  current: StoredCredentials,
  credential: BackendCredential,
): StoredCredentials {
  const { mintPause: _ended, ...rest } = current;
  return { ...rest, backend: credential };
}

/** The error a login paused by a saved note rethrows. It names no key and no secret. */
function storedPauseError(sec: number): MintedKeyError {
  const issue: ResponseIssue = {
    path: '(store)',
    code: 'login_paused',
    message:
      'an earlier key request may have created a key whose answer was lost',
  };
  return new MintedKeyError(
    `An earlier backend login (its pause is saved in the credential store) sent a key request whose answer was lost or could not be used, so it may have created an API key; no new login is tried for ${sec} s. A key it created counts toward the 10 active keys until it expires; the next key the session asks for lasts 1 day`,
    { service: 'backend', issues: [issue], mayHaveMinted: true },
  );
}

function storedPauseWarning(sec: number): string {
  return `@xomarket/client: an earlier backend login may have created an API key whose answer was lost (the credential store says so), so the session will not log in again for ${sec} s, and its next key lasts 1 day. The XO website has no key-management page yet: ask XO to revoke unknown xo-sdk keys, or let them expire.`;
}
