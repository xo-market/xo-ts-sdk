# Type Alias: SecureFetchUserRewardsEpochRequest

```ts
type SecureFetchUserRewardsEpochRequest = object;
```

What `fetchUserRewardsEpoch` takes on a signed-in client: a wallet, or none for its own.

## Properties

### epoch?

```ts
epoch?: number;
```

The UTC day: whole days since 1970-01-01, from 0 to 10,000,000. Defaults to today, the day
in progress, whose figures are a live projection.

***

### user?

```ts
user?: string;
```

The wallet whose rewards to read. Leave it out for the client's own wallet.
