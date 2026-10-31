// The orderbook client's trading part: building, signing and placing orders, and
// cancelling them. The placement results and errors live in placement.ts. `OrderbookClient`
// (client.ts) delegates to it; the public JSDoc lives there.

import type { Address, Hex, TypedDataDefinition, TypedDataDomain } from 'viem';
import {
  UnexpectedResponseError,
  UserInputError,
  XoError,
} from '../core/errors';
import { normalizeConditionId, normalizeTokenId } from '../core/ids';
import type { OrderHash, OrderType } from '../core/types';
import { cancelAllTypedData, cancelOrderTypedData } from '../signing/cancel';
import {
  hashOrder,
  type OrderStruct,
  orderDomain,
  toWireOrder,
  type WireOrder,
} from '../signing/order';
import { signAsTrader } from '../wallet/identity';
import { errorName, isObject } from '../wallet/internal';
import {
  type BuilderContext,
  buildLimitOrder,
  buildMarketOrder,
  type LimitOrderArgs,
  type MarketOrderArgs,
  type SignedOrder,
} from './builder';
import {
  type ContractReader,
  closedObject,
  isNumericRef,
  type OrderbookDeps,
  readOrderRef,
  requireSession,
  trader,
} from './internal';
import {
  type BatchOpResult,
  type BatchPlaceResult,
  incomplete,
  opsIncomplete,
  type PlaceOrderResult,
  withPlacement,
} from './placement';
import type { PlaceOrderResponse } from './schemas';
import {
  type BatchOpsEntry,
  type BatchOpsResponse,
  BatchOpsResponseSchema,
  type BatchPlaceEntry,
  BatchPlaceResponseSchema,
  type CancelResult,
  CancelResultSchema,
  PlaceOrderResponseSchema,
} from './schemas';

/** One group of `batchOps`. */
export type BatchOp =
  | { type: 'place'; orders: readonly SignedOrder[] }
  | { type: 'cancel'; ids: readonly string[] };

/** The options of `cancelOrder` and `cancelOrders`. */
export interface CancelOrderOptions {
  /**
   * Sign an EIP-712 `CancelOrder(orderId, marketId)` instead of using the L2 credentials
   * (for `cancelOrders`, over the first id). The gateway takes a signed cancel only for
   * numeric order ids, with `conditionId`. A signed cancel is replayable: it does not expire,
   * and through the batch route it can cancel any of your orders in that market. Prefer the
   * default L2 (HMAC) cancel unless you need signed mode.
   */
  signed?: boolean;
  /**
   * The order's market. Required with `signed: true`. `cancelOrders` takes it only then: all
   * its orders must be in this market.
   */
  conditionId?: string;
}

/** The options of `cancelAll`. */
export interface CancelAllOptions {
  /** Sign an EIP-712 `CancelAll("")` instead of using the L2 credentials. */
  signed?: boolean;
}

/** The options of `cancelMarketOrders`. */
export interface CancelMarketOrdersOptions {
  conditionId: string;
  /**
   * Sent as `assetId`. The gateway does not filter by it yet: every order of the caller in
   * the market is cancelled, on both outcomes.
   */
  tokenId?: string;
  /** Sign an EIP-712 `CancelAll(conditionId)` instead of using the L2 credentials. */
  signed?: boolean;
}

/**
 * The most orders one `POST /orders` takes: the gateway's default batch size. A gateway configured
 * lower answers 400 for the whole chunk.
 */
export const MAX_BATCH_PLACE = 300;

const ORDER_TYPES: readonly OrderType[] = ['GTC', 'GTD', 'FOK', 'FAK'];
const ORDER_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const WORD_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const UINT128_LIMIT = 1n << 128n;
/** `nonces(address)` of the CTF exchange. */
export const NONCES_SELECTOR = '0x7ecebe00';

const NO_CHAIN =
  'Building an order reads the exchange nonce (CTFExchange.nonces(maker)) on chain, but the client has no `chain`: pass the `chain` option, a ContractReader with readContract';

/** The calldata of `CTFExchange.nonces(maker)`: the selector and the address as one ABI word. */
export function noncesCalldata(maker: Address): Hex {
  return `${NONCES_SELECTOR}${maker.slice(2).toLowerCase().padStart(64, '0')}` as Hex;
}

