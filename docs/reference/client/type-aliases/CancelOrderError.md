# Type Alias: CancelOrderError

```ts
type CancelOrderError = 
  | UserInputError
  | SigningError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | UnexpectedResponseError
  | XoError;
```

The error union of [SecureClient.cancelOrder](../interfaces/SecureClient.md#cancelorder): the request, the errors of the cancel request (sent
once: they say `mayHaveLanded: true` when the cancel may have gone through, `false` when it did
not), the sign-in the client makes when its credentials are refused, and a plain
[XoError](../classes/XoError.md) for the session's codes.
