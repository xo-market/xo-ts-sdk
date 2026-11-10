# Interface: SubscriptionHandle\<E\>

A live subscription: iterate it with `for await` to read its events, and close it when you
are done. The events of every topic it was opened with arrive in one stream, in the order
they arrived.

**The loop sees events only, never gaps.** A stream does not replay what it missed while it
was down. Listen with [SubscriptionHandle.on](#on) too: `'reconnected'` says the connection
of a topic came back and its events in between are gone, and `'error'` says something went
wrong that the stream survived, such as `ws_events_dropped` (the service fell behind). Both
name the topic (`info.topic`, `error.topic`): read the state of the topic named again over
REST, such as `fetchOrderBooks` for `market` and `listOpenOrders` for `user`. The error
`subscription_overflow` (the loop read too slowly and old events were dropped) is about the
whole handle and names no topic: read the state of every topic again.

The first loop gets every event since `subscribe` resolved, up to 10,000 waiting events; a
later loop gets the events from when it starts. Breaking out of a loop stops that loop only:
the subscription stays open, and keeps the process alive, until [SubscriptionHandle.close](#close).
A topic whose stream stops for good reports why on `'error'` and the others go on; when every
topic has stopped, the handle closes.

## Example

```ts
const handle = await client.subscribe([{ topic: 'market', assetIds: [assetId] }]);
handle.on('reconnected', ({ topic }) => console.log(`${topic} is back: read it again`));
try {
  for await (const event of handle) {
    console.log(event.type, event.timestamp);
  }
} finally {
  await handle.close();
}
```

## Extends

- `AsyncIterable`\<`E`\>

## Type Parameters

| Type Parameter |
| ------ |
| <a id="type-parameter-e"></a> `E` |

## Methods

### close()

```ts
close(): Promise<void>;
```

Stops every stream of the subscription and closes its connections. A loop over it ends, and
`'closed'` is emitted once the connections are closed. Calling it again returns the same
promise, and it never rejects.

#### Returns

`Promise`\<`void`\>

#### Example

```ts
await handle.close();
```

***

### on()

#### Call Signature

```ts
on(type, listener): () => void;
```

Listens for the connection of a topic that came back after a drop. Its events in between
are gone: read the state of the topic named again. Returns a function that removes the
listener.

##### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `type` | `"reconnected"` | `'reconnected'`. |
| `listener` | (`info`) => `void` | Called once per reconnect, with the topic that reconnected. |

##### Returns

() => `void`

##### Example

```ts
const stop = handle.on('reconnected', ({ topic }) => console.log(`${topic} reconnected`));
stop();
```

#### Call Signature

```ts
on(type, listener): () => void;
```

Listens for something that went wrong; the error's `code` says what (see the realtime codes
of the errors page), and its `topic` which topic it is about (`undefined` for
`subscription_overflow`, which is about the whole handle). The stream goes on, except a
topic that stopped for good, which the message says. Returns a function that removes the
listener.

##### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `type` | `"error"` | `'error'`. |
| `listener` | (`error`) => `void` | Called with each error. |

##### Returns

() => `void`

##### Example

```ts
handle.on('error', (error) => console.log(error.topic, error.code, error.message));
```

#### Call Signature

```ts
on(type, listener): () => void;
```

Listens for the end of the subscription: it closed, by [SubscriptionHandle.close](#close),
by the client closing it, or because every stream of it stopped for good. A listener added
after the end is called once, soon after. Returns a function that removes the listener.

##### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `type` | `"closed"` | `'closed'`. |
| `listener` | () => `void` | Called once. |

##### Returns

() => `void`

##### Example

```ts
handle.on('closed', () => console.log('closed'));
```
