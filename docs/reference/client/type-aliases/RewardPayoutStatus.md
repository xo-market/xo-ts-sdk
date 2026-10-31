# Type Alias: RewardPayoutStatus

```ts
type RewardPayoutStatus = 
  | "projected"
  | "pending"
  | "paid"
  | "dropped_below_min"
  | "dropped_flagged"
  | "failed_transfer"
  | "none"
  | string & object;
```

Where a maker's payout for a day stands: `projected` while the day is open, `paid` once it
is credited, `none` when nothing is due. `pending`, `dropped_below_min`, `dropped_flagged`
and `failed_transfer` say why a payout is waiting or was not made. A status added later
reads as its own string.
