import type { Market, PublicClient } from '@xomarket/client';

type MarketLookupClient = Pick<
  PublicClient,
  'fetchMarket' | 'fetchOrderBook' | 'listMarkets'
>;

export async function findOrderExampleMarket(
  client: MarketLookupClient,
): Promise<Market> {
  const page = await client
    .listMarkets({
      sort: 'volume',
      pageSize: 50,
    })
    .firstPage();

  for (const candidate of page.items) {
    const market = await orderExampleMarket(client, candidate);

    if (market !== null) {
      return market;
    }
  }

  throw new Error(
    `Could not find a live market for the order example: none of the ${page.items.length} open markets with the most volume takes orders and has bids and asks`,
  );
}

async function orderExampleMarket(
  client: MarketLookupClient,
  candidate: Market,
): Promise<Market | null> {
  const assetId = candidate.outcomes.yes.tokenId;

  if (assetId === null) {
    return null;
  }

  try {
    const book = await client.fetchOrderBook({ assetId });

    if (book.asks.length === 0 || book.bids.length === 0) {
      return null;
    }
  } catch {
    return null;
  }

  // A listed market has no trading rules yet: fetching it joins the order book's.
  const market = await client.fetchMarket({ id: candidate.id });

  return market.state.acceptingOrders === true &&
    market.trading.minimumOrderSize !== null &&
    market.trading.minimumTickSize !== null
    ? market
    : null;
}
