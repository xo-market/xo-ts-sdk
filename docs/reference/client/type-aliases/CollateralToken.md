# Type Alias: CollateralToken

```ts
type CollateralToken = object;
```

A token that markets are paid in, such as USDC.

## Properties

### active

```ts
active: boolean;
```

Whether markets can be paid in the token.

***

### address

```ts
address: Address;
```

The token's contract address.

***

### decimals

```ts
decimals: number;
```

How many decimals the token has: an amount in its smallest unit has this many digits after the point.

***

### description

```ts
description: string | null;
```

What the token is.

***

### id

```ts
id: string;
```

XO's id for the token.

***

### image

```ts
image: string | null;
```

The token's logo. `null` when XO has none.

***

### name

```ts
name: string;
```

The token's name.

***

### symbol

```ts
symbol: string;
```

The token's symbol, such as `USDC`.
