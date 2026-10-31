# Type Alias: CreateLimitOrderError

```ts
type CreateLimitOrderError = 
  | UserInputError
  | SigningError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | UnexpectedResponseError
  | XoError;
```

The error union of [SecureClient.createLimitOrder](../interfaces/SecureClient.md#createlimitorder) and [SecureClient.createMarketOrder](../interfaces/SecureClient.md#createmarketorder): the request
(`UserInputError`), the wallet's signature (`SigningError`), the reads that building an order
makes (the market's tick size and the account's exchange nonce, and the sign-in the client
makes when its credentials are refused), and a plain [XoError](../classes/XoError.md) for the codes of the
client's session (`session_closed`), of the nonce (`nonce_unavailable`) and of a smart wallet
that cannot sign in.
