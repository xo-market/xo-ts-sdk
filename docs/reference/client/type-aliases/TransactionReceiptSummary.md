# Type Alias: TransactionReceiptSummary

```ts
type TransactionReceiptSummary = object;
```

How a mined transaction ended. A revert is a result, not an error: check `status`.

## Properties

### blockNumber

```ts
blockNumber: bigint;
```

The block the transaction was mined in.

***

### status

```ts
status: "success" | "reverted";
```

`success`, or `reverted` when the chain mined it and undid its effects.

***

### transactionHash

```ts
transactionHash: Hex;
```

The transaction's hash.
