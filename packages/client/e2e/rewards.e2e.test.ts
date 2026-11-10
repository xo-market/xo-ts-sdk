import { randomBytes } from 'node:crypto';
import { getAddress } from 'viem';
import { beforeAll, expect, test } from 'vitest';
import { isRejected } from '../src/core/errors';
import type { UserRewards } from '../src/index';
import { type Rewarded, rewardedMarket } from './discover';
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

// The liquidity-rewards reads of the two clients against the real mainnet services, with strict
// responses, so a field the services add, drop or type differently fails the call.
//
// - The public reads run with no credentials, on real data: the reward pools, the groups, and
//   a rewarded market found in them with its programme, a scored day, the day's makers and
//   orders. The wallet reads then use a wallet taken from that day's makers.
// - The reads of the account's own rewards run with ONE secure client of the e2e wallet, which
//   mints a 1-day API key that `close()` revokes. The wallet never makes a market, so it has
//   no rewards, and these calls check the envelopes (the zeroed totals, the empty lists, the
//   404 of an unranked account); the shape of a populated row is checked on their public twins,
//   which run the same mappers.
//
// Only reads are made, besides signing in and out, and no credential is printed.

const DAY_MS = 86_400_000;
const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;
const CONDITION_ID = /^0x[0-9a-f]{64}$/;
const WALLET = /^0x[0-9a-fA-F]{40}$/;

/** The amounts of a model, by field name. Each is exact text (or null), never a JSON number. */
const MONEY_KEYS = new Set([
  'dailyPool',
  'budgetTotal',
  'budgetRemaining',
  'minPayout',
  'minOrderSize',
  'amount',
  'remaining',
  'todayPool',
  'allocated',
  'distributed',
  'baseAllocated',
  'bonusAllocated',
  'pool',
  'credited',
  'effective',
  'effectiveCp',
  'allocatedCp',
  'creditedCp',
  'liquidityCp',
  'totalReceived',
  'lifetime',
  'today',
  'paid',
  'estimate',
  'baseAmount',
  'bonusAmount',
  'creatorBonus',
  'openingSize',
  'closingSize',
  'price',
]);

/** Every money-like field of a model is exact text (or null), never a JSON number. */
function expectExactMoney(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      expectExactMoney(item, `${path}[${index}]`);
    });
    return;
  }
  if (typeof value !== 'object' || value === null) {
    return;
  }
  for (const [name, child] of Object.entries(value)) {
    const here = `${path}.${name}`;
    if (MONEY_KEYS.has(name) && typeof child !== 'object') {
      if (child !== null && child !== undefined) {
        expect(typeof child, here).toBe('string');
        expect(child as string, here).toMatch(PLAIN_DECIMAL);
      }
    } else {
      expectExactMoney(child, here);
    }
  }
}

/**
 * A wallet's rewards without the figures of the day in progress, which are a projection that
 * moves between two reads (`currentDay`, and `today` in the totals).
 */
function settled(rewards: UserRewards['usdc'] | UserRewards['cp']): unknown {
  if (rewards === null) {
    return null;
  }
  const { currentDay: _day, ...rest } = rewards;
  return JSON.parse(
    JSON.stringify(rest, (name, value: unknown) =>
      name === 'today' ? undefined : value,
    ),
  );
}

