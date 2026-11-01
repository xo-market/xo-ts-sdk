// Code that docs/realtime.md quotes: type-checked, never run.

import type {
  PublicClient,
  SecureClient,
  SubscriptionTopic,
} from '@xomarket/client';

export async function watchBook(client: PublicClient, conditionId: string) {
  // #region realtime-book
  const handle = await client.subscribe([
    { topic: 'market', markets: [conditionId] },
  ]);

  for await (const event of handle) {
    if (event.type === 'book') {
      console.log(event.assetId, event.bids.at(-1), event.asks.at(-1));
      break;
    }
  }

  await handle.close();
  // #endregion realtime-book
}

export async function watchOrders(client: SecureClient) {
  // #region realtime-orders
  const handle = await client.subscribe([{ topic: 'user' }]);

  for await (const event of handle) {
    if (event.type === 'order') {
      console.log(`order ${event.orderId}: ${event.kind}`);
    } else {
      console.log(`trade ${event.id}: ${event.status}`);
    }
  }
  // #endregion realtime-orders
}

export async function watchPortfolio(client: SecureClient) {
  // #region watch
  const handle = await client.subscribe([{ topic: 'portfolio' }]);

  for await (const event of handle) {
    console.log(`${event.positions.length} positions`);
  }
  // #endregion watch
}

export async function watchFills(client: PublicClient, marketId: string) {
  // #region realtime-activity
  const handle = await client.subscribe([{ topic: 'activity', marketId }]);

  for await (const event of handle) {
    for (const trade of event.trades) {
      console.log(`${trade.side} ${trade.size} @ ${trade.price}`);
    }
  }
  // #endregion realtime-activity
}

export async function liveWithResync(client: SecureClient, assetIds: string[]) {
  // #region realtime-resync
  const handle = await client.subscribe([
    { topic: 'market', assetIds },
    { topic: 'user' },
  ]);

  const readAgain = async (topic?: SubscriptionTopic) => {
    if (topic === 'market' || topic === undefined) {
      const books = await client.fetchOrderBooks({ assetIds });
      console.log(`read ${books.length} books again`);
    }
    if (topic === 'user' || topic === undefined) {
      for await (const page of client.listOpenOrders()) {
        console.log(`read ${page.items.length} open orders again`);
      }
    }
  };

  handle.on('reconnected', ({ topic }) => {
    readAgain(topic).catch(console.error);
  });
  handle.on('error', (error) => {
    if (
      error.code === 'ws_events_dropped' ||
      error.code === 'subscription_overflow'
    ) {
      readAgain(error.topic).catch(console.error);
    }
  });
  // #endregion realtime-resync
  return handle;
}
