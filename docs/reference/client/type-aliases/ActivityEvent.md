# Type Alias: ActivityEvent

```ts
type ActivityEvent = object;
```

`trades`: the newest fills of one market, up to 50, newest first, each time it trades (and
once when the subscription opens). Replace what you hold with each one.

## Properties

### marketId

```ts
marketId: string;
```

XO's id for the market (the `id` of a `Market`).

***

### timestamp

```ts
timestamp: number;
```

When XO built the list, in Unix milliseconds.

***

### topic

```ts
topic: "activity";
```

`'activity'`.

***

### trades

```ts
trades: MarketTrade[];
```

The fills, newest first.

***

### type

```ts
type: "trades";
```

`'trades'`.
