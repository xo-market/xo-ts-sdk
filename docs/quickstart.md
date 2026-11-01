# Quickstart

> [!WARNING]
> XO runs on mainnet, so the money is real. Use a new wallet that holds only what you can afford
> to lose.

You need Node 22 or later, the private key of that wallet, and about 5 USDC on Base. Each step
runs one script from the SDK's [examples](../examples/scripts/README.md).

## 1. Set up a project

<!-- snippet: none -->
```sh
mkdir xo-app && cd xo-app
npm init -y && npm pkg set type=module
npm install @xomarket/client viem
npm install -D tsx typescript @types/node
```

Copy the scripts below and their `lib` folder from the examples' [`src`](../examples/scripts/src/)
folder. Then copy the repository's [`.env.example`](../.env.example) and add your key:

<!-- snippet: none -->
```sh
cp .env.example .env   # then set XO_PK=0x... in .env
```

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

It prints five open markets:

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

`createSecureClient` signs in for you, and creates your XO account the first time.
`client.wallet` is the address you trade from.

## 4. Deposit USDC

Run `npx tsx deposit.ts`. It prints an address and an amount, then waits. Send that amount of
USDC on Base to that address, once. The script ends when the payment is final. Only `COMPLETE`
means your USDC arrived.

If the script stops after you sent the funds, don't send again. The payment carries on, and
[Deposits and withdrawals](deposits-and-withdrawals.md) shows how to follow it by its
`paymentId`. If you sent nothing, send nothing: the payment expires, and a new run gets a new
quote.

## 5. Set up trading

Run `npx tsx account-setup.ts`. In one transaction, it lets the exchange move your USDC and
shares. XO pays the gas.

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

When the account is set up already, it sends nothing, so you can run it on every start.

## 6. Place and cancel an order

Run `npx tsx place-and-cancel.ts`. It picks a busy market that takes orders, bids for 1 YES
share at the lowest price so the order rests on the book, then cancels it.

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

It prints something like this:

<!-- snippet: none -->
```console Example
BUY 1 YES @ 0.001 is live: 0x7b1f…e09a
Canceled 1 order(s)
```

With `postOnly: true`, XO refuses an order that would trade right away. A refused order has
`placed.ok` set to `false`, and nothing was placed. If the call throws with `mayHaveLanded: true`,
the order may be on the book: look it up with `reconcileOrder` before you place it again.

## Common issues

| You see | What to do |
| --- | --- |
| `Set XO_PK (see .env.example)` | Put your key in `.env` as `XO_PK=0x...`. |
| `0 USDC to trade with` after a deposit | Wait a few seconds after `COMPLETE`, then run `dashboard.ts` again. |
| `Refused (market_not_active)` | The market stopped taking orders after the script picked it. Run it again. |
| `Refused (...)` | XO says why. Check that step 3 shows USDC to trade with. |
| `api_key_limit_reached` | Your account has 10 active API keys. See the [Production checklist](production.md). |

## Next steps

- [Place other kinds of orders](orders.md)
- [Show markets and prices in your app](markets.md)
- [Follow a deposit, or withdraw](deposits-and-withdrawals.md)
