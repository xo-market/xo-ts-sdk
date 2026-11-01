// Code that docs/README.md quotes: type-checked, never run.

import { createPublicClient } from '@xomarket/client';

const client = createPublicClient();
const assetId = '';

// #region realtime
const stream = await client.subscribe([
  { topic: 'market', assetIds: [assetId] },
]);

for await (const event of stream) {
  if (event.type === 'book') {
    console.log(`${event.bids.length} bids, ${event.asks.length} asks`);
  }
}
// #endregion realtime
