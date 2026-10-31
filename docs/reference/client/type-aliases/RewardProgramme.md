# Type Alias: RewardProgramme

```ts
type RewardProgramme = object;
```

The reward programme of one currency on a market or a group.

## Properties

### active

```ts
active: boolean | null;
```

Whether the programme pays today. `null` when XO does not say.

***

### budgetRemaining

```ts
budgetRemaining: DecimalString | null;
```

What is left of the budget, in `currency`.

***

### budgetTotal

```ts
budgetTotal: DecimalString | null;
```

The whole programme's budget, in `currency`.

***

### currency

```ts
currency: RewardCurrency;
```

What the programme pays in.

***

### dailyPool

```ts
dailyPool: DecimalString | null;
```

What is paid out per day, in `currency`.

***

### daysRemaining

```ts
daysRemaining: number | null;
```

How many days the programme still runs.

***

### endsAt

```ts
endsAt: string | null;
```

When the programme ends, as an ISO 8601 time. `null` while it has no end yet.

***

### estimatedApr

```ts
estimatedApr: DecimalString | null;
```

The estimated annual return in percent, from the daily pool against the liquidity it attracts. `null` for `CP`, and when XO cannot estimate it.

***

### inactiveReason

```ts
inactiveReason: RewardInactiveReason | null;
```

Why it does not pay today. `null` while it does, or when XO gives no reason.

***

### startsAt

```ts
startsAt: string | null;
```

When the programme starts, as an ISO 8601 time.

***

### status

```ts
status: RewardProgrammeStatus | null;
```

Where the programme is in its life.

***

### terms

```ts
terms: RewardTerms;
```

How resting orders are scored.
