# XO TypeScript SDK

`@xomarket/client` is XO's official TypeScript SDK. It runs on your server, with Node 22 or later,
or Bun.

<!-- cards: github, npm, clock-rotate-left, code -->
- **[GitHub](https://github.com/xo-market/xo-ts-sdk)**: View the SDK source.
- **[npm](https://www.npmjs.com/package/@xomarket/client)**: Install `@xomarket/client`.
- **[Changelog](changelog.md)**: What changed in each version.
- **[Examples](examples.md)**: Short scripts you can run, one task each.

## Install

<!-- code-group -->
<!-- snippet: none -->
```sh npm
npm install @xomarket/client viem
```

<!-- snippet: none -->
```sh pnpm
pnpm add @xomarket/client viem
```

<!-- snippet: none -->
```sh yarn
yarn add @xomarket/client viem
```

<!-- snippet: none -->
```sh bun
bun add @xomarket/client viem
```

## Two clients

`createPublicClient()` reads public data and needs no key. It returns at once and sends nothing
until you make a call.

<!-- snippet: docs/snippets/markets.ts#client -->
```ts
const client = createPublicClient();
```

`createSecureClient({ signer })` signs in with your wallet key, so it can trade, read your account
and move funds. Everything the public client has is on it too.

<!-- snippet: docs/snippets/portfolio.ts#client -->
```ts
const client = await createSecureClient({
  signer: privateKey(requireEnv('XO_PK')),
});
```

## Start here

<!-- cards: bolt, chart-line, arrow-right-arrow-left, money-bill-transfer -->
- **[Quickstart](quickstart.md)**: Place your first order in six steps.
- **[Markets and prices](markets.md)**: Show XO markets in your app. No key needed.
- **[Orders](orders.md)**: Place, list and cancel orders from your server.
- **[Deposits and withdrawals](deposits-and-withdrawals.md)**: Move USDC into XO and back out.

## What you can do

- Read markets, events, prices, order books and trades without a key.
- Trade with your own key. The client signs in when you create it.
- Stream order books, your orders and fills, and your positions.
- Deposit and withdraw USDC through XO's bridge.
- Set up your account, move USDC, merge and redeem positions. XO pays the gas.
- Read the liquidity rewards of a market or a wallet.

How the methods are named and shaped is on [SDK direction](sdk-direction.md). The
[API reference](reference/README.md) lists every method and type. Questions? Write to
gm@xo.market.
