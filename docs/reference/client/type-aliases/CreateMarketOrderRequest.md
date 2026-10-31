# Type Alias: CreateMarketOrderRequest

```ts
type CreateMarketOrderRequest = 
  | MarketBuyOrderRequest
  | MarketSellOrderRequest;
```

What [SecureClient.createMarketOrder](../interfaces/SecureClient.md#createmarketorder) and [SecureClient.placeMarketOrder](../interfaces/SecureClient.md#placemarketorder) take: a buy of an `amount` of
dollars, or a sell of a number of `shares`.
