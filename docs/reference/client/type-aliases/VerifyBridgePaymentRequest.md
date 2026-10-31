# Type Alias: VerifyBridgePaymentRequest

```ts
type VerifyBridgePaymentRequest = object;
```

What [SecureClient.verifyBridgePayment](../interfaces/SecureClient.md#verifybridgepayment) takes.

## Properties

### paymentId

```ts
paymentId: string;
```

The payment's id: the `paymentId` of its quote, or of an error.

***

### verify

```ts
verify: VerifyCallback;
```

Approves each thing the owner wallet is asked to sign: answer `true` to approve.
