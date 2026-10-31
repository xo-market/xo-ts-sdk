# Orders

Orders need a client from `createSecureClient`. A method's prefix says what it does:

| Prefix | What it does |
| --- | --- |
| `create*` | Signs an order and does not send it. |
| `post*` | Sends orders that are already signed. |
| `place*` | Signs and sends, in one call. |
| `cancel*` | Cancels orders. |

## Prices and sizes

- Pass prices and sizes as decimal strings, such as `'0.45'` and `'10'`. Numbers work too.
- A price is USDC per share, from `0.001` to `0.999`, a multiple of the market's tick size
  (`market.trading.minimumTickSize`). Nothing is rounded: a price off the tick is refused before
  anything is sent.
- A size is a number of shares: at least 1, with at most 6 decimals.
- Amounts you read back, such as `makingAmount`, are decimal strings in whole units: `"1.5"` is
  one and a half USDC or shares.
- Take the token to trade from the market: `market.outcomes.yes.tokenId` or
  `market.outcomes.no.tokenId`, passed as `assetId`.

## Place a limit order

`placeLimitOrder` signs the order and sends it. With `postOnly: true` the order only rests on the
book: one that would cross it is refused instead.

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

The result says what XO answered. When XO took the order, `ok` is `true`, and `status` is:

| `status` | Meaning |
| --- | --- |
| `live` | The order rests on the book. |
| `matched` | The order filled completely at once. |
| `delayed` | The order is held for the taker delay and can still fill. It is not a refusal. |

When XO refused the order, `ok` is `false`, nothing was placed, and `code` says why, such as
`insufficient_balance` or `post_only_would_cross`. A refusal is a value, not an exception: see
[Rejected orders](errors.md#rejected-orders) for the codes. Both results carry the order's
`orderHash`.

## Order types

`OrderType` has four values. A limit order is `GTC` or `GTD`, and a market order is `FAK` or
`FOK`.

| `OrderType` | What it does |
| --- | --- |
| `GTC` | Good till cancelled: rests until it fills or you cancel it. The default for a limit order. |
| `GTD` | Good till date: rests until it fills, you cancel it, or its `expiration` passes. |
| `FAK` | Fill and kill: fills what it can at once and drops the rest. The default for a market order. |
| `FOK` | Fill or kill: fills completely at once, or not at all. |

`postOnly` works with limit orders only. A market with an end time ends every order resting on it,
so `listOpenOrders` lists your `GTC` orders there as `GTD`, with an `expiration` no later than the
market's end.

## Post-only and the taker delay

An order that crosses the book waits a short taker delay before it matches, so its placement
takes longer to return. A cancel during the hold can fail with `order_in_delay_window`. Try it
again a moment later. A post-only order never crosses, so it never waits. XO's
[Taker delay](/guides/taker-delay) page has the timings.

## Place a good-til-date order

Pass an `expiration`, as a `Date` or as unix seconds (milliseconds are refused), and the order
becomes a `GTD` order. It must be at least a second ahead of XO's clock.

<!-- snippet: docs/snippets/orders.ts#gtd-order -->
```ts
const expiration = new Date(Date.now() + 5 * 60_000);
const placed = await client.placeLimitOrder({
  assetId,
  side: OrderSide.BUY,
  price: tickSize,
  size: '1',
  postOnly: true,
  expiration,
});
console.log(
  placed.ok
    ? `${placed.status} until ${expiration.toISOString()}: ${placed.orderId}`
    : `Refused (${placed.code}): ${placed.message}`,
);
```

## Place a market order

A market order trades now at the prices on the book. A buy spends an `amount` of USDC, and a sell
gives a number of `shares`. It is a `FAK` unless you pass `orderType: OrderType.FOK`.

<!-- snippet: docs/snippets/orders.ts#market-order -->
```ts
const result = await client.placeMarketOrder({
  assetId,
  side: OrderSide.BUY,
  amount: '1',
  orderType: OrderType.FAK,
});
console.log(
  result.ok
    ? `${result.status}: spent ${result.makingAmount}, bought ${result.takingAmount}`
    : `No fill (${result.code}): ${result.message}`,
);
```

A market order is a limit order at the worst price, 0.999 to buy and 0.001 to sell, so it takes
the best prices first. A taker order often answers `status: 'delayed'`: it waits out the taker
delay and can still fill. Read what filled with `listAccountTrades`, or look the order up with
`reconcileOrder`.

## Sign now, send later

`createLimitOrder` and `createMarketOrder` sign an order without sending it. Nothing goes to XO,
and the order's `orderHash` is its id. Send it with `postOrder`, which sends it once.

<!-- snippet: docs/snippets/orders.ts#create-limit-order -->
```ts
const order = await client.createLimitOrder({
  assetId,
  side: OrderSide.BUY,
  price: tickSize,
  size: minimumOrderSize,
  postOnly: true,
});
```

`createMarketOrder` takes the same `assetId` and `side` as `placeMarketOrder`, with an `amount` or
the `shares`. A signed order is frozen: changing it breaks its signature, and `postOrder` refuses
one that changed. The same signed order sent twice is refused.

## Place many orders at once

`postOrders` sends up to 300 signed orders per request, one request after the other, and gives
each order its own result, in the order you gave them.

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
  console.log(
    result.ok
      ? `${result.orderId}: ${result.status}`
      : `${result.orderHash}: refused (${result.code})`,
  );
}
```

XO does not report what filled for each order of a batch: an accepted order has `makingAmount`,
`takingAmount`, `tradeIds` and `transactionsHashes` set to `null`, which means not reported, not
none. Read your trades for them.

To cancel and replace orders in one request, use `postOrderBatch`. Its operations run in the order
given, and one that fails does not undo the others.

<!-- snippet: docs/snippets/orders.ts#order-batch -->
```ts
const order = await client.createLimitOrder({
  assetId,
  side: OrderSide.BUY,
  price: '0.41',
  size: '5',
  postOnly: true,
});
const results = await client.postOrderBatch({
  operations: [
    { type: 'cancel', orderIds },
    { type: 'place', orders: [order] },
  ],
});
for (const result of results) {
  console.log(
    result.type === 'cancel'
      ? `canceled ${result.canceled.length}, not canceled ${Object.keys(result.notCanceled).length}`
      : `placed ${result.orders.filter((placed) => placed.ok).length} of ${result.orders.length}`,
  );
}
```

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
| `cancelOrders({ orderIds })` | Several orders, 300 to a request. |
| `cancelMarketOrders({ market })` | Every open order of the account in one market. With an `assetId`, the orders of one outcome. |
| `cancelAll()` | Every open order of the account. |

The result lists the orders it cancelled in `canceled`, and the others in `notCanceled`, with XO's
reason. An order that is not open, because it filled or was cancelled already, is not found: it
comes back in `notCanceled`, not as an error. `cancelMarketOrders` and `cancelAll` also cancel the
orders another process placed for the same account.

A cancel is sent once and never retried. When its answer is lost, it throws with
`mayHaveLanded: true`: it may have cancelled your orders. Read them with `listOpenOrders` before
you cancel again. A second `cancelAll` also cancels an order placed between the two.

## List your orders and trades

<!-- snippet: docs/snippets/orders.ts#open-orders -->
```ts
const rows = [];

