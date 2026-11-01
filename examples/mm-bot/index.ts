// mm-bot: a DEMO market-making bot for XO Market on mainnet. It is an example of the SDK, not
// a strategy, and NOT financial advice. It trades real USDC. Read ./README.md before running it.
//
// In a project of your own: `npm install @xomarket/client viem@2.57.7` and `npm install -D tsx`, then
// copy this folder. In this repository: `pnpm install` and `pnpm -C packages/client build`.
//
//   read -rs XO_PK && export XO_PK    # paste the key: not echoed, not kept in the history
//   XO_MARKET=<market slug or id> npx tsx mm-bot/index.ts      (here: pnpm --filter @xomarket/mm-bot start)
//
// Or keep the key in a gitignored .env file: `npx tsx --env-file=.env mm-bot/index.ts`. Avoid
// `XO_PK=0x… cmd`, which writes the key into your shell history.
//
// It quotes both sides of one market with post-only orders, 2 ticks either side of the
// midpoint: a BUY of YES below it, and a BUY of NO that is a YES offer above it (a NO bid at q
// is a YES ask at 1 - q), so it needs USDC only. It re-quotes when the book moves
// (`price_change`), logs its fills from the `user` topic, and cancels everything on Ctrl-C.
// The heartbeat dead-man switch is opt-in (XO_HEARTBEAT=1). Every setting is in README.md.

import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  BatchOpsIncompleteError,
  BatchPlaceIncompleteError,
  type CredentialStore,
  createSecureClient,
  type FetchMarketRequest,
  type OpenOrder,
  type OrderBook,
  type OrderHeartbeat,
  type OrderResponse,
  OrderSide,
  type SecureClient,
  type SignedOrder,
  type UserOrderEvent,
  type UserTradeEvent,
  XoError,
} from '@xomarket/client';
import { fileStore } from '@xomarket/client/node';
import { privateKey } from '@xomarket/client/viem';
import { formatUnits, parseUnits } from 'viem';
import { pass, Unresolved } from './unresolved.js';

export interface BotConfig {
  /** The wallet's private key, with or without 0x. */
  privateKey: string;
  /** The market: slug, backend id or condition id. */
  market: string;
  /** Shares per quote. Keep it tiny: the USDC is real. */
  size: string;
  /** How many ticks either side of the midpoint. */
  spreadTicks: number;
  /** Send heartbeats (the account-wide 30 s dead-man switch). Opt-in. */
  heartbeat: boolean;
  /** The midpoint to quote around when the book has none (an empty or one-sided book). */
  referenceMid?: string;
  /** Where the credentials are kept, as a file store (`store` takes precedence). */
  storeDir: string;
  /** A credential store of your own instead of `fileStore(storeDir)`. */
  store?: CredentialStore;
  /** Stop (and cancel everything) after this many seconds. Runs until Ctrl-C without it. */
  runSeconds?: number;
  /**
   * Stops the bot when aborted. Without it the bot handles SIGINT and SIGTERM itself; with
   * it, the caller does.
   */
  signal?: AbortSignal;
  log?: (line: string) => void;
}

/** One USDC, or one share: both have 6 decimals. */
const ONE = 1_000_000n;
const micro = (value: string): bigint => parseUnits(value, 6);
const whole = (value: bigint): string => formatUnits(value, 6);
const short = (id: string): string =>
  id.length > 16 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id;

/** How long stopping may take before the bot gives up on it (and says so). */
const STOP_TIMEOUT_MS = 20_000;
/** The pause after the gateway refused a set of quotes; it doubles while the same set is refused. */
const REFUSAL_PAUSE_MS = 5000;
const MAX_REFUSAL_PAUSE_MS = 60_000;

/** The market the bot quotes: what it needs of it, every field known. */
interface BotMarket {
  id: string;
  slug: string;
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  tickSize: string;
}

/** A quote the bot has resting: which token, at what price, how many shares. */
interface Quote {
  tokenId: string;
  outcome: 'YES' | 'NO';
  price: bigint;
  size: bigint;
}

