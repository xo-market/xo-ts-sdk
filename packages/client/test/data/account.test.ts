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
import {
  AuthRequiredError,
  type RequestRejectedError,
  UnexpectedResponseError,
  UserInputError,
} from '../../src/core/errors';
import type { DecimalString, RawUnitsString } from '../../src/core/types';
import type {
  AccountProfile,
  ApiKeyInfo,
  MarketActivity,
  OpenOrder,
  PortfolioMarket,
  PortfolioPosition,
  PortfolioValue,
  UserActivity,
  UserMarketActivity,
} from '../../src/data/client';
import {
  API_KEY,
  caught,
  dataRig,
  expectNoRequest,
  last,
} from '../helpers/dataRig';
import {
  ACTIVITY_COUNT,
  CLAIMABLE_COUNT,
  currentUserFixture,
  fixtures,
  OPEN_ORDER_COUNT,
  OTHER_KEY_ID,
  OWN_KEY_ID,
  OWNER,
  PNL_MARKET_ID,
  PNL_POSITION_ID,
  PUBLIC_USER,
} from '../helpers/mockAccountData';
import { exceptionResponse } from '../helpers/mockBackend';
import { activityFixture, pageMeta } from '../helpers/mockBackendData';
import { rejectedWith } from '../helpers/rejections';
import { testEnv } from '../helpers/testEnv';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

const ids = (rows: Array<{ id: number }>) => rows.map((row) => row.id);

describe('portfolio.mine', () => {
  test('GET /api/users/me/portfolio with the session key and the SDK header, and marketScope withPulse', async () => {
    const { client, backend } = dataRig(server, { session: true });
    const page = await client.portfolio.mine().firstPage();
    const request = last(backend);
    expect(request.method).toBe('GET');
    expect(request.path).toBe('/api/users/me/portfolio');
    // Holdings are not hidden by default: withPulse applies no type filter.
    expect(request.query).toEqual({ page: '1', marketScope: 'withPulse' });
    expect(request.authorization).toBe(`Bearer ${API_KEY}`);
    expect(request.sdk).toBe('ts/9.9.9');
    // Every position, the pulse round (market 2, type 3) included.
    expect(ids(page.items)).toEqual([1, 2, 5, 6, 12]);
  });

  test("marketScope 'withPulse' reaches every position, and an explicit scope is sent as given", async () => {
    const { client, backend } = dataRig(server, { session: true });
    const all = await client.portfolio
      .mine({ marketScope: 'withPulse' })
      .toArray(50);
    expect(ids(all)).toEqual([1, 2, 5, 6, 12]);
    expect(last(backend).query.marketScope).toBe('withPulse');
    const orderbook = await client.portfolio
      .mine({ marketScope: 'onlyClob' })
      .toArray(50);
    expect(ids(orderbook)).toEqual([1, 2, 12]);
    expect(last(backend).query.marketScope).toBe('onlyClob');
    // The backend's own default leaves the pulse round out; the caller can still ask for it.
    const backendDefault = await client.portfolio
      .mine({ marketScope: 'default' })
      .toArray(50);
    expect(ids(backendDefault)).toEqual([1, 5, 6, 12]);
    expect(last(backend).query.marketScope).toBe('default');
    const conviction = await client.portfolio
      .mine({ marketScope: 'onlyConviction' })
      .toArray(50);
    expect(ids(conviction)).toEqual([5]);
  });

  test('a summary row has the market, its positions, the totals and the event placement', async () => {
    const { client } = dataRig(server, { session: true });
    const [row] = await client.portfolio.mine({ take: 1 }).toArray(1);
    expect(row).toBeDefined();
    const market = row as PortfolioMarket;
    expect(market.slug).toBe('market-1');
    expect(market.positions).toHaveLength(2);
    expect(market.transactionCounts).toBe(2);
    expect(market.event?.rootEventSlug).toBe('argentina-vs-france');
    expect(market.event?.eventMedia[0]?.role).toBe('icon');
    // Whole-unit USD numbers become exact decimal strings...
    expect(market.totalStake).toBe('662.000004');
    expect(market.totalPnL).toBe('529.6000019999999');
    const position = market
      .positions[0] as PortfolioMarket['positions'][number];
    expect(position.entryValue).toBe('331.000002');
    expect(position.pnl).toBe('264.80000099999995');
    // ...a percentage stays a number, and the token's raw units stay strings.
    expect(position.pnlPercentage).toBe(79.9999998187311);
    expect(position.collateralAmount).toBe('331000002');
    expect(position.shareAmount).toBe('662000004');
    expect(position.entryPrice).toBe('500000');
    expect(position.currentPrice).toBe('900000');
    expect(position.totalPnlInCollateral).toBe('0');
    expect(market.positions[1]?.totalPnlInCollateral).toBe('-50000');
    expect(position.positionPerformance).toBe('80.0000');
    expect(market.redeemableAmountPerShare).toBeNull();
    expect(market.collateralToken).toEqual({
      id: 1,
      tokenAddress: testEnv.contracts.usdc,
      decimals: 6,
    });
  });

  test('the money fields are typed per presenter: raw token units or whole-unit decimals', () => {
    expectTypeOf<
      PortfolioMarket['totalStake']
    >().toEqualTypeOf<DecimalString>();
    expectTypeOf<
      PortfolioMarket['positions'][number]['collateralAmount']
    >().toEqualTypeOf<RawUnitsString>();
    expectTypeOf<
      PortfolioMarket['positions'][number]['shareAmount']
    >().toEqualTypeOf<RawUnitsString>();
    expectTypeOf<
      PortfolioMarket['positions'][number]['entryPrice']
    >().toEqualTypeOf<RawUnitsString | null>();
    expectTypeOf<
      PortfolioMarket['redeemableAmountPerShare']
    >().toEqualTypeOf<RawUnitsString | null>();
    expectTypeOf<
      PortfolioPosition['collateralAmount']
    >().toEqualTypeOf<RawUnitsString>();
    // The brand keeps a raw amount from standing in for a whole-unit decimal.
    expectTypeOf<RawUnitsString>().not.toEqualTypeOf<DecimalString>();
  });

  test('marketId switches to the detail mode: flat position rows', async () => {
    const { client, backend } = dataRig(server, { session: true });
    const rows = await client.portfolio.mine({ marketId: 6 }).toArray(50);
    expect(last(backend).query).toEqual({
      page: '1',
      marketId: '6',
      marketScope: 'withPulse',
    });
    expect(rows).toHaveLength(2);
    const position = rows[0] as PortfolioPosition;
    expect(position.marketId).toBe(6);
    expect(position.market.event).toBeNull();
    expect(position.outcome?.title).toBe('Yes');
    expectTypeOf(rows).toEqualTypeOf<PortfolioPosition[]>();
  });

  test('contractMarketId stays in the summary mode', async () => {
    const { client, backend } = dataRig(server, { session: true });
    await client.portfolio
      .mine({ contractMarketId: `0x${'06'.repeat(20)}` })
      .firstPage();
    expect(last(backend).query.marketScope).toBe('withPulse');
    expect(last(backend).query.contractMarketId).toBe(`0x${'06'.repeat(20)}`);
  });

  test('paginates {data, meta} by hasNextPage and keeps the raw page', async () => {
    const { client, backend } = dataRig(server, { session: true });
    const pages = [];
    for await (const page of client.portfolio
      .mine({ take: 2, marketScope: 'withPulse' })
      .pages()) {
      pages.push(page);
      if (pages.length >= 10) break;
    }
    expect(pages.map((page) => page.items.length)).toEqual([2, 2, 1]);
    expect(backend.requests.map((request) => request.query.page)).toEqual([
      '1',
      '2',
      '3',
    ]);
    const raw = pages[0]?.raw as { meta: Record<string, unknown> };
    expect(raw.meta).toMatchObject({ page: 1, take: 2, hasNextPage: true });
  });

  test('sends every param the DTO knows, and a market status list as comma-separated text', async () => {
    const { client, backend } = dataRig(server, { session: true });
    await client.portfolio
      .mine({
        page: 2,
        take: 5,
        search: 'btc',
        sortBy: 'pnl',
        sortOrder: 'ASC',
        marketScope: 'withClob',
        status: 'closed',
        marketStatus: ['CLOSED', 'RESOLVED'],
        refresh: true,
        claimableFirst: true,
      })
      .firstPage();
    expect(last(backend).query).toEqual({
      page: '2',
      take: '5',
      search: 'btc',
      sortBy: 'pnl',
      sortOrder: 'ASC',
      marketScope: 'withClob',
      status: 'closed',
      marketStatus: 'CLOSED,RESOLVED',
      refresh: 'true',
      claimableFirst: 'true',
    });
  });

  test('closed params: an unknown key or a value outside the DTO is a UserInputError before any request', () => {
    const { client, backend } = dataRig(server, { session: true });
    const bad: unknown[] = [
      { unknown: 1 },
      { skip: 10 },
      { cursor: 'x' },
      { status: 'open' },
      { sortBy: 'volume' },
      { take: 1001 },
      { take: 0 },
      { page: 10_001 },
      { page: '2' },
      { marketId: 0 },
      { marketId: 1.5 },
      { marketStatus: ['OPEN'] },
      { marketScope: 'onlyEverything' },
      { refresh: 'yes' },
      null,
      [],
    ];
    for (const params of bad) {
      expect(() => client.portfolio.mine(params as never)).toThrow(
        UserInputError,
      );
    }
    expectNoRequest(backend);
  });

  test('contractMarketId takes a legacy address or a numeric id, not a 64-digit condition id (the DTO pattern)', () => {
    const { client, backend } = dataRig(server, { session: true });
    for (const good of [`0x${'ab'.repeat(20)}`, '12345']) {
      expect(() =>
        client.portfolio.mine({ contractMarketId: good }),
      ).not.toThrow();
    }
    for (const bad of [`0x${'ab'.repeat(32)}`, '0x12', 'abc', '']) {
      expect(() => client.portfolio.mine({ contractMarketId: bad })).toThrow(
        UserInputError,
      );
    }
    expectNoRequest(backend);
  });

  test('a market the backend does not know is a 404 rejection', async () => {
    const { client } = dataRig(server, { session: true });
    expect(
      await caught(() => client.portfolio.mine({ marketId: 4040 }).toArray(1)),
    ).toSatisfy(rejectedWith(404));
  });
});

