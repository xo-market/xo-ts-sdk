# Type Alias: RewardBonus

```ts
type RewardBonus = object;
```

An extra reward pool that is paid on top of a programme for a set time.

## Properties

### allocationMethod

```ts
allocationMethod: string;
```

How the pool is shared out, such as `pro_rata`.

***

### amount

```ts
amount: DecimalString;
```

The whole window's pool, in `currency`.

***

### currency

```ts
currency: RewardCurrency;
```

What the bonus pays in.

***

### endsAt

```ts
endsAt: string;
```

When the window ends, as an ISO 8601 time.

***

### kind

```ts
kind: "IN_GAME" | "EVENT" | "AD_HOC" | string & object | null;
```

`IN_GAME`, `EVENT` or `AD_HOC`. A kind added later reads as its own string.

***

### label

```ts
label: string | null;
```

A name for the window.

***

### remaining

```ts
remaining: DecimalString;
```

What is still on offer, in `currency`. Zero once the window ended.

***

### startsAt

```ts
startsAt: string;
```

When the window starts, as an ISO 8601 time.

***

### status

```ts
status: RewardProgrammeStatus;
```

Whether the window is `LIVE`, `SCHEDULED` or `ENDED`.

***

### stoppedAt

```ts
stoppedAt: string | null;
```

When the window was stopped early, as an ISO 8601 time. `null` when it was not.

***

### todayPool

```ts
todayPool: DecimalString;
```

The part of the pool offered in the current UTC day, in `currency`.

***

### windowId

```ts
windowId: string;
```

XO's id for the bonus window.
