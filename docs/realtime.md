# Live data

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

The `market` topic needs no key. Pass condition ids as `markets`, or outcome tokens as `assetIds`.
A `book` event is the whole book of one token, best price last, so replace your copy with each
one. The topic also sends `price_change` and `last_trade_price` events: switch on `event.type`.

Leaving the loop does not close the stream, and an open stream keeps your process running. Call
`handle.close()` when you are done, or `client.closeSubscriptions()` to close them all.

## Stream your orders and fills

The `user` topic needs a client from `createSecureClient`. It covers every market.

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

An order's `kind` is `PLACEMENT`, `UPDATE` (a fill), `CANCELLATION` or `REJECTED`. A trade is
`MATCHED`, then `MINED` and `CONFIRMED` as it settles, or `FAILED` if the fill was undone.

Open one `user` stream per process, keep it open and share it. Each one takes one of your
account's WebSocket slots.

## Stream your positions

<!-- snippet: docs/snippets/realtime.ts#watch -->
```ts
const handle = await client.subscribe([{ topic: 'portfolio' }]);

for await (const event of handle) {
  console.log(`${event.positions.length} positions`);
}
```

The `portfolio` topic also needs a secure client. Each event holds all your positions, as
`listPositions()` lists them, in your first 100 markets.

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

The `activity` topic needs no key. It takes the market's `id`, not its condition id.

## Catch up after a reconnect

A stream reconnects by itself, but it does not replay what it missed. Your loop does not see
this, so listen on the handle.

<!-- snippet: docs/snippets/realtime.ts#realtime-resync -->
```ts
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
```

After `'reconnected'` or `ws_events_dropped`, read that topic's state again: `fetchOrderBooks`
for `market`, `listOpenOrders` for `user`, `listPositions` for `portfolio`. `subscription_overflow`
means your loop fell behind. It names no topic, so read them all. See [Errors](errors.md).

## Next steps

- [Place an order](orders.md)
- [Read your portfolio](portfolio.md)
- [Every event type](reference/client/type-aliases/SubscriptionEvent.md)