describe('holdings are never hidden by default', () => {
  test('every account route that takes a marketScope sends withPulse unless the caller passes one', async () => {
    const { client, backend } = dataRig(server, { session: true });
    await client.portfolio.mine().firstPage();
    await client.portfolio.mine({ marketId: 1 }).firstPage();
    await client.portfolio.mine({ marketId: 6 }).firstPage();
    await client.portfolio.value();
    await client.portfolio.redeemable().firstPage();
    await client.portfolio.redeemable({ role: 'creator' }).firstPage();
    await client.portfolio.claimableMarkets().firstPage();
    await client.portfolio.openOrders().firstPage();
    await client.portfolio
      .ofWallet({ username: PUBLIC_USER.username })
      .firstPage();
    await client.pnl.summary();
    await client.pnl.summary({ status: 'all' });
    await client.pnl.market(PNL_MARKET_ID);
    await client.pnl.position(PNL_POSITION_ID);
    await client.activity.mine().firstPage();
    await client.activity.mine({ marketId: 1 }).firstPage();
    await client.activity.marketActivities().firstPage();
    await client.activity.marketActivities({ marketId: 1 }).firstPage();
    await client.activity.stats();
    expect(backend.requests.length).toBeGreaterThanOrEqual(17);
    // The routes that take no scope at all send none.
    const scopeless = new Set([
      '/api/users/me/portfolio-value',
      '/api/users/me/open-orders',
      `/api/user/pnl/market/${PNL_MARKET_ID}`,
      `/api/user/pnl/position/${PNL_POSITION_ID}`,
      '/api/users/me/stats',
    ]);
    for (const request of backend.requests) {
      expect(request.query.marketScope, request.path).toBe(
        scopeless.has(request.path) ? undefined : 'withPulse',
      );
    }
  });

  test('an explicit marketScope is passed through to every route that takes one', async () => {
    const { client, backend } = dataRig(server, { session: true });
    const calls: Array<[string, () => unknown]> = [
      [
        '/api/users/me/portfolio',
        () =>
          client.portfolio.mine({ marketScope: 'onlyConviction' }).firstPage(),
      ],
      [
        '/api/users/me/portfolio',
        () =>
          client.portfolio
            .mine({ marketId: 5, marketScope: 'onlyConviction' })
            .firstPage(),
      ],
      [
        '/api/users/portfolio',
        () =>
          client.portfolio
            .ofWallet(
              { username: PUBLIC_USER.username },
              { marketScope: 'onlyConviction' },
            )
            .firstPage(),
      ],
      [
        '/api/users/me/redeemable-positions',
        () =>
          client.portfolio
            .redeemable({ marketScope: 'onlyConviction' })
            .firstPage(),
      ],
      [
        '/api/users/me/claimable-markets',
        () =>
          client.portfolio
            .claimableMarkets({ marketScope: 'onlyConviction' })
            .firstPage(),
      ],
      [
        '/api/user/pnl',
        () => client.pnl.summary({ marketScope: 'onlyConviction' }),
      ],
      [
        '/api/users/me/activities',
        () =>
          client.activity.mine({ marketScope: 'onlyConviction' }).firstPage(),
      ],
      [
        '/api/users/me/market-activities',
        () =>
          client.activity
            .marketActivities({ marketScope: 'onlyConviction' })
            .firstPage(),
      ],
    ];
    for (const [path, run] of calls) {
      await run();
      expect(last(backend).path).toBe(path);
      expect(last(backend).query.marketScope, path).toBe('onlyConviction');
    }
  });

  test('every scope the backend knows is accepted, and another value is refused before any request', () => {
    const { client, backend } = dataRig(server, { session: true });
    for (const scope of [
      'default',
      'withPulse',
      'onlyPulse',
      'onlyClob',
      'withClob',
      'onlyClobPulse',
      'onlyConviction',
    ] as const) {
      expect(() => client.portfolio.mine({ marketScope: scope })).not.toThrow();
    }
    expect(() =>
      client.portfolio.mine({ marketScope: 'everything' as never }),
    ).toThrow(UserInputError);
    expectNoRequest(backend);
  });
});

describe('portfolio.value', () => {
  test('GET /api/users/me/portfolio-value: USD numbers become exact decimal strings', async () => {
    const { client, backend } = dataRig(server, { session: true });
    const value = await client.portfolio.value();
    expect(last(backend).path).toBe('/api/users/me/portfolio-value');
    expect(last(backend).query).toEqual({});
    expect(last(backend).authorization).toBe(`Bearer ${API_KEY}`);
    expect(value).toEqual({
      cashUSD: '691.5',
      positionsValueUSD: '420.25',
      claimableAmountUSD: '25',
      portfolioValueUSD: '1136.75',
      currency: 'USD',
      unpricedPositionCount: 0,
    });
    expectTypeOf(value).toEqualTypeOf<PortfolioValue>();
    expectTypeOf<PortfolioValue['cashUSD']>().toEqualTypeOf<DecimalString>();
  });

  test('refresh is sent only when true: the backend reads the text "false" as true', async () => {
    const { client, backend } = dataRig(server, { session: true });
    await client.portfolio.mine({ refresh: true }).firstPage();
    expect(last(backend).query.refresh).toBe('true');
    for (const params of [{ refresh: false }, {}]) {
      await client.portfolio.mine(params).firstPage();
      expect(
        last(backend).query.refresh,
        JSON.stringify(params),
      ).toBeUndefined();
      expect(Object.keys(last(backend).query)).not.toContain('refresh');
    }
    expect(() => client.portfolio.mine({ refresh: 'false' as never })).toThrow(
      UserInputError,
    );
  });

  test('refresh bypasses the backend cache, and nothing else is a param', async () => {
    const { client, backend } = dataRig(server, { session: true });
    await client.portfolio.value({ refresh: true });
    expect(last(backend).query).toEqual({ refresh: 'true' });
    await expect(
      client.portfolio.value({ x: 1 } as never),
    ).rejects.toBeInstanceOf(UserInputError);
  });
});

