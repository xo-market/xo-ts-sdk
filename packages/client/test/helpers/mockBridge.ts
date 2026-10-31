import { HttpResponse, http } from 'msw';
import type { SetupServer } from 'msw/node';
import { decodeFunctionData, encodeFunctionResult } from 'viem';
import { expect } from 'vitest';
import { ERC20_ABI } from '../../src/account/abis';
import type { TxResult } from '../../src/account/chain';
import { AccountClient } from '../../src/account/client';
import type { TxRail } from '../../src/account/rails';
import { Session } from '../../src/auth/session';
import { BridgeClient } from '../../src/bridge/client';
import { Clock } from '../../src/core/clock';
import type { EnvironmentConfig } from '../../src/core/env';
import { Transport } from '../../src/core/transport';
import type { Call } from '../../src/signing/kernel';
import type { InternalSigner } from '../../src/wallet/signer';
import { API_KEY } from './dataRig';
import { exceptionResponse, validationError } from './mockBackend';
import {
  eoaIdentity,
  OWNER,
  type RailChainStub,
  railChain,
  TX_HASH,
} from './railChain';
import { testEnv, testEnvWithBridge } from './testEnv';

// A fake of the backend's seven bridge routes, for the msw tests
// of the BridgeClient. It is written from the backend's routes, their checks and their
// answers, not from the SDK, so a test that reads
// against it checks the SDK's requests and schemas against an independent version:
//
// - every route is `shared` (a session or an `xo_sk` key): a missing or unknown key is a 401;
// - a failed DTO is the global pipe's flat 400 with no code; a domain failure is the bridge
//   filter's `response.error` code (see `exceptionResponse`);
// - the answers are the presenters', field for field: `{ data: [...] }` for the assets,
//   `{ data: { quotes, acceptBy, limits } }` for the quotes, a bare payment for the confirm,
//   verification, claim and get, and `{ data, nextCursor }` for the list;
// - every POST answers 200, and a replayed confirm answers with the stored payment.
//
// The payments live in a map the test can read and seed. `override(route, resolver)` answers one
// route differently from then on. Every request that reaches a handler is recorded.

const env = testEnv;

/** XO USDC, the asset every deposit lands as and every withdrawal starts from. */
export const XO_USDC_ASSET = 'xo:0x80c12230ce677e6f304027a14780edd2a829ab0c';
/** USDC on Base, an asset of both lists. */
export const BASE_USDC = 'base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
/**
 * XO USDC of the rig's environment as the asset id a withdrawal's deposit block names it by
 * (`xo:` and the lower-case USDC contract of `env`).
 */
export const XO_USDC_TOKEN = `xo:${env.contracts.usdc.toLowerCase()}`;
/** USDT on Ethereum, a deposit asset. */
export const ETH_USDT = 'ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7';
/** A withdrawal recipient on Base. */
export const RECIPIENT = '0x00000000000000000000000000000000000000B0';
/** The one-time address the bridge provider asks a deposit to be sent to. */
export const DEPOSIT_ADDRESS = '0x00000000000000000000000000000000000000d1';

/** A quote can be confirmed until then. */
export const ACCEPT_BY = '2026-10-21T12:05:00.000Z';
const CREATED_AT = '2026-10-21T12:00:00.000Z';
/**
 * The time a confirmed payment must be funded by. Far ahead on purpose: the funding claim
 * refuses a payment whose deadline is within 10 minutes of the real clock, so a date near
 * today would turn the fixtures into a time bomb.
 */
export const FUND_BY = '2099-12-31T00:00:00.000Z';
/** The funding claim refuses a payment whose `fundBy` is closer than this (or past). */
export const FUND_BY_GUARD_MS = 10 * 60_000;

/** One asset as the backend sends it. */
export function assetFixture(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    asset: BASE_USDC,
    chain: 'base',
    chainId: '8453',
    addressFamily: 'EVM',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    isNative: false,
    imageUrl: 'https://assets.example.com/usdc.png',
    ...over,
  };
}

