# Interface: OrderHeartbeat

A running order heartbeat, from [SecureClient.startOrderHeartbeat](SecureClient.md#startorderheartbeat).

## Properties

### running

```ts
readonly running: boolean;
```

`true` from the start until `stop()`. A missed beat does not change it.

## Methods

### stop()

```ts
stop(): void;
```

Stops sending heartbeats, and can be called again. It does not take the account out of the
cancel on silence: the open orders are cancelled about 30 seconds after the last beat.

#### Returns

`void`
