import { isBackendKey, isHeaderValue } from './apiKey';
import { type EnvironmentConfig, LOCAL_HOSTS } from './env';
import {
  AuthRequiredError,
  parseServiceError,
  RateLimitError,
  RequestAbortedError,
  RequestRejectedError,
  TimeoutError,
  TransportError,
  UnexpectedResponseError,
  UserInputError,
  type XoError,
} from './errors';
import {
  type CallOptions,
  checkCallOptions,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
} from './requestOptions';
import {
  DEFAULT_MAX_RETRIES,
  isRetryableStatus,
  retryDelayMs,
  sleep,
} from './retry';
import { processShared } from './shared';
import type { Service } from './types';

/**
 * Errors that left a request before any of it reached the service: thrown by the auth
 * provider before the first attempt was sent, or by its refresh after a 401 (the service did
 * not process a request it answered 401), and a caller's abort seen before any attempt was
 * sent. Such an error can still carry a status of its own, for example the 503 of an
 * orderbook derive, so its class and status do not say it.
 */
const NOT_SENT = processShared(
  'not-sent.v1',
  () => new WeakSet<object>(),
  (value): value is WeakSet<object> => value instanceof WeakSet,
);

function markNotSent(error: unknown): unknown {
  if (typeof error === 'object' && error !== null) {
    NOT_SENT.add(error);
  }
  return error;
}

/**
 * @internal Whether `error` left `Transport.request` before anything of the request reached
 * the service (see {@link NOT_SENT}), so whatever it asked for did not happen.
 */
export function wasNotSent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && NOT_SENT.has(error);
}

/**
 * @internal Marks `copy`, a copy of `original` made to carry something per call (see the bridge
 * client's `withPaymentId`), as not sent when `original` was: it is the same failure, so
 * {@link wasNotSent} must say the same of both.
 */
export function copyNotSent(original: unknown, copy: unknown): void {
  if (wasNotSent(original)) {
    markNotSent(copy);
  }
}

/** Which credentials a request carries. `'none'` is for public endpoints. */
export type AuthKind = 'none' | 'backend' | 'orderbook';

/**
 * A backend request that carries one specific `xo_sk_...` key instead of the client's
 * own credentials. Rotation needs it: the old key must revoke itself while the client
 * already uses the new one.
 */
export interface ExplicitBackendKey {
  kind: 'backend';
  key: string;
}

/** The four L1 (ClobAuth) headers of the orderbook gateway. */
export type OrderbookL1HeaderName =
  | 'XO_ADDRESS'
  | 'XO_SIGNATURE'
  | 'XO_TIMESTAMP'
  | 'XO_NONCE';

/**
 * An orderbook request that carries the given L1 (ClobAuth) headers as they are. Creating
 * or deriving the L2 credentials needs it: the wallet signs the L1 headers once, and the
 * credentials do not exist yet. The headers are sent on every attempt.
 */
export interface ExplicitOrderbookL1 {
  kind: 'orderbookL1';
  headers: Record<OrderbookL1HeaderName, string>;
}

/**
 * The four L2 (HMAC) headers of the orderbook gateway.
 *
 * @internal
 */
export type OrderbookL2HeaderName =
  | 'XO_API_KEY'
  | 'XO_PASSPHRASE'
  | 'XO_TIMESTAMP'
  | 'XO_SIGNATURE';

/**
 * An orderbook request signed with one given L2 credential instead of the client's own:
 * `sign` returns the four L2 headers for an attempt, and is called again for each attempt (an
 * HMAC timestamp must be fresh). Deleting an API key needs it: the key signs its own deletion,
 * whatever the session holds, and a 401 must not make the session sign in again.
 *
 * @internal
 */
export interface ExplicitOrderbookL2 {
  kind: 'orderbookL2';
  sign(req: {
    method: string;
    path: string;
    body: string;
  }): Promise<Record<OrderbookL2HeaderName, string>>;
}

/** What `onUnauthorized` is told about the attempt the server refused with a 401. */
export interface UnauthorizedContext {
  /**
   * A copy of the headers `headers()` returned for that attempt, so a provider can tell a
   * 401 for an old credential from a 401 for its current one. They hold credentials: the
   * transport passes them in process only and never logs them.
   */
  headers: Record<string, string>;
}

