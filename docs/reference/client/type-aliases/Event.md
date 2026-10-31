# Type Alias: Event

```ts
type Event = object;
```

An event: a heading that markets are placed under, with its sub-events kept separate (an
event's sub-event is an event of its own, with `parentEventId` set).

## Properties

### category

```ts
category: string | null;
```

The event's category, such as `Sports`.

***

### createdAt

```ts
createdAt: string;
```

When the event was created, as an ISO 8601 time.

***

### creators

```ts
creators: EventCreator[];
```

Who created the event.

***

### description

```ts
description: string | null;
```

The event's background text.

***

### icon

```ts
icon: string | null;
```

The event's icon.

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
markets: Market[] | null;
```

The event's CLOB markets with two outcomes, the markets of its sub-events included.
`null` when the source did not load them. Each market carries its label in
`groupItemTitle`.

***

### metadata

```ts
metadata: Record<string, unknown>;
```

Extra data XO keeps on the event, as it is.

***

### metrics

```ts
metrics: EventMetrics;
```

How much has traded.

***

### parentEventId

```ts
parentEventId: string | null;
```

The id of the event this one belongs to, for a sub-event.

***

### schedule

```ts
schedule: EventSchedule;
```

When the event ends.

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

***

### updatedAt

```ts
updatedAt: string;
```

When the event was last changed, as an ISO 8601 time.
