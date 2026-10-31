# Type Alias: WaitForBridgePaymentError

```ts
type WaitForBridgePaymentError = BridgeReadError;
```

The error union of [SecureClient.waitForBridgePayment](../interfaces/SecureClient.md#waitforbridgepayment): those of a read, and a `TimeoutError`
`bridge_wait_timeout` when the payment was not final in time.
