# Type Alias: FetchPositionPnlRequest

```ts
type FetchPositionPnlRequest = object;
```

What [SecureClient.fetchUserPnl](../interfaces/SecureClient.md#fetchuserpnl) takes for one position.

## Properties

### marketId?

```ts
optional marketId?: undefined;
```

Not given with a position.

***

### positionId

```ts
positionId: string;
```

XO's id for the position: the `positionId` of a `Position`.
