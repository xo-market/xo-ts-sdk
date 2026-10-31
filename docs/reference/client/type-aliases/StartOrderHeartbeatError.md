# Type Alias: StartOrderHeartbeatError

```ts
type StartOrderHeartbeatError = 
  | UserInputError
  | XoError;
```

The error union of [SecureClient.startOrderHeartbeat](../interfaces/SecureClient.md#startorderheartbeat): the request, a heartbeat that is already
running (`heartbeat_already_running`), and a client whose session is closed.
