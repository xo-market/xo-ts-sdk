import {
  type Address,
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  isAddressEqual,
  keccak256,
  maxUint256,
  parseAbi,
  toHex,
} from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { expect, it } from 'vitest';
import { CONDITIONAL_TOKENS_ABI, ERC20_ABI } from '../src/account/abis';
import { createChainReader } from '../src/account/chain';
import {
  checkCalls,
  MIN_FEE_PER_GAS,
  resolveGasLimit,
  signDigest,
} from '../src/account/rails';
import { mergeCall, redeemCall } from '../src/account/settle';
import {
  SPONSOR_SEND_PATH,
  SPONSOR_TIMEOUT_MS,
  type SponsorRequestBody,
  toSponsorTx,
} from '../src/account/sponsorClient';
import { production } from '../src/core/env';
import { isRejected, XoError } from '../src/core/errors';
import { normalizeConditionId } from '../src/core/ids';
import {
  type EvCall,
  type EvTx,
  executorSigningHash,
  validateEvTx,
} from '../src/signing/evTx';
import {
  type Call,
  kernelCreateAccountCalldata,
  kernelExecuteCalldata,
} from '../src/signing/kernel';
import { keySigner } from '../test/helpers/signers';
import {
  describeLive,
  liveFetch,
  liveTransport,
  readOnlyRpc,
  strictPublicClient,
} from './setup';

// Read-only checks of the `production` preset and of XO's production sponsor against the live
// services. They send nothing: the RPC gets only reads (`eth_chainId`, `eth_getCode`,
// `eth_call`, the gas estimates and the fee estimate), and the sponsor only `GET /health` and
// `POST /v1/sponsor/sign`, which signs as fee payer and never broadcasts. `/v1/sponsor/send` is
// never called: liveFetch refuses it, and the RPC transport refuses a send. Every executor is a
// key generated in memory for one case of this run, which only signs the sponsor request (it
// never signs in, so no account is made); no key is ever printed or written.
//
//   XO_E2E=1 pnpm -C packages/client test:e2e e2e/mainnet.e2e.test.ts

const mainnet = production;
const { contracts, chainId } = mainnet;

/** XO's production sponsor: the fee payer of every sponsored transaction on mainnet. */
const SPONSOR_ADDRESS: Address = '0x1237eDde231af0CF5b45cA924A366Aa5ccEFf7a9';

/** The sponsor's sign-only route: it answers the fee payer's signature and broadcasts nothing. */
const SIGN_PATH = '/v1/sponsor/sign';

/** A 65-byte `r || s || v` signature. */
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;

/**
 * The condition of the merge and redeem probes. The sponsor's policy decides on the contract and
 * the selector, so the condition need not exist; the calls are never sent.
 */
const PROBE_CONDITION = normalizeConditionId(
  keccak256(toHex('xo-sdk mainnet e2e sponsor policy probe')),
);

/**
 * The gas limit of a probe whose calls revert for a fresh account (a merge or a redeem of a
 * condition it holds nothing of), so they cannot be estimated: the rail's `gasLimit` override
 * path, raised to the calls' intrinsic gas as the rail raises it.
 */
const PROBE_GAS_OVERRIDE = 500_000n;

const TOKEN_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);
const MANAGER_ABI = parseAbi([
  'function CTF_EXCHANGE() view returns (address)',
]);

/** `USDC.transfer(to, amount)`, as `transferUsdc` builds it. */
const usdcTransfer = (to: Address, amount: bigint): Call => ({
  to: contracts.usdc,
  data: encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [to, amount],
  }),
  value: 0n,
});

/** `USDC.approve(CTFExchange, max)`, the `approve_usdc` action of `setup()`. */
const approveExchange = (): Call => ({
  to: contracts.usdc,
  data: encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [contracts.ctfExchange, maxUint256],
  }),
  value: 0n,
});

/**
 * `USDC.approve(ClobMarketManager, max)`, the `approve_manager` action of
 * `setup({ includeMarketManager: true })`.
 */
const approveManager = (): Call => ({
  to: contracts.usdc,
  data: encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [contracts.clobMarketManager, maxUint256],
  }),
  value: 0n,
});

/** `ConditionalTokens.setApprovalForAll(CTFExchange, true)`, the `approve_ctf` action of `setup()`. */
const approveOperator = (): Call => ({
  to: contracts.conditionalTokens,
  data: encodeFunctionData({
    abi: CONDITIONAL_TOKENS_ABI,
    functionName: 'setApprovalForAll',
    args: [contracts.ctfExchange, true],
  }),
  value: 0n,
});

