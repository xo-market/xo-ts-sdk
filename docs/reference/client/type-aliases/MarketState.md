# Type Alias: MarketState

```ts
type MarketState = object;
```

Whether a market takes orders and where it is in its life.

## Properties

### acceptingOrders

```ts
acceptingOrders: boolean | null;
```

Whether the order book takes orders now. `null` until the order book is read.

***

### active

```ts
active: boolean;
```

The market is open for trading: its status is `ACTIVE`.

***

### closed

```ts
closed: boolean;
```

The market has ended: its status is `CLOSED`, `RESOLVED`, `VOIDED` or `VOIDED_CLOSED`.

***

### endDate

```ts
endDate: string | null;
```

When trading ends, as an ISO 8601 time.

***

### startDate

```ts
startDate: string | null;
```

When trading opens, as an ISO 8601 time.

***

### status

```ts
status: MarketStatus;
```

XO's own status. A market that has passed `endDate` can still read `ACTIVE` until XO closes it.
