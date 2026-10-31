# Type Alias: BridgeReadError

```ts
type BridgeReadError = 
  | UserInputError
  | AuthRequiredError
  | SigningError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError
  | XoError;
```

The error union of the bridge's reads: the request and options, the client's sign-in
(`SigningError`, `client_closed`), a read that was cancelled, timed out or refused (such as a
quote's `asset_not_supported` or `amount_out_of_range`, or a payment's `payment_not_found`),
and an answer that cannot be read. A read moves nothing: its errors have `mayHaveLanded:
false`, but for the end of a wait (`bridge_wait_timeout`), which says `true` because the
payment goes on.
