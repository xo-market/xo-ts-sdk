# Type Alias: FetchTradingStateError

```ts
type FetchTradingStateError = 
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
```

The error union of [PublicClient.fetchTradingState](../interfaces/PublicClient.md#fetchtradingstate).
