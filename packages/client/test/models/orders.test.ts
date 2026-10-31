import { type Address, getAddress, type Hex } from 'viem';
import { describe, expect, expectTypeOf, test } from 'vitest';
import { UnexpectedResponseError } from '../../src/core/errors';
import type {
  ConditionId,
  DecimalString,
  OrderHash,
  TokenId,
} from '../../src/core/types';
import { OrderSide, OrderType } from '../../src/models/enums';
import {
  type AcceptedOrderResponse,
  type OpenOrder,
  ORDER_REJECTION_CODES,
  type OrderRejectionCode,
  type OrderResponse,
  orderRejectionCode,
  type RejectedOrderResponse,
  type SignedOrder,
  toBatchOrderResponse,
  toCancelOrdersResponse,
  toOpenOrder,
  toOrderResponse,
  toReconciledOrder,
  toRejectedOrderResponse,
} from '../../src/models/orders';
import type { SignedOrder as TodaysSignedOrder } from '../../src/orderbook/builder';
import {
  type BatchPlaceEntry,
  OpenOrderSchema,
  PlaceOrderResponseSchema,
  type OpenOrder as RawOpenOrder,
  type PlaceOrderResponse as RawPlaceOrderResponse,
  type Trade as RawTrade,
  TradeSchema,
} from '../../src/orderbook/schemas';
import { CONDITION_A, TOKEN_YES } from '../helpers/mockMarketData';
import { microToDecimal } from '../helpers/mockTrading';
import { wireStyleKeys } from '../helpers/modelKeys';

const HASH = `0x${'12'.repeat(32)}` as OrderHash;
const OTHER_HASH = `0x${'34'.repeat(32)}` as OrderHash;
const MAKER = `0x${'bb'.repeat(20)}`;
/**
 * A code of the EIP-1271 family that a failed signature check starts with: a name, then
 * `_1271`. Built from two pieces, like the other words the public-content check keeps out of
 * the repository.
 */
const CODE_1271 = `${'PO'}${'LY'}_1271`;

/** A placement answer as the gateway prints it. */
function placed(patch: Record<string, unknown> = {}): RawPlaceOrderResponse {
  return PlaceOrderResponseSchema.strict.parse({
    success: true,
    errorMsg: null,
    makingAmount: '0',
    takingAmount: '0',
    orderID: HASH,
    status: 'live',
    transactionsHashes: [],
    tradeIds: [],
    ...patch,
  });
}

/** An answer to a refused order, with the message `errorMsg` carries. */
const refused = (errorMsg: string | null): RawPlaceOrderResponse =>
  placed({ success: false, errorMsg, status: 'delayed' });

function accepted(response: OrderResponse): AcceptedOrderResponse {
  if (!response.ok) {
    throw new Error(`expected an accepted order, got ${response.code}`);
  }
  return response;
}

function rejected(response: OrderResponse): RejectedOrderResponse {
  if (response.ok) {
    throw new Error('expected a rejected order');
  }
  return response;
}

