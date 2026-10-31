# Quickstart

Each step runs one script from the SDK's [examples](../examples/scripts/README.md).

> [!WARNING]
> The SDK trades on XO mainnet, so the money is real. Use a new key that holds only what you can
> afford to lose.

You need Node 22 or later, a private key for a new wallet, and about 5 USDC on Base.

## 1. Set up a project

<!-- snippet: none -->
```sh
mkdir xo-app && cd xo-app
npm init -y && npm pkg set type=module
npm install @xomarket/client viem
npm install -D tsx typescript @types/node
```

Copy the scripts used below from the examples' [`src`](../examples/scripts/src/) folder, with its
`lib` folder, and the repository's [`.env.example`](../.env.example). Then add your key to a
`.env` in the folder you run the scripts from:

<!-- snippet: none -->
```sh
cp .env.example .env   # then set XO_PK=0x... in .env
```

The `.env` of the folder you run from wins. `lib/env.ts` also reads a `.env` two folders up (in a
clone of the SDK, the repository's), but only for the settings that yours leaves unset.

## 2. List markets

Run `npx tsx list-markets.ts`. Reading markets needs no key.

<!-- snippet: docs/snippets/markets.ts#client -->
```ts
const client = createPublicClient();
```

<!-- snippet: docs/snippets/quickstart.ts#list-markets -->
```ts
const page = await client
  .listMarkets({
    pageSize: 5,
  })
  .firstPage();

for (const market of page.items) {
  console.log(`${market.id}: ${market.question}`);
}
```

It prints five open markets, each with its id. An example of what it prints:

<!-- snippet: none -->
```console Example
54873: Draw: Sunderland vs Dinamo Zagreb
54875: Torreense to win vs Ararat-Armenia
54876: Draw: Torreense vs Ararat-Armenia
54872: Sunderland to win vs Dinamo Zagreb
54877: Ararat-Armenia to win vs Torreense
```

## 3. Check your account

Run `npx tsx dashboard.ts`. It reads your account and changes nothing.

<!-- snippet: docs/snippets/portfolio.ts#client -->
```ts
const client = await createSecureClient({
  signer: privateKey(requireEnv('XO_PK')),
});
```

<!-- snippet: docs/snippets/portfolio.ts#balances -->
```ts
const balances = await client.fetchBalances();
console.log(`${client.wallet}: ${balances.collateral} USDC to trade with`);
console.table(balances.positions);
```

An example of what it prints for a new wallet, with a shortened address:

<!-- snippet: none -->
```console Example
0xA11c…e5B7: 0 USDC to trade with
┌─────────┐
│ (index) │
├─────────┤
└─────────┘
```

There is no sign-in call. `createSecureClient` signs in when it creates the client, and creates
your XO account the first time. The address it trades from is `client.wallet`: your wallet's own.
The script ends by itself. The client revokes its 1-day API key when the process ends normally,
or on Ctrl-C or SIGTERM. If a script is cut short by `process.exit()` or a crash, the key is not
revoked and expires within a day.

## 4. Deposit USDC

Run `npx tsx deposit.ts`. It gets a quote from XO's bridge, prints an address and an amount, and
waits. Send exactly that amount of USDC on Base to that address, once. The script finishes when
the payment is final, and prints its status: only `COMPLETE` means the USDC arrived.

If the script stops after you sent the funds, don't send again: the payment goes on, and
[Deposits and withdrawals](deposits-and-withdrawals.md) shows how to follow it. If it stops before
you sent anything, send nothing: the payment expires at its `fundBy` time (status `EXPIRED`), and
a new run gets a new quote.

## 5. Set up trading

Run `npx tsx account-setup.ts`. It lets the exchange move your USDC and shares, in one
transaction. XO pays the gas.

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

Example output, with a shortened hash:

<!-- snippet: none -->
```console Example
Approvals missing: setting them up
Set up in transaction 0x4e3a…c21d
```

It sends nothing when the account is already set up, so it is safe to run on every start.

## 6. Place and cancel an order

Run `npx tsx place-and-cancel.ts`. It picks a high-volume open market that takes orders, bids for
1 YES share at the lowest price so the order rests on the book, then cancels it.

<!-- snippet: docs/snippets/orders.ts#place -->
```ts
const placed = await client.placeLimitOrder({
  assetId,
  side: OrderSide.BUY,
  price: tickSize,
  size: '1',
  postOnly: true,
});
console.log(
  placed.ok
    ? `BUY 1 YES @ ${tickSize} is ${placed.status}: ${placed.orderId}`
    : `Refused (${placed.code}): ${placed.message}`,
);
```

<!-- snippet: docs/snippets/orders.ts#cancel -->
```ts
if (placed.ok) {
  const { canceled } = await client.cancelOrder({ orderId: placed.orderId });
  console.log(`Canceled ${canceled.length} order(s)`);
}
```

Example output, with a shortened order id:

<!-- snippet: none -->
```console Example
BUY 1 YES @ 0.001 is live: 0x7b1f…e09a
Canceled 1 order(s)
```

`postOnly: true` means the order can only rest on the book. XO refuses it, with the code
`post_only_would_cross`, if it would trade right away. A refusal is a value (`placed.ok` is
`false`), not an exception.

## Common issues

| You see | What to do |
| --- | --- |
| `Set XO_PK (see .env.example)` | Put your private key in `.env` as `XO_PK=0x...`. |
| `0 USDC to trade with` after a deposit | Wait a few seconds after `deposit.ts` says `COMPLETE`, then run `dashboard.ts` again. |
| `Refused (market_not_active)` | The market stopped taking orders after the script picked it. Run the script again: it picks a market that takes orders. |
| `Refused (...)` | XO refused the order and says why. Check that step 3 shows USDC to trade with. |
| `api_key_limit_reached` | Your account has 10 active API keys. See the [Production checklist](production.md). |
| `deposit.ts` stopped before `COMPLETE` | If you already sent the funds, don't send again: the payment goes on, and `dashboard.ts` shows the USDC once it arrives. If you had not sent anything, send nothing and run it again for a new quote. |

## Next steps

- [Orders](orders.md): order types, market orders and listing your orders.
- [Markets and prices](markets.md): show markets and live prices in your app.
