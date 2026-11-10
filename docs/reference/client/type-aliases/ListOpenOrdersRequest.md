# Type Alias: ListOpenOrdersRequest

```ts
type ListOpenOrdersRequest = object;
```

What [SecureClient.listOpenOrders](../interfaces/SecureClient.md#listopenorders) takes. Every key is optional.

## Properties

### assetId?

```ts
assetId?: string;
```

Only the orders of this outcome token.

***

### market?

```ts
market?: string;
```

Only the orders of this market: its condition id, `0x` and 64 hex digits.