describe('portfolio.redeemable and portfolio.claimableMarkets', () => {
  test('redeemable: GET /api/users/me/redeemable-positions, role and marketScope, raw wei vs USD', async () => {
    const { client, backend } = dataRig(server, { session: true });
    const rows = await client.portfolio
      .redeemable({ role: 'creator', take: 2 })
      .toArray(50);
    expect(rows).toHaveLength(CLAIMABLE_COUNT);
    expect(last(backend).path).toBe('/api/users/me/redeemable-positions');
    expect(backend.requests.map((request) => request.query.page)).toEqual([
      '1',
      '2',
    ]);
    expect(backend.requests[0]?.query).toEqual({
      page: '1',
      take: '2',
      role: 'creator',
      marketScope: 'withPulse',
    });
    const row = rows[0];
    expect(row?.role).toBe('creator');
    expect(row?.claimableAmountWei).toBe('1500000');
    expect(row?.claimableAmountUSD).toBe('1.5');
    expect(row?.position.shareAmount).toBe('1500000');
    expect(row?.position.shareAmountFormatted).toBe('1.5');
    expect(row?.redeemableAmountPerShare).toBe('1000000');
    expect(row?.collateralToken?.symbol).toBe('USDC');
  });

  test('claimableMarkets: GET /api/users/me/claimable-markets', async () => {
    const { client, backend } = dataRig(server, { session: true });
    const rows = await client.portfolio
      .claimableMarkets({ sortBy: 'closedAt', sortOrder: 'ASC' })
      .toArray(50);
    expect(rows).toHaveLength(CLAIMABLE_COUNT);
    expect(last(backend).path).toBe('/api/users/me/claimable-markets');
    expect(last(backend).query).toEqual({
      page: '1',
      sortBy: 'closedAt',
      sortOrder: 'ASC',
      marketScope: 'withPulse',
    });
    expect(rows[0]).toMatchObject({
      marketId: 12,
      claimableAmountWei: '1500000',
      claimableAmountUSD: '1.5',
      winningOutcome: { id: 912, title: 'Yes', contractOutcomeId: '111' },
      userPosition: {
        outcomeId: 912,
        shareAmount: '1500000',
        shareAmountFormatted: '1.5',
      },
    });
    expectTypeOf<
      (typeof rows)[number]['claimableAmountWei']
    >().toEqualTypeOf<RawUnitsString>();
    expectTypeOf<
      (typeof rows)[number]['claimableAmountUSD']
    >().toEqualTypeOf<DecimalString>();
  });

  test('closed params: take is 1 to 100, role is user or creator (redeemable only)', () => {
    const { client, backend } = dataRig(server, { session: true });
    expect(() => client.portfolio.redeemable({ take: 101 })).toThrow(
      UserInputError,
    );
    expect(() =>
      client.portfolio.redeemable({ role: 'trader' } as never),
    ).toThrow(UserInputError);
    expect(() =>
      client.portfolio.claimableMarkets({ role: 'user' } as never),
    ).toThrow(UserInputError);
    expect(() =>
      client.portfolio.claimableMarkets({ sortBy: 'amount' } as never),
    ).toThrow(UserInputError);
    expectNoRequest(backend);
  });
});

describe('portfolio.openOrders (cursor)', () => {
  test('follows nextCursor until it is null', async () => {
    const { client, backend } = dataRig(server, { session: true });
    const orders = await client.portfolio.openOrders({ limit: 2 }).toArray(50);
    expect(orders).toHaveLength(OPEN_ORDER_COUNT);
    expect(orders.map((order) => order.orderId)).toEqual([
      '9001',
      '9002',
      '9003',
      '9004',
      '9005',
    ]);
    expect(backend.requests.map((request) => request.query.cursor)).toEqual([
      undefined,
      'cur-2',
      'cur-4',
    ]);
    for (const request of backend.requests) {
      expect(request.path).toBe('/api/users/me/open-orders');
      expect(request.query.limit).toBe('2');
      expect(request.authorization).toBe(`Bearer ${API_KEY}`);
    }
    // No page number: the route pages by cursor only.
    expect(backend.requests[0]?.query.page).toBeUndefined();
  });

  test('the raw page keeps the wallet, the echoed query and the cursor', async () => {
    const { client } = dataRig(server, { session: true });
    const pages = [];
    for await (const page of client.portfolio
      .openOrders({ limit: 3, sort: 'oldest', status: ['resting', 'partial'] })
      .pages()) {
      pages.push(page);
      if (pages.length >= 5) break;
    }
    expect(pages.map((page) => page.hasNext)).toEqual([true, false]);
    const raw = pages[0]?.raw as Record<string, unknown>;
    expect(raw.nextCursor).toBe('cur-3');
    expect(raw.query).toEqual({
      sort: 'oldest',
      status: ['resting', 'partial'],
      limit: 3,
    });
    expect(
      (pages[1]?.raw as { nextCursor: unknown } | undefined)?.nextCursor,
    ).toBeNull();
  });

  test('a status list is sent comma-separated, and break stops the traversal', async () => {
    const { client, backend } = dataRig(server, { session: true });
    for await (const _ of client.portfolio.openOrders({
      limit: 1,
      status: ['resting', 'partial'],
    })) {
      break;
    }
    expect(backend.requests).toHaveLength(1);
    expect(last(backend).query).toEqual({
      limit: '1',
      status: 'resting,partial',
    });
  });

  test('money: price and sizes are exact decimals, the micro fields are raw units', async () => {
    const { client } = dataRig(server, { session: true });
    const [order] = await client.portfolio.openOrders().toArray(1);
    const row = order as OpenOrder;
    expect(row).toMatchObject({
      marketId: `0x${'01'.repeat(32)}`,
      outcome: 'Yes',
      side: 'Buy',
      status: 'partial',
      price: '0.57',
      priceTick: 570,
      originalSize: '12.5',
      remainingSize: '7.5',
      notionalUsd: '7.125',
      originalSizeMicro: '12500000',
      remainingSizeMicro: '7500000',
      notionalMicro: '7125000',
      createdAtMs: 1_760_000_000_001,
      lastFillAtMs: null,
    });
    expect(row.market?.outcomes?.[0]).toEqual({
      outcomeTokenId: '111',
      index: 0,
      title: 'Yes',
    });
    expectTypeOf<
      OpenOrder['originalSizeMicro']
    >().toEqualTypeOf<RawUnitsString>();
    expectTypeOf<OpenOrder['price']>().toEqualTypeOf<DecimalString>();
  });

  describe('orderId', () => {
    /** A client, lenient or strict, whose open-orders route answers with `orders`. */
    function rigWithOrders(strict: boolean, orders: unknown[]) {
      server.resetHandlers();
      const rig = dataRig(server, { session: true, strict });
      rig.backend.override = (request) =>
        request.path === '/api/users/me/open-orders'
          ? HttpResponse.json({
              userId: OWNER.wallet,
              query: { sort: 'latest', status: ['resting'], limit: 50 },
              orders,
              nextCursor: null,
            })
          : undefined;
      return rig.client;
    }

    test('orderId as a long numeric string stays exact', async () => {
      // Above 2^53 (9007199254740992): a JSON number could not hold this id exactly.
      const orderId = '1152921504671201336';
      for (const strict of [false, true]) {
        const client = rigWithOrders(strict, [
          { ...fixtures.openOrderFixture(1), orderId },
        ]);
        const [order] = await client.portfolio.openOrders().toArray(50);
        expect(order?.orderId).toBe(orderId);
        expect(typeof order?.orderId).toBe('string');
      }
    });

    test('orderId as a number becomes its decimal string', async () => {
      for (const strict of [false, true]) {
        const client = rigWithOrders(strict, [
          { ...fixtures.openOrderFixture(1), orderId: 9001 },
        ]);
        const [order] = await client.portfolio.openOrders().toArray(50);
        expect(order?.orderId).toBe('9001');
      }
    });

    test('a number past 2^53 is refused, not rounded to a different id', async () => {
      for (const strict of [false, true]) {
        const client = rigWithOrders(strict, [
          {
            ...fixtures.openOrderFixture(1),
            orderId: 2 ** 60,
          },
        ]);
        const failure = await caught(() =>
          client.portfolio.openOrders().toArray(50),
        );
        expect(failure).toBeInstanceOf(UnexpectedResponseError);
        expect((failure as UnexpectedResponseError).issues).toContainEqual(
          expect.objectContaining({ path: 'orders.0.orderId' }),
        );
      }
    });

    test('a missing orderId is an UnexpectedResponseError', async () => {
      const { orderId: _omitted, ...withoutId } = fixtures.openOrderFixture(1);
      for (const strict of [false, true]) {
        const client = rigWithOrders(strict, [withoutId]);
        const failure = await caught(() =>
          client.portfolio.openOrders().toArray(50),
        );
        expect(failure).toBeInstanceOf(UnexpectedResponseError);
        expect((failure as UnexpectedResponseError).issues).toContainEqual(
          expect.objectContaining({ path: 'orders.0.orderId' }),
        );
      }
    });

    test('a boolean orderId is an UnexpectedResponseError', async () => {
      for (const strict of [false, true]) {
        const client = rigWithOrders(strict, [
          { ...fixtures.openOrderFixture(1), orderId: true },
        ]);
        const failure = await caught(() =>
          client.portfolio.openOrders().toArray(50),
        );
        expect(failure).toBeInstanceOf(UnexpectedResponseError);
        expect((failure as UnexpectedResponseError).issues).toContainEqual(
          expect.objectContaining({ path: 'orders.0.orderId' }),
        );
      }
    });
  });

  test('closed params: sort, status and limit follow the DTO; cursor is the paginator’s', () => {
    const { client, backend } = dataRig(server, { session: true });
    for (const params of [
      { limit: 201 },
      { limit: 0 },
      { sort: 'newest' },
      { status: ['open'] },
      { status: 'resting,partial' },
      { cursor: 'cur-2' },
      { page: 2 },
    ]) {
      expect(() => client.portfolio.openOrders(params as never)).toThrow(
        UserInputError,
      );
    }
    expectNoRequest(backend);
  });
});

