# Type Alias: ListMarketsError

```ts
type ListMarketsError = 
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError
  | PaginationLimitError;
```

The error union of [PublicClient.listMarkets](../interfaces/PublicClient.md#listmarkets).
