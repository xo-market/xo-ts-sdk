import { createSecureClient } from '@xomarket/client';
import { privateKey } from '@xomarket/client/viem';
import { requireEnv } from './lib/env';

const client = await createSecureClient({
  signer: privateKey(requireEnv('XO_PK')),
});

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
