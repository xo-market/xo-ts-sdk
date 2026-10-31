# Type Alias: Position

```ts
type Position = object;
```

What the account holds in one outcome of one market, with its value and profit.

`positionId` and `marketId` are XO's own ids, for reads that take them (`fetchUserPnl`).
A field XO has no value for is `null`.

## Properties

### assetId

```ts
assetId: TokenId | null;
```

The outcome token held, or `null` when XO gave none.

***

### avgPrice

```ts
avgPrice: DecimalString | null;
```

The average price paid per share, in dollars between 0 and 1. `null` when XO gave none.

***

### conditionId

```ts
conditionId: ConditionId | null;
```

The market's id on the order book, or `null` when XO gave none.

***

### currentPrice

```ts
currentPrice: DecimalString | null;
```

The outcome's current price, in dollars between 0 and 1. `null` when XO gave none.

***

### currentSize

```ts
currentSize: DecimalString;
```

The shares held.

***

### currentValue

```ts
currentValue: DecimalString;
```

What the shares are worth now, in dollars.

***

### endDate

```ts
endDate: string | null;
```

When the market ends, as an ISO 8601 time.

***

### entryCostUsdc

```ts
entryCostUsdc: DecimalString;
```

What the shares cost at the average entry price, in dollars.

***

### eventId

```ts
eventId: string | null;
```

The id of the event the market is placed on. `null` when it stands alone.

***

### eventSlug

```ts
eventSlug: string | null;
```

The URL name of the event the market is placed on. `null` when it stands alone.

***

### firstEntryAt

```ts
firstEntryAt: string;
```

When the position was opened, as an ISO 8601 time.

***

### icon

```ts
icon: string | null;
```

The market's picture.

***

### lastEventAt

```ts
lastEventAt: string;
```

When the position last changed, as an ISO 8601 time.

***

### marketId

```ts
marketId: string;
```

XO's id for the position's market (the `id` of a `Market`).

***

### outcome

```ts
outcome: string | null;
```

The outcome held, such as `Yes`. `null` when XO gave none.

***

### outcomeIndex

```ts
outcomeIndex: number | null;
```

The outcome's index in the market: 0 for the first, 1 for the second. `null` when XO gave none.

***

### percentPnl

```ts
percentPnl: DecimalString;
```

The profit or loss on the shares held, in percent.

***

### positionId

```ts
positionId: string;
```

XO's id for the position. Pass it as `positionId` to read the position's profit and loss.

***

### realizedPnl

```ts
realizedPnl: DecimalString | null;
```

The profit or loss already taken, in dollars (negative for a loss). `null` when XO gave none.

***

### redeemable

```ts
redeemable: boolean;
```

Whether the SDK can redeem the position now (`redeemPositions`, `redeemAllPositions`): its
market is `RESOLVED`, `VOIDED` or `VOIDED_CLOSED`, the winnings are not claimed, and it is a
market of the order book. A settled position of an older market type, which pays out on that
market's own contract, reads `status: 'REDEEMABLE'` and `redeemable: false`.

***

### slug

```ts
slug: string;
```

The market's URL name.

***

### status

```ts
status: PositionStatus;
```

Where the position is.

***

### title

```ts
title: string;
```

The market's question.

***

### unrealizedPnl

```ts
unrealizedPnl: DecimalString;
```

The profit or loss on the shares held: `currentValue - entryCostUsdc`, in dollars.

***

### wallet

```ts
wallet: Address;
```

The account's wallet address.