/** One sign-only probe: the calls the SDK hands its rail, for one kind of wallet. */
interface ProbeCase {
  name: string;
  wallet: 'eoa' | 'smart_wallet';
  /** The calls, for the case's throwaway recipient. */
  calls(recipient: Address): Call[];
  /**
   * Smart wallet only: the rail prepends `factory.createAccount(...)`, as it does for a smart
   * wallet without code. Without it the request is the one of a deployed smart wallet.
   */
  deploy?: boolean;
  /** The calls revert for a fresh account, so the gas is {@link PROBE_GAS_OVERRIDE}. */
  unestimable?: boolean;
}

/**
 * Every kind of call the SDK sends on mainnet, for both wallet types, as the sponsor must sign it:
 * `USDC.transfer`, the setup approvals (`USDC.approve` of the exchange and of the market manager,
 * `CTF.setApprovalForAll`), `CTF.mergePositions` and `CTF.redeemPositions`, as a plain wallet's
 * top-level calls and inside a smart wallet's `execute`, and the smart wallet's `createAccount`.
 */
const SIGNED_CASES: ProbeCase[] = [
  {
    name: 'plain wallet: USDC.transfer',
    wallet: 'eoa',
    calls: (recipient) => [usdcTransfer(recipient, 0n)],
  },
  {
    name: 'plain wallet: USDC.approve(CTFExchange)',
    wallet: 'eoa',
    calls: () => [approveExchange()],
  },
  {
    name: 'plain wallet: CTF.setApprovalForAll(CTFExchange)',
    wallet: 'eoa',
    calls: () => [approveOperator()],
  },
  {
    name: 'plain wallet: USDC.approve(ClobMarketManager)',
    wallet: 'eoa',
    calls: () => [approveManager()],
  },
  {
    name: 'plain wallet: the setup batch',
    wallet: 'eoa',
    calls: () => [approveExchange(), approveOperator()],
  },
  {
    name: 'plain wallet: CTF.mergePositions',
    wallet: 'eoa',
    calls: () => [mergeCall(contracts, PROBE_CONDITION, 0n)],
    unestimable: true,
  },
  {
    name: 'plain wallet: CTF.redeemPositions',
    wallet: 'eoa',
    calls: () => [redeemCall(contracts, PROBE_CONDITION)],
    unestimable: true,
  },
  {
    name: 'smart wallet: createAccount + execute(USDC.transfer)',
    wallet: 'smart_wallet',
    calls: (recipient) => [usdcTransfer(recipient, 0n)],
    deploy: true,
  },
  {
    name: 'smart wallet: execute(the setup batch)',
    wallet: 'smart_wallet',
    calls: () => [approveExchange(), approveOperator()],
  },
  {
    name: 'smart wallet: execute(USDC.approve(ClobMarketManager))',
    wallet: 'smart_wallet',
    calls: () => [approveManager()],
  },
  {
    name: 'smart wallet: execute(CTF.mergePositions)',
    wallet: 'smart_wallet',
    calls: () => [mergeCall(contracts, PROBE_CONDITION, 0n)],
  },
  {
    name: 'smart wallet: execute(CTF.redeemPositions)',
    wallet: 'smart_wallet',
    calls: () => [redeemCall(contracts, PROBE_CONDITION)],
  },
];

