# Type Alias: OrderBook

```ts
type OrderBook = object;
```

The order book of one outcome token.

Both sides are listed with the best price last: `bids` from the lowest bid to the highest,
and `asks` from the highest ask to the lowest. The best bid is `bids.at(-1)` and the best
ask is `asks.at(-1)`.

## Properties

### asks

```ts
asks: PriceLevel[];
```

The sell orders, highest price first, so the best ask is the last level.

***

### assetId

```ts
assetId: TokenId;
```

The outcome token the book is for.

***

### bids

```ts
bids: PriceLevel[];
```

The buy orders, lowest price first, so the best bid is the last level.

***

### hash

```ts
hash: string;
```

A short fingerprint of the book that changes when the book does.

***

### market

```ts
market: ConditionId;
```

The id of the market the token belongs to.

***

### minimumOrderSize

```ts
minimumOrderSize: DecimalString;
```

The smallest order in shares: 1 unless the book states a larger one.

***

### minimumTickSize

```ts
minimumTickSize: DecimalString;
```

The smallest price step, such as `"0.001"`.

***

### negRisk

```ts
negRisk: boolean;
```

Whether the market is a negative-risk market.

***

### timestamp

```ts
timestamp: number | null;
```

When the book was read, in Unix milliseconds. `null` when the source gave no readable time.
