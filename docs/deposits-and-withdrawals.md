# Deposits and withdrawals

A secure client moves USDC into XO from another network and back out, through XO's bridge. A
bridge payment is a deposit or a withdrawal, and every step reads the same way: ask for a quote,
confirm it, then follow the payment.

> [!WARNING]
> Mainnet is real money. Send exactly `deposit.amount` of `deposit.assetId`, once, to
> `deposit.address`. If `waitForBridgePayment` times out, the payment goes on: never send again.
> When an error has `mayHaveLanded: true`, never retry. Read the payment with
> `fetchBridgePayment({ paymentId: error.paymentId })` first.

## Deposit

A deposit pays in a token on another network and lands as USDC at your trading address.

## 1. Pick the asset

`listBridgeAssets({ direction: 'deposit' })` lists the tokens a deposit can be paid in. Each has an
`assetId`, which you pass to the quote.

<!-- snippet: docs/snippets/deposits-and-withdrawals.ts#deposit-asset -->
```ts
const { items } = await client
  .listBridgeAssets({ direction: 'deposit' })
  .firstPage();
const usdc = items.find((a) => a.symbol === 'USDC' && a.chain === 'base');
if (usdc === undefined) {
  throw new Error('USDC on Base is not on the deposit list');
}
```

## 2. Get a quote

Quotes are free and move nothing. Amounts are decimal strings in whole units, so `'25'` is 25 USDC.
`quoteDeposit` returns the ways to deposit, and the first pays out the most.

<!-- snippet: docs/snippets/deposits-and-withdrawals.ts#deposit-quote -->
```ts
const [quote] = await client.quoteDeposit({
  assetId: usdc.assetId,
  amount: '25',
});
if (quote === undefined) {
  throw new Error('No quote');
}
console.log(
  `${quote.input.amount} in, ${quote.output.amount} USDC out, fees ${quote.fees.total} ${quote.fees.currency}, confirm before ${quote.acceptBy}`,
);
```

A quote carries no minimum or maximum. An amount the bridge does not take fails with
`amount_out_of_range`, and the message names the bounds. A quote is a read, so the SDK retries it
like one.

## 3. Confirm it

Confirm before `acceptBy`, or ask for a new quote. The payment comes back with `deposit`: a
one-time address and the exact amount to send.

<!-- snippet: docs/snippets/deposits-and-withdrawals.ts#deposit-confirm -->
```ts
const payment = await client.createDeposit({ quote });
if (payment.status !== 'AWAITING_FUNDS' || payment.deposit === null) {
  throw new Error(`${payment.paymentId} is ${payment.status}: send nothing`);
}
console.log(
  `Send ${payment.deposit.amount} of ${payment.deposit.assetId} to ${payment.deposit.address} before ${payment.fundBy}`,
);
```

