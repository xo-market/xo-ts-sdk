import net from 'node:net';

// The process-wide guard that keeps unit tests off real hosts. It imports nothing but `node:net`,
// so the scripts package's setup file can use it too (scripts/test/setup/networkGuard.ts).
//
// `production` names XO's production sponsor, which pays for and broadcasts what it
// signs: a send a test forgot to mock would be a real, sponsored mainnet transaction. Two layers,
// installed before every test file by {@link installRealHostGuard}:
//
// - the global `fetch` refuses a non-local URL ({@link guardFetch}), with the
//   `TypeError('fetch failed')` a network failure has;
// - a TCP connection to a non-local host is refused where every client opens it,
//   `net.Socket.prototype.connect` ({@link guardSockets}): `node:http` and `node:https`
//   (`http.request`, `https.request`, `get`), `ws`, socket.io and undici all connect there. A
//   request msw mocks never opens a socket, so msw's own interception of `http.request` keeps
//   working; only a request msw would let through to a real host is stopped.

/** The hosts a unit test may reach: the local servers some tests start (HTTP, WebSocket). */
export const LOCAL_TEST_HOSTS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  'localhost',
  '[::1]',
]);

/** The same hosts as `net` names them: IPv6 without brackets. */
const LOCAL_SOCKET_HOSTS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
]);

/** Whether `url` is on one of {@link LOCAL_TEST_HOSTS}. */
export function isLocalTestUrl(url: string | URL): boolean {
  return LOCAL_TEST_HOSTS.has(new URL(url).hostname);
}

/** What a refusal names: the method, origin and path, never the query or the body. */
export function described(method: string, url: URL): string {
  return `${method.toUpperCase()} ${url.origin}${url.pathname}`;
}

/** The `cause` message of a request {@link guardFetch} refused starts with this. */
export const FETCH_GUARD_REFUSAL = 'unit-test network guard: refused';

/**
 * `real`, behind a guard: a request to a host other than {@link LOCAL_TEST_HOSTS} rejects with
 * the `TypeError('fetch failed')` a network failure has, its `cause` naming the request, and is
 * never handed to `real`.
 */
export function guardFetch(real: typeof fetch): typeof fetch {
  const guarded = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input,
    );
    if (!LOCAL_TEST_HOSTS.has(url.hostname)) {
      const method =
        init?.method ?? (input instanceof Request ? input.method : 'GET');
      throw new TypeError('fetch failed', {
        cause: new Error(`${FETCH_GUARD_REFUSAL} ${described(method, url)}`),
      });
    }
    return real(input, init);
  };
  return guarded as typeof fetch;
}

/** The `code` of the error a refused socket connection throws. */
export const SOCKET_GUARD_CODE = 'EXO_UNIT_TEST_REAL_HOST_SOCKET';

/**
 * Where a `Socket#connect` call goes: a Unix socket `path`, or a TCP `host` and `port`. Node's own
 * callers (`net.connect`, an http `Agent`, `tls.connect`) pass their normalized arguments as one
 * array; a direct call passes `(options)`, `(path)` or `(port, host)`. A TCP connection without a
 * host goes to `localhost`, as Node's does.
 */
export function connectTarget(
  args: readonly unknown[],
): { path: string } | { host: string; port: unknown } {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === 'object' && first !== null) {
    const options = first as { host?: unknown; path?: unknown; port?: unknown };
    if (typeof options.path === 'string') {
      return { path: options.path };
    }
    return {
      host: typeof options.host === 'string' ? options.host : 'localhost',
      port: options.port,
    };
  }
  if (typeof first === 'string' && Number.isNaN(Number(first))) {
    return { path: first };
  }
  return {
    host: typeof args[1] === 'string' ? args[1] : 'localhost',
    port: first,
  };
}

/**
 * Puts a guard on `net.Socket.prototype.connect`: a TCP connection to a host other than the
 * local ones throws an error with the code {@link SOCKET_GUARD_CODE}, before any socket is
 * opened. Unix sockets and local hosts go through. Returns the function that takes it off.
 */
export function guardSockets(): () => void {
  const real = net.Socket.prototype.connect;
  const guarded = function (this: net.Socket, ...args: unknown[]) {
    const target = connectTarget(args);
    if ('host' in target && !LOCAL_SOCKET_HOSTS.has(target.host)) {
      throw Object.assign(
        new Error(
          `${FETCH_GUARD_REFUSAL} a TCP connection to ${target.host}:${String(target.port)}`,
        ),
        { code: SOCKET_GUARD_CODE },
      );
    }
    return Reflect.apply(real, this, args) as net.Socket;
  };
  net.Socket.prototype.connect = guarded as typeof real;
  return () => {
    net.Socket.prototype.connect = real;
  };
}

/** Installs both layers, once per process (a second call is a no-op). */
export function installRealHostGuard(): void {
  const key = Symbol.for('@xomarket/client/test/real-host-guard');
  const holder = globalThis as Record<symbol, unknown>;
  if (holder[key] === true) {
    return;
  }
  holder[key] = true;
  globalThis.fetch = guardFetch(globalThis.fetch);
  guardSockets();
}
