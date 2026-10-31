import { createSecureClient } from '@xomarket/client';
import { privateKey } from '@xomarket/client/viem';
import { requireEnv } from './lib/env';

const client = await createSecureClient({
  signer: privateKey(requireEnv('XO_PK')),
});

const balances = await client.fetchBalances();
console.log(`${client.wallet}: ${balances.collateral} USDC to trade with`);
console.table(balances.positions);

const value = await client.fetchPortfolioValue();
console.table(value);

const pnl = await client.fetchUserPnl();
console.log(`PnL ${pnl.pnl} (${pnl.percentPnl} %), ${pnl.openPositions} open`);

const activity = await client.listActivity({ pageSize: 5 }).firstPage();
console.table(activity.items, ['timestamp', 'type', 'title', 'amount']);
