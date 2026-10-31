# Type Alias: MarketTrade

```ts
type MarketTrade = object;
```

A fill of a market, as the public trade feed lists it. A field the feed does not give is
`null`: a single market's feed leaves out the market's own fields, which the caller knows.

## Properties

### amount

```ts
amount: DecimalString;
```

The dollar value of the fill.

***

### conditionId

```ts
conditionId: ConditionId | null;
```

The market's id on the order book. `null` in a single market's feed.

***

### eventSlug

```ts
eventSlug: string | null;
```

The URL name of the event the market is placed on.

***

### icon

```ts
icon: string | null;
```

The market's picture. `null` in a single market's feed.

***

### id

```ts
id: string;
```

XO's id for the fill.

***

### marketId

```ts
marketId: string | null;
```

XO's id for the market (the `id` of a `Market`).

***

### outcome

```ts
outcome: string | null;
```

The outcome that traded, such as `YES`.

***

### outcomeIndex

```ts
outcomeIndex: number | null;
```

The outcome's index in the market: 0 for the first, 1 for the second.

***

### price

```ts
price: DecimalString | null;
```

The price per share, in dollars between 0 and 1. `null` when XO gave none.

***

### profileImage

```ts
profileImage: string | null;
```

The trader's picture.

***

### side

```ts
side: OrderSide;
```

Whether the fill bought or sold shares.

***

### size

```ts
size: DecimalString;
```

The shares that changed hands.

***

### slug

```ts
slug: string | null;
```

The market's URL name. `null` in a single market's feed.

***

### timestamp

```ts
timestamp: string;
```

When the fill was executed, as an ISO 8601 time.

***

### title

```ts
title: string | null;
```

The market's question. `null` in a single market's feed.

***

### transactionHash

```ts
transactionHash: Hex | null;
```

The settlement transaction. `null` when XO has none for the fill.

***

### userId

```ts
userId: string | null;
```

XO's id for the trader. `null` when the fill names none.

***

### username

```ts
username: string | null;
```

The trader's username.
