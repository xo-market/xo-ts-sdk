# Portfolio and activity

Any wallet's positions are public. Your own balances, value, profit and loss and activity need a
client that has signed in with your wallet.

## Read any wallet's positions

`listPositions({ user })` needs no key. Pass the wallet's address. A wallet with a private profile
lists none.

<!-- snippet: docs/snippets/portfolio.ts#list-positions -->
```ts
const rows = [];

for await (const page of client.listPositions({ user: wallet })) {
  rows.push(
    ...page.items.map((position) => ({
      market: position.title,
      outcome: position.outcome ?? '',
      size: position.currentSize,
      value: position.currentValue,
      avgPrice: position.avgPrice ?? '',
      price: position.currentPrice ?? '',
      pnl: position.unrealizedPnl,
      redeemable: position.redeemable,
    })),
  );
}

console.log(`${rows.length} position(s) of ${wallet}`);
console.table(rows);
```

`redeemable: true` lists only the positions you can redeem now, and `market` (a condition id)
lists the positions of one market. Both filters are applied to each page that XO sends, so a page
can hold fewer positions than XO sent, even none, and still have more after it. Keep reading until
`hasMore` is `false`.

## Create a client for your own account

Reading your own account takes a secure client. There is no read-only client for it: the wallet's
data is tied to its key. The client only signs in, and nothing in the example below trades.

<!-- snippet: docs/snippets/portfolio.ts#client -->
```ts
const client = await createSecureClient({
  signer: privateKey(requireEnv('XO_PK')),
});
```

> [!WARNING]
> A secure client can trade and move funds. Run it on your server, with a wallet that holds only
> what the account needs, and never put the key in a web page, a repository or a log.

On a secure client, `listPositions()` without a `user` lists your own wallet's positions, and the
same method with a `user` reads any other wallet.

## Read balances and value

<!-- snippet: docs/snippets/portfolio.ts#balances -->
```ts
const balances = await client.fetchBalances();
console.log(`${client.wallet}: ${balances.collateral} USDC to trade with`);
console.table(balances.positions);
```

<!-- snippet: docs/snippets/portfolio.ts#portfolio -->
```ts
const value = await client.fetchPortfolioValue();
console.table(value);
```

Amounts are decimal strings in dollars. Two of them look alike and are not the same:

| Field | What it is |
| --- | --- |
| `Balances.collateral` | The cash credit the order book holds for the account. This is what trading can use. |
| `PortfolioValue.cash` | The spendable USDC in the wallet, as the portfolio value reports it. |

They can differ, for example right after a deposit or before a withdrawal. `PortfolioValue.value`
is `cash + positionsValue + claimableAmount`.

## Read profit and loss

<!-- snippet: docs/snippets/portfolio.ts#pnl -->
```ts
const pnl = await client.fetchUserPnl();
console.log(
  `PnL ${pnl.pnl} (${pnl.percentPnl} %), ${pnl.openPositions} open`,
);
```

`fetchUserPnl()` reads the whole account. `fetchUserPnl({ marketId })` reads one market, and
`fetchUserPnl({ positionId })` one position, with the ids a `Position` gives.

## Read activity

<!-- snippet: docs/snippets/portfolio.ts#activity -->
```ts
const activity = await client.listActivity({ pageSize: 5 }).firstPage();
console.table(activity.items, ['timestamp', 'type', 'title', 'amount']);
```

`type` narrows the list to `TRADE`, `REDEEM`, `SPLIT`, `MERGE`, `TRANSFER_IN`, `TRANSFER_OUT`,
`REFUND` or `CREATOR_UNLOCK`, and `marketId` to one market. The whole dashboard runs as
[`dashboard.ts`](../examples/scripts/src/dashboard.ts).

## Stream the positions

The `portfolio` topic sends all your positions on subscribe and after every change: see
[Live data](realtime.md#stream-your-positions).

> [!WARNING]
> Never turn on `socket.io-client` debug logging (`DEBUG=socket.io-client:*`) with a real key. It
> prints the handshake, and the handshake carries the key.
