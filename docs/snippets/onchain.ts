// Code that docs/onchain.md quotes: type-checked, never run.

import type { SecureClient } from '@xomarket/client';

export async function setupTrading(client: SecureClient) {
  // #region setup
  const state = await client.fetchTradingApprovalsState();
  console.log(
    state.ready ? 'Ready to trade' : 'Approvals missing: setting them up',
  );

  const transaction = await client.setupTradingApprovals();
  console.log(
    transaction === null
      ? 'Already set up: nothing sent'
      : `Set up in transaction ${transaction.transactionHash}`,
  );
  // #endregion setup
}

export async function transferUsdc(client: SecureClient, to: string) {
  // #region transfer-usdc
  const transaction = await client.transferErc20({ to, amount: '1' });
  const receipt = await transaction.wait();
  console.log(`${receipt.status} in ${receipt.transactionHash}`);
  // #endregion transfer-usdc
  return receipt;
}

export async function mergeAll(client: SecureClient, conditionId: string) {
  // #region merge
  const transaction = await client.mergePositions({ conditionId });
  const receipt = await transaction.wait();
  console.log(`${receipt.status} in ${receipt.transactionHash}`);
  // #endregion merge
  return receipt;
}

export async function redeemAll(client: SecureClient) {
  // #region redeem-all
  const results = await client.redeemAllPositions();

  for (const result of results) {
    if (result.ok) {
      const receipt = await result.transaction.wait();
      console.log(`${result.conditionId}: ${receipt.status}`);
    } else {
      console.log(`${result.conditionId}: ${result.error.code}`);
    }
  }
  // #endregion redeem-all
  return results;
}
