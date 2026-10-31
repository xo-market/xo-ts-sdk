# Type Alias: FetchSpreadsError

```ts
type FetchSpreadsError = 
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
```

The error union of [PublicClient.fetchSpreads](../interfaces/PublicClient.md#fetchspreads).