/**
 * Supplies credentials to the transport. The transport asks for headers on every
 * attempt (an HMAC timestamp must be fresh) and calls `onUnauthorized` at most once
 * per request when the server answers 401.
 *
 * Both methods run outside the request timeout and the caller's abort signal: neither
 * is cancelled when the timeout fires or the signal aborts (minting a credential is a write,
 * and aborting it would not undo it). The transport checks the signal again once they return,
 * and sends nothing more when it has aborted. A provider must bound its own latency (for
 * example, give any network call it makes its own timeout).
 */
export interface AuthProvider {
  /**
   * The headers to add to one attempt. `path` excludes the query string and `body` is
   * the exact string that is sent (`''` when there is no body).
   */
  headers(
    kind: Exclude<AuthKind, 'none'>,
    req: { method: string; path: string; body: string },
  ): Promise<Record<string, string>>;
  /** Resolves true when the credentials were refreshed and the request may be retried once. */
  onUnauthorized(
    kind: Exclude<AuthKind, 'none'>,
    ctx: UnauthorizedContext,
  ): Promise<boolean>;
}

/**
 * What a client's rate-limit callback receives, once per response that carries a rate-limit
 * header and once per 429. Fields the response did not carry are left out.
 *
 * @example
 * const client = createPublicClient({
 *   onRateLimitUpdate: (update) => {
 *     if (update.remaining === 0) {
 *       console.log(`${update.service} limit reached; resets in ${update.resetMs} ms`);
 *     }
 *   },
 * });
 */
export interface RateLimitUpdate {
  service: Service;
  /** The request path, without the query. */
  path: string;
  /** How long the service asks to wait, in milliseconds: from `retry_after_ms` or `Retry-After` on a 429. */
  retryAfter?: number;
  /** From `X-RateLimit-Limit`. */
  limit?: number;
  /** From `X-RateLimit-Remaining`. */
  remaining?: number;
  /** From `X-RateLimit-Reset`, which is in seconds, converted to milliseconds. */
  resetMs?: number;
}

/** One request to a service, for {@link Transport.request}. */
export interface TransportRequest {
  service: 'backend' | 'orderbook' | 'sponsor';
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** The full path, starting with `/`. Backend paths include `/api`. */
  path: string;
  /** Query parameters. `undefined` values are skipped. */
  query?: Record<string, string | number | boolean | undefined>;
  /** Serialized once with `JSON.stringify`. */
  body?: unknown;
  /**
   * Defaults to `'none'`. An {@link ExplicitBackendKey} sends `Authorization: Bearer <key>`
   * and an {@link ExplicitOrderbookL1} sends its four `XO_*` headers. Neither consults the
   * {@link AuthProvider}: it is asked for no headers, and a 401 is not refreshed or
   * retried. A key is allowed for the `'backend'` service only, L1 headers for the
   * `'orderbook'` service only.
   *
   * Any auth other than `'none'` is refused with a `UserInputError` (code
   * `insecure_transport`) unless the service URL is `https:` or `http:` to `localhost`,
   * `127.0.0.1` or `[::1]`.
   */
  auth?: AuthKind | ExplicitBackendKey | ExplicitOrderbookL1;
  /** Defaults to `'read'` for GET and HEAD and `'none'` for every other method. */
  retry?: 'read' | 'none';
  /**
   * The caller's abort signal. Aborting rejects with a `RequestAbortedError` whose `cause` is
   * the signal's reason, and is never retried.
   */
  signal?: AbortSignal;
  /** Per attempt. Defaults to the transport's `defaultTimeoutMs`. */
  timeoutMs?: number;
  /**
   * The caller's per-call options, as `parseRequestOptions` builds them (checked again here,
   * before anything is sent). Its `timeoutMs` replaces
   * `timeoutMs` and the transport's default (`false`: no timer); its `retries` replaces the
   * transport's `maxRetries` for a request retried as a read (`retry: 'read'`) and changes
   * nothing for any other; its `signal` cancels the request like `signal` (both apply when both
   * are given).
   */
  call?: CallOptions;
}

