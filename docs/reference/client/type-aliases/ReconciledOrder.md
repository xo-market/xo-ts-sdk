# Type Alias: ReconciledOrder

```ts
type ReconciledOrder = 
  | {
  order: OpenOrder;
  state: "resting";
}
  | {
  state: "traded";
  trades: Trade[];
}
  | {
  state: "not_found";
};
```

Where an order that may have been placed is:

- `resting`: it is open, on the book or held for the taker delay, possibly partly filled
  (see [OpenOrder.sizeMatched](OpenOrder.md#sizematched)). It can be cancelled.
- `traded`: it is no longer open, and it traded: these are its trades among the account's
  latest ones.
- `not_found`: neither, as far as the lookups reached. This is not proof that it was not
  placed: the placement may still be on its way, or the order traded before the trades
  read. Look again later, and never send or sign it again on the strength of it.
