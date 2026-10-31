# Type Alias: SendOrderHeartbeatError

```ts
type SendOrderHeartbeatError = CancelOrderError;
```

The error union of [SecureClient.sendOrderHeartbeat](../interfaces/SecureClient.md#sendorderheartbeat): the errors of its one request, which is never
tried again, and of the sign-in the client makes when its credentials are refused.
