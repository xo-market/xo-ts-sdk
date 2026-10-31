# Type Alias: FetchMarketPnlRequest

```ts
type FetchMarketPnlRequest = object;
```

What [SecureClient.fetchUserPnl](../interfaces/SecureClient.md#fetchuserpnl) takes for one market.

## Properties

### marketId

```ts
marketId: string;
```

XO's id for the market: the `id` of a `Market`, or the `marketId` of a `Position`.

***

### positionId?

```ts
optional positionId?: undefined;
```

Not given with a market.
