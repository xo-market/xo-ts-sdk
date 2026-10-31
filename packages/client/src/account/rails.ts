import {
  type Address,
  type Hex,
  keccak256,
  serializeTransaction,
  type TransactionSerializableEIP1559,
} from 'viem';
import { isSameAddress, normalizeAddress } from '../core/address';
import type { EnvironmentConfig } from '../core/env';
import {
  SigningError,
  TimeoutError,
  TransactionFailedError,
  UserInputError,
  XoError,
} from '../core/errors';
import { Transport } from '../core/transport';
import { SDK_VERSION } from '../core/version';
import {
  type EvCall,
  type EvTx,
  estimateIntrinsicGas,
  executorSigningHash,
  MAX_CALLDATA_BYTES,
  MAX_CALLS,
  validateEvTx,
} from '../signing/evTx';
import { assertHexData, assertUint } from '../signing/internal';
import {
  type Call,
  kernelCreateAccountCalldata,
  kernelExecuteCalldata,
} from '../signing/kernel';
import type { TradingIdentity } from '../wallet/identity';
import { errorName, isObject } from '../wallet/internal';
import type { InternalSigner } from '../wallet/signer';
import type { ChainReader, TxResult } from './chain';
import {
  describeFailure,
  isEmptyCode,
  lastHandedOver,
  markAccepted,
  markHandedOver,
  nextNonce,
  withLanded,
} from './internal';
import { serializeByExecutor } from './nonceQueue';
import { normalizeExecutorSignature } from './signature';
import { sponsorSend, toSponsorTx } from './sponsorClient';

// The transaction rails: how the SDK puts calls on chain, from the gas limit through the
// build-and-sign and the send to the receipt wait.
//
// The rule every path keeps: a transaction whose outcome is unknown is never sent again.
//
// Besides the rails and their types, the module's helpers are exported too (the local checks,
// the chain reads, `signDigest`, `guarded`, `smartWalletDeploy`, the preflight registry). They
// are internal: no package entry exports them.

/** How long a send waits for the receipt once the transaction was handed over. */
export const RECEIPT_TIMEOUT_MS = 120_000;

/** The safety margin over an estimate or a bundle simulation, in percent. */
export const GAS_MARGIN_PERCENT = 25;

/**
 * The lowest fee per gas sent, for both EIP-1559 fields: 1 gwei. A chain can report a base fee
 * and a tip of 0, and the sponsor has been seen to accept 1 gwei in each. A chain that asks for
 * more gets what it asks for.
 */
export const MIN_FEE_PER_GAS = 1_000_000_000n;

const U64_MAX = (1n << 64n) - 1n;

/** The options of one send. */
export interface SendOptions {
  /**
   * The gas limit, instead of an estimate. Used as given (no margin), but never below the
   * intrinsic gas of the calls. There is no SDK cap (only the 64-bit field width), but the node
   * refuses a limit above the block gas limit: on the sponsored rail that comes back as a
   * sponsor 5xx, which the SDK must report as `mayHaveLanded: true`, so keep overrides
   * realistic. (On the direct rail the node's "exceeds block gas limit" is a definite
   * refusal.)
   */
  gasLimit?: bigint;
}

/**
 * Puts a batch of calls on chain as one transaction and waits for its receipt.
 *
 * `send` resolves with the receipt, including a reverted one (`status: 'reverted'`: the calls
 * did not take effect, and the nonce was used). It rejects with an `XoError` that always
 * carries `mayHaveLanded`:
 * - `false`: nothing was sent, or the receiver definitely refused it. Safe to fix and retry.
 * - `true` (a `TransactionFailedError`, with `transactionHash` when it is known and the executor
 *   `nonce` it was signed with): the transaction may be on chain. Never send it again:
 *   reconcile first, by its hash or by finding which transaction used that nonce from the
 *   executor.
 *
 * Two nonces must not be confused. A rail uses the executor's account (transaction) nonce.
 * The CTFExchange order nonce (`nonces(maker)`) is another thing: no call a rail sends today
 * changes it, but any SDK path that increments it on chain (for example a call to
 * `incrementNonce()`) must then call `OrderbookClient.refreshNonce()`. Otherwise later orders
 * are signed with the stale nonce, accepted by the gateway, and fail at settlement.
 */
export interface TxRail {
  /** See {@link TxRail}, including the order-nonce rule: call `refreshNonce()` after any call that increments the exchange nonce. */
  send(calls: Call[], o?: SendOptions): Promise<TxResult>;
}

// ---------------------------------------------------------------------------
// Preflight: what a send would refuse, checked before anything is sent (internal)
// ---------------------------------------------------------------------------

/**
 * The preflight of each rail instance: the refusals `send` would make before it reads the
 * chain or calls the sponsor (no `sponsorUrl`, a smart wallet on the direct rail, a signer that
 * cannot sign a digest), and for the sponsored rail the read-only checks it adds (see
 * {@link preflightRail}). Kept in a registry rather than as a method so that no public class
 * or interface gains a member. Internal: not exported from the package.
 */
const preflights = new WeakMap<object, () => void | Promise<void>>();

/** Registers the preflight of `rail`, for {@link preflightRail}. */
export function registerPreflight(
  rail: object,
  check: () => void | Promise<void>,
): void {
  preflights.set(rail, check);
}

/**
 * Runs the checks `rail.send` would make before its calls matter, so a caller that must not
 * spend something one-time before a send (the bridge's funding claim) learns that the send
 * cannot be made before it spends it. Nothing is signed, estimated or sent. The direct rail
 * reads nothing (a facade rail may resolve the trading identity). After its static checks, the
 * sponsored rail (`SponsoredRail`) reads the owner's `'latest'` and `'pending'` nonces, two
 * reads, and refuses while an earlier transaction of the owner may still land (see
 * {@link SponsoredRail}). A rail that registered no checks (a custom {@link TxRail}) passes.
 * An `XoError` leaves with `mayHaveLanded: false`.
 *
 * @throws the error `send` would throw for the same refusal, such as `UserInputError`
 *   `sponsor_not_configured` or `direct_rail_eoa_only`; from the sponsored rail,
 *   `TransactionFailedError` `previous_operation_pending` or `chain_read_failed`.
 */
