# Type Alias: UserRewardsEpochMarket

```ts
type UserRewardsEpochMarket = object;
```

One market's line of a wallet's reward day.

## Properties

### allocated

```ts
allocated: DecimalString;
```

What was allocated to the wallet, in `currency`.

***

### conditionId

```ts
conditionId: ConditionId;
```

The market's id on the order book.

***

### credited

```ts
credited: DecimalString | null;
```

What has been paid so far, in `currency`. `null` before settlement.

***

### currency

```ts
currency: RewardCurrency;
```

What the amounts are in.

***

### effective

```ts
effective: DecimalString;
```

What the wallet earns, in `currency`.

***

### score

```ts
score: string;
```

The wallet's liquidity score on the market, as an exact decimal text.

***

### scoreShare

```ts
scoreShare: string;
```

The score as a fraction of the market's total, from `"0"` to `"1"`.

***

### status

```ts
status: RewardPayoutStatus;
```

Where the payout stands.
