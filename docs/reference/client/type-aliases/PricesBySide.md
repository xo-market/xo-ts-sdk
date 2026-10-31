# Type Alias: PricesBySide

```ts
type PricesBySide = object;
```

The best price of one outcome token on each side of its book, in dollars between 0 and 1.
Only the sides that were asked for are there.

## Properties

### BUY?

```ts
optional BUY?: DecimalString | null;
```

The best bid: the highest price a buyer offers. `null` when nobody bids.

***

### SELL?

```ts
optional SELL?: DecimalString | null;
```

The best ask: the lowest price a seller wants. `null` when nobody asks.
