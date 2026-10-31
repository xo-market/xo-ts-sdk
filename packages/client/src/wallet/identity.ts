import {
  type Address,
  type Hex,
  hashTypedData,
  type TypedDataDefinition,
  zeroAddress,
} from 'viem';
import { isSameAddress, normalizeAddress } from '../core/address';
import type { EnvironmentConfig } from '../core/env';
import { UserInputError, XoError } from '../core/errors';
import { assertChainId, assertUint } from '../signing/internal';
import {
  encodeKernelSignature,
  kernelCreateAccountCalldata,
  kernelWrapTypedData,
} from '../signing/kernel';
import {
  errorName,
  isObject,
  normalizeSignature,
  WALLET_SHAPE_MESSAGE,
} from './internal';
import type { InternalSigner } from './signer';

/**
 * How the wallet trades:
 * - `{ type: 'eoa' }` (the default): the wallet itself is the trader and signs orders directly.
 * - `{ type: 'smart_wallet', index? }`: the wallet owns a smart wallet, and the smart wallet
 *   trades. It is counterfactual, so it need not be deployed. `index` numbers the owner's
 *   smart wallets and defaults to 0.
 */
export type WalletInput =
  | { type: 'eoa' }
  | { type: 'smart_wallet'; index?: number | bigint };

/** Who trades, and how their orders are signed. The session resolves it once, frozen. */
export interface TradingIdentity {
  /** `'eoa'`: the owner itself trades. `'smart_wallet'`: a smart wallet the owner owns trades. */
  readonly type: 'eoa' | 'smart_wallet';
  /** The wallet that signs. */
  readonly owner: Address;
  /** The trader on the exchange: the owner for `'eoa'`, the smart wallet for `'smart_wallet'`. */
  readonly address: Address;
  /** The order `signatureType`: 0 for an EOA, 3 for a smart wallet. */
  readonly signatureType: 0 | 3;
  /** The number of the owner's smart wallet. Set for `'smart_wallet'` only. */
  readonly index?: bigint;
}

/** The answer of the factory: an address, left-padded to a 32-byte ABI word. */
const ADDRESS_WORD_PATTERN = /^0x0{24}[0-9a-fA-F]{40}$/;

function smartWalletIndex(value: unknown): bigint {
  if (value === undefined) {
    return 0n;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new UserInputError(
        'wallet.index must be a non-negative safe integer; use a bigint for larger values',
      );
    }
    return BigInt(value);
  }
  if (typeof value === 'bigint') {
    return assertUint(value, 256, 'wallet.index');
  }
  throw new UserInputError('wallet.index must be a number or a bigint');
}

/**
 * `{}` for `{ type: 'eoa' }`, `{ index }` for `{ type: 'smart_wallet' }`. Throws a
 * `UserInputError` for any other shape, an extra key included.
 */
function parseWallet(wallet: unknown): { index?: bigint } {
  if (isObject(wallet)) {
    const keys = Object.keys(wallet);
    if (wallet.type === 'eoa' && keys.length === 1) {
      return {};
    }
    if (
      wallet.type === 'smart_wallet' &&
      keys.every((key) => key === 'type' || key === 'index')
    ) {
      return { index: smartWalletIndex(wallet.index) };
    }
  }
  throw new UserInputError(WALLET_SHAPE_MESSAGE);
}

function smartWalletAddressUnavailable(message: string): XoError {
  // No `cause`, on purpose: see errorName.
  return new XoError(message, {
    code: 'smart_wallet_address_unavailable',
    service: 'chain',
  });
}

/**
 * The address of the owner's smart wallet at `index`, read from the smart wallet factory with
 * one read-only call. The smart wallet does not have to be deployed.
 * @throws UserInputError for an invalid owner or validator.
 * @throws XoError with code `smart_wallet_address_unavailable` (service `chain`) if the read
 *   throws or does not answer an address other than zero. The message names the error type only.
 */
export async function lookupKernelAddress(
  owner: Address,
  index: bigint,
  env: EnvironmentConfig,
  readContract: (call: { to: Address; data: Hex }) => Promise<Hex>,
): Promise<Address> {
  // Outside the try below: an invalid owner or validator is the caller's input, not an outage.
  const data = kernelCreateAccountCalldata(
    owner,
    index,
    env.contracts.ecdsaValidator,
  );
  let result: unknown;
  try {
    result = await readContract({ to: env.contracts.kernelFactory, data });
  } catch (error) {
    throw smartWalletAddressUnavailable(
      `Smart wallet address lookup failed (${errorName(error)})`,
    );
  }
  if (typeof result !== 'string' || !ADDRESS_WORD_PATTERN.test(result)) {
    throw smartWalletAddressUnavailable(
      'Smart wallet address lookup returned something that is not an address',
    );
  }
  const address = normalizeAddress(`0x${result.slice(-40)}`);
  if (address === zeroAddress) {
    throw smartWalletAddressUnavailable(
      'Smart wallet address lookup returned the zero address',
    );
  }
  return address;
}