describe('portfolio.ofWallet (public)', () => {
  test('sends the wallet as `user` (the route takes no `wallet`), checksummed, with no credentials', async () => {
    const { client, backend } = dataRig(server, { session: true });
    const rows = await client.portfolio
      .ofWallet({ wallet: PUBLIC_USER.wallet.toLowerCase() })
      .toArray(50);
    const request = last(backend);
    expect(request.path).toBe('/api/users/portfolio');
    expect(request.authorization).toBeNull();
    expect(request.query).toEqual({
      user: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
      page: '1',
      marketScope: 'withPulse',
    });
    expect(request.query.user?.toLowerCase()).toBe(
      PUBLIC_USER.wallet.toLowerCase(),
    );
    expect(ids(rows)).toEqual([1, 2, 5, 6, 12]);
  });

  test('a username goes in the same `user` param', async () => {
    const { client, backend } = dataRig(server);
    await client.portfolio
      .ofWallet(
        { username: PUBLIC_USER.username },
        { marketScope: 'withPulse' },
      )
      .firstPage();
    expect(last(backend).query).toEqual({
      user: PUBLIC_USER.username,
      page: '1',
      marketScope: 'withPulse',
    });
  });

  test('marketId gives the flat position rows of the detail mode', async () => {
    const { client } = dataRig(server);
    const rows = await client.portfolio
      .ofWallet({ username: PUBLIC_USER.username }, { marketId: 1 })
      .toArray(10);
    expect(rows).toHaveLength(2);
    expectTypeOf(rows).toEqualTypeOf<PortfolioPosition[]>();
  });

  test('a route that answers the first page whatever page says: the traversal ends at the repeat and never returns a row twice', async () => {
    const { client, backend } = dataRig(server);
    const pages = [];
    for await (const page of client.portfolio
      .ofWallet(
        { username: PUBLIC_USER.username },
        { take: 2, marketScope: 'withPulse' },
      )
      .pages()) {
      pages.push(page);
      if (pages.length >= 10) break; // a runaway traversal fails the assertions below
    }
    expect(backend.requests.map((request) => request.query.page)).toEqual([
      '1',
      '2',
    ]);
    expect(pages.map((page) => ids(page.items))).toEqual([[1, 2], []]);
    expect(pages.map((page) => page.hasNext)).toEqual([true, false]);
    // The raw answer of the repeated page is kept as the backend sent it.
    const raw = pages[1]?.raw as {
      data: Array<{ id: number }>;
      meta: { page: number };
    };
    expect(ids(raw.data)).toEqual([1, 2]);
    expect(raw.meta.page).toBe(2);
    // A second traversal of the same paginator starts clean.
    const paginator = client.portfolio.ofWallet(
      { username: PUBLIC_USER.username },
      { take: 2, marketScope: 'withPulse' },
    );
    expect(ids(await paginator.toArray(50))).toEqual([1, 2]);
    expect(ids(await paginator.toArray(50))).toEqual([1, 2]);
  });

  test('with take 1, a row inserted ahead between two requests shifts page 2 onto page 1: the guard stops early (accepted), no row twice', async () => {
    const { client, backend, account } = dataRig(server);
    account.publicPortfolioIgnoresPage = false;
    // After the first page, a new market arrives at the top: page 2 now holds what page 1
    // held. The guard cannot tell this from a backend that ignores `page`, and ends there.
    backend.override = (request) => {
      if (request.query.page !== '2') return undefined;
      return HttpResponse.json({
        data: [fixtures.portfolioMarketRow(1)],
        meta: pageMeta(2, 1, 6),
      });
    };
    const pages = [];
    for await (const page of client.portfolio
      .ofWallet(
        { username: PUBLIC_USER.username },
        { take: 1, marketScope: 'withPulse' },
      )
      .pages()) {
      pages.push(page);
      if (pages.length >= 10) break;
    }
    expect(pages.map((page) => ids(page.items))).toEqual([[1], []]);
    expect(backend.requests.map((request) => request.query.page)).toEqual([
      '1',
      '2',
    ]);
    // The raw answer of the shifted page is kept; the caller can start again.
    const shifted = pages[1]?.raw as
      | { data: Array<{ id: number }> }
      | undefined;
    expect(ids(shifted?.data ?? [])).toEqual([1]);
  });

  test('a backend that pages properly is read page by page', async () => {
    const { client, backend, account } = dataRig(server);
    account.publicPortfolioIgnoresPage = false;
    const rows = await client.portfolio
      .ofWallet(
        { username: PUBLIC_USER.username },
        { take: 2, marketScope: 'withPulse' },
      )
      .toArray(50);
    expect(ids(rows)).toEqual([1, 2, 5, 6, 12]);
    expect(backend.requests.map((request) => request.query.page)).toEqual([
      '1',
      '2',
      '3',
    ]);
  });

  test('exactly one of wallet and username, both valid, before any request', () => {
    const { client, backend } = dataRig(server);
    for (const target of [
      {},
      { wallet: PUBLIC_USER.wallet, username: PUBLIC_USER.username },
      { wallet: '0x1234' },
      { wallet: 5 },
      { username: '' },
      { username: PUBLIC_USER.wallet },
      { user: 'x' },
      undefined,
      'x',
    ]) {
      expect(() => client.portfolio.ofWallet(target as never)).toThrow(
        UserInputError,
      );
    }
    // The route ignores these on the public path, so they are not offered.
    expect(() =>
      client.portfolio.ofWallet({ username: 'bob_1' }, {
        refresh: true,
      } as never),
    ).toThrow(UserInputError);
    expect(() =>
      client.portfolio.ofWallet({ username: 'bob_1' }, {
        claimableFirst: true,
      } as never),
    ).toThrow(UserInputError);
    expectNoRequest(backend);
  });

  test('an unknown user is a 404 rejection', async () => {
    const { client } = dataRig(server);
    expect(
      await caught(() =>
        client.portfolio.ofWallet({ username: 'nobody_here' }).toArray(1),
      ),
    ).toSatisfy(rejectedWith(404));
  });
});

