# Type Alias: WithdrawRequest

```ts
type WithdrawRequest = object;
```

What [SecureClient.withdraw](../interfaces/SecureClient.md#withdraw) takes.

## Properties

### quote

```ts
quote: WithdrawalQuote;
```

One of the quotes `quoteWithdrawal` gave. Its amount is the most that is sent.

***

### verify?

```ts
verify?: VerifyCallback;
```

Approves each thing the owner wallet is asked to sign, when the bridge asks for it, as for
`createDeposit`.
