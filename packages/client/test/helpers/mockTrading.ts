import { HttpResponse, http } from 'msw';
import type { SetupServer } from 'msw/node';
import {
  type Address,
  getAddress,
  type Hex,
  hashTypedData,
  recoverAddress,
  size,
  slice,
} from 'viem';
import {
  CONDITION_A,
  CONDITION_B,
  TOKEN_NO,
  TOKEN_YES,
} from './mockMarketData';
import {
  gatewayError,
  kernelWrap,
  type Orderbook,
  type OrderbookRequest,
  recovers,
  verifyL2,
} from './mockOrderbook';
import { testEnv } from './testEnv';

// A fake of the orderbook gateway's trading and own-data routes, for the msw tests of the
// OrderbookClient. It is written from the gateway's behaviour, not from the SDK, so a test that
// trades against it checks the SDK's requests against an independent version. The L2 (HMAC) check
// and the deployed Kernel accounts come from the auth fake (mockOrderbook.ts): install that
// first and pass its state here.
//
// - POST   /order               the place-order body (camelCase, no unknown field) -> the placement
//   answer. The EIP-712 order signature is checked first (401), then the optional HMAC (401 when
//   the headers are present but wrong). 503 trading_paused (+ Retry-After: 60) before anything.
// - POST   /orders              a JSON array of place-order bodies -> {results: [one entry per
//   order]} in input order; empty or > 300 entries is a 400; one bad signature is a 401 for the
//   batch.
// - DELETE /order               the cancel body {orderID|orderId, marketId?, signature?, ...}:
//   HMAC first, else the EIP-712 CancelOrder signature (numeric id + marketId), else 401.
// - DELETE /orders              a JSON array of ids (HMAC required) -> the cancel result; or the
//   signed form {orderIds: the numeric ids as JSON numbers, marketId, signature, signatureType?,
//   signer?} (no unknown field, at least one id): the EIP-712 CancelOrder(orderIds[0], marketId)
//   signature, then each id cancelled in `marketId`.
// - DELETE /cancel-all          empty body -> HMAC; a body that parses as a signed cancel-all (no
//   unknown field, `signature` required) -> the EIP-712 CancelAll(marketId ?? "") check; a body
//   that does not parse -> HMAC over that body. A `marketId` the engine does not know (including
//   "") is a 404 `market not found`.
// - DELETE /cancel-market-orders the market-cancel body {marketId|market, assetId?, signature?,
//   ...}: the signature (CancelAll(marketId)) when present, else HMAC. `assetId` is ignored, as
//   in the gateway: every order of the caller in the market is cancelled.
// - POST   /orders/batch-ops    {ops: [{type: "place"|"cancel", payload}]} (no unknown field),
//   HMAC required.
// - GET    /data/orders, /data/order/{id}, /data/trades, /trades/{id}, /balance-allowance,
//   /positions, /claimable, /data/market-capacity: the own-data reads, paginated with the
//   gateway's base64-offset cursor (end "LTE=").
// - POST   /v1/heartbeats and the legacy POST /heartbeats: the heartbeat answer. The HMAC is
//   checked over the literal path the request used and an EMPTY body, whatever was sent. A
//   valid HMAC records the owner's last-seen time and answers 200 `{status:"ok", tracked:true}`; a
//   missing or wrong HMAC ALSO answers 200, with `{status:"ok", tracked:false}` (a silent opt-out).
//   It never answers 401.
//
// Held orders (taker-delay window): `outcome` can hold a placement instead of resting it. As
// in the engine, a held order is found by hash (the lookup falls back to the held queue, and
// reports it LIVE), is cancelled by cancel-by-hash and by cancel-all, and is not listed by
// `/data/orders` (which reads the books only).
//
// Stricter than the gateway, on purpose (the SDK must never rely on what this rejects):
// - every own-data read rejects a query key the gateway does not read, and rejects `maker`,
//   `maker_address` and `address` (the legacy, unauthenticated identity fallbacks), except
//   `address` on /positions (where it is required), /claimable and /data/market-capacity;
// - /positions and /trades/{id} take no auth in the gateway; here L2 headers, when present,
//   must be valid.

const env = testEnv;
const BASE = env.orderbookUrl;

/** The gateway's default batch size for placements. */
export const MAX_BATCH_PLACE = 300;
/** The gateway's default batch sizes for cancels and for the sub-operations of a batch. */
const MAX_BATCH_CANCEL = 300;
const MAX_BATCH_OPS_TOTAL = 300;
/** The gateway's default page size. */
const DEFAULT_PAGE_LIMIT = 100;
const CURSOR_END = 'LTE=';
const U64_MAX = (1n << 64n) - 1n;
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export const NO_ORDERBOOK_ERROR =
  'No orderbook exists for the requested token id';
export const DUPLICATE_ORDER_ERROR =
  'invalid request: duplicate order: an order with the same signed-payload hash is already resting in this book';

const PLACE_KEYS = ['order', 'orderType', 'funder', 'owner', 'postOnly'];
const CANCEL_ALL_KEYS = ['marketId', 'signature', 'signatureType', 'signer'];
const BATCH_CANCEL_KEYS = [
  'orderIds',
  'marketId',
  'signature',
  'signatureType',
  'signer',
];

/** An order resting in the fake's books. */
export interface RestingOrder {
  hash: string;
  /** The legacy numeric `OrderId`. */
  numericId: number;
  /** The lower-case address that owns it (the HMAC user, else the maker). */
  owner: string;
  market: string;
  tokenId: string;
  outcome: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  tick: number;
  /** Canonical micro-shares. */
  size: bigint;
  orderType: string;
  expiration: string;
  createdAt: number;
}

/** What the fake answers for one accepted placement. */
export interface PlaceOutcome {
  /** Leave the order resting (default true). */
  rest?: boolean;
  /** Hold it in the taker-delay window instead of resting it (overrides `rest`). */
  hold?: boolean;
  success?: boolean;
  errorMsg?: string | null;
  status?: string;
  makingAmount?: string;
  takingAmount?: string;
  tradeIds?: string[];
  /**
   * Answer this instead, after the engine took the order (it rests when `rest` allows): a
   * proxy 504 or a garbled 200 for an order that was in fact placed.
   */
  respond?: Response;
}

export interface AccountFixture {
  cash: string;
  positions: Array<{ token_id: string; balance: string; reserved: string }>;
  /** Hex without 0x, as the gateway prints it. */
  smart_account?: string;
}

export interface ClaimableFixture {
  market_id: string;
  outcome: 'YES' | 'NO';
  token_id: string;
  balance: string;
  refund_reason: string;
}

