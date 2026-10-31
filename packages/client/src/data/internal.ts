// Internal: plumbing shared by the data client and its namespaces. Not re-exported from any
// barrel.

import type { Session } from '../auth/session';
import { AuthRequiredError } from '../core/errors';
import type { CallOptions } from '../core/requestOptions';
import { type DualSchema, parseResponse } from '../core/schema';
import type { Transport } from '../core/transport';
import type { Query } from './params';
import { expandPath, type RouteKey, routes } from './routes';

/** What a request to one route needs. */
export interface RouteOptions {
  /** Values for the `:name` segments of the route, already validated and encoded. */
  params?: Record<string, string>;
  query?: Query;
}

/** What a read of one route needs: the route's values and the caller's per-call options. */
export interface GetOptions extends RouteOptions {
  /** The caller's timeout, retries and signal. Left out: the transport's defaults. */
  call?: CallOptions;
}

/** What the namespaces get from the client. */
export interface DataDeps {
  /**
   * Sends one GET to the route `key` and checks the answer against `schema`. A `public`
   * route carries no credentials whatever the client holds; a `shared` route carries the
   * client's backend credentials, and fails at once with an `AuthRequiredError` (nothing
   * sent) when the session has neither a signer nor a key.
   */
  get<T>(key: RouteKey, schema: DualSchema<T>, o?: GetOptions): Promise<T>;
  readonly session: Session | undefined;
}

/**
 * What a `shared` route says when the session cannot get a backend key. It names both ways to
 * give one, as the session's own message does.
 */
export const NO_BACKEND_CREDENTIAL =
  'This request needs a backend API key, but the session has neither a signer nor a key: pass the `signer` option to log in with a wallet, or `credentials: { backend: { apiKey } }` to use an existing key';

/**
 * Whether the session can never produce a backend key: no signer to log in with and no key
 * held. A closed session is left to its own `session_closed` error.
 */
export function cannotAuthenticate(session: Session): boolean {
  return (
    session.toJSON().closed !== true &&
    !session.hasSigner() &&
    !session.hasBackendCredential()
  );
}

/** Builds the deps over a transport. `strict` rejects response fields the schemas do not know. */
export function createDeps(o: {
  transport: Transport;
  session?: Session;
  strict: boolean;
}): DataDeps {
  const { transport, strict, session } = o;

  async function send(
    key: RouteKey,
    request: GetOptions,
  ): Promise<{ data: unknown; path: string }> {
    const route = routes[key];
    const shared = route.access === 'shared';
    if (shared && session !== undefined && cannotAuthenticate(session)) {
      throw new AuthRequiredError(NO_BACKEND_CREDENTIAL, {
        service: 'backend',
      });
    }
    const path = expandPath(route.path, request.params);
    const data = await transport.request({
      service: 'backend',
      method: route.method,
      path,
      query: request.query,
      auth: shared ? 'backend' : 'none',
      call: request.call,
    });
    return { data, path };
  }

  return {
    session,
    async get(key, schema, request = {}) {
      const { data, path } = await send(key, request);
      return parseResponse(schema, data, { strict, service: 'backend', path });
    },
  };
}
