# Type Alias: SecureFetchUserStatsRequest

```ts
type SecureFetchUserStatsRequest = object;
```

What `fetchUserStats` takes on a signed-in client: a user's `username`, or nothing for the
client's own account.

## Properties

### username?

```ts
optional username?: string;
```

The user's unique name on XO. Leave it out for the client's own account.
