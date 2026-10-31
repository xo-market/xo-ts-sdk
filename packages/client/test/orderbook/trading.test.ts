import { delay, HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import {
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  hashTypedData,
  parseAbi,
  recoverAddress,
  recoverTypedDataAddress,
  size,
  slice,
  type TypedDataDefinition,
} from 'viem';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { Session } from '../../src/auth/session';
import { Clock } from '../../src/core/clock';
import { fromMicro } from '../../src/core/decimal';
import {
  AuthRequiredError,
  RateLimitError,
  RequestRejectedError,
  TimeoutError,
  TransportError,
  UnexpectedResponseError,
  UserInputError,
  XoError,
} from '../../src/core/errors';
import { type AuthProvider, Transport } from '../../src/core/transport';
import type { OrderHash } from '../../src/core/types';
import {
  type BuilderContext,
  buildLimitOrder,
  type SignedOrder,
} from '../../src/orderbook/builder';
import {
  BatchOpsIncompleteError,
  BatchPlaceIncompleteError,
  type ContractReader,
  OrderbookClient,
  PlacementError,
} from '../../src/orderbook/client';
import { resolveTradingIdentity } from '../../src/wallet/identity';
import type { InternalSigner } from '../../src/wallet/signer';
import {
  CONDITION_A,
  CONDITION_B,
  installMarketData,
  type MarketData,
  TOKEN_NO,
  TOKEN_UNKNOWN,
  TOKEN_YES,
} from '../helpers/mockMarketData';
import {
  type CredentialRecord,
  DERIVE_URL,
  installOrderbook,
  type Orderbook,
  type OrderbookRequest,
  seedKey,
} from '../helpers/mockOrderbook';
import { installTrading, type Trading } from '../helpers/mockTrading';
import {
  rejectedWith,
  serverFailure,
  tradingPaused,
} from '../helpers/rejections';
import { keySigner } from '../helpers/signers';
import { testEnv } from '../helpers/testEnv';
import { clobAuthVector, kernelVector } from '../signing/helpers';

const env = testEnv;
const BASE = env.orderbookUrl;

// The public test vector key from test-vectors/clobAuth.json. Never fund it.
const BASE_SIGNER = keySigner(clobAuthVector.inputs.privateKey);
const OWNER = BASE_SIGNER.address;
const ACCOUNT = kernelVector.createAccount.expectedAccount;
const PADDED_ACCOUNT =
  `0x${'00'.repeat(12)}${ACCOUNT.slice(2).toLowerCase()}` as Hex;
const NONCE = 7n;
const NONCES_ABI = parseAbi([
  'function nonces(address) view returns (uint128)',
]);
const EXCHANGE_DOMAIN = {
  name: 'XO Market CLOB',
  version: '1',
  chainId: env.chainId,
  verifyingContract: env.contracts.ctfExchange,
} as const;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function spiedSigner() {
  return {
    address: BASE_SIGNER.address,
    signMessage: vi.fn<InternalSigner['signMessage']>((m) =>
      BASE_SIGNER.signMessage(m),
    ),
    signTypedData: vi.fn<InternalSigner['signTypedData']>((td) =>
      BASE_SIGNER.signTypedData(td),
    ),
  };
}
type SpiedSigner = ReturnType<typeof spiedSigner>;

/** How many times the signer signed typed data of `primaryType`. */
const signed = (signer: SpiedSigner, primaryType: string) =>
  signer.signTypedData.mock.calls.filter(
    ([td]) => (td as { primaryType?: string }).primaryType === primaryType,
  ).length;

/** The ABI word `nonces(maker)` answers with. */
const nonceWord = (value: bigint): Hex =>
  encodeAbiParameters([{ type: 'uint128' }], [value]);

interface RigOptions {
  smartWallet?: boolean;
  /** `null`: no chain. */
  chain?: ContractReader | null;
  nonce?: bigint;
  maxRetries?: number;
  /** `false`: no session. */
  session?: false;
  strict?: boolean;
  pageLimit?: number;
  /** The server clock, in unix seconds (the session's Clock reads it). */
  serverNowSec?: () => number;
  /** The transport's per-attempt timeout. */
  timeoutMs?: number;
  /** The transport's auth provider, built around the session. `null`: none at all. */
  auth?: ((session: Session) => AuthProvider) | null;
  /** The client's local clock in ms (the tick-size cache). */
  now?: () => number;
}

interface Rig {
  client: OrderbookClient;
  session: Session;
  signer: SpiedSigner;
  trading: Trading;
  orderbook: Orderbook;
  market: MarketData;
  clock: Clock;
  readContract: ReturnType<typeof vi.fn<ContractReader['readContract']>>;
  credential: CredentialRecord;
  /** The trading address (the smart wallet, for a smart wallet). */
  trader: Address;
}

function rig(o: RigOptions = {}): Rig {
  const signer = spiedSigner();
  const transport = new Transport({
    env,
    version: '0.0.0-test',
    maxRetries: o.maxRetries ?? 2,
    ...(o.timeoutMs === undefined ? {} : { defaultTimeoutMs: o.timeoutMs }),
  });
  const clock = new Clock({
    fetchServerTimeSec: async () =>
      o.serverNowSec?.() ?? Math.floor(Date.now() / 1000),
  });
  const orderbook = installOrderbook(server, {
    smartAccounts: o.smartWallet
      ? { [ACCOUNT.toLowerCase()]: { owner: OWNER } }
      : {},
  });
  const market = installMarketData(server);
  const trading = installTrading(server, orderbook, {
    pageLimit: o.pageLimit,
  });
  const trader = o.smartWallet ? ACCOUNT : OWNER;
  const credential = seedKey(orderbook, trader);
  const session = new Session({
    env,
    transport,
    clock,
    signer,
    wallet: o.smartWallet
      ? { type: 'smart_wallet', index: 0 }
      : { type: 'eoa' },
    readContract: async () => PADDED_ACCOUNT,
    warn: vi.fn(),
  });
  if (o.auth !== null) {
    transport.setAuth(o.auth === undefined ? session : o.auth(session));
  }
  const readContract = vi.fn<ContractReader['readContract']>(async () =>
    nonceWord(o.nonce ?? NONCE),
  );
  const chain = o.chain === null ? undefined : (o.chain ?? { readContract });
  const client = new OrderbookClient({
    transport,
    env,
    ...(o.session === false ? {} : { session }),
    ...(chain === undefined ? {} : { chain }),
    ...(o.now === undefined ? {} : { now: o.now }),
    strictResponses: o.strict ?? true,
  });
  return {
    client,
    session,
    signer,
    trading,
    orderbook,
    market,
    clock,
    readContract,
    credential,
    trader,
  };
}

/** The requests that reached `route` ("METHOD /path"). */
const hits = (trading: Trading, route: string): OrderbookRequest[] =>
  trading.requests.filter((r) => `${r.method} ${r.path}` === route);

function only(trading: Trading, route: string): OrderbookRequest {
  const found = hits(trading, route);
  expect(found).toHaveLength(1);
  return found[0] as OrderbookRequest;
}

const queryOf = (r: OrderbookRequest) =>
  Object.fromEntries(new URLSearchParams(r.search));

async function caught(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

async function invalid(run: () => unknown): Promise<string> {
  const error = await caught(run);
  expect(error).toBeInstanceOf(UserInputError);
  return (error as UserInputError).message;
}

/** The L2 headers carried the seeded key (the fake verified the HMAC, or it would be a 401). */
function expectL2(r: OrderbookRequest, credential: CredentialRecord): void {
  expect(r.headers.get('XO_API_KEY')).toBe(credential.apiKey);
  expect(r.headers.get('XO_PASSPHRASE')).toBe(credential.passphrase);
  expect(r.headers.get('XO_TIMESTAMP')).toMatch(/^\d+$/);
  expect(r.headers.get('XO_SIGNATURE')).toMatch(/^[A-Za-z0-9_=-]+$/);
}

function expectNoL2(r: OrderbookRequest): void {
  for (const name of [
    'XO_API_KEY',
    'XO_PASSPHRASE',
    'XO_TIMESTAMP',
    'XO_SIGNATURE',
  ]) {
    expect(r.headers.get(name)).toBeNull();
  }
}

const SERVICE_UNAVAILABLE_503 = () =>
  HttpResponse.json(
    { error: 'service_unavailable', retry_after_ms: 0 },
    { status: 503 },
  );

/** Answers the first `times` requests to `route` with `respond()`, then lets the fake handle them. */
function failFirst(
  trading: Trading,
  route: string,
  times = 1,
  respond: () => Response = SERVICE_UNAVAILABLE_503,
): { count: () => number } {
  let count = 0;
  trading.override = (r) => {
    if (r !== route) {
      return undefined;
    }
    count += 1;
    return count <= times ? respond() : undefined;
  };
  return { count: () => count };
}

const limit = (over: Record<string, unknown> = {}) => ({
  tokenId: TOKEN_YES,
  side: 'BUY' as const,
  price: '0.5',
  size: '10',
  ...over,
});

/** Signed EOA orders built straight with the builder (no network), for the batch tests. */
const eoaIdentity = await resolveTradingIdentity(
  BASE_SIGNER,
  { type: 'eoa' },
  env,
  async () => '0x',
);
const staticCtx: BuilderContext = {
  env,
  identity: eoaIdentity,
  signer: BASE_SIGNER,
  nonce: async () => NONCE,
  tickSize: async () => '0.001',
  nowSec: () => Math.floor(Date.now() / 1000),
};
const ORDER_POOL: SignedOrder[] = [];
async function signedOrders(n: number): Promise<SignedOrder[]> {
  while (ORDER_POOL.length < n) {
    const i = ORDER_POOL.length;
    ORDER_POOL.push(
      await buildLimitOrder(
        {
          tokenId: i % 2 === 0 ? TOKEN_YES : TOKEN_NO,
          side: 'BUY',
          price: '0.5',
          size: String(10 + (i % 7)),
        },
        staticCtx,
      ),
    );
  }
  return ORDER_POOL.slice(0, n);
}

/** Places an order through the client and returns its hash. */
async function placed(r: Rig, over: Record<string, unknown> = {}) {
  const result = await r.client.placeOrder(limit(over));
  return result.orderHash;
}

// ---------------------------------------------------------------------------
// Build and sign
// ---------------------------------------------------------------------------

describe('createOrder / createMarketOrder', () => {
  test('createOrder builds and signs only: no placement, nonce from the chain, tick size from getTickSize', async () => {
    const r = rig();
    const order = await r.client.createOrder(limit());
    expect(order.order.maker).toBe(OWNER);
    expect(order.order.nonce).toBe(NONCE);
    expect(order.orderType).toBe('GTC');
    expect(order.postOnly).toBe(false);
    expect(order.orderHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.trading.calls).toEqual([]);
    expect(r.market.calls).toEqual(['GET /tick-size']);
    expect(signed(r.signer, 'Order')).toBe(1);
    // The EOA signature recovers to the trader.
    const recovered = await recoverTypedDataAddress({
      domain: EXCHANGE_DOMAIN,
      types: {
        Order: [
          { name: 'salt', type: 'uint256' },
          { name: 'maker', type: 'address' },
          { name: 'signer', type: 'address' },
          { name: 'beneficiary', type: 'address' },
          { name: 'tokenId', type: 'uint256' },
          { name: 'makerAmount', type: 'uint256' },
          { name: 'takerAmount', type: 'uint256' },
          { name: 'expiration', type: 'uint256' },
          { name: 'nonce', type: 'uint128' },
          { name: 'identifier', type: 'bytes16' },
          { name: 'metadata', type: 'bytes32' },
          { name: 'side', type: 'uint8' },
          { name: 'signatureType', type: 'uint8' },
        ],
      },
      primaryType: 'Order',
      message: order.order,
      signature: order.wire.signature,
    });
    expect(recovered).toBe(OWNER);
  });

  test('createMarketOrder builds a FAK at the cap, with no tick-size lookup', async () => {
    const r = rig();
    const order = await r.client.createMarketOrder({
      tokenId: TOKEN_YES,
      side: 'BUY',
      amount: '4.1',
    });
    expect(order.orderType).toBe('FAK');
    expect(order.order.makerAmount).toBe(4_100_000n);
    expect(order.order.nonce).toBe(NONCE);
    expect(r.market.calls).toEqual([]);
    expect(r.trading.calls).toEqual([]);
  });

  test("GTD expirations are checked against the session's server clock, not the local one", async () => {
    const dayAhead = () => Math.floor(Date.now() / 1000) + 86_400;
    const r = rig({ serverNowSec: dayAhead });
    await r.clock.sync();
    const localHourAhead = Math.floor(Date.now() / 1000) + 3600;
    const message = await invalid(() =>
      r.client.createOrder(limit({ type: 'GTD', expiration: localHourAhead })),
    );
    expect(message).toMatch(/^expiration must be at least/);
    const serverHourAhead = dayAhead() + 3600;
    const ok = await r.client.createOrder(
      limit({ type: 'GTD', expiration: serverHourAhead }),
    );
    expect(ok.order.expiration).toBe(BigInt(serverHourAhead));
  });

  test('smart wallet: maker is the smart wallet and the signature is 0x00-prefixed', async () => {
    const r = rig({ smartWallet: true });
    const order = await r.client.createOrder(limit());
    expect(order.order.maker).toBe(ACCOUNT);
    expect(order.order.signatureType).toBe(3);
    expect(size(order.wire.signature)).toBe(66);
    expect(slice(order.wire.signature, 0, 1)).toBe('0x00');
  });

  test('without a session: AuthRequiredError, nothing read or signed', async () => {
    const r = rig({ session: false });
    const error = await caught(() => r.client.createOrder(limit()));
    expect(error).toBeInstanceOf(AuthRequiredError);
    expect((error as Error).message).toMatch(/`session`/);
    expect(r.readContract).not.toHaveBeenCalled();
    expect(r.market.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Nonce
// ---------------------------------------------------------------------------

describe('nonce', () => {
  test('read once per client from nonces(maker) and reused across 3 orders', async () => {
    const r = rig();
    const orders = [
      await r.client.createOrder(limit()),
      await r.client.createOrder(limit({ side: 'SELL', price: '0.6' })),
      await r.client.createMarketOrder({
        tokenId: TOKEN_YES,
        side: 'BUY',
        amount: '2',
      }),
    ];
    expect(r.readContract).toHaveBeenCalledTimes(1);
    const call = r.readContract.mock.calls[0]?.[0];
    expect(call?.to).toBe(env.contracts.ctfExchange);
    expect(call?.data).toBe(
      encodeFunctionData({
        abi: NONCES_ABI,
        functionName: 'nonces',
        args: [OWNER],
      }),
    );
    expect(call?.data.slice(0, 10)).toBe('0x7ecebe00');
    for (const order of orders) {
      expect(order.order.nonce).toBe(NONCE);
    }
  });

  test('a smart wallet reads nonces(smart wallet)', async () => {
    const r = rig({ smartWallet: true });
    await r.client.createOrder(limit());
    expect(r.readContract.mock.calls[0]?.[0].data).toBe(
      encodeFunctionData({
        abi: NONCES_ABI,
        functionName: 'nonces',
        args: [ACCOUNT],
      }),
    );
  });

  test('refreshNonce() makes the next order read the nonce again', async () => {
    let value = NONCE;
    const r = rig();
    r.readContract.mockImplementation(async () => nonceWord(value));
    await r.client.createOrder(limit());
    value = 8n;
    expect((await r.client.createOrder(limit())).order.nonce).toBe(NONCE);
    r.client.refreshNonce();
    expect((await r.client.createOrder(limit())).order.nonce).toBe(8n);
    expect(r.readContract).toHaveBeenCalledTimes(2);
  });

  test('concurrent builds share one read', async () => {
    const r = rig();
    await Promise.all([
      r.client.createOrder(limit()),
      r.client.createOrder(limit()),
      r.client.createOrder(limit()),
    ]);
    expect(r.readContract).toHaveBeenCalledTimes(1);
  });

  test('a failed read is not cached and names only the error type', async () => {
    const r = rig();
    r.readContract.mockRejectedValueOnce(
      Object.assign(new Error('https://rpc.example/secret-key down'), {
        name: 'HttpRequestError',
      }),
    );
    const error = await caught(() => r.client.createOrder(limit()));
    expect(error).toBeInstanceOf(XoError);
    expect((error as XoError).code).toBe('nonce_unavailable');
    expect((error as XoError).service).toBe('chain');
    expect((error as XoError).message).toContain('HttpRequestError');
    expect((error as XoError).message).not.toContain('secret-key');
    expect(signed(r.signer, 'Order')).toBe(0);
    expect((await r.client.createOrder(limit())).order.nonce).toBe(NONCE);
    expect(r.readContract).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['empty', '0x'],
    ['short', '0x07'],
    ['33 bytes', `0x${'00'.repeat(33)}`],
    ['not hex', `0x${'zz'.repeat(32)}`],
    ['above uint128', `0x${'00'.repeat(15)}01${'00'.repeat(16)}`],
  ])(
    'an answer that is not a uint128 word (%s) is refused',
    async (_name, word) => {
      const r = rig();
      r.readContract.mockResolvedValue(word as Hex);
      const error = await caught(() => r.client.createOrder(limit()));
      expect((error as XoError).code).toBe('nonce_unavailable');
      expect(signed(r.signer, 'Order')).toBe(0);
    },
  );

  test('the largest uint128 is accepted', async () => {
    const r = rig({ nonce: 2n ** 128n - 1n });
    expect((await r.client.createOrder(limit())).order.nonce).toBe(
      2n ** 128n - 1n,
    );
  });

  test('no chain configured: UserInputError naming the `chain` option, nothing requested or signed', async () => {
    const r = rig({ chain: null });
    for (const run of [
      () => r.client.createOrder(limit()),
      () =>
        r.client.createMarketOrder({
          tokenId: TOKEN_YES,
          side: 'BUY',
          amount: '2',
        }),
      () => r.client.placeOrder(limit()),
    ]) {
      const error = await caught(run);
      expect(error).toBeInstanceOf(UserInputError);
      expect((error as UserInputError).code).toBe('chain_not_configured');
      expect((error as UserInputError).message).toMatch(/`chain`/);
    }
    expect(r.market.calls).toEqual([]);
    expect(r.trading.calls).toEqual([]);
    expect(r.signer.signTypedData).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// postOrder
// ---------------------------------------------------------------------------

describe('postOrder', () => {
  test('sends {order: wire, orderType, postOnly} only; the handler rejects unknown keys', async () => {
    const r = rig();
    const order = await r.client.createOrder(limit({ postOnly: true }));
    await r.client.postOrder(order);
    const sent = only(r.trading, 'POST /order');
    const body = JSON.parse(sent.body) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['order', 'orderType', 'postOnly']);
    expect(body).toEqual({
      order: order.wire,
      orderType: 'GTC',
      postOnly: true,
    });
    // The same body with one more key is refused by the fake, as the gateway refuses it.
    const refused = await fetch(`${BASE}/order`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, extra: 1 }),
    });
    expect(refused.status).toBe(400);
  });

  test('sends L2 headers, and the result is the gateway response plus the local orderHash', async () => {
    const r = rig();
    const order = await r.client.createOrder(limit());
    const result = await r.client.postOrder(order);
    expectL2(only(r.trading, 'POST /order'), r.credential);
    expect(result).toEqual({
      success: true,
      errorMsg: null,
      makingAmount: '0',
      takingAmount: '0',
      orderID: order.orderHash,
      status: 'live',
      transactionsHashes: [],
      tradeIds: [],
      orderHash: order.orderHash,
    });
    expect(r.trading.orders.map((o) => o.hash)).toEqual([order.orderHash]);
  });

  test('is never retried on 503 (1 hit)', async () => {
    const r = rig();
    const order = await r.client.createOrder(limit());
    const failing = failFirst(r.trading, 'POST /order', 5);
    const error = await caught(() => r.client.postOrder(order));
    expect(error).toSatisfy(serverFailure);
    expect(failing.count()).toBe(1);
  });

  test('is never retried on a network error (1 hit)', async () => {
    const r = rig();
    const order = await r.client.createOrder(limit());
    const failing = failFirst(r.trading, 'POST /order', 5, () =>
      HttpResponse.error(),
    );
    expect(await caught(() => r.client.postOrder(order))).toBeInstanceOf(
      TransportError,
    );
    expect(failing.count()).toBe(1);
  });

  test('FOK unfilled: 200 {success:true, status:"delayed"} returns a result; 200 {success:false} also returns one', async () => {
    const r = rig();
    r.trading.outcome = () => ({ rest: false, status: 'delayed' });
    const fok = await r.client.createOrder(limit({ type: 'FOK' }));
    const delayed = await r.client.postOrder(fok);
    expect(delayed.success).toBe(true);
    expect(delayed.status).toBe('delayed');
    expect(delayed.orderHash).toBe(fok.orderHash);

    r.trading.outcome = () => ({
      rest: false,
      success: false,
      errorMsg: 'order could not be fully filled',
      status: 'delayed',
    });
    const other = await r.client.createOrder(limit({ type: 'FOK' }));
    const failed = await r.client.postOrder(other);
    expect(failed.success).toBe(false);
    expect(failed.errorMsg).toBe('order could not be fully filled');
    expect(failed.orderHash).toBe(other.orderHash);
  });

  test('an unknown status is kept (lenient) and refused in strict mode', async () => {
    const lenient = rig({ strict: false });
    lenient.trading.outcome = () => ({ status: 'held' });
    expect((await lenient.client.placeOrder(limit())).status).toBe('held');
    server.resetHandlers();
    const strict = rig();
    strict.trading.outcome = () => ({ status: 'held' });
    expect(
      await caught(() => strict.client.placeOrder(limit())),
    ).toBeInstanceOf(UnexpectedResponseError);
  });

  test('503 trading_paused → trading_paused rejection with Retry-After 60, not retried', async () => {
    const r = rig();
    const order = await r.client.createOrder(limit());
    r.trading.paused = true;
    const error = await caught(() => r.client.postOrder(order));
    expect(error).toSatisfy(tradingPaused);
    expect((error as RequestRejectedError).retryAfter).toBe(60_000);
    expect(hits(r.trading, 'POST /order')).toHaveLength(1);
  });

  test('409 order_cancelled_during_hold → 409 rejection, not retried', async () => {
    const r = rig();
    const order = await r.client.createOrder(limit());
    const failing = failFirst(r.trading, 'POST /order', 5, () =>
      HttpResponse.json(
        {
          error: 'order_cancelled_during_hold',
          message: 'order was cancelled while in the taker-delay hold window',
        },
        { status: 409 },
      ),
    );
    const error = await caught(() => r.client.postOrder(order));
    expect(error).toSatisfy(rejectedWith(409));
    expect((error as RequestRejectedError).code).toBe(
      'order_cancelled_during_hold',
    );
    expect(failing.count()).toBe(1);
  });

  test('a duplicate (400 with prose only) is a plain 400 RequestRejectedError: no special handling, no resend', async () => {
    const r = rig();
    const order = await r.client.createOrder(limit());
    await r.client.postOrder(order);
    const error = await caught(() => r.client.postOrder(order));
    expect(error).toSatisfy(rejectedWith(400));
    expect((error as RequestRejectedError).code).toBe('http_400');
    expect(hits(r.trading, 'POST /order')).toHaveLength(2);
    expect(r.trading.orders).toHaveLength(1);
  });

  test('401 → exactly one resend with byte-identical body and no re-sign', async () => {
    const r = rig();
    const failing = failFirst(r.trading, 'POST /order', 1, () =>
      HttpResponse.json({ error: 'invalid L2 signature' }, { status: 401 }),
    );
    const result = await r.client.placeOrder(limit());
    const sent = hits(r.trading, 'POST /order');
    expect(sent).toHaveLength(2);
    expect(failing.count()).toBe(2);
    expect(sent[1]?.body).toBe(sent[0]?.body);
    expect(signed(r.signer, 'Order')).toBe(1);
    // The session recovered the credentials in between (derive, L1-signed again).
    expect(signed(r.signer, 'ClobAuth')).toBe(2);
    expect(result.orderHash).toBe(r.trading.orders[0]?.hash);
  });

  test('a second 401 is thrown, still with no re-sign', async () => {
    const r = rig();
    failFirst(r.trading, 'POST /order', 5, () =>
      HttpResponse.json({ error: 'invalid L2 signature' }, { status: 401 }),
    );
    const order = await r.client.createOrder(limit());
    expect(
      (await caught(() => r.client.postOrder(order))) as XoError,
    ).toMatchObject({
      status: 401,
    });
    expect(hits(r.trading, 'POST /order')).toHaveLength(2);
    expect(signed(r.signer, 'Order')).toBe(1);
  });

  test.each([
    ['not an object', null, 'order'],
    [
      'no orderHash',
      { orderType: 'GTC', postOnly: false, wire: {} },
      'order.orderHash',
    ],
    [
      'bad orderHash',
      { orderHash: '0x12', orderType: 'GTC', postOnly: false, wire: {} },
      'order.orderHash',
    ],
    [
      'no wire',
      { orderHash: `0x${'ab'.repeat(32)}`, orderType: 'GTC', postOnly: false },
      'order.wire',
    ],
    [
      'bad orderType',
      {
        orderHash: `0x${'ab'.repeat(32)}`,
        orderType: 'IOC',
        postOnly: false,
        wire: {},
      },
      'order.orderType',
    ],
    [
      'postOnly not boolean',
      {
        orderHash: `0x${'ab'.repeat(32)}`,
        orderType: 'GTC',
        postOnly: 'yes',
        wire: {},
      },
      'order.postOnly',
    ],
    [
      'postOnly with FOK',
      {
        orderHash: `0x${'ab'.repeat(32)}`,
        orderType: 'FOK',
        postOnly: true,
        wire: {},
      },
      'order.postOnly',
    ],
  ])(
    'refuses a malformed signed order (%s) before any request',
    async (_name, value, field) => {
      const r = rig();
      const message = await invalid(() =>
        r.client.postOrder(value as unknown as SignedOrder),
      );
      expect(message.startsWith(field)).toBe(true);
      expect(r.trading.calls).toEqual([]);
    },
  );

  test('placeOrder = createOrder + postOrder; placeMarketOrder places a FAK', async () => {
    const r = rig();
    const result = await r.client.placeOrder(limit());
    expect(result.orderHash).toBe(result.orderID);
    const market = await r.client.placeMarketOrder({
      tokenId: TOKEN_YES,
      side: 'SELL',
      amount: '3',
    });
    const body = JSON.parse(
      hits(r.trading, 'POST /order')[1]?.body ?? '{}',
    ) as Record<string, unknown>;
    expect(body.orderType).toBe('FAK');
    expect(body.postOnly).toBe(false);
    expect(market.orderHash).toBe(market.orderID);
    expect(signed(r.signer, 'Order')).toBe(2);
  });

  test('a smart wallet places as the smart wallet (the fake checks EIP-1271)', async () => {
    const r = rig({ smartWallet: true });
    const result = await r.client.placeOrder(limit());
    expect(r.trading.orders[0]?.owner).toBe(ACCOUNT.toLowerCase());
    expect(result.status).toBe('live');
  });
});

// ---------------------------------------------------------------------------
// postOrders
// ---------------------------------------------------------------------------

describe('postOrders', () => {
  test('301 orders → 2 requests (300 + 1), results in input order', async () => {
    const r = rig();
    const orders = await signedOrders(301);
    const results = await r.client.postOrders(orders);
    const sent = hits(r.trading, 'POST /orders');
    expect(sent.map((s) => (JSON.parse(s.body) as unknown[]).length)).toEqual([
      300, 1,
    ]);
    for (const s of sent) {
      expectL2(s, r.credential);
    }
    expect(results).toHaveLength(301);
    results.forEach((result, i) => {
      expect(result.orderHash).toBe(orders[i]?.orderHash);
      expect(result.order_hash).toBe(orders[i]?.orderHash);
      expect(result.error).toBeNull();
    });
    const first = JSON.parse(sent[0]?.body ?? '[]') as unknown[];
    expect(first[0]).toEqual({
      order: orders[0]?.wire,
      orderType: 'GTC',
      postOnly: false,
    });
  });

  test('per-order failures are results, not errors', async () => {
    const r = rig();
    const [good] = await signedOrders(1);
    const unknown = await buildLimitOrder(
      limit({ tokenId: TOKEN_UNKNOWN }),
      staticCtx,
    );
    const results = await r.client.postOrders([good as SignedOrder, unknown]);
    expect(results[0]?.error).toBeNull();
    expect(results[1]?.error).toMatch(/No orderbook exists/);
    expect(results[1]?.order_hash).toBeNull();
    expect(results[1]?.orderHash).toBe(unknown.orderHash);
  });

  test('a failing second chunk → batch_place_incomplete with results, failedChunk and notSent; never retried', async () => {
    const r = rig();
    const orders = await signedOrders(650);
    let chunk = 0;
    r.trading.override = (route) => {
      if (route !== 'POST /orders') {
        return undefined;
      }
      chunk += 1;
      return chunk === 2 ? SERVICE_UNAVAILABLE_503() : undefined;
    };
    const error = await caught(() => r.client.postOrders(orders));
    expect(error).toBeInstanceOf(BatchPlaceIncompleteError);
    expect(error).toBeInstanceOf(XoError);
    const incomplete = error as BatchPlaceIncompleteError;
    expect(incomplete.code).toBe('batch_place_incomplete');
    expect(incomplete.cause).toSatisfy(serverFailure);
    expect(incomplete.results.map((x) => x.orderHash)).toEqual(
      orders.slice(0, 300).map((o) => o.orderHash),
    );
    expect(incomplete.failedChunk).toEqual(
      orders.slice(300, 600).map((o) => o.orderHash),
    );
    expect(incomplete.notSent).toEqual(
      orders.slice(600).map((o) => o.orderHash),
    );
    expect(chunk).toBe(2);
    expect(incomplete.mayHaveLanded).toBe(true);
    expect(incomplete.message).toMatch(/may have been placed/);
    expect(incomplete.toJSON()).toMatchObject({
      code: 'batch_place_incomplete',
      failedChunk: incomplete.failedChunk,
      notSent: incomplete.notSent,
    });
  });

  test('a failing first chunk → nothing in results, the rest not sent', async () => {
    const r = rig();
    const orders = await signedOrders(301);
    const failing = failFirst(r.trading, 'POST /orders', 5, () =>
      HttpResponse.error(),
    );
    const incomplete = (await caught(() =>
      r.client.postOrders(orders),
    )) as BatchPlaceIncompleteError;
    expect(incomplete.code).toBe('batch_place_incomplete');
    expect(incomplete.cause).toBeInstanceOf(TransportError);
    expect(incomplete.mayHaveLanded).toBe(true);
    expect(incomplete.results).toEqual([]);
    expect(incomplete.failedChunk).toHaveLength(300);
    expect(incomplete.notSent).toEqual([orders[300]?.orderHash]);
    expect(failing.count()).toBe(1);
  });

  test('an answer that cannot be paired with the chunk (wrong count) is an incomplete batch', async () => {
    const r = rig();
    const orders = await signedOrders(2);
    failFirst(r.trading, 'POST /orders', 1, () =>
      HttpResponse.json({ results: [] }),
    );
    const incomplete = (await caught(() =>
      r.client.postOrders(orders),
    )) as BatchPlaceIncompleteError;
    expect(incomplete.code).toBe('batch_place_incomplete');
    expect(incomplete.cause).toBeInstanceOf(UnexpectedResponseError);
    expect(incomplete.mayHaveLanded).toBe(true);
    expect(incomplete.failedChunk).toEqual(orders.map((o) => o.orderHash));
  });

  test('an answer whose order_hash is not the order at that index is an incomplete batch', async () => {
    const r = rig();
    const orders = await signedOrders(2);
    const entry = (hash: string) => ({
      order_id: hash,
      fills: 0,
      resting: true,
      remaining_size: '10',
      error: null,
      order_hash: hash,
    });
    failFirst(r.trading, 'POST /orders', 1, () =>
      HttpResponse.json({
        results: [
          entry(orders[1]?.orderHash as string),
          entry(orders[0]?.orderHash as string),
        ],
      }),
    );
    const incomplete = (await caught(() =>
      r.client.postOrders(orders),
    )) as BatchPlaceIncompleteError;
    expect(incomplete.cause).toBeInstanceOf(UnexpectedResponseError);
  });

  test('refuses an empty list, a duplicate order and a malformed element before any request', async () => {
    const r = rig();
    const orders = await signedOrders(3);
    expect(await invalid(() => r.client.postOrders([]))).toMatch(/^orders/);
    expect(
      await invalid(() =>
        r.client.postOrders([
          orders[0] as SignedOrder,
          orders[1] as SignedOrder,
          orders[0] as SignedOrder,
        ]),
      ),
    ).toMatch(/^orders\[2\].*same order/);
    const big = [...(await signedOrders(401))];
    big[400] = { ...big[400], orderType: 'IOC' } as unknown as SignedOrder;
    expect(await invalid(() => r.client.postOrders(big))).toMatch(
      /^orders\[400\]\.orderType/,
    );
    expect(
      await invalid(() =>
        r.client.postOrders('nope' as unknown as SignedOrder[]),
      ),
    ).toMatch(/^orders/);
    expect(r.trading.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// batchOps
// ---------------------------------------------------------------------------

describe('batchOps', () => {
  test('sends place and cancel groups with L2 and pairs the results with the inputs', async () => {
    const r = rig();
    const resting = await placed(r);
    const orders = await signedOrders(2);
    const results = await r.client.batchOps([
      { type: 'cancel', ids: [resting] },
      { type: 'place', orders },
    ]);
    const sent = only(r.trading, 'POST /orders/batch-ops');
    expectL2(sent, r.credential);
    expect(JSON.parse(sent.body)).toEqual({
      ops: [
        { type: 'cancel', payload: [resting] },
        {
          type: 'place',
          payload: orders.map((o) => ({
            order: o.wire,
            orderType: o.orderType,
            postOnly: o.postOnly,
          })),
        },
      ],
    });
    expect(results[0]).toEqual({
      type: 'cancel',
      payload: { canceled: [resting], notCanceled: {} },
    });
    const place = results[1];
    expect(place?.type).toBe('place');
    if (place?.type === 'place') {
      expect(place.payload?.map((p) => p.orderHash)).toEqual(
        orders.map((o) => o.orderHash),
      );
    }
  });

  test('is never retried (it places orders)', async () => {
    const r = rig();
    const failing = failFirst(r.trading, 'POST /orders/batch-ops', 5);
    const orders = await signedOrders(1);
    const error = (await caught(() =>
      r.client.batchOps([{ type: 'place', orders }]),
    )) as BatchOpsIncompleteError;
    expect(error).toBeInstanceOf(BatchOpsIncompleteError);
    expect(error.cause).toSatisfy(serverFailure);
    expect(failing.count()).toBe(1);
  });

  test('an answer that does not match the groups: batch_ops_incomplete, every order to reconcile and no result', async () => {
    const r = rig();
    const answered = [
      { type: 'cancel', payload: { canceled: [], notCanceled: {} } },
    ];
    failFirst(r.trading, 'POST /orders/batch-ops', 1, () =>
      HttpResponse.json({ results: answered }),
    );
    const orders = await signedOrders(1);
    const error = (await caught(() =>
      r.client.batchOps([{ type: 'place', orders }]),
    )) as BatchOpsIncompleteError;
    expect(error.code).toBe('batch_ops_incomplete');
    expect(error.cause).toBeInstanceOf(UnexpectedResponseError);
    expect(error.mayHaveLanded).toBe(true);
    // An answer that cannot be paired with the groups sent says nothing reliable of any order.
    expect(error.results).toEqual([]);
    expect(error.orderHashes).toEqual(orders.map((o) => o.orderHash));
  });

  test('refuses bad ops before any request', async () => {
    const r = rig();
    const orders = await signedOrders(1);
    expect(await invalid(() => r.client.batchOps([]))).toMatch(/^ops/);
    expect(
      await invalid(() => r.client.batchOps([{ type: 'replace' } as never])),
    ).toMatch(/^ops\[0\]\.type/);
    expect(
      await invalid(() =>
        r.client.batchOps([{ type: 'place', orders, extra: 1 } as never]),
      ),
    ).toMatch(/^ops\[0\] has an unknown key/);
    expect(
      await invalid(() =>
        r.client.batchOps([{ type: 'cancel', ids: ['nope'] }]),
      ),
    ).toMatch(/^ops\[0\]\.ids\[0\]/);
    expect(
      await invalid(() =>
        r.client.batchOps([
          { type: 'place', orders },
          { type: 'place', orders },
        ]),
      ),
    ).toMatch(/same order/);
    expect(r.trading.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cancels
// ---------------------------------------------------------------------------

/** The CancelOrder / CancelAll typed data, written out from the gateway's verifier. */
function cancelTypedData(
  marketId: string,
  orderId?: bigint,
): TypedDataDefinition {
  return orderId === undefined
    ? {
        domain: EXCHANGE_DOMAIN,
        types: { CancelAll: [{ name: 'marketId', type: 'string' }] },
        primaryType: 'CancelAll',
        message: { marketId },
      }
    : {
        domain: EXCHANGE_DOMAIN,
        types: {
          CancelOrder: [
            { name: 'orderId', type: 'uint64' },
            { name: 'marketId', type: 'string' },
          ],
        },
        primaryType: 'CancelOrder',
        message: { orderId, marketId },
      };
}

describe('cancels (HMAC by default)', () => {
  test('cancelOrder(hash) sends {orderID} with L2 and returns the CancelResponse', async () => {
    const r = rig();
    const hash = await placed(r);
    const result = await r.client.cancelOrder(
      hash.toUpperCase().replace('0X', '0x'),
    );
    const sent = only(r.trading, 'DELETE /order');
    expectL2(sent, r.credential);
    expect(JSON.parse(sent.body)).toEqual({ orderID: hash });
    expect(result).toEqual({ canceled: [hash], notCanceled: {} });
    expect(r.trading.orders).toEqual([]);
  });

  test('cancelOrder with a numeric id and a conditionId', async () => {
    const r = rig();
    await placed(r);
    const result = await r.client.cancelOrder('0001', {
      conditionId: CONDITION_A,
    });
    expect(JSON.parse(only(r.trading, 'DELETE /order').body)).toEqual({
      orderID: '1',
      marketId: CONDITION_A,
    });
    expect(result.canceled).toEqual(['1']);
  });

  test('cancelOrder of an unknown order → 404 rejection', async () => {
    const r = rig();
    expect(
      await caught(() => r.client.cancelOrder(`0x${'cd'.repeat(32)}`)),
    ).toSatisfy(rejectedWith(404));
  });

  test('cancelOrders sends the ids as a JSON array with L2', async () => {
    const r = rig();
    const a = await placed(r);
    const b = await placed(r, { price: '0.4' });
    const missing = `0x${'ee'.repeat(32)}`;
    const result = await r.client.cancelOrders([a, b, missing]);
    const sent = only(r.trading, 'DELETE /orders');
    expectL2(sent, r.credential);
    expect(JSON.parse(sent.body)).toEqual([a, b, missing]);
    expect(result).toEqual({
      canceled: [a, b],
      notCanceled: { [missing]: 'order not found' },
    });
  });

  test('cancelAll sends an empty body with L2', async () => {
    const r = rig();
    const a = await placed(r);
    const b = await placed(r, { tokenId: TOKEN_NO });
    const result = await r.client.cancelAll();
    const sent = only(r.trading, 'DELETE /cancel-all');
    expect(sent.body).toBe('');
    expect(sent.headers.get('content-type')).toBeNull();
    expectL2(sent, r.credential);
    expect(result).toEqual({ canceled: [a, b], notCanceled: {} });
  });

  test('cancelMarketOrders sends {marketId, assetId} with L2; the gateway cancels the whole market', async () => {
    const r = rig();
    const yes = await placed(r);
    const no = await placed(r, { tokenId: TOKEN_NO });
    const result = await r.client.cancelMarketOrders({
      conditionId: CONDITION_A.toUpperCase().replace('0X', '0x'),
      tokenId: `0${TOKEN_YES}`,
    });
    const sent = only(r.trading, 'DELETE /cancel-market-orders');
    expectL2(sent, r.credential);
    expect(JSON.parse(sent.body)).toEqual({
      marketId: CONDITION_A,
      assetId: TOKEN_YES,
    });
    expect(result.canceled).toEqual([yes, no]);
  });

  test.each([
    [
      'cancelOrder',
      'DELETE /order',
      (r: Rig, hash: string) => r.client.cancelOrder(hash),
    ],
    [
      'cancelOrders',
      'DELETE /orders',
      (r: Rig, hash: string) => r.client.cancelOrders([hash]),
    ],
    ['cancelAll', 'DELETE /cancel-all', (r: Rig) => r.client.cancelAll()],
    [
      'cancelMarketOrders',
      'DELETE /cancel-market-orders',
      (r: Rig) => r.client.cancelMarketOrders({ conditionId: CONDITION_A }),
    ],
    [
      'cancelAll signed',
      'DELETE /cancel-all',
      (r: Rig) => r.client.cancelAll({ signed: true }),
    ],
  ])('%s is sent once: a 503 is not retried', async (_name, route, run) => {
    const r = rig();
    const hash = await placed(r);
    const failing = failFirst(r.trading, route, 1);
    const error = await caught(() => run(r, hash));
    expect(error).toSatisfy(rejectedWith(503));
    expect(failing.count()).toBe(1);
    // The order is still open: nothing was sent again.
    expect(r.trading.orders.map((o) => o.hash)).toEqual([hash]);
  });

  test('409 order_in_delay_window → 409 rejection', async () => {
    const r = rig();
    const hash = await placed(r);
    const failing = failFirst(r.trading, 'DELETE /order', 5, () =>
      HttpResponse.json(
        {
          error: 'order_in_delay_window',
          message:
            'order is in the taker-delay hold window; retry after the window expires',
        },
        { status: 409 },
      ),
    );
    const error = await caught(() => r.client.cancelOrder(hash));
    expect(error).toSatisfy(rejectedWith(409));
    expect((error as RequestRejectedError).code).toBe('order_in_delay_window');
    expect(failing.count()).toBe(1);
  });

  test('refuses bad ids and options before any request', async () => {
    const r = rig();
    for (const bad of [
      '',
      '0x12',
      'abc',
      '-1',
      '18446744073709551616',
      12,
      null,
    ]) {
      expect(await invalid(() => r.client.cancelOrder(bad as string))).toMatch(
        /^idOrHash/,
      );
    }
    expect(await invalid(() => r.client.cancelOrders(['1', 'x']))).toMatch(
      /^ids\[1\]/,
    );
    expect(
      await invalid(() => r.client.cancelOrders('1' as unknown as string[])),
    ).toMatch(/^ids/);
    expect(
      await invalid(() =>
        r.client.cancelAll({ signed: true, marketId: 'x' } as never),
      ),
    ).toMatch(/unknown key "marketId"/);
    expect(
      await invalid(() => r.client.cancelAll({ signed: 'yes' } as never)),
    ).toMatch(/^signed/);
    expect(
      await invalid(() =>
        r.client.cancelMarketOrders({ conditionId: 'market-1' }),
      ),
    ).toMatch(/^conditionId/);
    expect(
      await invalid(() =>
        r.client.cancelMarketOrders({
          conditionId: CONDITION_A,
          tokenId: '0x1',
        }),
      ),
    ).toMatch(/^tokenId/);
    expect(r.trading.calls).toEqual([]);
  });
});

describe('cancels (signed EIP-712)', () => {
  test('cancelAll({signed:true}) sends {signature, signatureType, signer} (no marketId), no L2, and recovers to the trader', async () => {
    const r = rig();
    const a = await placed(r);
    const result = await r.client.cancelAll({ signed: true });
    const sent = only(r.trading, 'DELETE /cancel-all');
    expectNoL2(sent);
    const body = JSON.parse(sent.body) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['signature', 'signatureType', 'signer']);
    expect(body.signatureType).toBe(0);
    expect(body.signer).toBe(OWNER);
    const recovered = await recoverTypedDataAddress({
      ...cancelTypedData(''),
      signature: body.signature as Hex,
    } as Parameters<typeof recoverTypedDataAddress>[0]);
    expect(recovered).toBe(OWNER);
    expect(result).toEqual({ canceled: [a], notCanceled: {} });
    expect(signed(r.signer, 'CancelAll')).toBe(1);
  });

  test('why marketId is left out: the gateway scopes marketId "" to a market that does not exist (404)', async () => {
    const r = rig();
    const signature = await BASE_SIGNER.signTypedData(cancelTypedData(''));
    const response = await fetch(`${BASE}/cancel-all`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        marketId: '',
        signature,
        signatureType: 0,
        signer: OWNER,
      }),
    });
    expect(response.status).toBe(404);
    expect(hits(r.trading, 'DELETE /cancel-all')).toHaveLength(1);
  });

  test('smart wallet: signed cancel-all has signatureType 3, the smart wallet as signer and a 0x00-prefixed signature', async () => {
    const r = rig({ smartWallet: true });
    const a = await placed(r);
    const result = await r.client.cancelAll({ signed: true });
    const body = JSON.parse(only(r.trading, 'DELETE /cancel-all').body) as {
      signature: Hex;
      signatureType: number;
      signer: Address;
    };
    expect(body.signatureType).toBe(3);
    expect(body.signer).toBe(ACCOUNT);
    expect(size(body.signature)).toBe(66);
    expect(slice(body.signature, 0, 1)).toBe('0x00');
    // The inner signature is the owner's, over the Kernel wrap of the CancelAll digest.
    const wrapped = hashTypedData({
      domain: {
        name: 'Kernel',
        version: '0.3.1',
        chainId: env.chainId,
        verifyingContract: ACCOUNT,
      },
      types: { Kernel: [{ name: 'hash', type: 'bytes32' }] },
      primaryType: 'Kernel',
      message: { hash: hashTypedData(cancelTypedData('')) },
    });
    expect(
      await recoverAddress({
        hash: wrapped,
        signature: slice(body.signature, 1),
      }),
    ).toBe(OWNER);
    expect(result.canceled).toEqual([a]);
  });

  test('cancelOrder(id, {signed, conditionId}) signs CancelOrder(id, conditionId) and recovers to the trader', async () => {
    const r = rig();
    await placed(r);
    const result = await r.client.cancelOrder('1', {
      signed: true,
      conditionId: CONDITION_A,
    });
    const sent = only(r.trading, 'DELETE /order');
    expectNoL2(sent);
    const body = JSON.parse(sent.body) as Record<string, unknown>;
    expect(body).toEqual({
      orderID: '1',
      marketId: CONDITION_A,
      signature: body.signature,
      signatureType: 0,
      signer: OWNER,
    });
    const recovered = await recoverTypedDataAddress({
      ...cancelTypedData(CONDITION_A, 1n),
      signature: body.signature as Hex,
    } as Parameters<typeof recoverTypedDataAddress>[0]);
    expect(recovered).toBe(OWNER);
    expect(result).toEqual({ canceled: ['1'], notCanceled: {} });
  });

  test('a signed cancel needs the numeric id and the conditionId', async () => {
    const r = rig();
    expect(
      await invalid(() =>
        r.client.cancelOrder(`0x${'ab'.repeat(32)}`, {
          signed: true,
          conditionId: CONDITION_A,
        }),
      ),
    ).toMatch(/^idOrHash.*numeric/);
    expect(
      await invalid(() => r.client.cancelOrder('1', { signed: true })),
    ).toMatch(/^conditionId.*required/);
    expect(r.signer.signTypedData).not.toHaveBeenCalled();
    expect(r.trading.calls).toEqual([]);
  });

  test('cancelOrders(ids, {signed, conditionId}) sends {orderIds, marketId, signature, signatureType, signer} with no L2; the signature is CancelOrder(first id, conditionId)', async () => {
    const r = rig();
    await placed(r);
    await placed(r, { price: '0.4' });
    const result = await r.client.cancelOrders(['1', '2', '77'], {
      signed: true,
      conditionId: CONDITION_A,
    });
    const sent = only(r.trading, 'DELETE /orders');
    expectNoL2(sent);
    const body = JSON.parse(sent.body) as Record<string, unknown>;
    // The gateway's batch-cancel body: the ids as whole JSON numbers, and nothing else.
    expect(body).toEqual({
      orderIds: [1, 2, 77],
      marketId: CONDITION_A,
      signature: body.signature,
      signatureType: 0,
      signer: OWNER,
    });
    const recovered = await recoverTypedDataAddress({
      ...cancelTypedData(CONDITION_A, 1n),
      signature: body.signature as Hex,
    } as Parameters<typeof recoverTypedDataAddress>[0]);
    expect(recovered).toBe(OWNER);
    expect(signed(r.signer, 'CancelOrder')).toBe(1);
    expect(result).toEqual({
      canceled: ['1', '2'],
      notCanceled: { '77': 'order not found' },
    });
  });

  test('a signed batch cancel needs numeric ids (JSON-safe), at least one, and the conditionId; conditionId alone is refused', async () => {
    const r = rig();
    const signedA = { signed: true, conditionId: CONDITION_A };
    expect(
      await invalid(() =>
        r.client.cancelOrders(['1', `0x${'ab'.repeat(32)}`], signedA),
      ),
    ).toMatch(/^ids\[1\].*numeric/);
    expect(
      await invalid(() => r.client.cancelOrders(['9007199254740992'], signedA)),
    ).toMatch(/^ids\[0\].*9007199254740991/);
    expect(await invalid(() => r.client.cancelOrders([], signedA))).toMatch(
      /^ids.*at least one/,
    );
    expect(
      await invalid(() => r.client.cancelOrders(['1'], { signed: true })),
    ).toMatch(/^conditionId.*required/);
    expect(
      await invalid(() =>
        r.client.cancelOrders(['1'], { conditionId: CONDITION_A }),
      ),
    ).toMatch(/^conditionId.*signed/);
    expect(
      await invalid(() =>
        r.client.cancelOrders(['1'], { signed: true, market: 'x' } as never),
      ),
    ).toMatch(/unknown key "market"/);
    expect(r.signer.signTypedData).not.toHaveBeenCalled();
    expect(r.trading.calls).toEqual([]);
  });

  test('cancelMarketOrders({signed}) signs CancelAll(conditionId)', async () => {
    const r = rig();
    const a = await placed(r);
    const result = await r.client.cancelMarketOrders({
      conditionId: CONDITION_A,
      signed: true,
    });
    const sent = only(r.trading, 'DELETE /cancel-market-orders');
    expectNoL2(sent);
    const body = JSON.parse(sent.body) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([
      'marketId',
      'signature',
      'signatureType',
      'signer',
    ]);
    const recovered = await recoverTypedDataAddress({
      ...cancelTypedData(CONDITION_A),
      signature: body.signature as Hex,
    } as Parameters<typeof recoverTypedDataAddress>[0]);
    expect(recovered).toBe(OWNER);
    expect(result.canceled).toEqual([a]);
  });

  test('signed cancels need a session with a signer', async () => {
    const r = rig({ session: false });
    expect(
      await caught(() => r.client.cancelAll({ signed: true })),
    ).toBeInstanceOf(AuthRequiredError);
  });
});

// ---------------------------------------------------------------------------
// Own data
// ---------------------------------------------------------------------------

const LEGACY_IDENTITY_KEYS = ['maker', 'maker_address', 'address'];

function trade(
  id: string,
  market: string,
  ids: { taker?: string; maker?: string } = {},
) {
  return {
    id,
    market,
    outcome: 'YES',
    side: 'BUY',
    price: '0.500',
    size: '10',
    status: 'MATCHED',
    match_time: '1800000000',
    last_update: '1800000000',
    bucket_index: 0,
    transaction_hash: null,
    taker_order_id: ids.taker ?? `0x${'aa'.repeat(32)}`,
    asset_id: TOKEN_YES,
    fee_rate_bps: '0',
    owner: '6f1e7a5c-0000-5000-8000-000000000000',
    maker_address: `0x${'bb'.repeat(20)}`,
    trader_side: 'TAKER',
    maker_orders: [
      {
        order_id: ids.maker ?? `0x${'cc'.repeat(32)}`,
        maker_address: `0x${'bb'.repeat(20)}`,
        owner: '6f1e7a5c-0000-5000-8000-000000000001',
        matched_amount: '10',
        price: '0.500',
        fee_rate_bps: '0',
        asset_id: TOKEN_YES,
        outcome: 'YES',
      },
    ],
    maker_original_size: '10000000',
    taker_original_size: '10000000',
  };
}

const TRADE_1 = `0x${'01'.repeat(32)}`;
const TRADE_2 = `0x${'02'.repeat(32)}`;
const TRADE_3 = `0x${'03'.repeat(32)}`;

describe('own data', () => {
  test('getOpenOrders uses L2, never sends maker/address, and paginates with next_cursor', async () => {
    const r = rig({ pageLimit: 2 });
    const hashes = [
      await placed(r),
      await placed(r, { price: '0.4' }),
      await placed(r, { price: '0.3' }),
    ];
    const orders = await r.client.getOpenOrders().toArray();
    expect(orders.map((o) => o.id)).toEqual(hashes);
    expect(orders[0]).toMatchObject({
      market: CONDITION_A,
      outcome: 'YES',
      side: 'BUY',
      price: '0.500',
      original_size: '10',
      status: 'LIVE',
      order_hash: hashes[0],
      asset_id: TOKEN_YES,
      order_type: 'GTC',
    });
    const sent = hits(r.trading, 'GET /data/orders');
    expect(sent.map(queryOf)).toEqual([{}, { next_cursor: btoa('2') }]);
    for (const s of sent) {
      expectL2(s, r.credential);
    }
  });

  test('getOpenOrders filters by conditionId and tokenId (market, asset_id)', async () => {
    const r = rig();
    await placed(r);
    const no = await placed(r, { tokenId: TOKEN_NO });
    const orders = await r.client
      .getOpenOrders({
        conditionId: CONDITION_A.toUpperCase().replace('0X', '0x'),
        tokenId: TOKEN_NO,
      })
      .toArray();
    expect(orders.map((o) => o.id)).toEqual([no]);
    expect(queryOf(only(r.trading, 'GET /data/orders'))).toEqual({
      market: CONDITION_A,
      asset_id: TOKEN_NO,
    });
  });

  test('getOrder(hash) reads /data/order/{hash}; an unknown order is a 404 rejection', async () => {
    const r = rig();
    const hash = await placed(r);
    const order = await r.client.getOrder(hash);
    expect(order.id).toBe(hash);
    expectL2(only(r.trading, `GET /data/order/${hash}`), r.credential);
    expect(await caught(() => r.client.getOrder('99'))).toSatisfy(
      rejectedWith(404),
    );
  });

  test('getTrades uses L2, filters by conditionId and paginates; getTrade reads /trades/{id}', async () => {
    const r = rig({ pageLimit: 2 });
    const me = OWNER.toLowerCase();
    r.trading.trades.push(
      { owner: me, trade: trade(TRADE_1, CONDITION_A) },
      { owner: me, trade: trade(TRADE_2, CONDITION_B) },
      { owner: me, trade: trade(TRADE_3, CONDITION_A) },
      { owner: '0xsomeone', trade: trade(`0x${'04'.repeat(32)}`, CONDITION_A) },
    );
    const all = await r.client.getTrades().toArray();
    // Newest first, as the gateway lists them.
    expect(all.map((t) => t.id)).toEqual([TRADE_3, TRADE_2, TRADE_1]);
    expect(all[0]?.transaction_hash).toBeNull();
    expect(all[0]?.maker_orders[0]?.matched_amount).toBe('10');
    const inA = await r.client
      .getTrades({ conditionId: CONDITION_A })
      .toArray();
    expect(inA.map((t) => t.id)).toEqual([TRADE_3, TRADE_1]);
    const sent = hits(r.trading, 'GET /data/trades');
    expect(sent.map(queryOf)).toEqual([
      {},
      { next_cursor: btoa('2') },
      { market: CONDITION_A },
    ]);
    for (const s of sent) {
      expectL2(s, r.credential);
    }
    const one = await r.client.getTrade(
      TRADE_2.toUpperCase().replace('0X', '0x'),
    );
    expect(one.id).toBe(TRADE_2);
    expect(only(r.trading, `GET /trades/${TRADE_2}`).search).toBe('');
  });

  test('getBalanceAllowance sends asset_type (and token_id) with L2, never an address', async () => {
    const r = rig();
    r.trading.accounts.set(OWNER.toLowerCase(), {
      cash: '25000000',
      positions: [{ token_id: TOKEN_YES, balance: '4000000', reserved: '0' }],
    });
    expect(
      await r.client.getBalanceAllowance({ assetType: 'COLLATERAL' }),
    ).toEqual({
      balance: '25000000',
      allowance: '0',
      smart_account: '00'.repeat(20),
    });
    const conditional = await r.client.getBalanceAllowance({
      assetType: 'CONDITIONAL',
      tokenId: TOKEN_YES,
    });
    expect(conditional.balance).toBe('4000000');
    const sent = hits(r.trading, 'GET /balance-allowance');
    expect(sent.map(queryOf)).toEqual([
      { asset_type: 'COLLATERAL' },
      { asset_type: 'CONDITIONAL', token_id: TOKEN_YES },
    ]);
    for (const s of sent) {
      expectL2(s, r.credential);
    }
  });

  test('getBalanceAllowance refuses bad options before any request', async () => {
    const r = rig();
    for (const bad of [
      {},
      { assetType: 'collateral' },
      { assetType: 'CONDITIONAL' },
      { assetType: 'COLLATERAL', tokenId: TOKEN_YES },
      { assetType: 'CONDITIONAL', tokenId: 'x' },
      { assetType: 'COLLATERAL', address: OWNER },
    ]) {
      await invalid(() => r.client.getBalanceAllowance(bad as never));
    }
    expect(r.trading.calls).toEqual([]);
  });

  test('getPositions sends address = the trading address (the route requires it) alongside L2', async () => {
    const r = rig();
    r.trading.accounts.set(OWNER.toLowerCase(), {
      cash: '1000000',
      positions: [
        { token_id: TOKEN_YES, balance: '4000000', reserved: '1000000' },
      ],
    });
    expect(await r.client.getPositions()).toEqual({
      cash_balance: '1000000',
      positions: [
        { token_id: TOKEN_YES, balance: '4000000', reserved: '1000000' },
      ],
    });
    const sent = only(r.trading, 'GET /positions');
    expect(queryOf(sent)).toEqual({ address: OWNER.toLowerCase() });
    expectL2(sent, r.credential);
  });

  test('smart wallet: getPositions asks for the smart wallet', async () => {
    const r = rig({ smartWallet: true });
    await r.client.getPositions();
    expect(queryOf(only(r.trading, 'GET /positions'))).toEqual({
      address: ACCOUNT.toLowerCase(),
    });
  });

  test('getClaimable uses L2 only (the HMAC principal is the identity)', async () => {
    const r = rig();
    r.trading.claimable.set(OWNER.toLowerCase(), [
      {
        market_id: CONDITION_A,
        outcome: 'YES',
        token_id: TOKEN_YES,
        balance: '5000000',
        refund_reason: 'resolved_winner',
      },
    ]);
    const claimable = await r.client.getClaimable();
    expect(claimable.address).toBe(OWNER.toLowerCase());
    expect(claimable.claimable[0]?.refund_reason).toBe('resolved_winner');
    const sent = only(r.trading, 'GET /claimable');
    expect(sent.search).toBe('');
    expectL2(sent, r.credential);
  });

  test('getMarketCapacity sends market = the condition id with L2', async () => {
    const r = rig();
    r.trading.accounts.set(OWNER.toLowerCase(), {
      cash: '9000000',
      positions: [
        { token_id: TOKEN_NO, balance: '3000000', reserved: '1000000' },
      ],
    });
    const capacity = await r.client.getMarketCapacity(
      CONDITION_A.toUpperCase().replace('0X', '0x'),
    );
    expect(capacity.market_id).toBe(CONDITION_A);
    expect(capacity.free_market_capacity).toBe('9000000');
    expect(capacity.positions.map((p) => [p.outcome, p.free_position])).toEqual(
      [
        ['YES', '0'],
        ['NO', '2000000'],
      ],
    );
    const sent = only(r.trading, 'GET /data/market-capacity');
    expect(queryOf(sent)).toEqual({ market: CONDITION_A });
    expectL2(sent, r.credential);
  });

  test('micro-unit amounts are checked as plain decimals, in lenient mode too: a JSON number is converted exactly, anything else fails the read', async () => {
    const r = rig({ strict: false });
    r.trading.override = (route) => {
      if (route === 'GET /positions') {
        return HttpResponse.json({
          cash_balance: 12500000,
          positions: [
            { token_id: TOKEN_YES, balance: '4000000', reserved: '0' },
          ],
        });
      }
      if (route === 'GET /data/market-capacity') {
        return HttpResponse.json({
          user_id: 'u-1',
          market_id: CONDITION_A,
          free_market_capacity: 'plenty',
          positions: [],
          smart_account: null,
        });
      }
      return undefined;
    };
    const positions = await r.client.getPositions();
    expect(positions.cash_balance).toBe('12500000');
    const error = await caught(() => r.client.getMarketCapacity(CONDITION_A));
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(JSON.stringify((error as UnexpectedResponseError).issues)).toContain(
      'free_market_capacity',
    );
  });

  test('a free_position becomes an order size through fromMicro, the explicit conversion the types ask for', async () => {
    const r = rig();
    r.trading.accounts.set(OWNER.toLowerCase(), {
      cash: '0',
      positions: [
        { token_id: TOKEN_NO, balance: '3000000', reserved: '1000000' },
      ],
    });
    const capacity = await r.client.getMarketCapacity(CONDITION_A);
    const free = capacity.positions.find((p) => p.outcome === 'NO');
    expect(free?.free_position).toBe('2000000');
    const order = await r.client.createOrder({
      tokenId: TOKEN_NO,
      side: 'SELL',
      price: '0.5',
      size: fromMicro(BigInt(free?.free_position ?? '0')),
    });
    expect(order.order.makerAmount).toBe(2_000_000n);
  });

  test('no own-data read sends maker, maker_address or address, except /positions', async () => {
    const r = rig();
    const hash = await placed(r);
    r.trading.trades.push({
      owner: OWNER.toLowerCase(),
      trade: trade(TRADE_1, CONDITION_A),
    });
    await r.client.getOpenOrders({ conditionId: CONDITION_A }).toArray();
    await r.client.getOrder(hash);
    await r.client.getTrades({ conditionId: CONDITION_A }).toArray();
    await r.client.getTrade(TRADE_1);
    await r.client.getBalanceAllowance({ assetType: 'COLLATERAL' });
    await r.client.getPositions();
    await r.client.getClaimable();
    await r.client.getMarketCapacity(CONDITION_A);
    const reads = r.trading.requests.filter((q) => q.method === 'GET');
    expect(reads).toHaveLength(8);
    for (const read of reads) {
      expectL2(read, r.credential);
      const keys = Object.keys(queryOf(read));
      const allowed = read.path === '/positions' ? ['address'] : [];
      for (const key of LEGACY_IDENTITY_KEYS) {
        if (!allowed.includes(key)) {
          expect(keys).not.toContain(key);
        }
      }
    }
  });

  test('the fake refuses a maker or address query on the routes that must not get one', async () => {
    const r = rig();
    for (const path of [
      '/data/orders?maker=0x1',
      '/data/trades?maker_address=0x1',
      `/balance-allowance?address=${OWNER}`,
    ]) {
      const response = await fetch(`${BASE}${path}`);
      expect(response.status).toBe(400);
    }
    expect(r.trading.calls).toHaveLength(3);
  });

  test('closed options and ids: unknown keys and bad ids are refused before any request', async () => {
    const r = rig();
    await invalid(() => r.client.getOpenOrders({ maker: OWNER } as never));
    await invalid(() => r.client.getOpenOrders({ conditionId: 'market-1' }));
    await invalid(() => r.client.getOpenOrders({ tokenId: '0x12' }));
    await invalid(() => r.client.getTrades({ tokenId: TOKEN_YES } as never));
    await invalid(() => r.client.getTrades({ address: OWNER } as never));
    await invalid(() => r.client.getOrder('xyz'));
    await invalid(() => r.client.getTrade('42'));
    await invalid(() => r.client.getMarketCapacity('market-1'));
    expect(r.trading.calls).toEqual([]);
  });

  test('getPositions without a session is an AuthRequiredError', async () => {
    const r = rig({ session: false });
    expect(await caught(() => r.client.getPositions())).toBeInstanceOf(
      AuthRequiredError,
    );
  });

  test('strict mode refuses an extra field on an own-data response; lenient keeps it', async () => {
    const strict = rig();
    strict.trading.override = (route) =>
      route === 'GET /claimable'
        ? HttpResponse.json({
            address: OWNER.toLowerCase(),
            claimable: [],
            extra: 1,
          })
        : undefined;
    expect(await caught(() => strict.client.getClaimable())).toBeInstanceOf(
      UnexpectedResponseError,
    );
    server.resetHandlers();
    const lenient = rig({ strict: false });
    lenient.trading.override = strict.trading.override;
    const kept = (await lenient.client.getClaimable()) as unknown as Record<
      string,
      unknown
    >;
    expect(kept.extra).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Reconcilable placement errors, tick-size cache
// ---------------------------------------------------------------------------

/** An auth provider around the session whose `headers()` throws `error` for the `nth` placement request. */
function failingAuth(
  path: '/order' | '/orders' | '/orders/batch-ops',
  nth: number,
  error: () => unknown,
): (session: Session) => AuthProvider {
  return (session) => {
    let seen = 0;
    return {
      headers: async (kind, req) => {
        if (req.method === 'POST' && req.path === path) {
          seen += 1;
          if (seen === nth) {
            throw error();
          }
        }
        return session.headers(kind, req);
      },
      onUnauthorized: (kind, ctx) => session.onUnauthorized(kind, ctx),
    };
  };
}

const status = (code: number, body: Record<string, unknown>) => () =>
  HttpResponse.json(body, { status: code });

describe('errors after signing carry orderHash and mayHaveLanded', () => {
  test('a 504 for an order the engine took: 5xx rejection, mayHaveLanded true, orderHash finds it', async () => {
    const r = rig();
    r.trading.outcome = () => ({
      respond: HttpResponse.json({ error: 'gateway timeout' }, { status: 504 }),
    });
    const error = (await caught(() => r.client.placeOrder(limit()))) as XoError;
    expect(error).toSatisfy(serverFailure);
    expect(error.status).toBe(504);
    expect(error.mayHaveLanded).toBe(true);
    expect(error.orderHash).toBe(r.trading.orders[0]?.hash);
    expect(hits(r.trading, 'POST /order')).toHaveLength(1);
    // The hash is enough to reconcile: the order is resting.
    r.trading.outcome = undefined;
    const reconciled = await r.client.reconcileOrder(error.orderHash as string);
    expect(reconciled.state).toBe('resting');
    expect(error.toJSON()).toMatchObject({
      orderHash: error.orderHash,
      mayHaveLanded: true,
    });
  });

  test('a 400: RequestRejectedError, mayHaveLanded false, with the orderHash', async () => {
    const r = rig();
    failFirst(
      r.trading,
      'POST /order',
      1,
      status(400, { error: 'invalid request: invalid size' }),
    );
    const error = (await caught(() => r.client.placeOrder(limit()))) as XoError;
    expect(error).toSatisfy(rejectedWith(400));
    expect(error.mayHaveLanded).toBe(false);
    expect(error.orderHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(JSON.parse(only(r.trading, 'POST /order').body).order).toBeDefined();
  });

  test('a timeout: TimeoutError, mayHaveLanded true', async () => {
    const r = rig({ timeoutMs: 50 });
    server.use(
      http.post(`${BASE}/order`, async () => {
        await delay(400);
        return HttpResponse.json({});
      }),
    );
    const error = (await caught(() =>
      r.client.placeMarketOrder({
        tokenId: TOKEN_YES,
        side: 'BUY',
        amount: '2',
      }),
    )) as XoError;
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.mayHaveLanded).toBe(true);
    expect(error.orderHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test.each([
    ['a network error', true, () => HttpResponse.error(), TransportError],
    [
      'a 200 that does not parse',
      true,
      () => HttpResponse.json({ success: true }),
      UnexpectedResponseError,
    ],
    [
      'a 503 trading_paused (checked before any work: refused)',
      false,
      status(503, { error: 'trading_paused', message: 'paused' }),
      RequestRejectedError,
    ],
    [
      'a 409',
      false,
      status(409, { error: 'order_cancelled_during_hold', message: 'held' }),
      RequestRejectedError,
    ],
    [
      'a 429',
      false,
      status(429, { error: 'rate limit exceeded', retry_after_ms: 0 }),
      RateLimitError,
    ],
  ] as const)('%s → mayHaveLanded %s', async (_name, landed, respond, kind) => {
    const r = rig({ maxRetries: 0 });
    failFirst(r.trading, 'POST /order', 5, respond);
    const error = (await caught(() => r.client.placeOrder(limit()))) as XoError;
    expect(error).toBeInstanceOf(kind);
    expect(error.mayHaveLanded).toBe(landed);
    expect(error.orderHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test('a 401 the refresh did not cure → mayHaveLanded false', async () => {
    const r = rig();
    failFirst(
      r.trading,
      'POST /order',
      5,
      status(401, { error: 'invalid L2 signature' }),
    );
    const error = (await caught(() => r.client.placeOrder(limit()))) as XoError;
    expect(error.status).toBe(401);
    expect(error.mayHaveLanded).toBe(false);
  });

  test('a local error before sending (no auth provider): mayHaveLanded false, nothing sent', async () => {
    const r = rig({ auth: null });
    const error = (await caught(() => r.client.placeOrder(limit()))) as XoError;
    expect(error).toBeInstanceOf(AuthRequiredError);
    expect(error.mayHaveLanded).toBe(false);
    expect(error.orderHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.trading.calls).toEqual([]);
  });

  test.each([
    [
      'a 503 from the orderbook derive',
      () =>
        new RequestRejectedError('derive failed', {
          code: 'service_unavailable',
          status: 503,
          service: 'orderbook',
        }),
      RequestRejectedError,
    ],
    [
      'a timeout of the orderbook derive',
      () => new TimeoutError('derive timed out', { service: 'orderbook' }),
      TimeoutError,
    ],
  ] as const)(
    'a credential refresh that fails before sending (%s) → mayHaveLanded false, nothing sent',
    async (_name, failure, kind) => {
      const r = rig({ auth: failingAuth('/order', 1, failure) });
      const error = (await caught(() =>
        r.client.placeOrder(limit()),
      )) as XoError;
      expect(error).toBeInstanceOf(kind);
      expect(error.mayHaveLanded).toBe(false);
      expect(error.orderHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(r.trading.calls).toEqual([]);
    },
  );

  test('a refresh after a 401 that fails (a 503 from the derive) → mayHaveLanded false: the 401 means the order was not processed', async () => {
    const r = rig({
      auth: (session) => ({
        headers: (kind, req) => session.headers(kind, req),
        onUnauthorized: async () => {
          throw new RequestRejectedError('derive failed', {
            code: 'service_unavailable',
            status: 503,
            service: 'orderbook',
          });
        },
      }),
    });
    failFirst(
      r.trading,
      'POST /order',
      1,
      status(401, { error: 'invalid L2 signature' }),
    );
    const error = (await caught(() => r.client.placeOrder(limit()))) as XoError;
    expect(error).toSatisfy(serverFailure);
    expect(error.status).toBe(503);
    expect(error.mayHaveLanded).toBe(false);
    expect(r.trading.calls.filter((c) => c === 'POST /order')).toHaveLength(1);
  });

  test('a non-SDK error from the auth provider is wrapped: PlacementError with the original as cause', async () => {
    const failure = new Error('credential store unavailable');
    const r = rig({ auth: failingAuth('/order', 1, () => failure) });
    const error = (await caught(() =>
      r.client.placeOrder(limit()),
    )) as PlacementError;
    expect(error).toBeInstanceOf(PlacementError);
    expect(error).toBeInstanceOf(XoError);
    expect(error.code).toBe('placement_failed');
    expect(error.cause).toBe(failure);
    expect(error.mayHaveLanded).toBe(false);
    expect(error.orderHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((failure as { orderHash?: string }).orderHash).toBeUndefined();
    expect(r.trading.calls).toEqual([]);
  });

  test('a DOMException before sending is wrapped, and message and String() work', async () => {
    const failure = new DOMException(
      'storage is not available',
      'NotAllowedError',
    );
    const r = rig({ auth: failingAuth('/order', 1, () => failure) });
    const error = (await caught(() =>
      r.client.placeOrder(limit()),
    )) as PlacementError;
    expect(error).toBeInstanceOf(PlacementError);
    expect(error.cause).toBe(failure);
    expect(error.message).toMatch(/NotAllowedError/);
    expect(String(error)).toMatch(/^PlacementError: /);
    expect(error.orderHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(error.mayHaveLanded).toBe(false);
    expect(JSON.stringify(error)).toContain(error.orderHash as string);
  });

  test('a 429 copy keeps RateLimitError and its retryAfter', async () => {
    const r = rig({ maxRetries: 0 });
    failFirst(
      r.trading,
      'POST /order',
      5,
      status(429, { error: 'rate limit exceeded', retry_after_ms: 1500 }),
    );
    const error = (await caught(() =>
      r.client.placeOrder(limit()),
    )) as RateLimitError;
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.retryAfter).toBe(1500);
    expect(error.status).toBe(429);
    expect(error.mayHaveLanded).toBe(false);
    expect(error.orderHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(error.toJSON()).toMatchObject({ retryAfter: 1500 });
  });

  test('postOrder attaches the same: the hash is the signed order’s', async () => {
    const r = rig();
    const order = await r.client.createOrder(limit());
    failFirst(r.trading, 'POST /order', 1, () => HttpResponse.error());
    const error = (await caught(() => r.client.postOrder(order))) as XoError;
    expect(error.orderHash).toBe(order.orderHash);
    expect(error.mayHaveLanded).toBe(true);
  });

  test('an error before the post step (a malformed signed order) carries neither', async () => {
    const r = rig();
    const error = (await caught(() =>
      r.client.postOrder({} as SignedOrder),
    )) as XoError;
    expect(error).toBeInstanceOf(UserInputError);
    expect(error.orderHash).toBeUndefined();
    expect(error.mayHaveLanded).toBeUndefined();
    expect(Object.keys(error.toJSON())).not.toContain('orderHash');
  });

  test('errors outside placement do not get the properties', async () => {
    const r = rig();
    const error = (await caught(() =>
      r.client.cancelOrder(`0x${'cd'.repeat(32)}`),
    )) as XoError;
    expect(error).toSatisfy(rejectedWith(404));
    expect(error.mayHaveLanded).toBeUndefined();
    expect(error.orderHash).toBeUndefined();
  });
});

describe('batch_place_incomplete by the same rule', () => {
  test('a chunk that failed locally before sending goes to notSent, not failedChunk', async () => {
    const orders = await signedOrders(650);
    const r = rig({
      auth: failingAuth(
        '/orders',
        2,
        () => new AuthRequiredError('no credentials'),
      ),
    });
    const incomplete = (await caught(() =>
      r.client.postOrders(orders),
    )) as BatchPlaceIncompleteError;
    expect(incomplete).toBeInstanceOf(BatchPlaceIncompleteError);
    expect(incomplete.code).toBe('batch_place_incomplete');
    expect(incomplete.mayHaveLanded).toBe(false);
    expect(incomplete.cause).toBeInstanceOf(AuthRequiredError);
    expect(incomplete.results.map((x) => x.orderHash)).toEqual(
      orders.slice(0, 300).map((o) => o.orderHash),
    );
    expect(incomplete.failedChunk).toEqual([]);
    expect(incomplete.notSent).toEqual(
      orders.slice(300).map((o) => o.orderHash),
    );
    expect(hits(r.trading, 'POST /orders')).toHaveLength(1);
    expect(incomplete.message).toMatch(/not sent/);
    expect(incomplete.message).not.toMatch(/may have been placed/);
  });

  test('a credential refresh that fails with a 503 before a chunk is sent: that chunk goes to notSent', async () => {
    const orders = await signedOrders(2);
    const r = rig({
      auth: failingAuth(
        '/orders',
        1,
        () =>
          new RequestRejectedError('derive failed', {
            code: 'service_unavailable',
            status: 503,
            service: 'orderbook',
          }),
      ),
    });
    const incomplete = (await caught(() =>
      r.client.postOrders(orders),
    )) as BatchPlaceIncompleteError;
    expect(incomplete.mayHaveLanded).toBe(false);
    expect(incomplete.failedChunk).toEqual([]);
    expect(incomplete.notSent).toEqual(orders.map((o) => o.orderHash));
    expect(r.trading.calls).toEqual([]);
  });

  test('batchOps: a credential refresh that fails with a timeout before sending is not may-have-run', async () => {
    const [order] = await signedOrders(1);
    const r = rig({
      auth: failingAuth(
        '/orders/batch-ops',
        1,
        () => new TimeoutError('derive timed out', { service: 'orderbook' }),
      ),
    });
    const incomplete = (await caught(() =>
      r.client.batchOps([{ type: 'place', orders: [order as SignedOrder] }]),
    )) as BatchOpsIncompleteError;
    expect(incomplete).toBeInstanceOf(BatchOpsIncompleteError);
    expect(incomplete.mayHaveLanded).toBe(false);
    expect(r.trading.calls).toEqual([]);
  });

  test('a local failure of the first chunk: nothing sent, everything in notSent', async () => {
    const orders = await signedOrders(2);
    const r = rig({ auth: failingAuth('/orders', 1, () => new Error('disk')) });
    const incomplete = (await caught(() =>
      r.client.postOrders(orders),
    )) as BatchPlaceIncompleteError;
    expect(incomplete.mayHaveLanded).toBe(false);
    expect(incomplete.failedChunk).toEqual([]);
    expect(incomplete.notSent).toEqual(orders.map((o) => o.orderHash));
    expect(r.trading.calls).toEqual([]);
  });

  test('a definitive 4xx for a chunk: failedChunk names it, mayHaveLanded false', async () => {
    const orders = await signedOrders(301);
    const r = rig();
    let chunk = 0;
    r.trading.override = (route) => {
      if (route !== 'POST /orders') {
        return undefined;
      }
      chunk += 1;
      return chunk === 2
        ? HttpResponse.json(
            { error: 'invalid request body: unknown field `extra`' },
            { status: 400 },
          )
        : undefined;
    };
    const incomplete = (await caught(() =>
      r.client.postOrders(orders),
    )) as BatchPlaceIncompleteError;
    expect(incomplete.cause).toSatisfy(rejectedWith(400));
    expect(incomplete.mayHaveLanded).toBe(false);
    expect(incomplete.failedChunk).toEqual([orders[300]?.orderHash]);
    expect(incomplete.notSent).toEqual([]);
    expect(incomplete.results).toHaveLength(300);
    expect(incomplete.message).toMatch(/refused/);
  });
});

describe('tick-size cache (5 minutes, per token)', () => {
  test('one GET for several limit builds on the same token; another token gets its own', async () => {
    const r = rig();
    await r.client.createOrder(limit());
    await r.client.createOrder(limit({ side: 'SELL', price: '0.6' }));
    await r.client.placeOrder(limit({ price: '0.4' }));
    await r.client.createOrder(limit({ tokenId: TOKEN_NO }));
    await r.client.createOrder(limit({ tokenId: TOKEN_NO }));
    const asked = r.market.requests
      .filter((q) => q.path === '/tick-size')
      .map((q) => new URLSearchParams(q.search).get('token_id'));
    expect(asked).toEqual([TOKEN_YES, TOKEN_NO]);
  });

  test('cached for just under 5 minutes; fetched again at 5 minutes', async () => {
    let now = 1_000_000;
    const r = rig({ now: () => now });
    await r.client.createOrder(limit());
    now += 299_999;
    await r.client.createOrder(limit());
    expect(r.market.calls).toEqual(['GET /tick-size']);
    now += 1;
    await r.client.createOrder(limit());
    expect(r.market.calls).toEqual(['GET /tick-size', 'GET /tick-size']);
    now += 299_999;
    await r.client.createOrder(limit());
    expect(r.market.calls).toHaveLength(2);
  });

  test('a local clock stepped back counts as expired', async () => {
    let now = 1_000_000;
    const r = rig({ now: () => now });
    await r.client.createOrder(limit());
    now -= 1;
    await r.client.createOrder(limit());
    expect(r.market.calls).toHaveLength(2);
  });

  test('concurrent builds share one GET; a failed GET is not cached', async () => {
    const r = rig();
    let fails = 1;
    r.market.override = (route) => {
      if (route !== '/tick-size' || fails === 0) {
        return undefined;
      }
      fails -= 1;
      return HttpResponse.json({ error: 'market not found' }, { status: 404 });
    };
    expect(await caught(() => r.client.createOrder(limit()))).toSatisfy(
      rejectedWith(404),
    );
    await Promise.all([
      r.client.createOrder(limit()),
      r.client.createOrder(limit()),
      r.client.createOrder(limit()),
    ]);
    expect(r.market.calls).toEqual(['GET /tick-size', 'GET /tick-size']);
  });

  test('getTickSize() itself always asks the gateway', async () => {
    const r = rig();
    await r.client.createOrder(limit());
    await r.client.getTickSize(TOKEN_YES);
    await r.client.getTickSize(TOKEN_YES);
    expect(r.market.calls).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation, a paused gateway, incomplete batches, per-call errors and hash integrity
// ---------------------------------------------------------------------------

const timeout504 = () =>
  HttpResponse.json({ error: 'gateway timeout' }, { status: 504 });

describe('reconcileOrder', () => {
  /** The fake fills each placement completely (no rest) and answers a 504 anyway. */
  function fillsAs(r: Rig, side: 'taker' | 'maker') {
    let n = 0;
    r.trading.outcome = (o) => {
      n += 1;
      r.trading.trades.push({
        owner: o.owner,
        trade: trade(
          `0x${n.toString(16).padStart(64, '0')}`,
          o.market,
          side === 'taker' ? { taker: o.hash } : { maker: o.hash },
        ),
      });
      return { rest: false, status: 'matched', respond: timeout504() };
    };
  }

  test('a filled FAK: getOrder is a 404, reconcileOrder finds it in the trades', async () => {
    const r = rig();
    fillsAs(r, 'taker');
    const error = (await caught(() =>
      r.client.placeMarketOrder({
        tokenId: TOKEN_YES,
        side: 'BUY',
        amount: '2',
      }),
    )) as XoError;
    expect(error.mayHaveLanded).toBe(true);
    const hash = error.orderHash as string;
    r.trading.outcome = undefined;
    expect(await caught(() => r.client.getOrder(hash))).toSatisfy(
      rejectedWith(404),
    );
    const found = await r.client.reconcileOrder(hash);
    expect(found.state).toBe('traded');
    if (found.state === 'traded') {
      expect(found.trades.map((t) => t.taker_order_id)).toEqual([hash]);
    }
    for (const read of r.trading.requests.filter((q) => q.method === 'GET')) {
      expectL2(read, r.credential);
    }
  });

  test('a maker fill matches maker_orders[].order_id, in any case', async () => {
    const r = rig();
    fillsAs(r, 'maker');
    const error = (await caught(() => r.client.placeOrder(limit()))) as XoError;
    const hash = error.orderHash as string;
    const found = await r.client.reconcileOrder(
      hash.toUpperCase().replace('0X', '0x'),
    );
    expect(found.state).toBe('traded');
    if (found.state === 'traded') {
      expect(found.trades[0]?.maker_orders[0]?.order_id).toBe(hash);
    }
  });

  test('an order held in the taker-delay window: getOrder sees it LIVE, reconcileOrder says resting, a cancel removes it', async () => {
    const r = rig();
    r.trading.outcome = () => ({ hold: true, respond: timeout504() });
    const error = (await caught(() => r.client.placeOrder(limit()))) as XoError;
    expect(error.mayHaveLanded).toBe(true);
    const hash = error.orderHash as string;
    r.trading.outcome = undefined;
    expect((await r.client.getOrder(hash)).status).toBe('LIVE');
    // Not in the open-orders list: that reads the books only.
    expect(await r.client.getOpenOrders().toArray()).toEqual([]);
    const found = await r.client.reconcileOrder(hash);
    expect(found.state).toBe('resting');
    expect(hits(r.trading, 'GET /data/trades')).toEqual([]);
    expect(await r.client.cancelOrder(hash)).toEqual({
      canceled: [hash],
      notCanceled: {},
    });
    expect(r.trading.held).toEqual([]);
  });

  test('cancelAll cancels held orders too', async () => {
    const r = rig();
    r.trading.outcome = () => ({ hold: true, respond: timeout504() });
    const error = (await caught(() => r.client.placeOrder(limit()))) as XoError;
    r.trading.outcome = undefined;
    expect((await r.client.cancelAll()).canceled).toEqual([error.orderHash]);
  });

  test('an order the gateway never got: not_found (not proof: a request may still be in flight)', async () => {
    const r = rig();
    failFirst(r.trading, 'POST /order', 1, () => HttpResponse.error());
    const error = (await caught(() => r.client.placeOrder(limit()))) as XoError;
    expect(error.mayHaveLanded).toBe(true);
    r.trading.trades.push({
      owner: OWNER.toLowerCase(),
      trade: trade(TRADE_1, CONDITION_A),
    });
    expect(await r.client.reconcileOrder(error.orderHash as string)).toEqual({
      state: 'not_found',
    });
    expect(hits(r.trading, 'GET /data/trades')).toHaveLength(1);
  });

  test('a trade seen on two pages (the list shifted between them) is returned once', async () => {
    const r = rig();
    const hash = `0x${'ab'.repeat(32)}`;
    const shifted = trade(TRADE_1, CONDITION_A, { taker: hash });
    r.trading.override = (route, request) => {
      if (route !== 'GET /data/trades') {
        return undefined;
      }
      const cursor = new URL(request.url).searchParams.get('next_cursor');
      return HttpResponse.json({
        limit: 1,
        count: 2,
        next_cursor: cursor === null ? btoa('1') : 'LTE=',
        data: [shifted],
      });
    };
    const found = await r.client.reconcileOrder(hash);
    expect(found.state).toBe('traded');
    if (found.state === 'traded') {
      expect(found.trades.map((t) => t.id)).toEqual([TRADE_1]);
    }
    expect(hits(r.trading, 'GET /data/trades')).toHaveLength(2);
  });

  test('a resting order: resting, and the trades are not read', async () => {
    const r = rig();
    const hash = await placed(r);
    const found = await r.client.reconcileOrder(hash);
    expect(found.state).toBe('resting');
    if (found.state === 'resting') {
      expect(found.order.id).toBe(hash);
    }
    expect(hits(r.trading, 'GET /data/trades')).toEqual([]);
  });

  test('scans at most maxTradePages pages of trades (default 3), newest first', async () => {
    const r = rig({ pageLimit: 1 });
    const hash = `0x${'ab'.repeat(32)}`;
    const me = OWNER.toLowerCase();
    // Oldest first: the matching trade is the oldest of five, so it is on page 5.
    r.trading.trades.push({
      owner: me,
      trade: trade(TRADE_1, CONDITION_A, { taker: hash }),
    });
    for (let i = 2; i <= 5; i += 1) {
      r.trading.trades.push({
        owner: me,
        trade: trade(`0x${String(i).padStart(64, '0')}`, CONDITION_A),
      });
    }
    expect((await r.client.reconcileOrder(hash)).state).toBe('not_found');
    expect(hits(r.trading, 'GET /data/trades')).toHaveLength(3);
    const deep = await r.client.reconcileOrder(hash, { maxTradePages: 5 });
    expect(deep.state).toBe('traded');
    expect(hits(r.trading, 'GET /data/trades')).toHaveLength(8);
  });

  test('refuses a bad hash or option before any request', async () => {
    const r = rig();
    const hash = `0x${'ab'.repeat(32)}`;
    await invalid(() => r.client.reconcileOrder('1'));
    await invalid(() => r.client.reconcileOrder('0x12'));
    for (const bad of [0, 1.5, -1, 101, '3', null]) {
      expect(
        await invalid(() =>
          r.client.reconcileOrder(hash, { maxTradePages: bad as number }),
        ),
      ).toMatch(/^maxTradePages/);
    }
    await invalid(() => r.client.reconcileOrder(hash, { pages: 2 } as never));
    expect(r.trading.calls).toEqual([]);
  });

  test('an error other than a 404 from the order lookup is thrown', async () => {
    const r = rig({ maxRetries: 0 });
    failFirst(r.trading, 'GET /data/order/{id}', 5);
    expect(
      await caught(() => r.client.reconcileOrder(`0x${'ab'.repeat(32)}`)),
    ).toSatisfy(serverFailure);
    expect(hits(r.trading, 'GET /data/trades')).toEqual([]);
  });
});

describe('trading_paused is refused', () => {
  test('a paused gateway refuses a chunk: failedChunk names it, mayHaveLanded false', async () => {
    const orders = await signedOrders(301);
    const r = rig();
    let chunk = 0;
    r.trading.override = (route) => {
      if (route !== 'POST /orders') {
        return undefined;
      }
      chunk += 1;
      return chunk === 2
        ? HttpResponse.json(
            { error: 'trading_paused', message: 'paused' },
            { status: 503, headers: { 'Retry-After': '60' } },
          )
        : undefined;
    };
    const incomplete = (await caught(() =>
      r.client.postOrders(orders),
    )) as BatchPlaceIncompleteError;
    expect(incomplete.cause).toSatisfy(tradingPaused);
    expect(incomplete.mayHaveLanded).toBe(false);
    expect(incomplete.failedChunk).toEqual([orders[300]?.orderHash]);
    expect(incomplete.notSent).toEqual([]);
  });
});

describe('batch_ops_incomplete', () => {
  const ops = async () => {
    const orders = await signedOrders(3);
    return [
      { type: 'place' as const, orders: orders.slice(0, 2) },
      { type: 'cancel' as const, ids: [`0x${'ee'.repeat(32)}`] },
      { type: 'place' as const, orders: orders.slice(2) },
    ];
  };

  test.each([
    ['a 503', true, SERVICE_UNAVAILABLE_503, RequestRejectedError],
    ['a network error', true, () => HttpResponse.error(), TransportError],
    [
      'a 429 (earlier groups may have run)',
      true,
      status(429, { error: 'rate limit exceeded', retry_after_ms: 0 }),
      XoError,
    ],
    [
      'a 400 (refused before execution)',
      false,
      status(400, { error: 'invalid request body: missing field `ops`' }),
      RequestRejectedError,
    ],
    [
      'a 503 trading_paused',
      false,
      status(503, { error: 'trading_paused', message: 'paused' }),
      RequestRejectedError,
    ],
  ] as const)('%s → mayHaveLanded %s', async (_name, landed, respond, kind) => {
    const r = rig({ maxRetries: 0 });
    const groups = await ops();
    failFirst(r.trading, 'POST /orders/batch-ops', 5, respond);
    const error = (await caught(() =>
      r.client.batchOps(groups),
    )) as BatchOpsIncompleteError;
    expect(error).toBeInstanceOf(BatchOpsIncompleteError);
    expect(error).toBeInstanceOf(XoError);
    expect(error.code).toBe('batch_ops_incomplete');
    expect(error.cause).toBeInstanceOf(kind);
    expect(error.mayHaveLanded).toBe(landed);
    expect(error.results).toEqual([]);
    expect(error.orderHashes).toEqual(
      [...(groups[0]?.orders ?? []), ...(groups[2]?.orders ?? [])].map(
        (o) => o.orderHash,
      ),
    );
    expect(hits(r.trading, 'POST /orders/batch-ops')).toHaveLength(1);
  });

  test('a 401 the refresh did not cure → mayHaveLanded false', async () => {
    const r = rig();
    failFirst(
      r.trading,
      'POST /orders/batch-ops',
      5,
      status(401, { error: 'invalid L2 signature' }),
    );
    const error = (await caught(async () =>
      r.client.batchOps(await ops()),
    )) as BatchOpsIncompleteError;
    expect(error.mayHaveLanded).toBe(false);
    expect(hits(r.trading, 'POST /orders/batch-ops')).toHaveLength(2);
  });

  test('a local error before sending → mayHaveLanded false, nothing sent', async () => {
    const r = rig({
      auth: failingAuth('/orders/batch-ops', 1, () => new Error('disk')),
    });
    const error = (await caught(async () =>
      r.client.batchOps(await ops()),
    )) as BatchOpsIncompleteError;
    expect(error.code).toBe('batch_ops_incomplete');
    expect(error.mayHaveLanded).toBe(false);
    expect(r.trading.calls).toEqual([]);
  });
});

describe('per-call errors', () => {
  test('two concurrent placeOrder calls on a cold session whose login fails get their own errors and hashes', async () => {
    const r = rig({ maxRetries: 0 });
    let derives = 0;
    server.use(
      http.get(DERIVE_URL, async () => {
        derives += 1;
        await delay(50);
        return HttpResponse.json({ error: 'down' }, { status: 503 });
      }),
    );
    const [a, b] = await Promise.allSettled([
      r.client.placeOrder(limit()),
      r.client.placeOrder(limit({ price: '0.4' })),
    ]);
    // One login flight, so the session rejected both calls with the same object.
    expect(derives).toBe(1);
    const ea = (a as PromiseRejectedResult).reason as XoError;
    const eb = (b as PromiseRejectedResult).reason as XoError;
    expect(ea).toSatisfy(serverFailure);
    expect(eb).toSatisfy(serverFailure);
    expect(ea).not.toBe(eb);
    expect(ea.orderHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(eb.orderHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ea.orderHash).not.toBe(eb.orderHash);
    expect(signed(r.signer, 'Order')).toBe(2);
    expect(r.trading.calls).toEqual([]);
  });

  test('concurrent postOrder calls: each error names its own order', async () => {
    const r = rig({ maxRetries: 0 });
    const one = await r.client.createOrder(limit());
    const two = await r.client.createOrder(limit({ price: '0.4' }));
    server.use(
      http.get(DERIVE_URL, async () => {
        await delay(50);
        return HttpResponse.json({ error: 'down' }, { status: 503 });
      }),
    );
    const settled = await Promise.allSettled([
      r.client.postOrder(one),
      r.client.postOrder(two),
    ]);
    expect(
      settled.map(
        (x) => ((x as PromiseRejectedResult).reason as XoError).orderHash,
      ),
    ).toEqual([one.orderHash, two.orderHash]);
  });

  test('a shared error object is never changed; each call gets a copy with its class and fields', async () => {
    const shared = new AuthRequiredError('no credentials', { cause: 'x' });
    const r = rig({
      auth: () => ({
        headers: async () => {
          throw shared;
        },
        onUnauthorized: async () => false,
      }),
    });
    const first = (await caught(() => r.client.placeOrder(limit()))) as XoError;
    const second = (await caught(() =>
      r.client.placeOrder(limit()),
    )) as XoError;
    for (const error of [first, second]) {
      expect(error).not.toBe(shared);
      expect(error).toBeInstanceOf(AuthRequiredError);
      expect(error.code).toBe('auth_required');
      expect(error.message).toBe(shared.message);
      expect(error.cause).toBe('x');
      expect(error.mayHaveLanded).toBe(false);
    }
    expect(first.orderHash).not.toBe(second.orderHash);
    expect(shared.orderHash).toBeUndefined();
    expect(shared.mayHaveLanded).toBeUndefined();
  });
});

describe('hash integrity', () => {
  test('the builder returns a deeply frozen SignedOrder', async () => {
    const r = rig();
    const order = await r.client.createOrder(limit());
    expect(Object.isFrozen(order)).toBe(true);
    expect(Object.isFrozen(order.order)).toBe(true);
    expect(Object.isFrozen(order.wire)).toBe(true);
    expect(() => {
      (order.order as { makerAmount: bigint }).makerAmount = 1n;
    }).toThrow(TypeError);
  });

  test('an order changed after signing is refused before sending', async () => {
    const r = rig();
    const order = await r.client.createOrder(limit());
    const changed = {
      ...order,
      order: { ...order.order, makerAmount: order.order.makerAmount + 1n },
    };
    expect(await invalid(() => r.client.postOrder(changed))).toMatch(
      /^order\.orderHash does not match the order/,
    );
    expect(r.trading.calls).toEqual([]);
  });

  test('an order signed for another chain is refused before sending', async () => {
    const r = rig();
    const other = await buildLimitOrder(limit(), {
      ...staticCtx,
      env: { ...env, chainId: 1 },
    });
    expect(await invalid(() => r.client.postOrder(other))).toMatch(
      /^order\.orderHash does not match the order/,
    );
    expect(r.trading.calls).toEqual([]);
  });

  test('the wire is re-derived from the order, whatever the given wire says', async () => {
    const r = rig();
    const order = await r.client.createOrder(limit());
    const tampered = {
      ...order,
      wire: { ...order.wire, makerAmount: '1', extra: 'x' },
    } as unknown as SignedOrder;
    await r.client.postOrder(tampered);
    const body = JSON.parse(only(r.trading, 'POST /order').body) as {
      order: unknown;
    };
    expect(body.order).toEqual(order.wire);
  });

  test('a struct that is not an order (bigints lost to JSON) is refused', async () => {
    const r = rig();
    const order = await r.client.createOrder(limit());
    const roundTripped = JSON.parse(
      JSON.stringify(order, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
    ) as SignedOrder;
    expect(await invalid(() => r.client.postOrder(roundTripped))).toMatch(
      /^order\.order is not a valid order/,
    );
    expect(r.trading.calls).toEqual([]);
  });

  test('a 200 whose orderID is another hash: the result is kept, with orderIdMismatch', async () => {
    const r = rig();
    const order = await r.client.createOrder(limit());
    const other = `0x${'9a'.repeat(32)}`;
    failFirst(r.trading, 'POST /order', 1, () =>
      HttpResponse.json({
        success: true,
        errorMsg: null,
        makingAmount: '0',
        takingAmount: '0',
        orderID: other,
        status: 'live',
        transactionsHashes: [],
        tradeIds: [],
      }),
    );
    const result = await r.client.postOrder(order);
    expect(result.orderIdMismatch).toBe(true);
    expect(result.orderID).toBe(other);
    expect(result.orderHash).toBe(order.orderHash);
  });

  test('the amounts of a placement answer are micro-units, typed but not checked: once the gateway answered, a cosmetic surprise is no error', async () => {
    const r = rig();
    const order = await r.client.createOrder(limit());
    failFirst(r.trading, 'POST /order', 1, () =>
      HttpResponse.json({
        success: true,
        errorMsg: null,
        makingAmount: '',
        takingAmount: '5000000',
        orderID: order.orderHash,
        status: 'matched',
        transactionsHashes: [],
        tradeIds: [],
      }),
    );
    const result = await r.client.postOrder(order);
    expect(result.makingAmount).toBe('');
    expect(fromMicro(BigInt(result.takingAmount))).toBe('5');
  });

  test('an orderID in another case is the same hash: no mismatch', async () => {
    const r = rig();
    const order = await r.client.createOrder(limit());
    failFirst(r.trading, 'POST /order', 1, () =>
      HttpResponse.json({
        success: true,
        errorMsg: null,
        makingAmount: '0',
        takingAmount: '0',
        orderID: `0x${order.orderHash.slice(2).toUpperCase()}`,
        status: 'live',
        transactionsHashes: [],
        tradeIds: [],
      }),
    );
    const result = await r.client.postOrder(order);
    expect('orderIdMismatch' in result).toBe(false);
  });
});

describe('401 on a postOrders chunk', () => {
  test('one resend, byte-identical, no re-sign', async () => {
    const r = rig();
    const orders = [
      await r.client.createOrder(limit()),
      await r.client.createOrder(limit({ price: '0.4' })),
    ];
    expect(signed(r.signer, 'Order')).toBe(2);
    failFirst(
      r.trading,
      'POST /orders',
      1,
      status(401, { error: 'invalid L2 signature' }),
    );
    const results = await r.client.postOrders(orders);
    const sent = hits(r.trading, 'POST /orders');
    expect(sent).toHaveLength(2);
    expect(sent[1]?.body).toBe(sent[0]?.body);
    expect(signed(r.signer, 'Order')).toBe(2);
    expect(signed(r.signer, 'ClobAuth')).toBe(2);
    expect(results.map((x) => x.order_hash)).toEqual(
      orders.map((o) => o.orderHash),
    );
  });
});

describe('session internals', () => {
  test('a Session exposes no signer or clock by reflection', () => {
    const r = rig();
    expect(Reflect.ownKeys(r.session)).toEqual([]);
    expect(Object.getOwnPropertySymbols(Session.prototype)).toEqual([
      Symbol.for('nodejs.util.inspect.custom'),
    ]);
  });

  test('a session that is not a Session is refused', async () => {
    const transport = new Transport({ env, version: '0.0.0-test' });
    const client = new OrderbookClient({
      transport,
      env,
      session: {} as Session,
      chain: { readContract: async () => nonceWord(NONCE) },
    });
    expect(await invalid(() => client.createOrder(limit()))).toMatch(
      /^session/,
    );
  });
});

// ---------------------------------------------------------------------------
// Once the gateway answered, a failure may have landed
// ---------------------------------------------------------------------------

/** Makes the client's response parsing throw a non-SDK error for `path`. */
function breakParsing(client: OrderbookClient, path: string): void {
  const target = client as unknown as {
    parse: (schema: unknown, data: unknown, path: string) => unknown;
  };
  const original = target.parse.bind(client);
  vi.spyOn(target, 'parse').mockImplementation((schema, data, p) => {
    if (p === path) {
      throw new TypeError('cannot read the answer');
    }
    return original(schema, data, p);
  });
}

describe('an answer that cannot be processed may have landed', () => {
  test('postOrder: a non-SDK error after the answer → PlacementError, mayHaveLanded true', async () => {
    const r = rig();
    const order = await r.client.createOrder(limit());
    breakParsing(r.client, '/order');
    const error = (await caught(() =>
      r.client.postOrder(order),
    )) as PlacementError;
    expect(error).toBeInstanceOf(PlacementError);
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(error.mayHaveLanded).toBe(true);
    expect(error.orderHash).toBe(order.orderHash);
    expect(r.trading.orders.map((o) => o.hash)).toEqual([order.orderHash]);
  });

  test('postOrders: a non-SDK error while pairing → failedChunk, mayHaveLanded true', async () => {
    const r = rig();
    const orders = await signedOrders(2);
    breakParsing(r.client, '/orders');
    const incomplete = (await caught(() =>
      r.client.postOrders(orders),
    )) as BatchPlaceIncompleteError;
    expect(incomplete.code).toBe('batch_place_incomplete');
    expect(incomplete.cause).toBeInstanceOf(TypeError);
    expect(incomplete.mayHaveLanded).toBe(true);
    expect(incomplete.failedChunk).toEqual(orders.map((o) => o.orderHash));
    expect(incomplete.notSent).toEqual([]);
  });

  test('batchOps: a non-SDK error while pairing → mayHaveLanded true', async () => {
    const r = rig();
    const orders = await signedOrders(2);
    breakParsing(r.client, '/orders/batch-ops');
    const error = (await caught(() =>
      r.client.batchOps([{ type: 'place', orders }]),
    )) as BatchOpsIncompleteError;
    expect(error.code).toBe('batch_ops_incomplete');
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(error.mayHaveLanded).toBe(true);
    expect(error.orderHashes).toEqual(orders.map((o) => o.orderHash));
  });
});

// A compile-time check that the result types carry the local hash.
const _typecheck = (r: Awaited<ReturnType<OrderbookClient['postOrder']>>) =>
  r.orderHash satisfies OrderHash;
void _typecheck;
