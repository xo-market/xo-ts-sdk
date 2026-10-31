# Balances and on-chain

A secure client reads what the order book holds for your trading address and sends its on-chain
actions. XO's sponsor pays the gas for all of them, for a plain wallet and a smart wallet alike.

## Read balances

Amounts are decimal strings in whole units: `'5'` is 5 USDC, or 5 shares. `fetchBalances` reads
what the order book holds for the account: its cash credit, and the shares it holds for each
outcome token, with those that resting sell orders reserve. That is what trading can use. It is
not the USDC at the wallet address on chain, and the two can differ for a few seconds after a
deposit, a transfer or a fill. `PortfolioValue.cash` is another figure again: see
[Portfolio and activity](portfolio.md).

<!-- snippet: docs/snippets/portfolio.ts#balances -->
```ts
const balances = await client.fetchBalances();
console.log(`${client.wallet}: ${balances.collateral} USDC to trade with`);
console.table(balances.positions);
```

## Set up the account

`fetchTradingApprovalsState` reads the chain and says whether the account is `ready` to trade.
`setupTradingApprovals` lets the exchange spend your USDC and move your shares, in one
transaction, and sends only what is missing. It returns `null` when nothing was missing, so call
it at every start.

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

## What a transaction method returns

Every method that sends a transaction returns a handle once the chain has mined it. It waits for
the receipt, up to two minutes, so `wait()` resolves at once. A transaction that was mined and
reverted is a result, not an error: check `status` (`'success'` or `'reverted'`) on the receipt.
The one exception is `setupTradingApprovals`, which throws `tx_reverted` for a revert, and which
is safe to call again. `blockNumber` is a `bigint`.

## Transfer USDC

`transferErc20` sends an ERC-20 token from your trading address. Without `token` it sends XO's
USDC. Check `to` yourself: USDC sent to a wrong address is gone. To move USDC to another network,
see [Deposits and withdrawals](deposits-and-withdrawals.md).

<!-- snippet: docs/snippets/onchain.ts#transfer-usdc -->
```ts
const transaction = await client.transferErc20({ to, amount: '1' });
const receipt = await transaction.wait();
console.log(
  `${receipt.status} in transaction ${receipt.transactionHash}, block ${receipt.blockNumber}`,
);
```

The balance is read first, and when it is short nothing is sent. The sponsor may refuse to pay for
the transfer of a token other than USDC: the error is a 403 `policy_rejected`, and nothing was
sent. Create the client with `rail: 'direct'` to send it yourself, from a plain wallet that pays
its own gas.

## Merge YES and NO into USDC

One YES and one NO share of a market merge into 1 USDC. `mergePositions` merges every full set
that is free, so shares that back your resting SELL orders stay. Pass an `amount` to merge fewer.
Pause quoting in that market first.

<!-- snippet: docs/snippets/onchain.ts#merge -->
```ts
const transaction = await client.mergePositions({ conditionId });
const receipt = await transaction.wait();
console.log(`Merged: ${receipt.status} in ${receipt.transactionHash}`);
```

## Redeem resolved markets

`redeemAllPositions` redeems your shares in every market you can redeem, one transaction per
market. `redeemPositions({ conditionId })` redeems one. A market that fails does not stop the
others, so you get one result per market.

<!-- snippet: docs/snippets/onchain.ts#redeem-all -->
```ts
const results = await client.redeemAllPositions();

for (const result of results) {
  if (result.ok) {
    console.log(
      `${result.conditionId}: redeemed in ${result.transaction.transactionHash}`,
    );
  } else {
    console.log(
      `${result.conditionId}: ${result.error.mayHaveLanded ? 'outcome unknown' : 'nothing sent'} (${result.error.code})`,
    );
  }
}
console.log(`${results.length} market(s) to redeem`);
```

After a send whose outcome is unknown, nothing more is sent: every market after it comes back as
`skipped_after_ambiguous`. Look that transaction up, then call again.

## When the outcome is unknown

> [!WARNING]
> When a send throws with `mayHaveLanded: true`, the transaction may be on chain. Never send it
> again before you know. The SDK never does.

The error carries what you need to find it:

- With a `transactionHash`, look that transaction up.
- Without one, the sponsor's answer was lost, and the error carries the executor `nonce` instead.
  The executor is your signer's address, even when a smart wallet trades. If that address's
  transaction count is above `nonce`, a transaction with that nonce landed: find it before you
  send anything again. If the count is not above it, nothing was mined yet, and it may still land.

Every error code is in [Errors](errors.md).