for await (const page of client.listOpenOrders()) {
  rows.push(
    ...page.items.map((order) => ({
      orderId: order.orderId,
      market: order.market,
      order: `${order.side} ${order.outcome} @ ${order.price}`,
      shares: order.originalSize,
      filled: order.sizeMatched,
      type: order.orderType,
    })),
  );
}

console.log(`${rows.length} open order(s)`);
console.table(rows);
```

| Method | Returns |
| --- | --- |
| `listOpenOrders({ market, assetId })` | Your resting orders, in every market unless you filter. An order waiting out the taker delay is not listed. |
| `fetchOrder({ orderId })` | One open order, including one waiting out the taker delay, by its hash. |
| `listAccountTrades()` | Your trades, newest first. XO keeps the latest 500. |
| `fetchAccountTrade({ tradeId })` | One trade, to follow its settlement from `MATCHED` to `CONFIRMED`. |
| `fetchMarketCapacity({ conditionId })` | The USDC and shares you can still commit in a market. |

## When a placement fails

The SDK never retries or re-signs a placement. When XO's answer is lost or cannot be read, the
error says `mayHaveLanded: true` and carries the `orderHash` to look up.

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
  console.log(
    placed.ok ? `${placed.status}: ${placed.orderId}` : placed.code,
  );
} catch (error) {
  if (error instanceof XoError && error.mayHaveLanded) {
    const found = await client.reconcileOrder({ orderHash: order.orderHash });
    console.log(`Never resend it. reconcileOrder says ${found.state}`);
  }
  throw error;
}
```

> [!WARNING]
> Mainnet is real money. When `mayHaveLanded` is true, the order may be resting or even filled.
> Never resend it or sign a new one in its place. `reconcileOrder` answers `resting`, `traded`
> or `not_found`, and `not_found` is not proof: check again a little later.

`postOrders` and `postOrderBatch` throw `BatchPlaceIncompleteError` and `BatchOpsIncompleteError`.
Their `results` hold what each answered order did, `failedChunk` (or `orderHashes`) lists the
orders to check, and `notSent` the orders that were never sent. An order whose fate XO did not
state has no result, so match a result to its order by `orderHash`, not by position. See
[Errors](errors.md).
