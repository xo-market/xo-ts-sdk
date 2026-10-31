import { createPublicClient } from '@xomarket/client';

const client = createPublicClient();

const page = await client
  .listMarkets({
    pageSize: 5,
  })
  .firstPage();

for (const market of page.items) {
  console.log(`${market.id}: ${market.question}`);
}
