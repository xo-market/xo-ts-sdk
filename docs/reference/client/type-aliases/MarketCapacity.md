# Type Alias: MarketCapacity

```ts
type MarketCapacity = object;
```

What an account can still commit in one market.

## Properties

### buyCapacity

```ts
buyCapacity: DecimalString;
```

The USDC a new buy order in this market may use, in dollars.

***

### conditionId

```ts
conditionId: ConditionId;
```

The market's id on the order book.

***

### positions

```ts
positions: PositionCapacity[];
```

What the account can sell of each outcome: the YES outcome, then the NO outcome. Empty for a market the order book does not know.