/**
 * Works out who trades. For `{ type: 'eoa' }` the owner trades and nothing is read. For
 * `{ type: 'smart_wallet' }` the factory is asked, with a read-only call, for the address of
 * the owner's smart wallet at that index; the smart wallet does not have to be deployed yet.
 * @param signer The owner.
 * @param wallet `{ type: 'eoa' }` or `{ type: 'smart_wallet', index? }`.
 * @param env The environment: its `contracts.kernelFactory` and ECDSA validator define the smart wallet.
 * @param readContract Runs a read-only `eth_call` of `data` on `to` and returns the raw result.
 * @throws UserInputError starting with `wallet`, `wallet.index` or `signer.address` (or `owner` or `validator`) for an invalid input.
 * @throws XoError with code `smart_wallet_address_unavailable` (service `chain`) if the lookup throws or does not answer an address. The message names the error type only.
 */
export async function resolveTradingIdentity(
  signer: InternalSigner,
  wallet: WalletInput,
  env: EnvironmentConfig,
  readContract: (call: { to: Address; data: Hex }) => Promise<Hex>,
): Promise<TradingIdentity> {
  const parsed = parseWallet(wallet);
  const owner = normalizeAddress(
    (isObject(signer) ? signer.address : undefined) as string,
    'signer.address',
  );
  if (parsed.index === undefined) {
    return Object.freeze({
      type: 'eoa',
      owner,
      address: owner,
      signatureType: 0,
    });
  }
  const address = await lookupKernelAddress(
    owner,
    parsed.index,
    env,
    readContract,
  );
  return Object.freeze({
    type: 'smart_wallet',
    owner,
    address,
    signatureType: 3,
    index: parsed.index,
  });
}

/**
 * Signs typed data (an order, a cancel, an L1 auth) as the trader.
 * - EOA: the signature of the owner over the typed data.
 * - Smart wallet: the owner signs the smart wallet's ERC-1271 wrap of the digest
 *   (`kernelWrapTypedData`, under the smart wallet's domain), and the result is
 *   `0x00 || signature` (66 bytes, `encodeKernelSignature`).
 *
 * Signing uses `signTypedData` only, so any {@link InternalSigner} works, with or without `signHash`.
 * For both types the signer's signature must be exactly 65 bytes (`r || s || v`; a compact
 * EIP-2098 signature is refused). A recovery byte `v` of 0 or 1 is changed to 27 or 28,
 * which is what on-chain ECDSA recovery (the exchange, the smart wallet's ECDSA validator)
 * expects; 27 and 28 pass through unchanged and any other `v` is refused.
 * @param chainId The chain of the smart wallet, a positive safe integer.
 * @throws UserInputError if `identity` or `signer` is not an object.
 * @throws UserInputError with code `signer_mismatch` if `signer.address` is not `identity.owner`. Checked before any signing: nothing is signed.
 * @throws UserInputError if `chainId` is not a positive safe integer, or the identity is not valid.
 * @throws SigningError if the signer does not return 65 bytes of hex, or `v` is not 0, 1, 27 or 28. The message does not quote the signature.
 */
export async function signAsTrader(
  identity: TradingIdentity,
  signer: InternalSigner,
  td: TypedDataDefinition,
  chainId: number,
): Promise<Hex> {
  if (!isObject(identity)) {
    throw new UserInputError('identity must be a trading identity');
  }
  if (!isObject(signer)) {
    throw new UserInputError('signer must be a Signer object');
  }
  if (!isSameAddress(identity.owner, signer.address as string)) {
    throw new UserInputError(
      'signer address is not the owner of the trading identity',
      { code: 'signer_mismatch' },
    );
  }
  const chain = assertChainId(chainId);

  if (identity.type === 'eoa') {
    return normalizeSignature(await signer.signTypedData(td));
  }
  if (identity.type === 'smart_wallet') {
    const inner = await signer.signTypedData(
      kernelWrapTypedData(hashTypedData(td), identity.address, chain),
    );
    return encodeKernelSignature(normalizeSignature(inner));
  }
  throw new UserInputError('identity.type must be "eoa" or "smart_wallet"');
}
