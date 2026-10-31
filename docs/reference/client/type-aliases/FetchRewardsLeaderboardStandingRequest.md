# Type Alias: FetchRewardsLeaderboardStandingRequest

```ts
type FetchRewardsLeaderboardStandingRequest = object;
```

What [SecureClient.fetchRewardsLeaderboardStanding](../interfaces/SecureClient.md#fetchrewardsleaderboardstanding) takes. Every key is optional.

## Properties

### period?

```ts
optional period?: "daily" | "weekly" | "seasonal";
```

The window: the day, the last 7 days or the season. Defaults to `weekly`.
