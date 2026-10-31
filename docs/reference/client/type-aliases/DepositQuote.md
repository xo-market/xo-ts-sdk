# Type Alias: DepositQuote

```ts
type DepositQuote = object;
```

A quote to deposit money into XO. Confirming it (creating the deposit) turns it into a
payment; it can be confirmed until `acceptBy`.

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

What the deposit costs.

***

### input

```ts
input: BridgeAmount;
```

What you pay in.

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

What XO credits: USDC in the trading wallet.

***

### paymentId

```ts
paymentId: string;
```

The id of the payment this quote becomes when it is confirmed.
