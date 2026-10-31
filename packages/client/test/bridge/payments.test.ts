import { HttpResponse, http } from 'msw';
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
import { Session } from '../../src/auth/session';
import { BridgeClient } from '../../src/bridge/client';
import { landedAfterPost, withPaymentId } from '../../src/bridge/internal';
import {
  BridgePaymentPageSchema,
  BridgePaymentSchema,
} from '../../src/bridge/schemas';
import { Clock } from '../../src/core/clock';
import {
  AuthRequiredError,
  RateLimitError,
  RequestRejectedError,
  TransactionFailedError,
  UnexpectedResponseError,
  UserInputError,
  XoError,
} from '../../src/core/errors';
import type { ResponseIssue } from '../../src/core/schema';
import { Transport, wasNotSent } from '../../src/core/transport';
import { API_KEY, caught } from '../helpers/dataRig';
import { exceptionResponse, NONCE_URL } from '../helpers/mockBackend';
import {
  BASE_USDC,
  bridgeRig,
  DEPOSIT_ADDRESS,
  expectNoRequest,
  FUND_BY,
  paymentFixture,
  RECIPIENT,
} from '../helpers/mockBridge';
import { eoaIdentity, OWNER, ownerSigner } from '../helpers/railChain';
import { rejectedWith, serverFailure } from '../helpers/rejections';
import { testEnv } from '../helpers/testEnv';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

const BASE = '/api/bridge/halliday';

