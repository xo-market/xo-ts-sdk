# Type Alias: MarketTrading

```ts
type MarketTrading = object;
```

The rules for trading a market. Each is `null` until the source that has it is read.

## Properties

### feeSchedule

```ts
feeSchedule: MarketFeeSchedule | null;
```

The fee rates, or `null` when fees do not apply or the fee policy was not read.

***

### feesEnabled

```ts
feesEnabled: boolean | null;
```

Whether the market charges a taker or maker fee. `null` until the fee policy is read.

***

### feeType

```ts
feeType: string | null;
```

The fee model, such as `FLAT_BPS` or `CONVICTION_CURVE`. `null` until the fee policy is read.

***

### minimumOrderSize

```ts
minimumOrderSize: DecimalString | null;
```

The smallest order the SDK places, in shares: 1. `null` until the order book is read.

***

### minimumTickSize

```ts
minimumTickSize: DecimalString | null;
```

The smallest price step, such as `"0.001"`. `null` until the order book is read.
