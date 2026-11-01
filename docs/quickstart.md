# Place your first order

This guide buys 1 USDC of YES in one market and shows your position. XO runs on mainnet, so the
USDC is real. Use a wallet that holds only what you can afford to lose.

You need the wallet's private key in `XO_PK` and at least 1 USDC in your XO account. To add USDC,
see [Deposit](deposit.md). Set up the project as in the [Quickstart](README.md#quickstart), and
put the steps below in one file.

## 1. Sign in

Create a secure client with your key. It signs in before it returns.

<!-- snippet: docs/snippets/quickstart.ts#sign-in -->
```ts
import { createSecureClient, OrderSide } from '@xomarket/client';
import { privateKey } from '@xomarket/client/viem';

const client = await createSecureClient({
  signer: privateKey(process.env.XO_PK ?? ''),
});
```

## 2. Set up trading

Let the exchange use your USDC. This runs once, XO pays the gas, and later calls send nothing.

<!-- snippet: docs/snippets/quickstart.ts#setup -->
```ts
await client.setupTradingApprovals();
```

## 3. Choose an outcome

Take the slug from the market's link on XO, `https://xo.market/markets/<slug>`. You trade an
outcome by its token id.

<!-- snippet: docs/snippets/quickstart.ts#choose -->
```ts
const market = await client.fetchMarket({ slug: 'your-market-slug' });
const assetId = market.outcomes.yes.tokenId;
if (assetId === null) {
  throw new Error('This market has no YES outcome');
}
```

## 4. Place a market order

<!-- snippet: docs/snippets/quickstart.ts#order -->
```ts
const order = await client.placeMarketOrder({
  assetId,
  side: OrderSide.BUY,
  amount: '1', // spends up to 1 USDC
});

console.log(order.ok ? order.status : `Refused: ${order.code}`);
```

`delayed` means the order waits out a short delay and can still fill. If the call throws, check
with `reconcileOrder` before you place it again.

## 5. Check your position

<!-- snippet: docs/snippets/quickstart.ts#position -->
```ts
const { items } = await client.listPositions().firstPage();

for (const position of items) {
  console.log(`${position.title}: ${position.currentSize} shares`);
}
```

A new position can take a few seconds to show while the trade settles.

That's it: you placed your first order. Next, learn the other order types in
[Place orders](place-orders.md), or stream your fills with [Real-time data](realtime.md).
