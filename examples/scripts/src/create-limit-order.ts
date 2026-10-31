import { createSecureClient, OrderSide } from '@xomarket/client';
import { privateKey } from '@xomarket/client/viem';
import { never } from './lib/assert';
import { requireEnv } from './lib/env';
import { findOrderExampleMarket } from './lib/markets';

const client = await createSecureClient({
  signer: privateKey(requireEnv('XO_PK')),
});

const market = await findOrderExampleMarket(client);
const assetId =
  market.outcomes.yes.tokenId ?? never('No YES token found for market');
const minimumTickSize =
  market.trading.minimumTickSize ?? never('No minimum tick size found');
const minimumOrderSize =
  market.trading.minimumOrderSize ?? never('No minimum order size found');

const order = await client.createLimitOrder({
  assetId,
  side: OrderSide.BUY,
  price: minimumTickSize,
  size: minimumOrderSize,
});

console.table({
  market: market.question,
  minimumTickSize,
  minimumOrderSize,
  assetId,
  side: order.wire.side,
  orderType: order.orderType,
  maker: order.wire.maker,
  makerAmount: order.wire.makerAmount,
  takerAmount: order.wire.takerAmount,
});