When the bridge wants the owner wallet's signature, `createDeposit` fails with
`verification_required` and the payment waits: see [Sign for larger payments](#sign-for-larger-payments).
A payment in `CONFIRM_UNKNOWN` has no `deposit` yet. Read it again with `fetchBridgePayment`
before you send anything.

## 4. Send the funds

The SDK does not send deposits. From any wallet that holds the funds, send exactly
`deposit.amount` of the asset on `deposit.chain` to `deposit.address`, once, before
`payment.fundBy`.

## 5. Wait

A final payment is not always a success, so check `status`.

<!-- snippet: docs/snippets/deposits-and-withdrawals.ts#deposit-wait -->
```ts
const done = await client.waitForBridgePayment(
  { paymentId },
  { timeout: 30 * 60_000 },
);
console.log(`The deposit is ${done.status}: only COMPLETE delivered`);
```

## Withdraw

A withdrawal sends USDC from your trading address to an address you name on another network. The
SDK sends the USDC itself, and XO's sponsor pays the gas.

## 1. Get a quote

<!-- snippet: docs/snippets/deposits-and-withdrawals.ts#withdraw-quote -->
```ts
const { items } = await client
  .listBridgeAssets({ direction: 'withdraw' })
  .firstPage();
const usdc = items.find((a) => a.symbol === 'USDC' && a.chain === 'base');
if (usdc === undefined) {
  throw new Error('USDC on Base is not on the withdraw list');
}
const [quote] = await client.quoteWithdrawal({
  assetId: usdc.assetId,
  amount: '25',
  recipient,
});
if (quote === undefined) {
  throw new Error('No quote');
}
console.log(
  `${quote.input.amount} USDC out, ${quote.output.amount} to ${quote.recipient}`,
);
```

`quoteWithdrawal` only checks that `recipient` is well formed for the asset's network. A valid
address that is wrong is final, so show it to whoever approves the withdrawal.

## 2. Withdraw

`withdraw({ quote })` confirms the quote and sends one USDC transfer, at most once. It needs a
signer that signs raw digests, such as `privateKey` or `signerFrom` with a local account.

<!-- snippet: docs/snippets/deposits-and-withdrawals.ts#withdraw-send -->
```ts
const { payment, transaction } = await client.withdraw({ quote });
console.log(
  `Payment ${payment.paymentId}: transfer in transaction ${transaction.transactionHash}`,
);
```

Everything that can be checked is checked before the funding is claimed, the balance included, and
a failure there sends nothing. Money moves once: calling `withdraw` again for the same quote after
the claim fails with `bridge_funding_claimed` and sends nothing.

If `transaction.wait()` says `reverted`, the transfer did not fund the payment and the funding
claim is used. Send the payment's `deposit.amount` to its `deposit.address` yourself, once, before
`fundBy`, then follow the payment.

## 3. Wait

Follow the payment as for a deposit, with `waitForBridgePayment({ paymentId })`.

## Sign for larger payments

The bridge may ask the owner wallet to sign before a payment goes on, usually from about $300 for a
wallet new to it. The payment is then `NEEDS_VERIFICATION`.

Pass a `verify` callback to `createDeposit` or `withdraw`. The SDK shows it each item the owner
wallet is asked to sign, after its own checks and before anything is signed. Only `true` approves;
anything else, or a throw, signs nothing. The SDK always refuses payloads that could sign in to XO
or move funds.

<!-- snippet: docs/snippets/deposits-and-withdrawals.ts#bridge-verify -->
```ts
const verify: VerifyCallback = async (request) => {
  const { decoded } = request;
  const what =
    decoded.kind === 'eip712'
      ? `typed data ${decoded.typedData.primaryType}, domain ${JSON.stringify(decoded.typedData.domain)}, message ${JSON.stringify(decoded.typedData.message)}`
      : `message ${JSON.stringify(decoded.message)}`;
  return approve(`Payment ${request.paymentId} (${request.reason}): ${what}`);
};
const payment = await client.createDeposit({ quote, verify });
```

If `createDeposit` failed with `verification_required` (no callback, or it answered no), the
payment still waits: `verifyBridgePayment({ paymentId: error.paymentId, verify })` finishes it. A
payment in any other status is returned as it is, so calling it again is safe.

The signer must be the owner EOA: your trading wallet, or the EOA that owns your smart wallet.

## Follow a payment

`fetchBridgePayment` reads a payment, and `waitForBridgePayment` waits until it is final, reading
it every 10 seconds. It takes a `signal` and a `timeout` for the whole wait (an hour by default),
and no retries. `listBridgePayments({ direction, status })` lists your payments, newest first.

<!-- snippet: docs/snippets/deposits-and-withdrawals.ts#bridge-follow -->
```ts
try {
  await client.waitForBridgePayment({ paymentId }, { timeout: 30 * 60_000 });
} catch (error) {
  if (!(error instanceof XoError && error.code === 'bridge_wait_timeout')) {
    throw error;
  }
}
const payment = await client.fetchBridgePayment({ paymentId });
console.log(`${payment.paymentId}: ${payment.status}`);

const { items } = await client
  .listBridgePayments({ direction: 'withdraw' })
  .firstPage();
console.table(items.map((p) => ({ id: p.paymentId, status: p.status })));
```

| Status | Meaning |
| --- | --- |
| `CONFIRM_UNKNOWN` | The confirm's outcome is not known yet. Read it again, and send nothing. |
| `NEEDS_VERIFICATION` | Waiting for the owner's signature. |
| `AWAITING_FUNDS` | Confirmed, not funded yet. |
| `PROCESSING` | The bridge has the funds and is delivering. |
| `COMPLETE` | Delivered. Final. |
| `HALTED` | Stopped, but it may still finish. `recoveryUrl` is the bridge's recovery page. |
| `EXPIRED` | Not funded or verified in time. Final. |
| `TAINTED` | The bridge will not complete it. Final. Report the `paymentId` to gm@xo.market. |

Every method is in the [API reference](reference/client/interfaces/SecureClient.md), and every
error code in [Errors](errors.md).
