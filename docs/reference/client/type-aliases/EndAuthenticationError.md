# Type Alias: EndAuthenticationError

```ts
type EndAuthenticationError = 
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | UnexpectedResponseError
  | XoError;
```

The error union of [SecureClient.endAuthentication](../interfaces/SecureClient.md#endauthentication).
