import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Address,
  createPublicClient,
  erc20Abi,
  getAddress,
  type Hex,
  http,
  type Transport as RpcTransport,
} from 'viem';
import { type LocalAccount, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe } from 'vitest';
import pkg from '../package.json';
import * as subscriptions from '../src/actions/subscriptions';
import { type ProvidedCredentials, Session } from '../src/auth/session';
import { type CredentialStore, memoryStore } from '../src/auth/store';
import type { ActionContext } from '../src/clients/context';
import {
  bindActions,
  type PublicClient,
  publicActions,
} from '../src/clients/public';
import {
  createSecureClient,
  type SecureClient,
  type SecureClientOptions,
} from '../src/clients/secure';
import { Clock } from '../src/core/clock';
import { production } from '../src/core/env';
import {
  isRejected,
  RateLimitError,
  UnexpectedResponseError,
  XoError,
} from '../src/core/errors';
import { Transport, type TransportRequest } from '../src/core/transport';
import { createPublicCore } from '../src/core/wiring';
import { DataClient } from '../src/data/client';
import { OrderbookClient } from '../src/orderbook/client';
import { RealtimeHub } from '../src/realtime/merged';
import { kernelCreateAccountCalldata } from '../src/signing/kernel';
import type { WalletInput } from '../src/wallet/identity';
import { type Signer, signerFrom } from '../src/wallet/publicSigner';
import type { InternalSigner } from '../src/wallet/signer';
import { accountSigner } from '../test/helpers/signers';

// Helpers of the live e2e tests, which run against XO mainnet (`production`). They
// run only with XO_E2E=1: never in `pnpm test` or the CI of pull requests, only in the nightly
// workflow (.github/workflows/nightly-e2e.yml) and by hand.
//
// The suite is read-only. It never places or cancels an order, sends a transaction or calls a
// write route. The only writes are signing in and out (the backend key mint and revoke, the
// orderbook credentials) and the sponsor's sign-only route, which signs as fee payer and
// broadcasts nothing ({@link WRITE_ALLOWLIST}); the order book's batch reads are POSTs that
// change nothing ({@link POST_READS}). Three layers hold it, and each throws
// {@link E2eWriteRefused} before the request leaves the process:
// - {@link liveFetch}, the `fetch` of every backend, orderbook and sponsor client here;
// - {@link readOnlyRpc}, the RPC transport of every chain client here;
// - the global `fetch`, which e2e/readOnlyGuard.ts puts behind the same rules for the whole run
//   ({@link installReadOnlyGuard}). It covers what the SDK builds itself and a test cannot hand
//   either of the above: `createChainReader`, and the chain reads of a client.
//
// The signed-in tests use ONE fixed wallet, from XO_E2E_WALLET_PK: its EOA and its smart wallet
// at index 0, never a fresh wallet (a fresh one would be a new account every night). It holds
// nothing, which {@link assertEmptyWallet} checks before each signed-in block. Without the
// variable those blocks are skipped ({@link describeSignedIn}). Nothing here prints a
// credential, and the key is never read from a file.

export const env = production;

/** `describe` for a live test: skipped unless XO_E2E=1. Every e2e file uses it. */
export const describeLive = describe.runIf(process.env.XO_E2E === '1');

/** The environment variable that holds the private key of the e2e wallet. */
export const E2E_WALLET_VARIABLE = 'XO_E2E_WALLET_PK';

/**
 * `describe` for a live test that signs in with the e2e wallet: skipped unless XO_E2E=1 and
 * XO_E2E_WALLET_PK is set. Each such block starts with a `beforeAll` that calls
 * {@link assertEmptyWallet}.
 */
export const describeSignedIn = describe.runIf(
  process.env.XO_E2E === '1' &&
    (process.env[E2E_WALLET_VARIABLE]?.trim() ?? '') !== '',
);

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The services rate-limit wallet logins by IP, and a CI runner shares its IP with others, so
 * the logins of a run are spaced out: a login to a service starts at least this long after the
 * previous login to the same service ended.
 */
export const LOGIN_GAP_MS = 15_000;

/** The services a wallet logs in to. Each has its own key-mint limit, so its own stamp. */
export type LoginService = 'backend' | 'orderbook';

/**
 * The file that holds the time (a decimal number of milliseconds, nothing else) the last live
 * login to `service` ended. One per service: a backend login does not delay an orderbook one.
 */
export function loginStampFile(service: LoginService): string {
  return join(tmpdir(), `xo-sdk-e2e-last-login-${service}`);
}

function lastLoginAt(file: string): number {
  try {
    const at = Number(readFileSync(file, 'utf8').trim());
    return Number.isFinite(at) ? at : 0;
  } catch {
    return 0;
  }
}

/**
 * Waits until {@link LOGIN_GAP_MS} have passed since the last live login (to one service)
 * ended, and does not wait at all if they have. The time is kept in a file under
 * `os.tmpdir()` ({@link loginStampFile}), so the gap also holds across test files and quick
 * re-runs. A time in the future (the clock was set back) never makes it wait longer than the
 * gap. `liveSession` calls it before every login, so a test does not need to; a client that
 * builds its own transport calls {@link awaitLoginGap} before what logs it in. It assumes one
 * login at a time per service.
 */
