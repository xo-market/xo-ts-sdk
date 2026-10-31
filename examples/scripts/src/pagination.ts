import { createPublicClient } from '@xomarket/client';

const client = createPublicClient();

const markets = client.listMarkets({
  pageSize: 5,
});

let pageCount = 0;

// List methods return async paginators, so you can loop through pages with for await.
for await (const page of markets) {
  pageCount += 1;

  console.log(`Page ${pageCount}`);

  for (const market of page.items) {
    console.log(`${market.id}: ${market.question}`);
  }

  if (pageCount === 3) {
    break;
  }
}
