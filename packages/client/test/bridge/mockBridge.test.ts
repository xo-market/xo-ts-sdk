import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { API_KEY } from '../helpers/dataRig';
import {
  BASE_USDC,
  type BridgeBackend,
  ETH_USDT,
  installBridge,
  paymentFixture,
  RECIPIENT,
  XO_USDC_ASSET,
  XO_USDC_TOKEN,
} from '../helpers/mockBridge';
import { testEnv } from '../helpers/testEnv';

// The fake of the bridge routes is what the BridgeClient tests read against, so its own
// behaviour is pinned here: the statuses and codes of the backend's controller, one route at a time.

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const BASE = `${testEnv.backendUrl}/api/bridge/halliday`;

// biome-ignore lint/suspicious/noExplicitAny: an answer's JSON is probed field by field
type Json = any;

async function call(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  key: string | null = API_KEY,
) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(key === null ? {} : { Authorization: `Bearer ${key}` }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json()) as Json;
  return { status: response.status, json, code: json.response?.error };
}

/** A withdrawal quote → its first option confirmed. */
async function confirmedWithdrawal(backend: BridgeBackend): Promise<string> {
  const quote = await call('POST', '/quotes', {
    direction: 'withdraw',
    asset: BASE_USDC,
    amount: '5',
    recipient: RECIPIENT,
  });
  const paymentId = quote.json.data.quotes[0].paymentId as string;
  await call('POST', '/payments', { paymentId });
  expect(backend.payments.get(paymentId)?.status).toBe('AWAITING_FUNDS');
  return paymentId;
}

