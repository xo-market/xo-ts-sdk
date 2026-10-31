import { createSecureClient } from '@xomarket/client';
import { privateKey } from '@xomarket/client/viem';
import { requireEnv } from './lib/env';

const to = requireEnv('XO_TO');
const client = await createSecureClient({
  signer: privateKey(requireEnv('XO_PK')),
});

const transaction = await client.transferErc20({ to, amount: '1' });
const receipt = await transaction.wait();
console.log(
  `${receipt.status} in transaction ${receipt.transactionHash}, block ${receipt.blockNumber}`,
);
