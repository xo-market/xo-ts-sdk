# Type Alias: FetchUserRewardsError

```ts
type FetchUserRewardsError = 
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

The error union of [PublicClient.fetchUserRewards](../interfaces/PublicClient.md#fetchuserrewards). On a signed-in client that reads its own
wallet, also the sign-in it makes when its API key is refused (`SigningError`) and
`client_closed` once it is closed.