function nonceUnavailable(message: string): XoError {
  // No `cause`, on purpose: an RPC error can carry the node URL, and the URL a key.
  return new XoError(message, { code: 'nonce_unavailable', service: 'chain' });
}

/** Reads `CTFExchange.nonces(maker)` and decodes the uint128 it returns. */
async function readNonce(
  chain: ContractReader,
  exchange: Address,
  maker: Address,
): Promise<bigint> {
  let result: unknown;
  try {
    result = await chain.readContract({
      to: exchange,
      data: noncesCalldata(maker),
    });
  } catch (error) {
    throw nonceUnavailable(
      `Reading the exchange nonce failed (${errorName(error)})`,
    );
  }
  if (typeof result !== 'string' || !WORD_PATTERN.test(result)) {
    throw nonceUnavailable(
      'Reading the exchange nonce returned something that is not one ABI word',
    );
  }
  const nonce = BigInt(result);
  if (nonce >= UINT128_LIMIT) {
    throw nonceUnavailable(
      'Reading the exchange nonce returned a value that does not fit a uint128',
    );
  }
  return nonce;
}

function readSigned(value: unknown): boolean {
  if (value === undefined) {
    return false;
  }
  if (typeof value !== 'boolean') {
    throw new UserInputError('signed must be true or false');
  }
  return value;
}

/** The checked parts of a signed order that are sent. */
interface Checked {
  orderHash: OrderHash;
  wire: WireOrder;
  orderType: OrderType;
  postOnly: boolean;
}

/**
 * Checks a signed order before it is sent. It never re-signs it. The hash is recomputed
 * from `order` under this environment's exchange domain and must equal `orderHash`, and the
 * wire order that is sent is derived again from `order` and the signature, so the bytes sent
 * are exactly the order the hash names (a changed `wire` cannot slip through).
 */
function readSignedOrder(
  value: unknown,
  field: string,
  domain: TypedDataDomain,
): Checked {
  if (!isObject(value)) {
    throw new UserInputError(
      `${field} must be a signed order (from createOrder or createMarketOrder)`,
    );
  }
  const { orderHash, wire, orderType, postOnly } = value;
  if (typeof orderHash !== 'string' || !ORDER_HASH_PATTERN.test(orderHash)) {
    throw new UserInputError(
      `${field}.orderHash must be 0x followed by 64 hex characters`,
    );
  }
  if (!isObject(wire)) {
    throw new UserInputError(`${field}.wire must be the wire order`);
  }
  if (!ORDER_TYPES.includes(orderType as OrderType)) {
    throw new UserInputError(
      `${field}.orderType must be one of ${ORDER_TYPES.join(', ')}`,
    );
  }
  if (typeof postOnly !== 'boolean') {
    throw new UserInputError(`${field}.postOnly must be true or false`);
  }
  if (postOnly && orderType !== 'GTC' && orderType !== 'GTD') {
    throw new UserInputError(
      `${field}.postOnly is only allowed with GTC or GTD orders`,
    );
  }
  let hash: OrderHash;
  try {
    hash = hashOrder(value.order as OrderStruct, domain);
  } catch (error) {
    if (!(error instanceof UserInputError)) {
      throw error;
    }
    throw new UserInputError(
      `${field}.order is not a valid order (${error.message})`,
    );
  }
  if (hash.toLowerCase() !== orderHash.toLowerCase()) {
    throw new UserInputError(
      `${field}.orderHash does not match the order: it was changed after signing, or signed for another chain or exchange`,
    );
  }
  let derived: WireOrder;
  try {
    derived = toWireOrder(value.order as OrderStruct, wire.signature as Hex);
  } catch (error) {
    if (!(error instanceof UserInputError)) {
      throw error;
    }
    throw new UserInputError(
      `${field}.wire.signature is not a valid signature (${error.message})`,
    );
  }
  return {
    orderHash: hash,
    wire: derived,
    orderType: orderType as OrderType,
    postOnly,
  };
}

/** A list of signed orders. The same order twice is refused: it could fill twice. */
function readSignedOrders(
  value: unknown,
  field: string,
  seen: Map<string, string>,
  domain: TypedDataDomain,
): Checked[] {
  if (!Array.isArray(value)) {
    throw new UserInputError(`${field} must be an array of signed orders`);
  }
  return Array.from(value as unknown[], (order, index) => {
    const name = `${field}[${index}]`;
    const checked = readSignedOrder(order, name, domain);
    const first = seen.get(checked.orderHash);
    if (first !== undefined) {
      throw new UserInputError(
        `${name} is the same order as ${first} (orderHash ${checked.orderHash}); send each signed order once`,
      );
    }
    seen.set(checked.orderHash, name);
    return checked;
  });
}

