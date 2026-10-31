# Type Alias: SecureFetchUserRewardsRequest

```ts
type SecureFetchUserRewardsRequest = object;
```

What `fetchUserRewards` takes on a signed-in client: a wallet, or none for its own.

## Properties

### user?

```ts
optional user?: string;
```

The wallet whose rewards to read. Leave it out for the client's own wallet.
