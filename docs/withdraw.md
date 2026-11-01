# Withdraw

USDC leaves your trading wallet, and the bridge delivers the token you pick to any address.

> [!WARNING]
> A wrong recipient can't be undone, and a withdrawal sends once. After an error with
> `mayHaveLanded: true`, check the transfer before you send anything.

## 1. Pick a token

<!-- snippet: docs/snippets/withdraw.ts#withdraw-asset -->
```ts
const { items } = await client
  .listBridgeAssets({ direction: 'withdraw' })
  .firstPage();
const usdc = items.find((a) => a.symbol === 'USDC' && a.chain === 'base');
if (usdc === undefined) {
  throw new Error('USDC on Base is not listed');
}
```

## 2. Get a quote

<!-- snippet: docs/snippets/withdraw.ts#withdraw-quote -->
```ts
const [quote] = await client.quoteWithdrawal({
  assetId: usdc.assetId,
  amount: '25', // USDC out of XO
  recipient,
});
if (quote === undefined) {
  throw new Error('No quote');
}
console.log(`${quote.output.amount} goes to ${quote.recipient}`);
```

The quote only checks that `recipient` is an address on that network. Check it yourself.

## 3. Withdraw

<!-- snippet: docs/snippets/withdraw.ts#withdraw-send -->
```ts
const { payment, transaction } = await client.withdraw({ quote });
const receipt = await transaction.wait();
console.log(`${payment.paymentId}: transfer ${receipt.status}`);
```

`withdraw` confirms the quote and sends the USDC once. XO pays the gas by default. A second call
for the same quote fails with `bridge_funding_claimed` and sends nothing. If the bridge asks your
wallet to sign, pass `verify` as for a [deposit](deposit.md#sign-when-the-bridge-asks).

If the transfer says `reverted`, the payment is not funded: send its `deposit.amount` to its
`deposit.address` yourself, once, before `fundBy`.

## 4. Wait for it

<!-- snippet: docs/snippets/withdraw.ts#withdraw-wait -->
```ts
const done = await client.waitForBridgePayment({
  paymentId: payment.paymentId,
});
console.log(`${done.paymentId}: ${done.status}`);
```

Only `COMPLETE` means it was delivered. The statuses are listed under
[Payment status](deposit.md#payment-status).

## When the outcome is unknown

If `withdraw` throws with `mayHaveLanded: true`, read the payment with
`fetchBridgePayment({ paymentId: error.paymentId })`. Then look the transfer up by the error's
`transactionHash`, or its `nonce` when there is no hash, as in
[Positions](positions.md#when-the-outcome-is-unknown). Send nothing until you know.

## Next steps

- [Deposit](deposit.md)
- [Read your balances](positions.md#read-your-balances)
