# Type Alias: ListBridgePaymentsRequest

```ts
type ListBridgePaymentsRequest = object;
```

What [SecureClient.listBridgePayments](../interfaces/SecureClient.md#listbridgepayments) takes. Every key is optional.

## Properties

### direction?

```ts
direction?: BridgeDirection;
```

Only deposits or only withdrawals. Both when left out.

***

### status?

```ts
status?: BridgePaymentStatus;
```

Only the payments in this status, such as `COMPLETE`. A quote nobody confirmed is never listed.