describe('bridge.get', () => {
  test('sends GET /payments/:paymentId with the session key and returns the payment', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.payments.set('p1', paymentFixture({ paymentId: 'p1' }));

    const payment = await bridge.get('p1');

    expect(payment).toEqual(paymentFixture({ paymentId: 'p1' }));
    expect(backend.requests).toEqual([
      {
        method: 'GET',
        path: `${BASE}/payments/p1`,
        query: {},
        body: undefined,
        authorization: `Bearer ${API_KEY}`,
        sdk: 'ts/9.9.9',
      },
    ]);
  });

  test('every field reaches the caller: the deposit block, the verification items, the nulls and the hashes', async () => {
    const { bridge, backend } = bridgeRig(server);
    const full = paymentFixture({
      paymentId: 'p_full',
      direction: 'withdraw',
      status: 'NEEDS_VERIFICATION',
      hallidayStatus: 'NEEDS_VERIFICATION',
      recipient: RECIPIENT,
      destinationAddress: RECIPIENT,
      verification: {
        items: [
          {
            reason: 'EVM_OWNER',
            signatureType: 'EIP712',
            payload: '{"types":{}}',
          },
          {
            reason: 'EVM_WITHDRAWAL',
            signatureType: 'EIP191',
            payload: 'Withdraw 5 USDC',
          },
        ],
      },
      fundingClaimedAt: '2026-10-21T12:03:00.000Z',
      fundingTxHash: `0x${'ab'.repeat(32)}`,
      deliveryTxHash: `0x${'cd'.repeat(32)}`,
      recoveryUrl: 'https://bridge.example/recover/p_full',
      completedAt: '2026-10-21T12:09:00.000Z',
    });
    backend.payments.set('p_full', full);
    expect(await bridge.get('p_full')).toEqual(full);

    const bare = paymentFixture({
      paymentId: 'p_bare',
      status: 'QUOTED',
      hallidayStatus: null,
      ownerAddress: null,
      fundBy: null,
      deposit: null,
    });
    backend.payments.set('p_bare', bare);
    const quoted = await bridge.get('p_bare');
    expect(quoted).toEqual(bare);
    expect(quoted.deposit).toBeNull();
    expect(quoted.fundBy).toBeNull();
    expect(quoted.ownerAddress).toBeNull();
  });

  test('timestamps stay ISO strings', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.payments.set('p1', paymentFixture({ paymentId: 'p1' }));
    const payment = await bridge.get('p1');
    expect(typeof payment.acceptBy).toBe('string');
    expect(payment.fundBy).toBe(FUND_BY);
    expect(typeof payment.createdAt).toBe('string');
    expect(typeof payment.updatedAt).toBe('string');
  });

  test.each(['p-1', 'p_1', 'A'.repeat(128), '0', 'pay_01HZX2K8Q9'])(
    'the id %j is a payment id and is sent as it is',
    async (id) => {
      const { bridge, backend } = bridgeRig(server);
      backend.payments.set(id, paymentFixture({ paymentId: id }));
      expect((await bridge.get(id)).paymentId).toBe(id);
      expect(backend.requests[0]?.path).toBe(`${BASE}/payments/${id}`);
    },
  );

  test('404 payment_not_found → 404 rejection that carries the paymentId, mayHaveLanded false', async () => {
    const { bridge, backend } = bridgeRig(server);
    const error = await caught(() => bridge.get('p1'));

    expect(error).toSatisfy(rejectedWith(404));
    const xo = error as XoError;
    expect(xo.code).toBe('payment_not_found');
    expect(xo.status).toBe(404);
    expect(xo.service).toBe('backend');
    expect(xo.paymentId).toBe('p1');
    expect(xo.mayHaveLanded).toBe(false);
    expect(xo.toJSON()).toMatchObject({
      code: 'payment_not_found',
      paymentId: 'p1',
      mayHaveLanded: false,
    });
    expect(backend.requests).toHaveLength(1);
  });

  test('every error of the request carries the paymentId: a 503, an unreadable answer', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.override('payment', ({ request }) =>
      exceptionResponse(request.path, 503, {
        error: 'halliday_unavailable',
        message: 'down',
      }),
    );
    const down = await caught(() => bridge.get('p9'));
    expect(down).toSatisfy(serverFailure);
    expect((down as XoError).paymentId).toBe('p9');
    // A read moves nothing.
    expect((down as XoError).mayHaveLanded).toBe(false);

    backend.override('payment', () => HttpResponse.json({ nonsense: true }));
    const odd = await caught(() => bridge.get('p9'));
    expect(odd).toBeInstanceOf(UnexpectedResponseError);
    expect((odd as XoError).paymentId).toBe('p9');
    expect((odd as XoError).mayHaveLanded).toBe(false);
  });

  test('a missing credential carries the paymentId too, and nothing is sent', async () => {
    const { bridge, backend } = bridgeRig(server, { session: 'none' });
    const error = await caught(() => bridge.get('p1'));
    expect(error).toBeInstanceOf(AuthRequiredError);
    expect((error as XoError).mayHaveLanded).toBe(false);
    expect((error as XoError).paymentId).toBe('p1');
    expectNoRequest(backend);
  });

  test.each([
    ['a path', 'p1/verification'],
    ['a parent path', '../assets'],
    ['a dot', '.'],
    ['a query', 'p1?x=1'],
    ['a fragment', 'p1#x'],
    ['a space', 'p 1'],
    ['an encoded slash', 'p%2F1'],
    ['a dot in the name', 'p.1'],
    ['empty', ''],
    ['129 characters', 'a'.repeat(129)],
    ['a number', 5],
    ['null', null],
    ['undefined', undefined],
    ['an object', { toString: () => 'p1' }],
  ])(
    'an id that is %s → UserInputError, mayHaveLanded false, and no request',
    async (_, id) => {
      const { bridge, backend } = bridgeRig(server);
      const error = await caught(() => bridge.get(id as never));
      expect(error).toBeInstanceOf(UserInputError);
      expect((error as XoError).code).toBe('invalid_input');
      expect((error as XoError).mayHaveLanded).toBe(false);
      expect((error as XoError).message).toContain('paymentId');
      expectNoRequest(backend);
    },
  );

  test('a message never holds the id that was refused', async () => {
    const { bridge } = bridgeRig(server);
    const error = await caught(() => bridge.get('secret/value'));
    expect((error as XoError).message).not.toContain('secret');
  });

  test('a config without a bridge: the gate comes first, before the id is looked at', async () => {
    const { bridge, backend } = bridgeRig(server, { env: testEnv });
    const error = await caught(() => bridge.get('a/b'));
    expect((error as XoError).code).toBe('bridge_not_available');
    expect((error as XoError).mayHaveLanded).toBe(false);
    // The gate is not about a payment.
    expect((error as XoError).paymentId).toBeUndefined();
    expectNoRequest(backend);
  });

  test('an unknown status is kept in lenient mode and refused in strict mode', async () => {
    const odd = paymentFixture({ paymentId: 'p1', status: 'BRAND_NEW' });

    const lenient = bridgeRig(server);
    lenient.backend.payments.set('p1', odd);
    expect((await lenient.bridge.get('p1')).status).toBe('BRAND_NEW');

    const strict = bridgeRig(server, { strict: true });
    strict.backend.payments.set('p1', odd);
    const error = await caught(() => strict.bridge.get('p1'));
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as XoError).paymentId).toBe('p1');
  });

  test('an unknown field is kept in lenient mode and refused in strict mode; strict takes the backend answer as it is', async () => {
    const extra = paymentFixture({ paymentId: 'p1', riskScore: 3 });
    const lenient = bridgeRig(server);
    lenient.backend.payments.set('p1', extra);
    expect(await lenient.bridge.get('p1')).toMatchObject({ riskScore: 3 });

    const strict = bridgeRig(server, { strict: true });
    strict.backend.payments.set('p1', extra);
    const error = await caught(() => strict.bridge.get('p1'));
    expect(
      ((error as UnexpectedResponseError).issues as ResponseIssue[]).map(
        (issue) => issue.code,
      ),
    ).toEqual(['unrecognized_keys']);

    const plain = bridgeRig(server, { strict: true });
    plain.backend.payments.set('p1', paymentFixture({ paymentId: 'p1' }));
    expect((await plain.bridge.get('p1')).paymentId).toBe('p1');
  });

  test.each([
    'paymentId',
    'direction',
    'status',
    'hallidayStatus',
    'input',
    'output',
    'fees',
    'ownerAddress',
    'destinationAddress',
    'recipient',
    'acceptBy',
    'fundBy',
    'deposit',
    'verification',
    'fundingClaimedAt',
    'fundingTxHash',
    'deliveryTxHash',
    'recoveryUrl',
    'createdAt',
    'updatedAt',
    'completedAt',
  ])(
    'a payment without %s → UnexpectedResponseError naming it',
    async (field) => {
      const { bridge, backend } = bridgeRig(server);
      const { [field]: _left, ...incomplete } = paymentFixture({
        paymentId: 'p1',
      });
      backend.override('payment', () => HttpResponse.json(incomplete));
      const error = await caught(() => bridge.get('p1'));
      expect(error).toBeInstanceOf(UnexpectedResponseError);
      expect(
        ((error as UnexpectedResponseError).issues as ResponseIssue[]).map(
          (issue) => issue.path,
        ),
      ).toEqual([field]);
    },
  );

  test('an amount that is not a decimal, or a direction that is neither, → UnexpectedResponseError', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.override('payment', () =>
      HttpResponse.json(
        paymentFixture({ input: { asset: 'base:0xa', amount: 'about 5' } }),
      ),
    );
    expect(await caught(() => bridge.get('p1'))).toBeInstanceOf(
      UnexpectedResponseError,
    );
    backend.override('payment', () =>
      HttpResponse.json(paymentFixture({ direction: 'sideways' })),
    );
    expect(await caught(() => bridge.get('p1'))).toBeInstanceOf(
      UnexpectedResponseError,
    );
  });

  test('the deposit block is read as it is', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.payments.set('p1', paymentFixture({ paymentId: 'p1' }));
    expect((await bridge.get('p1')).deposit).toEqual({
      address: DEPOSIT_ADDRESS,
      amount: '25.5',
      token: BASE_USDC,
      chain: 'base',
    });
  });
});

