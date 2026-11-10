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

### maxPrice?

```ts
maxPrice?: number | string;
```

The highest price per share to pay: the order only fills at this price or better. From
0.001 to 0.999, a multiple of the market's tick size. Without it the order takes any price
up to 0.999.

***

### orderType?

```ts
orderType?: 
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
