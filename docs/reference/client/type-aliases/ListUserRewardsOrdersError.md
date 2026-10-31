# Type Alias: ListUserRewardsOrdersError

```ts
type ListUserRewardsOrdersError = 
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

The error union of [PublicClient.listUserRewardsOrders](../interfaces/PublicClient.md#listuserrewardsorders). On a signed-in client that reads its own
wallet, also the sign-in it makes when its API key is refused (`SigningError`) and
`client_closed` once it is closed.
