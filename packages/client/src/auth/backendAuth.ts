import type { Address, Hex } from 'viem';
import { createSiweMessage, parseSiweMessage } from 'viem/siwe';
import { z } from 'zod';
import { isSameAddress, normalizeAddress } from '../core/address';
import { isBackendKey } from '../core/apiKey';
import type { EnvironmentConfig } from '../core/env';
import {
  isRejected,
  RequestRejectedError,
  UnexpectedResponseError,
  UserInputError,
  XoError,
  type XoErrorOptions,
} from '../core/errors';
import {
  defineSchema,
  parseResponse,
  type ResponseIssue,
} from '../core/schema';
import type { Transport } from '../core/transport';
import { assertChainId } from '../signing/internal';
import type { TradingIdentity } from '../wallet/identity';
import { errorName, isObject, normalizeSignature } from '../wallet/internal';
import type { InternalSigner } from '../wallet/signer';
import type { BackendCredential } from './store';

/** What a backend key may do. */
export type BackendScope = 'account:read' | 'account:write';

export interface BackendAuthOptions {
  /**
   * The environment, which says what the sign-in message must look like: its `chainId`,
   * `siweDomain` and `siweUri`. The login signs only a canonical EIP-4361 message for
   * exactly these (see {@link BackendAuth.login}), so a server cannot get a signature over
   * anything else. Pass the client's resolved environment; a plain
   * `{ chainId, siweDomain, siweUri }` works too.
   */
  env: Pick<EnvironmentConfig, 'chainId' | 'siweDomain' | 'siweUri'>;
  /** Part of the key's name, `xo-sdk:<label>:<yyyymmdd>`. 1 to 64 of `A-Za-z0-9._-`. Defaults to `'default'`. */
  label?: string;
  /**
   * `true` when keys outlive the process (a persistent store): 90-day keys, rotated when
   * fewer than 7 days remain. `false`: 1-day keys, rotated when fewer than 2 hours remain.
   * One login can still ask for a 1-day key (see {@link KeyLifetimeOptions}).
   */
  persistent: boolean;
  /** Defaults to both scopes. A non-empty list without duplicates. */
  scopes?: BackendScope[];
  /** The clock for the key name and for `needsRotation`. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Reject response fields and enum values the schemas do not know (for contract tests). */
  strictResponses?: boolean;
  /**
   * The per-attempt timeout of every request this class sends, in milliseconds. Defaults to
   * the transport's.
   */
  timeoutMs?: number;
}

/** The lifetime of one key, for `login()` and `needsRotation()`. */
export interface KeyLifetimeOptions {
  /**
   * A 1-day key, rotated when fewer than 2 hours remain, whatever `persistent` says. A
   * session asks for one after a key request whose answer was lost, so that a run of lost
   * answers holds the account's 10 key slots for a day at most. Defaults to `false`.
   */
  shortLived?: boolean;
}

/** One row of `list()`: the metadata of a key, never the key itself. */
export interface BackendKeyInfo {
  id: string;
  name: string;
  prefix: string;
  expiresAt: string;
  /** `null` while the key is not revoked. */
  revokedAt: string | null;
}

const NONCE_PATH = '/api/auth/api-keys/nonce';
/**
 * The one route that creates a key. It replaced
 * `POST /api/auth/api-keys/wallet`, which answers 404 now.
 */
const CREATE_KEY_PATH = '/api/auth/api-keys';
const KEYS_PATH = '/api/auth/api-keys';

const SCOPES = ['account:read', 'account:write'] as const;
const DEFAULT_LABEL = 'default';
const LABEL_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** The backend allows 2000 characters in the signed message. */
const MAX_MESSAGE_LENGTH = 2000;
const PERSISTENT_DAYS = 90;
const SHORT_LIVED_DAYS = 1;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const PERSISTENT_ROTATE_BEFORE_MS = 7 * DAY_MS;
const SHORT_LIVED_ROTATE_BEFORE_MS = 2 * HOUR_MS;
/** A key id as the backend takes it: a positive 32-bit integer in plain decimal. */
const KEY_ID_PATTERN = /^[1-9]\d{0,9}$/;
const MAX_KEY_ID = 2_147_483_647;
/** The longest per-attempt timeout a sign-in or sign-out request takes: 10 minutes. */
const MAX_AUTH_TIMEOUT_MS = 600_000;
/** What the backend sends for a date. Anything else is not a time the SDK can trust. */
const ISO_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
/** The statement of every sign-in message, as the backend expects it. */
const SIGN_IN_STATEMENT = 'Create an XO API key for this wallet.';

