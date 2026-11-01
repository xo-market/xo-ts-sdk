# Real-time data

| Topic | Needs a key? | What it streams |
| --- | --- | --- |
| `market` | No | Order books, price changes and last trade prices |
| `activity` | No | Each new fill of one market |
| `user` | Yes | Your orders and trades in every market |
| `portfolio` | Yes | Your positions when they change |

For `user` and `portfolio`, use a client from `createSecureClient`.

## Stream an order book

<!-- snippet: docs/snippets/realtime.ts#realtime-book -->
```ts
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
```

Pass condition ids as `markets` or token ids as `assetIds`. A `book` event is the whole book
of one token, best price last, so replace your copy with each one.

An open stream keeps your process running after you leave the loop.
`client.closeSubscriptions()` closes every stream.

## Stream your orders and fills

<!-- snippet: docs/snippets/realtime.ts#realtime-orders -->
```ts
const handle = await client.subscribe([{ topic: 'user' }]);

for await (const event of handle) {
  if (event.type === 'order') {
    console.log(`order ${event.orderId}: ${event.kind}`);
  } else {
    console.log(`trade ${event.id}: ${event.status}`);
  }
}
```

An order's `kind` is `PLACEMENT`, `UPDATE` (a fill), `CANCELLATION` or `REJECTED`. A trade's
`status` goes from `MATCHED` through `MINED` to `CONFIRMED`, or to `FAILED` if the fill was
undone.

Open one long-lived `user` stream per process and share it. Each takes one of your account's
WebSocket slots.

## Stream your positions

<!-- snippet: docs/snippets/realtime.ts#watch -->
```ts
const handle = await client.subscribe([{ topic: 'portfolio' }]);

for await (const event of handle) {
  console.log(`${event.positions.length} positions`);
}
```

Each event lists your positions in your first 100 markets.

## Stream a market's fills

<!-- snippet: docs/snippets/realtime.ts#realtime-activity -->
```ts
const handle = await client.subscribe([{ topic: 'activity', marketId }]);

for await (const event of handle) {
  for (const trade of event.trades) {
    console.log(`${trade.side} ${trade.size} @ ${trade.price}`);
  }
}
```

The `activity` topic takes the market's `id`, not its condition id.

## Catch up after a reconnect

A stream reconnects by itself but does not replay what it missed.

<!-- snippet: docs/snippets/realtime.ts#realtime-resync -->
```ts
const handle = await client.subscribe([
  { topic: 'market', assetIds },
  { topic: 'user' },
]);

const readAgain = async (topic?: SubscriptionTopic) => {
  if (topic !== 'user') {
    const books = await client.fetchOrderBooks({ assetIds });
    console.log(`read ${books.length} books again`);
  }
  if (topic !== 'market') {
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
```

After `'reconnected'` or `ws_events_dropped`, read that topic again: `fetchOrderBooks` for
`market`, `listOpenOrders` for `user`, `listPositions` for `portfolio`.
`subscription_overflow` means your loop fell behind, so read every topic. See [Errors](errors.md).

## Next steps

- [Place an order](place-orders.md)
- [Read your positions](positions.md)
- [Every event type](reference/client/type-aliases/SubscriptionEvent.md)
