import { HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import {
  type Hex,
  type TypedDataDefinition,
  verifyMessage,
  verifyTypedData,
} from 'viem';
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
import type {
  BridgeQuote,
  BridgeVerificationItem,
} from '../../src/bridge/schemas';
import type {
  VerificationRequest,
  VerifyCallback,
} from '../../src/bridge/verification';
import {
  AuthRequiredError,
  RequestRejectedError,
  SigningError,
  TransportError,
  UnexpectedResponseError,
  UserInputError,
  XoError,
} from '../../src/core/errors';
import type { InternalSigner } from '../../src/wallet/signer';
import { caught } from '../helpers/dataRig';
import { exceptionResponse } from '../helpers/mockBackend';
import {
  ACCEPT_BY,
  BASE_USDC,
  type BridgeBackend,
  bridgeRig,
  DEPOSIT_ADDRESS,
  expectNoRequest,
  paymentFixture,
  XO_USDC_ASSET,
} from '../helpers/mockBridge';
import {
  OWNER,
  ownerSigner,
  SMART_WALLET,
  smartWalletIdentity,
} from '../helpers/railChain';
import { rejectedWith, serverFailure } from '../helpers/rejections';
import { keySigner } from '../helpers/signers';
import { testEnv } from '../helpers/testEnv';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

const BASE = '/api/bridge/halliday';
const env = testEnv;

/** An EIP-712 payload like the bridge provider's, with the `EIP712Domain` type spelled out. */
const TYPED = {
  domain: { name: 'Bridge', version: '1', chainId: 8453 },
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
    ],
    OwnerVerification: [
      { name: 'owner', type: 'address' },
      { name: 'paymentId', type: 'string' },
      { name: 'nonce', type: 'uint256' },
    ],
  },
  primaryType: 'OwnerVerification',
  message: { owner: OWNER, paymentId: 'pay_v', nonce: '42' },
};
const TEXT = 'Bridge: I authorise payment pay_v.\nNonce: 7';

const typedItem = (payload: unknown = TYPED): BridgeVerificationItem => ({
  reason: 'EVM_OWNER',
  signatureType: 'EIP712',
  payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
});
const textItem = (payload: string = TEXT): BridgeVerificationItem => ({
  reason: 'EVM_WITHDRAWAL',
  signatureType: 'EIP191',
  payload,
});
const ITEMS = [typedItem(), textItem()];

/** The typed data like the bridge provider's with a `verifyingContract` in its domain (and in its `EIP712Domain` type). */
const bound = (verifyingContract: string) => ({
  ...TYPED,
  domain: { ...TYPED.domain, verifyingContract },
  types: {
    ...TYPED.types,
    EIP712Domain: [
      ...TYPED.types.EIP712Domain,
      { name: 'verifyingContract', type: 'address' },
    ],
  },
});

/** A quote option of a deposit, as `quoteDeposit` returns it. */
function quote(
  paymentId = 'pay_v',
  over: Partial<BridgeQuote> = {},
): BridgeQuote {
  return {
    paymentId,
    direction: 'deposit',
    input: { asset: BASE_USDC, amount: '25.5' },
    output: { asset: XO_USDC_ASSET, amount: '25.4' },
    fees: {
      total: '0.1',
      conversion: '0',
      network: '0.05',
      business: '0.05',
      currency: 'USD',
    },
    latencySeconds: 30,
    acceptBy: ACCEPT_BY,
    ...over,
  };
}

/** Puts a payment that waits for the owner's signatures in the fake: a confirm answers with it. */
function awaiting(
  backend: BridgeBackend,
  items: BridgeVerificationItem[] = ITEMS,
  over: Record<string, unknown> = {},
  id = 'pay_v',
): void {
  backend.payments.set(
    id,
    paymentFixture({
      paymentId: id,
      status: 'NEEDS_VERIFICATION',
      hallidayStatus: 'NEEDS_VERIFICATION',
      deposit: null,
      fundBy: null,
      verification: { items },
      ...over,
    }),
  );
}

/** The owner's signer, with its two signing methods spied and logged in `events`. */
function recordingSigner(
  events: string[] = [],
  over: Partial<InternalSigner> = {},
) {
  const real = ownerSigner();
  const signTypedData = vi.fn(async (td: TypedDataDefinition) => {
    events.push('sign:typed');
    return real.signTypedData(td);
  });
  const signMessage = vi.fn(async (message: string) => {
    events.push('sign:message');
    return real.signMessage(message);
  });
  const signer: InternalSigner = {
    address: real.address,
    signTypedData,
    signMessage,
    ...over,
  };
  return { signer, signTypedData, signMessage, events };
}

const yes = async () => true;

/** The verification POSTs the fake has seen. */
const verificationPosts = (backend: BridgeBackend) =>
  backend.requests.filter((r) => r.path.endsWith('/verification'));

/** The signatures of the one verification POST. */
function sentSignatures(backend: BridgeBackend) {
  const posts = verificationPosts(backend);
  expect(posts).toHaveLength(1);
  const body = posts[0]?.body as {
    signatures: { reason: string; signatureType: string; signature: Hex }[];
  };
  return body.signatures;
}

function expectUnlanded(error: unknown, paymentId = 'pay_v'): XoError {
  expect(error).toBeInstanceOf(XoError);
  const xo = error as XoError;
  expect(xo.mayHaveLanded).toBe(false);
  expect(xo.paymentId).toBe(paymentId);
  return xo;
}

