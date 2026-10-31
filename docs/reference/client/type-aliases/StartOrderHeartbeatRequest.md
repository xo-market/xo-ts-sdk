# Type Alias: StartOrderHeartbeatRequest

```ts
type StartOrderHeartbeatRequest = object;
```

What [SecureClient.startOrderHeartbeat](../interfaces/SecureClient.md#startorderheartbeat) takes. Every key is optional.

## Properties

### intervalMs?

```ts
optional intervalMs?: number;
```

Milliseconds between two beats: a whole number from 1 000 to 20 000. Defaults to 10 000.

***

### onMissed?

```ts
optional onMissed?: (error) => void;
```

Called with the error of every beat that did not count: XO answered that it did not track
it, or the request failed or took too long. It never stops the heartbeat, and an error it
throws is ignored.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `error` | [`XoError`](../classes/XoError.md) |

#### Returns

`void`
