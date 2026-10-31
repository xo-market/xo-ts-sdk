import { HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from 'vitest';
import { priceToTick } from '../../src/core/decimal';
import {
  AuthRequiredError,
  UnexpectedResponseError,
  UserInputError,
  type XoError,
} from '../../src/core/errors';
import type { Paginator } from '../../src/core/paginate';
import type { DecimalString, RawUnitsString } from '../../src/core/types';
import type {
  DataClient,
  EarningPool,
  EarningPoolCp,
  EarningPoolUsdc,
  RewardAmount,
  RewardsGroup,
  RewardsGroupDay,
  RewardsGroupDetail,
  RewardsGroupHistory,
  RewardsGroupHistoryLine,
  RewardsGroupHistoryTotals,
  RewardsLeaderboardRow,
  RewardsMaker,
  RewardsMakerOrder,
  RewardsMarket,
  RewardsMarketConfig,
  RewardsMarketDay,
  RewardsMarketEpoch,
  RewardsMarketOrder,
  RewardsUsdcMaker,
  RewardsUser,
  RewardsWalletEpoch,
  RewardsWalletSummary,
} from '../../src/data/client';
import {
  API_KEY,
  calls,
  caught,
  dataRig,
  expectNoRequest,
  last,
} from '../helpers/dataRig';
import { exceptionResponse } from '../helpers/mockBackend';
import {
  earningPoolsFixture,
  GROUPS_TOTAL,
  groupDayFixture,
  groupDetailFixture,
  groupFixture,
  groupHistoryFixture,
  groupIdAt,
  groupsFixture,
  HISTORY_TOTAL,
  LEADERBOARD_TOTAL,
  leaderboardFixture,
  leaderboardRowFixture,
  MAKER,
  MAKERS_TOTAL,
  marketConfigFixture,
  marketDayFixture,
  marketDetailFixture,
  marketEpochFixture,
  marketMakersFixture,
  marketOrdersFixture,
  ORDERS_TOTAL,
  OWNER_RANK,
  OWNER_WALLET,
  PRODUCT,
  REWARD_GROUP,
  REWARD_MARKET,
  REWARD_MARKET_2,
  SCORED_EPOCH,
  STRANGER,
  TODAY_EPOCH,
  UNENROLLED_MARKET,
  UNKNOWN_GROUP,
  walletEpochFixture,
  walletOrdersFixture,
  walletSummaryFixture,
} from '../helpers/mockRewardsData';
import { rejectedWith } from '../helpers/rejections';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
afterAll(() => server.close());

const PUBLIC = '/api/public/liquidity-rewards';
const MINE = '/api/liquidity-rewards';
const MS_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// The epoch helper
// ---------------------------------------------------------------------------

describe('rewards.currentEpoch', () => {
  test('is floor(ms / 86_400_000), the UTC-day index the backend uses', () => {
    const { client } = dataRig(server);
    expect(client.rewards.currentEpoch(new Date(MS_DAY * 20_000 + 5))).toBe(
      20_000,
    );
    // The last millisecond of a day belongs to that day, the next one to the next.
    expect(client.rewards.currentEpoch(new Date(MS_DAY * 20_000 - 1))).toBe(
      19_999,
    );
    expect(client.rewards.currentEpoch(new Date(MS_DAY * 20_000))).toBe(20_000);
    expect(client.rewards.currentEpoch(new Date(MS_DAY * 20_001 - 1))).toBe(
      20_000,
    );
    expect(client.rewards.currentEpoch(new Date(0))).toBe(0);
    // A real instant, in the UTC day the live services were on when this was written.
    expect(
      client.rewards.currentEpoch(new Date('2026-10-18T14:14:30.815Z')),
    ).toBe(TODAY_EPOCH);
    // The offset of a local time zone does not move the day: the index is UTC. These are the
    // 19th and the 18th on a clock at +10:00, and the 18th and the 17th in UTC.
    expect(
      client.rewards.currentEpoch(new Date('2026-10-19T02:00:00+10:00')),
    ).toBe(TODAY_EPOCH);
    expect(
      client.rewards.currentEpoch(new Date('2026-10-18T02:00:00+10:00')),
    ).toBe(TODAY_EPOCH - 1);
  });

  test('defaults to now, and sends nothing', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(MS_DAY * 20_000 + 1234));
    const { client, backend } = dataRig(server);
    expect(client.rewards.currentEpoch()).toBe(20_000);
    expect(client.rewards.currentEpoch(undefined)).toBe(20_000);
    expectNoRequest(backend);
  });

  test('agrees with the epoch the backend reports for the same instant', async () => {
    const { client } = dataRig(server);
    const [pool] = await client.rewards.earningPools().toArray(1);
    expect(pool).toBeDefined();
    const page = await client.rewards.earningPools().firstPage();
    const meta = (
      page.raw as { meta: { currentEpoch: number; dayOpenMs: number } }
    ).meta;
    expect(client.rewards.currentEpoch(new Date(meta.dayOpenMs))).toBe(
      meta.currentEpoch,
    );
    expect(client.rewards.currentEpoch(new Date(meta.dayOpenMs - 1))).toBe(
      meta.currentEpoch - 1,
    );
  });

  test('refuses what is not a date of the epoch range: an invalid Date, a number, a date before 1970', () => {
    const { client } = dataRig(server);
    for (const bad of [
      new Date('nope'),
      Date.now(),
      '2026-10-18',
      null,
      new Date(-1),
      new Date(-MS_DAY * 400),
    ]) {
      expect(
        () => client.rewards.currentEpoch(bad as never),
        String(bad),
      ).toThrow(UserInputError);
    }
    // A date so far out that its day is past the backend's maximum epoch (10_000_000).
    expect(() =>
      client.rewards.currentEpoch(new Date(MS_DAY * 10_000_001)),
    ).toThrow(UserInputError);
    expect(client.rewards.currentEpoch(new Date(MS_DAY * 10_000_000))).toBe(
      10_000_000,
    );
  });

  test('its result is always an epoch the other methods accept', async () => {
    const { client, backend } = dataRig(server);
    const epoch = client.rewards.currentEpoch(
      new Date(MS_DAY * TODAY_EPOCH + 9),
    );
    await client.rewards.walletEpoch(MAKER, epoch);
    expect(last(backend).path).toBe(
      `${PUBLIC}/wallets/${MAKER}/epochs/${TODAY_EPOCH}`,
    );
  });
});

// ---------------------------------------------------------------------------
// The public routes: path, query, no credentials
// ---------------------------------------------------------------------------

describe('public routes (no credentials, even when the client has a session)', () => {
  const CASES: Array<{
    name: string;
    call: (c: ReturnType<typeof dataRig>['client']) => Promise<unknown>;
    path: string;
    query: Record<string, string>;
  }> = [
    {
      name: 'earningPools',
      call: (c) => c.rewards.earningPools().firstPage(),
      path: `${PUBLIC}/earning-pools`,
      query: {},
    },
    {
      name: 'groups',
      call: (c) => c.rewards.groups().firstPage(),
      path: `${PUBLIC}/groups`,
      query: { page: '0' },
    },
    {
      name: 'groups with every param',
      call: (c) =>
        c.rewards
          .groups({
            page: 0,
            page_size: 2,
            currency: 'USDC',
            include_zero: true,
          })
          .firstPage(),
      path: `${PUBLIC}/groups`,
      query: {
        page: '0',
        page_size: '2',
        currency: 'USDC',
        include_zero: 'true',
      },
    },
    {
      name: 'group',
      call: (c) => c.rewards.group(REWARD_GROUP),
      path: `${PUBLIC}/groups/${REWARD_GROUP}`,
      query: {},
    },
    {
      name: 'marketConfig',
      call: (c) => c.rewards.marketConfig(REWARD_MARKET),
      path: `${PUBLIC}/markets/${REWARD_MARKET}/config`,
      query: {},
    },
    {
      name: 'market',
      call: (c) => c.rewards.market(REWARD_MARKET),
      path: `${PUBLIC}/markets/${REWARD_MARKET}`,
      query: {},
    },
    {
      name: 'marketEpoch',
      call: (c) => c.rewards.marketEpoch(REWARD_MARKET, SCORED_EPOCH),
      path: `${PUBLIC}/markets/${REWARD_MARKET}/epochs/${SCORED_EPOCH}`,
      query: {},
    },
    {
      name: 'marketEpochMakers',
      call: (c) =>
        c.rewards.marketEpochMakers(REWARD_MARKET, SCORED_EPOCH).firstPage(),
      path: `${PUBLIC}/markets/${REWARD_MARKET}/epochs/${SCORED_EPOCH}/makers`,
      query: { page: '0' },
    },
    {
      name: 'marketEpochMakers with a page size',
      call: (c) =>
        c.rewards
          .marketEpochMakers(REWARD_MARKET, SCORED_EPOCH, {
            page: 1,
            page_size: 2,
          })
          .firstPage(),
      path: `${PUBLIC}/markets/${REWARD_MARKET}/epochs/${SCORED_EPOCH}/makers`,
      query: { page: '1', page_size: '2' },
    },
    {
      name: 'marketEpochOrders',
      call: (c) =>
        c.rewards.marketEpochOrders(REWARD_MARKET, SCORED_EPOCH).firstPage(),
      path: `${PUBLIC}/markets/${REWARD_MARKET}/epochs/${SCORED_EPOCH}/orders`,
      query: { page: '0' },
    },
    {
      name: 'marketEpochOrders by maker',
      call: (c) =>
        c.rewards
          .marketEpochOrders(REWARD_MARKET, SCORED_EPOCH, {
            maker: MAKER.toUpperCase().replace('0X', '0x'),
            page_size: 3,
          })
          .firstPage(),
      path: `${PUBLIC}/markets/${REWARD_MARKET}/epochs/${SCORED_EPOCH}/orders`,
      // The wallet goes out in lower case, as the backend keys its cache.
      query: { page: '0', page_size: '3', maker: MAKER },
    },
    {
      name: 'marketWallet',
      call: (c) => c.rewards.marketWallet(REWARD_MARKET, MAKER),
      path: `${PUBLIC}/markets/${REWARD_MARKET}/wallets/${MAKER}`,
      query: {},
    },
    {
      name: 'marketWallet with every param',
      call: (c) =>
        c.rewards.marketWallet(REWARD_MARKET, MAKER, {
          epoch: SCORED_EPOCH,
          currency: 'CP',
          page: 0,
          page_size: 2,
        }),
      path: `${PUBLIC}/markets/${REWARD_MARKET}/wallets/${MAKER}`,
      query: {
        epoch: String(SCORED_EPOCH),
        currency: 'CP',
        page: '0',
        page_size: '2',
      },
    },
    {
      name: 'wallet',
      call: (c) => c.rewards.wallet(MAKER),
      path: `${PUBLIC}/wallets/${MAKER}/summary`,
      query: {},
    },
    {
      name: 'walletEpoch',
      call: (c) => c.rewards.walletEpoch(MAKER, SCORED_EPOCH),
      path: `${PUBLIC}/wallets/${MAKER}/epochs/${SCORED_EPOCH}`,
      query: {},
    },
    {
      name: 'walletOrders',
      call: (c) => c.rewards.walletOrders(MAKER).firstPage(),
      path: `${PUBLIC}/wallets/${MAKER}/orders`,
      query: { page: '0' },
    },
    {
      name: 'walletOrders with every param',
      call: (c) =>
        c.rewards
          .walletOrders(MAKER, {
            market_id: REWARD_MARKET,
            epoch: SCORED_EPOCH,
            page: 0,
            page_size: 2,
            live: false,
          })
          .firstPage(),
      path: `${PUBLIC}/wallets/${MAKER}/orders`,
      query: {
        market_id: REWARD_MARKET,
        epoch: String(SCORED_EPOCH),
        page: '0',
        page_size: '2',
        live: 'false',
      },
    },
  ];

  test.each(CASES)(
    '$name: GET $path, no Authorization',
    async ({ call, path, query }) => {
      // The client holds a session with a key; a public route must not send it.
      const { client, backend } = dataRig(server, { session: true });
      await call(client);
      const request = last(backend);
      expect(request.method).toBe('GET');
      expect(request.path).toBe(path);
      expect(request.query).toEqual(query);
      expect(request.authorization).toBeNull();
      expect(request.sdk).toBe('ts/9.9.9');
    },
  );

  test('they work with no session at all', async () => {
    const { client, backend } = dataRig(server);
    await client.rewards.earningPools().firstPage();
    await client.rewards.wallet(MAKER);
    expect(calls(backend)).toEqual([
      `GET ${PUBLIC}/earning-pools`,
      `GET ${PUBLIC}/wallets/${MAKER}/summary`,
    ]);
    expect(backend.requests.every((r) => r.authorization === null)).toBe(true);
  });

  test('a checksummed wallet and an upper-case condition id are sent in lower case', async () => {
    const { client, backend } = dataRig(server);
    const checksummed = '0x3466591038dD6DDc7C56A15A273Bb51Bf7D1E01a';
    await client.rewards.wallet(checksummed);
    expect(last(backend).path).toBe(
      `${PUBLIC}/wallets/${checksummed.toLowerCase()}/summary`,
    );
    // The backend's cache and the rewards service want the lower-case id: the backend answers 404
    // for the same id in upper case.
    const upper = `0x${REWARD_MARKET.slice(2).toUpperCase()}`;
    await client.rewards.marketConfig(upper);
    expect(last(backend).path).toBe(
      `${PUBLIC}/markets/${REWARD_MARKET}/config`,
    );
  });

  test('an upper-case group id is sent in lower case', async () => {
    const { client, backend } = dataRig(server);
    const upper = `0x${REWARD_GROUP.slice(2).toUpperCase()}`;
    await client.rewards.group(upper);
    expect(last(backend).path).toBe(`${PUBLIC}/groups/${REWARD_GROUP}`);
  });
});

