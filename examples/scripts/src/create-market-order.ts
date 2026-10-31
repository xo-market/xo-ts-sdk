import { createSecureClient, OrderSide, OrderType } from '@xomarket/client';
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
const minimumOrderSize =
  market.trading.minimumOrderSize ?? never('No minimum order size found');

const order = await client.createMarketOrder({
  assetId,
  side: OrderSide.BUY,
  amount: minimumOrderSize,
  orderType: OrderType.FAK,
});

console.table({
  market: market.question,
  minimumOrderSize,
  assetId,
  side: order.wire.side,
  orderType: order.orderType,
  maker: order.wire.maker,
  makerAmount: order.wire.makerAmount,
  takerAmount: order.wire.takerAmount,
});
