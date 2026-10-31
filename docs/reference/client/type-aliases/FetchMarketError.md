# Type Alias: FetchMarketError

```ts
type FetchMarketError = 
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
```

The error union of [PublicClient.fetchMarket](../interfaces/PublicClient.md#fetchmarket).
