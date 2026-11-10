# Type Alias: ListMarketRewardsMakersRequest

```ts
type ListMarketRewardsMakersRequest = object;
```

What [PublicClient.listMarketRewardsMakers](../interfaces/PublicClient.md#listmarketrewardsmakers) takes.

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

The UTC day: whole days since 1970-01-01, from 0 to 10,000,000. Defaults to today when the
list is made. To resume a walk on another day, pass the `epoch` it started with.

***

### pageSize?

```ts
pageSize?: number;
```

How many makers a page holds, from 1 to 1000.
