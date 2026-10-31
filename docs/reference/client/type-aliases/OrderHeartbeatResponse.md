# Type Alias: OrderHeartbeatResponse

```ts
type OrderHeartbeatResponse = object;
```

What [SecureClient.sendOrderHeartbeat](../interfaces/SecureClient.md#sendorderheartbeat) answers.

## Properties

### tracked

```ts
tracked: boolean;
```

Whether XO counted the beat. `false` means it did not: the credentials were not accepted,
and the countdown to the cancel of every open order was not reset.
