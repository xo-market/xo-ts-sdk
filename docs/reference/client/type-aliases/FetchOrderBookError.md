# Type Alias: FetchOrderBookError

```ts
type FetchOrderBookError = 
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
```

The error union of [PublicClient.fetchOrderBook](../interfaces/PublicClient.md#fetchorderbook).
