// Code that docs/README.md quotes: type-checked, never run.

// #region quickstart
import { createPublicClient } from '@xomarket/client';

const client = createPublicClient();

const page = await client.listMarkets({ pageSize: 5 }).firstPage();

for (const market of page.items) {
  console.log(`${market.id}: ${market.question}`);
}
// #endregion quickstart