export async function loginGap(stampFile: string): Promise<void> {
  const wait = lastLoginAt(stampFile) + LOGIN_GAP_MS - Date.now();
  if (wait > 0) {
    await sleep(Math.min(wait, LOGIN_GAP_MS));
  }
}

/** Records that a live login has just ended. Writes the time and nothing else. */
export function markLogin(stampFile: string): void {
  try {
    writeFileSync(stampFile, String(Date.now()));
  } catch {
    // Best effort: without the file the next login only skips its wait.
  }
}

/**
 * The login gap of each service, together: call it right before something that logs in a
 * client that builds its own transport (its first authenticated call). That transport has its
 * own request timeout, so the wait cannot happen inside its `fetch`; {@link liveFetch} records
 * when the login ended.
 */
export async function awaitLoginGap(
  ...services: LoginService[]
): Promise<void> {
  await Promise.all(services.map((s) => loginGap(loginStampFile(s))));
}

/** 64 hex characters, with or without a `0x` (or `0X`) prefix. */
const PRIVATE_KEY_TEXT = /^(?:0[xX])?[0-9a-fA-F]{64}$/;

/**
 * The e2e wallet, from XO_E2E_WALLET_PK (64 hex characters, with or without `0x`; surrounding
 * whitespace is ignored), or `undefined` when the variable is not set. It holds nothing, and
 * the suite only signs in with it: its EOA and its smart wallet at index 0.
 * @throws Error naming the variable when it is set but is not a private key. The message never contains the value.
 */
export function e2eWallet(): LocalAccount | undefined {
  const value = process.env[E2E_WALLET_VARIABLE]?.trim() ?? '';
  if (value === '') {
    return undefined;
  }
  const refused = () =>
    new Error(
      `${E2E_WALLET_VARIABLE} is not a private key: expected 64 hex characters, with or without 0x`,
    );
  if (!PRIVATE_KEY_TEXT.test(value)) {
    throw refused();
  }
  try {
    return privateKeyToAccount(`0x${value.slice(-64)}`);
  } catch {
    // No cause: whatever the library says could hold part of the key.
    throw refused();
  }
}

/**
 * The e2e wallet as the SDK's signer, for a {@link describeSignedIn} block.
 * @throws Error naming the variable when it is not set or not a private key. The message never contains the value.
 */
export function e2eSigner(): InternalSigner {
  const wallet = e2eWallet();
  if (wallet === undefined) {
    throw new Error(
      `${E2E_WALLET_VARIABLE} is not set: export the e2e wallet's private key in this variable to run the signed-in tests`,
    );
  }
  return accountSigner(wallet);
}

/**
 * The e2e wallet as the signer of the public API (`signerFrom`, as `@xomarket/client/viem`
 * makes it), for {@link trackClients}.
 * @throws Error naming the variable when it is not set or not a private key. The message never contains the value.
 */
export function e2ePublicSigner(): Signer {
  const wallet = e2eWallet();
  if (wallet === undefined) {
    throw new Error(
      `${E2E_WALLET_VARIABLE} is not set: export the e2e wallet's private key in this variable to run the signed-in tests`,
    );
  }
  return signerFrom(wallet);
}

/**
 * What a request is in a wallet login: its first request (`'start'`) or a later one
 * (`'step'`). The backend login is a nonce and then the key request, `POST /api/auth/api-keys`;
 * the orderbook login is a derive and then, if the wallet has no key yet, a create.
 */
function loginStep(o: {
  service: string;
  method: string;
  path: string;
}): 'start' | 'step' | undefined {
  const { service, method, path } = o;
  if (service === 'backend' && method === 'POST') {
    if (path === '/api/auth/api-keys/nonce') {
      return 'start';
    }
    if (path === '/api/auth/api-keys') {
      return 'step';
    }
  }
  if (service === 'orderbook') {
    if (method === 'GET' && path === '/auth/derive-api-key') {
      return 'start';
    }
    if (method === 'POST' && path === '/auth/api-key') {
      return 'step';
    }
  }
  return undefined;
}

/**
 * The live transport, which waits out the login gap before a login starts and records when it
 * ends. This is the one place every login passes through, including the lazy login of the
 * first authenticated request.
 */
class LiveTransport extends Transport {
  override async request<T = unknown>(o: TransportRequest): Promise<T> {
    const step = loginStep(o);
    // loginStep answers only for the backend and the orderbook.
    const stamp =
      step === undefined
        ? undefined
        : loginStampFile(o.service as LoginService);
    if (step === 'start' && stamp !== undefined) {
      // Before the request, so before the transport starts its timeout.
      await loginGap(stamp);
    }
    try {
      return await super.request<T>(o);
    } finally {
      if (stamp !== undefined) {
        markLogin(stamp);
      }
    }
  }
}