// Only the fields the SDK reads are required. The others are listed so that a strict parse
// knows them, but may be missing: the key route has already minted the key when its
// answer is checked, and the key cannot be fetched again, so a field the SDK never uses
// must not be able to throw it away. The nonce and list schemas follow the same rule.

interface WalletKeyNonce {
  address: string;
  chainId: number;
  message: string;
  domain?: string;
  uri?: string;
  version?: string;
  nonce?: string;
  issuedAt?: string;
  expirationTime?: string;
  statement?: string;
}

const WalletKeyNonceSchema = defineSchema<WalletKeyNonce>((obj) =>
  obj({
    address: z.string(),
    chainId: z.number(),
    message: z.string(),
    domain: z.string().optional(),
    uri: z.string().optional(),
    version: z.string().optional(),
    nonce: z.string().optional(),
    issuedAt: z.string().optional(),
    expirationTime: z.string().optional(),
    statement: z.string().optional(),
  }),
);

interface CreatedWalletKey {
  id: number;
  prefix: string;
  scopes: string[];
  expiresAt: string;
  /** The secret. Shown once. */
  key: string;
  name?: string;
  lastUsedAt?: string | null;
  lastUsedIp?: string | null;
  revokedAt?: string | null;
  createdVia?: string;
  createdAt?: string;
}

/** The five fields of the 201 that `login()` reads. */
interface CreatedKeyCore {
  id: number;
  prefix: string;
  scopes: string[];
  expiresAt: string;
  key: string;
}

// A lenient login checks only these five fields: the key is already minted when the answer
// is read, so a field it never uses must not be able to discard it. A strict login checks
// the full shape below.
const CreatedKeyCoreSchema = defineSchema<CreatedKeyCore>((obj, enumOf) =>
  obj({
    id: z.number(),
    prefix: z.string(),
    scopes: z.array(enumOf(SCOPES)),
    expiresAt: z.string(),
    key: z.string(),
  }),
);

const CreatedWalletKeySchema = defineSchema<CreatedWalletKey>((obj, enumOf) =>
  obj({
    id: z.number(),
    prefix: z.string(),
    scopes: z.array(enumOf(SCOPES)),
    expiresAt: z.string(),
    key: z.string(),
    name: z.string().optional(),
    lastUsedAt: z.string().nullable().optional(),
    lastUsedIp: z.string().nullable().optional(),
    revokedAt: z.string().nullable().optional(),
    createdVia: enumOf(['privy', 'wallet_signature']).optional(),
    createdAt: z.string().optional(),
  }),
);

interface ListedKey {
  id: number;
  name: string;
  prefix: string;
  expiresAt: string;
  revokedAt: string | null;
  scopes?: string[];
  lastUsedAt?: string | null;
  lastUsedIp?: string | null;
  createdVia?: string;
  createdAt?: string;
}

const ListedKeysSchema = defineSchema<ListedKey[]>((obj, enumOf) =>
  z.array(
    obj({
      id: z.number(),
      name: z.string(),
      prefix: z.string(),
      expiresAt: z.string(),
      revokedAt: z.string().nullable(),
      scopes: z.array(enumOf(SCOPES)).optional(),
      lastUsedAt: z.string().nullable().optional(),
      lastUsedIp: z.string().nullable().optional(),
      createdVia: enumOf(['privy', 'wallet_signature']).optional(),
      createdAt: z.string().optional(),
    }),
  ),
);

// The limit is a RequestRejectedError (409) whose message says what to do.
// A web session (Privy, on the website) can revoke any of the account's keys with
// DELETE /api/auth/api-keys/:id; an API key can only revoke itself. The website has no
// key-management page yet, so the way out today is to ask XO or
// let keys expire. POST /api/auth/api-keys creates keys, so it is not named here.
const KEY_LIMIT_MESSAGE =
  'The account already has 10 active API keys, so the backend refused to create another (api_key_limit_reached). ' +
  'Expired and revoked keys do not count toward the 10, so the limit clears as keys expire. ' +
  'Use a persistent credential store (fileStore from @xomarket/client/node) so one key is reused across restarts instead of a new key every run. ' +
  'The SDK never revokes other keys: an API key can only revoke itself. ' +
  "The backend lets a signed-in web session (Privy) revoke any of the account's keys (DELETE /api/auth/api-keys/:id), " +
  'but the XO website has no key-management page yet, so in practice ask XO to free a slot, or let keys expire.';

