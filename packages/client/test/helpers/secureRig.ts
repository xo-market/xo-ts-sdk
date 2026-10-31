import { HttpResponse, http } from 'msw';
import type { SetupServer } from 'msw/node';
import {
  type Address,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  getAddress,
  type Hex,
} from 'viem';
import { CONDITIONAL_TOKENS_ABI, ERC20_ABI } from '../../src/account/abis';
import type { SponsorRequestBody } from '../../src/account/sponsorClient';
import {
  createSecureClient,
  type SecureClient,
} from '../../src/clients/secure';
import type { EnvironmentConfig } from '../../src/core/env';
import { privateKey } from '../../src/wallet/publicSigner';
import { installAccountData } from './mockAccountData';
import { installBackend } from './mockBackend';
import { installBackendData } from './mockBackendData';
import { installBridge } from './mockBridge';
import { installMarketData } from './mockMarketData';
import { installOrderbook } from './mockOrderbook';
import { installRewardsData } from './mockRewardsData';
import { installTrading } from './mockTrading';
import { OWNER, OWNER_PK, type RailChainStub, TX_HASH } from './railChain';
import { testEnvWithBridge } from './testEnv';

// A secure client signed in to the fakes of every XO service: the sign-in routes, the order
// book (credentials, trading, balances), the account and rewards data, the bridge, the sponsor,
// and a chain stub as the client's chain reader. The data and bridge fakes accept the key the
// client signed in for. The trading wallet is the signer's own address, `OWNER`.

/** An ERC-20 token other than USDC, with 18 decimals, that the chain stub knows. */
export const OTHER_TOKEN: Address = getAddress(
  '0x00000000000000000000000000000000000a11ce',
);

/** What the chain stub answers for the account's tokens, approvals and markets. */
export interface ChainState {
  /** Balances in base units, by lower-case token address. */
  balances: Map<string, bigint>;
  /** Decimals, by lower-case token address. */
  decimals: Map<string, number>;
  /** The USDC allowance of the exchange. */
  allowance: bigint;
  /** Whether the exchange may move the outcome tokens. */
  operatorApproved: boolean;
  /** The payout denominator of every condition: 0 until it is resolved. */
  payoutDenominator: bigint;
}

/** What the fake sponsor saw. */
export interface SponsorLog {
  bodies: SponsorRequestBody[];
  /** Answers each request; by default the transaction hash `TX_HASH`. */
  reply: (body: SponsorRequestBody) => Response;
}

/** The exchange nonce the chain answers, for the order signatures. */
const NONCE_WORD = encodeAbiParameters([{ type: 'uint128' }], [7n]);

/** Answers the chain stub's `readContract` from `state`. */
export function chainReads(
  chain: RailChainStub,
  env: EnvironmentConfig,
  state: ChainState,
): void {
  const { usdc, conditionalTokens, ctfExchange } = env.contracts;
  chain.read = ({ to, data }) => {
    const target = to.toLowerCase();
    if (target === ctfExchange.toLowerCase()) {
      return NONCE_WORD;
    }
    if (target === conditionalTokens.toLowerCase()) {
      const call = decodeFunctionData({ abi: CONDITIONAL_TOKENS_ABI, data });
      if (call.functionName === 'isApprovedForAll') {
        return encodeFunctionResult({
          abi: CONDITIONAL_TOKENS_ABI,
          functionName: 'isApprovedForAll',
          result: state.operatorApproved,
        });
      }
      if (call.functionName === 'payoutDenominator') {
        return encodeFunctionResult({
          abi: CONDITIONAL_TOKENS_ABI,
          functionName: 'payoutDenominator',
          result: state.payoutDenominator,
        });
      }
      return new Error('execution reverted');
    }
    if (target === usdc.toLowerCase() || state.decimals.has(target)) {
      const call = decodeFunctionData({ abi: ERC20_ABI, data });
      switch (call.functionName) {
        case 'balanceOf':
          return encodeFunctionResult({
            abi: ERC20_ABI,
            functionName: 'balanceOf',
            result: state.balances.get(target) ?? 0n,
          });
        case 'decimals':
          return encodeFunctionResult({
            abi: ERC20_ABI,
            functionName: 'decimals',
            result: state.decimals.get(target) ?? 6,
          });
        case 'allowance':
          return encodeFunctionResult({
            abi: ERC20_ABI,
            functionName: 'allowance',
            result: state.allowance,
          });
        default:
          return new Error('execution reverted');
      }
    }
    return new Error('execution reverted');
  };
}

