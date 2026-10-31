import { randomBytes } from 'node:crypto';
import { HttpResponse, http } from 'msw';
import type { SetupServer } from 'msw/node';
import {
  type Address,
  getAddress,
  type Hex,
  recoverMessageAddress,
} from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { testEnv } from './testEnv';

// A fake of the backend's wallet-signed API key routes, for the msw tests of the backend
// login and the session. It mirrors the backend's key creation route with its body checks,
// the nonce route, and the list and revoke routes:
// - POST /api/auth/api-keys/nonce  -> 200, a single-use EIP-4361 message
// - POST /api/auth/api-keys        -> the one route that creates a key. `type` `eoa` or
//   `smart_wallet` with a signed nonce message: 201 with the key, and every proof failure is
//   the same 401 invalid_signature. The body is checked against the fields of its type, with
//   no other field allowed, and a failure is the backend's flat validation 400: `type` missing or
//   not privy, eoa or smart_wallet (the 400 names `type` only), `signatureType` (no longer a
//   field), `signer` or `index` with `eoa`, no `signer` with `smart_wallet`. `type` `privy`
//   needs a web session, which this fake has none of: 401 authentication_required.
// - POST /api/auth/api-keys/wallet -> 404: removed
// - GET /api/auth/api-keys         -> the key metadata, newest first, revoked included
// - DELETE /api/auth/api-keys/:id  -> 204; a key can only revoke itself
// - GET /api/users/me              -> a stand-in for any route that takes a key: 200 for
//   a valid, unrevoked, unexpired key (`{ keyId }`, plus the account's `walletPublicKey` when
//   the fake knows the key's wallet: a minted key's trading address, or the wallet a seeded
//   key was given), otherwise 401 invalid_credentials
//
// Other failures below 500 come out as the backend's error handler writes them (see
// exceptionResponse), and the sign-in message is a real EIP-4361 message for the
// environment's siweDomain and siweUri.

const env = testEnv;
export const API_KEYS_URL = `${env.backendUrl}/api/auth/api-keys`;
export const NONCE_URL = `${API_KEYS_URL}/nonce`;
/** The old key route. The backend answers 404 on it now. */
export const OLD_WALLET_URL = `${API_KEYS_URL}/wallet`;
export const ME_PATH = '/api/users/me';
export const ME_URL = `${env.backendUrl}${ME_PATH}`;
export const DAY_MS = 86_400_000;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;
const INDEX_DIGITS = /^[0-9]{1,78}$/;
const ALL_SCOPES = ['account:read', 'account:write'];
/** The statement of every sign-in message, as the backend expects it. */
export const SIGN_IN_STATEMENT = 'Create an XO API key for this wallet.';
/** The 400 of a `type` that is missing or not one of the three (API_KEY_CREATION_TYPE_MESSAGE). */
export const KEY_TYPE_MESSAGE = 'type must be one of: privy, eoa, smart_wallet';
type WalletKeyType = 'eoa' | 'smart_wallet';
/** The body fields the backend takes for each wallet type. */
const KEY_FIELDS: Record<WalletKeyType, ReadonlySet<string>> = {
  eoa: new Set([
    'type',
    'message',
    'signature',
    'name',
    'scopes',
    'expiresInDays',
  ]),
  smart_wallet: new Set([
    'type',
    'message',
    'signature',
    'signer',
    'index',
    'name',
    'scopes',
    'expiresInDays',
  ]),
};

export interface NonceBody {
  address: unknown;
  domain: string;
  uri: string;
  chainId: unknown;
  version: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
  statement: string;
  message: unknown;
}

export interface Issued {
  address: Address;
  message: string;
  used: boolean;
}

export interface KeyRecord {
  id: number;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  createdVia: string;
  createdAt: string;
}

