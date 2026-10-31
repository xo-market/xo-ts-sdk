# Type Alias: QuoteWithdrawalRequest

```ts
type QuoteWithdrawalRequest = object;
```

What [SecureClient.quoteWithdrawal](../interfaces/SecureClient.md#quotewithdrawal) takes.

## Properties

### amount

```ts
amount: string | number;
```

How much USDC leaves the trading wallet, in whole units: a decimal string above 0, or a number.

***

### assetId

```ts
assetId: string;
```

What the recipient gets: the `assetId` of a withdrawal asset.

***

### recipient

```ts
recipient: string;
```

Who receives the asset, as its network writes addresses. A valid address that is wrong
cannot be undone: check it before you withdraw.
