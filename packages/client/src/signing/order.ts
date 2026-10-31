import type { Address, Hex, TypedDataDefinition, TypedDataDomain } from 'viem';
import { hashTypedData } from 'viem';
import { normalizeAddress } from '../core/address';
import { UserInputError } from '../core/errors';
import type { OrderHash } from '../core/types';
import {
  assertChainId,
  assertHexBytes,
  assertUint,
  normalizeDomain,
} from './internal';

/** The EIP-712 domain name of the exchange: it signs orders and cancels. */
export const ORDER_DOMAIN_NAME = 'XO Market CLOB';

/**
 * The EIP-712 types of an exchange order. The field order is part of the type hash, and
 * the signed string is exactly
 * `Order(uint256 salt,address maker,address signer,address beneficiary,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint128 nonce,bytes16 identifier,bytes32 metadata,uint8 side,uint8 signatureType)`.
 * There is no `EIP712Domain` entry; viem derives it from the domain.
 */
export const ORDER_TYPES = {
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
} as const;

/** An order as the exchange hashes it. Integers are `bigint`; `side` 0 is BUY and 1 is SELL. */
export interface OrderStruct {
  /** uint256 */
  salt: bigint;
  maker: Address;
  signer: Address;
  beneficiary: Address;
  /** uint256 */
  tokenId: bigint;
  /** uint256 */
  makerAmount: bigint;
  /** uint256 */
  takerAmount: bigint;
  /** uint256 */
  expiration: bigint;
  /** uint128 */
  nonce: bigint;
  /** bytes16, as 0x plus 32 hex characters. */
  identifier: Hex;
  /** bytes32, as 0x plus 64 hex characters. */
  metadata: Hex;
  /** 0 is BUY, 1 is SELL. */
  side: 0 | 1;
  /** 0 is an EOA signature, 3 is a smart wallet. */
  signatureType: 0 | 3;
}

/** An order as the gateway takes it: integers as decimal strings, `side` as a word. */
export interface WireOrder {
  salt: string;
  maker: Address;
  signer: Address;
  beneficiary: Address;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  expiration: string;
  nonce: string;
  identifier: Hex;
  metadata: Hex;
  side: 'BUY' | 'SELL';
  signatureType: 0 | 3;
  signature: Hex;
}

const SIGNATURE_RE = /^0x(?:[0-9a-fA-F]{2})+$/;
/** The gateway requires an EOA (signatureType 0) signature to be r || s || v. */
const EOA_SIGNATURE_BYTES = 65;

function assertSide(value: unknown): 0 | 1 {
  if (value !== 0 && value !== 1) {
    throw new UserInputError('side must be 0 (BUY) or 1 (SELL)');
  }
  return value;
}

function assertSignatureType(value: unknown): 0 | 3 {
  if (value !== 0 && value !== 3) {
    throw new UserInputError(
      'signatureType must be 0 (EOA) or 3 (smart wallet)',
    );
  }
  return value;
}

/**
 * Checks the signature is non-empty, even-length `0x` hex, and for an EOA order exactly
 * 65 bytes. A smart wallet (signatureType 3) signature has no fixed length.
 */
function assertSignature(value: unknown, signatureType: 0 | 3): Hex {
  if (typeof value !== 'string' || !SIGNATURE_RE.test(value)) {
    throw new UserInputError(
      'signature must be a non-empty, even-length 0x-prefixed hex string',
    );
  }
  if (signatureType === 0 && value.length !== 2 + EOA_SIGNATURE_BYTES * 2) {
    throw new UserInputError(
      `signature must be exactly ${EOA_SIGNATURE_BYTES} bytes for an EOA order (signatureType 0)`,
    );
  }
  return value as Hex;
}

