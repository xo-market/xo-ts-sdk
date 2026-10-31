import { describe, expect, expectTypeOf, test } from 'vitest';
import type { ConditionId, DecimalString, TokenId } from '../../src/core/types';
import {
  type OrderBook,
  type PriceLevel,
  toOrderBook,
} from '../../src/models/orderBook';
import {
  OrderBookSchema,
  type OrderBook as RawOrderBook,
} from '../../src/orderbook/schemas';
import { CONDITION_A, TOKEN_YES } from '../helpers/mockMarketData';
import { keysOf, wireStyleKeys } from '../helpers/modelKeys';

/** A book as the gateway prints it: best price first on each side, padded prices. */
function raw(patch: Record<string, unknown> = {}): RawOrderBook {
  return OrderBookSchema.strict.parse({
    market: CONDITION_A,
    asset_id: TOKEN_YES,
    timestamp: '1800000123456',
    hash: 'ab12cd34',
    bids: [
      { price: '0.570', size: '100' },
      { price: '0.560', size: '250.5' },
      { price: '0.550', size: '12' },
    ],
    asks: [
      { price: '0.580', size: '80.123456' },
      { price: '0.590', size: '40' },
    ],
    min_order_size: '0',
    tick_size: '0.001',
    neg_risk: false,
    last_trade_price: '0.000',
    last_update_id: 42,
    ...patch,
  });
}

describe('toOrderBook', () => {
  test('has camelCase keys and the fields of the model, nothing else', () => {
    const book = toOrderBook(raw());

    expect(Object.keys(book).sort()).toEqual([
      'asks',
      'assetId',
      'bids',
      'hash',
      'market',
      'minimumOrderSize',
      'minimumTickSize',
      'negRisk',
      'timestamp',
    ]);
    expect(book).toHaveProperty('assetId');
    expect(book).toHaveProperty('minimumTickSize');
    expect(wireStyleKeys(book)).toEqual([]);
    expect(keysOf(book)).toEqual(
      expect.arrayContaining(['assetId', 'market', 'bids', 'price', 'size']),
    );
  });

  test('maps the identifiers, tick size, neg-risk flag, time and hash', () => {
    const book = toOrderBook(raw());

    expect(book.assetId).toBe(TOKEN_YES);
    expect(book.market).toBe(CONDITION_A);
    expect(book.minimumTickSize).toBe('0.001');
    expect(book.negRisk).toBe(false);
    expect(book.timestamp).toBe(1800000123456);
    expect(book.hash).toBe('ab12cd34');
    expect(toOrderBook(raw({ neg_risk: true })).negRisk).toBe(true);
  });

  test('keeps every price and size exactly as printed', () => {
    const book = toOrderBook(raw());

    expect(book.asks.map((level) => level.size)).toContain('80.123456');
    expect(book.bids.map((level) => level.price)).toEqual([
      '0.550',
      '0.560',
      '0.570',
    ]);
    expect(book.bids.map((level) => level.size)).toEqual([
      '12',
      '250.5',
      '100',
    ]);
  });

  test('lists bids from the lowest price and asks from the highest, so the best level of each side is last', () => {
    const book = toOrderBook(raw());

    expect(book.bids.at(-1)).toEqual({ price: '0.570', size: '100' });
    expect(book.asks.map((level) => level.price)).toEqual(['0.590', '0.580']);
    expect(book.asks.at(-1)).toEqual({ price: '0.580', size: '80.123456' });
  });

  test('an empty side stays empty', () => {
    const book = toOrderBook(raw({ bids: [], asks: [] }));

    expect(book.bids).toEqual([]);
    expect(book.asks).toEqual([]);
  });

  test('the minimum order size is one share while the source sends its placeholder zero', () => {
    expect(toOrderBook(raw({ min_order_size: '0' })).minimumOrderSize).toBe(
      '1',
    );
    expect(toOrderBook(raw({ min_order_size: '0.000' })).minimumOrderSize).toBe(
      '1',
    );
  });

  test('a minimum order size the source really states is kept', () => {
    expect(toOrderBook(raw({ min_order_size: '5' })).minimumOrderSize).toBe(
      '5',
    );
    expect(
      toOrderBook(raw({ min_order_size: '2.500000' })).minimumOrderSize,
    ).toBe('2.500000');
  });

  test('a timestamp that is not whole milliseconds is null', () => {
    expect(toOrderBook(raw({ timestamp: '' })).timestamp).toBeNull();
    expect(toOrderBook(raw({ timestamp: 'soon' })).timestamp).toBeNull();
    expect(toOrderBook(raw({ timestamp: '1.5' })).timestamp).toBeNull();
  });

  test('the condition id is lower-cased and the token id is canonical', () => {
    const upper = `0x${'AB'.repeat(32)}`;
    const book = toOrderBook(raw({ market: upper, asset_id: '0007' }));

    expect(book.market).toBe(`0x${'ab'.repeat(32)}`);
    expect(book.assetId).toBe('7');
  });

  test('an id it cannot read passes through unchanged and never throws', () => {
    const book = toOrderBook(raw({ market: 'market-1', asset_id: 'token-1' }));

    expect(book.market).toBe('market-1');
    expect(book.assetId).toBe('token-1');
  });

  test('does not change its input and returns plain JSON data', () => {
    const input = raw();
    const before = structuredClone(input);
    const book = toOrderBook(input);

    expect(input).toEqual(before);
    expect(JSON.parse(JSON.stringify(book))).toEqual(book);
    book.bids.pop();
    expect(input.bids).toHaveLength(3);
  });

  test('has the public types', () => {
    expectTypeOf<OrderBook['assetId']>().toEqualTypeOf<TokenId>();
    expectTypeOf<OrderBook['market']>().toEqualTypeOf<ConditionId>();
    expectTypeOf<OrderBook['bids']>().toEqualTypeOf<PriceLevel[]>();
    expectTypeOf<OrderBook['asks']>().toEqualTypeOf<PriceLevel[]>();
    expectTypeOf<OrderBook['minimumTickSize']>().toEqualTypeOf<DecimalString>();
    expectTypeOf<
      OrderBook['minimumOrderSize']
    >().toEqualTypeOf<DecimalString>();
    expectTypeOf<OrderBook['negRisk']>().toEqualTypeOf<boolean>();
    expectTypeOf<OrderBook['timestamp']>().toEqualTypeOf<number | null>();
    expectTypeOf<OrderBook['hash']>().toEqualTypeOf<string>();
    expectTypeOf<PriceLevel>().toEqualTypeOf<{
      price: DecimalString;
      size: DecimalString;
    }>();
  });
});
