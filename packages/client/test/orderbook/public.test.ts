import { HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import {
  type RequestRejectedError,
  UnexpectedResponseError,
  UserInputError,
} from '../../src/core/errors';
import { type AuthProvider, Transport } from '../../src/core/transport';
import { OrderbookClient, type PriceRequest } from '../../src/orderbook/client';
import {
  CONDITION_A,
  CONDITION_B,
  defaultBooks,
  type FixtureBook,
  installMarketData,
  type MarketData,
  type MarketDataOptions,
  type MarketDataRequest,
  SERVER_TIME_SEC,
  TOKEN_NO,
  TOKEN_UNKNOWN,
  TOKEN_YES,
} from '../helpers/mockMarketData';
import { rejectedWith } from '../helpers/rejections';
import { testEnv } from '../helpers/testEnv';

const env = testEnv;

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

interface RigOptions {
  strict?: boolean;
  maxRetries?: number;
  auth?: AuthProvider;
  data?: MarketDataOptions;
}

function rig(o: RigOptions = {}) {
  const transport = new Transport({
    env,
    version: '9.9.9',
    maxRetries: o.maxRetries ?? 0,
    ...(o.auth === undefined ? {} : { auth: o.auth }),
  });
  const data = installMarketData(server, o.data);
  const client = new OrderbookClient({
    transport,
    env,
    ...(o.strict === undefined ? {} : { strictResponses: o.strict }),
  });
  return { client, data, transport };
}

function last(data: MarketData): MarketDataRequest {
  const request = data.requests.at(-1);
  if (request === undefined) {
    throw new Error('no request reached the fake gateway');
  }
  return request;
}

/** The query of a request as a plain object. */
function queryOf(request: MarketDataRequest): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(request.search));
}

async function caught(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

/** The message of the UserInputError a call throws, whether it throws at once or later. */
async function invalid(run: () => unknown): Promise<string> {
  const error = await caught(run);
  expect(error).toBeInstanceOf(UserInputError);
  return (error as UserInputError).message;
}

const SERVICE_UNAVAILABLE_503 = () =>
  HttpResponse.json(
    { error: 'service_unavailable', retry_after_ms: 0 },
    { status: 503 },
  );

/** Answers the first `times` requests to `route` with a 503, then lets the fake handle them. */
function failFirst(
  data: MarketData,
  route: string,
  times = 1,
): { hits: () => number } {
  let hits = 0;
  data.override = (path) => {
    if (path !== route) {
      return undefined;
    }
    hits += 1;
    return hits <= times ? SERVICE_UNAVAILABLE_503() : undefined;
  };
  return { hits: () => hits };
}

const BAD_TOKEN_IDS: Array<[string, unknown]> = [
  ['a number', 4660],
  ['a bigint', 4660n],
  ['hex', '0x1234'],
  ['empty', ''],
  ['signed', '-1'],
  ['with a dot', '1.5'],
  ['with whitespace', ' 1'],
  ['79 digits', '1'.repeat(79)],
  ['2^256', (2n ** 256n).toString()],
  ['undefined', undefined],
  ['null', null],
  ['an object', {}],
];

const BAD_CONDITION_IDS: Array<[string, unknown]> = [
  ['empty', ''],
  ['a token id', TOKEN_YES],
  ['63 hex digits', `0x${'a'.repeat(63)}`],
  ['65 hex digits', `0x${'a'.repeat(65)}`],
  ['no prefix', 'a1'.repeat(32)],
  ['non-hex', `0x${'g'.repeat(64)}`],
  ['a path', `${CONDITION_A}/../conviction`],
  ['a query', `${CONDITION_A}?x=1`],
  ['a number', 5],
  ['undefined', undefined],
  ['null', null],
];

/** A literal book answer, for tests that hand-shape the answer. */
const BOOK_BODY = {
  market: CONDITION_A,
  asset_id: TOKEN_YES,
  timestamp: '1800000123456',
  hash: 'ab12',
  bids: [{ price: '0.550', size: '100' }],
  asks: [{ price: '0.560', size: '80.123456' }],
  min_order_size: '0',
  tick_size: '0.001',
  neg_risk: false,
  last_trade_price: '0.000',
  last_update_id: 42,
};

// One valid call per public method, for the tests that must hold for all of them.
const PUBLIC_CALLS: Array<
  [string, string, (c: OrderbookClient) => Promise<unknown>]
> = [
  ['getServerTime', 'GET /time', (c) => c.getServerTime()],
  ['getTradingState', 'GET /trading-state', (c) => c.getTradingState()],
  ['getTickSize', 'GET /tick-size', (c) => c.getTickSize(TOKEN_YES)],
  ['getMarket', `GET /markets/${CONDITION_A}`, (c) => c.getMarket(CONDITION_A)],
  [
    'getConvictionMarket',
    `GET /conviction/markets/${CONDITION_A}`,
    (c) => c.getConvictionMarket(CONDITION_A),
  ],
  ['getBook', 'GET /book', (c) => c.getBook(TOKEN_YES)],
  ['getBooks', 'POST /books', (c) => c.getBooks([TOKEN_YES, TOKEN_NO])],
  ['getMidpoint', 'GET /midpoint', (c) => c.getMidpoint(TOKEN_YES)],
  ['getMidpoints', 'POST /midpoints', (c) => c.getMidpoints([TOKEN_YES])],
  ['getPrice', 'GET /price', (c) => c.getPrice(TOKEN_YES, 'BUY')],
  [
    'getPrices',
    'POST /prices',
    (c) => c.getPrices([{ tokenId: TOKEN_YES, side: 'SELL' }]),
  ],
  ['getSpread', 'GET /spread', (c) => c.getSpread(TOKEN_YES)],
  ['getSpreads', 'POST /spreads', (c) => c.getSpreads([TOKEN_YES])],
  [
    'getLastTradePrice',
    'GET /last-trade-price',
    (c) => c.getLastTradePrice(TOKEN_YES),
  ],
  [
    'getLastTradePrices',
    'POST /last-trades-prices',
    (c) => c.getLastTradePrices([TOKEN_YES, TOKEN_NO]),
  ],
  [
    'getPricesHistory',
    'GET /prices-history',
    (c) => c.getPricesHistory({ tokenId: TOKEN_YES, limit: 2 }),
  ],
  ['getMarkets', 'GET /markets', (c) => c.getMarkets({ limit: 5 }).toArray()],
];

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

describe('getServerTime', () => {
  test('reads GET /time (a bare JSON number) as unix seconds', async () => {
    const { client, data } = rig();
    expect(await client.getServerTime()).toBe(SERVER_TIME_SEC);
    expect(data.calls).toEqual(['GET /time']);
    expect(last(data).search).toBe('');
  });

  test('reads plain digits too', async () => {
    const { client, data } = rig();
    data.override = () =>
      new Response('1800000123', { headers: { 'content-type': 'text/plain' } });
    expect(await client.getServerTime()).toBe(1_800_000_123);
  });

  test.each([
    ['letters', 'soon'],
    ['a fraction', '12.5'],
    ['a sign', '-5'],
    ['an exponent', '1e9'],
    ['leading whitespace', ' 12'],
    ['trailing whitespace', '12\n'],
    ['non-ASCII digits', '١٢٣'],
    ['an empty body', ''],
    ['digits beyond the safe integers', '99999999999999999999'],
  ])('text with %s is an UnexpectedResponseError', async (_name, text) => {
    const { client, data } = rig();
    data.override = () =>
      new Response(text, { headers: { 'content-type': 'text/plain' } });
    const error = await caught(() => client.getServerTime());
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).service).toBe('orderbook');
  });

  test.each([
    ['a fraction', 12.5],
    ['a negative number', -1],
    ['a string', 'abc'],
    ['an object', { timestamp: 1_800_000_123 }],
    ['null', null],
    ['a boolean', true],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ])(
    'a JSON body that is %s is an UnexpectedResponseError',
    async (_name, body) => {
      const { client, data } = rig();
      data.override = () => HttpResponse.json(body);
      await expect(client.getServerTime()).rejects.toBeInstanceOf(
        UnexpectedResponseError,
      );
    },
  );
});

