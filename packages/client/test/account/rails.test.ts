import { delay, HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import {
  type Hex,
  keccak256,
  numberToHex,
  parseTransaction,
  recoverTransactionAddress,
} from 'viem';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';
import { createChainReader } from '../../src/account/chain';
import { resetNonceTracking, setNonceClock } from '../../src/account/internal';
import {
  DirectRail,
  preflightRail,
  RECEIPT_TIMEOUT_MS,
  resolveGasLimit,
  SponsoredRail,
} from '../../src/account/rails';
import type { SponsorRequestBody } from '../../src/account/sponsorClient';
import type { EnvironmentConfig } from '../../src/core/env';
import {
  SigningError,
  TimeoutError,
  TransactionFailedError,
  UserInputError,
  XoError,
} from '../../src/core/errors';
import {
  type EvCall,
  estimateIntrinsicGas,
  MAX_CALLDATA_BYTES,
  MAX_CALLS,
} from '../../src/signing/evTx';
import {
  type Call,
  kernelCreateAccountCalldata,
  kernelExecuteCalldata,
} from '../../src/signing/kernel';
import type { InternalSigner } from '../../src/wallet/signer';
import {
  addressWord,
  call,
  eoaIdentity,
  executorOf,
  highSSigner,
  isLowS,
  noRawSigner,
  OWNER,
  ownerSigner,
  type RailChainStub,
  railChain,
  SMART_WALLET,
  smartWalletIdentity,
  TX_HASH,
} from '../helpers/railChain';
import { rejectedWith } from '../helpers/rejections';
import { keySigner } from '../helpers/signers';
import { testEnv } from '../helpers/testEnv';

const env = testEnv;
const SEND_URL = `${env.sponsorUrl}/v1/sponsor/send`;
const GWEI = 1_000_000_000n;
/** Half the secp256k1 curve order: a canonical (low-s) signature has s at most this. */
const HALF_N = BigInt(
  '0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0',
);

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
// The accepted-nonce record is per process: every test starts without one, and on the default
// monotonic clock.
beforeEach(() => resetNonceTracking());
afterEach(() => setNonceClock(undefined));

/** What the fake sponsor saw. */
interface SponsorLog {
  bodies: SponsorRequestBody[];
}

type Reply = (
  body: SponsorRequestBody,
  n: number,
) => Response | Promise<Response>;

const ok: Reply = () =>
  HttpResponse.json({
    txHash: TX_HASH,
    sponsor: '0x49c3b3b4adcaa889cd42934f20f5a563d0bbfde8',
    executor: OWNER,
  });

function sponsor(reply: Reply = ok): SponsorLog {
  const log: SponsorLog = { bodies: [] };
  server.use(
    http.post(SEND_URL, async ({ request }) => {
      const body = (await request.json()) as SponsorRequestBody;
      log.bodies.push(body);
      return reply(body, log.bodies.length);
    }),
  );
  return log;
}

function sponsoredRail(
  o: {
    chain?: RailChainStub;
    identity?: ReturnType<typeof eoaIdentity>;
    signer?: InternalSigner;
    env?: EnvironmentConfig;
  } = {},
) {
  const chain = o.chain ?? railChain();
  const rail = new SponsoredRail({
    env: o.env ?? env,
    identity: o.identity ?? eoaIdentity(),
    signer: o.signer ?? ownerSigner(),
    chain: chain.reader,
  });
  return { rail, chain };
}

function directRail(
  o: {
    chain?: RailChainStub;
    identity?: ReturnType<typeof eoaIdentity>;
    signer?: InternalSigner;
    env?: EnvironmentConfig;
  } = {},
) {
  const chain = o.chain ?? railChain();
  const rail = new DirectRail({
    env: o.env ?? env,
    identity: o.identity ?? eoaIdentity(),
    signer: o.signer ?? ownerSigner(),
    chain: chain.reader,
  });
  return { rail, chain };
}

/** A signer whose `signHash` answers `signature` whatever it is asked. */
function answering(signature: string): InternalSigner {
  const owner = ownerSigner();
  return {
    ...owner,
    address: owner.address,
    signHash: async () => signature as Hex,
  };
}

const margin = (gas: bigint) => (gas * 125n) / 100n;

async function failure(p: Promise<unknown>): Promise<XoError> {
  const error = await p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(XoError);
  return error as XoError;
}

// ---------------------------------------------------------------------------
// SponsoredRail
// ---------------------------------------------------------------------------

describe('SponsoredRail: EOA', () => {
  test('eoa: one 0x76 tx with the calls as top-level calls; executor = owner; POST /v1/sponsor/send body {tx, executorSignature}', async () => {
    const sent = sponsor();
    const { rail, chain } = sponsoredRail();
    const calls: Call[] = [call(1), { ...call(2), value: 3n }];

    const result = await rail.send(calls);

    expect(result).toEqual({
      txHash: TX_HASH,
      status: 'success',
      blockNumber: 42n,
    });
    expect(sent.bodies).toHaveLength(1);
    const body = sent.bodies[0] as SponsorRequestBody;
    expect(Object.keys(body).sort()).toEqual(['executorSignature', 'tx']);
    expect(Object.keys(body.tx).sort()).toEqual(
      [
        'calls',
        'chainId',
        'gasLimit',
        'maxFeePerGas',
        'maxPriorityFeePerGas',
        'nonce',
      ].sort(),
    );
    expect(body.tx.calls).toEqual([
      { to: call(1).to, value: '0x0', data: call(1).data },
      { to: call(2).to, value: '0x3', data: call(2).data },
    ]);
    // Hex quantities: chain id, the pending nonce, 1 gwei fee floor, the margined bundle gas.
    expect(body.tx.chainId).toBe('0x7a69');
    expect(body.tx.nonce).toBe('0x5');
    expect(body.tx.maxFeePerGas).toBe('0x3b9aca00');
    expect(body.tx.maxPriorityFeePerGas).toBe('0x3b9aca00');
    expect(body.tx.gasLimit).toBe(numberToHex(margin(200_000n)));
    expect(body.executorSignature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(['1b', '1c']).toContain(body.executorSignature.slice(-2));
    expect(await executorOf(body)).toBe(OWNER);
    // The receipt is awaited for the sponsor's hash, for 120 s.
    expect(chain.log.at(-1)).toEqual({
      method: 'waitForReceipt',
      args: [TX_HASH, 120_000],
    });
    expect(RECEIPT_TIMEOUT_MS).toBe(120_000);
    expect(chain.count('getCode')).toBe(0);
  });

  test('the nonce is read as pending from the owner', async () => {
    sponsor();
    const { rail, chain } = sponsoredRail();
    await rail.send([call()]);
    expect(chain.log.find((c) => c.method === 'getNonce')?.args).toEqual([
      OWNER,
    ]);
  });

  test('a single call is sized by estimateGas from the owner, plus 25%', async () => {
    const sent = sponsor();
    const { rail, chain } = sponsoredRail();
    chain.estimate = 120_000n;
    await rail.send([{ ...call(), value: 9n }]);
    expect(chain.log.find((c) => c.method === 'estimateGas')?.args).toEqual([
      { from: OWNER, to: call().to, data: call().data, value: 9n },
    ]);
    expect(chain.count('simulateBundleGas')).toBe(0);
    expect(sent.bodies[0]?.tx.gasLimit).toBe(numberToHex(margin(120_000n)));
  });

  test('chain fees above the 1 gwei floor are used as they are', async () => {
    const sent = sponsor();
    const { rail, chain } = sponsoredRail();
    chain.fees = { maxFeePerGas: 7n * GWEI, maxPriorityFeePerGas: 2n * GWEI };
    await rail.send([call()]);
    expect(sent.bodies[0]?.tx.maxFeePerGas).toBe(numberToHex(7n * GWEI));
    expect(sent.bodies[0]?.tx.maxPriorityFeePerGas).toBe(
      numberToHex(2n * GWEI),
    );
  });

  test('a reverted receipt is returned, not thrown', async () => {
    sponsor();
    const { rail, chain } = sponsoredRail();
    chain.receipt = (hash) => ({
      txHash: hash,
      status: 'reverted',
      blockNumber: 9n,
    });
    await expect(rail.send([call()])).resolves.toEqual({
      txHash: TX_HASH,
      status: 'reverted',
      blockNumber: 9n,
    });
  });

  test('high-s signature from the signer is reduced to low-s, and still recovers to the owner', async () => {
    const sent = sponsor();
    const { rail } = sponsoredRail({ signer: highSSigner() });
    await rail.send([call()]);
    const body = sent.bodies[0] as SponsorRequestBody;
    expect(isLowS(body.executorSignature)).toBe(true);
    expect(await executorOf(body)).toBe(OWNER);
  });

  test('a signer that answers v as 0/1 is accepted (canonical 27/28 on the wire)', async () => {
    const sent = sponsor();
    const base = ownerSigner();
    const signer: InternalSigner = {
      ...base,
      address: base.address,
      signHash: async (hash: Hex) => {
        const sig = await (
          base.signHash as NonNullable<InternalSigner['signHash']>
        )(hash);
        const v = Number.parseInt(sig.slice(-2), 16) - 27;
        return `${sig.slice(0, -2)}0${v}` as Hex;
      },
    };
    const { rail } = sponsoredRail({ signer });
    await rail.send([call()]);
    const body = sent.bodies[0] as SponsorRequestBody;
    expect(['1b', '1c']).toContain(body.executorSignature.slice(-2));
    expect(await executorOf(body)).toBe(OWNER);
  });

  test('the sponsor answering another executor → TransactionFailedError mayHaveLanded true with txHash', async () => {
    sponsor(() =>
      HttpResponse.json({ txHash: TX_HASH, executor: `0x${'99'.repeat(20)}` }),
    );
    const { rail, chain } = sponsoredRail();
    const error = await failure(rail.send([call()]));
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(error.mayHaveLanded).toBe(true);
    expect((error as TransactionFailedError).transactionHash).toBe(TX_HASH);
    expect(chain.count('waitForReceipt')).toBe(0);
  });
});

describe('SponsoredRail: smart wallet', () => {
  test('smart wallet: single top-level call to account.execute(...)', async () => {
    const sent = sponsor();
    const { rail, chain } = sponsoredRail({ identity: smartWalletIdentity() });
    const calls: Call[] = [call(1), call(2)];
    await rail.send(calls);

    const body = sent.bodies[0] as SponsorRequestBody;
    expect(body.tx.calls).toEqual([
      { to: SMART_WALLET, value: '0x0', data: kernelExecuteCalldata(calls) },
    ]);
    // The executor is the owner EOA, not the account.
    expect(await executorOf(body)).toBe(OWNER);
    expect(chain.log.find((c) => c.method === 'getNonce')?.args).toEqual([
      OWNER,
    ]);
    expect(chain.log.find((c) => c.method === 'getCode')?.args).toEqual([
      SMART_WALLET,
    ]);
    // One top-level call: estimateGas from the owner to the account.
    expect(chain.log.find((c) => c.method === 'estimateGas')?.args).toEqual([
      {
        from: OWNER,
        to: SMART_WALLET,
        data: kernelExecuteCalldata(calls),
        value: 0n,
      },
    ]);
    expect(chain.count('readContract')).toBe(0);
  });

  test('undeployed smart wallet (getCode 0x): factory.createAccount call prepended', async () => {
    const sent = sponsor();
    const chain = railChain();
    chain.code.clear();
    chain.read = addressWord(SMART_WALLET);
    const { rail } = sponsoredRail({
      chain,
      identity: smartWalletIdentity(OWNER, SMART_WALLET, 3n),
    });
    const calls: Call[] = [call(1)];
    await rail.send(calls);

    const create = kernelCreateAccountCalldata(
      OWNER,
      3n,
      env.contracts.ecdsaValidator,
    );
    const execute = kernelExecuteCalldata(calls);
    const body = sent.bodies[0] as SponsorRequestBody;
    expect(body.tx.calls).toEqual([
      { to: env.contracts.kernelFactory, value: '0x0', data: create },
      { to: SMART_WALLET, value: '0x0', data: execute },
    ]);
    // The factory is asked first where it would deploy: it must be the account.
    expect(chain.log.find((c) => c.method === 'readContract')?.args).toEqual([
      { to: env.contracts.kernelFactory, data: create },
    ]);
    // A deploy-prefixed batch is sized by bundle simulation, never by a lone estimate.
    expect(chain.count('estimateGas')).toBe(0);
    expect(
      chain.log.find((c) => c.method === 'simulateBundleGas')?.args,
    ).toEqual([
      {
        from: OWNER,
        calls: [
          { to: env.contracts.kernelFactory, value: 0n, data: create },
          { to: SMART_WALLET, value: 0n, data: execute },
        ],
      },
    ]);
    expect(body.tx.gasLimit).toBe(numberToHex(margin(200_000n)));
  });

  test("undeployed smart wallet (getCode '0x0', as some nodes answer): createAccount prepended too", async () => {
    const sent = sponsor();
    const chain = railChain();
    chain.code.set(SMART_WALLET.toLowerCase(), '0x0');
    chain.read = addressWord(SMART_WALLET);
    const { rail } = sponsoredRail({ chain, identity: smartWalletIdentity() });
    await rail.send([call()]);
    const body = sent.bodies[0] as SponsorRequestBody;
    expect(body.tx.calls.map((c) => c.to)).toEqual([
      env.contracts.kernelFactory,
      SMART_WALLET,
    ]);
  });

  test('undeployed smart wallet whose factory predicts another address → UserInputError, nothing sent', async () => {
    const sent = sponsor();
    const chain = railChain();
    chain.code.clear();
    chain.read = addressWord(`0x${'77'.repeat(20)}`);
    const { rail } = sponsoredRail({ chain, identity: smartWalletIdentity() });
    const error = await failure(rail.send([call()]));
    expect(error).toBeInstanceOf(UserInputError);
    expect(error.code).toBe('smart_wallet_address_mismatch');
    expect(error.mayHaveLanded).toBe(false);
    expect(sent.bodies).toHaveLength(0);
  });

  test('a deployed account is remembered: getCode is read once', async () => {
    sponsor();
    const { rail, chain } = sponsoredRail({ identity: smartWalletIdentity() });
    await rail.send([call()]);
    await rail.send([call()]);
    expect(chain.count('getCode')).toBe(1);
  });

  test('an undeployed account is checked again on the next send', async () => {
    sponsor();
    const chain = railChain();
    chain.code.clear();
    chain.read = addressWord(SMART_WALLET);
    const { rail } = sponsoredRail({ chain, identity: smartWalletIdentity() });
    await rail.send([call()]);
    await rail.send([call()]);
    expect(chain.count('getCode')).toBe(2);
  });

  test('>32 inner calls → UserInputError, nothing read or sent', async () => {
    const sent = sponsor();
    const { rail, chain } = sponsoredRail({ identity: smartWalletIdentity() });
    const calls = Array.from({ length: MAX_CALLS + 1 }, (_, i) => call(i));
    const error = await failure(rail.send(calls));
    expect(error).toBeInstanceOf(UserInputError);
    expect(error.mayHaveLanded).toBe(false);
    expect(chain.log).toEqual([]);
    expect(sent.bodies).toHaveLength(0);
  });

  test('an execute calldata over MAX_CALLDATA_BYTES → UserInputError, nothing sent', async () => {
    const sent = sponsor();
    const { rail, chain } = sponsoredRail({ identity: smartWalletIdentity() });
    // Two calls of 64 KiB each fit one by one but not wrapped together.
    const half = `0x${'ab'.repeat(MAX_CALLDATA_BYTES / 2)}` as Hex;
    const error = await failure(
      rail.send([
        { ...call(), data: half },
        { ...call(), data: half },
      ]),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect(error.message).toContain(String(MAX_CALLDATA_BYTES));
    expect(chain.log).toEqual([]);
    expect(sent.bodies).toHaveLength(0);
  });

  test('a smart wallet identity without an index → UserInputError', async () => {
    const sent = sponsor();
    const { index: _, ...identity } = smartWalletIdentity();
    const { rail, chain } = sponsoredRail({
      identity: identity as ReturnType<typeof smartWalletIdentity>,
    });
    const error = await failure(rail.send([call()]));
    expect(error).toBeInstanceOf(UserInputError);
    expect(chain.log).toEqual([]);
    expect(sent.bodies).toHaveLength(0);
  });

  test('an identity of the old kernel type → UserInputError, nothing read or sent', async () => {
    const sent = sponsor();
    const identity = { ...smartWalletIdentity(), type: 'kernel' };
    const { rail, chain } = sponsoredRail({
      identity: identity as unknown as ReturnType<typeof smartWalletIdentity>,
    });
    const error = await failure(rail.send([call()]));
    expect(error).toBeInstanceOf(UserInputError);
    expect(error.message).toBe('identity.type must be "eoa" or "smart_wallet"');
    expect(error.mayHaveLanded).toBe(false);
    expect(chain.log).toEqual([]);
    expect(sent.bodies).toHaveLength(0);
  });
});

describe('SponsoredRail: nonces', () => {
  test('two concurrent sends from same executor run sequentially with nonces n, n+1', async () => {
    const chain = railChain();
    chain.nonce = 5n;
    const sent = sponsor(async (_, n) => {
      // The sponsor broadcasts: the pending nonce moves on once the node has the tx.
      await delay(20);
      chain.nonce += 1n;
      return HttpResponse.json({
        txHash: `0x${n.toString(16).padStart(64, '0')}`,
        executor: OWNER,
      });
    });
    const { rail } = sponsoredRail({ chain });
    const [a, b] = await Promise.all([
      rail.send([call(1)]),
      rail.send([call(2)]),
    ]);

    expect(sent.bodies.map((body) => body.tx.nonce)).toEqual(['0x5', '0x6']);
    expect(sent.bodies.map((body) => body.tx.calls[0]?.data)).toEqual([
      call(1).data,
      call(2).data,
    ]);
    expect(a.txHash).toBe(`0x${'1'.padStart(64, '0')}`);
    expect(b.txHash).toBe(`0x${'2'.padStart(64, '0')}`);
  });

  test('two rails on the same executor share the queue', async () => {
    const chain = railChain();
    const sent = sponsor(async () => {
      await delay(20);
      chain.nonce += 1n;
      return HttpResponse.json({ txHash: TX_HASH, executor: OWNER });
    });
    const one = sponsoredRail({ chain }).rail;
    const two = sponsoredRail({ chain }).rail;
    await Promise.all([one.send([call()]), two.send([call()])]);
    expect(sent.bodies.map((body) => body.tx.nonce)).toEqual(['0x5', '0x6']);
  });

  test('the queue is released on failure, and the next send reads the pending nonce again', async () => {
    const chain = railChain();
    const sent = sponsor((_, n) => {
      if (n === 1) {
        // The sponsor broadcast it, then the connection dropped: the client cannot know.
        chain.nonce = 9n;
        return HttpResponse.error();
      }
      return HttpResponse.json({ txHash: TX_HASH, executor: OWNER });
    });
    const { rail } = sponsoredRail({ chain });
    const first = rail.send([call(1)]);
    const second = rail.send([call(2)]);
    const error = await failure(first);
    expect(error.mayHaveLanded).toBe(true);
    await expect(second).resolves.toMatchObject({ status: 'success' });
    // The second send read the pending nonce again: it neither reused 5 nor assumed 6.
    expect(chain.count('getNonce')).toBe(2);
    expect(sent.bodies.map((body) => body.tx.nonce)).toEqual(['0x5', '0x9']);
  });
});

describe('SponsoredRail: failures', () => {
  test('sponsor 403 policy_rejected → 403 rejection, mayHaveLanded false', async () => {
    const sent = sponsor(() =>
      HttpResponse.json(
        {
          error: {
            code: 'policy_rejected',
            message: 'contract 0x… is not allowed',
          },
        },
        { status: 403 },
      ),
    );
    const { rail, chain } = sponsoredRail();
    const error = await failure(rail.send([call()]));
    expect(error).toSatisfy(rejectedWith(403));
    expect(error.code).toBe('policy_rejected');
    expect(error.mayHaveLanded).toBe(false);
    expect(sent.bodies).toHaveLength(1);
    expect(chain.count('waitForReceipt')).toBe(0);
  });

  test('network error after send → TransactionFailedError mayHaveLanded true; never resent', async () => {
    const sent = sponsor(() => HttpResponse.error());
    const { rail, chain } = sponsoredRail();
    const error = await failure(rail.send([call()]));
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(error.mayHaveLanded).toBe(true);
    expect((error as TransactionFailedError).transactionHash).toBeUndefined();
    await delay(50);
    expect(sent.bodies).toHaveLength(1);
    expect(chain.count('waitForReceipt')).toBe(0);
  });

  test('sponsor 5xx → TransactionFailedError mayHaveLanded true; never resent', async () => {
    const sent = sponsor(() =>
      HttpResponse.json(
        { error: { code: 'submit_failed', message: 'x' } },
        { status: 502 },
      ),
    );
    const { rail } = sponsoredRail();
    const error = await failure(rail.send([call()]));
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(error.mayHaveLanded).toBe(true);
    expect(sent.bodies).toHaveLength(1);
  });

  test('receipt timeout 120 s → TransactionFailedError mayHaveLanded true with txHash', async () => {
    sponsor();
    const { rail, chain } = sponsoredRail();
    chain.receipt = (_, timeoutMs) =>
      new TimeoutError(`no receipt after ${timeoutMs} ms`, {
        service: 'chain',
      });
    const error = await failure(rail.send([call()]));
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(error.code).toBe('receipt_timeout');
    expect(error.mayHaveLanded).toBe(true);
    expect((error as TransactionFailedError).transactionHash).toBe(TX_HASH);
    expect(chain.log.at(-1)?.args).toEqual([TX_HASH, 120_000]);
  });

  test('a receipt read that fails otherwise → TransactionFailedError mayHaveLanded true with txHash', async () => {
    sponsor();
    const { rail, chain } = sponsoredRail();
    chain.receipt = () => new Error('rpc down');
    const error = await failure(rail.send([call()]));
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(error.code).toBe('receipt_unavailable');
    expect(error.mayHaveLanded).toBe(true);
    expect((error as TransactionFailedError).transactionHash).toBe(TX_HASH);
  });

  test('a receipt for another hash → TransactionFailedError mayHaveLanded true with our txHash', async () => {
    sponsor();
    const { rail, chain } = sponsoredRail();
    chain.receipt = () => ({
      txHash: `0x${'cd'.repeat(32)}`,
      status: 'success',
      blockNumber: 1n,
    });
    const error = await failure(rail.send([call()]));
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(error.mayHaveLanded).toBe(true);
    expect((error as TransactionFailedError).transactionHash).toBe(TX_HASH);
  });

  test('signer without signHash → SigningError code sign_hash_unsupported', async () => {
    const sent = sponsor();
    const { rail, chain } = sponsoredRail({ signer: noRawSigner() });
    const error = await failure(rail.send([call()]));
    expect(error).toBeInstanceOf(SigningError);
    expect(error.code).toBe('sign_hash_unsupported');
    expect(error.message).toMatch(/private key|local account/);
    expect(error.mayHaveLanded).toBe(false);
    expect(chain.log).toEqual([]);
    expect(sent.bodies).toHaveLength(0);
  });

  test('a signer that is not the owner → UserInputError signer_mismatch, nothing sent', async () => {
    const sent = sponsor();
    const other = keySigner(`0x${'22'.repeat(32)}`);
    const { rail, chain } = sponsoredRail({ signer: other });
    const error = await failure(rail.send([call()]));
    expect(error).toBeInstanceOf(UserInputError);
    expect(error.code).toBe('signer_mismatch');
    expect(chain.log).toEqual([]);
    expect(sent.bodies).toHaveLength(0);
  });

  test('a signature from another key → SigningError, nothing sent', async () => {
    const sent = sponsor();
    const other = keySigner(`0x${'22'.repeat(32)}`);
    const owner = ownerSigner();
    const signer: InternalSigner = {
      ...owner,
      address: owner.address,
      signHash: other.signHash,
    };
    const { rail } = sponsoredRail({ signer });
    const error = await failure(rail.send([call()]));
    expect(error).toBeInstanceOf(SigningError);
    expect(error.mayHaveLanded).toBe(false);
    expect(sent.bodies).toHaveLength(0);
  });

  test.each([
    ['not hex', 'nope'],
    ['64 bytes', `0x${'12'.repeat(64)}`],
    ['v = 29', `0x${'12'.repeat(64)}1d`],
  ])(
    'signHash answering %s → SigningError, nothing sent',
    async (_, answer) => {
      const sent = sponsor();
      const owner = ownerSigner();
      const signer: InternalSigner = {
        ...owner,
        address: owner.address,
        signHash: async () => answer as Hex,
      };
      const { rail } = sponsoredRail({ signer });
      const error = await failure(rail.send([call()]));
      expect(error).toBeInstanceOf(SigningError);
      expect(error.message).not.toContain('1212121212');
      expect(sent.bodies).toHaveLength(0);
    },
  );

  test('signHash throwing → SigningError mayHaveLanded false, nothing sent', async () => {
    const sent = sponsor();
    const owner = ownerSigner();
    const signer: InternalSigner = {
      ...owner,
      address: owner.address,
      signHash: async () => {
        throw new Error('user rejected');
      },
    };
    const { rail } = sponsoredRail({ signer });
    const error = await failure(rail.send([call()]));
    expect(error).toBeInstanceOf(SigningError);
    expect(error.mayHaveLanded).toBe(false);
    expect(sent.bodies).toHaveLength(0);
  });

  test('>32 calls → UserInputError', async () => {
    const sent = sponsor();
    const { rail, chain } = sponsoredRail();
    const calls = Array.from({ length: MAX_CALLS + 1 }, (_, i) => call(i));
    const error = await failure(rail.send(calls));
    expect(error).toBeInstanceOf(UserInputError);
    expect(error.mayHaveLanded).toBe(false);
    expect(chain.log).toEqual([]);
    expect(sent.bodies).toHaveLength(0);
  });

  test('exactly 32 calls are sent', async () => {
    const sent = sponsor();
    const { rail } = sponsoredRail();
    await rail.send(Array.from({ length: MAX_CALLS }, (_, i) => call(i)));
    expect(sent.bodies[0]?.tx.calls).toHaveLength(MAX_CALLS);
  });

  test('no calls → UserInputError, nothing read or sent', async () => {
    const sent = sponsor();
    const { rail, chain } = sponsoredRail();
    await expect(rail.send([])).rejects.toBeInstanceOf(UserInputError);
    expect(chain.log).toEqual([]);
    expect(sent.bodies).toHaveLength(0);
  });

  test('calldata over MAX_CALLDATA_BYTES → UserInputError, nothing read or sent; exactly the limit is sent', async () => {
    const sent = sponsor();
    const { rail, chain } = sponsoredRail();
    const over = `0x${'ab'.repeat(MAX_CALLDATA_BYTES + 1)}` as Hex;
    const error = await failure(rail.send([{ ...call(), data: over }]));
    expect(error).toBeInstanceOf(UserInputError);
    expect(error.message).toContain('calls[0].data');
    expect(chain.log).toEqual([]);
    expect(sent.bodies).toHaveLength(0);

    const exact = `0x${'ab'.repeat(MAX_CALLDATA_BYTES)}` as Hex;
    await rail.send([{ ...call(), data: exact }]);
    expect(sent.bodies[0]?.tx.calls[0]?.data).toBe(exact);
  });

  test.each([
    ['a bad address', [{ to: '0x1234', data: '0x' }]],
    ['odd-length data', [{ to: call().to, data: '0x123' }]],
    ['a negative value', [{ ...call(), value: -1n }]],
    ['a number value', [{ ...call(), value: 1 }]],
    ['a null call', [null]],
    ['a sparse array', new Array(2)],
    ['not an array', call()],
  ])('%s → UserInputError, nothing read or sent', async (_, calls) => {
    const sent = sponsor();
    const { rail, chain } = sponsoredRail();
    const error = await failure(rail.send(calls as unknown as Call[]));
    expect(error).toBeInstanceOf(UserInputError);
    expect(error.mayHaveLanded).toBe(false);
    expect(chain.log).toEqual([]);
    expect(sent.bodies).toHaveLength(0);
  });

  test.each([
    ['zero', 0n],
    ['negative', -1n],
    ['above u64', 1n << 64n],
    ['a number', 100_000],
  ])('a gasLimit override that is %s → UserInputError', async (_, gasLimit) => {
    const sent = sponsor();
    const { rail, chain } = sponsoredRail();
    const error = await failure(
      rail.send([call()], { gasLimit: gasLimit as bigint }),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect(chain.log).toEqual([]);
    expect(sent.bodies).toHaveLength(0);
  });

  test('no sponsorUrl → UserInputError sponsor_not_configured, nothing read, signed or sent', async () => {
    const sent = sponsor();
    const { sponsorUrl: _, ...noSponsor } = env;
    let signed = 0;
    const owner = ownerSigner();
    const signer: InternalSigner = {
      ...owner,
      address: owner.address,
      signHash: async (hash) => {
        signed += 1;
        return (owner.signHash as NonNullable<InternalSigner['signHash']>)(
          hash,
        );
      },
    };
    const { rail, chain } = sponsoredRail({ env: noSponsor, signer });
    const error = await failure(rail.send([call()]));
    expect(error).toBeInstanceOf(UserInputError);
    expect(error.code).toBe('sponsor_not_configured');
    expect(error.mayHaveLanded).toBe(false);
    expect(chain.log).toEqual([]);
    expect(signed).toBe(0);
    expect(sent.bodies).toHaveLength(0);
  });

  test('a failed nonce read → TransactionFailedError mayHaveLanded false, nothing sent', async () => {
    const sent = sponsor();
    const { rail, chain } = sponsoredRail();
    chain.reader.getNonce = async () => {
      throw new Error('https://user:secret@rpc.example/ down');
    };
    const error = await failure(rail.send([call()]));
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(error.code).toBe('chain_read_failed');
    expect(error.mayHaveLanded).toBe(false);
    // A raw error from a custom reader is named, never quoted: it can hold an RPC URL.
    expect(error.message).not.toContain('secret');
    expect(error.cause).toBeUndefined();
    expect(sent.bodies).toHaveLength(0);
  });

  test('a failed fee read → TransactionFailedError mayHaveLanded false, nothing sent', async () => {
    const sent = sponsor();
    const { rail, chain } = sponsoredRail();
    chain.fees = new Error('down');
    const error = await failure(rail.send([call()]));
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(error.mayHaveLanded).toBe(false);
    expect(sent.bodies).toHaveLength(0);
  });

  test('two-call EOA batch gas = simulateBundleGas × 1.25; failed simulation → TransactionFailedError mayHaveLanded false, nothing sent', async () => {
    const sent = sponsor();
    const { rail, chain } = sponsoredRail();
    chain.simulate = 300_000n;
    await rail.send([call(1), call(2)]);
    expect(sent.bodies[0]?.tx.gasLimit).toBe(numberToHex(375_000n));
    expect(chain.count('estimateGas')).toBe(0);
    expect(
      chain.log.find((c) => c.method === 'simulateBundleGas')?.args,
    ).toEqual([
      {
        from: OWNER,
        calls: [
          { to: call(1).to, value: 0n, data: call(1).data },
          { to: call(2).to, value: 0n, data: call(2).data },
        ],
      },
    ]);

    chain.simulate = new Error('sponsored bundle reverted in simulation');
    const error = await failure(rail.send([call(1), call(2)]));
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(error.code).toBe('gas_estimation_failed');
    expect(error.mayHaveLanded).toBe(false);
    expect(sent.bodies).toHaveLength(1);
  });

  test('a failed single-call estimate → TransactionFailedError mayHaveLanded false, nothing sent', async () => {
    const sent = sponsor();
    const { rail, chain } = sponsoredRail();
    chain.estimate = new XoError('execution reverted: ERC20: nope', {
      code: 'chain_rpc_failed',
      service: 'chain',
    });
    const error = await failure(rail.send([call()]));
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(error.code).toBe('gas_estimation_failed');
    expect(error.mayHaveLanded).toBe(false);
    // An SDK chain error is already safe to quote.
    expect(error.message).toContain('ERC20: nope');
    expect(sent.bodies).toHaveLength(0);
  });

  test('a gasLimit override skips estimation and is used without margin', async () => {
    const sent = sponsor();
    const { rail, chain } = sponsoredRail();
    await rail.send([call(1), call(2)], { gasLimit: 6_000_000n });
    expect(sent.bodies[0]?.tx.gasLimit).toBe(numberToHex(6_000_000n));
    expect(chain.count('estimateGas') + chain.count('simulateBundleGas')).toBe(
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// resolveGasLimit
// ---------------------------------------------------------------------------

describe('SponsoredRail preflight: an earlier transaction of the owner that may still land', () => {
  // The check `xo.bridge.withdraw()` makes before it confirms a quote and spends its one-time
  // funding claim: two nonce reads of the owner (the executor), and this process's record of
  // what it handed over.
  const nonceReads = (owner = OWNER) => [
    { method: 'getNonce', args: [owner, 'latest'] },
    { method: 'getNonce', args: [owner, 'pending'] },
  ];

  test("reads the owner's latest and pending nonces, and passes when they are equal and the process handed nothing over that has not landed", async () => {
    const { rail, chain } = sponsoredRail();
    await preflightRail(rail);
    expect(chain.log).toEqual(nonceReads());
  });

  test("a smart wallet's check reads the owner's nonces: the owner is the executor", async () => {
    const { rail, chain } = sponsoredRail({ identity: smartWalletIdentity() });
    await preflightRail(rail);
    expect(chain.log).toEqual(nonceReads());
  });

  test('a transaction of the owner in the mempool (pending above latest): previous_operation_pending, naming the owner and its nonce', async () => {
    const chain = railChain();
    chain.latestNonce = 5n;
    chain.nonce = 6n;
    const { rail } = sponsoredRail({ chain });

    const error = await failure(preflightRail(rail));

    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(error).toMatchObject({
      code: 'previous_operation_pending',
      mayHaveLanded: false,
      nonce: 5n,
      service: 'chain',
    });
    expect(error.message).toContain(OWNER);
    expect(error.message).toContain('nonce 5');
    expect(error.message).toMatch(/nothing was sent/i);
    expect(chain.log).toEqual(nonceReads());
  });

  test('a send of this process that ended sponsor_outcome_unknown, and has not landed: refused; once the nonce is mined, it passes', async () => {
    sponsor(() => HttpResponse.json({ error: 'down' }, { status: 503 }));
    const chain = railChain();
    const { rail } = sponsoredRail({ chain });
    const unknown = await failure(rail.send([call()]));
    expect(unknown).toMatchObject({
      code: 'sponsor_outcome_unknown',
      mayHaveLanded: true,
      nonce: 5n,
    });

    const error = await failure(preflightRail(rail));
    expect(error).toMatchObject({
      code: 'previous_operation_pending',
      mayHaveLanded: false,
      nonce: 5n,
    });
    expect(error.message).toContain('handed');

    // Another rail of the same owner on the same chain shares the record.
    const other = sponsoredRail({ chain });
    await expect(preflightRail(other.rail)).rejects.toMatchObject({
      code: 'previous_operation_pending',
    });

    chain.latestNonce = 6n;
    chain.nonce = 6n;
    await expect(preflightRail(rail)).resolves.toBeUndefined();
  });

  test('a send that was accepted but whose receipt is not in yet: refused until the nonce is mined', async () => {
    sponsor();
    const chain = railChain();
    const { rail } = sponsoredRail({ chain });
    await rail.send([call()]);

    // The RPC has not seen the block yet: latest is still the nonce the send used.
    await expect(preflightRail(rail)).rejects.toMatchObject({
      code: 'previous_operation_pending',
      nonce: 5n,
    });
    chain.latestNonce = 6n;
    chain.nonce = 6n;
    await expect(preflightRail(rail)).resolves.toBeUndefined();
  });

  test("a direct broadcast of the same owner whose outcome is unknown counts too: the record is the owner's", async () => {
    const chain = railChain();
    chain.broadcast = new Error('socket hang up');
    const direct = directRail({ chain });
    const unknown = await failure(direct.rail.send([call()]));
    expect(unknown.mayHaveLanded).toBe(true);

    const { rail } = sponsoredRail({ chain });
    await expect(preflightRail(rail)).rejects.toMatchObject({
      code: 'previous_operation_pending',
      nonce: 5n,
    });
  });

  test.each([
    [
      '403 policy_rejected',
      () =>
        HttpResponse.json(
          { error: { code: 'policy_rejected', message: 'not allowed' } },
          { status: 403 },
        ),
    ],
    [
      '429 overloaded',
      () =>
        HttpResponse.json(
          { error: { code: 'overloaded', message: 'busy' } },
          { status: 429 },
        ),
    ],
    [
      '400 bad_request',
      () =>
        HttpResponse.json(
          { error: { code: 'bad_request', message: 'no' } },
          { status: 400 },
        ),
    ],
  ])(
    'a send the sponsor refused for sure (%s) is taken off the record: the preflight passes',
    async (_, reply) => {
      sponsor(reply);
      const chain = railChain();
      const { rail } = sponsoredRail({ chain });
      const refused = await failure(rail.send([call()]));
      expect(refused.mayHaveLanded).toBe(false);

      await expect(preflightRail(rail)).resolves.toBeUndefined();
    },
  );

  test("a direct broadcast the node refused for sure (rejected_by_node) is taken off the record: the sponsored rail's preflight passes", async () => {
    const chain = railChain();
    chain.broadcast = new TransactionFailedError('insufficient funds for gas', {
      mayHaveLanded: false,
      code: 'rejected_by_node',
      service: 'chain',
    });
    const direct = directRail({ chain });
    const refused = await failure(direct.rail.send([call()]));
    expect(refused).toMatchObject({
      code: 'rejected_by_node',
      mayHaveLanded: false,
    });

    await expect(
      preflightRail(sponsoredRail({ chain }).rail),
    ).resolves.toBeUndefined();
  });

  test('a refusal after an unknown outcome puts the unknown one back: the preflight still refuses', async () => {
    sponsor((_, n) =>
      n === 1
        ? HttpResponse.json({ error: 'down' }, { status: 503 })
        : HttpResponse.json(
            { error: { code: 'policy_rejected', message: 'not allowed' } },
            { status: 403 },
          ),
    );
    const chain = railChain();
    const { rail } = sponsoredRail({ chain });
    const unknown = await failure(rail.send([call(1)]));
    expect(unknown).toMatchObject({ code: 'sponsor_outcome_unknown' });
    // The unknown send was never accepted, so the next one takes the same nonce, and is refused.
    const refused = await failure(rail.send([call(2)]));
    expect(refused).toMatchObject({ code: 'policy_rejected' });
    expect(refused.mayHaveLanded).toBe(false);

    await expect(preflightRail(rail)).rejects.toMatchObject({
      code: 'previous_operation_pending',
      nonce: 5n,
    });
  });

  test('a record of another chain does not count', async () => {
    sponsor(() => HttpResponse.json({ error: 'down' }, { status: 503 }));
    const chain = railChain();
    await failure(sponsoredRail({ chain }).rail.send([call()]));

    const { rail } = sponsoredRail({
      chain,
      env: { ...env, chainId: 4242 },
    });
    await expect(preflightRail(rail)).resolves.toBeUndefined();
  });

  test('a nonce read that fails refuses with chain_read_failed, mayHaveLanded false', async () => {
    const chain = railChain();
    chain.latestNonce = new Error('https://rpc.example/key-123 is down');
    const { rail } = sponsoredRail({ chain });

    const error = await failure(preflightRail(rail));

    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(error).toMatchObject({
      code: 'chain_read_failed',
      mayHaveLanded: false,
    });
    expect(error.message).not.toContain('key-123');
  });

  test('the static refusals still come first, before any read', async () => {
    const { sponsorUrl: _omitted, ...rest } = env;
    const { rail, chain } = sponsoredRail({ env: rest as EnvironmentConfig });
    const error = await failure(preflightRail(rail));
    expect(error.code).toBe('sponsor_not_configured');
    expect(chain.log).toEqual([]);
  });
});

describe('resolveGasLimit', () => {
  const one: EvCall[] = [{ to: call().to, value: 0n, input: call().data }];
  const two: EvCall[] = [...one, { to: SMART_WALLET, value: 0n, input: '0x' }];

  test('one call: max(estimate, intrinsic floor) × 1.25', async () => {
    const chain = railChain();
    chain.estimate = 100_000n;
    expect(await resolveGasLimit(chain.reader, OWNER, one)).toBe(125_000n);
    chain.estimate = 1n;
    expect(await resolveGasLimit(chain.reader, OWNER, one)).toBe(
      margin(estimateIntrinsicGas(one)),
    );
  });

  test('several calls: max(bundle simulation, floor) × 1.25', async () => {
    const chain = railChain();
    chain.simulate = 1n;
    expect(await resolveGasLimit(chain.reader, OWNER, two)).toBe(
      margin(estimateIntrinsicGas(two)),
    );
    chain.simulate = 400_000n;
    expect(await resolveGasLimit(chain.reader, OWNER, two)).toBe(500_000n);
  });

  test('an override is clamped up to the floor, without margin or estimate', async () => {
    const chain = railChain();
    expect(await resolveGasLimit(chain.reader, OWNER, one, 1n)).toBe(
      estimateIntrinsicGas(one),
    );
    expect(await resolveGasLimit(chain.reader, OWNER, one, 777_000n)).toBe(
      777_000n,
    );
    expect(chain.log).toEqual([]);
  });

  test('no large default: a failed estimate throws gas_estimation_failed', async () => {
    const chain = railChain();
    chain.estimate = new Error('boom');
    const error = await failure(resolveGasLimit(chain.reader, OWNER, one));
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(error.mayHaveLanded).toBe(false);
  });

  test('a non-bigint estimate is a failure, not a gas limit', async () => {
    const chain = railChain();
    chain.reader.estimateGas = async () => 100_000 as unknown as bigint;
    const error = await failure(resolveGasLimit(chain.reader, OWNER, one));
    expect(error.code).toBe('gas_estimation_failed');
  });
});

// ---------------------------------------------------------------------------
// DirectRail
// ---------------------------------------------------------------------------

describe('DirectRail', () => {
  test('signs one EIP-1559 tx locally and broadcasts it; returns the receipt', async () => {
    const { rail, chain } = directRail();
    chain.estimate = 50_000n;
    const result = await rail.send([{ ...call(), value: 4n }]);

    const raw = chain.log.find((c) => c.method === 'sendRawTransaction')
      ?.args[0] as Hex;
    const tx = parseTransaction(raw);
    expect(tx).toMatchObject({
      type: 'eip1559',
      chainId: env.chainId,
      nonce: 5,
      // parseTransaction answers the address in lower case.
      to: call().to.toLowerCase(),
      value: 4n,
      data: call().data,
      gas: margin(50_000n),
      maxFeePerGas: GWEI,
      maxPriorityFeePerGas: GWEI,
    });
    expect(BigInt(tx.s as Hex) <= HALF_N).toBe(true);
    expect(
      await recoverTransactionAddress({ serializedTransaction: raw as never }),
    ).toBe(OWNER);
    expect(result).toEqual({
      txHash: keccak256(raw),
      status: 'success',
      blockNumber: 42n,
    });
    expect(chain.log.at(-1)).toEqual({
      method: 'waitForReceipt',
      args: [keccak256(raw), 120_000],
    });
  });

  test('a high-s signer still yields a low-s, owner-signed tx', async () => {
    const { rail, chain } = directRail({ signer: highSSigner() });
    await rail.send([call()]);
    const raw = chain.log.find((c) => c.method === 'sendRawTransaction')
      ?.args[0] as Hex;
    const tx = parseTransaction(raw);
    expect(BigInt(tx.s as Hex) <= HALF_N).toBe(true);
    expect(
      await recoverTransactionAddress({ serializedTransaction: raw as never }),
    ).toBe(OWNER);
  });

  test('a smart wallet identity → UserInputError, nothing read', async () => {
    const { rail, chain } = directRail({ identity: smartWalletIdentity() });
    const error = await failure(rail.send([call()]));
    expect(error).toBeInstanceOf(UserInputError);
    expect(error.code).toBe('direct_rail_eoa_only');
    expect(error.message).toBe(
      'DirectRail sends from an EOA only; a smart wallet needs the sponsored rail',
    );
    expect(error.mayHaveLanded).toBe(false);
    expect(chain.log).toEqual([]);
  });

  test('a multi-call batch is refused (one call per direct tx), nothing read', async () => {
    const { rail, chain } = directRail();
    const error = await failure(rail.send([call(1), call(2)]));
    expect(error).toBeInstanceOf(UserInputError);
    expect(error.code).toBe('direct_rail_single_call');
    // The message names the facade option that batches: leaving `rail` out.
    expect(error.message).toContain('leave the rail option out');
    expect(error.message).toContain(
      'through the sponsor, where the environment has one',
    );
    expect(chain.log).toEqual([]);
  });

  test('signer without signHash → SigningError sign_hash_unsupported', async () => {
    const { rail, chain } = directRail({ signer: noRawSigner() });
    const error = await failure(rail.send([call()]));
    expect(error).toBeInstanceOf(SigningError);
    expect(error.code).toBe('sign_hash_unsupported');
    expect(chain.log).toEqual([]);
  });

  test('an ambiguous broadcast failure → TransactionFailedError mayHaveLanded true with the local txHash; sent once', async () => {
    const { rail, chain } = directRail();
    chain.broadcast = new XoError('timed out', {
      code: 'timeout',
      service: 'chain',
    });
    const error = await failure(rail.send([call()]));
    const raw = chain.log.find((c) => c.method === 'sendRawTransaction')
      ?.args[0] as Hex;
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(error.mayHaveLanded).toBe(true);
    expect((error as TransactionFailedError).transactionHash).toBe(
      keccak256(raw),
    );
    expect(chain.count('sendRawTransaction')).toBe(1);
    expect(chain.count('waitForReceipt')).toBe(0);
  });

  test('a node rejection (the reader says mayHaveLanded false) → mayHaveLanded false', async () => {
    const { rail, chain } = directRail();
    chain.broadcast = new TransactionFailedError('insufficient funds', {
      mayHaveLanded: false,
      code: 'rejected_by_node',
      service: 'chain',
    });
    const error = await failure(rail.send([call()]));
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(error.code).toBe('rejected_by_node');
    expect(error.mayHaveLanded).toBe(false);
    expect(chain.count('sendRawTransaction')).toBe(1);
  });

  test('receipt timeout → TransactionFailedError mayHaveLanded true with txHash', async () => {
    const { rail, chain } = directRail();
    chain.receipt = () => new TimeoutError('slow', { service: 'chain' });
    const error = await failure(rail.send([call()]));
    expect(error.code).toBe('receipt_timeout');
    expect(error.mayHaveLanded).toBe(true);
    expect((error as TransactionFailedError).transactionHash).toMatch(
      /^0x[0-9a-f]{64}$/,
    );
  });

  test('a reader without sendRawTransaction → UserInputError at construction', () => {
    const chain = railChain();
    const { sendRawTransaction: _, ...reader } = chain.reader;
    expect(
      () =>
        new DirectRail({
          env,
          identity: eoaIdentity(),
          signer: ownerSigner(),
          chain: reader,
        }),
    ).toThrow(UserInputError);
  });

  test('shares the executor queue with the sponsored rail', async () => {
    const chain = railChain();
    sponsor(async () => {
      await delay(20);
      chain.nonce += 1n;
      return HttpResponse.json({ txHash: TX_HASH, executor: OWNER });
    });
    const sponsored = sponsoredRail({ chain }).rail;
    const direct = directRail({ chain }).rail;
    await Promise.all([sponsored.send([call()]), direct.send([call()])]);
    const raw = chain.log.find((c) => c.method === 'sendRawTransaction')
      ?.args[0] as Hex;
    expect(parseTransaction(raw).nonce).toBe(6);
  });
});

describe('constructors', () => {
  test.each([
    ['env', { env: null }],
    ['identity', { identity: 'eoa' }],
    ['signer', { signer: undefined }],
    ['chain', { chain: {} }],
  ])('a bad %s → UserInputError', (_, patch) => {
    const base = {
      env,
      identity: eoaIdentity(),
      signer: ownerSigner(),
      chain: railChain().reader,
    };
    expect(() => new SponsoredRail({ ...base, ...patch } as never)).toThrow(
      UserInputError,
    );
    expect(() => new DirectRail({ ...base, ...patch } as never)).toThrow(
      UserInputError,
    );
  });

  test('a rail serialises to nothing: no key, no signer', () => {
    expect(JSON.stringify(sponsoredRail().rail)).toBe('{}');
  });
});

// ---------------------------------------------------------------------------
// Accepted nonces
// ---------------------------------------------------------------------------

const hashN = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;

/** A sponsor that accepts every send. The stub's pending count never moves: a lagging RPC. */
function laggingSponsor(): SponsorLog {
  return sponsor((_, n) =>
    HttpResponse.json({ txHash: hashN(n), executor: OWNER }),
  );
}

const nonces = (log: SponsorLog) => log.bodies.map((body) => body.tx.nonce);

describe('accepted nonces', () => {
  test('a lagging pending count: concurrent sends get n then n+1, and the next n+2', async () => {
    const sent = laggingSponsor();
    const { rail, chain } = sponsoredRail();
    await Promise.all([rail.send([call(1)]), rail.send([call(2)])]);
    await rail.send([call(3)]);
    expect(nonces(sent)).toEqual(['0x5', '0x6', '0x7']);
    expect(chain.nonce).toBe(5n);
    expect(chain.count('getNonce')).toBe(3);
  });

  test('the record expires RECEIPT_TIMEOUT_MS after it was set: back to the pending count', async () => {
    let now = 1_000_000;
    setNonceClock(() => now);
    const sent = laggingSponsor();
    const { rail } = sponsoredRail();
    await rail.send([call()]);
    now += RECEIPT_TIMEOUT_MS - 1;
    await rail.send([call()]);
    now += RECEIPT_TIMEOUT_MS;
    await rail.send([call()]);
    expect(nonces(sent)).toEqual(['0x5', '0x6', '0x5']);
  });

  test('the record ages on the module clock: a nowMs option is not read', async () => {
    let now = 1_000_000;
    setNonceClock(() => now);
    const sent = laggingSponsor();
    const chain = railChain();
    // Not a rail option any more: a frozen clock passed here must not keep the record fresh.
    const rail = new SponsoredRail({
      env,
      identity: eoaIdentity(),
      signer: ownerSigner(),
      chain: chain.reader,
      nowMs: () => 0,
    } as never);
    await rail.send([call()]);
    now += RECEIPT_TIMEOUT_MS;
    await rail.send([call()]);
    expect(nonces(sent)).toEqual(['0x5', '0x5']);
  });

  test('the sponsored and direct rails age the shared record on one clock', async () => {
    let now = 1_000_000;
    setNonceClock(() => now);
    const sent = laggingSponsor();
    const chain = railChain();
    await sponsoredRail({ chain }).rail.send([call()]);
    now += RECEIPT_TIMEOUT_MS - 1;
    const raw: Hex[] = [];
    chain.reader.sendRawTransaction = async (bytes) => {
      raw.push(bytes);
      return keccak256(bytes);
    };
    await directRail({ chain }).rail.send([call()]);
    expect(nonces(sent)).toEqual(['0x5']);
    expect(parseTransaction(raw[0] as Hex).nonce).toBe(6);
  });

  test('setNonceClock(undefined) restores the monotonic default', async () => {
    setNonceClock(() => 0);
    setNonceClock(undefined);
    const sent = laggingSponsor();
    const { rail } = sponsoredRail();
    const before = performance.now();
    await rail.send([call()]);
    await rail.send([call()]);
    // Fresh on performance.now(): the record raised the second nonce.
    expect(performance.now() - before).toBeLessThan(RECEIPT_TIMEOUT_MS);
    expect(nonces(sent)).toEqual(['0x5', '0x6']);
  });

  test('a clock that steps back keeps the record (a negative age counts as fresh)', async () => {
    let now = 1_000_000;
    setNonceClock(() => now);
    const sent = laggingSponsor();
    const { rail } = sponsoredRail();
    await rail.send([call()]);
    now -= 1;
    await rail.send([call()]);
    expect(nonces(sent)).toEqual(['0x5', '0x6']);
  });

  test("a failed task's late nonce read does not clear a newer record", async () => {
    let now = 0;
    setNonceClock(() => ++now);
    const sent = laggingSponsor();
    const { rail, chain } = sponsoredRail();
    // Send 1: its nonce read is held while its estimate fails at once.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    chain.reader.getNonce = async () => {
      reads += 1;
      if (reads === 1) {
        await held;
      }
      return chain.nonce;
    };
    let estimates = 0;
    chain.reader.estimateGas = async () => {
      estimates += 1;
      if (estimates === 1) {
        throw new Error('reverted');
      }
      return 100_000n;
    };
    const first = rail.send([call(1)]);
    const second = rail.send([call(2)]);
    // Long enough for send 2 to be accepted if send 1 had let the queue go early.
    await delay(30);
    // Send 1's task holds the queue until its nonce read is done, failed estimate or not.
    expect(reads).toBe(1);
    expect(sent.bodies).toHaveLength(0);
    release();
    expect((await failure(first)).code).toBe('gas_estimation_failed');
    await second;
    await rail.send([call(3)]);
    expect(nonces(sent)).toEqual(['0x5', '0x6']);
  });

  test("the chain's count wins once it is ahead of the record", async () => {
    const sent = laggingSponsor();
    const { rail, chain } = sponsoredRail();
    await rail.send([call()]);
    chain.nonce = 9n;
    await rail.send([call()]);
    expect(nonces(sent)).toEqual(['0x5', '0x9']);
  });

  test('a sponsor 4xx does not advance, and releases the queue', async () => {
    const sent = sponsor((_, n) =>
      n === 1
        ? HttpResponse.json(
            { error: { code: 'policy_rejected', message: 'no' } },
            { status: 403 },
          )
        : HttpResponse.json({ txHash: TX_HASH, executor: OWNER }),
    );
    const { rail } = sponsoredRail();
    const first = rail.send([call(1)]);
    const second = rail.send([call(2)]);
    expect((await failure(first)).code).toBe('policy_rejected');
    await expect(second).resolves.toMatchObject({ status: 'success' });
    expect(nonces(sent)).toEqual(['0x5', '0x5']);
  });

  test('an ambiguous failure does not advance', async () => {
    const sent = sponsor((_, n) =>
      n === 1
        ? HttpResponse.error()
        : HttpResponse.json({ txHash: TX_HASH, executor: OWNER }),
    );
    const { rail } = sponsoredRail();
    expect((await failure(rail.send([call(1)]))).mayHaveLanded).toBe(true);
    await rail.send([call(2)]);
    expect(nonces(sent)).toEqual(['0x5', '0x5']);
  });

  test('an executor mismatch does not advance', async () => {
    const sent = sponsor((_, n) =>
      HttpResponse.json({
        txHash: hashN(n),
        executor: n === 1 ? `0x${'99'.repeat(20)}` : OWNER,
      }),
    );
    const { rail } = sponsoredRail();
    expect((await failure(rail.send([call(1)]))).code).toBe(
      'executor_mismatch',
    );
    await rail.send([call(2)]);
    expect(nonces(sent)).toEqual(['0x5', '0x5']);
  });

  test('two chainIds with the same executor are tracked independently', async () => {
    const sent = laggingSponsor();
    const other: EnvironmentConfig = { ...env, chainId: 999 };
    const onBase = sponsoredRail().rail;
    const onOther = sponsoredRail({ env: other }).rail;
    await onBase.send([call()]);
    await onBase.send([call()]);
    await onOther.send([call()]);
    await onBase.send([call()]);
    expect(sent.bodies.map((body) => [body.tx.chainId, body.tx.nonce])).toEqual(
      [
        ['0x7a69', '0x5'],
        ['0x7a69', '0x6'],
        ['0x3e7', '0x5'],
        ['0x7a69', '0x7'],
      ],
    );
  });

  test('EOA and smart wallet rails of one owner share the record (the executor is the owner)', async () => {
    const sent = laggingSponsor();
    await sponsoredRail().rail.send([call()]);
    await sponsoredRail({ identity: smartWalletIdentity() }).rail.send([
      call(),
    ]);
    expect(nonces(sent)).toEqual(['0x5', '0x6']);
  });

  test('a sponsored acceptance advances the direct rail, and a direct broadcast the sponsored one', async () => {
    laggingSponsor();
    const chain = railChain();
    await sponsoredRail({ chain }).rail.send([call()]);
    await directRail({ chain }).rail.send([call()]);
    const raw = chain.log.find((c) => c.method === 'sendRawTransaction')
      ?.args[0] as Hex;
    expect(parseTransaction(raw).nonce).toBe(6);

    resetNonceTracking();
    const sent = laggingSponsor();
    const fresh = railChain();
    await directRail({ chain: fresh }).rail.send([call()]);
    await sponsoredRail({ chain: fresh }).rail.send([call()]);
    expect(nonces(sent)).toEqual(['0x6']);
  });

  test('a definite direct refusal does not advance', async () => {
    const chain = railChain();
    chain.broadcast = new TransactionFailedError('insufficient funds', {
      mayHaveLanded: false,
      code: 'rejected_by_node',
      service: 'chain',
    });
    await failure(directRail({ chain }).rail.send([call()]));
    const sent = laggingSponsor();
    await sponsoredRail({ chain }).rail.send([call()]);
    expect(nonces(sent)).toEqual(['0x5']);
  });

  test('two sends racing on an undeployed smart wallet both prepend createAccount', async () => {
    const sent = laggingSponsor();
    const chain = railChain();
    chain.code.clear();
    chain.read = addressWord(SMART_WALLET);
    const { rail } = sponsoredRail({ chain, identity: smartWalletIdentity() });
    await Promise.all([rail.send([call(1)]), rail.send([call(2)])]);
    // The first is not mined when the second is built, so both deploy; the factory hands
    // back the existing account the second time. The nonces still follow on.
    expect(sent.bodies.map((body) => body.tx.calls.map((c) => c.to))).toEqual([
      [env.contracts.kernelFactory, SMART_WALLET],
      [env.contracts.kernelFactory, SMART_WALLET],
    ]);
    expect(nonces(sent)).toEqual(['0x5', '0x6']);
  });
});

// ---------------------------------------------------------------------------
// The nonce on "may have landed" errors
// ---------------------------------------------------------------------------

describe('mayHaveLanded errors carry the nonce', () => {
  const advice = `check which transaction used nonce 5 from executor ${OWNER}`;

  test('sponsor_outcome_unknown', async () => {
    sponsor(() => HttpResponse.error());
    const error = (await failure(
      sponsoredRail().rail.send([call()]),
    )) as TransactionFailedError;
    expect(error.code).toBe('sponsor_outcome_unknown');
    expect(error.nonce).toBe(5n);
    expect(error.message).toContain(advice);
    expect(error.toJSON()).toMatchObject({ nonce: '5' });
  });

  test('executor_mismatch names the executor the sponsor recovered', async () => {
    const recovered = `0x${'99'.repeat(20)}`;
    sponsor(() => HttpResponse.json({ txHash: TX_HASH, executor: recovered }));
    const error = (await failure(
      sponsoredRail().rail.send([call()]),
    )) as TransactionFailedError;
    expect(error.nonce).toBe(5n);
    expect(error.message).toContain(
      `check which transaction used nonce 5 from executor ${recovered}`,
    );
    expect(error.message).not.toContain(advice);
  });

  test('receipt_timeout and receipt_unavailable', async () => {
    sponsor();
    const { rail, chain } = sponsoredRail();
    chain.receipt = () => new TimeoutError('slow', { service: 'chain' });
    const timedOut = (await failure(
      rail.send([call()]),
    )) as TransactionFailedError;
    expect(timedOut.code).toBe('receipt_timeout');
    expect(timedOut.nonce).toBe(5n);
    expect(timedOut.message).toContain(TX_HASH);
    expect(timedOut.message).toContain(advice);

    resetNonceTracking();
    chain.receipt = () => new Error('down');
    const unreadable = (await failure(
      rail.send([call()]),
    )) as TransactionFailedError;
    expect(unreadable.code).toBe('receipt_unavailable');
    expect(unreadable.nonce).toBe(5n);
  });

  test('broadcast_outcome_unknown', async () => {
    const { rail, chain } = directRail();
    chain.broadcast = new Error('socket hang up');
    const error = (await failure(
      rail.send([call()]),
    )) as TransactionFailedError;
    expect(error.code).toBe('broadcast_outcome_unknown');
    expect(error.nonce).toBe(5n);
    expect(error.message).toContain(advice);
  });

  test('a failure before hand-over carries no nonce', async () => {
    sponsor();
    const { rail, chain } = sponsoredRail();
    chain.simulate = new Error('reverted');
    const error = (await failure(
      rail.send([call(1), call(2)]),
    )) as TransactionFailedError;
    expect(error.mayHaveLanded).toBe(false);
    expect(error.nonce).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Signature range, direct gas floor
// ---------------------------------------------------------------------------

const N_HEX =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141';

describe('signature range', () => {
  test.each([
    ['r = 0', `0x${'00'.repeat(32)}${'11'.repeat(32)}1b`],
    ['r = n', `0x${N_HEX}${'11'.repeat(32)}1b`],
    ['s = 0', `0x${'11'.repeat(32)}${'00'.repeat(32)}1b`],
    ['s = n', `0x${'11'.repeat(32)}${N_HEX}1b`],
    ['s = 2^256 - 1', `0x${'11'.repeat(32)}${'ff'.repeat(32)}1c`],
  ])(
    '%s → SigningError before any reduction, nothing sent',
    async (_, signature) => {
      const sent = sponsor();
      const error = await failure(
        sponsoredRail({ signer: answering(signature) }).rail.send([call()]),
      );
      expect(error).toBeInstanceOf(SigningError);
      expect(error.code).toBe('signing_failed');
      expect(error.message).toContain('[1, n)');
      expect(error.mayHaveLanded).toBe(false);
      expect(sent.bodies).toHaveLength(0);
    },
  );
});

describe('DirectRail gas floor', () => {
  /** 21 000 plus 4 per zero byte and 16 per other byte. */
  function plainIntrinsic(data: Hex): bigint {
    let gas = 21_000n;
    for (let i = 2; i < data.length; i += 2) {
      gas += data.slice(i, i + 2) === '00' ? 4n : 16n;
    }
    return gas;
  }

  test('an override below it is raised to the plain EIP-1559 intrinsic gas, not the EvNode one', async () => {
    const { rail, chain } = directRail();
    await rail.send([call()], { gasLimit: 1n });
    const raw = chain.log.find((c) => c.method === 'sendRawTransaction')
      ?.args[0] as Hex;
    expect(parseTransaction(raw).gas).toBe(plainIntrinsic(call().data));
    expect(plainIntrinsic(call().data)).toBeLessThan(
      estimateIntrinsicGas([{ to: call().to, value: 0n, input: call().data }]),
    );
  });

  test('an estimate below it is raised to it, plus 25%', async () => {
    const { rail, chain } = directRail();
    chain.estimate = 1n;
    await rail.send([call()]);
    const raw = chain.log.find((c) => c.method === 'sendRawTransaction')
      ?.args[0] as Hex;
    expect(parseTransaction(raw).gas).toBe(margin(plainIntrinsic(call().data)));
  });
});

// ---------------------------------------------------------------------------
// DirectRail broadcast outcomes through createChainReader
// ---------------------------------------------------------------------------

describe('DirectRail broadcast outcomes', () => {
  /**
   * A node that answers every eth_sendRawTransaction with this JSON-RPC error, and
   * eth_getTransactionByHash with a transaction (`'found'`), null (`'not_found'`) or an error.
   */
  function nodeError(
    code: number,
    message: string,
    lookup: 'found' | 'not_found' | 'error' = 'not_found',
  ): { posts: number; lookups: string[] } {
    const seen = { posts: 0, lookups: [] as string[] };
    server.use(
      http.post(env.rpcUrl, async ({ request }) => {
        const req = (await request.json()) as {
          id: number;
          method: string;
          params: string[];
        };
        if (req.method === 'eth_getTransactionByHash') {
          seen.lookups.push(req.params[0] as string);
          if (lookup === 'error') {
            return HttpResponse.json({
              jsonrpc: '2.0',
              id: req.id,
              error: { code: -32603, message: 'internal error' },
            });
          }
          return HttpResponse.json({
            jsonrpc: '2.0',
            id: req.id,
            result:
              lookup === 'found'
                ? { hash: req.params[0], blockNumber: null, nonce: '0x5' }
                : null,
          });
        }
        seen.posts += 1;
        expect(req.method).toBe('eth_sendRawTransaction');
        return HttpResponse.json({
          jsonrpc: '2.0',
          id: req.id,
          error: { code, message },
        });
      }),
    );
    return seen;
  }

  /** The stub chain, with the real reader's sendRawTransaction and getTransaction (msw node behind them). */
  function realBroadcast(): ReturnType<typeof directRail> {
    const real = createChainReader(env);
    const chain = railChain();
    chain.reader.sendRawTransaction = async (raw) => {
      chain.log.push({ method: 'sendRawTransaction', args: [raw] });
      return (
        real.sendRawTransaction as NonNullable<typeof real.sendRawTransaction>
      )(raw);
    };
    chain.reader.getTransaction = async (hash) => {
      chain.log.push({ method: 'getTransaction', args: [hash] });
      return (real.getTransaction as NonNullable<typeof real.getTransaction>)(
        hash,
      );
    };
    return directRail({ chain });
  }

  const rawOf = (chain: RailChainStub) =>
    chain.log.find((c) => c.method === 'sendRawTransaction')?.args[0] as Hex;

  test.each([
    'already known',
    'known transaction: 0xabc',
    'Transaction ALREADY IMPORTED',
  ])(
    '"%s" → accepted: the local hash is awaited and the nonce advances',
    async (message) => {
      const node = nodeError(-32000, message);
      const { rail, chain } = realBroadcast();
      const result = await rail.send([call()]);
      const local = keccak256(rawOf(chain));
      expect(result).toEqual({
        txHash: local,
        status: 'success',
        blockNumber: 42n,
      });
      expect(chain.log.at(-1)).toEqual({
        method: 'waitForReceipt',
        args: [local, 120_000],
      });
      expect(node.posts).toBe(1);

      const sent = laggingSponsor();
      await sponsoredRail({ chain }).rail.send([call()]);
      expect(nonces(sent)).toEqual(['0x6']);
    },
  );

  test.each([
    'insufficient funds for gas * price + value',
    'intrinsic gas too low',
    'transaction underpriced',
    'replacement transaction underpriced',
    'max fee per gas less than block base fee: address 0x.., maxFeePerGas: 1, baseFee: 7',
    'exceeds block gas limit',
    'invalid sender',
    'invalid chain id for signer',
    'transaction type not supported',
    'tx type not supported',
    'INSUFFICIENT FUNDS',
  ])(
    '"%s" → rejected_by_node, mayHaveLanded false, sent once',
    async (message) => {
      const node = nodeError(-32000, message);
      const { rail, chain } = realBroadcast();
      const error = (await failure(
        rail.send([call()]),
      )) as TransactionFailedError;
      expect(error).toBeInstanceOf(TransactionFailedError);
      expect(error.code).toBe('rejected_by_node');
      expect(error.mayHaveLanded).toBe(false);
      expect(error.transactionHash).toBe(keccak256(rawOf(chain)));
      expect(node.posts).toBe(1);
      expect(chain.count('waitForReceipt')).toBe(0);
    },
  );

  test.each([
    [-32603, 'internal error'],
    [-32603, 'nonce gap: something odd happened'],
    [-32000, 'request timed out'],
    [-32000, 'gateway timeout'],
    [-32000, 'something nobody has seen before'],
  ])(
    '%i "%s" → broadcast_outcome_unknown, mayHaveLanded true, sent once',
    async (code, message) => {
      const node = nodeError(code, message);
      const { rail, chain } = realBroadcast();
      const error = (await failure(
        rail.send([call()]),
      )) as TransactionFailedError;
      expect(error.code).toBe('broadcast_outcome_unknown');
      expect(error.mayHaveLanded).toBe(true);
      expect(error.transactionHash).toBe(keccak256(rawOf(chain)));
      expect(error.nonce).toBe(5n);
      expect(node.posts).toBe(1);
    },
  );

  test('"nonce too low" and the node knows the local hash → accepted: receipt awaited, nonce advanced', async () => {
    const node = nodeError(
      -32000,
      'nonce too low: next nonce 6, tx nonce 5',
      'found',
    );
    const { rail, chain } = realBroadcast();
    const result = await rail.send([call()]);
    const local = keccak256(rawOf(chain));
    expect(node.lookups).toEqual([local]);
    expect(result).toEqual({
      txHash: local,
      status: 'success',
      blockNumber: 42n,
    });
    expect(node.posts).toBe(1);

    const sent = laggingSponsor();
    await sponsoredRail({ chain }).rail.send([call()]);
    expect(nonces(sent)).toEqual(['0x6']);
  });

  test.each([
    ['does not know the hash', 'not_found' as const],
    ['lookup fails', 'error' as const],
  ])(
    '"nonce too low" and the %s → nonce_already_used, mayHaveLanded true, not advanced',
    async (_, lookup) => {
      const node = nodeError(-32000, 'NONCE TOO LOW', lookup);
      const { rail, chain } = realBroadcast();
      const error = (await failure(
        rail.send([call()]),
      )) as TransactionFailedError;
      const local = keccak256(rawOf(chain));
      expect(error).toBeInstanceOf(TransactionFailedError);
      expect(error.code).toBe('nonce_already_used');
      expect(error.mayHaveLanded).toBe(true);
      expect(error.transactionHash).toBe(local);
      expect(error.nonce).toBe(5n);
      expect(error.message).toContain(
        `check which transaction used nonce 5 from executor ${OWNER}`,
      );
      // Only the local hash is looked up (a failed lookup is a read, which viem may retry).
      expect(new Set(node.lookups)).toEqual(new Set([local]));
      expect(node.posts).toBe(1);
      expect(chain.count('waitForReceipt')).toBe(0);

      const sent = laggingSponsor();
      await sponsoredRail({ chain }).rail.send([call()]);
      expect(nonces(sent)).toEqual(['0x5']);
    },
  );

  test('"nonce too low" with a reader that has no getTransaction → nonce_already_used', async () => {
    const chain = railChain();
    chain.broadcast = new TransactionFailedError('nonce too low', {
      mayHaveLanded: true,
      code: 'nonce_too_low',
      service: 'chain',
    });
    const { getTransaction: _, ...reader } = chain.reader;
    const rail = new DirectRail({
      env,
      identity: eoaIdentity(),
      signer: ownerSigner(),
      chain: reader,
    });
    const error = await failure(rail.send([call()]));
    expect(error.code).toBe('nonce_already_used');
    expect(error.mayHaveLanded).toBe(true);
  });

  test('"unknown transaction type" is not taken (the taken patterns are whole words)', async () => {
    nodeError(-32000, 'unknown transaction type 0x02');
    const { rail, chain } = realBroadcast();
    const error = await failure(rail.send([call()]));
    expect(error.code).toBe('broadcast_outcome_unknown');
    expect(error.mayHaveLanded).toBe(true);
    expect(chain.count('waitForReceipt')).toBe(0);
  });

  test('an HTTP 502 → broadcast_outcome_unknown, sent once', async () => {
    let posts = 0;
    server.use(
      http.post(env.rpcUrl, () => {
        posts += 1;
        return new HttpResponse('bad gateway', { status: 502 });
      }),
    );
    const { rail } = realBroadcast();
    const error = await failure(rail.send([call()]));
    expect(error.code).toBe('broadcast_outcome_unknown');
    expect(error.mayHaveLanded).toBe(true);
    expect(posts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Every error carries mayHaveLanded, code by code
// ---------------------------------------------------------------------------

const otherKey = keySigner(`0x${'22'.repeat(32)}`);

describe('every error carries mayHaveLanded', () => {
  type Case = [code: string, expected: boolean, run: () => Promise<unknown>];
  const cases: Case[] = [
    [
      'sponsor_not_configured',
      false,
      () => {
        const { sponsorUrl: _, ...noSponsor } = env;
        return sponsoredRail({ env: noSponsor }).rail.send([call()]);
      },
    ],
    ['invalid_input', false, () => sponsoredRail().rail.send([])],
    [
      'signer_mismatch',
      false,
      () => sponsoredRail({ signer: otherKey }).rail.send([call()]),
    ],
    [
      'sign_hash_unsupported',
      false,
      () => sponsoredRail({ signer: noRawSigner() }).rail.send([call()]),
    ],
    [
      'signing_failed',
      false,
      () => sponsoredRail({ signer: answering('nope') }).rail.send([call()]),
    ],
    [
      'signature_mismatch',
      false,
      () => {
        const owner = ownerSigner();
        const signer = {
          ...owner,
          address: owner.address,
          signHash: otherKey.signHash,
        };
        return sponsoredRail({ signer }).rail.send([call()]);
      },
    ],
    [
      'chain_read_failed',
      false,
      () => {
        const chain = railChain();
        chain.fees = new Error('down');
        return sponsoredRail({ chain }).rail.send([call()]);
      },
    ],
    [
      'smart_wallet_address_mismatch',
      false,
      () => {
        const chain = railChain();
        chain.code.clear();
        chain.read = addressWord(`0x${'77'.repeat(20)}`);
        return sponsoredRail({
          chain,
          identity: smartWalletIdentity(),
        }).rail.send([call()]);
      },
    ],
    [
      'gas_estimation_failed',
      false,
      () => {
        const chain = railChain();
        chain.estimate = new Error('reverted');
        return sponsoredRail({ chain }).rail.send([call()]);
      },
    ],
    [
      'policy_rejected',
      false,
      () => {
        sponsor(() =>
          HttpResponse.json(
            { error: { code: 'policy_rejected', message: 'no' } },
            { status: 403 },
          ),
        );
        return sponsoredRail().rail.send([call()]);
      },
    ],
    [
      'bad_request',
      false,
      () => {
        sponsor(() =>
          HttpResponse.json(
            { error: { code: 'bad_request', message: 'no' } },
            { status: 400 },
          ),
        );
        return sponsoredRail().rail.send([call()]);
      },
    ],
    [
      'overloaded',
      false,
      () => {
        sponsor(() =>
          HttpResponse.json(
            { error: { code: 'overloaded', message: 'busy' } },
            { status: 429 },
          ),
        );
        return sponsoredRail().rail.send([call()]);
      },
    ],
    [
      'sponsor_outcome_unknown',
      true,
      () => {
        sponsor(() => HttpResponse.error());
        return sponsoredRail().rail.send([call()]);
      },
    ],
    [
      'executor_mismatch',
      true,
      () => {
        sponsor(() =>
          HttpResponse.json({
            txHash: TX_HASH,
            executor: `0x${'99'.repeat(20)}`,
          }),
        );
        return sponsoredRail().rail.send([call()]);
      },
    ],
    [
      'receipt_timeout',
      true,
      () => {
        sponsor();
        const chain = railChain();
        chain.receipt = () => new TimeoutError('slow', { service: 'chain' });
        return sponsoredRail({ chain }).rail.send([call()]);
      },
    ],
    [
      'receipt_unavailable',
      true,
      () => {
        sponsor();
        const chain = railChain();
        chain.receipt = () => new Error('down');
        return sponsoredRail({ chain }).rail.send([call()]);
      },
    ],
    [
      'direct_rail_eoa_only',
      false,
      () => directRail({ identity: smartWalletIdentity() }).rail.send([call()]),
    ],
    [
      'direct_rail_single_call',
      false,
      () => directRail().rail.send([call(1), call(2)]),
    ],
    [
      'rejected_by_node',
      false,
      () => {
        const chain = railChain();
        chain.broadcast = new TransactionFailedError('insufficient funds', {
          mayHaveLanded: false,
          code: 'rejected_by_node',
          service: 'chain',
        });
        return directRail({ chain }).rail.send([call()]);
      },
    ],
    [
      'nonce_already_used',
      true,
      () => {
        const chain = railChain();
        chain.broadcast = new TransactionFailedError('nonce too low', {
          mayHaveLanded: true,
          code: 'nonce_too_low',
          service: 'chain',
        });
        return directRail({ chain }).rail.send([call()]);
      },
    ],
    [
      'broadcast_outcome_unknown',
      true,
      () => {
        const chain = railChain();
        chain.broadcast = new Error('socket hang up');
        return directRail({ chain }).rail.send([call()]);
      },
    ],
  ];

  test.each(cases)('%s → mayHaveLanded %s', async (code, expected, run) => {
    const error = await failure(run());
    expect(error.code).toBe(code);
    expect(error.mayHaveLanded).toBe(expected);
    expect(error.toJSON().mayHaveLanded).toBe(expected);
  });
});
