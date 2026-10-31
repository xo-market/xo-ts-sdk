# Type Alias: UserRewardsEpoch

```ts
type UserRewardsEpoch = object;
```

A wallet's reward day across every market.

## Properties

### allocatedCp

```ts
allocatedCp: DecimalString;
```

What was allocated to the wallet, in `CP`.

***

### creditedCp

```ts
creditedCp: DecimalString | null;
```

What has been paid so far, in `CP`. `null` before settlement.

***

### day

```ts
day: RewardsDay;
```

The day.

***

### effectiveCp

```ts
effectiveCp: DecimalString;
```

What the wallet earns for the day, in `CP`, over all markets.

***

### flagged

```ts
flagged: boolean;
```

Whether the wallet is flagged by the programme's enforcement.

***

### markets

```ts
markets: UserRewardsEpochMarket[];
```

The markets the wallet scored on.

***

### user

```ts
user: RewardsUserProfile | null;
```

The XO user behind the wallet. `null` for a wallet with no XO account.

***

### wallet

```ts
wallet: Address;
```

The wallet.
