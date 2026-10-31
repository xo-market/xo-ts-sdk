// Code that docs/realtime.md quotes: type-checked, never run.

import type { PublicClient, SecureClient } from '@xomarket/client';

/** A market's live order book: its first 10 events, for 60 seconds at most. */
export async function watchBook(client: PublicClient, conditionId: string) {
  try {
    // #region realtime-book
    const handle = await client.subscribe([
      { topic: 'market', markets: [conditionId] },
    ]);
    setTimeout(() => void handle.close(), 60_000).unref();

    let count = 0;
    for await (const event of handle) {
      if (event.type === 'book') {
        console.log(
          `book ${event.assetId}: ${event.bids.length} bids, ${event.asks.length} asks`,
        );
      } else if (event.type === 'last_trade_price') {
        console.log(`trade ${event.side} ${event.size} @ ${event.price}`);
      } else {
        console.log(`${event.priceChanges.length} price change(s)`);
      }
      if (++count === 10) {
        break;
      }
    }
    // #endregion realtime-book
  } finally {
    await client.closeSubscriptions();
  }
}

/** The account's orders and trades, live, on every market. */
export async function watchOrders(client: SecureClient) {
  // #region realtime-orders
  const handle = await client.subscribe([{ topic: 'user' }]);
  for await (const event of handle) {
    if (event.type === 'order') {
      console.log(`order ${event.kind} ${event.orderId}: ${event.status}`);
    } else {
      console.log(`trade ${event.id}: ${event.status}`);
    }
  }
  // #endregion realtime-orders
}

/** The account's positions, live: every change sends them all. */
export async function watchPortfolio(client: SecureClient) {
  // #region watch
  const handle = await client.subscribe([{ topic: 'portfolio' }]);
  handle.on('reconnected', () => console.log('portfolio stream reconnected'));
  handle.on('error', (error) => console.log(`portfolio error ${error.code}`));
  for await (const event of handle) {
    console.log(`${event.positions.length} position(s) at ${event.timestamp}`);
  }
  // #endregion watch
}

/** One market's fills, live, by XO's id for the market. */
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

/** One market's books and the account's orders, live, read again after a gap. */
export async function liveWithResync(client: SecureClient, assetIds: string[]) {
  // #region realtime-resync
  const handle = await client.subscribe([
    { topic: 'market', assetIds },
    { topic: 'user' },
  ]);
  const readAgain = async (topic: string) => {
    if (topic === 'market') {
      const books = await client.fetchOrderBooks({ assetIds });
      console.log(`read ${books.length} books again`);
    } else if (topic === 'user') {
      let open = 0;
      for await (const page of client.listOpenOrders()) {
        open += page.items.length;
      }
      console.log(`read ${open} open orders again`);
    }
  };
  handle.on('reconnected', ({ topic }) => {
    void readAgain(topic).catch(console.error);
  });
  handle.on('error', (error) => {
    if (error.code === 'ws_events_dropped' && error.topic !== undefined) {
      void readAgain(error.topic).catch(console.error);
    } else if (error.code === 'subscription_overflow') {
      void Promise.all([readAgain('market'), readAgain('user')]).catch(
        console.error,
      );
    }
  });
  // #endregion realtime-resync
  return handle;
}
