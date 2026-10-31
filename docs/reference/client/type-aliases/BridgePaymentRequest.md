# Type Alias: BridgePaymentRequest

```ts
type BridgePaymentRequest = object;
```

What [SecureClient.fetchBridgePayment](../interfaces/SecureClient.md#fetchbridgepayment) and [SecureClient.waitForBridgePayment](../interfaces/SecureClient.md#waitforbridgepayment) take.

## Properties

### paymentId

```ts
paymentId: string;
```

The payment's id: the `paymentId` of its quote, or of an error.