describe('bridge.deposit: confirm', () => {
  test('POST /payments with { paymentId } confirms a quote; the payment with its deposit block comes back, and no signer is needed', async () => {
    const { bridge, backend } = bridgeRig(server);
    const { quotes } = await bridge.quoteDeposit({
      asset: BASE_USDC,
      amount: '25.5',
    });
    const chosen = quotes[0] as BridgeQuote;

    const payment = await bridge.deposit(chosen);

    expect(backend.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST ${BASE}/quotes`,
      `POST ${BASE}/payments`,
    ]);
    expect(backend.requests[1]?.body).toEqual({ paymentId: chosen.paymentId });
    expect(payment.paymentId).toBe(chosen.paymentId);
    expect(payment.status).toBe('AWAITING_FUNDS');
    expect(payment.direction).toBe('deposit');
    // The token is the asset id the quote was asked for, as assets('deposit') lists it.
    expect(payment.deposit).toEqual({
      address: DEPOSIT_ADDRESS,
      amount: '25.5',
      token: BASE_USDC,
      chain: 'base',
    });
    expect(payment.verification).toBeNull();
  });

  test('a payment that needs nothing signed is returned as the backend sent it: no verification route is called', async () => {
    const { bridge, backend } = bridgeRig(server, { signer: ownerSigner() });
    backend.payments.set('pay_v', paymentFixture({ paymentId: 'pay_v' }));
    const callback = vi.fn(yes);

    const payment = await bridge.deposit(quote(), { verify: callback });

    expect(payment).toEqual(paymentFixture({ paymentId: 'pay_v' }));
    expect(callback).not.toHaveBeenCalled();
    expect(backend.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST ${BASE}/payments`,
    ]);
  });

  test('CONFIRM_UNKNOWN is returned as it is, with no deposit block (the confirm is still in flight): nothing is signed', async () => {
    const { signer, signTypedData, signMessage } = recordingSigner();
    const { bridge, backend } = bridgeRig(server, { signer });
    backend.override('confirm', () =>
      HttpResponse.json(
        paymentFixture({
          paymentId: 'pay_v',
          status: 'CONFIRM_UNKNOWN',
          hallidayStatus: null,
          deposit: null,
          fundBy: null,
        }),
      ),
    );
    const callback = vi.fn(yes);

    const payment = await bridge.deposit(quote(), { verify: callback });

    expect(payment.status).toBe('CONFIRM_UNKNOWN');
    expect(payment.deposit).toBeNull();
    expect(callback).not.toHaveBeenCalled();
    expect(signTypedData).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
    expect(backend.requests).toHaveLength(1);
  });

  test('a repeated confirm is answered with the stored payment, and nothing is asked twice of the caller', async () => {
    const { bridge, backend } = bridgeRig(server);
    const { quotes } = await bridge.quoteDeposit({
      asset: BASE_USDC,
      amount: '25.5',
    });
    const chosen = quotes[0] as BridgeQuote;
    const first = await bridge.deposit(chosen);
    const second = await bridge.deposit(chosen);
    expect(second).toEqual(first);
    expect(
      backend.requests.filter((r) => r.path === `${BASE}/payments`),
    ).toHaveLength(2);
  });
});

describe('bridge.deposit: arguments', () => {
  test('a withdrawal quote is refused with a UserInputError, before any request', async () => {
    const { bridge, backend } = bridgeRig(server, { signer: ownerSigner() });
    const error = await caught(() =>
      bridge.deposit(quote('pay_w', { direction: 'withdraw' })),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as XoError).code).toBe('invalid_input');
    expect((error as XoError).mayHaveLanded).toBe(false);
    expect((error as XoError).message).toMatch(/withdraw/i);
    expectNoRequest(backend);
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'pay_v'],
    ['an array', []],
    ['an object without a paymentId', { direction: 'deposit' }],
    ['an object without a direction', { paymentId: 'pay_v' }],
    ['a direction that is neither', { paymentId: 'pay_v', direction: 'x' }],
    ['a paymentId with a path', { paymentId: 'a/b', direction: 'deposit' }],
    ['a paymentId that is a number', { paymentId: 7, direction: 'deposit' }],
    ['an empty paymentId', { paymentId: '', direction: 'deposit' }],
  ])('a quote that is %s is refused before any request', async (_, bad) => {
    const { bridge, backend } = bridgeRig(server);
    const error = await caught(() =>
      bridge.deposit(bad as unknown as BridgeQuote),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as XoError).mayHaveLanded).toBe(false);
    expectNoRequest(backend);
  });

  test.each([
    ['an unknown option', { verfiy: yes }],
    ['a verify that is not a function', { verify: 'yes' }],
    ['a verify that is true', { verify: true }],
    ['options that are not an object', 'yes'],
    ['options that are null', null],
  ])('%s is refused before any request', async (_, options) => {
    const { bridge, backend } = bridgeRig(server);
    const error = await caught(() => bridge.deposit(quote(), options as never));
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as XoError).mayHaveLanded).toBe(false);
    expectNoRequest(backend);
  });

  test('a verify of undefined is the same as none', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.payments.set('pay_v', paymentFixture({ paymentId: 'pay_v' }));
    expect((await bridge.deposit(quote(), { verify: undefined })).status).toBe(
      'AWAITING_FUNDS',
    );
  });

  test('a config without a bridge fails with bridge_not_available before anything else', async () => {
    const { bridge, backend } = bridgeRig(server, { env: testEnv });
    const error = await caught(() => bridge.deposit(null as never));
    expect((error as XoError).code).toBe('bridge_not_available');
    expect((error as XoError).mayHaveLanded).toBe(false);
    expectNoRequest(backend);
  });

  test('a session with no credential fails at once with AuthRequiredError; the id is not known to the backend yet', async () => {
    const { bridge, backend } = bridgeRig(server, { session: 'none' });
    const error = await caught(() => bridge.deposit(quote()));
    expect(error).toBeInstanceOf(AuthRequiredError);
    expectUnlanded(error);
    expectNoRequest(backend);
  });
});

describe('bridge.deposit: errors of the confirm', () => {
  test('409 quote_expired → 409 rejection with the paymentId, mayHaveLanded false, sent once', async () => {
    const { bridge, backend } = bridgeRig(server, { signer: ownerSigner() });
    backend.override('confirm', ({ request }) =>
      exceptionResponse(request.path, 409, {
        error: 'quote_expired',
        message: 'The quote expired',
      }),
    );

    const error = await caught(() => bridge.deposit(quote(), { verify: yes }));

    expect(error).toSatisfy(rejectedWith(409));
    const xo = expectUnlanded(error);
    expect(xo.code).toBe('quote_expired');
    expect(xo.status).toBe(409);
    expect(backend.requests).toHaveLength(1);
  });

  test('404 payment_not_found → 404 rejection, mayHaveLanded false', async () => {
    const { bridge, backend } = bridgeRig(server);
    const error = await caught(() => bridge.deposit(quote('pay_nope')));
    expect(error).toSatisfy(rejectedWith(404));
    expect(expectUnlanded(error, 'pay_nope').code).toBe('payment_not_found');
    expect(backend.requests).toHaveLength(1);
  });

  test('503 from the bridge provider → 5xx rejection bridge_unavailable, mayHaveLanded true, with the paymentId, sent once', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.override('confirm', ({ request }) =>
      exceptionResponse(request.path, 503, {
        error: 'halliday_unavailable',
        message: 'down',
      }),
    );

    const error = await caught(() => bridge.deposit(quote()));

    expect(error).toSatisfy(serverFailure);
    const xo = error as XoError;
    expect(xo.code).toBe('bridge_unavailable');
    expect(xo.message).toBe('The bridge provider is unavailable');
    expect(xo.status).toBe(503);
    expect(xo.mayHaveLanded).toBe(true);
    expect(xo.paymentId).toBe('pay_v');
    expect(backend.requests).toHaveLength(1);
  });

  test('a lost connection → TransportError, mayHaveLanded true, with the paymentId', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.override('confirm', () => HttpResponse.error());
    const error = await caught(() => bridge.deposit(quote()));
    expect(error).toBeInstanceOf(TransportError);
    expect((error as XoError).mayHaveLanded).toBe(true);
    expect((error as XoError).paymentId).toBe('pay_v');
    expect(backend.requests).toHaveLength(1);
  });

  test('an unreadable 2xx → UnexpectedResponseError, mayHaveLanded true, with the paymentId', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.override('confirm', () => HttpResponse.json({ nonsense: true }));
    const error = await caught(() => bridge.deposit(quote()));
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as XoError).mayHaveLanded).toBe(true);
    expect((error as XoError).paymentId).toBe('pay_v');
  });

  test('502 from the bridge provider → bridge_rejected, mayHaveLanded true (a 5xx), with the paymentId', async () => {
    const { bridge, backend } = bridgeRig(server);
    backend.override('confirm', ({ request }) =>
      exceptionResponse(request.path, 502, {
        error: 'halliday_rejected',
        message: 'no',
      }),
    );
    const error = await caught(() => bridge.deposit(quote()));
    expect((error as XoError).code).toBe('bridge_rejected');
    expect((error as XoError).message).toBe(
      'The bridge provider refused the request',
    );
    expect((error as XoError).status).toBe(502);
    expect((error as XoError).mayHaveLanded).toBe(true);
    expect((error as XoError).paymentId).toBe('pay_v');
  });
});

