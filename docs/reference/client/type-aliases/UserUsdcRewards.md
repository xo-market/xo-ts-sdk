# Type Alias: UserUsdcRewards

```ts
type UserUsdcRewards = object;
```

A wallet's `USDC` rewards. Every figure is rounded to two decimals, in dollars.

## Properties

### currentDay

```ts
currentDay: UserRewardsDay;
```

The open day.

***

### liquidityRewards

```ts
liquidityRewards: UserRewardsTotal;
```

Rewards for resting orders.

***

### makerRebates

```ts
makerRebates: UserRewardsTotal;
```

Maker rebates.

***

### totalReceived

```ts
totalReceived: DecimalString;
```

Maker rebates and liquidity rewards, all time.