/** One finished HTTP exchange, without any header, query or body, so nothing secret. */
export interface HttpCall {
  method: string;
  service: 'backend' | 'orderbook' | 'sponsor' | 'other';
  /** The path only, without the query. */
  path: string;
  status: number;
}

const ORIGINS = {
  backend: new URL(env.backendUrl).origin,
  orderbook: new URL(env.orderbookUrl).origin,
  sponsor:
    env.sponsorUrl === undefined ? undefined : new URL(env.sponsorUrl).origin,
};

/** The JSON-RPC endpoint: a POST there is read by its JSON-RPC method, not refused outright. */
const RPC_URL = new URL(env.rpcUrl);

function serviceOf(url: URL): HttpCall['service'] {
  if (url.origin === ORIGINS.backend) {
    return 'backend';
  }
  if (url.origin === ORIGINS.orderbook) {
    return 'orderbook';
  }
  if (url.origin === ORIGINS.sponsor) {
    return 'sponsor';
  }
  return 'other';
}

/** A write the live suite refused, before it left the process. */
export class E2eWriteRefused extends Error {
  constructor(what: string) {
    super(`the live e2e suite is read-only: refused ${what}`);
    this.name = 'E2eWriteRefused';
  }
}

/** A write the live suite may make: one route of one service. */
export interface AllowedWrite {
  service: 'backend' | 'orderbook' | 'sponsor';
  method: 'POST' | 'DELETE';
  /**
   * The exact path, or a pattern of the whole path. The query is not looked at. For
   * `mintedKeyOnly`, the pattern's first group is the key id.
   */
  path: string | RegExp;
  /** Allowed only for a backend key this run minted (see {@link noteMintedKey}). */
  mintedKeyOnly?: true;
}

/** The backend's key mint: its 201 names the new key's id. */
const KEY_MINT_PATH = '/api/auth/api-keys';

/** The revoke of a backend key, by id. */
const KEY_BY_ID = /^\/api\/auth\/api-keys\/([0-9]+)$/;

/**
 * Every request but a GET or a HEAD that the live suite may send: signing in and out, and the
 * sponsor's sign-only route. Taken from the SDK's own requests:
 * - src/auth/backendAuth.ts: the SIWE nonce, then the key mint with the signed message, and
 *   the revoke of a key by id when the session closes, for a key this run minted only;
 * - src/auth/orderbookAuth.ts: the L1 create, when the derive (a GET) finds no credentials;
 * - src/account/sponsorClient.ts sends `/v1/sponsor/send`, which broadcasts and is refused; its
 *   sign-only twin `/v1/sponsor/sign` signs as fee payer and broadcasts nothing.
 */
export const WRITE_ALLOWLIST: readonly AllowedWrite[] = Object.freeze([
  { service: 'backend', method: 'POST', path: '/api/auth/api-keys/nonce' },
  { service: 'backend', method: 'POST', path: KEY_MINT_PATH },
  {
    service: 'backend',
    method: 'DELETE',
    path: KEY_BY_ID,
    mintedKeyOnly: true,
  },
  { service: 'orderbook', method: 'POST', path: '/auth/api-key' },
  { service: 'sponsor', method: 'POST', path: '/v1/sponsor/sign' },
]);

/**
 * The order book's batch reads: a POST that carries a list of tokens and answers books, prices
 * or trades, and changes nothing (`OrderbookClient`'s `publicBatch`, which `fetchOrderBooks`,
 * `fetchMidpoints`, `fetchPrices`, `fetchSpreads` and `fetchLastTradePrices` use). Exact paths
 * of the order book only: the trading routes (`/order`, `/orders`, `/heartbeats`) are not here.
 */
export const POST_READS: readonly string[] = Object.freeze([
  '/books',
  '/midpoints',
  '/prices',
  '/spreads',
  '/last-trades-prices',
]);

/**
 * The ids of the backend keys this run minted, from the key mint's 201 (one process: the test
 * files and the global guard share this module). Nothing else is kept from the answer.
 */
const mintedKeyIds = new Set<string>();

/**
 * Notes the key id of a successful backend key mint, so the session that minted it may revoke
 * it. Any other request or answer is ignored, as is a body that is not JSON with a positive
 * integer `id`.
 */
async function noteMintedKey(
  input: string | URL | Request,
  init: RequestInit | undefined,
  response: Response,
): Promise<void> {
  const url = urlOf(input);
  if (
    !response.ok ||
    methodOf(input, init) !== 'POST' ||
    serviceOf(url) !== 'backend' ||
    url.pathname !== KEY_MINT_PATH
  ) {
    return;
  }
  try {
    const body: unknown = await response.clone().json();
    const id =
      typeof body === 'object' && body !== null
        ? (body as { id?: unknown }).id
        : undefined;
    if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) {
      mintedKeyIds.add(String(id));
    }
  } catch {
    // Not JSON: no id to note, so this key cannot be revoked here.
  }
}

/**
 * The JSON-RPC methods the live suite may call, all reads: what the tests ask for (`eth_chainId`,
 * `eth_call`, `eth_getCode`) and what the SDK's chain reader asks for (`createChainReader`: the
 * nonce, the code, the gas estimate and bundle simulation, the fees, and the receipt and
 * transaction lookups). Compared without case. Any other method is refused, whatever it is.
 */
