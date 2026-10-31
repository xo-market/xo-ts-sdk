# Type Alias: BridgeSendError

```ts
type BridgeSendError = 
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

The error union of the bridge's sends: a deposit, a withdrawal or a verification. Each error
says with `mayHaveLanded` whether something may have happened, and carries the `paymentId`
once the quote is confirmed; a [TransactionFailedError](../classes/TransactionFailedError.md) is the withdrawal's transfer.
