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
import { BridgeClient } from '../../src/bridge/client';
import {
  compareDecimal,
  landedAfterPost,
  readBridgeAmount,
} from '../../src/bridge/internal';
import type { BridgeQuotes } from '../../src/bridge/schemas';
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
import type { ResponseIssue } from '../../src/core/schema';
import { Transport, wasNotSent } from '../../src/core/transport';
import { API_KEY, caught } from '../helpers/dataRig';
import { exceptionResponse } from '../helpers/mockBackend';
import {
  ACCEPT_BY,
  BASE_USDC,
  type BridgeBackend,
  type BridgeRequest,
  bridgeRig,
  ETH_USDT,
  expectNoRequest,
  RECIPIENT,
  XO_USDC_ASSET,
} from '../helpers/mockBridge';
import { eoaIdentity } from '../helpers/railChain';
import { rejectedWith, serverFailure } from '../helpers/rejections';
import { testEnv } from '../helpers/testEnv';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

const PATH = '/api/bridge/halliday/quotes';

/** The JSON body of the one request the fake has recorded. */
function sentBody(backend: BridgeBackend): Record<string, string> {
  expect(backend.requests).toHaveLength(1);
  return (backend.requests[0] as BridgeRequest).body as Record<string, string>;
}

const FEES = {
  total: '0.2',
  conversion: '0.1',
  network: '0.06',
  business: '0.04',
  currency: 'USD',
};

/** `{ data: { quotes, acceptBy, limits } }` as the backend sends it, with one option per output. */
function quoteAnswer(
  outputs: string[],
  over: { data?: Record<string, unknown> } = {},
) {
  return {
    data: {
      quotes: outputs.map((amount, i) => ({
        paymentId: `pay_o${i}`,
        input: { asset: BASE_USDC, amount: '10' },
        output: { asset: XO_USDC_ASSET, amount },
        fees: FEES,
        latencySeconds: i === 0 ? null : 30 * i,
      })),
      acceptBy: ACCEPT_BY,
      limits: [{ min: '1', max: null }],
      ...over.data,
    },
  };
}