describe('pnl', () => {
  test('summary uses the singular /api/user/pnl with the key and marketScope withPulse', async () => {
    const { client, backend } = dataRig(server, { session: true });
    const pnl = await client.pnl.summary();
    expect(last(backend).path).toBe('/api/user/pnl');
    expect(last(backend).query).toEqual({ marketScope: 'withPulse' });
    expect(last(backend).authorization).toBe(`Bearer ${API_KEY}`);
    expect(pnl).toMatchObject({
      totalPnl: '247.89',
      totalPnlPercentage: 15.67,
      totalEntryValue: '1580.5',
      totalCurrentValue: '1828.39',
      activePositionsCount: 5,
      closedPositionsCount: 3,
      calculationErrors: 0,
    });
    const position = pnl.positions[0];
    expect(position).toMatchObject({
      positionId: PNL_POSITION_ID,
      marketId: PNL_MARKET_ID,
      entryValue: '500',
      currentValue: '623.45',
      pnl: '123.45',
      pnlPercentage: 24.69,
      calculationType: 'ACTIVE',
      shareAmount: '2000000',
      entryPrice: '500000',
      calculatedAt: '2026-10-01T12:00:00.000Z',
    });
    expectTypeOf<
      (typeof pnl.positions)[number]['shareAmount']
    >().toEqualTypeOf<RawUnitsString>();
    expectTypeOf<
      (typeof pnl.positions)[number]['pnl']
    >().toEqualTypeOf<DecimalString>();
  });

  test('summary takes status, marketStatus and marketScope', async () => {
    const { client, backend } = dataRig(server, { session: true });
    await client.pnl.summary({
      status: 'closed',
      marketStatus: 'RESOLVED',
      marketScope: 'withPulse',
    });
    expect(last(backend).query).toEqual({
      status: 'closed',
      marketStatus: 'RESOLVED',
      marketScope: 'withPulse',
    });
    for (const params of [
      { status: 'resolved' },
      { marketStatus: ['CLOSED'] },
      { marketStatus: 'CLOSING_24H' },
      { page: 1 },
    ]) {
      await expect(client.pnl.summary(params as never)).rejects.toBeInstanceOf(
        UserInputError,
      );
    }
  });

  test('market(marketId) and position(positionId) use the singular path too', async () => {
    const { client, backend } = dataRig(server, { session: true });
    const market = await client.pnl.market(PNL_MARKET_ID);
    expect(last(backend).path).toBe(`/api/user/pnl/market/${PNL_MARKET_ID}`);
    expect(market).toMatchObject({
      marketId: PNL_MARKET_ID,
      totalPnl: '123.45',
      positionsCount: 1,
    });
    const position = await client.pnl.position(PNL_POSITION_ID);
    expect(last(backend).path).toBe(
      `/api/user/pnl/position/${PNL_POSITION_ID}`,
    );
    expect(position.position.positionId).toBe(PNL_POSITION_ID);
    // A numeric string is accepted for an id, as for the markets.
    await client.pnl.market(String(PNL_MARKET_ID));
    expect(last(backend).path).toBe(`/api/user/pnl/market/${PNL_MARKET_ID}`);
  });

  test('bad ids are refused locally; a position the account does not hold is a 404 rejection', async () => {
    const { client, backend } = dataRig(server, { session: true });
    for (const bad of [0, -1, 1.5, '1/2', '', Number.NaN, undefined]) {
      await expect(client.pnl.market(bad as never)).rejects.toBeInstanceOf(
        UserInputError,
      );
      await expect(client.pnl.position(bad as never)).rejects.toBeInstanceOf(
        UserInputError,
      );
    }
    expectNoRequest(backend);
    expect(await caught(() => client.pnl.position(1))).toSatisfy(
      rejectedWith(404),
    );
    expect(await caught(() => client.pnl.market(999))).toSatisfy(
      rejectedWith(404),
    );
  });
});

