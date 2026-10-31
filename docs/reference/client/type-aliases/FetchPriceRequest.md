# Type Alias: FetchPriceRequest

```ts
type FetchPriceRequest = object;
```

What [PublicClient.fetchPrice](../interfaces/PublicClient.md#fetchprice) takes.

## Properties

### assetId

```ts
assetId: string;
```

The token to read: a decimal string of digits.

***

### side

```ts
side: SideInput;
```

The side of the book to read: `BUY` is the best bid, `SELL` the best ask.
