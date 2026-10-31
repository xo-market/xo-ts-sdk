# Type Alias: CreateLimitOrderRequest

```ts
type CreateLimitOrderRequest = object;
```

What [SecureClient.createLimitOrder](../interfaces/SecureClient.md#createlimitorder) and [SecureClient.placeLimitOrder](../interfaces/SecureClient.md#placelimitorder) take.

## Properties

### assetId

```ts
assetId: string;
```

The outcome token to trade: `outcomes.yes.tokenId` or `outcomes.no.tokenId` of a market.

***

### expiration?

```ts
optional expiration?: Date | number;
```

When the order expires, which makes it a good-till-date order: a `Date`, or unix seconds
(milliseconds are refused). At least a second after XO's clock. Without it, the order is
good till cancelled.

***

### postOnly?

```ts
optional postOnly?: boolean;
```

Refuse the order rather than let it trade at once, so it only ever rests on the book.
Defaults to `false`.

***

### price

```ts
price: number | string;
```

The price per share in dollars, from 0.001 to 0.999, a multiple of the market's tick size.
Nothing is rounded.

***

### side

```ts
side: OrderSide;
```

Whether the order buys or sells shares: `OrderSide.BUY` or `OrderSide.SELL`.

***

### size

```ts
size: number | string;
```

How many shares: at least 1, with at most 6 decimals.
