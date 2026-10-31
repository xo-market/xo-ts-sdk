import {
  type Address,
  BaseError,
  createPublicClient,
  type Hex,
  http,
  keccak256,
  RpcRequestError,
  WaitForTransactionReceiptTimeoutError,
} from 'viem';
import type { EnvironmentConfig } from '../core/env';
import {
  TimeoutError,
  TransactionFailedError,
  UserInputError,
  XoError,
} from '../core/errors';
import type { ContractReader } from '../orderbook/internal';
import type { Call } from '../signing/kernel';
import { errorName, isObject } from '../wallet/internal';

/** A mined transaction. A revert is a result, not an error: check `status`. */
export interface TxResult {
  txHash: Hex;
  status: 'success' | 'reverted';
  blockNumber: bigint;
}

/**
 * Everything the SDK reads from (and, for `DirectRail`, sends to) the chain. It extends the
 * `readContract`-only reader the orderbook client and `resolveMarket` take, so one
 * {@link createChainReader} serves the orderbook client, market resolution and the rails.
 *
 * An implementation should throw SDK errors (`XoError`) whose messages are safe to show: the
 * rails quote the message of an `XoError` and only the name of anything else, because a raw
 * RPC error can carry the node URL and that URL can hold an API key.
 */
export interface ChainReader extends ContractReader {
  /**
   * The account nonce: `eth_getTransactionCount(address, blockTag)`. `'pending'` (the default) is
   * the nonce for the next transaction, the transactions in the mempool included; `'latest'`
   * counts mined transactions only. The sponsored rail's preflight compares the two: a reader of
   * your own that ignores `blockTag` disables that check.
   */
  getNonce(address: Address, blockTag?: 'pending' | 'latest'): Promise<bigint>;
  /** The code at `address`; `'0x'` when there is none. */
  getCode(address: Address): Promise<Hex>;
  /** `eth_estimateGas` for one call from `from`. */
  estimateGas(o: {
    from: Address;
    to: Address;
    data: Hex;
    value: bigint;
  }): Promise<bigint>;
  /**
   * The gas a sequence of calls from `from` uses when run one after another with state carried
   * between them (`eth_simulateV1`, through viem `simulateCalls`): the sum per call. It must
   * reject if any call reverts, so an under-provisioned limit never reaches the wire.
   *
   * This is how a batch is sized. A deploy-prefixed smart wallet batch cannot be estimated
   * call by call: `execute` on the still-codeless smart wallet is a no-op (about 21 000 gas),
   * while in the bundle the first call deploys the smart wallet and `execute` then runs
   * against its code.
   */
  simulateBundleGas(o: { from: Address; calls: Call[] }): Promise<bigint>;
  /** EIP-1559 fees from the latest block. */
  getFees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  /**
   * Waits for the receipt of `hash`.
   * @throws TimeoutError when there is none after `timeoutMs`.
   */
  waitForReceipt(hash: Hex, timeoutMs: number): Promise<TxResult>;
  /**
   * Broadcasts a signed transaction (`eth_sendRawTransaction`), once, and resolves with its
   * hash. Only `DirectRail` uses it, and it trusts the outcome this method reports, so an
   * implementation must sort a failure into one of four, matching the
   * node's text case-insensitively:
   * - **Taken:** the node says the transaction is already in its pool ("already known",
   *   "known transaction", "already imported", each as whole words: "unknown transaction
   *   type" is not one). Resolve with the hash of `raw`: it was accepted, and its receipt is
   *   awaited like any other.
   * - **Nonce too low:** throw a `TransactionFailedError` with code `nonce_too_low` and
   *   `mayHaveLanded: true`. The nonce is used, but possibly by this very transaction (an RPC
   *   load balancer may have retried upstream, and blocks are sub-second), so it is not a
   *   refusal: `DirectRail` looks the hash up with {@link ChainReader.getTransaction}.
   * - **Definitely refused:** throw a `TransactionFailedError` with `mayHaveLanded: false`. Only for
   *   an answer that proves the node did not take it: insufficient funds, intrinsic gas too
   *   low, (replacement) transaction underpriced, max fee per gas less than block base fee,
   *   exceeds block gas limit, invalid sender, invalid chain id, transaction type not
   *   supported.
   * - **Unknown:** throw anything else. Every other answer counts: a JSON-RPC `-32603`, a
   *   gateway timeout that comes back as a JSON-RPC error, an HTTP failure, unknown text.
   *   Claiming "refused" when it is not invites the caller to send the call a second time.
   */
  sendRawTransaction?(raw: Hex): Promise<Hex>;
  /**
   * Whether the node knows the transaction `hash`, pending or mined
   * (`eth_getTransactionByHash`): `'found'` or `'not_found'`. `DirectRail` uses it after a
   * "nonce too low" to tell its own landed transaction from another one. Throw when the
   * lookup itself fails; the rail then treats the outcome as unknown.
   */
  getTransaction?(hash: Hex): Promise<'found' | 'not_found'>;
}