export interface Trading {
  /** "METHOD /path" for every request that reached a handler. */
  calls: string[];
  requests: OrderbookRequest[];
  /** Resting orders, oldest first. */
  orders: RestingOrder[];
  /** Orders held in the taker-delay window (not resting yet), oldest first. */
  held: RestingOrder[];
  /** Trades by owner (lower-case address), oldest first; `trade` is the trade as the gateway sends it. */
  trades: Array<{ owner: string; trade: Record<string, unknown> }>;
  /** Accounts by lower-case address. */
  accounts: Map<string, AccountFixture>;
  /** Claimable positions by lower-case address. */
  claimable: Map<string, ClaimableFixture[]>;
  /** condition id (lower case) -> its YES and NO tokens. */
  markets: Map<string, { yes: string; no: string }>;
  paused: boolean;
  /**
   * The gateway's heartbeat tracker: owner (lower case) -> the fake clock (ms) of the last
   * heartbeat with a valid HMAC. Untracked callers are never added.
   */
  heartbeats: Map<string, number>;
  /**
   * While set, the heartbeat routes wait for it after recording the request and before
   * answering (a slow gateway). The request is already counted in `calls` and `requests`.
   */
  heartbeatGate?: Promise<unknown>;
  /** The page size of the paginated reads (the gateway's default is 100). */
  pageLimit: number;
  maxBatchPlace: number;
  /** Decides the answer of each accepted placement. Default: it rests, status `live`. */
  outcome?: (order: RestingOrder) => PlaceOutcome | Response;
  /** Answers instead of the handler (route as "METHOD /path"), after the request is recorded. */
  override?: (
    route: string,
    request: Request,
    body: string,
  ) => Response | undefined;
}

export interface TradingOptions {
  chainId?: number;
  now?: () => number;
  pageLimit?: number;
  maxBatchPlace?: number;
}

type Result<T> = { ok: true; value: T } | { ok: false; response: Response };
const fail = <T>(response: Response): Result<T> => ({ ok: false, response });
const unauthorized = (message: string) => gatewayError(401, message);
const invalid = (message: string) => gatewayError(400, message);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string): Result<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return fail(invalid('invalid request body: expected value'));
  }
}

/** A uint256 field as the gateway reads it: a decimal or 0x-hex string, or a JSON number. */
function u256(value: unknown, field: string): Result<bigint> {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return { ok: true, value: BigInt(value) };
  }
  if (
    typeof value === 'string' &&
    (/^[0-9]{1,78}$/.test(value) || /^0x[0-9a-fA-F]{1,64}$/.test(value))
  ) {
    return { ok: true, value: BigInt(value) };
  }
  return fail(invalid(`invalid request body: invalid ${field}`));
}

/** The address of a wire field: 20 bytes of hex (any case). */
function address(value: unknown, field: string): Result<Address> {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    return fail(invalid(`invalid request body: invalid ${field}`));
  }
  return { ok: true, value: getAddress(value.toLowerCase()) };
}

interface CtfOrder {
  salt: bigint;
  maker: Address;
  signer: Address;
  beneficiary: Address;
  tokenId: bigint;
  makerAmount: bigint;
  takerAmount: bigint;
  expiration: bigint;
  nonce: bigint;
  identifier: Hex;
  metadata: Hex;
  side: 0 | 1;
  signatureType: number;
  signature: Hex;
}

/** The signed order as the gateway reads it (camelCase; the order itself may carry unknown fields). */
function parseCtfOrder(value: unknown): Result<CtfOrder> {
  if (!isRecord(value)) {
    return fail(invalid('invalid request body: order must be an object'));
  }
  const out: Partial<CtfOrder> = {};
  for (const field of [
    'salt',
    'tokenId',
    'makerAmount',
    'takerAmount',
    'expiration',
    'nonce',
  ] as const) {
    const parsed = u256(value[field], field);
    if (!parsed.ok) {
      return parsed;
    }
    out[field] = parsed.value;
  }
  if ((out.nonce ?? 0n) >= 1n << 128n) {
    return fail(invalid('invalid request body: nonce exceeds uint128'));
  }
  for (const field of ['maker', 'signer'] as const) {
    const parsed = address(value[field], field);
    if (!parsed.ok) {
      return parsed;
    }
    out[field] = parsed.value;
  }
  const beneficiary =
    value.beneficiary === undefined
      ? { ok: true as const, value: getAddress(`0x${'00'.repeat(20)}`) }
      : address(value.beneficiary, 'beneficiary');
  if (!beneficiary.ok) {
    return beneficiary;
  }
  out.beneficiary = beneficiary.value;
  const hexField = (name: 'identifier' | 'metadata', bytes: number) => {
    const raw = value[name] ?? `0x${'00'.repeat(bytes)}`;
    return typeof raw === 'string' &&
      new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(raw)
      ? (raw.toLowerCase() as Hex)
      : undefined;
  };
  const identifier = hexField('identifier', 16);
  const metadata = hexField('metadata', 32);
  if (identifier === undefined || metadata === undefined) {
    return fail(
      invalid('invalid request body: invalid identifier or metadata'),
    );
  }
  out.identifier = identifier;
  out.metadata = metadata;
  const side = value.side;
  if (side === 'BUY' || side === 0) {
    out.side = 0;
  } else if (side === 'SELL' || side === 1) {
    out.side = 1;
  } else {
    return fail(invalid('invalid request body: invalid side'));
  }
  if (
    typeof value.signatureType !== 'number' ||
    !Number.isInteger(value.signatureType)
  ) {
    return fail(invalid('invalid request body: invalid signatureType'));
  }
  out.signatureType = value.signatureType;
  if (
    typeof value.signature !== 'string' ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(value.signature)
  ) {
    return fail(invalid('invalid request body: invalid signature'));
  }
  out.signature = value.signature as Hex;
  return { ok: true, value: out as CtfOrder };
}

interface PlaceRequest {
  order: CtfOrder;
  orderType: string;
  postOnly: boolean;
  funder?: string;
}

/** The place-order body: camelCase, no unknown field, `orderType` defaults to GTC. */
function parsePlaceRequest(value: unknown): Result<PlaceRequest> {
  if (!isRecord(value)) {
    return fail(invalid('invalid request body: expected an object'));
  }
  for (const key of Object.keys(value)) {
    if (!PLACE_KEYS.includes(key)) {
      return fail(invalid(`invalid request body: unknown field \`${key}\``));
    }
  }
  if (value.order === undefined) {
    return fail(invalid('invalid request body: missing field `order`'));
  }
  const order = parseCtfOrder(value.order);
  if (!order.ok) {
    return order;
  }
  const orderType = value.orderType ?? 'GTC';
  if (typeof orderType !== 'string') {
    return fail(invalid('invalid request body: orderType must be a string'));
  }
  if (value.postOnly !== undefined && typeof value.postOnly !== 'boolean') {
    return fail(invalid('invalid request body: postOnly must be a boolean'));
  }
  if (value.funder !== undefined && typeof value.funder !== 'string') {
    return fail(invalid('invalid request body: funder must be a string'));
  }
  return {
    ok: true,
    value: {
      order: order.value,
      orderType,
      postOnly: value.postOnly === true,
      ...(value.funder === undefined ? {} : { funder: value.funder as string }),
    },
  };
}

