import { beforeAll, expect, test } from 'vitest';
import {
  assertEmptyWallet,
  describeSignedIn,
  e2eClient,
  live,
  statusOf,
  trackClients,
} from './setup';

// A live read of the e2e wallet's balances and trading approvals, through a secure client (one
// sign-in, strict responses). It sends nothing: the order book's `GET /positions` and the
// chain's `eth_call` and `eth_getCode` are reads. Only addresses, amounts and HTTP statuses are
// printed.

describeSignedIn('Balances and approvals (live, signed in)', () => {
  const clients = trackClients();

  beforeAll(async () => {
    const xo = await e2eClient();
    try {
      await assertEmptyWallet(xo);
    } finally {
      await xo.close();
    }
  });

  test('EOA: fetchBalances and fetchTradingApprovalsState of the e2e wallet', async () => {
    const { client, calls } = await clients.create();
    const balances = await live('fetchBalances', () => client.fetchBalances());
    console.info(
      `[e2e] EOA ${client.wallet} order book cash ${balances.collateral} positions ${balances.positions.length}`,
    );
    // The e2e wallet holds nothing on the order book.
    expect(Number(balances.collateral)).toBe(0);
    expect(balances.positions).toEqual([]);
    expect(statusOf(calls, 'GET', 'orderbook', '/positions')).toBe(200);

    // What it set up for trading is read on chain and sent nowhere.
    const approvals = await live('fetchTradingApprovalsState', () =>
      client.fetchTradingApprovalsState(),
    );
    // A plain wallet is always deployed; what it approved is the wallet's own business.
    expect(approvals.deployed).toBe(true);
    expect(typeof approvals.ready).toBe('boolean');
    expect(typeof approvals.usdcApproved).toBe('boolean');
    expect(typeof approvals.conditionalTokensApproved).toBe('boolean');
  }, 180_000);
});