// ---------------------------------------------------------------------------
// The account's own routes: path, query, the key
// ---------------------------------------------------------------------------

describe('"mine" routes (shared: the session key)', () => {
  const CASES: Array<{
    name: string;
    call: (c: ReturnType<typeof dataRig>['client']) => Promise<unknown>;
    path: string;
    query: Record<string, string>;
  }> = [
    {
      name: 'mySummary',
      call: (c) => c.rewards.mySummary(),
      path: `${MINE}/me/summary`,
      query: {},
    },
    {
      name: 'myEpoch',
      call: (c) => c.rewards.myEpoch(SCORED_EPOCH),
      path: `${MINE}/me/epochs/${SCORED_EPOCH}`,
      query: {},
    },
    {
      name: 'myOrders',
      call: (c) => c.rewards.myOrders().firstPage(),
      path: `${MINE}/me/orders`,
      query: { page: '0' },
    },
    {
      name: 'myOrders with every param',
      call: (c) =>
        c.rewards
          .myOrders({
            market_id: REWARD_MARKET,
            epoch: SCORED_EPOCH,
            page: 0,
            page_size: 5,
            live: true,
          })
          .firstPage(),
      path: `${MINE}/me/orders`,
      query: {
        market_id: REWARD_MARKET,
        epoch: String(SCORED_EPOCH),
        page: '0',
        page_size: '5',
        live: 'true',
      },
    },
    {
      name: 'myGroupHistory',
      call: (c) => c.rewards.myGroupHistory().firstPage(),
      path: `${MINE}/me/group-history`,
      query: { page: '0' },
    },
    {
      name: 'myGroupHistory with a page size',
      call: (c) =>
        c.rewards.myGroupHistory({ page: 0, page_size: 2 }).firstPage(),
      path: `${MINE}/me/group-history`,
      query: { page: '0', page_size: '2' },
    },
    {
      name: 'myMarket',
      call: (c) => c.rewards.myMarket(REWARD_MARKET),
      path: `${MINE}/markets/${REWARD_MARKET}/me`,
      query: {},
    },
    {
      name: 'myMarket with every param',
      call: (c) =>
        c.rewards.myMarket(REWARD_MARKET, {
          epoch: SCORED_EPOCH,
          currency: 'USDC',
          page: 0,
          page_size: 1,
        }),
      path: `${MINE}/markets/${REWARD_MARKET}/me`,
      query: {
        epoch: String(SCORED_EPOCH),
        currency: 'USDC',
        page: '0',
        page_size: '1',
      },
    },
    {
      name: 'myGroup',
      call: (c) => c.rewards.myGroup(REWARD_GROUP),
      path: `${MINE}/groups/${REWARD_GROUP}/me`,
      query: {},
    },
    {
      name: 'myGroup with an epoch and a rail',
      call: (c) =>
        c.rewards.myGroup(REWARD_GROUP, {
          epoch: SCORED_EPOCH,
          currency: 'CP',
        }),
      path: `${MINE}/groups/${REWARD_GROUP}/me`,
      query: { epoch: String(SCORED_EPOCH), currency: 'CP' },
    },
    {
      name: 'leaderboard',
      call: (c) => c.rewards.leaderboard().firstPage(),
      path: `${MINE}/leaderboard`,
      query: { page: '1' },
    },
    {
      name: 'leaderboard with every param',
      call: (c) =>
        c.rewards
          .leaderboard({ period: 'daily', page: 1, take: 3 })
          .firstPage(),
      path: `${MINE}/leaderboard`,
      query: { period: 'daily', page: '1', take: '3' },
    },
    {
      name: 'myRank',
      call: (c) => c.rewards.myRank(),
      path: `${MINE}/leaderboard/me`,
      query: {},
    },
    {
      name: 'myRank for a period',
      call: (c) => c.rewards.myRank({ period: 'seasonal' }),
      path: `${MINE}/leaderboard/me`,
      query: { period: 'seasonal' },
    },
  ];

  test.each(CASES)(
    '$name: GET $path with the session key',
    async ({ call, path, query }) => {
      const { client, backend } = dataRig(server, { session: true });
      await call(client);
      const request = last(backend);
      expect(request.method).toBe('GET');
      expect(request.path).toBe(path);
      expect(request.query).toEqual(query);
      expect(request.authorization).toBe(`Bearer ${API_KEY}`);
      expect(request.sdk).toBe('ts/9.9.9');
    },
  );

  test.each(CASES)(
    '$name without a signer and without a key: AuthRequiredError, and no request',
    async ({ call }) => {
      const { client, backend } = dataRig(server, { session: 'none' });
      const failure = await caught(() => call(client));
      expect(failure).toBeInstanceOf(AuthRequiredError);
      expect((failure as Error).message).toContain('`signer`');
      expect((failure as Error).message).toContain('credentials');
      expectNoRequest(backend);
    },
  );

  test('a client with no session and a transport with no auth provider fails the same way', async () => {
    const { client, backend } = dataRig(server);
    for (const { call } of CASES) {
      expect(await caught(() => call(client))).toBeInstanceOf(
        AuthRequiredError,
      );
    }
    expectNoRequest(backend);
  });

  test('the public twin of a "mine" route needs no key, and the same wallet gets the same data', async () => {
    const { client, backend } = dataRig(server, { session: true });
    const mine = await client.rewards.mySummary();
    const theirs = await client.rewards.wallet(OWNER_WALLET);
    expect(theirs).toEqual(mine);
    expect(backend.requests.map((r) => r.authorization)).toEqual([
      `Bearer ${API_KEY}`,
      null,
    ]);
  });
});

// ---------------------------------------------------------------------------
// What the answers look like: case is the backend's, money is exact
// ---------------------------------------------------------------------------

