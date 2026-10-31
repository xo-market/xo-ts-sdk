const REDACTED = '[redacted]';
const CIRCULAR = '[Circular]';

// A key is normalized by lower-casing it and removing '-' and '_'
// (so `XO_API_KEY`, `x-api-key` and `apiKey` all become `...apikey`).
// It is sensitive when the normalized key EQUALS one of these...
const SENSITIVE_EXACT = new Set([
  'secret',
  'passphrase',
  'key',
  'privatekey',
  'signature',
  'apikey',
  'token',
  'authorization',
  'cookie',
  'setcookie',
]);
// ...or ENDS WITH one of these (`accessToken`, `clientSecret`, `XO_SIGNATURE`).
// `key` is exact-only on purpose, so `monkey` and `keyboard` stay visible.
const SENSITIVE_SUFFIXES = [
  'secret',
  'passphrase',
  'privatekey',
  'signature',
  'apikey',
  'authorization',
  'token',
];

const API_KEY_PATTERN = /xo_sk_[A-Za-z0-9_]+/g;

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, '');
  return (
    SENSITIVE_EXACT.has(normalized) ||
    SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

type Entry = [key: string, value: unknown];

/** The entries of a non-array object, ready to be redacted one by one. */
function entriesOf(value: object): Entry[] {
  if (typeof Headers !== 'undefined' && value instanceof Headers) {
    return [...value.entries()];
  }
  if (value instanceof Map) {
    return [...value.entries()].map(([key, item]) => [
      typeof key === 'string' ? key : String(key),
      item,
    ]);
  }
  if (value instanceof Error) {
    // `message` and `stack` are not enumerable, and `name` usually lives on the
    // prototype, so they are listed explicitly. Own enumerable props come after
    // and win a clash, which is harmless because they are redacted the same way.
    const entries: Entry[] = [
      ['name', value.name],
      ['message', value.message],
      ['stack', value.stack],
    ];
    if (value.cause !== undefined) {
      entries.push(['cause', value.cause]);
    }
    return [...entries, ...Object.entries(value)];
  }
  // Plain objects and any other object (class instances): own enumerable props.
  return Object.entries(value);
}

function walk(value: unknown, ancestors: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return value.replace(API_KEY_PATTERN, REDACTED);
  }
  if (typeof value !== 'object' || value === null || value instanceof Date) {
    return value;
  }

  // `ancestors` holds only the objects on the current path, so a shared (non-cyclic)
  // reference is redacted each time it appears and only a real cycle is cut.
  if (ancestors.has(value)) {
    return CIRCULAR;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => walk(item, ancestors));
    }
    if (value instanceof Set) {
      return [...value].map((item) => walk(item, ancestors));
    }
    return Object.fromEntries(
      entriesOf(value).map(([key, item]) => [
        key,
        isSensitiveKey(key) ? REDACTED : walk(item, ancestors),
      ]),
    );
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Returns a copy of `value` that is safe to log. It fails closed: nothing is returned
 * by reference except functions and `Date`s.
 *
 * - Keys that look secret (`secret`, `passphrase`, `key`, `privateKey`, `signature`,
 *   `apiKey`, `token`, `authorization`, `cookie`, `setCookie`, or ending in
 *   `secret`/`passphrase`/`privateKey`/`signature`/`apiKey`/`authorization`/`token`;
 *   case, `-` and `_` ignored) have their whole value replaced with `"[redacted]"`.
 * - Any `xo_sk_...` API key inside other strings is replaced in place.
 * - `Headers`, `Map`s and class instances become plain objects, `Set`s become arrays,
 *   and an `Error` becomes `{ name, message, stack, cause, ...own props }`.
 * - Cycles become `"[Circular]"`. The input is never mutated.
 */
export function redact(value: unknown): unknown {
  return walk(value, new WeakSet());
}
