# Type Alias: FetchLastTradePriceError

```ts
type FetchLastTradePriceError = 
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
```

The error union of [PublicClient.fetchLastTradePrice](../interfaces/PublicClient.md#fetchlasttradeprice).
