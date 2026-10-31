// Code that docs/portfolio.md quotes: type-checked, never run.

import {
  createSecureClient,
  type PublicClient,
  type SecureClient,
} from '@xomarket/client';
import { privateKey } from '@xomarket/client/viem';
import { requireEnv } from '../../examples/scripts/src/lib/env';

/** A signed-in client, with the key from the environment. */
export async function secureClient() {
  // #region client
  const client = await createSecureClient({
    signer: privateKey(requireEnv('XO_PK')),
  });
  // #endregion client
  return client;
}

/** The positions of any wallet, by its address. */
export async function listPositions(client: PublicClient, wallet: string) {
  // #region list-positions
  const rows = [];

  for await (const page of client.listPositions({ user: wallet })) {
    rows.push(
      ...page.items.map((position) => ({
        market: position.title,
        outcome: position.outcome ?? '',
        size: position.currentSize,
        value: position.currentValue,
        avgPrice: position.avgPrice ?? '',
        price: position.currentPrice ?? '',
        pnl: position.unrealizedPnl,
        redeemable: position.redeemable,
      })),
    );
  }

  console.log(`${rows.length} position(s) of ${wallet}`);
  console.table(rows);
  // #endregion list-positions
}

/** The account at a glance: balances, portfolio value, PnL and latest activity. */
export async function dashboard(client: SecureClient) {
  // #region balances
  const balances = await client.fetchBalances();
  console.log(`${client.wallet}: ${balances.collateral} USDC to trade with`);
  console.table(balances.positions);
  // #endregion balances

  // #region portfolio
  const value = await client.fetchPortfolioValue();
  console.table(value);
  // #endregion portfolio

  // #region pnl
  const pnl = await client.fetchUserPnl();
  console.log(
    `PnL ${pnl.pnl} (${pnl.percentPnl} %), ${pnl.openPositions} open`,
  );
  // #endregion pnl

  // #region activity
  const activity = await client.listActivity({ pageSize: 5 }).firstPage();
  console.table(activity.items, ['timestamp', 'type', 'title', 'amount']);
  // #endregion activity
}
