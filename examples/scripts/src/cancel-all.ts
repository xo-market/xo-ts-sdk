import { createSecureClient } from '@xomarket/client';
import { privateKey } from '@xomarket/client/viem';
import { requireEnv } from './lib/env';

const client = await createSecureClient({
  signer: privateKey(requireEnv('XO_PK')),
});

const { canceled, notCanceled } = await client.cancelAll();

console.log(`Canceled ${canceled.length} order(s)`);
for (const [orderId, reason] of Object.entries(notCanceled)) {
  console.log(`  not canceled ${orderId}: ${reason}`);
}
