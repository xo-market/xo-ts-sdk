import {
  type Address,
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  type Hex,
  type TypedDataDefinition,
  toHex,
  zeroAddress,
} from 'viem';
import { normalizeAddress } from '../core/address';
import { UserInputError } from '../core/errors';
import { MAX_CALLS } from './evTx';
import {
  assertChainId,
  assertHexBytes,
  assertHexData,
  assertUint,
} from './internal';

// Helpers for a Kernel v3.1 smart account (ERC-7579), the account behind signatureType 3.
// Nothing here talks to a chain. The factory and the validator are not constants: callers
// pass them in from the environment config (`production.contracts`).

/** The ECDSA validator type byte in a Kernel root-validator id (`bytes21`: type byte, then the validator address). */
const VALIDATOR_TYPE_ECDSA: Hex = '0x01';

/** The Kernel EIP-712 domain: `{ name: 'Kernel', version: '0.3.1', chainId, verifyingContract: account }`. */
export const KERNEL_DOMAIN_NAME = 'Kernel';
const KERNEL_DOMAIN_VERSION = '0.3.1';

/** The signature prefix byte for the root validator, which is the account's ECDSA owner. */
const ROOT_VALIDATOR_MODE: Hex = '0x00';
/** A secp256k1 signature, `r || s || v`. */
const ECDSA_SIGNATURE_BYTES = 65;

/**
 * ERC-7579 execution modes, the `bytes32 mode` of `execute`. Byte 0 is the call type
 * (`0x00` single, `0x01` batch), byte 1 is the exec type (`0x00`: revert if a call fails)
 * and the other 30 bytes are 0.
 */
const MODE_SINGLE: Hex = `0x00${'00'.repeat(31)}`;
const MODE_BATCH: Hex = `0x01${'00'.repeat(31)}`;

const INITIALIZE_ABI = [
  {
    type: 'function',
    name: 'initialize',
    inputs: [
      { name: '_rootValidator', type: 'bytes21' },
      { name: 'hook', type: 'address' },
      { name: 'validatorData', type: 'bytes' },
      { name: 'hookData', type: 'bytes' },
      { name: 'initConfig', type: 'bytes[]' },
    ],
    outputs: [],
  },
] as const;

