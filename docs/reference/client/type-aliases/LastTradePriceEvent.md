# Type Alias: LastTradePriceEvent

```ts
type LastTradePriceEvent = object;
```

`last_trade_price`: a fill, seen from the side of the order that took the liquidity.

## Properties

### assetId

```ts
assetId: TokenId;
```

The outcome token the taker traded.

***

### feeRateBps

```ts
feeRateBps: DecimalString;
```

The fee rate of the fill, in basis points.

***

### market

```ts
market: ConditionId;
```

The id of the market.

***

### price

```ts
price: DecimalString;
```

The taker's effective price, in dollars between 0 and 1.

***

### side

```ts
side: OrderSide;
```

The taker's side.

***

### size

```ts
size: DecimalString;
```

The shares that changed hands.

***

### timestamp

```ts
timestamp: number;
```

When the fill happened, in Unix milliseconds.

***

### topic

```ts
topic: "market";
```

`'market'`.

***

### type

```ts
type: "last_trade_price";
```

`'last_trade_price'`.
