# Type Alias: UserPnl

```ts
type UserPnl = object;
```

The profit and loss of the whole account: the totals and the position behind them.

## Properties

### closedPositions

```ts
closedPositions: number;
```

How many positions are closed.

***

### currentValue

```ts
currentValue: DecimalString;
```

What all the positions are worth now, in dollars.

***

### entryValue

```ts
entryValue: DecimalString;
```

What all the positions cost at their average entry prices, in dollars.

***

### failedCalculations

```ts
failedCalculations: number;
```

How many positions XO could not calculate.

***

### openPositions

```ts
openPositions: number;
```

How many positions are open.

***

### percentPnl

```ts
percentPnl: DecimalString;
```

The total profit or loss, in percent.

***

### pnl

```ts
pnl: DecimalString;
```

The total profit or loss, in dollars.

***

### positions

```ts
positions: PositionPnl[];
```

The positions behind the totals.