describe('the fake bridge backend', () => {
  test('every route needs a known key: 401 otherwise, and the request is still recorded', async () => {
    const backend = installBridge(server);
    expect(
      (await call('GET', '/assets?direction=deposit', undefined, null)).status,
    ).toBe(401);
    expect(
      (await call('GET', '/assets?direction=deposit', undefined, 'xo_sk_other'))
        .status,
    ).toBe(401);
    expect(backend.requests.map((r) => r.authorization)).toEqual([
      null,
      'Bearer xo_sk_other',
    ]);
  });

  test('assets: the list of the direction, and the flat 400 of a bad direction', async () => {
    const backend = installBridge(server);
    const ok = await call('GET', '/assets?direction=withdraw');
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ data: backend.fixtures.assets.withdraw });
    const bad = await call('GET', '/assets?direction=sideways');
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('Bad Request');
    expect(bad.json.message).toEqual([expect.stringContaining('direction')]);
  });

  test('quotes: one stored QUOTED payment per option, with acceptBy and limits', async () => {
    const backend = installBridge(server);
    const { status, json } = await call('POST', '/quotes', {
      direction: 'deposit',
      asset: BASE_USDC,
      amount: '25.5',
    });
    expect(status).toBe(200);
    const { quotes, acceptBy, limits } = json.data;
    expect(quotes).toHaveLength(2);
    expect(quotes[0]).toEqual({
      paymentId: expect.any(String),
      input: { asset: BASE_USDC, amount: '25.5' },
      output: { asset: XO_USDC_ASSET, amount: '25.5' },
      fees: expect.objectContaining({ currency: 'USD' }),
      latencySeconds: expect.any(Number),
    });
    expect(typeof acceptBy).toBe('string');
    expect(limits).toEqual([{ min: '1', max: '100000' }]);
    expect(
      quotes.map(
        (q: { paymentId: string }) => backend.payments.get(q.paymentId)?.status,
      ),
    ).toEqual(['QUOTED', 'QUOTED']);
  });

  test.each([
    [
      'an asset that is not listed',
      { asset: 'base:0xabc123' },
      400,
      'asset_not_supported',
    ],
    ['an amount out of range', { amount: '0.5' }, 400, 'amount_out_of_range'],
    [
      'a withdrawal without a recipient',
      { direction: 'withdraw' },
      400,
      'recipient_invalid',
    ],
  ])('quotes: %s → %s', async (_, patch, status, code) => {
    installBridge(server);
    const answer = await call('POST', '/quotes', {
      direction: 'deposit',
      asset: BASE_USDC,
      amount: '5',
      ...patch,
    });
    expect(answer.status).toBe(status);
    expect(answer.code).toBe(code);
  });

  test.each([
    ['a bad asset', { asset: 'USDC' }],
    ['an amount with an exponent', { amount: '1e-7' }],
    ['a padded amount', { amount: '05' }],
    ['a bad direction', { direction: 'up' }],
    ['no body', undefined],
  ])('quotes: %s is the pipe’s flat 400, with no code', async (_, patch) => {
    installBridge(server);
    const answer = await call(
      'POST',
      '/quotes',
      patch === undefined
        ? {}
        : { direction: 'deposit', asset: BASE_USDC, amount: '5', ...patch },
    );
    expect(answer.status).toBe(400);
    expect(answer.json.response).toBeUndefined();
    expect(answer.json.error).toBe('Bad Request');
  });

  test('confirm: QUOTED moves to the confirmed status once, a repeat answers the stored payment', async () => {
    const backend = installBridge(server);
    const quote = await call('POST', '/quotes', {
      direction: 'deposit',
      asset: BASE_USDC,
      amount: '25.5',
    });
    const paymentId = quote.json.data.quotes[0].paymentId as string;
    const first = await call('POST', '/payments', { paymentId });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({
      paymentId,
      status: 'AWAITING_FUNDS',
      ownerAddress: expect.any(String),
      deposit: { amount: '25.5' },
    });
    backend.payments.set(paymentId, { ...first.json, status: 'PROCESSING' });
    const again = await call('POST', '/payments', { paymentId });
    expect(again.json.status).toBe('PROCESSING');
  });

  test("confirm: the deposit instructions name the token by asset id (the bridge's deposit_token), on that asset's network", async () => {
    const backend = installBridge(server);
    for (const [asset, chain] of [
      [BASE_USDC, 'base'],
      [ETH_USDT, 'ethereum'],
    ] as const) {
      const quote = await call('POST', '/quotes', {
        direction: 'deposit',
        asset,
        amount: '25.5',
      });
      const paymentId = quote.json.data.quotes[0].paymentId as string;
      const confirmed = await call('POST', '/payments', { paymentId });
      expect(confirmed.json.deposit).toMatchObject({ token: asset, chain });
    }
    // A withdrawal is funded on XO's own chain, in XO USDC as an asset id.
    const id = await confirmedWithdrawal(backend);
    expect(backend.payments.get(id)?.deposit).toMatchObject({
      token: XO_USDC_TOKEN,
      chain: 'xo',
    });
  });

  test('confirm: an unknown payment is 404 payment_not_found, a bad id the flat 400', async () => {
    installBridge(server);
    const missing = await call('POST', '/payments', { paymentId: 'pay_nope' });
    expect(missing.status).toBe(404);
    expect(missing.code).toBe('payment_not_found');
    const bad = await call('POST', '/payments', { paymentId: 'no spaces' });
    expect(bad.status).toBe(400);
    expect(bad.json.response).toBeUndefined();
  });

  test('funding claim: once, for a withdrawal that awaits funds', async () => {
    const backend = installBridge(server);
    const paymentId = await confirmedWithdrawal(backend);
    const claim = await call('POST', `/payments/${paymentId}/funding-claim`);
    expect(claim.status).toBe(200);
    expect(claim.json.fundingClaimedAt).toEqual(expect.any(String));
    const second = await call('POST', `/payments/${paymentId}/funding-claim`);
    expect(second.status).toBe(409);
    expect(second.code).toBe('funding_already_claimed');
  });

  test('funding claim: a deposit is 400 not_a_withdrawal, a payment past AWAITING_FUNDS 409, an unknown one 404', async () => {
    const backend = installBridge(server);
    backend.payments.set('pay_dep', paymentFixture({ paymentId: 'pay_dep' }));
    backend.payments.set(
      'pay_busy',
      paymentFixture({
        paymentId: 'pay_busy',
        direction: 'withdraw',
        status: 'PROCESSING',
      }),
    );
    const deposit = await call('POST', '/payments/pay_dep/funding-claim');
    expect([deposit.status, deposit.code]).toEqual([400, 'not_a_withdrawal']);
    const busy = await call('POST', '/payments/pay_busy/funding-claim');
    expect([busy.status, busy.code]).toEqual([
      409,
      'payment_not_awaiting_funds',
    ]);
    const none = await call('POST', '/payments/pay_nope/funding-claim');
    expect([none.status, none.code]).toEqual([404, 'payment_not_found']);
  });

  describe("funding claim: the backend's order of checks", () => {
    // direction, then status and deposit, then the 10-minute deadline guard, and only then the
    // atomic claim that says "already claimed".
    const CLAIMED_AT = '2026-10-21T12:01:00.000Z';
    const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
    const claim = async (
      over: Record<string, unknown>,
    ): Promise<{ status: number; code: unknown; json: Json }> => {
      const backend = installBridge(server);
      backend.payments.set(
        'pay_c',
        paymentFixture({ paymentId: 'pay_c', direction: 'withdraw', ...over }),
      );
      const answer = await call('POST', '/payments/pay_c/funding-claim');
      return {
        ...answer,
        // What the fake holds afterwards, to see whether a claim was made.
        json: { ...answer.json, stored: backend.payments.get('pay_c') },
      };
    };

    test.each(['PROCESSING', 'COMPLETE', 'HALTED'])(
      'a claimed payment that moved on to %s is payment_not_awaiting_funds, not funding_already_claimed',
      async (status) => {
        const answer = await claim({ status, fundingClaimedAt: CLAIMED_AT });
        expect([answer.status, answer.code]).toEqual([
          409,
          'payment_not_awaiting_funds',
        ]);
      },
    );

    test('a claimed payment that still awaits funds is funding_already_claimed', async () => {
      const answer = await claim({ fundingClaimedAt: CLAIMED_AT });
      expect([answer.status, answer.code]).toEqual([
        409,
        'funding_already_claimed',
      ]);
    });

    test('a payment without a deposit is payment_not_awaiting_funds', async () => {
      const answer = await claim({ deposit: null });
      expect([answer.status, answer.code]).toEqual([
        409,
        'payment_not_awaiting_funds',
      ]);
      expect(answer.json.stored.fundingClaimedAt).toBeNull();
    });

    test.each([
      ['5 minutes ahead', 5 * 60_000],
      ['a minute ago', -60_000],
    ])(
      'a fundBy %s is within the 10-minute guard: payment_not_awaiting_funds, and nothing is claimed',
      async (_, ms) => {
        const answer = await claim({ fundBy: inMs(ms) });
        expect([answer.status, answer.code]).toEqual([
          409,
          'payment_not_awaiting_funds',
        ]);
        expect(answer.json.stored.fundingClaimedAt).toBeNull();
      },
    );

    test('the deadline guard comes before the already-claimed check', async () => {
      const answer = await claim({
        fundBy: inMs(5 * 60_000),
        fundingClaimedAt: CLAIMED_AT,
      });
      expect([answer.status, answer.code]).toEqual([
        409,
        'payment_not_awaiting_funds',
      ]);
    });

    test.each([
      ['30 minutes ahead', inMs(30 * 60_000)],
      ['not set', null],
    ])('a fundBy %s can be claimed', async (_, fundBy) => {
      const answer = await claim({ fundBy });
      expect(answer.status).toBe(200);
      expect(answer.json.stored.fundingClaimedAt).toEqual(expect.any(String));
    });

    test('the direction comes first: a deposit is not_a_withdrawal whatever else is wrong with it', async () => {
      const answer = await claim({
        direction: 'deposit',
        status: 'COMPLETE',
        deposit: null,
        fundingClaimedAt: CLAIMED_AT,
        fundBy: inMs(-60_000),
      });
      expect([answer.status, answer.code]).toEqual([400, 'not_a_withdrawal']);
    });
  });

  test('verification: moves NEEDS_VERIFICATION on; any other status is 409; bad signatures are the flat 400', async () => {
    const backend = installBridge(server);
    backend.payments.set(
      'pay_v',
      paymentFixture({
        paymentId: 'pay_v',
        status: 'NEEDS_VERIFICATION',
        verification: {
          items: [
            { reason: 'EVM_OWNER', signatureType: 'EIP712', payload: '{}' },
          ],
        },
      }),
    );
    backend.payments.set('pay_w', paymentFixture({ paymentId: 'pay_w' }));
    const signatures = [
      {
        reason: 'EVM_OWNER',
        signatureType: 'EIP712',
        signature: `0x${'ab'.repeat(65)}`,
      },
    ];
    const bad = await call('POST', '/payments/pay_v/verification', {
      signatures: [{ ...signatures[0], signature: '0x12' }],
    });
    expect(bad.status).toBe(400);
    expect(bad.json.response).toBeUndefined();
    const wrong = await call('POST', '/payments/pay_w/verification', {
      signatures,
    });
    expect([wrong.status, wrong.code]).toEqual([
      409,
      'payment_not_awaiting_verification',
    ]);
    const ok = await call('POST', '/payments/pay_v/verification', {
      signatures,
    });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ status: 'PROCESSING', verification: null });
  });

  test('get: the stored payment, or 404 payment_not_found', async () => {
    const backend = installBridge(server);
    backend.payments.set('pay_g', paymentFixture({ paymentId: 'pay_g' }));
    expect((await call('GET', '/payments/pay_g')).json.paymentId).toBe('pay_g');
    const none = await call('GET', '/payments/pay_nope');
    expect([none.status, none.code]).toEqual([404, 'payment_not_found']);
  });

  test('list: newest first, QUOTED left out, filtered, paged by a cursor', async () => {
    const backend = installBridge(server);
    backend.payments.set(
      'pay_q',
      paymentFixture({ paymentId: 'pay_q', status: 'QUOTED' }),
    );
    for (const [id, direction, status] of [
      ['pay_a', 'deposit', 'COMPLETE'],
      ['pay_b', 'withdraw', 'COMPLETE'],
      ['pay_c', 'deposit', 'PROCESSING'],
    ] as const) {
      backend.payments.set(
        id,
        paymentFixture({ paymentId: id, direction, status }),
      );
    }
    const ids = (answer: { json: Json }) =>
      answer.json.data.map((p: { paymentId: string }) => p.paymentId);

    const all = await call('GET', '/payments');
    expect(ids(all)).toEqual(['pay_c', 'pay_b', 'pay_a']);
    expect(all.json.nextCursor).toBeNull();
    expect(ids(await call('GET', '/payments?direction=deposit'))).toEqual([
      'pay_c',
      'pay_a',
    ]);
    expect(ids(await call('GET', '/payments?status=COMPLETE'))).toEqual([
      'pay_b',
      'pay_a',
    ]);

    const first = await call('GET', '/payments?limit=2');
    expect(ids(first)).toEqual(['pay_c', 'pay_b']);
    expect(first.json.nextCursor).toBe('2');
    const second = await call(
      'GET',
      `/payments?limit=2&cursor=${first.json.nextCursor}`,
    );
    expect(ids(second)).toEqual(['pay_a']);
    expect(second.json.nextCursor).toBeNull();

    const cursor = await call('GET', '/payments?cursor=garbage');
    expect([cursor.status, cursor.code]).toEqual([400, 'cursor_invalid']);
    expect((await call('GET', '/payments?status=QUOTED')).status).toBe(400);
    expect((await call('GET', '/payments?limit=101')).status).toBe(400);
  });

  test('override answers one route from then on, and still records the request', async () => {
    const backend = installBridge(server);
    backend.override(
      'assets',
      () => new Response('{"data":[]}', { status: 200 }),
    );
    expect((await call('GET', '/assets?direction=deposit')).json).toEqual({
      data: [],
    });
    expect(backend.requests).toHaveLength(1);
    // The other routes keep their defaults.
    expect((await call('GET', '/payments')).json).toEqual({
      data: [],
      nextCursor: null,
    });
  });
});
