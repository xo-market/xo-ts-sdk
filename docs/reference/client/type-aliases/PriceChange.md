# Type Alias: PriceChange

```ts
type PriceChange = object;
```

One price level that changed, in a [PriceChangeEvent](PriceChangeEvent.md).

## Properties

### assetId

```ts
assetId: TokenId;
```

The outcome token whose book changed.

***

### bestAsk

```ts
bestAsk: DecimalString | null;
```

The best ask after the change. `null` when there is none.

***

### bestBid

```ts
bestBid: DecimalString | null;
```

The best bid after the change. `null` when there is none.

***

### hash

```ts
hash: string;
```

The fingerprint of the token's book after the change.

***

### price

```ts
price: DecimalString;
```

The price of the level, in dollars between 0 and 1, such as `"0.55"`.

***

### side

```ts
side: OrderSide;
```

The side of the book the level is on.

***

### size

```ts
size: DecimalString;
```

The shares resting at this price now; `"0"` when the level is gone.
