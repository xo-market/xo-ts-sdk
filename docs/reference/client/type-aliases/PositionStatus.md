# Type Alias: PositionStatus

```ts
type PositionStatus = "OPEN" | "REDEEMABLE" | "CLOSED" | string & object;
```

Where a position is, in XO's words. A status added later reads as its own string.

- `OPEN`: the account holds shares of the outcome.
- `REDEEMABLE`: the market has resolved (or been voided) and the winnings of the position
  are not claimed yet. Whether the SDK can redeem them is [Position.redeemable](Position.md#redeemable).
- `CLOSED`: XO reports the position closed, and there is nothing left to redeem.
