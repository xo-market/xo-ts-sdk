# Type Alias: PostOrderError

```ts
type PostOrderError = 
  | UserInputError
  | SigningError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | UnexpectedResponseError
  | PlacementError
  | XoError;
```

The error union of [SecureClient.postOrder](../interfaces/SecureClient.md#postorder). Every error thrown once the order may have been sent
carries the order's `orderHash` and `mayHaveLanded`: when that is `true`, the order may be on
the book, so never send or sign it again; look it up with `reconcileOrder`. A
[PlacementError](../classes/PlacementError.md) wraps a failure that was not the SDK's own.
