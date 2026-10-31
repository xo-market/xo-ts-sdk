# Type Alias: ListOpenOrdersError

```ts
type ListOpenOrdersError = 
  | UserInputError
  | SigningError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError
  | XoError;
```

The error union of the reads of the account's orders and trades: the request and options, a
read that was cancelled, timed out or refused, and the sign-in the client makes when its
credentials are refused.