describe('bridge.history', () => {
  /** A confirmed payment, for the default backend's list. */
  const confirmed = (id: string, over: Record<string, unknown> = {}) =>
    paymentFixture({ paymentId: id, ...over });

  test('with no options asks for the first page with limit=100, and sends neither direction nor status nor cursor', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.payments.set('a', confirmed('a'));
    const payments = await bridge.history().toArray();

    expect(payments.map((payment) => payment.paymentId)).toEqual(['a']);
    expect(backend.requests).toEqual([
      {
        method: 'GET',
        path: `${BASE}/payments`,
        query: { limit: '100' },
        body: undefined,
        authorization: `Bearer ${API_KEY}`,
        sdk: 'ts/9.9.9',
      },
    ]);
  });

  test("history({ direction: 'withdraw' }) walks the pages through nextCursor, and the second request carries the cursor", async () => {
    const { bridge, backend } = bridgeRig(server);
    const page = (ids: string[], nextCursor: string | null) =>
      HttpResponse.json({
        data: ids.map((id) => confirmed(id, { direction: 'withdraw' })),
        nextCursor,
      });
    backend.override('payments', ({ request }) =>
      request.query.cursor === undefined
        ? page(['w3', 'w2'], 'c2')
        : page(['w1'], null),
    );

    const payments = await bridge.history({ direction: 'withdraw' }).toArray();

    expect(payments.map((payment) => payment.paymentId)).toEqual([
      'w3',
      'w2',
      'w1',
    ]);
    expect(backend.requests.map((request) => request.query)).toEqual([
      { direction: 'withdraw', limit: '100' },
      { direction: 'withdraw', limit: '100', cursor: 'c2' },
    ]);
  });

  test('the cursor is passed through untouched', async () => {
    const { bridge, backend } = bridgeRig(server);
    const cursor = 'eyJ0IjoiMjAyNi0xMC0yMVQxMjowMDowMC4wMDBaIiwiaSI6OX0=/+';
    backend.override('payments', ({ request }) =>
      HttpResponse.json(
        request.query.cursor === undefined
          ? { data: [confirmed('a')], nextCursor: cursor }
          : { data: [confirmed('b')], nextCursor: null },
      ),
    );
    await bridge.history().toArray();
    expect(backend.requests[1]?.query.cursor).toBe(cursor);
  });

  test('walks the default backend: the filters narrow the list, newest first, and the offset cursor is followed', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.payments.set('d1', confirmed('d1', { direction: 'deposit' }));
    backend.payments.set(
      'w1',
      confirmed('w1', { direction: 'withdraw', status: 'COMPLETE' }),
    );
    backend.payments.set(
      'w2',
      confirmed('w2', { direction: 'withdraw', status: 'HALTED' }),
    );
    backend.payments.set('q1', confirmed('q1', { status: 'QUOTED' }));

    expect(
      (await bridge.history().toArray()).map((payment) => payment.paymentId),
    ).toEqual(['w2', 'w1', 'd1']);

    expect(
      (await bridge.history({ direction: 'withdraw' }).toArray()).map(
        (payment) => payment.paymentId,
      ),
    ).toEqual(['w2', 'w1']);

    expect(
      (
        await bridge
          .history({ direction: 'withdraw', status: 'COMPLETE' })
          .toArray()
      ).map((payment) => payment.paymentId),
    ).toEqual(['w1']);

    expect(backend.requests.map((request) => request.query)).toEqual([
      { limit: '100' },
      { direction: 'withdraw', limit: '100' },
      { direction: 'withdraw', status: 'COMPLETE', limit: '100' },
    ]);
  });

  test('a status the SDK has not heard of is sent as it is', async () => {
    const { bridge, backend } = bridgeRig(server);
    await bridge.history({ status: 'BRAND_NEW' }).toArray();
    expect(backend.requests[0]?.query).toEqual({
      status: 'BRAND_NEW',
      limit: '100',
    });
  });

  test('is lazy: nothing is requested until the paginator is read; each read starts again', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.payments.set('a', confirmed('a'));
    const history = bridge.history();
    expectNoRequest(backend);
    await history.toArray();
    await history.firstPage();
    expect(backend.requests).toHaveLength(2);
  });

  test('stops asking when the cursor repeats', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.override('payments', () =>
      HttpResponse.json({
        data: [confirmed(`p${backend.requests.length}`)],
        nextCursor: 'same',
      }),
    );
    const payments = await bridge.history().toArray();
    expect(payments).toHaveLength(2);
    expect(backend.requests).toHaveLength(2);
  });

  test('a page that is empty ends the list', async () => {
    const { bridge } = bridgeRig(server);
    expect(await bridge.history().toArray()).toEqual([]);
  });

  test('a read error is mayHaveLanded false and carries no paymentId', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.override('payments', ({ request }) =>
      exceptionResponse(request.path, 503, {
        error: 'halliday_unavailable',
        message: 'down',
      }),
    );
    const error = await caught(() => bridge.history().toArray());
    expect(error).toSatisfy(serverFailure);
    expect((error as XoError).mayHaveLanded).toBe(false);
    expect((error as XoError).paymentId).toBeUndefined();
  });

  test('a page that does not match the schema → UnexpectedResponseError naming the item', async () => {
    const { bridge, backend } = bridgeRig(server);
    const { status: _status, ...bad } = confirmed('a');
    backend.override('payments', () =>
      HttpResponse.json({ data: [bad], nextCursor: null }),
    );
    const error = await caught(() => bridge.history().toArray());
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(
      ((error as UnexpectedResponseError).issues as ResponseIssue[]).map(
        (issue) => issue.path,
      ),
    ).toEqual(['data.0.status']);
    expect((error as XoError).mayHaveLanded).toBe(false);
  });

  test('a page with no nextCursor field is not a page', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.override('payments', () => HttpResponse.json({ data: [] }));
    expect(await caught(() => bridge.history().toArray())).toBeInstanceOf(
      UnexpectedResponseError,
    );
  });

  test.each([
    ['direction sideways', { direction: 'sideways' }],
    ['direction in capitals', { direction: 'DEPOSIT' }],
    ['direction null', { direction: null }],
    ['status empty', { status: '' }],
    ['status a number', { status: 5 }],
    ['status null', { status: null }],
    ['status QUOTED, which is never listed', { status: 'QUOTED' }],
    ['an unknown key', { limit: 5 }],
    ['an unknown key cursor', { cursor: 'x' }],
  ])(
    'options with %s → UserInputError, mayHaveLanded false, and no request',
    async (_, options) => {
      const { bridge, backend } = bridgeRig(server);
      const error = await caught(() => bridge.history(options as never));
      expect(error).toBeInstanceOf(UserInputError);
      expect((error as XoError).code).toBe('invalid_input');
      expect((error as XoError).mayHaveLanded).toBe(false);
      expectNoRequest(backend);
    },
  );

  test.each([null, 'withdraw', 5, []])(
    'options %j → UserInputError',
    async (options) => {
      const { bridge, backend } = bridgeRig(server);
      const error = await caught(() => bridge.history(options as never));
      expect(error).toBeInstanceOf(UserInputError);
      expectNoRequest(backend);
    },
  );

  test('a config without a bridge: the gate comes first, when history() is called', async () => {
    const { bridge, backend } = bridgeRig(server, { env: testEnv });
    const error = await caught(() =>
      bridge.history({ direction: 'sideways' } as never),
    );
    expect((error as XoError).code).toBe('bridge_not_available');
    expect((error as XoError).mayHaveLanded).toBe(false);
    expectNoRequest(backend);
  });

  test('a session with neither a signer nor a key fails when the paginator is read, with mayHaveLanded false and nothing sent', async () => {
    const { bridge, backend } = bridgeRig(server, { session: 'none' });
    const history = bridge.history();
    const error = await caught(() => history.toArray());
    expect(error).toBeInstanceOf(AuthRequiredError);
    expect((error as XoError).mayHaveLanded).toBe(false);
    expectNoRequest(backend);
  });
});

