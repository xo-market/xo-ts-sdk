import type { Address, Hex, TypedDataDefinition } from 'viem';
import { normalizeAddress } from '../core/address';
import { UserInputError } from '../core/errors';
import { assertChainId, assertTimestamp, assertUint } from './internal';

/** The EIP-712 domain name of an L1 (ClobAuth) signature. */
export const CLOB_AUTH_DOMAIN_NAME = 'ClobAuthDomain';

/** The constant `message` field of every ClobAuth signature. */
export const CLOB_AUTH_MESSAGE =
  'This message attests that I control the given wallet';

/** The EIP-712 types of an L1 auth signature: `ClobAuth(address address,string timestamp,uint256 nonce,string message)`. */
export const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: 'address', type: 'address' },
    { name: 'timestamp', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'message', type: 'string' },
  ],
} as const;

/** What an L1 (ClobAuth) signature covers: see {@link clobAuthTypedData}. */
export interface ClobAuthParams {
  /** The wallet that signs. Any case: it is checksummed. */
  address: Address;
  /** Unix seconds as a decimal string. The gateway allows a skew of 120 seconds. */
  timestamp: string;
  /** The L1 nonce, a `bigint` in `[0, 2^256)`. */
  nonce: bigint;
  /** The chain id of the ClobAuth domain. */
  chainId: number;
}

/**
 * The typed data to sign for L1 auth. The signature proves control of the wallet and is
 * used to create or derive the L2 credentials.
 *
 * The domain is `{ name: 'ClobAuthDomain', version: '1', chainId }` and has no
 * `verifyingContract`: the gateway hashes `EIP712Domain(string name,string version,uint256 chainId)`.
 * @throws UserInputError if `address` is not a 20-byte hex address, `timestamp` is not a string of decimal digits, `nonce` is not a bigint in `[0, 2^256)` or `chainId` is not a positive safe integer.
 */
export function clobAuthTypedData(
  p: ClobAuthParams,
): TypedDataDefinition<typeof CLOB_AUTH_TYPES, 'ClobAuth'> {
  return {
    domain: {
      name: CLOB_AUTH_DOMAIN_NAME,
      version: '1',
      chainId: assertChainId(p.chainId),
    },
    types: CLOB_AUTH_TYPES,
    primaryType: 'ClobAuth',
    message: {
      address: normalizeAddress(p.address, 'address'),
      timestamp: assertTimestamp(p.timestamp, 'timestamp'),
      nonce: assertUint(p.nonce, 256, 'nonce'),
      message: CLOB_AUTH_MESSAGE,
    },
  };
}

/** A 0x-prefixed hex string of whole bytes, with at least one byte. */
const SIGNATURE_PATTERN = /^0x(?:[0-9a-fA-F]{2})+$/;

/**
 * The L1 request headers. `XO_ADDRESS` is checksummed and `XO_NONCE` is the nonce in decimal.
 *
 * The signature is any non-empty hex string of whole bytes, not only 65 bytes: a smart
 * wallet signs with EIP-1271 and its signature has another length.
 * @throws UserInputError if `address`, `timestamp` or `nonce` is invalid (see {@link clobAuthTypedData}) or `signature` is not a non-empty 0x-hex string with an even number of digits.
 */
export function l1Headers(p: {
  address: Address;
  signature: Hex;
  timestamp: string;
  nonce: bigint;
}): Record<
  'XO_ADDRESS' | 'XO_SIGNATURE' | 'XO_TIMESTAMP' | 'XO_NONCE',
  string
> {
  const address = normalizeAddress(p.address, 'address');
  if (typeof p.signature !== 'string' || !SIGNATURE_PATTERN.test(p.signature)) {
    throw new UserInputError(
      'signature must be a 0x-prefixed hex string of whole bytes',
    );
  }
  const timestamp = assertTimestamp(p.timestamp, 'timestamp');
  const nonce = assertUint(p.nonce, 256, 'nonce');
  return {
    XO_ADDRESS: address,
    XO_SIGNATURE: p.signature,
    XO_TIMESTAMP: timestamp,
    XO_NONCE: nonce.toString(10),
  };
}
