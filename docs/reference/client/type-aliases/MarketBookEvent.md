# Type Alias: MarketBookEvent

```ts
type MarketBookEvent = object;
```

`book`: the whole order book of one outcome token. One comes for each token when the
subscription opens and after every reconnect, and another after every placement, cancel and
fill in the market, so a book kept from these events heals itself on the next one. Replace
what you hold with each one.

Both sides are listed with the best price last, as in `fetchOrderBook`: the best bid is
`bids.at(-1)` and the best ask is `asks.at(-1)`.

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

### timestamp

```ts
timestamp: number;
```

When the book was read, in Unix milliseconds.

***

### topic

```ts
topic: "market";
```

`'market'`.

***

### type

```ts
type: "book";
```

`'book'`.