/** Validates every field, in struct order, and returns a fresh struct with checksummed addresses. */
function normalizeOrder(order: OrderStruct): OrderStruct {
  if (typeof order !== 'object' || order === null) {
    throw new UserInputError('order must be an object');
  }
  return {
    salt: assertUint(order.salt, 256, 'salt'),
    maker: normalizeAddress(order.maker, 'maker'),
    signer: normalizeAddress(order.signer, 'signer'),
    beneficiary: normalizeAddress(order.beneficiary, 'beneficiary'),
    tokenId: assertUint(order.tokenId, 256, 'tokenId'),
    makerAmount: assertUint(order.makerAmount, 256, 'makerAmount'),
    takerAmount: assertUint(order.takerAmount, 256, 'takerAmount'),
    expiration: assertUint(order.expiration, 256, 'expiration'),
    nonce: assertUint(order.nonce, 128, 'nonce'),
    identifier: assertHexBytes(order.identifier, 16, 'identifier'),
    metadata: assertHexBytes(order.metadata, 32, 'metadata'),
    side: assertSide(order.side),
    signatureType: assertSignatureType(order.signatureType),
  };
}

/**
 * The EIP-712 domain of the exchange: name `XO Market CLOB`, version `1`. The same domain
 * signs orders and cancels. `exchange` is checksummed, so any address case is accepted.
 * @throws UserInputError if `chainId` is not a positive safe integer or `exchange` is not a 20-byte hex address.
 */
export function orderDomain(
  chainId: number,
  exchange: Address,
): TypedDataDomain {
  return {
    name: ORDER_DOMAIN_NAME,
    version: '1',
    chainId: assertChainId(chainId),
    verifyingContract: normalizeAddress(exchange, 'exchange'),
  };
}

/**
 * The typed data to sign for an order. Addresses (including the domain's
 * `verifyingContract`) are checksummed, so the result does not depend on their input case.
 * @throws UserInputError, starting with the field name, for the first field that is missing, out of range or malformed. The domain is checked first, then the order in struct order.
 */
export function orderTypedData(
  order: OrderStruct,
  domain: TypedDataDomain,
): TypedDataDefinition<typeof ORDER_TYPES, 'Order'> {
  return {
    domain: normalizeDomain(domain),
    types: ORDER_TYPES,
    primaryType: 'Order',
    message: normalizeOrder(order),
  };
}

/**
 * The EIP-712 digest of an order, the same value the deployed exchange's `hashOrder`
 * returns.
 * @throws UserInputError, starting with the field name, for the first field that is missing, out of range or malformed. The domain is checked first, then the order in struct order.
 */
export function hashOrder(
  order: OrderStruct,
  domain: TypedDataDomain,
): OrderHash {
  return hashTypedData(orderTypedData(order, domain)) as OrderHash;
}

/**
 * The body fields the gateway takes for an order: integers as decimal strings, `side` as
 * `'BUY'` or `'SELL'`, addresses checksummed. `signature` is passed through unchanged, but
 * it must be non-empty, even-length `0x` hex, and exactly 65 bytes for an EOA order
 * (`signatureType` 0), which is what the gateway enforces. Only these 14 fields are
 * emitted, whatever else the order object carries.
 * @throws UserInputError, starting with the field name, for the first field (in struct order, then the signature) that is missing, out of range or malformed.
 */
export function toWireOrder(order: OrderStruct, signature: Hex): WireOrder {
  const o = normalizeOrder(order);
  assertSignature(signature, o.signatureType);
  return {
    salt: o.salt.toString(),
    maker: o.maker,
    signer: o.signer,
    beneficiary: o.beneficiary,
    tokenId: o.tokenId.toString(),
    makerAmount: o.makerAmount.toString(),
    takerAmount: o.takerAmount.toString(),
    expiration: o.expiration.toString(),
    nonce: o.nonce.toString(),
    identifier: o.identifier,
    metadata: o.metadata,
    side: o.side === 0 ? 'BUY' : 'SELL',
    signatureType: o.signatureType,
    signature,
  };
}
