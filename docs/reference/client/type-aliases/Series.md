# Type Alias: Series

```ts
type Series = object;
```

A series of events, such as a tournament.

## Properties

### active

```ts
active: boolean;
```

Whether the series is running.

***

### category

```ts
category: string | null;
```

The series' category, such as `Sports`.

***

### createdAt

```ts
createdAt: string;
```

When the series was created, as an ISO 8601 time.

***

### description

```ts
description: string | null;
```

The series' background text.

***

### id

```ts
id: string;
```

XO's id for the series.

***

### slug

```ts
slug: string;
```

The series' URL name.

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

The series' name.

***

### updatedAt

```ts
updatedAt: string;
```

When the series was last changed, as an ISO 8601 time.
