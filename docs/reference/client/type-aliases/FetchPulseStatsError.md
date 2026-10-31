# Type Alias: FetchPulseStatsError

```ts
type FetchPulseStatsError = 
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
```

The error union of [PublicClient.fetchPulseStats](../interfaces/PublicClient.md#fetchpulsestats).
