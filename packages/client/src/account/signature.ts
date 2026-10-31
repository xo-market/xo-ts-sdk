import {
  type Address,
  type Hex,
  numberToHex,
  recoverAddress,
  serializeSignature,
} from 'viem';
import { isSameAddress } from '../core/address';
import { SigningError } from '../core/errors';
import type { ExecutorSignature } from '../signing/evTx';

// The executor signature in the form the sponsor takes: `parseCompactSignature`, `toYParity`
// and `normalizeExecutorSignature`. The errors are the SDK's, and their messages never quote a
// signature.

/** secp256k1 curve order and its half, for EIP-2 low-s canonicalisation. */
const SECP256K1_N = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
);
const SECP256K1_HALF_N = SECP256K1_N >> 1n;

const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;

function toYParity(v: number): 0 | 1 {
  if (v === 0 || v === 1) {
    return v;
  }
  if (v === 27 || v === 28) {
    return (v - 27) as 0 | 1;
  }
  throw new SigningError(
    'signHash returned a signature whose recovery byte (v) is not 0, 1, 27 or 28',
  );
}

async function recovers(
  hash: Hex,
  r: Hex,
  s: Hex,
  yParity: 0 | 1,
  executor: Address,
): Promise<boolean> {
  try {
    const recovered = await recoverAddress({
      hash,
      signature: { r, s, yParity },
    });
    return isSameAddress(recovered, executor);
  } catch {
    // r or s out of range, or no point on the curve.
    return false;
  }
}

/**
 * Checks a raw signature of `hash` against the executor that must have made it, and returns
 * the two forms a transaction needs: `{ r, s, yParity }` for an envelope and the canonical
 * 65-byte `r || s || v` (v = 27 or 28) for the sponsor request.
 *
 * - `s` is reduced to the low half of the curve order (EIP-2): `(r, s)` and `(r, n - s)` are
 *   both valid signatures, but nodes refuse the high-s form.
 * - The parity is not trusted: it is recovered against `executor`, and flipped if the other
 *   one is right (which it is after a high-s reduction).
 * @throws SigningError if the signature is not 65 bytes of hex, `r` or `s` is 0 or not below
 *   the curve order, `v` is not 0, 1, 27 or 28, or neither parity recovers to `executor` (the signer signed another digest, for example with
 *   an EIP-191 prefix, or with another key). The message never quotes the signature.
 */
export async function normalizeExecutorSignature(
  hash: Hex,
  signature: unknown,
  executor: Address,
): Promise<{ exec: ExecutorSignature; canonical: Hex }> {
  if (typeof signature !== 'string' || !SIGNATURE_PATTERN.test(signature)) {
    throw new SigningError(
      'signHash did not return a 65-byte hex signature (r || s || v)',
    );
  }
  const r = `0x${signature.slice(2, 66)}` as Hex;
  const rawR = BigInt(r);
  const rawS = BigInt(`0x${signature.slice(66, 130)}`);
  const v = Number.parseInt(signature.slice(130, 132), 16);
  // A valid signature has r and s in [1, n). Checked before the low-s reduction, which
  // would otherwise go negative and fail as an unrelated range error.
  if (
    rawR === 0n ||
    rawR >= SECP256K1_N ||
    rawS === 0n ||
    rawS >= SECP256K1_N
  ) {
    throw new SigningError(
      'signHash returned a signature whose r or s is outside the secp256k1 range [1, n)',
    );
  }

  const s =
    rawS > SECP256K1_HALF_N
      ? numberToHex(SECP256K1_N - rawS, { size: 32 })
      : numberToHex(rawS, { size: 32 });

  let yParity = toYParity(v);
  if (!(await recovers(hash, r, s, yParity, executor))) {
    const flipped = (yParity ^ 1) as 0 | 1;
    if (!(await recovers(hash, r, s, flipped, executor))) {
      throw new SigningError(
        'The signature does not recover to the executor: the signer must sign the raw 32-byte digest (no EIP-191 prefix) with the owner key',
        { code: 'signature_mismatch' },
      );
    }
    yParity = flipped;
  }

  const exec: ExecutorSignature = { r: r.toLowerCase() as Hex, s, yParity };
  return { exec, canonical: serializeSignature({ ...exec }) };
}
