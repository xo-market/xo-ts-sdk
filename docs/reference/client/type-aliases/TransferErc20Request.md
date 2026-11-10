# Type Alias: TransferErc20Request

```ts
type TransferErc20Request = object;
```

What [SecureClient.transferErc20](../interfaces/SecureClient.md#transfererc20) takes.

## Properties

### amount

```ts
amount: string | number;
```

How much to send, in whole units of the token (`'5'` is 5 USDC), above 0 and with at most
as many decimals as the token has.

***

### to

```ts
to: string;
```

Who receives the tokens: an address. It may be neither the zero address nor the token.

***

### token?

```ts
token?: string;
```

The token's contract address. Leave it out for XO's USDC, the money of the markets.
