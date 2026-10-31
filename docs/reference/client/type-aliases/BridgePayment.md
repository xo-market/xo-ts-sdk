# Type Alias: BridgePayment

```ts
type BridgePayment = object;
```

A payment through the bridge: a quote, a deposit or a withdrawal.

## Properties

### acceptBy

```ts
acceptBy: string;
```

The quote could be confirmed until then, as an ISO 8601 time.

***

### completedAt

```ts
completedAt: string | null;
```

When the payment completed, as an ISO 8601 time. `null` while it has not.

***

### createdAt

```ts
createdAt: string;
```

When the payment was created (the quote was asked for), as an ISO 8601 time.

***

### deliveryTransactionHash

```ts
deliveryTransactionHash: string | null;
```

The transaction that delivered the output. `null` until it is delivered.

***

### deposit

```ts
deposit: BridgeDeposit | null;
```

Where and how much to send. `null` until the bridge has said.

***

### destinationAddress

```ts
destinationAddress: string;
```

Where the output is delivered: the trading wallet for a deposit, the recipient for a withdrawal.

***

### direction

```ts
direction: BridgeDirection;
```

`deposit` into XO or `withdraw` out of it.

***

### fees

```ts
fees: BridgeFees;
```

What the payment costs.

***

### fundBy

```ts
fundBy: string | null;
```

The money must be sent by then, as an ISO 8601 time. `null` before the quote was confirmed.

***

### fundingClaimedAt

```ts
fundingClaimedAt: string | null;
```

When the funding of a withdrawal was claimed, as an ISO 8601 time. `null` if it was not.

***

### fundingTransactionHash

```ts
fundingTransactionHash: string | null;
```

The transaction that sent the money, once the bridge has seen it. It is a transaction of the paying network.

***

### input

```ts
input: BridgeAmount;
```

What goes in.

***

### output

```ts
output: BridgeAmount;
```

What comes out.

***

### ownerAddress

```ts
ownerAddress: Address | null;
```

The wallet that owns the payment. `null` before the quote was confirmed.

***

### paymentId

```ts
paymentId: string;
```

The payment's id.

***

### providerStatus

```ts
providerStatus: string | null;
```

The last status the bridge provider reported, for support. `null` before it reported one.

***

### recipient

```ts
recipient: string | null;
```

A withdrawal's recipient. `null` for a deposit.

***

### recoveryUrl

```ts
recoveryUrl: string | null;
```

The bridge provider's recovery page. Set only while the status is `HALTED`.

***

### status

```ts
status: BridgePaymentStatus;
```

Where the payment is in its life.

***

### updatedAt

```ts
updatedAt: string;
```

When the payment last changed, as an ISO 8601 time.

***

### verification

```ts
verification: BridgeVerificationItem[] | null;
```

What to sign. Set only while the status is `NEEDS_VERIFICATION`.
