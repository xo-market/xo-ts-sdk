# Type Alias: UserTradeEvent

```ts
type UserTradeEvent = object;
```

`trade`: a fill the account took part in, then each step of its settlement. The first event
of a trade (`status: 'MATCHED'`) describes the fill; the later ones carry its id, market and
new status only, so their other fields are `null`.

## Properties

### assetId

```ts
assetId: TokenId | null;
```

The outcome token the taker traded. Given for `MATCHED`.

***

### feeRateBps

```ts
feeRateBps: DecimalString | null;
```

The fee rate of the fill, in basis points. Given for `MATCHED`.

***

### id

```ts
id: string;
```

The trade's id.

***

### makerAddress

```ts
makerAddress: Address | null;
```

The address of the maker. Given for `MATCHED`.

***

### makerOrderId

```ts
makerOrderId: string | null;
```

The id of the resting order it filled. Given for `MATCHED`.

***

### market

```ts
market: ConditionId;
```

The id of the market.

***

### matchType

```ts
matchType: "COMPLEMENTARY" | "MINT" | "MERGE" | string & object | null;
```

How the two orders met: `COMPLEMENTARY` (a buy and a sell of one token), `MINT` (two buys of
opposite tokens) or `MERGE` (two sells of opposite tokens). Given for `MATCHED`.

***

### outcome

```ts
outcome: "YES" | "NO" | string & object | null;
```

The outcome the taker traded, `YES` or `NO`. Given for `MATCHED`.

***

### price

```ts
price: DecimalString | null;
```

The taker's effective price, in dollars between 0 and 1. Given for `MATCHED`.

***

### side

```ts
side: OrderSide | null;
```

The taker's side. Given for `MATCHED`.

***

### size

```ts
size: DecimalString | null;
```

The shares that changed hands. Given for `MATCHED`.

***

### status

```ts
status: TradeStatus;
```

Where the trade is in its settlement. `FAILED` means the fill was undone.

***

### takerOrderId

```ts
takerOrderId: string | null;
```

The id of the order that took the liquidity. Given for `MATCHED`.

***

### timestamp

```ts
timestamp: number;
```

When it happened, in Unix milliseconds.

***

### topic

```ts
topic: "user";
```

`'user'`.

***

### traderSide

```ts
traderSide: TraderSide | null;
```

Whether the account was the maker or the taker. Given for `MATCHED`.

***

### type

```ts
type: "trade";
```

`'trade'`.