export async function preflightRail(rail: unknown): Promise<void> {
  const check = isObject(rail) ? preflights.get(rail) : undefined;
  if (check === undefined) {
    return;
  }
  try {
    await check();
  } catch (error) {
    throw error instanceof XoError ? withLanded(error, false) : error;
  }
}

/** What every rail takes. */
export interface RailOptions {
  env: EnvironmentConfig;
  /** Who sends: the owner signs (it is the executor); for a smart wallet, the smart wallet makes the calls. */
  identity: TradingIdentity;
  /** The owner's signer. It needs `signHash` (a private key or a viem local account). */
  signer: InternalSigner;
  chain: ChainReader;
}

/** The options of {@link SponsoredRail}: those of every rail, plus the sponsor's transport. */
export interface SponsoredRailOptions extends RailOptions {
  /**
   * The SDK transport for the sponsor request (the client passes its own, so the request
   * carries its `X-XO-SDK` header and rate-limit reporting). Without it the rail makes one
   * from `env` and `fetch`.
   */
  transport?: Transport;
  /** The `fetch` of the transport the rail makes when no `transport` is given. */
  fetch?: typeof fetch;
}

/** How to reconcile a transaction whose outcome is unknown, for a message. */
function reconcileHint(
  txHash: Hex | undefined,
  nonce: bigint | undefined,
  executor: Address | undefined,
): string {
  const byNonce =
    nonce === undefined
      ? "check the executor's transactions"
      : `check which transaction used nonce ${nonce}${
          executor === undefined ? '' : ` from executor ${executor}`
        }`;
  return txHash === undefined ? byNonce : `wait for ${txHash}, or ${byNonce}`;
}

// ---------------------------------------------------------------------------
// Gas and fees
// ---------------------------------------------------------------------------

function addMargin(gas: bigint): bigint {
  return (gas * BigInt(100 + GAS_MARGIN_PERCENT)) / 100n;
}

function gasEstimationFailed(error: unknown): TransactionFailedError {
  return new TransactionFailedError(
    `Gas estimation failed, so nothing was sent: ${describeFailure(error)}`,
    { mayHaveLanded: false, code: 'gas_estimation_failed', service: 'chain' },
  );
}

/**
 * The intrinsic gas of a plain (EIP-1559) transaction: 21 000, 4 per zero calldata byte and
 * 16 per other byte, plus 32 000 for a contract creation (which a rail never sends). This is
 * the direct rail's floor; the EvNode formula (`estimateIntrinsicGas`) adds 21 000 per call.
 */
function eip1559IntrinsicGas(data: Hex, create = false): bigint {
  let gas = 21_000n + (create ? 32_000n : 0n);
  for (let i = 2; i < data.length; i += 2) {
    gas += data.slice(i, i + 2) === '00' ? 4n : 16n;
  }
  return gas;
}

/** {@link resolveGasLimit} with the floor given. */
async function gasLimitFor(
  chain: ChainReader,
  executor: Address,
  calls: EvCall[],
  floor: bigint,
  override: bigint | undefined,
): Promise<bigint> {
  if (override !== undefined) {
    return override > floor ? override : floor;
  }
  const [only] = calls;
  let estimate: unknown;
  try {
    if (calls.length === 1 && only !== undefined && only.to !== null) {
      estimate = await chain.estimateGas({
        from: executor,
        to: only.to,
        data: only.input,
        value: only.value,
      });
    } else {
      estimate = await chain.simulateBundleGas({
        from: executor,
        calls: calls.map((c) => {
          if (c.to === null) {
            throw new UserInputError('A rail never sends a contract creation');
          }
          return { to: c.to, value: c.value, data: c.input };
        }),
      });
    }
  } catch (error) {
    throw gasEstimationFailed(error);
  }
  if (typeof estimate !== 'bigint' || estimate < 0n) {
    throw gasEstimationFailed(new Error('the estimate is not a bigint'));
  }
  return addMargin(estimate > floor ? estimate : floor);
}

/**
 * The gas limit of an EvNode transaction with `calls` from `executor`.
 *
 * - The intrinsic gas of the calls (`estimateIntrinsicGas`) is a hard floor, even for an
 *   override.
 * - An `override` is used as given (raised to the floor), with no margin and no estimate.
 * - One call: `chain.estimateGas` from the executor. Several (a batch, or a smart wallet deploy
 *   plus `execute`): `chain.simulateBundleGas`, which runs them in order with state carried over.
 * - The larger of the estimate and the floor, plus 25 %.
 *
 * There is no large fallback when the estimate fails: it throws a
 * `TransactionFailedError` (code `gas_estimation_failed`, `mayHaveLanded: false`) and nothing is
 * sent. A guessed limit either reverts out of gas (and the sponsor still pays) or overpays,
 * and a sponsor policy with a per-transaction gas cap would refuse a large one. There is no
 * hard cap in the SDK itself: the sponsor has been seen to accept a 6 000 000 limit.
 * @throws TransactionFailedError with `mayHaveLanded: false` if the estimate or the simulation fails
 *   or does not answer a bigint.
 */
export async function resolveGasLimit(
  chain: ChainReader,
  executor: Address,
  calls: EvCall[],
  override?: bigint,
): Promise<bigint> {
  return gasLimitFor(
    chain,
    executor,
    calls,
    estimateIntrinsicGas(calls),
    override,
  );
}

/** The chain's fees, each raised to {@link MIN_FEE_PER_GAS}, and the cap never below the tip. */
async function resolveFees(
  chain: ChainReader,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const fees = await readChain('getFees', () => chain.getFees());
  if (
    !isObject(fees) ||
    typeof fees.maxFeePerGas !== 'bigint' ||
    typeof fees.maxPriorityFeePerGas !== 'bigint'
  ) {
    throw chainReadFailed('getFees', new Error('not two bigints'));
  }
  const tip =
    fees.maxPriorityFeePerGas > MIN_FEE_PER_GAS
      ? fees.maxPriorityFeePerGas
      : MIN_FEE_PER_GAS;
  const cap = fees.maxFeePerGas > tip ? fees.maxFeePerGas : tip;
  return { maxFeePerGas: cap, maxPriorityFeePerGas: tip };
}

