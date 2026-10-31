// Code that docs/orders.md quotes: type-checked, never run.

import {
  OrderSide,
  OrderType,
  type SecureClient,
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
  const expiration = new Date(Date.now() + 5 * 60_000);
  const placed = await client.placeLimitOrder({
    assetId,
    side: OrderSide.BUY,
    price: tickSize,
    size: '1',
    postOnly: true,
    expiration,
  });
  console.log(
    placed.ok
      ? `${placed.status} until ${expiration.toISOString()}: ${placed.orderId}`
      : `Refused (${placed.code}): ${placed.message}`,
  );
  // #endregion gtd-order
}

/** Buys YES with up to 1 USDC now, at the prices on the book: a real trade. */
export async function buyNow(client: SecureClient, assetId: string) {
  // #region market-order
  const result = await client.placeMarketOrder({
    assetId,
    side: OrderSide.BUY,
    amount: '1',
    orderType: OrderType.FAK,
  });
  console.log(
    result.ok
      ? `${result.status}: spent ${result.makingAmount}, bought ${result.takingAmount}`
      : `No fill (${result.code}): ${result.message}`,
  );
  // #endregion market-order
  return result;
}

/** Signs a limit order without sending it. */
export async function signLimit(
  client: SecureClient,
  assetId: string,
  tickSize: string,
  minimumOrderSize: string,
) {
  // #region create-limit-order
  const order = await client.createLimitOrder({
    assetId,
    side: OrderSide.BUY,
    price: tickSize,
    size: minimumOrderSize,
    postOnly: true,
  });
  // #endregion create-limit-order
  return order;
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
    console.log(
      result.ok
        ? `${result.orderId}: ${result.status}`
        : `${result.orderHash}: refused (${result.code})`,
    );
  }
  // #endregion post-orders
  return results;
}

/** Cancels resting orders and places their replacement in one request. */
export async function replaceOrders(
  client: SecureClient,
  assetId: string,
  orderIds: string[],
) {
  // #region order-batch
  const order = await client.createLimitOrder({
    assetId,
    side: OrderSide.BUY,
    price: '0.41',
    size: '5',
    postOnly: true,
  });
  const results = await client.postOrderBatch({
    operations: [
      { type: 'cancel', orderIds },
      { type: 'place', orders: [order] },
    ],
  });
  for (const result of results) {
    console.log(
      result.type === 'cancel'
        ? `canceled ${result.canceled.length}, not canceled ${Object.keys(result.notCanceled).length}`
        : `placed ${result.orders.filter((placed) => placed.ok).length} of ${result.orders.length}`,
    );
  }
  // #endregion order-batch
  return results;
}

/** The account's open orders, in every market. */
export async function openOrders(client: SecureClient) {
  // #region open-orders
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
    console.log(
      placed.ok ? `${placed.status}: ${placed.orderId}` : placed.code,
    );
  } catch (error) {
    if (error instanceof XoError && error.mayHaveLanded) {
      const found = await client.reconcileOrder({ orderHash: order.orderHash });
      console.log(`Never resend it. reconcileOrder says ${found.state}`);
    }
    throw error;
  }
  // #endregion reconcile-order
}
