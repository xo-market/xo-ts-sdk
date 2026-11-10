# Type Alias: FetchSmartWalletAddressRequest

```ts
type FetchSmartWalletAddressRequest = object;
```

What [PublicClient.fetchSmartWalletAddress](../interfaces/PublicClient.md#fetchsmartwalletaddress) takes.

## Properties

### index?

```ts
index?: number;
```

Which of the owner's smart wallets: a whole number from 0. Defaults to 0, the first.

***

### owner

```ts
owner: string;
```

The address of the key that owns the smart wallet: a signer's own address, `0x` and 40 hex digits.
