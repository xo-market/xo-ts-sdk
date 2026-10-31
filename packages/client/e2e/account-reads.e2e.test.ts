import { randomBytes } from 'node:crypto';
import { getAddress } from 'viem';
import { beforeAll, expect, test } from 'vitest';
import { isRejected, XoError } from '../src/core/errors';
import type { Position } from '../src/index';
import { rewardedMarket } from './discover';
import {
  assertEmptyWallet,
  describeLive,
  describeSignedIn,
  e2eClient,
  live,
  revokeSucceeded,
  statusOf,
  strictPublicClient,
  trackClients,
} from './setup';

// The account reads of the two clients against the real mainnet backend, with strict
// responses, so a field the backend adds, drops or types differently fails the call.
//
// - The public reads (`listPositions` of a wallet, `fetchPublicProfile`, `fetchUserStats`) run
//   with no credentials: the wallet is a maker found in the reward pools who holds positions,
//   the user name a trader of the busiest market.
// - The reads of the account's own run with ONE secure client of the e2e wallet, which mints a
//   1-day API key that `close()` revokes. The wallet holds nothing and never trades, so these
//   calls check the envelopes (the empty lists, the zeroed totals) and the errors; the shape of
//   a row is checked on the public twins, which run the same mappers.
//
// Only reads are made, besides signing in and out, and no credential is printed.

const DECIMAL = /^-?\d+(\.\d+)?$/;
const WALLET = /^0x[0-9a-fA-F]{40}$/;

/** A position row: its amounts are exact text, its wallet an address. */
function expectPosition(position: Position): void {
  expect(position.wallet).toMatch(WALLET);
  for (const amount of [
    position.currentSize,
    position.currentValue,
    position.entryCostUsdc,
    position.unrealizedPnl,
    position.percentPnl,
  ]) {
    expect(amount).toMatch(DECIMAL);
  }
  expect(typeof position.redeemable).toBe('boolean');
  expect(position.title.length).toBeGreaterThan(0);
}

describeLive('Live account reads on mainnet: public reads (strict)', () => {
  const client = strictPublicClient();

  let username: string;
  let wallet: string;
  let first: Position;

  beforeAll(async () => {
    // A trader of the busiest market, from its own public feed.
    const markets = await live('listMarkets (setup)', () =>
      client.listMarkets({ sort: 'volume', pageSize: 3 }).firstPage(),
    );
    const names: string[] = [];
    for (const market of markets.items) {
      const trades = await live(`listTrades (setup, ${market.id})`, () =>
        client.listTrades({ marketId: market.id, pageSize: 50 }).firstPage(),
      );
      for (const trade of trades.items) {
        if (trade.username !== null) {
          names.push(trade.username);
        }
      }
      if (names.length > 0) {
        break;
      }
    }
    expect(names.length, 'the feed has traders').toBeGreaterThan(0);
    username = names[0] as string;

    // A maker of the reward pools whose wallet holds positions, the first one that does.
    const found = await rewardedMarket(client);
    for (const maker of [...new Set(found.makers.map((m) => m.wallet))]) {
      const page = await live(`listPositions (setup, ${maker})`, () =>
        client.listPositions({ user: maker }).firstPage(),
      );
      if (page.items[0] !== undefined) {
        wallet = maker;
        first = page.items[0];
        break;
      }
    }
    expect(first, 'a maker of the reward pools has positions').toBeDefined();
  });

  test('listPositions: the rows parse, in every filter, and the list ends', async () => {
    const seen = new Set<string>();
    let pages = 0;
    for await (const page of client.listPositions({ user: wallet })) {
      pages += 1;
      for (const position of page.items) {
        expectPosition(position);
        expect(position.wallet.toLowerCase()).toBe(wallet.toLowerCase());
        seen.add(position.positionId);
      }
      expect(pages, 'the walk ends').toBeLessThan(50);
    }
    expect(seen.size).toBeGreaterThan(0);

    // `redeemable` splits the list.
    for (const redeemable of [true, false]) {
      const page = await live(`listPositions (redeemable ${redeemable})`, () =>
        client.listPositions({ user: wallet, redeemable }).firstPage(),
      );
      for (const position of page.items) {
        expect(position.redeemable).toBe(redeemable);
      }
    }

    // One market only.
    if (first.conditionId !== null) {
      const conditionId = first.conditionId;
      const ofMarket = await live('listPositions (market)', () =>
        client.listPositions({ user: wallet, market: conditionId }).firstPage(),
      );
      expect(ofMarket.items.length).toBeGreaterThan(0);
      for (const position of ofMarket.items) {
        expect(position.conditionId).toBe(conditionId);
      }
    }
  });

  test('the wallet in any case reaches the same positions', async () => {
    const lower = await live('listPositions (lower case)', () =>
      client.listPositions({ user: wallet.toLowerCase() }).firstPage(),
    );
    const checksummed = await live('listPositions (checksummed)', () =>
      client.listPositions({ user: getAddress(wallet) }).firstPage(),
    );
    expect(checksummed.items.map((p) => p.positionId)).toEqual(
      lower.items.map((p) => p.positionId),
    );
  });

  test('fetchPublicProfile and fetchUserStats', async () => {
    const profile = await live('fetchPublicProfile', () =>
      client.fetchPublicProfile({ username }),
    );
    expect(profile.username.toLowerCase()).toBe(username.toLowerCase());
    expect(typeof profile.isPrivate).toBe('boolean');
    const stats = await live('fetchUserStats', () =>
      client.fetchUserStats({ username }),
    );
    if (stats.tradedMarketCount !== null) {
      expect(typeof stats.tradedMarketCount).toBe('number');
    }
    if (stats.volume !== null) {
      expect(stats.volume).toMatch(DECIMAL);
    }
  });

  test('an unknown user is a 404 rejection, and an address nobody uses lists nothing', async () => {
    const missing = `nobody_${Date.now().toString(36)}`;
    for (const run of [
      () => client.fetchPublicProfile({ username: missing }),
      () => client.fetchUserStats({ username: missing }),
    ]) {
      const failure = await live('unknown user', async () =>
        run().then(
          () => undefined,
          (error: unknown) => error,
        ),
      );
      expect(isRejected(failure, 404)).toBe(true);
    }
    // The backend answers a wallet it does not know with its unknown-user 404, or an empty list.
    const stranger = getAddress(`0x${randomBytes(20).toString('hex')}`);
    const page = await client
      .listPositions({ user: stranger })
      .firstPage()
      .catch((error: unknown) => {
        if (isRejected(error, 404)) {
          return { items: [] as Position[] };
        }
        throw error;
      });
    expect(page.items).toEqual([]);
  });

  test('a request that is not valid is refused before anything is sent', () => {
    let refused: unknown;
    try {
      client.listPositions({ user: '0x12' });
    } catch (error) {
      refused = error;
    }
    expect(refused).toMatchObject({ code: 'invalid_input' });
    // The reads of an account's own need a signed-in client.
    expect(client).not.toHaveProperty('fetchProfile');
    expect(client).not.toHaveProperty('listApiKeys');
  });
});

