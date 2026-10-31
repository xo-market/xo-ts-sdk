# Type Alias: FetchUserRewardsEpochRequest

```ts
type FetchUserRewardsEpochRequest = object;
```

What [PublicClient.fetchUserRewardsEpoch](../interfaces/PublicClient.md#fetchuserrewardsepoch) takes.

## Properties

### epoch?

```ts
optional epoch?: number;
```

The UTC day: whole days since 1970-01-01, from 0 to 10,000,000. Defaults to today, the day
in progress, whose figures are a live projection.

***

### user

```ts
user: string;
```

The wallet whose rewards to read: `0x` and 40 hex digits.
