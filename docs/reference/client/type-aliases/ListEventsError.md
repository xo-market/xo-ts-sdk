# Type Alias: ListEventsError

```ts
type ListEventsError = 
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError
  | PaginationLimitError;
```

The error union of [PublicClient.listEvents](../interfaces/PublicClient.md#listevents).
