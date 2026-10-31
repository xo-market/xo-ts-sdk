# Type Alias: PulseMarket

```ts
type PulseMarket = object;
```

One round of a pulse market, which trades on the order book like any CLOB market.

## Properties

### closedAt

```ts
closedAt: string | null;
```

When the round closed, as an ISO 8601 time. `null` until it does.

***

### closingPrice

```ts
closingPrice: DecimalString | null;
```

The reference price at the end of the round. `null` until it is known.

***

### conditionId

```ts
conditionId: ConditionId;
```

The round's id on the order book.

***

### cycle

```ts
cycle: number;
```

The round's number within its pulse market.

***

### endDate

```ts
endDate: string;
```

When the round ends, as an ISO 8601 time.

***

### id

```ts
id: string;
```

XO's id for the round.

***

### metadata

```ts
metadata: Record<string, unknown>;
```

Extra data XO keeps on the pulse market, such as the asset's symbol.

***

### name

```ts
name: string;
```

The name of the pulse market the round belongs to, such as `BTC 5 min`.

***

### observationEndDate

```ts
observationEndDate: string;
```

When the window in which XO samples the price closes, as an ISO 8601 time.

***

### observationStartDate

```ts
observationStartDate: string;
```

When the window in which XO samples the price opens, as an ISO 8601 time.

***

### openingPrice

```ts
openingPrice: DecimalString | null;
```

The reference price at the start of the round. `null` until it is known.

***

### resolvedAt

```ts
resolvedAt: string | null;
```

When the round resolved, as an ISO 8601 time. `null` until it does.

***

### sampleCount

```ts
sampleCount: number;
```

How many price samples XO has taken in the round so far.

***

### startDate

```ts
startDate: string;
```

When the round starts, as an ISO 8601 time.

***

### status

```ts
status: PulseStatus;
```

Where the round is.

***

### winningOutcome

```ts
winningOutcome: "yes" | "no" | null;
```

The side that won, once the round has resolved.
