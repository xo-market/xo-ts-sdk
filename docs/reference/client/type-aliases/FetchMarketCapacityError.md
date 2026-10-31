# Type Alias: FetchMarketCapacityError

```ts
type FetchMarketCapacityError = 
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError
  | SigningError
  | XoError;
```

The error union of [SecureClient.fetchMarketCapacity](../interfaces/SecureClient.md#fetchmarketcapacity). It reads an account, so it is the union of a
read that signs in: the order book logs in with the wallet's signature, and again when it
refuses the credentials (a 401), which can fail to sign ([SigningError](../classes/SigningError.md)). A plain
[XoError](../classes/XoError.md) carries the other codes of that login: `session_closed` for a client that
has been closed, and `smart_wallet_not_deployed`, `smart_wallet_deployment_unknown` and
`smart_wallet_address_unavailable` for a smart wallet whose deployment or address could not
be read.
