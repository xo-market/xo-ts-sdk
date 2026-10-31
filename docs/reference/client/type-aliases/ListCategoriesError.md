# Type Alias: ListCategoriesError

```ts
type ListCategoriesError = 
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
```

The error union of [PublicClient.listCategories](../interfaces/PublicClient.md#listcategories).