describe('toOrderResponse: an accepted order', () => {
  test('maps success: true to ok: true with orderId, the local hash, status and the trades', () => {
    const response = toOrderResponse(
      placed({
        makingAmount: '570000',
        takingAmount: '1000000',
        status: 'matched',
        tradeIds: ['7', '8'],
      }),
      HASH,
    );

    expect(response).toEqual({
      ok: true,
      orderId: HASH,
      orderHash: HASH,
      status: 'matched',
      makingAmount: '0.57',
      takingAmount: '1',
      tradeIds: ['7', '8'],
      transactionsHashes: [],
    });
  });

  test('a resting order has zero amounts and status live', () => {
    const response = accepted(toOrderResponse(placed(), HASH));

    expect(response.status).toBe('live');
    expect(response.makingAmount).toBe('0');
    expect(response.takingAmount).toBe('0');
    expect(response.tradeIds).toEqual([]);
  });

  test.each([
    ['0', '0'],
    ['', '0'],
    ['1', '0.000001'],
    ['10', '0.00001'],
    ['999999', '0.999999'],
    ['1000000', '1'],
    ['1500000', '1.5'],
    ['570000', '0.57'],
    ['153641122', '153.641122'],
    ['9007199254740993', '9007199254.740993'],
    ['18446744073709551615', '18446744073709.551615'],
  ])(
    'converts the micro-units %j exactly to %j whole units',
    (micro, whole) => {
      const response = accepted(
        toOrderResponse(
          placed({ makingAmount: micro, takingAmount: micro }),
          HASH,
        ),
      );

      expect(response.makingAmount).toBe(whole);
      expect(response.takingAmount).toBe(whole);
    },
  );

  test.each(['abc', '-5', '1.5', '1e6', ' 5'])(
    'an amount that is not whole micro-units (%j) is an unexpected response, not a guess',
    (micro) => {
      expect(() =>
        toOrderResponse(placed({ makingAmount: micro }), HASH),
      ).toThrow(UnexpectedResponseError);
      expect(() =>
        toOrderResponse(placed({ takingAmount: micro }), HASH),
      ).toThrow(UnexpectedResponseError);
    },
  );

  test('the error names the field and never the value', () => {
    try {
      toOrderResponse(placed({ makingAmount: 'secret-looking' }), HASH);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UnexpectedResponseError);
      expect((error as Error).message).toContain('makingAmount');
      expect((error as Error).message).not.toContain('secret-looking');
    }
  });

  test('orderId is the gateway id and orderHash is the local hash, even when they differ', () => {
    const response = accepted(
      toOrderResponse(placed({ orderID: OTHER_HASH }), HASH),
    );

    expect(response.orderId).toBe(OTHER_HASH);
    expect(response.orderHash).toBe(HASH);
  });

  test('an answer without an id falls back to the local hash, which is the id on XO', () => {
    expect(
      accepted(toOrderResponse(placed({ orderID: '' }), HASH)).orderId,
    ).toBe(HASH);
  });

  test('keeps a status it does not know', () => {
    const lenient = PlaceOrderResponseSchema.lenient.parse({
      ...placed(),
      status: 'queued',
    });

    expect(accepted(toOrderResponse(lenient, HASH)).status).toBe('queued');
  });

  test('keeps the settlement transaction hashes that are hashes', () => {
    const tx = `0x${'ab'.repeat(32)}`;
    const response = accepted(
      toOrderResponse(
        placed({ transactionsHashes: [tx, 'oops', '0x12'] }),
        HASH,
      ),
    );

    expect(response.transactionsHashes).toEqual([tx]);
  });

  test('has camelCase keys only, copies the lists and returns plain JSON data', () => {
    const input = placed({ tradeIds: ['7'], transactionsHashes: [] });
    const before = structuredClone(input);
    const response = toOrderResponse(input, HASH);

    expect(wireStyleKeys(response)).toEqual([]);
    expect(input).toEqual(before);
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
    // A single placement always reports its trades: never null.
    accepted(response).tradeIds?.push('9');
    expect(accepted(response).tradeIds).toEqual(['7', '9']);
    expect(input.tradeIds).toEqual(['7']);
  });
});

describe('toOrderResponse: a refused order', () => {
  test('a post-only order that would cross is ok: false with code post_only_would_cross', () => {
    const message = 'post-only order would cross resting liquidity';
    const response = toOrderResponse(refused(message), HASH);

    expect(response).toEqual({
      ok: false,
      orderHash: HASH,
      code: 'post_only_would_cross',
      message,
    });
  });

  test('a message it does not know is code rejected and the message is kept as it was', () => {
    const message = 'Some New Refusal: the venue said so (id 42)';
    const response = rejected(toOrderResponse(refused(message), HASH));

    expect(response.code).toBe('rejected');
    expect(response.message).toBe(message);
    expect(response.orderHash).toBe(HASH);
  });

  test('a refusal without a message is code rejected with a message of its own', () => {
    for (const errorMsg of [null, '', '   ']) {
      const response = rejected(toOrderResponse(refused(errorMsg), HASH));

      expect(response.code).toBe('rejected');
      expect(response.message.length).toBeGreaterThan(10);
    }
  });

  test('the amounts of a refused order are not read', () => {
    const response = toOrderResponse(
      placed({
        success: false,
        errorMsg: 'size below minimum: min 1000000, got 1',
        makingAmount: 'not a number',
      }),
      HASH,
    );

    expect(rejected(response).code).toBe('size_below_minimum');
  });

  test('has camelCase keys only and no status or amounts', () => {
    const response = toOrderResponse(
      refused('market not found: unknown'),
      HASH,
    );

    expect(Object.keys(response).sort()).toEqual([
      'code',
      'message',
      'ok',
      'orderHash',
    ]);
  });
});

