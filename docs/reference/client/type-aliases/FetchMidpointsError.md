# Type Alias: FetchMidpointsError

```ts
type FetchMidpointsError = 
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
```

The error union of [PublicClient.fetchMidpoints](../interfaces/PublicClient.md#fetchmidpoints).
