import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { encodeAbiParameters } from 'viem';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { withLanded } from '../../src/account/internal';
import { resetProcessState, setClientSeams } from '../../src/clients/internal';
import {
  createSecureClient,
  type SecureClient,
} from '../../src/clients/secure';
import {
  RateLimitError,
  RequestRejectedError,
  TransportError,
  UnexpectedResponseError,
  UserInputError,
  type XoError,
} from '../../src/core/errors';
import { OrderSide, OrderType } from '../../src/models/enums';
import type {
  AcceptedOrderResponse,
  OrderResponse,
  SignedOrder,
} from '../../src/models/orders';
import {
  BatchOpsIncompleteError,
  BatchPlaceIncompleteError,
  failureAfterAnswer,
} from '../../src/orderbook/placement';
import { privateKey } from '../../src/wallet/publicSigner';
import { installBackend } from '../helpers/mockBackend';
import {
  CONDITION_A,
  installMarketData,
  TOKEN_NO,
  TOKEN_YES,
} from '../helpers/mockMarketData';
import {
  installOrderbook,
  type Orderbook,
  type OrderbookRequest,
} from '../helpers/mockOrderbook';
import {
  installTrading,
  type RestingOrder,
  type Trading,
} from '../helpers/mockTrading';
import { wireStyleKeys } from '../helpers/modelKeys';
import {
  OWNER,
  OWNER_PK,
  type RailChainStub,
  railChain,
} from '../helpers/railChain';
import { testEnv } from '../helpers/testEnv';

// The trading actions of a signed-in client, against fakes of XO's backend and order book.
// What matters most: an order XO refused is a value (`ok: false` and a code), an order whose
// fate is unknown is an error with `mayHaveLanded: true` and its `orderHash`, and a placement is
// sent once, never again.

const env = testEnv;
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

const clients: SecureClient[] = [];
let chain: RailChainStub;

/** The exchange nonce the chain answers. */
const NONCE_WORD = encodeAbiParameters([{ type: 'uint128' }], [7n]);

beforeEach(() => {
  chain = railChain();
  chain.read = ({ to }) =>
    to.toLowerCase() === env.contracts.ctfExchange.toLowerCase()
      ? NONCE_WORD
      : new Error('execution reverted');
  setClientSeams({ chain: chain.reader });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((c) => c.close()));
  server.resetHandlers();
  vi.restoreAllMocks();
  setClientSeams({});
  resetProcessState();
});

interface Rig {
  client: SecureClient;
  trading: Trading;
  orderbook: Orderbook;
}

/** A client signed in to the fakes of XO's backend and order book. */
async function rig(o: { pageLimit?: number } = {}): Promise<Rig> {
  installMarketData(server);
  installBackend(server);
  const orderbook = installOrderbook(server);
  const trading = installTrading(server, orderbook, {
    pageLimit: o.pageLimit,
  });
  // After the market data fake, whose clock is fixed: the L2 checks read the real one.
  server.use(
    http.get(`${env.orderbookUrl}/time`, () =>
      HttpResponse.json(Math.floor(Date.now() / 1000)),
    ),
  );
  const client = await createSecureClient({
    environment: env,
    signer: privateKey(OWNER_PK),
  });
  clients.push(client);
  return { client, trading, orderbook };
}

const BUY = {
  assetId: TOKEN_YES,
  side: OrderSide.BUY,
  price: '0.5',
  size: 10,
} as const;

/** The requests that reached the trading fake on `route` ("METHOD /path"). */
const hits = (trading: Trading, route: string): OrderbookRequest[] =>
  trading.requests.filter((r) => `${r.method} ${r.path}` === route);

const bodyOf = (request: OrderbookRequest | undefined): unknown =>
  JSON.parse(request?.body ?? 'null');

const queryOf = (request: OrderbookRequest | undefined) =>
  Object.fromEntries(new URLSearchParams(request?.search ?? ''));

async function caught(run: () => unknown): Promise<XoError> {
  try {
    await run();
  } catch (error) {
    return error as XoError;
  }
  throw new Error('expected the call to throw');
}

function accepted(response: OrderResponse): AcceptedOrderResponse {
  if (!response.ok) {
    throw new Error(`expected an accepted order, got ${response.code}`);
  }
  return response;
}