describe('answers keep the backend’s field names, camelCase and snake_case, as sent', () => {
  test('every route parses to exactly what the backend sent (lenient and strict)', async () => {
    for (const strict of [false, true]) {
      const { client } = dataRig(server, { session: true, strict });
      const label = strict ? 'strict' : 'lenient';

      // The lists: the whole answer (`raw`) is what the backend sent, and the items are the
      // list inside it.
      const expectPage = (
        page: { raw: unknown; items: unknown[] },
        fixture: Record<string, unknown>,
        key: string,
      ) => {
        expect(page.raw, `${label} ${key} raw`).toEqual(fixture);
        expect(page.items, `${label} ${key} items`).toEqual(fixture[key]);
      };

      const pools = await client.rewards.earningPools().firstPage();
      expectPage(pools, earningPoolsFixture(), 'data');
      expect(pools.items[0]?.marketId, label).toBe(REWARD_MARKET);
      expectPage(
        await client.rewards.groups().firstPage(),
        groupsFixture(0, 100),
        'groups',
      );
      expectPage(
        await client.rewards
          .marketEpochMakers(REWARD_MARKET, SCORED_EPOCH)
          .firstPage(),
        marketMakersFixture(REWARD_MARKET, SCORED_EPOCH, 0, 100),
        'makers',
      );
      expectPage(
        await client.rewards
          .marketEpochOrders(REWARD_MARKET, SCORED_EPOCH)
          .firstPage(),
        marketOrdersFixture(REWARD_MARKET, SCORED_EPOCH, 0, 100, undefined),
        'orders',
      );
      // A populated page of scored orders: the day is settled, the wallet has five.
      const ordersOf = (wallet: string) =>
        walletOrdersFixture(wallet, {
          epoch: SCORED_EPOCH,
          page: 0,
          pageSize: 100,
        });
      expectPage(
        await client.rewards
          .walletOrders(MAKER, { epoch: SCORED_EPOCH })
          .firstPage(),
        ordersOf(MAKER),
        'orders',
      );
      expectPage(
        await client.rewards.myOrders({ epoch: SCORED_EPOCH }).firstPage(),
        ordersOf(OWNER_WALLET),
        'orders',
      );
      expectPage(
        await client.rewards.myGroupHistory().firstPage(),
        groupHistoryFixture(OWNER_WALLET, 0, 100),
        'lines',
      );
      expectPage(
        await client.rewards.leaderboard().firstPage(),
        leaderboardFixture('weekly', 1, 10),
        'data',
      );

      expect(await client.rewards.group(REWARD_GROUP), label).toEqual(
        groupDetailFixture(REWARD_GROUP),
      );
      expect(await client.rewards.marketConfig(REWARD_MARKET), label).toEqual(
        marketConfigFixture(REWARD_MARKET),
      );
      expect(await client.rewards.market(REWARD_MARKET), label).toEqual(
        marketDetailFixture(REWARD_MARKET),
      );
      expect(
        await client.rewards.marketEpoch(REWARD_MARKET, SCORED_EPOCH),
        label,
      ).toEqual(marketEpochFixture(REWARD_MARKET, SCORED_EPOCH));
      expect(
        await client.rewards.marketEpoch(REWARD_MARKET, TODAY_EPOCH),
        label,
      ).toEqual(marketEpochFixture(REWARD_MARKET, TODAY_EPOCH));
      expect(
        await client.rewards.marketWallet(REWARD_MARKET, MAKER, {
          epoch: SCORED_EPOCH,
        }),
        label,
      ).toEqual(
        marketDayFixture(REWARD_MARKET, MAKER, {
          epoch: SCORED_EPOCH,
          page: 0,
          pageSize: 100,
        }),
      );
      expect(await client.rewards.wallet(MAKER), label).toEqual(
        walletSummaryFixture(MAKER),
      );
      expect(await client.rewards.wallet(STRANGER), label).toEqual(
        walletSummaryFixture(STRANGER),
      );
      expect(
        await client.rewards.walletEpoch(MAKER, SCORED_EPOCH),
        label,
      ).toEqual(walletEpochFixture(MAKER, SCORED_EPOCH));
      expect(
        await client.rewards.walletEpoch(STRANGER, SCORED_EPOCH),
        label,
      ).toEqual(walletEpochFixture(STRANGER, SCORED_EPOCH));
      // The day in progress has no scored orders yet: the live overlay (`applied`) answers.
      expect(
        (await client.rewards.walletOrders(MAKER).firstPage()).items,
        label,
      ).toEqual([]);

      expect(await client.rewards.mySummary(), label).toEqual(
        walletSummaryFixture(OWNER_WALLET),
      );
      expect(await client.rewards.myEpoch(SCORED_EPOCH), label).toEqual(
        walletEpochFixture(OWNER_WALLET, SCORED_EPOCH),
      );
      expect(
        await client.rewards.myMarket(REWARD_MARKET, { epoch: SCORED_EPOCH }),
        label,
      ).toEqual(
        marketDayFixture(REWARD_MARKET, OWNER_WALLET, {
          epoch: SCORED_EPOCH,
          page: 0,
          pageSize: 100,
        }),
      );
      expect(await client.rewards.myGroup(REWARD_GROUP), label).toEqual(
        groupDayFixture(REWARD_GROUP, OWNER_WALLET, undefined),
      );
      const rank = await client.rewards.myRank();
      expect(rank, label).toEqual(leaderboardRowFixture(OWNER_RANK));
    }
  });

  test('camelCase fields stay camelCase and snake_case fields stay snake_case, in the same payload', async () => {
    const { client } = dataRig(server, { session: true });
    const page = await client.rewards
      .walletOrders(MAKER, { epoch: SCORED_EPOCH })
      .firstPage();
    const order = page.items[0] as RewardsMakerOrder;
    // The rewards service's fields are snake_case; the two the backend adds are camelCase.
    expect(Object.keys(order)).toEqual(
      expect.arrayContaining([
        'market_id',
        'order_id',
        'price_tick',
        'maker_score_share',
        'opening_size_micro',
        'closing_size_micro',
        'openingSizeShares',
        'closingSizeShares',
      ]),
    );
    expect(order).not.toHaveProperty('marketId');
    expect(order).not.toHaveProperty('openingSizeMicro');
    expect(order).not.toHaveProperty('opening_size_shares');
    const raw = page.raw as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual(
      expect.arrayContaining([
        'payout_summary',
        'live_status',
        'markets',
        'user',
      ]),
    );
    // The profile is the backend's own presenter: camelCase.
    expect(Object.keys(raw.user as object)).toEqual(
      expect.arrayContaining(['profilePictureUrl', 'roosterColor', 'cpPoints']),
    );

    // The earning pools are the backend's presenter (camelCase) around snake_case nowhere.
    const [pool] = await client.rewards.earningPools().toArray(1);
    expect(pool?.cp?.minOrderRestMs).toBe(500);
    expect(pool).not.toHaveProperty('market_id');

    // The market config is the rewards service's (snake_case) with the backend's `programmes`.
    const config = await client.rewards.marketConfig(REWARD_MARKET);
    expect(config.programmes[0]?.min_order_rest_ms).toBe(500);
    expect(config).not.toHaveProperty('marketId');

    // The wallet summary is the backend's presenter (camelCase), the wallet epoch the rewards
    // service's.
    const summary = await client.rewards.wallet(MAKER);
    expect(summary.me?.cp.creatorBonus.lifetime).toBe('0.00');
    const epoch = await client.rewards.walletEpoch(MAKER, SCORED_EPOCH);
    expect(epoch.effective_cp).toBe('133.19');
    expect(epoch.user?.profilePictureUrl).toBe(
      'https://img.example/profile.jpg',
    );
  });
});

describe('money is exact text, never a float', () => {
  test('amounts are decimal strings as sent: no rounding, no trailing-zero loss', async () => {
    const { client } = dataRig(server);
    const [pool] = await client.rewards.earningPools().toArray(1);
    expect(pool?.cp?.dailyPool).toBe('200.00');
    expect(pool?.usdc?.dailyRate).toBe('1004.000000');
    expect(pool?.usdc?.budgetTotal).toBe('1004.018060');
    const config = await client.rewards.marketConfig(REWARD_MARKET);
    // The config says "1004.01806": the text is kept, not "1004.018060".
    expect(config.programmes[1]?.budget_total).toBe('1004.01806');
    const makers = await client.rewards
      .marketEpochMakers(REWARD_MARKET, SCORED_EPOCH)
      .toArray();
    expect(makers[0]?.effective_cp).toBe('68.75');
    expect(makers[0]?.score).toBe('35277817245000.000000');
  });

  test('a score is kept whole: a number would lose digits past 2^53', async () => {
    const { client, backend } = dataRig(server);
    const exact = '385300915998620.312037';
    expect(Number(exact).toString()).not.toBe(exact);
    backend.override = (request) =>
      request.path.endsWith('/config') || request.path.includes('/epochs/')
        ? undefined
        : request.path.endsWith(`/markets/${REWARD_MARKET}`)
          ? HttpResponse.json({
              ...marketDetailFixture(REWARD_MARKET),
              total_scored_liquidity: exact,
            })
          : undefined;
    const market = await client.rewards.market(REWARD_MARKET);
    expect(market.total_scored_liquidity).toBe(exact);
    expect(typeof market.total_scored_liquidity).toBe('string');
  });

  test('a JSON number in a money field is converted exactly, not left as a float', async () => {
    const { client, backend } = dataRig(server);
    backend.override = (request) =>
      request.path.endsWith(`/wallets/${MAKER}/epochs/${SCORED_EPOCH}`)
        ? HttpResponse.json({
            ...walletEpochFixture(MAKER, SCORED_EPOCH),
            effective_cp: 133.19,
            allocated_cp: 1e-7,
            credited_cp: null,
          })
        : undefined;
    const epoch = await client.rewards.walletEpoch(MAKER, SCORED_EPOCH);
    expect(epoch.effective_cp).toBe('133.19');
    expect(epoch.allocated_cp).toBe('0.0000001');
    expect(epoch.credited_cp).toBeNull();
    expect(typeof epoch.effective_cp).toBe('string');
  });

  test('a money field that is not a plain decimal fails the response, without the value in the message', async () => {
    const { client, backend } = dataRig(server);
    // The real summary, with only one money field replaced: the failure is that field alone.
    const real = walletSummaryFixture(MAKER) as {
      me: { usdc: object; cp: object };
    };
    backend.override = (request) =>
      request.path.endsWith('/summary')
        ? HttpResponse.json({
            ...real,
            me: {
              ...real.me,
              cp: { ...real.me.cp, totalReceived: 'NaN-secret-42' },
            },
          })
        : undefined;
    const failure = await caught(() => client.rewards.wallet(MAKER));
    expect(failure).toBeInstanceOf(UnexpectedResponseError);
    expect((failure as Error).message).not.toContain('NaN-secret-42');
    const issues = (failure as UnexpectedResponseError).issues as Array<{
      path: string;
    }>;
    expect(issues.map((issue) => issue.path)).toEqual(['me.cp.totalReceived']);
  });

  test('raw units and whole units are told apart by the types', async () => {
    const { client } = dataRig(server);
    const [order] = await client.rewards
      .walletOrders(MAKER, { epoch: SCORED_EPOCH })
      .toArray(1);
    const row = order as RewardsMakerOrder;
    expect(row.opening_size_micro).toBe('1000000000');
    expect(row.openingSizeShares).toBe(1000);
    // A raw amount is not whole units: `priceToTick` refuses it at compile time.
    // @ts-expect-error RawUnitsString is not a whole-unit amount
    expect(() => priceToTick(row.opening_size_micro)).toThrow();
  });
});

