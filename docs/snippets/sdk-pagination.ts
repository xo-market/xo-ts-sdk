// Code that docs/README.md quotes: type-checked, never run.

import { createPublicClient } from '@xomarket/client';

const client = createPublicClient();

// #region pagination
const markets = client.listMarkets({ pageSize: 50 });

for await (const page of markets) {
  console.log(`${page.items.length} markets`);
}

const first = await markets.firstPage();
const next = await markets.from(first.nextCursor).firstPage();
// #endregion pagination

console.log(next.hasMore);