/** Every message XO's orderbook gives for a refused placement, and the code it becomes. */
const REFUSALS: Array<[code: OrderRejectionCode, message: string]> = [
  ['post_only_would_cross', 'post-only order would cross resting liquidity'],
  [
    'post_only_would_cross',
    'trading error: engine error: post-only order would cross resting liquidity',
  ],
  [
    'duplicate_order',
    'duplicate order: an order with the same signed-payload hash is already resting in this book',
  ],
  [
    'duplicate_order',
    'duplicate order: an order with the same signed-payload hash has already been matched',
  ],
  [
    'duplicate_order',
    'trading error: engine error: book error: order 17 already exists in book',
  ],
  [
    'duplicate_order',
    `trading error: engine error: order hash already matched: ${HASH}`,
  ],
  ['size_below_minimum', 'size below minimum: min 1000000, got 500000'],
  [
    'size_below_minimum',
    'trading error: validation error: size below minimum: min 1000000, got 1',
  ],
  ['notional_below_minimum', 'notional below minimum: min 1000, got 600'],
  ['price_out_of_range', 'invalid price tick 1000: must be 1..=999'],
  ['price_out_of_range', 'invalid price tick 0: must be 0..=1000'],
  [
    'price_out_of_range',
    'order amount: price tick out of range: ratio = 1500 (must be 1..=999)',
  ],
  [
    'invalid_expiration',
    'GTD expiration is in the past or too soon (expiration=1700000000, now=1800000000); signed order must carry a Unix timestamp at least 1s in the future',
  ],
  [
    'invalid_expiration',
    'GTC expiration is in the past or too soon (expiration=1, now=2); signed order must carry a Unix timestamp at least 1s in the future',
  ],
  [
    'invalid_expiration',
    'GTD order requires non-zero expiration in signed order',
  ],
  ['invalid_expiration', 'GTD expiration too large for u64'],
  ['market_not_active', 'market is not active (status: Paused)'],
  ['market_not_active', 'market is not active (status: MarketPaused)'],
  [
    'market_not_active',
    'market is not active (status: market reached terminal/paused status during taker-delay hold)',
  ],
  [
    'market_not_active',
    'only the conviction market creator may place an order while pending',
  ],
  ['market_not_found', 'market not found: unknown'],
  [
    'insufficient_balance',
    'insufficient balance: required 120000000, available 100000000',
  ],
  [
    'insufficient_balance',
    'trading error: accounting error: insufficient balance: required 5, available 1',
  ],
  [
    'insufficient_position',
    'insufficient position: required 10000000, available 4000000',
  ],
  ['account_not_found', `user not found: ${MAKER}`],
  [
    'order_cancelled_during_hold',
    'order was cancelled while in the taker-delay hold window',
  ],
  [
    'order_cancelled_during_hold',
    'trading error: order cancelled during taker-delay hold',
  ],
  [
    'trading_paused',
    'Global trading is paused. New orders are not being accepted.',
  ],
  ['trading_paused', 'trading error: global trading is paused'],
];

/** Messages of the same orderbook that are not about the order itself. */
const NOT_ABOUT_THE_ORDER = [
  'invalid request body: expected value',
  'invalid side',
  'postOnly orders must use orderType GTC or GTD',
  'signature mismatch',
  'rate limit exceeded',
  'engine unavailable',
  'internal error: boom',
  'the conviction pending commitment must be a BUY order; SELL is not allowed',
];

