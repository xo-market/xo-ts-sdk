# Type Alias: Market

```ts
type Market = object;
```

A CLOB market with two outcomes: what it asks, its outcome tokens, its state, rules and
rewards.

A market in a listing has only what the listing carries; the fields that need the order
book, the fee policy or the rewards programme are `null` there. Fetching the market joins
them all.

## Properties

### category

```ts
category: string | null;
```

The market's category, such as `Sports`.

***

### conditionId

```ts
conditionId: ConditionId | null;
```

The market's id on the order book, or `null` when XO gave none.

***

### description

```ts
description: string | null;
```

The market's rules and background.

***

### events

```ts
events: MarketEvent[];
```

The event the market is placed on: empty when it stands alone.

***

### groupItemTitle

```ts
groupItemTitle: string | null;
```

The market's label within its event, such as a team or candidate name. `null` when the
market is not shown inside an event.

***

### id

```ts
id: string;
```

XO's id for the market.

***

### image

```ts
image: string | null;
```

The market's picture.

***

### metrics

```ts
metrics: MarketMetrics;
```

How much has traded.

***

### outcomes

```ts
outcomes: MarketOutcomes;
```

The two outcomes and their prices.

***

### question

```ts
question: string;
```

What the market asks.

***

### resolution

```ts
resolution: MarketResolution;
```

How the market resolves and what it resolved to.

***

### rewards

```ts
rewards: MarketRewards;
```

The liquidity rewards.

***

### slug

```ts
slug: string;
```

The market's URL name.

***

### state

```ts
state: MarketState;
```

Whether the market is open and takes orders.

***

### tags

```ts
tags: MarketTag[];
```

The market's tags.

***

### trading

```ts
trading: MarketTrading;
```

Tick size, order size and fees.
