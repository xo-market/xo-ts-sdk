# Type Alias: CancelMarketOrdersRequest

```ts
type CancelMarketOrdersRequest = 
  | {
  assetId?: string;
  market: string;
}
  | {
  assetId: string;
  market?: string;
};
```

What [SecureClient.cancelMarketOrders](../interfaces/SecureClient.md#cancelmarketorders) takes: the `market` (a condition id) to cancel every order
of, or the `assetId` of one outcome to cancel only its orders; both narrow to the orders of
that outcome in that market.

## Union Members

### Type Literal

```ts
{
  assetId?: string;
  market: string;
}
```

#### assetId?

```ts
optional assetId?: string;
```

Only the orders of this outcome token.

#### market

```ts
market: string;
```

The market's condition id, `0x` and 64 hex digits.

***

### Type Literal

```ts
{
  assetId: string;
  market?: string;
}
```

#### assetId

```ts
assetId: string;
```

Only the orders of this outcome token.

#### market?

```ts
optional market?: string;
```

The market's condition id, `0x` and 64 hex digits.
