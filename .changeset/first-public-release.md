---
'@xomarket/client': minor
---

First public release of the TypeScript SDK for XO Market.

- **Two clients.** `createPublicClient()` reads public data and needs no credentials.
  `await createSecureClient({ signer })` signs in with a wallet and adds everything that belongs
  to an account. Make the signer with `privateKey` or `signerFrom` from `@xomarket/client/viem`.
  The client trades from the signer's own address unless you pass the `wallet` option with the
  address of one of the signer's smart wallets.
- **Markets and market data.** Markets, events, series and categories; order books; midpoints,
  prices and spreads (`null` where there is none); a market's trades and price history; and a
  check of whether a market can be traded now. Lists are paginators: read the first page, walk
  them with `for await`, or resume a walk with the cursor of a page.
- **Trading.** Limit and market orders, singly or in batches: `create` only signs an order,
  `place` signs and sends it, `post` sends orders you signed before. Cancel by order, by market
  or all at once, and list open orders and trades. Heartbeats are an opt-in, account-wide
  auto-cancel switch: once armed, XO cancels every open order of the account when the beats
  stop. A refused order comes back as a value (`ok: false` with the reason), not as an
  exception. Orders and cancels are sent once and never retried, and an order is never signed
  twice: a send whose outcome is not known throws an error that says it may have landed, and an
  order's error names the order to check.
- **Account and positions.** Positions, portfolio value, profit and loss, activity, balances,
  your profile and your API keys.
- **On-chain steps.** Trading approvals, transfers, merge and redeem. XO pays the gas by
  default; with `rail: 'direct'` they are sent from the signer's own address, which pays it.
- **Deposits and withdrawals.** Assets, quotes, payments, and waiting for a payment to finish.
- **Liquidity rewards.** The reward pools and groups, the rewards of a market and of a day, its
  makers and orders, a wallet's rewards, and the leaderboard.
- **Live updates.** One `subscribe()` follows order books, price changes and trades, a market's
  newest fills, and, with a signed-in client, your orders, trades and positions, on a single
  handle.
- **Options per call.** Reads take `{ signal, timeout, retries }` to cancel them, bound each
  attempt and set how often a failed attempt is retried. The reads of the chain ignore `retries`,
  and `waitForBridgePayment` takes `{ signal, timeout }`. Calls that change something take none.
- **Mainnet only.** The SDK runs on XO's production services, with real money.
- **Earlier versions were pre-releases** and are deprecated.
