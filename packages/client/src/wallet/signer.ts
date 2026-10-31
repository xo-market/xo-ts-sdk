import type { Address, Hex, TypedDataDefinition } from 'viem';

/**
 * The signer the engines sign with: the address, read once, and the sign functions. The public
 * `Signer` (`./publicSigner`) becomes one with `toInternalSigner`. It holds an `address` and
 * functions, nothing else, and every method returns a plain `0x` hex string.
 */
export interface InternalSigner {
  /** The checksummed address of the wallet. */
  readonly address: Address;
  /** An EIP-191 `personal_sign` signature of a text message. */
  signMessage(message: string): Promise<Hex>;
  /** An EIP-712 signature of typed data. */
  signTypedData(td: TypedDataDefinition): Promise<Hex>;
  /**
   * A signature of a raw 32-byte digest, with no prefix and no hashing. Only a signer that
   * holds the key itself can do this, so wallet clients (a browser wallet, a hardware
   * wallet) leave the property out. Logins, orders and cancels do not need it (they go
   * through `signMessage` and `signTypedData`); on-chain transactions do: the rails sign the
   * transaction's hash with it, and refuse a signer without it (`sign_hash_unsupported`).
   */
  signHash?(hash: Hex): Promise<Hex>;
}
