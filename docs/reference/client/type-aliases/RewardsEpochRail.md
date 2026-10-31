# Type Alias: RewardsEpochRail

```ts
type RewardsEpochRail = object;
```

One currency's side of a market's reward day.

## Properties

### allocated

```ts
allocated: DecimalString;
```

What was allocated to makers, in `currency`.

***

### credited

```ts
credited: DecimalString | null;
```

What has been paid, in `currency`. `null` before settlement.

***

### currency

```ts
currency: RewardCurrency;
```

The currency.

***

### makerCount

```ts
makerCount: number;
```

How many makers scored.

***

### makers

```ts
makers: RewardsMaker[];
```

The makers with the highest scores.

***

### pool

```ts
pool: DecimalString | null;
```

The day's pool, in `currency`. `null` where the market has no programme that day.

***

### projected

```ts
projected: boolean;
```

Whether the figures are a live projection of the open day.

***

### projectedThrough

```ts
projectedThrough: string | null;
```

How fresh the projection is, as an ISO 8601 time. `null` for a day that is not projected.

***

### status

```ts
status: RewardDayStatus | null;
```

Where the day is.

***

### totalScore

```ts
totalScore: string;
```

The liquidity score of all makers, as an exact decimal text.
