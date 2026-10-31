# Type Alias: FetchLastTradePricesError

```ts
type FetchLastTradePricesError = 
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
```

The error union of [PublicClient.fetchLastTradePrices](../interfaces/PublicClient.md#fetchlasttradeprices).