describe('activity', () => {
  test('mine: GET /api/users/me/activities, cash fields as decimals, cp and fees as sent', async () => {
    const { client, backend } = dataRig(server, { session: true });
    const rows = await client.activity.mine({ take: 4 }).toArray(50);
    expect(rows).toHaveLength(ACTIVITY_COUNT);
    expect(backend.requests.map((request) => request.query.page)).toEqual([
      '1',
      '2',
    ]);
    expect(backend.requests[0]).toMatchObject({
      path: '/api/users/me/activities',
      query: { page: '1', take: '4', marketScope: 'withPulse' },
      authorization: `Bearer ${API_KEY}`,
    });
    const row = rows[0] as UserActivity;
    expect(row).toMatchObject({
      activityType: 'user',
      positionType: 'SELL',
      volumeInUSD: '5.7',
      cpEarned: '3.50',
      avgEntryValue: '5.7',
      avgPnl: '0.3',
      avgPnlPercentage: 5.26,
      avgEntryPrice: '570000',
      netFeeUSD: '-0.0996',
      tradingFee: { feeAmount: '99640', feeInUSD: '0.09964', isTaker: true },
      event: null,
    });
    expect(rows.at(-1)?.activityType).toBe('creator');
    expectTypeOf<UserActivity['volumeInUSD']>().toEqualTypeOf<DecimalString>();
    expectTypeOf<
      NonNullable<UserActivity['avgEntryPrice']>
    >().toEqualTypeOf<RawUnitsString>();
  });

  test('mine takes the filters of the DTO; take goes to 1000 here', async () => {
    const { client, backend } = dataRig(server, { session: true });
    await client.activity
      .mine({
        take: 1000,
        search: 'btc',
        sortBy: 'volumeInUSD',
        sortOrder: 'ASC',
        marketScope: 'withPulse',
        positionType: 'REDEEM',
        marketId: 3,
        dateFrom: new Date('2026-10-01T00:00:00.000Z'),
        dateTo: '2026-10-02T00:00:00.000Z',
        cpMin: 0,
        cpMax: 10.5,
      })
      .firstPage();
    expect(last(backend).query).toEqual({
      page: '1',
      take: '1000',
      search: 'btc',
      sortBy: 'volumeInUSD',
      sortOrder: 'ASC',
      marketScope: 'withPulse',
      positionType: 'REDEEM',
      marketId: '3',
      dateFrom: '2026-10-01T00:00:00.000Z',
      dateTo: '2026-10-02T00:00:00.000Z',
      cpMin: '0',
      cpMax: '10.5',
    });
    await client.activity.mine({ marketId: 3 }).firstPage();
    expect(last(backend).query).toEqual({
      page: '1',
      marketId: '3',
      marketScope: 'withPulse',
    });
  });

  test('marketActivities: GET /api/users/me/market-activities, pnlInUSD and cycleNumber, take 1 to 50', async () => {
    const { client, backend } = dataRig(server, { session: true });
    const rows = await client.activity
      .marketActivities({ take: 50 })
      .toArray(50);
    expect(rows).toHaveLength(ACTIVITY_COUNT);
    expect(last(backend).path).toBe('/api/users/me/market-activities');
    expect(last(backend).query).toEqual({
      page: '1',
      take: '50',
      marketScope: 'withPulse',
    });
    const row = rows[1] as UserMarketActivity;
    expect(row.pnlInUSD).toBe('-12.50');
    expect(row.market?.cycleNumber).toBe(5018);
    expect(row.collateralAmount).toBe('5700000');
    expect(row.volumeInUSD).toBe('5.70');
    expect(row.user?.username).toBe('bot_one');
    expectTypeOf<
      UserMarketActivity['pnlInUSD']
    >().toEqualTypeOf<DecimalString>();
    // The use case clamps take to 50, so more is refused rather than silently cut.
    expect(() => client.activity.marketActivities({ take: 51 })).toThrow(
      UserInputError,
    );
  });

  test('the history defaults to withPulse; a scope the caller passes goes through', async () => {
    const { client, backend } = dataRig(server, { session: true });
    expect(await client.activity.mine().toArray(50)).toHaveLength(
      ACTIVITY_COUNT,
    );
    expect(last(backend).query.marketScope).toBe('withPulse');
    await client.activity.mine({ marketScope: 'onlyClob' }).firstPage();
    expect(last(backend).query.marketScope).toBe('onlyClob');
    // Market 1 is a CLOB market: the conviction scope has none of its trades.
    expect(
      await client.activity.mine({ marketScope: 'onlyConviction' }).toArray(50),
    ).toEqual([]);
    expect(
      await client.activity
        .marketActivities({ marketScope: 'onlyConviction' })
        .toArray(50),
    ).toEqual([]);
  });

  test('activity filters are validated: dates, conviction-point bounds and the sort', () => {
    const { client, backend } = dataRig(server, { session: true });
    for (const params of [
      { dateFrom: 'yesterday' },
      { dateTo: new Date('nope') },
      { cpMin: Number.POSITIVE_INFINITY },
      { cpMax: '5' },
      { positionType: 'TRANSFER' },
      { sortBy: 'pnl' },
      { take: 1001 },
      { marketId: 0 },
    ]) {
      expect(() => client.activity.mine(params as never)).toThrow(
        UserInputError,
      );
    }
    expectNoRequest(backend);
  });

  test('marketActivities scopes to an event with eventId and subEventId; includeSubEvents is not offered', async () => {
    const { client, backend } = dataRig(server, { session: true });
    const eventId = '5b7c1a2e-9c4d-4e8f-a1b2-3c4d5e6f7a8b';
    await client.activity
      .marketActivities({ eventId, subEventId: eventId })
      .firstPage();
    expect(last(backend).query).toMatchObject({ eventId, subEventId: eventId });
    expect(last(backend).query.includeSubEvents).toBeUndefined();
    expect(() =>
      client.activity.marketActivities({ eventId: 'not-a-uuid' }),
    ).toThrow(UserInputError);
    // The backend answers 400 "includeSubEvents is not a boolean" to true and to false (live
    // check), so the param is refused with the reason instead of being sent.
    for (const includeSubEvents of [true, false]) {
      expect(() =>
        client.activity.marketActivities({
          eventId,
          includeSubEvents,
        } as never),
      ).toThrow(/includeSubEvents is not available.*not a boolean/);
    }
  });

  test('stats: GET /api/users/me/stats, PnL and volume as decimals', async () => {
    const { client, backend } = dataRig(server, { session: true });
    const stats = await client.activity.stats();
    expect(last(backend).path).toBe('/api/users/me/stats');
    expect(stats).toEqual({
      pnl: '-1690.288222',
      volume: '5936.423181',
      marketsTraded: 52,
      winRate: null,
    });
  });
});

describe('account', () => {
  test('me: GET /api/users/me, slim profile with the money-like fields as decimals', async () => {
    const { client, backend } = dataRig(server, { session: true });
    const me = await client.account.me();
    expect(last(backend).path).toBe('/api/users/me');
    expect(last(backend).query).toEqual({});
    expect(last(backend).authorization).toBe(`Bearer ${API_KEY}`);
    expect(me).toMatchObject({
      id: 77,
      username: 'bot_one',
      status: 'ACTIVE',
      isPrivate: false,
      userVolume: '1234.56',
      userPoints: { currentPoints: '15.75', totalPointsEarned: '47.25' },
      cpPoints: 5000,
      tier: 'Believer',
      likedMarketIds: [1, 3],
    });
    expect(me.positionHistory).toEqual([]);
    expect(me.currentPositions).toEqual([]);
  });

  test('me: hasAccess and inviteCodeId may be missing, in strict mode too (auth review of 19 October 2026)', async () => {
    // The review agreed to remove the invitation and has-access logic, so the backend may stop
    // sending either field. A strict read must not break when they go.
    const { hasAccess: _hasAccess, ...withoutAccess } = currentUserFixture();
    expect(withoutAccess).not.toHaveProperty('inviteCodeId');
    const strict = dataRig(server, { session: true, strict: true });
    strict.backend.override = (request) =>
      request.path === '/api/users/me'
        ? HttpResponse.json(withoutAccess)
        : undefined;
    const me = await strict.client.account.me();
    expect(me.username).toBe('bot_one');
    expect(me).not.toHaveProperty('hasAccess');
    expect(me).not.toHaveProperty('inviteCodeId');

    // Still read, and still checked, when they are sent.
    strict.backend.override = (request) =>
      request.path === '/api/users/me'
        ? HttpResponse.json({
            ...withoutAccess,
            hasAccess: true,
            inviteCodeId: 'abc',
          })
        : undefined;
    expect(await strict.client.account.me()).toMatchObject({
      hasAccess: true,
      inviteCodeId: 'abc',
    });
    strict.backend.override = (request) =>
      request.path === '/api/users/me'
        ? HttpResponse.json({ ...withoutAccess, hasAccess: 'yes' })
        : undefined;
    expect(await caught(() => strict.client.account.me())).toBeInstanceOf(
      UnexpectedResponseError,
    );

    expectTypeOf<AccountProfile['hasAccess']>().toEqualTypeOf<
      boolean | undefined
    >();
    expectTypeOf<AccountProfile['inviteCodeId']>().toEqualTypeOf<
      string | null | undefined
    >();
  });

  test('apiKeys: GET /api/auth/api-keys as a one-page Paginator of key metadata, ids as text', async () => {
    const { client, backend } = dataRig(server, { session: true });
    const keys = await client.account.apiKeys().toArray();
    expect(last(backend).path).toBe('/api/auth/api-keys');
    expect(last(backend).authorization).toBe(`Bearer ${API_KEY}`);
    expect(keys.map((key) => key.id)).toEqual([
      String(OTHER_KEY_ID),
      String(OWN_KEY_ID),
    ]);
    expect(keys[1]).toMatchObject({
      prefix: '0123456789abcdef',
      scopes: ['account:read', 'account:write'],
      revokedAt: null,
      createdVia: 'wallet_signature',
    });
    // The secret is never part of a listing.
    expect(JSON.stringify(keys)).not.toContain('xo_sk');
    expectTypeOf(keys).toEqualTypeOf<ApiKeyInfo[]>();
    const page = await client.account.apiKeys().firstPage();
    expect(page.hasNext).toBe(false);
  });
});

