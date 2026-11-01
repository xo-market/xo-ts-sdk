// Code that docs/production.md and SDK_DIRECTION.md quote: type-checked, never run.

import {
  createPublicClient,
  createSecureClient,
  type PublicClient,
  type SecureClient,
} from '@xomarket/client';
import { fileStore } from '@xomarket/client/node';
import { privateKey } from '@xomarket/client/viem';

export async function productionClient(key: string) {
  // #region production-client
  const client = await createSecureClient({
    signer: privateKey(key),
    store: fileStore('/var/lib/my-bot/xo'),
    label: 'my-bot',
  });
  // #endregion production-client
  return client;
}

export async function shutDown(client: SecureClient) {
  // #region stop-cancel
  try {
    await client.cancelAll();
  } finally {
    await client.close();
  }
  // #endregion stop-cancel
}

export function startHeartbeat(client: SecureClient) {
  // #region heartbeat
  const heartbeat = client.startOrderHeartbeat({
    onMissed: (error) => console.warn(`Heartbeat missed: ${error.code}`),
  });
  // #endregion heartbeat
  return heartbeat;
}

export async function quickRead(
  client: PublicClient,
  assetId: string,
  signal: AbortSignal,
) {
  // #region request-options
  const book = await client.fetchOrderBook(
    { assetId },
    { timeout: 5_000, retries: 0, signal },
  );
  // #endregion request-options
  return book;
}

export function rateLimitClient() {
  // #region rate-limit
  const client = createPublicClient({
    onRateLimitUpdate: (update) => {
      if (update.remaining === 0) {
        console.warn(`${update.service} rate limit reached on ${update.path}`);
      }
    },
  });
  // #endregion rate-limit
  return client;
}
