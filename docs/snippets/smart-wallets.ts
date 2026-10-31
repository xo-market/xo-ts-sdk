// Code that docs/smart-wallets.md quotes: type-checked, never run.

import { createPublicClient, createSecureClient } from '@xomarket/client';
import { privateKey } from '@xomarket/client/viem';
import { requireEnv } from '../../examples/scripts/src/lib/env';

/** The addresses of a key's first three smart wallets, from the factory on chain. */
export async function smartWalletAddresses() {
  const signer = privateKey(requireEnv('XO_PK'));
  const client = createPublicClient();

  // #region smart-wallet-address
  const owner = await signer.getAddress();

  for (const index of [0, 1, 2]) {
    const wallet = await client.fetchSmartWalletAddress({ owner, index });
    console.log(`smart wallet ${index} of ${owner}: ${wallet}`);
  }
  // #endregion smart-wallet-address
}

/** A client that trades from a smart wallet the key owns: the wallet trades, the key signs. */
export async function smartWalletClient() {
  // #region make-client
  const signer = privateKey(requireEnv('XO_PK'));
  const client = await createSecureClient({
    signer,
    wallet: requireEnv('XO_SMART_WALLET'),
  });
  // #endregion make-client

  // #region addresses
  console.log(
    `signer ${await signer.getAddress()}, trading as ${client.wallet}`,
  );
  // #endregion addresses

  // #region setup
  const transaction = await client.setupTradingApprovals();
  console.log(
    transaction === null
      ? 'setup: approved already, nothing sent'
      : `setup: sent in transaction ${transaction.transactionHash}`,
  );
  // #endregion setup
  return client;
}
