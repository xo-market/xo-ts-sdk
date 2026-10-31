# TypeScript examples

This private workspace package holds runnable TypeScript scripts that show the workflows of
`@xomarket/client` on XO mainnet.

Run an example from the repository root:

```bash
pnpm --filter @xomarket/examples list:markets
pnpm --filter @xomarket/examples fetch:market
pnpm --filter @xomarket/examples pagination
pnpm --filter @xomarket/examples market:prices
pnpm --filter @xomarket/examples market:book
pnpm --filter @xomarket/examples stream:market
pnpm --filter @xomarket/examples rewards:markets
pnpm --filter @xomarket/examples positions:list
pnpm --filter @xomarket/examples account:dashboard
pnpm --filter @xomarket/examples account:setup
pnpm --filter @xomarket/examples bridge:deposit
pnpm --filter @xomarket/examples order:create-limit
pnpm --filter @xomarket/examples order:create-market
pnpm --filter @xomarket/examples order:place-and-cancel
pnpm --filter @xomarket/examples order:place-gtd
pnpm --filter @xomarket/examples orders:open
pnpm --filter @xomarket/examples orders:cancel-all
pnpm --filter @xomarket/examples orders:heartbeat
pnpm --filter @xomarket/examples usdc:transfer
pnpm --filter @xomarket/examples positions:redeem-all
pnpm --filter @xomarket/examples smart-wallet:address
pnpm --filter @xomarket/examples smart-wallet:create-order
```

The examples use the built package, so run `pnpm -C packages/client build` first. Copy the root
`.env.example` to `.env` and set `XO_PK`, the key of a wallet of yours, before you run the
examples that need your key: `account:*`, `bridge:deposit`, `order:*`, `orders:*`,
`usdc:transfer`, `positions:redeem-all` and `smart-wallet:*`. `positions:list` needs no key, only
`XO_WALLET`, the address of any XO wallet. `smart-wallet:create-order` also needs `XO_SMART_WALLET`,
and `usdc:transfer` needs `XO_TO`.

`order:place-and-cancel`, `order:place-gtd`, `bridge:deposit` and `usdc:transfer` can spend real
USDC on mainnet, so run them from a wallet that holds only what you mean to risk;
`orders:heartbeat` arms an account-wide auto-cancel, so run it from a wallet you don't trade by
hand. `smart-wallet:create-order` deploys `XO_SMART_WALLET` first if it is new, once, with its
trading approvals: XO pays the gas.

Typecheck the examples:

```bash
pnpm --filter @xomarket/examples typecheck
```
