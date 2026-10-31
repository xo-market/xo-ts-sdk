# Type Alias: UserRewards

```ts
type UserRewards = object;
```

What a wallet has earned from liquidity rewards.

## Properties

### cp

```ts
cp: UserCpRewards | null;
```

The `CP` rewards. `null` when XO has no account for the wallet.

***

### day

```ts
day: RewardsDay;
```

The day the figures are drawn for.

***

### flagged

```ts
flagged: boolean;
```

Whether the wallet is flagged by the programme's enforcement.

***

### usdc

```ts
usdc: UserUsdcRewards | null;
```

The `USDC` rewards. `null` when XO has no account for the wallet.
