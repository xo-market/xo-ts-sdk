# Type Alias: RewardPoolMarket

```ts
type RewardPoolMarket = object;
```

The market a reward pool is for. A field XO does not have is `null`.

## Properties

### category

```ts
category: string | null;
```

The market's category, such as `SPORTS`.

***

### endDate

```ts
endDate: string | null;
```

When the market ends, as an ISO 8601 time.

***

### id

```ts
id: string | null;
```

XO's id for the market (the `id` of a `Market`).

***

### image

```ts
image: string | null;
```

The market's picture.

***

### prices

```ts
prices: 
  | {
  no: DecimalString;
  yes: DecimalString;
}
  | null;
```

The midpoint prices of the two outcomes, in dollars between 0 and 1. `null` before the order book has them.

***

### slug

```ts
slug: string | null;
```

The market's URL name.

***

### status

```ts
status: string | null;
```

Where the market is in its life, such as `ACTIVE`.

***

### title

```ts
title: string | null;
```

The market's question.
