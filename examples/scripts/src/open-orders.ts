import { createSecureClient } from '@xomarket/client';
import { privateKey } from '@xomarket/client/viem';
import { requireEnv } from './lib/env';

const client = await createSecureClient({
  signer: privateKey(requireEnv('XO_PK')),
});

const rows = [];

for await (const page of client.listOpenOrders()) {
  rows.push(
    ...page.items.map((order) => ({
      orderId: order.orderId,
      market: order.market,
      order: `${order.side} ${order.outcome} @ ${order.price}`,
      shares: order.originalSize,
      filled: order.sizeMatched,
      type: order.orderType,
    })),
  );
}

console.log(`${rows.length} open order(s)`);
console.table(rows);
