import { setupServer } from 'msw/node';
import { getAddress } from 'viem';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import {
  fetchMarketRewards,
  fetchMarketRewardsEpoch,
  fetchRewardGroup,
  fetchRewardsLeaderboardStanding,
  fetchUserRewards,
  fetchUserRewardsEpoch,
  listMarketRewardsMakers,
  listMarketRewardsOrders,
  listRewardGroups,
  listRewardPools,
  listRewardsLeaderboard,
  listUserRewardsOrders,
  secureFetchUserRewards,
  secureFetchUserRewardsEpoch,
  secureListUserRewardsOrders,
} from '../../src/actions/rewards';
import type { ActionContext } from '../../src/clients/context';
import { UserInputError } from '../../src/core/errors';
import type { Paginated } from '../../src/core/paginated';
import type { RequestOptions } from '../../src/core/requestOptions';
import { OrderSide } from '../../src/models/enums';
import { actionRig } from '../helpers/actionRig';
import { caught } from '../helpers/dataRig';
import {
  MAKER,
  REWARD_GROUP,
  REWARD_MARKET,
  REWARD_MARKET_2,
  SCORED_EPOCH,
  STRANGER,
  TODAY_EPOCH,
  UNENROLLED_MARKET,
  UNKNOWN_GROUP,
} from '../helpers/mockRewardsData';
import { wireStyleKeys } from '../helpers/modelKeys';
import { rejectedWith } from '../helpers/rejections';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

type Rig = ReturnType<typeof actionRig>;

const PUBLIC = '/api/public/liquidity-rewards';

/** The "METHOD /path" of every request the backend fake saw, in order. */
const backendCalls = (r: Rig): string[] =>
  r.backend.requests.map((request) => `${request.method} ${request.path}`);