export interface Backend {
  /** "METHOD /path" for every request that reached a handler. */
  calls: string[];
  nonceBodies: unknown[];
  nonceAuth: Array<string | null>;
  /** The bodies of the key requests (`POST /api/auth/api-keys`) that passed the DTO check. */
  walletBodies: Array<Record<string, unknown>>;
  /** The Authorization header of every key request. */
  walletAuth: Array<string | null>;
  /** The Authorization header of every list and revoke request. */
  keyAuth: Array<string | null>;
  /** The Authorization header of every `GET /api/users/me`. */
  meAuth: Array<string | null>;
  issued: Issued[];
  minted: Array<{ key: string; record: KeyRecord }>;
  keys: Map<string, KeyRecord>;
  /** The wallet of each key's account (the address that holds the funds), when known. */
  wallets: Map<string, Address>;
  /** Changes the nonce response before it is sent. */
  nonceHook?: (nonce: NonceBody) => NonceBody | Response;
  /** Answers instead of the normal key handling (after the DTO check). */
  walletHook?: (body: Record<string, unknown>) => Response | undefined;
  /** Changes the 201 body. */
  createdHook?: (body: Record<string, unknown>) => Record<string, unknown>;
  /** The account has 10 active keys. */
  limitReached: boolean;
}

export interface BackendOptions {
  chainId?: number;
  /** Smart accounts the backend knows how to resolve: account -> owner and index. */
  smartAccounts?: Record<string, { owner: Address; index: bigint }>;
}

/** The exception class names the filter's `name` field carries, by status. */
const EXCEPTION_NAMES: Record<number, string> = {
  400: 'BadRequestException',
  401: 'UnauthorizedException',
  403: 'ForbiddenException',
  404: 'NotFoundException',
  409: 'ConflictException',
};

/**
 * An error response as the backend's error handler writes it for a status below 500:
 * `{ statusCode, timestamp, path, ...exception }`. The exception's own fields come along:
 * `response` (what the route threw), `status`,
 * `options`, `message` and `name`. The code sits in `response.error`; the top level has
 * no `error`. `path` is the request URL, which is relative to the host.
 */
export function exceptionResponse(
  path: string,
  status: number,
  response: { error?: string; message: string | string[] },
): Response {
  const body = { statusCode: status, ...response };
  return HttpResponse.json(
    {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path,
      response: body,
      status,
      options: {},
      // The exception takes a string message as it is, and names an array one after its
      // class.
      message:
        typeof response.message === 'string'
          ? response.message
          : (EXCEPTION_NAMES[status] ?? 'Error')
              .match(/[A-Z][a-z]+/g)
              ?.join(' '),
      name: EXCEPTION_NAMES[status] ?? 'HttpException',
    },
    { status },
  );
}

const OLD_WALLET_PATH = '/api/auth/api-keys/wallet';
const NONCE_PATH = '/api/auth/api-keys/nonce';
const KEYS_PATH = '/api/auth/api-keys';

export const badRequest = (message: string, path = KEYS_PATH): Response =>
  exceptionResponse(path, 400, { message: [message], error: 'Bad Request' });

/**
 * A body that fails the backend's validation, as the backend answers it: a flat
 * body with no `timestamp`, `path` or `response`, and `message` an array of strings.
 */
export const validationError = (...messages: string[]): Response =>
  HttpResponse.json(
    { statusCode: 400, message: messages, error: 'Bad Request' },
    { status: 400 },
  );

export const invalidSignature = (path = KEYS_PATH): Response =>
  exceptionResponse(path, 401, {
    error: 'invalid_signature',
    message: 'Invalid signature',
  });

export const invalidCredentials = (path = KEYS_PATH): Response =>
  exceptionResponse(path, 401, {
    error: 'invalid_credentials',
    message: 'Invalid credentials',
  });

/** The path of a request, as the backend sees it. */
const pathOf = (request: Request): string => {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
};

const isWalletKeyIndex = (value: unknown): boolean =>
  typeof value === 'number'
    ? Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
    : typeof value === 'string' && INDEX_DIGITS.test(value);

/** The `type` of a body, read as the backend's key route reads it. */
function requestedKeyType(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return undefined;
  }
  if (!Object.hasOwn(body, 'type')) {
    return undefined;
  }
  const type = (body as Record<string, unknown>).type;
  return typeof type === 'string' ? type : undefined;
}

/**
 * The backend's API-key body check for a wallet type: no field outside the type's fields, and
 * the rules of each field.
 */