/**
 * A request as the SDK's own modules may send it: its `auth` may also be an
 * {@link ExplicitOrderbookL2}, which sends the four headers its `sign` returns for each
 * attempt, to the `'orderbook'` service only. Like the other explicit forms it never consults
 * the {@link AuthProvider}, and a 401 is not refreshed or retried.
 *
 * @internal
 */
export interface InternalTransportRequest
  extends Omit<TransportRequest, 'auth'> {
  auth?: TransportRequest['auth'] | ExplicitOrderbookL2;
}

/** The options of {@link Transport}. */
export interface TransportOptions {
  env: EnvironmentConfig;
  /** The SDK version, sent as `X-XO-SDK: ts/<version>`. */
  version: string;
  /** Defaults to the global `fetch`, looked up on each request. */
  fetch?: typeof fetch;
  auth?: AuthProvider;
  /** Called with rate-limit information. Errors it throws are ignored. */
  onRateLimit?: (info: RateLimitUpdate) => void;
  /** Retries per read request after the first attempt. Defaults to 2. */
  maxRetries?: number;
  /** Per-attempt timeout. Defaults to 30000 ms. */
  defaultTimeoutMs?: number;
}

function checkTimeout(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new UserInputError(
      `${field} must be a whole number of milliseconds between 1 and ${MAX_TIMEOUT_MS}`,
    );
  }
  return value;
}

/** Strips one trailing slash. */
function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

const L1_HEADER_NAMES: readonly OrderbookL1HeaderName[] = [
  'XO_ADDRESS',
  'XO_SIGNATURE',
  'XO_TIMESTAMP',
  'XO_NONCE',
];

const L2_HEADER_NAMES: readonly OrderbookL2HeaderName[] = [
  'XO_API_KEY',
  'XO_PASSPHRASE',
  'XO_TIMESTAMP',
  'XO_SIGNATURE',
];

/** What {@link readAuth} found: the provider kind to use plus any explicit credential. */
interface ReadAuth {
  kind: AuthKind;
  /** The explicit backend key, if any. */
  key: string | undefined;
  /** A private copy of the explicit L1 headers, if any. */
  l1: Record<OrderbookL1HeaderName, string> | undefined;
  /** The signer of the explicit L2 headers, if any. */
  l2?: ExplicitOrderbookL2['sign'];
}

const AUTH_FORMS =
  "'none', 'backend', 'orderbook', { kind: 'backend', key }, { kind: 'orderbookL1', headers } or { kind: 'orderbookL2', sign }";

/**
 * The L2 headers `sign` returned for one attempt, checked: exactly the four names, each with a
 * header-safe value. A failure of `sign` itself passes through. Messages name a header from the
 * fixed list at most and never contain a value.
 */
async function signL2Headers(
  sign: ExplicitOrderbookL2['sign'],
  req: { method: string; path: string; body: string },
  label: string,
  service: Service,
): Promise<Record<OrderbookL2HeaderName, string>> {
  const headers: unknown = await sign(req);
  if (
    typeof headers !== 'object' ||
    headers === null ||
    Array.isArray(headers)
  ) {
    throw new UserInputError(
      `${label}: the L2 headers must be an object with ${L2_HEADER_NAMES.join(', ')}`,
      { service },
    );
  }
  const own = Object.keys(headers);
  if (
    own.length !== L2_HEADER_NAMES.length ||
    !L2_HEADER_NAMES.every((name) => own.includes(name))
  ) {
    throw new UserInputError(
      `${label}: the L2 headers must be exactly ${L2_HEADER_NAMES.join(', ')}`,
      { service },
    );
  }
  const copy = {} as Record<OrderbookL2HeaderName, string>;
  for (const name of L2_HEADER_NAMES) {
    const value = (headers as Record<string, unknown>)[name];
    if (!isHeaderValue(value)) {
      throw new UserInputError(
        `${label}: the ${name} header must be 1 to 256 visible ASCII characters without whitespace`,
        { service },
      );
    }
    copy[name] = value;
  }
  return copy;
}

/**
 * Checks explicit L1 headers and returns a private copy: exactly the four names, each with
 * a header-safe value (see {@link isHeaderValue}). Messages name a header from the fixed
 * list at most and never contain a value.
 */