describe('quoteDeposit', () => {
  test('sends POST /quotes { direction, asset, amount } with the session key, and no recipient', async () => {
    const { bridge, backend } = bridgeRig(server);
    await bridge.quoteDeposit({ asset: BASE_USDC, amount: '25.5' });

    expect(backend.requests).toEqual([
      {
        method: 'POST',
        path: PATH,
        query: {},
        body: { direction: 'deposit', asset: BASE_USDC, amount: '25.5' },
        authorization: `Bearer ${API_KEY}`,
        sdk: 'ts/9.9.9',
      },
    ]);
    expect(Object.keys(backend.requests[0]?.body as object).sort()).toEqual([
      'amount',
      'asset',
      'direction',
    ]);
  });

  test('returns the quotes, the deadline and the limits; every quote carries its direction and the deadline', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.override('quotes', () =>
      HttpResponse.json(quoteAnswer(['20', '10'])),
    );
    const answer: BridgeQuotes = await bridge.quoteDeposit({
      asset: BASE_USDC,
      amount: '10',
    });

    expect(answer).toEqual({
      quotes: [
        {
          paymentId: 'pay_o0',
          direction: 'deposit',
          input: { asset: BASE_USDC, amount: '10' },
          output: { asset: XO_USDC_ASSET, amount: '20' },
          fees: FEES,
          latencySeconds: null,
          acceptBy: ACCEPT_BY,
        },
        {
          paymentId: 'pay_o1',
          direction: 'deposit',
          input: { asset: BASE_USDC, amount: '10' },
          output: { asset: XO_USDC_ASSET, amount: '10' },
          fees: FEES,
          latencySeconds: 30,
          acceptBy: ACCEPT_BY,
        },
      ],
      acceptBy: ACCEPT_BY,
      limits: [{ min: '1', max: null }],
    });
  });

  test("the default test backend's answer reaches the caller as it is, plus direction and acceptBy", async () => {
    const { bridge, backend } = bridgeRig(server);
    const answer = await bridge.quoteDeposit({
      asset: ETH_USDT,
      amount: '5',
    });
    // The fake answers latencies 30 and 60 with the same output amount: the order is kept.
    expect(answer.quotes.map((quote) => quote.paymentId)).toEqual([
      'pay_q1',
      'pay_q2',
    ]);
    expect(answer.limits).toEqual([backend.fixtures.limits]);
    expect(answer.acceptBy).toBe(ACCEPT_BY);
    for (const quote of answer.quotes) {
      expect(quote.direction).toBe('deposit');
      expect(quote.acceptBy).toBe(ACCEPT_BY);
      expect(quote.input).toEqual({ asset: ETH_USDT, amount: '5' });
      expect(quote.output).toEqual({ asset: XO_USDC_ASSET, amount: '5' });
    }
  });

  test('sorts the quotes by output amount, largest first, as numbers and not as text', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.override('quotes', () =>
      HttpResponse.json(quoteAnswer(['9.5', '10.01', '10.1'])),
    );
    const { quotes } = await bridge.quoteDeposit({
      asset: BASE_USDC,
      amount: '10',
    });
    expect(quotes.map((quote) => quote.output.amount)).toEqual([
      '10.1',
      '10.01',
      '9.5',
    ]);
    // The options travel with their own payment ids.
    expect(quotes.map((quote) => quote.paymentId)).toEqual([
      'pay_o2',
      'pay_o1',
      'pay_o0',
    ]);
  });

  test('sorts exactly: amounts that a float cannot tell apart, and the same value at different scales', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.override('quotes', () =>
      HttpResponse.json(
        quoteAnswer([
          '1000000000000000.000000000000000001',
          '1000000000000000.000000000000000002',
          '1000000000000000.0000000000000000010',
          '999999999999999.999999999999999999',
        ]),
      ),
    );
    const { quotes } = await bridge.quoteDeposit({
      asset: BASE_USDC,
      amount: '10',
    });
    expect(quotes.map((quote) => quote.paymentId)).toEqual([
      'pay_o1',
      // Equal values keep the backend's order.
      'pay_o0',
      'pay_o2',
      'pay_o3',
    ]);
  });

  test('an answer with no option is an answer with no option', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.override('quotes', () => HttpResponse.json(quoteAnswer([])));
    expect(
      (await bridge.quoteDeposit({ asset: BASE_USDC, amount: '10' })).quotes,
    ).toEqual([]);
  });

  test('a stray key is refused: a deposit takes no recipient', async () => {
    const { bridge, backend } = bridgeRig(server);
    const error = await caught(() =>
      bridge.quoteDeposit({
        asset: BASE_USDC,
        amount: '10',
        recipient: RECIPIENT,
      } as never),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as XoError).code).toBe('invalid_input');
    expect((error as XoError).mayHaveLanded).toBe(false);
    expectNoRequest(backend);
  });

  test.each([undefined, null, 'asset', 5, []])(
    'options %j → UserInputError, mayHaveLanded false, and no request',
    async (bad) => {
      const { bridge, backend } = bridgeRig(server);
      const error = await caught(() => bridge.quoteDeposit(bad as never));
      expect(error).toBeInstanceOf(UserInputError);
      expect((error as XoError).mayHaveLanded).toBe(false);
      expectNoRequest(backend);
    },
  );
});

