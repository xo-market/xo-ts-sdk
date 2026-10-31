# Live data

`subscribe` opens one or more live topics through one handle. Read the handle with `for await`,
and close it when you are done. Every stream reconnects by itself.

| Topic | Streams | Needs |
| --- | --- | --- |
| `market` | The books, price changes and fills of outcome tokens or of whole markets. | Nothing. |
| `activity` | The newest fills of one market. | Nothing. |
| `user` | Your orders and trades, in every market. | `createSecureClient` |
| `portfolio` | Your positions. | `createSecureClient` |

## Stream an order book

A `market` spec takes `markets` (condition ids, for every outcome token of each) or `assetIds`
(outcome tokens). It needs no key. A `book` event is the full depth of one token, so replace what
you hold with each one.

<!-- snippet: docs/snippets/realtime.ts#realtime-book -->
```ts
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
```

Each event names its `topic` and its `type`, and the loop yields the events of every topic you
asked for, in the order they arrive. Switch on `event.type` to narrow it.

| Topic | `type` | What it holds |
| --- | --- | --- |
| `market` | `book` | The full depth of one token. Sent on open, after a reconnect, and after every order, cancel and fill in the market. Best price last, as in `fetchOrderBook`. |
| `market` | `price_change` | The price levels that changed. |
| `market` | `last_trade_price` | A fill: the taker's side, the size and the price. |
| `user` | `order` | One of your orders changed. |
| `user` | `trade` | A fill of yours, then each step of its settlement. |
| `portfolio` | `positions` | All your positions, each time they change. |
| `activity` | `trades` | The newest fills of one market, up to 50, newest first. |

Leaving a `for await` loop with `break` ends that loop only. The subscription stays open, and
keeps the process alive, until you call `handle.close()`. `client.closeSubscriptions()` closes
every handle of the client.

## Stream your orders and fills

The `user` topic needs a client from `createSecureClient`, and streams every market on one
connection.

<!-- snippet: docs/snippets/realtime.ts#realtime-orders -->
```ts
const handle = await client.subscribe([{ topic: 'user' }]);
for await (const event of handle) {
  if (event.type === 'order') {
    console.log(`order ${event.kind} ${event.orderId}: ${event.status}`);
  } else {
    console.log(`trade ${event.id}: ${event.status}`);
  }
}
```

An `order` event's `kind` is `PLACEMENT`, `UPDATE` (a fill), `CANCELLATION` or `REJECTED`. A
`trade` is `MATCHED` first, then `MINED` and `CONFIRMED` as it settles. `FAILED` means the fill
was undone. Open one long-lived handle for the `user` topic per process and share it: each handle
takes one of the account's WebSocket slots.

## Stream your positions

The `portfolio` topic sends the positions that `listPositions()` lists, in the first 100 markets
of the account. Each event holds all of them, so replace what you hold with each one.

<!-- snippet: docs/snippets/realtime.ts#watch -->
```ts
const handle = await client.subscribe([{ topic: 'portfolio' }]);
handle.on('reconnected', () => console.log('portfolio stream reconnected'));
handle.on('error', (error) => console.log(`portfolio error ${error.code}`));
for await (const event of handle) {
  console.log(`${event.positions.length} position(s) at ${event.timestamp}`);
}
```

## Stream a market's fills

The `activity` topic needs no key. It takes XO's id for the market (`market.id`).

<!-- snippet: docs/snippets/realtime.ts#realtime-activity -->
```ts
const handle = await client.subscribe([{ topic: 'activity', marketId }]);
for await (const event of handle) {
  for (const trade of event.trades) {
    console.log(`${trade.side} ${trade.size} @ ${trade.price}`);
  }
}
```

## Read again after a gap

A stream does not replay what it missed while it was down. The loop sees events only, so listen
for the handle's signals too. `'reconnected'` passes `{ topic }`: the connection of that topic came
back, and the events in between are gone. An `'error'` carries `error.topic` the same way, and
`ws_events_dropped` means the service fell behind. On either, read the state of the topic named
again:

| Topic | Read again with |
| --- | --- |
| `market` | `fetchOrderBooks` |
| `user` | `listOpenOrders` |
| `portfolio` | `listPositions` |
| `activity` | Nothing: the next event is whole. |

<!-- snippet: docs/snippets/realtime.ts#realtime-resync -->
```ts
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
```

`subscription_overflow` is about the whole handle, so it names no topic: your loop read too slowly
and old events were dropped, so read every topic again, and do less work per event. A topic whose
stream stops for good says so on `'error'`, and the other topics go on. Every error code is in
[Errors](errors.md).

## Limits

A connection holds 100 ids, which is 50 markets with both tokens. The SDK splits longer lists over
more connections. The `user` topic takes one of the account's WebSocket slots for each handle, so
share one handle across your users. See [Orderbook API rate limits](/api-reference/rate-limits).
