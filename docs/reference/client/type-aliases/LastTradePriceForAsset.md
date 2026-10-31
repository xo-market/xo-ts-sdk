# Type Alias: LastTradePriceForAsset

```ts
type LastTradePriceForAsset = object;
```

The last trade of one outcome token in a list of them.

## Properties

### assetId

```ts
assetId: TokenId;
```

The outcome token the trade is for.

***

### price

```ts
price: DecimalString;
```

The trade's price in dollars between 0 and 1.

***

### side

```ts
side: OrderSide;
```

The side of the order that took the liquidity.