function walletBodyProblem(
  o: Record<string, unknown>,
  type: WalletKeyType,
): string | undefined {
  for (const key of Object.keys(o)) {
    // signatureType is no longer a field, and signer and index are smart_wallet only.
    if (!KEY_FIELDS[type].has(key)) {
      return `property ${key} should not exist`;
    }
  }
  if (
    typeof o.message !== 'string' ||
    o.message.length < 1 ||
    o.message.length > 2000
  ) {
    return 'message must be between 1 and 2000 characters';
  }
  if (typeof o.signature !== 'string' || !SIGNATURE_PATTERN.test(o.signature)) {
    return 'signature must be 0x followed by 130 hex digits';
  }
  if (type === 'smart_wallet') {
    // Required.
    if (typeof o.signer !== 'string' || !ADDRESS_PATTERN.test(o.signer)) {
      return 'signer must be 0x followed by 40 hex digits';
    }
    // Optional: null and undefined both mean "not sent".
    if (
      o.index !== undefined &&
      o.index !== null &&
      !isWalletKeyIndex(o.index)
    ) {
      return 'index must be a non-negative integer or a string of 1 to 78 decimal digits';
    }
  }
  // The DTO trims `name` first, then checks its length and control characters.
  const name = typeof o.name === 'string' ? o.name.trim() : undefined;
  if (
    name === undefined ||
    name.length < 1 ||
    name.length > 100 ||
    /\p{Cc}/u.test(name)
  ) {
    return 'name must be 1 to 100 characters without control characters';
  }
  const scopes = o.scopes;
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    scopes.length > ALL_SCOPES.length ||
    new Set(scopes).size !== scopes.length ||
    !scopes.every((scope) => ALL_SCOPES.includes(scope))
  ) {
    return 'scopes must be a non-empty, unique subset of account:read, account:write';
  }
  const days = o.expiresInDays;
  if (
    days !== undefined &&
    days !== null &&
    (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 365)
  ) {
    return 'expiresInDays must be an integer from 1 to 365';
  }
  return undefined;
}

/** The proof checks of the use case. Every failure is the same 401. */
async function proofHolds(
  backend: Backend,
  options: BackendOptions,
  body: Record<string, unknown>,
): Promise<boolean> {
  const issued = backend.issued.find((i) => i.message === body.message);
  if (issued === undefined || issued.used) {
    return false;
  }
  let recovered: Address;
  try {
    recovered = await recoverMessageAddress({
      message: body.message as string,
      signature: body.signature as Hex,
    });
  } catch {
    return false;
  }
  if (body.type === 'eoa') {
    if (recovered.toLowerCase() !== issued.address.toLowerCase()) {
      return false;
    }
  } else if (body.type === 'smart_wallet') {
    const account = options.smartAccounts?.[issued.address.toLowerCase()];
    if (
      account === undefined ||
      typeof body.signer !== 'string' ||
      body.signer.toLowerCase() !== account.owner.toLowerCase() ||
      recovered.toLowerCase() !== account.owner.toLowerCase() ||
      BigInt((body.index ?? 0) as string | number) !== account.index
    ) {
      return false;
    }
  } else {
    return false;
  }
  issued.used = true;
  return true;
}

function authenticate(
  backend: Backend,
  request: Request,
  log: Array<string | null> = backend.keyAuth,
): KeyRecord | Response {
  log.push(request.headers.get('authorization'));
  const match = /^Bearer (.+)$/.exec(
    request.headers.get('authorization') ?? '',
  );
  const record =
    match?.[1] === undefined ? undefined : backend.keys.get(match[1]);
  if (
    record === undefined ||
    record.revokedAt !== null ||
    Date.parse(record.expiresAt) <= Date.now()
  ) {
    return invalidCredentials(pathOf(request));
  }
  return record;
}

/**
 * Installs the handlers on `server` and returns the live state of the fake backend. Call
 * it in a test, after `server.listen()`; `server.resetHandlers()` removes the handlers.
 */