describe('quoteWithdraw', () => {
  test('sends POST /quotes { direction, asset, amount, recipient }', async () => {
    const { bridge, backend } = bridgeRig(server);
    await bridge.quoteWithdraw({
      asset: BASE_USDC,
      amount: '10',
      recipient: RECIPIENT,
    });
    expect(backend.requests).toEqual([
      {
        method: 'POST',
        path: PATH,
        query: {},
        body: {
          direction: 'withdraw',
          asset: BASE_USDC,
          amount: '10',
          recipient: RECIPIENT,
        },
        authorization: `Bearer ${API_KEY}`,
        sdk: 'ts/9.9.9',
      },
    ]);
  });

  test('returns quotes that carry the withdraw direction, sorted the same way', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.override('quotes', () =>
      HttpResponse.json(quoteAnswer(['9.5', '10.1'])),
    );
    const answer = await bridge.quoteWithdraw({
      asset: BASE_USDC,
      amount: '10',
      recipient: RECIPIENT,
    });
    expect(answer.quotes.map((quote) => quote.output.amount)).toEqual([
      '10.1',
      '9.5',
    ]);
    for (const quote of answer.quotes) {
      expect(quote.direction).toBe('withdraw');
      expect(quote.acceptBy).toBe(ACCEPT_BY);
    }
  });

  test('every quote carries the recipient it was asked for, as it was given (withdraw() checks the payment against it)', async () => {
    const { bridge } = bridgeRig(server);
    const odd = ' 0xAbCdEf0000000000000000000000000000000001';
    const answer = await bridge.quoteWithdraw({
      asset: BASE_USDC,
      amount: '10',
      recipient: odd,
    });
    expect(answer.quotes).toHaveLength(2);
    for (const quote of answer.quotes) {
      expect(quote.recipient).toBe(odd);
    }
  });

  test('a deposit quote has no recipient', async () => {
    const { bridge } = bridgeRig(server);
    const answer = await bridge.quoteDeposit({
      asset: BASE_USDC,
      amount: '10',
    });
    for (const quote of answer.quotes) {
      expect(Object.hasOwn(quote, 'recipient')).toBe(false);
    }
  });

  test('the recipient is sent as it was given: not trimmed, not lower-cased, not checksummed', async () => {
    const { bridge, backend } = bridgeRig(server);
    const odd = '0xAbCdEf0000000000000000000000000000000001';
    await bridge.quoteWithdraw({
      asset: BASE_USDC,
      amount: '10',
      recipient: odd,
    });
    expect(sentBody(backend).recipient).toBe(odd);
  });

  test.each([
    ['empty', ''],
    ['blank', '   '],
    ['missing', undefined],
    ['null', null],
    ['a number', 5],
    ['an object', {}],
    ['longer than 128 characters', 'a'.repeat(129)],
  ])(
    'a recipient that is %s → UserInputError, mayHaveLanded false, and no request',
    async (_, recipient) => {
      const { bridge, backend } = bridgeRig(server);
      const error = await caught(() =>
        bridge.quoteWithdraw({
          asset: BASE_USDC,
          amount: '10',
          recipient: recipient as never,
        }),
      );
      expect(error).toBeInstanceOf(UserInputError);
      expect((error as XoError).code).toBe('invalid_input');
      expect((error as XoError).mayHaveLanded).toBe(false);
      expect((error as XoError).message).toContain('recipient');
      expectNoRequest(backend);
    },
  );

  test('a recipient of exactly 128 characters is sent', async () => {
    const { bridge, backend } = bridgeRig(server);
    await bridge.quoteWithdraw({
      asset: BASE_USDC,
      amount: '10',
      recipient: 'a'.repeat(128),
    });
    expect(backend.requests).toHaveLength(1);
  });
});

