---
'@xomarket/client': minor
---

First public release.

- Two clients: `createPublicClient()` reads public data, and `createSecureClient({ signer })`
  signs in with a wallet or one of its smart wallets.
- Markets, events, prices, order books and trades.
- Limit and market orders, singly or in batches, and cancels.
- An opt-in heartbeat that cancels every open order when the beats stop.
- Positions, profit and loss, activity, balances and API keys.
- Approvals, transfers, merge and redeem on chain. XO pays the gas by default.
- USDC deposits and withdrawals, and liquidity rewards.
- Live order books, orders and positions through one `subscribe()`.
- `{ signal, timeout, retries }` on reads. Orders, cancels, transactions and payments are
  never retried.
- Mainnet only.
- Earlier versions were pre-releases and are deprecated.
