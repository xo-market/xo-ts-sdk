# Type Alias: FetchPricesError

```ts
type FetchPricesError = 
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
```

The error union of [PublicClient.fetchPrices](../interfaces/PublicClient.md#fetchprices).
