# Type Alias: MarketOutcome

```ts
type MarketOutcome = object;
```

One side of a market: its outcome token and its price.

`tokenId` is the id to trade and to read the book with (`assetId` in a request).

## Properties

### label

```ts
label: string;
```

The outcome's name, such as `YES`.

***

### price

```ts
price: DecimalString | null;
```

The price in dollars between 0 and 1: the order book's midpoint, or its last trade when
a side is empty. `null` while the order book has neither, and `null` until the order
book is read.

***

### tokenId

```ts
tokenId: TokenId | null;
```

The outcome token, or `null` when no source gave one.
