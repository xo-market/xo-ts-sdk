# Type Alias: RewardTerms

```ts
type RewardTerms = object;
```

How a programme scores resting orders. A term XO does not state is `null`.

## Properties

### maxAvgPrice

```ts
maxAvgPrice: DecimalString | null;
```

Orders score nothing when the midpoint is above this price (or below 1 minus it), in dollars between 0 and 1.

***

### maxDistanceCents

```ts
maxDistanceCents: number | null;
```

How far from the midpoint, in cents, an order still scores.

***

### minOrderRestMs

```ts
minOrderRestMs: number | null;
```

How long an order must rest before it scores, in milliseconds.

***

### minOrderSize

```ts
minOrderSize: DecimalString | null;
```

The smallest order that scores, in shares.

***

### minPayout

```ts
minPayout: DecimalString | null;
```

The smallest payout that is made, in the programme's currency.

***

### singleSidedFactor

```ts
singleSidedFactor: number | null;
```

The multiplier on the score of a one-sided order.

***

### twoSidedBandHigh

```ts
twoSidedBandHigh: DecimalString | null;
```

The high end of the scoring band, as a price between 0 and 1.

***

### twoSidedBandLow

```ts
twoSidedBandLow: DecimalString | null;
```

The low end of the scoring band, as a price between 0 and 1.
