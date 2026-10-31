import type { Address } from 'viem';
import { z } from 'zod';
import { isSameAddress, normalizeAddress } from '../core/address';
import { isHeaderValue } from '../core/apiKey';
import type { Clock } from '../core/clock';
import type { EnvironmentConfig } from '../core/env';
import {
  isRejected,
  RequestRejectedError,
  UnexpectedResponseError,
  UserInputError,
  XoError,
} from '../core/errors';
import {
  defineSchema,
  parseResponse,
  type ResponseIssue,
} from '../core/schema';
import type { Transport } from '../core/transport';
import { clobAuthTypedData, l1Headers } from '../signing/clobAuth';
import {
  isValidSecret,
  l2Headers,
  type OrderbookCredential,
} from '../signing/hmac';
import { assertChainId } from '../signing/internal';
import { signAsTrader, type TradingIdentity } from '../wallet/identity';
import { errorName, isObject } from '../wallet/internal';
import type { InternalSigner } from '../wallet/signer';
import { checkAuthTimeout } from './backendAuth';

export interface OrderbookAuthOptions {
  /**
   * Whether the smart wallet `address` is deployed. For a smart wallet the orderbook
   * checks the L1 signature on chain (EIP-1271), which an undeployed smart wallet cannot
   * answer (there is no ERC-6492), so `login()` asks first and fails with an actionable error
   * before signing anything. Never called for an EOA. Without it the check is skipped and
   * an undeployed smart wallet is the gateway's 401.
   *
   * A `false` is read again, at most 3 reads over about 6 s: right after `setup()` deploys
   * the smart wallet, a load-balanced RPC node can still answer from before the deploy. Only
   * the read is repeated, never a signature.
   */
  isDeployed?: (address: Address) => Promise<boolean>;
  /**
   * The waits before the second and the third `isDeployed` read, in milliseconds. Defaults
   * to `[2000, 4000]`. For tests.
   */
  deployRecheckMs?: readonly number[];
  /** Reject response fields the schema does not know (for contract tests). */
  strictResponses?: boolean;
  /**
   * The per-attempt timeout of the derive and create requests, in milliseconds. Defaults to
   * the transport's.
   */
  timeoutMs?: number;
}

/** The explicit L1 auth of the derive and create requests: headers signed once. */
type L1Auth = { kind: 'orderbookL1'; headers: ReturnType<typeof l1Headers> };

/** The waits between the `isDeployed` reads: 3 reads, at 0, 2 and 6 s. */
const DEPLOY_RECHECK_MS: readonly number[] = [2_000, 4_000];

const DERIVE_PATH = '/auth/derive-api-key';
const CREATE_PATH = '/auth/api-key';
/** The L1 nonce. The credentials are bound to the address, so a fixed nonce is enough. */
const L1_NONCE = 0n;

// The values are checked further, in `credentialFrom`: `apiKey` and `passphrase` must be
// header-safe (they become L2 headers) and `secret` must decode as base64 or base64url.
const CredentialSchema = defineSchema<OrderbookCredential>((obj) =>
  obj({
    apiKey: z.string(),
    secret: z.string(),
    passphrase: z.string(),
  }),
);

/**
 * A response the SDK cannot use. The message names the field and the rule, never the
 * received value, so nothing the gateway sent (and no secret) can end up in it.
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
    `Unexpected orderbook response for ${path}: ${field}: ${rule}`,
    { service: 'orderbook', issues: [issue] },
  );
}

/**
 * Logs in to the orderbook gateway with a wallet and returns the L2 (HMAC) credentials.
 *
 * The wallet proves control with an EIP-712 `ClobAuth` signature (L1), sent as the
 * `XO_ADDRESS`, `XO_SIGNATURE`, `XO_TIMESTAMP` and `XO_NONCE` headers. The gateway answers
 * with `{ apiKey, secret, passphrase }`: the secret and the passphrase are credentials.
 * `login()` derives the wallet's existing credentials (`GET /auth/derive-api-key`) and
 * only when there are none (404) creates them (`POST /auth/api-key`), so a wallet that has
 * logged in before does not use up one of its 100 keys.
 *
 * The only thing the wallet signs is the `ClobAuth` typed data this class builds itself, for
 * the trading address and the clock's time. For a smart wallet that is wrapped for the smart
 * wallet (ERC-1271) by `signAsTrader`. Nothing the gateway sends is ever signed.
 *
 * The timestamp must be within 120 s of the gateway's clock, so it comes from the `Clock`:
 * sync it (`clock.sync()`) before the first login. This class never syncs it.
 *
 * No error, message or log contains a credential or the signature.
 */
