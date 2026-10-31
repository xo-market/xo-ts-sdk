# Type Alias: MarketTopicEvent

```ts
type MarketTopicEvent = 
  | MarketBookEvent
  | PriceChangeEvent
  | LastTradePriceEvent;
```

An event of the `market` topic; narrow it with `type`.
