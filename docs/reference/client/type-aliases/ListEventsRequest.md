# Type Alias: ListEventsRequest

```ts
type ListEventsRequest = object;
```

What [PublicClient.listEvents](../interfaces/PublicClient.md#listevents) takes. Every key is optional.

## Properties

### categoryId?

```ts
optional categoryId?: string;
```

Only the events in this category. A category's id (`Category.id`), digits.

***

### pageSize?

```ts
optional pageSize?: number;
```

How many events a page holds, from 1 to 1000.

***

### search?

```ts
optional search?: string;
```

Only events that match this text.

***

### seriesId?

```ts
optional seriesId?: string;
```

Only the events of this series. A series' id, a UUID.

***

### withMarkets?

```ts
optional withMarkets?: boolean;
```

Load each event's markets into `Event.markets`, which a list leaves `null`. It needs
`seriesId`.