export const RPC_READ_METHODS: ReadonlySet<string> = new Set([
  'eth_chainid',
  'eth_blocknumber',
  'eth_call',
  'eth_getcode',
  'eth_gettransactioncount',
  'eth_estimategas',
  'eth_simulatev1',
  'eth_gasprice',
  'eth_maxpriorityfeepergas',
  'eth_getblockbynumber',
  'eth_gettransactionreceipt',
  'eth_gettransactionbyhash',
]);

/** Throws unless `method` is a JSON-RPC method name on {@link RPC_READ_METHODS}. */
function refuseRpcWrite(method: unknown): void {
  if (typeof method !== 'string') {
    throw new E2eWriteRefused('a JSON-RPC request without a method');
  }
  if (!RPC_READ_METHODS.has(method.toLowerCase())) {
    throw new E2eWriteRefused(`the JSON-RPC method ${method}`);
  }
}

/** Throws unless a JSON-RPC body (one request or a batch) only reads. */
function refuseRpcBody(body: unknown, what: string): void {
  if (typeof body !== 'string') {
    throw new E2eWriteRefused(`${what}: its body cannot be read`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new E2eWriteRefused(`${what}: its body is not JSON-RPC`);
  }
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
    refuseRpcWrite(
      typeof item === 'object' && item !== null
        ? (item as { method?: unknown }).method
        : undefined,
    );
  }
}

function urlOf(input: string | URL | Request): URL {
  return new URL(
    input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : input,
  );
}

/** The request's method, in upper case. */
function methodOf(
  input: string | URL | Request,
  init: RequestInit | undefined,
): string {
  return (
    init?.method ?? (input instanceof Request ? input.method : 'GET')
  ).toUpperCase();
}

/**
 * Throws {@link E2eWriteRefused} unless the request only reads: a GET or a HEAD, a JSON-RPC
 * request to the RPC whose methods are all on {@link RPC_READ_METHODS}, a batch read of the
 * order book ({@link POST_READS}), or a write on {@link WRITE_ALLOWLIST} (a key revoke for a
 * key this run minted only). The message names the method, origin and path, never the query or
 * the body.
 */
export function assertReadOnly(
  input: string | URL | Request,
  init?: RequestInit,
): void {
  const url = urlOf(input);
  const method = methodOf(input, init);
  if (method === 'GET' || method === 'HEAD') {
    return;
  }
  const what = `${method} ${url.origin}${url.pathname}`;
  if (
    method === 'POST' &&
    url.origin === RPC_URL.origin &&
    url.pathname === RPC_URL.pathname
  ) {
    refuseRpcBody(init?.body, what);
    return;
  }
  const service = serviceOf(url);
  if (
    method === 'POST' &&
    service === 'orderbook' &&
    POST_READS.includes(url.pathname)
  ) {
    return;
  }
  for (const write of WRITE_ALLOWLIST) {
    if (write.service !== service || write.method !== method) {
      continue;
    }
    const match =
      typeof write.path === 'string'
        ? write.path === url.pathname
          ? [url.pathname]
          : null
        : write.path.exec(url.pathname);
    if (match === null) {
      continue;
    }
    if (write.mintedKeyOnly === true && !mintedKeyIds.has(match[1] ?? '')) {
      throw new E2eWriteRefused(`${what}: that key was not minted in this run`);
    }
    return;
  }
  throw new E2eWriteRefused(what);
}

/**
 * `real` behind {@link assertReadOnly}: a refused request never reaches it. It also notes the
 * id of a key it sees minted ({@link noteMintedKey}), so that key may be revoked.
 */
export function readOnlyFetch(real: typeof fetch): typeof fetch {
  return async (input, init) => {
    assertReadOnly(input, init);
    const response = await real(input, init);
    await noteMintedKey(input, init, response);
    return response;
  };
}

const GUARDED = Symbol.for('xo-sdk.e2e.readOnlyGuard');

/**
 * Puts the global `fetch` behind {@link assertReadOnly}, once: a second call changes nothing.
 * e2e/readOnlyGuard.ts calls it before every live test file, so what the SDK builds itself
 * (`createChainReader`, the chain reads of a client) is guarded too.
 */
export function installReadOnlyGuard(): void {
  const current = globalThis.fetch as typeof fetch & { [GUARDED]?: true };
  if (current[GUARDED] === true) {
    return;
  }
  globalThis.fetch = Object.assign(readOnlyFetch(current), {
    [GUARDED]: true as const,
  });
}

/** Per JSON-RPC request, as the SDK's own chain reader. */
const RPC_TIMEOUT_MS = 15_000;

