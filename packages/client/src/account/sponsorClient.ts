import { type Address, type Hex, isAddress, numberToHex } from 'viem';
import {
  TimeoutError,
  TransactionFailedError,
  TransportError,
  UnexpectedResponseError,
  XoError,
} from '../core/errors';
import type { Transport } from '../core/transport';
import type { EvTx } from '../signing/evTx';
import { withLanded } from './internal';

// The sponsor's HTTP client: `POST /v1/sponsor/send`, and the request shaping.
// - The request goes through the SDK transport (X-XO-SDK header, `sponsor_not_configured`
//   when the environment has no sponsor, sponsor error bodies parsed into the SDK errors).
// - Only `/send` is used: the SDK never assembles or broadcasts a sponsored envelope itself.
// - Every failure is classified for the caller: see `sponsorSend`.

/** Hex-quantity transaction fields, as the sponsor expects them (JSON-RPC style). */
export interface SponsorTxRequest {
  chainId: Hex;
  nonce: Hex;
  maxPriorityFeePerGas: Hex;
  maxFeePerGas: Hex;
  gasLimit: Hex;
  calls: Array<{ to: Address | null; value: Hex; data: Hex }>;
  /** Sent only when it is not empty. */
  accessList?: Array<{ address: Address; storageKeys: Hex[] }>;
}

/** The body of `POST /v1/sponsor/send`. */
export interface SponsorRequestBody {
  tx: SponsorTxRequest;
  /** The executor's 65-byte `r || s || v` signature over `executorSigningHash(tx)`, low-s. */
  executorSignature: Hex;
}

/** What `/send` answers: the sponsor already broadcast the transaction. */
export interface SponsorSendResponse {
  txHash: Hex;
  /** The fee payer. Left out when the answer has none that is an address. */
  sponsor?: Address;
  /** The address the sponsor recovered from the executor signature. Left out likewise. */
  executor?: Address;
}

export const SPONSOR_SEND_PATH = '/v1/sponsor/send';

/** The default request timeout: a hung sponsor must not hang the caller. */
export const SPONSOR_TIMEOUT_MS = 15_000;

/** A 32-byte transaction hash. */
const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** The wire form of an EvNode transaction: every integer as a hex quantity. */
export function toSponsorTx(tx: EvTx): SponsorTxRequest {
  const request: SponsorTxRequest = {
    chainId: numberToHex(tx.chainId),
    nonce: numberToHex(tx.nonce),
    maxPriorityFeePerGas: numberToHex(tx.maxPriorityFeePerGas),
    maxFeePerGas: numberToHex(tx.maxFeePerGas),
    gasLimit: numberToHex(tx.gasLimit),
    calls: tx.calls.map((call) => ({
      to: call.to,
      value: numberToHex(call.value),
      data: call.input,
    })),
  };
  if (tx.accessList.length > 0) {
    request.accessList = tx.accessList;
  }
  return request;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The nonce of a request body, when it reads as a hex quantity. */
function nonceOf(body: SponsorRequestBody): bigint | undefined {
  try {
    return BigInt(body.tx.nonce);
  } catch {
    return undefined;
  }
}

function outcomeUnknown(
  message: string,
  context: { nonce: bigint | undefined; executor: Address | undefined },
  cause?: unknown,
): TransactionFailedError {
  const { nonce, executor } = context;
  const check =
    nonce === undefined
      ? "check the executor's transactions"
      : `check which transaction used nonce ${nonce}${
          executor === undefined ? '' : ` from executor ${executor}`
        }`;
  return new TransactionFailedError(
    `${message}. The sponsor may have broadcast the transaction: do not resend it; ${check} before trying again`,
    {
      mayHaveLanded: true,
      code: 'sponsor_outcome_unknown',
      service: 'sponsor',
      nonce,
      cause,
    },
  );
}

/**
 * Whether a failed request reached the sponsor. Only a definite answer counts as "it did not":
 * a 4xx status. A timeout, a network failure, a 5xx or a 2xx that could not be read may all
 * come after the sponsor broadcast. An SDK error without a status (other than those) was
 * raised in this process before anything was sent.
 */
function classify(error: unknown): 'refused' | 'notSent' | 'unknown' {
  if (
    error instanceof TimeoutError ||
    error instanceof TransportError ||
    error instanceof UnexpectedResponseError
  ) {
    return 'unknown';
  }
  if (error instanceof XoError) {
    if (error.status === undefined) {
      return 'notSent';
    }
    return error.status >= 400 && error.status < 500 ? 'refused' : 'unknown';
  }
  return 'unknown';
}

/**
 * Hands a signed EvNode transaction to the sponsor, which co-signs as fee payer and
 * broadcasts it. Sent once, never retried.
 *
 * How it fails:
 * - A 4xx answer (403 `policy_rejected`, 400 `bad_request` or `signature_recovery_failed`,
 *   429 `overloaded` or a rate limit) is the parsed SDK error (`RequestRejectedError`,
 *   `RateLimitError`) with `mayHaveLanded: false`: the sponsor refused
 *   it.
 * - A failure before the request went out (no `sponsorUrl`: `UserInputError` code
 *   `sponsor_not_configured`) is thrown as it is, with `mayHaveLanded: false`.
 * - Anything else after the request was sent is a `TransactionFailedError` with code
 *   `sponsor_outcome_unknown` and `mayHaveLanded: true`, the original as `cause`: a timeout, a
 *   network failure, a 5xx (the sponsor reports a node refusal as 5xx `submit_failed`, but it
 *   cannot tell a refusal from an RPC timeout, so the SDK does not either), or a 2xx without a
 *   valid transaction hash. There is no hash to give: the error carries the `nonce` of the
 *   body, and the caller reconciles by finding which transaction used that nonce from the
 *   executor (`o.executor`, named in the message when given).
 */
export async function sponsorSend(
  transport: Transport,
  body: SponsorRequestBody,
  o: { timeoutMs?: number; executor?: Address } = {},
): Promise<SponsorSendResponse> {
  const context = { nonce: nonceOf(body), executor: o.executor };
  let answer: unknown;
  try {
    answer = await transport.request({
      service: 'sponsor',
      method: 'POST',
      path: SPONSOR_SEND_PATH,
      body,
      auth: 'none',
      retry: 'none',
      timeoutMs: o.timeoutMs ?? SPONSOR_TIMEOUT_MS,
    });
  } catch (error) {
    const outcome = classify(error);
    if (outcome !== 'unknown' && error instanceof XoError) {
      throw withLanded(error, false);
    }
    throw outcomeUnknown(`${SPONSOR_SEND_PATH} failed`, context, error);
  }

  const txHash = isRecord(answer) ? answer.txHash : undefined;
  if (typeof txHash !== 'string' || !TX_HASH_PATTERN.test(txHash)) {
    throw outcomeUnknown(
      `${SPONSOR_SEND_PATH} answered without a valid transaction hash`,
      context,
    );
  }
  const out: SponsorSendResponse = { txHash: txHash.toLowerCase() as Hex };
  const { sponsor, executor } = answer as Record<string, unknown>;
  if (typeof sponsor === 'string' && isAddress(sponsor, { strict: false })) {
    out.sponsor = sponsor as Address;
  }
  if (typeof executor === 'string' && isAddress(executor, { strict: false })) {
    out.executor = executor as Address;
  }
  return out;
}
