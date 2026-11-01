# Deposit

Whatever token you pay in lands as USDC in your trading wallet.

> [!WARNING]
> Send a deposit's funds once. After a timeout or an error with `mayHaveLanded: true`, read the
> payment with `fetchBridgePayment` before you send anything.

## 1. Pick a token

<!-- snippet: docs/snippets/deposit.ts#deposit-asset -->
```ts
const { items } = await client
  .listBridgeAssets({ direction: 'deposit' })
  .firstPage();
const usdc = items.find((a) => a.symbol === 'USDC' && a.chain === 'base');
if (usdc === undefined) {
  throw new Error('USDC on Base is not listed');
}
```

## 2. Get a quote

<!-- snippet: docs/snippets/deposit.ts#deposit-quote -->
```ts
const [quote] = await client.quoteDeposit({
  assetId: usdc.assetId,
  amount: '25',
});
if (quote === undefined) {
  throw new Error('No quote');
}
console.log(`${quote.output.amount} USDC lands, fees ${quote.fees.total}`);
```

A quote moves nothing; the first lands the most. An amount out of range fails with
`amount_out_of_range`, which names the limits.

## 3. Confirm the deposit

<!-- snippet: docs/snippets/deposit.ts#deposit-confirm -->
```ts
const payment = await client.createDeposit({ quote });
const { deposit } = payment;
if (payment.status !== 'AWAITING_FUNDS' || deposit === null) {
  throw new Error(`${payment.paymentId} is ${payment.status}: send nothing`);
}
console.log(
  `Send ${deposit.amount} to ${deposit.address} on ${deposit.chain} before ${payment.fundBy}`,
);
```

Confirm before the quote's `acceptBy`. The address is for this payment only.

## 4. Send the funds

The SDK does not send deposits. From any wallet, send `deposit.amount` to `deposit.address` on
`deposit.chain`, once, before `fundBy`. After that, the payment expires.

## 5. Wait for it

<!-- snippet: docs/snippets/deposit.ts#deposit-wait -->
```ts
const done = await client.waitForBridgePayment({ paymentId }); // up to an hour
console.log(`${paymentId}: ${done.status}`);
```

Only `COMPLETE` means the USDC arrived. A timed-out wait does not stop the payment.

## Payment status

Read a payment with `fetchBridgePayment({ paymentId })`, or list yours, newest first, with
`listBridgePayments()`.

| Status | Meaning |
| --- | --- |
| `CONFIRM_UNKNOWN` | Unknown if the confirm worked. Read it again; send nothing. |
| `NEEDS_VERIFICATION` | Waiting for your owner wallet to sign. |
| `AWAITING_FUNDS` | Waiting for the funds. |
| `PROCESSING` | Delivering. |
| `COMPLETE` | Delivered. Final. |
| `HALTED` | Stopped; may still finish. See `recoveryUrl`. |
| `EXPIRED` | Not funded in time. Final. |
| `TAINTED` | Will not complete. Final. Report the `paymentId` to gm@xo.market. |

## Sign when the bridge asks

<!-- snippet: docs/snippets/deposit.ts#bridge-verify -->
```ts
const verify: VerifyCallback = (request) => {
  console.log(`${request.paymentId} asks you to sign:`, request.decoded);
  return approve(request);
};

const payment = await client.createDeposit({ quote, verify });
```

Nothing is signed unless `verify` returns `true` for every item. Without it, the call fails with
`verification_required`. Finish with `verifyBridgePayment({ paymentId: error.paymentId, verify })`.

## Next steps

- [Withdraw](withdraw.md)
- [Read your balances](positions.md#read-your-balances)