describe('bridge.deposit: opt-in verification', () => {
  test('round trip: both requests are decoded and approved before any signature, then two 65-byte signatures (v 27/28) are posted', async () => {
    const events: string[] = [];
    const { signer, signTypedData, signMessage } = recordingSigner(events);
    const { bridge, backend } = bridgeRig(server, { signer });
    awaiting(backend);
    const seen: VerificationRequest[] = [];
    const callback = vi.fn(async (request: VerificationRequest) => {
      events.push(`ask:${request.signatureType}`);
      seen.push(request);
      return true;
    });

    const payment = await bridge.deposit(quote(), { verify: callback });

    // Both were asked, in order, before the first signature.
    expect(events).toEqual([
      'ask:EIP712',
      'ask:EIP191',
      'sign:typed',
      'sign:message',
    ]);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([
      {
        paymentId: 'pay_v',
        reason: 'EVM_OWNER',
        signatureType: 'EIP712',
        payload: JSON.stringify(TYPED),
        decoded: { kind: 'eip712', typedData: TYPED },
      },
      {
        paymentId: 'pay_v',
        reason: 'EVM_WITHDRAWAL',
        signatureType: 'EIP191',
        payload: TEXT,
        decoded: { kind: 'eip191', message: TEXT },
      },
    ]);
    // What was signed is what the callback was shown.
    expect(signTypedData).toHaveBeenCalledWith(TYPED);
    expect(signMessage).toHaveBeenCalledWith(TEXT);

    // The confirm, then one verification POST with the two signatures, in the items' order.
    expect(backend.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST ${BASE}/payments`,
      `POST ${BASE}/payments/pay_v/verification`,
    ]);
    const signatures = sentSignatures(backend);
    expect(
      signatures.map(({ reason, signatureType }) => ({
        reason,
        signatureType,
      })),
    ).toEqual([
      { reason: 'EVM_OWNER', signatureType: 'EIP712' },
      { reason: 'EVM_WITHDRAWAL', signatureType: 'EIP191' },
    ]);
    for (const { signature } of signatures) {
      expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
      expect(['1b', '1c']).toContain(signature.slice(-2));
    }
    expect(
      await verifyTypedData({
        address: OWNER,
        ...(TYPED as object),
        signature: (signatures[0] as { signature: Hex }).signature,
      } as Parameters<typeof verifyTypedData>[0]),
    ).toBe(true);
    expect(
      await verifyMessage({
        address: OWNER,
        message: TEXT,
        signature: (signatures[1] as { signature: Hex }).signature,
      }),
    ).toBe(true);

    // The body holds the signatures and nothing else; no token, no payload.
    expect(Object.keys(verificationPosts(backend)[0]?.body as object)).toEqual([
      'signatures',
    ]);
    // What comes back is the backend's answer to the verification.
    expect(payment.status).toBe('PROCESSING');
    expect(payment.verification).toBeNull();
  });

  test('a signer that answers v 0/1 gets 27/28 on the wire', async () => {
    const real = ownerSigner();
    const { signer } = recordingSigner([], {
      signMessage: async (message: string) => {
        const signature = await real.signMessage(message);
        const v = Number.parseInt(signature.slice(-2), 16);
        return `${signature.slice(0, -2)}${(v - 27).toString(16).padStart(2, '0')}` as Hex;
      },
    });
    const { bridge, backend } = bridgeRig(server, { signer });
    awaiting(backend, [textItem()]);

    await bridge.deposit(quote(), { verify: yes });

    const [only] = sentSignatures(backend);
    expect(['1b', '1c']).toContain(only?.signature.slice(-2));
    expect(
      await verifyMessage({
        address: OWNER,
        message: TEXT,
        signature: (only as { signature: Hex }).signature,
      }),
    ).toBe(true);
  });

  test('the owner address in a lower-case form is the same owner', async () => {
    const { signer } = recordingSigner();
    const { bridge, backend } = bridgeRig(server, { signer });
    awaiting(backend, ITEMS, { ownerAddress: OWNER.toLowerCase() });
    expect((await bridge.deposit(quote(), { verify: yes })).status).toBe(
      'PROCESSING',
    );
  });

  test('the callback is asked one item at a time, in order: the next waits for the answer', async () => {
    const { signer } = recordingSigner();
    const { bridge, backend } = bridgeRig(server, { signer });
    awaiting(backend, [typedItem(), textItem(), textItem('Second text')]);
    const events: string[] = [];
    const verify = async (request: VerificationRequest) => {
      events.push(`start:${request.signatureType}`);
      await new Promise((resolve) => setTimeout(resolve, 15));
      events.push(`end:${request.signatureType}`);
      return true;
    };

    await bridge.deposit(quote(), { verify });

    expect(events).toEqual([
      'start:EIP712',
      'end:EIP712',
      'start:EIP191',
      'end:EIP191',
      'start:EIP191',
      'end:EIP191',
    ]);
  });

  test('a callback that changes the request it is given changes nothing that is signed', async () => {
    const { signer, signTypedData } = recordingSigner();
    const { bridge, backend } = bridgeRig(server, { signer });
    awaiting(backend, [typedItem()]);
    const verify = async (request: VerificationRequest) => {
      try {
        (
          request.decoded as unknown as {
            typedData: { message: { nonce: string } };
          }
        ).typedData.message.nonce = '1';
        (request as { payload: string }).payload = 'changed';
      } catch {
        // A frozen request refuses, which is the point.
      }
      return true;
    };

    await bridge.deposit(quote(), { verify });

    expect(signTypedData).toHaveBeenCalledWith(TYPED);
    const [only] = sentSignatures(backend);
    expect(
      await verifyTypedData({
        address: OWNER,
        ...(TYPED as object),
        signature: (only as { signature: Hex }).signature,
      } as Parameters<typeof verifyTypedData>[0]),
    ).toBe(true);
  });

  test('no callback → verification_required (AuthRequiredError), mayHaveLanded false, the paymentId, no signature and no verification POST', async () => {
    const { signer, signTypedData, signMessage } = recordingSigner();
    const { bridge, backend } = bridgeRig(server, { signer });
    awaiting(backend);

    const error = await caught(() => bridge.deposit(quote()));

    expect(error).toBeInstanceOf(AuthRequiredError);
    const xo = expectUnlanded(error);
    expect(xo.code).toBe('verification_required');
    expect(xo.service).toBe('sdk');
    expect(xo.message).toMatch(/verify/);
    expect(xo.message).toMatch(/pay_v/);
    expect(signTypedData).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
    expect(verificationPosts(backend)).toHaveLength(0);
    expect(backend.requests).toHaveLength(1);
  });

  test('a callback that says no to the second item → verification_required, and not one signature is made', async () => {
    const { signer, signTypedData, signMessage } = recordingSigner();
    const { bridge, backend } = bridgeRig(server, { signer });
    awaiting(backend, [typedItem(), textItem(), textItem('Third')]);
    const verify = vi
      .fn<(request: VerificationRequest) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    const error = await caught(() => bridge.deposit(quote(), { verify }));

    expect(error).toBeInstanceOf(AuthRequiredError);
    expect(expectUnlanded(error).code).toBe('verification_required');
    // It stopped at the first no: the third was never asked.
    expect(verify).toHaveBeenCalledTimes(2);
    expect(signTypedData).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
    expect(verificationPosts(backend)).toHaveLength(0);
  });

  test.each([
    ['false', false],
    ['undefined (a callback that forgot to return)', undefined],
    ['null', null],
    ['the string "true"', 'true'],
    ['1', 1],
    ['an object', {}],
  ])(
    'a callback that answers %s is a no: only true approves',
    async (_, answer) => {
      const { signer, signTypedData, signMessage } = recordingSigner();
      const { bridge, backend } = bridgeRig(server, { signer });
      awaiting(backend);

      const error = await caught(() =>
        bridge.deposit(quote(), { verify: (async () => answer) as never }),
      );

      expect(expectUnlanded(error).code).toBe('verification_required');
      expect(signTypedData).not.toHaveBeenCalled();
      expect(signMessage).not.toHaveBeenCalled();
      expect(verificationPosts(backend)).toHaveLength(0);
    },
  );

  test('a callback that answers true without a promise is accepted', async () => {
    const { signer } = recordingSigner();
    const { bridge, backend } = bridgeRig(server, { signer });
    awaiting(backend);
    expect((await bridge.deposit(quote(), { verify: () => true })).status).toBe(
      'PROCESSING',
    );
  });

  describe('a callback that throws is a callback that did not approve', () => {
    const boom = () => new Error('the user closed the dialog SECRET-123');
    const sdk = () =>
      new UserInputError('not on my watch', { code: 'my_code' });
    const modes: [string, (thrown: unknown) => VerifyCallback][] = [
      [
        'throws synchronously',
        (thrown) => () => {
          throw thrown;
        },
      ],
      [
        'throws inside an async function',
        (thrown) => async () => {
          throw thrown;
        },
      ],
      ['returns a rejected promise', (thrown) => () => Promise.reject(thrown)],
    ];

    test.each(
      modes.flatMap(([mode, make]) =>
        [
          ['a plain Error', boom],
          ['an SDK error', sdk],
          ['a string', () => 'cancelled'],
          ['an object that is not an Error', () => ({ reason: 'closed' })],
        ].map(([what, thrown]) => [mode, what, make, thrown] as const),
      ),
    )(
      'a callback that %s %s → AuthRequiredError verification_required with the throw as its cause: nothing is signed or posted',
      async (_mode, _what, make, produce) => {
        const { signer, signTypedData, signMessage } = recordingSigner();
        const { bridge, backend } = bridgeRig(server, { signer });
        awaiting(backend);
        const thrown = (produce as () => unknown)();

        const error = await caught(() =>
          bridge.deposit(quote(), { verify: make(thrown) }),
        );

        expect(error).toBeInstanceOf(AuthRequiredError);
        const xo = expectUnlanded(error);
        expect(xo.code).toBe('verification_required');
        expect(xo.service).toBe('sdk');
        expect(xo.cause).toBe(thrown);
        // The throw's own message is not copied into ours.
        expect(xo.message).not.toContain('SECRET-123');
        expect(signTypedData).not.toHaveBeenCalled();
        expect(signMessage).not.toHaveBeenCalled();
        expect(verificationPosts(backend)).toHaveLength(0);
      },
    );

    test('an SDK error the callback throws does not keep its own class, code or flags: the caller gets verification_required, and the error is the cause', async () => {
      const { signer } = recordingSigner();
      const { bridge, backend } = bridgeRig(server, { signer });
      awaiting(backend);
      const thrown = Object.assign(sdk(), { mayHaveLanded: true });

      const error = await caught(() =>
        bridge.deposit(quote(), {
          verify: () => {
            throw thrown;
          },
        }),
      );

      expect(error).not.toBe(thrown);
      expect(error).not.toBeInstanceOf(UserInputError);
      expect(expectUnlanded(error).code).toBe('verification_required');
      expect((error as XoError).cause).toBe(thrown);
    });

    test('a callback that rejects on the second item after approving the first: still nothing is signed, and the third is never asked', async () => {
      const { signer, signTypedData, signMessage } = recordingSigner();
      const { bridge, backend } = bridgeRig(server, { signer });
      awaiting(backend, [typedItem(), textItem(), textItem('Third')]);
      const late = new Error('late');
      const verify = vi
        .fn<(request: VerificationRequest) => Promise<boolean>>()
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(late);

      const error = await caught(() => bridge.deposit(quote(), { verify }));

      expect(expectUnlanded(error).code).toBe('verification_required');
      expect((error as XoError).cause).toBe(late);
      expect(verify).toHaveBeenCalledTimes(2);
      expect(signTypedData).not.toHaveBeenCalled();
      expect(signMessage).not.toHaveBeenCalled();
      expect(verificationPosts(backend)).toHaveLength(0);
    });

    test('verify() treats a throwing callback the same way, and the payment still waits', async () => {
      const { signer } = recordingSigner();
      const { bridge, backend } = bridgeRig(server, { signer });
      awaiting(backend);
      const thrown = boom();

      const error = await caught(() =>
        bridge.verify('pay_v', {
          verify: async () => {
            throw thrown;
          },
        }),
      );

      expect(expectUnlanded(error).code).toBe('verification_required');
      expect((error as XoError).cause).toBe(thrown);
      expect(verificationPosts(backend)).toHaveLength(0);
    });
  });

  test("a signer that throws → SigningError signing_failed, mayHaveLanded false, nothing posted; the wallet's own message is not copied", async () => {
    const { signer } = recordingSigner([], {
      signMessage: async () => {
        throw new Error('wallet said: https://rpc.example/?key=SECRET');
      },
    });
    const { bridge, backend } = bridgeRig(server, { signer });
    awaiting(backend);

    const error = await caught(() => bridge.deposit(quote(), { verify: yes }));

    expect(error).toBeInstanceOf(SigningError);
    const xo = expectUnlanded(error);
    expect(xo.code).toBe('signing_failed');
    expect(JSON.stringify(xo.toJSON())).not.toContain('SECRET');
    expect(verificationPosts(backend)).toHaveLength(0);
  });

  test('a signer that returns something that is not a signature → SigningError, mayHaveLanded false, nothing posted', async () => {
    const { signer } = recordingSigner([], {
      signTypedData: async () => '0x1234' as Hex,
    });
    const { bridge, backend } = bridgeRig(server, { signer });
    awaiting(backend);

    const error = await caught(() => bridge.deposit(quote(), { verify: yes }));

    expect(error).toBeInstanceOf(SigningError);
    expectUnlanded(error);
    expect(verificationPosts(backend)).toHaveLength(0);
  });

  describe('every signature must recover to the owner before anything is posted', () => {
    const stranger = keySigner(`0x${'22'.repeat(32)}`);

    test('an EIP-712 signature by another key → SigningError signing_failed, nothing posted', async () => {
      const { signer } = recordingSigner([], {
        signTypedData: stranger.signTypedData,
      });
      const { bridge, backend } = bridgeRig(server, { signer });
      awaiting(backend, [typedItem()]);

      const error = await caught(() =>
        bridge.deposit(quote(), { verify: yes }),
      );

      expect(error).toBeInstanceOf(SigningError);
      const xo = expectUnlanded(error);
      expect(xo.code).toBe('signing_failed');
      expect(xo.message).toMatch(/recover/);
      expect(verificationPosts(backend)).toHaveLength(0);
    });

    test('an EIP-191 signature by another key → SigningError signing_failed, nothing posted', async () => {
      const { signer } = recordingSigner([], {
        signMessage: stranger.signMessage,
      });
      const { bridge, backend } = bridgeRig(server, { signer });
      awaiting(backend, [textItem()]);

      const error = await caught(() =>
        bridge.deposit(quote(), { verify: yes }),
      );

      expect(error).toBeInstanceOf(SigningError);
      expect(expectUnlanded(error).code).toBe('signing_failed');
      expect(verificationPosts(backend)).toHaveLength(0);
    });

    test('a good first signature and a bad second one: nothing is posted, not even the good one', async () => {
      const { signer } = recordingSigner([], {
        signMessage: stranger.signMessage,
      });
      const { bridge, backend } = bridgeRig(server, { signer });
      awaiting(backend);

      const error = await caught(() =>
        bridge.deposit(quote(), { verify: yes }),
      );

      expect(expectUnlanded(error).code).toBe('signing_failed');
      expect(verificationPosts(backend)).toHaveLength(0);
    });

    test('a signature over other text than was shown → signing_failed', async () => {
      const real = ownerSigner();
      const { signer } = recordingSigner([], {
        signMessage: (message: string) => real.signMessage(`${message}!`),
      });
      const { bridge, backend } = bridgeRig(server, { signer });
      awaiting(backend, [textItem()]);

      const error = await caught(() =>
        bridge.deposit(quote(), { verify: yes }),
      );

      expect(expectUnlanded(error).code).toBe('signing_failed');
      expect(verificationPosts(backend)).toHaveLength(0);
    });

    test('a signature over other typed data than was shown → signing_failed', async () => {
      const real = ownerSigner();
      const { signer } = recordingSigner([], {
        signTypedData: (td) =>
          real.signTypedData({
            ...td,
            message: { ...(td.message as object), nonce: '43' },
          } as typeof td),
      });
      const { bridge, backend } = bridgeRig(server, { signer });
      awaiting(backend, [typedItem()]);

      const error = await caught(() =>
        bridge.deposit(quote(), { verify: yes }),
      );

      expect(expectUnlanded(error).code).toBe('signing_failed');
      expect(verificationPosts(backend)).toHaveLength(0);
    });
  });
});

describe('bridge.deposit: what is always refused', () => {
  const orderTyped = {
    ...TYPED,
    primaryType: 'Order',
    types: { Order: [{ name: 'salt', type: 'uint256' }] },
    message: { salt: '1' },
  };
  const permitTyped = {
    ...TYPED,
    primaryType: 'Permit',
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
      ],
    },
    message: { owner: OWNER, spender: OWNER, value: '1' },
  };
  const authorization = (name: string) => ({
    ...TYPED,
    primaryType: name,
    types: {
      [name]: [
        { name: 'from', type: 'address' },
        { name: 'value', type: 'uint256' },
      ],
    },
    message: { from: OWNER, value: '1' },
  });
  const withDomain = (domain: Record<string, unknown>, types?: unknown) => ({
    ...TYPED,
    domain,
    ...(types === undefined
      ? {
          types: {
            ...TYPED.types,
            EIP712Domain: Object.keys(domain).map((name) => ({
              name,
              type: name === 'chainId' ? 'uint256' : 'string',
            })),
          },
        }
      : { types }),
  });

  test.each<[string, BridgeVerificationItem]>([
    ['the primary type Order', typedItem(orderTyped)],
    ['a Permit type', typedItem(permitTyped)],
    [
      'a Permit type in another letter case',
      typedItem(authorization('pErMiT')),
    ],
    [
      'a Permit nested in another struct',
      typedItem({
        ...TYPED,
        primaryType: 'Wrapper',
        types: {
          Wrapper: [{ name: 'inner', type: 'permitSingle' }],
          permitSingle: [{ name: 'value', type: 'uint256' }],
        },
        message: { inner: { value: '1' } },
      }),
    ],
    [
      'TransferWithAuthorization (EIP-3009)',
      typedItem(authorization('TransferWithAuthorization')),
    ],
    [
      'PermitWitnessTransferFrom (Permit2)',
      typedItem(authorization('PermitWitnessTransferFrom')),
    ],
    ['a Safe transaction', typedItem(authorization('SafeTx'))],
    ['an ERC-4337 user operation', typedItem(authorization('UserOperation'))],
    [
      'verifyingContract = the USDC contract',
      typedItem(bound(env.contracts.usdc)),
    ],
    [
      'verifyingContract = the CTF exchange, in lower case',
      typedItem(bound(env.contracts.ctfExchange.toLowerCase())),
    ],
    // The rig's trading identity is the EOA of OWNER.
    ['verifyingContract = the trading address', typedItem(bound(OWNER))],
    [
      'the domain of the orderbook login',
      typedItem(
        withDomain({ name: 'ClobAuthDomain', version: '1', chainId: 1 }),
      ),
    ],
    ['malformed JSON', typedItem('{"domain": ')],
    ['JSON without a message', typedItem({ ...TYPED, message: undefined })],
    [
      'EIP712Domain as the primary type',
      typedItem({ ...TYPED, primaryType: 'EIP712Domain' }),
    ],
    [
      'a domain with a key the EIP-712 domain does not have',
      typedItem(withDomain({ ...TYPED.domain, extra: 'x' })),
    ],
    [
      'a chainId that is a string',
      typedItem(withDomain({ ...TYPED.domain, chainId: '8453' })),
    ],
    [
      'an EIP712Domain type that does not match the domain',
      typedItem(
        withDomain(TYPED.domain, {
          ...TYPED.types,
          EIP712Domain: [{ name: 'name', type: 'string' }],
        }),
      ),
    ],
    [
      'a message key its struct does not have',
      typedItem({ ...TYPED, message: { ...TYPED.message, spender: OWNER } }),
    ],
    [
      'an oversize payload (over 64 KB)',
      typedItem({
        ...TYPED,
        message: { ...TYPED.message, paymentId: 'a'.repeat(70_000) },
      }),
    ],
    ['an EIP-191 payload with a NUL', textItem('Withdraw\u0000 5 USDC')],
    ['an EIP-191 message of exactly 32 bytes', textItem('a'.repeat(32))],
    ['an EIP-191 message that is hex text', textItem(`0x${'ab'.repeat(32)}`)],
    [
      'an EIP-191 sign-in message (EIP-4361) for another domain',
      textItem(
        `evil.example wants you to sign in with your Ethereum account:\n${OWNER}\n\nSign in.\n\nURI: https://evil.example\nVersion: 1\nChain ID: 1\nNonce: abcdef12`,
      ),
    ],
    [
      'signatureType OTHER',
      { reason: 'EVM_OWNER', signatureType: 'OTHER', payload: TEXT },
    ],
  ])('%s, even with a callback that says yes', async (_, bad) => {
    const events: string[] = [];
    const { signer, signTypedData, signMessage } = recordingSigner(events);
    const { bridge, backend } = bridgeRig(server, { signer });
    awaiting(backend, [bad]);
    const verify = vi.fn(yes);

    const error = await caught(() => bridge.deposit(quote(), { verify }));

    expect(error).toBeInstanceOf(SigningError);
    const xo = expectUnlanded(error);
    expect(xo.code).toBe('verification_payload_refused');
    expect(xo.service).toBe('sdk');
    expect(verify).not.toHaveBeenCalled();
    expect(signTypedData).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
    expect(verificationPosts(backend)).toHaveLength(0);
  });

  test('a refused item is refused before the callback is asked about the others: refuse first, ask second', async () => {
    const { signer, signTypedData, signMessage } = recordingSigner();
    const { bridge, backend } = bridgeRig(server, { signer });
    awaiting(backend, [typedItem(), textItem(), typedItem(orderTyped)]);
    const verify = vi.fn(yes);

    const error = await caught(() => bridge.deposit(quote(), { verify }));

    expect(expectUnlanded(error).code).toBe('verification_payload_refused');
    expect(verify).not.toHaveBeenCalled();
    expect(signTypedData).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
    expect(verificationPosts(backend)).toHaveLength(0);
  });

  test('a refused payload is refused without a callback too (it is not a verification_required)', async () => {
    const { signer } = recordingSigner();
    const { bridge, backend } = bridgeRig(server, { signer });
    awaiting(backend, [typedItem(orderTyped)]);
    const error = await caught(() => bridge.deposit(quote()));
    expect(expectUnlanded(error).code).toBe('verification_payload_refused');
  });

  test.each([
    ['none', []],
    [
      'five',
      [typedItem(), textItem(), textItem('a'), textItem('b'), textItem('c')],
    ],
  ])(
    '%s items to sign: the backend takes 1 to 4, so it is refused here',
    async (_, items) => {
      const { signer, signTypedData, signMessage } = recordingSigner();
      const { bridge, backend } = bridgeRig(server, { signer });
      awaiting(backend, items);
      const verify = vi.fn(yes);

      const error = await caught(() => bridge.deposit(quote(), { verify }));

      expect(expectUnlanded(error).code).toBe('verification_payload_refused');
      expect(verify).not.toHaveBeenCalled();
      expect(signTypedData).not.toHaveBeenCalled();
      expect(signMessage).not.toHaveBeenCalled();
      expect(verificationPosts(backend)).toHaveLength(0);
    },
  );

  test('a payment that needs verification but carries no verification block is refused too', async () => {
    const { signer } = recordingSigner();
    const { bridge, backend } = bridgeRig(server, { signer });
    awaiting(backend, [], { verification: null });
    const error = await caught(() => bridge.deposit(quote(), { verify: yes }));
    expect(expectUnlanded(error).code).toBe('verification_payload_refused');
    expect(verificationPosts(backend)).toHaveLength(0);
  });
});

