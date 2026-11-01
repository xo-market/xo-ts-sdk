import { createPublicClient, OrderSide } from '@xomarket/client';
import { never } from './lib/assert';

const client = createPublicClient();

const {
  items: [market],
} = await client
  .listMarkets({
    pageSize: 1,
  })
  .firstPage();

const assetId =
  market?.outcomes.yes.tokenId ?? never('No YES token found for market');

const [orderBook, bestBid, midpoint, spread, lastTrade] = await Promise.all([
  client.fetchOrderBook({ assetId }),
  client.fetchPrice({ assetId, side: OrderSide.BUY }),
  client.fetchMidpoint({ assetId }),
  client.fetchSpread({ assetId }),
  client.fetchLastTradePrice({ assetId }),
]);

console.table({
  market: market?.question ?? never(),
  assetId,
  bids: orderBook.bids.length,
  asks: orderBook.asks.length,
  bestBid,
  midpoint,
  spread,
  lastTradePrice: lastTrade?.price ?? 'N/A',
  lastTradeSide: lastTrade?.side ?? 'N/A',
});
