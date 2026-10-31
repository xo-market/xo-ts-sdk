# Type Alias: MarketFeeSchedule

```ts
type MarketFeeSchedule = object;
```

The fees charged on a market, in basis points.

## Properties

### makerFeeBps

```ts
makerFeeBps: number;
```

The maker's fee.

***

### split

```ts
split: MarketFeeSplit | null;
```

How the fee is shared out, or `null` when XO gave no split.

***

### takerFeeBps

```ts
takerFeeBps: number;
```

The taker's base fee. For the `CONVICTION_CURVE` fee type this is the rate before the
price curve is applied.
