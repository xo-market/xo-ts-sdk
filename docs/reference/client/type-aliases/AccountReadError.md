# Type Alias: AccountReadError

```ts
type AccountReadError = 
  | UserInputError
  | AuthRequiredError
  | SigningError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError
  | XoError;
```

The error union of the reads of an account: the request and options, a read that was
cancelled, timed out or refused, an answer that cannot be read, and, on a signed-in client,
the sign-in it makes when its API key is refused (`SigningError`) and `client_closed` once it
is closed.
