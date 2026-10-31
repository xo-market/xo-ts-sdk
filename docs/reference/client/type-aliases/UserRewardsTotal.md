# Type Alias: UserRewardsTotal

```ts
type UserRewardsTotal = object;
```

A lifetime total and what was paid today.

## Properties

### lifetime

```ts
lifetime: DecimalString;
```

All that was paid or credited.

***

### today

```ts
today: DecimalString;
```

What was paid or credited today. This is only what has settled; the day in progress is `currentDay`.
