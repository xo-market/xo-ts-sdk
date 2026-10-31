# Type Alias: UserCpRewards

```ts
type UserCpRewards = object;
```

A wallet's `CP` rewards. Every figure is rounded to two decimals.

## Properties

### creatorBonus

```ts
creatorBonus: DecimalString;
```

Creator bonus points, all time.

***

### currentDay

```ts
currentDay: UserRewardsDay;
```

The open day.

***

### liquidity

```ts
liquidity: UserRewardsTotal;
```

Points for resting orders.

***

### totalReceived

```ts
totalReceived: DecimalString;
```

Liquidity points credited, all time.
