// Helpers shared by the wallet modules (signer, identity) and the backend and orderbook
// logins. This module is not part of the public API.

import type { Hex } from 'viem';
import { SigningError } from '../core/errors';

/**
 * Whether `value` is a non-null object that is not an array. Class instances count: a viem
 * account or wallet client is an object, not a plain `{}`. Use it before reading a
 * property of a value the type system cannot vouch for.
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `UserInputError` message for a `wallet` option of any other shape. */
export const WALLET_SHAPE_MESSAGE =
  "wallet must be { type: 'eoa' } or { type: 'smart_wallet', index?: number | bigint } with a non-negative index";

/** A secp256k1 signature, `r || s || v`, as 65 bytes of hex. */
const ECDSA_SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;
/** The recovery byte as on-chain ECDSA recovery wants it, 27 or 28, and as some wallets send it, 0 or 1. */
const V_BY_PARITY: Readonly<Record<number, string>> = { 0: '1b', 1: '1c' };

/**
 * Checks a signature the signer returned and puts it in the form the chain recovers:
 * exactly 65 bytes, with `v` (the last byte) equal to 27 or 28. A wallet that returns 0 or 1
 * (some hardware and WalletConnect wallets do) is mapped to 27 or 28; `r`, `s` and the
 * rest are kept as they are, and a signature that is already 27 or 28 comes back as it is.
 * @throws SigningError if it is not 65 bytes of hex or `v` is none of 0, 1, 27, 28. The message never quotes the signature.
 */
export function normalizeSignature(signature: unknown): Hex {
  if (
    typeof signature !== 'string' ||
    !ECDSA_SIGNATURE_PATTERN.test(signature)
  ) {
    throw new SigningError(
      'signer did not return a 65-byte hex signature (r || s || v)',
    );
  }
  const v = Number.parseInt(signature.slice(-2), 16);
  if (v === 27 || v === 28) {
    return signature as Hex;
  }
  const normalized = V_BY_PARITY[v];
  if (normalized === undefined) {
    throw new SigningError(
      'signer returned a signature whose recovery byte (v) is not 0, 1, 27 or 28',
    );
  }
  return `${signature.slice(0, -2)}${normalized}` as Hex;
}

/** What an error name may look like to be quoted in a message. */
const ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * A name that is safe to put in a message. Only the name is used, never the message of
 * the error: an RPC error can carry the URL of the node, and that URL can hold an API key.
 */
export function errorName(error: unknown): string {
  // Reading `name` can run a getter, and a getter can throw: nothing here may escape.
  try {
    if (!isObject(error)) {
      return 'unknown';
    }
    const { name } = error as { name?: unknown };
    return typeof name === 'string' && ERROR_NAME_PATTERN.test(name)
      ? name
      : 'Error';
  } catch {
    return 'Error';
  }
}
