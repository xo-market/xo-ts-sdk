# Interface: ResolvedMarket

A market joined across the backend and the orderbook.

## Properties

### active

```ts
active: boolean;
```

The orderbook's own status: whether it takes orders. This is **not** a tradability verdict
(expired and unregistered markets are reported active upstream); use `tradable`.

***

### conditionId

```ts
conditionId: ConditionId;
```

The CTF condition id, in lower case.

***

### marketId

```ts
marketId: number;
```

The backend's database id.

***

### noTokenId

```ts
noTokenId: TokenId;
```

The orderbook token of the NO outcome (a decimal string).

***

### rewards?

```ts
optional rewards?: RewardsMarketConfig;
```

The liquidity-rewards programmes of the market. Left out when the market has none (the
backend answers 404 for a market that is not enrolled).

***

### slug

```ts
slug: string;
```

***

### tickSize

```ts
tickSize: string;
```

The market's minimum tick size, such as `"0.001"`.

***

### tradable

```ts
tradable: Tradable;
```

***

### yesTokenId

```ts
yesTokenId: TokenId;
```

The orderbook token of the YES outcome (a decimal string).