/**
 * A response the SDK cannot use. The message names the field and the rule, never the
 * received value, so nothing the server sent (and no secret) can end up in it.
 */
function unexpected(
  path: string,
  field: string,
  rule: string,
): UnexpectedResponseError {
  const issue: ResponseIssue = {
    path: field,
    code: 'invalid_value',
    message: rule,
  };
  return new UnexpectedResponseError(
    `Unexpected backend response for ${path}: ${field}: ${rule}`,
    { service: 'backend', issues: [issue] },
  );
}

function parseExpiry(value: unknown): number {
  if (typeof value !== 'string' || !ISO_TIME_PATTERN.test(value)) {
    return Number.NaN;
  }
  return Date.parse(value);
}

function checkScopes(scopes: unknown): BackendScope[] {
  const known: readonly string[] = SCOPES;
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    new Set(scopes).size !== scopes.length ||
    !scopes.every((scope) => typeof scope === 'string' && known.includes(scope))
  ) {
    throw new UserInputError(
      `scopes must be a non-empty list of unique scopes from: ${SCOPES.join(', ')}`,
    );
  }
  return [...scopes] as BackendScope[];
}

/**
 * A per-attempt timeout of the sign-in and sign-out requests: `undefined` (the transport's), or a
 * whole number of milliseconds from 1 to 600000.
 */
export function checkAuthTimeout(value: unknown): number | undefined {
  if (
    value !== undefined &&
    (typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > MAX_AUTH_TIMEOUT_MS)
  ) {
    throw new UserInputError(
      `timeoutMs must be a whole number of milliseconds from 1 to ${MAX_AUTH_TIMEOUT_MS}`,
    );
  }
  return value as number | undefined;
}

/** The key-name label, or `'default'`. Exported for the Session's up-front option check. */
export function checkLabel(label: unknown): string {
  if (label === undefined) {
    return DEFAULT_LABEL;
  }
  if (typeof label !== 'string' || !LABEL_PATTERN.test(label)) {
    throw new UserInputError(
      'label must be 1 to 64 characters from A-Z a-z 0-9 . _ -',
    );
  }
  return label;
}

/** The key out of a credential, as a string. The transport checks that it is a usable key. */
function keyOf(credential: unknown): string {
  if (!isObject(credential) || typeof credential.key !== 'string') {
    throw new UserInputError('credential must be a BackendCredential');
  }
  return credential.key;
}

/** A `Date` that holds a real time. */
function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/** The id of the key the backend says it created, when the answer has one. It is not a secret. */
function mintedKeyId(raw: unknown): number | undefined {
  const id = isObject(raw) ? raw.id : undefined;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0
    ? id
    : undefined;
}

/**
 * A login whose key request may have created a key that the SDK does not hold. Its `name`
 * stays `UnexpectedResponseError`.
 *
 * - `mayHaveMinted: false`: the backend answered 201, so the key exists and counts toward
 *   the 10 active keys, but the answer could not be used. `keyId` is the key's id when the
 *   answer carried one.
 * - `mayHaveMinted: true`: the request failed without saying whether a key was made
 *   (no response, a timeout, a 5xx, a 2xx body that cannot be read). `keyId` is undefined
 *   and `cause` is the original error.
 *
 * `keyId` is not a secret: it names the key in the account's key listing
 * (`listApiKeys()`). A key can revoke only itself, and the XO website has no
 * key-management page yet, so to revoke that key write to gm@xo.market, or let it expire. The
 * key itself is never kept. A session does not log in again for a while after this error, so a
 * broken or lost answer cannot mint a key on every call.
 */
export class MintedKeyError extends UnexpectedResponseError {
  readonly keyId?: string;
  readonly mayHaveMinted: boolean;

  constructor(
    message: string,
    opts: XoErrorOptions & {
      issues: unknown;
      keyId?: string;
      mayHaveMinted?: boolean;
    },
  ) {
    super(message, opts);
    this.keyId = opts.keyId;
    this.mayHaveMinted = opts.mayHaveMinted === true;
  }