/**
 * The RPC transport of every chain client of the live tests: viem's `http` on `env.rpcUrl`,
 * read-only. A JSON-RPC method that is not on {@link RPC_READ_METHODS} (`eth_sendRawTransaction`
 * and `eth_sendTransaction` among them, in any case) throws {@link E2eWriteRefused} when it is
 * asked for, and the HTTP request is checked again by {@link assertReadOnly} before it is sent
 * (a batch too).
 * Use it with `ccipRead: false`, so no contract can make the client follow an off-chain lookup.
 * @param o.methods Each JSON-RPC method that is asked for and allowed is appended here.
 */
export function readOnlyRpc(o: { methods?: string[] } = {}): RpcTransport {
  const inner = http(env.rpcUrl, {
    timeout: RPC_TIMEOUT_MS,
    // The global fetch at call time: the guard of the run, or a test's stub.
    fetchFn: readOnlyFetch((input, init) => fetch(input, init)),
  });
  return (params) => {
    const transport = inner(params);
    const request: typeof transport.request = async (args, options) => {
      refuseRpcWrite(args.method);
      o.methods?.push(args.method);
      return transport.request(args, options);
    };
    return { ...transport, request };
  };
}

/** A `fetch` that appends each response's method, service, path and status to `calls`. */
function recordingFetch(calls: HttpCall[]): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    const url = urlOf(input);
    calls.push({
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      service: serviceOf(url),
      path: url.pathname,
      status: response.status,
    });
    return response;
  };
}

/**
 * The `fetch` of every live client: it refuses a write ({@link readOnlyFetch}) before it is
 * sent, appends each exchange to `calls`, and records when a login request to the backend or
 * the orderbook ended (in that service's {@link loginStampFile}), so the next login keeps the
 * gap. It never waits itself (see {@link awaitLoginGap}).
 * @param stampFile Only for tests of this function.
 */
export function liveFetch(
  calls: HttpCall[],
  stampFile: (service: LoginService) => string = loginStampFile,
): typeof fetch {
  const guarded = readOnlyFetch(recordingFetch(calls));
  return async (input, init) => {
    const url = urlOf(input);
    const service = serviceOf(url);
    const step =
      service === 'backend' || service === 'orderbook'
        ? loginStep({
            service,
            method: methodOf(input, init),
            path: url.pathname,
          })
        : undefined;
    try {
      return await guarded(input, init);
    } finally {
      if (step !== undefined) {
        markLogin(stampFile(service as LoginService));
      }
    }
  };
}

/**
 * A transport for mainnet, which sends the package version as `X-XO-SDK`, on
 * {@link liveFetch}: writes are refused, every exchange is appended to `calls`, and a wallet
 * login keeps the login gap.
 */
export function liveTransport(o: { calls?: HttpCall[] } = {}): Transport {
  return new LiveTransport({
    env,
    version: pkg.version,
    fetch: liveFetch(o.calls ?? []),
  });
}

/**
 * A public client on mainnet with strict responses: a response field the SDK does not know,
 * or one that is missing or of another type, fails the read. `createPublicClient` has no such
 * option, so this wires the same context by hand: the same actions (`publicActions`, bound
 * the way `createPublicClient` binds them), the same core, on engines with
 * `strictResponses: true` and on {@link liveFetch}, which refuses a write and appends every
 * exchange to `o.calls`. The chain reads go through the global `fetch`, which the read-only
 * guard covers (e2e/readOnlyGuard.ts). Close its subscriptions when a test opened any.
 */
export function strictPublicClient(
  o: { calls?: HttpCall[] } = {},
): PublicClient {
  const { transport, clock, chain } = createPublicCore({
    env,
    fetch: liveFetch(o.calls ?? []),
    strictResponses: true,
  });
  const orderbook = new OrderbookClient({
    transport,
    env,
    strictResponses: true,
  });
  const ctx: ActionContext = {
    env,
    orderbook,
    data: new DataClient({ transport, strictResponses: true }),
    chain,
    clock,
    strict: true,
    realtime: new RealtimeHub({ env, orderbook, strict: true }),
  };
  const client: PublicClient = {
    ...bindActions(publicActions, ctx),
    subscribe: (specs) => subscriptions.subscribe(ctx, specs),
    closeSubscriptions: () => subscriptions.closeSubscriptions(ctx),
  };
  return Object.freeze(client);
}

/** The e2e wallet signed in on mainnet, as far as {@link assertEmptyWallet} reads it. */
export interface E2eClient {
  /** The session's non-secret state: `type` is `'eoa'` or `'smart_wallet'`. */
  toJSON(): Record<string, unknown>;
  /** The address that trades and holds the funds. */
  tradingAddress(): Promise<Address>;
  /** The backend's reads, sent with the session's backend key. */
  readonly data: DataClient;
  /** Closes the session, which revokes its short-lived backend key. */
  close(): Promise<void>;
}

/**
 * The e2e wallet on mainnet: a {@link liveSession} (writes refused, strict responses) and the
 * backend's reads on its transport. `wallet` defaults to the EOA. Close it.
 */
export function e2eClient(
  o: { wallet?: WalletInput } = {},
): Promise<E2eClient> {
  const { session, transport } = liveSession(e2eSigner(), o.wallet);
  const data = new DataClient({ transport, session, strictResponses: true });
  return Promise.resolve(
    Object.freeze({
      toJSON: () => session.toJSON(),
      tradingAddress: async () => (await session.identity()).address,
      data,
      close: () => session.close(),
    }),
  );
}

