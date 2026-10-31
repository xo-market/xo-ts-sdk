import { getAddress } from 'viem';
import { describe, expect, test } from 'vitest';
import { UnexpectedResponseError } from '../../src/core/errors';
import type { MarketActivity as RawActivity } from '../../src/data/activitySchemas';
import { OrderSide } from '../../src/models/enums';
import {
  toConvictionMarket,
  toLastTradePrice,
  toLastTradePriceForAsset,
  toMarketCapacity,
  toMarketTrade,
  toPricePoint,
} from '../../src/models/marketData';
import {
  ConvictionMarketSchema,
  LastTradePriceSchema,
  MarketCapacitySchema,
  type PricePoint as RawPricePoint,
} from '../../src/orderbook/schemas';
import { activityFixture, conditionIdOf } from '../helpers/mockBackendData';
import { CONDITION_A, TOKEN_NO, TOKEN_YES } from '../helpers/mockMarketData';
import { wireStyleKeys } from '../helpers/modelKeys';

describe('toLastTradePrice', () => {
  const parse = (value: Record<string, unknown>) =>
    LastTradePriceSchema.strict.parse(value);

  test('a trade is its price and the taker side', () => {
    expect(toLastTradePrice(parse({ price: '0.555', side: 'BUY' }))).toEqual({
      price: '0.555',
      side: OrderSide.BUY,
    });
    expect(toLastTradePrice(parse({ price: '0.4', side: 'SELL' }))).toEqual({
      price: '0.4',
      side: OrderSide.SELL,
    });
  });

  test('the placeholder of a token that has not traded is null, not a price', () => {
    expect(toLastTradePrice(parse({ price: '0.5', side: '' }))).toBeNull();
  });

  test('a trade of a list names its token', () => {
    expect(
      toLastTradePriceForAsset({
        token_id: `0${TOKEN_YES}`,
        price: '0.7',
        side: 'SELL',
      }),
    ).toEqual({ assetId: TOKEN_YES, price: '0.7', side: OrderSide.SELL });
  });
});

describe('toPricePoint', () => {
  test('a point is its time in milliseconds and its price', () => {
    const point: RawPricePoint = { t: 1_800_000_060, p: '0.520' };
    expect(toPricePoint(point)).toEqual({
      timestamp: 1_800_000_060_000,
      price: '0.520',
    });
  });
});

describe('toConvictionMarket', () => {
  const raw = (patch: Record<string, unknown> = {}) =>
    ConvictionMarketSchema.strict.parse({
      condition_id: CONDITION_A,
      tokens: [
        { token_id: TOKEN_YES, outcome: 'Yes', price: '0.555' },
        { token_id: TOKEN_NO, outcome: 'No', price: '0.445' },
      ],
      active: true,
      variant: 'conviction',
      creator: `0x${'c0'.repeat(20)}`,
      commitment: {
        order_id: '77',
        status: 'resting',
        outcome: 'no',
        side: 'sell',
        price: '0.700',
        size: '50',
        remaining: '20',
      },
      ...patch,
    });

  test('has the market, its creator and the creator commitment', () => {
    const market = toConvictionMarket(raw());
    expect(market).toEqual({
      conditionId: CONDITION_A,
      active: true,
      variant: 'conviction',
      creator: getAddress(`0x${'c0'.repeat(20)}`),
      commitment: {
        orderId: '77',
        status: 'resting',
        outcome: 'no',
        side: OrderSide.SELL,
        price: '0.700',
        size: '50',
        remaining: '20',
      },
      outcomes: {
        yes: { tokenId: TOKEN_YES, price: '0.555' },
        no: { tokenId: TOKEN_NO, price: '0.445' },
      },
    });
    expect(wireStyleKeys(market)).toEqual([]);
  });

  test('a spent commitment leaves out what the order book keeps no detail of', () => {
    const market = toConvictionMarket(
      raw({
        commitment: {
          order_id: '77',
          status: 'spent_tombstone',
          outcome: 'yes',
        },
      }),
    );
    expect(market.commitment).toEqual({
      orderId: '77',
      status: 'spent_tombstone',
      outcome: 'yes',
      side: null,
      price: null,
      size: null,
      remaining: null,
    });
  });

  test('a market that is not a conviction market has neither', () => {
    const market = toConvictionMarket(
      raw({ variant: 'clob', creator: null, commitment: null }),
    );
    expect(market).toMatchObject({
      variant: 'clob',
      creator: null,
      commitment: null,
    });
  });

  test('an outcome with no price has null, never the order book\'s "0.000"', () => {
    const market = toConvictionMarket(
      raw({
        tokens: [
          { token_id: TOKEN_YES, outcome: 'Yes', price: '0.000' },
          { token_id: TOKEN_NO, outcome: 'No', price: '0' },
        ],
      }),
    );
    expect(market.outcomes).toEqual({
      yes: { tokenId: TOKEN_YES, price: null },
      no: { tokenId: TOKEN_NO, price: null },
    });
  });

  test('the outcomes are found by their name, whatever the order', () => {
    const market = toConvictionMarket(
      raw({
        tokens: [
          { token_id: TOKEN_NO, outcome: 'No', price: '0.445' },
          { token_id: TOKEN_YES, outcome: 'Yes', price: '0.555' },
        ],
      }),
    );
    expect(market.outcomes.yes.tokenId).toBe(TOKEN_YES);
    expect(market.outcomes.no.tokenId).toBe(TOKEN_NO);
  });

  test.each([
    ['one outcome', [{ token_id: TOKEN_YES, outcome: 'Yes', price: '0.5' }]],
    [
      'two outcomes that are not Yes and No',
      [
        { token_id: TOKEN_YES, outcome: 'Up', price: '0.5' },
        { token_id: TOKEN_NO, outcome: 'Down', price: '0.5' },
      ],
    ],
  ])('%s is an unexpected response that names the field', (_name, tokens) => {
    const lenient = ConvictionMarketSchema.lenient.parse({
      ...raw(),
      tokens,
    });
    let error: unknown;
    try {
      toConvictionMarket(lenient);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).message).toContain('outcomes');
    expect((error as UnexpectedResponseError).service).toBe('orderbook');
  });
});

