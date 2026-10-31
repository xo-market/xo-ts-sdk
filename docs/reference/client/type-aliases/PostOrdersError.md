# Type Alias: PostOrdersError

```ts
type PostOrdersError = 
  | UserInputError
  | BatchPlaceIncompleteError
  | XoError;
```

The error union of [SecureClient.postOrders](../interfaces/SecureClient.md#postorders): the list of orders (`UserInputError`), a client that
is closing (`session_closed`), and every failure of a request or of an answer, as a
[BatchPlaceIncompleteError](../classes/BatchPlaceIncompleteError.md) that says which orders may have been placed.