describeSignedIn(
  'Live account reads on mainnet: the e2e wallet (strict)',
  () => {
    // The e2e wallet's EOA, one login: the 1-day API key is revoked by close() after the test.
    const clients = trackClients();

    beforeAll(async () => {
      const xo = await e2eClient();
      try {
        await assertEmptyWallet(xo);
      } finally {
        await xo.close();
      }
    });

    test('every read of the account answers for an account that holds nothing, the envelopes parse, and the errors are typed', async () => {
      const { client, calls } = await clients.create();
      const lower = client.wallet.toLowerCase();
      const credentials = await client.exportCredentials();
      const failures: string[] = [];
      /** Runs a step; a failure is recorded and the next step still runs, so one run shows every mismatch. */
      const step = async (label: string, run: () => Promise<void>) => {
        try {
          await live(label, run);
        } catch (error) {
          failures.push(
            `${label}: ${error instanceof XoError ? `${error.name} ${error.code}: ${error.message}` : String(error)}`,
          );
        }
      };
      const rejection = async (run: () => Promise<unknown>) =>
        run().then(
          () => undefined,
          (error: unknown) => error,
        );

      await step('fetchProfile', async () => {
        const profile = await client.fetchProfile();
        expect(profile.wallet.toLowerCase()).toBe(lower);
        expect(profile.username.length).toBeGreaterThan(0);
        expect(profile.isPrivate).toBe(false);
      });

      await step('listApiKeys', async () => {
        const keys: Array<{ id: string; revokedAt: string | null }> = [];
        for await (const page of client.listApiKeys()) {
          keys.push(...page.items);
        }
        const own = keys.find((key) => key.id === credentials.backend.id);
        expect(own, 'the client key is listed').toBeDefined();
        expect(own?.revokedAt).toBeNull();
        // A key is never listed: booleans, so a failure cannot show one in a diff.
        expect(JSON.stringify(keys).includes(credentials.backend.apiKey)).toBe(
          false,
        );
      });

      await step('listPositions', async () => {
        for (const request of [
          {},
          { redeemable: true },
          { redeemable: false },
        ]) {
          const page = await client.listPositions(request).firstPage();
          expect(page.items).toEqual([]);
          expect(page.hasMore).toBe(false);
        }
        // The same wallet, named: the public read agrees.
        const named = await client
          .listPositions({ user: client.wallet })
          .firstPage();
        expect(named.items).toEqual([]);
      });

      await step('fetchPortfolioValue', async () => {
        const value = await client.fetchPortfolioValue();
        expect(value.value).toMatch(DECIMAL);
        expect(value.cash).toMatch(DECIMAL);
        expect(value.positionsValue).toMatch(DECIMAL);
        expect(value.claimableAmount).toMatch(DECIMAL);
        expect(typeof value.unpricedPositionCount).toBe('number');
      });

      await step('fetchUserPnl', async () => {
        const summary = await client.fetchUserPnl();
        expect(summary.positions).toEqual([]);
        expect(summary.pnl).toMatch(DECIMAL);
        const [market] = (await client.listMarkets({ pageSize: 1 }).firstPage())
          .items;
        for (const run of [
          () =>
            client.fetchUserPnl({ marketId: (market as { id: string }).id }),
          () => client.fetchUserPnl({ positionId: '1' }),
        ]) {
          const failure = await rejection(run);
          expect(failure).toBeInstanceOf(XoError);
          // 404 for a market or position the account has none in, 403 for one it does not own.
          expect([403, 404]).toContain((failure as XoError).status);
        }
      });

      await step('listActivity', async () => {
        const page = await client.listActivity({ pageSize: 5 }).firstPage();
        expect(page.items).toEqual([]);
        const redeems = await client
          .listActivity({ type: 'REDEEM' })
          .firstPage();
        expect(redeems.items).toEqual([]);
      });

      await step('listOpenOrders and listAccountTrades', async () => {
        const orders = await client.listOpenOrders().firstPage();
        expect(orders.items).toEqual([]);
        const trades = await client.listAccountTrades().firstPage();
        expect(trades.items).toEqual([]);
      });

      // The 1-day key is revoked by close() with a DELETE on its id.
      await client.close();
      expect(failures).toEqual([]);
      expect(revokeSucceeded(calls)).toEqual([true]);
      expect(statusOf(calls, 'GET', 'backend', '/api/auth/api-keys')).toBe(200);
    });
  },
);
