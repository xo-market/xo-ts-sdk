# Type Alias: TradableReason

```ts
type TradableReason = 
  | "orderbook_inactive"
  | "expired"
  | "expiry_unknown"
  | "chain_unchecked"
  | "not_prepared"
  | "already_resolved"
  | "not_registered_on_exchange";
```

Why a market is not (or not verifiably) tradable. A stable code per failed or skipped check:

- `orderbook_inactive`: the orderbook market is not active.
- `expired`: the market's expiry time has passed (the upstream status stays active).
- `expiry_unknown`: the backend gave no usable expiry time (none, or one without a `Z` or an
  offset), so expiry could not be checked.
- `chain_unchecked`: no chain reader was passed, so the three on-chain checks did not run.
- `not_prepared`: the condition is not prepared on ConditionalTokens with two outcomes.
- `already_resolved`: the condition has a payout denominator, so it is resolved.
- `not_registered_on_exchange`: the exchange does not know the YES token as this condition's
  (orders on it match and then fail to settle).
