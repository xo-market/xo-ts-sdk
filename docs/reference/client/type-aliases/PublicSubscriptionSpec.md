# Type Alias: PublicSubscriptionSpec

```ts
type PublicSubscriptionSpec = 
  | MarketSubscriptionSpec
  | ActivitySubscriptionSpec;
```

The topics a client without a wallet can subscribe to: `market` and `activity`.
