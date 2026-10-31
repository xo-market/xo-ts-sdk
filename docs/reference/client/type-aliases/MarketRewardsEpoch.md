# Type Alias: MarketRewardsEpoch

```ts
type MarketRewardsEpoch = object;
```

A market's reward day: one rail per currency.

## Properties

### bonusOnly

```ts
bonusOnly: boolean;
```

Whether only a bonus window paid that day.

***

### conditionId

```ts
conditionId: ConditionId;
```

The market's id on the order book.

***

### day

```ts
day: RewardsDay;
```

The day.

***

### omittedRails

```ts
omittedRails: RewardCurrency[];
```

The currencies the answer leaves out.

***

### rails

```ts
rails: RewardsEpochRail[];
```

One entry per currency in the answer, `CP` first.
