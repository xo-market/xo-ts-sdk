import { setTimeout as sleep } from 'node:timers/promises';
import { createSecureClient } from '@xomarket/client';
import { privateKey } from '@xomarket/client/viem';
import { requireEnv } from './lib/env';

const client = await createSecureClient({
  signer: privateKey(requireEnv('XO_PK')),
});

// One counted beat arms an account-wide auto-cancel that stopping does not disarm.
const heartbeat = client.startOrderHeartbeat({
  onMissed: (error) => console.warn(`Heartbeat missed: ${error.code}`),
});

console.log(`Heartbeat running: ${heartbeat.running}`);
await sleep(60_000);
heartbeat.stop();
console.log(
  'Heartbeat stopped: the account has 30 s before its open orders are canceled',
);