describe('profiles (public)', () => {
  test('get: GET /api/profiles/:username with no credentials', async () => {
    const { client, backend } = dataRig(server, { session: true });
    const profile = await client.profiles.get(PUBLIC_USER.username);
    expect(last(backend).path).toBe(`/api/profiles/${PUBLIC_USER.username}`);
    expect(last(backend).authorization).toBeNull();
    expect(profile).toMatchObject({
      id: PUBLIC_USER.id,
      username: PUBLIC_USER.username,
      verified: false,
      isPrivate: false,
      cpPoints: 520321.56,
      tier: 'Caller',
      socials: { x: 'xouser1330', tiktok: null },
      achievements: ['CATALYST'],
    });
    expect(profile.profileBadges?.[0]).toEqual({
      key: 'CATALYST',
      earned: true,
      isRevoked: false,
      tokenId: 1,
    });
    expect(profile.boardingPassTiers?.[0]?.key).toBe('BOARDING_PASS_ECONOMY');
  });

  test('stats: GET /api/profiles/:username/stats, public, PnL and volume as decimals', async () => {
    const { client, backend } = dataRig(server, { session: true });
    const stats = await client.profiles.stats(PUBLIC_USER.username);
    expect(last(backend).path).toBe(
      `/api/profiles/${PUBLIC_USER.username}/stats`,
    );
    expect(last(backend).authorization).toBeNull();
    expect(stats).toEqual({
      pnl: '-1690.288222',
      volume: '5936.423181',
      marketsTraded: 52,
      winRate: null,
    });
  });

  test('an unknown user is a 404 rejection; a bad username is refused locally', async () => {
    const { client, backend } = dataRig(server);
    expect(await caught(() => client.profiles.get('nobody_here'))).toSatisfy(
      rejectedWith(404),
    );
    expect(await caught(() => client.profiles.stats('nobody_here'))).toSatisfy(
      rejectedWith(404),
    );
    backend.requests.length = 0;
    for (const bad of ['', '..', '.', 'a\nb', 5, undefined, 'x'.repeat(101)]) {
      await expect(client.profiles.get(bad as never)).rejects.toBeInstanceOf(
        UserInputError,
      );
      await expect(client.profiles.stats(bad as never)).rejects.toBeInstanceOf(
        UserInputError,
      );
    }
    expectNoRequest(backend);
  });

  test('a username is percent-encoded into the path', async () => {
    const { client, backend } = dataRig(server);
    await caught(() => client.profiles.get('a b?c#d'));
    expect(last(backend).path).toBe('/api/profiles/a%20b%3Fc%23d');
  });
});

describe('credentials of the shared routes', () => {
  const SHARED_CALLS: Array<
    [string, (c: ReturnType<typeof dataRig>['client']) => unknown]
  > = [
    ['portfolio.mine', (c) => c.portfolio.mine().firstPage()],
    ['portfolio.value', (c) => c.portfolio.value()],
    ['portfolio.redeemable', (c) => c.portfolio.redeemable().firstPage()],
    [
      'portfolio.claimableMarkets',
      (c) => c.portfolio.claimableMarkets().firstPage(),
    ],
    ['portfolio.openOrders', (c) => c.portfolio.openOrders().firstPage()],
    ['pnl.summary', (c) => c.pnl.summary()],
    ['pnl.market', (c) => c.pnl.market(1)],
    ['pnl.position', (c) => c.pnl.position(1)],
    ['activity.mine', (c) => c.activity.mine().firstPage()],
    [
      'activity.marketActivities',
      (c) => c.activity.marketActivities().firstPage(),
    ],
    ['activity.stats', (c) => c.activity.stats()],
    ['account.me', (c) => c.account.me()],
    ['account.apiKeys', (c) => c.account.apiKeys().firstPage()],
  ];

  test.each(SHARED_CALLS)(
    '%s without a signer and without a backend credential → AuthRequiredError naming both options, and no request',
    async (_name, call) => {
      const { client, backend } = dataRig(server, { session: 'none' });
      const failure = await caught(() => call(client));
      expect(failure).toBeInstanceOf(AuthRequiredError);
      expect((failure as Error).message).toContain('`signer`');
      expect((failure as Error).message).toContain('credentials');
      expectNoRequest(backend);
    },
  );

  test('the client checks the session itself: the options are named even when the session is not installed on the transport', async () => {
    const { client, backend } = dataRig(server, {
      session: 'none',
      install: false,
    });
    const failure = await caught(() => client.portfolio.value());
    expect(failure).toBeInstanceOf(AuthRequiredError);
    expect((failure as Error).message).toContain('`signer`');
    expect((failure as Error).message).toContain('credentials');
    expectNoRequest(backend);
  });

  test('a client with no session and a transport with no auth provider fails the same way, with no request', async () => {
    const { client, backend } = dataRig(server);
    for (const [, call] of SHARED_CALLS) {
      expect(await caught(() => call(client))).toBeInstanceOf(
        AuthRequiredError,
      );
    }
    expectNoRequest(backend);
  });

  test('"mine" routes send Bearer xo_sk key from the session; the public routes send nothing', async () => {
    const { client, backend } = dataRig(server, { session: true });
    await client.portfolio.mine().firstPage();
    await client.portfolio.value();
    await client.pnl.summary();
    await client.activity.stats();
    await client.account.me();
    for (const request of backend.requests) {
      expect(request.authorization, request.path).toBe(`Bearer ${API_KEY}`);
      expect(request.authorization).toMatch(/^Bearer xo_sk_/);
    }
    backend.requests.length = 0;
    await client.portfolio
      .ofWallet({ username: PUBLIC_USER.username })
      .firstPage();
    await client.profiles.get(PUBLIC_USER.username);
    await client.profiles.stats(PUBLIC_USER.username);
    for (const request of backend.requests) {
      expect(request.authorization, request.path).toBeNull();
    }
  });

  test('403 frontend_only → 403 rejection with the backend code', async () => {
    const { client, backend } = dataRig(server, { session: true });
    backend.override = (request) =>
      exceptionResponse(request.path, 403, {
        error: 'frontend_only',
        message: 'This route is only available from the XO website',
      });
    for (const call of [
      () => client.portfolio.value(),
      () => client.account.me(),
      () => client.pnl.summary(),
      () => client.portfolio.mine().firstPage(),
    ]) {
      const failure = await caught(call);
      expect(failure).toSatisfy(rejectedWith(403));
      expect((failure as RequestRejectedError).code).toBe('frontend_only');
      expect((failure as RequestRejectedError).status).toBe(403);
    }
  });

  test('a key the backend rejects → 401 rejection', async () => {
    const { client, backend } = dataRig(server, { session: true });
    backend.validKeys.clear();
    expect(await caught(() => client.account.me())).toSatisfy(
      rejectedWith(401),
    );
  });
});

