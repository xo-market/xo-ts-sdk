# Type Alias: Balances

```ts
type Balances = object;
```

What the order book holds for the account: its credit in cash, and its outcome shares with
what resting sell orders reserve. These are the order book's records, not the balances at
the wallet address on chain, and the two can differ, for example right after a deposit or
before a withdrawal.

## Properties

### collateral

```ts
collateral: DecimalString;
```

The cash credit the order book holds for the account, in dollars. This is not the USDC at
the wallet address on chain, and the two can differ, for example right after a deposit or
before a withdrawal.

***

### positions

```ts
positions: PositionBalance[];
```

The outcome shares the account holds. Tokens with no balance are left out.
