// Code that docs/onchain.md quotes: type-checked, never run.

import type { SecureClient } from '@xomarket/client';

/** The one-time approvals before the first order. */
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

/** Sends 1 USDC to `to`, another wallet of yours. */
export async function transferUsdc(client: SecureClient, to: string) {
  // #region transfer-usdc
  const transaction = await client.transferErc20({ to, amount: '1' });
  const receipt = await transaction.wait();
  console.log(
    `${receipt.status} in transaction ${receipt.transactionHash}, block ${receipt.blockNumber}`,
  );
  // #endregion transfer-usdc
  return receipt;
}

/** Merges every free YES + NO pair of one market back into USDC. */
export async function mergeAll(client: SecureClient, conditionId: string) {
  // #region merge
  const transaction = await client.mergePositions({ conditionId });
  const receipt = await transaction.wait();
  console.log(`Merged: ${receipt.status} in ${receipt.transactionHash}`);
  // #endregion merge
  return receipt;
}

/** Redeems the shares in every resolved market for USDC. */
export async function redeemAll(client: SecureClient) {
  // #region redeem-all
  const results = await client.redeemAllPositions();

  for (const result of results) {
    if (result.ok) {
      console.log(
        `${result.conditionId}: redeemed in ${result.transaction.transactionHash}`,
      );
    } else {
      console.log(
        `${result.conditionId}: ${result.error.mayHaveLanded ? 'outcome unknown' : 'nothing sent'} (${result.error.code})`,
      );
    }
  }
  console.log(`${results.length} market(s) to redeem`);
  // #endregion redeem-all
  return results;
}