/** The body of `POST /order`: exactly `{ order, orderType, postOnly }`. */
const placeBody = (o: Checked) => ({
  order: o.wire,
  orderType: o.orderType,
  postOnly: o.postOnly,
});

function unpaired(path: string, code: string, message: string) {
  return new UnexpectedResponseError(
    `Unexpected orderbook response for ${path}: ${message}`,
    {
      service: 'orderbook',
      issues: [{ path: 'results', code, message }],
    },
  );
}

/**
 * Pairs a batch answer with the orders sent, by position, and adds each input's hash. An
 * answer with another count, or an `order_hash` that is not the order at its position,
 * cannot be paired and is an `UnexpectedResponseError`.
 */
function pair(
  entries: readonly BatchPlaceEntry[],
  sent: readonly Checked[],
  path: string,
): BatchPlaceResult[] {
  if (entries.length !== sent.length) {
    throw unpaired(
      path,
      'result_count_mismatch',
      `${entries.length} results for ${sent.length} orders`,
    );
  }
  return entries.map((entry, index) => {
    const local = (sent[index] as Checked).orderHash;
    if (entry.order_hash !== null && entry.order_hash.toLowerCase() !== local) {
      throw unpaired(
        path,
        'result_order_mismatch',
        `result ${index} is for another order than the one sent at that position`,
      );
    }
    return { ...entry, orderHash: local };
  });
}

/** A checked `batchOps` group. */
type Group =
  | { type: 'place'; orders: Checked[] }
  | { type: 'cancel'; ids: string[] };

/** Pairs a `batchOps` answer with the groups sent, by position and type. */
function pairOps(
  results: readonly BatchOpsEntry[],
  groups: readonly Group[],
  path: string,
): BatchOpResult[] {
  if (results.length !== groups.length) {
    throw unpaired(
      path,
      'result_count_mismatch',
      `${results.length} results for ${groups.length} groups`,
    );
  }
  return results.map((entry, index): BatchOpResult => {
    const group = groups[index] as Group;
    if (entry.type !== group.type) {
      throw unpaired(
        path,
        'result_type_mismatch',
        `result ${index} is a ${entry.type} group, but a ${group.type} group was sent`,
      );
    }
    if (entry.type === 'cancel' || group.type === 'cancel') {
      return entry as BatchOpResult;
    }
    // A place group: pair its entries with the orders sent, as `postOrders` does.
    const { payload, ...rest } = entry;
    return payload === undefined
      ? { ...rest, type: 'place' }
      : { ...rest, type: 'place', payload: pair(payload, group.orders, path) };
  });
}

/** How long a market's tick size is reused for building orders. */
export const TICK_SIZE_TTL_MS = 300_000;

export class Trading {
  readonly #deps: OrderbookDeps;
  /** The exchange nonce per maker (lower case): a pending or settled read. */
  readonly #nonces = new Map<string, Promise<bigint>>();
  /** The tick size per token id, and when it was asked for (local ms). */
  readonly #tickSizes = new Map<
    string,
    { at: number; value: Promise<string> }
  >();

  constructor(deps: OrderbookDeps) {
    this.#deps = deps;
  }

  // -------------------------------------------------------------------------
  // Build and place
  // -------------------------------------------------------------------------

