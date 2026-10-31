import { type Address, concat, type Hex, keccak256, toRlp } from 'viem';

/**
 * Byte-exact TypeScript encoding of the EvNode (`0x76`) transaction. This is pure and
 * dependency-light (viem RLP primitives only) so it can be exhaustively unit-tested against
 * golden vectors — see `test/signing/evTx.test.ts`.
 *
 * The one rule that governs correctness: **alloy encodes every integer as a
 * minimal big-endian byte string** (no fixed-width padding); `0` encodes as the
 * empty string (`0x80`), never `0x00`. All integer fields therefore go through
 * {@link rlpInt}. Empty-string (`0x80`, e.g. `to = Create`, absent fee payer)
 * and empty-list (`0xc0`, e.g. empty access list) are distinct and must not be
 * conflated.
 */

/**
 * A single call inside an EvNode batch. `to = null` denotes a contract
 * creation (only valid as the first call).
 */
export interface EvCall {
  to: Address | null;
  value: bigint;
  /** Calldata (or init code for a creation). */
  input: Hex;
}

/** EIP-2930 access-list entry (currently always empty for sponsored claims). */
export interface EvAccessListItem {
  address: Address;
  storageKeys: Hex[];
}

/** An unsigned EvNode `0x76` transaction payload. */
export interface EvTx {
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  calls: EvCall[];
  accessList: EvAccessListItem[];
}

/**
 * The executor's secp256k1 signature over `executorSigningHash`, decomposed for
 * the signed envelope. `yParity` is `0 | 1` (NOT the `27/28` `v`).
 */
export interface ExecutorSignature {
  r: Hex;
  s: Hex;
  yParity: 0 | 1;
}

/** EIP-2718 type byte for EvNode transactions; also the executor signing-hash domain. */
export const EVNODE_TX_TYPE: Hex = '0x76';

/** The most calls the sponsor takes in one batch. */
export const MAX_CALLS = 32;

/** The most calldata bytes the sponsor takes per call. */
export const MAX_CALLDATA_BYTES = 128 * 1024;

const BASE_TX_GAS = BigInt(21_000);
const CREATE_GAS = BigInt(32_000);
const GAS_PER_ZERO_BYTE = BigInt(4);
const GAS_PER_NONZERO_BYTE = BigInt(16);

/**
 * Node integer-width ceilings. The Rust envelope decodes chainId/nonce/gasLimit as
 * `u64`, the fee fields as `u128`, and call `value` as `U256`; a bigint wider than
 * its field is byte-serialised fine here but rejected by the node's decoder at
 * `eth_sendRawTransaction` with an opaque RLP-overflow error. Guarding here turns an
 * upstream fee/nonce bug into a clear client-side failure instead.
 */
const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const U128_MAX = (BigInt(1) << BigInt(128)) - BigInt(1);
const U256_MAX = (BigInt(1) << BigInt(256)) - BigInt(1);

type RlpItem = Hex | RlpItem[];

/**
 * RLP-encode an unsigned integer as a minimal big-endian byte string, matching
 * alloy. `0` → `'0x'` (which `toRlp` renders as `0x80`); no leading zero bytes.
 *
 * Do NOT substitute `numberToHex(v, { size })` — fixed-width padding corrupts
 * the hash and the recovered executor address.
 */
export function rlpInt(value: bigint | number): Hex {
  const v = BigInt(value);
  if (v < BigInt(0)) throw new RangeError('rlpInt: value must be non-negative');
  if (v === BigInt(0)) return '0x';
  let hex = v.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  return `0x${hex}`;
}

function encodeCalls(calls: EvCall[]): RlpItem[] {
  // `to = null` (Create) → empty string (0x80); value → minimal U256; input verbatim.
  return calls.map((c) => [
    c.to ?? '0x',
    rlpInt(c.value),
    c.input && c.input !== '0x' ? c.input : '0x',
  ]);
}

function encodeAccessList(list: EvAccessListItem[]): RlpItem[] {
  // Empty list → 0xc0 (empty *list*, not empty string).
  return list.map((item) => [item.address, item.storageKeys]);
}