describeLive('Live liquidity rewards on mainnet: public reads (strict)', () => {
  const client = strictPublicClient();
  let found: Rewarded;

  beforeAll(async () => {
    found = await rewardedMarket(client);
  });

  test('listRewardPools: the programmes parse and money is exact text', async () => {
    const page = await live('listRewardPools', () =>
      client.listRewardPools().firstPage(),
    );
    expect(page.hasMore).toBe(false);
    expect(page.items.length).toBeGreaterThan(0);
    for (const pool of page.items) {
      expect(pool.conditionId, 'a condition id').toMatch(CONDITION_ID);
      expect(pool.programmes.length).toBeGreaterThan(0);
      expectExactMoney(pool);
      for (const programme of pool.programmes) {
        expect(['CP', 'USDC']).toContain(programme.currency);
        if (programme.terms.minOrderRestMs !== null) {
          expect(typeof programme.terms.minOrderRestMs).toBe('number');
        }
      }
      // A Pulse window carries its group; an ordinary market does not.
      if (pool.groupId !== null) {
        expect(pool.groupId).toMatch(CONDITION_ID);
      }
    }
  });

  test('listRewardGroups: a page size paginates, and a group reads back', async () => {
    const first = await live('listRewardGroups', () =>
      client.listRewardGroups({ pageSize: 1 }).firstPage(),
    );
    expect(first.items.length).toBeLessThanOrEqual(1);
    let pages = 0;
    const ids: string[] = [];
    for await (const page of client.listRewardGroups({ pageSize: 1 })) {
      pages += 1;
      for (const group of page.items) {
        ids.push(group.groupId);
      }
      if (pages === 3) {
        break;
      }
    }
    expect(new Set(ids).size, 'no group on two pages').toBe(ids.length);
    // The filters the list takes are accepted.
    for (const request of [
      { currency: 'CP' as const, includeInactive: true, pageSize: 100 },
      { currency: 'USDC' as const },
    ]) {
      await live('listRewardGroups (filters)', () =>
        client.listRewardGroups(request).firstPage(),
      );
    }
    const [group] = first.items;
    if (group === undefined) {
      console.warn(
        '[e2e] mainnet has no liquidity reward group now: the group checks are skipped',
      );
      return;
    }
    expect(group.groupId).toMatch(CONDITION_ID);
    expectExactMoney(group);
    const detail = await live('fetchRewardGroup', () =>
      client.fetchRewardGroup({ groupId: group.groupId }),
    );
    expect(detail.groupId).toBe(group.groupId);
    expect(detail.product).toEqual(group.product);
    expect(detail.day).not.toBeNull();
    // Lower- and upper-case ids reach the same group.
    const upper = `0x${group.groupId.slice(2).toUpperCase()}`;
    const same = await live('fetchRewardGroup (upper case)', () =>
      client.fetchRewardGroup({ groupId: upper }),
    );
    expect(same.groupId).toBe(group.groupId);
  });

  test('fetchMarketRewards: both currencies, the day, and the id in any case', async () => {
    const { rewards } = found;
    expect(rewards.conditionId).toBe(found.conditionId);
    expect(rewards.programmes.length).toBeGreaterThan(0);
    expectExactMoney(rewards);
    expect(rewards.lifetime.length).toBeGreaterThan(0);
    // A score is exact text: a float would lose digits.
    for (const row of rewards.lifetime) {
      expect(typeof row.totalScoredLiquidity).toBe('string');
    }
    // The day in progress is today's UTC day, give or take midnight.
    const today = Math.floor(Date.now() / DAY_MS);
    expect(Math.abs(rewards.day.epoch - today)).toBeLessThanOrEqual(1);
    // The same id in upper case works: the SDK sends it in lower case.
    const upper = `0x${found.conditionId.slice(2).toUpperCase()}`;
    const same = await live('fetchMarketRewards (upper case)', () =>
      client.fetchMarketRewards({ conditionId: upper }),
    );
    expect(same.conditionId).toBe(found.conditionId);
  });

  test('a scored day, its makers and orders, and the day in progress', async () => {
    const day = await live('fetchMarketRewardsEpoch', () =>
      client.fetchMarketRewardsEpoch({
        conditionId: found.conditionId,
        epoch: found.epoch,
      }),
    );
    expect(day.conditionId).toBe(found.conditionId);
    expect(day.day.epoch).toBe(found.epoch);
    // The day's bounds are the epoch times the day.
    expect(Date.parse(day.day.closesAt) - Date.parse(day.day.opensAt)).toBe(
      DAY_MS,
    );
    expect(Date.parse(day.day.opensAt)).toBe(found.epoch * DAY_MS);
    expect(day.rails.length).toBeGreaterThan(0);
    expectExactMoney(day);

    // Makers: a page size paginates.
    const first = await live('listMarketRewardsMakers', () =>
      client
        .listMarketRewardsMakers({
          conditionId: found.conditionId,
          epoch: found.epoch,
          pageSize: 1,
        })
        .firstPage(),
    );
    expect(first.items).toHaveLength(1);
    for (const maker of found.makers) {
      expect(maker.wallet).toMatch(WALLET);
      expectExactMoney(maker);
    }

    const orders = await live('listMarketRewardsOrders', () =>
      client
        .listMarketRewardsOrders({
          conditionId: found.conditionId,
          epoch: found.epoch,
          pageSize: 5,
        })
        .firstPage(),
    );
    for (const order of orders.items) {
      expect(order.maker).toMatch(WALLET);
      expect(order.openingSize).toMatch(PLAIN_DECIMAL);
      expectExactMoney(order);
    }
    // The maker filter narrows the list to that wallet.
    const byMaker = await live('listMarketRewardsOrders (maker)', () =>
      client
        .listMarketRewardsOrders({
          conditionId: found.conditionId,
          epoch: found.epoch,
          maker: found.maker.toLowerCase(),
          pageSize: 20,
        })
        .firstPage(),
    );
    expect(
      byMaker.items.every(
        (order) => order.maker?.toLowerCase() === found.maker.toLowerCase(),
      ),
    ).toBe(true);

    // The day in progress is a live projection.
    const projected = await live('fetchMarketRewardsEpoch (today)', () =>
      client.fetchMarketRewardsEpoch({ conditionId: found.conditionId }),
    );
    expect(
      Math.abs(projected.day.epoch - Math.floor(Date.now() / DAY_MS)),
    ).toBeLessThanOrEqual(1);
    expectExactMoney(projected);
  });

  test('a maker’s wallet reads: the totals, a day and the scored orders', async () => {
    const summary = await live('fetchUserRewards', () =>
      client.fetchUserRewards({ user: found.maker }),
    );
    expectExactMoney(summary);
    expect(summary.cp !== null || summary.usdc !== null).toBe(true);
    expect(typeof summary.flagged).toBe('boolean');
    // The checksummed form of the wallet reaches the same data.
    const checksummed = getAddress(found.maker);
    const same = await live('fetchUserRewards (checksummed)', () =>
      client.fetchUserRewards({ user: checksummed }),
    );
    expect(settled(same.usdc)).toEqual(settled(summary.usdc));
    expect(settled(same.cp)).toEqual(settled(summary.cp));

    const day = await live('fetchUserRewardsEpoch', () =>
      client.fetchUserRewardsEpoch({ user: found.maker, epoch: found.epoch }),
    );
    expect(day.wallet.toLowerCase()).toBe(found.maker.toLowerCase());
    expect(day.day.epoch).toBe(found.epoch);
    expectExactMoney(day);
    if (found.scored) {
      expect(
        day.markets.some((line) => line.conditionId === found.conditionId),
      ).toBe(true);
    }

    const page = await live('listUserRewardsOrders', () =>
      client
        .listUserRewardsOrders({
          user: found.maker,
          epoch: found.epoch,
          pageSize: 2,
        })
        .firstPage(),
    );
    expect(page.items.length).toBeLessThanOrEqual(2);
    expectExactMoney(page.items);
    for (const order of page.items) {
      expect(order.openingSize).toMatch(PLAIN_DECIMAL);
      expect(order.conditionId).toMatch(CONDITION_ID);
    }
    // A condition-id filter narrows it.
    const filtered = await live('listUserRewardsOrders (conditionId)', () =>
      client
        .listUserRewardsOrders({
          user: found.maker,
          conditionId: found.conditionId,
          epoch: found.epoch,
          live: false,
          pageSize: 20,
        })
        .firstPage(),
    );
    expect(
      filtered.items.every((order) => order.conditionId === found.conditionId),
    ).toBe(true);
  });

  test('a wallet with no activity gets zeros and empty lists, not an error', async () => {
    // A random address, with no key: it is only read, so no account is made for it.
    const stranger = getAddress(`0x${randomBytes(20).toString('hex')}`);
    const summary = await live('fetchUserRewards (stranger)', () =>
      client.fetchUserRewards({ user: stranger }),
    );
    expect(summary.cp?.totalReceived).toBe('0.00');
    expect(summary.usdc?.totalReceived).toBe('0.00');
    expect(summary.flagged).toBe(false);
    const day = await live('fetchUserRewardsEpoch (stranger)', () =>
      client.fetchUserRewardsEpoch({ user: stranger, epoch: found.epoch }),
    );
    expect(day.markets).toEqual([]);
    expect(day.user).toBeNull();
    const orders = await live('listUserRewardsOrders (stranger)', () =>
      client.listUserRewardsOrders({ user: stranger }).firstPage(),
    );
    expect(orders.items).toEqual([]);
    expect(orders.hasMore).toBe(false);
    const ofMarket = await live('listMarketRewardsOrders (stranger)', () =>
      client
        .listMarketRewardsOrders({
          conditionId: found.conditionId,
          maker: stranger,
        })
        .firstPage(),
    );
    expect(ofMarket.items).toEqual([]);
  });

  test('every boolean the reads send is accepted by the backend, true and false', async () => {
    for (const value of [true, false]) {
      await live(`listRewardGroups (includeInactive ${value})`, () =>
        client
          .listRewardGroups({ includeInactive: value, pageSize: 1 })
          .firstPage(),
      );
      await live(`listUserRewardsOrders (live ${value})`, () =>
        client
          .listUserRewardsOrders({
            user: found.maker,
            epoch: found.epoch,
            live: value,
            pageSize: 1,
          })
          .firstPage(),
      );
    }
  });

  test('errors: an unknown market or group is a 404 rejection, a bad id never leaves the SDK', async () => {
    const unknown = `0x${'0'.repeat(63)}1`;
    for (const run of [
      () => client.fetchMarketRewards({ conditionId: unknown }),
      () => client.fetchRewardGroup({ groupId: unknown }),
    ]) {
      const failure = await live('unknown market or group', async () =>
        run().then(
          () => undefined,
          (error: unknown) => error,
        ),
      );
      expect(isRejected(failure, 404)).toBe(true);
    }
    // The day of a market without a programme is not a 404: the service answers a day with
    // nothing in it, one empty rail per currency.
    const empty = await live('fetchMarketRewardsEpoch (unknown)', () =>
      client.fetchMarketRewardsEpoch({ conditionId: unknown }),
    );
    expect(empty.rails.every((rail) => rail.makerCount === 0)).toBe(true);
    expect(empty.rails.every((rail) => rail.makers.length === 0)).toBe(true);
    // The numeric id of a market is not a condition id: refused locally.
    const numeric = await client
      .fetchMarketRewards({ conditionId: '69781' })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(numeric).toMatchObject({ code: 'invalid_input' });
  });

  test('the public client has no reads of an account’s own rewards', () => {
    expect(client).not.toHaveProperty('listRewardsLeaderboard');
    expect(client).not.toHaveProperty('fetchRewardsLeaderboardStanding');
  });
});

