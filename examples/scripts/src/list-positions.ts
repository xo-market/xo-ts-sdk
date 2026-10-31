import { createPublicClient } from '@xomarket/client';
import { requireEnv } from './lib/env';

const client = createPublicClient();

const wallet = requireEnv('XO_WALLET');
const positions = client.listPositions({
  user: wallet,
});

const rows = [];

for await (const page of positions) {
  rows.push(
    ...page.items.map((position) => ({
      title: position.title,
      outcome: position.outcome ?? '',
      size: position.currentSize,
      currentValue: position.currentValue,
      avgPrice: position.avgPrice ?? '',
      curPrice: position.currentPrice ?? '',
      redeemable: position.redeemable,
      assetId: position.assetId ?? '',
    })),
  );
}

console.log(`Found ${rows.length} positions for ${wallet}`);
console.table(rows);
