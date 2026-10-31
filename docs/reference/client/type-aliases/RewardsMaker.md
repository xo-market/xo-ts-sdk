# Type Alias: RewardsMaker

```ts
type RewardsMaker = object;
```

A maker's share of a market's reward day.

## Properties

### allocated

```ts
allocated: DecimalString;
```

What was allocated to the maker, in the rail's currency.

***

### credited

```ts
credited: DecimalString | null;
```

What has been paid so far, in the rail's currency. `null` before settlement.

***

### effective

```ts
effective: DecimalString;
```

What the maker earns for the day, in the rail's currency.

***

### score

```ts
score: string;
```

The maker's liquidity score for the day, as an exact decimal text.

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

Where the maker's payout stands.

***

### wallet

```ts
wallet: Address;
```

The maker's wallet.
