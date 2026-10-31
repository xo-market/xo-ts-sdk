# Type Alias: MarketRewards

```ts
type MarketRewards = object;
```

The liquidity rewards on a market. Every field is `null` until the rewards programme is read.

## Properties

### clobRewards

```ts
clobRewards: MarketRewardsProgramme[] | null;
```

One entry per currency the market pays in. Empty when the market has no programme.

***

### rewardsMaxSpread

```ts
rewardsMaxSpread: number | null;
```

How far from the midpoint an order still earns, in cents.

***

### rewardsMinSize

```ts
rewardsMinSize: DecimalString | null;
```

The smallest resting order that earns, in shares.
