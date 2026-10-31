import { createPublicClient } from '@xomarket/client';
import { privateKey } from '@xomarket/client/viem';
import { requireEnv } from './lib/env';

const signer = privateKey(requireEnv('XO_PK'));
const client = createPublicClient();

const owner = await signer.getAddress();

for (const index of [0, 1, 2]) {
  const wallet = await client.fetchSmartWalletAddress({ owner, index });
  console.log(`smart wallet ${index} of ${owner}: ${wallet}`);
}
