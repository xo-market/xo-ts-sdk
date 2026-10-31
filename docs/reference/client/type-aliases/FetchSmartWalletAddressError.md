# Type Alias: FetchSmartWalletAddressError

```ts
type FetchSmartWalletAddressError = 
  | UserInputError
  | RequestAbortedError
  | TimeoutError
  | XoError;
```

The error union of [PublicClient.fetchSmartWalletAddress](../interfaces/PublicClient.md#fetchsmartwalletaddress): the request and options
(`UserInputError`), the options' `RequestAbortedError` and `TimeoutError`, and a plain
[XoError](../classes/XoError.md) `smart_wallet_address_unavailable` when the factory cannot be read.