describe('bridge.deposit: who may sign', () => {
  test('a signer that is not the payment owner → UserInputError signer_mismatch, mayHaveLanded false, nothing asked or signed', async () => {
    const { signer, signTypedData, signMessage } = recordingSigner([], {
      address: '0x00000000000000000000000000000000000b0b0b',
    });
    const { bridge, backend } = bridgeRig(server, { signer });
    awaiting(backend);
    const verify = vi.fn(yes);

    const error = await caught(() => bridge.deposit(quote(), { verify }));

    expect(error).toBeInstanceOf(UserInputError);
    const xo = expectUnlanded(error);
    expect(xo.code).toBe('signer_mismatch');
    expect(xo.service).toBe('sdk');
    expect(verify).not.toHaveBeenCalled();
    expect(signTypedData).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
    expect(verificationPosts(backend)).toHaveLength(0);
  });

  test('a payment with no owner address cannot be signed for: signer_mismatch', async () => {
    const { signer, signTypedData } = recordingSigner();
    const { bridge, backend } = bridgeRig(server, { signer });
    awaiting(backend, ITEMS, { ownerAddress: null });
    const error = await caught(() => bridge.deposit(quote(), { verify: yes }));
    expect(error).toBeInstanceOf(UserInputError);
    expect(expectUnlanded(error).code).toBe('signer_mismatch');
    expect(signTypedData).not.toHaveBeenCalled();
  });

  test('no signer → AuthRequiredError (auth_required) after the confirm, with the paymentId and mayHaveLanded false', async () => {
    const { bridge, backend } = bridgeRig(server);
    awaiting(backend);
    const verify = vi.fn(yes);

    const error = await caught(() => bridge.deposit(quote(), { verify }));

    expect(error).toBeInstanceOf(AuthRequiredError);
    const xo = expectUnlanded(error);
    expect(xo.code).toBe('auth_required');
    expect(verify).not.toHaveBeenCalled();
    // The confirm was sent: that is where the verification came from.
    expect(backend.requests.map((r) => r.path)).toEqual([`${BASE}/payments`]);
  });
});

