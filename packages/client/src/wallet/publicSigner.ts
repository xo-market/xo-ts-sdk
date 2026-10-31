import type {
  Address,
  Hex,
  LocalAccount,
  TypedDataDefinition,
  WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { normalizeAddress } from '../core/address';
import { SigningError, UserInputError } from '../core/errors';
import { errorName, isObject } from './internal';
import type { InternalSigner } from './signer';

/**
 * Something that signs for a wallet. Implement it to sign with a key the SDK must not hold
 * (a key management service, a hardware wallet), or make one with `privateKey` or
 * `signerFrom` from `@xomarket/client/viem`.
 *
 * The address is asked for with `getAddress()`, so it may come from somewhere that needs a
 * round trip. The SDK asks once, when the signer is first used. A signer made by this
 * package holds nothing but functions: a private key stays in a closure, so logging,
 * `JSON.stringify` or `util.inspect` of it can never show it.
 */
export interface Signer {
  /**
   * The address of the wallet. Any case; the SDK checksums it.
   * @returns The wallet's `0x` address.
   */
  getAddress(): Promise<Address>;
  /**
   * An EIP-191 `personal_sign` signature of a text message.
   * @param message The text to sign.
   * @returns The signature as `0x` hex.
   */
  signMessage(message: string): Promise<Hex>;
  /**
   * An EIP-712 signature of typed data.
   * @param typedData The domain, types, primary type and message to sign.
   * @returns The signature as `0x` hex.
   */
  signTypedData(typedData: TypedDataDefinition): Promise<Hex>;
  /**
   * A signature of a raw 32-byte digest, with no prefix and no hashing. Only a signer that
   * holds the key itself can do this, so a wallet client (a browser wallet, a hardware
   * wallet) leaves the property out. Logins, orders and cancels do not need it; on-chain
   * transactions do, and are refused for a signer without it (`sign_hash_unsupported`).
   * @param hash The 32-byte digest.
   * @returns The signature as `0x` hex.
   */
  signHash?(hash: Hex): Promise<Hex>;
}

/** A secp256k1 private key: `0x` and 32 bytes of hex. */
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * The signer of a viem local account. It has `signHash` only when the account has `sign`. The
 * address is read once, here.
 *
 * @throws {UserInputError} If `a` is not an account with an address, `signMessage` and
 *   `signTypedData`.
 */
function accountSigner(a: LocalAccount): Signer {
  if (
    !isObject(a) ||
    typeof a.signMessage !== 'function' ||
    typeof a.signTypedData !== 'function'
  ) {
    throw new UserInputError(
      'account must be a viem local account with signMessage and signTypedData',
    );
  }
  const address = normalizeAddress(a.address, 'account.address');
  const hasSign = typeof a.sign === 'function';
  return Object.freeze({
    getAddress: async () => address,
    signMessage: async (message: string) => a.signMessage({ message }),
    signTypedData: async (typedData: TypedDataDefinition) =>
      a.signTypedData(typedData),
    // Left out entirely (not set to undefined) when the account cannot sign a raw hash.
    ...(hasSign
      ? {
          signHash: async (hash: Hex) =>
            (a.sign as NonNullable<LocalAccount['sign']>)({ hash }),
        }
      : {}),
  });
}

/**
 * The signer of a viem wallet client. Its `account` is read once, here, and passed explicitly
 * to every sign call. There is no `signHash`: a wallet does not sign raw digests.
 *
 * @throws {UserInputError} If the client has no `account`.
 */
function walletClientSigner(wc: WalletClient): Signer {
  const account = isObject(wc) ? wc.account : undefined;
  if (!isObject(account)) {
    throw new UserInputError(
      'walletClient must have an account; create it with createWalletClient({ account, ... })',
    );
  }
  const address = normalizeAddress(
    account.address as string,
    'walletClient.account.address',
  );
  return Object.freeze({
    getAddress: async () => address,
    signMessage: async (message: string) =>
      wc.signMessage({ account, message }),
    // `account` goes last, so nothing in `typedData` can choose another one.
    signTypedData: async (typedData: TypedDataDefinition) =>
      wc.signTypedData({ ...typedData, account }),
  });
}

/**
 * A signer for a private key. The key stays in a closure.
 * @param key The key: `0x` and 32 bytes of hex. Any string is accepted at compile time (an
 *   environment variable is a `string`, not a `Hex`) and checked here.
 * @returns A frozen signer that can also sign a raw hash.
 * @throws {UserInputError} `invalid_private_key` if `key` is not 32 bytes of hex or is not a
 *   valid secp256k1 key. The message starts with `privateKey` and never contains the key.
 * @example
 * const signer = privateKey(process.env.XO_PK as string);
 * console.log(await signer.getAddress());
 */
export function privateKey(key: Hex | string): Signer {
  if (typeof key !== 'string' || !PRIVATE_KEY_PATTERN.test(key)) {
    throw new UserInputError(
      'privateKey must be a 0x-prefixed 32-byte hex string',
      { code: 'invalid_private_key' },
    );
  }
  let account: LocalAccount;
  try {
    account = privateKeyToAccount(key as Hex);
  } catch {
    // No cause: keep whatever the library says about the key out of the error.
    throw new UserInputError(
      'privateKey is not a valid secp256k1 private key',
      { code: 'invalid_private_key' },
    );
  }
  return accountSigner(account);
}

/**
 * A signer for a viem local account (`privateKeyToAccount`, a mnemonic account, `toAccount`)
 * or a viem wallet client such as a browser wallet or a hardware wallet.
 *
 * An account can sign a raw hash when it has `sign`, so then the signer has `signHash`. A
 * wallet client has no `signHash`: a wallet does not sign raw digests. A wallet client needs
 * an `account`, which is read once here and passed explicitly to every sign call.
 * @param source A viem local account, or a wallet client created with an `account`.
 * @returns A frozen signer.
 * @throws {UserInputError} If `source` is neither a local account with an address,
 *   `signMessage` and `signTypedData`, nor a wallet client with an `account`.
 * @example
 * const signer = signerFrom(privateKeyToAccount(process.env.XO_PK as Hex));
 * console.log(await signer.getAddress());
 */
export function signerFrom(source: LocalAccount | WalletClient): Signer {
  const shape: unknown = source;
  if (isObject(shape)) {
    // A local account has an address of its own; a wallet client holds an account instead.
    if (typeof shape.address === 'string') {
      return accountSigner(source as LocalAccount);
    }
    if ('account' in shape) {
      return walletClientSigner(source as WalletClient);
    }
  }
  throw new UserInputError(
    'source must be a viem local account or a viem wallet client',
  );
}

/**
 * The internal shape of a signer, for the engines that sign: the address is read once,
 * here, and kept, so no engine ever waits for it. The functions of `signer` are kept as they
 * are now and called as its methods. `signHash` is there only when `signer` has one. The
 * result is frozen.
 * @param signer The public signer, made by this package or written by hand.
 * @returns The internal signer: its `address` (checksummed) and the sign functions.
 * @throws {UserInputError} If `signer` lacks `getAddress`, `signMessage` or `signTypedData`
 *   (the message starts with `signer`), or its address is not an address (`signer.address`).
 * @throws {SigningError} `signing_failed` if `getAddress` throws. The message names the error
 *   type only.
 */
export async function toInternalSigner(
  signer: Signer,
): Promise<InternalSigner> {
  if (
    !isObject(signer) ||
    typeof signer.getAddress !== 'function' ||
    typeof signer.signMessage !== 'function' ||
    typeof signer.signTypedData !== 'function'
  ) {
    throw new UserInputError(
      'signer must be a Signer with getAddress, signMessage and signTypedData functions',
    );
  }
  const { getAddress, signMessage, signTypedData, signHash } = signer;
  let reported: unknown;
  try {
    reported = await getAddress.call(signer);
  } catch (error) {
    // No `cause`, on purpose: see errorName.
    throw new SigningError(
      `The signer could not give its address (${errorName(error)}): nothing was sent`,
    );
  }
  const address = normalizeAddress(reported as string, 'signer.address');
  return Object.freeze({
    address,
    signMessage: async (message: string) => signMessage.call(signer, message),
    signTypedData: async (typedData: TypedDataDefinition) =>
      signTypedData.call(signer, typedData),
    ...(typeof signHash === 'function'
      ? { signHash: async (hash: Hex) => signHash.call(signer, hash) }
      : {}),
  });
}
