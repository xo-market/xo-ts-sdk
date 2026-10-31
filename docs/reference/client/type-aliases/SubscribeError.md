# Type Alias: SubscribeError

```ts
type SubscribeError = UserInputError;
```

The error union of `subscribe`: a `UserInputError` for specs that are not valid, a topic that
needs a signed-in client (`topic_needs_sign_in`), no WebSocket implementation, or a client
that is closed (`client_closed`).
