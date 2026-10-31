# Type Alias: ActivityType

```ts
type ActivityType = 
  | "TRADE"
  | "REDEEM"
  | "SPLIT"
  | "MERGE"
  | "TRANSFER_IN"
  | "TRANSFER_OUT"
  | "REFUND"
  | "CREATOR_UNLOCK"
  | string & object;
```

What an activity row is, in XO's words. A kind added later reads as its own string.

- `TRADE`: a buy or a sell (see [Activity.side](Activity.md#side)).
- `REDEEM`: winnings paid out for a resolved market.
- `SPLIT`, `MERGE`: collateral split into a complete set of outcome shares, or a set
  merged back into collateral.
- `TRANSFER_IN`, `TRANSFER_OUT`: shares moved into or out of the account.
- `REFUND`: a refund.
- `CREATOR_UNLOCK`: a creator share unlock.
