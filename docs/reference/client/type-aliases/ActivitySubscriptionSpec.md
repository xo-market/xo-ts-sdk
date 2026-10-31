# Type Alias: ActivitySubscriptionSpec

```ts
type ActivitySubscriptionSpec = object;
```

The `activity` topic: the newest fills of one market each time it trades.

## Properties

### marketId

```ts
marketId: string;
```

XO's id for the market (the `id` of a `Market`): digits.

***

### topic

```ts
topic: "activity";
```

`'activity'`.