/** What {@link assertEmptyWallet} reads on chain. */
export interface WalletChainReads {
  /** The address of `owner`'s smart wallet at index 0 (deployed or not). */
  smartWalletOf(owner: Address): Promise<Address>;
  /** The USDC balance of `address`, in micro-USDC. */
  usdcBalance(address: Address): Promise<bigint>;
}

/** {@link WalletChainReads} on mainnet, through {@link readOnlyRpc}. */
export function walletChainReads(): WalletChainReads {
  const rpc = createPublicClient({ transport: readOnlyRpc(), ccipRead: false });
  return {
    async smartWalletOf(owner) {
      const { data } = await rpc.call({
        to: env.contracts.kernelFactory,
        data: kernelCreateAccountCalldata(
          owner,
          0n,
          env.contracts.ecdsaValidator,
        ),
      });
      if (data === undefined || !/^0x0{24}[0-9a-fA-F]{40}$/.test(data)) {
        throw new Error('the factory did not answer an address');
      }
      return getAddress(`0x${data.slice(26)}`);
    },
    usdcBalance: (address) =>
      rpc.readContract({
        address: env.contracts.usdc,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address],
      }),
  };
}

/** What {@link assertEmptyWallet} uses besides the EOA client. Each has a live default. */
export interface EmptyWalletDeps {
  /** The chain reads. Defaults to {@link walletChainReads}. */
  chain?: WalletChainReads;
  /**
   * A client of the same wallet's smart wallet at index 0, which assertEmptyWallet closes.
   * Defaults to `e2eClient({ wallet: { type: 'smart_wallet', index: 0 } })`.
   */
  smartWalletClient?: () => Promise<E2eClient>;
  /** Waited before each sign-in. Defaults to the backend's {@link awaitLoginGap}. */
  loginGap?: () => Promise<void>;
}

/**
 * Whether `error` is the backend's answer for a user it does not know: a 404 "User not found".
 * The backend sends no code of its own for it, so the SDK's code is the generic `http_404`, and
 * the message tells it from every other 404.
 */
function isUnknownUser(error: unknown): boolean {
  return (
    isRejected(error, 404) &&
    error.code === 'http_404' &&
    error.message === 'User not found'
  );
}

/**
 * Checks that the e2e wallet holds nothing, for its EOA and for its smart wallet at index 0:
 * - no USDC on chain;
 * - a public profile: a private one makes the public portfolio answer an empty list, which
 *   would hide its positions. Its username comes from `account.me()`, so each address signs in
 *   to the backend (a short-lived key, revoked when its client closes);
 * - no position in the public portfolio, in any status. Only the backend's unknown-user 404
 *   counts as none; any other error is thrown.
 * @param client The e2e wallet's EOA client ({@link e2eClient}). The caller closes it.
 * @param o Only for tests of this function.
 * @throws Error naming each address that holds something or hides it, and what.
 */
export async function assertEmptyWallet(
  client: E2eClient,
  o: EmptyWalletDeps = {},
): Promise<void> {
  if (client.toJSON().type !== 'eoa') {
    throw new Error(
      'assertEmptyWallet takes the EOA client of the e2e wallet: its smart wallet is found from the EOA',
    );
  }
  const chain = o.chain ?? walletChainReads();
  const gap = o.loginGap ?? (() => awaitLoginGap('backend'));
  const smart = await (
    o.smartWalletClient ??
    (() => e2eClient({ wallet: { type: 'smart_wallet', index: 0 } }))
  )();
  try {
    const eoa = await client.tradingAddress();
    const expected = await chain.smartWalletOf(eoa);
    const smartWallet = await smart.tradingAddress();
    if (getAddress(smartWallet) !== getAddress(expected)) {
      throw new Error(
        `the smart wallet client trades from ${smartWallet}, not ${expected}, the smart wallet of the EOA ${eoa} at index 0`,
      );
    }
    const problems: string[] = [];
    for (const [label, address, xo] of [
      ['EOA', eoa, client],
      ['smart wallet', smartWallet, smart],
    ] as const) {
      const usdc = await chain.usdcBalance(address);
      if (usdc !== 0n) {
        problems.push(`the ${label} ${address} holds ${usdc} micro-USDC`);
      }
      await gap();
      const { username } = await xo.data.account.me();
      const profile = await xo.data.profiles.get(username);
      if (profile.isPrivate) {
        problems.push(
          `the profile of the ${label} ${address} is private, so its public portfolio would hide its positions: make it public`,
        );
      }
      const positions = await xo.data.portfolio
        .ofWallet({ wallet: address }, { status: 'all', take: 1 })
        .firstPage()
        .catch((error: unknown) => {
          if (isUnknownUser(error)) {
            return { items: [] };
          }
          throw error;
        });
      if (positions.items.length > 0) {
        problems.push(`the ${label} ${address} has positions`);
      }
    }
    if (problems.length > 0) {
      throw new Error(
        `the e2e wallet must hold nothing, so the suite stays read-only: ${problems.join('; ')}`,
      );
    }
  } finally {
    await smart.close();
  }
}

