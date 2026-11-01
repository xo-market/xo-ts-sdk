# Positions

Anyone's positions can be read without a key. The rest of this page needs a secure client signed
in with your wallet. Trading approvals are set once with `setupTradingApprovals()`, as in the
[quickstart](quickstart.md).

## Read a wallet's positions

<!-- snippet: docs/snippets/positions.ts#list-positions -->
```ts
for await (const page of client.listPositions({ user: wallet })) {
  for (const position of page.items) {
    console.log(
      `${position.title}: ${position.currentSize} shares worth ${position.currentValue}`,
    );
  }
}
```

Positions are public, so a public client reads any wallet's by address. A private profile lists
none. On a secure client, leave out `user` to list your own. Pass `redeemable: true` for what you
can redeem now, or `market` (a condition id) for one market.

## Read your balances

<!-- snippet: docs/snippets/positions.ts#balances -->
```ts
const balances = await client.fetchBalances();
console.log(`${balances.collateral} USDC to trade with`);

const value = await client.fetchPortfolioValue();
console.log(`Worth ${value.value} in all, ${value.cash} in cash`);
```

`collateral` is what the order book holds for you to trade with, not the USDC in your wallet on
chain. The two can differ, for example right after a deposit. `value` adds up your cash, your
positions and the winnings you have not redeemed.

## Read profit and loss

<!-- snippet: docs/snippets/positions.ts#pnl -->
```ts
const pnl = await client.fetchUserPnl();
console.log(`PnL ${pnl.pnl} (${pnl.percentPnl}%)`);
```

That is the whole account. Pass a `marketId` for one market, or a `positionId` for one position.

## Read activity

<!-- snippet: docs/snippets/positions.ts#activity -->
```ts
const { items } = await client.listActivity({ pageSize: 5 }).firstPage();

for (const row of items) {
  console.log(row.timestamp, row.type, row.title, row.amount);
}
```

Activity lists your trades, redemptions, merges and transfers, newest first. Filter it by `type`,
such as `TRADE` or `REDEEM`, or by `marketId`.

## Merge YES and NO into USDC

<!-- snippet: docs/snippets/positions.ts#merge -->
```ts
const transaction = await client.mergePositions({ conditionId });
const receipt = await transaction.wait();
console.log(`${receipt.status} in ${receipt.transactionHash}`);
```

One YES and one NO share merge into 1 USDC. With no `amount`, it merges every pair your resting
sell orders do not hold. Stop quoting that market first: an order filled mid-merge can lose its
shares.

## Redeem resolved markets

<!-- snippet: docs/snippets/positions.ts#redeem-all -->
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

Each market is its own transaction. `redeemPositions({ conditionId })` redeems one. If a send's
outcome is unknown, the markets after it come back as `skipped_after_ambiguous`: look that
transaction up, then call again.

## Transfer USDC

<!-- snippet: docs/snippets/positions.ts#transfer-usdc -->
```ts
const transaction = await client.transferErc20({ to, amount: '1' }); // 1 USDC
const receipt = await transaction.wait();
console.log(`${receipt.status} in ${receipt.transactionHash}`);
```

Pass a `token` to send another ERC-20. Check `to` yourself: USDC sent to the wrong address is gone.

Merges, redeems and transfers return once the transaction is mined, and XO pays the gas by
default. A revert is not an error, so check `status`.

## When the outcome is unknown

<!-- snippet: docs/snippets/positions.ts#unknown-outcome -->
```ts
try {
  await client.transferErc20({ to, amount: '1' });
} catch (error) {
  if (error instanceof TransactionFailedError && error.mayHaveLanded) {
    console.log(
      `May have landed: look up ${error.transactionHash ?? `nonce ${error.nonce}`}`,
    );
  }
  throw error;
}
```

> [!WARNING]
> With `mayHaveLanded: true`, the transaction may be on chain. Never send it again until you have
> checked. The SDK never does.

Look the `transactionHash` up. Without one, the error has the `nonce` your signer's address used,
even for a smart wallet. If that address's transaction count is above `nonce`, a transaction with
that nonce landed: find it. If not, it may still land.

## Next steps

- [Deposit USDC](deposit.md)
- [Stream your positions](realtime.md)
- [Every error code](errors.md)
