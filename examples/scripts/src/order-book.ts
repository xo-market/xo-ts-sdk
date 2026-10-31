import { createPublicClient } from '@xomarket/client';
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

const orderBook = await client.fetchOrderBook({ assetId });

console.log(
  `${market?.question ?? never()}: tick ${orderBook.minimumTickSize}`,
);
console.log('Best bids, best first');
console.table(orderBook.bids.slice(-5).reverse());
console.log('Best asks, best first');
console.table(orderBook.asks.slice(-5).reverse());
