# Type Alias: UserStats

```ts
type UserStats = object;
```

A trader's statistics. A figure XO does not have yet is `null`.

## Properties

### pnl

```ts
pnl: DecimalString | null;
```

The total profit or loss, in dollars.

***

### tradedMarketCount

```ts
tradedMarketCount: number | null;
```

How many different markets the trader has traded.

***

### volume

```ts
volume: DecimalString | null;
```

The total volume traded, in dollars.
