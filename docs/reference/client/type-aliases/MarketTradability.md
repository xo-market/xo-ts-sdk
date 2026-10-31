# Type Alias: MarketTradability

```ts
type MarketTradability = object;
```

Whether a market can be traded, and why not when it cannot.

## Properties

### ok

```ts
ok: boolean;
```

`true` only when every check passed.

***

### reasons

```ts
reasons: TradableReason[];
```

One stable code per check that failed, in a fixed order. Empty when `ok`.
