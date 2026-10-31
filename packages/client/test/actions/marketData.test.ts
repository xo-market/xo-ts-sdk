import { setupServer } from 'msw/node';
import { getAddress } from 'viem';
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
  FetchMarketCapacityError,
  fetchConvictionMarket,
  fetchLastTradePrice,
  fetchLastTradePrices,
  fetchMarketCapacity,
  fetchMidpoint,
  fetchMidpoints,
  fetchOrderBook,
  fetchOrderBooks,
  fetchPrice,
  fetchPrices,
  fetchSpread,
  fetchSpreads,
  fetchTradingState,
  listPriceHistory,
  listTrades,
} from '../../src/actions/marketData';
import type { ActionContext } from '../../src/clients/context';
import {
  RequestAbortedError,
  RequestRejectedError,
  SigningError,
  UserInputError,
  XoError,
} from '../../src/core/errors';
import type { RequestOptions } from '../../src/core/requestOptions';
import { OrderSide } from '../../src/models/enums';
import type { OrderbookClient } from '../../src/orderbook/client';
import { actionRig, NOW_MS, noTokenOf, yesTokenOf } from '../helpers/actionRig';
import { caught } from '../helpers/dataRig';
import { conditionIdOf } from '../helpers/mockBackendData';
import {
  CONDITION_A,
  TOKEN_NO,
  TOKEN_UNKNOWN,
  TOKEN_YES,
} from '../helpers/mockMarketData';
import { wireStyleKeys } from '../helpers/modelKeys';
import { rejectedWith } from '../helpers/rejections';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

type Rig = ReturnType<typeof actionRig>;

/** The "METHOD /path" of every request the order book fake saw, in order. */
const bookCalls = (r: Rig): string[] => r.orderbook.calls;

/** The query of the last request the order book fake saw, as an object. */
const lastQuery = (r: Rig): Record<string, string> =>
  Object.fromEntries(
    new URLSearchParams(r.orderbook.requests.at(-1)?.search ?? ''),
  );

/** A cursor as a list gives it out, made by hand. */
function cursorOf(
  list: string,
  kind: 'cursor' | 'page',
  value: string | number,
): string {
  return Buffer.from(JSON.stringify({ v: 1, list, kind, value }))
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

const NOW_SEC = Math.floor(NOW_MS / 1000);

// ---------------------------------------------------------------------------
// fetchOrderBook, fetchOrderBooks
// ---------------------------------------------------------------------------

describe('fetchOrderBook', () => {
  test('reads a book as a camelCase model, best level last, with no credentials', async () => {
    const r = actionRig(server);
    const book = await fetchOrderBook(r.ctx, { assetId: TOKEN_YES });
    expect(bookCalls(r)).toEqual(['GET /book']);
    expect(lastQuery(r)).toEqual({ token_id: TOKEN_YES });
    expect(r.orderbook.requests[0]?.headers.get('authorization')).toBeNull();
    expect(book).toEqual({
      assetId: TOKEN_YES,
      market: CONDITION_A,
      bids: [
        { price: '0.540', size: '25.5' },
        { price: '0.550', size: '100' },
      ],
      asks: [
        { price: '0.570', size: '10' },
        { price: '0.560', size: '80.123456' },
      ],
      minimumTickSize: '0.001',
      minimumOrderSize: '1',
      negRisk: false,
      timestamp: 1_800_000_123_456,
      hash: 'ab12cd34',
    });
    expect(wireStyleKeys(book)).toEqual([]);
  });

  test('a token the order book does not know is a 404', async () => {
    const r = actionRig(server);
    const error = await caught(() =>
      fetchOrderBook(r.ctx, { assetId: TOKEN_UNKNOWN }),
    );
    expect(error).toSatisfy(rejectedWith(404));
  });

  test.each([
    ['no request', undefined],
    ['no assetId', {}],
    ['an assetId that is a number', { assetId: 4660 }],
    ['an assetId that is hex', { assetId: '0x1234' }],
    ['an empty assetId', { assetId: '' }],
    ['an assetId of 79 digits', { assetId: '1'.repeat(79) }],
    ['an assetId above 2^256', { assetId: (2n ** 256n).toString() }],
    ['an unknown key', { assetId: TOKEN_YES, tokenId: TOKEN_YES }],
  ])('%s is invalid_input, before any request', async (_name, request) => {
    const r = actionRig(server);
    const error = await caught(() => fetchOrderBook(r.ctx, request as never));
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).code).toBe('invalid_input');
    expect((error as UserInputError).message).toMatch(/^fetchOrderBook: /);
    expect(r.orderbook.requests).toEqual([]);
  });
});

