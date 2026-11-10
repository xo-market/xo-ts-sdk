# Type Alias: ListEventsRequest

```ts
type ListEventsRequest = object;
```

What [PublicClient.listEvents](../interfaces/PublicClient.md#listevents) takes. Every key is optional.

## Properties

### categoryId?

```ts
categoryId?: string;
```

Only the events in this category. A category's id (`Category.id`), digits.

***

### pageSize?

```ts
pageSize?: number;
```

How many events a page holds, from 1 to 1000.

***

### search?

```ts
search?: string;
```

Only events that match this text.

***

### seriesId?

```ts
seriesId?: string;
```

Only the events of this series. A series' id, a UUID.

***

### withMarkets?

```ts
withMarkets?: boolean;
```

Load each event's markets into `Event.markets`, which a list leaves `null`. It needs
`seriesId`.