describe('amounts', () => {
  test.each([
    [5, '5'],
    [0.5, '0.5'],
    [25.5, '25.5'],
    [1e20, '100000000000000000000'],
    ['5', '5'],
    ['0.000001', '0.000001'],
    ['10.50', '10.50'],
    [`0.${'1'.repeat(36)}`, `0.${'1'.repeat(36)}`],
  ])('amount %j is sent as the string %j', async (amount, sent) => {
    const { bridge, backend } = bridgeRig(server);
    // The fake's range check is not what this test is about.
    backend.fixtures.limits = { min: null, max: null };
    await bridge.quoteDeposit({ asset: BASE_USDC, amount });
    expect(backend.requests).toHaveLength(1);
    expect(sentBody(backend).amount).toBe(sent);
  });

  test('0.1 + 0.2 is sent as its exact string form: String() prints 17 decimals, which the backend takes', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.fixtures.limits = { min: null, max: null };
    expect(String(0.1 + 0.2)).toBe('0.30000000000000004');
    await bridge.quoteDeposit({ asset: BASE_USDC, amount: 0.1 + 0.2 });
    expect(sentBody(backend).amount).toBe('0.30000000000000004');
  });

  test.each([
    ['1e-7', 1e-7],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['NaN', Number.NaN],
    ['1e21, which prints as an exponent', 1e21],
    ['a negative number', -5],
    ['zero', 0],
    ['negative zero', -0],
    ['the string "0"', '0'],
    ['the string "0.0"', '0.0'],
    ['the string "0.000"', '0.000'],
    ['a string with a leading zero', '01'],
    ['a string with two leading zeros', '00.5'],
    ['an empty string', ''],
    ['a bare dot', '.'],
    ['a string with no whole part', '.5'],
    ['a string with no fraction digits', '5.'],
    ['a signed string', '-1'],
    ['a plus-signed string', '+1'],
    ['a string with an exponent', '1e3'],
    ['a string with a space', ' 1'],
    ['a string with a trailing space', '1 '],
    ['a string with a comma', '1,5'],
    ['a string with 37 fraction digits', `0.${'1'.repeat(37)}`],
    ['a string longer than 80 characters', `1${'0'.repeat(80)}`],
    ['null', null],
    ['undefined', undefined],
    ['a bigint', 5n],
    ['a boolean', true],
    ['an object', {}],
    ['an array', ['5']],
  ])(
    'amount %s → UserInputError invalid_input, mayHaveLanded false, and no request',
    async (_, amount) => {
      const { bridge, backend } = bridgeRig(server);
      const deposit = await caught(() =>
        bridge.quoteDeposit({ asset: BASE_USDC, amount: amount as never }),
      );
      expect(deposit).toBeInstanceOf(UserInputError);
      expect((deposit as XoError).code).toBe('invalid_input');
      expect((deposit as XoError).mayHaveLanded).toBe(false);
      expect((deposit as XoError).message).toContain('amount');

      const withdraw = await caught(() =>
        bridge.quoteWithdraw({
          asset: BASE_USDC,
          amount: amount as never,
          recipient: RECIPIENT,
        }),
      );
      expect(withdraw).toBeInstanceOf(UserInputError);
      expect((withdraw as XoError).code).toBe('invalid_input');
      expectNoRequest(backend);
    },
  );

  test('a message never holds the amount that was refused', async () => {
    const { bridge } = bridgeRig(server);
    const error = await caught(() =>
      bridge.quoteDeposit({ asset: BASE_USDC, amount: '12345.678e9' }),
    );
    expect((error as XoError).message).not.toContain('12345');
  });

  test('readBridgeAmount: the grammar of the backend DTO, and a digit other than zero', () => {
    expect(readBridgeAmount('1')).toBe('1');
    expect(readBridgeAmount('0.0000000001')).toBe('0.0000000001');
    expect(readBridgeAmount(7)).toBe('7');
    expect(readBridgeAmount(1234.5)).toBe('1234.5');
    expect(readBridgeAmount(`${'9'.repeat(80)}`)).toBe('9'.repeat(80));
    expect(() => readBridgeAmount('9'.repeat(81))).toThrow(UserInputError);
    expect(() => readBridgeAmount('0')).toThrow(UserInputError);
    expect(() => readBridgeAmount(1e-7)).toThrow(UserInputError);
  });
});

