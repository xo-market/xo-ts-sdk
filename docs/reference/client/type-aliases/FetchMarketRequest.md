# Type Alias: FetchMarketRequest

```ts
type FetchMarketRequest = 
  | {
  id: string;
}
  | {
  slug: string;
}
  | {
  url: string;
}
  | {
  conditionId: string;
};
```

What [PublicClient.fetchMarket](../interfaces/PublicClient.md#fetchmarket) takes: one way to name the market.

- `id`: XO's id for the market (`Market.id`), digits.
- `slug`: the market's URL name.
- `url`: the link of the market's page on XO's website, such as
  `https://xo.market/markets/<slug>`. Only `https` links on `xo.market` and its subdomains
  are accepted.
- `conditionId`: the market's id on the order book, `0x` and 64 hex digits.
