# Type Alias: RewardPool

```ts
type RewardPool = object;
```

A market (or, for a Pulse group, the window accruing now) that pays liquidity rewards,
with its programme in each currency.

## Properties

### bonuses

```ts
bonuses: RewardBonus[];
```

The bonus windows: live, scheduled, then ended.

***

### conditionId

```ts
conditionId: ConditionId;
```

The market's id on the order book.

***

### groupId

```ts
groupId: string | null;
```

The Pulse group whose shared pool pays this window. `null` for a market with its own pool.

***

### market

```ts
market: RewardPoolMarket | null;
```

The market. `null` when XO gave none.

***

### programmes

```ts
programmes: RewardProgramme[];
```

The programme in each currency, `CP` first.
