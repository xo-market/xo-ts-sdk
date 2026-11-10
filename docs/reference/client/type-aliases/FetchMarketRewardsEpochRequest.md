# Type Alias: FetchMarketRewardsEpochRequest

```ts
type FetchMarketRewardsEpochRequest = object;
```

What [PublicClient.fetchMarketRewardsEpoch](../interfaces/PublicClient.md#fetchmarketrewardsepoch) takes.

## Properties

### conditionId

```ts
conditionId: string;
```

The market's id on the order book, `0x` and 64 hex digits.

***

### epoch?

```ts
epoch?: number;
```

The UTC day: whole days since 1970-01-01, from 0 to 10,000,000. Defaults to today, the day
in progress, whose figures are a live projection.
