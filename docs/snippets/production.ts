// Code that docs/production.md quotes: type-checked, never run.

import {
  createPublicClient,
  createSecureClient,
  type PublicClient,
  type SecureClient,
} from '@xomarket/client';
import { fileStore } from '@xomarket/client/node';
import { privateKey } from '@xomarket/client/viem';
import { describeError as describe } from './errors';

/** A client for a server that runs on its own. */
export async function productionClient(key: string) {
  // #region production-client
  const client = await createSecureClient({
    signer: privateKey(key),
    store: fileStore('/var/lib/my-bot/xo'),
    label: 'my-bot',
    shutdownHooks: false,
  });
  // #endregion production-client
  return client;
}

/** Cancels every open order, then closes the client: how a bot stops. */
export async function shutDown(
  client: SecureClient,
  log: (line: string) => void,
) {
  let code = 0;
  // #region stop-cancel
  try {
    const cancelled = await client.cancelAll().catch((error: unknown) => {
      log(`cancelAll failed: ${describe(error)}. Sending it once more`);
      return client.cancelAll();
    });
    log(`cancelAll canceled ${cancelled.canceled.length} order(s)`);
  } catch (error) {
    log(`cancelAll FAILED: ${describe(error)}. Check your open orders!`);
    code = 1;
  }
  await client.close();
  // #endregion stop-cancel
  return code;
}

/** Starts the order heartbeat, the account-wide dead-man switch. */
export function startHeartbeat(client: SecureClient) {
  // #region heartbeat
  const heartbeat = client.startOrderHeartbeat({
    onMissed: (error) => console.warn(`Heartbeat missed: ${error.code}`),
  });
  // #endregion heartbeat
  return heartbeat;
}

/** A read with a timeout of its own, no retries, and a signal that cancels it. */
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

/** Warns when a service says no requests are left in the window. */
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