  protected override extraJson(): Record<string, unknown> {
    return {
      ...super.extraJson(),
      keyId: this.keyId,
      mayHaveMinted: this.mayHaveMinted,
    };
  }
}

/**
 * Statuses of the key request that say the backend refused it, so no key was created. A 413
 * (a body over 16 kB) is answered before the guards, validation and the throttler.
 */
const REFUSED_STATUSES: ReadonlySet<number> = new Set([
  400, 401, 403, 409, 413, 429,
]);

/**
 * Statuses that say the backend has no key-creation route at the path (or none for POST), so
 * no key was created either: the SDK is out of step with the backend.
 */
const NO_ROUTE_STATUSES: ReadonlySet<number> = new Set([404, 405]);

/**
 * A failure of the key request as it should reach the caller. A refusal (one of
 * {@link REFUSED_STATUSES}) or a `UserInputError` raised before anything was sent passes
 * through. A 404 or 405 ({@link NO_ROUTE_STATUSES}) is an `XoError` with the code
 * `key_route_not_found`. Anything else may have created a key: a {@link MintedKeyError} with
 * `mayHaveMinted: true`. Decided on class and status only.
 */
function walletFailure(error: unknown, path: string): unknown {
  if (
    error instanceof XoError &&
    error.status !== undefined &&
    REFUSED_STATUSES.has(error.status)
  ) {
    return error;
  }
  if (
    error instanceof XoError &&
    error.status !== undefined &&
    NO_ROUTE_STATUSES.has(error.status)
  ) {
    return new XoError(
      `${path} answered ${error.status}: the backend has no key-creation route at that path, so no API key was created. This version of @xomarket/client may be out of date with the backend: update it`,
      {
        code: 'key_route_not_found',
        service: 'backend',
        status: error.status,
        requestId: error.requestId,
        cause: error,
      },
    );
  }
  if (error instanceof UserInputError) {
    return error;
  }
  const reason = error instanceof XoError ? error.code : errorName(error);
  const issue: ResponseIssue = {
    path: '(response)',
    code: 'outcome_unknown',
    message: 'the key request failed without saying whether a key was created',
  };
  return new MintedKeyError(
    `${path} failed (${reason}) without saying whether the backend created an API key. A key it created counts toward the 10 active keys until it expires. The XO website has no key-management page yet: ask XO to revoke unknown xo-sdk keys, or let them expire`,
    {
      service: 'backend',
      status: error instanceof XoError ? error.status : undefined,
      requestId: error instanceof XoError ? error.requestId : undefined,
      issues: [issue],
      mayHaveMinted: true,
      cause: error,
    },
  );
}

/**
 * The error of a failed read of the 201 as a {@link MintedKeyError}. When the answer had an
 * id, the message also names it (never the key).
 */
function asMintedKeyError(error: unknown, id: number | undefined): unknown {
  if (!(error instanceof UnexpectedResponseError)) {
    return error;
  }
  if (id === undefined) {
    return new MintedKeyError(error.message, {
      service: error.service,
      issues: error.issues,
    });
  }
  return new MintedKeyError(
    `${error.message}. The backend created API key id ${id} before this failed; it counts toward the 10 active keys until it expires. The XO website has no key-management page yet: ask XO to revoke it, or let it expire`,
    { service: error.service, issues: error.issues, keyId: String(id) },
  );
}

/** What a sign-in message must say to be signed. */
interface ExpectedSignIn {
  address: Address;
  chainId: number;
  domain: string;
  uri: string;
}

/**
 * Whether `message` is the canonical XO sign-in message for `expected`, or the reason why
 * not. The wallet signs `message` as plain text, so it is only signed when it is exactly
 * what the backend's `createSiweMessage` writes for this address, chain, domain and URI,
 * with the backend's fixed statement. Anything else (a 32-byte hash, a message for another
 * site, trailing text) is refused, so the server cannot ask for a signature over data of
 * its choosing. The reasons name the check; they never quote the message.
 */
