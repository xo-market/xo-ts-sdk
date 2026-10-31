import type { Address, Hex } from 'viem';
import { isSameAddress, normalizeAddress } from '../core/address';
import type { EnvironmentConfig } from '../core/env';
import { UserInputError } from '../core/errors';
import { lookupKernelAddress } from '../wallet/identity';

// Which account a secure client trades from, worked out from the `wallet` address the user
// gives: the signer's own address is the plain wallet, and an address of one of the signer's
// smart wallets is that smart wallet. Internal: the secure client calls it before it signs in.

/** The most smart wallets of one owner the SDK looks at: indexes 0 to 9. */
export const SMART_WALLET_INDEXES = 10;

/** How the signer trades: from its own address, or from its smart wallet at `index`. */
export type WalletResolution =
  | { type: 'eoa' }
  | { type: 'smart_wallet'; index: bigint };

/**
 * Works out which of the signer's accounts `wallet` names.
 *
 * - No `wallet`, or the signer's own address (in any case): the plain wallet. Nothing is read.
 * - An address of one of the signer's smart wallets: that smart wallet. The smart wallet
 *   factory is asked for the addresses of indexes 0, 1, 2… with one read-only call each, up to
 *   index 9, and the first that matches is the answer. The smart wallet need not be deployed.
 * - Anything else is not the signer's: `wallet_not_owned`.
 *
 * Only the chain is read. Nothing is signed and nothing is sent to XO, so a wallet that is not
 * the signer's is refused before any sign-in.
 *
 * @param owner The signer's address.
 * @param wallet The `wallet` option: a `0x` address in any case, or `undefined`.
 * @param env Its smart wallet factory and validator define the smart wallets.
 * @param readContract A read-only `eth_call` of `data` on `to`.
 * @throws UserInputError `invalid_input` when `wallet` is not an address, and
 *   `wallet_not_owned` when it is neither the signer's address nor one of its smart wallets
 *   0 to 9. The messages never repeat the value.
 * @throws XoError `smart_wallet_address_unavailable` (service `chain`) when a factory read fails.
 */
export async function resolveWalletAddress(
  owner: Address,
  wallet: string | undefined,
  env: EnvironmentConfig,
  readContract: (call: { to: Address; data: Hex }) => Promise<Hex>,
): Promise<WalletResolution> {
  if (wallet === undefined) {
    return { type: 'eoa' };
  }
  let target: Address;
  try {
    target = normalizeAddress(wallet);
  } catch {
    throw new UserInputError(
      "wallet must be a 0x address: the signer's own, or one of its smart wallets",
    );
  }
  if (isSameAddress(target, owner)) {
    return { type: 'eoa' };
  }
  for (let index = 0n; index < BigInt(SMART_WALLET_INDEXES); index += 1n) {
    const address = await lookupKernelAddress(owner, index, env, readContract);
    if (isSameAddress(address, target)) {
      return { type: 'smart_wallet', index };
    }
  }
  throw new UserInputError(
    `wallet is not the signer's: it is neither the signer's address nor one of its smart wallets 0 to ${SMART_WALLET_INDEXES - 1}. Pass the signer that owns it, or leave wallet out to trade from the signer's own address`,
    { code: 'wallet_not_owned' },
  );
}
