# Manage orders

You need a signed-in client. See [Wallets and authentication](authentication.md).

## List open orders

`listOpenOrders` lists your orders that rest on the book, in every market.

<!-- snippet: docs/snippets/manage-orders.ts#open-orders -->
```ts
for await (const page of client.listOpenOrders()) {
  for (const order of page.items) {
    console.log(`${order.side} ${order.originalSize} @ ${order.price}`);
  }
}
```

An order that waits out the [taker delay](/guides/taker-delay) is not listed, but `fetchOrder`
finds it by its hash.

## Get one order

<!-- snippet: docs/snippets/manage-orders.ts#fetch-order -->
```ts
const order = await client.fetchOrder({ orderId });
console.log(`${order.sizeMatched} of ${order.originalSize} filled`);
```

`fetchOrder` reads an open order. An order that filled or was cancelled is no longer open, so it
throws. To find out what became of it, use [`reconcileOrder`](#reconcile-an-order).

## List your trades

`listAccountTrades` lists your fills, newest first.

<!-- snippet: docs/snippets/manage-orders.ts#trades -->
```ts
const { items } = await client.listAccountTrades().firstPage();

for (const trade of items) {
  console.log(`${trade.side} ${trade.size} @ ${trade.price}`);
}
```

## Cancel orders

<!-- snippet: docs/snippets/manage-orders.ts#cancel -->
```ts
const result = await client.cancelOrders({ orderIds });
console.log(result.canceled); // the ids cancelled
console.log(result.notCanceled); // the others, with XO's reason
```

| Method | Cancels |
| --- | --- |
| `cancelOrder({ orderId })` | One order. |
| `cancelOrders({ orderIds })` | Several orders. |
| `cancelMarketOrders({ market })` | Your open orders in one market. |
| `cancelAll()` | Every open order of the account, from any process. |

A cancel is sent once and never retried. If it throws with `mayHaveLanded: true`, it may have
worked, so read `listOpenOrders` before you cancel again.

## Replace orders

`postOrderBatch` cancels and places in one request. The operations run in order, and one that
fails does not undo the others.

<!-- snippet: docs/snippets/manage-orders.ts#order-batch -->
```ts
const results = await client.postOrderBatch({
  operations: [
    { type: 'cancel', orderIds }, // runs first
    { type: 'place', orders: [replacement] }, // signed by createLimitOrder
  ],
});
```

## Reconcile an order

An order is sent once and never retried. If XO's answer is lost, the call throws with
`mayHaveLanded: true`: the order may be on the book, or even filled. Look it up before you place
it again.

<!-- snippet: docs/snippets/manage-orders.ts#reconcile-order -->
```ts
try {
  await client.postOrder(order);
} catch (error) {
  if (error instanceof XoError && error.mayHaveLanded) {
    const found = await client.reconcileOrder({ orderHash: order.orderHash });
    console.log(found.state);
  }
  throw error;
}
```

| `state` | Meaning |
| --- | --- |
| `resting` | It is on the book, in `found.order`. |
| `traded` | It filled, with its trades in `found.trades`. |
| `not_found` | Not found yet. This is not proof, so look again a little later. |

When `postOrders` or `postOrderBatch` throws, the error lists the orders to check. See
[Errors](errors.md).

## Cancel orders if your server stops

A heartbeat tells XO your server is alive. When the beats stop, XO cancels your orders.

<!-- snippet: docs/snippets/manage-orders.ts#heartbeat -->
```ts
const heartbeat = client.startOrderHeartbeat({
  onMissed: (error) => console.warn(`Heartbeat missed: ${error.code}`),
});
```

> [!WARNING]
> Once one beat counts, XO cancels every open order of the account 30 seconds after the beats
> stop, including orders from other processes and the XO website. `heartbeat.stop()` does not
> turn it off. Don't use it on a wallet you also trade by hand.

## Shut down cleanly

Run this when your server stops, such as on SIGTERM. A closed client can't cancel, so cancel
first.

<!-- snippet: docs/snippets/manage-orders.ts#shut-down -->
```ts
try {
  await client.cancelAll();
} finally {
  await client.close();
}
```

If `cancelAll()` throws, check your open orders. Call `close()`, not `endAuthentication()`, which
deletes the orderbook key every process of the wallet shares.

## Next steps

- [Stream your orders and fills](realtime.md)
- [See your positions](positions.md)
- [Handle errors](errors.md)
