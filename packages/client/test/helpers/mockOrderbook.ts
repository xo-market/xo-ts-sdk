import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { HttpResponse, http } from 'msw';
import type { SetupServer } from 'msw/node';
import {
  type Address,
  getAddress,
  type Hex,
  hashTypedData,
  recoverAddress,
  size,
  slice,
} from 'viem';
import { testEnv } from './testEnv';

// A fake of the orderbook gateway's credential routes, for the msw tests of the orderbook
// login and the session. It mirrors the gateway's key routes, its L1 and L2 checks and its
// errors:
// - GET  /auth/derive-api-key -> the EXISTING credentials of the L1-recovered address (the
//   oldest key), or 404 when there is none. It never mints. Optional query: address, nonce.
// - POST /auth/api-key        -> a new {apiKey, secret, passphrase}. The body is empty,
//   `null`, `{}` or `{address}`; anything else is 422 (unknown field) or 400 (not JSON). A
//   user holds at most 100 keys; the 101st is a 400.
// - L1 (ClobAuth) is mandatory on both: the headers XO_ADDRESS, XO_SIGNATURE, XO_TIMESTAMP
//   and XO_NONCE. A failure is always `401 { error: <message> }`. The timestamp must be
//   within 120 s of the gateway's clock. An EOA signature is 65 bytes and recovers to
//   XO_ADDRESS. Anything else goes to EIP-1271, which here is a Kernel account that is
//   listed in `smartAccounts` (deployed) and whose owner signed the Kernel wrap of the
//   digest; an undeployed account fails (there is no ERC-6492).
// - DELETE /auth/api-key      -> deletes the key named by the body `{ apiKey }`, which must be
//   the only field, signed with L2 HMAC over that exact body: `200 { deleted: true }`; 404 for
//   a key the gateway does not hold (its message repeats the key, as the gateway's does); 403
//   for a key of another wallet; 401 when the L2 check fails.
// - GET  /data/orders         -> a stand-in for any L2 route: `[]` when the L2 HMAC
//   headers XO_API_KEY, XO_PASSPHRASE, XO_TIMESTAMP and XO_SIGNATURE are valid for a key the
//   gateway holds and the timestamp is within 30 s of its clock, otherwise `401 { error }`.
//   The 401 messages are written here, not copied from the gateway (the SDK never reads them).
//
// The L1 digest and the Kernel wrap are written out here from the gateway's and Kernel's
// definitions, not taken from the SDK, so a test that logs in against this mock checks the
// SDK's signing against an independent version.

const env = testEnv;
export const DERIVE_PATH = '/auth/derive-api-key';
export const CREATE_PATH = '/auth/api-key';
export const DERIVE_URL = `${env.orderbookUrl}${DERIVE_PATH}`;
export const CREATE_URL = `${env.orderbookUrl}${CREATE_PATH}`;
export const ORDERS_PATH = '/data/orders';
export const ORDERS_URL = `${env.orderbookUrl}${ORDERS_PATH}`;

/** The L1 timestamp window of the gateway, in seconds. */
export const L1_WINDOW_SEC = 120;
/** The L2 timestamp window of the gateway, in seconds. */
export const L2_WINDOW_SEC = 30;
/** `MAX_KEYS_PER_USER` of the gateway. */
export const MAX_KEYS_PER_USER = 100;

const CLOB_AUTH_MESSAGE =
  'This message attests that I control the given wallet';
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HEX_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
const U64_MAX = (1n << 64n) - 1n;

export interface CredentialRecord {
  apiKey: string;
  secret: string;
  passphrase: string;
}

/** One request that reached a handler. */
export interface OrderbookRequest {
  method: string;
  path: string;
  /** The query string with its `?`, or `''`. */
  search: string;
  body: string;
  headers: Headers;
}

export type Route = 'derive' | 'create';

export interface Orderbook {
  /** "METHOD /path" for every request that reached a handler. */
  calls: string[];
  requests: OrderbookRequest[];
  /** The credentials the gateway holds, by lower-case address, oldest first. */
  keys: Map<string, CredentialRecord[]>;
  /**
   * The deployed Kernel accounts, by lower-case address, with their owner. Only these pass
   * a non-ECDSA (EIP-1271) L1 check. Remove an entry to make the account undeployed.
   */
  smartAccounts: Map<string, Address>;
  /** The most keys a user may hold. */
  maxKeysPerUser: number;
  /** Answers instead of the normal handling, before any check. */
  override?: (route: Route) => Response | undefined;
  /** Answers a `DELETE /auth/api-key` instead of the normal handling, before any check. */
  deleteOverride?: () => Response | undefined;
  /** The API keys `DELETE /auth/api-key` deleted, in order. */
  deleted: string[];
  /**
   * Changes the body of a 200, or replaces it by any JSON value or a whole `Response`.
   * Returning `undefined` leaves it as it is.
   */
  shape?: (route: Route, body: CredentialRecord) => unknown;
}

