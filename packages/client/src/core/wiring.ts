import { type ChainReader, createChainReader } from '../account/chain';
import { isEmptyCode } from '../account/internal';
import { type ProvidedCredentials, Session } from '../auth/session';
import type { CredentialStore } from '../auth/store';
import type { ContractReader } from '../orderbook/internal';
import { ServerTimeSchema } from '../orderbook/schemas';
import type { RealtimeHubOptions } from '../realtime/merged';
import type { WalletInput } from '../wallet/identity';
import type { InternalSigner } from '../wallet/signer';
import { Clock, DEFAULT_MAX_RTT_MS } from './clock';
import type { EnvironmentConfig } from './env';
import { parseResponse } from './schema';
import { type RateLimitUpdate, Transport } from './transport';
import { SDK_VERSION } from './version';
import { processWarn } from './warn';

// The shared core of a client: one transport, one server clock, one chain reader and, for a
// secure client, one session, wired together. Each client builds its own here (`createCore` for
// a secure client, `createPublicCore` for a public one), so they all get exactly the same
// wiring. Internal: no public barrel exports this module.

/** What a test can put in place of a part the core builds. */
export interface ClientSeams {
  /** Replaces `createChainReader(env)`: every part of the client reads this one instead. */
  chain?: ChainReader;
  /** The connection tuning and the buffer of a client's live subscriptions. */
  realtime?: Pick<
    RealtimeHubOptions,
    'orderbookConnection' | 'backendConnection' | 'bufferSize'
  >;
}

let seams: ClientSeams = {};

/** The seams in force. */
export function clientSeams(): ClientSeams {
  return seams;
}

/** Sets the seams of the clients created from now on; `{}` restores the defaults. Test-only. */
export function setClientSeams(next: ClientSeams): void {
  seams = { ...next };
}

/** What {@link createCore} builds the core from. Everything but `env` is optional. */
export interface CoreOptions<C extends ContractReader = ChainReader> {
  /** Resolved and validated already (`resolveEnvironment`). */
  env: EnvironmentConfig;
  signer?: InternalSigner;
  wallet?: WalletInput;
  store?: CredentialStore;
  provided?: ProvidedCredentials;
  label?: string;
  strictResponses?: boolean;
  fetch?: typeof fetch;
  onRateLimit?: (info: RateLimitUpdate) => void;
  /**
   * The per-attempt timeout of the session's sign-in and sign-out requests, in milliseconds.
   * Defaults to the transport's.
   */
  authTimeoutMs?: number;
  /**
   * A chain reader of your own; defaults to `createChainReader(env)`. One with `readContract`
   * only (what the orderbook client takes) serves the session too, without the smart wallet
   * deployment check before an orderbook login (the gateway refuses an undeployed smart wallet).
   */
  chain?: C;
}

/** One transport, clock, chain reader and session, with the session installed on the transport. */
export interface Core<C extends ContractReader = ChainReader> {
  env: EnvironmentConfig;
  transport: Transport;
  clock: Clock;
  chain: C;
  session: Session;
}

/** The SDK transport for `env`: it sends `X-XO-SDK: ts/<version>`. */
export function createTransport(o: {
  env: EnvironmentConfig;
  fetch?: typeof fetch;
  onRateLimit?: (info: RateLimitUpdate) => void;
}): Transport {
  return new Transport({
    env: o.env,
    version: SDK_VERSION,
    fetch: o.fetch,
    onRateLimit: o.onRateLimit,
  });
}

/**
 * The orderbook's `GET /time` for the clock: one attempt, no retry (a retried sample has a
 * long round trip, which the clock refuses anyway), and no longer than the clock trusts.
 */
async function serverTimeSec(
  transport: Transport,
  strict: boolean,
): Promise<number> {
  const data = await transport.request({
    service: 'orderbook',
    method: 'GET',
    path: '/time',
    auth: 'none',
    retry: 'none',
    timeoutMs: DEFAULT_MAX_RTT_MS,
  });
  return parseResponse(ServerTimeSchema, data, {
    strict,
    service: 'orderbook',
    path: '/time',
  });
}

/** What {@link createPublicCore} builds the core from. */
export interface PublicCoreOptions {
  /** Resolved and validated already (`resolveEnvironment`). */
  env: EnvironmentConfig;
  fetch?: typeof fetch;
  onRateLimit?: (info: RateLimitUpdate) => void;
  strictResponses?: boolean;
}

/** The parts of a client that holds no credentials: no session, no key, no wallet. */
export interface PublicCore {
  env: EnvironmentConfig;
  transport: Transport;
  clock: Clock;
  chain: ChainReader;
}

/**
 * Builds the core of a client without credentials: the same transport, clock and chain reader
 * {@link createCore} builds, and no session, so nothing on the transport can ask for a key. The
 * clock is not synced here; it reads the local time until a later call asks it to resync.
 * Nothing is requested here.
 */
export function createPublicCore(o: PublicCoreOptions): PublicCore {
  const { env } = o;
  const transport = createTransport(o);
  const chain = clientSeams().chain ?? createChainReader(env);
  const strict = o.strictResponses === true;
  const clock = new Clock({
    fetchServerTimeSec: () => serverTimeSec(transport, strict),
  });
  return { env, transport, clock, chain };
}

/**
 * Builds the core: the transport, a clock on the orderbook's `GET /time`, the chain reader
 * (yours, a test seam, or `createChainReader(env)`), and the one session, which reads the
 * smart wallet address and the deployment through that chain reader, warns through the
 * once-per-process warning, and is installed on the transport (`setAuth`). Nothing is
 * requested here.
 * @throws UserInputError for an invalid session option (signer, wallet, store, credentials, label).
 */
export function createCore<C extends ContractReader = ChainReader>(
  o: CoreOptions<C>,
): Core<C> {
  const { env } = o;
  const transport = createTransport(o);
  // Without a reader of your own, C is the full ChainReader, which both of these are.
  const chain = (o.chain ??
    clientSeams().chain ??
    createChainReader(env)) as C & Partial<ChainReader>;
  const getCode = chain.getCode;
  const strict = o.strictResponses === true;
  const clock = new Clock({
    fetchServerTimeSec: () => serverTimeSec(transport, strict),
  });
  const session = new Session({
    env,
    transport,
    clock,
    signer: o.signer,
    wallet: o.wallet,
    store: o.store,
    credentials: o.provided,
    label: o.label,
    readContract: (call) => chain.readContract(call),
    isDeployed:
      typeof getCode === 'function'
        ? async (address) => !isEmptyCode(await getCode.call(chain, address))
        : undefined,
    warn: processWarn,
    strictResponses: o.strictResponses,
    authTimeoutMs: o.authTimeoutMs,
  });
  transport.setAuth(session);
  return { env, transport, clock, chain, session };
}
