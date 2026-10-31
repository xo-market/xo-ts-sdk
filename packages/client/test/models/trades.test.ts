import { type Address, getAddress, type Hex } from 'viem';
import { describe, expect, expectTypeOf, test } from 'vitest';
import { UnexpectedResponseError } from '../../src/core/errors';
import type { ConditionId, DecimalString, TokenId } from '../../src/core/types';
import { OrderSide } from '../../src/models/enums';
import {
  type MakerOrder,
  type Trade,
  type TraderSide,
  type TradeStatus,
  toTrade,
} from '../../src/models/trades';
import {
  type Trade as RawTrade,
  TradeSchema,
} from '../../src/orderbook/schemas';
import { CONDITION_A, TOKEN_YES } from '../helpers/mockMarketData';
import { keysOf, wireStyleKeys } from '../helpers/modelKeys';

const TRADE_ID = `0x${'01'.repeat(32)}`;
const TAKER_ORDER = `0x${'aa'.repeat(32)}`;
const MAKER_ORDER = `0x${'cc'.repeat(32)}`;
const MAKER = `0x${'bb'.repeat(20)}`;
const TX = `0x${'ef'.repeat(32)}`;

/** A trade as the gateway prints it, with the fields it only fills for newer trades. */
function raw(patch: Record<string, unknown> = {}): RawTrade {
  return TradeSchema.strict.parse({
    id: TRADE_ID,
    market: CONDITION_A,
    outcome: 'YES',
    side: 'BUY',
    price: '0.500',
    size: '10',
    status: 'MATCHED',
    match_time: '1800000000',
    last_update: '1800000456',
    bucket_index: 0,
    transaction_hash: null,
    taker_order_id: TAKER_ORDER,
    asset_id: TOKEN_YES,
    fee_rate_bps: '0',
    owner: '6f1e7a5c-0000-5000-8000-000000000000',
    maker_address: MAKER,
    trader_side: 'TAKER',
    maker_orders: [
      {
        order_id: MAKER_ORDER,
        maker_address: MAKER,
        owner: '6f1e7a5c-0000-5000-8000-000000000001',
        matched_amount: '10',
        price: '0.500',
        fee_rate_bps: '0',
        asset_id: TOKEN_YES,
        outcome: 'YES',
      },
    ],
    maker_original_size: '10000000',
    maker_remaining_after_fill: '0',
    taker_original_size: '10000000',
    taker_remaining_after_fill: '0',
    ...patch,
  });
}