describe('types', () => {
  test('money: reward amounts are whole-unit DecimalStrings, sizes in micro-shares are RawUnitsStrings', () => {
    expectTypeOf<RewardAmount['amount']>().toEqualTypeOf<DecimalString>();
    expectTypeOf<RewardAmount['currency']>().toEqualTypeOf<
      'CP' | 'USDC' | (string & {})
    >();
    expectTypeOf<RewardsMaker['effective_cp']>().toEqualTypeOf<DecimalString>();
    expectTypeOf<RewardsMaker['allocated_cp']>().toEqualTypeOf<DecimalString>();
    expectTypeOf<
      RewardsMaker['credited_cp']
    >().toEqualTypeOf<DecimalString | null>();
    expectTypeOf<
      RewardsMarketEpoch['pool']
    >().toEqualTypeOf<DecimalString | null>();
    expectTypeOf<
      RewardsWalletEpoch['effective_cp']
    >().toEqualTypeOf<DecimalString>();
    expectTypeOf<
      EarningPoolCp['dailyPool']
    >().toEqualTypeOf<DecimalString | null>();
    expectTypeOf<
      EarningPoolCp['minPayout']
    >().toEqualTypeOf<DecimalString | null>();
    expectTypeOf<
      EarningPoolUsdc['escrowed']
    >().toEqualTypeOf<DecimalString | null>();
    expectTypeOf<
      EarningPoolUsdc['dailyRate']
    >().toEqualTypeOf<DecimalString | null>();
    expectTypeOf<
      RewardsLeaderboardRow['liquidityCp']
    >().toEqualTypeOf<DecimalString>();
    expectTypeOf<
      RewardsMakerOrder['opening_size_micro']
    >().toEqualTypeOf<RawUnitsString>();
    expectTypeOf<
      RewardsMakerOrder['closing_size_micro']
    >().toEqualTypeOf<RawUnitsString>();
    expectTypeOf<
      RewardsMarketOrder['opening_size_micro']
    >().toEqualTypeOf<RawUnitsString>();
    // Raw and whole units are different types.
    expectTypeOf<RawUnitsString>().not.toEqualTypeOf<DecimalString>();
    expectTypeOf<
      RewardsMakerOrder['opening_size_micro']
    >().not.toEqualTypeOf<DecimalString>();
  });

  test('numbers: counts, ticks, ids, timestamps, ranks and share counts stay numbers; scores stay exact text', () => {
    expectTypeOf<RewardsMakerOrder['price_tick']>().toEqualTypeOf<number>();
    expectTypeOf<RewardsMakerOrder['eligible_ms']>().toEqualTypeOf<number>();
    expectTypeOf<
      RewardsMakerOrder['openingSizeShares']
    >().toEqualTypeOf<number>();
    expectTypeOf<RewardsMarketEpoch['maker_count']>().toEqualTypeOf<number>();
    expectTypeOf<RewardsMarketEpoch['day_open_ms']>().toEqualTypeOf<number>();
    expectTypeOf<RewardsLeaderboardRow['rank']>().toEqualTypeOf<number>();
    expectTypeOf<RewardsLeaderboardRow['marketDays']>().toEqualTypeOf<number>();
    expectTypeOf<RewardsUser['cpPoints']>().toEqualTypeOf<number>();
    expectTypeOf<EarningPoolCp['minOrderSizeShares']>().toEqualTypeOf<
      number | null
    >();
    // A score is an exact decimal that does not fit a float: text, and not money.
    expectTypeOf<RewardsMaker['score']>().toEqualTypeOf<string>();
    expectTypeOf<RewardsMaker['score_share']>().toEqualTypeOf<string>();
    expectTypeOf<RewardsMakerOrder['score']>().toEqualTypeOf<string>();
    expectTypeOf<
      RewardsMarket['total_scored_liquidity']
    >().toEqualTypeOf<string>();
  });

  test('the namespace returns the types of its routes', () => {
    type Rewards = DataClient['rewards'];
    expectTypeOf<
      Rewards['market']
    >().returns.resolves.toEqualTypeOf<RewardsMarket>();
    expectTypeOf<
      Rewards['marketConfig']
    >().returns.resolves.toEqualTypeOf<RewardsMarketConfig>();
    expectTypeOf<
      Rewards['marketEpoch']
    >().returns.resolves.toEqualTypeOf<RewardsMarketEpoch>();
    expectTypeOf<
      Rewards['marketWallet']
    >().returns.resolves.toEqualTypeOf<RewardsMarketDay>();
    expectTypeOf<
      Rewards['myMarket']
    >().returns.resolves.toEqualTypeOf<RewardsMarketDay>();
    expectTypeOf<
      Rewards['wallet']
    >().returns.resolves.toEqualTypeOf<RewardsWalletSummary>();
    expectTypeOf<
      Rewards['mySummary']
    >().returns.resolves.toEqualTypeOf<RewardsWalletSummary>();
    expectTypeOf<
      Rewards['walletEpoch']
    >().returns.resolves.toEqualTypeOf<RewardsWalletEpoch>();
    expectTypeOf<
      Rewards['myEpoch']
    >().returns.resolves.toEqualTypeOf<RewardsWalletEpoch>();
    expectTypeOf<
      Rewards['myGroup']
    >().returns.resolves.toEqualTypeOf<RewardsGroupDay>();
    expectTypeOf<
      Rewards['group']
    >().returns.resolves.toEqualTypeOf<RewardsGroupDetail>();
    expectTypeOf<
      Rewards['myRank']
    >().returns.resolves.toEqualTypeOf<RewardsLeaderboardRow>();
    expectTypeOf<Rewards['currentEpoch']>().returns.toEqualTypeOf<number>();
    expectTypeOf<Rewards['currentEpoch']>().parameters.toEqualTypeOf<
      [now?: Date]
    >();
    expectTypeOf<Rewards['earningPools']>().returns.toEqualTypeOf<
      Paginator<EarningPool>
    >();
    expectTypeOf<Rewards['groups']>().returns.toEqualTypeOf<
      Paginator<RewardsGroup>
    >();
    expectTypeOf<Rewards['marketEpochMakers']>().returns.toEqualTypeOf<
      Paginator<RewardsMaker>
    >();
    expectTypeOf<Rewards['marketEpochOrders']>().returns.toEqualTypeOf<
      Paginator<RewardsMarketOrder>
    >();
    expectTypeOf<Rewards['walletOrders']>().returns.toEqualTypeOf<
      Paginator<RewardsMakerOrder>
    >();
    expectTypeOf<Rewards['myOrders']>().returns.toEqualTypeOf<
      Paginator<RewardsMakerOrder>
    >();
    expectTypeOf<Rewards['myGroupHistory']>().returns.toEqualTypeOf<
      Paginator<RewardsGroupHistoryLine>
    >();
    expectTypeOf<Rewards['leaderboard']>().returns.toEqualTypeOf<
      Paginator<RewardsLeaderboardRow>
    >();
  });
});

// ---------------------------------------------------------------------------
// Strict and lenient parsing
// ---------------------------------------------------------------------------

describe('what live answers taught', () => {
  test('a multi-outcome market names its outcomes: the book’s outcome is the title, not Yes or No', async () => {
    const { client, backend } = dataRig(server, { strict: true });
    backend.override = (request) => {
      if (!request.path.endsWith('/earning-pools')) return undefined;
      const answer = earningPoolsFixture() as {
        data: Array<{
          market: { bookSnapshot: { books: Array<{ outcome: string }> } };
        }>;
      };
      const books = answer.data[0]?.market.bookSnapshot.books ?? [];
      const names = ['Charles Leclerc', 'Lewis Hamilton'];
      for (const [index, book] of books.entries()) {
        book.outcome = names[index] ?? book.outcome;
      }
      return HttpResponse.json(answer);
    };
    const [pool] = await client.rewards.earningPools().toArray(1);
    expect(
      pool?.market?.bookSnapshot?.books.map((book) => book.outcome),
    ).toEqual(['Charles Leclerc', 'Lewis Hamilton']);
  });

  test('a group’s product label can have no slug', async () => {
    const { client, backend } = dataRig(server, {
      session: true,
      strict: true,
    });
    backend.override = (request) =>
      request.path.endsWith('/me/group-history')
        ? HttpResponse.json({
            ...groupHistoryFixture(OWNER_WALLET, 0, 100),
            products: { [REWARD_GROUP]: { ...PRODUCT, slug: null } },
          })
        : request.path.endsWith('/groups')
          ? HttpResponse.json({
              ...(groupsFixture(0, 100) as object),
              groups: [
                { ...groupFixture(0), product: { ...PRODUCT, slug: null } },
              ],
            })
          : undefined;
    const page = await client.rewards.myGroupHistory().firstPage();
    expect(
      (page.raw as { products: Record<string, { slug: string | null }> })
        .products[REWARD_GROUP]?.slug,
    ).toBeNull();
    const [group] = await client.rewards.groups().toArray(1);
    expect(group?.product?.slug).toBeNull();
  });
});

