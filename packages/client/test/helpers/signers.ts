import {
  getAddress,
  type Hex,
  type LocalAccount,
  type TypedDataDefinition,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { InternalSigner } from '../../src/wallet/signer';

// The internal signer the engines sign with, made from a key, a viem account or a wallet client,
// for the tests of the engines. The public signers (`privateKey`, `signerFrom`) and their
// conversion (`toInternalSigner`) are tested in wallet/publicSigner.test.ts.

/** The internal signer of a viem local account: with `signHash` when it has `sign`. Frozen. */
export function accountSigner(account: LocalAccount): InternalSigner {
  const hasSign = typeof account.sign === 'function';
  return Object.freeze({
    address: getAddress(account.address),
    signMessage: async (message: string) => account.signMessage({ message }),
    signTypedData: async (td: TypedDataDefinition) => account.signTypedData(td),
    ...(hasSign
      ? {
          signHash: async (hash: Hex) =>
            (account.sign as NonNullable<LocalAccount['sign']>)({ hash }),
        }
      : {}),
  });
}

/** The internal signer of a private key (`0x` and 32 bytes of hex). */
export function keySigner(key: Hex | string): InternalSigner {
  return accountSigner(privateKeyToAccount(key as Hex));
}

/** The internal signer of a viem wallet client that has an `account`: no `signHash`. Frozen. */
export function walletClientSigner(wc: WalletClient): InternalSigner {
  const { account } = wc;
  if (account === undefined) {
    throw new Error('the wallet client needs an account');
  }
  return Object.freeze({
    address: getAddress(account.address),
    signMessage: async (message: string) =>
      wc.signMessage({ account, message }),
    signTypedData: async (td: TypedDataDefinition) =>
      wc.signTypedData({ ...td, account }),
  });
}
