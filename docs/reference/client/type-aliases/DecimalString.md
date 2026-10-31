# Type Alias: DecimalString

```ts
type DecimalString = string;
```

A base-10 decimal in **whole units**: a price between 0 and 1, dollars, shares. For example
`"0.57"` or `"153.641122"`. Never an amount in a token's raw smallest units: one and a half
dollars is `"1.5"`, not `"1500000"`.
