import { delay, HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import type { Hex } from 'viem';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import pkg from '../../package.json';
import {
  type SponsorRequestBody,
  sponsorSend,
  toSponsorTx,
} from '../../src/account/sponsorClient';
import type { EnvironmentConfig } from '../../src/core/env';
import {
  RateLimitError,
  TransactionFailedError,
  UserInputError,
} from '../../src/core/errors';
import { Transport } from '../../src/core/transport';
import type { EvTx } from '../../src/signing/evTx';
import { OWNER, TX_HASH } from '../helpers/railChain';
import { rejectedWith } from '../helpers/rejections';
import { testEnv } from '../helpers/testEnv';

const env = testEnv;
const SEND_URL = `${env.sponsorUrl}/v1/sponsor/send`;
const SPONSOR: Hex = '0x49c3b3b4adcaa889cd42934f20f5a563d0bbfde8';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const transport = (e: EnvironmentConfig = env) =>
  new Transport({ env: e, version: pkg.version });

const TX: EvTx = {
  chainId: BigInt(env.chainId),
  nonce: 0n,
  maxPriorityFeePerGas: 1_000_000_000n,
  maxFeePerGas: 1_000_000_000n,
  gasLimit: 78_736n,
  calls: [
    {
      to: env.contracts.usdc,
      value: 0n,
      input: '0x095ea7b3',
    },
  ],
  accessList: [],
};

const BODY: SponsorRequestBody = {
  tx: toSponsorTx(TX),
  executorSignature: `0x${'12'.repeat(64)}1b`,
};

/** Installs a `/send` handler and returns the requests it saw. */
function onSend(reply: () => Response | Promise<Response>): Request[] {
  const seen: Request[] = [];
  server.use(
    http.post(SEND_URL, ({ request }) => {
      seen.push(request.clone());
      return reply();
    }),
  );
  return seen;
}

describe('toSponsorTx', () => {
  test('hex quantities, calls as {to, value, data}, no accessList when empty', () => {
    expect(toSponsorTx(TX)).toEqual({
      chainId: '0x7a69',
      nonce: '0x0',
      maxPriorityFeePerGas: '0x3b9aca00',
      maxFeePerGas: '0x3b9aca00',
      gasLimit: '0x13390',
      calls: [
        {
          to: env.contracts.usdc,
          value: '0x0',
          data: '0x095ea7b3',
        },
      ],
    });
  });

  test('keeps a non-empty access list', () => {
    const accessList = [
      { address: OWNER, storageKeys: [`0x${'00'.repeat(32)}` as Hex] },
    ];
    expect(toSponsorTx({ ...TX, accessList }).accessList).toEqual(accessList);
  });
});

describe('sponsorSend', () => {
  test('POSTs the body as JSON to /v1/sponsor/send and returns the answer', async () => {
    const seen = onSend(() =>
      HttpResponse.json({ txHash: TX_HASH, sponsor: SPONSOR, executor: OWNER }),
    );
    const out = await sponsorSend(transport(), BODY);
    expect(out).toEqual({ txHash: TX_HASH, sponsor: SPONSOR, executor: OWNER });
    expect(seen).toHaveLength(1);
    const request = seen[0] as Request;
    expect(request.method).toBe('POST');
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(request.headers.get('x-xo-sdk')).toBe(`ts/${pkg.version}`);
    expect(await request.json()).toEqual(JSON.parse(JSON.stringify(BODY)));
  });

  test('403 policy_rejected → 403 rejection, mayHaveLanded false, sent once', async () => {
    const seen = onSend(() =>
      HttpResponse.json(
        {
          error: {
            code: 'policy_rejected',
            message:
              'contract 0x000000000000000000000000000000000000dEaD is not allowed',
          },
        },
        { status: 403 },
      ),
    );
    const error = await sponsorSend(transport(), BODY).catch((e) => e);
    expect(error).toSatisfy(rejectedWith(403));
    expect(error.code).toBe('policy_rejected');
    expect(error.status).toBe(403);
    expect(error.service).toBe('sponsor');
    expect(error.mayHaveLanded).toBe(false);
    expect(error.message).toContain('is not allowed');
    expect(seen).toHaveLength(1);
  });

  test('400 → a 400 RequestRejectedError, mayHaveLanded false', async () => {
    onSend(() =>
      HttpResponse.json(
        { error: { code: 'signature_recovery_failed', message: 'bad sig' } },
        { status: 400 },
      ),
    );
    const error = await sponsorSend(transport(), BODY).catch((e) => e);
    expect(error).toSatisfy(rejectedWith(400));
    expect(error.code).toBe('signature_recovery_failed');
    expect(error.mayHaveLanded).toBe(false);
  });

  test('429 → RateLimitError, mayHaveLanded false, not retried', async () => {
    const seen = onSend(() =>
      HttpResponse.json(
        { error: { code: 'overloaded', message: 'busy' } },
        { status: 429, headers: { 'retry-after': '1' } },
      ),
    );
    const error = await sponsorSend(transport(), BODY).catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.mayHaveLanded).toBe(false);
    expect(seen).toHaveLength(1);
  });

  test.each([500, 502, 503, 504])(
    '%i → TransactionFailedError mayHaveLanded true, never resent',
    async (status) => {
      const seen = onSend(() =>
        HttpResponse.json(
          { error: { code: 'submit_failed', message: 'node said no' } },
          { status },
        ),
      );
      const error = await sponsorSend(transport(), BODY).catch((e) => e);
      expect(error).toBeInstanceOf(TransactionFailedError);
      expect(error.mayHaveLanded).toBe(true);
      expect(error.txHash).toBeUndefined();
      expect(error.service).toBe('sponsor');
      expect(error.cause.status).toBe(status);
      expect(seen).toHaveLength(1);
    },
  );

  test('network error → TransactionFailedError mayHaveLanded true, sent once', async () => {
    const seen = onSend(() => HttpResponse.error());
    const error = await sponsorSend(transport(), BODY).catch((e) => e);
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(error.mayHaveLanded).toBe(true);
    expect(error.code).toBe('sponsor_outcome_unknown');
    expect(seen).toHaveLength(1);
  });

  test('an ambiguous failure carries the nonce of the body and names the executor', async () => {
    onSend(() => HttpResponse.error());
    const body = { ...BODY, tx: { ...BODY.tx, nonce: '0x2a' as Hex } };
    const error = await sponsorSend(transport(), body, {
      executor: OWNER,
    }).catch((e) => e);
    expect(error.nonce).toBe(42n);
    expect(error.message).toContain(
      `check which transaction used nonce 42 from executor ${OWNER}`,
    );
    // Without an executor the advice still names the nonce.
    const bare = await sponsorSend(transport(), body).catch((e) => e);
    expect(bare.message).toContain('check which transaction used nonce 42');
  });

  test('timeout → TransactionFailedError mayHaveLanded true', async () => {
    const seen = onSend(async () => {
      await delay('infinite');
      return HttpResponse.json({});
    });
    const error = await sponsorSend(transport(), BODY, { timeoutMs: 30 }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(error.mayHaveLanded).toBe(true);
    expect(error.cause.code).toBe('timeout');
    expect(seen).toHaveLength(1);
  });

  test.each([
    [
      'invalid JSON',
      () =>
        new HttpResponse('{not json', {
          headers: { 'content-type': 'application/json' },
        }),
    ],
    ['an empty body', () => new HttpResponse(null, { status: 200 })],
    ['plain text', () => HttpResponse.text('ok')],
    [
      'no txHash',
      () => HttpResponse.json({ sponsor: SPONSOR, executor: OWNER }),
    ],
    [
      'a short txHash',
      () => HttpResponse.json({ txHash: '0xabcd', executor: OWNER }),
    ],
    ['a JSON array', () => HttpResponse.json([TX_HASH])],
  ])(
    '2xx with %s → TransactionFailedError mayHaveLanded true, no hash',
    async (_, reply) => {
      const seen = onSend(reply);
      const error = await sponsorSend(transport(), BODY).catch((e) => e);
      expect(error).toBeInstanceOf(TransactionFailedError);
      expect(error.mayHaveLanded).toBe(true);
      expect(error.txHash).toBeUndefined();
      expect(seen).toHaveLength(1);
    },
  );

  test('2xx whose executor is not an address → still returns the hash, executor left out', async () => {
    onSend(() => HttpResponse.json({ txHash: TX_HASH, executor: 'nope' }));
    await expect(sponsorSend(transport(), BODY)).resolves.toEqual({
      txHash: TX_HASH,
    });
  });

  test('no sponsorUrl → UserInputError sponsor_not_configured, nothing sent', async () => {
    const seen = onSend(() => HttpResponse.json({ txHash: TX_HASH }));
    const { sponsorUrl: _, ...rest } = env;
    const error = await sponsorSend(transport(rest), BODY).catch((e) => e);
    expect(error).toBeInstanceOf(UserInputError);
    expect(error.code).toBe('sponsor_not_configured');
    expect(error.mayHaveLanded).toBe(false);
    expect(seen).toHaveLength(0);
  });
});