describeSignedIn(
  'Live liquidity rewards on mainnet: the e2e wallet (strict)',
  () => {
    // The e2e wallet's EOA, one login: the 1-day API key is revoked by close() after the test.
    const clients = trackClients();
    // The market and the day come from the public reads, with no credentials.
    const publicClient = strictPublicClient();

    beforeAll(async () => {
      const xo = await e2eClient();
      try {
        await assertEmptyWallet(xo);
      } finally {
        await xo.close();
      }
    });

    test('every read of the account’s own rewards answers for an account without rewards, the envelopes parse, and the errors are typed', async () => {
      const found = await rewardedMarket(publicClient);
      const { client, calls } = await clients.create();
      const wallet = client.wallet.toLowerCase();

      const summary = await live('fetchUserRewards', () =>
        client.fetchUserRewards(),
      );
      expectExactMoney(summary);
      expect(summary.cp?.totalReceived).toBe('0.00');
      expect(summary.usdc?.totalReceived).toBe('0.00');
      expect(summary.cp?.liquidity.today).toBe('0.00');
      expect(summary.flagged).toBe(false);
      // The account's wallet is the EOA: the public twin of the same wallet agrees.
      const twin = await live('fetchUserRewards (user)', () =>
        client.fetchUserRewards({ user: client.wallet }),
      );
      expect(settled(twin.cp)).toEqual(settled(summary.cp));
      expect(settled(twin.usdc)).toEqual(settled(summary.usdc));

      const day = await live('fetchUserRewardsEpoch', () =>
        client.fetchUserRewardsEpoch({ epoch: found.epoch }),
      );
      expect(day.wallet.toLowerCase()).toBe(wallet);
      expect(day.day.epoch).toBe(found.epoch);
      expect(day.markets).toEqual([]);
      expect(day.effectiveCp).toBe('0.00');
      expectExactMoney(day);

      for (const request of [
        {},
        { epoch: found.epoch },
        { live: false },
        { conditionId: found.conditionId, pageSize: 5 },
      ]) {
        const page = await live('listUserRewardsOrders', () =>
          client.listUserRewardsOrders(request).firstPage(),
        );
        expect(page.items).toEqual([]);
        expect(page.hasMore).toBe(false);
      }

      const board = await live('listRewardsLeaderboard', () =>
        client.listRewardsLeaderboard({ pageSize: 2 }).firstPage(),
      );
      expect(board.items.length).toBeLessThanOrEqual(2);
      for (const entry of board.items) {
        expect(entry.wallet).toMatch(WALLET);
        expect(typeof entry.rank).toBe('number');
        expectExactMoney(entry);
      }
      if (board.items.length === 2) {
        expect(board.items.map((entry) => entry.rank)).toEqual([1, 2]);
      }
      for (const period of ['daily', 'weekly', 'seasonal'] as const) {
        await live(`listRewardsLeaderboard (${period})`, () =>
          client.listRewardsLeaderboard({ period, pageSize: 1 }).firstPage(),
        );
      }

      // An account that earned nothing is not ranked: a 404.
      for (const request of [{}, { period: 'daily' as const }]) {
        const failure = await client
          .fetchRewardsLeaderboardStanding(request)
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(isRejected(failure, 404)).toBe(true);
      }

      // A bad id or option is refused before a request.
      const before = calls.length;
      await expect(
        client.fetchUserRewardsEpoch({ epoch: -1 }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(
        client.fetchUserRewards({ user: '0x12' }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
      let refused: unknown;
      try {
        client.listRewardsLeaderboard({ period: 'monthly' as never });
      } catch (error) {
        refused = error;
      }
      expect(refused).toMatchObject({ code: 'invalid_input' });
      expect(calls.length).toBe(before);

      // Every read of the account's own went to the shared routes with a key.
      expect(
        statusOf(calls, 'GET', 'backend', '/api/liquidity-rewards/me/summary'),
      ).toBe(200);
      expect(
        statusOf(
          calls,
          'GET',
          'backend',
          '/api/liquidity-rewards/leaderboard/me',
        ),
      ).toBe(404);

      // The memory store gives a 1-day key, which close() revokes with a DELETE on its id.
      await client.close();
      expect(revokeSucceeded(calls)).toEqual([true]);
    });
  },
);