/** One payment as the backend sends it: a confirmed deposit awaiting its funds. */
export function paymentFixture(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    paymentId: 'pay_1',
    direction: 'deposit',
    status: 'AWAITING_FUNDS',
    hallidayStatus: 'PENDING',
    input: { asset: BASE_USDC, amount: '25.5' },
    output: { asset: XO_USDC_ASSET, amount: '25.4' },
    fees: {
      total: '0.1',
      conversion: '0',
      network: '0.05',
      business: '0.05',
      currency: 'USD',
    },
    ownerAddress: OWNER,
    destinationAddress: OWNER,
    recipient: null,
    acceptBy: ACCEPT_BY,
    fundBy: FUND_BY,
    // The deposit names its token by asset id, as the asset lists do (the bridge's
    // `deposit_token`): USDC on Base here, the input of the payment.
    deposit: {
      address: DEPOSIT_ADDRESS,
      amount: '25.5',
      token: BASE_USDC,
      chain: 'base',
    },
    verification: null,
    fundingClaimedAt: null,
    fundingTxHash: null,
    deliveryTxHash: null,
    recoveryUrl: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    completedAt: null,
    ...over,
  };
}

/** What the fake answers from. The test may change any field after `installBridge`. */
export interface BridgeFixtures {
  /** `GET /assets`, by direction. A quote is refused for an asset that is not in its list. */
  assets: Record<'deposit' | 'withdraw', Array<Record<string, unknown>>>;
  /** The status a confirm moves a QUOTED payment to. */
  confirmedStatus: string;
  /** The `limits` of a quote answer. */
  limits: { min: string | null; max: string | null };
  /** How many options a quote answer holds. */
  quoteOptions: number;
  /** The `xo_sk` keys the routes accept. */
  validKeys: Set<string>;
}

/** The seven routes. */
export type BridgeRoute =
  | 'assets'
  | 'quotes'
  | 'confirm'
  | 'verification'
  | 'fundingClaim'
  | 'payment'
  | 'payments';

/** One request that reached a handler. */
export interface BridgeRequest {
  method: string;
  /** The pathname, without the query. */
  path: string;
  query: Record<string, string>;
  /** The parsed JSON body of a POST, `undefined` for a GET. */
  body: unknown;
  /** The Authorization header, or null when none was sent. */
  authorization: string | null;
  /** The X-XO-SDK header, or null. */
  sdk: string | null;
}

/** What a resolver is given: the recorded request and the `:paymentId` of the path. */
export interface BridgeCall {
  request: BridgeRequest;
  params: { paymentId?: string };
}

/** Answers one route. */
export type BridgeResolver = (call: BridgeCall) => Response | Promise<Response>;

export interface BridgeBackend {
  /** Every request that reached a handler (an overridden route included), oldest first. */
  requests: BridgeRequest[];
  /** The payments, by payment id: quote options and confirmed payments alike. */
  payments: Map<string, Record<string, unknown>>;
  fixtures: BridgeFixtures;
  /** Answers `route` with `resolver` from now on (a later override wins). The request is recorded first. */
  override(route: BridgeRoute, resolver: BridgeResolver): void;
}

export interface BridgeBackendOptions {
  fixtures?: Partial<BridgeFixtures>;
  /** The backend the routes are served on. Defaults to the test environment's, which the rig's environment uses. */
  backendUrl?: string;
  /**
   * The USDC contract a confirmed withdrawal's deposit names (as `xo:` and the lower-case
   * address). Defaults to the test environment's USDC, which is mainnet's: the test environment
   * holds the mainnet contracts.
   */
  usdc?: string;
}

const ROUTES: Record<
  BridgeRoute,
  { method: 'get' | 'post'; path: string; params: boolean }
> = {
  assets: { method: 'get', path: '/assets', params: false },
  quotes: { method: 'post', path: '/quotes', params: false },
  confirm: { method: 'post', path: '/payments', params: false },
  verification: {
    method: 'post',
    path: '/payments/:paymentId/verification',
    params: true,
  },
  fundingClaim: {
    method: 'post',
    path: '/payments/:paymentId/funding-claim',
    params: true,
  },
  payment: { method: 'get', path: '/payments/:paymentId', params: true },
  payments: { method: 'get', path: '/payments', params: false },
};

