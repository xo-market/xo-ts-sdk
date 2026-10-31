# Type Alias: WithdrawalQuote

```ts
type WithdrawalQuote = object;
```

A quote to withdraw money out of XO. Confirming it (withdrawing) turns it into a payment;
it can be confirmed until `acceptBy`.

## Properties

### acceptBy

```ts
acceptBy: string;
```

The quote can be confirmed until then, as an ISO 8601 time.

***

### fees

```ts
fees: BridgeFees;
```

What the withdrawal costs.

***

### input

```ts
input: BridgeAmount;
```

What leaves XO: USDC from the trading wallet.

***

### latencySeconds

```ts
latencySeconds: number | null;
```

The expected time to deliver, in seconds. `null` when the bridge gives none.

***

### output

```ts
output: BridgeAmount;
```

What the recipient gets.

***

### paymentId

```ts
paymentId: string;
```

The id of the payment this quote becomes when it is confirmed.

***

### recipient

```ts
recipient: string;
```

The address that receives the money, as it was given. A valid address that is wrong cannot be undone.
