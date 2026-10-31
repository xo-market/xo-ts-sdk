# Type Alias: RotateCredentialsError

```ts
type RotateCredentialsError = 
  | UserInputError
  | SigningError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | UnexpectedResponseError
  | XoError;
```

The error union of [SecureClient.rotateCredentials](../interfaces/SecureClient.md#rotatecredentials).