/** A chain read before anything was sent failed: `chain_read_failed`, `mayHaveLanded: false`. */
export function chainReadFailed(
  method: string,
  error: unknown,
): TransactionFailedError {
  return new TransactionFailedError(
    `Reading the chain (${method}) failed, so nothing was sent: ${describeFailure(error)}`,
    { mayHaveLanded: false, code: 'chain_read_failed', service: 'chain' },
  );
}

/** A chain read before anything is sent: any failure means nothing was sent. */
export async function readChain<T>(
  method: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw chainReadFailed(method, error);
  }
}

/**
 * The nonce for the next transaction of `executor` on `chainId`: the chain's `'pending'`
 * count, raised past the last nonce the network accepted from this executor in this process.
 * Call it inside the executor's queued task. The record's clock is read after the count
 * arrives, so the age it compares is never older than the read.
 */
async function claimNonce(
  chain: ChainReader,
  chainId: number,
  executor: Address,
): Promise<bigint> {
  const pending = await readChain('getNonce', () => chain.getNonce(executor));
  if (typeof pending !== 'bigint' || pending < 0n || pending > U64_MAX) {
    throw chainReadFailed('getNonce', new Error('not a u64 bigint'));
  }
  return nextNonce({
    chainId,
    executor,
    pending,
    ttlMs: RECEIPT_TIMEOUT_MS,
  });
}

/**
 * Awaits every read of a send, then throws the first failure (in argument order). Unlike
 * `Promise.all` it never settles while a read is still in flight: a send's task, and so
 * its place in the executor queue, lasts until all of its reads are done, and nothing of a
 * failed task runs after the queue has moved on.
 */
export async function settleAll<A, B, C>(
  a: Promise<A>,
  b: Promise<B>,
  c: Promise<C>,
): Promise<[A, B, C]> {
  const [ra, rb, rc] = await Promise.allSettled([a, b, c]);
  for (const result of [ra, rb, rc]) {
    if (result.status === 'rejected') {
      throw result.reason;
    }
  }
  return [
    (ra as PromiseFulfilledResult<A>).value,
    (rb as PromiseFulfilledResult<B>).value,
    (rc as PromiseFulfilledResult<C>).value,
  ];
}

// ---------------------------------------------------------------------------
// Local checks
// ---------------------------------------------------------------------------

/** A call with every field checked and filled in. */
export interface CheckedCall {
  to: Address;
  value: bigint;
  data: Hex;
}

function byteLength(data: Hex): number {
  return (data.length - 2) / 2;
}

/**
 * Checks the calls before anything is read or signed: an array of 1 to {@link MAX_CALLS}
 * calls, each with a valid `to`, a `uint256` `value` (default 0) and even-length hex `data` of
 * at most {@link MAX_CALLDATA_BYTES} bytes.
 */
export function checkCalls(calls: unknown): CheckedCall[] {
  if (!Array.isArray(calls)) {
    throw new UserInputError('calls must be an array');
  }
  if (calls.length === 0) {
    throw new UserInputError('calls must contain at least one call');
  }
  if (calls.length > MAX_CALLS) {
    throw new UserInputError(
      `calls must contain at most ${MAX_CALLS} calls, not ${calls.length}`,
    );
  }
  const checked: CheckedCall[] = [];
  // A plain loop, not map: map skips the holes of a sparse array.
  for (let i = 0; i < calls.length; i++) {
    const field = `calls[${i}]`;
    const call: unknown = calls[i];
    if (!isObject(call)) {
      throw new UserInputError(`${field} must be an object`);
    }
    const data = assertHexData(call.data, `${field}.data`);
    if (byteLength(data) > MAX_CALLDATA_BYTES) {
      throw new UserInputError(
        `${field}.data is ${byteLength(data)} bytes, over the ${MAX_CALLDATA_BYTES}-byte limit`,
      );
    }
    checked.push({
      to: normalizeAddress(call.to as string, `${field}.to`),
      value:
        call.value === undefined
          ? 0n
          : assertUint(call.value, 256, `${field}.value`),
      data,
    });
  }
  return checked;
}

/** The gas limit override: a bigint in [1, 2^64), the width of the field. No other cap. */
export function checkGasLimit(o: unknown): bigint | undefined {
  if (o === undefined) {
    return undefined;
  }
  if (!isObject(o)) {
    throw new UserInputError('options must be an object');
  }
  const { gasLimit } = o;
  if (gasLimit === undefined) {
    return undefined;
  }
  if (typeof gasLimit !== 'bigint' || gasLimit <= 0n || gasLimit > U64_MAX) {
    throw new UserInputError(
      'gasLimit must be a bigint between 1 and 2^64 - 1 (the width of the field)',
    );
  }
  return gasLimit;
}

/**
 * The raw-hash signing function of the signer, after checking it signs for the owner.
 * @throws UserInputError `signer_mismatch` if the signer is not the identity's owner.
 * @throws SigningError `sign_hash_unsupported` if the signer cannot sign a raw digest.
 */
export function rawSigner(
  signer: InternalSigner,
  identity: TradingIdentity,
): (hash: Hex) => Promise<Hex> {
  if (!isSameAddress(identity.owner, signer.address as string)) {
    throw new UserInputError(
      'signer address is not the owner of the trading identity',
      { code: 'signer_mismatch' },
    );
  }
  const signHash = signer.signHash;
  if (typeof signHash !== 'function') {
    throw new SigningError(
      'On-chain transactions need a signer that can sign a raw 32-byte digest (signHash), and wallet clients (browser or hardware wallets) cannot: use privateKey or signerFrom with a local account',
      { code: 'sign_hash_unsupported' },
    );
  }
  return (hash) => signHash.call(signer, hash);
}

/**
 * Signs `hash` with the owner's raw signer and normalises the signature (low-s, parity),
 * checked to recover to `owner`.
 * @throws SigningError if signing fails, or `signature_mismatch` if the signature does not
 *   recover to `owner`.
 */