function readL1Headers(
  headers: unknown,
  label: string,
  service: TransportRequest['service'],
): Record<OrderbookL1HeaderName, string> {
  if (
    typeof headers !== 'object' ||
    headers === null ||
    Array.isArray(headers)
  ) {
    throw new UserInputError(
      `${label}: the L1 headers must be an object with ${L1_HEADER_NAMES.join(', ')}`,
      { service },
    );
  }
  const own = Object.keys(headers);
  if (
    own.length !== L1_HEADER_NAMES.length ||
    !L1_HEADER_NAMES.every((name) => own.includes(name))
  ) {
    throw new UserInputError(
      `${label}: the L1 headers must be exactly ${L1_HEADER_NAMES.join(', ')}`,
      { service },
    );
  }
  const copy = {} as Record<OrderbookL1HeaderName, string>;
  for (const name of L1_HEADER_NAMES) {
    const value = (headers as Record<string, unknown>)[name];
    if (!isHeaderValue(value)) {
      throw new UserInputError(
        `${label}: the ${name} header must be 1 to 256 visible ASCII characters without whitespace`,
        { service },
      );
    }
    copy[name] = value;
  }
  return copy;
}

/**
 * Reads the `auth` option. Returns the explicit key, L1 headers or L2 signer (or none of
 * them) and the provider kind to use, which is `'none'` for an explicit credential so the
 * provider is never involved. Messages never contain the key or any header value.
 */
function readAuth(
  auth: InternalTransportRequest['auth'],
  service: TransportRequest['service'],
  label: string,
): ReadAuth {
  if (auth === undefined || typeof auth === 'string') {
    return { kind: auth ?? 'none', key: undefined, l1: undefined };
  }
  const explicit: unknown = auth;
  const kind =
    typeof explicit === 'object' && explicit !== null
      ? (explicit as { kind?: unknown }).kind
      : undefined;
  if (kind === 'orderbookL1') {
    if (service !== 'orderbook') {
      throw new UserInputError(
        `${label}: explicit L1 headers can only be sent to the orderbook service`,
        { service },
      );
    }
    return {
      kind: 'none',
      key: undefined,
      l1: readL1Headers(
        (explicit as { headers?: unknown }).headers,
        label,
        service,
      ),
    };
  }
  const sign =
    kind === 'orderbookL2' ? (explicit as { sign?: unknown }).sign : undefined;
  if (typeof sign === 'function') {
    if (service !== 'orderbook') {
      throw new UserInputError(
        `${label}: explicit L2 headers can only be sent to the orderbook service`,
        { service },
      );
    }
    return {
      kind: 'none',
      key: undefined,
      l1: undefined,
      l2: sign as ExplicitOrderbookL2['sign'],
    };
  }
  if (kind !== 'backend') {
    throw new UserInputError(`${label}: auth must be ${AUTH_FORMS}`, {
      service,
    });
  }
  if (service !== 'backend') {
    throw new UserInputError(
      `${label}: an explicit API key can only be sent to the backend service`,
      { service },
    );
  }
  const key = (explicit as { key?: unknown }).key;
  if (!isBackendKey(key)) {
    throw new UserInputError(
      `${label}: the API key must start with "xo_sk_" and hold only visible ASCII characters`,
      { service },
    );
  }
  return { kind: 'none', key, l1: undefined };
}

/**
 * Whether a credential may be sent to `base`: an `https:` URL, or `http:` to one of the
 * local hosts. This is the rule `resolveEnvironment` applies to the URLs it accepts. The
 * transport applies it again, because an `EnvironmentConfig` can also be built by hand.
 * A URL that does not parse is not safe.
 */
function isSafeForCredentials(base: string): boolean {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))
  );
}