function signInMessageProblem(
  message: string,
  expected: ExpectedSignIn,
): string | undefined {
  const parsed = parseSiweMessage(message);
  const { address, chainId, domain, uri, version, nonce } = parsed;
  const { issuedAt, expirationTime, statement } = parsed;
  if (
    address === undefined ||
    domain === undefined ||
    uri === undefined ||
    version === undefined ||
    chainId === undefined ||
    nonce === undefined ||
    !isValidDate(issuedAt) ||
    !isValidDate(expirationTime)
  ) {
    return 'it is not a complete EIP-4361 message with a nonce, an issued time and an expiry';
  }
  if (
    parsed.notBefore !== undefined ||
    parsed.requestId !== undefined ||
    parsed.resources !== undefined ||
    parsed.scheme !== undefined
  ) {
    return 'it has a scheme, not-before time, request id or resources, which the backend never sets';
  }
  if (!isSameAddress(address, expected.address)) {
    return 'it is for another address than the trading address';
  }
  if (chainId !== expected.chainId) {
    return `it is for another chain than chain ${expected.chainId}`;
  }
  if (version !== '1') {
    return 'it is not EIP-4361 version 1';
  }
  if (domain !== expected.domain) {
    return `it is for another domain than ${expected.domain}`;
  }
  if (uri !== expected.uri) {
    return `it is for another URI than ${expected.uri}`;
  }
  if (statement !== SIGN_IN_STATEMENT) {
    return 'it does not carry the XO API key statement';
  }
  let canonical: string;
  try {
    canonical = createSiweMessage({
      address,
      chainId,
      domain,
      uri,
      version: '1',
      nonce,
      issuedAt,
      expirationTime,
      statement,
    });
  } catch {
    return 'it is not a well-formed EIP-4361 message';
  }
  if (canonical !== message) {
    return 'it is not in the canonical EIP-4361 form (extra or changed text)';
  }
  return undefined;
}

/**
 * Signs in to the XO backend with a wallet and manages the API keys that come out of it.
 *
 * The backend issues a single-use EIP-4361 (SIWE) message for the trading address; the
 * wallet signs it with plain EIP-191 `personal_sign`; and the backend answers with an
 * `xo_sk_data_...` bearer key, which is shown once. For a smart wallet the message is issued
 * for the smart wallet and the owner signs it (this is not ERC-1271).
 *
 * The wallet signs the message as text, so the SDK signs only the canonical message the
 * backend writes: for the trading address, the environment's chain, `siweDomain` and
 * `siweUri`, and the XO API key statement, with a nonce and an expiry and nothing more.
 * Anything else is an `UnexpectedResponseError` and nothing is signed.
 *
 * The key is a secret. It is only ever returned from `login()` and sent as the
 * `Authorization` header of `list()` and `revoke()`; no error, message or log contains it.
 */
export class BackendAuth {
  readonly #transport: Transport;
  readonly #signer: InternalSigner;
  readonly #type: TradingIdentity['type'];
  readonly #address: Address;
  readonly #owner: Address;
  readonly #index: bigint | undefined;
  readonly #chainId: number;
  readonly #siweDomain: string;
  readonly #siweUri: string;
  readonly #label: string;
  readonly #persistent: boolean;
  readonly #scopes: readonly BackendScope[];
  readonly #now: () => Date;
  readonly #strict: boolean;
  readonly #timeoutMs: number | undefined;

  /**
   * @param signer Signs the sign-in message. It must be the owner of `identity`.
   * @throws UserInputError for an invalid option, identity, or a signer that is not the owner. Nothing is requested.
   */
  constructor(
    t: Transport,
    signer: InternalSigner,
    identity: TradingIdentity,
    o: BackendAuthOptions,
  ) {
    if (!isObject(o)) {
      throw new UserInputError('options must be an object');
    }
    if (!isObject(signer) || typeof signer.signMessage !== 'function') {
      throw new UserInputError('signer must be a Signer');
    }
    if (!isObject(identity)) {
      throw new UserInputError('identity must be a trading identity');
    }
    if (typeof o.persistent !== 'boolean') {
      throw new UserInputError('persistent must be true or false');
    }
    if (o.now !== undefined && typeof o.now !== 'function') {
      throw new UserInputError('now must be a function that returns a Date');
    }
    this.#timeoutMs = checkAuthTimeout(o.timeoutMs);
    if (!isObject(o.env)) {
      throw new UserInputError(
        'env must be an environment with chainId, siweDomain and siweUri',
      );
    }
    this.#chainId = assertChainId(o.env.chainId);
    for (const field of ['siweDomain', 'siweUri'] as const) {
      if (typeof o.env[field] !== 'string' || o.env[field] === '') {
        throw new UserInputError(`env.${field} must be a non-empty string`);
      }
    }
    this.#siweDomain = o.env.siweDomain;
    this.#siweUri = o.env.siweUri;
    this.#label = checkLabel(o.label);
    this.#scopes = Object.freeze(
      o.scopes === undefined ? [...SCOPES] : checkScopes(o.scopes),
    );
    this.#persistent = o.persistent;
    this.#now = o.now ?? (() => new Date());
    this.#strict = o.strictResponses === true;

