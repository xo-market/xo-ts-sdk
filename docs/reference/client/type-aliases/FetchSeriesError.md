# Type Alias: FetchSeriesError

```ts
type FetchSeriesError = 
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
```

The error union of [PublicClient.fetchSeries](../interfaces/PublicClient.md#fetchseries).
