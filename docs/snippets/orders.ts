// Code that docs/orders.md quotes: type-checked, never run.

import {
  OrderSide,
  type SecureClient,
  type SignedOrder,
  XoError,
} from '@xomarket/client';

/** Places a 1-share order at the lowest price, so it rests, then cancels it. */
export async function placeAndCancel(
  client: SecureClient,
  assetId: string,
  tickSize: string,
) {
  // #region place
  const placed = await client.placeLimitOrder({
    assetId,
    side: OrderSide.BUY,
    price: tickSize,
    size: '1',
    postOnly: true,
  });
  console.log(
    placed.ok
      ? `BUY 1 YES @ ${tickSize} is ${placed.status}: ${placed.orderId}`
      : `Refused (${placed.code}): ${placed.message}`,
  );
  // #endregion place

  // #region cancel
  if (placed.ok) {
    const { canceled } = await client.cancelOrder({ orderId: placed.orderId });
    console.log(`Canceled ${canceled.length} order(s)`);
  }
  // #endregion cancel
}

/** Places an order that ends by itself in 5 minutes. */
export async function placeGtd(
  client: SecureClient,
  assetId: string,
  tickSize: string,
) {
  // #region gtd-order
  const placed = await client.placeLimitOrder({
    assetId,
    side: OrderSide.BUY,
    price: tickSize,
    size: '1',
    expiration: new Date(Date.now() + 5 * 60_000),
  });
  // #endregion gtd-order
  return placed;
}

/** Buys YES with up to 1 USDC now, at the prices on the book: a real trade. */
export async function buyNow(client: SecureClient, assetId: string) {
  // #region market-order
  const result = await client.placeMarketOrder({
    assetId,
    side: OrderSide.BUY,
    amount: '1',
  });
  console.log(result.ok ? result.status : result.code);
  // #endregion market-order
  return result;
}

/** Signs two orders, then places them in one request. */
export async function placeMany(client: SecureClient, assetId: string) {
  // #region post-orders
  const orders = [
    await client.createLimitOrder({
      assetId,
      side: OrderSide.BUY,
      price: '0.40',
      size: '5',
      postOnly: true,
    }),
    await client.createLimitOrder({
      assetId,
      side: OrderSide.BUY,
      price: '0.39',
      size: '5',
      postOnly: true,
    }),
  ];
  const results = await client.postOrders(orders);

  for (const result of results) {
    console.log(result.ok ? result.status : result.code);
  }
  // #endregion post-orders
  return results;
}

/** Cancels resting orders and places their replacement in one request. */
export async function replaceOrders(
  client: SecureClient,
  orderIds: string[],
  order: SignedOrder,
) {
  // #region order-batch
  const results = await client.postOrderBatch({
    operations: [
      { type: 'cancel', orderIds },
      { type: 'place', orders: [order] },
    ],
  });
  // #endregion order-batch
  return results;
}

/** The account's open orders, in every market. */
export async function openOrders(client: SecureClient) {
  // #region open-orders
  for await (const page of client.listOpenOrders()) {
    for (const order of page.items) {
      console.log(`${order.side} ${order.originalSize} @ ${order.price}`);
    }
  }
  // #endregion open-orders
}

/** Places a signed order once, and finds it when the placement may have landed. */
export async function placeOnce(client: SecureClient, assetId: string) {
  // #region reconcile-order
  const order = await client.createLimitOrder({
    assetId,
    side: OrderSide.BUY,
    price: '0.40',
    size: '5',
  });

  try {
    const placed = await client.postOrder(order);
    console.log(placed.ok ? placed.status : placed.code);
  } catch (error) {
    if (error instanceof XoError && error.mayHaveLanded) {
      const found = await client.reconcileOrder({ orderHash: order.orderHash });
      console.log(`Do not place it again. It is ${found.state}`);
    }
    throw error;
  }
  // #endregion reconcile-order
}
