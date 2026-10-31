# Type Alias: UserRewardsDay

```ts
type UserRewardsDay = object;
```

What a wallet has earned on the open day, with its projection.

## Properties

### allocated

```ts
allocated: DecimalString;
```

What was allocated to the wallet for the open day.

***

### baseAmount

```ts
baseAmount: DecimalString | null;
```

The part of `effective` that comes from the base programme.

***

### bonusAmount

```ts
bonusAmount: DecimalString | null;
```

The part of `effective` that comes from bonus windows.

***

### credited

```ts
credited: DecimalString | null;
```

What was credited, once the day is over. `null` before that.

***

### effective

```ts
effective: DecimalString;
```

What the wallet has earned so far on the open day.

***

### estimate

```ts
estimate: DecimalString | null;
```

The projected payout before settlement. `null` when there is no projection.

***

### paid

```ts
paid: DecimalString;
```

What was already paid for the day.

***

### projected

```ts
projected: boolean;
```

Whether the figures are a live projection.

***

### projectedThrough

```ts
projectedThrough: string | null;
```

How fresh the projection is, as an ISO 8601 time. `null` when there is no projection.

***

### status

```ts
status: RewardPayoutStatus | null;
```

Where the day's payout stands. `null` when XO gives no status.
