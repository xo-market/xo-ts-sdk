# Type Alias: ListMarketRewardsOrdersRequest

```ts
type ListMarketRewardsOrdersRequest = object;
```

What [PublicClient.listMarketRewardsOrders](../interfaces/PublicClient.md#listmarketrewardsorders) takes.

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

### maker?

```ts
maker?: string;
```

Only the orders of this wallet.

***

### pageSize?

```ts
pageSize?: number;
```

How many orders a page holds, from 1 to 1000.
