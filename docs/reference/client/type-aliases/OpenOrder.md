# Type Alias: OpenOrder

```ts
type OpenOrder = object;
```

An order of the account that rests on the book.

A resting order on a market that has an end time lists as `GTD`, even one placed as `GTC`,
and its `expiration` is that end time or the order's own, whichever is earlier.

## Properties

### assetId

```ts
assetId: TokenId;
```

The outcome token the order is for.

***

### createdAt

```ts
createdAt: string;
```

When the order was placed, as an ISO 8601 time.

***

### expiration

```ts
expiration: string | null;
```

When the order expires, as an ISO 8601 time. `null` when it does not expire.

***

### makerAddress

```ts
makerAddress: Address;
```

The address that placed the order.

***

### market

```ts
market: ConditionId;
```

The id of the market the token belongs to.

***

### orderId

```ts
orderId: string;
```

The order's id. Pass it to fetch or cancel the order.

***

### orderType

```ts
orderType: OrderType;
```

How long the order lives.

***

### originalSize

```ts
originalSize: DecimalString;
```

The shares the order was placed for.

***

### outcome

```ts
outcome: "YES" | "NO" | string & object;
```

The outcome the order is for, `YES` or `NO`.

***

### price

```ts
price: DecimalString;
```

The limit price in dollars between 0 and 1, as printed, such as `"0.570"`.

***

### side

```ts
side: OrderSide;
```

Whether the order buys or sells.

***

### sizeMatched

```ts
sizeMatched: DecimalString;
```

The shares that have filled so far.

***

### status

```ts
status: OpenOrderStatus;
```

Where the order is.