/** A fake sponsor on `env`, answering `TX_HASH` for the owner unless `reply` says otherwise. */
export function installSponsor(
  server: SetupServer,
  env: EnvironmentConfig,
): SponsorLog {
  const log: SponsorLog = {
    bodies: [],
    reply: () =>
      HttpResponse.json({
        txHash: TX_HASH,
        sponsor: '0x49c3b3b4adcaa889cd42934f20f5a563d0bbfde8',
        executor: OWNER,
      }),
  };
  server.use(
    http.post(`${env.sponsorUrl}/v1/sponsor/send`, async ({ request }) => {
      const body = (await request.json()) as SponsorRequestBody;
      log.bodies.push(body);
      return log.reply(body);
    }),
  );
  return log;
}

/** The default chain state: 1000 USDC, 50 of the other token, nothing approved, nothing resolved. */
export function defaultChainState(env: EnvironmentConfig): ChainState {
  return {
    balances: new Map([
      [env.contracts.usdc.toLowerCase(), 1_000_000_000n],
      [OTHER_TOKEN.toLowerCase(), 50n * 10n ** 18n],
    ]),
    decimals: new Map([[OTHER_TOKEN.toLowerCase(), 18]]),
    allowance: 0n,
    operatorApproved: false,
    payoutDenominator: 0n,
  };
}

/**
 * Signs a secure client in to every fake. Install the chain seam (`setClientSeams({ chain })`)
 * before calling it: the client reads the chain through it.
 */
export async function signedInClient(
  server: SetupServer,
  o: { env?: EnvironmentConfig; WebSocket?: typeof WebSocket } = {},
): Promise<{
  client: SecureClient;
  data: ReturnType<typeof installBackendData>;
  account: ReturnType<typeof installAccountData>;
  rewards: ReturnType<typeof installRewardsData>;
  bridge: ReturnType<typeof installBridge>;
  trading: ReturnType<typeof installTrading>;
  sponsor: SponsorLog;
}> {
  const env = o.env ?? testEnvWithBridge;
  installMarketData(server);
  const auth = installBackend(server);
  const orderbook = installOrderbook(server);
  const trading = installTrading(server, orderbook);
  // The account data fake lists and revokes keys too, so it comes after the sign-in fake.
  const data = installBackendData(server, { validKeys: [] });
  const account = installAccountData(server, data);
  const rewards = installRewardsData(server, data);
  const bridge = installBridge(server, { backendUrl: env.backendUrl });
  const sponsor = installSponsor(server, env);
  // After the market data fake, whose clock is fixed: the L2 checks read the real one.
  server.use(
    http.get(`${env.orderbookUrl}/time`, () =>
      HttpResponse.json(Math.floor(Date.now() / 1000)),
    ),
  );
  const client = await createSecureClient({
    environment: env,
    signer: privateKey(OWNER_PK),
    ...(o.WebSocket === undefined ? {} : { WebSocket: o.WebSocket }),
  });
  for (const { key } of auth.minted) {
    data.validKeys.add(key);
    bridge.fixtures.validKeys.add(key);
  }
  return { client, data, account, rewards, bridge, trading, sponsor };
}

/** The calldata of the one call of a sponsored transaction, decoded with `abi`. */
export function onlyCall(body: SponsorRequestBody | undefined): {
  to: Address | null;
  data: Hex;
} {
  const [call] = body?.tx.calls ?? [];
  if (call === undefined || body?.tx.calls.length !== 1) {
    throw new Error('expected a transaction of one call');
  }
  return { to: call.to, data: call.data };
}