export interface OrderbookOptions {
  chainId?: number;
  /** The Kernel accounts that are deployed: account (lower case) -> owner. */
  smartAccounts?: Record<string, { owner: Address }>;
  /** The gateway's clock in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  maxKeysPerUser?: number;
}

/** A credential as the gateway makes it: a UUID, 32 random bytes as padded base64url, 16 random bytes as hex. */
export function newCredential(): CredentialRecord {
  return {
    apiKey: randomUUID(),
    secret: randomBytes(32)
      .toString('base64')
      .replaceAll('+', '-')
      .replaceAll('/', '_'),
    passphrase: randomBytes(16).toString('hex'),
  };
}

/** Gives `address` an existing key, as if it had logged in before. */
export function seedKey(
  orderbook: Orderbook,
  address: string,
): CredentialRecord {
  const credential = newCredential();
  const owned = orderbook.keys.get(address.toLowerCase()) ?? [];
  owned.push(credential);
  orderbook.keys.set(address.toLowerCase(), owned);
  return credential;
}

/** A gateway error: every error is `{ error: <message> }`. */
export const gatewayError = (status: number, message: string): Response =>
  HttpResponse.json({ error: message }, { status });

const unauthorized = (message: string): Response => gatewayError(401, message);

/** The digest the gateway builds to check the L1 headers. */
function clobAuthDigest(
  chainId: number,
  address: Address,
  timestamp: string,
  nonce: bigint,
): Hex {
  return hashTypedData({
    domain: { name: 'ClobAuthDomain', version: '1', chainId },
    types: {
      ClobAuth: [
        { name: 'address', type: 'address' },
        { name: 'timestamp', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'message', type: 'string' },
      ],
    },
    primaryType: 'ClobAuth',
    message: { address, timestamp, nonce, message: CLOB_AUTH_MESSAGE },
  });
}

/** The ERC-1271 digest a Kernel v3.1 account checks: `Kernel(bytes32 hash)` under the account's domain. */
export function kernelWrap(hash: Hex, account: Address, chainId: number): Hex {
  return hashTypedData({
    domain: {
      name: 'Kernel',
      version: '0.3.1',
      chainId,
      verifyingContract: account,
    },
    types: { Kernel: [{ name: 'hash', type: 'bytes32' }] },
    primaryType: 'Kernel',
    message: { hash },
  });
}

export async function recovers(
  hash: Hex,
  signature: Hex,
  expected: Address,
): Promise<boolean> {
  try {
    const recovered = await recoverAddress({ hash, signature });
    return recovered.toLowerCase() === expected.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * The gateway's L1 check: the lower-case address the L1 headers prove, or the 401.
 * `requested` is the `address` of the query or the body, which must match when present.
 */
async function verifyL1(
  orderbook: Orderbook,
  request: Request,
  chainId: number,
  now: () => number,
  requested: string | undefined,
): Promise<string | Response> {
  const header = (name: string) => request.headers.get(name) ?? undefined;
  const claimedText = header('XO_ADDRESS');
  if (claimedText === undefined) {
    return unauthorized('L1 ClobAuth headers required');
  }
  const signature = header('XO_SIGNATURE');
  if (signature === undefined) {
    return unauthorized('missing XO_SIGNATURE header');
  }
  const timestamp = header('XO_TIMESTAMP');
  if (timestamp === undefined) {
    return unauthorized('missing XO_TIMESTAMP header');
  }
  const nonceText = header('XO_NONCE') ?? '0';
  if (!/^\d+$/.test(timestamp) || BigInt(timestamp) > U64_MAX) {
    return unauthorized('invalid L1 timestamp');
  }
  if (Math.abs(Math.floor(now() / 1000) - Number(timestamp)) > L1_WINDOW_SEC) {
    return unauthorized('L1 timestamp too old or too far in future');
  }
  if (!ADDRESS_PATTERN.test(claimedText)) {
    return unauthorized('XO_ADDRESS must be 20 bytes');
  }
  if (!/^\d+$/.test(nonceText) || BigInt(nonceText) > U64_MAX) {
    return unauthorized('invalid L1 nonce');
  }
  if (!HEX_PATTERN.test(signature)) {
    return unauthorized('invalid signature encoding');
  }
  const claimed = getAddress(claimedText.toLowerCase());
  const digest = clobAuthDigest(chainId, claimed, timestamp, BigInt(nonceText));

  let valid = false;
  if (size(signature as Hex) === 65) {
    valid = await recovers(digest, signature as Hex, claimed);
  }
  if (!valid) {
    // The EIP-1271 path: the gateway asks the account over `eth_call`.
    const owner = orderbook.smartAccounts.get(claimed.toLowerCase());
    if (owner === undefined) {
      return unauthorized(
        'L1 signature invalid (ECDSA failed; EIP-1271: the account has no code, so isValidSignature cannot be called)',
      );
    }
    const wrapped = kernelWrap(digest, claimed, chainId);
    valid =
      size(signature as Hex) === 66 &&
      slice(signature as Hex, 0, 1) === '0x00' &&
      (await recovers(wrapped, slice(signature as Hex, 1), owner));
    if (!valid) {
      return unauthorized(
        'L1 signature invalid (ECDSA failed; EIP-1271: isValidSignature rejected the signature)',
      );
    }
  }
  if (
    requested !== undefined &&
    claimed.toLowerCase() !== requested.toLowerCase()
  ) {
    return unauthorized('L1 auth address does not match request address');
  }
  return claimed.toLowerCase();
}

/**
 * The L2 signature, written out from the gateway's definition (not taken from the SDK):
 * URL-safe base64 (padding kept) of HMAC-SHA256(base64Decode(secret), timestamp + METHOD +
 * path + body). Node's base64 decoder takes both alphabets.
 */
function l2Signature(
  secret: string,
  timestamp: string,
  method: string,
  path: string,
  body: string,
): string {
  return createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(`${timestamp}${method.toUpperCase()}${path}${body}`)
    .digest('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_');
}

/** The lower-case address whose key signed the request, or the 401. */
export function verifyL2(
  orderbook: Orderbook,
  request: Request,
  path: string,
  body: string,
  now: () => number,
): string | Response {
  const header = (name: string) => request.headers.get(name) ?? undefined;
  const apiKey = header('XO_API_KEY');
  const passphrase = header('XO_PASSPHRASE');
  const timestamp = header('XO_TIMESTAMP');
  const signature = header('XO_SIGNATURE');
  if (
    apiKey === undefined ||
    passphrase === undefined ||
    timestamp === undefined ||
    signature === undefined
  ) {
    return unauthorized('L2 auth headers required');
  }
  let owner: string | undefined;
  let credential: CredentialRecord | undefined;
  for (const [address, owned] of orderbook.keys) {
    credential = owned.find((c) => c.apiKey === apiKey);
    if (credential !== undefined) {
      owner = address;
      break;
    }
  }
  if (owner === undefined || credential === undefined) {
    return unauthorized('unknown API key');
  }
  if (credential.passphrase !== passphrase) {
    return unauthorized('invalid passphrase');
  }
  if (
    !/^\d+$/.test(timestamp) ||
    Math.abs(Math.floor(now() / 1000) - Number(timestamp)) > L2_WINDOW_SEC
  ) {
    return unauthorized('L2 timestamp too old or too far in future');
  }
  const expected = l2Signature(
    credential.secret,
    timestamp,
    request.method,
    path,
    body,
  );
  if (signature !== expected) {
    return unauthorized('invalid L2 signature');
  }
  return owner;
}

type Parsed =
  | { ok: true; address: string | undefined }
  | { ok: false; response: Response };

/** The optional body of the key route: empty or `null` is the default. */
function parseCreateBody(text: string): Parsed {
  if (text.trim() === '' || text.trim() === 'null') {
    return { ok: true, address: undefined };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      ok: false,
      response: gatewayError(400, 'request body is not valid JSON'),
    };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      response: gatewayError(422, 'request body must be a JSON object'),
    };
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== 'address')) {
    return {
      ok: false,
      response: gatewayError(422, 'unknown field in request body'),
    };
  }
  if (body.address !== undefined && typeof body.address !== 'string') {
    return {
      ok: false,
      response: gatewayError(422, 'address must be a string'),
    };
  }
  return { ok: true, address: body.address as string | undefined };
}

