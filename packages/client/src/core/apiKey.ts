// Internal: not re-exported from `src/index.ts` or `src/node.ts`.

/**
 * What a backend API key looks like to the SDK: `xo_sk_` and at least one more visible
 * ASCII character. A header value cannot carry anything else, and whitespace or a control
 * character is a sign of a damaged key. The transport checks a key with this before it
 * sends it, and the backend login checks a key it was just given.
 */
export const BACKEND_KEY_PATTERN = /^xo_sk_[\x21-\x7e]+$/;

/** Whether `value` is a string that looks like a backend API key. */
export function isBackendKey(value: unknown): value is string {
  return typeof value === 'string' && BACKEND_KEY_PATTERN.test(value);
}

/**
 * What a credential value that goes into a request header looks like to the SDK: 1 to 256
 * visible ASCII characters, so no whitespace, no control character and nothing outside
 * ASCII. A header cannot carry anything else, and whitespace or a control character is a
 * sign of a damaged value (or of an attempt to inject a header). The transport checks the
 * explicit L1 headers with it, and the orderbook login checks the `apiKey` and the
 * `passphrase` it was just given, which later become L2 headers.
 */
export const HEADER_VALUE_PATTERN = /^[\x21-\x7e]{1,256}$/;

/** Whether `value` is a string that is safe to send as a credential header value. */
export function isHeaderValue(value: unknown): value is string {
  return typeof value === 'string' && HEADER_VALUE_PATTERN.test(value);
}
