# Type Alias: FetchMarketTradabilityError

```ts
type FetchMarketTradabilityError = 
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError
  | XoError;
```

The error union of [PublicClient.fetchMarketTradability](../interfaces/PublicClient.md#fetchmarkettradability). A failed read of the chain is a plain
[XoError](../classes/XoError.md) with the code `chain_read_failed`.
