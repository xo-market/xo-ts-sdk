# Orders

## Place an order

You need a signed-in client. See [Wallets and sign-in](authentication.md).

<!-- snippet: docs/snippets/orders.ts#place -->
```ts
const placed = await client.placeLimitOrder({
  assetId,
  side: OrderSide.BUY,
  price: tickSize,
  size: '1',
  postOnly: true,
});
console.log(
  placed.ok
    ? `BUY 1 YES @ ${tickSize} is ${placed.status}: ${placed.orderId}`
    : `Refused (${placed.code}): ${placed.message}`,
);
```

`assetId` is the token of the outcome you trade, such as `market.outcomes.yes.tokenId`. A price
is USDC per share, from `0.001` to `0.999`, in steps of the market's tick size. A size is a
number of shares, at least 1. Pass both as strings, such as `'0.45'` and `'10'`.

With `postOnly: true` the order only rests on the book. If it would trade straight away, XO
refuses it.

## Read the result

If `ok` is `false`, XO refused the order and nothing was placed. `code` says why, such as
`insufficient_balance`. See [Rejected orders](errors.md#rejected-orders).

If `ok` is `true`, `status` says where the order is:

| `status` | Meaning |
| --- | --- |
| `live` | It rests on the book. |
| `matched` | It filled completely. |
| `delayed` | It waits out the [taker delay](/guides/taker-delay), and can still fill. |

## Place an order that expires

<!-- snippet: docs/snippets/orders.ts#gtd-order -->
```ts
const placed = await client.placeLimitOrder({
  assetId,
  side: OrderSide.BUY,
  price: tickSize,
  size: '1',
  expiration: new Date(Date.now() + 5 * 60_000),
});
```

The order ends at `expiration` if it has not filled. Pass a `Date` or unix seconds, not
milliseconds. Without one, an order rests until it fills or you cancel it.

## Place a market order

<!-- snippet: docs/snippets/orders.ts#market-order -->
```ts
const result = await client.placeMarketOrder({
  assetId,
  side: OrderSide.BUY,
  amount: '1',
});
console.log(result.ok ? result.status : result.code);
```

A buy spends an `amount` of USDC, and a sell gives a number of `shares`, at the best prices on the
book. What does not fill straight away is dropped. To fill all of it or nothing, pass
`orderType: OrderType.FOK`.

A market order often comes back `delayed`, which is not a refusal. Read what filled with
`listAccountTrades`.

## Place many orders

<!-- snippet: docs/snippets/orders.ts#post-orders -->
```ts
const orders = [
  await client.createLimitOrder({
    assetId,
    side: OrderSide.BUY,
    price: '0.40',
    size: '5',
    postOnly: true,
  }),
  await client.createLimitOrder({
    assetId,
    side: OrderSide.BUY,
    price: '0.39',
    size: '5',
    postOnly: true,
  }),
];
const results = await client.postOrders(orders);

for (const result of results) {
  console.log(result.ok ? result.status : result.code);
}
```

`createLimitOrder` signs an order without sending it. `postOrders` sends signed orders, up to 300
to a request, and gives each one its result in the same order. XO does not say what each order of
a batch filled, so read your trades for that.

## Replace orders

<!-- snippet: docs/snippets/orders.ts#order-batch -->
```ts
const results = await client.postOrderBatch({
  operations: [
    { type: 'cancel', orderIds },
    { type: 'place', orders: [order] },
  ],
});
```

`postOrderBatch` cancels and places in one request. The operations run in order, and one that
fails does not undo the others.

## Cancel orders

<!-- snippet: docs/snippets/orders.ts#cancel -->
```ts
if (placed.ok) {
  const { canceled } = await client.cancelOrder({ orderId: placed.orderId });
  console.log(`Canceled ${canceled.length} order(s)`);
}
```

| Method | Cancels |
| --- | --- |
| `cancelOrder({ orderId })` | One order. |
| `cancelOrders({ orderIds })` | Several orders. |
| `cancelMarketOrders({ market })` | Your open orders in one market. |
| `cancelAll()` | Every open order of the account, from any process. |

The orders that were cancelled are in `canceled`. The rest are in `notCanceled` with XO's reason,
for example an order that had already filled.

A cancel is sent once and never retried. If it throws with `mayHaveLanded: true`, it may have
worked, so check your orders with `listOpenOrders` before you cancel again.

> [!WARNING]
> Once your account sends a heartbeat, XO cancels all its open orders when the beats stop for 30
> seconds, even after `stop()`. See
> [Cancel orders if your server stops](production.md#cancel-orders-if-your-server-stops).

## List your orders and trades

<!-- snippet: docs/snippets/orders.ts#open-orders -->
```ts
for await (const page of client.listOpenOrders()) {
  for (const order of page.items) {
    console.log(`${order.side} ${order.originalSize} @ ${order.price}`);
  }
}
```

`listOpenOrders` lists your orders on the book. An order in the taker delay is not listed, but
`fetchOrder` finds it by its hash. `listAccountTrades` lists your fills, newest first, and
`fetchMarketCapacity` says how much you can still commit in a market.

## When a placement throws

<!-- snippet: docs/snippets/orders.ts#reconcile-order -->
```ts
const order = await client.createLimitOrder({
  assetId,
  side: OrderSide.BUY,
  price: '0.40',
  size: '5',
});

try {
  const placed = await client.postOrder(order);
  console.log(placed.ok ? placed.status : placed.code);
} catch (error) {
  if (error instanceof XoError && error.mayHaveLanded) {
    const found = await client.reconcileOrder({ orderHash: order.orderHash });
    console.log(`Do not place it again. It is ${found.state}`);
  }
  throw error;
}
```

The SDK sends an order once and never retries it. If XO's answer is lost, the error says
`mayHaveLanded: true`: the order may be on the book, or even filled. Do not place it again until
`reconcileOrder` has told you what happened.

`reconcileOrder` answers `resting`, `traded` or `not_found`. `not_found` is not proof, so check
again a little later. When `postOrders` or `postOrderBatch` throws, the error lists the orders to
check. See [Errors](errors.md).

## Next steps

- [Stream your orders and fills](realtime.md)
- [Handle errors](errors.md)
- [Run in production](production.md)