describe('assets', () => {
  test.each([
    ['empty', ''],
    ['a bare symbol', 'USDC'],
    [
      'an address with no network',
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    ],
    ['a network with no address', 'base:'],
    [
      'an upper-case network',
      'Base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    ],
    ['a path', 'base:../assets'],
    ['longer than 128 characters', `base:${'a'.repeat(125)}`],
    ['missing', undefined],
    ['null', null],
    ['a number', 5],
    ['an object', {}],
  ])(
    'an asset that is %s → UserInputError, mayHaveLanded false, and no request',
    async (_, asset) => {
      const { bridge, backend } = bridgeRig(server);
      const error = await caught(() =>
        bridge.quoteDeposit({ asset: asset as never, amount: '5' }),
      );
      expect(error).toBeInstanceOf(UserInputError);
      expect((error as XoError).code).toBe('invalid_input');
      expect((error as XoError).mayHaveLanded).toBe(false);
      expect((error as XoError).message).toContain('asset');
      expectNoRequest(backend);
    },
  );

  test('an asset the SDK has never heard of is not judged: the backend decides (asset_not_supported)', async () => {
    const { bridge, backend } = bridgeRig(server);
    const error = await caught(() =>
      bridge.quoteDeposit({ asset: 'polygon:0xdeadbeef', amount: '5' }),
    );
    expect(error).toSatisfy(rejectedWith(400));
    expect((error as XoError).code).toBe('asset_not_supported');
    expect(backend.requests).toHaveLength(1);
  });
});

describe('the gate and the credentials', () => {
  test('a config without a bridge: the gate comes first, before the input is looked at and before the credential check', async () => {
    const { bridge, backend } = bridgeRig(server, {
      env: testEnv,
      session: 'none',
    });
    for (const run of [
      () => bridge.quoteDeposit({ asset: 5, amount: 'x' } as never),
      () => bridge.quoteWithdraw(undefined as never),
    ]) {
      const error = await caught(run);
      expect((error as XoError).code).toBe('bridge_not_available');
      expect((error as XoError).mayHaveLanded).toBe(false);
    }
    expectNoRequest(backend);
  });

  test('a bad input is refused before the credential check', async () => {
    const { bridge, backend } = bridgeRig(server, { session: 'none' });
    const error = await caught(() =>
      bridge.quoteDeposit({ asset: BASE_USDC, amount: '0' }),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expectNoRequest(backend);
  });

  test('a session with neither a signer nor a key → AuthRequiredError, mayHaveLanded false, and no request', async () => {
    const { bridge, backend } = bridgeRig(server, { session: 'none' });
    const deposit = await caught(() =>
      bridge.quoteDeposit({ asset: BASE_USDC, amount: '5' }),
    );
    const withdraw = await caught(() =>
      bridge.quoteWithdraw({
        asset: BASE_USDC,
        amount: '5',
        recipient: RECIPIENT,
      }),
    );
    for (const error of [deposit, withdraw]) {
      expect(error).toBeInstanceOf(AuthRequiredError);
      expect((error as XoError).mayHaveLanded).toBe(false);
    }
    expectNoRequest(backend);
  });
});

describe('the backend says no', () => {
  test('400 asset_not_supported → a 400 RequestRejectedError with that code, mayHaveLanded false', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.fixtures.assets.deposit = [];
    const error = await caught(() =>
      bridge.quoteDeposit({ asset: BASE_USDC, amount: '5' }),
    );
    expect(error).toSatisfy(rejectedWith(400));
    const xo = error as XoError;
    expect(xo.code).toBe('asset_not_supported');
    expect(xo.status).toBe(400);
    expect(xo.service).toBe('backend');
    // A refusal for sure: no quote row was stored.
    expect(xo.mayHaveLanded).toBe(false);
    expect(backend.requests).toHaveLength(1);
  });

  test('400 amount_out_of_range and recipient_invalid keep their codes, mayHaveLanded false', async () => {
    const { bridge, backend } = bridgeRig(server);
    const range = await caught(() =>
      bridge.quoteDeposit({ asset: BASE_USDC, amount: '0.0001' }),
    );
    expect(range).toSatisfy(rejectedWith(400));
    expect((range as XoError).code).toBe('amount_out_of_range');
    expect((range as XoError).mayHaveLanded).toBe(false);

    backend.override('quotes', ({ request }) =>
      exceptionResponse(request.path, 400, {
        error: 'recipient_invalid',
        message: 'That is not an address on base',
      }),
    );
    const recipient = await caught(() =>
      bridge.quoteWithdraw({
        asset: BASE_USDC,
        amount: '5',
        recipient: 'not-an-address',
      }),
    );
    expect(recipient).toSatisfy(rejectedWith(400));
    expect((recipient as XoError).code).toBe('recipient_invalid');
    expect((recipient as XoError).mayHaveLanded).toBe(false);
  });

  test('503 from the bridge provider → 5xx rejection bridge_unavailable, mayHaveLanded true: quote rows may exist', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.override('quotes', ({ request }) =>
      exceptionResponse(request.path, 503, {
        error: 'halliday_unavailable',
        message: 'down',
      }),
    );
    const error = await caught(() =>
      bridge.quoteDeposit({ asset: BASE_USDC, amount: '5' }),
    );
    expect(error).toSatisfy(serverFailure);
    expect((error as XoError).code).toBe('bridge_unavailable');
    expect((error as XoError).mayHaveLanded).toBe(true);
  });

  test('a quote is posted once, however many retries the transport allows', async () => {
    const { bridge, backend } = bridgeRig(server, { maxRetries: 3 });
    backend.override('quotes', ({ request }) =>
      exceptionResponse(request.path, 503, {
        error: 'halliday_unavailable',
        message: 'down',
      }),
    );
    await caught(() => bridge.quoteDeposit({ asset: BASE_USDC, amount: '5' }));
    expect(backend.requests).toHaveLength(1);
  });

  test('a 4xx that is not a validation error is mayHaveLanded false too (404, 409, 429)', async () => {
    for (const [status, cls, code] of [
      [404, RequestRejectedError, 'bridge_not_available'],
      [409, RequestRejectedError, 'quote_conflict'],
      [429, RateLimitError, 'rate_limited'],
    ] as const) {
      const { bridge, backend } = bridgeRig(server);
      backend.override('quotes', ({ request }) =>
        exceptionResponse(request.path, status, { error: code, message: 'no' }),
      );
      const error = await caught(() =>
        bridge.quoteDeposit({ asset: BASE_USDC, amount: '5' }),
      );
      expect(error).toBeInstanceOf(cls);
      expect((error as XoError).mayHaveLanded).toBe(false);
    }
  });

  test('a lost connection → TransportError, mayHaveLanded true', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.override('quotes', () => HttpResponse.error());
    const error = await caught(() =>
      bridge.quoteDeposit({ asset: BASE_USDC, amount: '5' }),
    );
    expect(error).toBeInstanceOf(TransportError);
    expect((error as XoError).mayHaveLanded).toBe(true);
  });

  test('a timeout → TimeoutError, mayHaveLanded true', async () => {
    const rig = bridgeRig(server);
    const transport = new Transport({
      env: rig.env,
      version: '9.9.9',
      maxRetries: 0,
      defaultTimeoutMs: 40,
    });
    transport.setAuth(rig.session);
    const bridge = new BridgeClient({
      env: rig.env,
      transport,
      session: rig.session,
      identity: async () => eoaIdentity(),
      chain: rig.chain.reader,
      account: rig.account,
    });
    rig.backend.override('quotes', async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return HttpResponse.json(quoteAnswer(['5']));
    });
    const error = await caught(() =>
      bridge.quoteDeposit({ asset: BASE_USDC, amount: '5' }),
    );
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as XoError).mayHaveLanded).toBe(true);
  });
});