describe('bridge.deposit: the trading wallet', () => {
  /** The rig's pieces, with a BridgeClient of our own that resolves `identity`. */
  function withIdentity(
    rig: ReturnType<typeof bridgeRig>,
    signer: InternalSigner,
    identity: ConstructorParameters<typeof BridgeClient>[0]['identity'],
  ) {
    return new BridgeClient({
      env: rig.env,
      transport: rig.transport,
      session: rig.session,
      identity,
      signer,
      chain: rig.chain.reader,
      account: rig.account,
    });
  }

  test('a smart wallet that trades is the trading address, and its owner is the signer: both are refused as a verifyingContract, another address is not', async () => {
    const { signer } = recordingSigner();
    const rig = bridgeRig(server, { signer });
    const bridge = withIdentity(rig, signer, async () => smartWalletIdentity());
    for (const address of [SMART_WALLET, OWNER]) {
      awaiting(rig.backend, [typedItem(bound(address))]);
      const refused = await caught(() =>
        bridge.deposit(quote(), { verify: yes }),
      );
      expect(expectUnlanded(refused).code).toBe('verification_payload_refused');
      expect(verificationPosts(rig.backend)).toHaveLength(0);
    }

    // An address that is neither XO's, the trader's nor the signer's is the callback's to judge.
    awaiting(rig.backend, [
      typedItem(bound('0x00000000000000000000000000000000000b0b0b')),
    ]);
    const accepted = await bridge.deposit(quote(), { verify: yes });
    expect(accepted.status).toBe('PROCESSING');
  });

  test('an identity that cannot be resolved fails after the confirm with its own class, the paymentId and mayHaveLanded false; nothing is asked or signed', async () => {
    const { signer, signTypedData, signMessage } = recordingSigner();
    const rig = bridgeRig(server, { signer });
    const down = new RequestRejectedError('the chain is down', {
      status: 503,
      code: 'chain_rpc_failed',
      service: 'chain',
    });
    const bridge = withIdentity(rig, signer, async () => {
      throw down;
    });
    awaiting(rig.backend);
    const verify = vi.fn(yes);

    const error = await caught(() => bridge.deposit(quote(), { verify }));

    expect(error).toSatisfy(serverFailure);
    const xo = expectUnlanded(error);
    expect(xo.code).toBe('chain_rpc_failed');
    expect(verify).not.toHaveBeenCalled();
    expect(signTypedData).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
    expect(verificationPosts(rig.backend)).toHaveLength(0);
  });
});

