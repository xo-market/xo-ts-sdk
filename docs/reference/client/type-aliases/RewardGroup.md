# Type Alias: RewardGroup

```ts
type RewardGroup = object;
```

A Pulse group: one shared reward pool for all the short rounds of a product.

A group read from a listing has only what the listing carries; `day`,
`totalScoredLiquidity` and `lifetime` are `null` there.

## Properties

### active

```ts
active: boolean;
```

Whether the group pays today.

***

### activeMarkets

```ts
activeMarkets: number;
```

How many windows of the product accrue today.

***

### bonuses

```ts
bonuses: RewardBonus[];
```

The bonus windows: live, scheduled, then ended.

***

### day

```ts
day: RewardsDay | null;
```

The day in progress. `null` in a listing.

***

### groupId

```ts
groupId: string;
```

XO's id for the group.

***

### lifetime

```ts
lifetime: RewardLifetime[] | null;
```

What the group scored and paid over its life, per currency. `null` in a listing.

***

### product

```ts
product: RewardGroupProduct | null;
```

What the group is for. `null` when XO has no label for it.

***

### programmes

```ts
programmes: RewardProgramme[];
```

The programme in each currency, `CP` first.

***

### totalScoredLiquidity

```ts
totalScoredLiquidity: string | null;
```

The liquidity scored in all, as an exact decimal text (share-seconds). `null` in a listing.