const DIRECTIONS = ['deposit', 'withdraw'];
const PAYMENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ASSET = /^[a-z0-9-]+:[A-Za-z0-9]{1,100}$/;
const AMOUNT = /^(0|[1-9]\d*)(\.\d{1,36})?$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const REASONS = ['EVM_OWNER', 'EVM_WITHDRAWAL'];
const SIGNATURE_TYPES = ['EIP712', 'EIP191'];
const PAYMENT_ID_MESSAGE =
  'paymentId must be 1 to 128 letters, digits, underscores or hyphens';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The `{ code }` failures of the bridge use cases, in the shape the filter writes them. */
const failure = (
  path: string,
  status: number,
  error: string,
  message: string,
): Response => exceptionResponse(path, status, { error, message });

/** Installs the seven routes on `server`. */
export function installBridge(
  server: SetupServer,
  o: BridgeBackendOptions = {},
): BridgeBackend {
  const base = `${o.backendUrl ?? env.backendUrl}/api/bridge/halliday`;
  const withdrawToken =
    o.usdc === undefined ? XO_USDC_TOKEN : `xo:${o.usdc.toLowerCase()}`;
  const backend: BridgeBackend = {
    requests: [],
    payments: new Map(),
    fixtures: {
      assets: {
        deposit: [
          assetFixture(),
          assetFixture({
            asset: ETH_USDT,
            chain: 'ethereum',
            chainId: '1',
            symbol: 'USDT',
            name: 'Tether USD',
            address: '0xdac17f958d2ee523a2206206994597c13d831ec7',
          }),
        ],
        withdraw: [assetFixture()],
      },
      confirmedStatus: 'AWAITING_FUNDS',
      limits: { min: '1', max: '100000' },
      quoteOptions: 2,
      validKeys: new Set([API_KEY]),
      ...o.fixtures,
    },
    override(route, resolver) {
      server.use(handler(route, resolver));
    },
  };
  let counter = 0;

  const unauthorized = (path: string): Response =>
    exceptionResponse(path, 401, {
      error: 'invalid_credentials',
      message: 'Invalid credentials',
    });
  const missing = (path: string): Response =>
    failure(path, 404, 'payment_not_found', 'Payment not found');

  /** The fake's default answer of each route. */
  const defaults: Record<BridgeRoute, BridgeResolver> = {
    assets({ request }) {
      const { direction } = request.query;
      if (direction === undefined || !DIRECTIONS.includes(direction)) {
        return validationError(
          'direction must be one of the following values: deposit, withdraw',
        );
      }
      return HttpResponse.json({
        data: backend.fixtures.assets[direction as 'deposit' | 'withdraw'],
      });
    },

    quotes({ request }) {
      const { body } = request;
      if (!isRecord(body)) {
        return validationError('direction must be one of the following values');
      }
      const { direction, asset, amount, recipient } = body;
      if (typeof direction !== 'string' || !DIRECTIONS.includes(direction)) {
        return validationError(
          'direction must be one of the following values: deposit, withdraw',
        );
      }
      if (typeof asset !== 'string' || !ASSET.test(asset)) {
        return validationError('asset must look like `network:address`');
      }
      if (typeof amount !== 'string' || !AMOUNT.test(amount)) {
        return validationError(
          'amount must be a plain decimal number, with at most 36 fraction digits',
        );
      }
      if (recipient !== undefined && typeof recipient !== 'string') {
        return validationError('recipient must be a string');
      }
      const listed =
        backend.fixtures.assets[direction as 'deposit' | 'withdraw'];
      if (!listed.some((entry) => entry.asset === asset)) {
        return failure(
          request.path,
          400,
          'asset_not_supported',
          'The asset is not supported',
        );
      }
      const { min, max } = backend.fixtures.limits;
      if (
        Number(amount) <= 0 ||
        (min !== null && Number(amount) < Number(min)) ||
        (max !== null && Number(amount) > Number(max))
      ) {
        return failure(
          request.path,
          400,
          'amount_out_of_range',
          `The amount must be between ${min ?? 'none'} and ${max ?? 'none'}`,
        );
      }
      if (direction === 'withdraw' && recipient === undefined) {
        return failure(
          request.path,
          400,
          'recipient_invalid',
          'A withdrawal needs a recipient',
        );
      }
      const quotes = Array.from(
        { length: backend.fixtures.quoteOptions },
        (_, i) => {
          counter += 1;
          const paymentId = `pay_q${counter}`;
          const input =
            direction === 'deposit'
              ? { asset, amount }
              : { asset: XO_USDC_ASSET, amount };
          const output =
            direction === 'deposit'
              ? { asset: XO_USDC_ASSET, amount }
              : { asset, amount };
          const fees = {
            total: '0',
            conversion: '0',
            network: '0',
            business: '0',
            currency: 'USD',
          };
          backend.payments.set(
            paymentId,
            paymentFixture({
              paymentId,
              direction,
              status: 'QUOTED',
              hallidayStatus: null,
              input,
              output,
              fees,
              ownerAddress: null,
              destinationAddress:
                direction === 'deposit' ? OWNER : (recipient ?? OWNER),
              recipient: direction === 'withdraw' ? (recipient ?? null) : null,
              fundBy: null,
              deposit: null,
            }),
          );
          return {
            paymentId,
            input,
            output,
            fees,
            latencySeconds: 30 + i * 30,
          };
        },
      );
      return HttpResponse.json({
        data: {
          quotes,
          acceptBy: ACCEPT_BY,
          limits: [{ ...backend.fixtures.limits }],
        },
      });
    },

    confirm({ request }) {
      const { body } = request;
      if (
        !isRecord(body) ||
        typeof body.paymentId !== 'string' ||
        !PAYMENT_ID.test(body.paymentId)
      ) {
        return validationError(PAYMENT_ID_MESSAGE);
      }
      const row = backend.payments.get(body.paymentId);
      if (row === undefined) {
        return missing(request.path);
      }
      // A repeat answers with the stored payment.
      if (row.status !== 'QUOTED') {
        return HttpResponse.json(row);
      }
      const confirmed = {
        ...row,
        status: backend.fixtures.confirmedStatus,
        hallidayStatus: 'PENDING',
        ownerAddress: OWNER,
        fundBy: FUND_BY,
        // The token is an asset id either way. A deposit is paid in its input asset, on that
        // asset's network; a withdrawal is funded on XO's own chain, in XO USDC.
        deposit: {
          address: DEPOSIT_ADDRESS,
          amount: (row.input as { amount: string }).amount,
          token:
            row.direction === 'withdraw'
              ? withdrawToken
              : (row.input as { asset: string }).asset,
          chain:
            row.direction === 'withdraw'
              ? 'xo'
              : ((row.input as { asset: string }).asset.split(':')[0] ?? ''),
        },
        updatedAt: CREATED_AT,
      };
      backend.payments.set(body.paymentId, confirmed);
      return HttpResponse.json(confirmed);
    },

    verification({ request, params }) {
      const { paymentId } = params;
      if (paymentId === undefined || !PAYMENT_ID.test(paymentId)) {
        return validationError(PAYMENT_ID_MESSAGE);
      }
      const signatures = isRecord(request.body)
        ? request.body.signatures
        : undefined;
      if (
        !Array.isArray(signatures) ||
        signatures.length < 1 ||
        signatures.length > 4 ||
        !signatures.every(
          (item) =>
            isRecord(item) &&
            REASONS.includes(item.reason as string) &&
            SIGNATURE_TYPES.includes(item.signatureType as string) &&
            typeof item.signature === 'string' &&
            SIGNATURE.test(item.signature),
        )
      ) {
        return validationError(
          'signatures must hold 1 to 4 items of reason, signatureType and a 65-byte signature',
        );
      }
      const row = backend.payments.get(paymentId);
      if (row === undefined) {
        return missing(request.path);
      }
      if (row.status !== 'NEEDS_VERIFICATION') {
        return failure(
          request.path,
          409,
          'payment_not_awaiting_verification',
          'The payment is not awaiting verification',
        );
      }
      const verified = {
        ...row,
        status: 'PROCESSING',
        verification: null,
      };
      backend.payments.set(paymentId, verified);
      return HttpResponse.json(verified);
    },

    fundingClaim({ request, params }) {
      const { paymentId } = params;
      if (paymentId === undefined || !PAYMENT_ID.test(paymentId)) {
        return validationError(PAYMENT_ID_MESSAGE);
      }
      const row = backend.payments.get(paymentId);
      if (row === undefined) {
        return missing(request.path);
      }
      // The backend's order: the direction, then whether the
      // payment can still be funded (status, deposit, deadline), and only then the atomic
      // claim, which is what says "already claimed".
      if (row.direction !== 'withdraw') {
        return failure(
          request.path,
          400,
          'not_a_withdrawal',
          'Only a withdrawal is funded by its owner',
        );
      }
      const notAwaiting = failure(
        request.path,
        409,
        'payment_not_awaiting_funds',
        'The payment is not awaiting funds',
      );
      if (row.status !== 'AWAITING_FUNDS' || !row.deposit) {
        return notAwaiting;
      }
      if (
        typeof row.fundBy === 'string' &&
        Date.parse(row.fundBy) - Date.now() < FUND_BY_GUARD_MS
      ) {
        return notAwaiting;
      }
      if (row.fundingClaimedAt !== null) {
        return failure(
          request.path,
          409,
          'funding_already_claimed',
          'The funding of this payment was already claimed',
        );
      }
      const claimed = { ...row, fundingClaimedAt: new Date().toISOString() };
      backend.payments.set(paymentId, claimed);
      return HttpResponse.json(claimed);
    },

    payment({ request, params }) {
      const { paymentId } = params;
      if (paymentId === undefined || !PAYMENT_ID.test(paymentId)) {
        return validationError(PAYMENT_ID_MESSAGE);
      }
      const row = backend.payments.get(paymentId);
      return row === undefined ? missing(request.path) : HttpResponse.json(row);
    },

    payments({ request }) {
      const { direction, status, cursor, limit } = request.query;
      if (direction !== undefined && !DIRECTIONS.includes(direction)) {
        return validationError(
          'direction must be one of the following values: deposit, withdraw',
        );
      }
      if (status === 'QUOTED') {
        return validationError('status must be one of the listable statuses');
      }
      const take = limit === undefined ? 20 : Number(limit);
      if (!Number.isInteger(take) || take < 1 || take > 100) {
        return validationError('limit must be an integer from 1 to 100');
      }
      // The cursor is the offset into the newest-first list, as a decimal string.
      const from = cursor === undefined || cursor === '' ? 0 : Number(cursor);
      if (!Number.isInteger(from) || from < 0) {
        return failure(
          request.path,
          400,
          'cursor_invalid',
          'The cursor is not valid',
        );
      }
      const rows = [...backend.payments.values()]
        .filter((row) => row.status !== 'QUOTED')
        .filter((row) => direction === undefined || row.direction === direction)
        .filter((row) => status === undefined || row.status === status)
        .reverse();
      const page = rows.slice(from, from + take);
      return HttpResponse.json({
        data: page,
        nextCursor: from + take < rows.length ? String(from + take) : null,
      });
    },
  };

  /** The msw handler of `route`: record the request, check the key, then `resolver`. */
  function handler(route: BridgeRoute, resolver: BridgeResolver) {
    const { method, path } = ROUTES[route];
    return http[method](`${base}${path}`, async ({ request, params }) => {
      const parsed = new URL(request.url);
      const text = method === 'post' ? await request.clone().text() : '';
      const recorded: BridgeRequest = {
        method: request.method,
        path: parsed.pathname,
        query: Object.fromEntries(parsed.searchParams),
        body: text === '' ? undefined : JSON.parse(text),
        authorization: request.headers.get('authorization'),
        sdk: request.headers.get('x-xo-sdk'),
      };
      backend.requests.push(recorded);
      const key = /^Bearer (.+)$/.exec(recorded.authorization ?? '')?.[1];
      if (key === undefined || !backend.fixtures.validKeys.has(key)) {
        return unauthorized(recorded.path);
      }
      return resolver({
        request: recorded,
        params: { paymentId: params.paymentId as string | undefined },
      });
    });
  }

  server.use(
    ...(Object.keys(ROUTES) as BridgeRoute[]).map((route) =>
      handler(route, defaults[route]),
    ),
  );
  return backend;
}