  async createOrder(a: LimitOrderArgs): Promise<SignedOrder> {
    return buildLimitOrder(a, await this.#context());
  }

  async createMarketOrder(a: MarketOrderArgs): Promise<SignedOrder> {
    return buildMarketOrder(a, await this.#context());
  }

  async postOrder(order: SignedOrder): Promise<PlaceOrderResult> {
    const checked = readSignedOrder(order, 'order', this.#domain());
    let answer: unknown;
    try {
      answer = await this.#deps.request({
        method: 'POST',
        path: '/order',
        body: placeBody(checked),
        auth: 'orderbook',
        retry: 'none',
      });
    } catch (error) {
      throw withPlacement(error, checked.orderHash, false);
    }
    let response: PlaceOrderResponse;
    try {
      response = this.#deps.parse(PlaceOrderResponseSchema, answer, '/order');
    } catch (error) {
      // The gateway answered: the order may be placed.
      throw withPlacement(error, checked.orderHash, true);
    }
    const result: PlaceOrderResult = {
      ...response,
      orderHash: checked.orderHash,
    };
    if (response.orderID.toLowerCase() !== checked.orderHash) {
      result.orderIdMismatch = true;
    }
    return result;
  }

  async placeOrder(a: LimitOrderArgs): Promise<PlaceOrderResult> {
    return this.postOrder(await this.createOrder(a));
  }

  async placeMarketOrder(a: MarketOrderArgs): Promise<PlaceOrderResult> {
    return this.postOrder(await this.createMarketOrder(a));
  }

  async postOrders(
    orders: readonly SignedOrder[],
  ): Promise<BatchPlaceResult[]> {
    const checked = readSignedOrders(
      orders,
      'orders',
      new Map(),
      this.#domain(),
    );
    if (checked.length === 0) {
      throw new UserInputError(
        'orders must hold at least one signed order (the gateway refuses an empty batch)',
      );
    }
    const chunks = Math.ceil(checked.length / MAX_BATCH_PLACE);
    const results: BatchPlaceResult[] = [];
    for (let index = 0; index < chunks; index += 1) {
      const start = index * MAX_BATCH_PLACE;
      const chunk = checked.slice(start, start + MAX_BATCH_PLACE);
      const failed = (cause: unknown, answered: boolean) =>
        incomplete(
          index,
          chunks,
          chunk.map((o) => o.orderHash),
          checked.slice(start + chunk.length).map((o) => o.orderHash),
          results,
          cause,
          answered,
        );
      let answer: unknown;
      try {
        answer = await this.#deps.request({
          method: 'POST',
          path: '/orders',
          body: chunk.map(placeBody),
          auth: 'orderbook',
          retry: 'none',
        });
      } catch (cause) {
        throw failed(cause, false);
      }
      try {
        const response = this.#deps.parse(
          BatchPlaceResponseSchema,
          answer,
          '/orders',
        );
        results.push(...pair(response.results, chunk, '/orders'));
      } catch (cause) {
        // The gateway answered: the chunk may be placed.
        throw failed(cause, true);
      }
    }
    return results;
  }

  async batchOps(ops: readonly BatchOp[]): Promise<BatchOpResult[]> {
    if (!Array.isArray(ops) || ops.length === 0) {
      throw new UserInputError(
        'ops must be a non-empty array of { type: "place", orders } or { type: "cancel", ids }',
      );
    }
    const seen = new Map<string, string>();
    const domain = this.#domain();
    const groups = Array.from(ops as unknown[], (op, index): Group => {
      const field = `ops[${index}]`;
      if (!isObject(op) || (op.type !== 'place' && op.type !== 'cancel')) {
        throw new UserInputError(`${field}.type must be 'place' or 'cancel'`);
      }
      if (op.type === 'place') {
        closedObject(op, field, ['type', 'orders']);
        return {
          type: 'place',
          orders: readSignedOrders(op.orders, `${field}.orders`, seen, domain),
        };
      }
      closedObject(op, field, ['type', 'ids']);
      return { type: 'cancel', ids: readOrderRefs(op.ids, `${field}.ids`) };
    });
    const orderHashes = groups.flatMap((g) =>
      g.type === 'place' ? g.orders.map((o) => o.orderHash) : [],
    );
    const path = '/orders/batch-ops';
    let answer: unknown;
    try {
      answer = await this.#deps.request({
        method: 'POST',
        path,
        body: {
          ops: groups.map((g) =>
            g.type === 'place'
              ? { type: 'place', payload: g.orders.map(placeBody) }
              : { type: 'cancel', payload: g.ids },
          ),
        },
        auth: 'orderbook',
        retry: 'none',
      });
    } catch (cause) {
      throw opsIncomplete(orderHashes, cause, false);
    }
    // From here the gateway answered: its groups ran.
    let response: BatchOpsResponse;
    try {
      response = this.#deps.parse(BatchOpsResponseSchema, answer, path);
    } catch (cause) {
      throw opsIncomplete(orderHashes, cause, true);
    }
    try {
      return pairOps(response.results, groups, path);
    } catch (cause) {
      throw opsIncomplete(orderHashes, cause, true);
    }
  }

  // -------------------------------------------------------------------------
  // Cancel
  // -------------------------------------------------------------------------

  async cancelOrder(
    idOrHash: string,
    options: CancelOrderOptions = {},
  ): Promise<CancelResult> {
    const ref = readOrderRef(idOrHash, 'idOrHash');
    const o = closedObject(options, 'options', ['signed', 'conditionId']);
    const signed = readSigned(o.signed);
    const marketId =
      o.conditionId === undefined
        ? undefined
        : normalizeConditionId(o.conditionId, 'conditionId');
    if (!signed) {
      return this.#cancel('/order', { orderID: ref, marketId }, false);
    }
    if (!isNumericRef(ref)) {
      throw new UserInputError(
        'idOrHash must be the numeric order id for a signed cancel: the gateway verifies CancelOrder(uint64 orderId, marketId); cancel by hash without `signed`',
      );
    }
    if (marketId === undefined) {
      throw new UserInputError(
        'conditionId is required for a signed cancel: it is part of the signed CancelOrder message',
      );
    }
    const auth = await this.#signCancel(
      cancelOrderTypedData(BigInt(ref), marketId, this.#domain()),
    );
    return this.#cancel('/order', { orderID: ref, marketId, ...auth }, true);
  }

  async cancelOrders(
    ids: readonly string[],
    options: CancelOrderOptions = {},
  ): Promise<CancelResult> {
    const refs = readOrderRefs(ids, 'ids');
    const o = closedObject(options, 'options', ['signed', 'conditionId']);
    const signed = readSigned(o.signed);
    if (!signed) {
      if (o.conditionId !== undefined) {
        throw new UserInputError(
          'conditionId is only sent with signed: true: the HMAC batch cancel is a list of ids, whatever their market',
        );
      }
      return this.#cancel('/orders', refs, false);
    }
    if (refs.length === 0) {
      throw new UserInputError(
        'ids must hold at least one numeric order id for a signed cancel',
      );
    }
    // The gateway's signed form takes the ids as u64 JSON numbers, so each must be exact as a
    // JavaScript number.
    const orderIds = refs.map((ref, index) => {
      if (!isNumericRef(ref)) {
        throw new UserInputError(
          `ids[${index}] must be a numeric order id for a signed cancel: the gateway verifies CancelOrder(uint64 orderId, marketId); cancel by hash without \`signed\``,
        );
      }
      const id = Number(ref);
      if (!Number.isSafeInteger(id)) {
        throw new UserInputError(
          `ids[${index}] is above ${Number.MAX_SAFE_INTEGER}: the signed batch cancel sends ids as JSON numbers, which cannot hold it exactly; cancel it without \`signed\``,
        );
      }
      return id;
    });
    if (o.conditionId === undefined) {
      throw new UserInputError(
        'conditionId is required for a signed cancel: it is part of the signed CancelOrder message, and every id must be an order of that market',
      );
    }
    const marketId = normalizeConditionId(o.conditionId, 'conditionId');
    const auth = await this.#signCancel(
      cancelOrderTypedData(BigInt(refs[0] as string), marketId, this.#domain()),
    );
    return this.#cancel('/orders', { orderIds, marketId, ...auth }, true);
  }

  async cancelAll(options: CancelAllOptions = {}): Promise<CancelResult> {
    const o = closedObject(options, 'options', ['signed']);
    if (!readSigned(o.signed)) {
      return this.#cancel('/cancel-all', undefined, false);
    }
    // No `marketId` in the body: the gateway scopes `marketId: ""` to a market of that name
    // (a 404), and only an absent marketId means every market. The signed message is
    // CancelAll("") either way.
    const auth = await this.#signCancel(cancelAllTypedData('', this.#domain()));
    return this.#cancel('/cancel-all', auth, true);
  }

  async cancelMarketOrders(
    options: CancelMarketOrdersOptions,
  ): Promise<CancelResult> {
    const o = closedObject(options, 'options', [
      'conditionId',
      'tokenId',
      'signed',
    ]);
    const marketId = normalizeConditionId(o.conditionId, 'conditionId');
    const assetId =
      o.tokenId === undefined ? undefined : normalizeTokenId(o.tokenId);
    if (!readSigned(o.signed)) {
      return this.#cancel(
        '/cancel-market-orders',
        { marketId, assetId },
        false,
      );
    }
    const auth = await this.#signCancel(
      cancelAllTypedData(marketId, this.#domain()),
    );
    return this.#cancel(
      '/cancel-market-orders',
      { marketId, assetId, ...auth },
      true,
    );
  }

  // -------------------------------------------------------------------------
  // Nonce
  // -------------------------------------------------------------------------

  refreshNonce(): void {
    this.#nonces.clear();
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  /** The builder's context. Checks the session and the chain before anything is read or signed. */
  async #context(): Promise<BuilderContext> {
    requireSession(this.#deps);
    const chain = this.#deps.chain;
    if (chain === undefined) {
      throw new UserInputError(NO_CHAIN, { code: 'chain_not_configured' });
    }
    const { identity, signer, nowSec } = await trader(this.#deps);
    return {
      env: this.#deps.env,
      identity,
      signer,
      nonce: () => this.#nonce(chain, identity.address),
      tickSize: (tokenId) => this.#tickSize(tokenId),
      nowSec,
    };
  }

  /** The maker's exchange nonce, read once and cached until `refreshNonce()`; a failed read is not kept. */
  #nonce(chain: ContractReader, maker: Address): Promise<bigint> {
    const key = maker.toLowerCase();
    const cached = this.#nonces.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const pending = readNonce(
      chain,
      this.#deps.env.contracts.ctfExchange,
      maker,
    );
    this.#nonces.set(key, pending);
    pending.catch(() => {
      if (this.#nonces.get(key) === pending) {
        this.#nonces.delete(key);
      }
    });
    return pending;
  }

  /**
   * The token's tick size for the builder: one `getTickSize` per token per
   * {@link TICK_SIZE_TTL_MS}, shared by concurrent builds. A failed read is not kept, and a
   * local clock that went back counts as expired.
   */
  #tickSize(tokenId: string): Promise<string> {
    const now = this.#deps.now();
    const cached = this.#tickSizes.get(tokenId);
    if (cached !== undefined) {
      const age = now - cached.at;
      if (age >= 0 && age < TICK_SIZE_TTL_MS) {
        return cached.value;
      }
    }
    const value = this.#deps.tickSize(tokenId);
    const entry = { at: now, value };
    this.#tickSizes.set(tokenId, entry);
    value.catch(() => {
      if (this.#tickSizes.get(tokenId) === entry) {
        this.#tickSizes.delete(tokenId);
      }
    });
    return value;
  }

  #domain() {
    return orderDomain(
      this.#deps.env.chainId,
      this.#deps.env.contracts.ctfExchange,
    );
  }

  /**
   * Signs a cancel built here, as the trader. The body fields are the ones the gateway's
   * cancel structs take: `signature`, `signatureType` (0 EOA, 3 smart wallet) and `signer`
   * (the trading address, which the gateway asks for an EIP-1271 check for a smart wallet).
   */
  async #signCancel(td: TypedDataDefinition): Promise<{
    signature: Hex;
    signatureType: 0 | 3;
    signer: Address;
  }> {
    const { identity, signer } = await trader(this.#deps);
    const signature = await signAsTrader(
      identity,
      signer,
      td,
      this.#deps.env.chainId,
    );
    return {
      signature,
      signatureType: identity.signatureType,
      signer: identity.address,
    };
  }

  /**
   * One cancel request, sent once and never retried, like an order, an on-chain transaction or a
   * payment: a second attempt would report an order the first one cancelled as not found, and a
   * second cancel-all would also cancel an order placed between the two. A signed cancel carries no L2
   * headers: the gateway tries HMAC first on `DELETE /order`, so the signature is only checked
   * when they are absent.
   */
  #cancel(path: string, body: unknown, signed: boolean): Promise<CancelResult> {
    return this.#deps.send(CancelResultSchema, {
      method: 'DELETE',
      path,
      body,
      auth: signed ? 'none' : 'orderbook',
      retry: 'none',
    });
  }
}

/** A list of order references (see `readOrderRef`). */
function readOrderRefs(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new UserInputError(
      `${field} must be an array of order hashes or numeric order ids`,
    );
  }
  return Array.from(value as unknown[], (ref, index) =>
    readOrderRef(ref, `${field}[${index}]`),
  );
}