/** Per JSON-RPC request. */
const RPC_TIMEOUT_MS = 15_000;
/** How often a receipt wait polls. */
const POLLING_INTERVAL_MS = 1_000;
/** The longest wait `setTimeout` can hold (a signed 32-bit number of milliseconds). */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
/** Node-supplied text kept in a message, at most. */
const MAX_DETAIL_CHARS = 300;

function clip(text: string): string {
  return text.length > MAX_DETAIL_CHARS
    ? `${text.slice(0, MAX_DETAIL_CHARS)}...`
    : text;
}

/**
 * A failed RPC as an SDK error. viem's `shortMessage` names the failure (a revert reason, "HTTP
 * request failed.") without the URL, which viem keeps in `details` and `metaMessages`. There is
 * no `cause`, so nothing that holds the URL travels with the error.
 */
function chainFailure(method: string, error: unknown): XoError {
  const detail =
    error instanceof BaseError ? clip(error.shortMessage) : errorName(error);
  return new XoError(`${method} failed: ${detail}`, {
    code: 'chain_rpc_failed',
    service: 'chain',
  });
}

/**
 * Node answers meaning the transaction is already in the pool: it was taken. Anchored on a word
 * boundary, so "unknown transaction type" is not one of them.
 */
const ALREADY_TAKEN =
  /\balready known\b|\bknown transaction\b|\balready imported\b/i;

/**
 * "Nonce too low": the nonce is used, but maybe by this very transaction. Not a refusal:
 * the caller looks the hash up.
 */
const NONCE_TOO_LOW = /\bnonce too low\b/i;

/** Node answers that prove the transaction was not taken. Anything else is unknown. */
const DEFINITELY_REFUSED =
  /insufficient funds|intrinsic gas too low|underpriced|max fee per gas less than block base fee|exceeds block gas limit|invalid sender|invalid chain id|(?:tx|transaction) type not supported/i;

/**
 * The texts a failure carries, down its `cause` chain: viem's short message and details (the
 * node's own message for a JSON-RPC error), or the `message` of anything else. viem's full
 * `message` is skipped: it holds the URL.
 */
function failureTexts(error: unknown): string[] {
  const texts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 10 && isObject(current); depth++) {
    if (current instanceof BaseError) {
      texts.push(current.shortMessage);
      if (typeof current.details === 'string') {
        texts.push(current.details);
      }
    } else if (typeof current.message === 'string') {
      texts.push(current.message);
    }
    current = current.cause;
  }
  return texts;
}

/**
 * What a failed `eth_sendRawTransaction` means, matched case-insensitively on the
 * messages and details of the error chain, in this order: `taken` (already known),
 * `nonceTooLow`, `refused` (a definite rejection, with the text that says so) or `unknown`.
 */
function classifyBroadcastFailure(
  error: unknown,
):
  | { kind: 'taken' }
  | { kind: 'nonceTooLow' }
  | { kind: 'refused'; text: string }
  | { kind: 'unknown' } {
  const texts = failureTexts(error);
  if (texts.some((text) => ALREADY_TAKEN.test(text))) {
    return { kind: 'taken' };
  }
  if (texts.some((text) => NONCE_TOO_LOW.test(text))) {
    return { kind: 'nonceTooLow' };
  }
  const refusal = texts.find((text) => DEFINITELY_REFUSED.test(text));
  return refusal === undefined
    ? { kind: 'unknown' }
    : { kind: 'refused', text: refusal };
}

/** Runs one RPC, turning any failure into {@link chainFailure}. */
async function rpc<T>(method: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw chainFailure(method, error);
  }
}

/**
 * A {@link ChainReader} on `env.rpcUrl`: a viem public client with `ccipRead: false`, so no
 * contract can make the SDK follow an off-chain lookup. Reads use viem's default retries;
 * `sendRawTransaction` goes through its own client with no retry, so a signed transaction is
 * sent once.
 *
 * Every failure is an `XoError` (code `chain_rpc_failed`, service `chain`) whose message holds
 * viem's short message only, never the RPC URL; `waitForReceipt` throws a `TimeoutError` when
 * it runs out of time. `sendRawTransaction` sorts a failure as the `ChainReader` contract
 * says: "already known" resolves with the hash of the bytes, "nonce too low" is a
 * `TransactionFailedError` `nonce_too_low` (`mayHaveLanded: true`), a definite rejection a
 * `TransactionFailedError` with `mayHaveLanded: false`, and anything else an `XoError`.
 * `getTransaction` answers `'found'` or `'not_found'` from `eth_getTransactionByHash`.
 * @throws UserInputError if `env` has no `rpcUrl`.
 *
 * Internal: an engine behind the two clients. No entry of the package exports it.
 */
