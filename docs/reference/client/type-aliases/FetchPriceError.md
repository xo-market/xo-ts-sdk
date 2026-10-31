# Type Alias: FetchPriceError

```ts
type FetchPriceError = 
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
```

The error union of [PublicClient.fetchPrice](../interfaces/PublicClient.md#fetchprice).
