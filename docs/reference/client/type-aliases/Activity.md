# Type Alias: Activity

```ts
type Activity = object;
```

One row of the account's history: a trade, a redemption, a split, a merge, a transfer or a
refund, with the market and outcome it concerns. A field XO has no value for is `null`.

## Properties

### amount

```ts
amount: DecimalString;
```

The dollar value of the row: the notional of a trade, the payout of a redeem.

***

### conditionId

```ts
conditionId: ConditionId | null;
```

The market's id on the order book. `null` for a market that is not on the order book.

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

The market's picture.

***

### id

```ts
id: string;
```

XO's id for the row.

***

### marketId

```ts
marketId: string | null;
```

XO's id for the market (the `id` of a `Market`).

***

### netFee

```ts
netFee: DecimalString | null;
```

The net fee in dollars: negative when the account paid, positive when it earned. `null` when XO gave none.

***

### outcome

```ts
outcome: string | null;
```

The outcome the row concerns, such as `Yes`.

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

The price per share at execution, in dollars between 0 and 1. `null` when XO gave none.

***

### realizedPnl

```ts
realizedPnl: DecimalString;
```

The profit or loss the row realised, in dollars. Typically 0 on a buy.

***

### shares

```ts
shares: DecimalString;
```

The shares involved.

***

### side

```ts
side: OrderSide | null;
```

Whether a trade bought or sold. `null` for every other type.

***

### slug

```ts
slug: string | null;
```

The market's URL name.

***

### timestamp

```ts
timestamp: string;
```

When it happened, as an ISO 8601 time.

***

### title

```ts
title: string | null;
```

The market's question.

***

### transactionHash

```ts
transactionHash: Hex | null;
```

The settlement transaction. `null` when XO has none for the row.

***

### type

```ts
type: ActivityType;
```

What the row is.
