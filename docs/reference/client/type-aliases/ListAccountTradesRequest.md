# Type Alias: ListAccountTradesRequest

```ts
type ListAccountTradesRequest = object;
```

What [SecureClient.listAccountTrades](../interfaces/SecureClient.md#listaccounttrades) takes. Every key is optional.

## Properties

### after?

```ts
optional after?: Date | number;
```

Only the trades matched at or after this time: a `Date`, or unix seconds.

***

### assetId?

```ts
optional assetId?: string;
```

Only the trades of this outcome token.

***

### before?

```ts
optional before?: Date | number;
```

Only the trades matched before this time: a `Date`, or unix seconds.

***

### market?

```ts
optional market?: string;
```

Only the trades of this market: its condition id, `0x` and 64 hex digits.