export async function signDigest(
  sign: (hash: Hex) => Promise<Hex>,
  hash: Hex,
  owner: Address,
): ReturnType<typeof normalizeExecutorSignature> {
  let signature: unknown;
  try {
    signature = await sign(hash);
  } catch (error) {
    // No cause: a wallet's error is not ours to vouch for.
    throw new SigningError(`signHash failed (${errorName(error)})`);
  }
  return normalizeExecutorSignature(hash, signature, owner);
}

/** The sponsored rail needs the environment's sponsor. @throws UserInputError `sponsor_not_configured`. */
function assertSponsorConfigured(env: EnvironmentConfig): void {
  if (env.sponsorUrl === undefined) {
    throw new UserInputError(
      `The ${env.name} environment has no sponsorUrl, so sponsored transactions are not available`,
      { code: 'sponsor_not_configured', service: 'sponsor' },
    );
  }
}

/** The direct rail sends from an EOA only. @throws UserInputError `direct_rail_eoa_only`. */
function assertEoa(identity: TradingIdentity): void {
  if (identity.type !== 'eoa') {
    throw new UserInputError(
      'DirectRail sends from an EOA only; a smart wallet needs the sponsored rail',
      { code: 'direct_rail_eoa_only' },
    );
  }
}

export function checkIdentity(identity: TradingIdentity): void {
  const { type, owner, address } = identity;
  normalizeAddress(owner as string, 'identity.owner');
  normalizeAddress(address as string, 'identity.address');
  if (type === 'eoa') {
    if (!isSameAddress(owner, address)) {
      throw new UserInputError(
        "identity.address must be the owner for type 'eoa'",
      );
    }
    return;
  }
  if (type === 'smart_wallet') {
    assertUint(identity.index, 256, 'identity.index');
    return;
  }
  throw new UserInputError('identity.type must be "eoa" or "smart_wallet"');
}

export function checkOptions(o: unknown): RailOptions {
  if (!isObject(o)) {
    throw new UserInputError('options must be an object');
  }
  const { env, identity, signer, chain } = o as Partial<RailOptions>;
  if (!isObject(env) || !isObject(env.contracts)) {
    throw new UserInputError('env must be an environment config');
  }
  if (!isObject(identity)) {
    throw new UserInputError('identity must be a trading identity');
  }
  if (!isObject(signer)) {
    throw new UserInputError('signer must be a Signer object');
  }
  const methods = [
    'getNonce',
    'getCode',
    'estimateGas',
    'simulateBundleGas',
    'getFees',
    'readContract',
    'waitForReceipt',
  ] as const;
  if (
    !isObject(chain) ||
    methods.some(
      (m) => typeof (chain as Record<string, unknown>)[m] !== 'function',
    )
  ) {
    throw new UserInputError(
      `chain must be a ChainReader (${methods.join(', ')})`,
    );
  }
  return {
    env: env as EnvironmentConfig,
    identity: identity as TradingIdentity,
    signer: signer as InternalSigner,
    chain: chain as ChainReader,
  };
}

// ---------------------------------------------------------------------------
// The shared ends of a send
// ---------------------------------------------------------------------------

/** What a send has done so far, for the error an unexpected failure becomes. */
export interface SendState {
  /** Set just before the transaction is handed to the sponsor or the network. */
  handedOver: boolean;
  nonce?: bigint;
  executor?: Address;
}

/**
 * Runs one send so that every error leaves with `mayHaveLanded`. `state.handedOver` tells
 * whether the transaction was given to the network (or the sponsor) when an unexpected error
 * escapes.
 */
export async function guarded<T>(
  run: (state: SendState) => Promise<T>,
): Promise<T> {
  const state: SendState = { handedOver: false };
  try {
    return await run(state);
  } catch (error) {
    // Classified where it was raised (a TransactionFailedError, or a sponsor answer).
    if (error instanceof XoError && typeof error.mayHaveLanded === 'boolean') {
      throw error;
    }
    if (error instanceof XoError && !state.handedOver) {
      throw withLanded(error, false);
    }
    throw new TransactionFailedError(
      `The send failed unexpectedly (${errorName(error)})${
        state.handedOver
          ? ` after the transaction was handed over: do not resend it; ${reconcileHint(undefined, state.nonce, state.executor)}`
          : '; nothing was sent'
      }`,
      // No cause: an unexpected error could be a raw RPC error, which can hold the node URL.
      {
        mayHaveLanded: state.handedOver,
        code: 'send_failed',
        nonce: state.handedOver ? state.nonce : undefined,
      },
    );
  }
}

/** A transaction that was handed over: its hash, and the nonce and executor it used. */
interface HandedOver {
  txHash: Hex;
  nonce: bigint;
  executor: Address;
}

/**
 * Waits up to {@link RECEIPT_TIMEOUT_MS} for the receipt of a transaction that was handed
 * over. Every failure here means it may still land: `TransactionFailedError` with `mayHaveLanded:
 * true`, the hash and the nonce (code `receipt_timeout`, or `receipt_unavailable` when the
 * read failed).
 */
async function awaitReceipt(
  chain: ChainReader,
  sent: HandedOver,
): Promise<TxResult> {
  const { txHash, nonce, executor } = sent;
  const hint = reconcileHint(txHash, nonce, executor);
  let receipt: unknown;
  try {
    receipt = await chain.waitForReceipt(txHash, RECEIPT_TIMEOUT_MS);
  } catch (error) {
    const timedOut = error instanceof TimeoutError;
    throw new TransactionFailedError(
      timedOut
        ? `No receipt for ${txHash} after ${RECEIPT_TIMEOUT_MS / 1000} s. It may still land: do not resend it; ${hint}`
        : `Reading the receipt of ${txHash} failed (${describeFailure(error)}). It may have landed: do not resend it; ${hint}`,
      {
        mayHaveLanded: true,
        transactionHash: txHash,
        nonce,
        code: timedOut ? 'receipt_timeout' : 'receipt_unavailable',
        service: 'chain',
      },
    );
  }
  if (
    !isObject(receipt) ||
    typeof receipt.txHash !== 'string' ||
    receipt.txHash.toLowerCase() !== txHash.toLowerCase() ||
    (receipt.status !== 'success' && receipt.status !== 'reverted') ||
    typeof receipt.blockNumber !== 'bigint'
  ) {
    throw new TransactionFailedError(
      `The receipt read for ${txHash} is not a receipt of that transaction. It may have landed: do not resend it; ${hint}`,
      {
        mayHaveLanded: true,
        transactionHash: txHash,
        nonce,
        code: 'receipt_unavailable',
        service: 'chain',
      },
    );
  }
  return { txHash, status: receipt.status, blockNumber: receipt.blockNumber };
}