/** The status of the last call that matches, or `undefined` if there was none. */
export function statusOf(
  calls: readonly HttpCall[],
  method: string,
  service: HttpCall['service'],
  path: string | RegExp,
): number | undefined {
  const matches = calls.filter(
    (call) =>
      call.method === method &&
      call.service === service &&
      (typeof path === 'string' ? call.path === path : path.test(call.path)),
  );
  return matches.at(-1)?.status;
}

/** For each revoke (a DELETE of a backend key by id) that was sent: whether it succeeded. */
export function revokeSucceeded(calls: readonly HttpCall[]): boolean[] {
  return calls
    .filter(
      (call) =>
        call.method === 'DELETE' &&
        call.service === 'backend' &&
        /^\/api\/auth\/api-keys\/[0-9]+$/.test(call.path),
    )
    .map((call) => call.status >= 200 && call.status < 300);
}

/** The warnings other than the one a memory store always gives (short-lived keys). */
export function unexpected(warnings: readonly string[]): string[] {
  return warnings.filter((message) => !message.includes('short-lived'));
}

/** A live session with everything it needs, and what the tests look at. */
export interface LiveSession {
  /** Installed on `transport` with `setAuth`. */
  session: Session;
  transport: Transport;
  /** The wallet that signs: the owner, also for a smart wallet. */
  owner: Address;
  /** Every response the transport and the clock got, in order. */
  calls: HttpCall[];
  /** The messages the session passed to `warn`. They never hold a secret. */
  warnings: string[];
  /** How many signatures the session has asked the wallet for so far. */
  signatures: () => number;
}

export interface LiveSessionOptions {
  /** Defaults to `memoryStore()`: 1-day backend keys, revoked on `close()`. */
  store?: CredentialStore;
  /** Part of the backend key's name. Defaults to `'e2e'`. */
  label?: string;
  /** Credentials to use as they are, instead of (or besides) a login. */
  credentials?: ProvidedCredentials;
  /** Replaces the `eth_getCode` check of the RPC. */
  isDeployed?: (address: Address) => Promise<boolean>;
  /** Replaces the `eth_call` of the RPC. */
  readContract?: (call: { to: Address; data: Hex }) => Promise<Hex>;
}

/**
 * A session wired as a client wires it: the live transport ({@link liveTransport}: writes
 * refused) with the session as its auth provider, a clock read from the orderbook's
 * `GET /time`, and {@link readOnlyRpc} for the smart wallet address lookup and the deployment
 * check. By default it uses `memoryStore()`, so the backend key lasts 1 day and `close()`
 * revokes it. Every login keeps the login gap. Close it in every test (see
 * {@link trackSessions}).
 *
 * Response schemas are strict, so a field the services add shows up as a failure.
 */
export function liveSession(
  signer: InternalSigner,
  wallet: WalletInput = { type: 'eoa' },
  options: LiveSessionOptions = {},
): LiveSession {
  const calls: HttpCall[] = [];
  const warnings: string[] = [];
  const transport = liveTransport({ calls });

  const clock = new Clock({
    fetchServerTimeSec: async () =>
      // The body is plain text: unix seconds.
      Number(
        await transport.request({
          service: 'orderbook',
          method: 'GET',
          path: '/time',
          auth: 'none',
          retry: 'none',
          timeoutMs: 5000,
        }),
      ),
  });

  // ccipRead false: never follow an off-chain lookup that a contract asks for.
  const rpc = createPublicClient({ transport: readOnlyRpc(), ccipRead: false });

  let signatures = 0;
  const hash = signer.signHash;
  const counting: InternalSigner = Object.freeze({
    address: signer.address,
    signMessage: (message: string) => {
      signatures += 1;
      return signer.signMessage(message);
    },
    signTypedData: (td: Parameters<InternalSigner['signTypedData']>[0]) => {
      signatures += 1;
      return signer.signTypedData(td);
    },
    // Left out when the wallet cannot sign a raw hash, as `fromViemAccount` does.
    ...(hash === undefined
      ? {}
      : {
          signHash: (digest: Hex) => {
            signatures += 1;
            return hash.call(signer, digest);
          },
        }),
  });

  const session = new Session({
    env,
    transport,
    clock,
    signer: counting,
    wallet,
    store: options.store ?? memoryStore(),
    label: options.label ?? 'e2e',
    credentials: options.credentials,
    readContract:
      options.readContract ??
      (async ({ to, data }) => {
        const result = await rpc.call({ to, data });
        return result.data ?? '0x';
      }),
    isDeployed:
      options.isDeployed ??
      (async (address) => {
        const code = await rpc.getCode({ address });
        return code !== undefined && code !== '0x';
      }),
    warn: (message) => {
      warnings.push(message);
    },
    strictResponses: true,
  });
  transport.setAuth(session);

  return {
    session,
    transport,
    owner: signer.address,
    calls,
    warnings,
    signatures: () => signatures,
  };
}

