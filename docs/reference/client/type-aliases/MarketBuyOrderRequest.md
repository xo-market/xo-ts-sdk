# Type Alias: MarketBuyOrderRequest

```ts
type MarketBuyOrderRequest = object;
```

A market order that buys: it spends `amount` dollars.

## Properties

### amount

```ts
amount: number | string;
```

How many dollars to spend, with at most 6 decimals.

***

### assetId

```ts
assetId: string;
```

The outcome token to buy: `outcomes.yes.tokenId` or `outcomes.no.tokenId` of a market.

***

### orderType?

```ts
optional orderType?: 
  | FAK
  | FOK;
```

What happens to the part that does not fill at once: `OrderType.FAK` (the default) drops it,
`OrderType.FOK` drops the whole order unless all of it fills.

***

### side

```ts
side: BUY;
```

`OrderSide.BUY`.
