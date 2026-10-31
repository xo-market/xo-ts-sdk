# Type Alias: ListBrowseItemsRequest

```ts
type ListBrowseItemsRequest = object;
```

What [PublicClient.listBrowseItems](../interfaces/PublicClient.md#listbrowseitems) takes. Every key is optional.

## Properties

### category?

```ts
optional category?: string;
```

Only markets in this category, by its name, such as `Sports`, in any case.

***

### endAfter?

```ts
optional endAfter?: Date;
```

Only markets that end after this time.

***

### order?

```ts
optional order?: "asc" | "desc";
```

The direction of `sort`. For `trending` it flips the volume ranking only. Defaults to
`desc`.

***

### pageSize?

```ts
optional pageSize?: number;
```

How many cards a page holds, from 1 to 50.

***

### sort?

```ts
optional sort?: "trending" | "volume" | "created" | "endDate" | "liquidity";
```

What to order by. `trending` is the order of XO's market page: boosted markets first, then
markets that close within a day, then the rest by XO's own volume ranking, which does not
always match the order of `metrics.volume`. The others are as for
[ListMarketsRequest](ListMarketsRequest.md). Defaults to `trending`.

***

### status?

```ts
optional status?: "active" | "closed" | "resolved";
```

Only markets in this stage of their life, as for [ListMarketsRequest](ListMarketsRequest.md). Defaults to
`active`: a feed without a `status` shows open markets only. The market page takes the same
status filter as a market list.