type Levels = readonly { price: string; size: string }[];

/**
 * The best price of one side of a book, in micro-USDC, leaving out the bot's own quotes
 * (`own`: price → shares), so the bot never quotes around itself.
 */
function bestOf(
  levels: Levels,
  side: 'bid' | 'ask',
  own: ReadonlyMap<bigint, bigint> = new Map(),
): bigint | undefined {
  let top: bigint | undefined;
  for (const level of levels) {
    const price = micro(level.price);
    const others = micro(level.size) - (own.get(price) ?? 0n);
    if (
      others > 0n &&
      (top === undefined || (side === 'bid' ? price > top : price < top))
    ) {
      top = price;
    }
  }
  return top;
}

/** A set of quotes, as a key: the same tokens at the same prices give the same key. */
const keyOf = (quotes: Iterable<Quote>): string =>
  [...quotes]
    .map((q) => `${q.tokenId}@${q.price}`)
    .sort()
    .join(',');

/**
 * Runs the bot until Ctrl-C (or `runSeconds`, or `signal`), then cancels everything and
 * closes. A failure to start (sign-in, setup, the market) is thrown after the client is
 * closed; before the first quote nothing is cancelled but the start-up cancel of the bot's
 * own market, which runs once the market is found.
 */
export async function runBot(config: BotConfig): Promise<void> {
  const log =
    config.log ??
    ((line: string) =>
      console.log(`${new Date().toISOString().slice(11, 19)} ${line}`));
  const size = micro(config.size);
  const reference =
    config.referenceMid === undefined ? undefined : micro(config.referenceMid);

  // Persistent credentials by default (one 90-day key across restarts). The bot handles the
  // signals itself, so the SDK's shutdown hooks are off. The client signs in here.
  const client = await createSecureClient({
    signer: privateKey(withPrefix(config.privateKey)),
    store: config.store ?? fileStore(config.storeDir),
    label: 'mm-bot',
    shutdownHooks: false,
  });

  /** The quotes resting now, by order hash. */
  let live = new Map<string, Quote>();
  /** The quotes the bot is cancelling itself, so their CANCELLATION frames are expected. */
  const cancelling = new Set<string>();
  /** The never-resend latch: while it is blocked, the bot reconciles and places nothing. */
  const unresolved = new Unresolved();
  /** The last set of quotes the gateway refused, and until when the bot leaves it alone. */
  let refused: { key: string; count: number; until: number } | undefined;
  /** Whether "no midpoint" was logged since the last quote, so it is said once. */
  let saidNoMid = false;
  /** Set once the bot stops quoting: on Ctrl-C, at the end of `runSeconds`, or on a halt. */
  let stopping = false;
  /** The pass in progress, and whether another one was asked for meanwhile. */
  let busy: Promise<void> | undefined;
  let again = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  /** The one timer of a later pass, and when it fires (the earliest one asked for wins). */
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryAt = Number.POSITIVE_INFINITY;
  /** Set while a placement (postOrders, postOrderBatch) is in flight. */
  let placing = false;
  let heartbeat: OrderHeartbeat | undefined;
  let market: BotMarket | undefined;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  // ---------------------------------------------------------------------------
  // Stopping: once quoting began, cancel everything (every market); then stop the
  // heartbeat and close.
  // ---------------------------------------------------------------------------
  const stop = async (reason: string, exitCode = 0): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    clearTimeout(debounce);
    clearTimeout(retry);
    // Before the first quote the bot has placed nothing, and the account's other orders are
    // not its own: a failed start or an early Ctrl-C skips cancelAll().
    const quoted = market !== undefined;
    log(
      quoted
        ? `stopping (${reason}): cancelling everything`
        : `stopping (${reason}) before quoting: cancelling nothing`,
    );
    let code = exitCode;
    const work = async () => {
      if (!quoted) {
        await client.close();
        return;
      }
      // Never interrupt a placement half-way: let one in flight finish first, for a while.
      // A pass that only reconciles (the latch is blocked) sends nothing, so it is not waited
      // for, and cancelAll starts well within the cap either way.
      if (placing && busy !== undefined) {
        await Promise.race([
          busy.catch(() => undefined),
          sleep(STOP_TIMEOUT_MS / 2, undefined, { ref: false }),
        ]);
        if (placing) {
          log(
            'a placement is still in flight: cancelling anyway (an order of it may land later: check your open orders)',
          );
        }
      }
      // The bot places nothing now, so a cancelAll that failed is safe to send once more.
      try {
        const cancelled = await client.cancelAll().catch((error: unknown) => {
          log(`cancelAll failed: ${describe(error)}. Sending it once more`);
          return client.cancelAll();
        });
        log(`cancelAll canceled ${cancelled.canceled.length} order(s)`);
      } catch (error) {
        log(`cancelAll FAILED: ${describe(error)}. Check your open orders!`);
        code = 1;
      }
      await client.close();
    };
    // Bounded: a hung request must not keep the bot from exiting.
    const finished = await Promise.race([
      work().then(
        () => true,
        (error: unknown) => {
          log(`closing failed: ${describe(error)}`);
          code = 1;
          return true;
        },
      ),
      sleep(STOP_TIMEOUT_MS, false, { ref: false }),
    ]);
    if (!finished) {
      log(
        `stopping took over ${STOP_TIMEOUT_MS / 1000} s: check your open orders`,
      );
      code = 1;
    }
    // Stopping the heartbeat does not opt out of its auto-cancel. After a cancelAll that
    // worked there is nothing left for it; after one that did not finish, the gateway's
    // auto-cancel 30 s after this last beat is the fallback.
    heartbeat?.stop();
    process.exitCode = code;
    resolveDone();
  };
  const halt = (why: string): void => {
    log(`HALT: ${why}`);
    void stop('halted', 1);
  };
  if (config.signal === undefined) {
    process.once('SIGINT', () => void stop('Ctrl-C'));
    process.once('SIGTERM', () => void stop('SIGTERM'));
  } else if (config.signal.aborted) {
    void stop('aborted');
  } else {
    config.signal.addEventListener('abort', () => void stop('aborted'), {
      once: true,
    });
  }

  // ---------------------------------------------------------------------------
  // Quoting
  // ---------------------------------------------------------------------------

  /**
   * The bot's own shares per price on each side of each book. The orderbook lists every order
   * on both books: a BUY of YES at p is a YES bid at p and also a NO ask at 1 - p (and a BUY
   * of NO at q a NO bid at q and a YES ask at 1 - q), so both are left out.
   */
  const ownLevels = (m: BotMarket) => {
    const levels = {
      yes: { bids: new Map<bigint, bigint>(), asks: new Map<bigint, bigint>() },
      no: { bids: new Map<bigint, bigint>(), asks: new Map<bigint, bigint>() },
    };
    const add = (map: Map<bigint, bigint>, price: bigint, shares: bigint) => {
      map.set(price, (map.get(price) ?? 0n) + shares);
    };
    for (const q of live.values()) {
      const [own, other] =
        q.tokenId === m.yesTokenId
          ? [levels.yes, levels.no]
          : [levels.no, levels.yes];
      add(own.bids, q.price, q.size);
      add(other.asks, ONE - q.price, q.size);
    }
    return levels;
  };

  /** The quotes the bot wants now, from the books without its own orders. */
  const target = (m: BotMarket, yes: OrderBook, no: OrderBook) => {
    const own = ownLevels(m);
    // The best YES bid and ask of the whole market: a NO ask at q is a YES bid at 1 - q, and
    // a NO bid at q a YES ask at 1 - q.
    const flip = (p: bigint | undefined) =>
      p === undefined ? undefined : ONE - p;
    const bids = [
      bestOf(yes.bids, 'bid', own.yes.bids),
      flip(bestOf(no.asks, 'ask', own.no.asks)),
    ].filter((p): p is bigint => p !== undefined);
    const asks = [
      bestOf(yes.asks, 'ask', own.yes.asks),
      flip(bestOf(no.bids, 'bid', own.no.bids)),
    ].filter((p): p is bigint => p !== undefined);
    const bestBid =
      bids.length === 0 ? undefined : bids.reduce((a, b) => (a > b ? a : b));
    const bestAsk =
      asks.length === 0 ? undefined : asks.reduce((a, b) => (a < b ? a : b));
    const mid =
      bestBid !== undefined && bestAsk !== undefined
        ? (bestBid + bestAsk) / 2n
        : reference;
    if (mid === undefined) {
      return { mid, quotes: [] as Quote[] };
    }
    const tick = micro(m.tickSize);
    const midTick = (mid / tick) * tick;
    const bid = midTick - BigInt(config.spreadTicks) * tick;
    const ask = midTick + BigInt(config.spreadTicks) * tick;
    const quotes: Quote[] = [];
    // Post-only: a side that would cross the others' book is left out, not sent.
    if (bid >= tick && (bestAsk === undefined || bid < bestAsk)) {
      quotes.push({ tokenId: m.yesTokenId, outcome: 'YES', price: bid, size });
    }
    if (ask <= ONE - tick && (bestBid === undefined || ask > bestBid)) {
      quotes.push({
        tokenId: m.noTokenId,
        outcome: 'NO',
        price: ONE - ask,
        size,
      });
    }
    return { mid, quotes };
  };

  /** The resting quotes from the orderbook itself: the truth after a gap or an unknown outcome. */
  const resync = async (m: BotMarket): Promise<void> => {
    const open: OpenOrder[] = [];
    for await (const page of client.listOpenOrders({ market: m.conditionId })) {
      open.push(...page.items);
    }
    live = new Map(
      open.map((order) => [
        order.orderId.toLowerCase(),
        {
          tokenId: order.assetId,
          outcome: order.assetId === m.yesTokenId ? 'YES' : 'NO',
          price: micro(order.price),
          size: micro(order.originalSize) - micro(order.sizeMatched),
        },
      ]),
    );
    log(`resynced: ${live.size} quote(s) resting`);
  };

  /**
   * Runs a pass in `ms` (a retry of the latch, or the end of a refusal pause). There is one
   * timer: a later request never pushes back an earlier one, and every pass that still has to
   * wait asks again. Nothing is scheduled once the bot is stopping.
   */
  const passIn = (ms: number, why: string): void => {
    if (stopping) {
      return;
    }
    const at = Date.now() + Math.max(ms, 0);
    if (retry !== undefined && retryAt <= at) {
      return;
    }
    clearTimeout(retry);
    retryAt = at;
    retry = setTimeout(
      () => {
        retry = undefined;
        retryAt = Number.POSITIVE_INFINITY;
        requote(why);
      },
      Math.max(at - Date.now(), 0),
    );
  };

  /** Notes a refusal of `key`: the same quotes are left alone for a while, longer each time. */
  const noteRefusal = (key: string): void => {
    const count = refused?.key === key ? refused.count + 1 : 1;
    const pause = Math.min(
      MAX_REFUSAL_PAUSE_MS,
      REFUSAL_PAUSE_MS * 2 ** (count - 1),
    );
    refused = { key, count, until: Date.now() + pause };
    log(`  the same quotes wait ${pause / 1000} s before they are tried again`);
    passIn(pause, 'refusal pause over');
  };

  /** Cancels the resting quotes and places `orders`, in one request when there are both. */
  const replace = async (
    orders: readonly SignedOrder[],
    quotes: readonly Quote[],
  ): Promise<void> => {
    const key = keyOf(quotes);
    const byHash = new Map(
      orders.map((o, i) => [o.orderHash.toLowerCase(), quotes[i] as Quote]),
    );
    const cancel = [...live.keys()];
    for (const id of cancel) {
      cancelling.add(id);
    }
    let refusals = 0;
    const placed = (response: OrderResponse) => {
      const hash = response.orderHash;
      const quote = byHash.get(hash.toLowerCase());
      if (!response.ok || quote === undefined) {
        refusals += 1;
        log(
          `  refused ${short(hash)}: ${response.ok ? 'not one of the orders sent' : `${response.code} (${response.message})`}`,
        );
        return;
      }
      live.set(hash.toLowerCase(), quote);
      log(
        `  quoting BUY ${quote.outcome} ${whole(quote.size)} @ ${whole(quote.price)} (${short(hash)})`,
      );
    };
    try {
      if (cancel.length === 0) {
        for (const response of await client.postOrders([...orders])) {
          placed(response);
        }
      } else {
        const results = await client.postOrderBatch({
          operations:
            orders.length === 0
              ? [{ type: 'cancel', orderIds: cancel }]
              : [
                  { type: 'cancel', orderIds: cancel },
                  { type: 'place', orders: [...orders] },
                ],
        });
        for (const result of results) {
          if (result.type === 'cancel') {
            // Canceled, or not open any more ("order not found": filled or already gone).
            const gone = new Set(
              [...result.canceled, ...Object.keys(result.notCanceled)].map(
                (id) => id.toLowerCase(),
              ),
            );
            for (const id of cancel) {
              if (gone.has(id)) {
                live.delete(id);
              }
            }
            const stuck = Object.values(result.notCanceled).filter(
              (why) => !/not found/i.test(why),
            );
            if (stuck.length > 0) {
              // Not sure what rests now: read the open orders before placing again.
              log(
                `  ${stuck.length} quote(s) not canceled: ${stuck.join('; ')}`,
              );
              unresolved.markStale();
              passIn(1000, 'resync');
            }
          } else {
            for (const response of result.orders) {
              placed(response);
            }
          }
        }
      }
      if (refusals > 0) {
        noteRefusal(key);
      } else if (refused?.key === key) {
        refused = undefined;
      }
    } catch (error) {
      const unknown =
        error instanceof BatchPlaceIncompleteError
          ? error.failedChunk
          : error instanceof BatchOpsIncompleteError
            ? error.orderHashes
            : orders.map((o) => o.orderHash);
      if (error instanceof XoError && error.mayHaveLanded !== false) {
        // The orders may be on the book, and the cancels may have run: latch, and place
        // nothing until the orderbook says where things are.
        log(`placement outcome unknown: ${describe(error)}`);
        unresolved.add(unknown);
        passIn(0, 'reconcile');
        return;
      }
      // Refused before anything was sent (mayHaveLanded false): nothing was placed or canceled.
      log(`placement refused: ${describe(error)}`);
      noteRefusal(key);
    } finally {
      for (const id of cancel) {
        cancelling.delete(id);
      }
    }
  };

  /**
   * One pass: while the latch is blocked, it only reconciles and resyncs (`pass` in
   * ./unresolved.ts); once it is clear, it reads the books and re-quotes.
   */
  const quoteOnce = async (m: BotMarket, why: string): Promise<void> => {
    const wasBlocked = unresolved.blocked;
    const outcome = await pass(unresolved, {
      reconcileOrder: async (hash) => {
        const found = await client.reconcileOrder({ orderHash: hash });
        log(`  ${short(hash)} may have landed: ${found.state}`);
        return found;
      },
      resync: async () => {
        await resync(m);
        return new Set(live.keys());
      },
      now: () => Date.now(),
      quote: async () => {
        if (wasBlocked) {
          log('reconciled: quoting again');
        }
        await quoteNow(m, why);
      },
    });
    if (outcome.kind === 'halt') {
      halt(
        outcome.error === undefined
          ? outcome.reason
          : `${outcome.reason} (${describe(outcome.error)})`,
      );
    } else if (outcome.kind === 'wait') {
      const wait = outcome.at - Date.now();
      if (outcome.error !== undefined) {
        log(
          `cannot reconcile yet (${describe(outcome.error)}): trying again in ${Math.ceil(Math.max(wait, 0) / 1000)} s, placing nothing`,
        );
      }
      passIn(wait, 'reconcile');
    }
  };

  /** Reads the books and re-quotes when the target moved. Only `pass` calls it. */
  const quoteNow = async (m: BotMarket, why: string): Promise<void> => {
    const [yes, no] = await client.fetchOrderBooks({
      assetIds: [m.yesTokenId, m.noTokenId],
    });
    if (yes === undefined || no === undefined) {
      throw new Error('the books are missing');
    }
    const { mid, quotes } = target(m, yes, no);
    if (mid === undefined && !saidNoMid) {
      log(
        'no two-sided book to take a midpoint from, and no XO_REFERENCE_MID: not quoting',
      );
    }
    saidNoMid = mid === undefined;
    const key = keyOf(quotes);
    if (key === keyOf(live.values())) {
      return;
    }
    if (refused?.key === key && Date.now() < refused.until) {
      // The gateway refused these very quotes a moment ago: try again when the pause is over.
      passIn(refused.until - Date.now(), 'refusal pause over');
      return;
    }
    log(
      `re-quoting (${why}) around ${mid === undefined ? 'nothing' : whole(mid)}`,
    );
    const orders: SignedOrder[] = [];
    for (const q of quotes) {
      orders.push(
        await client.createLimitOrder({
          assetId: q.tokenId,
          side: OrderSide.BUY,
          price: whole(q.price),
          size: whole(q.size),
          postOnly: true,
        }),
      );
    }
    if (orders.length === 0 && live.size === 0) {
      return;
    }
    // A last check: the latch may have closed while the orders were being signed.
    if (stopping || unresolved.blocked) {
      return;
    }
    placing = true;
    try {
      await replace(orders, quotes);
    } finally {
      placing = false;
    }
  };

  /** Re-quotes now, one pass at a time; a call during a pass runs one more pass after it. */
  const requote = (why: string): void => {
    if (stopping || market === undefined) {
      return;
    }
    if (busy !== undefined) {
      again = true;
      return;
    }
    const m = market;
    busy = (async () => {
      let reason = why;
      do {
        again = false;
        try {
          await quoteOnce(m, reason);
        } catch (error) {
          log(`re-quote failed: ${describe(error)}`);
        }
        reason = 'queued';
      } while (again && !stopping);
    })().finally(() => {
      busy = undefined;
    });
  };

  /** Book updates come in bursts: re-quote once they settle. */
  const soon = (why: string): void => {
    if (stopping) {
      return;
    }
    clearTimeout(debounce);
    debounce = setTimeout(() => requote(why), 1000);
  };

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------
  /** The `user` topic, this market's part: fills, and cancels the bot did not make. */
  const onOrder = (e: UserOrderEvent): void => {
    const id = e.orderId?.toLowerCase() ?? '';
    if (e.kind === 'UPDATE') {
      log(
        `FILL ${e.side} ${e.outcome} ${e.sizeMatched}/${e.originalSize} @ ${e.price} (${e.status})`,
      );
      const quote = live.get(id);
      if (quote !== undefined && e.status === 'MATCHED') {
        live.delete(id);
        soon('filled');
      } else if (
        quote !== undefined &&
        e.originalSize !== null &&
        e.sizeMatched !== null
      ) {
        // Partly filled: the rest still rests.
        quote.size = micro(e.originalSize) - micro(e.sizeMatched);
      }
    } else if (e.kind === 'CANCELLATION') {
      // The bot's own cancels are expected; any other one (the heartbeat's auto-cancel, an
      // expiry, the market closing, a balance that dropped) leaves a side unquoted.
      const own = cancelling.has(id) || stopping;
      if (live.delete(id) && !own) {
        log(`quote ${short(id)} canceled by the gateway`);
        soon('canceled');
      }
    } else if (e.kind === 'REJECTED') {
      log(`order rejected: ${e.reason}`);
    }
  };
  const onTrade = (e: UserTradeEvent): void => {
    log(
      e.status === 'MATCHED'
        ? `TRADE ${e.traderSide} ${e.side} ${e.size} ${e.outcome} @ ${e.price} (${short(e.id)})`
        : `trade ${short(e.id)} ${e.status}`,
    );
  };

  try {
    log(`signed in as ${client.wallet}`);
    const setup = await client.setupTradingApprovals();
    if (setup !== null) {
      log(`setup sent in ${setup.transactionHash}`);
    }
    const m = await resolveMarket(client, config.market);
    log(
      `market ${m.id} ${m.slug}, tick ${m.tickSize}; size ${config.size}, ±${config.spreadTicks} ticks`,
    );
    // A restart starts clean: every open order of the ACCOUNT in this market is canceled,
    // whichever bot or key placed it (see examples/mm-bot/README.md).
    const stale = await client.cancelMarketOrders({ market: m.conditionId });
    if (stale.canceled.length > 0) {
      log(`canceled ${stale.canceled.length} stale order(s) in this market`);
    }

    // One subscription: the market's book moves, and the account's orders and trades (the
    // `user` topic covers every market, so the events of other markets are left out).
    const stream = await client.subscribe([
      { topic: 'market', markets: [m.conditionId] },
      { topic: 'user' },
    ]);
    // The topics do not replay what a reconnect missed: read the open orders again before
    // placing anything (the latch does it on the next pass).
    stream.on('reconnected', ({ topic }) => {
      if (topic === 'user') {
        unresolved.markStale();
      }
      soon(`${topic} reconnected`);
    });
    stream.on('error', (e) => {
      log(`${e.topic ?? 'subscription'} error ${e.code}`);
      if (
        e.code === 'subscription_overflow' ||
        e.code === 'ws_events_dropped'
      ) {
        unresolved.markStale();
        soon('events dropped');
      }
    });
    void (async () => {
      for await (const event of stream) {
        if (event.type === 'price_change') {
          soon('price_change');
        } else if (event.type === 'order' && event.market === m.conditionId) {
          onOrder(event);
        } else if (event.type === 'trade' && event.market === m.conditionId) {
          onTrade(event);
        }
      }
    })().catch((error: unknown) =>
      log(`subscription ended: ${describe(error)}`),
    );

    // The heartbeat, only when asked for: a dead-man switch for the WHOLE account.
    if (config.heartbeat) {
      const misses: number[] = [];
      heartbeat = client.startOrderHeartbeat({
        intervalMs: 5000,
        onMissed: (error) => {
          const now = Date.now();
          misses.push(now);
          while (misses.length > 0 && (misses[0] ?? now) < now - 30_000) {
            misses.shift();
          }
          log(`heartbeat missed (${error.code}): ${misses.length} in 30 s`);
          // Four misses in 30 s: the gateway may already have cancelled everything.
          if (misses.length >= 4) {
            halt('heartbeats keep failing: stop quoting');
          }
        },
      });
      log(
        'heartbeat on: the gateway cancels every order of the account 30 s after the last beat',
      );
    }

    market = m;
    requote('start');
    if (config.runSeconds !== undefined) {
      const seconds = config.runSeconds;
      const timer = setTimeout(
        () => void stop(`${seconds} s are up`),
        seconds * 1000,
      );
      void done.then(() => clearTimeout(timer));
    }
    log('running: Ctrl-C cancels everything and stops');
    await done;
  } catch (error) {
    await stop('failed to start', 1);
    throw error;
  } finally {
    // Give the last log lines (cancel frames, close) a moment.
    await sleep(100);
  }
}