describe('fetchOrderBooks', () => {
  test('reads the books in the order asked, with one POST', async () => {
    const r = actionRig(server);
    const books = await fetchOrderBooks(r.ctx, {
      assetIds: [TOKEN_NO, TOKEN_YES],
    });
    expect(bookCalls(r)).toEqual(['POST /books']);
    expect(JSON.parse(r.orderbook.requests[0]?.body ?? '')).toEqual([
      { token_id: TOKEN_NO },
      { token_id: TOKEN_YES },
    ]);
    expect(books.map((book) => book.assetId)).toEqual([TOKEN_NO, TOKEN_YES]);
    // The same model as the single read.
    expect(books[1]).toEqual(
      await fetchOrderBook(r.ctx, { assetId: TOKEN_YES }),
    );
  });

  test('a token the order book does not know is a 404', async () => {
    const r = actionRig(server);
    const error = await caught(() =>
      fetchOrderBooks(r.ctx, { assetIds: [TOKEN_YES, TOKEN_UNKNOWN] }),
    );
    expect(error).toSatisfy(rejectedWith(404));
  });

  test.each([
    ['no request', undefined],
    ['no assetIds', {}],
    ['an empty list', { assetIds: [] }],
    ['assetIds that is a string', { assetIds: TOKEN_YES }],
    ['a bad id in the list', { assetIds: [TOKEN_YES, '0xabc'] }],
    ['a list with a hole', { assetIds: [TOKEN_YES, undefined] }],
    ['an unknown key', { assetIds: [TOKEN_YES], assetId: TOKEN_YES }],
  ])('%s is invalid_input, before any request', async (_name, request) => {
    const r = actionRig(server);
    const error = await caught(() => fetchOrderBooks(r.ctx, request as never));
    expect((error as UserInputError).code).toBe('invalid_input');
    expect((error as UserInputError).message).toMatch(/^fetchOrderBooks: /);
    expect(r.orderbook.requests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Midpoint, price, spread, last trade
// ---------------------------------------------------------------------------

describe('fetchMidpoint, fetchMidpoints', () => {
  test('the midpoint of a token is a decimal string; null when a side of the book is empty', async () => {
    const r = actionRig(server);
    expect(await fetchMidpoint(r.ctx, { assetId: TOKEN_YES })).toBe('0.555');
    expect(await fetchMidpoint(r.ctx, { assetId: TOKEN_NO })).toBeNull();
    expect(bookCalls(r)).toEqual(['GET /midpoint', 'GET /midpoint']);
    expect(
      await caught(() => fetchMidpoint(r.ctx, { assetId: TOKEN_UNKNOWN })),
    ).toSatisfy(rejectedWith(404));
  });

  test('the midpoints have an entry for every token asked, null where there is no midpoint', async () => {
    const r = actionRig(server);
    const midpoints = await fetchMidpoints(r.ctx, {
      assetIds: [TOKEN_YES, TOKEN_UNKNOWN, TOKEN_NO],
    });
    expect(midpoints).toEqual({
      [TOKEN_YES]: '0.555',
      [TOKEN_UNKNOWN]: null,
      [TOKEN_NO]: null,
    });
    expect(bookCalls(r)).toEqual(['POST /midpoints']);
  });

  test('a token asked with leading zeros has its entry under the token id', async () => {
    const r = actionRig(server);
    expect(
      await fetchMidpoints(r.ctx, { assetIds: [`0${TOKEN_YES}`] }),
    ).toEqual({ [TOKEN_YES]: '0.555' });
  });

  test('the singular and the plural agree on every token', async () => {
    const r = actionRig(server);
    const midpoints = await fetchMidpoints(r.ctx, {
      assetIds: [TOKEN_YES, TOKEN_NO],
    });
    for (const assetId of [TOKEN_YES, TOKEN_NO]) {
      expect(midpoints[assetId]).toBe(await fetchMidpoint(r.ctx, { assetId }));
    }
  });

  test('bad requests are invalid_input', async () => {
    const r = actionRig(server);
    for (const run of [
      () => fetchMidpoint(r.ctx, { assetId: 5 } as never),
      () => fetchMidpoints(r.ctx, { assetIds: [] } as never),
    ]) {
      expect(((await caught(run)) as UserInputError).code).toBe(
        'invalid_input',
      );
    }
    expect(r.orderbook.requests).toEqual([]);
  });
});

describe('fetchPrice, fetchPrices', () => {
  test('the price of a side: the best bid for BUY, the best ask for SELL', async () => {
    const r = actionRig(server);
    expect(
      await fetchPrice(r.ctx, { assetId: TOKEN_YES, side: OrderSide.BUY }),
    ).toBe('0.55');
    expect(lastQuery(r)).toEqual({ token_id: TOKEN_YES, side: 'BUY' });
    // The side may also be written as its text.
    expect(await fetchPrice(r.ctx, { assetId: TOKEN_YES, side: 'SELL' })).toBe(
      '0.56',
    );
    expect(lastQuery(r)).toEqual({ token_id: TOKEN_YES, side: 'SELL' });
  });

  test('the price of an empty side is null', async () => {
    const r = actionRig(server);
    expect(
      await fetchPrice(r.ctx, { assetId: TOKEN_NO, side: OrderSide.SELL }),
    ).toBeNull();
    expect(
      await fetchPrice(r.ctx, { assetId: TOKEN_NO, side: OrderSide.BUY }),
    ).toBe('0.44');
  });

  test('the prices have an entry for every token and side asked, null where there is no price', async () => {
    const r = actionRig(server);
    const prices = await fetchPrices(r.ctx, {
      requests: [
        { assetId: TOKEN_YES, side: OrderSide.BUY },
        { assetId: TOKEN_YES, side: OrderSide.SELL },
        { assetId: TOKEN_UNKNOWN, side: OrderSide.BUY },
        { assetId: TOKEN_NO, side: OrderSide.BUY },
        { assetId: TOKEN_NO, side: OrderSide.SELL },
      ],
    });
    expect(prices).toEqual({
      [TOKEN_YES]: { BUY: '0.55', SELL: '0.56' },
      [TOKEN_UNKNOWN]: { BUY: null },
      [TOKEN_NO]: { BUY: '0.44', SELL: null },
    });
    expect(JSON.parse(r.orderbook.requests[0]?.body ?? '')).toEqual([
      { token_id: TOKEN_YES, side: 'BUY' },
      { token_id: TOKEN_YES, side: 'SELL' },
      { token_id: TOKEN_UNKNOWN, side: 'BUY' },
      { token_id: TOKEN_NO, side: 'BUY' },
      { token_id: TOKEN_NO, side: 'SELL' },
    ]);
  });

  test('a side that was not asked for is not in the entry', async () => {
    const r = actionRig(server);
    const prices = await fetchPrices(r.ctx, {
      requests: [{ assetId: TOKEN_NO, side: OrderSide.SELL }],
    });
    expect(prices).toEqual({ [TOKEN_NO]: { SELL: null } });
    expect(Object.keys(prices[TOKEN_NO] ?? {})).toEqual(['SELL']);
  });

  test.each([
    ['no side', () => ({ assetId: TOKEN_YES })],
    ['a side that is not one', () => ({ assetId: TOKEN_YES, side: 'HOLD' })],
    ['a lower-case side', () => ({ assetId: TOKEN_YES, side: 'buy' })],
  ])('fetchPrice with %s is invalid_input', async (_name, request) => {
    const r = actionRig(server);
    const error = await caught(() => fetchPrice(r.ctx, request() as never));
    expect((error as UserInputError).code).toBe('invalid_input');
    expect((error as UserInputError).message).toMatch(/^fetchPrice: side /);
    expect(r.orderbook.requests).toEqual([]);
  });

  test.each([
    ['an empty list', { requests: [] }],
    ['requests that is not a list', { requests: { assetId: TOKEN_YES } }],
    ['an element without a side', { requests: [{ assetId: TOKEN_YES }] }],
    [
      'an element with an unknown key',
      { requests: [{ assetId: TOKEN_YES, side: 'BUY', extra: 1 }] },
    ],
  ])('fetchPrices with %s is invalid_input', async (_name, request) => {
    const r = actionRig(server);
    const error = await caught(() => fetchPrices(r.ctx, request as never));
    expect((error as UserInputError).code).toBe('invalid_input');
    expect(r.orderbook.requests).toEqual([]);
  });
});

describe('fetchSpread, fetchSpreads', () => {
  test('the spread is the gap between the best ask and the best bid', async () => {
    const r = actionRig(server);
    expect(await fetchSpread(r.ctx, { assetId: TOKEN_YES })).toBe('0.01');
    expect(bookCalls(r)).toEqual(['GET /spread']);
    expect(
      await caught(() => fetchSpread(r.ctx, { assetId: TOKEN_UNKNOWN })),
    ).toSatisfy(rejectedWith(404));
  });

  test('the spread of a book with an empty side is null', async () => {
    const r = actionRig(server);
    expect(await fetchSpread(r.ctx, { assetId: TOKEN_NO })).toBeNull();
    // The order book prints 0 for it: the list of spreads tells it from a real 0.
    expect(bookCalls(r)).toEqual(['GET /spread', 'POST /spreads']);
    expect(JSON.parse(r.orderbook.requests[1]?.body ?? '')).toEqual([
      { token_id: TOKEN_NO },
    ]);
  });

  test('the options reach both requests when the spread needs the second one', async () => {
    const r = actionRig(server);
    const spy = vi.spyOn(r.transport, 'request');
    const { signal } = new AbortController();

    const spread = await fetchSpread(
      r.ctx,
      { assetId: TOKEN_NO },
      { signal, timeout: 1234, retries: 1 },
    );

    expect(spread).toBeNull();
    expect(bookCalls(r)).toEqual(['GET /spread', 'POST /spreads']);
    expect(spy.mock.calls.map(([request]) => request.call)).toEqual([
      { signal, timeoutMs: 1234, retries: 1 },
      { signal, timeoutMs: 1234, retries: 1 },
    ]);
  });

  test('a book whose best bid meets its best ask has a spread of 0', async () => {
    const r = actionRig(server);
    const book = r.orderbook.books.get(TOKEN_NO);
    if (book === undefined) {
      throw new Error('fixture');
    }
    book.asks = [{ tick: 440, size: '1' }];
    expect(await fetchSpread(r.ctx, { assetId: TOKEN_NO })).toBe('0');
    expect(await fetchSpreads(r.ctx, { assetIds: [TOKEN_NO] })).toEqual({
      [TOKEN_NO]: '0',
    });
  });

  test('the spreads have an entry for every token asked, null where there is no spread', async () => {
    const r = actionRig(server);
    const spreads = await fetchSpreads(r.ctx, {
      assetIds: [TOKEN_YES, TOKEN_NO, TOKEN_UNKNOWN],
    });
    expect(spreads).toEqual({
      [TOKEN_YES]: '0.01',
      [TOKEN_NO]: null,
      [TOKEN_UNKNOWN]: null,
    });
    expect(bookCalls(r)).toEqual(['POST /spreads']);
  });

  test('the singular and the plural agree on every token', async () => {
    const r = actionRig(server);
    const spreads = await fetchSpreads(r.ctx, {
      assetIds: [TOKEN_YES, TOKEN_NO],
    });
    for (const assetId of [TOKEN_YES, TOKEN_NO]) {
      expect(spreads[assetId]).toBe(await fetchSpread(r.ctx, { assetId }));
    }
  });
});

describe('fetchLastTradePrice, fetchLastTradePrices', () => {
  test('the last trade is a price and the taker side; null when the token has not traded', async () => {
    const r = actionRig(server);
    expect(await fetchLastTradePrice(r.ctx, { assetId: TOKEN_YES })).toEqual({
      price: '0.555',
      side: OrderSide.BUY,
    });
    expect(await fetchLastTradePrice(r.ctx, { assetId: TOKEN_NO })).toBeNull();
  });

  test('the last trades are a list by token, and a token without a trade is left out', async () => {
    const r = actionRig(server);
    expect(
      await fetchLastTradePrices(r.ctx, { assetIds: [TOKEN_NO, TOKEN_YES] }),
    ).toEqual([{ assetId: TOKEN_YES, price: '0.555', side: OrderSide.BUY }]);
  });

  test('a trade the SELL taker made reads as SELL', async () => {
    const r = actionRig(server);
    const book = r.orderbook.books.get(TOKEN_YES);
    if (book === undefined) {
      throw new Error('fixture');
    }
    book.last = { tick: 540, side: 'SELL' };
    expect(await fetchLastTradePrice(r.ctx, { assetId: TOKEN_YES })).toEqual({
      price: '0.54',
      side: OrderSide.SELL,
    });
  });
});

// ---------------------------------------------------------------------------
// listPriceHistory
// ---------------------------------------------------------------------------

describe('listPriceHistory', () => {
  test('is one page, oldest point first, with no more to read', async () => {
    const r = actionRig(server);
    const history = listPriceHistory(r.ctx, {
      assetId: TOKEN_YES,
      interval: 'max',
    });
    expect(r.orderbook.requests).toEqual([]);
    const page = await history.firstPage();
    expect(page).toEqual({
      items: [
        { timestamp: 1_800_000_000_000, price: '0.500' },
        { timestamp: 1_800_000_060_000, price: '0.520' },
        { timestamp: 1_800_000_120_000, price: '0.550' },
      ],
      hasMore: false,
    });
    expect(bookCalls(r)).toEqual(['GET /prices-history']);
    expect(lastQuery(r)).toEqual({ token_id: TOKEN_YES });
    const pages = [];
    for await (const each of history) {
      pages.push(each);
    }
    expect(pages).toEqual([page]);
  });

  test('fidelity is the most points to read, newest first from the order book', async () => {
    const r = actionRig(server);
    const page = await listPriceHistory(r.ctx, {
      assetId: TOKEN_YES,
      interval: 'max',
      fidelity: 2,
    }).firstPage();
    expect(lastQuery(r)).toEqual({ token_id: TOKEN_YES, fidelity: '2' });
    expect(page.items.map((point) => point.price)).toEqual(['0.520', '0.550']);
  });

  test('startTs and endTs, in unix seconds, bound the points', async () => {
    const r = actionRig(server);
    const read = async (window: { startTs?: number; endTs?: number }) =>
      (
        await listPriceHistory(r.ctx, {
          assetId: TOKEN_YES,
          interval: 'max',
          ...window,
        }).firstPage()
      ).items.map((point) => point.price);
    expect(await read({ endTs: 1_800_000_060 })).toEqual(['0.500', '0.520']);
    expect(await read({ startTs: 1_800_000_060 })).toEqual(['0.520', '0.550']);
    expect(
      await read({ startTs: 1_800_000_030, endTs: 1_800_000_090 }),
    ).toEqual(['0.520']);
    expect(await read({ startTs: 1_900_000_000 })).toEqual([]);
  });

  test('the interval is the window before endTs, which is now by default', async () => {
    const r = actionRig(server);
    const book = r.orderbook.books.get(TOKEN_YES);
    if (book === undefined) {
      throw new Error('fixture');
    }
    book.history = [
      [NOW_SEC - 90_000, 400],
      [NOW_SEC - 7_200, 500],
      [NOW_SEC - 4_000, 510],
      [NOW_SEC - 1_800, 520],
      [NOW_SEC - 10, 550],
    ];
    const prices = async (
      interval: '1h' | '6h' | '1d' | '1w' | 'max',
      endTs?: number,
    ) =>
      (
        await listPriceHistory(r.ctx, {
          assetId: TOKEN_YES,
          interval,
          ...(endTs === undefined ? {} : { endTs }),
        }).firstPage()
      ).items.map((point) => point.price);
    expect(await prices('1h')).toEqual(['0.520', '0.550']);
    expect(await prices('6h')).toEqual(['0.500', '0.510', '0.520', '0.550']);
    expect(await prices('1d')).toEqual(['0.500', '0.510', '0.520', '0.550']);
    expect(await prices('1w')).toEqual([
      '0.400',
      '0.500',
      '0.510',
      '0.520',
      '0.550',
    ]);
    expect(await prices('max')).toEqual([
      '0.400',
      '0.500',
      '0.510',
      '0.520',
      '0.550',
    ]);
    // With endTs the window ends there and reaches back from there.
    expect(await prices('1h', NOW_SEC - 1_000)).toEqual(['0.510', '0.520']);
    expect(await prices('1h', NOW_SEC - 3_000)).toEqual(['0.510']);
    expect(await prices('1h', NOW_SEC - 20_000)).toEqual([]);
  });

  test('a token the order book does not know has no points', async () => {
    const r = actionRig(server);
    const page = await listPriceHistory(r.ctx, {
      assetId: TOKEN_UNKNOWN,
      interval: 'max',
    }).firstPage();
    expect(page).toEqual({ items: [], hasMore: false });
  });

  test.each([
    ['no interval', { assetId: TOKEN_YES }],
    ['an interval that is not one', { assetId: TOKEN_YES, interval: '1m' }],
    ['no assetId', { interval: '1d' }],
    ['a fidelity of 0', { assetId: TOKEN_YES, interval: '1d', fidelity: 0 }],
    [
      'a fidelity above 500',
      { assetId: TOKEN_YES, interval: '1d', fidelity: 501 },
    ],
    [
      'a startTs after endTs',
      { assetId: TOKEN_YES, interval: 'max', startTs: 20, endTs: 10 },
    ],
    [
      'a startTs in milliseconds as text',
      { assetId: TOKEN_YES, interval: 'max', startTs: '10' },
    ],
    [
      'a negative startTs',
      { assetId: TOKEN_YES, interval: 'max', startTs: -1 },
    ],
    ['a fractional endTs', { assetId: TOKEN_YES, interval: 'max', endTs: 1.5 }],
    ['an unknown key', { assetId: TOKEN_YES, interval: '1d', cursor: 'x' }],
  ])('%s is invalid_input, at once', (_name, request) => {
    const r = actionRig(server);
    let error: unknown;
    try {
      listPriceHistory(r.ctx, request as never);
    } catch (e) {
      error = e;
    }
    expect((error as UserInputError).code).toBe('invalid_input');
    expect((error as UserInputError).message).toMatch(/^listPriceHistory: /);
    expect(r.orderbook.requests).toEqual([]);
  });

  test('a cursor is refused: the list has one page', async () => {
    const r = actionRig(server);
    const history = listPriceHistory(r.ctx, {
      assetId: TOKEN_YES,
      interval: 'max',
    });
    expect(() => history.from('nonsense')).toThrow(UserInputError);
    for (const forged of [
      cursorOf('priceHistory', 'page', 2),
      cursorOf('priceHistory', 'cursor', 'x'),
    ]) {
      const error = await caught(() => history.from(forged).firstPage());
      expect((error as UserInputError).code).toBe('invalid_cursor');
    }
    expect(r.orderbook.requests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchTradingState, fetchConvictionMarket, fetchMarketCapacity
// ---------------------------------------------------------------------------

describe('fetchTradingState', () => {
  test('is active or paused, for the whole venue', async () => {
    const r = actionRig(server);
    expect(await fetchTradingState(r.ctx)).toBe('active');
    r.orderbook.paused = true;
    expect(await fetchTradingState(r.ctx)).toBe('paused');
    expect(bookCalls(r)).toEqual(['GET /trading-state', 'GET /trading-state']);
  });

  test('takes options only', async () => {
    const r = actionRig(server);
    const error = await caught(() => fetchTradingState(r.ctx, { retries: 9 }));
    expect((error as UserInputError).code).toBe('invalid_request_options');
    expect(r.orderbook.requests).toEqual([]);
  });
});

describe('fetchConvictionMarket', () => {
  test('a market without a conviction commitment has no creator and no commitment', async () => {
    const r = actionRig(server);
    const market = await fetchConvictionMarket(r.ctx, {
      conditionId: conditionIdOf(1),
    });
    expect(bookCalls(r)).toEqual([
      `GET /conviction/markets/${conditionIdOf(1)}`,
    ]);
    expect(market).toEqual({
      conditionId: conditionIdOf(1),
      active: true,
      variant: 'clob',
      creator: null,
      commitment: null,
      outcomes: {
        yes: { tokenId: yesTokenOf(1), price: null },
        no: { tokenId: noTokenOf(1), price: null },
      },
    });
    expect(wireStyleKeys(market)).toEqual([]);
  });

  test('a conviction market carries its creator and the creator commitment', async () => {
    const r = actionRig(server);
    const first = r.orderbook.markets[0];
    if (first === undefined) {
      throw new Error('fixture');
    }
    r.orderbook.markets[0] = {
      ...first,
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
    };
    const market = await fetchConvictionMarket(r.ctx, {
      conditionId: conditionIdOf(1).toUpperCase().replace('0X', '0x'),
    });
    expect(market).toMatchObject({
      variant: 'conviction',
      creator: getAddress(`0x${'c0'.repeat(20)}`),
      commitment: {
        orderId: '77',
        status: 'resting',
        outcome: 'yes',
        side: OrderSide.BUY,
        price: '0.700',
        size: '50',
        remaining: '50',
      },
    });
    expect(wireStyleKeys(market)).toEqual([]);
  });

  test('an unknown market is a 404; a bad condition id is invalid_input', async () => {
    const r = actionRig(server);
    expect(
      await caught(() =>
        fetchConvictionMarket(r.ctx, { conditionId: `0x${'ee'.repeat(32)}` }),
      ),
    ).toSatisfy(rejectedWith(404));
    const calls = r.orderbook.calls.length;
    for (const request of [{}, { conditionId: '0x12' }, { conditionId: 5 }]) {
      const error = await caught(() =>
        fetchConvictionMarket(r.ctx, request as never),
      );
      expect((error as UserInputError).code).toBe('invalid_input');
    }
    expect(r.orderbook.calls).toHaveLength(calls);
  });
});

describe('fetchMarketCapacity', () => {
  const RAW = {
    user_id: '0x22e2',
    market_id: CONDITION_A,
    free_market_capacity: '9000000',
    positions: [
      {
        token_id: TOKEN_YES,
        outcome: 'YES',
        balance: '4000000',
        reserved: '1000000',
        pending_settlement: '500000',
        free_position: '2500000',
      },
      {
        token_id: TOKEN_NO,
        outcome: 'NO',
        balance: '0',
        reserved: '0',
        pending_settlement: '0',
        free_position: '0',
      },
    ],
    smart_account: null,
  };

  /** A context whose order book answers the capacity read, as a signed-in client's would. */
  function signedIn(r: Rig) {
    const read = vi.fn(async (_id: string, _call?: unknown) => RAW);
    const ctx: ActionContext = {
      ...r.ctx,
      orderbook: { getMarketCapacity: read } as unknown as OrderbookClient,
    };
    return { ctx, read };
  }

  test('reads what the account can still commit, in whole units', async () => {
    const r = actionRig(server);
    const { ctx, read } = signedIn(r);
    const capacity = await fetchMarketCapacity(
      ctx,
      { conditionId: CONDITION_A.replace('a1', 'A1') },
      { retries: 1, timeout: 900 },
    );
    expect(read).toHaveBeenCalledWith(CONDITION_A, {
      timeoutMs: 900,
      retries: 1,
    });
    expect(capacity).toEqual({
      conditionId: CONDITION_A,
      buyCapacity: '9',
      positions: [
        {
          assetId: TOKEN_YES,
          outcome: 'YES',
          balance: '4',
          reserved: '1',
          pendingSettlement: '0.5',
          free: '2.5',
        },
        {
          assetId: TOKEN_NO,
          outcome: 'NO',
          balance: '0',
          reserved: '0',
          pendingSettlement: '0',
          free: '0',
        },
      ],
    });
    expect(wireStyleKeys(capacity)).toEqual([]);
  });

  test('what a failed sign-in raises passes through, and the guard knows it', async () => {
    const r = actionRig(server);
    for (const failure of [
      new SigningError('the wallet refused'),
      new XoError('closed', { code: 'session_closed' }),
      new RequestRejectedError('refused', { status: 401 }),
    ]) {
      const ctx: ActionContext = {
        ...r.ctx,
        orderbook: {
          getMarketCapacity: vi.fn(async () => {
            throw failure;
          }),
        } as unknown as OrderbookClient,
      };
      const error = await caught(() =>
        fetchMarketCapacity(ctx, { conditionId: CONDITION_A }),
      );
      expect(error).toBe(failure);
      expect(FetchMarketCapacityError.isError(error)).toBe(true);
    }
  });

  test('a bad request is invalid_input, before the order book is asked', async () => {
    const r = actionRig(server);
    const { ctx, read } = signedIn(r);
    for (const request of [undefined, {}, { conditionId: 'x' }]) {
      const error = await caught(() =>
        fetchMarketCapacity(ctx, request as never),
      );
      expect((error as UserInputError).code).toBe('invalid_input');
      expect((error as UserInputError).message).toMatch(
        /^fetchMarketCapacity: /,
      );
    }
    expect(read).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// listTrades
// ---------------------------------------------------------------------------

describe('listTrades', () => {
  const backendCalls = (r: Rig): string[] =>
    r.backend.requests.map((request) => `${request.method} ${request.path}`);

  test('lists the fills of a market, newest first, a page per request', async () => {
    const r = actionRig(server);
    const trades = listTrades(r.ctx, { marketId: '1' });
    expect(r.backend.requests).toEqual([]);
    const page = await trades.firstPage();
    expect(backendCalls(r)).toEqual(['GET /api/markets/1/activity']);
    expect(r.backend.requests[0]?.authorization).toBeNull();
    expect(r.backend.requests[0]?.query).toMatchObject({
      sortBy: 'executedAt',
      sortOrder: 'DESC',
    });
    expect(page.items[0]).toMatchObject({
      id: '1',
      side: OrderSide.BUY,
      marketId: '1',
      outcome: 'YES',
      outcomeIndex: 0,
      size: '1.75',
      price: '0.57',
      amount: '1.00',
      timestamp: expect.any(String),
      transactionHash: `0x${'ee'.repeat(32)}`,
      userId: '21',
      username: 'trader',
      profileImage: null,
    });
    expect(wireStyleKeys(page.items)).toEqual([]);
  });

  test("one market's fills come from its own feed, keeping the market id the caller asked for", async () => {
    const r = actionRig(server);
    const page = await listTrades(r.ctx, {
      marketId: '1',
      pageSize: 3,
    }).firstPage();
    expect(backendCalls(r)).toEqual(['GET /api/markets/1/activity']);
    expect(r.backend.requests[0]?.query).toMatchObject({ take: '3' });
    expect(page.items).toHaveLength(3);
    expect(page.items.map((trade) => trade.side)).toEqual([
      OrderSide.BUY,
      OrderSide.SELL,
      OrderSide.BUY,
    ]);
    // The per-market feed leaves the market out of its rows: only the id is known.
    expect(page.items[0]).toMatchObject({
      marketId: '1',
      conditionId: null,
      title: null,
      slug: null,
    });
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual(expect.any(String));
  });

  test('walks the pages with from(nextCursor), and stops after the last', async () => {
    const r = actionRig(server);
    const pages = [];
    for await (const page of listTrades(r.ctx, {
      marketId: '1',
      pageSize: 3,
    })) {
      pages.push(page.items.length);
    }
    expect(pages).toEqual([3, 3, 1]);
    const first = await listTrades(r.ctx, {
      marketId: '1',
      pageSize: 3,
    }).firstPage();
    const second = await listTrades(r.ctx, { marketId: '1', pageSize: 3 })
      .from(first.nextCursor)
      .firstPage();
    expect(second.items.map((trade) => trade.id)).toEqual(['4', '5', '6']);
    expect(r.backend.requests.at(-1)?.query.page).toBe('2');
  });

  test('side filters the fills', async () => {
    const r = actionRig(server);
    await listTrades(r.ctx, {
      marketId: '1',
      side: OrderSide.SELL,
    }).firstPage();
    expect(r.backend.requests[0]?.query).toMatchObject({
      positionType: 'SELL',
    });
    await listTrades(r.ctx, { side: 'BUY', marketId: '1' }).firstPage();
    expect(r.backend.requests[1]?.query).toMatchObject({ positionType: 'BUY' });
  });

  test('a cursor of another list, or one that is not a page number, is refused', async () => {
    const r = actionRig(server);
    expect(() =>
      listTrades(r.ctx, { marketId: '1' }).from(cursorOf('markets', 'page', 2)),
    ).toThrow(UserInputError);
    for (const forged of [
      cursorOf('trades', 'cursor', 'abc'),
      cursorOf('trades', 'cursor', '0'),
      cursorOf('trades', 'page', 0),
    ]) {
      const error = await caught(() =>
        listTrades(r.ctx, { marketId: '1' }).from(forged).firstPage(),
      );
      expect((error as UserInputError).code).toBe('invalid_cursor');
    }
    expect(r.backend.requests).toEqual([]);
  });

  test.each([
    ['no request', undefined],
    ['a request without a marketId', { pageSize: 5 }],
    ['a marketId that is not digits', { marketId: 'abc' }],
    ['a marketId that is a number', { marketId: 1 }],
    ['a pageSize of 0', { marketId: '1', pageSize: 0 }],
    ['a pageSize above 50', { marketId: '1', pageSize: 51 }],
    ['a side that is not one', { marketId: '1', side: 'HOLD' }],
    ['an unknown key', { marketId: '1', market: conditionIdOf(1) }],
  ])('%s is invalid_input, at once', (_name, request) => {
    const r = actionRig(server);
    let error: unknown;
    try {
      listTrades(r.ctx, request as never);
    } catch (e) {
      error = e;
    }
    expect((error as UserInputError).code).toBe('invalid_input');
    expect((error as UserInputError).message).toMatch(/^listTrades: /);
    expect(r.backend.requests).toEqual([]);
  });

  test('an unknown market is a 404 when the list is read', async () => {
    const r = actionRig(server);
    const error = await caught(() =>
      listTrades(r.ctx, { marketId: '999' }).firstPage(),
    );
    expect(error).toBeInstanceOf(RequestRejectedError);
    expect(error).toSatisfy(rejectedWith(404));
  });
});

// ---------------------------------------------------------------------------
// Options reach every request
// ---------------------------------------------------------------------------

describe('options', () => {
  const GOOD = { retries: 0, timeout: 1234 } as const;
  const EXPECTED = { timeoutMs: 1234, retries: 0 };

  const reads: Array<
    [string, (ctx: ActionContext, options: RequestOptions) => unknown]
  > = [
    ['fetchOrderBook', (c, o) => fetchOrderBook(c, { assetId: TOKEN_YES }, o)],
    [
      'fetchOrderBooks',
      (c, o) => fetchOrderBooks(c, { assetIds: [TOKEN_YES] }, o),
    ],
    ['fetchMidpoint', (c, o) => fetchMidpoint(c, { assetId: TOKEN_YES }, o)],
    [
      'fetchMidpoints',
      (c, o) => fetchMidpoints(c, { assetIds: [TOKEN_YES] }, o),
    ],
    [
      'fetchPrice',
      (c, o) => fetchPrice(c, { assetId: TOKEN_YES, side: 'BUY' }, o),
    ],
    [
      'fetchPrices',
      (c, o) =>
        fetchPrices(c, { requests: [{ assetId: TOKEN_YES, side: 'BUY' }] }, o),
    ],
    ['fetchSpread', (c, o) => fetchSpread(c, { assetId: TOKEN_YES }, o)],
    ['fetchSpreads', (c, o) => fetchSpreads(c, { assetIds: [TOKEN_YES] }, o)],
    [
      'fetchLastTradePrice',
      (c, o) => fetchLastTradePrice(c, { assetId: TOKEN_YES }, o),
    ],
    [
      'fetchLastTradePrices',
      (c, o) => fetchLastTradePrices(c, { assetIds: [TOKEN_YES] }, o),
    ],
    [
      'listPriceHistory',
      (c, o) =>
        listPriceHistory(
          c,
          { assetId: TOKEN_YES, interval: 'max' },
          o,
        ).firstPage(),
    ],
    ['fetchTradingState', (c, o) => fetchTradingState(c, o)],
    [
      'fetchConvictionMarket',
      (c, o) => fetchConvictionMarket(c, { conditionId: conditionIdOf(1) }, o),
    ],
    ['listTrades', (c, o) => listTrades(c, { marketId: '1' }, o).firstPage()],
  ];

  test.each(reads)('%s passes them to its request', async (_name, run) => {
    const r = actionRig(server);
    const spy = vi.spyOn(r.transport, 'request');
    await run(r.ctx, GOOD);
    expect(spy).toHaveBeenCalled();
    for (const [request] of spy.mock.calls) {
      expect(request.call).toEqual(EXPECTED);
    }
  });

  test.each(reads)(
    '%s rejects bad options before any request',
    async (_name, run) => {
      const r = actionRig(server);
      const error = await caught(() => run(r.ctx, { retries: 99 }));
      expect(error).toBeInstanceOf(UserInputError);
      expect((error as UserInputError).code).toBe('invalid_request_options');
      expect(r.orderbook.requests).toEqual([]);
      expect(r.backend.requests).toEqual([]);
    },
  );

  test('an aborted signal rejects with RequestAbortedError', async () => {
    const r = actionRig(server);
    const controller = new AbortController();
    controller.abort();
    const error = await caught(() =>
      fetchOrderBook(
        r.ctx,
        { assetId: TOKEN_YES },
        { signal: controller.signal },
      ),
    );
    expect(error).toBeInstanceOf(RequestAbortedError);
  });
});
