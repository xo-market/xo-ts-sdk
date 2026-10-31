# Type Alias: FetchEventError

```ts
type FetchEventError = 
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
```

The error union of [PublicClient.fetchEvent](../interfaces/PublicClient.md#fetchevent).