    const owner = normalizeAddress(identity.owner, 'identity.owner');
    const address = normalizeAddress(identity.address, 'identity.address');
    if (!isSameAddress(owner, signer.address)) {
      throw new UserInputError(
        'signer address is not the owner of the trading identity',
        { code: 'signer_mismatch' },
      );
    }
    if (identity.type === 'eoa') {
      if (identity.signatureType !== 0 || !isSameAddress(owner, address)) {
        throw new UserInputError('identity is not a valid EOA identity');
      }
    } else if (identity.type === 'smart_wallet') {
      const index = identity.index;
      if (
        identity.signatureType !== 3 ||
        typeof index !== 'bigint' ||
        index < 0n ||
        index >= 1n << 256n
      ) {
        throw new UserInputError(
          'identity is not a valid smart wallet identity: it needs signatureType 3 and an index',
        );
      }
      this.#index = index;
    } else {
      throw new UserInputError('identity.type must be "eoa" or "smart_wallet"');
    }
    this.#transport = t;
    this.#signer = signer;
    this.#type = identity.type;
    this.#address = address;
    this.#owner = owner;
  }

  /**
   * Gets a sign-in message, signs it and exchanges it for a new API key. Costs one nonce
   * request and one key request, and uses up the key's slot (the account holds 10 active
   * keys). Neither request is retried: the nonce is single-use.
   *
   * @throws UnexpectedResponseError if the nonce response is for another address or chain, or its message is empty, over 2000 characters or has a carriage return, or is not the canonical XO sign-in message for this address, chain, domain and URI. Nothing is signed and no key request is sent.
   * @throws MintedKeyError (an UnexpectedResponseError with `keyId`) if the key answer is unusable after the backend created the key: the key is not an `xo_sk_` key of visible ASCII, `id`, `prefix`, `scopes`, `expiresAt` or `key` is missing or wrong-typed, or, with `strictResponses`, any field is wrong or unknown or `expiresAt` is not ISO-8601. The message then names the key's id (not the key), as the key listing shows it. A lenient login keeps a key whose `expiresAt` is not ISO-8601, with the requested lifetime as its expiry.
   * @throws SigningError if the signer does not return a 65-byte signature. An error from the signer itself passes through.
   * @throws RequestRejectedError with code `invalid_signature` (status 401) when the backend rejects the proof, or with code `api_key_limit_reached` (status 409) when the account has 10 active keys. The SDK never revokes other keys.
   * @throws MintedKeyError with `mayHaveMinted: true` when the key request fails without saying whether a key was made: no response, a timeout, a 5xx, or a 2xx body that cannot be read. The original error is its `cause`.
   * @throws RequestRejectedError (status 403 for a banned account, 400, 413 for a body over 16 kB) and RateLimitError (429) as the backend sends them; a 503 from the nonce request passes through as a RequestRejectedError with status 503.
   * @throws XoError with code `key_route_not_found` when the key request answers 404 or 405: the backend has no key-creation route at that path, so no key was created and the session does not pause. This version of the SDK may be out of date with the backend.
   * @throws UserInputError when `options` is not `{ shortLived?: boolean }`. Nothing is requested.
   */
  async login(options: KeyLifetimeOptions = {}): Promise<BackendCredential> {
    const days = this.#isShortLived(options, 'options')
      ? SHORT_LIVED_DAYS
      : PERSISTENT_DAYS;
    // Read first, so a broken clock fails before the nonce is spent.
    const at = this.#currentTime();
    const message = await this.#requestMessage();
    const signature = normalizeSignature(
      await this.#signer.signMessage(message),
    );
    return this.#createKey(message, signature, at, days);
  }

  /**
   * Whether `c` should be replaced: fewer than 7 days left for a persistent store, fewer
   * than 2 hours otherwise, or for a key minted with `shortLived`. An expiry that is not an
   * ISO-8601 time needs rotation, and so does any check made with a clock that does not
   * return a valid `Date` or with options that are not `{ shortLived?: boolean }`. It never
   * throws.
   */
  needsRotation(
    c: BackendCredential,
    options: KeyLifetimeOptions = {},
  ): boolean {
    let short: boolean;
    try {
      short = this.#isShortLived(options, 'options');
    } catch {
      return true;
    }
    const expiresAt = parseExpiry(isObject(c) ? c.expiresAt : undefined);
    const threshold = short
      ? SHORT_LIVED_ROTATE_BEFORE_MS
      : PERSISTENT_ROTATE_BEFORE_MS;
    const now = this.#now();
    // Written so that NaN (an unparseable time, or a clock that returns something other
    // than a valid Date) is "due" instead of an error.
    return !(
      expiresAt - (isValidDate(now) ? now.getTime() : Number.NaN) >=
      threshold
    );
  }

  /**
   * Revokes the key `c` with that same key (`DELETE /api/auth/api-keys/:id`). A key can
   * only revoke itself. The call is idempotent, so it is retried like a read. A
   * `401 invalid_credentials` resolves: the key is already revoked, expired or unknown, so
   * it cannot be used either way (this covers a lost 204 followed by the retry).
   * @throws UserInputError if `c.id` is not a key id from 1 to 2147483647 or `c.key` is not an `xo_sk_` key. Nothing is requested and the key is not echoed.
   */
  async revoke(c: BackendCredential): Promise<void> {
    const key = keyOf(c);
    const id = c.id;
    if (
      typeof id !== 'string' ||
      !KEY_ID_PATTERN.test(id) ||
      Number(id) > MAX_KEY_ID
    ) {
      throw new UserInputError(
        'credential.id must be a key id from 1 to 2147483647',
      );
    }
    try {
      await this.#transport.request({
        service: 'backend',
        method: 'DELETE',
        path: `${KEYS_PATH}/${id}`,
        auth: { kind: 'backend', key },
        retry: 'read',
        timeoutMs: this.#timeoutMs,
      });
    } catch (error) {
      if (isRejected(error, 401) && error.code === 'invalid_credentials') {
        return;
      }
      throw error;
    }
  }

  /**
   * The metadata of the account's keys, newest first, revoked and expired ones included.
   * Needs `account:read`.
   */
  async list(c: BackendCredential): Promise<BackendKeyInfo[]> {
    const key = keyOf(c);
    const raw = await this.#transport.request({
      service: 'backend',
      method: 'GET',
      path: KEYS_PATH,
      auth: { kind: 'backend', key },
      timeoutMs: this.#timeoutMs,
    });
    return parseResponse(ListedKeysSchema, raw, {
      strict: this.#strict,
      service: 'backend',
      path: KEYS_PATH,
    }).map((row) => ({
      id: String(row.id),
      name: row.name,
      prefix: row.prefix,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    }));
  }

  /** Whether a key is (or is to be) a 1-day key: always without a persistent store. */
  #isShortLived(options: unknown, field: string): boolean {
    if (!isObject(options)) {
      throw new UserInputError(`${field} must be { shortLived?: boolean }`);
    }
    const { shortLived } = options;
    if (shortLived !== undefined && typeof shortLived !== 'boolean') {
      throw new UserInputError(`${field}.shortLived must be true or false`);
    }
    return !this.#persistent || shortLived === true;
  }

  /** The clock's time, which must be a valid Date. */
  #currentTime(): Date {
    const at = this.#now();
    if (!isValidDate(at)) {
      throw new UserInputError('now() must return a valid Date');
    }
    return at;
  }

  /** Requests the message to sign and checks it before anything is signed. */
  async #requestMessage(): Promise<string> {
    const raw = await this.#transport.request({
      service: 'backend',
      method: 'POST',
      path: NONCE_PATH,
      body: { address: this.#address },
      auth: 'none',
      retry: 'none',
      timeoutMs: this.#timeoutMs,
    });
    const nonce = parseResponse(WalletKeyNonceSchema, raw, {
      strict: this.#strict,
      service: 'backend',
      path: NONCE_PATH,
    });
    if (!isSameAddress(nonce.address, this.#address)) {
      throw unexpected(
        NONCE_PATH,
        'address',
        'the sign-in message is for another address than the trading address',
      );
    }
    if (nonce.chainId !== this.#chainId) {
      throw unexpected(
        NONCE_PATH,
        'chainId',
        `the sign-in message is for another chain than chain ${this.#chainId}`,
      );
    }
    const { message } = nonce;
    if (
      message === '' ||
      message.length > MAX_MESSAGE_LENGTH ||
      message.includes('\r')
    ) {
      throw unexpected(
        NONCE_PATH,
        'message',
        `the sign-in message must be 1 to ${MAX_MESSAGE_LENGTH} characters without a carriage return`,
      );
    }
    const problem = signInMessageProblem(message, {
      address: this.#address,
      chainId: this.#chainId,
      domain: this.#siweDomain,
      uri: this.#siweUri,
    });
    if (problem !== undefined) {
      throw unexpected(
        NONCE_PATH,
        'message',
        `the sign-in message is not signed because ${problem}`,
      );
    }
    return message;
  }

  /**
   * @param at The clock's time when the login began: it dates the key's name and expiry.
   * @param days The lifetime to ask for.
   */
  async #createKey(
    message: string,
    signature: Hex,
    at: Date,
    days: number,
  ): Promise<BackendCredential> {
    // Exactly these fields: the backend checks the body against the fields of its `type` and
    // answers 400 to any other field, `signatureType` included.
    const body: Record<string, unknown> = {
      type: this.#type,
      message,
      signature,
      // `xo-sdk:<label>:<yyyymmdd>`, with the UTC date.
      name: `xo-sdk:${this.#label}:${at.toISOString().slice(0, 10).replaceAll('-', '')}`,
      scopes: [...this.#scopes],
      expiresInDays: days,
    };
    if (this.#type === 'smart_wallet') {
      // The owner signed; the backend finds the smart wallet from the owner and index.
      // smart_wallet only: the backend answers 400 to either with `eoa`.
      body.signer = this.#owner;
      body.index = String(this.#index);
    }
    let raw: unknown;
    try {
      raw = await this.#transport.request({
        service: 'backend',
        method: 'POST',
        path: CREATE_KEY_PATH,
        body,
        auth: 'none',
        retry: 'none',
        timeoutMs: this.#timeoutMs,
      });
    } catch (error) {
      if (isRejected(error, 409) && error.code === 'api_key_limit_reached') {
        // No cause and no follow-up call: the SDK does not revoke anything here.
        throw new RequestRejectedError(KEY_LIMIT_MESSAGE, {
          code: 'api_key_limit_reached',
          status: 409,
          service: 'backend',
          requestId: error.requestId,
        });
      }
      throw walletFailure(error, `POST ${CREATE_KEY_PATH}`);
    }
    // From here the backend has created the key, and it counts toward the 10 active keys.
    // A failure below names its id (not the key) so the user can revoke it.
    const id = mintedKeyId(raw);
    try {
      return this.#credentialFrom(raw, days, at);
    } catch (error) {
      throw asMintedKeyError(error, id);
    }
  }

  /** Reads the 201 into a credential. */
  #credentialFrom(raw: unknown, days: number, at: Date): BackendCredential {
    const ctx = {
      strict: this.#strict,
      service: 'backend',
      path: CREATE_KEY_PATH,
    } as const;
    // Lenient: the five fields used. Strict: the full shape.
    const created: CreatedKeyCore = this.#strict
      ? parseResponse(CreatedWalletKeySchema, raw, ctx)
      : parseResponse(CreatedKeyCoreSchema, raw, ctx);
    if (!isBackendKey(created.key)) {
      throw unexpected(
        CREATE_KEY_PATH,
        'key',
        'the key must be an xo_sk_ key made of visible ASCII characters',
      );
    }
    let expiresAt = created.expiresAt;
    if (Number.isNaN(parseExpiry(expiresAt))) {
      if (this.#strict) {
        throw unexpected(
          CREATE_KEY_PATH,
          'expiresAt',
          'the expiry must be an ISO-8601 time',
        );
      }
      // The key exists and counts toward the 10, so it is kept, not thrown away.
      // Its expiry is the lifetime that was asked for, counted from before the request
      // began, so it is never later than the backend's.
      expiresAt = new Date(at.getTime() + days * DAY_MS).toISOString();
    }
    return {
      id: String(created.id),
      key: created.key,
      prefix: created.prefix,
      scopes: [...created.scopes],
      expiresAt,
    };
  }
}
