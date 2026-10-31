# Type Alias: PositionPnl

```ts
type PositionPnl = object;
```

The profit and loss of one position.

## Properties

### avgPrice

```ts
avgPrice: DecimalString;
```

The average price paid per share, in dollars between 0 and 1.

***

### calculatedAt

```ts
calculatedAt: string;
```

When XO calculated it, as an ISO 8601 time.

***

### currentValue

```ts
currentValue: DecimalString;
```

What the shares are worth now, in dollars.

***

### entryValue

```ts
entryValue: DecimalString;
```

What the shares cost at the average entry price, in dollars.

***

### marketId

```ts
marketId: string;
```

XO's id for the position's market.

***

### marketStatus

```ts
marketStatus: MarketStatus;
```

Where the market is in its life.

***

### marketTitle

```ts
marketTitle: string;
```

The market's question.

***

### outcome

```ts
outcome: string;
```

The outcome held, such as `Yes`.

***

### percentPnl

```ts
percentPnl: DecimalString;
```

The profit or loss, in percent.

***

### pnl

```ts
pnl: DecimalString;
```

The profit or loss: `currentValue - entryValue`, in dollars.

***

### positionId

```ts
positionId: string;
```

XO's id for the position (the `positionId` of a [Position](Position.md)).

***

### redeemableAmount

```ts
redeemableAmount: DecimalString | null;
```

What a share redeems for in a closed market, in dollars. `null` when it does not apply.

***

### shares

```ts
shares: DecimalString;
```

The shares held.

***

### status

```ts
status: PositionStatus;
```

`OPEN` while the shares are held, `CLOSED` once the position is over.
