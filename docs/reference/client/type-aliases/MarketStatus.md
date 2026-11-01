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
- `ACTIVE`: open for trading. A market past its end time reads `ACTIVE` until its outcome
  is set.
- `PAUSED`: trading is paused.
- `RESOLVED`: the outcome is decided.
- `CLOSED`: the outcome is decided and the market is final; it was `RESOLVED` first (see
  [MarketState.closed](MarketState.md#closed)).
- `CANCELLED`, `VOIDED`, `VOIDED_CLOSED`: the market was called off.
- `DISPUTED`, `DEFAULTED`, `UPDATE_REQUIRED`: a resolution problem or an edit under review.