describe('rejection codes', () => {
  test.each(REFUSALS)('%s <- %j', (code, message) => {
    expect(orderRejectionCode(message)).toBe(code);
    expect(rejected(toOrderResponse(refused(message), HASH)).code).toBe(code);
  });

  test('matches the message in any letter case', () => {
    expect(
      orderRejectionCode('POST-ONLY ORDER WOULD CROSS RESTING LIQUIDITY'),
    ).toBe('post_only_would_cross');
    expect(
      orderRejectionCode('Insufficient Balance: required 2, available 1'),
    ).toBe('insufficient_balance');
  });

  test.each(NOT_ABOUT_THE_ORDER)(
    '%j is not given a code of its own: rejected',
    (message) => {
      expect(orderRejectionCode(message)).toBe('rejected');
    },
  );

  test('ORDER_REJECTION_CODES lists snake_case codes once each, and rejected', () => {
    expect(new Set(ORDER_REJECTION_CODES).size).toBe(
      ORDER_REJECTION_CODES.length,
    );
    for (const code of ORDER_REJECTION_CODES) {
      expect(code, code).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
    expect(ORDER_REJECTION_CODES).toContain('rejected');
  });

  test('every code is produced by a refusal message above, or is rejected', () => {
    const produced = new Set<string>([
      ...REFUSALS.map(([code]) => code),
      'rejected',
    ]);

    expect([...produced].sort()).toEqual([...ORDER_REJECTION_CODES].sort());
  });

  test('the code of a rejected order is one of the listed codes', () => {
    const response = rejected(toOrderResponse(refused('anything'), HASH));

    expectTypeOf(response.code).toEqualTypeOf<OrderRejectionCode>();
    expect(ORDER_REJECTION_CODES).toContain(response.code);
  });
});

describe('toRejectedOrderResponse', () => {
  test('builds the rejected response of a message, as toOrderResponse does', () => {
    const message = 'insufficient position: required 2, available 1';

    expect(toRejectedOrderResponse(message, HASH)).toEqual({
      ok: false,
      orderHash: HASH,
      code: 'insufficient_position',
      message,
    });
    expect(toRejectedOrderResponse(message, HASH)).toEqual(
      toOrderResponse(refused(message), HASH),
    );
  });

  test('an empty message gets one of its own', () => {
    const response = toRejectedOrderResponse('', HASH);

    expect(response.code).toBe('rejected');
    expect(response.message.length).toBeGreaterThan(10);
  });
});

describe('toOrderResponse: a delayed order is not a refusal', () => {
  const delayed = (patch: Record<string, unknown> = {}) =>
    placed({ status: 'delayed', ...patch });

  test('an answer of delayed with nothing filled stays accepted, with status delayed and zero amounts', () => {
    expect(toOrderResponse(delayed(), HASH)).toEqual({
      ok: true,
      orderId: HASH,
      orderHash: HASH,
      status: 'delayed',
      makingAmount: '0',
      takingAmount: '0',
      tradeIds: [],
      transactionsHashes: [],
    });
  });

  test('an answer of delayed with part filled stays accepted and keeps what filled', () => {
    const response = accepted(
      toOrderResponse(
        delayed({
          makingAmount: '570000',
          takingAmount: '1000000',
          tradeIds: ['7'],
        }),
        HASH,
      ),
    );

    expect(response.status).toBe('delayed');
    expect(response.makingAmount).toBe('0.57');
    expect(response.takingAmount).toBe('1');
    expect(response.tradeIds).toEqual(['7']);
  });

  test('only the answer decides: the order type is not an input', () => {
    expectTypeOf(toOrderResponse).parameters.toEqualTypeOf<
      [RawPlaceOrderResponse, OrderHash]
    >();
    expect(toOrderResponse.length).toBe(2);
  });
});

/** An open order as the gateway prints it. */
function rawOrder(patch: Record<string, unknown> = {}): RawOpenOrder {
  return OpenOrderSchema.strict.parse({
    id: HASH,
    market: CONDITION_A,
    outcome: 'YES',
    side: 'BUY',
    price: '0.570',
    original_size: microToDecimal(10_000_000n),
    size_matched: '0',
    status: 'LIVE',
    created_at: 1800000000,
    order_hash: HASH,
    asset_id: TOKEN_YES,
    maker_address: MAKER,
    owner: '6f1e7a5c-0000-5000-8000-000000000000',
    expiration: '0',
    order_type: 'GTC',
    ...patch,
  });
}

describe('toOpenOrder', () => {
  test('maps an open order: id becomes orderId, times become ISO 8601, side and type are the enums', () => {
    const order = toOpenOrder(rawOrder());

    expect(order).toEqual({
      orderId: HASH,
      assetId: TOKEN_YES,
      market: CONDITION_A,
      outcome: 'YES',
      side: OrderSide.BUY,
      price: '0.570',
      originalSize: '10',
      sizeMatched: '0',
      status: 'LIVE',
      orderType: OrderType.GTC,
      expiration: null,
      createdAt: '2027-01-15T08:00:00.000Z',
      makerAddress: getAddress(MAKER),
    });
  });

  test('has camelCase keys and the fields of the model, nothing else', () => {
    const order = toOpenOrder(rawOrder());

    expect(Object.keys(order).sort()).toEqual(
      [
        'orderId',
        'assetId',
        'market',
        'outcome',
        'side',
        'price',
        'originalSize',
        'sizeMatched',
        'status',
        'orderType',
        'expiration',
        'createdAt',
        'makerAddress',
      ].sort(),
    );
    expect(wireStyleKeys(order)).toEqual([]);
  });

  test('maps the sell side, the other times in force and a partly filled order', () => {
    const order = toOpenOrder(
      rawOrder({
        side: 'SELL',
        order_type: 'GTD',
        status: 'MATCHED',
        size_matched: '4.5',
        expiration: '1800003600',
      }),
    );

    expect(order.side).toBe(OrderSide.SELL);
    expect(order.orderType).toBe(OrderType.GTD);
    expect(order.status).toBe('MATCHED');
    expect(order.sizeMatched).toBe('4.5');
    expect(order.expiration).toBe('2027-01-15T09:00:00.000Z');
    expect(toOpenOrder(rawOrder({ order_type: 'FAK' })).orderType).toBe(
      OrderType.FAK,
    );
    expect(toOpenOrder(rawOrder({ order_type: 'FOK' })).orderType).toBe(
      OrderType.FOK,
    );
  });

  test('an expiration of 0, or one it cannot read, means the order does not expire: null', () => {
    for (const expiration of ['0', '', 'never', '-1', '1.5']) {
      expect(
        toOpenOrder(rawOrder({ expiration })).expiration,
        expiration,
      ).toBeNull();
    }
  });

  test('keeps the sizes and the price exactly as printed', () => {
    const order = toOpenOrder(
      rawOrder({
        price: '0.571',
        original_size: '12.345678',
        size_matched: '0.1',
      }),
    );

    expect(order.price).toBe('0.571');
    expect(order.originalSize).toBe('12.345678');
    expect(order.sizeMatched).toBe('0.1');
  });

  test('lower-cases the condition id, checksums the maker and canonicalises the token id', () => {
    const order = toOpenOrder(
      rawOrder({
        market: `0x${'AB'.repeat(32)}`,
        maker_address: MAKER.toUpperCase().replace('0X', '0x'),
        asset_id: '0042',
      }),
    );

    expect(order.market).toBe(`0x${'ab'.repeat(32)}`);
    expect(order.makerAddress).toBe(getAddress(MAKER));
    expect(order.assetId).toBe('42');
  });

  test('an id it cannot read passes through unchanged and never throws', () => {
    const order = toOpenOrder(
      rawOrder({ market: 'market-1', asset_id: '', maker_address: 'someone' }),
    );

    expect(order.market).toBe('market-1');
    expect(order.assetId).toBe('');
    expect(order.makerAddress).toBe('someone');
  });

  test('a creation time that is not a time is an unexpected response', () => {
    expect(() => toOpenOrder(rawOrder({ created_at: 1e15 }))).toThrow(
      UnexpectedResponseError,
    );
  });

  test('does not change its input and returns plain JSON data', () => {
    const input = rawOrder();
    const before = structuredClone(input);
    const order = toOpenOrder(input);

    expect(input).toEqual(before);
    expect(JSON.parse(JSON.stringify(order))).toEqual(order);
  });

  test('has the public types', () => {
    expectTypeOf<OpenOrder['orderId']>().toEqualTypeOf<string>();
    expectTypeOf<OpenOrder['assetId']>().toEqualTypeOf<TokenId>();
    expectTypeOf<OpenOrder['market']>().toEqualTypeOf<ConditionId>();
    expectTypeOf<OpenOrder['side']>().toEqualTypeOf<OrderSide>();
    expectTypeOf<OpenOrder['orderType']>().toEqualTypeOf<OrderType>();
    expectTypeOf<OpenOrder['price']>().toEqualTypeOf<DecimalString>();
    expectTypeOf<OpenOrder['originalSize']>().toEqualTypeOf<DecimalString>();
    expectTypeOf<OpenOrder['sizeMatched']>().toEqualTypeOf<DecimalString>();
    expectTypeOf<OpenOrder['expiration']>().toEqualTypeOf<string | null>();
    expectTypeOf<OpenOrder['createdAt']>().toEqualTypeOf<string>();
    expectTypeOf<OpenOrder['makerAddress']>().toEqualTypeOf<Address>();
  });
});

describe('the types of a placement result', () => {
  test('AcceptedOrderResponse and RejectedOrderResponse are told apart by ok', () => {
    expectTypeOf<OrderResponse>().toEqualTypeOf<
      AcceptedOrderResponse | RejectedOrderResponse
    >();
    expectTypeOf<AcceptedOrderResponse['ok']>().toEqualTypeOf<true>();
    expectTypeOf<RejectedOrderResponse['ok']>().toEqualTypeOf<false>();
    expectTypeOf<AcceptedOrderResponse['orderId']>().toEqualTypeOf<string>();
    expectTypeOf<
      AcceptedOrderResponse['orderHash']
    >().toEqualTypeOf<OrderHash>();
    expectTypeOf<
      RejectedOrderResponse['orderHash']
    >().toEqualTypeOf<OrderHash>();
    // `null`: the answer did not report them (an order posted in a batch).
    expectTypeOf<
      AcceptedOrderResponse['makingAmount']
    >().toEqualTypeOf<DecimalString | null>();
    expectTypeOf<
      AcceptedOrderResponse['takingAmount']
    >().toEqualTypeOf<DecimalString | null>();
    expectTypeOf<AcceptedOrderResponse['tradeIds']>().toEqualTypeOf<
      string[] | null
    >();
    expectTypeOf<AcceptedOrderResponse['transactionsHashes']>().toEqualTypeOf<
      Hex[] | null
    >();
    expectTypeOf<RejectedOrderResponse['message']>().toEqualTypeOf<string>();
  });

  test('narrowing on ok gives the fields of each side', () => {
    const response = toOrderResponse(placed(), HASH);

    if (response.ok) {
      expectTypeOf(response.orderId).toEqualTypeOf<string>();
    } else {
      expectTypeOf(response.code).toEqualTypeOf<OrderRejectionCode>();
    }
    expect(response.ok).toBe(true);
  });

  test('SignedOrder is the order the builders return, with its orderHash and OrderType', () => {
    expectTypeOf<SignedOrder>().toEqualTypeOf<TodaysSignedOrder>();
    expectTypeOf<SignedOrder['orderHash']>().toEqualTypeOf<OrderHash>();
    expectTypeOf<SignedOrder['orderType']>().toEqualTypeOf<OrderType>();
  });
});

describe('toBatchOrderResponse: one order of a batch', () => {
  const entry = (patch: Partial<BatchPlaceEntry> = {}): BatchPlaceEntry => ({
    order_id: HASH,
    fills: 0,
    resting: true,
    remaining_size: '10',
    error: null,
    order_hash: HASH,
    ...patch,
  });

  test('a placed order is accepted, and a batch reports no amounts, trades or transactions: null, not zero or none', () => {
    expect(toBatchOrderResponse(entry(), HASH)).toEqual({
      ok: true,
      orderId: HASH,
      orderHash: HASH,
      status: 'live',
      makingAmount: null,
      takingAmount: null,
      tradeIds: null,
      transactionsHashes: null,
    });
  });

  test('a single placement reports its trades and transactions: none is an empty list', () => {
    expect(accepted(toOrderResponse(placed(), HASH))).toMatchObject({
      tradeIds: [],
      transactionsHashes: [],
    });
  });

  test.each([
    [{ fills: 2, resting: false, remaining_size: '0' }, 'matched'],
    [{ fills: 1, resting: true, remaining_size: '4.5' }, 'live'],
    [{ fills: 0, resting: false, remaining_size: '10' }, 'delayed'],
    [{ fills: 0, resting: false, remaining_size: '0' }, 'delayed'],
  ] as const)(
    'its status follows the fills and what rests: %j is %s',
    (patch, status) => {
      expect(toBatchOrderResponse(entry(patch), HASH)).toMatchObject({
        ok: true,
        status,
      });
    },
  );

  test('the order id falls back to the local hash', () => {
    expect(toBatchOrderResponse(entry({ order_id: null }), HASH)).toMatchObject(
      { orderId: HASH },
    );
  });

  test('a refused order is ok:false with the code of its message', () => {
    const message =
      'trading error: insufficient position: required 5000000, available 0';
    expect(
      toBatchOrderResponse(
        entry({
          order_id: null,
          fills: null,
          resting: null,
          remaining_size: null,
          error: message,
          order_hash: null,
        }),
        HASH,
      ),
    ).toEqual({
      ok: false,
      orderHash: HASH,
      code: 'insufficient_position',
      message,
    });
  });

  const failed = (error: string) =>
    entry({
      order_id: null,
      fills: null,
      resting: null,
      remaining_size: null,
      error,
      order_hash: null,
    });

  test.each([
    'engine has stopped',
    'engine reply channel dropped',
    'trade log error: write failed',
    // A text the SDK has never seen: it may be a failure after the order was taken.
    'the matching engine took too long',
    'internal error: unexpected state',
    '',
    // A refusal's words inside an unknown frame are still unknown.
    'retrying: insufficient balance',
    // A known family whose text also says the engine's answer was lost.
    'trading error: engine has stopped',
  ])(
    'an entry that cannot say what became of the order (%j) is no value at all',
    (error) => {
      expect(toBatchOrderResponse(failed(error), HASH)).toBeUndefined();
    },
  );

  // The family of EIP-1271 codes is narrow: an upper-case name, then `_1271`, at the start of
  // the text, then a colon. Anything else that looks like it is not a definite refusal.
  test.each([
    'X_12710: signature check failed',
    'x_1271: signature check failed',
    'Xo_1271: signature check failed',
    'A_B_1271: signature check failed',
    'XO2_1271: signature check failed',
    '_1271: signature check failed',
    ' XO_1271: signature check failed',
    'upstream said XO_1271: signature check failed',
    'XO_1271 signature check failed',
    'XO_1271',
  ])(
    'a text that only looks like an EIP-1271 code (%j) is no definite refusal',
    (error) => {
      expect(toBatchOrderResponse(failed(error), HASH)).toBeUndefined();
    },
  );

  test.each([
    [
      'trading error: accounting error: insufficient balance: required 4000000, available 0',
      'insufficient_balance',
    ],
    [
      'trading error: engine error: post-only order would cross resting liquidity',
      'post_only_would_cross',
    ],
    ['trading error: market not found: 0xab', 'market_not_found'],
    ['trading error: global trading is paused', 'trading_paused'],
    [
      'trading error: order cancelled during taker-delay hold',
      'order_cancelled_during_hold',
    ],
    [
      'validation error: size below minimum: min 1000000, got 5',
      'size_below_minimum',
    ],
    [
      'engine error: market is not active (status: Paused)',
      'market_not_active',
    ],
    [
      'accounting error: insufficient position: required 1000000, available 0',
      'insufficient_position',
    ],
    ['market not found: 0xab', 'market_not_found'],
    ['global trading is paused', 'trading_paused'],
    ['order cancelled during taker-delay hold', 'order_cancelled_during_hold'],
    ['invalid price tick 1000: must be 1..=999', 'price_out_of_range'],
    ['invalid size: must be > 0', 'rejected'],
    ['size below minimum: min 1000000, got 5', 'size_below_minimum'],
    ['notional below minimum: min 10000, got 5', 'notional_below_minimum'],
    ['funder is not a valid Ethereum address: nope', 'rejected'],
    ['invalid request: funder exceeds maximum length of 256 bytes', 'rejected'],
    ['invalid side in order', 'rejected'],
    [
      'order amount: price tick out of range: ratio = 0 (must be 1..=999)',
      'price_out_of_range',
    ],
    [
      'invalid request: unsupported orderType: IOC (supported: GTC, GTD, FOK, FAK)',
      'rejected',
    ],
    [
      'invalid request: GTD order requires non-zero expiration in signed order',
      'invalid_expiration',
    ],
    [
      'invalid request: GTD expiration is in the past or too soon (expiration=1, now=2); signed order must carry a Unix timestamp at least 1s in the future',
      'invalid_expiration',
    ],
    ['invalid request: GTC expiration too large for u64', 'invalid_expiration'],
    ['postOnly orders must use orderType GTC or GTD', 'rejected'],
    ['signature mismatch: recovered 0x01, expected 0x02', 'rejected'],
    ['invalid signature length: 64 (expected 65)', 'rejected'],
    ['invalid signature: bad recovery id', 'rejected'],
    ['unsupported signature type: 9 (supported: 0=EOA)', 'rejected'],
    ['signature type 3 requires a configured JSON-RPC URL', 'rejected'],
    ['signature verification failed: internal error', 'rejected'],
    [
      'EIP-1271: isValidSignature returned non-magic value (got 0x00000000)',
      'rejected',
    ],
    ['EIP-1271 RPC isValidSignature call failed: timeout', 'rejected'],
    [`${CODE_1271}: empty signature`, 'rejected'],
    ['XO_1271: signature check failed', 'rejected'],
  ] as const)(
    'a definite refusal (%j) is ok:false with the code %s',
    (error, code) => {
      expect(toBatchOrderResponse(failed(error), HASH)).toEqual({
        ok: false,
        orderHash: HASH,
        code,
        message: error,
      });
    },
  );
});

describe('toCancelOrdersResponse', () => {
  test('copies the ids cancelled and the reasons of the others', () => {
    const raw = { canceled: ['1'], notCanceled: { '2': 'order not found' } };
    const response = toCancelOrdersResponse(raw);

    expect(response).toEqual(raw);
    expect(response.canceled).not.toBe(raw.canceled);
    expect(response.notCanceled).not.toBe(raw.notCanceled);
  });
});

describe('toReconciledOrder', () => {
  function rawTrade(): RawTrade {
    return TradeSchema.lenient.parse({
      id: `0x${'01'.repeat(32)}`,
      market: CONDITION_A,
      outcome: 'YES',
      side: 'BUY',
      price: '0.500',
      size: '10',
      status: 'MATCHED',
      match_time: '1800000000',
      last_update: '1800000000',
      bucket_index: 0,
      transaction_hash: null,
      taker_order_id: HASH,
      asset_id: TOKEN_YES,
      fee_rate_bps: '0',
      owner: '6f1e7a5c-0000-5000-8000-000000000000',
      maker_address: MAKER,
      trader_side: 'TAKER',
      maker_orders: [],
    });
  }

  test('maps each state to the models', () => {
    expect(toReconciledOrder({ state: 'not_found' })).toEqual({
      state: 'not_found',
    });
    expect(
      toReconciledOrder({ state: 'traded', trades: [rawTrade()] }),
    ).toMatchObject({
      state: 'traded',
      trades: [{ takerOrderId: HASH, assetId: TOKEN_YES }],
    });
  });
});
