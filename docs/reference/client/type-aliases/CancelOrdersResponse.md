# Type Alias: CancelOrdersResponse

```ts
type CancelOrdersResponse = object;
```

What a cancel did: the orders it cancelled, and why each other one was not.

## Properties

### canceled

```ts
canceled: string[];
```

The ids of the orders that were cancelled.

***

### notCanceled

```ts
notCanceled: Record<string, string>;
```

The orders that were not cancelled, by id, with XO's reason, such as `order not found`.