describe('getTradingState', () => {
  test('reads GET /trading-state', async () => {
    const { client, data } = rig();
    expect(await client.getTradingState()).toBe('active');
    data.paused = true;
    expect(await client.getTradingState()).toBe('paused');
    expect(data.calls).toEqual(['GET /trading-state', 'GET /trading-state']);
    expect(last(data).search).toBe('');
  });

  test('accepts a state it does not know', async () => {
    const { client, data } = rig();
    data.override = () => HttpResponse.json({ state: 'draining' });
    expect(await client.getTradingState()).toBe('draining');
  });

  test('strict mode refuses a state it does not know', async () => {
    const { client, data } = rig({ strict: true });
    data.override = () => HttpResponse.json({ state: 'draining' });
    await expect(client.getTradingState()).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });

  test('a missing or non-string state is refused in both modes', async () => {
    for (const strict of [false, true]) {
      for (const body of [{}, { state: 1 }, { state: null }, 'active']) {
        const { client, data } = rig({ strict });
        data.override = () => HttpResponse.json(body);
        await expect(client.getTradingState()).rejects.toBeInstanceOf(
          UnexpectedResponseError,
        );
        server.resetHandlers();
      }
    }
  });
});

describe('getTickSize', () => {
  test('reads GET /tick-size?token_id= and keeps it as a decimal string', async () => {
    const { client, data } = rig();
    expect(await client.getTickSize(TOKEN_YES)).toBe('0.001');
    expect(last(data).path).toBe('/tick-size');
    expect(queryOf(last(data))).toEqual({ token_id: TOKEN_YES });
  });

  test('sends the canonical token id (no leading zeros)', async () => {
    const { client, data } = rig();
    await client.getTickSize(`0${TOKEN_YES}`);
    expect(queryOf(last(data))).toEqual({ token_id: TOKEN_YES });
  });

  test('an unknown token is a 404 rejection', async () => {
    const { client } = rig();
    const error = await caught(() => client.getTickSize(TOKEN_UNKNOWN));
    expect(error).toSatisfy(rejectedWith(404));
    expect((error as RequestRejectedError).status).toBe(404);
    expect((error as RequestRejectedError).service).toBe('orderbook');
  });

  test.each([
    [0.01, '0.01'],
    [0.1, '0.1'],
    [1, '1'],
    [0.0001, '0.0001'],
    [0.000001, '0.000001'],
  ])('a tick size of %s becomes the plain string %s', async (size, text) => {
    const { client, data } = rig();
    data.override = (route) =>
      route === '/tick-size'
        ? HttpResponse.json({ minimum_tick_size: size })
        : route === '/markets/{condition_id}'
          ? HttpResponse.json({
              condition_id: CONDITION_A,
              tokens: [],
              minimum_tick_size: size,
              neg_risk: false,
              active: true,
            })
          : undefined;
    expect(await client.getTickSize(TOKEN_YES)).toBe(text);
    expect((await client.getMarket(CONDITION_A)).minimum_tick_size).toBe(text);
  });

  test('a tick size that is not a plain positive number is refused', async () => {
    for (const body of [
      { minimum_tick_size: '0.001' },
      { minimum_tick_size: 1e-7 },
      { minimum_tick_size: -0.001 },
      { minimum_tick_size: 0 },
      {},
    ]) {
      const { client, data } = rig();
      data.override = () => HttpResponse.json(body);
      await expect(client.getTickSize(TOKEN_YES)).rejects.toBeInstanceOf(
        UnexpectedResponseError,
      );
      server.resetHandlers();
    }
  });
});

// ---------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------

