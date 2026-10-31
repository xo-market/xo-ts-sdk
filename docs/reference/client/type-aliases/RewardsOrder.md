# Type Alias: RewardsOrder

```ts
type RewardsOrder = object;
```

An order that was scored for rewards on a day.

The same model serves a market's orders (which name the `maker`) and the account's own
(which name the `conditionId`, the payouts per currency and how the order is scoring);
the fields only one of them has are `null` on the other.

## Properties

### closingSize

```ts
closingSize: DecimalString;
```

The order's size at the end of the day, in shares.

***

### conditionId

```ts
conditionId: ConditionId | null;
```

The market's id on the order book. `null` in a market's list: the market is the one asked for.

***

### createdAt

```ts
createdAt: string;
```

When the order was placed, as an ISO 8601 time.

***

### eligibleMs

```ts
eligibleMs: number;
```

How long the order qualified, in milliseconds.

***

### exit

```ts
exit: RewardsOrderExit | null;
```

How the order ended. `null` while it still rests.

***

### firstSeenAt

```ts
firstSeenAt: string;
```

When the order was first seen on the day, as an ISO 8601 time.

***

### groupId

```ts
groupId: string | null;
```

The Pulse group the order's market belongs to. `null` for an ordinary market, and in a market's list.

***

### lastSeenAt

```ts
lastSeenAt: string;
```

When the order was last seen on the day, as an ISO 8601 time.

***

### maker

```ts
maker: Address | null;
```

The wallet that placed the order. `null` in the account's own list.

***

### openingSize

```ts
openingSize: DecimalString;
```

The order's size at the start of the day, in shares.

***

### orderId

```ts
orderId: string;
```

The order's id.

***

### outcome

```ts
outcome: string;
```

The outcome the order is for, such as `Yes`.

***

### payouts

```ts
payouts: RewardAmount[];
```

What the order earns, per currency.

***

### price

```ts
price: DecimalString;
```

The order's limit price in dollars between 0 and 1.

***

### projected

```ts
projected: boolean | null;
```

Whether the figures are a live projection. `null` in a market's list.

***

### score

```ts
score: string;
```

The order's liquidity score, as an exact decimal text.

***

### scored

```ts
scored: boolean;
```

Whether the order has a score yet: an order that was just placed shows a placeholder score of 0 until it is scored.

***

### scoreShare

```ts
scoreShare: string;
```

The order's share of its maker's score, as an exact decimal text from `"0"` to `"1"`.

***

### scoring

```ts
scoring: 
  | "scoring"
  | "previously_scored"
  | "not_scoring"
  | string & object
  | null;
```

`scoring`, `previously_scored` or `not_scoring`. `null` in a market's list.

***

### side

```ts
side: OrderSide;
```

Whether the order buys or sells.
