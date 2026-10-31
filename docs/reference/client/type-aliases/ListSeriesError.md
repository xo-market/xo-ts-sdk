# Type Alias: ListSeriesError

```ts
type ListSeriesError = 
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
```

The error union of [PublicClient.listSeries](../interfaces/PublicClient.md#listseries).
