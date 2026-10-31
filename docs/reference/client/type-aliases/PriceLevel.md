# Type Alias: PriceLevel

```ts
type PriceLevel = object;
```

One price level of an order book: all the resting size at one price.

## Properties

### price

```ts
price: DecimalString;
```

The price in dollars between 0 and 1, as printed, such as `"0.550"`.

***

### size

```ts
size: DecimalString;
```

The shares resting at this price, as printed, such as `"80.123456"`.
