// Code that docs/place-orders.md quotes: type-checked, never run.

import { OrderSide, OrderType, type SecureClient } from '@xomarket/client';

export async function placeLimit(client: SecureClient, assetId: string) {
  // #region limit-order
  const placed = await client.placeLimitOrder({
    assetId, // the outcome's token id
    side: OrderSide.BUY,
    price: '0.45', // USDC per share
    size: '10', // shares
  });
  // #endregion limit-order
  return placed;
}

export async function placePostOnly(client: SecureClient, assetId: string) {
  // #region post-only
  const placed = await client.placeLimitOrder({
    assetId,
    side: OrderSide.BUY,
    price: '0.45',
    size: '10',
    postOnly: true, // refused if it would trade at once
  });
  // #endregion post-only
  return placed;
}

export async function placeExpiring(client: SecureClient, assetId: string) {
  // #region expiring-order
  const placed = await client.placeLimitOrder({
    assetId,
    side: OrderSide.BUY,
    price: '0.45',
    size: '10',
    expiration: new Date(Date.now() + 5 * 60_000), // ends in 5 minutes
  });
  // #endregion expiring-order
  return placed;
}

export async function placeMarket(client: SecureClient, assetId: string) {
  // #region market-order
  const bought = await client.placeMarketOrder({
    assetId,
    side: OrderSide.BUY,
    amount: '5', // spends up to 5 USDC
  });

  const sold = await client.placeMarketOrder({
    assetId,
    side: OrderSide.SELL,
    shares: '5',
    orderType: OrderType.FOK, // all 5 shares, or none
  });
  // #endregion market-order
  return [bought, sold];
}

export async function createThenPost(client: SecureClient, assetId: string) {
  // #region create-post
  const order = await client.createLimitOrder({
    assetId,
    side: OrderSide.BUY,
    price: '0.45',
    size: '10',
  });
  console.log(order.orderHash); // keep it to look the order up

  const placed = await client.postOrder(order);
  // #endregion create-post
  return placed;
}

export async function placeMany(client: SecureClient, assetId: string) {
  // #region post-orders
  const orders = [
    await client.createLimitOrder({
      assetId,
      side: OrderSide.BUY,
      price: '0.40',
      size: '5',
    }),
    await client.createLimitOrder({
      assetId,
      side: OrderSide.BUY,
      price: '0.39',
      size: '5',
    }),
  ];
  const results = await client.postOrders(orders); // sent 300 to a request

  for (const result of results) {
    console.log(result.ok ? result.status : result.code);
  }
  // #endregion post-orders
  return results;
}

export async function readResult(client: SecureClient, assetId: string) {
  const placed = await placeLimit(client, assetId);
  // #region read-result
  if (placed.ok) {
    console.log(`${placed.orderId} is ${placed.status}`);
  } else {
    console.log(`Refused (${placed.code}): ${placed.message}`);
  }
  // #endregion read-result
}