export function createChainReader(env: EnvironmentConfig): ChainReader {
  if (!isObject(env) || typeof env.rpcUrl !== 'string') {
    throw new UserInputError(
      'env must be an environment config with an rpcUrl',
    );
  }
  const client = createPublicClient({
    transport: http(env.rpcUrl, { timeout: RPC_TIMEOUT_MS }),
    ccipRead: false,
    pollingInterval: POLLING_INTERVAL_MS,
  });
  const writer = createPublicClient({
    transport: http(env.rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: 0 }),
    ccipRead: false,
  });

  return Object.freeze({
    async readContract({ to, data }: { to: Address; data: Hex }) {
      const result = await rpc('eth_call', () => client.call({ to, data }));
      return result.data ?? '0x';
    },

    async getNonce(
      address: Address,
      blockTag: 'pending' | 'latest' = 'pending',
    ) {
      const count = await rpc('eth_getTransactionCount', () =>
        client.getTransactionCount({ address, blockTag }),
      );
      return BigInt(count);
    },

    async getCode(address: Address) {
      const code = await rpc('eth_getCode', () => client.getCode({ address }));
      return code ?? '0x';
    },

    async estimateGas(o: {
      from: Address;
      to: Address;
      data: Hex;
      value: bigint;
    }) {
      return rpc('eth_estimateGas', () =>
        client.estimateGas({
          account: o.from,
          to: o.to,
          data: o.data,
          value: o.value,
        }),
      );
    },

    async simulateBundleGas({ from, calls }: { from: Address; calls: Call[] }) {
      const { results } = await rpc('eth_simulateV1', () =>
        client.simulateCalls({
          account: from,
          calls: calls.map((c) => ({
            to: c.to,
            data: c.data,
            value: c.value ?? 0n,
          })),
        }),
      );
      if (results.length !== calls.length) {
        throw new XoError(
          `eth_simulateV1 answered ${results.length} results for ${calls.length} calls`,
          { code: 'chain_rpc_failed', service: 'chain' },
        );
      }
      let total = 0n;
      results.forEach((result, i) => {
        if (result.status !== 'success') {
          throw new XoError(
            `eth_simulateV1: calls[${i}] reverted in simulation, so the batch cannot be sized`,
            { code: 'bundle_simulation_reverted', service: 'chain' },
          );
        }
        // A node that reports the peak (before refunds) is the safer figure.
        const peak = (result as { maxUsedGas?: bigint }).maxUsedGas;
        total +=
          typeof peak === 'bigint' && peak > result.gasUsed
            ? peak
            : result.gasUsed;
      });
      return total;
    },

    async getFees() {
      const fees = await rpc('fee estimation', () =>
        client.estimateFeesPerGas(),
      );
      return {
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      };
    },

    async waitForReceipt(hash: Hex, timeoutMs: number): Promise<TxResult> {
      if (
        !Number.isInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > MAX_TIMEOUT_MS
      ) {
        throw new UserInputError(
          `timeoutMs must be a whole number of milliseconds between 1 and ${MAX_TIMEOUT_MS}`,
        );
      }
      try {
        // No replacement detection: a replacement's receipt is not this transaction's result.
        // A replaced transaction runs into the timeout, and the caller reconciles.
        const receipt = await client.waitForTransactionReceipt({
          hash,
          timeout: timeoutMs,
          checkReplacement: false,
        });
        return {
          txHash: receipt.transactionHash,
          status: receipt.status,
          blockNumber: receipt.blockNumber,
        };
      } catch (error) {
        if (error instanceof WaitForTransactionReceiptTimeoutError) {
          throw new TimeoutError(
            `No receipt for ${hash} within ${timeoutMs} ms`,
            { service: 'chain' },
          );
        }
        throw chainFailure('eth_getTransactionReceipt', error);
      }
    },

    async getTransaction(hash: Hex): Promise<'found' | 'not_found'> {
      const tx = await rpc('eth_getTransactionByHash', () =>
        client.request({ method: 'eth_getTransactionByHash', params: [hash] }),
      );
      return isObject(tx) ? 'found' : 'not_found';
    },

    async sendRawTransaction(raw: Hex) {
      try {
        return await writer.sendRawTransaction({ serializedTransaction: raw });
      } catch (error) {
        const outcome = classifyBroadcastFailure(error);
        if (outcome.kind === 'taken') {
          // Already in the node's pool: it was accepted. Its hash is the hash of the bytes.
          return keccak256(raw);
        }
        if (outcome.kind === 'nonceTooLow') {
          throw new TransactionFailedError(
            'eth_sendRawTransaction: nonce too low. The nonce is used, maybe by this transaction: look its hash up before concluding',
            {
              mayHaveLanded: true,
              transactionHash: keccak256(raw),
              code: 'nonce_too_low',
              service: 'chain',
            },
          );
        }
        if (outcome.kind === 'refused') {
          throw new TransactionFailedError(
            `eth_sendRawTransaction: the node refused the transaction: ${clip(outcome.text)}`,
            {
              mayHaveLanded: false,
              code: 'rejected_by_node',
              service: 'chain',
            },
          );
        }
        const rpcError =
          error instanceof BaseError
            ? error.walk((e) => e instanceof RpcRequestError)
            : null;
        throw new XoError(
          `eth_sendRawTransaction failed, outcome unknown: ${
            rpcError instanceof RpcRequestError
              ? clip(rpcError.details)
              : error instanceof BaseError
                ? clip(error.shortMessage)
                : errorName(error)
          }`,
          { code: 'chain_rpc_failed', service: 'chain' },
        );
      }
    },
  });
}
