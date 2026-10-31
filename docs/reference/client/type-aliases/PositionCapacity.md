# Type Alias: PositionCapacity

```ts
type PositionCapacity = object;
```

What an account can still commit of one outcome's shares.

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

The shares the account holds, settled.

***

### free

```ts
free: DecimalString;
```

The shares a new sell order may use.

***

### outcome

```ts
outcome: "YES" | "NO" | string & object;
```

The outcome, `YES` or `NO`.

***

### pendingSettlement

```ts
pendingSettlement: DecimalString;
```

The shares matched in a trade that has not settled yet.

***

### reserved

```ts
reserved: DecimalString;
```

The shares reserved by resting sell orders.