describe('strict and lenient responses', () => {
  test('lenient mode keeps a field the schema does not know; strict mode refuses it', async () => {
    const extra = (request: { path: string }) =>
      request.path === '/api/users/me/portfolio-value'
        ? HttpResponse.json({
            cashUSD: 1,
            positionsValueUSD: 2,
            claimableAmountUSD: 3,
            portfolioValueUSD: 6,
            currency: 'USD',
            unpricedPositionCount: 0,
            brandNewField: 'x',
          })
        : undefined;
    const lenient = dataRig(server, { session: true });
    lenient.backend.override = extra;
    const value = await lenient.client.portfolio.value();
    expect((value as unknown as Record<string, unknown>).brandNewField).toBe(
      'x',
    );

    server.resetHandlers();
    const strict = dataRig(server, { session: true, strict: true });
    strict.backend.override = extra;
    expect(await caught(() => strict.client.portfolio.value())).toBeInstanceOf(
      UnexpectedResponseError,
    );
  });

  test('a money field that is not a decimal fails the response, without echoing the value', async () => {
    const { client, backend } = dataRig(server, { session: true });
    backend.override = (request) =>
      request.path === '/api/users/me/stats'
        ? HttpResponse.json({
            pnl: 'a lot',
            volume: 1,
            marketsTraded: 1,
            winRate: null,
          })
        : undefined;
    const failure = await caught(() => client.activity.stats());
    expect(failure).toBeInstanceOf(UnexpectedResponseError);
    expect((failure as Error).message).not.toContain('a lot');
  });

  test("the account's trade feeds take every history kind the backend writes, strictly; the holdings take only BUY, SELL and REDEEM", async () => {
    // The backend's own history types and the indexer's kinds.
    const kinds = [
      'BUY',
      'SELL',
      'REDEEM',
      'SPLIT',
      'MERGE',
      'TRANSFER_IN',
      'TRANSFER_OUT',
      'REFUND',
    ];
    const answer = (
      path: string,
      row: (n: number) => Record<string, unknown>,
      positionType: (n: number) => string,
    ) => {
      const rows = kinds.map((_, n) => ({
        ...row(n + 1),
        positionType: positionType(n),
      }));
      return (request: { path: string }) =>
        request.path === path
          ? HttpResponse.json({
              data: rows,
              meta: pageMeta(1, 50, rows.length),
            })
          : undefined;
    };
    const kind = (n: number) => kinds[n] ?? 'BUY';
    const strict = dataRig(server, { session: true, strict: true });
    strict.backend.override = answer(
      '/api/users/me/activities',
      fixtures.userActivityFixture,
      kind,
    );
    expect(
      (await strict.client.activity.mine().toArray(50)).map(
        (a) => a.positionType,
      ),
    ).toEqual(kinds);
    strict.backend.override = answer(
      '/api/users/me/market-activities',
      fixtures.marketActivityFixture,
      kind,
    );
    expect(
      (await strict.client.activity.marketActivities().toArray(50)).map(
        (a) => a.positionType,
      ),
    ).toEqual(kinds);

    // A kind the backend does not name (a REBALANCE_* member, say) fails strictly, passes leniently.
    const unknown = () => 'REBALANCE_SOMETHING';
    strict.backend.override = answer(
      '/api/users/me/activities',
      fixtures.userActivityFixture,
      unknown,
    );
    const refused = await caught(() =>
      strict.client.activity.mine().toArray(50),
    );
    expect(refused).toBeInstanceOf(UnexpectedResponseError);
    expect((refused as UnexpectedResponseError).issues).toContainEqual(
      expect.objectContaining({ path: 'data.0.positionType' }),
    );
    server.resetHandlers();
    const lenient = dataRig(server, { session: true });
    lenient.backend.override = answer(
      '/api/users/me/activities',
      fixtures.userActivityFixture,
      unknown,
    );
    expect(
      (await lenient.client.activity.mine().toArray(50))[0]?.positionType,
    ).toBe('REBALANCE_SOMETHING');

    // A holding is a current position: SPLIT is a history row, never a holding.
    server.resetHandlers();
    const holdings = dataRig(server, { session: true, strict: true });
    holdings.backend.override = (request) =>
      request.path === '/api/users/me/portfolio'
        ? HttpResponse.json({
            data: [
              {
                ...fixtures.positionFixture(1, 0, 'detail'),
                positionType: 'SPLIT',
              },
            ],
            meta: pageMeta(1, 50, 1),
          })
        : undefined;
    const holding = await caught(() =>
      holdings.client.portfolio.mine({ marketId: 1 }).toArray(50),
    );
    expect(holding).toBeInstanceOf(UnexpectedResponseError);
    expect((holding as UnexpectedResponseError).issues).toContainEqual(
      expect.objectContaining({ path: 'data.0.positionType' }),
    );
  });

  test('the public trade feeds take BUY and SELL only, strictly; the account feed takes every kind', async () => {
    // The public feeds list order fills: BUY and SELL, for the user rows and the creator rows
    // alike, and an explicit filter is BUY, SELL or all. So no public row is a REDEEM, nor a
    // SPLIT, MERGE, TRANSFER_* or REFUND. The account's own feed lists every kind.
    const row = (positionType: string) => ({
      ...activityFixture(1, false),
      positionType,
    });
    const answer =
      (path: string, rows: Array<Record<string, unknown>>) =>
      (request: { path: string }) =>
        request.path === path
          ? HttpResponse.json({
              data: rows,
              meta: pageMeta(1, 50, rows.length),
            })
          : undefined;
    const strict = dataRig(server, { strict: true });
    const publicFeeds = {
      '/api/markets/1/activity': () => strict.client.markets.activity(1),
      '/api/markets/activities': () => strict.client.markets.allActivity(),
    };

    for (const [path, feed] of Object.entries(publicFeeds)) {
      // The two fills pass.
      strict.backend.override = answer(path, [row('BUY'), row('SELL')]);
      expect((await feed().toArray(50)).map((a) => a.positionType)).toEqual([
        'BUY',
        'SELL',
      ]);
      // Every other kind, REDEEM included, is not what these feeds serve.
      for (const kind of [
        'REDEEM',
        'SPLIT',
        'MERGE',
        'TRANSFER_IN',
        'TRANSFER_OUT',
        'REFUND',
      ]) {
        strict.backend.override = answer(path, [row(kind)]);
        const refused = await caught(() => feed().toArray(50));
        expect(refused, `${path} ${kind}`).toBeInstanceOf(
          UnexpectedResponseError,
        );
        expect(
          (refused as UnexpectedResponseError).issues,
          `${path} ${kind}`,
        ).toContainEqual(
          expect.objectContaining({ path: 'data.0.positionType' }),
        );
      }
    }

    // The same SPLIT on the account's market feed is a row it lists.
    server.resetHandlers();
    const account = dataRig(server, { session: true, strict: true });
    account.backend.override = answer('/api/users/me/market-activities', [
      { ...fixtures.marketActivityFixture(1), positionType: 'SPLIT' },
    ]);
    expect(
      (await account.client.activity.marketActivities().toArray(50)).map(
        (a) => a.positionType,
      ),
    ).toEqual(['SPLIT']);

    // Lenient mode stays loose on the public feeds.
    server.resetHandlers();
    const lenient = dataRig(server);
    lenient.backend.override = answer('/api/markets/1/activity', [
      row('SPLIT'),
    ]);
    expect(
      (await lenient.client.markets.activity(1).toArray(50))[0]?.positionType,
    ).toBe('SPLIT');

    // The types follow: the public row names BUY and SELL, the account's row all eight.
    expectTypeOf<
      Extract<MarketActivity['positionType'], 'SPLIT' | 'REDEEM'>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<UserMarketActivity['positionType'], 'SPLIT' | 'REDEEM'>
    >().toEqualTypeOf<'SPLIT' | 'REDEEM'>();
  });

  test('strict mode accepts every fixture the fake serves', async () => {
    const { client } = dataRig(server, { session: true, strict: true });
    await client.portfolio.mine({ marketScope: 'withPulse' }).toArray(50);
    await client.portfolio.mine({ marketId: 1 }).toArray(50);
    await client.portfolio.value();
    await client.portfolio.redeemable().toArray(50);
    await client.portfolio.claimableMarkets().toArray(50);
    await client.portfolio.openOrders().toArray(50);
    await client.portfolio
      .ofWallet(
        { username: PUBLIC_USER.username },
        { marketScope: 'withPulse' },
      )
      .toArray(50);
    await client.pnl.summary();
    await client.pnl.market(PNL_MARKET_ID);
    await client.pnl.position(PNL_POSITION_ID);
    await client.activity.mine().toArray(50);
    await client.activity.marketActivities().toArray(50);
    await client.activity.stats();
    await client.account.me();
    await client.account.apiKeys().toArray();
    await client.profiles.get(PUBLIC_USER.username);
    await client.profiles.stats(PUBLIC_USER.username);
  });
});
