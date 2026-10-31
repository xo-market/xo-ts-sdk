# Type Alias: PulseStats

```ts
type PulseStats = object;
```

Totals over the pulse markets that trade on the order book.

## Properties

### initialCollateral

```ts
initialCollateral: DecimalString;
```

The collateral the rounds were opened with, in tokens.

***

### marketCount

```ts
marketCount: number;
```

How many pulse markets the totals cover.

***

### positionsValue

```ts
positionsValue: DecimalString;
```

The value of all open positions, in dollars.

***

### tradeCount

```ts
tradeCount: number;
```

How many trades have been made.

***

### traderCount

```ts
traderCount: number;
```

How many different traders have traded.

***

### volume

```ts
volume: DecimalString;
```

The total volume, in dollars.