/** Asserts no request reached the fake. */
export function expectNoRequest(backend: BridgeBackend): void {
  expect(backend.requests).toEqual([]);
}

/** A rail that records each batch it is given and answers `answer` (or throws it). */
export interface RecordingRail extends TxRail {
  /** Every batch of calls, in order. */
  sent: Call[][];
  /** What `send` resolves, or throws. Change it to make a transfer revert or fail. */
  answer: TxResult | Error;
}

/** The chain stub, with the USDC balance of every holder in one field. */
export type BridgeChain = RailChainStub & { balanceMicro: bigint };

export interface BridgeRigOptions {
  /** Defaults to `testEnvWithBridge`. */
  env?: EnvironmentConfig;
  /**
   * `true` (the default) gives the session a backend key (`API_KEY`) the fake accepts; `'none'`,
   * and `false` too, gives it neither a signer nor a key. The session never holds the signer:
   * it is the BridgeClient's own, for the calls that sign.
   */
  session?: boolean | 'none';
  /** The owner's signer, passed to the BridgeClient. None by default. */
  signer?: InternalSigner;
  /** The USDC the trading wallet holds, in micro-USDC. Defaults to 1000 USDC. */
  balanceMicro?: bigint;
  /** Reject response fields the schemas do not know. */
  strict?: boolean;
  /** Retries per read after the first attempt. Defaults to 0, so a test sees every attempt. */
  maxRetries?: number;
}

