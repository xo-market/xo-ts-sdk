# Type Alias: RewardsLeaderboardEntry

```ts
type RewardsLeaderboardEntry = object;
```

A maker on the liquidity leaderboard, with the profile of its wallet when it has one.

## Properties

### achievements

```ts
achievements: string[];
```

The keys of the badges the maker earned.

***

### convictionPoints

```ts
convictionPoints: DecimalString;
```

The maker's conviction points, as an exact decimal.

***

### creditedCp

```ts
creditedCp: DecimalString;
```

The conviction points credited for the period.

***

### isOg

```ts
isOg: boolean;
```

Whether the maker holds the OG role (the top 5% of the daily leaderboard).

***

### liquidityCp

```ts
liquidityCp: DecimalString;
```

The effective conviction points the maker earned in the period.

***

### marketDays

```ts
marketDays: number;
```

On how many market-days the maker earned in the period.

***

### name

```ts
name: string | null;
```

The maker's display name.

***

### profileImage

```ts
profileImage: string | null;
```

The maker's picture.

***

### rank

```ts
rank: number;
```

The maker's rank.

***

### tier

```ts
tier: string;
```

The maker's tier, such as `Believer`.

***

### userId

```ts
userId: string | null;
```

XO's id for the maker. `null` for a wallet with no XO account.

***

### username

```ts
username: string | null;
```

The maker's unique name.

***

### verifiedBadge

```ts
verifiedBadge: boolean;
```

Whether the maker is verified.

***

### wallet

```ts
wallet: Address;
```

The maker's wallet.