describe('getMarkets', () => {
  test('iterates two pages with next_cursor and stops at "LTE="', async () => {
    const { client, data } = rig();
    const items = await client.getMarkets({ limit: 1 }).toArray();
    expect(items.map((m) => m.condition_id)).toEqual([
      CONDITION_A,
      CONDITION_B,
    ]);
    expect(data.calls).toEqual(['GET /markets', 'GET /markets']);
    const [first, second] = data.requests;
    expect(queryOf(first as MarketDataRequest)).toEqual({ limit: '1' });
    // The cursor of the second page is the one the first page returned: base64("1").
    expect(queryOf(second as MarketDataRequest)).toEqual({
      limit: '1',
      next_cursor: Buffer.from('1').toString('base64'),
    });
  });

  test('is lazy, and a break stops fetching', async () => {
    const { client, data } = rig();
    const markets = client.getMarkets({ limit: 1 });
    expect(data.calls).toEqual([]);
    for await (const market of markets) {
      expect(market.condition_id).toBe(CONDITION_A);
      break;
    }
    expect(data.calls).toEqual(['GET /markets']);
  });

  test('a single page sends no query and ends at "LTE="', async () => {
    const { client, data } = rig();
    const page = await client.getMarkets().firstPage();
    expect(page.hasNext).toBe(false);
    expect(page.items).toHaveLength(2);
    expect(data.calls).toEqual(['GET /markets']);
    expect(last(data).search).toBe('');
    expect(page.raw).toMatchObject({
      count: 2,
      limit: 100,
      next_cursor: 'LTE=',
    });
  });

  test('keeps the market fields, with the tick size as a decimal string', async () => {
    const { client } = rig();
    const [a, b] = await client.getMarkets().toArray();
    expect(a).toEqual({
      condition_id: CONDITION_A,
      tokens: [
        { token_id: TOKEN_YES, outcome: 'Yes', price: '0.555' },
        { token_id: TOKEN_NO, outcome: 'No', price: '0.000' },
      ],
      minimum_tick_size: '0.001',
      neg_risk: false,
      active: true,
    });
    expect(b?.active).toBe(false);
  });

  test.each([
    ['zero', 0],
    ['501', 501],
    ['negative', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '5'],
    ['null', null],
  ])(
    'a limit that is %s is refused before any request',
    async (_name, limit) => {
      const { client, data } = rig();
      const message = await invalid(() =>
        client.getMarkets({ limit: limit as number }),
      );
      expect(message).toMatch(/^limit /);
      expect(message).toContain('between 1 and 500');
      expect(data.calls).toEqual([]);
    },
  );

  test('1 and 500 are accepted', async () => {
    const { client, data } = rig();
    await client.getMarkets({ limit: 500 }).firstPage();
    expect(queryOf(last(data)).limit).toBe('500');
    await client.getMarkets({ limit: 1 }).firstPage();
    expect(queryOf(last(data)).limit).toBe('1');
  });

  test.each([
    ['next_cursor', { next_cursor: 'MQ==' }],
    ['cursor', { cursor: 'MQ==' }],
    ['offset', { offset: 1 }],
    ['maker', { maker: '0x0' }],
    ['address', { address: '0x0' }],
  ])(
    'an unknown option %s is refused before any request',
    async (key, options) => {
      const { client, data } = rig();
      const message = await invalid(() => client.getMarkets(options as never));
      expect(message).toContain(key);
      expect(data.calls).toEqual([]);
    },
  );

  test.each([null, 5, 'limit', [1]])(
    'options %o are refused',
    async (options) => {
      const { client, data } = rig();
      await invalid(() => client.getMarkets(options as never));
      expect(data.calls).toEqual([]);
    },
  );

  test('an explicit undefined limit is the default', async () => {
    const { client, data } = rig();
    await client.getMarkets({ limit: undefined }).firstPage();
    expect(last(data).search).toBe('');
  });
});

describe('getMarket', () => {
  test('reads GET /markets/{condition_id} and lower-cases the id', async () => {
    const { client, data } = rig();
    const upper = `0x${'A1'.repeat(32)}`;
    const market = await client.getMarket(upper);
    expect(last(data).path).toBe(`/markets/${CONDITION_A}`);
    expect(last(data).search).toBe('');
    expect(market.condition_id).toBe(CONDITION_A);
    expect(market.tokens.map((t) => t.outcome)).toEqual(['Yes', 'No']);
    expect(market.minimum_tick_size).toBe('0.001');
  });

  test.each(BAD_CONDITION_IDS)(
    'a condition id that is %s is refused before any request',
    async (_name, id) => {
      const { client, data } = rig();
      const message = await invalid(() => client.getMarket(id as string));
      expect(message).toMatch(/^conditionId /);
      expect(data.calls).toEqual([]);
    },
  );

  test('an unknown market is a 404 rejection', async () => {
    const { client } = rig();
    await expect(client.getMarket(`0x${'ee'.repeat(32)}`)).rejects.toSatisfy(
      rejectedWith(404),
    );
  });
});

