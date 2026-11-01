// Code that docs/withdraw.md quotes: type-checked, never run.

import type { SecureClient } from '@xomarket/client';

export async function withdrawSteps(client: SecureClient, recipient: string) {
  // #region withdraw-asset
  const { items } = await client
    .listBridgeAssets({ direction: 'withdraw' })
    .firstPage();
  const usdc = items.find((a) => a.symbol === 'USDC' && a.chain === 'base');
  if (usdc === undefined) {
    throw new Error('USDC on Base is not listed');
  }
  // #endregion withdraw-asset

  // #region withdraw-quote
  const [quote] = await client.quoteWithdrawal({
    assetId: usdc.assetId,
    amount: '25', // USDC out of XO
    recipient,
  });
  if (quote === undefined) {
    throw new Error('No quote');
  }
  console.log(`${quote.output.amount} goes to ${quote.recipient}`);
  // #endregion withdraw-quote

  // #region withdraw-send
  const { payment, transaction } = await client.withdraw({ quote });
  const receipt = await transaction.wait();
  console.log(`${payment.paymentId}: transfer ${receipt.status}`);
  // #endregion withdraw-send

  // #region withdraw-wait
  const done = await client.waitForBridgePayment({
    paymentId: payment.paymentId,
  });
  console.log(`${done.paymentId}: ${done.status}`);
  // #endregion withdraw-wait

  return done;
}