export function installBackend(
  server: SetupServer,
  options: BackendOptions = {},
): Backend {
  const chainId = options.chainId ?? env.chainId;
  const backend: Backend = {
    calls: [],
    nonceBodies: [],
    nonceAuth: [],
    walletBodies: [],
    walletAuth: [],
    keyAuth: [],
    meAuth: [],
    issued: [],
    minted: [],
    keys: new Map(),
    wallets: new Map(),
    limitReached: false,
  };
  let seq = 100;

  server.use(
    http.post(NONCE_URL, async ({ request }) => {
      backend.calls.push(`POST ${NONCE_PATH}`);
      backend.nonceAuth.push(request.headers.get('authorization'));
      const body: unknown = await request.json().catch(() => undefined);
      backend.nonceBodies.push(body);
      if (
        typeof body !== 'object' ||
        body === null ||
        Object.keys(body).some((key) => key !== 'address')
      ) {
        return badRequest('property should not exist', NONCE_PATH);
      }
      const requested = (body as { address?: unknown }).address;
      if (typeof requested !== 'string' || !ADDRESS_PATTERN.test(requested)) {
        return badRequest(
          'address must be 0x followed by 40 hex digits',
          NONCE_PATH,
        );
      }
      const address = getAddress(requested.toLowerCase());
      const nonce = randomBytes(8).toString('hex');
      const issuedAt = new Date();
      const expirationTime = new Date(issuedAt.getTime() + 5 * 60_000);
      const base: NonceBody = {
        address,
        domain: env.siweDomain,
        uri: env.siweUri,
        chainId,
        version: '1',
        nonce,
        issuedAt: issuedAt.toISOString(),
        expirationTime: expirationTime.toISOString(),
        statement: SIGN_IN_STATEMENT,
        message: createSiweMessage({
          address,
          chainId,
          domain: env.siweDomain,
          nonce,
          uri: env.siweUri,
          version: '1',
          statement: SIGN_IN_STATEMENT,
          issuedAt,
          expirationTime,
        }),
      };
      const shaped = backend.nonceHook?.(base) ?? base;
      if (shaped instanceof Response) {
        return shaped;
      }
      if (typeof shaped.message === 'string') {
        backend.issued.push({ address, message: shaped.message, used: false });
      }
      return HttpResponse.json(shaped as unknown as Record<string, unknown>, {
        headers: { 'cache-control': 'no-store' },
      });
    }),

    // Removed: the backend answers an unknown route with a 404.
    http.post(OLD_WALLET_URL, () => {
      backend.calls.push(`POST ${OLD_WALLET_PATH}`);
      return exceptionResponse(OLD_WALLET_PATH, 404, {
        error: 'Not Found',
        message: `Cannot POST ${OLD_WALLET_PATH}`,
      });
    }),

    http.post(API_KEYS_URL, async ({ request }) => {
      backend.calls.push(`POST ${KEYS_PATH}`);
      backend.walletAuth.push(request.headers.get('authorization'));
      const body: unknown = await request.json().catch(() => undefined);
      const type = requestedKeyType(body);
      // For privy, the backend checks the web session before it validates the body.
      if (type === 'privy') {
        return exceptionResponse(KEYS_PATH, 401, {
          error: 'authentication_required',
          message: 'Authentication required',
        });
      }
      // Without one of the three types, only `type` is reported.
      if (type !== 'eoa' && type !== 'smart_wallet') {
        return validationError(KEY_TYPE_MESSAGE);
      }
      const dto = body as Record<string, unknown>;
      const problem = walletBodyProblem(dto, type);
      if (problem !== undefined) {
        return validationError(problem);
      }
      backend.walletBodies.push(dto);
      const forced = backend.walletHook?.(dto);
      if (forced !== undefined) {
        return forced;
      }
      if (!(await proofHolds(backend, options, dto))) {
        return invalidSignature();
      }
      if (backend.limitReached) {
        return exceptionResponse(KEYS_PATH, 409, {
          error: 'api_key_limit_reached',
          message:
            'You can have at most 10 active API keys. Revoke one to create another.',
        });
      }
      seq += 1;
      const prefix = randomBytes(4).toString('hex');
      const key = `xo_sk_data_${prefix}_${randomBytes(24).toString('hex')}`;
      const now = new Date();
      const days = (dto.expiresInDays as number | null | undefined) ?? 90;
      const record: KeyRecord = {
        id: seq,
        name: (dto.name as string).trim(),
        prefix,
        scopes: [...(dto.scopes as string[])],
        expiresAt: new Date(now.getTime() + days * DAY_MS).toISOString(),
        lastUsedAt: null,
        lastUsedIp: null,
        revokedAt: null,
        createdVia: 'wallet_signature',
        createdAt: now.toISOString(),
      };
      backend.keys.set(key, record);
      backend.minted.push({ key, record });
      const issued = backend.issued.find((i) => i.message === dto.message);
      if (issued !== undefined) {
        backend.wallets.set(key, issued.address);
      }
      const created = { ...record, key };
      return HttpResponse.json(backend.createdHook?.(created) ?? created, {
        status: 201,
        headers: { 'cache-control': 'no-store' },
      });
    }),

    http.get(API_KEYS_URL, ({ request }) => {
      backend.calls.push('GET /api/auth/api-keys');
      const caller = authenticate(backend, request);
      if (caller instanceof Response) {
        return caller;
      }
      if (!caller.scopes.includes('account:read')) {
        return exceptionResponse(KEYS_PATH, 403, {
          error: 'insufficient_scope',
          message: 'This API key does not have the account:read scope',
        });
      }
      // Newest first, including revoked and expired keys.
      const all = [...backend.keys.values()].sort((a, b) => b.id - a.id);
      return HttpResponse.json(all);
    }),

    http.delete(`${API_KEYS_URL}/:id`, ({ request, params }) => {
      backend.calls.push(`DELETE /api/auth/api-keys/${String(params.id)}`);
      const caller = authenticate(backend, request);
      if (caller instanceof Response) {
        return caller;
      }
      const path = pathOf(request);
      const raw = String(params.id);
      // The authentication above runs first, then the id is parsed as an integer.
      if (!/^-?\d+$/.test(raw)) {
        return badRequest(
          'Validation failed (numeric string is expected)',
          path,
        );
      }
      const id = Number(raw);
      // The self check comes before any range check or lookup,
      // so a key cannot probe for other ids. A key caller never reaches the 404.
      if (id !== caller.id) {
        return exceptionResponse(path, 403, {
          error: 'api_key_can_only_revoke_itself',
          message: 'An API key can only revoke itself.',
        });
      }
      if (id < 1 || id > 2_147_483_647) {
        return exceptionResponse(path, 404, {
          error: 'Not Found',
          message: 'API key not found',
        });
      }
      caller.revokedAt = new Date().toISOString();
      return new HttpResponse(null, { status: 204 });
    }),

    http.get(ME_URL, ({ request }) => {
      backend.calls.push(`GET ${ME_PATH}`);
      const caller = authenticate(backend, request, backend.meAuth);
      if (caller instanceof Response) {
        return caller;
      }
      const key = /^Bearer (.+)$/.exec(
        request.headers.get('authorization') ?? '',
      )?.[1];
      const wallet = key === undefined ? undefined : backend.wallets.get(key);
      return HttpResponse.json({
        keyId: caller.id,
        ...(wallet === undefined ? {} : { walletPublicKey: wallet }),
      });
    }),
  );
  return backend;
}

/**
 * Puts an active key in the fake backend, as if a login had minted it earlier (for a
 * restart test). Ids start at 10, below the ids `installBackend` mints (101 and up).
 */
export function seedBackendKey(
  backend: Backend,
  o: { expiresAt?: string; scopes?: string[]; wallet?: Address } = {},
): { key: string; record: KeyRecord } {
  const prefix = randomBytes(4).toString('hex');
  const key = `xo_sk_data_${prefix}_${randomBytes(24).toString('hex')}`;
  const now = new Date();
  const record: KeyRecord = {
    id: 10 + backend.keys.size,
    name: 'xo-sdk:default:20261001',
    prefix,
    scopes: [...(o.scopes ?? ALL_SCOPES)],
    expiresAt:
      o.expiresAt ?? new Date(now.getTime() + 90 * DAY_MS).toISOString(),
    lastUsedAt: null,
    lastUsedIp: null,
    revokedAt: null,
    createdVia: 'wallet_signature',
    createdAt: now.toISOString(),
  };
  backend.keys.set(key, record);
  if (o.wallet !== undefined) {
    backend.wallets.set(key, o.wallet);
  }
  return { key, record };
}