describe('withPaymentId', () => {
  test('sets paymentId on the error and returns that same error', () => {
    const error = new TransactionFailedError('m', { mayHaveLanded: true });
    const same = withPaymentId(error, 'p1');
    expect(same).toBe(error);
    expect(error.paymentId).toBe('p1');
  });

  test('toJSON carries it, and so does JSON.stringify', () => {
    const error = withPaymentId(
      new RequestRejectedError('gone', { status: 404, code: 'not_found' }),
      'p1',
    );
    expect(error.toJSON()).toMatchObject({ paymentId: 'p1' });
    expect(JSON.parse(JSON.stringify(error))).toMatchObject({
      paymentId: 'p1',
    });
  });

  test('is a plain data property, as mayHaveLanded is: own, enumerable, and it shows when the error is inspected', () => {
    const error = withPaymentId(new XoError('m'), 'p1');
    expect(Object.getOwnPropertyDescriptor(error, 'paymentId')).toMatchObject({
      value: 'p1',
      enumerable: true,
    });
  });

  test('an error that already has this id comes back as the same object', () => {
    const error = withPaymentId(new XoError('m'), 'p1');
    expect(withPaymentId(error, 'p1')).toBe(error);
    expect(error.paymentId).toBe('p1');
  });

  test('an error that has another id is not changed: the caller gets a copy with its own id', () => {
    const first = withPaymentId(
      new RequestRejectedError('down', {
        code: 'bridge_unavailable',
        service: 'backend',
        status: 503,
        requestId: 'req-1',
        retryAfter: 2000,
      }),
      'first',
    );
    const second = withPaymentId(first, 'second');

    expect(second).not.toBe(first);
    expect(first.paymentId).toBe('first');
    expect(second.paymentId).toBe('second');
    expect(second.cause).toBe(first);
  });

  test('a copy keeps the class and every field of the original, and has its own paymentId and cause', () => {
    const original = new RequestRejectedError('down for now', {
      code: 'bridge_unavailable',
      service: 'backend',
      status: 503,
      requestId: 'req-1',
      retryAfter: 2000,
      cause: new Error('socket closed'),
    });
    Object.defineProperty(original, 'mayHaveLanded', {
      value: true,
      enumerable: true,
      configurable: true,
    });
    withPaymentId(original, 'p_a');
    const copy = withPaymentId(original, 'p_b');

    expect(copy).not.toBe(original);
    expect(Object.getPrototypeOf(copy)).toBe(Object.getPrototypeOf(original));
    expect(copy).toSatisfy(serverFailure);
    expect(copy.name).toBe('RequestRejectedError');
    expect(copy.message).toBe('down for now');
    expect(copy.code).toBe('bridge_unavailable');
    expect(copy.service).toBe('backend');
    expect(copy.status).toBe(503);
    expect(copy.requestId).toBe('req-1');
    expect(copy.retryAfter).toBe(2000);
    expect(copy.mayHaveLanded).toBe(true);
    expect(copy.stack).toBe(original.stack);
    expect(String(copy)).toBe(String(original));
    expect(copy.paymentId).toBe('p_b');
    expect(copy.cause).toBe(original);
    // The original is untouched.
    expect(original.paymentId).toBe('p_a');
    expect((original.cause as Error).message).toBe('socket closed');
    // The copy reads like an error everywhere else: toJSON, JSON.stringify.
    expect(copy.toJSON()).toMatchObject({
      name: 'RequestRejectedError',
      code: 'bridge_unavailable',
      status: 503,
      requestId: 'req-1',
      retryAfter: 2000,
      mayHaveLanded: true,
      paymentId: 'p_b',
    });
    expect(JSON.parse(JSON.stringify(copy))).toMatchObject({
      paymentId: 'p_b',
    });
  });

  test('an error the transport marked as not sent may be shared by several callers, so it is copied even when it has no id yet', async () => {
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
    const shared = await caught(() =>
      transport.request({
        service: 'backend',
        method: 'POST',
        path: '/x',
        auth: 'backend',
      }),
    );
    expect(shared).toBe(failure);
    expect(wasNotSent(shared)).toBe(true);

    const copy = withPaymentId(failure, 'p1');

    expect(copy).not.toBe(failure);
    expect(copy).toSatisfy(serverFailure);
    expect(copy.paymentId).toBe('p1');
    expect(copy.cause).toBe(failure);
    // The shared object is left as it was found.
    expect(failure.paymentId).toBeUndefined();
    // The copy is the same fact: nothing was sent.
    expect(wasNotSent(copy)).toBe(true);
    expect(landedAfterPost(copy)).toBe(false);
  });

  test('an error that is not shared and has no id yet is stamped in place', () => {
    const error = new RequestRejectedError('gone', {
      code: 'not_found',
      status: 404,
    });
    const same = withPaymentId(error, 'p1');
    expect(same).toBe(error);
    expect(error.paymentId).toBe('p1');
  });

  test('a frozen error keeps what it has and is still returned', () => {
    const error = new XoError('m');
    Object.freeze(error);
    expect(withPaymentId(error, 'p1')).toBe(error);
    expect(error.paymentId).toBeUndefined();
  });

  test('an error without one has none, and toJSON leaves the field out', () => {
    const error = new XoError('m');
    expect(error.paymentId).toBeUndefined();
    expect('paymentId' in error.toJSON()).toBe(false);
  });

  test('the id is redacted like any field of toJSON', () => {
    const key = 'xo_sk_data_abc123_x';
    const error = withPaymentId(new XoError('m'), `pay_${key}`);
    expect(JSON.stringify(error.toJSON())).not.toContain('xo_sk_');
  });
});