describe('response checks', () => {
  test.each([
    ['acceptBy', (data: Record<string, unknown>) => delete data.acceptBy],
    ['limits', (data: Record<string, unknown>) => delete data.limits],
    [
      'quotes.0.paymentId',
      (data: Record<string, unknown>) =>
        delete (data.quotes as Array<Record<string, unknown>>)[0]?.paymentId,
    ],
    [
      'quotes.0.fees',
      (data: Record<string, unknown>) =>
        delete (data.quotes as Array<Record<string, unknown>>)[0]?.fees,
    ],
    [
      'quotes.0.latencySeconds',
      (data: Record<string, unknown>) =>
        delete (data.quotes as Array<Record<string, unknown>>)[0]
          ?.latencySeconds,
    ],
  ])(
    'a missing %s → UnexpectedResponseError naming it, mayHaveLanded true: the quotes were stored',
    async (path, remove) => {
      const { bridge, backend } = bridgeRig(server);
      backend.override('quotes', () => {
        const body = quoteAnswer(['5']);
        remove(body.data);
        return HttpResponse.json(body);
      });
      const error = await caught(() =>
        bridge.quoteDeposit({ asset: BASE_USDC, amount: '5' }),
      );
      expect(error).toBeInstanceOf(UnexpectedResponseError);
      const failure = error as UnexpectedResponseError;
      expect(failure.service).toBe('backend');
      expect(
        (failure.issues as ResponseIssue[]).map((issue) => issue.path),
      ).toEqual([`data.${path}`]);
      expect(failure.message).toContain(PATH);
      expect(failure.mayHaveLanded).toBe(true);
    },
  );

  test('an amount that is not a decimal → UnexpectedResponseError: it cannot be sorted or sent on', async () => {
    const { bridge, backend } = bridgeRig(server);
    for (const bad of ['about 5', '', '1,5', '.', '--1']) {
      backend.override('quotes', () => HttpResponse.json(quoteAnswer([bad])));
      const error = await caught(() =>
        bridge.quoteDeposit({ asset: BASE_USDC, amount: '5' }),
      );
      expect(error).toBeInstanceOf(UnexpectedResponseError);
      expect((error as XoError).mayHaveLanded).toBe(true);
    }
  });

  test('an amount in exponent form is written out exactly, so it sorts as the number it is', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.override('quotes', () =>
      HttpResponse.json(quoteAnswer(['1e-7', '1.5e1', '9'])),
    );
    const { quotes } = await bridge.quoteDeposit({
      asset: BASE_USDC,
      amount: '5',
    });
    expect(quotes.map((quote) => quote.output.amount)).toEqual([
      '15',
      '9',
      '0.0000001',
    ]);
  });

  test('an answer that is not wrapped in { data } → UnexpectedResponseError', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.override('quotes', () =>
      HttpResponse.json(quoteAnswer(['5']).data),
    );
    const error = await caught(() =>
      bridge.quoteDeposit({ asset: BASE_USDC, amount: '5' }),
    );
    expect(error).toBeInstanceOf(UnexpectedResponseError);
  });

  test('an unknown field is kept in lenient mode and refused in strict mode', async () => {
    const answer = quoteAnswer(['5']);
    (answer.data.quotes[0] as Record<string, unknown>).routeId = 'r1';

    const lenient = bridgeRig(server);
    lenient.backend.override('quotes', () => HttpResponse.json(answer));
    const kept = await lenient.bridge.quoteDeposit({
      asset: BASE_USDC,
      amount: '5',
    });
    expect(kept.quotes[0]).toMatchObject({ routeId: 'r1' });

    const strict = bridgeRig(server, { strict: true });
    strict.backend.override('quotes', () => HttpResponse.json(answer));
    const error = await caught(() =>
      strict.bridge.quoteDeposit({ asset: BASE_USDC, amount: '5' }),
    );
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(
      ((error as UnexpectedResponseError).issues as ResponseIssue[]).map(
        (issue) => issue.code,
      ),
    ).toEqual(['unrecognized_keys']);
  });

  test('strict mode accepts the backend answer as it is', async () => {
    const { bridge } = bridgeRig(server, { strict: true });
    const answer = await bridge.quoteDeposit({ asset: BASE_USDC, amount: '5' });
    expect(answer.quotes).toHaveLength(2);
  });
});