/**
 * Installs the handlers on `server` and returns the live state of the fake gateway. Call it
 * in a test, after `server.listen()`; `server.resetHandlers()` removes the handlers.
 */
export function installOrderbook(
  server: SetupServer,
  options: OrderbookOptions = {},
): Orderbook {
  const chainId = options.chainId ?? env.chainId;
  const now = options.now ?? (() => Date.now());
  const orderbook: Orderbook = {
    calls: [],
    requests: [],
    keys: new Map(),
    smartAccounts: new Map(
      Object.entries(options.smartAccounts ?? {}).map(
        ([account, { owner }]) => [account.toLowerCase(), owner],
      ),
    ),
    maxKeysPerUser: options.maxKeysPerUser ?? MAX_KEYS_PER_USER,
    deleted: [],
  };

  async function record(request: Request, path: string): Promise<string> {
    const url = new URL(request.url);
    const body = await request.text();
    orderbook.calls.push(`${request.method} ${path}`);
    orderbook.requests.push({
      method: request.method,
      path,
      search: url.search,
      body,
      headers: request.headers,
    });
    return body;
  }

  const credentialResponse = (
    route: Route,
    credential: CredentialRecord,
  ): Response => {
    // `undefined` leaves the body as it is; anything else, `null` included, replaces it.
    const changed = orderbook.shape?.(route, credential);
    const shaped = changed === undefined ? credential : changed;
    return shaped instanceof Response
      ? shaped
      : HttpResponse.json(shaped as Record<string, unknown>);
  };

  server.use(
    http.get(DERIVE_URL, async ({ request }) => {
      await record(request, DERIVE_PATH);
      const overridden = orderbook.override?.('derive');
      if (overridden !== undefined) {
        return overridden;
      }
      const params = new URL(request.url).searchParams;
      const nonce = params.get('nonce');
      if (nonce !== null && (!/^\d+$/.test(nonce) || BigInt(nonce) > U64_MAX)) {
        return gatewayError(400, 'invalid nonce');
      }
      const address = await verifyL1(
        orderbook,
        request,
        chainId,
        now,
        params.get('address') ?? undefined,
      );
      if (address instanceof Response) {
        return address;
      }
      // The oldest key, so a repeat caller sees a stable result. Derive never mints.
      const existing = orderbook.keys.get(address)?.[0];
      if (existing === undefined) {
        return gatewayError(404, `no API key found for address ${address}`);
      }
      return credentialResponse('derive', existing);
    }),

    http.post(CREATE_URL, async ({ request }) => {
      const text = await record(request, CREATE_PATH);
      const overridden = orderbook.override?.('create');
      if (overridden !== undefined) {
        return overridden;
      }
      const parsed = parseCreateBody(text);
      if (!parsed.ok) {
        return parsed.response;
      }
      const address = await verifyL1(
        orderbook,
        request,
        chainId,
        now,
        parsed.address,
      );
      if (address instanceof Response) {
        return address;
      }
      const owned = orderbook.keys.get(address) ?? [];
      if (owned.length >= orderbook.maxKeysPerUser) {
        return gatewayError(
          400,
          `maximum ${orderbook.maxKeysPerUser} API keys per user reached`,
        );
      }
      const credential = newCredential();
      owned.push(credential);
      orderbook.keys.set(address, owned);
      return credentialResponse('create', credential);
    }),

    http.delete(CREATE_URL, async ({ request }) => {
      const text = await record(request, CREATE_PATH);
      const overridden = orderbook.deleteOverride?.();
      if (overridden !== undefined) {
        return overridden;
      }
      const caller = verifyL2(orderbook, request, CREATE_PATH, text, now);
      if (caller instanceof Response) {
        return caller;
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return gatewayError(400, 'invalid request body: not JSON');
      }
      if (
        typeof body !== 'object' ||
        body === null ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => key !== 'apiKey') ||
        typeof (body as { apiKey?: unknown }).apiKey !== 'string'
      ) {
        return gatewayError(400, 'invalid request body: expected { apiKey }');
      }
      const apiKey = (body as { apiKey: string }).apiKey;
      let owner: string | undefined;
      for (const [address, owned] of orderbook.keys) {
        if (owned.some((c) => c.apiKey === apiKey)) {
          owner = address;
        }
      }
      if (owner === undefined) {
        return gatewayError(404, `API key not found: ${apiKey}`);
      }
      if (owner !== caller) {
        return gatewayError(
          403,
          'API key does not belong to the authenticated caller',
        );
      }
      orderbook.keys.set(
        owner,
        (orderbook.keys.get(owner) ?? []).filter((c) => c.apiKey !== apiKey),
      );
      orderbook.deleted.push(apiKey);
      return HttpResponse.json({ deleted: true });
    }),

    http.get(ORDERS_URL, async ({ request }) => {
      const body = await record(request, ORDERS_PATH);
      const owner = verifyL2(orderbook, request, ORDERS_PATH, body, now);
      if (owner instanceof Response) {
        return owner;
      }
      return HttpResponse.json([]);
    }),
  );

  return orderbook;
}