/**
 * A BridgeClient on a transport with `maxRetries: 0` (unless `maxRetries` says otherwise), a session, a recording rail, a chain
 * stub that answers `USDC.balanceOf` with `balanceMicro` and a real AccountClient over them,
 * as the secure client composes them (the trading wallet is the EOA of `OWNER`).
 */
export function bridgeRig(server: SetupServer, o: BridgeRigOptions = {}) {
  const rigEnv = o.env ?? testEnvWithBridge;
  const backend = installBridge(server);
  const transport = new Transport({
    env: rigEnv,
    version: '9.9.9',
    maxRetries: o.maxRetries ?? 0,
  });
  const session = new Session({
    env: rigEnv,
    transport,
    clock: new Clock({
      fetchServerTimeSec: async () => Math.floor(Date.now() / 1000),
    }),
    ...(o.session === 'none' || o.session === false
      ? {}
      : { credentials: { backend: { apiKey: API_KEY } } }),
    readContract: async () => '0x',
    warn: () => {},
  });
  transport.setAuth(session);

  const chain = Object.assign(railChain(), {
    balanceMicro: o.balanceMicro ?? 1_000_000_000n,
  }) as BridgeChain;
  chain.read = ({ to, data }) => {
    if (to.toLowerCase() === rigEnv.contracts.usdc.toLowerCase()) {
      const call = decodeFunctionData({ abi: ERC20_ABI, data });
      if (call.functionName === 'balanceOf') {
        return encodeFunctionResult({
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          result: chain.balanceMicro,
        });
      }
    }
    return new Error('execution reverted');
  };

  const rail: RecordingRail = {
    sent: [],
    answer: { txHash: TX_HASH, status: 'success', blockNumber: 1n },
    async send(calls) {
      rail.sent.push(calls);
      if (rail.answer instanceof Error) {
        throw rail.answer;
      }
      return rail.answer;
    },
  };

  const identity = async () => eoaIdentity();
  const account = new AccountClient({
    env: rigEnv,
    identity,
    chain: chain.reader,
    // The orderbook reads are merge's and redeemAll's: a bridge call never makes them.
    orderbook: {
      getPositions: () => Promise.reject(new Error('unused')),
      getMarketCapacity: () => Promise.reject(new Error('unused')),
      getClaimable: () => Promise.reject(new Error('unused')),
    },
    rail,
  });
  const bridge = new BridgeClient({
    env: rigEnv,
    transport,
    session,
    identity,
    ...(o.signer === undefined ? {} : { signer: o.signer }),
    chain: chain.reader,
    account,
    ...(o.strict === undefined ? {} : { strictResponses: o.strict }),
  });
  return {
    bridge,
    backend,
    rail,
    chain,
    env: rigEnv,
    transport,
    session,
    account,
  };
}
