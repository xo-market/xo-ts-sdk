# Type Alias: BridgeWithdrawal

```ts
type BridgeWithdrawal = object;
```

A withdrawal that was made: the payment as XO answered once its funding was claimed, and the
USDC transfer that funded it, mined. Follow the payment with `waitForBridgePayment`.

A `transaction` whose `wait()` says `reverted` did not fund the payment, and the funding claim
is used: send the payment's `deposit.amount` to its `deposit.address` yourself (once, before
`fundBy`), then follow it.

## Properties

### payment

```ts
payment: BridgePayment;
```

The payment, with its `fundingClaimedAt` set.

***

### transaction

```ts
transaction: TransactionHandle;
```

The USDC transfer from the trading wallet to the payment's deposit address.
