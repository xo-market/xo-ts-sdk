# Type Alias: ListRewardsLeaderboardRequest

```ts
type ListRewardsLeaderboardRequest = object;
```

What [SecureClient.listRewardsLeaderboard](../interfaces/SecureClient.md#listrewardsleaderboard) takes. Every key is optional.

## Properties

### pageSize?

```ts
pageSize?: number;
```

How many makers a page holds, from 1 to 1000.

***

### period?

```ts
period?: "daily" | "weekly" | "seasonal";
```

The window: the day, the last 7 days or the season. Defaults to `weekly`.
