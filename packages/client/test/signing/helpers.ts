import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Address, Hex } from 'viem';
import { expect } from 'vitest';
import { UserInputError } from '../../src/core/errors';
import { type OrderStruct, orderDomain } from '../../src/signing/order';

// Shared fixtures for the signing tests. Each vector file is loaded once per test file.

export interface OrderVector {
  typeString: string;
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
  inputs: {
    chainId: number;
    exchange: Address;
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
    side: 0 | 1;
    signatureType: 0 | 3;
  };
  expectedDigest: Hex;
}

export interface CancelVector {
  typeStrings: { CancelOrder: string; CancelAll: string };
  domain: OrderVector['domain'];
  inputs: { chainId: number; exchange: Address };
  cases: Array<{
    name: string;
    primaryType: 'CancelOrder' | 'CancelAll';
    message: { orderId?: string; marketId: string };
    expectedDigest: Hex;
  }>;
}

export interface HmacVector {
  inputs: { secret: string; timestamp: string };
  cases: Array<{
    name: string;
    method: string;
    path: string;
    body: string;
    expectedSignature: string;
  }>;
  alphabetCase: {
    secrets: {
      standardPadded: string;
      standardUnpadded: string;
      urlSafePadded: string;
      urlSafeUnpadded: string;
    };
    timestamp: string;
    method: string;
    path: string;
    body: string;
    expectedSignature: string;
  };
  utf8Case: {
    secret: string;
    timestamp: string;
    method: string;
    path: string;
    body: string;
    expectedSignature: string;
    latin1WrongSignature: string;
  };
}

export interface ClobAuthVector {
  domain: { name: string; version: string; chainId: number };
  typeStrings: { EIP712Domain: string; ClobAuth: string };
  message: string;
  inputs: {
    privateKey: Hex;
    privateKeyNote: string;
    address: Address;
    timestamp: string;
    nonce: string;
    chainId: number;
  };
  expectedDigest: Hex;
  expectedSignature: Hex;
  expectedHeaders: Record<
    'XO_ADDRESS' | 'XO_SIGNATURE' | 'XO_TIMESTAMP' | 'XO_NONCE',
    string
  >;
}

export interface KernelExecuteCase {
  calls: Array<{ to: Address; value: string; data: Hex }>;
  expectedCalldata: Hex;
}

export interface KernelVector {
  createAccount: {
    factory: Address;
    ecdsaValidator: Address;
    owner: Address;
    index: string;
    selector: Hex;
    expectedCalldata: Hex;
    expectedAccount: Address;
  };
  wrap: {
    domain: {
      name: string;
      version: string;
      chainId: number;
      verifyingContract: Address;
    };
    typeStrings: { EIP712Domain: string; Kernel: string };
    inputs: { hash: Hex; account: Address; chainId: number };
    expectedDigest: Hex;
  };
  execute: {
    selector: Hex;
    single: KernelExecuteCase;
    batch: KernelExecuteCase;
  };
  signature: { ecdsa: Hex; expectedSignature: Hex };
}

function loadVector<T>(file: string): T {
  // test-vectors/ is at the repo root.
  const path = fileURLToPath(
    new URL(`../../../../test-vectors/${file}`, import.meta.url),
  );
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export const orderVector = loadVector<OrderVector>('order.json');
export const cancelVector = loadVector<CancelVector>('cancel.json');
export const hmacVector = loadVector<HmacVector>('hmac.json');
export const clobAuthVector = loadVector<ClobAuthVector>('clobAuth.json');
export const kernelVector = loadVector<KernelVector>('kernel.json');

export const { inputs } = orderVector;

export const ORDER: OrderStruct = {
  salt: BigInt(inputs.salt),
  maker: inputs.maker,
  signer: inputs.signer,
  beneficiary: inputs.beneficiary,
  tokenId: BigInt(inputs.tokenId),
  makerAmount: BigInt(inputs.makerAmount),
  takerAmount: BigInt(inputs.takerAmount),
  expiration: BigInt(inputs.expiration),
  nonce: BigInt(inputs.nonce),
  identifier: inputs.identifier,
  metadata: inputs.metadata,
  side: inputs.side,
  signatureType: inputs.signatureType,
};

export const DOMAIN = orderDomain(inputs.chainId, inputs.exchange);

// The exchange address with a deliberately wrong mixed-case checksum (the case of every
// letter swapped), as it might be copied from docs. viem's strict address check rejects it;
// the SDK must not.
export const BAD_CHECKSUM_EXCHANGE =
  '0x4Bc5e872256d12e6017DFE466e04C867dc761b77' as Address;

/** Expects a `UserInputError` whose message starts with the field name, and returns it. */
export function expectInvalid(
  fn: () => unknown,
  field: string,
): UserInputError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  return checkInvalid(caught, field);
}

/** Like {@link expectInvalid}, for a function that returns a promise. */
export async function expectInvalidAsync(
  fn: () => Promise<unknown>,
  field: string,
): Promise<UserInputError> {
  let caught: unknown;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  return checkInvalid(caught, field);
}

function checkInvalid(caught: unknown, field: string): UserInputError {
  expect(caught).toBeInstanceOf(UserInputError);
  const error = caught as UserInputError;
  expect(error.message.startsWith(`${field} `)).toBe(true);
  return error;
}

/** An order with one or more fields replaced by values the types would not allow. */
export function badOrder(overrides: Record<string, unknown>): OrderStruct {
  return { ...ORDER, ...overrides } as OrderStruct;
}
