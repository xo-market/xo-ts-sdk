# Type Alias: PriceChangeEvent

```ts
type PriceChangeEvent = object;
```

`price_change`: price levels of a market changed after a placement or a cancel, one entry per
level. With `assetIds`, only the entries of those tokens are kept.

## Properties

### market

```ts
market: ConditionId;
```

The id of the market.

***

### priceChanges

```ts
priceChanges: PriceChange[];
```

The levels that changed.

***

### timestamp

```ts
timestamp: number;
```

When the change happened, in Unix milliseconds.

***

### topic

```ts
topic: "market";
```

`'market'`.

***

### type

```ts
type: "price_change";
```

`'price_change'`.