describe('getConvictionMarket', () => {
  test('reads GET /conviction/markets/{condition_id} and keeps the commitment strings', async () => {
    const { client, data } = rig();
    const market = await client.getConvictionMarket(
      CONDITION_A.toUpperCase().replace('0X', '0x'),
    );
    expect(last(data).path).toBe(`/conviction/markets/${CONDITION_A}`);
    expect(last(data).search).toBe('');
    expect(market).toEqual({
      condition_id: CONDITION_A,
      tokens: [
        { token_id: TOKEN_YES, outcome: 'Yes', price: '0.555' },
        { token_id: TOKEN_NO, outcome: 'No', price: '0.000' },
      ],
      active: true,
      variant: 'conviction',
      creator: `0x${'c0'.repeat(20)}`,
      commitment: {
        order_id: '77',
        status: 'resting',
        outcome: 'yes',
        side: 'buy',
        price: '0.700',
        size: '50',
        remaining: '50',
      },
    });
  });

  test('a plain market has a null creator and a null commitment', async () => {
    const { client } = rig();
    const market = await client.getConvictionMarket(CONDITION_B);
    expect(market.variant).toBe('clob');
    expect(market.creator).toBeNull();
    expect(market.commitment).toBeNull();
    expect(market.active).toBe(false);
  });

  test.each([false, true])(
    'a commitment may leave out side, price, size and remaining (strict: %s)',
    async (strict) => {
      const { client, data } = rig({ strict });
      data.override = () =>
        HttpResponse.json({
          condition_id: CONDITION_A,
          tokens: [],
          active: true,
          variant: 'conviction',
          creator: null,
          commitment: {
            order_id: '9',
            status: 'spent_tombstone',
            outcome: 'no',
          },
        });
      const market = await client.getConvictionMarket(CONDITION_A);
      expect(market.commitment).toEqual({
        order_id: '9',
        status: 'spent_tombstone',
        outcome: 'no',
      });
    },
  );

  test('an unknown variant is accepted, and refused in strict mode', async () => {
    const body = {
      condition_id: CONDITION_A,
      tokens: [],
      active: true,
      variant: 'clob_future',
      creator: null,
      commitment: null,
    };
    const lenient = rig();
    lenient.data.override = () => HttpResponse.json(body);
    expect(
      (await lenient.client.getConvictionMarket(CONDITION_A)).variant,
    ).toBe('clob_future');
    server.resetHandlers();
    const strict = rig({ strict: true });
    strict.data.override = () => HttpResponse.json(body);
    await expect(
      strict.client.getConvictionMarket(CONDITION_A),
    ).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  test.each(BAD_CONDITION_IDS)(
    'a condition id that is %s is refused before any request',
    async (_name, id) => {
      const { client, data } = rig();
      await invalid(() => client.getConvictionMarket(id as string));
      expect(data.calls).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// Books
// ---------------------------------------------------------------------------

describe('getBook', () => {
  test('reads GET /book?token_id= and keeps the price strings exactly, padded', async () => {
    const { client, data } = rig();
    const book = await client.getBook(TOKEN_YES);
    expect(last(data).path).toBe('/book');
    expect(queryOf(last(data))).toEqual({ token_id: TOKEN_YES });
    expect(book.bids).toEqual([
      { price: '0.550', size: '100' },
      { price: '0.540', size: '25.5' },
    ]);
    expect(book.asks).toEqual([
      { price: '0.560', size: '80.123456' },
      { price: '0.570', size: '10' },
    ]);
    expect(typeof book.bids[0]?.price).toBe('string');
    expect(book).toMatchObject({
      asset_id: TOKEN_YES,
      min_order_size: '0',
      tick_size: '0.001',
      neg_risk: false,
      last_trade_price: '0.000',
      last_update_id: 42,
    });
    expect(typeof book.timestamp).toBe('string');
  });

  test('an empty side is an empty array', async () => {
    const { client } = rig();
    const book = await client.getBook(TOKEN_NO);
    expect(book.asks).toEqual([]);
    expect(book.bids).toEqual([{ price: '0.440', size: '5' }]);
  });

  test('an unknown token is a 404 rejection', async () => {
    const { client } = rig();
    await expect(client.getBook(TOKEN_UNKNOWN)).rejects.toSatisfy(
      rejectedWith(404),
    );
  });
});

describe('getBooks', () => {
  test('posts [{token_id}] to /books and returns the books in order', async () => {
    const { client, data } = rig();
    const books = await client.getBooks([TOKEN_NO, TOKEN_YES]);
    expect(last(data).method).toBe('POST');
    expect(last(data).path).toBe('/books');
    expect(last(data).search).toBe('');
    expect(last(data).body).toBe(
      JSON.stringify([{ token_id: TOKEN_NO }, { token_id: TOKEN_YES }]),
    );
    expect(last(data).headers.get('content-type')).toBe('application/json');
    expect(books.map((b) => b.asset_id)).toEqual([TOKEN_NO, TOKEN_YES]);
    expect(books[1]?.bids[0]?.price).toBe('0.550');
  });

  test('an empty list is posted as []', async () => {
    const { client, data } = rig();
    expect(await client.getBooks([])).toEqual([]);
    expect(last(data).body).toBe('[]');
  });

  test('an unknown token fails the batch with a 404 rejection', async () => {
    const { client } = rig();
    await expect(client.getBooks([TOKEN_YES, TOKEN_UNKNOWN])).rejects.toSatisfy(
      rejectedWith(404),
    );
  });
});

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

describe('getMidpoint and getMidpoints', () => {
  test('getMidpoint reads GET /midpoint?token_id= as the gateway prints it', async () => {
    const { client, data } = rig();
    expect(await client.getMidpoint(TOKEN_YES)).toBe('0.555');
    expect(last(data).path).toBe('/midpoint');
    expect(queryOf(last(data))).toEqual({ token_id: TOKEN_YES });
  });

  test('a half tick keeps its 4th decimal and a one-sided book is "0.000"', async () => {
    const books: Record<string, FixtureBook> = {
      ...defaultBooks(),
      '500': {
        bids: [{ tick: 500, size: '1' }],
        asks: [{ tick: 501, size: '1' }],
      },
    };
    const { client } = rig({ data: { books } });
    expect(await client.getMidpoint('500')).toBe('0.5005');
    expect(await client.getMidpoint(TOKEN_NO)).toBe('0.000');
  });

  test('getMidpoints posts [{token_id}] to /midpoints, omitting unknown tokens', async () => {
    const { client, data } = rig();
    const mids = await client.getMidpoints([
      TOKEN_YES,
      TOKEN_UNKNOWN,
      TOKEN_NO,
    ]);
    expect(last(data).method).toBe('POST');
    expect(last(data).path).toBe('/midpoints');
    expect(last(data).body).toBe(
      JSON.stringify([
        { token_id: TOKEN_YES },
        { token_id: TOKEN_UNKNOWN },
        { token_id: TOKEN_NO },
      ]),
    );
    expect(mids).toEqual({ [TOKEN_YES]: '0.555', [TOKEN_NO]: '0.000' });
    expect(mids[TOKEN_UNKNOWN]).toBeUndefined();
  });

  test('getMidpoints sends canonical ids and keys the map by them', async () => {
    const { client, data } = rig();
    const mids = await client.getMidpoints([`0${TOKEN_YES}`]);
    expect(last(data).body).toBe(JSON.stringify([{ token_id: TOKEN_YES }]));
    expect(mids).toEqual({ [TOKEN_YES]: '0.555' });
  });

  test('getMidpoint on an unknown token is a 404 rejection', async () => {
    const { client } = rig();
    await expect(client.getMidpoint(TOKEN_UNKNOWN)).rejects.toSatisfy(
      rejectedWith(404),
    );
  });
});

describe('getPrice and getPrices', () => {
  test('getPrice reads GET /price?token_id=&side= (un-padded)', async () => {
    const { client, data } = rig();
    expect(await client.getPrice(TOKEN_YES, 'BUY')).toBe('0.55');
    expect(last(data).path).toBe('/price');
    expect(queryOf(last(data))).toEqual({ token_id: TOKEN_YES, side: 'BUY' });
    expect(await client.getPrice(TOKEN_YES, 'SELL')).toBe('0.56');
    expect(queryOf(last(data))).toEqual({ token_id: TOKEN_YES, side: 'SELL' });
    // An empty side is "0.000".
    expect(await client.getPrice(TOKEN_NO, 'SELL')).toBe('0.000');
  });

  test.each([
    ['lower case', 'buy'],
    ['BID', 'BID'],
    ['ASK', 'ASK'],
    ['unknown', 'HOLD'],
    ['empty', ''],
    ['a number', 1],
    ['undefined', undefined],
    ['null', null],
  ])('a side that is %s is refused before any request', async (_name, side) => {
    const { client, data } = rig();
    const message = await invalid(() =>
      client.getPrice(TOKEN_YES, side as 'BUY'),
    );
    expect(message).toMatch(/^side /);
    expect(data.calls).toEqual([]);
  });

  test('getPrices posts [{token_id, side}] to /prices and returns a map by token', async () => {
    const { client, data } = rig();
    const prices = await client.getPrices([
      { tokenId: TOKEN_YES, side: 'BUY' },
      { tokenId: TOKEN_YES, side: 'SELL' },
      { tokenId: TOKEN_NO, side: 'BUY' },
      { tokenId: TOKEN_UNKNOWN, side: 'BUY' },
    ]);
    expect(last(data).method).toBe('POST');
    expect(last(data).path).toBe('/prices');
    expect(last(data).body).toBe(
      JSON.stringify([
        { token_id: TOKEN_YES, side: 'BUY' },
        { token_id: TOKEN_YES, side: 'SELL' },
        { token_id: TOKEN_NO, side: 'BUY' },
        { token_id: TOKEN_UNKNOWN, side: 'BUY' },
      ]),
    );
    expect(prices).toEqual({
      [TOKEN_YES]: { BUY: '0.55', SELL: '0.56' },
      [TOKEN_NO]: { BUY: '0.44' },
    });
  });

  test('getPrices refuses an element with an unknown key before any request', async () => {
    const { client, data } = rig();
    for (const extra of ['address', 'maker', 'token_id', 'extra']) {
      const request = {
        tokenId: TOKEN_YES,
        side: 'BUY',
        [extra]: 'x',
      } as unknown as PriceRequest;
      const message = await invalid(() => client.getPrices([request]));
      expect(message).toContain(extra);
    }
    expect(data.calls).toEqual([]);
  });

  test('getPrices refuses a bad element, naming its index', async () => {
    const { client, data } = rig();
    expect(
      await invalid(() =>
        client.getPrices([
          { tokenId: TOKEN_YES, side: 'BUY' },
          { tokenId: 12, side: 'BUY' } as never,
        ]),
      ),
    ).toMatch(/^requests\[1\]\.tokenId /);
    expect(
      await invalid(() =>
        client.getPrices([{ tokenId: TOKEN_YES, side: 'sell' } as never]),
      ),
    ).toMatch(/^requests\[0\]\.side /);
    expect(await invalid(() => client.getPrices([null as never]))).toMatch(
      /^requests\[0\] /,
    );
    expect(await invalid(() => client.getPrices('BUY' as never))).toMatch(
      /^requests /,
    );
    expect(data.calls).toEqual([]);
  });
});

describe('getSpread and getSpreads', () => {
  test('getSpread reads GET /spread?token_id=', async () => {
    const { client, data } = rig();
    expect(await client.getSpread(TOKEN_YES)).toBe('0.01');
    expect(last(data).path).toBe('/spread');
    expect(queryOf(last(data))).toEqual({ token_id: TOKEN_YES });
    // A one-sided book has no spread: the gateway says "0".
    expect(await client.getSpread(TOKEN_NO)).toBe('0');
  });

  test('getSpreads posts [{token_id}] to /spreads, omitting tokens with no spread', async () => {
    const { client, data } = rig();
    const spreads = await client.getSpreads([
      TOKEN_YES,
      TOKEN_NO,
      TOKEN_UNKNOWN,
    ]);
    expect(last(data).method).toBe('POST');
    expect(last(data).path).toBe('/spreads');
    expect(last(data).body).toBe(
      JSON.stringify([
        { token_id: TOKEN_YES },
        { token_id: TOKEN_NO },
        { token_id: TOKEN_UNKNOWN },
      ]),
    );
    expect(spreads).toEqual({ [TOKEN_YES]: '0.01' });
  });
});

describe('getLastTradePrice and getLastTradePrices', () => {
  test('getLastTradePrice reads GET /last-trade-price?token_id=', async () => {
    const { client, data } = rig();
    expect(await client.getLastTradePrice(TOKEN_YES)).toEqual({
      price: '0.555',
      side: 'BUY',
    });
    expect(last(data).path).toBe('/last-trade-price');
    expect(queryOf(last(data))).toEqual({ token_id: TOKEN_YES });
  });

  test('a token with no trade answers the default, and an empty side is valid in strict mode', async () => {
    for (const strict of [false, true]) {
      const { client } = rig({ strict });
      expect(await client.getLastTradePrice(TOKEN_NO)).toEqual({
        price: '0.5',
        side: '',
      });
      expect(await client.getLastTradePrice(TOKEN_UNKNOWN)).toEqual({
        price: '0.5',
        side: '',
      });
      server.resetHandlers();
    }
  });

  test('getLastTradePrices posts [{token_id}] to /last-trades-prices', async () => {
    const { client, data } = rig();
    const trades = await client.getLastTradePrices([
      TOKEN_YES,
      TOKEN_NO,
      TOKEN_UNKNOWN,
    ]);
    expect(last(data).method).toBe('POST');
    expect(last(data).path).toBe('/last-trades-prices');
    expect(last(data).body).toBe(
      JSON.stringify([
        { token_id: TOKEN_YES },
        { token_id: TOKEN_NO },
        { token_id: TOKEN_UNKNOWN },
      ]),
    );
    // Tokens with no trade data are omitted.
    expect(trades).toEqual([
      { price: '0.555', side: 'BUY', token_id: TOKEN_YES },
    ]);
  });
});

describe('getPricesHistory', () => {
  test('reads GET /prices-history?token_id= and returns the points with padded prices', async () => {
    const { client, data } = rig();
    const history = await client.getPricesHistory({ tokenId: TOKEN_YES });
    expect(last(data).path).toBe('/prices-history');
    expect(queryOf(last(data))).toEqual({ token_id: TOKEN_YES });
    // Newest first, as the gateway sends them.
    expect(history).toEqual([
      { t: 1_800_000_120, p: '0.550' },
      { t: 1_800_000_060, p: '0.520' },
      { t: 1_800_000_000, p: '0.500' },
    ]);
  });

  test('limit is sent as the gateway query parameter fidelity', async () => {
    const { client, data } = rig();
    const history = await client.getPricesHistory({
      tokenId: TOKEN_YES,
      limit: 2,
    });
    expect(queryOf(last(data))).toEqual({ token_id: TOKEN_YES, fidelity: '2' });
    // The newest two points, newest first.
    expect(history.map((p) => p.p)).toEqual(['0.550', '0.520']);
    await client.getPricesHistory({ tokenId: TOKEN_YES, limit: 500 });
    expect(queryOf(last(data)).fidelity).toBe('500');
  });

  test('a token with no history is an empty list', async () => {
    const { client } = rig();
    expect(await client.getPricesHistory({ tokenId: TOKEN_NO })).toEqual([]);
  });

  test.each([
    ['zero', 0],
    ['501', 501],
    ['negative', -3],
    ['a fraction', 2.5],
    ['NaN', Number.NaN],
    ['a string', '10'],
    ['null', null],
  ])(
    'a limit that is %s is refused before any request',
    async (_name, limit) => {
      const { client, data } = rig();
      const message = await invalid(() =>
        client.getPricesHistory({ tokenId: TOKEN_YES, limit: limit as number }),
      );
      expect(message).toMatch(/^limit /);
      expect(data.calls).toEqual([]);
    },
  );

  test.each([
    ['fidelity', { fidelity: 10 }],
    ['interval', { interval: '1h' }],
    ['token_id', { token_id: TOKEN_YES }],
    ['maker', { maker: '0x0' }],
    ['address', { address: '0x0' }],
  ])(
    'an unknown option %s is refused before any request',
    async (key, extra) => {
      const { client, data } = rig();
      const message = await invalid(() =>
        client.getPricesHistory({ tokenId: TOKEN_YES, ...extra } as never),
      );
      expect(message).toContain(key);
      expect(data.calls).toEqual([]);
    },
  );

  test('a missing or bad token id, or options that are not an object, are refused', async () => {
    const { client, data } = rig();
    expect(await invalid(() => client.getPricesHistory({} as never))).toMatch(
      /^tokenId /,
    );
    expect(
      await invalid(() => client.getPricesHistory({ tokenId: 5 } as never)),
    ).toMatch(/^tokenId /);
    for (const options of [null, undefined, 'x', [TOKEN_YES]]) {
      await invalid(() => client.getPricesHistory(options as never));
    }
    expect(data.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ids are checked before any request
// ---------------------------------------------------------------------------

describe('token ids', () => {
  const SINGLE: Array<[string, (c: OrderbookClient, id: unknown) => unknown]> =
    [
      ['getTickSize', (c, id) => c.getTickSize(id as string)],
      ['getBook', (c, id) => c.getBook(id as string)],
      ['getMidpoint', (c, id) => c.getMidpoint(id as string)],
      ['getPrice', (c, id) => c.getPrice(id as string, 'BUY')],
      ['getSpread', (c, id) => c.getSpread(id as string)],
      ['getLastTradePrice', (c, id) => c.getLastTradePrice(id as string)],
      [
        'getPricesHistory',
        (c, id) => c.getPricesHistory({ tokenId: id as string }),
      ],
    ];

  describe.each(SINGLE)('%s', (_name, call) => {
    test.each(BAD_TOKEN_IDS)(
      'a token id that is %s is refused before any request',
      async (_label, id) => {
        const { client, data } = rig();
        const message = await invalid(() => call(client, id));
        expect(message).toMatch(/^tokenId /);
        expect(data.calls).toEqual([]);
      },
    );
  });

  const BATCH: Array<[string, (c: OrderbookClient, ids: unknown) => unknown]> =
    [
      ['getBooks', (c, ids) => c.getBooks(ids as string[])],
      ['getMidpoints', (c, ids) => c.getMidpoints(ids as string[])],
      ['getSpreads', (c, ids) => c.getSpreads(ids as string[])],
      ['getLastTradePrices', (c, ids) => c.getLastTradePrices(ids as string[])],
    ];

  describe.each(BATCH)('%s', (_name, call) => {
    test.each(BAD_TOKEN_IDS)(
      'an element that is %s is refused, naming its index, before any request',
      async (_label, id) => {
        const { client, data } = rig();
        const message = await invalid(() => call(client, [TOKEN_YES, id]));
        expect(message).toMatch(/^tokenIds\[1\] /);
        expect(data.calls).toEqual([]);
      },
    );

    test.each([
      ['a string', TOKEN_YES],
      ['null', null],
      ['an object', {}],
      ['undefined', undefined],
    ])(
      'a list that is %s is refused before any request',
      async (_label, ids) => {
        const { client, data } = rig();
        const message = await invalid(() => call(client, ids));
        expect(message).toMatch(/^tokenIds /);
        expect(data.calls).toEqual([]);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Behaviour shared by every public read
// ---------------------------------------------------------------------------

describe('every public read', () => {
  test.each(PUBLIC_CALLS)(
    '%s hits the expected route',
    async (_name, route, call) => {
      const { client, data } = rig();
      await call(client);
      expect(data.calls[0]).toBe(route);
    },
  );

  test('sends no credentials and never asks the auth provider', async () => {
    const provider: AuthProvider = {
      headers: vi.fn(async () => ({ XO_API_KEY: 'must-not-be-sent' })),
      onUnauthorized: vi.fn(async () => true),
    };
    const { client, data } = rig({ auth: provider });
    for (const [, , call] of PUBLIC_CALLS) {
      await call(client);
    }
    expect(data.requests.length).toBeGreaterThanOrEqual(PUBLIC_CALLS.length);
    for (const request of data.requests) {
      for (const header of [
        'authorization',
        'xo_api_key',
        'xo_signature',
        'xo_timestamp',
        'xo_passphrase',
        'xo_address',
      ]) {
        expect(request.headers.get(header)).toBeNull();
      }
      expect(request.headers.get('x-xo-sdk')).toBe('ts/9.9.9');
    }
    expect(provider.headers).not.toHaveBeenCalled();
    expect(provider.onUnauthorized).not.toHaveBeenCalled();
  });

  test('strict mode accepts everything the gateway emits', async () => {
    const { client } = rig({ strict: true });
    for (const [, , call] of PUBLIC_CALLS) {
      await call(client);
    }
  });

  test('never sends a maker or address parameter', async () => {
    const { client, data } = rig();
    for (const [, , call] of PUBLIC_CALLS) {
      await call(client);
    }
    for (const request of data.requests) {
      const keys = Object.keys(queryOf(request));
      expect(keys).not.toContain('maker');
      expect(keys).not.toContain('address');
      expect(request.body).not.toMatch(/maker|address/);
    }
  });
});

describe('retries', () => {
  test('a GET is retried on a 503 (the read default)', async () => {
    const { client, data } = rig({ maxRetries: 2 });
    const failing = failFirst(data, '/book');
    const book = await client.getBook(TOKEN_YES);
    expect(book.asset_id).toBe(TOKEN_YES);
    expect(failing.hits()).toBe(2);
  });

  test.each([
    ['getBooks', '/books', (c: OrderbookClient) => c.getBooks([TOKEN_YES])],
    [
      'getMidpoints',
      '/midpoints',
      (c: OrderbookClient) => c.getMidpoints([TOKEN_YES]),
    ],
    [
      'getPrices',
      '/prices',
      (c: OrderbookClient) =>
        c.getPrices([{ tokenId: TOKEN_YES, side: 'BUY' }]),
    ],
    [
      'getSpreads',
      '/spreads',
      (c: OrderbookClient) => c.getSpreads([TOKEN_YES]),
    ],
    [
      'getLastTradePrices',
      '/last-trades-prices',
      (c: OrderbookClient) => c.getLastTradePrices([TOKEN_YES]),
    ],
  ])('%s (a POST read) is retried on a 503', async (_name, route, call) => {
    const { client, data } = rig({ maxRetries: 2 });
    const failing = failFirst(data, route);
    await call(client);
    expect(failing.hits()).toBe(2);
    expect(data.requests.filter((r) => r.path === route)).toHaveLength(2);
  });

  test('the retry budget ends in a 5xx rejection-class failure', async () => {
    const { client, data } = rig({ maxRetries: 1 });
    const failing = failFirst(data, '/books', 10);
    await expect(client.getBooks([TOKEN_YES])).rejects.toMatchObject({
      status: 503,
    });
    expect(failing.hits()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

describe('response schemas', () => {
  test('strict mode refuses an extra top-level field, and lenient mode keeps it', async () => {
    const body = { ...BOOK_BODY, surprise: 'new' };

    const strict = rig({ strict: true });
    strict.data.override = () => HttpResponse.json(body);
    const error = await caught(() => strict.client.getBook(TOKEN_YES));
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).message).toContain('/book');
    expect((error as UnexpectedResponseError).message).toContain('surprise');
    server.resetHandlers();

    const lenient = rig();
    lenient.data.override = () => HttpResponse.json(body);
    const book = await lenient.client.getBook(TOKEN_YES);
    expect(book.hash).toBe('ab12');
    expect((book as unknown as Record<string, unknown>).surprise).toBe('new');
  });

  const MARKET_BODY = {
    condition_id: CONDITION_A,
    tokens: [{ token_id: TOKEN_YES, outcome: 'Yes', price: '0.5' }],
    minimum_tick_size: 0.001,
    neg_risk: false,
    active: true,
  };
  const CONVICTION_BODY = {
    condition_id: CONDITION_A,
    tokens: [{ token_id: TOKEN_YES, outcome: 'Yes', price: '0.5' }],
    active: true,
    variant: 'conviction',
    creator: '0xabc',
    commitment: { order_id: '1', status: 'resting', outcome: 'yes' },
  };

  test.each<
    [string, string, unknown, (c: OrderbookClient) => Promise<unknown>]
  >([
    [
      'a price level',
      '/book',
      { ...BOOK_BODY, bids: [{ price: '0.550', size: '1', age: 3 }] },
      (c) => c.getBook(TOKEN_YES),
    ],
    [
      'a market token',
      '/markets/{condition_id}',
      {
        ...MARKET_BODY,
        tokens: [
          { token_id: TOKEN_YES, outcome: 'Yes', price: '0.5', volume: '9' },
        ],
      },
      (c) => c.getMarket(CONDITION_A),
    ],
    [
      'a conviction market token',
      '/conviction/markets/{condition_id}',
      {
        ...CONVICTION_BODY,
        tokens: [
          { token_id: TOKEN_YES, outcome: 'Yes', price: '0.5', volume: '9' },
        ],
      },
      (c) => c.getConvictionMarket(CONDITION_A),
    ],
    [
      'a commitment',
      '/conviction/markets/{condition_id}',
      {
        ...CONVICTION_BODY,
        commitment: {
          order_id: '1',
          status: 'resting',
          outcome: 'yes',
          nonce: 3,
        },
      },
      (c) => c.getConvictionMarket(CONDITION_A),
    ],
    [
      'a price point',
      '/prices-history',
      { history: [{ t: 1, p: '0.5', v: 1 }] },
      (c) => c.getPricesHistory({ tokenId: TOKEN_YES }),
    ],
  ])(
    'strict mode refuses an extra field inside %s, lenient mode keeps it',
    async (_name, route, body, call) => {
      const strict = rig({ strict: true });
      strict.data.override = (path) =>
        path === route ? HttpResponse.json(body as never) : undefined;
      await expect(call(strict.client)).rejects.toBeInstanceOf(
        UnexpectedResponseError,
      );
      server.resetHandlers();

      const lenient = rig();
      lenient.data.override = (path) =>
        path === route ? HttpResponse.json(body as never) : undefined;
      await expect(call(lenient.client)).resolves.toBeDefined();
    },
  );

  test('strict mode refuses an extra field on a page and on its markets, lenient keeps both', async () => {
    const page = {
      limit: 100,
      count: 1,
      next_cursor: 'LTE=',
      extra_page: true,
      data: [
        {
          condition_id: CONDITION_A,
          tokens: [],
          minimum_tick_size: 0.001,
          neg_risk: false,
          active: true,
          extra_market: 1,
        },
      ],
    };
    const strict = rig({ strict: true });
    strict.data.override = () => HttpResponse.json(page);
    await expect(strict.client.getMarkets().toArray()).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
    server.resetHandlers();

    const lenient = rig();
    lenient.data.override = () => HttpResponse.json(page);
    const [market] = await lenient.client.getMarkets().toArray();
    expect((market as unknown as Record<string, unknown>).extra_market).toBe(1);
  });

  test('strict mode refuses an extra field in each batch and price response', async () => {
    const cases: Array<
      [string, unknown, (c: OrderbookClient) => Promise<unknown>]
    > = [
      ['/books', [{ ...BOOK_BODY, extra: 1 }], (c) => c.getBooks([TOKEN_YES])],
      ['/midpoint', { mid: '0.5', extra: 1 }, (c) => c.getMidpoint(TOKEN_YES)],
      [
        '/price',
        { price: '0.5', extra: 1 },
        (c) => c.getPrice(TOKEN_YES, 'BUY'),
      ],
      [
        '/prices',
        { [TOKEN_YES]: { BUY: '0.5', extra: '1' } },
        (c) => c.getPrices([{ tokenId: TOKEN_YES, side: 'BUY' }]),
      ],
      ['/spread', { spread: '0.01', extra: 1 }, (c) => c.getSpread(TOKEN_YES)],
      [
        '/last-trade-price',
        { price: '0.5', side: 'BUY', extra: 1 },
        (c) => c.getLastTradePrice(TOKEN_YES),
      ],
      [
        '/last-trades-prices',
        [{ price: '0.5', side: 'BUY', token_id: TOKEN_YES, extra: 1 }],
        (c) => c.getLastTradePrices([TOKEN_YES]),
      ],
      [
        '/prices-history',
        { history: [{ t: 1, p: '0.5', extra: 1 }] },
        (c) => c.getPricesHistory({ tokenId: TOKEN_YES }),
      ],
      [
        '/prices-history',
        { history: [], extra: 1 },
        (c) => c.getPricesHistory({ tokenId: TOKEN_YES }),
      ],
      [
        '/tick-size',
        { minimum_tick_size: 0.001, extra: 1 },
        (c) => c.getTickSize(TOKEN_YES),
      ],
      [
        '/trading-state',
        { state: 'active', extra: 1 },
        (c) => c.getTradingState(),
      ],
    ];
    for (const [route, body, call] of cases) {
      const strict = rig({ strict: true });
      strict.data.override = (path) =>
        path === route ? HttpResponse.json(body as never) : undefined;
      await expect(call(strict.client), route).rejects.toBeInstanceOf(
        UnexpectedResponseError,
      );
      server.resetHandlers();

      // The same body is fine in lenient mode.
      const lenient = rig();
      lenient.data.override = (path) =>
        path === route ? HttpResponse.json(body as never) : undefined;
      await call(lenient.client);
      server.resetHandlers();
    }
  });

  test('a missing or wrong-typed field is refused in lenient mode too', async () => {
    const cases: Array<
      [string, unknown, (c: OrderbookClient) => Promise<unknown>]
    > = [
      [
        '/book',
        { ...BOOK_BODY, last_update_id: '42' },
        (c) => c.getBook(TOKEN_YES),
      ],
      ['/book', { ...BOOK_BODY, neg_risk: 'no' }, (c) => c.getBook(TOKEN_YES)],
      [
        '/book',
        { ...BOOK_BODY, bids: [{ price: 0.55, size: '1' }] },
        (c) => c.getBook(TOKEN_YES),
      ],
      ['/book', { ...BOOK_BODY, asks: null }, (c) => c.getBook(TOKEN_YES)],
      ['/midpoint', { mid: 0.5 }, (c) => c.getMidpoint(TOKEN_YES)],
      ['/price', {}, (c) => c.getPrice(TOKEN_YES, 'BUY')],
      ['/spread', { spread: 1 }, (c) => c.getSpread(TOKEN_YES)],
      [
        '/last-trade-price',
        { price: '0.5' },
        (c) => c.getLastTradePrice(TOKEN_YES),
      ],
      [
        '/last-trade-price',
        { side: 'BUY' },
        (c) => c.getLastTradePrice(TOKEN_YES),
      ],
      ['/midpoints', [], (c) => c.getMidpoints([TOKEN_YES])],
      ['/midpoints', { [TOKEN_YES]: 0.5 }, (c) => c.getMidpoints([TOKEN_YES])],
      [
        '/prices',
        { [TOKEN_YES]: { BUY: 5 } },
        (c) => c.getPrices([{ tokenId: TOKEN_YES, side: 'BUY' }]),
      ],
      ['/books', { not: 'a list' }, (c) => c.getBooks([TOKEN_YES])],
      [
        '/last-trades-prices',
        [{ price: '0.5', side: 'BUY' }],
        (c) => c.getLastTradePrices([TOKEN_YES]),
      ],
      [
        '/prices-history',
        { history: [{ t: '1', p: '0.5' }] },
        (c) => c.getPricesHistory({ tokenId: TOKEN_YES }),
      ],
      [
        '/prices-history',
        {},
        (c) => c.getPricesHistory({ tokenId: TOKEN_YES }),
      ],
      [
        '/markets',
        { limit: 1, count: 1, data: [] },
        (c) => c.getMarkets().toArray(),
      ],
      [
        '/markets',
        { limit: 1, count: 1, next_cursor: 5, data: [] },
        (c) => c.getMarkets().toArray(),
      ],
      [
        '/markets/{condition_id}',
        { condition_id: CONDITION_A },
        (c) => c.getMarket(CONDITION_A),
      ],
      [
        '/conviction/markets/{condition_id}',
        { condition_id: CONDITION_A, tokens: [], active: true },
        (c) => c.getConvictionMarket(CONDITION_A),
      ],
    ];
    for (const [route, body, call] of cases) {
      const { client, data } = rig();
      data.override = (path) =>
        path === route ? HttpResponse.json(body as never) : undefined;
      await expect(
        call(client),
        `${route} ${JSON.stringify(body)}`,
      ).rejects.toBeInstanceOf(UnexpectedResponseError);
      server.resetHandlers();
    }
  });

  test('a response that is not JSON is an UnexpectedResponseError', async () => {
    const { client, data } = rig();
    data.override = () =>
      new Response('<html>', { headers: { 'content-type': 'text/html' } });
    await expect(client.getBook(TOKEN_YES)).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });

  test('the price and size strings are never turned into numbers', async () => {
    const { client, data } = rig();
    data.override = (route) =>
      route === '/book'
        ? HttpResponse.json({
            ...BOOK_BODY,
            bids: [{ price: '0.550', size: '100.000000' }],
            asks: [{ price: '0.5000', size: '0010' }],
            min_order_size: '5.0',
            last_trade_price: '0.500',
          })
        : undefined;
    const book = await client.getBook(TOKEN_YES);
    expect(book.bids[0]).toEqual({ price: '0.550', size: '100.000000' });
    expect(book.asks[0]).toEqual({ price: '0.5000', size: '0010' });
    expect(book.min_order_size).toBe('5.0');
    expect(book.last_trade_price).toBe('0.500');
  });
});

describe('constructor', () => {
  test('needs only a transport and an environment', () => {
    const transport = new Transport({ env, version: '1.0.0' });
    expect(() => new OrderbookClient({ transport, env })).not.toThrow();
  });
});
