# Type Alias: MakerOrder

```ts
type MakerOrder = object;
```

The resting order that a trade filled.

## Properties

### assetId

```ts
assetId: TokenId;
```

The outcome token the order was for.

***

### feeRateBps

```ts
feeRateBps: DecimalString;
```

The fee rate of the fill, in basis points.

***

### makerAddress

```ts
makerAddress: Address;
```

The address that placed the resting order.

***

### matchedAmount

```ts
matchedAmount: DecimalString;
```

The shares of this order that the trade filled.

***

### orderId

```ts
orderId: string;
```

The id of the resting order.

***

### outcome

```ts
outcome: "YES" | "NO" | string & object;
```

The outcome of the resting order, `YES` or `NO`.

***

### price

```ts
price: DecimalString;
```

The price of the resting order, in dollars between 0 and 1.
