# Type Alias: ListActivityRequest

```ts
type ListActivityRequest = object;
```

What [SecureClient.listActivity](../interfaces/SecureClient.md#listactivity) takes. Every key is optional.

## Properties

### marketId?

```ts
optional marketId?: string;
```

Only the activity of this market: XO's id for it, the `id` of a `Market`.

***

### pageSize?

```ts
optional pageSize?: number;
```

How many rows XO reads for a page, from 1 to 50.

***

### type?

```ts
optional type?: typeof ACTIVITY_TYPES[number];
```

Only rows of this kind, such as `TRADE` (buys and sells) or `REDEEM`.