/** `validateEvTx` throws plain errors; locally they are a UserInputError. */
function checkEvTx(tx: EvTx): void {
  try {
    validateEvTx(tx);
  } catch (error) {
    throw new UserInputError(
      error instanceof Error ? error.message : 'invalid transaction',
    );
  }
}

// ---------------------------------------------------------------------------
// Deploying a smart wallet (shared by the rails that send for one)
// ---------------------------------------------------------------------------

/** The address word `eth_call` answers for `createAccount`. */
const ADDRESS_WORD_PATTERN = /^0x0{24}[0-9a-fA-F]{40}$/;

/**
 * What deploys a smart wallet that has no code yet: the environment's `kernelFactory` and the
 * `createAccount` calldata for the identity's owner and index. `undefined` when the smart wallet
 * has code (the `isEmptyCode` rule). The sponsored rail decides with it, and makes it a
 * top-level call. Internal.
 *
 * Before the deploy is sent, the factory is asked (`eth_call`) where it would deploy, and that must
 * be the smart wallet the calls are for. Otherwise the calls would go to an empty address and
 * "succeed" without doing anything.
 * @throws TransactionFailedError `chain_read_failed` (`mayHaveLanded: false`) if a read fails.
 * @throws UserInputError `smart_wallet_address_mismatch` if the factory would deploy another
 *   address.
 */
export async function smartWalletDeploy(
  chain: ChainReader,
  env: EnvironmentConfig,
  identity: TradingIdentity,
): Promise<{ factory: Address; factoryData: Hex } | undefined> {
  const account = normalizeAddress(identity.address);
  const code = await readChain('getCode', () => chain.getCode(account));
  if (typeof code !== 'string') {
    throw chainReadFailed('getCode', new Error('not hex'));
  }
  if (!isEmptyCode(code)) {
    return undefined;
  }
  const factory = normalizeAddress(env.contracts.kernelFactory);
  const factoryData = kernelCreateAccountCalldata(
    identity.owner,
    identity.index as bigint,
    env.contracts.ecdsaValidator,
  );
  const predicted = await readChain('readContract', () =>
    chain.readContract({ to: factory, data: factoryData }),
  );
  if (
    typeof predicted !== 'string' ||
    !ADDRESS_WORD_PATTERN.test(predicted) ||
    !isSameAddress(`0x${predicted.slice(-40)}`, account)
  ) {
    throw new UserInputError(
      `The smart wallet factory would not deploy ${account} for this owner and index, so the smart wallet cannot be deployed with this identity; nothing was sent`,
      { code: 'smart_wallet_address_mismatch', service: 'chain' },
    );
  }
  return { factory, factoryData };
}

// ---------------------------------------------------------------------------
// The sponsored rail's pre-claim guard
// ---------------------------------------------------------------------------

/** A nonce read that must be a u64 bigint. */
function checkNonceRead(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) {
    throw chainReadFailed('getNonce', new Error('not a u64 bigint'));
  }
  return value;
}

/** An earlier transaction of `owner` with `nonce` may still land: nothing was sent. */
function earlierPending(
  owner: Address,
  nonce: bigint,
  why: string,
): TransactionFailedError {
  return new TransactionFailedError(
    `An earlier transaction of the account on the sponsored rail may still land: ${why}. Nothing was sent: wait until it is mined (the latest nonce of executor ${owner} passes ${nonce}), or check which transaction used nonce ${nonce} from ${owner}, then try again`,
    {
      mayHaveLanded: false,
      code: 'previous_operation_pending',
      service: 'chain',
      nonce,
    },
  );
}

/**
 * The pre-claim guard: refuses while an earlier transaction of `owner` (the executor) on
 * `chainId` may still land. Two reads, the owner's `'latest'` and `'pending'` nonces:
 *
 * - `pending > latest`: a transaction of the owner is in the mempool (the one with nonce
 *   `latest` is next to be mined);
 * - otherwise, this process handed over a transaction of the owner whose nonce the chain has not
 *   passed (`latest` is not above it): accepted with no receipt yet, or an unknown outcome.
 *
 * @throws TransactionFailedError `previous_operation_pending` (`mayHaveLanded: false`, the nonce) or
 *   `chain_read_failed`.
 */
async function assertNoEarlierPending(
  chain: ChainReader,
  chainId: number,
  owner: Address,
): Promise<void> {
  // Both reads start at once, latest first, and both settle before anything is decided.
  const [latestRead, pendingRead] = await settleAll(
    readChain('getNonce', () => chain.getNonce(owner, 'latest')),
    readChain('getNonce', () => chain.getNonce(owner, 'pending')),
    Promise.resolve(undefined),
  );
  const latest = checkNonceRead(latestRead);
  const pending = checkNonceRead(pendingRead);
  if (pending > latest) {
    throw earlierPending(
      owner,
      latest,
      `a transaction of executor ${owner} with nonce ${latest} is in the mempool (its pending nonce is ${pending}, its latest ${latest})`,
    );
  }
  const handed = lastHandedOver({ chainId, executor: owner });
  if (handed !== undefined && handed >= latest) {
    throw earlierPending(
      owner,
      handed,
      `this process handed over the transaction of executor ${owner} with nonce ${handed}, and the chain's latest nonce, ${latest}, has not passed it`,
    );
  }
}

// ---------------------------------------------------------------------------
// SponsoredRail
// ---------------------------------------------------------------------------

