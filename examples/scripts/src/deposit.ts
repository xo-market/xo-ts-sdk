import { createSecureClient } from '@xomarket/client';
import { privateKey } from '@xomarket/client/viem';
import { never } from './lib/assert';
import { requireEnv } from './lib/env';

const client = await createSecureClient({
  signer: privateKey(requireEnv('XO_PK')),
});

const { items } = await client
  .listBridgeAssets({ direction: 'deposit' })
  .firstPage();
const usdc =
  items.find((asset) => asset.symbol === 'USDC' && asset.chain === 'base') ??
  never('USDC on Base is not on the deposit list');

const [quote] = await client.quoteDeposit({
  assetId: usdc.assetId,
  amount: process.env.XO_DEPOSIT?.trim() || '5',
});
const best = quote ?? never('No quote for this amount');
console.log(`${best.input.amount} in, ${best.output.amount} USDC out`);

const payment = await client.createDeposit({ quote: best });
const { paymentId, status, deposit } = payment;
if (status !== 'AWAITING_FUNDS' || deposit === null) {
  never(
    `Payment ${paymentId} is ${status}, with no deposit address yet: send nothing`,
  );
}
console.log(
  `Payment ${paymentId}: send exactly ${deposit.amount} of ${deposit.assetId} on ${deposit.chain} to ${deposit.address}, once, before ${payment.fundBy}`,
);
console.log(
  `If this stops after you sent the funds, the payment goes on: do not send again, and follow it with waitForBridgePayment({ paymentId: '${paymentId}' }). If you sent nothing, send nothing: the payment expires at ${payment.fundBy}`,
);

const done = await client.waitForBridgePayment(
  { paymentId },
  { timeout: 30 * 60_000 },
);
console.log(`The deposit is ${done.status}: only COMPLETE delivered`);
