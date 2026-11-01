// Code that docs/positions.md quotes: type-checked, never run.

import {
  type PublicClient,
  type SecureClient,
  TransactionFailedError,
} from '@xomarket/client';

export async function listPositions(client: PublicClient, wallet: string) {
  // #region list-positions
  for await (const page of client.listPositions({ user: wallet })) {
    for (const position of page.items) {
      console.log(
        `${position.title}: ${position.currentSize} shares worth ${position.currentValue}`,
      );
    }
  }
  // #endregion list-positions
}

export async function account(client: SecureClient) {
  // #region balances
  const balances = await client.fetchBalances();
  console.log(`${balances.collateral} USDC to trade with`);

  const value = await client.fetchPortfolioValue();
  console.log(`Worth ${value.value} in all, ${value.cash} in cash`);
  // #endregion balances

  // #region pnl
  const pnl = await client.fetchUserPnl();
  console.log(`PnL ${pnl.pnl} (${pnl.percentPnl}%)`);
  // #endregion pnl

  // #region activity
  const { items } = await client.listActivity({ pageSize: 5 }).firstPage();

  for (const row of items) {
    console.log(row.timestamp, row.type, row.title, row.amount);
  }
  // #endregion activity
}

export async function merge(client: SecureClient, conditionId: string) {
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

export async function transferUsdc(client: SecureClient, to: string) {
  // #region transfer-usdc
  const transaction = await client.transferErc20({ to, amount: '1' }); // 1 USDC
  const receipt = await transaction.wait();
  console.log(`${receipt.status} in ${receipt.transactionHash}`);
  // #endregion transfer-usdc
  return receipt;
}

export async function unknownOutcome(client: SecureClient, to: string) {
  // #region unknown-outcome
  try {
    await client.transferErc20({ to, amount: '1' });
  } catch (error) {
    if (error instanceof TransactionFailedError && error.mayHaveLanded) {
      console.log(
        `May have landed: look up ${error.transactionHash ?? `nonce ${error.nonce}`}`,
      );
    }
    throw error;
  }
  // #endregion unknown-outcome
}
