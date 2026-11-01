# Deposits and withdrawals

> [!WARNING]
> This is real money. Send a deposit's funds once. After a timeout or an error with
> `mayHaveLanded: true`, never send again until you have read the payment with
> `fetchBridgePayment({ paymentId })`.

## Pick a token to deposit

<!-- snippet: docs/snippets/deposits-and-withdrawals.ts#deposit-asset -->
```ts
const { items } = await client
  .listBridgeAssets({ direction: 'deposit' })
  .firstPage();
const usdc = items.find((a) => a.symbol === 'USDC' && a.chain === 'base');
if (usdc === undefined) {
  throw new Error('USDC on Base is not listed');
}
```

Whatever you pay in lands as USDC at your trading address.

## Get a quote

<!-- snippet: docs/snippets/deposits-and-withdrawals.ts#deposit-quote -->
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

A quote is free and moves nothing. The first one lands the most. An amount the bridge does not take
fails with `amount_out_of_range`, and the message gives the limits.

## Confirm the deposit

<!-- snippet: docs/snippets/deposits-and-withdrawals.ts#deposit-confirm -->
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

Confirm before the quote's `acceptBy`, or get a new quote. The payment's `deposit` says where to
send the funds: a one-time address and the amount.

## Send the funds

The SDK does not send deposits. From any wallet, send `deposit.amount` of the token on
`deposit.chain` to `deposit.address`, once.

Send it before `payment.fundBy`. After that, the payment expires.

## Wait for the deposit

<!-- snippet: docs/snippets/deposits-and-withdrawals.ts#deposit-wait -->
```ts
const done = await client.waitForBridgePayment({ paymentId });
console.log(`${paymentId}: ${done.status}`);
```

`waitForBridgePayment` waits for the payment to be final, an hour at most by default. Only
`COMPLETE` means the USDC arrived.

If the wait times out, the payment goes on. Don't send again.

## Withdraw

Pick the token to receive with `listBridgeAssets({ direction: 'withdraw' })`, then get a quote.

<!-- snippet: docs/snippets/deposits-and-withdrawals.ts#withdraw-quote -->
```ts
const [quote] = await client.quoteWithdrawal({
  assetId: usdc.assetId,
  amount: '25',
  recipient,
});
if (quote === undefined) {
  throw new Error('No quote');
}
console.log(`${quote.output.amount} goes to ${quote.recipient}`);
```

The quote only checks that `recipient` is an address on that network. A wrong address can't be
undone, so check it before you withdraw.

<!-- snippet: docs/snippets/deposits-and-withdrawals.ts#withdraw-send -->
```ts
const { payment, transaction } = await client.withdraw({ quote });
console.log(`${payment.paymentId}: sent in ${transaction.transactionHash}`);
```

`withdraw` confirms the quote and sends the USDC from your trading address, once. XO pays the gas by
default. Your signer must be able to sign a raw digest, as `privateKey` does. Calling it again for
the same quote fails with `bridge_funding_claimed` and sends nothing. Then wait for the payment as
for a deposit.

If it throws with `mayHaveLanded: true`, also look the transfer up by its `transactionHash` or
`nonce`. If `transaction.wait()` says `reverted`, the payment is not funded: send its
`deposit.amount` to its `deposit.address` yourself, once, before `fundBy`.

## Sign when the bridge asks

<!-- snippet: docs/snippets/deposits-and-withdrawals.ts#bridge-verify -->
```ts
const verify: VerifyCallback = (request) => {
  console.log(`${request.paymentId} asks you to sign:`, request.decoded);
  return approve(request);
};

const payment = await client.createDeposit({ quote, verify });
```

The bridge may ask your owner wallet to sign before a payment goes on. Pass a `verify` callback to
`createDeposit` or `withdraw`. Nothing is signed unless it returns `true` for every item. The SDK
itself refuses anything that could sign in to XO or move funds.

Without a callback, or when it says no, the call fails with `verification_required` and the
payment waits. Finish it with `verifyBridgePayment({ paymentId: error.paymentId, verify })`.

## Follow a payment

<!-- snippet: docs/snippets/deposits-and-withdrawals.ts#bridge-follow -->
```ts
const payment = await client.fetchBridgePayment({ paymentId });
console.log(`${payment.paymentId}: ${payment.status}`);

const { items } = await client.listBridgePayments().firstPage();

for (const p of items) {
  console.log(`${p.direction} ${p.paymentId}: ${p.status}`);
}
```

`listBridgePayments` lists your deposits and withdrawals, newest first. `COMPLETE`, `EXPIRED` and
`TAINTED` are final.

| Status | Meaning |
| --- | --- |
| `CONFIRM_UNKNOWN` | The confirm's outcome is unknown. Read it again, and send nothing. |
| `NEEDS_VERIFICATION` | Waiting for the owner wallet to sign. |
| `AWAITING_FUNDS` | Waiting for the funds. |
| `PROCESSING` | The bridge is delivering. |
| `COMPLETE` | Delivered. |
| `HALTED` | Stopped, but it may still finish. See `recoveryUrl`. |
| `EXPIRED` | Not funded in time. |
| `TAINTED` | The bridge will not complete it. Report the `paymentId` to gm@xo.market. |

## Next steps

- [Set up trading](onchain.md#set-up-the-account)
- [Read your balances](portfolio.md#read-balances)
- [Every error code](errors.md)
