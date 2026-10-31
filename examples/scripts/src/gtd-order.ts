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
const tickSize =
  market.trading.minimumTickSize ?? never('No minimum tick size found');

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
