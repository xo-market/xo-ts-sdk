# Type Alias: ListBridgePaymentsRequest

```ts
type ListBridgePaymentsRequest = object;
```

What [SecureClient.listBridgePayments](../interfaces/SecureClient.md#listbridgepayments) takes. Every key is optional.

## Properties

### direction?

```ts
optional direction?: BridgeDirection;
```

Only deposits or only withdrawals. Both when left out.

***

### status?

```ts
optional status?: BridgePaymentStatus;
```

Only the payments in this status, such as `COMPLETE`. A quote nobody confirmed is never listed.
