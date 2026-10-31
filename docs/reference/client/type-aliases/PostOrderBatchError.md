# Type Alias: PostOrderBatchError

```ts
type PostOrderBatchError = 
  | UserInputError
  | BatchOpsIncompleteError
  | XoError;
```

The error union of [SecureClient.postOrderBatch](../interfaces/SecureClient.md#postorderbatch): the operations (`UserInputError`), a client that
is closing (`session_closed`), and every failure of the request or of its answer, as a
[BatchOpsIncompleteError](../classes/BatchOpsIncompleteError.md) that says which orders may have been placed.