/** The seven shared payload fields (everything except the fee-payer / executor sig). */
function payloadFields(tx: EvTx): RlpItem[] {
  return [
    rlpInt(tx.chainId),
    rlpInt(tx.nonce),
    rlpInt(tx.maxPriorityFeePerGas),
    rlpInt(tx.maxFeePerGas),
    rlpInt(tx.gasLimit),
    encodeCalls(tx.calls),
    encodeAccessList(tx.accessList),
  ];
}

/**
 * The digest the executor raw-signs (secp256k1 over the prehash, NO EIP-191):
 * `keccak256(0x76 || rlp([...7 fields, feePayer = empty string]))`.
 *
 * The fee-payer field is always the empty string here, which is why the
 * executor hash is independent of any sponsor signature.
 */
export function executorSigningHash(tx: EvTx): Hex {
  const list: RlpItem[] = [...payloadFields(tx), '0x'];
  return keccak256(concat([EVNODE_TX_TYPE, toRlp(list, 'hex')]));
}

/**
 * The signed envelope for `eth_sendRawTransaction`:
 * `0x76 || rlp([...7 fields, feePayerSignature, execYParity, execR, execS])`.
 *
 * @param feePayerSignature the sponsor's 65-byte `r||s||v` signature, passed
 *   verbatim; `null` for a self-paid (unsponsored) transaction.
 */
export function encodeSignedTx(
  tx: EvTx,
  feePayerSignature: Hex | null,
  exec: ExecutorSignature,
): Hex {
  const list: RlpItem[] = [
    ...payloadFields(tx),
    feePayerSignature ?? '0x',
    rlpInt(exec.yParity),
    rlpInt(BigInt(exec.r)),
    rlpInt(BigInt(exec.s)),
  ];
  return concat([EVNODE_TX_TYPE, toRlp(list, 'hex')]);
}

/**
 * Client-side intrinsic-gas floor.
 * Advisory only — the node computes the authoritative figure — but a useful
 * lower bound when no on-chain estimate is available.
 */
export function estimateIntrinsicGas(calls: EvCall[]): bigint {
  let gas = BASE_TX_GAS;
  for (const call of calls) {
    gas += BASE_TX_GAS;
    if (call.to === null) gas += CREATE_GAS;
    const body = call.input && call.input !== '0x' ? call.input.slice(2) : '';
    for (let i = 0; i < body.length; i += 2) {
      gas +=
        body.slice(i, i + 2) === '00'
          ? GAS_PER_ZERO_BYTE
          : GAS_PER_NONZERO_BYTE;
    }
  }
  return gas;
}

/** Structural validation of an EvNode transaction, with the sponsor's request limits. */
export function validateEvTx(tx: EvTx): void {
  if (tx.calls.length === 0) {
    throw new Error('EvTx: transaction must include at least one call');
  }
  if (tx.calls.length > MAX_CALLS) {
    throw new Error(`EvTx: at most ${MAX_CALLS} calls per batch`);
  }

  // Integer-width bounds (mirror the node's u64/u128/U256 decode; see the *_MAX consts).
  assertInRange('chainId', tx.chainId, U64_MAX);
  assertInRange('nonce', tx.nonce, U64_MAX);
  assertInRange('gasLimit', tx.gasLimit, U64_MAX);
  assertInRange('maxFeePerGas', tx.maxFeePerGas, U128_MAX);
  assertInRange('maxPriorityFeePerGas', tx.maxPriorityFeePerGas, U128_MAX);

  tx.calls.forEach((call, i) => {
    if (i > 0 && call.to === null) {
      throw new Error('EvTx: only the first call may be a contract creation');
    }
    assertInRange(`calls[${i}].value`, call.value, U256_MAX);
    const byteLen =
      call.input && call.input !== '0x' ? (call.input.length - 2) / 2 : 0;
    if (byteLen > MAX_CALLDATA_BYTES) {
      throw new Error(`EvTx: calldata exceeds ${MAX_CALLDATA_BYTES} bytes`);
    }
  });
}

function assertInRange(field: string, value: bigint, max: bigint): void {
  if (value < BigInt(0) || value > max) {
    throw new Error(`EvTx: ${field} out of range (0..=${max}), got ${value}`);
  }
}
