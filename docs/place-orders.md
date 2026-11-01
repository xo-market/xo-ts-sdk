# Place orders

You need a signed-in client with trading set up. See [Place your first order](quickstart.md).

## Place a limit order

A limit order buys or sells at a price you set. The price is USDC per share, from `0.001` to
`0.999`, in steps of the market's tick size. The size is a number of shares, at least 1.

<!-- snippet: docs/snippets/place-orders.ts#limit-order -->
```ts
const placed = await client.placeLimitOrder({
  assetId, // the outcome's token id
  side: OrderSide.BUY,
  price: '0.45', // USDC per share
  size: '10', // shares
});
```

Each order has a type, set by how you place it:

| Type | What it does | How to place it |
| --- | --- | --- |
| `GTC` | Rests until it fills or you cancel it. | A limit order. |
| `GTD` | Rests until it fills, you cancel it, or it expires. | A limit order with `expiration`. |
| `FOK` | Fills completely at once, or not at all. | A market order with `orderType: OrderType.FOK`. |
| `FAK` | Fills what it can at once and drops the rest. | A market order. |

## Place a post-only order

A post-only order only rests on the book. If it would trade at once, XO refuses it with
`post_only_would_cross`.

<!-- snippet: docs/snippets/place-orders.ts#post-only -->
```ts
const placed = await client.placeLimitOrder({
  assetId,
  side: OrderSide.BUY,
  price: '0.45',
  size: '10',
  postOnly: true, // refused if it would trade at once
});
```

## Place an order that expires

Pass `expiration` as a `Date` or in unix seconds, not milliseconds.

<!-- snippet: docs/snippets/place-orders.ts#expiring-order -->
```ts
const placed = await client.placeLimitOrder({
  assetId,
  side: OrderSide.BUY,
  price: '0.45',
  size: '10',
  expiration: new Date(Date.now() + 5 * 60_000), // ends in 5 minutes
});
```

## Place a market order

A market order takes the best prices on the book. A buy spends an `amount` of USDC, and a sell
gives a number of `shares`. Set `maxPrice` on a buy or `minPrice` on a sell, and the order only
fills at that price or better.

<!-- snippet: docs/snippets/place-orders.ts#market-order -->
```ts
const bought = await client.placeMarketOrder({
  assetId,
  side: OrderSide.BUY,
  amount: '5', // spends up to 5 USDC
  maxPrice: '0.6', // never pays more than 0.6 a share
});

const sold = await client.placeMarketOrder({
  assetId,
  side: OrderSide.SELL,
  shares: '5',
  minPrice: '0.4', // never takes less than 0.4 a share
  orderType: OrderType.FOK, // all 5 shares, or none
});
```

Without a worst price, a buy takes any price up to 0.999 and a sell any price down to 0.001, so
a thin book can fill it far from the last trade. A buy must be worth at least one share at its
worst price: 0.999 USDC without `maxPrice`.

## Create, then post

`createLimitOrder` and `createMarketOrder` sign an order without sending it. `postOrder` sends it.

<!-- snippet: docs/snippets/place-orders.ts#create-post -->
```ts
const order = await client.createLimitOrder({
  assetId,
  side: OrderSide.BUY,
  price: '0.45',
  size: '10',
});
console.log(order.orderHash); // keep it to look the order up

const placed = await client.postOrder(order);
```

## Place many orders

`postOrders` sends signed orders and gives each one its result, in the order given.

<!-- snippet: docs/snippets/place-orders.ts#post-orders -->
```ts
const orders = [
  await client.createLimitOrder({
    assetId,
    side: OrderSide.BUY,
    price: '0.40',
    size: '5',
  }),
  await client.createLimitOrder({
    assetId,
    side: OrderSide.BUY,
    price: '0.39',
    size: '5',
  }),
];
const results = await client.postOrders(orders); // sent 300 to a request

for (const result of results) {
  console.log(result.ok ? result.status : result.code);
}
```

XO does not say what each order of a batch filled, so read your trades for that.

## Read the result

<!-- snippet: docs/snippets/place-orders.ts#read-result -->
```ts
if (placed.ok) {
  console.log(`${placed.orderId} is ${placed.status}`);
} else {
  console.log(`Refused (${placed.code}): ${placed.message}`);
}
```

If `ok` is `false`, XO refused the order and nothing was placed. `code` says why: see
[Rejected orders](errors.md#rejected-orders). If `ok` is `true`, `status` says where the order is:

| `status` | Meaning |
| --- | --- |
| `live` | It rests on the book. Part of it may have filled. |
| `matched` | It filled completely. |
| `delayed` | It waits out the [taker delay](/guides/taker-delay) and can still fill. |

An order is sent once and never retried. If the call throws with `mayHaveLanded: true`, the order
may be on the book. Look it up with [`reconcileOrder`](manage-orders.md#reconcile-an-order) before
you place it again.

## Next steps

- [Manage orders](manage-orders.md)
- [Stream your orders and fills](realtime.md)
- [Handle errors](errors.md)
