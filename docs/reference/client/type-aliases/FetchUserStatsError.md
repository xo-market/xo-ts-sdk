# Type Alias: FetchUserStatsError

```ts
type FetchUserStatsError = 
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

The error union of [PublicClient.fetchUserStats](../interfaces/PublicClient.md#fetchuserstats). On a signed-in client that reads its own account,
also the sign-in it makes when its API key is refused (`SigningError`) and `client_closed`
once it is closed.
