// Code that docs/deposits-and-withdrawals.md quotes: type-checked, never run.

import {
  type DepositQuote,
  type SecureClient,
  type VerifyCallback,
  XoError,
} from '@xomarket/client';

/** A deposit of 25 USDC from Base, step by step, up to the instructions of what to send. */
export async function depositSteps(client: SecureClient) {
  // #region deposit-asset
  const { items } = await client
    .listBridgeAssets({ direction: 'deposit' })
    .firstPage();
  const usdc = items.find((a) => a.symbol === 'USDC' && a.chain === 'base');
  if (usdc === undefined) {
    throw new Error('USDC on Base is not on the deposit list');
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
  console.log(
    `${quote.input.amount} in, ${quote.output.amount} USDC out, fees ${quote.fees.total} ${quote.fees.currency}, confirm before ${quote.acceptBy}`,
  );
  // #endregion deposit-quote

  // #region deposit-confirm
  const payment = await client.createDeposit({ quote });
  if (payment.status !== 'AWAITING_FUNDS' || payment.deposit === null) {
    throw new Error(`${payment.paymentId} is ${payment.status}: send nothing`);
  }
  console.log(
    `Send ${payment.deposit.amount} of ${payment.deposit.assetId} to ${payment.deposit.address} before ${payment.fundBy}`,
  );
  // #endregion deposit-confirm

  return payment;
}

/** Waits up to 30 minutes for a deposit to be final. */
export async function waitForDeposit(client: SecureClient, paymentId: string) {
  // #region deposit-wait
  const done = await client.waitForBridgePayment(
    { paymentId },
    { timeout: 30 * 60_000 },
  );
  console.log(`The deposit is ${done.status}: only COMPLETE delivered`);
  // #endregion deposit-wait
  return done;
}

/** A withdrawal of 25 USDC to `recipient`, an address of yours on Base, step by step. */
export async function withdrawSteps(client: SecureClient, recipient: string) {
  // #region withdraw-quote
  const { items } = await client
    .listBridgeAssets({ direction: 'withdraw' })
    .firstPage();
  const usdc = items.find((a) => a.symbol === 'USDC' && a.chain === 'base');
  if (usdc === undefined) {
    throw new Error('USDC on Base is not on the withdraw list');
  }
  const [quote] = await client.quoteWithdrawal({
    assetId: usdc.assetId,
    amount: '25',
    recipient,
  });
  if (quote === undefined) {
    throw new Error('No quote');
  }
  console.log(
    `${quote.input.amount} USDC out, ${quote.output.amount} to ${quote.recipient}`,
  );
  // #endregion withdraw-quote

  // #region withdraw-send
  const { payment, transaction } = await client.withdraw({ quote });
  console.log(
    `Payment ${payment.paymentId}: transfer in transaction ${transaction.transactionHash}`,
  );
  // #endregion withdraw-send
  return payment;
}

/** Deposits with a callback that shows the owner what the bridge asks to be signed. */
export async function bridgeVerify(
  client: SecureClient,
  quote: DepositQuote,
  approve: (summary: string) => Promise<boolean>,
) {
  // #region bridge-verify
  const verify: VerifyCallback = async (request) => {
    const { decoded } = request;
    const what =
      decoded.kind === 'eip712'
        ? `typed data ${decoded.typedData.primaryType}, domain ${JSON.stringify(decoded.typedData.domain)}, message ${JSON.stringify(decoded.typedData.message)}`
        : `message ${JSON.stringify(decoded.message)}`;
    return approve(`Payment ${request.paymentId} (${request.reason}): ${what}`);
  };
  const payment = await client.createDeposit({ quote, verify });
  // #endregion bridge-verify
  return payment;
}

/** Waits for a payment, reads it after a timeout, and lists the latest withdrawals. */
export async function followPayment(client: SecureClient, paymentId: string) {
  // #region bridge-follow
  try {
    await client.waitForBridgePayment({ paymentId }, { timeout: 30 * 60_000 });
  } catch (error) {
    if (!(error instanceof XoError && error.code === 'bridge_wait_timeout')) {
      throw error;
    }
  }
  const payment = await client.fetchBridgePayment({ paymentId });
  console.log(`${payment.paymentId}: ${payment.status}`);

  const { items } = await client
    .listBridgePayments({ direction: 'withdraw' })
    .firstPage();
  console.table(items.map((p) => ({ id: p.paymentId, status: p.status })));
  // #endregion bridge-follow
  return payment;
}