const CREATE_ACCOUNT_ABI = [
  {
    type: 'function',
    name: 'createAccount',
    inputs: [
      { name: 'data', type: 'bytes' },
      { name: 'salt', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

const EXECUTE_ABI = [
  {
    type: 'function',
    name: 'execute',
    inputs: [
      { name: 'execMode', type: 'bytes32' },
      { name: 'executionCalldata', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

/** `Execution[]`: the ERC-7579 batch encoding. */
const BATCH_PARAMETERS = [
  {
    type: 'tuple[]',
    components: [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'callData', type: 'bytes' },
    ],
  },
] as const;

/**
 * The EIP-712 types of the Kernel ERC-1271 wrap: `Kernel(bytes32 hash)`. There is no
 * `EIP712Domain` entry; viem derives it from the domain.
 */
export const KERNEL_TYPES = {
  Kernel: [{ name: 'hash', type: 'bytes32' }],
} as const;

/** One on-chain call: sent as it is from an EOA, or made by a smart wallet through its `execute`. */
export interface Call {
  /** The target. Any case: it is checksummed. */
  to: Address;
  /** Wei to send. Defaults to 0. */
  value?: bigint;
  /** The calldata, as even-length `0x` hex. `0x` for a plain transfer. */
  data: Hex;
}

/**
 * The calldata of `factory.createAccount(...)` for an owner, as the Kernel factory
 * expects it: `createAccount(initialize(0x01 || validator, address(0), owner, 0x, []), bytes32(index))`.
 *
 * Sent to the factory as a read-only `eth_call`, the answer is the account address the
 * owner would get, whether or not it is deployed yet. Sent as a transaction, it deploys
 * the account.
 * @param owner The ECDSA owner (the EOA that signs for the account).
 * @param index The account number of the owner, a `bigint` in `[0, 2^256)`. It is the salt.
 * @param validator The ECDSA validator module (`production.contracts.ecdsaValidator`).
 * @throws UserInputError, starting with `owner`, `index` or `validator`, for the first of them that is invalid.
 */
export function kernelCreateAccountCalldata(
  owner: Address,
  index: bigint,
  validator: Address,
): Hex {
  const ownerAddress = normalizeAddress(owner, 'owner');
  const salt = assertUint(index, 256, 'index');
  const validatorAddress = normalizeAddress(validator, 'validator');

  const initialize = encodeFunctionData({
    abi: INITIALIZE_ABI,
    functionName: 'initialize',
    args: [
      concat([VALIDATOR_TYPE_ECDSA, validatorAddress]),
      zeroAddress,
      ownerAddress,
      '0x',
      [],
    ],
  });
  return encodeFunctionData({
    abi: CREATE_ACCOUNT_ABI,
    functionName: 'createAccount',
    args: [initialize, toHex(salt, { size: 32 })],
  }).toLowerCase() as Hex;
}

/**
 * The typed data a Kernel owner signs to make an ERC-1271 signature for `hash` (for
 * example an order digest). Kernel does not check the raw hash: it wraps it as the
 * EIP-712 struct `Kernel(bytes32 hash)` under the domain
 * `{ name: 'Kernel', version: '0.3.1', chainId, verifyingContract: account }`.
 * @param hash The 32-byte digest to approve.
 * @param account The Kernel account address. Any case: it is checksummed.
 * @param chainId The chain the account lives on, a positive safe integer.
 * @throws UserInputError, starting with `hash`, `account` or `chainId`, for the first of them that is invalid.
 */
export function kernelWrapTypedData(
  hash: Hex,
  account: Address,
  chainId: number,
): TypedDataDefinition<typeof KERNEL_TYPES, 'Kernel'> {
  const wrapped = assertHexBytes(hash, 32, 'hash');
  const verifyingContract = normalizeAddress(account, 'account');
  const id = assertChainId(chainId);
  return {
    domain: {
      name: KERNEL_DOMAIN_NAME,
      version: KERNEL_DOMAIN_VERSION,
      chainId: id,
      verifyingContract,
    },
    types: KERNEL_TYPES,
    primaryType: 'Kernel',
    message: { hash: wrapped },
  };
}

/**
 * The Kernel signature for the root validator: `0x00 || ecdsa`, 66 bytes. Pass it as the
 * signature of a signatureType 3 order, or as the ERC-1271 signature.
 * @param ecdsa The owner's 65-byte `r || s || v` signature over the digest from {@link kernelWrapTypedData}.
 * @throws UserInputError starting with `ecdsa` if it is not a 0x-prefixed hex string of exactly 65 bytes.
 */
export function encodeKernelSignature(ecdsa: Hex): Hex {
  return concat([
    ROOT_VALIDATOR_MODE,
    assertHexBytes(ecdsa, ECDSA_SIGNATURE_BYTES, 'ecdsa'),
  ]);
}

function normalizeCall(call: unknown, index: number): Required<Call> {
  const field = `calls[${index}]`;
  if (typeof call !== 'object' || call === null) {
    throw new UserInputError(`${field} must be an object`);
  }
  const { to, value, data } = call as Partial<Call>;
  return {
    to: normalizeAddress(to as string, `${field}.to`),
    value: value === undefined ? 0n : assertUint(value, 256, `${field}.value`),
    data: assertHexData(data, `${field}.data`),
  };
}

/**
 * The calldata of the Kernel account's ERC-7579 `execute(bytes32 mode, bytes executionCalldata)`
 * (selector `0xe9ae5c53`), to make one or more calls from the account.
 *
 * - One call: mode `0x00` plus 31 zero bytes, and `executionCalldata` is the packed
 *   `target (20 bytes) || value (32 bytes) || data`.
 * - Two or more calls: mode `0x01` plus 31 zero bytes, and `executionCalldata` is the ABI
 *   encoding of `(address target, uint256 value, bytes callData)[]`.
 *
 * The exec type is the default (`0x00`): if a call fails, the whole execution reverts.
 * @throws UserInputError, starting with `calls` or `calls[i]` or `calls[i].to|value|data`, if `calls` is empty, has more than `MAX_CALLS` (32) calls, or has a call that is not valid.
 */
export function kernelExecuteCalldata(calls: Call[]): Hex {
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
  // A plain loop, not map: map skips the holes of a sparse array.
  const normalized: Required<Call>[] = [];
  for (let i = 0; i < calls.length; i++) {
    normalized.push(normalizeCall(calls[i], i));
  }

  const [only] = normalized;
  const [mode, executionCalldata] =
    normalized.length === 1 && only !== undefined
      ? [
          MODE_SINGLE,
          encodePacked(
            ['address', 'uint256', 'bytes'],
            [only.to, only.value, only.data],
          ),
        ]
      : [
          MODE_BATCH,
          encodeAbiParameters(BATCH_PARAMETERS, [
            normalized.map((c) => ({
              target: c.to,
              value: c.value,
              callData: c.data,
            })),
          ]),
        ];
  return encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: 'execute',
    args: [mode, executionCalldata],
  }).toLowerCase() as Hex;
}
