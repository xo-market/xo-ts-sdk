// Code that docs/deposits-and-withdrawals.md quotes: type-checked, never run.

import type {
  BridgeAsset,
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
  const done = await client.waitForBridgePayment({ paymentId });
  console.log(`${paymentId}: ${done.status}`);
  // #endregion deposit-wait
  return done;
}

export async function withdrawSteps(
  client: SecureClient,
  usdc: BridgeAsset,
  recipient: string,
) {
  // #region withdraw-quote
  const [quote] = await client.quoteWithdrawal({
    assetId: usdc.assetId,
    amount: '25',
    recipient,
  });
  if (quote === undefined) {
    throw new Error('No quote');
  }
  console.log(`${quote.output.amount} goes to ${quote.recipient}`);
  // #endregion withdraw-quote

  // #region withdraw-send
  const { payment, transaction } = await client.withdraw({ quote });
  console.log(`${payment.paymentId}: sent in ${transaction.transactionHash}`);
  // #endregion withdraw-send
  return payment;
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

export async function followPayment(client: SecureClient, paymentId: string) {
  // #region bridge-follow
  const payment = await client.fetchBridgePayment({ paymentId });
  console.log(`${payment.paymentId}: ${payment.status}`);

  const { items } = await client.listBridgePayments().firstPage();

  for (const p of items) {
    console.log(`${p.direction} ${p.paymentId}: ${p.status}`);
  }
  // #endregion bridge-follow
  return payment;
}
