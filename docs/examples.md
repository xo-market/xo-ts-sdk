# Examples

The scripts run on mainnet, and the ones that trade spend real USDC. Use a wallet that holds only
what you can afford to lose.

To run one, clone the repository, then:

<!-- snippet: none -->
```sh
pnpm install && pnpm -C packages/client build
cp .env.example .env   # then fill in what the example needs
pnpm --filter @xomarket/examples list:markets
```

The [examples README](../examples/scripts/README.md) lists every command. In your own project,
follow the [Quickstart](quickstart.md).

## Market data

These need no key.

- [List markets](../examples/scripts/src/list-markets.ts)
- [Fetch a market](../examples/scripts/src/fetch-market.ts) by link, slug or id
- [Read every page](../examples/scripts/src/pagination.ts)
- [Market prices](../examples/scripts/src/market-prices.ts)
- [Order book](../examples/scripts/src/order-book.ts)
- [Live order books](../examples/scripts/src/realtime-book.ts)
- [List positions](../examples/scripts/src/list-positions.ts) of the wallet in `XO_WALLET`
- [Markets that pay rewards](../examples/scripts/src/rewards-markets.ts)

## Your account

The rest need your key in `XO_PK`.

- [Dashboard](../examples/scripts/src/dashboard.ts), read-only
- [Account setup](../examples/scripts/src/account-setup.ts) before your first order
- [Smart wallet addresses](../examples/scripts/src/smart-wallet-address.ts)
- [Sign an order as a smart wallet](../examples/scripts/src/smart-wallet.ts) set in
  `XO_SMART_WALLET`. A new one is deployed first, once, gas-free, with its trading approvals.

## Orders

- [Create a limit order](../examples/scripts/src/create-limit-order.ts) without sending it
- [Create a market order](../examples/scripts/src/create-market-order.ts) without sending it
- [Place and cancel](../examples/scripts/src/place-and-cancel.ts) a 1-share order
- [Good-til-date order](../examples/scripts/src/gtd-order.ts) that expires in 5 minutes
- [Open orders](../examples/scripts/src/open-orders.ts)
- [Cancel all](../examples/scripts/src/cancel-all.ts) open orders
- [Heartbeat](../examples/scripts/src/heartbeat.ts) for a minute

> [!WARNING]
> Once a heartbeat counts, XO cancels every open order of the account, the website's too, 30
> seconds after the heartbeats stop. Use a wallet you don't trade by hand.

## Funds

- [Deposit](../examples/scripts/src/deposit.ts) USDC from Base
- [Transfer 1 USDC](../examples/scripts/src/transfer-usdc.ts) to `XO_TO`
- [Redeem](../examples/scripts/src/redeem-all.ts) shares in resolved markets

## Next steps

- [A demo market-making bot](../examples/mm-bot/README.md)
- [Place your first order](quickstart.md)
