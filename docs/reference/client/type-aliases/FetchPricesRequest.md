# Type Alias: FetchPricesRequest

```ts
type FetchPricesRequest = object;
```

What [PublicClient.fetchPrices](../interfaces/PublicClient.md#fetchprices) takes.

## Properties

### requests

```ts
requests: FetchPriceRequest[];
```

The tokens and sides to read: at least one. A token may appear with both sides.
