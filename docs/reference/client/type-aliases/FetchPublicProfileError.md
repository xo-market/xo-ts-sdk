# Type Alias: FetchPublicProfileError

```ts
type FetchPublicProfileError = 
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
```

The error union of [PublicClient.fetchPublicProfile](../interfaces/PublicClient.md#fetchpublicprofile).