describe('toMarketCapacity', () => {
  const raw = (patch: Record<string, unknown> = {}) =>
    MarketCapacitySchema.strict.parse({
      user_id: '0x22e2',
      market_id: CONDITION_A.toUpperCase().replace('0X', '0x'),
      free_market_capacity: '2444289692',
      positions: [
        {
          token_id: TOKEN_YES,
          outcome: 'YES',
          balance: '41000000',
          reserved: '0',
          pending_settlement: '1',
          free_position: '40999999',
        },
      ],
      smart_account: '22e2',
      ...patch,
    });

  test('has whole units, the condition id in lower case, and no account', () => {
    const capacity = toMarketCapacity(raw());
    expect(capacity).toEqual({
      conditionId: CONDITION_A,
      buyCapacity: '2444.289692',
      positions: [
        {
          assetId: TOKEN_YES,
          outcome: 'YES',
          balance: '41',
          reserved: '0',
          pendingSettlement: '0.000001',
          free: '40.999999',
        },
      ],
    });
    expect(Object.keys(capacity)).not.toContain('userId');
    expect(wireStyleKeys(capacity)).toEqual([]);
  });

  test('an amount that is not micro-units is an unexpected response that names the field', () => {
    const lenient = MarketCapacitySchema.lenient.parse({
      ...raw(),
      free_market_capacity: '12.5',
    });
    let error: unknown;
    try {
      toMarketCapacity(lenient);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).message).toContain('buyCapacity');
    expect((error as UnexpectedResponseError).message).not.toContain('12.5');
  });
});

describe('toMarketTrade', () => {
  const row = (patch: Record<string, unknown> = {}, market = true) =>
    ({
      ...activityFixture(1, market),
      ...patch,
    }) as unknown as RawActivity;

  test('a fill is a flat, camelCase model in whole units', () => {
    expect(toMarketTrade(row())).toEqual({
      id: '1',
      side: OrderSide.BUY,
      marketId: '1',
      conditionId: conditionIdOf(1),
      title: 'Will thing 1 happen?',
      slug: expect.any(String),
      eventSlug: null,
      icon: 'https://cdn.example/m.png',
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
  });

  test('a creator share unlock is not a fill', () => {
    expect(
      toMarketTrade(row({ activityType: 'CREATOR_UNLOCK' })),
    ).toBeUndefined();
  });

  test('a row of a single market has only the market id the caller asked for', () => {
    expect(toMarketTrade(row({ market: null }, false), '7')).toMatchObject({
      marketId: '7',
      conditionId: null,
      title: null,
      slug: null,
      eventSlug: null,
      icon: null,
    });
    expect(toMarketTrade(row({ market: null }, false))).toMatchObject({
      marketId: null,
    });
  });

  test('a price, a hash and a trader the row lacks are null', () => {
    const trade = toMarketTrade(
      row({
        priceAtExecution: null,
        transactionHash: 'not-a-hash',
        user: null,
        outcome: null,
        positionType: 'SELL',
      }),
    );
    expect(trade).toMatchObject({
      side: OrderSide.SELL,
      price: null,
      transactionHash: null,
      userId: null,
      username: null,
      profileImage: null,
      outcome: null,
      outcomeIndex: null,
    });
  });

  test('a size that is not micro-units is an unexpected response that names the field', () => {
    let error: unknown;
    try {
      toMarketTrade(row({ shareAmount: '1.5' }));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).message).toContain('size');
    expect((error as UnexpectedResponseError).service).toBe('backend');
  });
});