describe('toTrade', () => {
  test('maps a trade: camelCase keys, enums, ISO 8601 times, a null hash until it settles', () => {
    expect(toTrade(raw())).toEqual({
      id: TRADE_ID,
      assetId: TOKEN_YES,
      market: CONDITION_A,
      outcome: 'YES',
      side: OrderSide.BUY,
      traderSide: 'TAKER',
      price: '0.500',
      size: '10',
      status: 'MATCHED',
      feeRateBps: '0',
      transactionHash: null,
      takerOrderId: TAKER_ORDER,
      makerAddress: getAddress(MAKER),
      makerOrders: [
        {
          orderId: MAKER_ORDER,
          assetId: TOKEN_YES,
          makerAddress: getAddress(MAKER),
          matchedAmount: '10',
          price: '0.500',
          feeRateBps: '0',
          outcome: 'YES',
        },
      ],
      matchedAt: '2027-01-15T08:00:00.000Z',
      updatedAt: '2027-01-15T08:07:36.000Z',
    });
  });

  test('has the fields of the model and nothing else, and no snake_case or *ID key', () => {
    const trade = toTrade(raw());

    expect(Object.keys(trade).sort()).toEqual(
      [
        'id',
        'assetId',
        'market',
        'outcome',
        'side',
        'traderSide',
        'price',
        'size',
        'status',
        'feeRateBps',
        'transactionHash',
        'takerOrderId',
        'makerAddress',
        'makerOrders',
        'matchedAt',
        'updatedAt',
      ].sort(),
    );
    expect(Object.keys(trade.makerOrders[0] ?? {}).sort()).toEqual(
      [
        'orderId',
        'assetId',
        'makerAddress',
        'matchedAmount',
        'price',
        'feeRateBps',
        'outcome',
      ].sort(),
    );
    expect(wireStyleKeys(trade)).toEqual([]);
    expect(keysOf(trade)).toContain('transactionHash');
  });

  test('leaves out what has no meaning for a trader: the owner id, the bucket and the size bookkeeping', () => {
    const keys = keysOf(toTrade(raw()));

    for (const name of [
      'owner',
      'bucketIndex',
      'makerOriginalSize',
      'makerRemainingAfterFill',
      'takerOriginalSize',
      'takerRemainingAfterFill',
    ]) {
      expect(keys, name).not.toContain(name);
    }
  });

  test('a settled trade carries its transaction hash, and the status is kept as it is', () => {
    const trade = toTrade(raw({ transaction_hash: TX, status: 'CONFIRMED' }));

    expect(trade.transactionHash).toBe(TX);
    expect(trade.status).toBe('CONFIRMED');
    for (const status of [
      'MATCHED',
      'MINED',
      'CONFIRMED',
      'RETRYING',
      'FAILED',
    ]) {
      expect(toTrade(raw({ status })).status).toBe(status);
    }
  });

  test('a transaction hash that is empty or not a hash is null', () => {
    expect(toTrade(raw({ transaction_hash: '' })).transactionHash).toBeNull();
    expect(
      toTrade(raw({ transaction_hash: 'pending' })).transactionHash,
    ).toBeNull();
  });

  test('maps the trader side and the taker side', () => {
    const maker = toTrade(raw({ trader_side: 'MAKER', side: 'SELL' }));

    expect(maker.traderSide).toBe('MAKER');
    expect(maker.side).toBe(OrderSide.SELL);
  });

  test('keeps legacy numeric order ids as strings', () => {
    const trade = toTrade(
      raw({
        taker_order_id: '1234',
        maker_orders: [
          {
            order_id: '99',
            maker_address: MAKER,
            owner: 'x',
            matched_amount: '10',
            price: '0.500',
            fee_rate_bps: '0',
            asset_id: TOKEN_YES,
            outcome: 'YES',
          },
        ],
      }),
    );

    expect(trade.takerOrderId).toBe('1234');
    expect(trade.makerOrders[0]?.orderId).toBe('99');
  });

  test('a trade without maker orders has none', () => {
    expect(toTrade(raw({ maker_orders: [] })).makerOrders).toEqual([]);
  });

  test('keeps the price, size and fee rate exactly as printed', () => {
    const trade = toTrade(
      raw({ price: '0.571', size: '12.345678', fee_rate_bps: '25' }),
    );

    expect(trade.price).toBe('0.571');
    expect(trade.size).toBe('12.345678');
    expect(trade.feeRateBps).toBe('25');
  });

  test('lower-cases the condition id and canonicalises the token id', () => {
    const trade = toTrade(
      raw({ market: `0x${'AB'.repeat(32)}`, asset_id: '0042' }),
    );

    expect(trade.market).toBe(`0x${'ab'.repeat(32)}`);
    expect(trade.assetId).toBe('42');
  });

  test('a match time or an update time that is not a time is an unexpected response', () => {
    for (const patch of [
      { match_time: '' },
      { match_time: 'later' },
      { last_update: '-1' },
      { last_update: '99999999999999999' },
    ]) {
      expect(() => toTrade(raw(patch)), JSON.stringify(patch)).toThrow(
        UnexpectedResponseError,
      );
    }
  });

  test('does not change its input and returns plain JSON data', () => {
    const input = raw();
    const before = structuredClone(input);
    const trade = toTrade(input);

    expect(input).toEqual(before);
    expect(JSON.parse(JSON.stringify(trade))).toEqual(trade);
    trade.makerOrders.pop();
    expect(input.maker_orders).toHaveLength(1);
  });

  test('has the public types', () => {
    expectTypeOf<Trade['id']>().toEqualTypeOf<string>();
    expectTypeOf<Trade['assetId']>().toEqualTypeOf<TokenId>();
    expectTypeOf<Trade['market']>().toEqualTypeOf<ConditionId>();
    expectTypeOf<Trade['side']>().toEqualTypeOf<OrderSide>();
    expectTypeOf<Trade['traderSide']>().toEqualTypeOf<TraderSide>();
    expectTypeOf<Trade['status']>().toEqualTypeOf<TradeStatus>();
    expectTypeOf<Trade['price']>().toEqualTypeOf<DecimalString>();
    expectTypeOf<Trade['size']>().toEqualTypeOf<DecimalString>();
    expectTypeOf<Trade['feeRateBps']>().toEqualTypeOf<DecimalString>();
    expectTypeOf<Trade['transactionHash']>().toEqualTypeOf<Hex | null>();
    expectTypeOf<Trade['makerAddress']>().toEqualTypeOf<Address>();
    expectTypeOf<Trade['makerOrders']>().toEqualTypeOf<MakerOrder[]>();
    expectTypeOf<Trade['matchedAt']>().toEqualTypeOf<string>();
    expectTypeOf<Trade['updatedAt']>().toEqualTypeOf<string>();
    expectTypeOf<MakerOrder['matchedAmount']>().toEqualTypeOf<DecimalString>();
  });
});
