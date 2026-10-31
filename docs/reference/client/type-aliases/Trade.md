# Type Alias: Trade

```ts
type Trade = object;
```

A trade of the account: one fill, seen from the account's side (see
[Trade.traderSide](#traderside)). `side`, `outcome` and `price` describe the order that took the
liquidity.

## Properties

### assetId

```ts
assetId: TokenId;
```

The outcome token that traded.

***

### feeRateBps

```ts
feeRateBps: DecimalString;
```

The fee rate of the trade, in basis points.

***

### id

```ts
id: string;
```

The trade's id.

***

### makerAddress

```ts
makerAddress: Address;
```

The address of the maker.

***

### makerOrders

```ts
makerOrders: MakerOrder[];
```

The resting orders the trade filled: one on XO.

***

### market

```ts
market: ConditionId;
```

The id of the market the token belongs to.

***

### matchedAt

```ts
matchedAt: string;
```

When the trade was matched, as an ISO 8601 time.

***

### outcome

```ts
outcome: "YES" | "NO" | string & object;
```

The outcome the taker traded, `YES` or `NO`.

***

### price

```ts
price: DecimalString;
```

The taker's effective price in dollars between 0 and 1.

***

### side

```ts
side: OrderSide;
```

The taker's side.

***

### size

```ts
size: DecimalString;
```

The shares that changed hands.

***

### status

```ts
status: TradeStatus;
```

Where the trade is in its settlement.

***

### takerOrderId

```ts
takerOrderId: string;
```

The id of the order that took the liquidity.

***

### traderSide

```ts
traderSide: TraderSide;
```

Whether the account was the maker or the taker of this trade.

***

### transactionHash

```ts
transactionHash: Hex | null;
```

The settlement transaction. `null` until there is one.

***

### updatedAt

```ts
updatedAt: string;
```

When the trade last changed status, as an ISO 8601 time.
