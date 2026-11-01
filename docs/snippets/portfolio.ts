// Code that docs/portfolio.md quotes: type-checked, never run.

import {
  createSecureClient,
  type PublicClient,
  type SecureClient,
} from '@xomarket/client';
import { privateKey } from '@xomarket/client/viem';
import { requireEnv } from '../../examples/scripts/src/lib/env';

export async function secureClient() {
  // #region client
  const client = await createSecureClient({
    signer: privateKey(requireEnv('XO_PK')),
  });
  // #endregion client
  return client;
}

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

export async function dashboard(client: SecureClient) {
  // #region balances
  const balances = await client.fetchBalances();
  console.log(`${client.wallet}: ${balances.collateral} USDC to trade with`);
  console.table(balances.positions);
  // #endregion balances

  // #region portfolio
  const value = await client.fetchPortfolioValue();
  console.log(`Worth ${value.value} in all, ${value.cash} in cash`);
  // #endregion portfolio

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
