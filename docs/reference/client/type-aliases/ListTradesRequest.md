# Type Alias: ListTradesRequest

```ts
type ListTradesRequest = object;
```

What [PublicClient.listTrades](../interfaces/PublicClient.md#listtrades) takes. Only `marketId` is required.

## Properties

### marketId

```ts
marketId: string;
```

The market whose fills to list: XO's id for it (`Market.id`), digits.

***

### pageSize?

```ts
optional pageSize?: number;
```

How many fills a page holds, from 1 to 50. XO's own page size when left out.

***

### side?

```ts
optional side?: SideInput;
```

Only buys or only sells.
