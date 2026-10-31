# Type Alias: OnchainSendError

```ts
type OnchainSendError = 
  | UserInputError
  | AuthRequiredError
  | SigningError
  | TransactionFailedError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | UnexpectedResponseError
  | XoError;
```

The error union of the on-chain sends: the request (`UserInputError`, such as
`insufficient_balance` or `not_resolved`), the client's closing (`client_closed`), the
signer (`SigningError`), the reads before the send (a `chain_read_failed` `XoError`, and the
order book's reads), a refusal of the sponsor (`RequestRejectedError`, `RateLimitError`), and
a [TransactionFailedError](../classes/TransactionFailedError.md) for the send itself, whose `mayHaveLanded` says whether the
transaction may be on chain.
