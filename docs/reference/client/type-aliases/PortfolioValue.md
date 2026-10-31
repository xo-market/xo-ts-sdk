# Type Alias: PortfolioValue

```ts
type PortfolioValue = object;
```

The account's cash and portfolio figures, in dollars.

## Properties

### cash

```ts
cash: DecimalString;
```

Spendable USDC in the wallet, as XO's portfolio value reports it. This is not the order
book's credit ([Balances.collateral](Balances.md#collateral)); the two can differ, for example right after
a deposit or before a withdrawal.

***

### claimableAmount

```ts
claimableAmount: DecimalString;
```

Winnings that are settled and not redeemed yet.

***

### positionsValue

```ts
positionsValue: DecimalString;
```

What the open positions are worth.

***

### unpricedPositionCount

```ts
unpricedPositionCount: number;
```

How many open positions were valued at cost for want of a price. Above 0 the total is an estimate.

***

### value

```ts
value: DecimalString;
```

The whole portfolio: `cash + positionsValue + claimableAmount`.
