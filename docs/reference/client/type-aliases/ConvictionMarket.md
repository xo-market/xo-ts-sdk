# Type Alias: ConvictionMarket

```ts
type ConvictionMarket = object;
```

A market with the metadata of a conviction market: who created it and what they committed.

## Properties

### active

```ts
active: boolean;
```

Whether the market is taking orders.

***

### commitment

```ts
commitment: ConvictionCommitment | null;
```

The creator's commitment. `null` for a market that is not a conviction market, or when the slot is empty.

***

### conditionId

```ts
conditionId: ConditionId;
```

The market's id on the order book.

***

### creator

```ts
creator: Address | null;
```

The wallet that created the market. `null` for a market that is not a conviction market.

***

### outcomes

```ts
outcomes: object;
```

The two outcomes.

#### no

```ts
no: ConvictionOutcome;
```

#### yes

```ts
yes: ConvictionOutcome;
```

***

### variant

```ts
variant: "clob" | "clob_pulse" | "conviction" | string & object;
```

The kind of market: `clob`, `clob_pulse` or `conviction`. A kind added later reads as its own string.