describe('compareDecimal', () => {
  test.each([
    ['1', '1', 0],
    ['1.0', '1', 0],
    ['1', '1.0', 0],
    ['1.000', '1.0', 0],
    ['0', '0.0', 0],
    ['0', '-0', 0],
    ['10.10', '10.1', 0],
    ['2', '10', -1],
    ['10', '2', 1],
    ['9.5', '10.01', -1],
    ['10.01', '10.1', -1],
    ['10.1', '10.01', 1],
    ['0.9', '0.10', 1],
    ['0.000001', '0.0000001', 1],
    ['0', '0.000000000000000000000000000000000001', -1],
    ['-1', '1', -1],
    ['-1', '-2', 1],
    ['-0.5', '0', -1],
    // Wider than a double, and wider than 2^53 in the whole part.
    ['9007199254740993', '9007199254740992', 1],
    ['0.30000000000000004', '0.3', 1],
    [
      '123456789012345678901234567890.5',
      '123456789012345678901234567890.49',
      1,
    ],
    ['1000000000000000.000000000000000001', '1000000000000000', 1],
  ])('compareDecimal(%j, %j) is %i', (a, b, expected) => {
    expect(compareDecimal(a, b)).toBe(expected);
  });

  test('is antisymmetric', () => {
    for (const [a, b] of [
      ['1.5', '1.49'],
      ['0.1', '0.10001'],
      ['12', '12.0'],
    ] as const) {
      expect(compareDecimal(a, b)).toBe(-compareDecimal(b, a) || 0);
    }
  });

  test.each(['', '.', '1.', '.5', '1e3', '1,5', ' 1', 'abc', '--1', '+1'])(
    'compareDecimal(%j, "1") refuses text that is not a plain decimal',
    (bad) => {
      expect(() => compareDecimal(bad, '1')).toThrow(UserInputError);
      expect(() => compareDecimal('1', bad)).toThrow(UserInputError);
    },
  );
});

