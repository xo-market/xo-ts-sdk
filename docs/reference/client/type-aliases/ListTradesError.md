# Type Alias: ListTradesError

```ts
type ListTradesError = 
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError
  | PaginationLimitError;
```

The error union of [PublicClient.listTrades](../interfaces/PublicClient.md#listtrades).
