# XO TypeScript SDK

`@xomarket/client` is XO's official TypeScript SDK. It runs on your server, with Node 22 or later
or Bun.

<!-- cards: github, npm, clock-rotate-left, code -->
- **[GitHub](https://github.com/xo-market/xo-ts-sdk)**: The SDK's source.
- **[npm](https://www.npmjs.com/package/@xomarket/client)**: The `@xomarket/client` package.
- **[Changelog](changelog.md)**: What changed in each version.
- **[Examples](examples.md)**: Short scripts, one task each.

## Install

<!-- snippet: none -->
```sh
npm install @xomarket/client viem
```

For pnpm, yarn or Bun, see [Installation](install.md).

## Two clients

`createPublicClient()` reads public data and needs no key.

<!-- snippet: docs/snippets/markets.ts#client -->
```ts
const client = createPublicClient();
```

`createSecureClient({ signer })` signs in with your wallet's key to trade, read your account and
move funds. It has every public read too.

<!-- snippet: docs/snippets/portfolio.ts#client -->
```ts
const client = await createSecureClient({
  signer: privateKey(requireEnv('XO_PK')),
});
```

## What you can do

- [Read markets and prices](markets.md) without a key.
- [Stream](realtime.md) order books, your orders and your positions.
- [Place and cancel orders](orders.md), from your wallet or a [smart wallet](smart-wallets.md).
- [Deposit and withdraw](deposits-and-withdrawals.md) USDC.
- [Move USDC, merge and redeem](onchain.md). XO pays the gas by default.

The [API reference](reference/README.md) lists every method and type. Questions? Write to
gm@xo.market.

## Next steps

<!-- cards: bolt, chart-line, arrow-right-arrow-left -->
- **[Quickstart](quickstart.md)**: Place your first order in six steps.
- **[Markets and prices](markets.md)**: Show XO markets in your app.
- **[Orders](orders.md)**: Place, list and cancel orders.
