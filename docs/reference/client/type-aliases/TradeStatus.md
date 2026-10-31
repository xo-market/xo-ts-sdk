# Type Alias: TradeStatus

```ts
type TradeStatus = 
  | "MATCHED"
  | "MINED"
  | "CONFIRMED"
  | "RETRYING"
  | "FAILED"
  | string & object;
```

Where a trade is in its settlement, in XO's words. A status added later reads as its own
string.

- `MATCHED`: matched, not settled on chain yet.
- `MINED`: the settlement transaction is sent and waits for its confirmation.
- `CONFIRMED`: settled on chain. Final.
- `RETRYING`: settlement failed for now and is tried again.
- `FAILED`: settlement failed for good and the fill was undone. Final.
