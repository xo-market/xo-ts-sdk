# Balances and on-chain

## Read balances

<!-- snippet: docs/snippets/portfolio.ts#balances -->
```ts
const balances = await client.fetchBalances();
console.log(`${client.wallet}: ${balances.collateral} USDC to trade with`);
console.table(balances.positions);
```

This is what the order book holds for you to trade with, not your wallet's USDC on chain.

## Set up the account

<!-- snippet: docs/snippets/onchain.ts#setup -->
```ts
const state = await client.fetchTradingApprovalsState();
console.log(
  state.ready ? 'Ready to trade' : 'Approvals missing: setting them up',
);

const transaction = await client.setupTradingApprovals();
console.log(
  transaction === null
    ? 'Already set up: nothing sent'
    : `Set up in transaction ${transaction.transactionHash}`,
);
```

`setupTradingApprovals` lets the exchange spend your USDC and move your shares. It sends only
what is missing, so call it at every start. XO pays the gas by default.

## Transfer USDC

<!-- snippet: docs/snippets/onchain.ts#transfer-usdc -->
```ts
const transaction = await client.transferErc20({ to, amount: '1' });
const receipt = await transaction.wait();
console.log(`${receipt.status} in ${receipt.transactionHash}`);
```

`transferErc20` sends XO's USDC unless you pass a `token`. Check `to` yourself: USDC sent to the
wrong address is gone.

It returns once the transaction is mined. A revert is not an error, so check `status`.

## Merge YES and NO into USDC

<!-- snippet: docs/snippets/onchain.ts#merge -->
```ts
const transaction = await client.mergePositions({ conditionId });
const receipt = await transaction.wait();
console.log(`${receipt.status} in ${receipt.transactionHash}`);
```

One YES and one NO share merge into 1 USDC. With no `amount`, `mergePositions` merges every pair
your resting sell orders do not hold. Stop quoting that market first: an order filled mid-merge
can lose its shares.

## Redeem resolved markets

<!-- snippet: docs/snippets/onchain.ts#redeem-all -->
```ts
const results = await client.redeemAllPositions();

for (const result of results) {
  if (result.ok) {
    const receipt = await result.transaction.wait();
    console.log(`${result.conditionId}: ${receipt.status}`);
  } else {
    console.log(`${result.conditionId}: ${result.error.code}`);
  }
}
```

Each market is its own transaction. `redeemPositions({ conditionId })` redeems one market.

If a send's outcome is unknown, it stops there: the markets after it come back as
`skipped_after_ambiguous`. Look that transaction up, then call again.

## When the outcome is unknown

> [!WARNING]
> When a send throws with `mayHaveLanded: true`, the transaction may be on chain. Never send it
> again until you have checked. The SDK never does.

If the error has a `transactionHash`, look that transaction up. If not, it has the `nonce` your
signer's address used, even when a smart wallet trades. If that address's transaction count is
above `nonce`, a transaction with that nonce landed: find it. If not, it may still land.

## Next steps

- [Move USDC to another network](deposits-and-withdrawals.md)
- [Read your portfolio](portfolio.md)
- [Every error code](errors.md)
