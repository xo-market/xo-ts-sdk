# Type Alias: BrowseEvent

```ts
type BrowseEvent = object;
```

An event card of the browse feed: the event and its CLOB markets.

## Properties

### endDate

```ts
endDate: string | null;
```

The soonest end time among the event's markets, as an ISO 8601 time. `null` when XO gave none.

***

### id

```ts
id: string;
```

XO's id for the event.

***

### image

```ts
image: string | null;
```

The event's banner picture.

***

### markets

```ts
markets: Market[];
```

The event's CLOB markets with two outcomes, each with its label in `groupItemTitle`.

***

### metadata

```ts
metadata: Record<string, unknown>;
```

Extra data XO keeps on the event, as it is.

***

### metrics

```ts
metrics: object;
```

How much has traded on the event.

#### volume

```ts
volume: DecimalString | null;
```

The volume of the event's markets, in dollars. `null` when XO gave none.

***

### parentEventId

```ts
parentEventId: string | null;
```

The id of the event this one belongs to, for a sub-event.

***

### seriesId

```ts
seriesId: string | null;
```

The id of the series the event belongs to.

***

### slug

```ts
slug: string;
```

The event's URL name.

***

### subtitle

```ts
subtitle: string | null;
```

A line under the title.

***

### title

```ts
title: string;
```

The event's name.
