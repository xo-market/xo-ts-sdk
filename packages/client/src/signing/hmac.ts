import { UserInputError } from '../core/errors';
import { assertNonEmptyString, assertTimestamp } from './internal';

/** The L2 credentials the orderbook issues for a wallet. */
export interface OrderbookCredential {
  apiKey: string;
  /** URL-safe base64, normally 44 characters with `=` padding. */
  secret: string;
  passphrase: string;
}

// The base64 and base64url alphabets together, then up to two `=` at the very end.
const SECRET_PATTERN = /^([A-Za-z0-9+/_-]*)(={0,2})$/;

// A fixed message: it must never repeat any part of the secret. The whitespace hint is
// there because a secret copied from a file or a shell often ends with a newline.
const INVALID_SECRET =
  'secret is not valid base64 or base64url: it has a character outside the alphabet, bad padding or an impossible length. Whitespace and newlines are not trimmed: remove them from the secret';

/**
 * Decodes a secret written in the standard (`+/`) or the URL-safe (`-_`) alphabet,
 * padded or not. Anything else is an error: a corrupted secret must fail here, loudly,
 * and not turn into a 401 from the gateway. Whitespace is not trimmed.
 *
 * The two alphabets may be mixed in one secret (for example `-` next to `/`): `+` and `-`
 * are the same digit, and so are `/` and `_`, so the bytes are unambiguous. This is
 * accepted on purpose.
 *
 * The error never contains the secret or any part of it: not a character, a position or
 * the length.
 */
function decodeSecret(secret: unknown): Uint8Array<ArrayBuffer> {
  const match = SECRET_PATTERN.exec(assertNonEmptyString(secret, 'secret'));
  const body = match?.[1] ?? '';
  const padding = match?.[2] ?? '';
  // A remainder of 1 character can never come out of a base64 encoder. If `=` is there,
  // it must round the length up to a multiple of 4.
  if (
    match === null ||
    body.length % 4 === 1 ||
    (padding !== '' && (body.length + padding.length) % 4 !== 0)
  ) {
    throw new UserInputError(INVALID_SECRET);
  }
  const standard = body.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(standard + '='.repeat((4 - (standard.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Whether `secret` is a secret that {@link hmacSignature} can use: base64 or base64url,
 * padded or not (see the rules above). Never throws, and never reveals why a secret is
 * refused. It is for code that must reject a bad secret before it is stored or used, such
 * as the orderbook login.
 *
 * Internal: the signing index must not re-export it.
 */
export function isValidSecret(secret: unknown): boolean {
  try {
    decodeSecret(secret).fill(0);
    return true;
  } catch {
    return false;
  }
}

/** URL-safe base64 that keeps the `=` padding: only `+` and `/` are swapped. */
function encodeUrlSafe(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_');
}

function assertPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    throw new UserInputError('path must be a string that starts with "/"');
  }
  // The message never repeats the path: it may carry a query with ids or cursors.
  if (value.includes('?') || value.includes('#')) {
    throw new UserInputError(
      'path must not contain "?" or "#": sign the path without its query string',
    );
  }
  return value;
}

function assertBody(value: unknown): string {
  if (typeof value !== 'string') {
    throw new UserInputError(`body must be a string, not ${typeof value}`);
  }
  return value;
}

/**
 * The L2 signature of one request:
 * `urlSafeBase64(HMAC-SHA256(base64Decode(secret), timestamp + METHOD + path + body))`.
 *
 * The result is URL-safe base64 with the `=` padding kept (`+/` become `-_`). The secret
 * may be in the standard or the URL-safe alphabet, padded or not.
 *
 * - `method` is upper-cased.
 * - `path` is the request path only: no query string and no fragment. A path with `?` or
 *   `#` is rejected, because the gateway does not sign the query.
 * - `body` is the exact string that is sent (`''` when there is none).
 * @throws UserInputError if the secret is not valid base64, `timestamp` is not a string of decimal digits, `method` is empty, `path` does not start with `/` or has `?` or `#`, or `body` is not a string. No message contains the secret.
 */
export async function hmacSignature(
  secret: string,
  timestamp: string,
  method: string,
  path: string,
  body: string,
): Promise<string> {
  // Validate the request first, so a rejected request never decodes the secret.
  const message =
    assertTimestamp(timestamp, 'timestamp') +
    assertNonEmptyString(method, 'method').toUpperCase() +
    assertPath(path) +
    assertBody(body);
  const key = decodeSecret(secret);
  // The lib has no DOM types, so the key type is read from the call.
  let cryptoKey: Awaited<ReturnType<typeof crypto.subtle.importKey>>;
  try {
    cryptoKey = await crypto.subtle.importKey(
      'raw',
      key,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } finally {
    // Best effort: importKey copies the bytes, so the decoded secret need not stay in
    // memory. The string forms of the secret cannot be wiped.
    key.fill(0);
  }
  const signature = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    new TextEncoder().encode(message),
  );
  return encodeUrlSafe(new Uint8Array(signature));
}

/**
 * The L2 request headers for one orderbook call. See {@link hmacSignature} for what is
 * signed. Nothing here logs, and no error contains the secret or the passphrase.
 * @throws UserInputError if the credential is missing a field or the signature inputs are invalid (see {@link hmacSignature}).
 */
export async function l2Headers(
  c: OrderbookCredential,
  timestamp: string,
  method: string,
  path: string,
  body: string,
): Promise<
  Record<
    'XO_API_KEY' | 'XO_PASSPHRASE' | 'XO_TIMESTAMP' | 'XO_SIGNATURE',
    string
  >
> {
  if (typeof c !== 'object' || c === null) {
    throw new UserInputError('credential must be an object');
  }
  const apiKey = assertNonEmptyString(c.apiKey, 'apiKey');
  const passphrase = assertNonEmptyString(c.passphrase, 'passphrase');
  return {
    XO_API_KEY: apiKey,
    XO_PASSPHRASE: passphrase,
    XO_TIMESTAMP: timestamp,
    XO_SIGNATURE: await hmacSignature(c.secret, timestamp, method, path, body),
  };
}
