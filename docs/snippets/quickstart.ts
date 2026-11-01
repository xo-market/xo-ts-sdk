// Code that docs/quickstart.md quotes, one region per step: type-checked, never run.

// #region sign-in
import { createSecureClient, OrderSide } from '@xomarket/client';
import { privateKey } from '@xomarket/client/viem';

const client = await createSecureClient({
  signer: privateKey(process.env.XO_PK ?? ''),
});
// #endregion sign-in

// #region setup
await client.setupTradingApprovals();
// #endregion setup

// #region choose
const market = await client.fetchMarket({ slug: 'your-market-slug' });
const assetId = market.outcomes.yes.tokenId;
if (assetId === null) {
  throw new Error('This market has no YES outcome');
}
// #endregion choose

// #region order
const order = await client.placeMarketOrder({
  assetId,
  side: OrderSide.BUY,
  amount: '1', // spends up to 1 USDC
});

console.log(order.ok ? order.status : `Refused: ${order.code}`);
// #endregion order

// #region position
const { items } = await client.listPositions().firstPage();

for (const position of items) {
  console.log(`${position.title}: ${position.currentSize} shares`);
}
// #endregion position
