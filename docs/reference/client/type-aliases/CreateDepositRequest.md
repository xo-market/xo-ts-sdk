# Type Alias: CreateDepositRequest

```ts
type CreateDepositRequest = object;
```

What [SecureClient.createDeposit](../interfaces/SecureClient.md#createdeposit) takes.

## Properties

### quote

```ts
quote: DepositQuote;
```

One of the quotes `quoteDeposit` gave.

***

### verify?

```ts
optional verify?: VerifyCallback;
```

Approves each thing the owner wallet is asked to sign, when the bridge asks for it: answer
`true` to approve. Without it, a deposit that asks fails with `verification_required`.