describe('landedAfterPost', () => {
  const sdkError = (status?: number) =>
    new XoError('m', { status, service: 'backend' });

  test.each([
    ['a 400', new RequestRejectedError('m', { status: 400 }), false],
    ['a 401', sdkError(401), false],
    [
      'a 404',
      new RequestRejectedError('m', { code: 'not_found', status: 404 }),
      false,
    ],
    [
      'a 409',
      new RequestRejectedError('m', { code: 'conflict', status: 409 }),
      false,
    ],
    ['a 422', new RequestRejectedError('m', { status: 422 }), false],
    ['a 429', new RateLimitError('m', { status: 429 }), false],
    ['a 499', sdkError(499), false],
    ['a 500', sdkError(500), true],
    ['a 502', sdkError(502), true],
    [
      'a 503',
      new RequestRejectedError('m', {
        code: 'service_unavailable',
        status: 503,
      }),
      true,
    ],
    ['a 504', sdkError(504), true],
    ['a timeout', new TimeoutError('m'), true],
    ['a transport error', new TransportError('m'), true],
    [
      'an unreadable 2xx answer',
      new UnexpectedResponseError('m', { status: 200, issues: [] }),
      true,
    ],
    ['an XoError with no status', new XoError('m'), true],
    ['an error that is not an XoError', new Error('boom'), true],
    ['a thrown string', 'boom', true],
    ['undefined', undefined, true],
  ])('%s → %s', (_, error, expected) => {
    expect(landedAfterPost(error)).toBe(expected);
  });

  test('an error the transport marked as not sent is false, whatever its class and status', async () => {
    const rig = bridgeRig(server);
    const failure = new RequestRejectedError('login failed', {
      code: 'service_unavailable',
      status: 503,
      service: 'backend',
    });
    const transport = new Transport({
      env: rig.env,
      version: '9.9.9',
      maxRetries: 0,
      auth: {
        headers: async () => {
          throw failure;
        },
        onUnauthorized: async () => false,
      },
    });
    const error = await caught(() =>
      transport.request({
        service: 'backend',
        method: 'POST',
        path: PATH,
        body: {},
        auth: 'backend',
      }),
    );
    expect(error).toBe(failure);
    expect(wasNotSent(error)).toBe(true);
    expect(landedAfterPost(error)).toBe(false);
    // The same error, thrown by something else, says nothing about the send.
    expect(
      landedAfterPost(
        new RequestRejectedError('login failed', {
          code: 'service_unavailable',
          status: 503,
        }),
      ),
    ).toBe(true);
    expectNoRequest(rig.backend);
  });
});
