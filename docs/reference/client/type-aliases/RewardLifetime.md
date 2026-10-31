# Type Alias: RewardLifetime

```ts
type RewardLifetime = object;
```

What a programme has scored and paid over its life, in one currency.

## Properties

### allocated

```ts
allocated: DecimalString;
```

What was allocated over the programme's life, in `currency`.

***

### baseAllocated

```ts
baseAllocated: DecimalString | null;
```

The part of `allocated` that came from the base programme. `null` when XO does not split it.

***

### bonusAllocated

```ts
bonusAllocated: DecimalString | null;
```

The part of `allocated` that came from bonus windows. `null` when XO does not split it.

***

### bonusOnlyEpochs

```ts
bonusOnlyEpochs: number | null;
```

On how many days only a bonus window paid. `null` when XO does not say.

***

### currency

```ts
currency: RewardCurrency;
```

The currency.

***

### distributed

```ts
distributed: DecimalString;
```

What was distributed over the programme's life, in `currency`.

***

### latestEpoch

```ts
latestEpoch: number;
```

The most recent scored day.

***

### scoredEpochs

```ts
scoredEpochs: number;
```

How many days have been scored.

***

### totalScoredLiquidity

```ts
totalScoredLiquidity: string;
```

The liquidity scored in all, as an exact decimal text (share-seconds).
