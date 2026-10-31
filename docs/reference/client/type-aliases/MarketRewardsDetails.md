# Type Alias: MarketRewardsDetails

```ts
type MarketRewardsDetails = object;
```

The rewards of one market: its programmes, the day in progress and what it paid so far.

## Properties

### active

```ts
active: boolean;
```

Whether the market's rewards are active.

***

### bonuses

```ts
bonuses: RewardBonus[];
```

The bonus windows: live, scheduled, then ended.

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

The day in progress.

***

### lifetime

```ts
lifetime: RewardLifetime[];
```

What the market scored and paid over its life, per currency.

***

### programmes

```ts
programmes: RewardProgramme[];
```

The programme in each currency, `CP` first.

***

### totalScoredLiquidity

```ts
totalScoredLiquidity: string;
```

The liquidity scored in all, as an exact decimal text (share-seconds).
