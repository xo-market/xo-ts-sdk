# Type Alias: PositionBalance

```ts
type PositionBalance = object;
```

The shares of one outcome token the order book credits to the account.

## Properties

### assetId

```ts
assetId: TokenId;
```

The outcome token.

***

### balance

```ts
balance: DecimalString;
```

The shares the account holds.

***

### reserved

```ts
reserved: DecimalString;
```

Of those, the shares reserved by resting sell orders.
