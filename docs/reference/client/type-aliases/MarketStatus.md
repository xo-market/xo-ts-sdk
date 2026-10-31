# Type Alias: MarketStatus

```ts
type MarketStatus = 
  | "PENDING"
  | "ACTIVE"
  | "PAUSED"
  | "CANCELLED"
  | "RESOLVED"
  | "DISPUTED"
  | "CLOSED"
  | "DEFAULTED"
  | "UPDATE_REQUIRED"
  | "VOIDED"
  | "VOIDED_CLOSED"
  | string & object;
```

Where a market is in its life, in XO's words. A status added later reads as its own string.

- `PENDING`: created, not open yet.
- `ACTIVE`: open for trading.
- `PAUSED`: trading is paused.
- `CLOSED`: trading ended (see [MarketState.closed](MarketState.md#closed)).
- `RESOLVED`: the outcome is decided.
- `CANCELLED`, `VOIDED`, `VOIDED_CLOSED`: the market was called off.
- `DISPUTED`, `DEFAULTED`, `UPDATE_REQUIRED`: a resolution problem or an edit under review.