/**
 * The default rail on an environment with a `sponsorUrl` (`mainnet` has one), for both wallet
 * types: an EvNode `0x76` transaction that the owner EOA signs as executor and the sponsor
 * (`POST /v1/sponsor/send`) pays for and broadcasts.
 *
 * - EOA: the calls are the top-level calls of the transaction, made by the owner.
 * - Smart wallet: one top-level call to `account.execute(...)` (ERC-7579; the smart wallet
 *   makes the calls, the owner is still the executor). If the smart wallet has no code yet, a
 *   top-level `factory.createAccount(...)` call goes first, in the same transaction, after
 *   checking that the factory would deploy exactly this smart wallet (otherwise `execute`
 *   would hit an empty address and "succeed" without doing anything). Two sends racing before
 *   the first is mined both prepend it; the factory returns the existing smart wallet the
 *   second time.
 * - Nonce: `max(the owner's 'pending' count, the last nonce accepted from the owner + 1)`,
 *   computed for every send: an RPC whose pending count lags behind the sponsor's node
 *   cannot make the next send reuse a nonce. The record is shared by every rail of the owner
 *   on the chain, advanced only when the sponsor answers 2xx with a valid hash and the right
 *   executor (or a raw broadcast succeeds), and ignored once it is 120 s
 *   old (on one process-wide monotonic clock). Sends from the same owner run one at a time
 *   (one queue per owner): nonce, sign and hand over, then the next. A send's task
 *   waits for all of its reads, even after one failed, before it gives up its place.
 *   The receipt wait is outside the queue. The queue and the record are **per process**:
 *   two processes sending from one owner are not coordinated, can pick the same nonce, and
 *   the loser's send then fails as ambiguous (`mayHaveLanded: true`). Give each process its
 *   own wallet, or serialize one wallet's sends outside the SDK.
 * - Gas: the larger of an estimate (a bundle simulation for several calls) and the calls'
 *   intrinsic gas, plus 25 %; or the `gasLimit` you pass, raised to that floor. Fees: the
 *   chain's, at least 1 gwei each.
 * - The executor signs `executorSigningHash(tx)` raw (no EIP-191 prefix) with `signHash`; the
 *   signature is reduced to low-s and checked to recover to the owner before it is sent.
 *   Everything signed is built here: nothing from a server is signed.
 * - **The preflight, a pre-claim guard.** `bridge.withdraw()` runs the rail's preflight before
 *   it confirms a quote and spends its one-time funding claim. After the static refusals (no
 *   `sponsorUrl`, a bad identity, a signer that cannot sign a digest; nothing read), it reads the
 *   owner's (the executor's) `'latest'` and `'pending'` nonces, and refuses with
 *   `TransactionFailedError` `previous_operation_pending` (`mayHaveLanded: false`, the `nonce`) while an
 *   earlier transaction of the owner may still land: one is in the mempool (`pending > latest`),
 *   or this process handed one over (accepted, or with an unknown outcome) whose nonce the chain
 *   has not passed yet (`latest` not above it). A send the sponsor or the node refused for sure
 *   (`mayHaveLanded: false`) is taken off that record at once: it cannot land. Every sponsored and
 *   direct rail of the owner on the chain shares the record, for as long as the process runs. A failed read is
 *   `chain_read_failed`. Sends themselves never make this check: their nonce rule is the one
 *   above.
 *
 * How a send fails (see {@link TxRail} for the `mayHaveLanded` contract):
 *
 * | stage | error | mayHaveLanded |
 * | --- | --- | --- |
 * | no `sponsorUrl` | `UserInputError` `sponsor_not_configured` | false |
 * | bad calls, options or identity; signer not the owner | `UserInputError` | false |
 * | signer without `signHash`; signing fails | `SigningError` | false |
 * | a chain read fails | `TransactionFailedError` `chain_read_failed` | false |
 * | gas estimate or simulation fails | `TransactionFailedError` `gas_estimation_failed` | false |
 * | sponsor answers 4xx (403 `policy_rejected`, ...) | the parsed error (`RequestRejectedError`, ...) | false |
 * | sponsor timeout, network error, 5xx, unreadable 2xx | `TransactionFailedError` `sponsor_outcome_unknown`, with nonce, no hash | true |
 * | sponsor names another executor | `TransactionFailedError` `executor_mismatch`, with hash and nonce | true |
 * | no receipt after 120 s, or the read fails | `TransactionFailedError` `receipt_timeout` / `receipt_unavailable`, with hash and nonce | true |
 *
 * Nothing is ever resent.
 *
 * Internal: an engine behind the two clients. No entry of the package exports it.
 */
export class SponsoredRail implements TxRail {
  readonly #env: EnvironmentConfig;
  readonly #identity: TradingIdentity;
  readonly #signer: InternalSigner;
  readonly #chain: ChainReader;
  readonly #transport: Transport;
  /** Set once the smart wallet was seen deployed (deployment cannot be undone). */
  #deployed = false;

  /** @throws UserInputError if an option is missing or of the wrong kind. */
  constructor(o: SponsoredRailOptions) {
    const { env, identity, signer, chain } = checkOptions(o);
    this.#env = env;
    this.#identity = identity;
    this.#signer = signer;
    this.#chain = chain;
    if (o.transport !== undefined && !(o.transport instanceof Transport)) {
      throw new UserInputError('transport must be a Transport');
    }
    this.#transport =
      o.transport ??
      new Transport({ env, version: SDK_VERSION, fetch: o.fetch });
    registerPreflight(this, async () => {
      assertSponsorConfigured(env);
      checkIdentity(identity);
      rawSigner(signer, identity);
      await assertNoEarlierPending(
        chain,
        env.chainId,
        normalizeAddress(identity.owner),
      );
    });
  }

