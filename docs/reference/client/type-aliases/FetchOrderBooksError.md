# Type Alias: FetchOrderBooksError

```ts
type FetchOrderBooksError = 
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
```

The error union of [PublicClient.fetchOrderBooks](../interfaces/PublicClient.md#fetchorderbooks).
