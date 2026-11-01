// Code that docs/quickstart.md quotes, the same as in the example it runs: type-checked, never run.

import type { PublicClient } from '@xomarket/client';

export async function listMarkets(client: PublicClient) {
  // #region list-markets
  const page = await client
    .listMarkets({
      pageSize: 5,
    })
    .firstPage();

  for (const market of page.items) {
    console.log(`${market.id}: ${market.question}`);
  }
  // #endregion list-markets
}
