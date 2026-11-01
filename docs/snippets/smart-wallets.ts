// Code that docs/smart-wallets.md quotes: type-checked, never run.

import { createPublicClient, createSecureClient } from '@xomarket/client';
import { privateKey } from '@xomarket/client/viem';
import { requireEnv } from '../../examples/scripts/src/lib/env';

/** The address of a key's smart wallet 0, from the factory on chain. */
export async function smartWalletAddress() {
  const signer = privateKey(requireEnv('XO_PK'));
  const client = createPublicClient();

  // #region smart-wallet-address
  const owner = await signer.getAddress();
  const wallet = await client.fetchSmartWalletAddress({ owner, index: 0 });
  console.log(`Smart wallet 0: ${wallet}`);
  // #endregion smart-wallet-address
}

/** A client that trades from a smart wallet the key owns: the wallet trades, the key signs. */
export async function smartWalletClient() {
  // #region make-client
  const client = await createSecureClient({
    signer: privateKey(requireEnv('XO_PK')),
    wallet: requireEnv('XO_SMART_WALLET'),
  });
  console.log(`Trading as ${client.wallet}`);
  // #endregion make-client

  // #region setup
  const transaction = await client.setupTradingApprovals();
  console.log(transaction?.transactionHash ?? 'Nothing to set up');
  // #endregion setup
  return client;
}
