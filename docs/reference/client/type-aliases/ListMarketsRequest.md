# Type Alias: ListMarketsRequest

```ts
type ListMarketsRequest = object;
```

What [PublicClient.listMarkets](../interfaces/PublicClient.md#listmarkets) takes. Every key is optional. A market must have two outcomes and
trade on the order book to be listed, whatever the filters say.

## Properties

### category?

```ts
category?: string;
```

Only markets in this category, by its name, such as `Sports`, in any case. Not with `eventId` or `seriesId`.

***

### endAfter?

```ts
endAfter?: Date;
```

Only markets that end after this time. Not with `eventId` or `seriesId`.

***

### eventId?

```ts
eventId?: string;
```

Only the markets of this event, its sub-events included. An event's id, a UUID.

***

### order?

```ts
order?: "asc" | "desc";
```

The direction of `sort`. Defaults to `desc`.

***

### pageSize?

```ts
pageSize?: number;
```

How many markets a page holds, from 1 to 50.

***

### seriesId?

```ts
seriesId?: string;
```

Only the markets of this series. A series' id, a UUID.

***

### sort?

```ts
sort?: "volume" | "created" | "endDate" | "liquidity";
```

What to order by: `volume` (high-volume markets first, in XO's own ranking, which does not
always match the order of `Market.metrics.volume`), `created` (when the market was made),
`endDate` (when trading ends) or `liquidity`. `liquidity` is not available with `eventId`
or `seriesId`.

***

### status?

```ts
status?: "active" | "closed" | "resolved";
```

Only markets in this stage of their life: `active` (open for trading and not past their
end time), `closed` (past their end time, with the outcome not decided yet) or `resolved`
(the outcome is decided). Defaults to `active`: a list without a `status` holds open
markets only. A `closed` market's own status still reads `ACTIVE` until its outcome is
set, so its `state.closed` is `false`.
