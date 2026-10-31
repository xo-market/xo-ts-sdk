# Type Alias: RedeemAllPositionsError

```ts
type RedeemAllPositionsError = OnchainSendError;
```

The error union of [SecureClient.redeemAllPositions](../interfaces/SecureClient.md#redeemallpositions): the errors before any market is redeemed (the
markets could not be read, a closed client). A market that fails is a result, not a throw.