/** Reads the market and checks it can be traded now; refuses one without an order book. */
async function resolveMarket(
  client: SecureClient,
  wanted: string,
): Promise<BotMarket> {
  const found = await client.fetchMarket(marketRequest(wanted));
  const { conditionId } = found;
  const yesTokenId = found.outcomes.yes.tokenId;
  const noTokenId = found.outcomes.no.tokenId;
  const tickSize = found.trading.minimumTickSize;
  if (
    conditionId === null ||
    yesTokenId === null ||
    noTokenId === null ||
    tickSize === null
  ) {
    throw new Error(`market ${found.id} has no order book`);
  }
  const tradable = await client.fetchMarketTradability({ conditionId });
  if (!tradable.ok) {
    throw new Error(
      `market ${found.id} is not tradable: ${tradable.reasons.join(', ')}`,
    );
  }
  return {
    id: found.id,
    slug: found.slug,
    conditionId,
    yesTokenId,
    noTokenId,
    tickSize,
  };
}

/** A market by slug, XO's id, condition id or link. */
function marketRequest(wanted: string): FetchMarketRequest {
  if (/^0x[0-9a-fA-F]{64}$/.test(wanted)) {
    return { conditionId: wanted };
  }
  if (/^\d+$/.test(wanted)) {
    return { id: wanted };
  }
  return wanted.startsWith('https://') ? { url: wanted } : { slug: wanted };
}

