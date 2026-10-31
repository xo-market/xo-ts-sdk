# Type Alias: RewardInactiveReason

```ts
type RewardInactiveReason = 
  | "reward_disabled"
  | "no_daily_pool"
  | "outside_program_window"
  | "budget_exhausted"
  | "before_term"
  | "window_elapsed"
  | "not_configured"
  | "misconfigured"
  | string & object;
```

Why a programme does not pay today: `reward_disabled`, `no_daily_pool`,
`outside_program_window`, `budget_exhausted`, `before_term`, `window_elapsed`,
`not_configured` or `misconfigured`. A reason added later reads as its own string.
