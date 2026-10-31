# Type Alias: MarketPnl

```ts
type MarketPnl = object;
```

The profit and loss of the account's positions in one market.

## Properties

### marketId

```ts
marketId: string;
```

XO's id for the market.

***

### percentPnl

```ts
percentPnl: DecimalString;
```

The profit or loss on the market, in percent.

***

### pnl

```ts
pnl: DecimalString;
```

The profit or loss on the market, in dollars.

***

### positions

```ts
positions: PositionPnl[];
```

The account's positions in the market.

***

### title

```ts
title: string;
```

The market's question.
