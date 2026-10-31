# Type Alias: QuoteDepositRequest

```ts
type QuoteDepositRequest = object;
```

What [SecureClient.quoteDeposit](../interfaces/SecureClient.md#quotedeposit) takes.

## Properties

### amount

```ts
amount: string | number;
```

How much of it, in whole units: a decimal string above 0, or a number.

***

### assetId

```ts
assetId: string;
```

What to pay in: the `assetId` of a deposit asset, such as `base:0x8335…2913`.