/** What a failed test needs to see: the wallets and every exchange, without a secret. */
function diagnostics(live: LiveSession): string {
  const { type, address } = live.session.toJSON();
  const trading = typeof address === 'string' ? ` trading ${address}` : '';
  const lines = live.calls.map(
    (call) => `${call.method} ${call.service} ${call.path} -> ${call.status}`,
  );
  const extra = unexpected(live.warnings);
  const warned = `${live.warnings.length} warning(s)${
    extra.length === 0 ? '' : `, unexpected: ${JSON.stringify(extra)}`
  }`;
  return [
    `[e2e] ${String(type)} owner ${live.owner}${trading}`,
    ...lines.map((line) => `  ${line}`),
    `  ${warned}`,
  ].join('\n');
}

/**
 * Call it inside a `describeLive` block. `start` is `liveSession`, and after each test (pass or
 * fail) every session it made is closed, so the backend keys are revoked, and then the wallets
 * and the exchanges (statuses only) are printed. Closing is idempotent, so a test may close
 * its session itself to check what `close()` did.
 */
export function trackSessions(): { start: typeof liveSession } {
  const opened: LiveSession[] = [];
  afterEach(async () => {
    const sessions = opened.splice(0);
    const closed = await Promise.allSettled(
      sessions.map((live) => live.session.close()),
    );
    for (const live of sessions) {
      console.info(diagnostics(live));
    }
    const failed = closed.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failed !== undefined) {
      throw failed.reason;
    }
  });
  return {
    start: (...args) => {
      const live = liveSession(...args);
      opened.push(live);
      return live;
    },
  };
}

/** A secure client of the e2e wallet, and the exchanges it made. */
export interface LiveClient {
  client: SecureClient;
  /** Every response its requests got, in order (not the chain's). */
  calls: HttpCall[];
}

/** What {@link trackClients} lets a test choose. The rest is fixed. */
export type LiveClientOptions = Pick<
  SecureClientOptions,
  'wallet' | 'credentials' | 'store' | 'rail' | 'label'
>;

/**
 * Call it inside a `describeSignedIn` block. `create` signs the e2e wallet in with
 * `createSecureClient` (strict responses, {@link liveFetch}, no process hooks) after the login
 * gap of both services, and after each test (pass or fail) every client it made is closed,
 * which revokes its 1-day backend key; then the exchanges (statuses only) are printed. Closing
 * is idempotent, so a test may close its client itself to check what `close()` did.
 */
export function trackClients(): {
  create: (options?: LiveClientOptions) => Promise<LiveClient>;
} {
  const opened: LiveClient[] = [];
  afterEach(async () => {
    const clients = opened.splice(0);
    const closed = await Promise.allSettled(
      clients.map((live) => live.client.close()),
    );
    for (const live of clients) {
      console.info(
        [
          `[e2e] secure client ${live.client.wallet}`,
          ...live.calls.map(
            (call) =>
              `  ${call.method} ${call.service} ${call.path} -> ${call.status}`,
          ),
        ].join('\n'),
      );
    }
    const failed = closed.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failed !== undefined) {
      throw failed.reason;
    }
  });
  return {
    create: async (options = {}) => {
      // The login gap cannot be waited inside the client's own request timeout, so it is
      // waited here, before the client signs in.
      await awaitLoginGap('backend', 'orderbook');
      const calls: HttpCall[] = [];
      const client = await createSecureClient({
        signer: e2ePublicSigner(),
        fetch: liveFetch(calls),
        strictResponses: true,
        // The test closes it (afterEach): no handler of this process is left behind.
        shutdownHooks: false,
        label: 'e2e',
        ...options,
      });
      const live: LiveClient = { client, calls };
      opened.push(live);
      return live;
    },
  };
}

/** The longest wait for a rate limit, in milliseconds. */
const MAX_RATE_LIMIT_WAIT_MS = 65_000;

/**
 * What a failed live call prints: the error and, for a response that did not match its
 * schema, the issues (paths and zod messages, never the values).
 */
export function describeFailure(error: unknown): string {
  if (error instanceof UnexpectedResponseError) {
    return `${error.message}\n${JSON.stringify(error.issues, null, 1)}`;
  }
  return error instanceof XoError
    ? `${error.name} ${error.status ?? ''}: ${error.message}`
    : String(error);
}

/**
 * Runs a live call; on a 429 waits what the server asked (once, at most
 * {@link MAX_RATE_LIMIT_WAIT_MS}) and tries again. A call that fails prints its label and
 * {@link describeFailure} before the test fails.
 */
export async function live<T>(
  label: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    try {
      return await run();
    } catch (error) {
      if (error instanceof RateLimitError) {
        await sleep(
          Math.min(error.retryAfter ?? 10_000, MAX_RATE_LIMIT_WAIT_MS),
        );
        return await run();
      }
      throw error;
    }
  } catch (error) {
    console.error(`[e2e] ${label} failed: ${describeFailure(error)}`);
    throw error;
  }
}