export class OrderbookAuth {
  readonly #transport: Transport;
  readonly #signer: InternalSigner;
  readonly #identity: TradingIdentity;
  readonly #address: Address;
  readonly #chainId: number;
  readonly #clock: Clock;
  readonly #isDeployed: OrderbookAuthOptions['isDeployed'];
  readonly #deployRecheckMs: readonly number[];
  readonly #strict: boolean;
  readonly #timeoutMs: number | undefined;

  /**
   * @param signer Signs the L1 typed data. It must be the owner of `identity`.
   * @param env Only `chainId` is used: the `ClobAuth` domain is bound to the gateway's chain.
   * @param clock The server-synced clock that dates the L1 signature.
   * @throws UserInputError for an invalid argument, identity or option, or a signer that is not the owner (code `signer_mismatch`). Nothing is requested.
   */
  constructor(
    t: Transport,
    signer: InternalSigner,
    identity: TradingIdentity,
    env: Pick<EnvironmentConfig, 'chainId'>,
    clock: Clock,
    o: OrderbookAuthOptions = {},
  ) {
    // Every field is read exactly once, into a local, and the locals are checked and stored.
    // A getter or a proxy that answers differently the second time then changes nothing
    // after the checks: what was validated is what is used.
    const options: unknown = o;
    if (!isObject(options)) {
      throw new UserInputError('options must be an object');
    }
    const isDeployed = options.isDeployed;
    const strictResponses = options.strictResponses;
    const recheck = options.deployRecheckMs;
    const timeoutMs = checkAuthTimeout(options.timeoutMs);
    if (isDeployed !== undefined && typeof isDeployed !== 'function') {
      throw new UserInputError('isDeployed must be a function');
    }
    const deployRecheckMs: unknown[] =
      recheck === undefined
        ? [...DEPLOY_RECHECK_MS]
        : Array.isArray(recheck)
          ? [...recheck]
          : [Number.NaN];
    if (
      deployRecheckMs.length > 2 ||
      !deployRecheckMs.every(
        (ms) => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0,
      )
    ) {
      throw new UserInputError(
        'deployRecheckMs must be an array of at most 2 non-negative numbers of milliseconds',
      );
    }
    if (strictResponses !== undefined && typeof strictResponses !== 'boolean') {
      throw new UserInputError('strictResponses must be true or false');
    }
    if (!isObject(signer) || typeof signer.signTypedData !== 'function') {
      throw new UserInputError('signer must be a Signer');
    }
    if (!isObject(identity)) {
      throw new UserInputError('identity must be a trading identity');
    }
    if (!isObject(env)) {
      throw new UserInputError('env must be an environment with a chainId');
    }
    if (!isObject(clock) || typeof clock.nowSecString !== 'function') {
      throw new UserInputError('clock must be a Clock');
    }
    this.#chainId = assertChainId(env.chainId);

    const { type, signatureType, index } = identity;
    const owner = normalizeAddress(identity.owner, 'identity.owner');
    const address = normalizeAddress(identity.address, 'identity.address');
    if (!isSameAddress(owner, signer.address)) {
      throw new UserInputError(
        'signer address is not the owner of the trading identity',
        { code: 'signer_mismatch' },
      );
    }
    if (type === 'eoa') {
      if (signatureType !== 0 || !isSameAddress(owner, address)) {
        throw new UserInputError('identity is not a valid EOA identity');
      }
    } else if (type === 'smart_wallet') {
      if (signatureType !== 3) {
        throw new UserInputError(
          'identity is not a valid smart wallet identity: it needs signatureType 3',
        );
      }
      if (index !== undefined && typeof index !== 'bigint') {
        throw new UserInputError('identity.index must be a bigint');
      }
    } else {
      throw new UserInputError('identity.type must be "eoa" or "smart_wallet"');
    }
    this.#transport = t;
    this.#signer = signer;
    // A frozen copy of the checked locals. An EOA identity has no index.
    this.#identity = Object.freeze(
      type === 'smart_wallet'
        ? { type, owner, address, signatureType, index }
        : { type, owner, address, signatureType },
    );
    this.#address = address;
    this.#clock = clock;
    this.#isDeployed = isDeployed as OrderbookAuthOptions['isDeployed'];
    this.#deployRecheckMs = Object.freeze(deployRecheckMs as number[]);
    this.#strict = strictResponses === true;
    this.#timeoutMs = timeoutMs;
  }

  /**
   * Signs the L1 headers once and gets the credentials: `GET /auth/derive-api-key` (the
   * existing ones, retried like a read) and `POST /auth/api-key` with no body (not retried)
   * only when the gateway finds no key for the wallet (a 404 on derive, and nothing else).
   * At most one request of each kind, with the same headers. Nothing loops.
   *
   * The credentials are secrets. The returned object is plain data: keep it out of logs.
   *
   * @throws XoError with code `smart_wallet_not_deployed` (service `chain`) for a smart wallet when `isDeployed` says it is not deployed, 3 times over about 6 s. Nothing is signed or requested.
   * @throws XoError with code `smart_wallet_deployment_unknown` (service `chain`) when `isDeployed` throws or does not answer `true` or `false`. The message names the error type only.
   * @throws UserInputError if the clock does not give a unix-seconds string. Nothing is requested.
   * @throws SigningError if the signer does not return a 65-byte signature. An error from the signer itself passes through.
   * @throws RequestRejectedError (status 401) if the gateway rejects the proof: a timestamp outside its 120 s window, a signature that does not recover to the address, or a smart wallet that is not deployed.
   * @throws RequestRejectedError (status 400) from the create call: derive found no key, and the create was refused. Because the gateway only creates for a wallet without a key, the realistic cause is the per-user limit (100 keys) being reached in a race with other clients that created keys for the same wallet between the two calls. Other refusals (403, 5xx) pass through as parsed, and so does RateLimitError.
   * @throws UnexpectedResponseError if the answer is not `{ apiKey, secret, passphrase }`; if the `apiKey` or the `passphrase` is not 1 to 256 visible ASCII characters (they become request headers); if the secret is not base64 or base64url; or, with `strictResponses`, if a field is unknown. The message names the field, never a value. After a create, the gateway may already hold the new key; the next `login()` derives it.
   */
  async login(): Promise<OrderbookCredential> {
    const auth = await this.#l1Auth();
    const derived = await this.#derive(auth);
    if (derived !== undefined) {
      return derived;
    }

    // The wallet has no credentials yet.
    const raw = await this.#transport.request({
      service: 'orderbook',
      method: 'POST',
      path: CREATE_PATH,
      auth,
      retry: 'none',
      timeoutMs: this.#timeoutMs,
    });
    return this.#credentialFrom(raw, CREATE_PATH);
  }

  /**
   * The wallet's existing credentials, or `undefined` when it has none: one L1 signature and
   * `GET /auth/derive-api-key`, the request {@link login} starts with. It never creates a key.
   * The credentials are secrets.
   *
   * @throws The errors of {@link login} but those of the create call.
   */
  async derive(): Promise<OrderbookCredential | undefined> {
    return this.#derive(await this.#l1Auth());
  }

  /** The smart wallet deployment check, then the L1 headers, signed once. */
  async #l1Auth(): Promise<L1Auth> {
    if (
      this.#identity.type === 'smart_wallet' &&
      this.#isDeployed !== undefined
    ) {
      await this.#requireDeployed(this.#isDeployed);
    }
    return { kind: 'orderbookL1', headers: await this.#signL1() };
  }

  /** `GET /auth/derive-api-key` with `auth`: the credentials, or `undefined` on a 404. */
  async #derive(auth: L1Auth): Promise<OrderbookCredential | undefined> {
    // Only the request sits inside the `try`: what it throws is a transport or server
    // error, and a 404 is the one that means "no key yet". Reading the answer happens
    // after it, so a parse error can never be mistaken for that 404 and lead to a create.
    let raw: unknown;
    try {
      raw = await this.#transport.request({
        service: 'orderbook',
        method: 'GET',
        path: DERIVE_PATH,
        auth,
        retry: 'read',
        timeoutMs: this.#timeoutMs,
      });
    } catch (error) {
      if (isRejected(error, 404)) {
        return undefined;
      }
      throw error;
    }
    return this.#credentialFrom(raw, DERIVE_PATH);
  }

  /**
   * Fails, before anything is signed, when the smart wallet cannot answer EIP-1271. A
   * `false` is read again after each of the recheck waits (an RPC node may lag behind the
   * deploy); a read that throws, or answers anything else, ends the check at once.
   */
  async #requireDeployed(
    isDeployed: NonNullable<OrderbookAuthOptions['isDeployed']>,
  ): Promise<void> {
    for (const wait of [undefined, ...this.#deployRecheckMs]) {
      if (wait !== undefined) {
        await new Promise<void>((resolve) => setTimeout(resolve, wait));
      }
      if (await this.#readDeployed(isDeployed)) {
        return;
      }
    }
    throw new XoError(
      `Cannot log in to the orderbook: the smart wallet ${this.#address} is not deployed; the orderbook verifies smart wallet signatures on chain (EIP-1271). createSecureClient deploys a new smart wallet before it signs in, so the chain read may be lagging behind: try again in a moment`,
      { code: 'smart_wallet_not_deployed', service: 'chain' },
    );
  }

  /** One `isDeployed` read: `true` or `false`, else `smart_wallet_deployment_unknown`. */
  async #readDeployed(
    isDeployed: NonNullable<OrderbookAuthOptions['isDeployed']>,
  ): Promise<boolean> {
    let deployed: unknown;
    try {
      deployed = await isDeployed(this.#address);
    } catch (error) {
      // No `cause`, and only the error's name: an RPC error can carry the URL of the node,
      // and that URL can hold an API key.
      throw new XoError(
        `Cannot log in to the orderbook: it could not be checked whether the smart wallet ${this.#address} is deployed (${errorName(error)})`,
        { code: 'smart_wallet_deployment_unknown', service: 'chain' },
      );
    }
    if (typeof deployed === 'boolean') {
      return deployed;
    }
    throw new XoError(
      `Cannot log in to the orderbook: it could not be checked whether the smart wallet ${this.#address} is deployed (isDeployed did not answer true or false)`,
      { code: 'smart_wallet_deployment_unknown', service: 'chain' },
    );
  }

  /** The L1 headers for the trading address, dated by the clock. */
  async #signL1(): Promise<ReturnType<typeof l1Headers>> {
    const timestamp = this.#clock.nowSecString();
    const signature = await signAsTrader(
      this.#identity,
      this.#signer,
      clobAuthTypedData({
        address: this.#address,
        timestamp,
        nonce: L1_NONCE,
        chainId: this.#chainId,
      }),
      this.#chainId,
    );
    return l1Headers({
      address: this.#address,
      signature,
      timestamp,
      nonce: L1_NONCE,
    });
  }

  /** Reads a 200 into the credential, checking the secret. The error never holds a value. */
  #credentialFrom(raw: unknown, path: string): OrderbookCredential {
    const parsed = parseResponse(CredentialSchema, raw, {
      strict: this.#strict,
      service: 'orderbook',
      path,
    });
    // The apiKey and the passphrase become the XO_API_KEY and XO_PASSPHRASE headers of every
    // L2 request, so a value a header cannot carry is refused here, with the login.
    for (const field of ['apiKey', 'passphrase'] as const) {
      if (!isHeaderValue(parsed[field])) {
        throw unexpected(
          path,
          field,
          `the ${field} must be 1 to 256 visible ASCII characters without whitespace`,
        );
      }
    }
    if (!isValidSecret(parsed.secret)) {
      throw unexpected(
        path,
        'secret',
        'the secret must be base64 or base64url (standard or URL-safe alphabet, padded or not)',
      );
    }
    // Exactly the three fields: a lenient parse keeps unknown ones, and they are dropped here.
    return {
      apiKey: parsed.apiKey,
      secret: parsed.secret,
      passphrase: parsed.passphrase,
    };
  }
}

