# mm-bot: a demo market-making bot

> **A demo, not a strategy, and not financial advice.** This bot shows how the pieces of
> `@xomarket/client` fit together in a long-running quoter. It does not manage inventory or
> risk, and it is not tuned to make money. It trades on **mainnet**, with real USDC: read the
> code first, and run it from a wallet that holds only what you mean to risk.

## What it does

- **Two-sided, post-only quotes around the midpoint.** It quotes one market 2 ticks either side
  of the midpoint (`XO_SPREAD_TICKS`). It buys YES below the midpoint, and buys NO as a YES offer
  above it (a NO bid at `q` is a YES ask at `1 - q`), so it needs USDC only. Post-only orders
  never take liquidity: a side that would cross the book is left out.
- **The midpoint leaves out its own quotes**, on both books: the orderbook lists every order on
  both books (a BUY of YES at `p` is also a NO ask at `1 - p`), so each quote of the bot is in
  both. The bot reads both books and takes the better price of each side (a NO ask at `q` is a
  YES bid at `1 - q`). An empty or one-sided book has no midpoint: the bot then pulls its quotes
  and waits, unless you set `XO_REFERENCE_MID`.
- **It re-quotes on `price_change`**, debounced by 1 s, and only when the target prices moved.
  Each refresh is one `postOrderBatch` request: cancel the old quotes, then place the new ones. When
  the gateway refuses a set of quotes, the same set waits 5 s before it is tried again, then
  10 s, and so on up to 60 s.
- **It logs its fills** from the `user` topic of `subscribe`: order `UPDATE`s and `MATCHED`
  trades, then their settlement statuses. The topic covers every market of the account; the bot
  keeps the events of its own market.
- **It cancels everything on Ctrl-C** (SIGINT or SIGTERM), in every market of the account
  (`cancelAll()`), then closes the client. It waits for a placement in flight (10 s at most),
  never for a pass that only reconciles, so `cancelAll()` starts well within the 20 s that
  stopping may take; if it takes longer the bot says so, exits with code 1, and you should
  check your open orders. A second Ctrl-C kills it at once.
- **It never resends an order.** See below.
- **The heartbeat is opt-in** (`XO_HEARTBEAT=1`). Read the warning below first.

## Run it

In this repository:

```sh
pnpm install
pnpm -C packages/client build
read -rs XO_PK && export XO_PK    # paste the key: it is not echoed, nor kept in the history
XO_MARKET=<market slug or id> pnpm --filter @xomarket/mm-bot start
```

Or keep the key in a gitignored `.env` file in this folder and run
`npx tsx --env-file=.env index.ts` here. Avoid `XO_PK=0x… pnpm --filter @xomarket/mm-bot start`:
that writes the key into your shell history.

In a project of your own: `npm install @xomarket/client viem@2.57.7`, `npm install -D tsx`, copy this
folder (`index.ts` and `unresolved.ts`), and run `npx tsx mm-bot/index.ts`.

The wallet needs USDC at its trading address and the one-time trading approvals
(`setupTradingApprovals()`), which the bot sends itself at start (the sponsor pays, no gas).
The `bridge:deposit` and `account:setup` [examples](../scripts/README.md) walk through both.

## Settings

| Variable | Default | What it is |
| --- | --- | --- |
| `XO_PK` | (required) | The private key of a wallet of your own, `0x` and 64 hex characters. It is never printed. |
| `XO_MARKET` | (required) | The market to quote: slug, XO's id, condition id or link. The first argument works too. |
| `XO_SIZE` | `1` | Shares per quote, at least 1. Keep it tiny: each quote locks up `price × size` USDC. |
| `XO_SPREAD_TICKS` | `2` | How many ticks either side of the midpoint. |
| `XO_REFERENCE_MID` | (none) | The midpoint to quote around when the book has none, such as `0.5`. Without it the bot waits for a two-sided book. |
| `XO_HEARTBEAT` | off | `1` turns the heartbeat on (every 5 s). |
| `XO_STORE` | `./.xo` | Where the credentials are kept (gitignored). One 90-day key is reused across restarts. |
| `XO_RUN_SECONDS` | (none) | Stop after this many seconds, cancelling everything. Without it the bot runs until Ctrl-C. |

**Small defaults.** The client trades on XO mainnet, the only environment. The default size is
1 share, the minimum order, so its two quotes lock up at most about 1 USDC at a time.

## At start: every order of the account in that market is cancelled

So that a restart begins clean, the bot calls `cancelMarketOrders({ market: conditionId })`
before it quotes. That cancels **every open order of the account in that market**, whichever bot, key or
person placed it, not only this bot's. Do not point it at a market where you keep other orders
on the same account.

## Never resending an order

When a placement fails with `mayHaveLanded: true` (a timeout, a network failure, a 5xx), its
orders may be on the book, or even filled, without the bot knowing. Placing a fresh pair then
could leave the old pair resting, unseen. So the bot latches (`unresolved.ts`):

- While any order's outcome is unknown, or its view of its resting quotes is stale (a cancel
  whose effect is unknown, a `user` topic that reconnected or dropped events), it **places
  nothing**.
- It only asks the orderbook: `reconcileOrder` for each unknown order, then the open orders of
  the market, which it adopts as its quotes. The same fault often makes these reads fail for a
  while, so it waits longer after each failed attempt (1 s, 2 s, 4 s, up to 30 s).
- An attempt counts only as a whole: the orders leave the latch only when every one has a
  definite answer **and** the open orders were read and agree (an order reported resting must
  be among them). A read that fails half-way settles nothing. A `user` topic that reconnects
  during the read keeps the view stale. After 8 failed attempts in a row the bot halts.
- The latch logic is a small module of its own, tested against a fake orderbook in the
  repository's `scripts/test/unresolved.test.ts`.

**A `not_found` halts the bot at once**, before anything else is asked. The orderbook not
finding an order is not proof that it was never placed: the request may still be in flight. So
the bot stops (cancelling everything) rather than quote next to an order it cannot see. **The
order can still land after the bot has stopped**, and then it rests with no bot watching it.
After such a halt, check the account's open orders a minute later
(`listOpenOrders()`, or the website) and cancel what is left (`cancelAll()`). With
the heartbeat on, the gateway's auto-cancel, about 30 s after the last heartbeat, also catches
an order that lands before it fires; one that lands later is not caught.

## The heartbeat: read this before turning it on

The heartbeat is a dead-man switch for the **whole account**, not for this bot. Once one valid
heartbeat arrives, the gateway cancels **every open order of the account, in every market,
placed by any bot or key**, if no heartbeat arrives for 30 s. A crash, a blocked event loop or
a suspended laptop then cancels everything within about 30 to 35 s.

Stopping the heartbeat does not opt the account out: the countdown from the last beat keeps
running. So the bot cancels on purpose at shutdown (`cancelAll()`), before it stops the
heartbeat. When heartbeats keep failing (4 misses in 30 s), the bot stops quoting.

## What it does not do

- **Inventory.** Fills leave the bot holding YES or NO shares, and it keeps quoting both sides
  regardless. One YES and one NO make a pair that `mergePositions({ conditionId })` turns back
  into 1 USDC, gas-free through XO's sponsor. Stop quoting that market before you merge.
- **Risk limits, fees, rewards scoring, several markets.** Liquidity Rewards pay for size near
  the midpoint, with a minimum order size per programme (`fetchMarket(...).rewards`).
  The default 1 share is usually below it.
