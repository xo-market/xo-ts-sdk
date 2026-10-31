# Type Alias: MarketSubscriptionSpec

```ts
type MarketSubscriptionSpec = object;
```

The `market` topic: the books, price changes and fills of outcome tokens or markets.

## Properties

### assetIds?

```ts
optional assetIds?: readonly string[];
```

Outcome tokens, by id (the `assetId` of an order book). Their events only, even though the
service sends their market's.

***

### markets?

```ts
optional markets?: readonly string[];
```

Markets, by condition id: the events of every outcome token of each one.

***

### topic

```ts
topic: "market";
```

`'market'`.