describe('strictResponses', () => {
  test('lenient keeps a field the schemas do not know; strict refuses it', async () => {
    const extra = { surprise: 'new-field' };
    const lenient = dataRig(server);
    lenient.backend.override = (request) =>
      request.path.endsWith(`/wallets/${MAKER}/summary`)
        ? HttpResponse.json({ ...walletSummaryFixture(MAKER), ...extra })
        : undefined;
    const kept = await lenient.client.rewards.wallet(MAKER);
    expect(kept).toHaveProperty('surprise', 'new-field');

    const strict = dataRig(server, { strict: true });
    strict.backend.override = lenient.backend.override;
    const failure = await caught(() => strict.client.rewards.wallet(MAKER));
    expect(failure).toBeInstanceOf(UnexpectedResponseError);
    const issues = (failure as UnexpectedResponseError).issues as Array<{
      path: string;
      code: string;
    }>;
    expect(issues[0]?.code).toBe('unrecognized_keys');
    expect(issues[0]?.path).toBe('(root)');
  });

  test('strict also refuses an unknown value of a server enum, lenient keeps it', async () => {
    const override = (request: { path: string }) =>
      request.path.endsWith(`/epochs/${SCORED_EPOCH}`) &&
      request.path.includes('/markets/')
        ? HttpResponse.json({
            ...marketEpochFixture(REWARD_MARKET, SCORED_EPOCH),
            status: 'brand_new_status',
          })
        : undefined;
    const lenient = dataRig(server);
    lenient.backend.override = override;
    expect(
      (await lenient.client.rewards.marketEpoch(REWARD_MARKET, SCORED_EPOCH))
        .status,
    ).toBe('brand_new_status');
    const strict = dataRig(server, { strict: true });
    strict.backend.override = override;
    expect(
      await caught(() =>
        strict.client.rewards.marketEpoch(REWARD_MARKET, SCORED_EPOCH),
      ),
    ).toBeInstanceOf(UnexpectedResponseError);
  });

  test('a missing field the type promises fails in both flavours', async () => {
    const { client, backend } = dataRig(server);
    backend.override = (request) => {
      if (!request.path.endsWith('/config')) return undefined;
      const { programmes: _gone, ...rest } = marketConfigFixture(REWARD_MARKET);
      return HttpResponse.json(rest);
    };
    expect(
      await caught(() => client.rewards.marketConfig(REWARD_MARKET)),
    ).toBeInstanceOf(UnexpectedResponseError);
  });

  test('the totals of a group history are typed: amounts per rail, base and bonus halves, market-days', async () => {
    const { client } = dataRig(server, { session: true, strict: true });
    const page = await client.rewards.myGroupHistory().firstPage();
    const history = page.raw as RewardsGroupHistory;
    const [totals] = history.totals_by_currency ?? [];
    expect(totals?.currency).toBe('CP');
    expect(totals?.allocated).toEqual({ amount: '206.25', currency: 'CP' });
    expect(totals?.base_effective?.amount).toBe('206.25');
    expect(totals?.bonus_effective?.amount).toBe('0.00');
    expect(totals?.market_days).toBe(HISTORY_TOTAL);
    expectTypeOf<RewardsGroupHistoryTotals['effective']>().toEqualTypeOf<
      RewardAmount | undefined
    >();
    expectTypeOf<RewardsGroupHistoryTotals['bonus_effective']>().toEqualTypeOf<
      RewardAmount | undefined
    >();
    expectTypeOf<RewardsGroupHistoryTotals['market_days']>().toEqualTypeOf<
      number | undefined
    >();
    // The labels cover every known group, not only the groups of the account's own lines.
    expect(new Set(page.items.map((line) => line.group_id))).toEqual(
      new Set([groupIdAt(0)]),
    );
    expect(Object.keys(history.products)).toEqual(
      Array.from({ length: GROUPS_TOTAL }, (_, n) => groupIdAt(n)),
    );
    expect(history.products[groupIdAt(1)]).toBeNull();
  });

  test('a total with a malformed amount fails the response (the object stays loose, its amounts are checked)', async () => {
    const { client, backend } = dataRig(server, { session: true });
    backend.override = (request) =>
      request.path.endsWith('/me/group-history')
        ? HttpResponse.json({
            ...groupHistoryFixture(OWNER_WALLET, 0, 100),
            totals_by_currency: [
              { currency: 'CP', allocated: { amount: 'lots', currency: 'CP' } },
            ],
          })
        : undefined;
    expect(
      await caught(() => client.rewards.myGroupHistory().firstPage()),
    ).toBeInstanceOf(UnexpectedResponseError);
  });

  test('the answers of the rewards service that the backend passes through untouched keep their unknown fields even in strict mode (group day and history)', async () => {
    const { client, backend } = dataRig(server, {
      session: true,
      strict: true,
    });
    backend.override = (request) =>
      request.path.endsWith('/me/group-history')
        ? HttpResponse.json({
            ...groupHistoryFixture(OWNER_WALLET, 0, 100),
            newUpstreamField: { nested: true },
          })
        : request.path.endsWith('/me')
          ? HttpResponse.json({
              ...groupDayFixture(REWARD_GROUP, OWNER_WALLET, undefined),
              newUpstreamField: 1,
            })
          : undefined;
    const day = await client.rewards.myGroup(REWARD_GROUP);
    expect(day).toHaveProperty('newUpstreamField', 1);
    const page = await client.rewards.myGroupHistory().firstPage();
    expect(page.raw).toHaveProperty('newUpstreamField');
  });
});

describe('marketEpoch carries both rails: the USDC fields sit beside the CP ones', () => {
  const epochOverride =
    (body: unknown) =>
    (request: {
      path: string;
    }): ReturnType<typeof HttpResponse.json> | undefined =>
      request.path.endsWith(`/epochs/${SCORED_EPOCH}`) &&
      request.path.includes('/markets/')
        ? HttpResponse.json(body as Record<string, unknown>)
        : undefined;

  test.each([false, true])(
    'a day with every USDC field parses, typed (strict: %s)',
    async (strict) => {
      const { client } = dataRig(server, { strict });
      for (const epoch of [SCORED_EPOCH, TODAY_EPOCH]) {
        const day = await client.rewards.marketEpoch(REWARD_MARKET, epoch);
        expect(day).toEqual(marketEpochFixture(REWARD_MARKET, epoch));
      }
      const settled = await client.rewards.marketEpoch(
        REWARD_MARKET,
        SCORED_EPOCH,
      );
      expect(settled.pool_usdc).toBe('500.000000');
      expect(settled.status_usdc).toBe('settled');
      expect(settled.total_score_usdc).toBe('12345678901234.500000');
      expect(settled.maker_count_usdc).toBe(2);
      expect(settled.allocated_usdc).toBe('200.008826');
      expect(settled.credited_usdc).toBe('200.008826');
      expect(settled.projected_usdc).toBe(false);
      expect(settled.projected_through_ms_usdc).toBeNull();
      expect(settled.top_makers_usdc?.[0]).toEqual({
        user_id: MAKER,
        score: '12345678901234.500000',
        score_share: '1.00000000',
        effective_usdc: '200.008826',
        allocated_usdc: '200.008826',
        credited_usdc: '200.008826',
        status: 'paid',
      });
      const today = await client.rewards.marketEpoch(
        REWARD_MARKET,
        TODAY_EPOCH,
      );
      expect(today.projected_usdc).toBe(true);
      expect(today.projected_through_ms_usdc).toBe(1_792_332_596_709);
      expect(today.top_makers_usdc?.[0]?.credited_usdc).toBeNull();
    },
  );

  test.each([false, true])(
    'a response without the USDC rail still parses (strict: %s)',
    async (strict) => {
      const { client, backend } = dataRig(server, { strict });
      const withoutUsdc = marketEpochFixture(REWARD_MARKET, SCORED_EPOCH, {
        usdc: false,
      });
      expect(
        Object.keys(withoutUsdc).some((key) => key.endsWith('_usdc')),
      ).toBe(false);
      backend.override = epochOverride(withoutUsdc);
      const day = await client.rewards.marketEpoch(REWARD_MARKET, SCORED_EPOCH);
      expect(day).toEqual(withoutUsdc);
      expect(day.pool_usdc).toBeUndefined();
      expect(day.top_makers_usdc).toBeUndefined();
      expect(day.omitted_rails).toEqual(['USDC']);
    },
  );

  test.each([false, true])(
    'a rail with no programme sends nulls and zeros, and they parse (strict: %s)',
    async (strict) => {
      const { client, backend } = dataRig(server, { strict });
      backend.override = epochOverride({
        ...marketEpochFixture(REWARD_MARKET, SCORED_EPOCH),
        pool_usdc: null,
        status_usdc: null,
        total_score_usdc: '0.000000',
        maker_count_usdc: 0,
        allocated_usdc: '0.000000',
        credited_usdc: null,
        projected_usdc: false,
        projected_through_ms_usdc: null,
        top_makers_usdc: [],
      });
      const day = await client.rewards.marketEpoch(REWARD_MARKET, SCORED_EPOCH);
      expect(day.pool_usdc).toBeNull();
      expect(day.status_usdc).toBeNull();
      expect(day.credited_usdc).toBeNull();
      expect(day.top_makers_usdc).toEqual([]);
    },
  );

  test('USDC money is exact text, and a JSON number in a money field is converted exactly', async () => {
    const { client, backend } = dataRig(server);
    backend.override = epochOverride({
      ...marketEpochFixture(REWARD_MARKET, SCORED_EPOCH),
      pool_usdc: 1004.01806,
      allocated_usdc: 200.008826,
      credited_usdc: 1e-6,
      top_makers_usdc: [
        {
          ...(
            marketEpochFixture(REWARD_MARKET, SCORED_EPOCH) as {
              top_makers_usdc: object[];
            }
          ).top_makers_usdc[0],
          effective_usdc: 200.008826,
        },
      ],
    });
    const day = await client.rewards.marketEpoch(REWARD_MARKET, SCORED_EPOCH);
    expect(day.pool_usdc).toBe('1004.01806');
    expect(day.allocated_usdc).toBe('200.008826');
    expect(day.credited_usdc).toBe('0.000001');
    expect(day.top_makers_usdc?.[0]?.effective_usdc).toBe('200.008826');
  });

  test.each([
    ['pool_usdc', { pool_usdc: { amount: '1' } }],
    ['maker_count_usdc', { maker_count_usdc: '2' }],
    ['allocated_usdc', { allocated_usdc: 'lots' }],
    ['credited_usdc', { credited_usdc: true }],
    ['projected_usdc', { projected_usdc: 'yes' }],
    [
      'projected_through_ms_usdc',
      { projected_through_ms_usdc: '1792332596709' },
    ],
    ['total_score_usdc', { total_score_usdc: [] }],
    ['top_makers_usdc, not a list', { top_makers_usdc: {} }],
    [
      'top_makers_usdc, a line without its user',
      { top_makers_usdc: [{ score: '1' }] },
    ],
  ])(
    'a wrong-typed %s is an UnexpectedResponseError, strict or not',
    async (_name, patch) => {
      for (const strict of [false, true]) {
        const { client, backend } = dataRig(server, { strict });
        backend.override = epochOverride({
          ...marketEpochFixture(REWARD_MARKET, SCORED_EPOCH),
          ...patch,
        });
        expect(
          await caught(() =>
            client.rewards.marketEpoch(REWARD_MARKET, SCORED_EPOCH),
          ),
          `strict: ${strict}`,
        ).toBeInstanceOf(UnexpectedResponseError);
      }
    },
  );

  test('a wrong-typed field of a USDC maker line fails the answer', async () => {
    const line = (
      marketEpochFixture(REWARD_MARKET, SCORED_EPOCH) as {
        top_makers_usdc: object[];
      }
    ).top_makers_usdc[0];
    for (const patch of [
      { effective_usdc: 'lots' },
      { allocated_usdc: null },
      { credited_usdc: false },
      { score_share: {} },
      { status: 7 },
    ]) {
      const { client, backend } = dataRig(server);
      backend.override = epochOverride({
        ...marketEpochFixture(REWARD_MARKET, SCORED_EPOCH),
        top_makers_usdc: [{ ...line, ...patch }],
      });
      expect(
        await caught(() =>
          client.rewards.marketEpoch(REWARD_MARKET, SCORED_EPOCH),
        ),
        JSON.stringify(patch),
      ).toBeInstanceOf(UnexpectedResponseError);
    }
  });

  test('strict refuses an unknown status of the USDC rail and an unknown key of a USDC line; lenient keeps both', async () => {
    const line = (
      marketEpochFixture(REWARD_MARKET, SCORED_EPOCH) as {
        top_makers_usdc: object[];
      }
    ).top_makers_usdc[0];
    const body = {
      ...marketEpochFixture(REWARD_MARKET, SCORED_EPOCH),
      status_usdc: 'brand_new_status',
      top_makers_usdc: [{ ...line, surprise: 1 }],
    };
    const lenient = dataRig(server);
    lenient.backend.override = epochOverride(body);
    const kept = await lenient.client.rewards.marketEpoch(
      REWARD_MARKET,
      SCORED_EPOCH,
    );
    expect(kept.status_usdc).toBe('brand_new_status');
    expect(kept.top_makers_usdc?.[0]).toHaveProperty('surprise', 1);
    const strict = dataRig(server, { strict: true });
    strict.backend.override = epochOverride(body);
    expect(
      await caught(() =>
        strict.client.rewards.marketEpoch(REWARD_MARKET, SCORED_EPOCH),
      ),
    ).toBeInstanceOf(UnexpectedResponseError);
    // Each refusal on its own.
    for (const patch of [
      { status_usdc: 'brand_new_status' },
      { top_makers_usdc: [{ ...line, surprise: 1 }] },
    ]) {
      const only = dataRig(server, { strict: true });
      only.backend.override = epochOverride({
        ...marketEpochFixture(REWARD_MARKET, SCORED_EPOCH),
        ...patch,
      });
      expect(
        await caught(() =>
          only.client.rewards.marketEpoch(REWARD_MARKET, SCORED_EPOCH),
        ),
        JSON.stringify(Object.keys(patch)),
      ).toBeInstanceOf(UnexpectedResponseError);
    }
  });

  test('types: the USDC fields mirror the CP ones, optional, money as DecimalString', () => {
    expectTypeOf<RewardsMarketEpoch['pool_usdc']>().toEqualTypeOf<
      DecimalString | null | undefined
    >();
    expectTypeOf<RewardsMarketEpoch['allocated_usdc']>().toEqualTypeOf<
      DecimalString | undefined
    >();
    expectTypeOf<RewardsMarketEpoch['credited_usdc']>().toEqualTypeOf<
      DecimalString | null | undefined
    >();
    expectTypeOf<RewardsMarketEpoch['total_score_usdc']>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<RewardsMarketEpoch['maker_count_usdc']>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<RewardsMarketEpoch['projected_usdc']>().toEqualTypeOf<
      boolean | undefined
    >();
    expectTypeOf<
      RewardsMarketEpoch['projected_through_ms_usdc']
    >().toEqualTypeOf<number | null | undefined>();
    expectTypeOf<RewardsMarketEpoch['top_makers_usdc']>().toEqualTypeOf<
      RewardsUsdcMaker[] | undefined
    >();
    expectTypeOf<
      RewardsUsdcMaker['effective_usdc']
    >().toEqualTypeOf<DecimalString>();
    expectTypeOf<
      RewardsUsdcMaker['allocated_usdc']
    >().toEqualTypeOf<DecimalString>();
    expectTypeOf<
      RewardsUsdcMaker['credited_usdc']
    >().toEqualTypeOf<DecimalString | null>();
    expectTypeOf<RewardsUsdcMaker['score']>().toEqualTypeOf<string>();
    expectTypeOf<RewardsUsdcMaker['status']>().toEqualTypeOf<
      RewardsMaker['status']
    >();
    expectTypeOf<RewardsMarketEpoch['status_usdc']>().toEqualTypeOf<
      RewardsMarketEpoch['status'] | undefined
    >();
  });
});

