// Code that docs/manage-orders.md quotes: type-checked, never run.

import { type SecureClient, type SignedOrder, XoError } from '@xomarket/client';

export async function openOrders(client: SecureClient) {
  // #region open-orders
  for await (const page of client.listOpenOrders()) {
    for (const order of page.items) {
      console.log(`${order.side} ${order.originalSize} @ ${order.price}`);
    }
  }
  // #endregion open-orders
}

export async function oneOrder(client: SecureClient, orderId: string) {
  // #region fetch-order
  const order = await client.fetchOrder({ orderId });
  console.log(`${order.sizeMatched} of ${order.originalSize} filled`);
  // #endregion fetch-order
}

export async function trades(client: SecureClient) {
  // #region trades
  const { items } = await client.listAccountTrades().firstPage();

  for (const trade of items) {
    console.log(`${trade.side} ${trade.size} @ ${trade.price}`);
  }
  // #endregion trades
}

export async function cancel(client: SecureClient, orderIds: string[]) {
  // #region cancel
  const result = await client.cancelOrders({ orderIds });
  console.log(result.canceled); // the ids cancelled
  console.log(result.notCanceled); // the others, with XO's reason
  // #endregion cancel
}

export async function replaceOrders(
  client: SecureClient,
  orderIds: string[],
  replacement: SignedOrder,
) {
  // #region order-batch
  const results = await client.postOrderBatch({
    operations: [
      { type: 'cancel', orderIds }, // runs first
      { type: 'place', orders: [replacement] }, // signed by createLimitOrder
    ],
  });
  // #endregion order-batch
  return results;
}

export async function placeOnce(client: SecureClient, order: SignedOrder) {
  // #region reconcile-order
  try {
    await client.postOrder(order);
  } catch (error) {
    if (error instanceof XoError && error.mayHaveLanded) {
      const found = await client.reconcileOrder({ orderHash: order.orderHash });
      console.log(found.state);
    }
    throw error;
  }
  // #endregion reconcile-order
}

export function startHeartbeat(client: SecureClient) {
  // #region heartbeat
  const heartbeat = client.startOrderHeartbeat({
    onMissed: (error) => console.warn(`Heartbeat missed: ${error.code}`),
  });
  // #endregion heartbeat
  return heartbeat;
}

export async function shutDown(client: SecureClient) {
  // #region shut-down
  try {
    await client.cancelAll();
  } finally {
    await client.close();
  }
  // #endregion shut-down
}
