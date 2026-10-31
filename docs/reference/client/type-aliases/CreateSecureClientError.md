# Type Alias: CreateSecureClientError

```ts
type CreateSecureClientError = 
  | UserInputError
  | SigningError
  | TransactionFailedError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | UnexpectedResponseError
  | XoError;
```

The error union of [createSecureClient](../functions/createSecureClient.md).
