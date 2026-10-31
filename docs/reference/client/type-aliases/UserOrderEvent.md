# Type Alias: UserOrderEvent

```ts
type UserOrderEvent = object;
```

`order`: one of the account's orders changed. A field that the `kind` does not carry is
`null`.

## Properties

### assetId

```ts
assetId: TokenId | null;
```

The outcome token the order is for. `null` for `REJECTED`.

***

### expiration

```ts
expiration: string | null;
```

When the order expires, as an ISO 8601 time. `null` when it does not, or for another kind.

***

### kind

```ts
kind: UserOrderEventKind;
```

What happened to the order.

***

### makerAddress

```ts
makerAddress: Address;
```

The address that signed the order.

***

### market

```ts
market: ConditionId;
```

The id of the market.

***

### orderId

```ts
orderId: string | null;
```

The order's id. `null` for `REJECTED`.

***

### orderType

```ts
orderType: OrderType | null;
```

How long the order lives. Given for `PLACEMENT`.

***

### originalSize

```ts
originalSize: DecimalString | null;
```

The shares the order was placed for. Given for `PLACEMENT` and `UPDATE`.

***

### outcome

```ts
outcome: "YES" | "NO" | string & object | null;
```

The outcome the order is for, `YES` or `NO`. `null` for `REJECTED`.

***

### owner

```ts
owner: Address;
```

The address that trades: the smart wallet, when one trades.

***

### price

```ts
price: DecimalString | null;
```

The limit price, in dollars between 0 and 1. `null` for `REJECTED`.

***

### reason

```ts
reason: string | null;
```

Why the order was refused. Given for `REJECTED`.

***

### side

```ts
side: OrderSide | null;
```

Whether the order buys or sells. `null` for `REJECTED`.

***

### sizeMatched

```ts
sizeMatched: DecimalString | null;
```

The shares that have filled so far. Given for `PLACEMENT` and `UPDATE`.

***

### status

```ts
status: "LIVE" | "MATCHED" | "CANCELED" | "REJECTED" | string & object;
```

Where the order is: `LIVE` while some of it rests, `MATCHED` once all of it filled,
`CANCELED`, or `REJECTED`. A status added later reads as its own string.

***

### timestamp

```ts
timestamp: number;
```

When it happened, in Unix milliseconds.

***

### topic

```ts
topic: "user";
```

`'user'`.

***

### type

```ts
type: "order";
```

`'order'`.
