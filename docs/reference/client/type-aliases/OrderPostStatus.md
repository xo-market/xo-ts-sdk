# Type Alias: OrderPostStatus

```ts
type OrderPostStatus = "live" | "matched" | "delayed" | string & object;
```

What became of an order that XO accepted. A status added later reads as its own string.

- `live`: the order rests on the book. Part of it may have filled at once (see
  [AcceptedOrderResponse.tradeIds](AcceptedOrderResponse.md#tradeids)).
- `matched`: the order filled completely at once.
- `delayed`: the order is held for the taker delay and can still fill. What has filled so
  far is in `makingAmount`, `takingAmount` and `tradeIds`. To see the rest, read the
  account's trades with `listAccountTrades`, or look the order up with
  `reconcileOrder({ orderHash })`.
