# Type Alias: ListBrowseItemsError

```ts
type ListBrowseItemsError = 
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError
  | PaginationLimitError;
```

The error union of [PublicClient.listBrowseItems](../interfaces/PublicClient.md#listbrowseitems).
