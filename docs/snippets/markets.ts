// Code that docs/markets.md quotes: type-checked, never run.

import {
  createPublicClient,
  type Market,
  OrderSide,
  type Page,
  type PublicClient,
} from '@xomarket/client';

export function publicClient() {
  // #region client
  const client = createPublicClient();
  // #endregion client
  return client;
}

export async function listMarkets(client: PublicClient) {
  // #region list-markets
  const page = await client
    .listMarkets({ sort: 'volume', pageSize: 10 })
    .firstPage();

  for (const market of page.items) {
    console.log(`${market.id}: ${market.question}`);
  }
  // #endregion list-markets
  return page;
}

export async function walkPages(client: PublicClient) {
  // #region pagination
  for await (const page of client.listMarkets({ pageSize: 50 })) {
    for (const market of page.items) {
      console.log(market.question);
    }
  }
  // #endregion pagination
}

export async function readMarket(client: PublicClient, slug: string) {
  // #region fetch-market
  const market = await client.fetchMarket({ slug });

  console.log(market.question);
  console.log('YES token:', market.outcomes.yes.tokenId);
  console.log('Tick size:', market.trading.minimumTickSize);
  // #endregion fetch-market
  return market;
}

export async function checkTradable(client: PublicClient, conditionId: string) {
  // #region tradability
  const { ok, reasons } = await client.fetchMarketTradability({ conditionId });
  console.log(ok ? 'tradable' : `not tradable: ${reasons.join(', ')}`);
  // #endregion tradability
  return ok;
}

export async function readPrices(client: PublicClient, assetId: string) {
  // #region prices
  const [midpoint, bestBid, spread, lastTrade] = await Promise.all([
    client.fetchMidpoint({ assetId }),
    client.fetchPrice({ assetId, side: OrderSide.BUY }),
    client.fetchSpread({ assetId }),
    client.fetchLastTradePrice({ assetId }),
  ]);

  console.log({ midpoint, bestBid, spread, lastTrade: lastTrade?.price });
  // #endregion prices
}

export async function priceMany(client: PublicClient, page: Page<Market>) {
  // #region list-prices
  const assetIds = page.items.flatMap(
    (market) => market.outcomes.yes.tokenId ?? [],
  );
  const midpoints = await client.fetchMidpoints({ assetIds });

  for (const assetId of assetIds) {
    console.log(assetId, midpoints[assetId] ?? 'no price');
  }
  // #endregion list-prices
}

export async function readBook(client: PublicClient, assetId: string) {
  // #region book
  const book = await client.fetchOrderBook({ assetId });

  console.log('Best bid:', book.bids.at(-1));
  console.log('Best ask:', book.asks.at(-1));
  // #endregion book
}

export async function readEvent(client: PublicClient, slug: string) {
  // #region event-markets
  const event = await client.fetchEvent({ slug });

  for (const market of event.markets ?? []) {
    console.log(`${market.groupItemTitle ?? market.slug}: ${market.question}`);
  }
  // #endregion event-markets
  return event;
}

export async function rewardsMarkets(client: PublicClient) {
  // #region rewards-markets
  const { items } = await client.listRewardPools().firstPage();

  for (const pool of items) {
    for (const programme of pool.programmes) {
      console.log(
        pool.market?.slug ?? pool.conditionId,
        `${programme.dailyPool} ${programme.currency} a day`,
      );
    }
  }
  // #endregion rewards-markets
}
