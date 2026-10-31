# Class: Clock

Keeps the offset between this machine's clock and the orderbook's, so that every auth
timestamp (L1 `ClobAuth` and L2 HMAC) is the server's time and not a skewed local one.
The orderbook rejects timestamps too far from its own clock with a 401.

- Before the first successful [Clock.sync](#sync) the offset is 0, so `nowSec()` is the
  local time.
- The offset is `serverSec * 1000` minus the midpoint of the local clock before and
  after the request, which cancels half of the round trip.
- [Clock.nowSec](#nowsec) also refreshes the offset lazily, in the background, once
  `resyncMs` has passed. There are no timers, so the clock never keeps a process alive.

The same instance can serve concurrent callers.

## Constructors

### Constructor

```ts
new Clock(o): Clock;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `o` | `ClockOptions` |

#### Returns

`Clock`

## Methods

### nowSec()

```ts
nowSec(): number;
```

The current server time as unix seconds, rounded down. It returns at once, with the
offset known so far, and never throws because of a sync. If a resync is due it
starts one in the background and does not wait for it.

#### Returns

`number`

***

### nowSecString()

```ts
nowSecString(): string;
```

[Clock.nowSec](#nowsec) as a decimal string, the form that goes in an auth header.

#### Returns

`string`

***

### sync()

```ts
sync(): Promise<void>;
```

Reads the server's clock and updates the offset. Calls made while a sync is in
flight share it, including a call made by `fetchServerTimeSec` itself. Rejects on
any failure (the fetch failed, the value was implausible, or the round trip was
negative or took longer than `maxRttMs`) and the previous offset stays in force.

#### Returns

`Promise`\<`void`\>
