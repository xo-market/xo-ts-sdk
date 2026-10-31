# Type Alias: MarketRewardsProgramme

```ts
type MarketRewardsProgramme = object;
```

The liquidity rewards one programme pays on a market, in one currency.

## Properties

### active

```ts
active: boolean;
```

Whether the programme pays today.

***

### currency

```ts
currency: "CP" | "USDC" | string & object;
```

What it pays in: `CP` (conviction points) or `USDC`.

***

### endDate

```ts
endDate: string | null;
```

When the programme ends, as an ISO 8601 time. `null` while it has no end yet.

***

### rewardsAmount

```ts
rewardsAmount: DecimalString | null;
```

The whole programme's budget in `currency`.

***

### rewardsDailyRate

```ts
rewardsDailyRate: DecimalString | null;
```

What is paid out per day in `currency`.

***

### startDate

```ts
startDate: string | null;
```

When the programme starts, as an ISO 8601 time.
