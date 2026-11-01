# Type Alias: MarketSellOrderRequest

```ts
type MarketSellOrderRequest = object;
```

A market order that sells: it gives `shares` shares.

## Properties

### assetId

```ts
assetId: string;
```

The outcome token to sell: `outcomes.yes.tokenId` or `outcomes.no.tokenId` of a market.

***

### minPrice?

```ts
optional minPrice?: number | string;
```

The lowest price per share to take: the order only fills at this price or better. From
0.001 to 0.999, a multiple of the market's tick size. Without it the order takes any price
down to 0.001.

***

### orderType?

```ts
optional orderType?: 
  | FAK
  | FOK;
```

What happens to the part that does not fill at once: see [MarketBuyOrderRequest](MarketBuyOrderRequest.md).

***

### shares

```ts
shares: number | string;
```

How many shares to sell: at least 1, with at most 6 decimals.

***

### side

```ts
side: SELL;
```

`OrderSide.SELL`.