describe('callers that share one error', () => {
  /**
   * A bridge client whose session has a signer and no backend key, and whose login fails with
   * `status`. Callers of the same login in flight get one error object (any failure); a 429
   * also pauses logins, and every later caller within the pause gets that same object again.
   */
  function failingLogin(status: number) {
    const rig = bridgeRig(server);
    server.use(
      http.post(NONCE_URL, ({ request }) =>
        exceptionResponse(new URL(request.url).pathname, status, {
          error: status === 429 ? 'rate_limited' : 'service_unavailable',
          message: 'login is down',
        }),
      ),
    );
    const transport = new Transport({
      env: rig.env,
      version: '9.9.9',
      maxRetries: 0,
    });
    const session = new Session({
      env: rig.env,
      transport,
      clock: new Clock({
        fetchServerTimeSec: async () => Math.floor(Date.now() / 1000),
      }),
      signer: ownerSigner(),
      readContract: async () => '0x',
      warn: () => {},
    });
    transport.setAuth(session);
    const bridge = new BridgeClient({
      env: rig.env,
      transport,
      session,
      identity: async () => eoaIdentity(),
      chain: rig.chain.reader,
      account: rig.account,
    });
    return { bridge, backend: rig.backend };
  }

  test('two get()s on one failing login each carry their own paymentId, with the class and code intact', async () => {
    const { bridge, backend } = failingLogin(503);

    const [a, b] = (await Promise.all([
      caught(() => bridge.get('pay_A')),
      caught(() => bridge.get('pay_B')),
    ])) as [XoError, XoError];

    // Without a copy, B would read 'pay_A'.
    expect(a.paymentId).toBe('pay_A');
    expect(b.paymentId).toBe('pay_B');
    expect(a).not.toBe(b);
    // It is one login failure that both callers got: the originals are the same object ...
    expect(a.cause).toBe(b.cause);
    const shared = a.cause as XoError;
    expect(shared).toBeInstanceOf(XoError);
    expect(wasNotSent(shared)).toBe(true);
    // ... and it was left without an id.
    expect(shared.paymentId).toBeUndefined();
    // Each copy keeps the class, the code and the flags of the shared error.
    for (const error of [a, b]) {
      expect(Object.getPrototypeOf(error)).toBe(Object.getPrototypeOf(shared));
      expect(error.code).toBe(shared.code);
      expect(error.service).toBe(shared.service);
      expect(error.status).toBe(shared.status);
      expect(error.message).toBe(shared.message);
      // A read moves nothing, and the login failed before any request.
      expect(error.mayHaveLanded).toBe(false);
    }
    expect(backend.requests).toEqual([]);
  });

  test('a caller that comes later, while the login is paused, gets its own id too', async () => {
    const { bridge } = failingLogin(429);
    const first = (await caught(() => bridge.get('pay_A'))) as XoError;
    const second = (await caught(() => bridge.get('pay_B'))) as XoError;
    const third = (await caught(() => bridge.get('pay_C'))) as XoError;

    // The pause hands each of them the one error the login failed with.
    expect(second.cause).toBe(first.cause);
    expect(third.cause).toBe(first.cause);
    expect((first.cause as XoError).paymentId).toBeUndefined();
    expect([first, second, third].map((error) => error.paymentId)).toEqual([
      'pay_A',
      'pay_B',
      'pay_C',
    ]);
    expect(new Set([first, second, third]).size).toBe(3);
    for (const error of [first, second, third]) {
      expect(error).toBeInstanceOf(RateLimitError);
      expect(error.status).toBe(429);
      expect(error.mayHaveLanded).toBe(false);
    }
  });
});

describe('the schemas', () => {
  test('BridgePaymentSchema takes the presenter as it is, in both flavours', () => {
    const body = paymentFixture();
    expect(BridgePaymentSchema.lenient.parse(body)).toEqual(body);
    expect(BridgePaymentSchema.strict.parse(body)).toEqual(body);
  });

  test('BridgePaymentPageSchema takes { data, nextCursor }, with a null or a string cursor', () => {
    for (const nextCursor of [null, 'c1']) {
      const page = { data: [paymentFixture()], nextCursor };
      expect(BridgePaymentPageSchema.lenient.parse(page)).toEqual(page);
      expect(BridgePaymentPageSchema.strict.parse(page)).toEqual(page);
    }
    expect(() =>
      BridgePaymentPageSchema.lenient.parse({ data: [paymentFixture()] }),
    ).toThrow();
  });

  test('a payment funded by the owner: ownerAddress and destinationAddress are the wallet', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.payments.set('p1', paymentFixture({ paymentId: 'p1' }));
    const payment = await bridge.get('p1');
    expect(payment.ownerAddress).toBe(OWNER);
    expect(payment.destinationAddress).toBe(OWNER);
  });
});