/** The route that deletes an orderbook API key. */
const DELETE_PATH = '/auth/api-key';

/**
 * Deletes the orderbook API key `credential` with itself: `DELETE /auth/api-key` with the body
 * `{ "apiKey": … }`, signed (L2 HMAC) by that same credential, afresh for each attempt. The
 * deletion is idempotent, so it is retried like a read; the session is never asked for
 * headers, so a 401 cannot make it sign in again.
 *
 * The gateway keeps one set of credentials per wallet, and every process that signs in for the
 * same wallet gets the same key (sign-in derives the existing one): deleting it signs all of
 * them out of the order book. One that signs in again gets a new key.
 *
 * @param clock Dates each attempt, and is synced once after a 401 (a skewed clock) before the
 *   one more attempt.
 * @param timeoutMs The per-attempt timeout; defaults to the transport's.
 * @returns `'deleted'`, or `'gone'` when no one can use the credential any more: the gateway
 *   does not know the key (404: unknown, or deleted already) or does not accept it even after
 *   the clock sync (401).
 * @throws RequestRejectedError for any other refusal: status 403 when the key belongs to
 *   another wallet. Its message is the SDK's own, so the key is never repeated.
 * @throws RateLimitError, TimeoutError or TransportError when the request fails.
 */
export async function deleteOrderbookKey(
  t: Transport,
  credential: OrderbookCredential,
  clock: Pick<Clock, 'nowSecString' | 'sync'>,
  timeoutMs?: number,
): Promise<'deleted' | 'gone'> {
  const send = async (): Promise<void> => {
    await t.request({
      service: 'orderbook',
      method: 'DELETE',
      path: DELETE_PATH,
      body: { apiKey: credential.apiKey },
      auth: {
        kind: 'orderbookL2',
        // The transport passes the exact body it sends, so the HMAC covers those bytes.
        sign: (req) =>
          l2Headers(
            credential,
            clock.nowSecString(),
            req.method,
            req.path,
            req.body,
          ),
      },
      retry: 'read',
      timeoutMs: checkAuthTimeout(timeoutMs),
    });
  };
  try {
    await send();
    return 'deleted';
  } catch (error) {
    if (isRejected(error, 404)) {
      return 'gone';
    }
    if (!isRejected(error, 401)) {
      throw refusalWithoutKey(error);
    }
  }
  // A 401: the key is gone, or this machine's clock is off by more than the gateway allows.
  try {
    await clock.sync();
  } catch {
    // Best effort: the second attempt tells either way.
  }
  try {
    await send();
    return 'deleted';
  } catch (error) {
    if (isRejected(error, 404) || isRejected(error, 401)) {
      return 'gone';
    }
    throw refusalWithoutKey(error);
  }
}

/**
 * A refusal of the deletion, with a message of the SDK's own: the gateway's message can repeat
 * the key it was asked about. Any other error passes through.
 */
function refusalWithoutKey(error: unknown): unknown {
  if (!(error instanceof RequestRejectedError)) {
    return error;
  }
  const why =
    error.status === 403
      ? 'the key belongs to another wallet'
      : `status ${error.status}`;
  return new RequestRejectedError(
    `The order book refused to delete its API key (${why})`,
    {
      code: error.code,
      status: error.status,
      service: 'orderbook',
      requestId: error.requestId,
      retryAfter: error.retryAfter,
    },
  );
}