function exchangeDomain(chainId: number) {
  return {
    name: 'XO Market CLOB',
    version: '1',
    chainId,
    verifyingContract: env.contracts.ctfExchange,
  } as const;
}

/** The order's EIP-712 digest, written out from the Solidity struct. */
function orderDigest(order: CtfOrder, chainId: number): Hex {
  return hashTypedData({
    domain: exchangeDomain(chainId),
    types: {
      Order: [
        { name: 'salt', type: 'uint256' },
        { name: 'maker', type: 'address' },
        { name: 'signer', type: 'address' },
        { name: 'beneficiary', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
        { name: 'makerAmount', type: 'uint256' },
        { name: 'takerAmount', type: 'uint256' },
        { name: 'expiration', type: 'uint256' },
        { name: 'nonce', type: 'uint128' },
        { name: 'identifier', type: 'bytes16' },
        { name: 'metadata', type: 'bytes32' },
        { name: 'side', type: 'uint8' },
        { name: 'signatureType', type: 'uint8' },
      ],
    },
    primaryType: 'Order',
    message: {
      salt: order.salt,
      maker: order.maker,
      signer: order.signer,
      beneficiary: order.beneficiary,
      tokenId: order.tokenId,
      makerAmount: order.makerAmount,
      takerAmount: order.takerAmount,
      expiration: order.expiration,
      nonce: order.nonce,
      identifier: order.identifier,
      metadata: order.metadata,
      side: order.side,
      signatureType: order.signatureType,
    },
  });
}

/** `CancelOrder(uint64 orderId,string marketId)` or `CancelAll(string marketId)` under the exchange domain. */
function cancelDigest(
  chainId: number,
  marketId: string,
  orderId?: bigint,
): Hex {
  if (orderId === undefined) {
    return hashTypedData({
      domain: exchangeDomain(chainId),
      types: { CancelAll: [{ name: 'marketId', type: 'string' }] },
      primaryType: 'CancelAll',
      message: { marketId },
    });
  }
  return hashTypedData({
    domain: exchangeDomain(chainId),
    types: {
      CancelOrder: [
        { name: 'orderId', type: 'uint64' },
        { name: 'marketId', type: 'string' },
      ],
    },
    primaryType: 'CancelOrder',
    message: { orderId, marketId },
  });
}

/** `isValidSignature` of a deployed Kernel account: `0x00 || owner signature over the Kernel wrap`. */
async function kernelAccepts(
  orderbook: Orderbook,
  account: Address,
  digest: Hex,
  signature: Hex,
  chainId: number,
): Promise<boolean> {
  const owner = orderbook.smartAccounts.get(account.toLowerCase());
  if (owner === undefined) {
    return false;
  }
  return (
    size(signature) === 66 &&
    slice(signature, 0, 1) === '0x00' &&
    recovers(kernelWrap(digest, account, chainId), slice(signature, 1), owner)
  );
}

/** The gateway's order signature check: ECDSA on `signer` for type 0, EIP-1271 on `maker` for 1 and 3. */
async function verifyOrderSignature(
  orderbook: Orderbook,
  order: CtfOrder,
  chainId: number,
): Promise<string | undefined> {
  const digest = orderDigest(order, chainId);
  if (order.signatureType === 0) {
    if (size(order.signature) !== 65) {
      return `invalid signature length: ${size(order.signature)} (expected 65)`;
    }
    return (await recovers(digest, order.signature, order.signer))
      ? undefined
      : 'signature mismatch';
  }
  if (order.signatureType === 1 || order.signatureType === 3) {
    return (await kernelAccepts(
      orderbook,
      order.maker,
      digest,
      order.signature,
      chainId,
    ))
      ? undefined
      : 'EIP-1271: isValidSignature rejected the signature';
  }
  return `unsupported signature type: ${order.signatureType}`;
}

/**
 * The gateway's cancel and cancel-all signature checks: type 0 recovers the
 * signer from a 65-byte signature (the recovered address IS the user); 1, 2 and 3 need
 * `signer` and ask that account. Returns the lower-case user, or the 401.
 */
async function verifyCancelSignature(
  orderbook: Orderbook,
  digest: Hex,
  signature: unknown,
  signatureType: unknown,
  signer: unknown,
  chainId: number,
): Promise<string | Response> {
  if (
    typeof signature !== 'string' ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(signature)
  ) {
    return invalid('invalid signature hex');
  }
  const type = signatureType ?? 0;
  if (type === 0) {
    if (size(signature as Hex) !== 65) {
      return unauthorized('invalid cancel signature length (expected 65)');
    }
    try {
      const recovered = await recoverAddress({
        hash: digest,
        signature: signature as Hex,
      });
      return recovered.toLowerCase();
    } catch {
      return unauthorized('cancel ecrecover failed');
    }
  }
  if (type === 1 || type === 2 || type === 3) {
    if (typeof signer !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(signer)) {
      return unauthorized(
        `signature type ${type} cancel requires \`signer\` field`,
      );
    }
    const account = getAddress(signer.toLowerCase());
    return (await kernelAccepts(
      orderbook,
      account,
      digest,
      signature as Hex,
      chainId,
    ))
      ? account.toLowerCase()
      : unauthorized('EIP-1271: isValidSignature rejected the signature');
  }
  return unauthorized(`unsupported cancel signature type: ${String(type)}`);
}

/** A tick as the gateway prints a price: padded, such as `"0.570"`. */
function tickToDecimal(tick: number): string {
  return `${Math.floor(tick / 1000)}.${String(tick % 1000).padStart(3, '0')}`;
}

/** Micro-shares as the gateway prints a size: whole shares, trailing zeros trimmed. */
export function microToDecimal(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = micro % 1_000_000n;
  if (frac === 0n) {
    return whole.toString();
  }
  return `${whole}.${frac.toString().padStart(6, '0')}`.replace(/0+$/, '');
}

function encodeCursor(offset: number, total: number): string {
  return offset >= total ? CURSOR_END : btoa(String(offset));
}

function decodeCursor(cursor: string | null): number {
  if (
    cursor === null ||
    cursor === '' ||
    cursor === CURSOR_END ||
    cursor === 'END'
  ) {
    return 0;
  }
  try {
    const n = Number.parseInt(atob(cursor), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * The keys a read takes, plus this fake's stricter rule: keys outside `allowed` are a 400, and so
 * are the legacy identity keys unless listed. `required` keys must be there.
 */
function readQuery(
  request: Request,
  allowed: readonly string[],
  required: readonly string[] = [],
): Result<URLSearchParams> {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (!allowed.includes(key)) {
      return fail(
        invalid(`Failed to deserialize query string: unknown field \`${key}\``),
      );
    }
  }
  for (const key of required) {
    if (!params.has(key)) {
      return fail(
        invalid(`Failed to deserialize query string: missing field \`${key}\``),
      );
    }
  }
  return { ok: true, value: params };
}

/**
 * Installs the handlers on `server` and returns the live state of the fake gateway. Call it
 * after `installOrderbook`, whose L2 keys and Kernel accounts it uses: msw tries the latest
 * handlers first, so this fake's `/data/orders` replaces the auth fake's stand-in. Pair it
 * with `installMarketData` for `/tick-size`.
 */
export function installTrading(
  server: SetupServer,
  orderbook: Orderbook,
  options: TradingOptions = {},
): Trading {
  const chainId = options.chainId ?? env.chainId;
  const now = options.now ?? (() => Date.now());
  const trading: Trading = {
    calls: [],
    requests: [],
    orders: [],
    held: [],
    trades: [],
    accounts: new Map(),
    claimable: new Map(),
    markets: new Map([
      [CONDITION_A, { yes: TOKEN_YES, no: TOKEN_NO }],
      [CONDITION_B, { yes: '111', no: '222' }],
    ]),
    paused: false,
    heartbeats: new Map(),
    pageLimit: options.pageLimit ?? DEFAULT_PAGE_LIMIT,
    maxBatchPlace: options.maxBatchPlace ?? MAX_BATCH_PLACE,
  };
  let nextNumericId = 1;

  async function record(request: Request, path: string): Promise<string> {
    const url = new URL(request.url);
    const body = await request.text();
    trading.calls.push(`${request.method} ${path}`);
    trading.requests.push({
      method: request.method,
      path,
      search: url.search,
      body,
      headers: request.headers,
    });
    return body;
  }

  /** The token's market, or undefined. */
  function bookOf(tokenId: bigint) {
    const token = tokenId.toString();
    for (const [market, tokens] of trading.markets) {
      if (tokens.yes === token) {
        return { market, outcome: 'YES' as const };
      }
      if (tokens.no === token) {
        return { market, outcome: 'NO' as const };
      }
    }
    return undefined;
  }

  /** The optional HMAC check: undefined without headers, the owner, or the 401. */
  function tryHmac(
    request: Request,
    path: string,
    body: string,
  ): string | Response | undefined {
    if (request.headers.get('XO_API_KEY') === null) {
      return undefined;
    }
    return verifyL2(orderbook, request, path, body, now);
  }

  /** The gateway's check of an own-data read, without the legacy fallbacks (this fake rejects them). */
  function requireHmac(request: Request, path: string): string | Response {
    return (
      tryHmac(request, path, '') ?? unauthorized('HMAC L2 credentials required')
    );
  }

  const pausedResponse = () =>
    HttpResponse.json(
      {
        error: 'trading_paused',
        message: 'Global trading is paused. New orders are not being accepted.',
      },
      { status: 503, headers: { 'Retry-After': '60' } },
    );

  /**
   * Everything the gateway's placement checks after the signature and auth: the book, the amounts,
   * the order type, post-only and duplicates. Returns the resting order, or the error message
   * and its status.
   */
  function admit(
    request: PlaceRequest,
    owner: string,
  ): RestingOrder | { status: number; error: string } {
    const { order } = request;
    const book = bookOf(order.tokenId);
    if (book === undefined) {
      return { status: 404, error: NO_ORDERBOOK_ERROR };
    }
    const collateral = order.side === 0 ? order.makerAmount : order.takerAmount;
    const shares = order.side === 0 ? order.takerAmount : order.makerAmount;
    if (shares === 0n || collateral === 0n) {
      return { status: 400, error: 'invalid request: invalid size' };
    }
    const tick =
      order.side === 0
        ? (collateral * 1000n) / shares
        : (collateral * 1000n + shares - 1n) / shares;
    if (tick < 1n || tick > 999n) {
      return { status: 400, error: 'order amount: price tick out of range' };
    }
    if (shares < 1_000_000n) {
      return {
        status: 422,
        error: `size below minimum: min 1000000, got ${shares}`,
      };
    }
    const type = request.orderType.toUpperCase();
    if (!['GTC', 'GTD', 'FOK', 'FAK'].includes(type)) {
      return {
        status: 400,
        error: `unsupported orderType: ${request.orderType} (supported: GTC, GTD, FOK, FAK)`,
      };
    }
    if (type === 'GTD') {
      const nowSec = BigInt(Math.floor(now() / 1000));
      if (order.expiration === 0n || order.expiration < nowSec + 1n) {
        return {
          status: 400,
          error: 'GTD expiration is in the past or too soon',
        };
      }
    }
    if (request.postOnly && type !== 'GTC' && type !== 'GTD') {
      return {
        status: 400,
        error: 'postOnly orders must use orderType GTC or GTD',
      };
    }
    const hash = orderDigest(order, chainId);
    if ([...trading.orders, ...trading.held].some((o) => o.hash === hash)) {
      return { status: 400, error: DUPLICATE_ORDER_ERROR };
    }
    return {
      hash,
      numericId: nextNumericId++,
      owner,
      market: book.market,
      tokenId: order.tokenId.toString(),
      outcome: book.outcome,
      side: order.side === 0 ? 'BUY' : 'SELL',
      tick: Number(tick),
      size: shares,
      orderType: type,
      expiration: order.expiration.toString(),
      createdAt: Math.floor(now() / 1000),
    };
  }

  /** The owner: the funder, else the HMAC user, else the maker (`funder > HMAC > maker`). */
  function ownerOf(
    request: PlaceRequest,
    hmacUser: string | undefined,
  ): string {
    return (
      request.funder?.toLowerCase() ??
      hmacUser ??
      request.order.maker.toLowerCase()
    );
  }

  /** Places one admitted order and builds the PlaceOrderResponse fields. */
  function place(resting: RestingOrder): Response | Record<string, unknown> {
    const chosen = trading.outcome?.(resting) ?? {};
    if (chosen instanceof Response) {
      return chosen;
    }
    if (chosen.hold === true) {
      trading.held.push(resting);
    } else if (chosen.rest ?? true) {
      trading.orders.push(resting);
    }
    if (chosen.respond !== undefined) {
      return chosen.respond;
    }
    return {
      success: chosen.success ?? true,
      errorMsg: chosen.errorMsg ?? null,
      makingAmount: chosen.makingAmount ?? '0',
      takingAmount: chosen.takingAmount ?? '0',
      orderID: resting.hash,
      status: chosen.status ?? ((chosen.rest ?? true) ? 'live' : 'delayed'),
      transactionsHashes: [],
      tradeIds: chosen.tradeIds ?? [],
    };
  }

  function openOrder(o: RestingOrder) {
    return {
      id: o.hash,
      market: o.market,
      outcome: o.outcome,
      side: o.side,
      price: tickToDecimal(o.tick),
      original_size: microToDecimal(o.size),
      size_matched: '0',
      status: 'LIVE',
      created_at: o.createdAt,
      order_hash: o.hash,
      asset_id: o.tokenId,
      maker_address: o.owner,
      owner: '6f1e7a5c-0000-5000-8000-000000000000',
      expiration: o.expiration,
      order_type: o.orderType,
    };
  }

  function page<T>(items: T[], cursor: string | null) {
    const offset = decodeCursor(cursor);
    const data = items.slice(offset, offset + trading.pageLimit);
    return {
      limit: trading.pageLimit,
      count: items.length,
      next_cursor: encodeCursor(offset + data.length, items.length),
      data,
    };
  }

  /** The cancel target, read and looked up in the engine: the order, or the reason it is not there. */
  function findTarget(
    value: unknown,
  ):
    | { key: string; order?: RestingOrder }
    | { key: string; error: string; status: number } {
    const key =
      typeof value === 'string'
        ? value
        : typeof value === 'number'
          ? String(value)
          : JSON.stringify(value);
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || value < 0) {
        return {
          key,
          status: 400,
          error: 'order_id must be a positive integer',
        };
      }
      return { key, order: trading.orders.find((o) => o.numericId === value) };
    }
    if (typeof value === 'string') {
      if (HASH_PATTERN.test(value) || /^0X[0-9a-fA-F]{64}$/.test(value)) {
        const hash = `0x${value.slice(2).toLowerCase()}`;
        return {
          key,
          order:
            trading.orders.find((o) => o.hash === hash) ??
            trading.held.find((o) => o.hash === hash),
        };
      }
      if (/^[0-9]+$/.test(value) && BigInt(value) <= U64_MAX) {
        return {
          key,
          order: trading.orders.find((o) => o.numericId === Number(value)),
        };
      }
      return {
        key,
        status: 400,
        error:
          'order_id must be a numeric string or 0x-prefixed 32-byte hex hash',
      };
    }
    return { key, status: 400, error: 'order_id must be a string or integer' };
  }

  function remove(order: RestingOrder): void {
    trading.orders = trading.orders.filter((o) => o !== order);
    trading.held = trading.held.filter((o) => o !== order);
  }

  /** Cancels every resting order of `user`, optionally in one market. */
  function cancelAllOf(
    user: string,
    market: string | undefined,
  ): Response | string[] {
    if (market !== undefined && !trading.markets.has(market)) {
      return gatewayError(404, `market not found: ${market}`);
    }
    const mine = [...trading.orders, ...trading.held].filter(
      (o) => o.owner === user && (market === undefined || o.market === market),
    );
    trading.orders = trading.orders.filter((o) => !mine.includes(o));
    trading.held = trading.held.filter((o) => !mine.includes(o));
    return mine.map((o) => o.hash);
  }

  const overridden = (route: string, request: Request, body: string) =>
    trading.override?.(route, request, body);

  /**
   * The heartbeat answer: the HMAC is verified over the literal `path` and an empty body (the
   * gateway signs an empty body whatever was sent), and every failure is a 200 with
   * `tracked: false`.
   */
  async function heartbeat(request: Request, path: string): Promise<Response> {
    const body = await record(request, path);
    const answer = overridden(`POST ${path}`, request, body);
    if (answer !== undefined) {
      return answer;
    }
    if (trading.heartbeatGate !== undefined) {
      await trading.heartbeatGate;
    }
    const owner = tryHmac(request, path, '');
    if (typeof owner === 'string') {
      trading.heartbeats.set(owner, now());
      return HttpResponse.json({ status: 'ok', tracked: true });
    }
    return HttpResponse.json({ status: 'ok', tracked: false });
  }

  // --------------------------------------------------------------- signed batch cancel
  /** The `{orderIds, marketId, signature}` form of `DELETE /orders`. */
  async function signedBatchCancel(value: unknown): Promise<Response> {
    if (
      !isRecord(value) ||
      !Object.keys(value).every((k) => BATCH_CANCEL_KEYS.includes(k))
    ) {
      return invalid(
        'invalid batch cancel request: unknown field or not an object',
      );
    }
    const ids = value.orderIds;
    if (
      !Array.isArray(ids) ||
      !ids.every((id) => typeof id === 'number' && Number.isSafeInteger(id))
    ) {
      return invalid(
        'invalid batch cancel request: the order ids must be whole numbers',
      );
    }
    if (typeof value.marketId !== 'string') {
      return invalid('invalid batch cancel request: missing field `marketId`');
    }
    if (ids.length === 0) {
      return invalid('orderIds must not be empty');
    }
    const user = await verifyCancelSignature(
      orderbook,
      cancelDigest(chainId, value.marketId, BigInt(ids[0] as number)),
      value.signature,
      value.signatureType,
      value.signer,
      chainId,
    );
    if (user instanceof Response) {
      return user;
    }
    const canceled: string[] = [];
    const notCanceled: Record<string, string> = {};
    for (const id of ids as number[]) {
      const order = trading.orders.find((o) => o.numericId === id);
      if (
        order === undefined ||
        order.owner !== user ||
        order.market !== value.marketId
      ) {
        notCanceled[String(id)] = 'order not found';
        continue;
      }
      remove(order);
      canceled.push(String(id));
    }
    return HttpResponse.json({ canceled, notCanceled });
  }

  server.use(
    // ---------------------------------------------------------------- place
    http.post(`${BASE}/order`, async ({ request }) => {
      const body = await record(request, '/order');
      const answer = overridden('POST /order', request, body);
      if (answer !== undefined) {
        return answer;
      }
      if (trading.paused) {
        return pausedResponse();
      }
      const json = parseJson(body);
      if (!json.ok) {
        return json.response;
      }
      const parsed = parsePlaceRequest(json.value);
      if (!parsed.ok) {
        return parsed.response;
      }
      const bad = await verifyOrderSignature(
        orderbook,
        parsed.value.order,
        chainId,
      );
      if (bad !== undefined) {
        return unauthorized(bad);
      }
      const hmac = tryHmac(request, '/order', body);
      if (hmac instanceof Response) {
        return hmac;
      }
      const admitted = admit(parsed.value, ownerOf(parsed.value, hmac));
      if ('error' in admitted) {
        return gatewayError(admitted.status, admitted.error);
      }
      const placed = place(admitted);
      return placed instanceof Response ? placed : HttpResponse.json(placed);
    }),

    http.post(`${BASE}/orders`, async ({ request }) => {
      const body = await record(request, '/orders');
      const answer = overridden('POST /orders', request, body);
      if (answer !== undefined) {
        return answer;
      }
      if (trading.paused) {
        return pausedResponse();
      }
      const json = parseJson(body);
      if (!json.ok) {
        return json.response;
      }
      if (!Array.isArray(json.value)) {
        return invalid('invalid request body: expected a list');
      }
      const requests: PlaceRequest[] = [];
      for (const entry of json.value) {
        const parsed = parsePlaceRequest(entry);
        if (!parsed.ok) {
          return parsed.response;
        }
        requests.push(parsed.value);
      }
      if (requests.length === 0) {
        return invalid('batch must contain at least one order');
      }
      if (requests.length > trading.maxBatchPlace) {
        return invalid(
          `batch size ${requests.length} exceeds maximum of ${trading.maxBatchPlace}`,
        );
      }
      const hmac = tryHmac(request, '/orders', body);
      if (hmac instanceof Response) {
        return hmac;
      }
      // Every signature first: one bad signature fails the whole batch (`?` in the loop).
      for (const r of requests) {
        const bad = await verifyOrderSignature(orderbook, r.order, chainId);
        if (bad !== undefined) {
          return unauthorized(bad);
        }
      }
      const results = requests.map((r) => {
        const admitted = admit(r, ownerOf(r, hmac));
        if ('error' in admitted) {
          return {
            order_id: null,
            fills: null,
            resting: null,
            remaining_size: null,
            error: admitted.error,
            order_hash: null,
          };
        }
        // A `Response` from the `outcome` hook only shapes single placements.
        place(admitted);
        return {
          order_id: admitted.hash,
          fills: 0,
          resting: trading.orders.includes(admitted),
          remaining_size: microToDecimal(admitted.size),
          error: null,
          order_hash: admitted.hash,
        };
      });
      return HttpResponse.json({ results });
    }),

    // --------------------------------------------------------------- cancel
    http.delete(`${BASE}/order`, async ({ request }) => {
      const body = await record(request, '/order');
      const answer = overridden('DELETE /order', request, body);
      if (answer !== undefined) {
        return answer;
      }
      const json = parseJson(body);
      if (!json.ok) {
        return json.response;
      }
      if (!isRecord(json.value)) {
        return invalid('invalid request body: expected an object');
      }
      const req = json.value;
      const id = req.orderID ?? req.orderId;
      if (id === undefined) {
        return invalid('invalid request body: missing field `orderId`');
      }
      if (req.marketId !== undefined && typeof req.marketId !== 'string') {
        return invalid('invalid request body: marketId must be a string');
      }
      const target = findTarget(id);
      if ('error' in target) {
        return gatewayError(target.status, target.error);
      }
      let user = tryHmac(request, '/order', body);
      if (user instanceof Response) {
        return user;
      }
      if (user === undefined) {
        if (req.signature === undefined) {
          return unauthorized(
            'cancel requires HMAC headers or EIP-712 signature',
          );
        }
        const numeric =
          typeof id === 'number' ||
          (typeof id === 'string' && /^[0-9]+$/.test(id));
        if (!numeric) {
          return invalid(
            'EIP-712 cancel signature requires the numeric orderID; use HMAC auth for hash-based cancels',
          );
        }
        if (typeof req.marketId !== 'string') {
          return invalid('market_id required for EIP-712 cancel auth');
        }
        const signed = await verifyCancelSignature(
          orderbook,
          cancelDigest(chainId, req.marketId, BigInt(id as string | number)),
          req.signature,
          req.signatureType,
          req.signer,
          chainId,
        );
        if (signed instanceof Response) {
          return signed;
        }
        user = signed;
      }
      const order = target.order;
      if (order === undefined) {
        return gatewayError(404, `order ${target.key} not found`);
      }
      if (order.owner !== user) {
        return HttpResponse.json({
          canceled: [],
          notCanceled: { [target.key]: 'order does not belong to the caller' },
        });
      }
      if (typeof req.marketId === 'string' && req.marketId !== order.market) {
        return HttpResponse.json({
          canceled: [],
          notCanceled: { [target.key]: 'order not in market' },
        });
      }
      remove(order);
      return HttpResponse.json({ canceled: [target.key], notCanceled: {} });
    }),

    http.delete(`${BASE}/orders`, async ({ request }) => {
      const body = await record(request, '/orders');
      const answer = overridden('DELETE /orders', request, body);
      if (answer !== undefined) {
        return answer;
      }
      const json = parseJson(body);
      if (!json.ok) {
        return json.response;
      }
      if (!Array.isArray(json.value)) {
        return signedBatchCancel(json.value);
      }
      const user = tryHmac(request, '/orders', body);
      if (user instanceof Response) {
        return user;
      }
      if (user === undefined) {
        return unauthorized('HMAC auth required for batch cancel');
      }
      const canceled: string[] = [];
      const notCanceled: Record<string, string> = {};
      for (const value of json.value as unknown[]) {
        const target = findTarget(value);
        if ('error' in target) {
          notCanceled[target.key] = `invalid request: ${target.error}`;
          continue;
        }
        if (target.order === undefined || target.order.owner !== user) {
          notCanceled[target.key] = 'order not found';
          continue;
        }
        remove(target.order);
        canceled.push(target.key);
      }
      return HttpResponse.json({ canceled, notCanceled });
    }),

    http.delete(`${BASE}/cancel-all`, async ({ request }) => {
      const body = await record(request, '/cancel-all');
      const answer = overridden('DELETE /cancel-all', request, body);
      if (answer !== undefined) {
        return answer;
      }
      // The gateway parses the body as a signed cancel-all: anything that does not parse (bad
      // JSON, an unknown field, no signature) falls back to HMAC over the raw body.
      let parsed: Record<string, unknown> | undefined;
      if (body !== '') {
        try {
          const value: unknown = JSON.parse(body);
          if (
            isRecord(value) &&
            Object.keys(value).every((k) => CANCEL_ALL_KEYS.includes(k)) &&
            typeof value.signature === 'string' &&
            (value.marketId === undefined ||
              typeof value.marketId === 'string') &&
            (value.signatureType === undefined ||
              typeof value.signatureType === 'number') &&
            (value.signer === undefined || typeof value.signer === 'string')
          ) {
            parsed = value;
          }
        } catch {
          parsed = undefined;
        }
      }
      let user: string;
      let market: string | undefined;
      if (parsed !== undefined) {
        const signedMarket = (parsed.marketId as string | undefined) ?? '';
        const signed = await verifyCancelSignature(
          orderbook,
          cancelDigest(chainId, signedMarket),
          parsed.signature,
          parsed.signatureType,
          parsed.signer,
          chainId,
        );
        if (signed instanceof Response) {
          return signed;
        }
        user = signed;
        market = parsed.marketId as string | undefined;
      } else {
        const hmac = tryHmac(request, '/cancel-all', body);
        if (hmac instanceof Response) {
          return hmac;
        }
        if (hmac === undefined) {
          return unauthorized('authentication required');
        }
        user = hmac;
      }
      const canceled = cancelAllOf(user, market);
      return canceled instanceof Response
        ? canceled
        : HttpResponse.json({ canceled, notCanceled: {} });
    }),

    http.delete(`${BASE}/cancel-market-orders`, async ({ request }) => {
      const body = await record(request, '/cancel-market-orders');
      const answer = overridden('DELETE /cancel-market-orders', request, body);
      if (answer !== undefined) {
        return answer;
      }
      const json = parseJson(body);
      if (!json.ok) {
        return json.response;
      }
      if (!isRecord(json.value)) {
        return invalid('invalid request body: expected an object');
      }
      const req = json.value;
      const marketId = req.marketId ?? req.market;
      if (typeof marketId !== 'string') {
        return invalid('invalid request body: missing field `marketId`');
      }
      let user: string;
      if (req.signature !== undefined) {
        const signed = await verifyCancelSignature(
          orderbook,
          cancelDigest(chainId, marketId),
          req.signature,
          req.signatureType,
          req.signer,
          chainId,
        );
        if (signed instanceof Response) {
          return signed;
        }
        user = signed;
      } else {
        const hmac = tryHmac(request, '/cancel-market-orders', body);
        if (hmac instanceof Response) {
          return hmac;
        }
        if (hmac === undefined) {
          return unauthorized('authentication required');
        }
        user = hmac;
      }
      // `asset_id` is accepted and ignored, as in the gateway.
      const canceled = cancelAllOf(user, marketId);
      return canceled instanceof Response
        ? canceled
        : HttpResponse.json({ canceled, notCanceled: {} });
    }),

    // ------------------------------------------------------------ batch-ops
    http.post(`${BASE}/orders/batch-ops`, async ({ request }) => {
      const body = await record(request, '/orders/batch-ops');
      const answer = overridden('POST /orders/batch-ops', request, body);
      if (answer !== undefined) {
        return answer;
      }
      if (trading.paused) {
        return pausedResponse();
      }
      const json = parseJson(body);
      if (!json.ok) {
        return json.response;
      }
      const envelope = json.value;
      if (!isRecord(envelope) || !Array.isArray(envelope.ops)) {
        return invalid('invalid request body: missing field `ops`');
      }
      if (Object.keys(envelope).some((k) => k !== 'ops')) {
        return invalid('invalid request body: unknown field in the batch');
      }
      type Group =
        | { type: 'place'; payload: PlaceRequest[] }
        | { type: 'cancel'; payload: unknown[] };
      const groups: Group[] = [];
      let total = 0;
      for (const op of envelope.ops as unknown[]) {
        if (!isRecord(op) || (op.type !== 'place' && op.type !== 'cancel')) {
          return invalid('invalid request body: unknown variant');
        }
        if (Object.keys(op).some((k) => k !== 'type' && k !== 'payload')) {
          return invalid('invalid request body: unknown field in an operation');
        }
        if (!Array.isArray(op.payload)) {
          return invalid('invalid request body: missing field `payload`');
        }
        if (op.type === 'place') {
          const payload: PlaceRequest[] = [];
          for (const entry of op.payload as unknown[]) {
            const parsed = parsePlaceRequest(entry);
            if (!parsed.ok) {
              return parsed.response;
            }
            payload.push(parsed.value);
          }
          if (payload.length > trading.maxBatchPlace) {
            return invalid(
              `place group size ${payload.length} exceeds maximum`,
            );
          }
          groups.push({ type: 'place', payload });
        } else {
          if (op.payload.length > MAX_BATCH_CANCEL) {
            return invalid(
              `cancel group size ${op.payload.length} exceeds maximum`,
            );
          }
          groups.push({ type: 'cancel', payload: op.payload as unknown[] });
        }
        total += (op.payload as unknown[]).length;
      }
      if (groups.length === 0) {
        return invalid('ops must contain at least one group');
      }
      if (total > MAX_BATCH_OPS_TOTAL) {
        return invalid(`total sub-op count ${total} exceeds maximum`);
      }
      const hmac = tryHmac(request, '/orders/batch-ops', body);
      if (hmac instanceof Response) {
        return hmac;
      }
      if (hmac === undefined) {
        return unauthorized('HMAC auth required for POST /orders/batch-ops');
      }
      const results: unknown[] = [];
      for (const group of groups) {
        if (group.type === 'place') {
          const entries: unknown[] = [];
          for (const r of group.payload) {
            const bad = await verifyOrderSignature(orderbook, r.order, chainId);
            const admitted =
              bad === undefined
                ? admit(r, r.funder?.toLowerCase() ?? hmac)
                : { status: 401, error: bad };
            if ('error' in admitted) {
              entries.push({
                order_id: null,
                fills: null,
                resting: null,
                remaining_size: null,
                error: admitted.error,
                order_hash: null,
              });
              continue;
            }
            place(admitted);
            entries.push({
              order_id: admitted.hash,
              fills: 0,
              resting: trading.orders.includes(admitted),
              remaining_size: microToDecimal(admitted.size),
              error: null,
              order_hash: admitted.hash,
            });
          }
          results.push({ type: 'place', payload: entries });
        } else {
          const canceled: string[] = [];
          const notCanceled: Record<string, string> = {};
          for (const value of group.payload) {
            const target = findTarget(value);
            if ('error' in target) {
              notCanceled[target.key] = `invalid request: ${target.error}`;
            } else if (
              target.order === undefined ||
              target.order.owner !== hmac
            ) {
              notCanceled[target.key] = 'order not found';
            } else {
              remove(target.order);
              canceled.push(target.key);
            }
          }
          results.push({ type: 'cancel', payload: { canceled, notCanceled } });
        }
      }
      return HttpResponse.json({ results });
    }),

    // ------------------------------------------------------------- own data
    http.get(`${BASE}/data/orders`, async ({ request }) => {
      const body = await record(request, '/data/orders');
      const answer = overridden('GET /data/orders', request, body);
      if (answer !== undefined) {
        return answer;
      }
      const query = readQuery(request, [
        'market',
        'asset_id',
        'status',
        'id',
        'next_cursor',
        'limit',
      ]);
      if (!query.ok) {
        return query.response;
      }
      const user = requireHmac(request, '/data/orders');
      if (user instanceof Response) {
        return user;
      }
      const market = query.value.get('market');
      const asset = query.value.get('asset_id');
      if (asset !== null && !/^[0-9]+$/.test(asset)) {
        return invalid('invalid token_id: invalid digit found in string');
      }
      const mine = trading.orders.filter(
        (o) =>
          o.owner === user &&
          (market === null || o.market === market) &&
          (asset === null || BigInt(o.tokenId) === BigInt(asset)),
      );
      return HttpResponse.json(
        page(mine.map(openOrder), query.value.get('next_cursor')),
      );
    }),

    http.get(`${BASE}/data/order/:id`, async ({ request, params }) => {
      const id = String(params.id);
      const path = `/data/order/${id}`;
      const body = await record(request, path);
      const answer = overridden('GET /data/order/{id}', request, body);
      if (answer !== undefined) {
        return answer;
      }
      const query = readQuery(request, []);
      if (!query.ok) {
        return query.response;
      }
      const user = requireHmac(request, path);
      if (user instanceof Response) {
        return user;
      }
      let order: RestingOrder | undefined;
      if (HASH_PATTERN.test(id)) {
        // The books first, then the held queue.
        order =
          trading.orders.find((o) => o.hash === id.toLowerCase()) ??
          trading.held.find((o) => o.hash === id.toLowerCase());
      } else if (/^[0-9]+$/.test(id)) {
        order = trading.orders.find((o) => o.numericId === Number(id));
      } else {
        return invalid('invalid order ID');
      }
      if (order === undefined || order.owner !== user) {
        return gatewayError(404, `order ${id} not found`);
      }
      return HttpResponse.json(openOrder(order));
    }),

    http.get(`${BASE}/data/trades`, async ({ request }) => {
      const body = await record(request, '/data/trades');
      const answer = overridden('GET /data/trades', request, body);
      if (answer !== undefined) {
        return answer;
      }
      const query = readQuery(request, [
        'market',
        'asset_id',
        'limit',
        'next_cursor',
        'id',
        'before',
        'after',
      ]);
      if (!query.ok) {
        return query.response;
      }
      const user = requireHmac(request, '/data/trades');
      if (user instanceof Response) {
        return user;
      }
      const market = query.value.get('market');
      // The gateway walks the user's trade index backwards: newest first. `trading.trades` is
      // written oldest first.
      const mine = trading.trades
        .filter(
          (t) =>
            t.owner === user && (market === null || t.trade.market === market),
        )
        .map((t) => t.trade)
        .reverse();
      return HttpResponse.json(page(mine, query.value.get('next_cursor')));
    }),

    http.get(`${BASE}/trades/:id`, async ({ request, params }) => {
      const id = String(params.id);
      const path = `/trades/${id}`;
      const body = await record(request, path);
      const answer = overridden('GET /trades/{id}', request, body);
      if (answer !== undefined) {
        return answer;
      }
      const query = readQuery(request, []);
      if (!query.ok) {
        return query.response;
      }
      const hmac = tryHmac(request, path, '');
      if (hmac instanceof Response) {
        return hmac;
      }
      const hex = id.startsWith('0x') ? id.slice(2) : id;
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        return invalid('invalid trade ID');
      }
      const found = trading.trades.find(
        (t) => String(t.trade.id).toLowerCase() === `0x${hex.toLowerCase()}`,
      );
      if (found === undefined) {
        return gatewayError(404, `trade 0x${hex.toLowerCase()} not found`);
      }
      return HttpResponse.json(found.trade);
    }),

    http.get(`${BASE}/balance-allowance`, async ({ request }) => {
      const body = await record(request, '/balance-allowance');
      const answer = overridden('GET /balance-allowance', request, body);
      if (answer !== undefined) {
        return answer;
      }
      const query = readQuery(request, [
        'asset_type',
        'token_id',
        'signature_type',
      ]);
      if (!query.ok) {
        return query.response;
      }
      const user = requireHmac(request, '/balance-allowance');
      if (user instanceof Response) {
        return user;
      }
      const account = trading.accounts.get(user);
      if (account === undefined) {
        return HttpResponse.json({
          balance: '0',
          allowance: '0',
          smart_account: null,
        });
      }
      const type = (
        query.value.get('asset_type') ?? 'COLLATERAL'
      ).toUpperCase();
      let balance = account.cash;
      if (type === 'CONDITIONAL') {
        const token = query.value.get('token_id');
        if (token === null) {
          return invalid('token_id required when asset_type=CONDITIONAL');
        }
        balance =
          account.positions.find((p) => BigInt(p.token_id) === BigInt(token))
            ?.balance ?? '0';
      }
      return HttpResponse.json({
        balance,
        allowance: '0',
        smart_account: account.smart_account ?? '00'.repeat(20),
      });
    }),

    http.get(`${BASE}/positions`, async ({ request }) => {
      const body = await record(request, '/positions');
      const answer = overridden('GET /positions', request, body);
      if (answer !== undefined) {
        return answer;
      }
      const query = readQuery(request, ['address'], ['address']);
      if (!query.ok) {
        return query.response;
      }
      const hmac = tryHmac(request, '/positions', '');
      if (hmac instanceof Response) {
        return hmac;
      }
      const user = (query.value.get('address') ?? '').toLowerCase();
      const account = trading.accounts.get(user);
      return HttpResponse.json(
        account === undefined
          ? { cash_balance: '0', positions: [] }
          : {
              cash_balance: account.cash,
              positions: account.positions.filter(
                (p) => BigInt(p.balance) > 0n,
              ),
            },
      );
    }),

    http.get(`${BASE}/claimable`, async ({ request }) => {
      const body = await record(request, '/claimable');
      const answer = overridden('GET /claimable', request, body);
      if (answer !== undefined) {
        return answer;
      }
      const query = readQuery(request, ['address']);
      if (!query.ok) {
        return query.response;
      }
      const hmac = tryHmac(request, '/claimable', '');
      if (hmac instanceof Response) {
        return hmac;
      }
      const user = hmac ?? query.value.get('address')?.toLowerCase();
      if (user === undefined) {
        return unauthorized('HMAC L2 credentials required');
      }
      return HttpResponse.json({
        address: user,
        claimable: trading.claimable.get(user) ?? [],
      });
    }),

    // ------------------------------------------------------------ heartbeat
    http.post(`${BASE}/v1/heartbeats`, ({ request }) =>
      heartbeat(request, '/v1/heartbeats'),
    ),
    http.post(`${BASE}/heartbeats`, ({ request }) =>
      heartbeat(request, '/heartbeats'),
    ),

    http.get(`${BASE}/data/market-capacity`, async ({ request }) => {
      const body = await record(request, '/data/market-capacity');
      const answer = overridden('GET /data/market-capacity', request, body);
      if (answer !== undefined) {
        return answer;
      }
      const query = readQuery(request, ['address', 'market'], ['market']);
      if (!query.ok) {
        return query.response;
      }
      const hmac = tryHmac(request, '/data/market-capacity', '');
      if (hmac instanceof Response) {
        return hmac;
      }
      const user = hmac ?? query.value.get('address')?.toLowerCase();
      if (user === undefined) {
        return unauthorized('HMAC L2 credentials required');
      }
      const raw = query.value.get('market') ?? '';
      const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        return invalid('invalid hex: expected 32 bytes');
      }
      const market = `0x${hex.toLowerCase()}`;
      const tokens = trading.markets.get(market);
      const account = trading.accounts.get(user);
      const position = (token: string, outcome: 'YES' | 'NO') => {
        const held = account?.positions.find((p) => p.token_id === token);
        const balance = held?.balance ?? '0';
        const reserved = held?.reserved ?? '0';
        return {
          token_id: token,
          outcome,
          balance,
          reserved,
          pending_settlement: '0',
          free_position: (BigInt(balance) - BigInt(reserved)).toString(),
        };
      };
      return HttpResponse.json({
        user_id: user,
        market_id: market,
        free_market_capacity: account?.cash ?? '0',
        positions:
          tokens === undefined
            ? []
            : [position(tokens.yes, 'YES'), position(tokens.no, 'NO')],
        smart_account:
          account === undefined
            ? null
            : (account.smart_account ?? '00'.repeat(20)),
      });
    }),
  );

  return trading;
}