  /**
   * Builds, signs and sends one sponsored transaction, then waits for its receipt. See
   * {@link TxRail} for what it resolves and throws, and the order-nonce rule: after any call
   * that increments the exchange order nonce, call `OrderbookClient.refreshNonce()`.
   */
  send(calls: Call[], o?: SendOptions): Promise<TxResult> {
    return guarded((state) => this.#send(calls, o, state));
  }

  async #send(
    calls: Call[],
    o: SendOptions | undefined,
    state: SendState,
  ): Promise<TxResult> {
    const env = this.#env;
    assertSponsorConfigured(env);
    const identity = this.#identity;
    checkIdentity(identity);
    const sign = rawSigner(this.#signer, identity);
    const checked = checkCalls(calls);
    const gasOverride = checkGasLimit(o);
    const owner = normalizeAddress(identity.owner);
    state.executor = owner;

    // The top-level calls, without a possible deploy call (that needs a chain read).
    const main: EvCall[] =
      identity.type === 'smart_wallet'
        ? [this.#executeCall(identity, checked)]
        : checked.map((c) => ({ to: c.to, value: c.value, input: c.data }));

    const sent = await serializeByExecutor(owner, async () => {
      const top =
        identity.type === 'smart_wallet'
          ? [...(await this.#deployCalls(identity)), ...main]
          : main;
      const chain = this.#chain;
      const [nonce, gasLimit, fees] = await settleAll(
        claimNonce(chain, env.chainId, owner),
        resolveGasLimit(chain, owner, top, gasOverride),
        resolveFees(chain),
      );
      const tx: EvTx = {
        chainId: BigInt(env.chainId),
        nonce,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        maxFeePerGas: fees.maxFeePerGas,
        gasLimit,
        calls: top,
        accessList: [],
      };
      checkEvTx(tx);
      const hash = executorSigningHash(tx);
      const { canonical } = await signDigest(sign, hash, owner);

      state.nonce = nonce;
      state.handedOver = true;
      const unmarkHandedOver = markHandedOver({
        chainId: env.chainId,
        executor: owner,
        nonce,
      });
      let answer: Awaited<ReturnType<typeof sponsorSend>>;
      try {
        answer = await sponsorSend(
          this.#transport,
          { tx: toSponsorTx(tx), executorSignature: canonical },
          { executor: owner },
        );
      } catch (error) {
        // A definite refusal (a 4xx: `mayHaveLanded: false`) cannot land: take it off the
        // handed-over record, or the pre-claim guard would hold withdraw() back for nothing.
        // Exact, because one executor's sends run one at a time (this queued task): no other
        // mark of the owner came in between.
        if (error instanceof XoError && error.mayHaveLanded === false) {
          unmarkHandedOver();
        }
        throw error;
      }
      if (
        answer.executor !== undefined &&
        !isSameAddress(answer.executor, owner)
      ) {
        // Not recorded as accepted: whatever landed, it used the nonce of the account the
        // sponsor recovered, not the owner's. That is the account to check.
        throw new TransactionFailedError(
          `The sponsor recovered executor ${answer.executor}, not the owner ${owner}: the transaction was broadcast as another account. Do not resend it; ${reconcileHint(answer.txHash, nonce, answer.executor)}`,
          {
            mayHaveLanded: true,
            transactionHash: answer.txHash,
            nonce,
            code: 'executor_mismatch',
            service: 'sponsor',
          },
        );
      }
      // Accepted: the next send uses at least nonce + 1, whatever the RPC's pending count says.
      markAccepted({ chainId: env.chainId, executor: owner, nonce });
      return { txHash: answer.txHash, nonce, executor: owner };
    });

    return awaitReceipt(this.#chain, sent);
  }

  /** `account.execute(calls)` as one top-level call, checked against the calldata limit. */
  #executeCall(identity: TradingIdentity, calls: CheckedCall[]): EvCall {
    const input = kernelExecuteCalldata(calls);
    if (byteLength(input) > MAX_CALLDATA_BYTES) {
      throw new UserInputError(
        `calls: the smart wallet's execute calldata is ${byteLength(input)} bytes, over the ${MAX_CALLDATA_BYTES}-byte limit; send fewer or smaller calls`,
      );
    }
    return { to: normalizeAddress(identity.address), value: 0n, input };
  }

  /** `[factory.createAccount(...)]` when the smart wallet has no code, `[]` when it has. */
  async #deployCalls(identity: TradingIdentity): Promise<EvCall[]> {
    if (this.#deployed) {
      return [];
    }
    const deploy = await smartWalletDeploy(this.#chain, this.#env, identity);
    if (deploy === undefined) {
      this.#deployed = true;
      return [];
    }
    return [{ to: deploy.factory, value: 0n, input: deploy.factoryData }];
  }
}

// ---------------------------------------------------------------------------
// DirectRail
// ---------------------------------------------------------------------------

/**
 * A normal EIP-1559 transaction that the owner EOA signs and pays for, broadcast with
 * `chain.sendRawTransaction`. A fallback for when no sponsor is available; the owner needs
 * native gas.
 *
 * - EOA only: a smart wallet identity is refused (`UserInputError` `direct_rail_eoa_only`).
 * - One call per send. A transaction of this kind carries one call, and splitting a batch into
 *   several transactions would make it non-atomic (a failure halfway leaves the first calls
 *   applied and the rest not), so a batch of two or more is refused
 *   (`UserInputError` `direct_rail_single_call`). Send the calls one by one, or leave the
 *   secure client's `rail` option out: a batch then goes in one transaction, through
 *   the sponsored rail, where the environment has a sponsor (either wallet type). An
 *   `AccountClient.setup()` that needs two or more actions fails here.
 * - The transaction is built and signed here: `signHash` over its signing hash, low-s, checked
 *   to recover to the owner. Its hash is known before it is broadcast.
 * - Gas: as on the sponsored rail, but the floor is the plain EIP-1559 intrinsic gas
 *   (21 000 plus calldata), not the EvNode one.
 * - Nonce, fees and the queue are those of {@link SponsoredRail}, and the queue and the
 *   accepted-nonce record are shared, so the two rails never race on one owner's nonce. A
 *   successful broadcast (including the node's "already known") counts as accepted.
 *
 * Failures are those of {@link SponsoredRail} up to signing. Then (sorted by the chain reader):
 * - "already known": an acceptance; the receipt of the local hash is awaited.
 * - "nonce too low" (code `nonce_too_low` from the reader): the nonce is used, possibly by this
 *   very transaction (a load balancer can retry upstream, and blocks are sub-second). The local
 *   hash is looked up (`chain.getTransaction`): found, pending or mined, it is an acceptance;
 *   not found, or the lookup fails or is missing, it is a `TransactionFailedError`
 *   `nonce_already_used` with `mayHaveLanded: true`, the hash and the nonce.
 * - A definite refusal (insufficient funds, underpriced, ...): `TransactionFailedError`
 *   `rejected_by_node` with `mayHaveLanded: false`.
 * - Anything else: `TransactionFailedError` `broadcast_outcome_unknown` with `mayHaveLanded: true`,
 *   the hash and the nonce.
 *
 * The receipt wait fails as on the sponsored rail. Nothing is ever rebroadcast.
 *
 * Internal: an engine behind the two clients. No entry of the package exports it.
 */
export class DirectRail implements TxRail {
  readonly #env: EnvironmentConfig;
  readonly #identity: TradingIdentity;
  readonly #signer: InternalSigner;
  readonly #chain: ChainReader;
  readonly #broadcast: (raw: Hex) => Promise<Hex>;

  /** @throws UserInputError if an option is missing, or the chain reader has no `sendRawTransaction`. */
  constructor(o: RailOptions) {
    const { env, identity, signer, chain } = checkOptions(o);
    const broadcast = chain.sendRawTransaction;
    if (typeof broadcast !== 'function') {
      throw new UserInputError(
        'DirectRail needs a chain reader with sendRawTransaction (createChainReader has it)',
      );
    }
    this.#env = env;
    this.#identity = identity;
    this.#signer = signer;
    this.#chain = chain;
    this.#broadcast = (raw) => broadcast.call(chain, raw);
    registerPreflight(this, () => {
      checkIdentity(identity);
      assertEoa(identity);
      rawSigner(signer, identity);
    });
  }

  /**
   * Builds, signs and broadcasts one EIP-1559 transaction, then waits for its receipt. See
   * {@link TxRail} for what it resolves and throws, and the order-nonce rule: after any call
   * that increments the exchange order nonce, call `OrderbookClient.refreshNonce()`.
   */
  send(calls: Call[], o?: SendOptions): Promise<TxResult> {
    return guarded((state) => this.#send(calls, o, state));
  }

  /** Whether the node knows `txHash`, pending or mined. A missing method or a failed lookup is "no". */
  async #knows(txHash: Hex): Promise<boolean> {
    const lookup = this.#chain.getTransaction;
    if (typeof lookup !== 'function') {
      return false;
    }
    try {
      return (await lookup.call(this.#chain, txHash)) === 'found';
    } catch {
      return false;
    }
  }

  async #send(
    calls: Call[],
    o: SendOptions | undefined,
    state: SendState,
  ): Promise<TxResult> {
    const identity = this.#identity;
    checkIdentity(identity);
    assertEoa(identity);
    const sign = rawSigner(this.#signer, identity);
    const checked = checkCalls(calls);
    const [only] = checked;
    if (checked.length !== 1 || only === undefined) {
      throw new UserInputError(
        `DirectRail sends one call per transaction, not ${checked.length}: send them one by one, or leave the rail option out of createSecureClient, so that a batch goes in one transaction (through the sponsor, where the environment has one)`,
        { code: 'direct_rail_single_call' },
      );
    }
    const gasOverride = checkGasLimit(o);
    const owner = normalizeAddress(identity.owner);
    state.executor = owner;
    const chain = this.#chain;
    const chainId = this.#env.chainId;

    const sent = await serializeByExecutor(owner, async () => {
      const [nonce, gas, fees] = await settleAll(
        claimNonce(chain, chainId, owner),
        gasLimitFor(
          chain,
          owner,
          [{ to: only.to, value: only.value, input: only.data }],
          eip1559IntrinsicGas(only.data),
          gasOverride,
        ),
        resolveFees(chain),
      );
      if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw chainReadFailed('getNonce', new Error('nonce too large'));
      }
      const request: TransactionSerializableEIP1559 = {
        type: 'eip1559',
        chainId,
        nonce: Number(nonce),
        to: only.to,
        value: only.value,
        data: only.data,
        gas,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      };
      const hash = keccak256(serializeTransaction(request));
      const { exec } = await signDigest(sign, hash, owner);
      const raw = serializeTransaction(request, {
        r: exec.r,
        s: exec.s,
        yParity: exec.yParity,
      });
      const txHash = keccak256(raw);

      state.nonce = nonce;
      state.handedOver = true;
      const unmarkHandedOver = markHandedOver({
        chainId,
        executor: owner,
        nonce,
      });
      try {
        // The reader resolves for "already known" too: the node has the transaction.
        await this.#broadcast(raw);
      } catch (error) {
        if (
          error instanceof TransactionFailedError &&
          error.code === 'nonce_too_low'
        ) {
          // The nonce is used, maybe by this very transaction (an RPC load balancer can
          // retry upstream, and blocks are sub-second). Only the node knowing our hash tells.
          if (!(await this.#knows(txHash))) {
            throw new TransactionFailedError(
              `The node says nonce ${nonce} is already used, and it does not know ${txHash}. Another transaction may have used it, or this one landed where the lookup cannot see it: do not resend it; ${reconcileHint(txHash, nonce, owner)}`,
              {
                mayHaveLanded: true,
                transactionHash: txHash,
                nonce,
                code: 'nonce_already_used',
                service: 'chain',
              },
            );
          }
          // Found, pending or mined: it is ours. Accepted below.
        } else if (
          error instanceof TransactionFailedError &&
          !error.mayHaveLanded
        ) {
          // A definite refusal of the node cannot land: off the handed-over record (exact, as
          // on the sponsored rail: one executor's sends run one at a time).
          unmarkHandedOver();
          throw new TransactionFailedError(error.message, {
            mayHaveLanded: false,
            transactionHash: txHash,
            nonce,
            code: error.code,
            service: 'chain',
          });
        } else {
          throw new TransactionFailedError(
            `Broadcasting ${txHash} failed (${describeFailure(error)}). It may have reached the network: do not resend it; ${reconcileHint(txHash, nonce, owner)}`,
            {
              mayHaveLanded: true,
              transactionHash: txHash,
              nonce,
              code: 'broadcast_outcome_unknown',
              service: 'chain',
            },
          );
        }
      }
      markAccepted({ chainId, executor: owner, nonce });
      return { txHash, nonce, executor: owner };
    });

    return awaitReceipt(chain, sent);
  }
}