const HASH_PATTERN = /^0x[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Placing one order
// ---------------------------------------------------------------------------

describe('placeLimitOrder', () => {
  test('placeLimitOrder returns ok:true with orderId and orderHash', async () => {
    const { client, trading } = await rig();

    const response = await client.placeLimitOrder(BUY);

    const [resting] = trading.orders;
    expect(response).toEqual({
      ok: true,
      orderId: resting?.hash,
      orderHash: resting?.hash,
      status: 'live',
      makingAmount: '0',
      takingAmount: '0',
      tradeIds: [],
      transactionsHashes: [],
    });
    const posts = hits(trading, 'POST /order');
    expect(posts).toHaveLength(1);
    expect(bodyOf(posts[0])).toMatchObject({
      orderType: 'GTC',
      postOnly: false,
    });
  });

  test('the fills made at placement come back in whole units', async () => {
    const { client, trading } = await rig();
    trading.outcome = () => ({
      rest: false,
      status: 'matched',
      makingAmount: '5000000',
      takingAmount: '10000000',
      tradeIds: ['t-1'],
    });

    const response = accepted(await client.placeLimitOrder(BUY));

    expect(response.status).toBe('matched');
    expect(response.makingAmount).toBe('5');
    expect(response.takingAmount).toBe('10');
    expect(response.tradeIds).toEqual(['t-1']);
  });

  test.each([
    [
      'a balance too small',
      () =>
        HttpResponse.json(
          { error: 'insufficient balance: required 5000000, available 0' },
          { status: 422 },
        ),
      'insufficient_balance',
      'insufficient balance: required 5000000, available 0',
    ],
    [
      'a post-only order that would cross',
      () =>
        HttpResponse.json(
          { error: 'post-only order would cross resting liquidity' },
          { status: 400 },
        ),
      'post_only_would_cross',
      'post-only order would cross resting liquidity',
    ],
    [
      'an order cancelled while it was held',
      () =>
        HttpResponse.json(
          {
            error: 'order_cancelled_during_hold',
            message: 'order was cancelled while in the taker-delay hold window',
          },
          { status: 409 },
        ),
      'order_cancelled_during_hold',
      'order was cancelled while in the taker-delay hold window',
    ],
    [
      'a market that is over',
      () =>
        HttpResponse.json(
          { error: 'market is not active (status: Resolved)' },
          { status: 422 },
        ),
      'market_not_active',
      'market is not active (status: Resolved)',
    ],
    [
      'a refusal XO gives no code for',
      () =>
        HttpResponse.json({ error: 'invalid side in order' }, { status: 400 }),
      'rejected',
      'invalid side in order',
    ],
  ])(
    'a definite 4xx refusal returns ok:false with its code: %s',
    async (_name, respond, code, message) => {
      const { client, trading } = await rig();
      trading.outcome = () => respond();
      const order = await client.createLimitOrder(BUY);

      const response = await client.postOrder(order);

      expect(response).toEqual({
        ok: false,
        orderHash: order.orderHash,
        code,
        message,
      });
      expect(hits(trading, 'POST /order')).toHaveLength(1);
      expect(trading.orders).toEqual([]);
    },
  );

  test('the same signed order sent twice is a duplicate_order value the second time', async () => {
    const { client, trading } = await rig();
    const order = await client.createLimitOrder(BUY);

    accepted(await client.postOrder(order));
    const again = await client.postOrder(order);

    expect(again).toMatchObject({
      ok: false,
      code: 'duplicate_order',
      orderHash: order.orderHash,
    });
    expect(trading.orders).toHaveLength(1);
  });

  test('trading paused is a trading_paused value, and the order is sent once', async () => {
    const { client, trading } = await rig();
    trading.paused = true;

    const response = await client.placeLimitOrder(BUY);

    expect(response).toMatchObject({ ok: false, code: 'trading_paused' });
    expect(response.orderHash).toMatch(HASH_PATTERN);
    expect(hits(trading, 'POST /order')).toHaveLength(1);
  });

  test('a connection reset after sending makes placeLimitOrder throw with mayHaveLanded true and orderHash; reconcileOrder({ orderHash }) then reports resting', async () => {
    const { client, trading } = await rig();
    // The order reaches the book, and the answer is lost on the way back.
    trading.outcome = () => ({ respond: HttpResponse.error() });

    const error = await caught(() => client.placeLimitOrder(BUY));

    expect(error).toBeInstanceOf(TransportError);
    expect(error.mayHaveLanded).toBe(true);
    const [resting] = trading.orders;
    expect(error.orderHash).toBe(resting?.hash);
    expect(hits(trading, 'POST /order')).toHaveLength(1);

    const reconciled = await client.reconcileOrder({
      orderHash: error.orderHash as string,
    });

    expect(reconciled.state).toBe('resting');
    expect(reconciled).toMatchObject({
      state: 'resting',
      order: { orderId: resting?.hash, assetId: TOKEN_YES, side: 'BUY' },
    });
    // Nothing was placed again.
    expect(hits(trading, 'POST /order')).toHaveLength(1);
  });

  test('reconcileOrder reports the trades of an order that filled, and not_found for an unknown one', async () => {
    const { client, trading } = await rig();
    const filled = `0x${'5e'.repeat(32)}`;
    trading.trades.push({
      owner: OWNER.toLowerCase(),
      trade: rawTrade(`0x${'01'.repeat(32)}`, { taker: filled }),
    });

    const traded = await client.reconcileOrder({ orderHash: filled });
    const unknown = await client.reconcileOrder({
      orderHash: `0x${'77'.repeat(32)}`,
    });

    expect(traded).toMatchObject({
      state: 'traded',
      trades: [{ id: `0x${'01'.repeat(32)}`, takerOrderId: filled }],
    });
    expect(unknown).toEqual({ state: 'not_found' });
  });

  test('placeLimitOrder never retries: one request on a 503', async () => {
    const { client, trading } = await rig();
    trading.override = (route) =>
      route === 'POST /order'
        ? HttpResponse.json(
            { error: 'service_unavailable', retry_after_ms: 0 },
            { status: 503 },
          )
        : undefined;

    const error = await caught(() => client.placeLimitOrder(BUY));

    expect(error).toBeInstanceOf(RequestRejectedError);
    expect(error.status).toBe(503);
    expect(error.mayHaveLanded).toBe(true);
    expect(error.orderHash).toMatch(HASH_PATTERN);
    expect(hits(trading, 'POST /order')).toHaveLength(1);
  });

  test('an answer of 200 that cannot be read throws with mayHaveLanded true', async () => {
    const { client, trading } = await rig();
    trading.outcome = () => ({ makingAmount: 'not micro-units' });

    const error = await caught(() => client.placeLimitOrder(BUY));

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(error.mayHaveLanded).toBe(true);
    expect(error.orderHash).toBe(trading.orders[0]?.hash);
  });

  test.each([
    [
      429,
      () =>
        HttpResponse.json(
          { error: 'rate limit exceeded', retry_after_ms: 10_000 },
          { status: 429 },
        ),
      RateLimitError,
    ],
    [
      403,
      () =>
        HttpResponse.json(
          {
            error: 'rfq_market_placement_forbidden',
            message: 'this market only trades through POST /rfq/match',
          },
          { status: 403 },
        ),
      RequestRejectedError,
    ],
  ])(
    'a %d is thrown, not returned as a value, and says the order was not placed',
    async (_status, respond, cls) => {
      const { client, trading } = await rig();
      trading.override = (route) =>
        route === 'POST /order' ? respond() : undefined;

      const error = await caught(() => client.placeLimitOrder(BUY));

      expect(error).toBeInstanceOf(cls);
      expect(error.mayHaveLanded).toBe(false);
      expect(error.orderHash).toMatch(HASH_PATTERN);
      expect(hits(trading, 'POST /order')).toHaveLength(1);
    },
  );

  test('a 401 is thrown, not returned as a value', async () => {
    const { client, trading } = await rig();
    trading.override = (route) =>
      route === 'POST /order'
        ? HttpResponse.json({ error: 'invalid HMAC' }, { status: 401 })
        : undefined;

    const error = await caught(() => client.placeLimitOrder(BUY));

    expect(error).toBeInstanceOf(RequestRejectedError);
    expect(error.status).toBe(401);
    expect(error.mayHaveLanded).toBe(false);
    // The transport's one resend after a fresh login, of the same bytes; never a new signature.
    const posts = hits(trading, 'POST /order');
    expect(posts.length).toBeLessThanOrEqual(2);
    expect(new Set(posts.map((p) => p.body)).size).toBe(1);
  });

  test('a 401 whose fresh sign-in is refused is thrown, not taken for a refusal of the order', async () => {
    const { client, trading, orderbook } = await rig();
    trading.override = (route) =>
      route === 'POST /order'
        ? HttpResponse.json({ error: 'invalid HMAC' }, { status: 401 })
        : undefined;
    // The sign-in after the 401 fails with a status of its own: that 400 refuses no order.
    orderbook.override = (route) =>
      route === 'derive'
        ? HttpResponse.json({ error: 'invalid request' }, { status: 400 })
        : undefined;

    const error = await caught(() => client.placeLimitOrder(BUY));

    expect(error).toBeInstanceOf(RequestRejectedError);
    expect(error.status).toBe(400);
    expect(error.mayHaveLanded).toBe(false);
    expect(error.orderHash).toMatch(HASH_PATTERN);
    expect(hits(trading, 'POST /order')).toHaveLength(1);
  });

  test('an input error throws before anything is signed or sent', async () => {
    const { client, trading } = await rig();

    const error = await caught(() =>
      client.placeLimitOrder({ ...BUY, price: '1.5' }),
    );

    expect(error).toBeInstanceOf(UserInputError);
    expect(error.mayHaveLanded).toBe(false);
    expect(hits(trading, 'POST /order')).toEqual([]);
  });

  test('a request with an unknown key is refused, and the key is named', async () => {
    const { client, trading } = await rig();

    const error = await caught(() =>
      client.placeLimitOrder({
        ...BUY,
        tokenId: TOKEN_YES,
      } as unknown as Parameters<SecureClient['placeLimitOrder']>[0]),
    );

    expect(error).toBeInstanceOf(UserInputError);
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain('tokenId');
    expect(trading.requests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Building orders
// ---------------------------------------------------------------------------

describe('createLimitOrder and createMarketOrder', () => {
  test('a limit order is GTC; an expiration makes it GTD', async () => {
    const { client, trading } = await rig();
    const inAnHour = Math.floor(Date.now() / 1000) + 3600;

    const gtc = await client.createLimitOrder(BUY);
    const gtd = await client.createLimitOrder({
      ...BUY,
      expiration: inAnHour,
    });
    const byDate = await client.createLimitOrder({
      ...BUY,
      postOnly: true,
      expiration: new Date(inAnHour * 1000),
    });

    expect(gtc.orderType).toBe('GTC');
    expect(gtc.order.expiration).toBe(0n);
    expect(gtd.orderType).toBe('GTD');
    expect(gtd.order.expiration).toBe(BigInt(inAnHour));
    expect(byDate).toMatchObject({ orderType: 'GTD', postOnly: true });
    // Signing sends nothing.
    expect(trading.requests).toEqual([]);
  });

  test('an expiration in milliseconds is refused', async () => {
    const { client } = await rig();

    const error = await caught(() =>
      client.createLimitOrder({ ...BUY, expiration: Date.now() + 3_600_000 }),
    );

    expect(error).toBeInstanceOf(UserInputError);
    expect(error.message).toContain('milliseconds');
  });

  test('a market buy spends an amount; a market sell gives shares', async () => {
    const { client } = await rig();

    const buy = await client.createMarketOrder({
      assetId: TOKEN_YES,
      side: OrderSide.BUY,
      amount: '9.99',
    });
    const sell = await client.createMarketOrder({
      assetId: TOKEN_YES,
      side: OrderSide.SELL,
      shares: 5,
      orderType: OrderType.FOK,
    });

    expect(buy.orderType).toBe('FAK');
    expect(buy.order.makerAmount).toBe(9_990_000n);
    expect(sell.orderType).toBe('FOK');
    expect(sell.order.makerAmount).toBe(5_000_000n);
  });

  test('a market buy never pays more than maxPrice; a market sell never takes less than minPrice', async () => {
    const { client } = await rig();

    const buy = await client.createMarketOrder({
      assetId: TOKEN_YES,
      side: OrderSide.BUY,
      amount: '2',
      maxPrice: '0.4',
    });
    const sell = await client.createMarketOrder({
      assetId: TOKEN_YES,
      side: OrderSide.SELL,
      shares: 5,
      minPrice: 0.6,
    });

    // Signed as limit orders at the worst price: 2 USDC buys at most 5 shares at 0.4, and 5
    // shares sell for at least 3 USDC at 0.6.
    expect(buy.order.makerAmount).toBe(2_000_000n);
    expect(buy.order.takerAmount).toBe(5_000_000n);
    expect(sell.order.makerAmount).toBe(5_000_000n);
    expect(sell.order.takerAmount).toBe(3_000_000n);
  });

  test.each([
    [{ assetId: TOKEN_YES, side: OrderSide.BUY, shares: 5 }, 'amount'],
    [{ assetId: TOKEN_YES, side: OrderSide.SELL, amount: 5 }, 'shares'],
    [
      { assetId: TOKEN_YES, side: OrderSide.BUY, amount: 5, minPrice: 0.5 },
      'minPrice',
    ],
    [
      { assetId: TOKEN_YES, side: OrderSide.SELL, shares: 5, maxPrice: 0.5 },
      'maxPrice',
    ],
    [
      { assetId: TOKEN_YES, side: OrderSide.BUY, amount: 5, maxPrice: 1.5 },
      'maxPrice',
    ],
    [
      {
        assetId: TOKEN_YES,
        side: OrderSide.BUY,
        amount: 5,
        orderType: OrderType.GTC,
      },
      'orderType',
    ],
  ])(
    'a market order with the wrong fields is refused: %j',
    async (request, field) => {
      const { client } = await rig();

      const error = await caught(() =>
        client.createMarketOrder(
          request as unknown as Parameters<
            SecureClient['createMarketOrder']
          >[0],
        ),
      );

      expect(error).toBeInstanceOf(UserInputError);
      expect(error.message).toContain(field);
    },
  );

  test('placeMarketOrder signs a FAK and posts it once', async () => {
    const { client, trading } = await rig();
    trading.outcome = () => ({ rest: false, status: 'delayed' });

    const response = accepted(
      await client.placeMarketOrder({
        assetId: TOKEN_YES,
        side: OrderSide.BUY,
        amount: 10,
      }),
    );

    // A delayed taker order is not a refusal: it waits out the taker delay.
    expect(response.status).toBe('delayed');
    const posts = hits(trading, 'POST /order');
    expect(posts).toHaveLength(1);
    expect(bodyOf(posts[0])).toMatchObject({ orderType: 'FAK' });
  });

  test('placeMarketOrder with maxPrice posts the order signed at that price', async () => {
    const { client, trading } = await rig();
    trading.outcome = () => ({ rest: false, status: 'delayed' });

    accepted(
      await client.placeMarketOrder({
        assetId: TOKEN_YES,
        side: OrderSide.BUY,
        amount: 10,
        maxPrice: '0.25',
      }),
    );

    const posts = hits(trading, 'POST /order');
    expect(posts).toHaveLength(1);
    expect(bodyOf(posts[0])).toMatchObject({
      orderType: 'FAK',
      order: { makerAmount: '10000000', takerAmount: '40000000' },
    });
  });
});

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

/** An entry of a batch answer for an order that was placed. */
const placedEntry = (hash: string) => ({
  order_id: hash,
  fills: 0,
  resting: true,
  remaining_size: '10',
  error: null,
  order_hash: hash,
});
/** An entry of a batch answer for an order that was not placed, or whose fate is unknown. */
const failedEntry = (error: string) => ({
  order_id: null,
  fills: null,
  resting: null,
  remaining_size: null,
  error,
  order_hash: null,
});

async function signedPair(client: SecureClient): Promise<SignedOrder[]> {
  return [
    await client.createLimitOrder(BUY),
    await client.createLimitOrder({ ...BUY, price: '0.4' }),
  ];
}

describe('postOrders', () => {
  test('each order gets its value; XO reports no amounts per order in a batch', async () => {
    const { client, trading } = await rig();
    const orders = await signedPair(client);

    const responses = await client.postOrders(orders);

    expect(responses).toEqual(
      orders.map((order) => ({
        ok: true,
        orderId: order.orderHash,
        orderHash: order.orderHash,
        status: 'live',
        makingAmount: null,
        takingAmount: null,
        tradeIds: null,
        transactionsHashes: null,
      })),
    );
    expect(hits(trading, 'POST /orders')).toHaveLength(1);
  });

  test('a refused entry is ok:false with its code; the others stand', async () => {
    const { client, trading } = await rig();
    const [first, second] = await signedPair(client);
    trading.override = (route) =>
      route === 'POST /orders'
        ? HttpResponse.json({
            results: [
              placedEntry(first?.orderHash as string),
              failedEntry(
                'trading error: accounting error: insufficient balance: required 4000000, available 0',
              ),
            ],
          })
        : undefined;

    const responses = await client.postOrders([
      first as SignedOrder,
      second as SignedOrder,
    ]);

    expect(responses[0]).toMatchObject({ ok: true, status: 'live' });
    expect(responses[1]).toEqual({
      ok: false,
      orderHash: second?.orderHash,
      code: 'insufficient_balance',
      message:
        'trading error: accounting error: insufficient balance: required 4000000, available 0',
    });
  });

  test('an entry whose fate XO could not tell throws with mayHaveLanded true and its hash', async () => {
    const { client, trading } = await rig();
    const [first, second] = await signedPair(client);
    trading.override = (route) =>
      route === 'POST /orders'
        ? HttpResponse.json({
            results: [
              placedEntry(first?.orderHash as string),
              failedEntry('engine has stopped'),
            ],
          })
        : undefined;

    const error = await caught(() =>
      client.postOrders([first as SignedOrder, second as SignedOrder]),
    );

    expect(error).toBeInstanceOf(BatchPlaceIncompleteError);
    expect(error.mayHaveLanded).toBe(true);
    expect((error as BatchPlaceIncompleteError).failedChunk).toEqual([
      second?.orderHash,
    ]);
    // The answered orders are public values; the one whose fate is unknown is in none of them.
    expect((error as BatchPlaceIncompleteError).results).toEqual([
      {
        ok: true,
        orderId: first?.orderHash,
        orderHash: first?.orderHash,
        status: 'live',
        makingAmount: null,
        takingAmount: null,
        tradeIds: null,
        transactionsHashes: null,
      },
    ]);
    expect(wireStyleKeys(JSON.parse(JSON.stringify(error)))).toEqual([]);
    expect(hits(trading, 'POST /orders')).toHaveLength(1);
  });

  test('an entry in words the SDK does not know for a refusal throws with mayHaveLanded true', async () => {
    const { client, trading } = await rig();
    const [first, second] = await signedPair(client);
    trading.override = (route) =>
      route === 'POST /orders'
        ? HttpResponse.json({
            results: [
              failedEntry('invalid side in order'),
              failedEntry('the engine timed out after taking the order'),
            ],
          })
        : undefined;

    const error = await caught(() =>
      client.postOrders([first as SignedOrder, second as SignedOrder]),
    );

    expect(error).toBeInstanceOf(BatchPlaceIncompleteError);
    expect(error.mayHaveLanded).toBe(true);
    expect((error as BatchPlaceIncompleteError).failedChunk).toEqual([
      second?.orderHash,
    ]);
    // The definite refusal is a value; the text the SDK does not know is never taken for one.
    expect((error as BatchPlaceIncompleteError).results).toEqual([
      {
        ok: false,
        orderHash: first?.orderHash,
        code: expect.any(String),
        message: 'invalid side in order',
      },
    ]);
  });

  test.each([
    [
      'refused with a 429',
      () =>
        HttpResponse.json(
          { error: 'rate limit exceeded', retry_after_ms: 10_000 },
          { status: 429 },
        ),
      false,
    ],
    ['lost on the way back', () => HttpResponse.error(), true],
  ])(
    'an unknown-fate order of an answered batch is not hidden when a later batch is %s',
    async (_name, respond, laterMayHaveLanded) => {
      const { client, trading } = await rig();
      const orders: SignedOrder[] = [];
      for (let i = 0; i < 301; i += 1) {
        orders.push(await client.createLimitOrder(BUY));
      }
      const unknown = orders[7] as SignedOrder;
      const last = orders[300] as SignedOrder;
      let batch = 0;
      trading.override = (route) => {
        if (route !== 'POST /orders') {
          return undefined;
        }
        batch += 1;
        return batch === 1
          ? HttpResponse.json({
              results: orders
                .slice(0, 300)
                .map((order, index) =>
                  index === 7
                    ? failedEntry('engine has stopped')
                    : placedEntry(order.orderHash),
                ),
            })
          : respond();
      };

      const error = (await caught(() =>
        client.postOrders(orders),
      )) as BatchPlaceIncompleteError;

      expect(error).toBeInstanceOf(BatchPlaceIncompleteError);
      expect(error.mayHaveLanded).toBe(true);
      expect(error.failedChunk).toEqual(
        laterMayHaveLanded
          ? [unknown.orderHash, last.orderHash]
          : [unknown.orderHash],
      );
      expect(error.notSent).toEqual([]);
      // Every answered order of known fate, as a public value; the unknown one in none of them.
      expect(error.results).toHaveLength(299);
      expect(error.results.every((result) => result.ok)).toBe(true);
      expect(error.results.map((result) => result.orderHash)).not.toContain(
        unknown.orderHash,
      );
      // The later batch's failure, with what it says of its own orders.
      const cause = error.cause as BatchPlaceIncompleteError;
      expect(cause).toBeInstanceOf(BatchPlaceIncompleteError);
      expect(cause.mayHaveLanded).toBe(laterMayHaveLanded);
      expect(cause.failedChunk).toEqual([last.orderHash]);
      expect(cause.results).toEqual(error.results);
      expect(wireStyleKeys(JSON.parse(JSON.stringify(error)))).toEqual([]);
      expect(hits(trading, 'POST /orders')).toHaveLength(2);
    },
    30_000,
  );

  test('a later batch whose answer was lost: the error lists the answered orders as public values', async () => {
    const { client, trading } = await rig();
    const orders: SignedOrder[] = [];
    for (let i = 0; i < 301; i += 1) {
      orders.push(await client.createLimitOrder(BUY));
    }
    let batch = 0;
    trading.override = (route) => {
      if (route !== 'POST /orders') {
        return undefined;
      }
      batch += 1;
      return batch === 1
        ? HttpResponse.json({
            results: orders
              .slice(0, 300)
              .map((order) => placedEntry(order.orderHash)),
          })
        : HttpResponse.error();
    };

    const error = (await caught(() =>
      client.postOrders(orders),
    )) as BatchPlaceIncompleteError;

    expect(error).toBeInstanceOf(BatchPlaceIncompleteError);
    expect(error.mayHaveLanded).toBe(true);
    expect(error.failedChunk).toEqual([orders[300]?.orderHash]);
    expect(error.notSent).toEqual([]);
    expect(error.cause).toBeInstanceOf(TransportError);
    expect(error.results).toEqual(
      orders.slice(0, 300).map((order) => ({
        ok: true,
        orderId: order.orderHash,
        orderHash: order.orderHash,
        status: 'live',
        makingAmount: null,
        takingAmount: null,
        tradeIds: null,
        transactionsHashes: null,
      })),
    );
    expect(wireStyleKeys(JSON.parse(JSON.stringify(error)))).toEqual([]);
    expect(hits(trading, 'POST /orders')).toHaveLength(2);
  }, 30_000);

  test('a batch XO refused as a whole: every order is ok:false with the code', async () => {
    const { client, trading } = await rig();
    const orders = await signedPair(client);
    trading.paused = true;

    const responses = await client.postOrders(orders);

    expect(responses).toEqual(
      orders.map((order) => ({
        ok: false,
        orderHash: order.orderHash,
        code: 'trading_paused',
        message: 'Global trading is paused. New orders are not being accepted.',
      })),
    );
    expect(hits(trading, 'POST /orders')).toHaveLength(1);
  });

  test('a batch whose answer was lost throws with mayHaveLanded true, sent once', async () => {
    const { client, trading } = await rig();
    const orders = await signedPair(client);
    trading.override = (route) =>
      route === 'POST /orders' ? HttpResponse.error() : undefined;

    const error = await caught(() => client.postOrders(orders));

    expect(error).toBeInstanceOf(BatchPlaceIncompleteError);
    expect(error.mayHaveLanded).toBe(true);
    expect((error as BatchPlaceIncompleteError).failedChunk).toEqual(
      orders.map((o) => o.orderHash),
    );
    expect(hits(trading, 'POST /orders')).toHaveLength(1);
  });

  test('postOrders sends at most 300 orders per request', async () => {
    const { client, trading } = await rig();
    const one = await client.createLimitOrder(BUY);
    trading.override = (route, _request, body) => {
      if (route !== 'POST /orders') {
        return undefined;
      }
      const sent = JSON.parse(body) as unknown[];
      return HttpResponse.json({
        results: sent.map(() => failedEntry('invalid side in order')),
      });
    };
    // Distinct orders are needed: the same order twice is refused before anything is sent.
    const orders = [one];
    for (let i = 1; i < 301; i += 1) {
      orders.push(await client.createLimitOrder(BUY));
    }

    const responses = await client.postOrders(orders);

    expect(responses).toHaveLength(301);
    expect(
      hits(trading, 'POST /orders').map((r) => (bodyOf(r) as []).length),
    ).toEqual([300, 1]);
  }, 30_000);
});

describe('postOrderBatch', () => {
  test('places and cancels in one request, group by group', async () => {
    const { client, trading } = await rig();
    const resting = accepted(await client.placeLimitOrder(BUY));
    const order = await client.createLimitOrder({ ...BUY, price: '0.45' });

    const results = await client.postOrderBatch({
      operations: [
        { type: 'cancel', orderIds: [resting.orderId] },
        { type: 'place', orders: [order] },
      ],
    });

    expect(results).toEqual([
      { type: 'cancel', canceled: [resting.orderId], notCanceled: {} },
      {
        type: 'place',
        orders: [
          {
            ok: true,
            orderId: order.orderHash,
            orderHash: order.orderHash,
            status: 'live',
            makingAmount: null,
            takingAmount: null,
            tradeIds: null,
            transactionsHashes: null,
          },
        ],
      },
    ]);
    const [sent] = hits(trading, 'POST /orders/batch-ops');
    expect(bodyOf(sent)).toMatchObject({
      ops: [
        { type: 'cancel', payload: [resting.orderId] },
        { type: 'place', payload: [{ orderType: 'GTC', postOnly: false }] },
      ],
    });
  });

  test('a batch refused before any group ran gives every order and cancel its value', async () => {
    const { client, trading } = await rig();
    const resting = accepted(await client.placeLimitOrder(BUY));
    const order = await client.createLimitOrder({ ...BUY, price: '0.45' });
    trading.paused = true;

    const results = await client.postOrderBatch({
      operations: [
        { type: 'place', orders: [order] },
        { type: 'cancel', orderIds: [resting.orderId] },
      ],
    });

    const message =
      'Global trading is paused. New orders are not being accepted.';
    expect(results).toEqual([
      {
        type: 'place',
        orders: [
          {
            ok: false,
            orderHash: order.orderHash,
            code: 'trading_paused',
            message,
          },
        ],
      },
      {
        type: 'cancel',
        canceled: [],
        notCanceled: { [resting.orderId]: message },
      },
    ]);
  });

  test('an order whose fate is unknown throws with mayHaveLanded true', async () => {
    const { client, trading } = await rig();
    const order = await client.createLimitOrder(BUY);
    trading.override = (route) =>
      route === 'POST /orders/batch-ops'
        ? HttpResponse.json({
            results: [
              {
                type: 'place',
                payload: [failedEntry('engine reply channel dropped')],
              },
            ],
          })
        : undefined;

    const error = await caught(() =>
      client.postOrderBatch({
        operations: [{ type: 'place', orders: [order] }],
      }),
    );

    expect(error).toBeInstanceOf(BatchOpsIncompleteError);
    expect(error.mayHaveLanded).toBe(true);
    expect((error as BatchOpsIncompleteError).orderHashes).toEqual([
      order.orderHash,
    ]);
    expect((error as BatchOpsIncompleteError).results).toEqual([
      { type: 'place', orders: [] },
    ]);
  });

  test('the error of an order whose fate is unknown carries what each operation did, as public values', async () => {
    const { client, trading } = await rig();
    const resting = accepted(await client.placeLimitOrder(BUY));
    const [placed, unknown] = await signedPair(client);
    trading.override = (route) =>
      route === 'POST /orders/batch-ops'
        ? HttpResponse.json({
            results: [
              {
                type: 'cancel',
                payload: { canceled: [resting.orderId], notCanceled: {} },
              },
              {
                type: 'place',
                payload: [
                  placedEntry(placed?.orderHash as string),
                  failedEntry('engine reply channel dropped'),
                ],
              },
            ],
          })
        : undefined;

    const error = (await caught(() =>
      client.postOrderBatch({
        operations: [
          { type: 'cancel', orderIds: [resting.orderId] },
          {
            type: 'place',
            orders: [placed as SignedOrder, unknown as SignedOrder],
          },
        ],
      }),
    )) as BatchOpsIncompleteError;

    expect(error).toBeInstanceOf(BatchOpsIncompleteError);
    expect(error.mayHaveLanded).toBe(true);
    expect(error.orderHashes).toEqual([unknown?.orderHash]);
    expect(error.results).toEqual([
      { type: 'cancel', canceled: [resting.orderId], notCanceled: {} },
      {
        type: 'place',
        orders: [
          {
            ok: true,
            orderId: placed?.orderHash,
            orderHash: placed?.orderHash,
            status: 'live',
            makingAmount: null,
            takingAmount: null,
            tradeIds: null,
            transactionsHashes: null,
          },
        ],
      },
    ]);
    expect(wireStyleKeys(JSON.parse(JSON.stringify(error)))).toEqual([]);
    expect(hits(trading, 'POST /orders/batch-ops')).toHaveLength(1);
  });

  test('a lost answer throws with mayHaveLanded true, sent once', async () => {
    const { client, trading } = await rig();
    const order = await client.createLimitOrder(BUY);
    trading.override = (route) =>
      route === 'POST /orders/batch-ops' ? HttpResponse.error() : undefined;

    const error = await caught(() =>
      client.postOrderBatch({
        operations: [{ type: 'place', orders: [order] }],
      }),
    );

    expect(error).toBeInstanceOf(BatchOpsIncompleteError);
    expect(error.mayHaveLanded).toBe(true);
    expect(hits(trading, 'POST /orders/batch-ops')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Cancels
// ---------------------------------------------------------------------------

describe('cancels', () => {
  test('cancelOrder({ orderId }) sends orderID on the wire', async () => {
    const { client, trading } = await rig();
    const placed = accepted(await client.placeLimitOrder(BUY));

    const result = await client.cancelOrder({ orderId: placed.orderId });

    expect(result).toEqual({ canceled: [placed.orderId], notCanceled: {} });
    expect(bodyOf(hits(trading, 'DELETE /order')[0])).toEqual({
      orderID: placed.orderId,
    });
    expect(trading.orders).toEqual([]);
  });

  test('cancelOrder of an order that is not open: not cancelled, not found', async () => {
    const { client, trading } = await rig();
    const missing = `0x${'0E'.repeat(32)}`;

    const result = await client.cancelOrder({ orderId: missing });

    const id = missing.toLowerCase();
    expect(result).toEqual({
      canceled: [],
      notCanceled: { [id]: `order ${id} not found` },
    });
    expect(hits(trading, 'DELETE /order')).toHaveLength(1);
  });

  test('cancelOrder still throws a refusal that is not a 404', async () => {
    const { client, trading } = await rig();
    trading.override = (route) =>
      route === 'DELETE /order'
        ? HttpResponse.json(
            {
              error: 'order_in_delay_window',
              message: 'order is in the taker-delay hold window',
            },
            { status: 409 },
          )
        : undefined;

    const error = await caught(() =>
      client.cancelOrder({ orderId: `0x${'0e'.repeat(32)}` }),
    );

    expect(error).toBeInstanceOf(RequestRejectedError);
    expect(error.status).toBe(409);
    // XO refused it: nothing was cancelled.
    expect(error.mayHaveLanded).toBe(false);
    expect(hits(trading, 'DELETE /order')).toHaveLength(1);
  });

  const CANCELS: Array<
    [string, string, (client: SecureClient, orderId: string) => unknown]
  > = [
    [
      'cancelOrder',
      'DELETE /order',
      (client, orderId) => client.cancelOrder({ orderId }),
    ],
    [
      'cancelOrders',
      'DELETE /orders',
      (client, orderId) => client.cancelOrders({ orderIds: [orderId] }),
    ],
    ['cancelAll', 'DELETE /cancel-all', (client) => client.cancelAll()],
    [
      'cancelMarketOrders',
      'DELETE /cancel-market-orders',
      (client) => client.cancelMarketOrders({ market: CONDITION_A }),
    ],
    [
      'cancelMarketOrders of an outcome',
      'DELETE /orders',
      (client) => client.cancelMarketOrders({ assetId: TOKEN_YES }),
    ],
  ];

  test.each(CANCELS)(
    '%s is sent once: an answer that is lost throws with mayHaveLanded: true',
    async (_name, route, run) => {
      const { client, trading } = await rig();
      const placed = accepted(await client.placeLimitOrder(BUY));
      trading.override = (r) =>
        r === route ? HttpResponse.error() : undefined;

      const error = await caught(() => run(client, placed.orderId));

      expect(error).toBeInstanceOf(TransportError);
      expect(error.mayHaveLanded).toBe(true);
      expect(hits(trading, route)).toHaveLength(1);
    },
  );

  test.each(CANCELS)(
    '%s is sent once: a 5xx throws with mayHaveLanded: true',
    async (_name, route, run) => {
      const { client, trading } = await rig();
      const placed = accepted(await client.placeLimitOrder(BUY));
      trading.override = (r) =>
        r === route
          ? HttpResponse.json({ error: 'busy' }, { status: 503 })
          : undefined;

      const error = await caught(() => run(client, placed.orderId));

      expect(error).toBeInstanceOf(RequestRejectedError);
      expect(error.status).toBe(503);
      expect(error.mayHaveLanded).toBe(true);
      expect(hits(trading, route)).toHaveLength(1);
      // Nothing was sent again, so the order is still open here.
      expect(trading.orders.map((o) => o.hash)).toEqual([placed.orderId]);
    },
  );

  test.each(CANCELS)(
    '%s refused by XO throws with mayHaveLanded: false',
    async (_name, route, run) => {
      const { client, trading } = await rig();
      const placed = accepted(await client.placeLimitOrder(BUY));
      trading.override = (r) =>
        r === route
          ? HttpResponse.json({ error: 'bad request' }, { status: 400 })
          : undefined;

      const error = await caught(() => run(client, placed.orderId));

      expect(error).toBeInstanceOf(RequestRejectedError);
      expect(error.status).toBe(400);
      expect(error.mayHaveLanded).toBe(false);
      expect(hits(trading, route)).toHaveLength(1);
    },
  );

  test('cancelOrder of an order that is not open stays a value, sent once', async () => {
    const { client, trading } = await rig();
    const missing = `0x${'0e'.repeat(32)}`;

    const result = await client.cancelOrder({ orderId: missing });

    expect(result.canceled).toEqual([]);
    expect(Object.keys(result.notCanceled)).toEqual([missing]);
    expect(hits(trading, 'DELETE /order')).toHaveLength(1);
  });

  test('cancelOrders of more than 300 ids: a later request that is lost may have landed, the earlier ones are done', async () => {
    const { client, trading } = await rig();
    const ids = Array.from(
      { length: 301 },
      (_, index) => `0x${index.toString(16).padStart(64, '0')}`,
    );
    let requests = 0;
    trading.override = (route) => {
      if (route !== 'DELETE /orders') {
        return undefined;
      }
      requests += 1;
      return requests === 2 ? HttpResponse.error() : undefined;
    };

    const error = await caught(() => client.cancelOrders({ orderIds: ids }));

    expect(error).toBeInstanceOf(TransportError);
    expect(error.mayHaveLanded).toBe(true);
    expect(hits(trading, 'DELETE /orders')).toHaveLength(2);
  });

  const IDS_301 = Array.from(
    { length: 301 },
    (_, index) => `0x${index.toString(16).padStart(64, '0')}`,
  );
  const tooMany = () =>
    HttpResponse.json(
      { error: 'rate limit exceeded', retry_after_ms: 10_000 },
      { status: 429 },
    );

  test.each([
    ['a 429', tooMany, RateLimitError],
    [
      'a 400',
      () => HttpResponse.json({ error: 'bad request' }, { status: 400 }),
      RequestRejectedError,
    ],
  ])(
    'cancelOrders of more than 300 ids: a later request refused with %s may have landed, since the first one cancelled',
    async (_name, respond, cls) => {
      const { client, trading } = await rig();
      let requests = 0;
      trading.override = (route) => {
        if (route !== 'DELETE /orders') {
          return undefined;
        }
        requests += 1;
        return requests === 2 ? respond() : undefined;
      };

      const error = await caught(() =>
        client.cancelOrders({ orderIds: IDS_301 }),
      );

      expect(error).toBeInstanceOf(cls);
      expect(error.mayHaveLanded).toBe(true);
      expect(hits(trading, 'DELETE /orders')).toHaveLength(2);
    },
  );

  test('cancelOrders of more than 300 ids: a later request that fails before it is sent may have landed, since the first one cancelled', async () => {
    const { client, trading, orderbook } = await rig();
    let requests = 0;
    trading.override = (route) => {
      if (route !== 'DELETE /orders') {
        return undefined;
      }
      requests += 1;
      return requests >= 2
        ? HttpResponse.json({ error: 'invalid HMAC' }, { status: 401 })
        : undefined;
    };
    // The sign-in after the 401 fails: the second request is never processed.
    orderbook.override = (route) =>
      route === 'derive'
        ? HttpResponse.json({ error: 'invalid request' }, { status: 400 })
        : undefined;

    const error = await caught(() =>
      client.cancelOrders({ orderIds: IDS_301 }),
    );

    expect(error).toBeInstanceOf(RequestRejectedError);
    expect(error.status).toBe(400);
    expect(error.mayHaveLanded).toBe(true);
  });

  test('cancelOrders of more than 300 ids: the first request refused with a 429 cancelled nothing', async () => {
    const { client, trading } = await rig();
    trading.override = (route) =>
      route === 'DELETE /orders' ? tooMany() : undefined;

    const error = await caught(() =>
      client.cancelOrders({ orderIds: IDS_301 }),
    );

    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.mayHaveLanded).toBe(false);
    expect(hits(trading, 'DELETE /orders')).toHaveLength(1);
  });

  test('cancelMarketOrders of an outcome with more than 300 open orders: a later request refused with a 429 may have landed', async () => {
    const { client, trading } = await rig();
    accepted(await client.placeLimitOrder(BUY));
    const [first] = trading.orders as [RestingOrder];
    for (let index = 1; index < 301; index += 1) {
      trading.orders.push({
        ...first,
        hash: `0x${index.toString(16).padStart(64, '0')}`,
        numericId: first.numericId + index,
      });
    }
    let requests = 0;
    trading.override = (route) => {
      if (route !== 'DELETE /orders') {
        return undefined;
      }
      requests += 1;
      return requests === 2 ? tooMany() : undefined;
    };

    const error = await caught(() =>
      client.cancelMarketOrders({ assetId: TOKEN_YES }),
    );

    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.mayHaveLanded).toBe(true);
    expect(hits(trading, 'DELETE /orders')).toHaveLength(2);
    // The first request cancelled 300 of them.
    expect(trading.orders).toHaveLength(1);
  });

  test('cancelMarketOrders of an outcome with more than 300 open orders: the first request refused with a 429 cancelled nothing', async () => {
    const { client, trading } = await rig();
    accepted(await client.placeLimitOrder(BUY));
    const [first] = trading.orders as [RestingOrder];
    for (let index = 1; index < 301; index += 1) {
      trading.orders.push({
        ...first,
        hash: `0x${index.toString(16).padStart(64, '0')}`,
        numericId: first.numericId + index,
      });
    }
    trading.override = (route) =>
      route === 'DELETE /orders' ? tooMany() : undefined;

    const error = await caught(() =>
      client.cancelMarketOrders({ assetId: TOKEN_YES }),
    );

    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.mayHaveLanded).toBe(false);
    expect(trading.orders).toHaveLength(301);
  });

  test('a later request whose error another caller already marked keeps that caller’s mark and throws its own copy', () => {
    const shared = new RateLimitError('too many requests', {
      service: 'orderbook',
      status: 429,
    });
    withLanded(shared, false);

    const thrown = failureAfterAnswer(shared) as XoError;

    expect(thrown).not.toBe(shared);
    expect(thrown).toBeInstanceOf(RateLimitError);
    expect(thrown.status).toBe(429);
    expect(thrown.message).toBe(shared.message);
    expect(thrown.mayHaveLanded).toBe(true);
    expect(shared.mayHaveLanded).toBe(false);
  });

  test('cancelMarketOrders of an outcome whose order list fails cancels nothing: mayHaveLanded: false', async () => {
    const { client, trading } = await rig();
    accepted(await client.placeLimitOrder(BUY));
    trading.override = (route) =>
      route === 'GET /data/orders' ? HttpResponse.error() : undefined;

    const error = await caught(() =>
      client.cancelMarketOrders({ assetId: TOKEN_YES }),
    );

    expect(error).toBeInstanceOf(TransportError);
    expect(error.mayHaveLanded).toBe(false);
    expect(hits(trading, 'DELETE /orders')).toEqual([]);
  });

  test('cancelOrders cancels by id and says which were not', async () => {
    const { client, trading } = await rig();
    const placed = accepted(await client.placeLimitOrder(BUY));
    const missing = `0x${'0e'.repeat(32)}`;

    const result = await client.cancelOrders({
      orderIds: [placed.orderId, missing],
    });

    expect(result).toEqual({
      canceled: [placed.orderId],
      notCanceled: { [missing]: 'order not found' },
    });
    expect(bodyOf(hits(trading, 'DELETE /orders')[0])).toEqual([
      placed.orderId,
      missing,
    ]);
  });

  test('cancelAll cancels every open order', async () => {
    const { client, trading } = await rig();
    const placed = accepted(await client.placeLimitOrder(BUY));

    const result = await client.cancelAll();

    expect(result).toEqual({ canceled: [placed.orderId], notCanceled: {} });
    expect(hits(trading, 'DELETE /cancel-all')).toHaveLength(1);
  });

  test('cancelMarketOrders({ market }) cancels the orders of that market', async () => {
    const { client, trading } = await rig();
    const placed = accepted(await client.placeLimitOrder(BUY));

    const result = await client.cancelMarketOrders({ market: CONDITION_A });

    expect(result).toEqual({ canceled: [placed.orderId], notCanceled: {} });
    expect(bodyOf(hits(trading, 'DELETE /cancel-market-orders')[0])).toEqual({
      marketId: CONDITION_A,
    });
  });

  test('cancelMarketOrders({ assetId }) cancels the orders of that outcome only', async () => {
    const { client, trading } = await rig();
    const yes = accepted(await client.placeLimitOrder(BUY));
    const no = accepted(
      await client.placeLimitOrder({ ...BUY, assetId: TOKEN_NO }),
    );

    const result = await client.cancelMarketOrders({ assetId: TOKEN_NO });

    expect(result).toEqual({ canceled: [no.orderId], notCanceled: {} });
    expect(trading.orders.map((o) => o.hash)).toEqual([yes.orderId]);
    expect(queryOf(hits(trading, 'GET /data/orders')[0])).toEqual({
      asset_id: TOKEN_NO,
    });
    expect(hits(trading, 'DELETE /cancel-market-orders')).toEqual([]);
  });

  test('a cancel request needs an id, and a market cancel a market or an outcome', async () => {
    const { client, trading } = await rig();

    for (const run of [
      () => client.cancelOrder({ orderId: 'not an id' }),
      () => client.cancelOrders({ orderIds: [] }),
      () =>
        client.cancelMarketOrders(
          {} as Parameters<SecureClient['cancelMarketOrders']>[0],
        ),
    ]) {
      const error = await caught(run);
      expect(error).toBeInstanceOf(UserInputError);
      expect(error.code).toBe('invalid_input');
    }
    expect(trading.requests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The account's orders and trades
// ---------------------------------------------------------------------------

function rawTrade(
  id: string,
  o: {
    taker?: string;
    assetId?: string;
    matchTime?: number;
    outcome?: 'YES' | 'NO';
  } = {},
) {
  const asset = o.assetId ?? TOKEN_YES;
  const time = String(o.matchTime ?? 1_800_000_000);
  return {
    id,
    market: CONDITION_A,
    outcome: o.outcome ?? 'YES',
    side: 'BUY',
    price: '0.500',
    size: '10',
    status: 'MATCHED',
    match_time: time,
    last_update: time,
    bucket_index: 0,
    transaction_hash: null,
    taker_order_id: o.taker ?? `0x${'aa'.repeat(32)}`,
    asset_id: asset,
    fee_rate_bps: '0',
    owner: '6f1e7a5c-0000-5000-8000-000000000000',
    maker_address: `0x${'bb'.repeat(20)}`,
    trader_side: 'TAKER',
    maker_orders: [
      {
        order_id: `0x${'cc'.repeat(32)}`,
        maker_address: `0x${'bb'.repeat(20)}`,
        owner: '6f1e7a5c-0000-5000-8000-000000000001',
        matched_amount: '10',
        price: '0.500',
        fee_rate_bps: '0',
        asset_id: asset,
        outcome: o.outcome ?? 'YES',
      },
    ],
  };
}

describe('listOpenOrders and fetchOrder', () => {
  test('listOpenOrders iterates pages and from(cursor) resumes', async () => {
    const { client, trading } = await rig({ pageLimit: 2 });
    const placed = [
      accepted(await client.placeLimitOrder(BUY)),
      accepted(await client.placeLimitOrder({ ...BUY, price: '0.4' })),
      accepted(await client.placeLimitOrder({ ...BUY, price: '0.3' })),
    ];
    const list = client.listOpenOrders({ market: CONDITION_A });

    const pages = [];
    for await (const page of list) {
      pages.push(page);
    }
    const first = await list.firstPage();
    const rest = await list.from(first.nextCursor).firstPage();

    expect(pages.map((p) => p.items.map((o) => o.orderId))).toEqual([
      [placed[0]?.orderId, placed[1]?.orderId],
      [placed[2]?.orderId],
    ]);
    expect(pages.map((p) => p.hasMore)).toEqual([true, false]);
    expect(rest.items.map((o) => o.orderId)).toEqual([placed[2]?.orderId]);
    expect(rest.hasMore).toBe(false);
    expect(pages[0]?.items[0]).toMatchObject({
      assetId: TOKEN_YES,
      market: CONDITION_A,
      side: 'BUY',
      price: '0.500',
      originalSize: '10',
      orderType: 'GTC',
      expiration: null,
    });
    for (const request of hits(trading, 'GET /data/orders')) {
      expect(queryOf(request).market).toBe(CONDITION_A);
    }
  });

  test('from() refuses a cursor it did not give out', async () => {
    const { client } = await rig();

    const error = await caught(() =>
      client.listOpenOrders().from('not-a-cursor'),
    );

    expect(error).toBeInstanceOf(UserInputError);
    expect(error.code).toBe('invalid_cursor');
  });

  test('listOpenOrders({ assetId }) asks for that outcome', async () => {
    const { client, trading } = await rig();
    await client.placeLimitOrder(BUY);
    const no = accepted(
      await client.placeLimitOrder({ ...BUY, assetId: TOKEN_NO }),
    );

    const page = await client.listOpenOrders({ assetId: TOKEN_NO }).firstPage();

    expect(page.items.map((o) => o.orderId)).toEqual([no.orderId]);
    expect(queryOf(hits(trading, 'GET /data/orders').at(-1))).toEqual({
      asset_id: TOKEN_NO,
    });
  });

  test('fetchOrder reads one open order, with the options of the call', async () => {
    const { client, trading } = await rig();
    const placed = accepted(await client.placeLimitOrder(BUY));
    trading.override = (() => {
      let first = true;
      return (route: string) => {
        if (route === 'GET /data/order/{id}' && first) {
          first = false;
          return HttpResponse.json({ error: 'busy' }, { status: 503 });
        }
        return undefined;
      };
    })();

    const error = await caught(() =>
      client.fetchOrder({ orderId: placed.orderId }, { retries: 0 }),
    );
    const order = await client.fetchOrder({ orderId: placed.orderId });

    expect(error).toBeInstanceOf(RequestRejectedError);
    expect(order).toMatchObject({ orderId: placed.orderId, status: 'LIVE' });
  });
});

describe('listAccountTrades and fetchAccountTrade', () => {
  const TRADE_A = `0x${'01'.repeat(32)}`;
  const TRADE_B = `0x${'02'.repeat(32)}`;
  const TRADE_C = `0x${'03'.repeat(32)}`;

  async function withTrades() {
    const r = await rig();
    const owner = OWNER.toLowerCase();
    r.trading.trades.push(
      { owner, trade: rawTrade(TRADE_A, { matchTime: 1_800_000_000 }) },
      {
        owner,
        trade: rawTrade(TRADE_B, {
          assetId: TOKEN_NO,
          outcome: 'NO',
          matchTime: 1_800_000_100,
        }),
      },
      { owner, trade: rawTrade(TRADE_C, { matchTime: 1_800_000_200 }) },
    );
    return r;
  }

  test('lists the trades newest first, filtered by market on the wire', async () => {
    const { client, trading } = await withTrades();

    const page = await client
      .listAccountTrades({ market: CONDITION_A })
      .firstPage();

    expect(page.items.map((t) => t.id)).toEqual([TRADE_C, TRADE_B, TRADE_A]);
    expect(page.items[0]).toMatchObject({
      market: CONDITION_A,
      assetId: TOKEN_YES,
      matchedAt: new Date(1_800_000_200_000).toISOString(),
    });
    expect(queryOf(hits(trading, 'GET /data/trades')[0])).toEqual({
      market: CONDITION_A,
    });
  });

  test('assetId, after and before keep the trades of that outcome and window', async () => {
    const { client, trading } = await withTrades();

    const yes = await client
      .listAccountTrades({ assetId: TOKEN_YES })
      .firstPage();
    const window = await client
      .listAccountTrades({
        after: 1_800_000_100,
        before: new Date(1_800_000_200_000),
      })
      .firstPage();

    const padded = await client
      .listAccountTrades({ assetId: `0${TOKEN_YES}` })
      .firstPage();

    expect(yes.items.map((t) => t.id)).toEqual([TRADE_C, TRADE_A]);
    expect(padded.items.map((t) => t.id)).toEqual([TRADE_C, TRADE_A]);
    expect(window.items.map((t) => t.id)).toEqual([TRADE_B]);
    // Only the market is a filter on the wire.
    for (const request of hits(trading, 'GET /data/trades')) {
      expect(queryOf(request)).toEqual({});
    }
  });

  test('fetchAccountTrade reads one trade', async () => {
    const { client } = await withTrades();

    const trade = await client.fetchAccountTrade({ tradeId: TRADE_B });

    expect(trade).toMatchObject({
      id: TRADE_B,
      assetId: TOKEN_NO,
      outcome: 'NO',
    });
  });
});

// ---------------------------------------------------------------------------
// Heartbeats
// ---------------------------------------------------------------------------

describe('heartbeats', () => {
  test('sendOrderHeartbeat sends one beat and says whether it counted', async () => {
    const { client, trading } = await rig();

    const answer = await client.sendOrderHeartbeat();

    expect(answer).toEqual({ tracked: true });
    expect(hits(trading, 'POST /v1/heartbeats')).toHaveLength(1);
  });

  test('a beat that did not count is tracked: false, and it is not sent again', async () => {
    const { client, trading } = await rig();
    trading.override = (route) =>
      route === 'POST /v1/heartbeats'
        ? HttpResponse.json({ status: 'ok', tracked: false })
        : undefined;

    expect(await client.sendOrderHeartbeat()).toEqual({ tracked: false });
    expect(hits(trading, 'POST /v1/heartbeats')).toHaveLength(1);
  });

  test('startOrderHeartbeat returns its handle at once, and stop() ends it', async () => {
    const { client, trading } = await rig();

    const heartbeat = client.startOrderHeartbeat({ intervalMs: 1_000 });

    expect(heartbeat).not.toBeInstanceOf(Promise);
    expect(heartbeat.running).toBe(true);
    await vi.waitFor(() =>
      expect(hits(trading, 'POST /v1/heartbeats').length).toBeGreaterThan(0),
    );
    heartbeat.stop();
    expect(heartbeat.running).toBe(false);
    // One loop per client.
    const again = client.startOrderHeartbeat();
    expect(() => client.startOrderHeartbeat()).toThrow(UserInputError);
    again.stop();
  });

  test('a bad interval is refused at once', async () => {
    const { client } = await rig();

    expect(() => client.startOrderHeartbeat({ intervalMs: 50 })).toThrow(
      UserInputError,
    );
  });
});

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

describe('a closed client', () => {
  test('every trading member refuses with client_closed, and nothing is sent', async () => {
    const { client, trading } = await rig();
    const order = await client.createLimitOrder(BUY);
    await client.close();
    const before = trading.requests.length;

    const calls: Array<[string, () => unknown]> = [
      ['createLimitOrder', () => client.createLimitOrder(BUY)],
      [
        'createMarketOrder',
        () =>
          client.createMarketOrder({
            assetId: TOKEN_YES,
            side: OrderSide.BUY,
            amount: 1,
          }),
      ],
      ['placeLimitOrder', () => client.placeLimitOrder(BUY)],
      [
        'placeMarketOrder',
        () =>
          client.placeMarketOrder({
            assetId: TOKEN_YES,
            side: OrderSide.SELL,
            shares: 1,
          }),
      ],
      ['postOrder', () => client.postOrder(order)],
      ['postOrders', () => client.postOrders([order])],
      [
        'postOrderBatch',
        () =>
          client.postOrderBatch({
            operations: [{ type: 'place', orders: [order] }],
          }),
      ],
      ['cancelOrder', () => client.cancelOrder({ orderId: order.orderHash })],
      [
        'cancelOrders',
        () => client.cancelOrders({ orderIds: [order.orderHash] }),
      ],
      ['cancelAll', () => client.cancelAll()],
      [
        'cancelMarketOrders',
        () => client.cancelMarketOrders({ market: CONDITION_A }),
      ],
      ['listOpenOrders', () => client.listOpenOrders()],
      ['fetchOrder', () => client.fetchOrder({ orderId: order.orderHash })],
      ['listAccountTrades', () => client.listAccountTrades()],
      [
        'fetchAccountTrade',
        () => client.fetchAccountTrade({ tradeId: `0x${'01'.repeat(32)}` }),
      ],
      ['sendOrderHeartbeat', () => client.sendOrderHeartbeat()],
      ['startOrderHeartbeat', () => client.startOrderHeartbeat()],
      [
        'reconcileOrder',
        () => client.reconcileOrder({ orderHash: order.orderHash }),
      ],
      [
        'fetchMarketCapacity',
        () => client.fetchMarketCapacity({ conditionId: CONDITION_A }),
      ],
    ];
    for (const [name, run] of calls) {
      const error = await caught(run);
      expect(error, name).toBeInstanceOf(UserInputError);
      expect(error.code, name).toBe('client_closed');
      expect(error.mayHaveLanded, name).toBe(false);
    }
    // The lists and the heartbeat start refuse at once; nothing else returns a value.
    expect(() => client.listOpenOrders()).toThrow(UserInputError);
    expect(() => client.listAccountTrades()).toThrow(UserInputError);
    expect(() => client.startOrderHeartbeat()).toThrow(UserInputError);
    expect(trading.requests.length).toBe(before);
  });

  test('a list made before close() refuses to read after it', async () => {
    const { client, trading } = await rig();
    const list = client.listOpenOrders();
    await client.close();

    const error = await caught(() => list.firstPage());

    expect(error).toBeInstanceOf(UserInputError);
    expect(error.code).toBe('client_closed');
    expect(hits(trading, 'GET /data/orders')).toEqual([]);
  });

  test('fetchMarketCapacity reads the capacity of the account', async () => {
    const { client, trading } = await rig();
    trading.accounts.set(OWNER.toLowerCase(), {
      cash: '25000000',
      positions: [{ token_id: TOKEN_YES, balance: '3000000', reserved: '0' }],
    });

    const capacity = await client.fetchMarketCapacity({
      conditionId: CONDITION_A,
    });

    expect(capacity.buyCapacity).toBe('25');
    expect(hits(trading, 'GET /data/market-capacity')).toHaveLength(1);
  });
});
