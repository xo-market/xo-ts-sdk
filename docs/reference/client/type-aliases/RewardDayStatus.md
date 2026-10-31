# Type Alias: RewardDayStatus

```ts
type RewardDayStatus = "scored" | "settling" | "settled" | "projected" | string & object;
```

Where a market's reward day is: `scored`, `settling`, `settled` or `projected`. A status added later reads as its own string.
