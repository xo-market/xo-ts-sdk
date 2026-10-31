# Type Alias: PricePoint

```ts
type PricePoint = object;
```

One point of a token's price history: the price of a trade.

## Properties

### price

```ts
price: DecimalString;
```

The trade's price in dollars between 0 and 1, as printed, such as `"0.520"`.

***

### timestamp

```ts
timestamp: number;
```

When the trade happened, in Unix milliseconds.