describe('bridge.deposit: the answer must be for the payment that was asked for', () => {
  /** A payment that waits for signatures, under another id than the one asked for. */
  const other = () =>
    paymentFixture({
      paymentId: 'pay_other',
      status: 'NEEDS_VERIFICATION',
      hallidayStatus: 'NEEDS_VERIFICATION',
      deposit: null,
      fundBy: null,
      verification: { items: ITEMS },
    });

  test('a confirm answered with another paymentId signs nothing: verification_payload_refused, mayHaveLanded false, the paymentId asked for', async () => {
    const { signer, signTypedData, signMessage } = recordingSigner();
    const { bridge, backend } = bridgeRig(server, { signer });
    backend.override('confirm', () => HttpResponse.json(other()));
    const verify = vi.fn(yes);

    const error = await caught(() => bridge.deposit(quote(), { verify }));

    expect(error).toBeInstanceOf(SigningError);
    const xo = expectUnlanded(error, 'pay_v');
    expect(xo.code).toBe('verification_payload_refused');
    expect(verify).not.toHaveBeenCalled();
    expect(signTypedData).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
    expect(verificationPosts(backend)).toHaveLength(0);
    expect(backend.requests).toHaveLength(1);
  });

  test('a read answered with another paymentId signs nothing either (verify)', async () => {
    const { signer, signTypedData } = recordingSigner();
    const { bridge, backend } = bridgeRig(server, { signer });
    backend.override('payment', () => HttpResponse.json(other()));
    const verify = vi.fn(yes);

    const error = await caught(() => bridge.verify('pay_v', { verify }));

    expect(error).toBeInstanceOf(SigningError);
    expect(expectUnlanded(error, 'pay_v').code).toBe(
      'verification_payload_refused',
    );
    expect(verify).not.toHaveBeenCalled();
    expect(signTypedData).not.toHaveBeenCalled();
    expect(verificationPosts(backend)).toHaveLength(0);
  });

  test('a paymentId that differs only in case is another payment', async () => {
    const { signer, signTypedData } = recordingSigner();
    const { bridge, backend } = bridgeRig(server, { signer });
    backend.override('confirm', () =>
      HttpResponse.json({ ...other(), paymentId: 'PAY_V' }),
    );
    const error = await caught(() => bridge.deposit(quote(), { verify: yes }));
    expect(expectUnlanded(error, 'pay_v').code).toBe(
      'verification_payload_refused',
    );
    expect(signTypedData).not.toHaveBeenCalled();
  });

  test('a paymentId that is not an id the backend gives is refused, with the id asked for on the error and nothing in the URL', async () => {
    const { signer, signTypedData } = recordingSigner();
    const { bridge, backend } = bridgeRig(server, { signer });
    backend.override('confirm', () =>
      HttpResponse.json({ ...other(), paymentId: '../assets' }),
    );
    const error = await caught(() => bridge.deposit(quote(), { verify: yes }));
    expect(expectUnlanded(error, 'pay_v').code).toBe(
      'verification_payload_refused',
    );
    expect(signTypedData).not.toHaveBeenCalled();
    expect(backend.requests).toHaveLength(1);
  });
});

