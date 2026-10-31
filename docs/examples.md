# Examples

Each script does one task and runs on its own. They run on mainnet, so the ones that trade spend
real USDC.

In a clone of the SDK's repository, build the package, copy the settings and run one:

<!-- snippet: none -->
```sh
pnpm install && pnpm -C packages/client build
cp .env.example .env   # then set what the example needs, such as XO_PK
pnpm --filter @xomarket/examples list:markets
```

The [examples README](../examples/scripts/README.md) lists the command of each. To run them in a
project of your own, see the [Quickstart](quickstart.md).

## Market data

These use `createPublicClient()` and need no key. List positions reads the wallet whose address
you set as `XO_WALLET`.

<!-- cards: list, magnifying-glass, layer-group, chart-line, book-open, wave-pulse, wallet, trophy -->
- **[List markets](../examples/scripts/src/list-markets.ts)**: Five open markets, each with its id.
- **[Fetch a market](../examples/scripts/src/fetch-market.ts)**: One market, read by its link, its slug and its id.
- **[Pagination](../examples/scripts/src/pagination.ts)**: Three pages of open markets, one after the other.
- **[Market prices](../examples/scripts/src/market-prices.ts)**: A YES token's book, best buy price, midpoint, spread and last trade.
- **[Order book](../examples/scripts/src/order-book.ts)**: A YES token's five best bids and asks.
- **[Live order book](../examples/scripts/src/realtime-book.ts)**: The books of ten open markets, live: the first 10 events.
- **[List positions](../examples/scripts/src/list-positions.ts)**: The positions of any XO wallet, by its address.
- **[Rewards markets](../examples/scripts/src/rewards-markets.ts)**: The markets that pay USDC liquidity rewards, and what an order must do to earn.

## Your account

These need your key. Most use `createSecureClient({ signer })`; Smart wallet address only reads
the address of your key.

<!-- cards: table, gear, location-dot, shield-halved -->
- **[Dashboard](../examples/scripts/src/dashboard.ts)**: Your balances, portfolio value, PnL and latest activity. Read-only.
- **[Account setup](../examples/scripts/src/account-setup.ts)**: The one-time approvals before your first order.
- **[Smart wallet address](../examples/scripts/src/smart-wallet-address.ts)**: The addresses of your key's first three smart wallets. Sends nothing.
- **[Smart wallet](../examples/scripts/src/smart-wallet.ts)**: Sign an order as a smart wallet that your key owns, without sending it. A new smart wallet is deployed first, once, with its trading approvals: XO pays the gas.

## Orders

<!-- cards: pen, pen-ruler, arrow-right-arrow-left, clock, list-check, ban, heart-pulse -->
- **[Create a limit order](../examples/scripts/src/create-limit-order.ts)**: Sign a limit order without sending it. Spends nothing.
- **[Create a market order](../examples/scripts/src/create-market-order.ts)**: Sign a market order without sending it. Spends nothing.
- **[Place and cancel](../examples/scripts/src/place-and-cancel.ts)**: Rest a 1-share order on the book, then cancel it.
- **[Good-til-date order](../examples/scripts/src/gtd-order.ts)**: An order that ends by itself in 5 minutes.
- **[Open orders](../examples/scripts/src/open-orders.ts)**: Your open orders, in every market.
- **[Cancel all](../examples/scripts/src/cancel-all.ts)**: Cancel every open order of the account.
- **[Heartbeat](../examples/scripts/src/heartbeat.ts)**: Send the order heartbeat for a minute. It arms an account-wide auto-cancel that stopping does not disarm.

> [!WARNING]
> One counted heartbeat arms an auto-cancel for the whole account, and `stop()` does not disarm it:
> 30 seconds after the last beat, XO cancels every open order, later ones and the website's too.
> Run the heartbeat example with a wallet you don't trade by hand. See
> [Cancel orders if your server stops](production.md#cancel-orders-if-your-server-stops).

## Funds

<!-- cards: download, paper-plane, trophy -->
- **[Deposit](../examples/scripts/src/deposit.ts)**: Deposit USDC from Base through XO's bridge.
- **[Transfer USDC](../examples/scripts/src/transfer-usdc.ts)**: Send 1 USDC to another wallet of yours.
- **[Redeem](../examples/scripts/src/redeem-all.ts)**: Turn your shares in resolved markets back into USDC.

## A bot

<!-- cards: robot -->
- **[Market-making bot](../examples/mm-bot/README.md)**: A demo two-sided quoter that re-quotes when the book moves. A demo, not a strategy.
