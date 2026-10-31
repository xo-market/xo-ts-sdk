# Interface: TransactionHandle

A transaction that was sent and mined. A call that sends one returns its handle once the
chain has mined it (it waits for the receipt, up to two minutes), so `wait` resolves at once
with how the transaction ended. When the receipt does not come in time, or cannot be read,
the call throws a `TransactionFailedError` with `mayHaveLanded: true` and the
`transactionHash` instead: never send again before you have looked that hash up.

## Properties

### transactionHash

```ts
readonly transactionHash: `0x${string}`;
```

The transaction's hash. Keep it: it is how you look the transaction up if you lose the handle.

## Methods

### wait()

```ts
wait(): Promise<TransactionReceiptSummary>;
```

Resolves with how the transaction ended: `status: 'success'`, or `'reverted'` when the chain
mined it and undid its effects. A revert is a result, not an error. It never rejects.

#### Returns

`Promise`\<[`TransactionReceiptSummary`](../type-aliases/TransactionReceiptSummary.md)\>
