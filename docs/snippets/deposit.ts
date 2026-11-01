// Code that docs/deposit.md quotes: type-checked, never run.

import type {
  DepositQuote,
  SecureClient,
  VerificationRequest,
  VerifyCallback,
} from '@xomarket/client';

export async function depositSteps(client: SecureClient) {
  // #region deposit-asset
  const { items } = await client
    .listBridgeAssets({ direction: 'deposit' })
    .firstPage();
  const usdc = items.find((a) => a.symbol === 'USDC' && a.chain === 'base');
  if (usdc === undefined) {
    throw new Error('USDC on Base is not listed');
  }
  // #endregion deposit-asset

  // #region deposit-quote
  const [quote] = await client.quoteDeposit({
    assetId: usdc.assetId,
    amount: '25',
  });
  if (quote === undefined) {
    throw new Error('No quote');
  }
  console.log(`${quote.output.amount} USDC lands, fees ${quote.fees.total}`);
  // #endregion deposit-quote

  // #region deposit-confirm
  const payment = await client.createDeposit({ quote });
  const { deposit } = payment;
  if (payment.status !== 'AWAITING_FUNDS' || deposit === null) {
    throw new Error(`${payment.paymentId} is ${payment.status}: send nothing`);
  }
  console.log(
    `Send ${deposit.amount} to ${deposit.address} on ${deposit.chain} before ${payment.fundBy}`,
  );
  // #endregion deposit-confirm

  return payment;
}

export async function waitForDeposit(client: SecureClient, paymentId: string) {
  // #region deposit-wait
  const done = await client.waitForBridgePayment({ paymentId }); // up to an hour
  console.log(`${paymentId}: ${done.status}`);
  // #endregion deposit-wait
  return done;
}

export async function bridgeVerify(
  client: SecureClient,
  quote: DepositQuote,
  approve: (request: VerificationRequest) => Promise<boolean>,
) {
  // #region bridge-verify
  const verify: VerifyCallback = (request) => {
    console.log(`${request.paymentId} asks you to sign:`, request.decoded);
    return approve(request);
  };

  const payment = await client.createDeposit({ quote, verify });
  // #endregion bridge-verify
  return payment;
}
