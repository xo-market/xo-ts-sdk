# Portfolio and activity

## Read any wallet's positions

<!-- snippet: docs/snippets/portfolio.ts#list-positions -->
```ts
for await (const page of client.listPositions({ user: wallet })) {
  for (const position of page.items) {
    console.log(
      `${position.title}: ${position.currentSize} shares worth ${position.currentValue}`,
    );
  }
}
```

Positions are public, so a client with no key can read them by wallet address. A wallet with a
private profile lists none.

Pass `redeemable: true` to list only what you can redeem now, or `market` (a condition id) for one
market. For every field, see [`Position`](reference/client/type-aliases/Position.md).

## Create a client for your account

Your balances, value, profit and loss and activity need a client signed in with your wallet.

<!-- snippet: docs/snippets/portfolio.ts#client -->
```ts
const client = await createSecureClient({
  signer: privateKey(requireEnv('XO_PK')),
});
```

Nothing on this page trades, but a secure client can trade and move funds. Keep it, and its key,
on your server.

On this client, `listPositions()` with no `user` lists your own positions.

## Read balances

<!-- snippet: docs/snippets/portfolio.ts#balances -->
```ts
const balances = await client.fetchBalances();
console.log(`${client.wallet}: ${balances.collateral} USDC to trade with`);
console.table(balances.positions);
```

`collateral` is the USDC the order book holds for you, which is what you can trade with.
`positions` lists your shares of each outcome token. Amounts are decimal strings.

## Read your portfolio value

<!-- snippet: docs/snippets/portfolio.ts#portfolio -->
```ts
const value = await client.fetchPortfolioValue();
console.log(`Worth ${value.value} in all, ${value.cash} in cash`);
```

`value` adds up `cash`, what your positions are worth and the winnings you have not redeemed yet.
`cash` and `collateral` can differ, for example right after a deposit.

## Read profit and loss

<!-- snippet: docs/snippets/portfolio.ts#pnl -->
```ts
const pnl = await client.fetchUserPnl();
console.log(`PnL ${pnl.pnl} (${pnl.percentPnl}%)`);
```

That is the whole account. Pass a `marketId` for one market, or a `positionId` for one position.

## Read activity

<!-- snippet: docs/snippets/portfolio.ts#activity -->
```ts
const { items } = await client.listActivity({ pageSize: 5 }).firstPage();

for (const row of items) {
  console.log(row.timestamp, row.type, row.title, row.amount);
}
```

Activity is newest first. Filter it by `type`, such as `TRADE` or `REDEEM`, or by `marketId`.
The example [`dashboard.ts`](../examples/scripts/src/dashboard.ts) reads your balances, value,
profit and loss and activity in one script.

## Next steps

- [Stream your positions](realtime.md#stream-your-positions)
- [Redeem resolved markets](onchain.md#redeem-resolved-markets)
- [Move USDC in and out](deposits-and-withdrawals.md)
