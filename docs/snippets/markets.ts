// Code that docs/markets.md quotes: type-checked, never run.

import {
  createPublicClient,
  type Market,
  OrderSide,
  type PublicClient,
} from '@xomarket/client';

/** The public client: it needs no key. */
export function publicClient() {
  // #region client
  const client = createPublicClient();
  // #endregion client
  return client;
}

/** High-volume open markets, then the YES price of each. */
export async function listMarkets(client: PublicClient) {
  // #region list-markets
  const page = await client
    .listMarkets({ status: 'active', sort: 'volume', pageSize: 10 })
    .firstPage();

  for (const market of page.items) {
    console.log(
      `${market.id}: ${market.question} (volume ${market.metrics.volume})`,
    );
  }
  // #endregion list-markets

  // #region list-prices
  const assetIds = page.items.flatMap(
    (market) => market.outcomes.yes.tokenId ?? [],
  );
  const midpoints = await client.fetchMidpoints({ assetIds });

  console.table(
    page.items.map((market) => ({
      slug: market.slug,
      yes: midpoints[market.outcomes.yes.tokenId ?? ''] ?? 'no price',
    })),
  );
  // #endregion list-prices
}

/** Three pages of the open markets, then the page after them from its cursor. */
export async function walkPages(client: PublicClient) {
  // #region pagination
  const markets = client.listMarkets({ status: 'active', pageSize: 5 });

  let pageCount = 0;
  let cursor: string | undefined;

  for await (const page of markets) {
    pageCount += 1;
    console.log(`Page ${pageCount}`);
    for (const market of page.items) {
      console.log(`  ${market.id}: ${market.question}`);
    }
    cursor = page.nextCursor;
    if (pageCount === 3) {
      break;
    }
  }
  // #endregion pagination

  // #region pagination-cursor
  const next = await markets.from(cursor).firstPage();
  console.log(
    `Page 4 has ${next.items.length} market(s); more after it: ${next.hasMore}`,
  );
  // #endregion pagination-cursor
}

/** One market, read by its slug, by its link and by its id, then its main fields. */
export async function readMarket(client: PublicClient, listed: Market) {
  // #region fetch-market
  const bySlug = await client.fetchMarket({ slug: listed.slug });
  const byUrl = await client.fetchMarket({
    url: `https://xo.market/markets/${listed.slug}`,
  });
  const byId = await client.fetchMarket({ id: listed.id });
  // #endregion fetch-market

  // #region market-fields
  console.table({
    conditionId: byId.conditionId,
    yesToken: byId.outcomes.yes.tokenId,
    noToken: byId.outcomes.no.tokenId,
    yesPrice: byId.outcomes.yes.price,
    tickSize: byId.trading.minimumTickSize,
    minimumOrderSize: byId.trading.minimumOrderSize,
    endDate: byId.state.endDate,
  });
  // #endregion market-fields
  return [bySlug, byUrl, byId];
}

/** Says whether a market takes orders now, and why not. */
export async function checkTradable(client: PublicClient, conditionId: string) {
  // #region tradability
  const { ok, reasons } = await client.fetchMarketTradability({ conditionId });
  console.log(ok ? 'tradable' : `not tradable: ${reasons.join(', ')}`);
  // #endregion tradability
  return ok;
}

/** The prices of a market's YES token: book, best buy price, midpoint, spread and last trade. */
export async function readPrices(
  client: PublicClient,
  market: Market,
  assetId: string,
) {
  // #region prices
  const [orderBook, buyPrice, midpoint, spread, lastTrade] = await Promise.all([
    client.fetchOrderBook({ assetId }),
    client.fetchPrice({ assetId, side: OrderSide.BUY }),
    client.fetchMidpoint({ assetId }),
    client.fetchSpread({ assetId }),
    client.fetchLastTradePrice({ assetId }),
  ]);

  console.table({
    market: market.question,
    assetId,
    bids: orderBook.bids.length,
    asks: orderBook.asks.length,
    buyPrice: buyPrice ?? 'none',
    midpoint: midpoint ?? 'none',
    spread: spread ?? 'none',
    lastTradePrice: lastTrade?.price ?? 'none',
    lastTradeSide: lastTrade?.side ?? 'none',
  });
  // #endregion prices
}

/** The order book of a market's YES token: its five best bids and asks. */
export async function readBook(
  client: PublicClient,
  market: Market,
  assetId: string,
) {
  // #region book
  const book = await client.fetchOrderBook({ assetId });

  console.log(`${market.question}: tick ${book.minimumTickSize}`);
  console.log('Best bids, best first');
  console.table(book.bids.slice(-5).reverse());
  console.log('Best asks, best first');
  console.table(book.asks.slice(-5).reverse());
  // #endregion book
}

/** Reads an event with its markets, each under its label in the event. */
export async function readEvent(client: PublicClient, slug: string) {
  // #region event-markets
  const event = await client.fetchEvent({ slug });
  for (const market of event.markets ?? []) {
    console.log(`${market.groupItemTitle ?? market.slug}: ${market.question}`);
  }
  // #endregion event-markets
  return event;
}

/** The markets that pay Liquidity Rewards in USDC, and what an order must do to earn. */
export async function rewardsMarkets(client: PublicClient) {
  // #region rewards-markets
  const { items } = await client.listRewardPools().firstPage();

  const rows = items.flatMap((pool) =>
    pool.programmes
      .filter((programme) => programme.currency === 'USDC' && programme.active)
      .map((programme) => ({
        market: pool.market?.slug ?? pool.conditionId,
        usdcPerDay: programme.dailyPool ?? 'n/a',
        minShares: programme.terms.minOrderSize ?? 'n/a',
        maxCentsFromMid: programme.terms.maxDistanceCents ?? 'n/a',
        ends: programme.endsAt ?? 'n/a',
      })),
  );

  console.table(rows);
  // #endregion rewards-markets
}
