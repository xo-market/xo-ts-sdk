import type { PublicClient } from './public';
import type { SecureClient } from './secure';

// The two kinds of client, told apart at run time. A client carries its kind under a symbol
// no other module can reach, set where the client is made and not enumerable, so a copy of a
// client (a spread, a JSON round trip) is neither. Internal: the package entry exports only
// the two guards.

const KIND = Symbol('xo.client.kind');

/** The kinds of client. */
type ClientKind = 'public' | 'secure';

/**
 * Marks `client` as a client of `kind`. Each factory calls it once, on the object it returns.
 *
 * @internal
 */
export function brandClient<T extends object>(client: T, kind: ClientKind): T {
  Object.defineProperty(client, KIND, { value: kind });
  return client;
}

function kindOf(value: unknown): ClientKind | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const kind: unknown = (value as { [KIND]?: unknown })[KIND];
  return kind === 'public' || kind === 'secure' ? kind : undefined;
}

/**
 * Whether `value` is a client made by `createPublicClient`: a client that reads public data
 * only. A client that signed in is not a public client; see {@link isSecureClient}. Only a
 * client of the same build of this package is recognised: one made by its CommonJS build is
 * not, to code that imports its ES module, and the reverse.
 *
 * @example
 * const client: unknown = createPublicClient();
 * if (isPublicClient(client)) {
 *   console.log(await client.fetchTradingState());
 * }
 */
export function isPublicClient(value: unknown): value is PublicClient {
  return kindOf(value) === 'public';
}

/**
 * Whether `value` is a client made by `createSecureClient`: a client that signed in with a
 * wallet. A client made by `createPublicClient` is not. Only a client of the same build of
 * this package is recognised: one made by its CommonJS build is not, to code that imports its
 * ES module, and the reverse.
 *
 * @example
 * const client: unknown = await createSecureClient({ signer });
 * if (isSecureClient(client)) {
 *   console.log(client.wallet);
 * }
 */
export function isSecureClient(value: unknown): value is SecureClient {
  return kindOf(value) === 'secure';
}