function queryString(query: TransportRequest['query']): string {
  if (query === undefined) {
    return '';
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.append(key, String(value));
    }
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

/** The one place a request body is serialized. `undefined` means "no body". */
function serializeBody(body: unknown, label: string): string | undefined {
  if (body === undefined) {
    return undefined;
  }
  let text: string | undefined;
  try {
    text = JSON.stringify(body);
  } catch {
    text = undefined;
  }
  if (text === undefined) {
    // No cause: the serializer's message can name the offending value.
    throw new UserInputError(`${label}: the body cannot be serialized as JSON`);
  }
  return text;
}

/** JSON when the text parses, the text itself when it does not, `undefined` when empty. */
function decodeErrorBody(text: string): unknown {
  if (text === '') {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function retryAfterOf(error: XoError): number | undefined {
  if (
    error instanceof RateLimitError ||
    error instanceof RequestRejectedError
  ) {
    return error.retryAfter;
  }
  return undefined;
}

function headerNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name)?.trim();
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function isAbortLike(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

/** The caller's signal of a request: its own, its call's, or one that aborts with either. */
function callerSignal(
  own: AbortSignal | undefined,
  fromCall: AbortSignal | undefined,
): AbortSignal | undefined {
  if (own === undefined || fromCall === undefined || own === fromCall) {
    return own ?? fromCall;
  }
  return AbortSignal.any([own, fromCall]);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

/** What one attempt produced: an HTTP response, or a failure to get one. */
type Attempt =
  | {
      kind: 'response';
      status: number;
      ok: boolean;
      headers: Headers;
      text: string;
    }
  | { kind: 'network'; error: TransportError };

const RATE_LIMIT_HEADERS = [
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
] as const;

/**
 * Every HTTP call the SDK makes goes through here: the backend, the orderbook gateway
 * and the sponsor. It builds the request, adds auth, applies timeouts, retries reads,
 * reports rate limits and maps failures to {@link XoError}s.
 *
 * Internal: an engine behind the two clients. No entry of the package exports it.
 */
export class Transport {
  private readonly env: EnvironmentConfig;
  private readonly version: string;
  private readonly fetchImpl?: typeof fetch;
  private auth?: AuthProvider;
  private readonly onRateLimit?: (info: RateLimitUpdate) => void;
  private readonly maxRetries: number;
  private readonly defaultTimeoutMs: number;

  constructor(o: TransportOptions) {
    const maxRetries = o.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new UserInputError('maxRetries must be a whole number, 0 or more');
    }
    this.env = o.env;
    this.version = o.version;
    this.fetchImpl = o.fetch;
    this.auth = o.auth;
    this.onRateLimit = o.onRateLimit;
    this.maxRetries = maxRetries;
    this.defaultTimeoutMs = checkTimeout(
      o.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      'defaultTimeoutMs',
    );
  }

  /** Installs or replaces the credentials provider. Later requests use it. */
  setAuth(auth: AuthProvider): void {
    this.auth = auth;
  }

  /**
   * Sends one request (see {@link TransportRequest}) and resolves with the decoded body: JSON
   * when it parses, the text otherwise, `undefined` when it is empty. A read is retried on a
   * network error, 429, 502, 503 or 504, unless the service asked for a wait longer than 5 s
   * (the error, with its `retryAfter`, is thrown instead of sleeping); nothing else is retried,
   * a timed-out attempt included (its `TimeoutError` is thrown at once, so a hanging service
   * costs one timeout, not three). A caller's abort, at any point, rejects with a
   * `RequestAbortedError`. An error answer rejects with the {@link XoError} its status and body
   * map to.
   */
  request<T = unknown>(o: TransportRequest): Promise<T>;
  /**
   * The same, with the auth forms only the SDK's own modules use.
   *
   * @internal
   */
  request<T = unknown>(o: InternalTransportRequest): Promise<T>;
  async request<T = unknown>(o: InternalTransportRequest): Promise<T> {
    const { service, method, path } = o;
    // Checked first: per-call options a caller built by hand must not slip through.
    const call = o.call === undefined ? undefined : checkCallOptions(o.call);
    const signal = callerSignal(o.signal, call?.signal);
    const label = `${method} ${path}`;
    const base = this.baseUrl(service);
    // The path is what auth signs, so a query or fragment in it would be signed too.
    // Messages name the path only up to a "?" or "#", so a query never reaches them.
    const cut = path.search(/[?#]/);
    if (cut !== -1) {
      throw new UserInputError(
        `${method} ${path.slice(0, cut)}: the path must not contain "?" or "#", pass query parameters in \`query\``,
        { service },
      );
    }
    if (!path.startsWith('/')) {
      throw new UserInputError(`${label}: the path must start with "/"`, {
        service,
      });
    }
    if ((method === 'GET' || method === 'HEAD') && o.body !== undefined) {
      throw new UserInputError(
        `${label}: a ${method} request cannot have a body`,
        {
          service,
        },
      );
    }
    const { kind, key: explicitKey, l1, l2 } = readAuth(o.auth, service, label);
    // Provider credentials, an explicit key and explicit L1 or L2 headers all count. Checked
    // before anything is asked of the provider or sent, and the message names neither the URL
    // (it can hold a password) nor any credential.
    if (
      (kind !== 'none' ||
        explicitKey !== undefined ||
        l1 !== undefined ||
        l2 !== undefined) &&
      !isSafeForCredentials(base)
    ) {
      throw new UserInputError(
        `${label}: credentials are only sent over https, or over http to localhost, 127.0.0.1 or [::1]`,
        { code: 'insecure_transport', service },
      );
    }
    const auth = this.auth;
    if (kind !== 'none' && auth === undefined) {
      throw new AuthRequiredError(
        `${label} needs ${kind} credentials but the client has none`,
        { service },
      );
    }
    const timeoutMs =
      call !== undefined
        ? call.timeoutMs
        : o.timeoutMs === undefined
          ? this.defaultTimeoutMs
          : checkTimeout(o.timeoutMs, 'timeoutMs');
    const maxRetries = call?.retries ?? this.maxRetries;
    const body = serializeBody(o.body, label);
    const url = `${trimSlash(base)}${path}${queryString(o.query)}`;
    const readPolicy =
      (o.retry ?? (method === 'GET' || method === 'HEAD' ? 'read' : 'none')) ===
      'read';

    let retries = 0;
    let refreshed = false;
    // Whether an earlier attempt of this request may have reached the service (it is being
    // retried after a network failure or a retryable status). Until then, a failure of the
    // auth provider means that nothing was sent.
    let mayHaveRun = false;
    for (;;) {
      if (signal?.aborted) {
        const error = this.aborted(service, label, signal.reason);
        throw mayHaveRun ? error : markNotSent(error);
      }
      let built: Awaited<ReturnType<Transport['buildHeaders']>>;
      try {
        built = await this.buildHeaders(
          service,
          label,
          kind === 'none' || auth === undefined
            ? undefined
            : { auth, kind, method, path, body: body ?? '' },
          body !== undefined,
          explicitKey,
          l1,
          l2 === undefined
            ? undefined
            : { sign: l2, method, path, body: body ?? '' },
        );
      } catch (error) {
        throw mayHaveRun ? error : markNotSent(error);
      }
      // The provider ran without the signal (it may have minted a credential), so an abort
      // while it ran is seen here, before anything is sent.
      if (signal?.aborted) {
        const error = this.aborted(service, label, signal.reason);
        throw mayHaveRun ? error : markNotSent(error);
      }
      const { headers, provided } = built;
      const attempt = await this.attempt({
        service,
        label,
        url,
        method,
        headers,
        body,
        timeoutMs,
        signal,
      });

      if (attempt.kind === 'network') {
        if (readPolicy && retries < maxRetries) {
          mayHaveRun = true;
          await this.pause(
            retryDelayMs(undefined, retries),
            signal,
            service,
            label,
          );
          retries += 1;
          continue;
        }
        throw attempt.error;
      }

      const { status, headers: responseHeaders, text } = attempt;
      if (attempt.ok) {
        this.reportRateLimit(service, path, status, responseHeaders);
        return this.decodeSuccess(
          text,
          responseHeaders,
          service,
          status,
          label,
        ) as T;
      }

      const error = parseServiceError({
        service,
        status,
        body: decodeErrorBody(text),
        headers: responseHeaders,
      });
      this.reportRateLimit(service, path, status, responseHeaders, error);

      // A 401 means the request was not processed, so refreshing and re-sending is safe
      // for any method. It happens at most once and does not use the retry budget.
      if (
        status === 401 &&
        kind !== 'none' &&
        auth !== undefined &&
        !refreshed
      ) {
        refreshed = true;
        let again: boolean;
        try {
          again = await auth.onUnauthorized(kind, { headers: provided ?? {} });
        } catch (failure) {
          // The 401 says this attempt was not processed.
          throw mayHaveRun ? failure : markNotSent(failure);
        }
        // Like the headers, the refresh ran without the signal.
        if (signal?.aborted) {
          const aborted = this.aborted(service, label, signal.reason);
          throw mayHaveRun ? aborted : markNotSent(aborted);
        }
        if (again) {
          continue;
        }
        throw error;
      }

      if (readPolicy && retries < maxRetries && isRetryableStatus(status)) {
        // A wait the service asked for that is too long to sleep: the caller decides.
        const wait = retryDelayMs(retryAfterOf(error), retries);
        if (wait === undefined) {
          throw error;
        }
        mayHaveRun = true;
        await this.pause(wait, signal, service, label);
        retries += 1;
        continue;
      }
      throw error;
    }
  }

  private baseUrl(service: TransportRequest['service']): string {
    if (service === 'backend') {
      return this.env.backendUrl;
    }
    if (service === 'orderbook') {
      return this.env.orderbookUrl;
    }
    if (this.env.sponsorUrl === undefined) {
      throw new UserInputError(
        `The ${this.env.name} environment has no sponsorUrl`,
        { code: 'sponsor_not_configured', service },
      );
    }
    return this.env.sponsorUrl;
  }

  private async buildHeaders(
    service: Service,
    label: string,
    credentials:
      | {
          auth: AuthProvider;
          kind: Exclude<AuthKind, 'none'>;
          method: string;
          path: string;
          body: string;
        }
      | undefined,
    hasBody: boolean,
    explicitKey: string | undefined,
    l1: Record<OrderbookL1HeaderName, string> | undefined,
    l2:
      | {
          sign: ExplicitOrderbookL2['sign'];
          method: string;
          path: string;
          body: string;
        }
      | undefined,
  ): Promise<{
    headers: Headers;
    /** A copy of what the provider returned, for `onUnauthorized`. */
    provided: Record<string, string> | undefined;
  }> {
    const headers = new Headers({
      accept: 'application/json',
      'x-xo-sdk': `ts/${this.version}`,
    });
    if (hasBody) {
      headers.set('content-type', 'application/json');
    }
    if (explicitKey !== undefined) {
      headers.set('authorization', `Bearer ${explicitKey}`);
    }
    if (l1 !== undefined) {
      // Checked by readL1Headers, so every value is a valid header value.
      for (const name of L1_HEADER_NAMES) {
        headers.set(name, l1[name]);
      }
    }
    if (l2 !== undefined) {
      const { sign, method, path, body } = l2;
      // Signed again for every attempt; checked by signL2Headers.
      const signed = await signL2Headers(
        sign,
        { method, path, body },
        label,
        service,
      );
      for (const name of L2_HEADER_NAMES) {
        headers.set(name, signed[name]);
      }
    }
    let provided: Record<string, string> | undefined;
    if (credentials !== undefined) {
      const { auth, kind, method, path, body } = credentials;
      const extra = await auth.headers(kind, { method, path, body });
      provided = { ...extra };
      for (const [name, value] of Object.entries(extra)) {
        try {
          headers.set(name, value);
        } catch {
          // No cause: the runtime's message can quote the header value.
          throw new UserInputError(
            `${label}: the auth provider returned an invalid "${name}" header`,
            { service },
          );
        }
      }
    }
    return { headers, provided };
  }

  /**
   * One fetch plus reading its body. Timeouts and aborts throw; the rest returns. The caller's
   * signal and the attempt's own timer both cancel the fetch; which one fired decides the
   * error: the caller's abort is a `RequestAbortedError`, the timer a `TimeoutError`.
   */
  private async attempt(a: {
    service: Service;
    label: string;
    url: string;
    method: string;
    headers: Headers;
    body: string | undefined;
    timeoutMs: number | false;
    signal: AbortSignal | undefined;
  }): Promise<Attempt> {
    const timeout =
      a.timeoutMs === false ? undefined : AbortSignal.timeout(a.timeoutMs);
    const combined =
      timeout === undefined || a.signal === undefined
        ? (timeout ?? a.signal)
        : AbortSignal.any([timeout, a.signal]);
    const doFetch = this.fetchImpl ?? globalThis.fetch;
    // Set once the response head has arrived, so a failure after it is told apart.
    let received: number | undefined;
    try {
      const res = await doFetch(a.url, {
        method: a.method,
        headers: a.headers,
        body: a.body,
        signal: combined,
        // A followed cross-origin redirect would carry the X-XO-* auth headers along.
        redirect: 'error',
      });
      received = res.status;
      const text = await res.text();
      return {
        kind: 'response',
        status: res.status,
        ok: res.ok,
        headers: res.headers,
        text,
      };
    } catch (cause) {
      // The caller's abort first: when both fired, the caller asked to stop.
      if (a.signal?.aborted) {
        throw this.aborted(a.service, a.label, a.signal.reason);
      }
      if (timeout?.aborted) {
        throw new TimeoutError(`${a.label} timed out after ${a.timeoutMs} ms`, {
          service: a.service,
          cause: timeout.reason,
        });
      }
      if (isAbortLike(cause)) {
        // Neither signal fired: the fetch gave up by itself. Not retried, like a timeout.
        throw new TransportError(`${a.label} was aborted`, {
          service: a.service,
          cause,
        });
      }
      return {
        kind: 'network',
        error: new TransportError(
          received === undefined
            ? `${a.label} got no response from ${a.service}`
            : `${a.label}: response ${received} received but its body could not be read`,
          { service: a.service, cause },
        ),
      };
    }
  }

  /** The error of a caller's abort: its `cause` is the signal's reason. */
  private aborted(
    service: Service,
    label: string,
    reason: unknown,
  ): RequestAbortedError {
    return new RequestAbortedError(`${label} was aborted`, {
      service,
      cause: reason,
    });
  }

  /** Waits before a retry. A caller abort ends the wait and the request. */
  private async pause(
    ms: number,
    signal: AbortSignal | undefined,
    service: Service,
    label: string,
  ): Promise<void> {
    try {
      await sleep(ms, signal);
    } catch (reason) {
      throw this.aborted(service, label, reason);
    }
  }

  private decodeSuccess(
    text: string,
    headers: Headers,
    service: Service,
    status: number,
    label: string,
  ): unknown {
    if (text === '') {
      return undefined;
    }
    const contentType = headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('json')) {
      return text;
    }
    try {
      return JSON.parse(text);
    } catch {
      // The parser's message quotes the start of the body, so it is not kept.
      throw new UnexpectedResponseError(
        `${label} returned a body that is not valid JSON`,
        {
          service,
          status,
          requestId: headers.get('x-correlation-id') ?? undefined,
          issues: [
            {
              code: 'invalid_json',
              message: 'The response body is not valid JSON',
              contentType,
            },
          ],
        },
      );
    }
  }

  /**
   * Calls `onRateLimit` when the response carries a rate-limit header or is a 429.
   * Whatever the callback does, the request carries on.
   */
  private reportRateLimit(
    service: Service,
    path: string,
    status: number,
    headers: Headers,
    error?: XoError,
  ): void {
    const callback = this.onRateLimit;
    if (callback === undefined) {
      return;
    }
    const hasHeader = RATE_LIMIT_HEADERS.some((name) => headers.has(name));
    if (!hasHeader && status !== 429) {
      return;
    }
    const info: RateLimitUpdate = { service, path };
    const limit = headerNumber(headers, 'x-ratelimit-limit');
    const remaining = headerNumber(headers, 'x-ratelimit-remaining');
    const reset = headerNumber(headers, 'x-ratelimit-reset');
    if (limit !== undefined) {
      info.limit = limit;
    }
    if (remaining !== undefined) {
      info.remaining = remaining;
    }
    if (reset !== undefined) {
      info.resetMs = reset * 1000;
    }
    if (error instanceof RateLimitError && error.retryAfter !== undefined) {
      info.retryAfter = error.retryAfter;
    }
    try {
      const result: unknown = callback(info);
      if (isThenable(result)) {
        result.then(undefined, () => {});
      }
    } catch {
      // A broken listener must not break the request.
    }
  }
}
