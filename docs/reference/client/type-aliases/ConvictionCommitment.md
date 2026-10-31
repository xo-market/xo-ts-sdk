# Type Alias: ConvictionCommitment

```ts
type ConvictionCommitment = object;
```

The order a market's creator committed to when making it. The order book keeps no detail
once the order has left the book, so those fields are `null` then.

## Properties

### orderId

```ts
orderId: string;
```

The commitment's order id.

***

### outcome

```ts
outcome: "yes" | "no" | string & object;
```

The outcome the commitment is on, `yes` or `no`.

***

### price

```ts
price: DecimalString | null;
```

The commitment's price in dollars between 0 and 1.

***

### remaining

```ts
remaining: DecimalString | null;
```

The shares of the commitment still resting.

***

### side

```ts
side: OrderSide | null;
```

Whether the commitment buys or sells.

***

### size

```ts
size: DecimalString | null;
```

The commitment's size in shares.

***

### status

```ts
status: "resting" | "spent_tombstone" | string & object;
```

`resting` while the order is on the book, `spent_tombstone` after it left.