describe('bridge.deposit: errors of the verification', () => {
  test('422 verification_failed → a 422 RequestRejectedError, mayHaveLanded false, one verification POST and no refresh or resend', async () => {
    const { signer } = recordingSigner();
    const { bridge, backend } = bridgeRig(server, { signer });
    awaiting(backend);
    backend.override('verification', ({ request }) =>
      exceptionResponse(request.path, 422, {
        error: 'verification_failed',
        message: 'The signatures were refused',
      }),
    );

    const error = await caught(() => bridge.deposit(quote(), { verify: yes }));

    expect(error).toSatisfy(rejectedWith(422));
    const xo = expectUnlanded(error);
    expect(xo.code).toBe('verification_failed');
    expect(xo.status).toBe(422);
    expect(verificationPosts(backend)).toHaveLength(1);
    // The confirm and the one verification: nothing was refreshed with a GET, nothing resent.
    expect(backend.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST ${BASE}/payments`,
      `POST ${BASE}/payments/pay_v/verification`,
    ]);
  });

  test('503 on the verification → 5xx rejection, mayHaveLanded true, the paymentId, sent once', async () => {
    const { signer } = recordingSigner();
    const { bridge, backend } = bridgeRig(server, { signer });
    awaiting(backend);
    backend.override('verification', ({ request }) =>
      exceptionResponse(request.path, 503, {
        error: 'halliday_unavailable',
        message: 'down',
      }),
    );

    const error = await caught(() => bridge.deposit(quote(), { verify: yes }));

    expect(error).toSatisfy(serverFailure);
    expect((error as XoError).mayHaveLanded).toBe(true);
    expect((error as XoError).paymentId).toBe('pay_v');
    expect(verificationPosts(backend)).toHaveLength(1);
  });

  test('a lost connection on the verification → TransportError, mayHaveLanded true', async () => {
    const { signer } = recordingSigner();
    const { bridge, backend } = bridgeRig(server, { signer });
    awaiting(backend);
    backend.override('verification', () => HttpResponse.error());
    const error = await caught(() => bridge.deposit(quote(), { verify: yes }));
    expect(error).toBeInstanceOf(TransportError);
    expect((error as XoError).mayHaveLanded).toBe(true);
    expect((error as XoError).paymentId).toBe('pay_v');
    expect(verificationPosts(backend)).toHaveLength(1);
  });

  test('409 payment_not_awaiting_verification → 409 rejection, mayHaveLanded false', async () => {
    const { signer } = recordingSigner();
    const { bridge, backend } = bridgeRig(server, { signer });
    awaiting(backend);
    backend.override('verification', ({ request }) =>
      exceptionResponse(request.path, 409, {
        error: 'payment_not_awaiting_verification',
        message: 'The payment is not awaiting verification',
      }),
    );
    const error = await caught(() => bridge.deposit(quote(), { verify: yes }));
    expect(error).toSatisfy(rejectedWith(409));
    expect(expectUnlanded(error).code).toBe(
      'payment_not_awaiting_verification',
    );
  });
});

describe('bridge.verify', () => {
  test('on a payment that is not awaiting verification it returns it unchanged: one GET, no POST, nothing signed or asked', async () => {
    const { signer, signTypedData, signMessage } = recordingSigner();
    const { bridge, backend } = bridgeRig(server, { signer });
    backend.payments.set('pay_v', paymentFixture({ paymentId: 'pay_v' }));
    const verify = vi.fn(yes);

    const payment = await bridge.verify('pay_v', { verify });

    expect(payment).toEqual(paymentFixture({ paymentId: 'pay_v' }));
    expect(backend.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET ${BASE}/payments/pay_v`,
    ]);
    expect(verify).not.toHaveBeenCalled();
    expect(signTypedData).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
  });

  test("on a payment awaiting verification it asks, signs and posts, and returns the backend's answer", async () => {
    const events: string[] = [];
    const { signer } = recordingSigner(events);
    const { bridge, backend } = bridgeRig(server, { signer });
    awaiting(backend);

    const payment = await bridge.verify('pay_v', {
      verify: async (request) => {
        events.push(`ask:${request.signatureType}`);
        return true;
      },
    });

    expect(events).toEqual([
      'ask:EIP712',
      'ask:EIP191',
      'sign:typed',
      'sign:message',
    ]);
    expect(backend.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET ${BASE}/payments/pay_v`,
      `POST ${BASE}/payments/pay_v/verification`,
    ]);
    expect(sentSignatures(backend)).toHaveLength(2);
    expect(payment.status).toBe('PROCESSING');
  });

  test('it finishes what a deposit left open: deposit() without a callback, then verify() with one', async () => {
    const { signer } = recordingSigner();
    const { bridge, backend } = bridgeRig(server, { signer });
    awaiting(backend);

    const first = await caught(() => bridge.deposit(quote()));
    expect((first as XoError).code).toBe('verification_required');
    const id = (first as XoError).paymentId as string;

    const payment = await bridge.verify(id, { verify: yes });

    expect(payment.status).toBe('PROCESSING');
    expect(verificationPosts(backend)).toHaveLength(1);
  });

  test('verify() on a refused payload signs nothing', async () => {
    const { signer, signTypedData } = recordingSigner();
    const { bridge, backend } = bridgeRig(server, { signer });
    awaiting(backend, [
      typedItem({ ...TYPED, primaryType: 'Permit', types: { Permit: [] } }),
    ]);
    const error = await caught(() => bridge.verify('pay_v', { verify: yes }));
    expect(expectUnlanded(error).code).toBe('verification_payload_refused');
    expect(signTypedData).not.toHaveBeenCalled();
    expect(verificationPosts(backend)).toHaveLength(0);
  });

  test.each([
    ['no options', undefined],
    ['empty options', {}],
    ['a verify that is not a function', { verify: 'yes' }],
    ['a verify of undefined', { verify: undefined }],
    ['an unknown option', { verify: yes, again: true }],
    ['options that are null', null],
  ])('%s is a UserInputError before any request', async (_, options) => {
    const { bridge, backend } = bridgeRig(server, { signer: ownerSigner() });
    const error = await caught(() => bridge.verify('pay_v', options as never));
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as XoError).code).toBe('invalid_input');
    expect((error as XoError).mayHaveLanded).toBe(false);
    expectNoRequest(backend);
  });

  test.each(['p/1', '../x', '', 'p?x=1'])(
    'the payment id %j is refused before any request',
    async (id) => {
      const { bridge, backend } = bridgeRig(server, { signer: ownerSigner() });
      const error = await caught(() => bridge.verify(id, { verify: yes }));
      expect(error).toBeInstanceOf(UserInputError);
      expect((error as XoError).mayHaveLanded).toBe(false);
      expectNoRequest(backend);
    },
  );

  test('an unknown payment → 404 rejection with the paymentId, mayHaveLanded false', async () => {
    const { bridge, backend } = bridgeRig(server, { signer: ownerSigner() });
    const error = await caught(() =>
      bridge.verify('pay_nope', { verify: yes }),
    );
    expect(error).toSatisfy(rejectedWith(404));
    expectUnlanded(error, 'pay_nope');
    expect(backend.requests).toHaveLength(1);
  });

  test('a config without a bridge fails with bridge_not_available', async () => {
    const { bridge, backend } = bridgeRig(server, { env: testEnv });
    const error = await caught(() => bridge.verify('pay_v', { verify: yes }));
    expect((error as XoError).code).toBe('bridge_not_available');
    expectNoRequest(backend);
  });

  test("a failing verification POST is classified as the deposit's is: 422 → false, 503 → true", async () => {
    const { signer } = recordingSigner();
    const { bridge, backend } = bridgeRig(server, { signer });
    awaiting(backend);
    backend.override('verification', ({ request }) =>
      exceptionResponse(request.path, 422, {
        error: 'verification_failed',
        message: 'no',
      }),
    );
    const refused = await caught(() => bridge.verify('pay_v', { verify: yes }));
    expect(expectUnlanded(refused).code).toBe('verification_failed');

    backend.override('verification', ({ request }) =>
      exceptionResponse(request.path, 503, {
        error: 'halliday_unavailable',
        message: 'down',
      }),
    );
    const down = await caught(() => bridge.verify('pay_v', { verify: yes }));
    expect((down as XoError).mayHaveLanded).toBe(true);
    expect((down as XoError).paymentId).toBe('pay_v');
  });
});
