// Code that docs/quickstart.md quotes and that its examples run: type-checked, never run.

import type { PublicClient } from '@xomarket/client';

/** Five open markets, each with its id: what list-markets.ts prints. */
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
