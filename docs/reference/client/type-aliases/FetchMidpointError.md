# Type Alias: FetchMidpointError

```ts
type FetchMidpointError = 
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
```

The error union of [PublicClient.fetchMidpoint](../interfaces/PublicClient.md#fetchmidpoint).