// ---------------------------------------------------------------------------
// Pagination: the shapes of the lists
// ---------------------------------------------------------------------------

describe('pagination', () => {
  test('earningPools is one page: { data, meta } with the epoch meta kept on raw', async () => {
    const { client, backend } = dataRig(server);
    const pages = [];
    for await (const page of client.rewards.earningPools().pages())
      pages.push(page);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.hasNext).toBe(false);
    expect(pages[0]?.items.map((pool) => pool.marketId)).toEqual([
      REWARD_MARKET,
      REWARD_MARKET_2,
    ]);
    const raw = pages[0]?.raw as { meta: { currentEpoch: number } };
    expect(raw.meta.currentEpoch).toBe(TODAY_EPOCH);
    expect(backend.requests).toHaveLength(1);
    // The Pulse row carries its group.
    expect(pages[0]?.items[1]?.group?.groupId).toBe(REWARD_GROUP);
    expect(pages[0]?.items[0]?.group).toBeNull();
  });

  test('groups pages are 0-based and end at total', async () => {
    const { client, backend } = dataRig(server);
    const paginator = client.rewards.groups({ page_size: 2 });
    const pages = [];
    for await (const page of paginator.pages()) pages.push(page);
    expect(pages.map((page) => page.items.length)).toEqual([2, 1]);
    expect(pages.map((page) => page.hasNext)).toEqual([true, false]);
    expect(backend.requests.map((r) => r.query)).toEqual([
      { page: '0', page_size: '2' },
      { page: '1', page_size: '2' },
    ]);
    expect(pages[0]?.items.map((g) => g.group_id)).toEqual([
      groupIdAt(0),
      groupIdAt(1),
    ]);
    // The envelope (the epoch and the totals) is on raw.
    expect(pages[0]?.raw).toEqual(
      expect.objectContaining({
        total: GROUPS_TOTAL,
        current_epoch: TODAY_EPOCH,
      }),
    );
    // The label of a group's product, and null when it has none.
    expect(pages[0]?.items[0]?.product?.name).toBe('5m Up/Down');
    expect(pages[0]?.items[1]?.product).toBeNull();
  });

  test('a traversal starts at the page the caller gives (the first page is 0)', async () => {
    const { client, backend } = dataRig(server);
    const items = await client.rewards
      .groups({ page: 1, page_size: 2 })
      .toArray();
    expect(items).toHaveLength(1);
    expect(backend.requests.map((r) => r.query.page)).toEqual(['1']);
    const all = await client.rewards
      .groups({ page: 0, page_size: 100 })
      .toArray();
    expect(all).toHaveLength(GROUPS_TOTAL);
    expect(backend.requests.at(-1)?.query.page).toBe('0');
  });

  test('marketEpochMakers: pages of makers until total, with the day’s totals on raw', async () => {
    const { client, backend } = dataRig(server);
    const pages = [];
    for await (const page of client.rewards
      .marketEpochMakers(REWARD_MARKET, SCORED_EPOCH, { page_size: 2 })
      .pages()) {
      pages.push(page);
    }
    expect(pages.map((page) => page.items.length)).toEqual([2, 2, 1]);
    expect(pages.map((page) => page.hasNext)).toEqual([true, true, false]);
    expect(backend.requests.map((r) => r.query.page)).toEqual(['0', '1', '2']);
    expect(pages.flatMap((page) => page.items)).toHaveLength(MAKERS_TOTAL);
    expect(pages[0]?.items[0]?.user_id).toBe(MAKER);
    expect(pages[0]?.raw).toEqual(
      expect.objectContaining({ total: MAKERS_TOTAL, omitted_rails: ['USDC'] }),
    );
    // The first maker is the one the wallet routes use.
    const first = pages[0]?.items[0] as RewardsMaker;
    expect(first.status).toBe('paid');
  });

  test('marketEpochOrders pages and the maker filter', async () => {
    const { client, backend } = dataRig(server);
    const all = await client.rewards
      .marketEpochOrders(REWARD_MARKET, SCORED_EPOCH, { page_size: 2 })
      .toArray();
    expect(all).toHaveLength(ORDERS_TOTAL);
    expect(backend.requests.map((r) => r.query.page)).toEqual(['0', '1', '2']);
    const mine = await client.rewards
      .marketEpochOrders(REWARD_MARKET, SCORED_EPOCH, { maker: MAKER })
      .toArray();
    expect(mine).toHaveLength(3);
    expect(mine.every((order) => order.maker === MAKER)).toBe(true);
    // The last order of the fixture was filled.
    expect(all.at(-1)?.exit_kind).toBe('filled');
    expect(all[0]?.exit_kind).toBeNull();
  });

  test.each([
    [
      'walletOrders',
      (c: ReturnType<typeof dataRig>['client'], p: object) =>
        c.rewards.walletOrders(MAKER, p),
    ],
    [
      'myOrders',
      (c: ReturnType<typeof dataRig>['client'], p: object) =>
        c.rewards.myOrders(p),
    ],
  ])(
    '%s pages the scored orders, 0-based, with the day’s payout summary on raw',
    async (_name, list) => {
      const { client, backend } = dataRig(server, { session: true });
      const pages = [];
      for await (const page of list(client, {
        epoch: SCORED_EPOCH,
        page_size: 2,
      }).pages()) {
        pages.push(page);
      }
      expect(pages.map((page) => page.items.length)).toEqual([2, 2, 1]);
      expect(backend.requests.map((r) => r.query.page)).toEqual([
        '0',
        '1',
        '2',
      ]);
      const raw = pages[0]?.raw as {
        total: number;
        payout_summary: { markets: unknown[]; groups: unknown[] };
        markets: Record<string, unknown>;
      };
      expect(raw.total).toBe(ORDERS_TOTAL);
      expect(raw.payout_summary.markets).toHaveLength(2);
      expect(raw.payout_summary.groups).toHaveLength(1);
      expect(Object.keys(raw.markets)).toEqual([REWARD_MARKET]);
      // A Pulse group order carries its window.
      const groupOrder = pages[2]?.items[0] as RewardsMakerOrder;
      expect(groupOrder.group_id).toBe(REWARD_GROUP);
      expect(groupOrder.window_state).toBe('accruing');
      expect(pages[0]?.items[0]?.group_id).toBeNull();
    },
  );

  test('a wallet with no orders gets one empty page', async () => {
    const { client, backend } = dataRig(server);
    const page = await client.rewards.walletOrders(STRANGER).firstPage();
    expect(page.items).toEqual([]);
    expect(page.hasNext).toBe(false);
    expect(backend.requests).toHaveLength(1);
    expect((page.raw as { user: unknown }).user).toBeNull();
  });

  test('myGroupHistory pages the settled group-days', async () => {
    const { client, backend } = dataRig(server, { session: true });
    const pages = [];
    for await (const page of client.rewards
      .myGroupHistory({ page_size: 2 })
      .pages()) {
      pages.push(page);
    }
    expect(pages.map((page) => page.items.length)).toEqual([2, 1]);
    expect(backend.requests.map((r) => r.query.page)).toEqual(['0', '1']);
    expect(pages[0]?.items[0]?.epoch).toBe(SCORED_EPOCH);
    expect(pages[0]?.raw).toEqual(
      expect.objectContaining({ total: HISTORY_TOTAL }),
    );
  });

  test('leaderboard is 1-based { data, meta } and ends at meta.hasNextPage', async () => {
    const { client, backend } = dataRig(server, { session: true });
    const pages = [];
    for await (const page of client.rewards.leaderboard({ take: 2 }).pages()) {
      pages.push(page);
    }
    expect(pages.map((page) => page.items.map((row) => row.rank))).toEqual([
      [1, 2],
      [3, 4],
      [5],
    ]);
    expect(pages.map((page) => page.hasNext)).toEqual([true, true, false]);
    expect(backend.requests.map((r) => r.query)).toEqual([
      { page: '1', take: '2' },
      { page: '2', take: '2' },
      { page: '3', take: '2' },
    ]);
    // The window and the total are on raw.
    expect(pages[0]?.raw).toEqual(
      expect.objectContaining({
        period: 'weekly',
        totalCp: '48210.75',
        fromEpoch: 20_737,
      }),
    );
    expect(LEADERBOARD_TOTAL).toBe(5);
    const second = await client.rewards
      .leaderboard({ page: 2, take: 2 })
      .toArray(1);
    expect(second[0]?.rank).toBe(3);
  });

  test('toArray(max), break and re-iteration behave like every other paginator', async () => {
    const { client, backend } = dataRig(server);
    const makers = client.rewards.marketEpochMakers(
      REWARD_MARKET,
      SCORED_EPOCH,
      {
        page_size: 2,
      },
    );
    expect(backend.requests).toHaveLength(0);
    expect(await makers.toArray(3)).toHaveLength(3);
    expect(backend.requests).toHaveLength(2);
    for await (const _ of makers) break;
    expect(backend.requests).toHaveLength(3);
    expect(await makers.toArray()).toHaveLength(MAKERS_TOTAL);
  });

  test('a route that says there is more but answers an empty page ends the traversal', async () => {
    const { client, backend } = dataRig(server);
    backend.override = (request) =>
      request.path.endsWith('/makers')
        ? HttpResponse.json({
            ...(marketEpochFixture(REWARD_MARKET, SCORED_EPOCH) as object),
            page: Number(request.query.page ?? 0),
            page_size: 2,
            total: 99,
            projected: false,
            projected_through_ms: null,
            makers: [],
          })
        : undefined;
    expect(
      await client.rewards
        .marketEpochMakers(REWARD_MARKET, SCORED_EPOCH)
        .toArray(),
    ).toEqual([]);
    expect(backend.requests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Validation: before any request
// ---------------------------------------------------------------------------

describe('the market is a condition id', () => {
  const METHODS: Array<
    [string, (c: ReturnType<typeof dataRig>['client'], id: string) => unknown]
  > = [
    ['marketConfig', (c, id) => c.rewards.marketConfig(id)],
    ['market', (c, id) => c.rewards.market(id)],
    ['marketEpoch', (c, id) => c.rewards.marketEpoch(id, SCORED_EPOCH)],
    [
      'marketEpochMakers',
      (c, id) => c.rewards.marketEpochMakers(id, SCORED_EPOCH),
    ],
    [
      'marketEpochOrders',
      (c, id) => c.rewards.marketEpochOrders(id, SCORED_EPOCH),
    ],
    ['marketWallet', (c, id) => c.rewards.marketWallet(id, MAKER)],
    ['myMarket', (c, id) => c.rewards.myMarket(id)],
  ];

  test.each(METHODS)(
    '%s refuses what is not 0x and 64 hex digits, before any request',
    async (_name, call) => {
      const { client, backend } = dataRig(server, { session: true });
      for (const bad of [
        '',
        '0x',
        '0x1234',
        REWARD_MARKET.slice(0, -1),
        `${REWARD_MARKET}0`,
        `0X${REWARD_MARKET.slice(2)}`,
        // A contract address (40 hex digits) is not the id the rewards ledger keys on.
        `0x${'ab'.repeat(20)}`,
        // The numeric database id of a market is not a condition id: the backend answers 404 for
        // it.
        69_781,
        '69781',
        'not-a-market',
        null,
        undefined,
        {},
      ]) {
        const failure = await caught(async () => call(client, bad as never));
        expect(failure, String(bad)).toBeInstanceOf(UserInputError);
        expect((failure as XoError).code).toBe('invalid_input');
        expect((failure as Error).message).toContain('conditionId');
      }
      expectNoRequest(backend);
    },
  );

  test('the message tells a numeric market id from a condition id', async () => {
    const { client } = dataRig(server);
    const failure = await caught(async () =>
      client.rewards.market(69_781 as never),
    );
    expect((failure as Error).message).toMatch(/64 hex/);
  });

  test('a condition id the ledger does not know is a 404 rejection', async () => {
    const { client } = dataRig(server, { session: true });
    for (const run of [
      () => client.rewards.marketConfig(UNENROLLED_MARKET),
      () => client.rewards.market(UNENROLLED_MARKET),
      () => client.rewards.marketEpoch(UNENROLLED_MARKET, SCORED_EPOCH),
      () => client.rewards.myMarket(UNENROLLED_MARKET),
    ]) {
      expect(await caught(run)).toSatisfy(rejectedWith(404));
    }
  });
});

describe('the group is a bytes32 id', () => {
  test('group and myGroup refuse anything else, before any request', async () => {
    const { client, backend } = dataRig(server, { session: true });
    for (const bad of [
      '',
      '0x12',
      REWARD_MARKET.slice(0, -2),
      `0x${'zz'.repeat(32)}`,
      42,
      null,
    ]) {
      for (const run of [
        () => client.rewards.group(bad as never),
        () => client.rewards.myGroup(bad as never),
      ]) {
        const failure = await caught(async () => run());
        expect(failure, String(bad)).toBeInstanceOf(UserInputError);
        expect((failure as Error).message).toContain('groupId');
      }
    }
    expectNoRequest(backend);
  });

  test('an unknown group is a 404 rejection', async () => {
    const { client } = dataRig(server, { session: true });
    expect(await caught(() => client.rewards.group(UNKNOWN_GROUP))).toSatisfy(
      rejectedWith(404),
    );
    expect(await caught(() => client.rewards.myGroup(UNKNOWN_GROUP))).toSatisfy(
      rejectedWith(404),
    );
  });
});

describe('the wallet is a 20-byte address', () => {
  test('refuses anything else, before any request', async () => {
    const { client, backend } = dataRig(server);
    for (const bad of [
      '',
      '0x',
      '0x123',
      `0x${'g'.repeat(40)}`,
      `${MAKER}00`,
      'xouser1148',
      5,
      null,
    ]) {
      for (const run of [
        () => client.rewards.wallet(bad as never),
        () => client.rewards.walletEpoch(bad as never, SCORED_EPOCH),
        () => client.rewards.walletOrders(bad as never),
        () => client.rewards.marketWallet(REWARD_MARKET, bad as never),
        () =>
          client.rewards.marketEpochOrders(REWARD_MARKET, SCORED_EPOCH, {
            maker: bad as never,
          }),
      ]) {
        const failure = await caught(async () => run());
        expect(failure, String(bad)).toBeInstanceOf(UserInputError);
      }
    }
    expectNoRequest(backend);
  });
});

describe('the epoch is a whole number from 0 to 10_000_000', () => {
  const EPOCH_METHODS: Array<
    [
      string,
      (c: ReturnType<typeof dataRig>['client'], epoch: unknown) => unknown,
    ]
  > = [
    [
      'marketEpoch',
      (c, e) => c.rewards.marketEpoch(REWARD_MARKET, e as number),
    ],
    [
      'marketEpochMakers',
      (c, e) => c.rewards.marketEpochMakers(REWARD_MARKET, e as number),
    ],
    [
      'marketEpochOrders',
      (c, e) => c.rewards.marketEpochOrders(REWARD_MARKET, e as number),
    ],
    ['walletEpoch', (c, e) => c.rewards.walletEpoch(MAKER, e as number)],
    ['myEpoch', (c, e) => c.rewards.myEpoch(e as number)],
  ];

  test.each(EPOCH_METHODS)(
    '%s refuses a negative, fractional, huge, non-finite or non-number epoch, before any request',
    async (_name, call) => {
      const { client, backend } = dataRig(server, { session: true });
      for (const bad of [
        -1,
        -0.5,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        2 ** 53,
        Number.MAX_SAFE_INTEGER,
        10_000_001,
        '20743',
        '',
        '-1',
        null,
        undefined,
        {},
        20_743n,
      ]) {
        const failure = await caught(async () => call(client, bad));
        expect(failure, String(bad)).toBeInstanceOf(UserInputError);
        expect((failure as XoError).code).toBe('invalid_input');
        expect((failure as Error).message).toContain('epoch');
      }
      expectNoRequest(backend);
    },
  );

  test('0, a day number and the backend’s maximum are accepted', async () => {
    const { client, backend } = dataRig(server, { session: true });
    for (const epoch of [0, 1, SCORED_EPOCH, 10_000_000]) {
      await client.rewards.walletEpoch(MAKER, epoch);
      expect(last(backend).path).toBe(
        `${PUBLIC}/wallets/${MAKER}/epochs/${epoch}`,
      );
      await client.rewards.myEpoch(epoch);
      expect(last(backend).path).toBe(`${MINE}/me/epochs/${epoch}`);
    }
  });

  test('the epoch param of the other routes is checked the same way', async () => {
    const { client, backend } = dataRig(server, { session: true });
    for (const bad of [-1, 1.5, 10_000_001, '20743', Number.NaN]) {
      // The lists throw at once...
      expect(() =>
        client.rewards.walletOrders(MAKER, { epoch: bad as never }),
      ).toThrow(UserInputError);
      expect(() => client.rewards.myOrders({ epoch: bad as never })).toThrow(
        UserInputError,
      );
      // ...the single answers reject.
      for (const run of [
        () =>
          client.rewards.marketWallet(REWARD_MARKET, MAKER, {
            epoch: bad as never,
          }),
        () => client.rewards.myMarket(REWARD_MARKET, { epoch: bad as never }),
        () => client.rewards.myGroup(REWARD_GROUP, { epoch: bad as never }),
      ]) {
        expect(await caught(async () => run()), String(bad)).toBeInstanceOf(
          UserInputError,
        );
      }
    }
    expectNoRequest(backend);
  });
});

describe('params are closed objects', () => {
  test('an unknown key is a UserInputError naming it and the allowed ones, before any request', () => {
    const { client, backend } = dataRig(server, { session: true });
    const cases: Array<() => unknown> = [
      () => client.rewards.groups({ nope: 1 } as never),
      () =>
        client.rewards.marketEpochMakers(REWARD_MARKET, SCORED_EPOCH, {
          nope: 1,
        } as never),
      () =>
        client.rewards.marketEpochOrders(REWARD_MARKET, SCORED_EPOCH, {
          nope: 1,
        } as never),
      () => client.rewards.walletOrders(MAKER, { nope: 1 } as never),
      () => client.rewards.myOrders({ nope: 1 } as never),
      () => client.rewards.myGroupHistory({ nope: 1 } as never),
      () => client.rewards.leaderboard({ nope: 1 } as never),
    ];
    for (const run of cases) {
      expect(run).toThrow(UserInputError);
      expect(run).toThrow(/unknown param "nope"/);
    }
    expect(() =>
      client.rewards.walletOrders(MAKER, { nope: 1 } as never),
    ).toThrow(/allowed: market_id, epoch, page, page_size, live/);
    expectNoRequest(backend);
  });

  test('the promise methods reject for an unknown key', async () => {
    const { client, backend } = dataRig(server, { session: true });
    for (const run of [
      () =>
        client.rewards.marketWallet(REWARD_MARKET, MAKER, { nope: 1 } as never),
      () => client.rewards.myMarket(REWARD_MARKET, { nope: 1 } as never),
      () => client.rewards.myGroup(REWARD_GROUP, { nope: 1 } as never),
      () => client.rewards.myRank({ nope: 1 } as never),
    ]) {
      expect(await caught(async () => run())).toBeInstanceOf(UserInputError);
    }
    expectNoRequest(backend);
  });

  test('the backend’s names are the params’: a camelCase twin is refused with a hint', () => {
    const { client } = dataRig(server, { session: true });
    expect(() =>
      client.rewards.walletOrders(MAKER, { pageSize: 5 } as never),
    ).toThrow(/pageSize is not available: use page_size/);
    expect(() =>
      client.rewards.walletOrders(MAKER, { marketId: REWARD_MARKET } as never),
    ).toThrow(/marketId is not available: use market_id/);
    expect(() => client.rewards.groups({ pageSize: 5 } as never)).toThrow(
      /pageSize is not available: use page_size/,
    );
    expect(() => client.rewards.groups({ includeZero: true } as never)).toThrow(
      /includeZero is not available: use include_zero/,
    );
    expect(() => client.rewards.leaderboard({ pageSize: 5 } as never)).toThrow(
      /pageSize is not available: use take/,
    );
  });

  test('the leaderboard takes period, page and take only: the DTO accepts search and sort but the route ignores them', () => {
    const { client } = dataRig(server, { session: true });
    for (const key of ['search', 'sortBy', 'sortOrder']) {
      expect(() => client.rewards.leaderboard({ [key]: 'x' } as never)).toThrow(
        new RegExp(`${key} is not available: the route ignores it`),
      );
    }
  });

  test('a param object must be an object, undefined and {} are the defaults', async () => {
    const { client, backend } = dataRig(server, { session: true });
    for (const bad of [null, 5, 'x', []]) {
      expect(() => client.rewards.groups(bad as never)).toThrow(UserInputError);
    }
    await client.rewards.groups({}).firstPage();
    await client.rewards.groups(undefined).firstPage();
    expect(backend.requests.map((r) => r.query)).toEqual([
      { page: '0' },
      { page: '0' },
    ]);
  });

  test('ranges and enums are checked against the backend DTOs, before any request', () => {
    const { client, backend } = dataRig(server, { session: true });
    const bad: Array<[string, () => unknown]> = [
      ['groups page -1', () => client.rewards.groups({ page: -1 })],
      [
        'groups page 1_000_001',
        () => client.rewards.groups({ page: 1_000_001 }),
      ],
      ['groups page 1.5', () => client.rewards.groups({ page: 1.5 })],
      ['groups page_size 0', () => client.rewards.groups({ page_size: 0 })],
      ['groups page_size 101', () => client.rewards.groups({ page_size: 101 })],
      [
        'groups currency',
        () => client.rewards.groups({ currency: 'EUR' as never }),
      ],
      [
        'groups include_zero text',
        () => client.rewards.groups({ include_zero: 'true' as never }),
      ],
      [
        'makers page_size 0',
        () =>
          client.rewards.marketEpochMakers(REWARD_MARKET, 1, { page_size: 0 }),
      ],
      [
        'makers page_size 1001',
        () =>
          client.rewards.marketEpochMakers(REWARD_MARKET, 1, {
            page_size: 1001,
          }),
      ],
      [
        'makers page -1',
        () => client.rewards.marketEpochMakers(REWARD_MARKET, 1, { page: -1 }),
      ],
      [
        'orders maker',
        () =>
          client.rewards.marketEpochOrders(REWARD_MARKET, 1, { maker: 'bob' }),
      ],
      [
        'wallet orders page_size 1001',
        () => client.rewards.walletOrders(MAKER, { page_size: 1001 }),
      ],
      [
        'wallet orders live text',
        () => client.rewards.walletOrders(MAKER, { live: 'false' as never }),
      ],
      [
        'wallet orders market_id',
        () => client.rewards.walletOrders(MAKER, { market_id: '69781' }),
      ],
      [
        'my orders epoch latest',
        () => client.rewards.myOrders({ epoch: 'latest' as never }),
      ],
      [
        'group history page_size 101',
        () => client.rewards.myGroupHistory({ page_size: 101 }),
      ],
      [
        'leaderboard period',
        () => client.rewards.leaderboard({ period: 'monthly' as never }),
      ],
      ['leaderboard page 0', () => client.rewards.leaderboard({ page: 0 })],
      [
        'leaderboard page 10001',
        () => client.rewards.leaderboard({ page: 10_001 }),
      ],
      ['leaderboard take 0', () => client.rewards.leaderboard({ take: 0 })],
      [
        'leaderboard take 1001',
        () => client.rewards.leaderboard({ take: 1001 }),
      ],
    ];
    for (const [name, run] of bad) {
      expect(run, name).toThrow(UserInputError);
    }
    expectNoRequest(backend);
  });

  test('the boundaries of the ranges are accepted', async () => {
    const { client, backend } = dataRig(server, { session: true });
    await client.rewards
      .groups({ page: 1_000_000, page_size: 100 })
      .firstPage();
    await client.rewards.groups({ page: 0, page_size: 1 }).firstPage();
    await client.rewards
      .marketEpochMakers(REWARD_MARKET, 1, { page_size: 1000 })
      .firstPage();
    await client.rewards.leaderboard({ page: 10_000, take: 1000 }).firstPage();
    await client.rewards.myGroupHistory({ page_size: 100 }).firstPage();
    expect(backend.requests).toHaveLength(5);
  });

  test('a value is never echoed in the message', () => {
    const { client } = dataRig(server, { session: true });
    try {
      client.rewards.groups({ currency: 'SECRET-VALUE' as never });
    } catch (error) {
      expect((error as Error).message).not.toContain('SECRET-VALUE');
      return;
    }
    throw new Error('expected a throw');
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe('errors', () => {
  test('a dual-rail market whose CP-only makers page the rewards service refuses is a 409 rejection', async () => {
    const { client, backend } = dataRig(server);
    backend.override = (request) =>
      request.path.endsWith('/makers')
        ? exceptionResponse(request.path, 409, {
            error: 'Conflict',
            message: 'market is on both rails',
          })
        : undefined;
    const failure = await caught(() =>
      client.rewards.marketEpochMakers(REWARD_MARKET, SCORED_EPOCH).firstPage(),
    );
    expect(failure).toSatisfy(rejectedWith(409));
    expect((failure as XoError).status).toBe(409);
    // The way round the JSDoc names: the day's rollup answers, with the top makers of both rails.
    backend.override = undefined;
    const day = await client.rewards.marketEpoch(REWARD_MARKET, SCORED_EPOCH);
    expect(day.top_makers).toHaveLength(2);
    expect(day.top_makers_usdc).toHaveLength(2);
    expect(day.omitted_rails).toBeUndefined();
  });

  test('a rollup that is all zeros is not an error: the backend answers 200 for an upstream failure too', async () => {
    // What the backend sends when the rewards service is down: the wallet looks like it
    // earned nothing. The SDK cannot tell it from a real zero, which the docs of walletEpoch say.
    const { client, backend } = dataRig(server, { session: true });
    backend.override = (request) =>
      request.path.includes('/epochs/')
        ? HttpResponse.json({
            user_id: OWNER_WALLET,
            epoch: SCORED_EPOCH,
            day_open_ms: SCORED_EPOCH * MS_DAY,
            day_close_ms: (SCORED_EPOCH + 1) * MS_DAY,
            flagged: false,
            effective_cp: '0.00',
            allocated_cp: '0.00',
            credited_cp: '0.00',
            markets: [],
          })
        : undefined;
    const mine = await client.rewards.myEpoch(SCORED_EPOCH);
    const theirs = await client.rewards.walletEpoch(MAKER, SCORED_EPOCH);
    for (const epoch of [mine, theirs]) {
      expect(epoch.markets).toEqual([]);
      expect(epoch.effective_cp).toBe('0.00');
      expect(epoch.user ?? null).toBeNull();
    }
  });

  test('an account that is not on the leaderboard is a 404 rejection', async () => {
    const { client, rewards } = dataRig(server, { session: true });
    rewards.unranked = true;
    const failure = await caught(() => client.rewards.myRank());
    expect(failure).toSatisfy(rejectedWith(404));
    expect((failure as Error).message).toContain('not ranked');
  });

  test('a 401 from the backend for a key it does not know is an auth error, not an empty answer', async () => {
    const { client, backend } = dataRig(server, { session: true });
    backend.validKeys.clear();
    const failure = await caught(() => client.rewards.mySummary());
    expect(failure).toSatisfy(rejectedWith(401));
    expect((failure as XoError).status).toBe(401);
  });
});

describe('what the rewards namespace is not', () => {
  test('the shared twins that have a public route are not offered', () => {
    const { client } = dataRig(server);
    const names = Object.getOwnPropertyNames(
      Object.getPrototypeOf(client.rewards),
    );
    // earning-pools and markets/:marketId/config are served by their public routes, which
    // need no credentials; coverage records the shared ones as skipped.
    expect(names).not.toContain('myEarningPools');
    expect(names).not.toContain('myMarketConfig');
    expect(names.sort()).toEqual(
      [
        'constructor',
        'currentEpoch',
        'earningPools',
        'group',
        'groups',
        'leaderboard',
        'market',
        'marketConfig',
        'marketEpoch',
        'marketEpochMakers',
        'marketEpochOrders',
        'marketWallet',
        'myEpoch',
        'myGroup',
        'myGroupHistory',
        'myMarket',
        'myOrders',
        'myRank',
        'mySummary',
        'wallet',
        'walletEpoch',
        'walletOrders',
      ].sort(),
    );
  });
});