const PRIVATE_KEY = /^(?:0[xX])?[0-9a-fA-F]{64}$/;

const withPrefix = (key: string): string => `0x${key.trim().slice(-64)}`;

/** A log-safe description: the SDK's errors redact themselves. */
function describe(error: unknown): string {
  return error instanceof XoError
    ? `${error.name} ${error.code}${error.mayHaveLanded === undefined ? '' : ` mayHaveLanded=${error.mayHaveLanded}`}: ${error.message}`
    : String(error);
}

/** The configuration from the environment (see README.md). Tiny defaults. */
export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BotConfig | string {
  const privateKey = env.XO_PK?.trim() ?? '';
  const market = (env.XO_MARKET ?? process.argv[2] ?? '').trim();
  if (privateKey === '') {
    return 'Set XO_PK to the private key of a wallet of your own (see the top of mm-bot/index.ts for how to keep it out of your shell history).';
  }
  // The message never repeats the value.
  if (!PRIVATE_KEY.test(privateKey)) {
    return 'XO_PK is not a private key: expected 64 hex characters, with or without 0x.';
  }
  if (market === '') {
    return 'Set XO_MARKET (or pass an argument): the market to quote, by slug, id or condition id.';
  }
  const size = env.XO_SIZE?.trim() || '1';
  if (!/^\d+(\.\d{1,6})?$/.test(size) || Number(size) < 1) {
    return 'XO_SIZE must be a number of shares, at least 1 (at most 6 decimals).';
  }
  const spreadTicks = Number(env.XO_SPREAD_TICKS ?? '2');
  if (!Number.isInteger(spreadTicks) || spreadTicks < 1) {
    return 'XO_SPREAD_TICKS must be a whole number, 1 or more.';
  }
  const referenceMid = env.XO_REFERENCE_MID?.trim() || undefined;
  if (referenceMid !== undefined && !/^0\.\d{1,6}$/.test(referenceMid)) {
    return 'XO_REFERENCE_MID must be a price between 0 and 1, such as 0.5.';
  }
  const runSeconds =
    env.XO_RUN_SECONDS === undefined ? undefined : Number(env.XO_RUN_SECONDS);
  if (
    runSeconds !== undefined &&
    (!Number.isFinite(runSeconds) || runSeconds <= 0)
  ) {
    return 'XO_RUN_SECONDS must be a number of seconds above 0.';
  }
  return {
    privateKey,
    market,
    size,
    spreadTicks,
    heartbeat: env.XO_HEARTBEAT === '1',
    referenceMid,
    storeDir: env.XO_STORE?.trim() || './.xo',
    runSeconds,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const config = configFromEnv();
  if (typeof config === 'string') {
    console.error(config);
    process.exitCode = 1;
  } else {
    runBot(config).catch((error: unknown) => {
      console.error(`mm-bot failed: ${describe(error)}`);
      process.exitCode = 1;
    });
  }
}