describeLive('XO mainnet preset and production sponsor (read-only)', () => {
  // ccipRead false: never follow an off-chain lookup that a contract asks for.
  const client = createPublicClient({
    transport: readOnlyRpc(),
    ccipRead: false,
  });
  // The SDK's own reader, for the rail's gas and fee rules: its RPC goes through the global
  // fetch, which refuses a send (e2e/readOnlyGuard.ts).
  const chain = createChainReader(mainnet);
  const sponsorUrl = mainnet.sponsorUrl;
  if (sponsorUrl === undefined) {
    throw new Error('production has no sponsorUrl');
  }
  // The transport a client gives its SponsoredRail: the same X-XO-SDK header and error parsing,
  // on liveFetch.
  const transport = liveTransport();

  /** The smart wallet the factory deploys for `owner` at index 0: its `eth_call` answer. */
  const smartWalletOf = async (owner: Address): Promise<Address> => {
    const { data } = await client.call({
      to: contracts.kernelFactory,
      data: kernelCreateAccountCalldata(owner, 0n, contracts.ecdsaValidator),
    });
    expect(data, 'the factory answered no address word').toMatch(
      /^0x0{24}[0-9a-fA-F]{40}$/,
    );
    return getAddress(`0x${(data as Hex).slice(26)}`);
  };

  /** The chain's fees, each at least 1 gwei, the cap never below the tip: the rail's own rule. */
  const fees = async () => {
    const { maxFeePerGas, maxPriorityFeePerGas } = await chain.getFees();
    const tip =
      maxPriorityFeePerGas > MIN_FEE_PER_GAS
        ? maxPriorityFeePerGas
        : MIN_FEE_PER_GAS;
    return {
      maxPriorityFeePerGas: tip,
      maxFeePerGas: maxFeePerGas > tip ? maxFeePerGas : tip,
    };
  };

  /**
   * The request `SponsoredRail.send` builds for `calls`, from a fresh executor: the top-level
   * calls (the calls themselves for a plain wallet; `execute` on the smart wallet, after
   * `createAccount` when `deploy`), nonce 0 (a fresh key's pending count), the rail's gas limit
   * and fees, and the executor's normalised signature over `executorSigningHash`.
   */
  async function railRequest(
    probe: Pick<ProbeCase, 'wallet' | 'deploy' | 'unestimable'>,
    calls: Call[],
  ): Promise<{
    body: SponsorRequestBody;
    executor: Address;
    gas: { limit: bigint; source: string };
  }> {
    const signer = keySigner(generatePrivateKey());
    const executor = getAddress(signer.address);
    const checked = checkCalls(calls);
    let top: EvCall[];
    if (probe.wallet === 'eoa') {
      top = checked.map((c) => ({ to: c.to, value: c.value, input: c.data }));
    } else {
      const execute: EvCall = {
        to: await smartWalletOf(executor),
        value: 0n,
        input: kernelExecuteCalldata(checked),
      };
      top =
        probe.deploy === true
          ? [
              {
                to: getAddress(contracts.kernelFactory),
                value: 0n,
                input: kernelCreateAccountCalldata(
                  executor,
                  0n,
                  contracts.ecdsaValidator,
                ),
              },
              execute,
            ]
          : [execute];
    }

    const gas =
      probe.unestimable === true
        ? {
            limit: await resolveGasLimit(
              chain,
              executor,
              top,
              PROBE_GAS_OVERRIDE,
            ),
            source: 'the gasLimit override',
          }
        : {
            limit: await resolveGasLimit(chain, executor, top),
            source: top.length > 1 ? 'a bundle simulation' : 'an estimate',
          };

    const tx: EvTx = {
      chainId: BigInt(chainId),
      nonce: 0n,
      ...(await fees()),
      gasLimit: gas.limit,
      calls: top,
      accessList: [],
    };
    validateEvTx(tx);
    const signHash = signer.signHash;
    if (signHash === undefined) {
      throw new Error('the key signer has no signHash');
    }
    const { canonical } = await signDigest(
      (hash) => signHash.call(signer, hash),
      executorSigningHash(tx),
      executor,
    );
    return {
      body: { tx: toSponsorTx(tx), executorSignature: canonical },
      executor,
      gas,
    };
  }

  /** `POST /v1/sponsor/sign` with `body`, as the rail posts `/send`: once, no retry. */
  const sign = (body: SponsorRequestBody): Promise<unknown> => {
    // Never the broadcasting route.
    expect(SIGN_PATH).not.toBe(SPONSOR_SEND_PATH);
    return transport.request({
      service: 'sponsor',
      method: 'POST',
      path: SIGN_PATH,
      body,
      auth: 'none',
      retry: 'none',
      timeoutMs: SPONSOR_TIMEOUT_MS,
    });
  };

  /** What a refusal of the sponsor says, for a message: its code and text, never a key. */
  const refusal = (error: unknown): string =>
    error instanceof XoError
      ? `${error.name} ${error.code} (HTTP ${error.status ?? 'none'}): ${error.message.slice(0, 300)}`
      : error instanceof Error
        ? `${error.name}: ${error.message.slice(0, 300)}`
        : 'a non-Error was thrown';

  it('the RPC serves chain 3223', async () => {
    expect(chainId).toBe(3223);
    await expect(client.getChainId()).resolves.toBe(3223);
  });

  it('every preset contract has code', async () => {
    const targets: Record<string, Address> = {
      usdc: contracts.usdc,
      ctfExchange: contracts.ctfExchange,
      conditionalTokens: contracts.conditionalTokens,
      clobMarketManager: contracts.clobMarketManager,
      kernelFactory: contracts.kernelFactory,
      ecdsaValidator: contracts.ecdsaValidator,
    };
    const codes = await Promise.all(
      Object.entries(targets).map(async ([name, address]) => ({
        name,
        address,
        code: await client.getCode({ address }),
      })),
    );
    // viem answers `undefined` for an address with no code.
    const withoutCode = codes
      .filter(({ code }) => code === undefined || code === '0x')
      .map(({ name, address }) => `${name} ${address}`);
    expect(withoutCode).toEqual([]);
  });

  it('USDC is USDC.e with 6 decimals', async () => {
    const [symbol, decimals] = await Promise.all([
      client.readContract({
        address: contracts.usdc,
        abi: TOKEN_ABI,
        functionName: 'symbol',
      }),
      client.readContract({
        address: contracts.usdc,
        abi: TOKEN_ABI,
        functionName: 'decimals',
      }),
    ]);
    expect(symbol).toBe('USDC.e');
    expect(decimals).toBe(6);
  });

  it('the manager names the preset exchange', async () => {
    const exchange = await client.readContract({
      address: contracts.clobMarketManager,
      abi: MANAGER_ABI,
      functionName: 'CTF_EXCHANGE',
    });
    expect(getAddress(exchange)).toBe(getAddress(contracts.ctfExchange));
  });

  it('the collateral token XO lists is the preset USDC', async () => {
    const tokens = await strictPublicClient().fetchCollateralTokens();
    const usdc = tokens.find(
      (token) => getAddress(token.address) === getAddress(contracts.usdc),
    );
    expect(
      usdc,
      'XO lists the preset USDC as a collateral token',
    ).toBeDefined();
    expect(usdc?.decimals).toBe(6);
  });

  it('the preset names the production sponsor, and it answers GET /health with 200', async () => {
    expect(sponsorUrl).toBe('https://sponsor.xo.market');
    const response = await liveFetch([])(new URL('/health', sponsorUrl), {
      signal: AbortSignal.timeout(15_000),
    });
    expect(response.status).toBe(200);
  });

  it.each(SIGNED_CASES)(
    'the sponsor signs (sign-only) $name, as the SDK sends it',
    async (probe) => {
      const recipient = privateKeyToAddress(generatePrivateKey());
      const { body, executor, gas } = await railRequest(
        probe,
        probe.calls(recipient),
      );

      let answer: unknown;
      try {
        answer = await sign(body);
      } catch (error) {
        throw new Error(
          `The sponsor did not sign ${probe.name}: ${refusal(error)}`,
        );
      }

      const signed = (answer ?? {}) as Record<string, unknown>;
      expect(
        signed.feePayerSignature,
        'no 65-byte fee payer signature',
      ).toMatch(SIGNATURE_PATTERN);
      expect(
        typeof signed.sponsor === 'string' &&
          isAddressEqual(signed.sponsor as Address, SPONSOR_ADDRESS),
        `signed by ${String(signed.sponsor)}, not the sponsor ${SPONSOR_ADDRESS}`,
      ).toBe(true);
      expect(
        typeof signed.executor === 'string' &&
          isAddressEqual(signed.executor as Address, executor),
        'the sponsor recovered another executor',
      ).toBe(true);
      console.info(
        `[e2e] sponsor /sign ${probe.name}: signed (${body.tx.calls.length} top-level call(s), gas ${gas.limit} from ${gas.source})`,
      );
    },
  );

  it('the sponsor refuses USDC.transferFrom with 403 policy_rejected, so a loosened policy fails here', async () => {
    const { body } = await railRequest({ wallet: 'eoa', unestimable: true }, [
      {
        to: contracts.usdc,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transferFrom',
          args: [
            privateKeyToAddress(generatePrivateKey()),
            privateKeyToAddress(generatePrivateKey()),
            0n,
          ],
        }),
        value: 0n,
      },
    ]);

    const outcome = await sign(body).then(
      () => ({ signed: true as const }),
      (error: unknown) => ({ signed: false as const, error }),
    );

    if (outcome.signed) {
      throw new Error(
        'The sponsor signed USDC.transferFrom: its policy is looser than the SDK needs',
      );
    }
    const { error } = outcome;
    expect(isRejected(error, 403), refusal(error)).toBe(true);
    expect((error as XoError).code).toBe('policy_rejected');
    console.info(
      `[e2e] sponsor /sign plain wallet: USDC.transferFrom: refused (${refusal(error)})`,
    );
  });
});
