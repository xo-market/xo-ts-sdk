import { createPublicClient } from '@xomarket/client';

const client = createPublicClient();

const { items } = await client
  .listMarkets({
    pageSize: 10,
  })
  .firstPage();

try {
  const stream = await client.subscribe([
    {
      topic: 'market',
      markets: items.flatMap((market) => market.conditionId ?? []),
    },
  ]);
  let eventCount = 0;
  for await (const event of stream) {
    if (event.type === 'book') {
      console.log(
        'Book:',
        event.assetId,
        event.bids.length,
        'bids',
        event.asks.length,
        'asks',
      );
    } else if (event.type === 'last_trade_price') {
      console.log('Trade:', event.side, event.size, '@', event.price);
    } else {
      console.log('Price changes:', event.priceChanges.length);
    }
    if (++eventCount === 10) break;
  }
} finally {
  await client.closeSubscriptions();
}