/** A cursor as a list gives it out, made by hand. */
function cursorOf(
  list: string,
  kind: 'cursor' | 'page',
  value: string | number,
): string {
  return Buffer.from(JSON.stringify({ v: 1, list, kind, value }))
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

/** The number of items of each page of a list. */
async function pageSizes(
  list: AsyncIterable<{ items: unknown[] }>,
): Promise<number[]> {
  const sizes: number[] = [];
  for await (const page of list) {
    sizes.push(page.items.length);
  }
  return sizes;
}

describe('listRewardPools', () => {
  test('lists the markets that pay rewards on one page, with no credentials', async () => {
    const r = actionRig(server, { session: true });
    const pools = listRewardPools(r.ctx);
    expect(r.backend.requests).toEqual([]);
    const page = await pools.firstPage();
    expect(backendCalls(r)).toEqual([`GET ${PUBLIC}/earning-pools`]);
    expect(r.backend.requests[0]?.authorization).toBeNull();
    expect(page.hasMore).toBe(false);
    expect(page.items.map((pool) => pool.conditionId)).toEqual([
      REWARD_MARKET,
      REWARD_MARKET_2,
    ]);
    expect(page.items[0]?.programmes.map((p) => p.currency)).toEqual([
      'CP',
      'USDC',
    ]);
    expect(wireStyleKeys(page.items)).toEqual([]);
  });

  test('has one page: any cursor is refused', async () => {
    const r = actionRig(server);
    const error = await caught(() =>
      listRewardPools(r.ctx)
        .from(cursorOf('rewardPools', 'cursor', 'x'))
        .firstPage(),
    );
    expect((error as UserInputError).code).toBe('invalid_cursor');
    expect(r.backend.requests).toEqual([]);
  });
});

describe('listRewardGroups', () => {
  test('lists the Pulse groups a page at a time', async () => {
    const r = actionRig(server);
    expect(await pageSizes(listRewardGroups(r.ctx, { pageSize: 2 }))).toEqual([
      2, 1,
    ]);
    expect(backendCalls(r)).toEqual([
      `GET ${PUBLIC}/groups`,
      `GET ${PUBLIC}/groups`,
    ]);
    expect(r.backend.requests.map((q) => q.query)).toEqual([
      { page_size: '2', page: '0' },
      { page_size: '2', page: '1' },
    ]);
    const first = await listRewardGroups(r.ctx, { pageSize: 2 }).firstPage();
    expect(first.hasMore).toBe(true);
    expect(first.items[0]).toMatchObject({
      groupId: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      active: true,
      day: null,
    });
    const second = await listRewardGroups(r.ctx, { pageSize: 2 })
      .from(first.nextCursor)
      .firstPage();
    expect(second.items).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(wireStyleKeys(first.items)).toEqual([]);
  });

  test('currency and includeInactive filter the groups', async () => {
    const r = actionRig(server);
    await listRewardGroups(r.ctx, {
      currency: 'CP',
      includeInactive: true,
    }).firstPage();
    expect(r.backend.requests[0]?.query).toMatchObject({
      currency: 'CP',
      include_zero: 'true',
    });
  });

  test.each([
    ['a currency that is not one', { currency: 'EUR' }],
    ['a pageSize of 0', { pageSize: 0 }],
    ['a pageSize above 100', { pageSize: 101 }],
    ['includeInactive that is text', { includeInactive: 'yes' }],
    ['an unknown key', { include_zero: true }],
  ])('%s is invalid_input, at once', (_name, request) => {
    const r = actionRig(server);
    let error: unknown;
    try {
      listRewardGroups(r.ctx, request as never);
    } catch (e) {
      error = e;
    }
    expect((error as UserInputError).code).toBe('invalid_input');
    expect((error as UserInputError).message).toMatch(/^listRewardGroups: /);
    expect(r.backend.requests).toEqual([]);
  });

  test('a cursor that is not a page number is refused when the list is read', async () => {
    const r = actionRig(server);
    for (const forged of [
      cursorOf('rewardGroups', 'cursor', 'abc'),
      cursorOf('rewardGroups', 'cursor', '0'),
    ]) {
      const error = await caught(() =>
        listRewardGroups(r.ctx).from(forged).firstPage(),
      );
      expect((error as UserInputError).code).toBe('invalid_cursor');
    }
    expect(r.backend.requests).toEqual([]);
  });
});

describe('fetchRewardGroup', () => {
  test('reads one group in full', async () => {
    const r = actionRig(server);
    const group = await fetchRewardGroup(r.ctx, { groupId: REWARD_GROUP });
    expect(backendCalls(r)).toEqual([`GET ${PUBLIC}/groups/${REWARD_GROUP}`]);
    expect(group).toMatchObject({
      groupId: REWARD_GROUP,
      active: true,
      day: { epoch: TODAY_EPOCH },
    });
    expect(group.lifetime).not.toBeNull();
    expect(wireStyleKeys(group)).toEqual([]);
  });

  test('an unknown group is a 404; a bad id is invalid_input', async () => {
    const r = actionRig(server);
    expect(
      await caught(() => fetchRewardGroup(r.ctx, { groupId: UNKNOWN_GROUP })),
    ).toSatisfy(rejectedWith(404));
    const calls = r.backend.requests.length;
    for (const request of [{}, { groupId: '0x12' }, { groupId: 5 }]) {
      const error = await caught(() =>
        fetchRewardGroup(r.ctx, request as never),
      );
      expect((error as UserInputError).code).toBe('invalid_input');
    }
    expect(r.backend.requests).toHaveLength(calls);
  });
});

describe('fetchMarketRewards', () => {
  test('reads the rewards of an enrolled market', async () => {
    const r = actionRig(server);
    const rewards = await fetchMarketRewards(r.ctx, {
      conditionId: REWARD_MARKET,
    });
    expect(backendCalls(r)).toEqual([`GET ${PUBLIC}/markets/${REWARD_MARKET}`]);
    expect(rewards).toMatchObject({
      conditionId: REWARD_MARKET,
      day: { epoch: TODAY_EPOCH },
    });
    expect(rewards.programmes.map((p) => p.currency)).toEqual(['CP', 'USDC']);
    expect(wireStyleKeys(rewards)).toEqual([]);
  });

  test('a market with no programme is a 404; a bad id is invalid_input', async () => {
    const r = actionRig(server);
    expect(
      await caught(() =>
        fetchMarketRewards(r.ctx, { conditionId: UNENROLLED_MARKET }),
      ),
    ).toSatisfy(rejectedWith(404));
    for (const request of [{}, { conditionId: 'x' }, { id: '1' }]) {
      const error = await caught(() =>
        fetchMarketRewards(r.ctx, request as never),
      );
      expect((error as UserInputError).code).toBe('invalid_input');
    }
  });
});

describe('fetchMarketRewardsEpoch', () => {
  test('reads a UTC day of a market', async () => {
    const r = actionRig(server);
    const day = await fetchMarketRewardsEpoch(r.ctx, {
      conditionId: REWARD_MARKET,
      epoch: SCORED_EPOCH,
    });
    expect(backendCalls(r)).toEqual([
      `GET ${PUBLIC}/markets/${REWARD_MARKET}/epochs/${SCORED_EPOCH}`,
    ]);
    expect(day).toMatchObject({
      conditionId: REWARD_MARKET,
      day: { epoch: SCORED_EPOCH },
    });
    expect(day.rails.map((rail) => rail.currency)).toEqual(['CP', 'USDC']);
    expect(wireStyleKeys(day)).toEqual([]);
  });

  test("without an epoch it reads today's, by the server's clock", async () => {
    const r = actionRig(server);
    const day = await fetchMarketRewardsEpoch(r.ctx, {
      conditionId: REWARD_MARKET,
    });
    expect(r.backend.requests[0]?.path).toBe(
      `${PUBLIC}/markets/${REWARD_MARKET}/epochs/${TODAY_EPOCH}`,
    );
    expect(day.day.epoch).toBe(TODAY_EPOCH);
  });

  test.each([
    ['a negative epoch', -1],
    ['a fractional epoch', 1.5],
    ['an epoch above 10,000,000', 10_000_001],
    ['an epoch as text', '5'],
  ])('%s is invalid_input', async (_name, epoch) => {
    const r = actionRig(server);
    const error = await caught(() =>
      fetchMarketRewardsEpoch(r.ctx, {
        conditionId: REWARD_MARKET,
        epoch: epoch as never,
      }),
    );
    expect((error as UserInputError).code).toBe('invalid_input');
    expect((error as UserInputError).message).toMatch(
      /^fetchMarketRewardsEpoch: epoch /,
    );
    expect(r.backend.requests).toEqual([]);
  });
});

describe('listMarketRewardsMakers', () => {
  test('lists the makers of a day a page at a time', async () => {
    const r = actionRig(server);
    const makers = listMarketRewardsMakers(r.ctx, {
      conditionId: REWARD_MARKET,
      epoch: SCORED_EPOCH,
      pageSize: 2,
    });
    expect(await pageSizes(makers)).toEqual([2, 2, 1]);
    expect(backendCalls(r)).toEqual(
      Array(3).fill(
        `GET ${PUBLIC}/markets/${REWARD_MARKET}/epochs/${SCORED_EPOCH}/makers`,
      ),
    );
    expect(r.backend.requests.map((q) => q.query.page)).toEqual([
      '0',
      '1',
      '2',
    ]);
    const first = await makers.firstPage();
    expect(first.items[0]).toMatchObject({
      wallet: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
      status: expect.any(String),
    });
    expect(wireStyleKeys(first.items)).toEqual([]);
    const third = await makers
      .from((await makers.from(first.nextCursor).firstPage()).nextCursor)
      .firstPage();
    expect(third.items).toHaveLength(1);
    expect(third.hasMore).toBe(false);
  });

  test("without an epoch it lists today's makers", async () => {
    const r = actionRig(server);
    await listMarketRewardsMakers(r.ctx, {
      conditionId: REWARD_MARKET,
    }).firstPage();
    expect(r.backend.requests[0]?.path).toBe(
      `${PUBLIC}/markets/${REWARD_MARKET}/epochs/${TODAY_EPOCH}/makers`,
    );
  });

  test('a bad request is invalid_input, at once', () => {
    const r = actionRig(server);
    for (const request of [
      {},
      { conditionId: REWARD_MARKET, pageSize: 1001 },
      { conditionId: REWARD_MARKET, maker: MAKER },
    ]) {
      let error: unknown;
      try {
        listMarketRewardsMakers(r.ctx, request as never);
      } catch (e) {
        error = e;
      }
      expect((error as UserInputError).code).toBe('invalid_input');
    }
    expect(r.backend.requests).toEqual([]);
  });
});

describe('listMarketRewardsOrders', () => {
  test('lists the scored orders of a day, with the maker of each', async () => {
    const r = actionRig(server);
    const orders = listMarketRewardsOrders(r.ctx, {
      conditionId: REWARD_MARKET,
      epoch: SCORED_EPOCH,
      pageSize: 2,
    });
    expect(await pageSizes(orders)).toEqual([2, 2, 1]);
    const first = await orders.firstPage();
    expect(first.items[0]).toMatchObject({
      orderId: '101407907',
      conditionId: null,
      maker: getAddress(MAKER),
      outcome: 'Yes',
      side: OrderSide.BUY,
      price: '0.89',
    });
    expect(wireStyleKeys(first.items)).toEqual([]);
  });

  test('maker keeps only the orders of one wallet', async () => {
    const r = actionRig(server);
    const page = await listMarketRewardsOrders(r.ctx, {
      conditionId: REWARD_MARKET,
      epoch: SCORED_EPOCH,
      maker: getAddress(MAKER),
    }).firstPage();
    expect(page.items).toHaveLength(3);
    expect(r.backend.requests[0]?.query.maker).toBe(MAKER);
    const none = await listMarketRewardsOrders(r.ctx, {
      conditionId: REWARD_MARKET,
      epoch: SCORED_EPOCH,
      maker: '0x1111111111111111111111111111111111111111',
    }).firstPage();
    expect(none.items).toEqual([]);
  });

  test('a maker that is not an address is invalid_input', () => {
    const r = actionRig(server);
    expect(() =>
      listMarketRewardsOrders(r.ctx, {
        conditionId: REWARD_MARKET,
        maker: '0x12',
      }),
    ).toThrow(UserInputError);
  });
});

describe('fetchUserRewards', () => {
  test("reads a wallet's rewards, with no credentials", async () => {
    const r = actionRig(server, { session: true });
    const rewards = await fetchUserRewards(r.ctx, { user: getAddress(MAKER) });
    expect(backendCalls(r)).toEqual([`GET ${PUBLIC}/wallets/${MAKER}/summary`]);
    expect(r.backend.requests[0]?.authorization).toBeNull();
    expect(rewards).toMatchObject({
      flagged: false,
      day: { epoch: TODAY_EPOCH },
      usdc: { totalReceived: '378.43' },
      cp: { totalReceived: '7833.97' },
    });
    expect(wireStyleKeys(rewards)).toEqual([]);
  });

  test('a wallet that has earned nothing reads zeros', async () => {
    const r = actionRig(server);
    const rewards = await fetchUserRewards(r.ctx, { user: STRANGER });
    expect(rewards.usdc?.totalReceived).toBe('0.00');
  });

  test.each([
    ['no user', {}],
    ['a user that is not an address', { user: '0x12' }],
    ['a user that is a number', { user: 5 }],
    ['an unknown key', { user: MAKER, wallet: MAKER }],
  ])('%s is invalid_input, before any request', async (_name, request) => {
    const r = actionRig(server);
    const error = await caught(() => fetchUserRewards(r.ctx, request as never));
    expect((error as UserInputError).code).toBe('invalid_input');
    expect((error as UserInputError).message).toMatch(/^fetchUserRewards: /);
    expect(r.backend.requests).toEqual([]);
  });
});

describe('fetchUserRewardsEpoch', () => {
  test("reads a wallet's day across its markets", async () => {
    const r = actionRig(server);
    const day = await fetchUserRewardsEpoch(r.ctx, {
      user: MAKER,
      epoch: SCORED_EPOCH,
    });
    expect(backendCalls(r)).toEqual([
      `GET ${PUBLIC}/wallets/${MAKER}/epochs/${SCORED_EPOCH}`,
    ]);
    expect(day).toMatchObject({
      wallet: getAddress(MAKER),
      day: { epoch: SCORED_EPOCH },
    });
    expect(day.markets.map((m) => m.conditionId)).toEqual([
      REWARD_MARKET,
      REWARD_MARKET_2,
    ]);
    expect(wireStyleKeys(day)).toEqual([]);
  });

  test("without an epoch it reads today's", async () => {
    const r = actionRig(server);
    await fetchUserRewardsEpoch(r.ctx, { user: MAKER });
    expect(r.backend.requests[0]?.path).toBe(
      `${PUBLIC}/wallets/${MAKER}/epochs/${TODAY_EPOCH}`,
    );
  });
});

describe('listUserRewardsOrders', () => {
  test("lists a wallet's scored orders, with the market of each", async () => {
    const r = actionRig(server);
    const orders = listUserRewardsOrders(r.ctx, {
      user: MAKER,
      epoch: SCORED_EPOCH,
      pageSize: 2,
    });
    expect(await pageSizes(orders)).toEqual([2, 2, 1]);
    expect(backendCalls(r)).toEqual(
      Array(3).fill(`GET ${PUBLIC}/wallets/${MAKER}/orders`),
    );
    expect(r.backend.requests.map((q) => q.query)).toEqual([
      { epoch: String(SCORED_EPOCH), page_size: '2', page: '0' },
      { epoch: String(SCORED_EPOCH), page_size: '2', page: '1' },
      { epoch: String(SCORED_EPOCH), page_size: '2', page: '2' },
    ]);
    const first = await orders.firstPage();
    expect(first.items[0]).toMatchObject({
      conditionId: REWARD_MARKET,
      maker: null,
      side: OrderSide.BUY,
      price: '0.79',
      scored: true,
    });
    expect(first.items[0]?.payouts.map((p) => p.currency)).toEqual([
      'CP',
      'USDC',
    ]);
    expect(wireStyleKeys(first.items)).toEqual([]);
  });

  test('conditionId and live narrow the list; without an epoch the day in progress is read', async () => {
    const r = actionRig(server);
    const page = await listUserRewardsOrders(r.ctx, {
      user: MAKER,
      epoch: SCORED_EPOCH,
      conditionId: REWARD_MARKET_2,
      live: false,
    }).firstPage();
    expect(page.items.map((o) => o.conditionId)).toEqual([REWARD_MARKET_2]);
    expect(r.backend.requests[0]?.query).toMatchObject({
      market_id: REWARD_MARKET_2,
      live: 'false',
    });
    await listUserRewardsOrders(r.ctx, { user: MAKER }).firstPage();
    expect(r.backend.requests[1]?.query.epoch).toBeUndefined();
  });

  test.each([
    ['no user', {}],
    ['a conditionId that is not one', { user: MAKER, conditionId: 'x' }],
    ['a live that is text', { user: MAKER, live: 'yes' }],
    ['an epoch above the last day', { user: MAKER, epoch: 10_000_001 }],
    ['a pageSize of 0', { user: MAKER, pageSize: 0 }],
  ])('%s is invalid_input, at once', (_name, request) => {
    const r = actionRig(server);
    let error: unknown;
    try {
      listUserRewardsOrders(r.ctx, request as never);
    } catch (e) {
      error = e;
    }
    expect((error as UserInputError).code).toBe('invalid_input');
    expect((error as UserInputError).message).toMatch(
      /^listUserRewardsOrders: /,
    );
    expect(r.backend.requests).toEqual([]);
  });
});

describe('every paged list reads its cursor as a page number', () => {
  const lists: Array<[string, string, (r: Rig) => Paginated<unknown>]> = [
    ['listRewardGroups', 'rewardGroups', (r) => listRewardGroups(r.ctx)],
    [
      'listMarketRewardsMakers',
      'marketRewardsMakers',
      (r) => listMarketRewardsMakers(r.ctx, { conditionId: REWARD_MARKET }),
    ],
    [
      'listMarketRewardsOrders',
      'marketRewardsOrders',
      (r) => listMarketRewardsOrders(r.ctx, { conditionId: REWARD_MARKET }),
    ],
    [
      'listUserRewardsOrders',
      'userRewardsOrders',
      (r) => listUserRewardsOrders(r.ctx, { user: MAKER }),
    ],
  ];

  test.each(lists)(
    '%s refuses a cursor that is not a page number, before any request',
    async (_name, list, make) => {
      const r = actionRig(server);
      for (const forged of [
        cursorOf(list, 'cursor', 'abc'),
        cursorOf(list, 'cursor', '1.5'),
        cursorOf(list, 'cursor', '0'),
        cursorOf(list, 'page', 0),
      ]) {
        const error = await caught(() => make(r).from(forged).firstPage());
        expect((error as UserInputError).code).toBe('invalid_cursor');
      }
      expect(r.backend.requests).toEqual([]);
    },
  );

  test.each(lists)(
    '%s does not accept the cursor of another list',
    (_name, _list, make) => {
      const r = actionRig(server);
      expect(() => make(r).from(cursorOf('markets', 'page', 2))).toThrow(
        UserInputError,
      );
    },
  );
});

describe('options', () => {
  const GOOD = { retries: 0, timeout: 1234 } as const;

  const reads: Array<
    [string, (ctx: ActionContext, options: RequestOptions) => unknown]
  > = [
    ['listRewardPools', (c, o) => listRewardPools(c, o).firstPage()],
    ['listRewardGroups', (c, o) => listRewardGroups(c, {}, o).firstPage()],
    [
      'fetchRewardGroup',
      (c, o) => fetchRewardGroup(c, { groupId: REWARD_GROUP }, o),
    ],
    [
      'fetchMarketRewards',
      (c, o) => fetchMarketRewards(c, { conditionId: REWARD_MARKET }, o),
    ],
    [
      'fetchMarketRewardsEpoch',
      (c, o) => fetchMarketRewardsEpoch(c, { conditionId: REWARD_MARKET }, o),
    ],
    [
      'listMarketRewardsMakers',
      (c, o) =>
        listMarketRewardsMakers(
          c,
          { conditionId: REWARD_MARKET },
          o,
        ).firstPage(),
    ],
    [
      'listMarketRewardsOrders',
      (c, o) =>
        listMarketRewardsOrders(
          c,
          { conditionId: REWARD_MARKET },
          o,
        ).firstPage(),
    ],
    ['fetchUserRewards', (c, o) => fetchUserRewards(c, { user: MAKER }, o)],
    [
      'fetchUserRewardsEpoch',
      (c, o) => fetchUserRewardsEpoch(c, { user: MAKER }, o),
    ],
    [
      'listUserRewardsOrders',
      (c, o) => listUserRewardsOrders(c, { user: MAKER }, o).firstPage(),
    ],
  ];

  test.each(reads)('%s passes them to its request', async (_name, run) => {
    const r = actionRig(server);
    const spy = vi.spyOn(r.transport, 'request');
    await run(r.ctx, GOOD);
    expect(spy).toHaveBeenCalled();
    for (const [request] of spy.mock.calls) {
      expect(request.call).toEqual({ timeoutMs: 1234, retries: 0 });
    }
  });

  test.each(reads)(
    '%s rejects bad options before any request',
    async (_name, run) => {
      const r = actionRig(server);
      const error = await caught(() => run(r.ctx, { retries: 99 }));
      expect(error).toBeInstanceOf(UserInputError);
      expect((error as UserInputError).code).toBe('invalid_request_options');
      expect(r.backend.requests).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// The reads of a signed-in client: its own rewards by default, and the leaderboard
// ---------------------------------------------------------------------------

describe('the rewards reads of a signed-in client', () => {
  const MINE = '/api/liquidity-rewards';

  test("fetchUserRewards without a user reads the account's own totals, with the key", async () => {
    const r = actionRig(server, { session: true });
    const own = await secureFetchUserRewards(r.ctx);
    expect(backendCalls(r)).toEqual([`GET ${MINE}/me/summary`]);
    expect(r.backend.requests[0]?.authorization).toMatch(/^Bearer /);
    const other = await secureFetchUserRewards(r.ctx, { user: MAKER });
    expect(backendCalls(r).at(-1)).toBe(
      `GET ${PUBLIC}/wallets/${MAKER}/summary`,
    );
    expect(Object.keys(own).sort()).toEqual(Object.keys(other).sort());
  });

  test("fetchUserRewardsEpoch without a user reads the account's own day", async () => {
    const r = actionRig(server, { session: true });
    const day = await secureFetchUserRewardsEpoch(r.ctx, {
      epoch: SCORED_EPOCH,
    });
    expect(backendCalls(r)).toEqual([`GET ${MINE}/me/epochs/${SCORED_EPOCH}`]);
    expect(day).toHaveProperty('markets');
  });

  test("listUserRewardsOrders without a user lists the account's own orders", async () => {
    const r = actionRig(server, { session: true });
    const page = await secureListUserRewardsOrders(r.ctx, {
      epoch: SCORED_EPOCH,
    }).firstPage();
    expect(backendCalls(r)).toEqual([`GET ${MINE}/me/orders`]);
    expect(page.items.length).toBeGreaterThan(0);
    await secureListUserRewardsOrders(r.ctx, { user: MAKER }).firstPage();
    expect(backendCalls(r).at(-1)).toBe(
      `GET ${PUBLIC}/wallets/${MAKER}/orders`,
    );
  });

  test('listRewardsLeaderboard lists the makers by rank, a page at a time', async () => {
    const r = actionRig(server, { session: true });
    const pages = await pageSizes(
      listRewardsLeaderboard(r.ctx, { period: 'daily', pageSize: 2 }),
    );
    expect(pages).toEqual([2, 2, 1]);
    expect(r.backend.requests[0]?.query).toMatchObject({
      period: 'daily',
      take: '2',
    });
    const first = await listRewardsLeaderboard(r.ctx).firstPage();
    expect(first.items[0]).toMatchObject({ rank: 1 });
  });

  test("fetchRewardsLeaderboardStanding reads the account's own row", async () => {
    const r = actionRig(server, { session: true });
    const standing = await fetchRewardsLeaderboardStanding(r.ctx, {
      period: 'weekly',
    });
    expect(backendCalls(r)).toEqual([`GET ${MINE}/leaderboard/me`]);
    expect(standing.rank).toBe(3);
  });

  test('an unknown period is refused at once', async () => {
    const r = actionRig(server, { session: true });
    const error = await caught(() =>
      fetchRewardsLeaderboardStanding(r.ctx, { period: 'yearly' } as never),
    );
    expect((error as UserInputError).code).toBe('invalid_input');
    expect(r.backend.requests).toEqual([]);
  });
});
