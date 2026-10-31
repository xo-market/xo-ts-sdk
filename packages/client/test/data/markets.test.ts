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
import { fromMicro, priceToTick } from '../../src/core/decimal';
import {
  AuthRequiredError,
  type RequestRejectedError,
  UnexpectedResponseError,
  UserInputError,
} from '../../src/core/errors';
import type { DecimalString, RawUnitsString } from '../../src/core/types';
import {
  API_KEY,
  calls,
  caught,
  dataRig,
  env,
  expectNoRequest,
  last,
} from '../helpers/dataRig';
import {
  addressOf,
  CLOB_MARKET_IDS,
  conditionIdOf,
  MARKET_COUNT,
  marketFixture,
  RESOLVED_MARKET_ID,
  STANDARD_MARKET_IDS,
  slugOf,
} from '../helpers/mockBackendData';
import { rejectedWith } from '../helpers/rejections';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

const ids = (rows: Array<{ id: number }>) => rows.map((row) => row.id);

describe('markets.list', () => {
  test('GET /api/markets with the default marketScope, the SDK header and no credentials', async () => {
    const { client, backend } = dataRig(server);
    const page = await client.markets.list().firstPage();
    const request = last(backend);
    expect(request.method).toBe('GET');
    expect(request.path).toBe('/api/markets');
    expect(request.query).toEqual({ page: '1', marketScope: 'onlyClob' });
    expect(request.sdk).toBe('ts/9.9.9');
    expect(request.authorization).toBeNull();
    expect(ids(page.items)).toEqual(CLOB_MARKET_IDS);
  });

  test('list() paginates {data, meta: PageMeta} via hasNextPage', async () => {
    const { client, backend } = dataRig(server);
    const all = await client.markets.list({ take: 4 }).toArray(200);
    expect(ids(all)).toEqual(CLOB_MARKET_IDS);
    expect(backend.requests.map((request) => request.query.page)).toEqual([
      '1',
      '2',
      '3',
    ]);
    for (const request of backend.requests) {
      expect(request.query.take).toBe('4');
      expect(request.query.marketScope).toBe('onlyClob');
    }
  });

  test('pages() keeps the raw {data, meta} of every page', async () => {
    const { client } = dataRig(server);
    const pages: Array<{ hasNext: boolean; raw: unknown; count: number }> = [];
    for await (const page of client.markets.list({ take: 4 }).pages()) {
      pages.push({
        hasNext: page.hasNext,
        raw: page.raw,
        count: page.items.length,
      });
      if (pages.length >= 20) break; // a runaway traversal fails the assertions below
    }
    expect(pages.map((page) => page.count)).toEqual([4, 4, 1]);
    expect(pages.map((page) => page.hasNext)).toEqual([true, true, false]);
    const raw = pages[2]?.raw as {
      data: unknown[];
      meta: Record<string, unknown>;
    };
    expect(raw.meta).toEqual({
      page: 3,
      take: 4,
      itemCount: 9,
      pageCount: 3,
      hasPreviousPage: true,
      hasNextPage: false,
    });
    expect(raw.data).toHaveLength(1);
  });

  test('the traversal starts at the given page and a break fetches nothing more', async () => {
    const { client, backend } = dataRig(server);
    const iterator = client.markets.list({ take: 4, page: 2 });
    for await (const market of iterator) {
      expect(market.id).toBe(CLOB_MARKET_IDS[4]);
      break;
    }
    expect(backend.requests.map((request) => request.query.page)).toEqual([
      '2',
    ]);
  });

  test('a traversal stops at page 10000, the most the backend takes, and never asks for 10001', async () => {
    const { client, backend } = dataRig(server);
    backend.override = (request) =>
      request.path === '/api/markets'
        ? HttpResponse.json({
            // A different market on every page: identical pages would end the list early.
            data: [marketFixture(Number(request.query.page))],
            meta: {
              page: Number(request.query.page),
              take: 1,
              itemCount: 100_000,
              pageCount: 100_000,
              hasPreviousPage: true,
              hasNextPage: true,
            },
          })
        : undefined;
    const rows = await client.markets
      .list({ take: 1, page: 9_999 })
      .toArray(200);
    expect(rows).toHaveLength(2);
    expect(backend.requests.map((request) => request.query.page)).toEqual([
      '9999',
      '10000',
    ]);
  });

  test('nothing is requested until the paginator is read', () => {
    const { client, backend } = dataRig(server);
    client.markets.list({ take: 4 });
    expectNoRequest(backend);
  });

  test('marketScope defaults to onlyClob and can be overridden', async () => {
    const { client, backend } = dataRig(server);
    const clob = await client.markets.list({ take: 50 }).toArray(200);
    expect(ids(clob)).toEqual(CLOB_MARKET_IDS);
    expect(backend.requests[0]?.query.marketScope).toBe('onlyClob');

    // The backend's own default for GET /markets leaves CLOB out: standard markets only.
    const standard = await client.markets
      .list({ take: 50, marketScope: 'default' })
      .toArray(200);
    expect(ids(standard)).toEqual(STANDARD_MARKET_IDS);
    expect(backend.requests[1]?.query.marketScope).toBe('default');

    const everything = await client.markets
      .list({ take: 50, marketScope: 'withPulse' })
      .toArray(200);
    expect(everything).toHaveLength(MARKET_COUNT);
  });

  test('sends every supported filter in one request, all of them known to the DTO', async () => {
    const { client, backend } = dataRig(server);
    await client.markets
      .list({
        page: 1,
        take: 10,
        search: 'btc',
        sortBy: 'totalVolumeInUSD',
        sortOrder: 'DESC',
        marketScope: 'withClob',
        marketType: [2, 3],
        categories: ['SPORTS'],
        categoryId: 1,
        subcategoryId: 2,
        subcategoryUnassigned: false,
        tagKey: 'league',
        tagValue: 'wc',
        statuses: ['ACTIVE', 'CLOSING_24H'],
        excludedStatuses: ['VOIDED'],
        creatorId: 7,
        creatorType: 'admin',
        expiresAfter: new Date('2026-11-01T00:00:00Z'),
        expiresBefore: '2026-12-01T00:00:00Z',
        minVolume: 100,
        maxVolume: '5000.5',
        volumeInToken: false,
        collateralTokenIds: [1],
        isResolved: false,
        isFeatureMarket: false,
        unplacedOnly: false,
        graduated: true,
        contractMarketIds: [conditionIdOf(1)],
      })
      .firstPage();
    expect(last(backend).query).toEqual({
      page: '1',
      take: '10',
      search: 'btc',
      sortBy: 'totalVolumeInUSD',
      sortOrder: 'DESC',
      marketScope: 'withClob',
      marketType: '2,3',
      unplacedOnly: 'false',
      graduated: 'true',
      categories: 'SPORTS',
      categoryId: '1',
      subcategoryId: '2',
      subcategoryUnassigned: 'false',
      tagValue: 'wc',
      tagKey: 'league',
      statuses: 'ACTIVE,CLOSING_24H',
      excludedStatuses: 'VOIDED',
      creatorId: '7',
      expiresAfter: '2026-11-01T00:00:00.000Z',
      expiresBefore: '2026-12-01T00:00:00.000Z',
      minVolume: '100',
      maxVolume: '5000.5',
      volumeInToken: 'false',
      collateralTokenIds: '1',
      isResolved: 'false',
      creatorType: 'admin',
      isFeatureMarket: 'false',
      contractMarketIds: conditionIdOf(1),
    });
  });

  test('an unknown param key is a UserInputError before any request', () => {
    const { client, backend } = dataRig(server);
    expect(() =>
      client.markets.list({ page: 1, bogus: true } as never),
    ).toThrow(UserInputError);
    expect(() => client.markets.list({ take: 51 })).toThrow(UserInputError);
    expect(() => client.markets.list({ skip: 5 } as never)).toThrow(
      UserInputError,
    );
    expectNoRequest(backend);
  });

  test('the fake backend refuses what the SDK refuses (the mirror is faithful)', async () => {
    // Bypass the SDK's check with a raw fetch: the backend refuses unknown keys and take > 50.
    const { backend } = dataRig(server);
    const tooMany = await fetch(`${env.backendUrl}/api/markets?take=51`);
    expect(tooMany.status).toBe(400);
    const unknown = await fetch(`${env.backendUrl}/api/markets?skip=5`);
    expect(unknown.status).toBe(400);
    expect(backend.requests).toHaveLength(2);
  });
});

describe('markets.browse', () => {
  test('browse sends page/take/search/sortBy only; unknown param key → UserInputError before request', async () => {
    const { client, backend } = dataRig(server);
    expect(() => client.markets.browse({ page: 1, nope: 1 } as never)).toThrow(
      UserInputError,
    );
    expectNoRequest(backend);

    await client.markets
      .browse({ page: 1, take: 20, search: 'world cup', sortBy: 'smart' })
      .firstPage();
    const request = last(backend);
    expect(request.path).toBe('/api/markets/browse');
    // marketScope is the SDK's default; nothing else is sent.
    expect(request.query).toEqual({
      page: '1',
      take: '20',
      search: 'world cup',
      sortBy: 'smart',
      marketScope: 'onlyClob',
    });
  });

  test('pages through market cards and event cards', async () => {
    const { client } = dataRig(server);
    const items = await client.markets.browse({ take: 4 }).toArray(200);
    expect(items.map((item) => item.kind)).toEqual([
      'market',
      'market',
      'market',
      'market',
      'market',
      'market',
      'market',
      'market',
      'market',
    ]);
    const all = await client.markets
      .browse({ take: 3, marketScope: 'onlyConviction' })
      .toArray(200);
    expect(all).toHaveLength(2);
    expect(all[0]?.kind).toBe('event');
    expect(all[0]?.markets?.[0]?.market.id).toBe(5);
    expect(all[0]?.event?.slug).toBe('argentina-vs-france');
    expect(all[0]?.totalVolumeInUSD).toBe('1500.00');
  });
});

describe('markets.get / bySlug / byContract', () => {
  test('get(id) is GET /api/markets/:id and returns the market', async () => {
    const { client, backend } = dataRig(server);
    const market = await client.markets.get(3);
    expect(last(backend).path).toBe('/api/markets/3');
    expect(last(backend).query).toEqual({});
    expect(market.id).toBe(3);
    expect(market.conditionId).toBe(conditionIdOf(3));
    expect(market.contractMarketId).toBe(conditionIdOf(3));
    expect(market.type).toBe(2);
    expect(market.status).toBe('ACTIVE');
    expect(market.slug).toBe(slugOf(3));
    expect(market.totalVolumeInUSD).toBe('1500.00');
    expect(market.outcomes).toHaveLength(2);
    expect(market.outcomes?.[0]).toMatchObject({
      title: 'YES',
      index: 0,
      currentPrice: '570000',
    });
    expect(market.effectiveFeeConfig).toMatchObject({
      eligible: true,
      takerFeeBps: 200,
    });
    expect(market.collateralToken).toMatchObject({
      symbol: 'USDC',
      decimals: 6,
    });
    expect(market.rootEventSlug).toBeNull();
  });

  test('a numeric string id is accepted; a bad id is a UserInputError before any request', async () => {
    const { client, backend } = dataRig(server);
    await client.markets.get('4');
    expect(last(backend).path).toBe('/api/markets/4');
    backend.requests.length = 0;
    for (const bad of [0, -1, 1.5, '1/2', '', 'abc', null, undefined]) {
      expect(
        await caught(() => client.markets.get(bad as never)),
      ).toBeInstanceOf(UserInputError);
    }
    expectNoRequest(backend);
  });

  test('get(unknown id) → 404 rejection', async () => {
    const { client } = dataRig(server);
    const error = await caught(() => client.markets.get(999));
    expect(error).toSatisfy(rejectedWith(404));
    expect((error as RequestRejectedError).status).toBe(404);
  });

  test('bySlug is GET /api/markets/slug/:slug and encodes the slug', async () => {
    const { client, backend } = dataRig(server);
    const market = await client.markets.bySlug(slugOf(2));
    expect(last(backend).path).toBe('/api/markets/slug/market-2');
    expect(market.id).toBe(2);
    expect(market.slug).toBe('market-2');
  });

  test('bySlug 404 → 404 rejection', async () => {
    const { client } = dataRig(server);
    const error = await caught(() => client.markets.bySlug('no-such-market'));
    expect(error).toSatisfy(rejectedWith(404));
  });

  test('bySlug refuses a slug that could change the route, before any request', async () => {
    const { client, backend } = dataRig(server);
    for (const slug of ['', '..', '.', 'x'.repeat(301), 'a\nb']) {
      expect(await caught(() => client.markets.bySlug(slug))).toBeInstanceOf(
        UserInputError,
      );
    }
    await client.markets.bySlug('a/b?c#d').catch(() => undefined);
    // The slash, the question mark and the hash travel as data, not as path or query.
    expect(last(backend).path).toBe('/api/markets/slug/a%2Fb%3Fc%23d');
    expect(last(backend).search).toBe('');
  });

  test('byContract takes a condition id or a contract address', async () => {
    const { client, backend } = dataRig(server);
    const byCondition = await client.markets.byContract(conditionIdOf(1));
    expect(last(backend).path).toBe(
      `/api/markets/contract/${conditionIdOf(1)}`,
    );
    expect(byCondition.id).toBe(1);
    const legacy = STANDARD_MARKET_IDS[0] ?? 6;
    const byAddress = await client.markets.byContract(addressOf(legacy));
    expect(byAddress.id).toBe(legacy);
    expect(byAddress.conditionId).toBeNull();
  });

  test('byContract refuses a malformed key before any request, 404 for an unknown one', async () => {
    const { client, backend } = dataRig(server);
    for (const key of ['0x12', 'nope', '', `0x${'g'.repeat(40)}`]) {
      expect(await caught(() => client.markets.byContract(key))).toBeInstanceOf(
        UserInputError,
      );
    }
    expectNoRequest(backend);
    expect(
      await caught(() => client.markets.byContract(`0x${'ff'.repeat(32)}`)),
    ).toSatisfy(rejectedWith(404));
  });
});

describe('markets.priceHistory / statuses', () => {
  test('priceHistory is a bare array: one page, with money-like numbers as exact decimal strings', async () => {
    const { client, backend } = dataRig(server);
    const history = client.markets.priceHistory(2);
    const page = await history.firstPage();
    expect(last(backend).path).toBe('/api/markets/2/price-history');
    expect(page.hasNext).toBe(false);
    expect(Array.isArray(page.raw)).toBe(true);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.outcomes[0]).toEqual({
      outcomeId: 20,
      outcomeTitle: 'YES',
      price: '0.55',
    });
    // The fake sends 0.57 as a JSON number in the second point.
    expect(page.items[1]?.outcomes[0]?.price).toBe('0.57');
    expect(page.items[1]?.outcomes[1]?.price).toBe('0.43');
    expect(await client.markets.priceHistory(2).toArray(200)).toHaveLength(2);
  });

  test('priceHistory validates the id before any request', async () => {
    const { client, backend } = dataRig(server);
    expect(() => client.markets.priceHistory(0)).toThrow(UserInputError);
    expectNoRequest(backend);
  });

  test('statuses is GET /api/markets/:id/statuses', async () => {
    const { client, backend } = dataRig(server);
    const statuses = await client.markets.statuses(5);
    expect(last(backend).path).toBe('/api/markets/5/statuses');
    expect(statuses.marketId).toBe(5);
    expect(statuses.status).toBe('ACTIVE');
    expect(statuses.timestamps.PAUSED).toBeNull();
    expect(statuses.timestamps.EXPIRED).toBe('2026-12-01T00:00:00.000Z');
  });

  test('statuses of an unknown market → 404 rejection', async () => {
    const { client } = dataRig(server);
    expect(await caught(() => client.markets.statuses(404))).toSatisfy(
      rejectedWith(404),
    );
  });
});

describe('markets.activity / allActivity', () => {
  test('activity(id, p) is GET /api/markets/:id/activity and paginates', async () => {
    const { client, backend } = dataRig(server);
    const rows = await client.markets
      .activity(1, {
        take: 3,
        sortBy: 'executedAt',
        sortOrder: 'DESC',
        positionType: 'all',
      })
      .toArray(200);
    expect(rows).toHaveLength(7);
    expect(calls(backend)).toEqual([
      'GET /api/markets/1/activity',
      'GET /api/markets/1/activity',
      'GET /api/markets/1/activity',
    ]);
    expect(backend.requests[0]?.query).toEqual({
      page: '1',
      take: '3',
      sortBy: 'executedAt',
      sortOrder: 'DESC',
      positionType: 'all',
    });
    expect(backend.requests.map((request) => request.query.page)).toEqual([
      '1',
      '2',
      '3',
    ]);
  });

  test('activity rows keep money-like numbers as exact decimal strings', async () => {
    const { client } = dataRig(server);
    const [row] = await client.markets.activity(1).toArray(200);
    expect(row).toBeDefined();
    expect(row?.collateralAmount).toBe('1000000');
    expect(row?.volumeInUSD).toBe('1.00');
    expect(row?.avgEntryValue).toBe('100');
    expect(row?.avgCurrentValue).toBe('120.5');
    expect(row?.avgPnl).toBe('20.5');
    // A percentage is not money: it stays a number.
    expect(row?.avgPnlPercentage).toBe(20.5);
    expect(row?.cpEarned).toBe('3.50');
    expect(row?.tradingFee).toEqual({
      feeAmount: '5000',
      feeInUSD: '0.0050',
      isTaker: true,
      netCollateralAmount: '1005000',
    });
    expect(row?.netFeeUSD).toBe('-0.0050');
    expect(row?.market).toBeNull();
    expect(row?.user?.username).toBe('trader');
    expect(row?.outcome).toMatchObject({ index: 0, currentPrice: '570000' });
  });

  test('activity: take over 50 and userTradesOnly are refused before any request', async () => {
    const { client, backend } = dataRig(server);
    expect(() => client.markets.activity(1, { take: 51 })).toThrow(
      UserInputError,
    );
    expect(() =>
      client.markets.activity(1, { userTradesOnly: true } as never),
    ).toThrow(/userTradesOnly/);
    expect(() => client.markets.activity(0)).toThrow(UserInputError);
    expectNoRequest(backend);
  });

  test('allActivity is GET /api/markets/activities with the default marketScope', async () => {
    const { client, backend } = dataRig(server);
    const rows = await client.markets.allActivity({ take: 50 }).toArray(200);
    expect(last(backend).path).toBe('/api/markets/activities');
    expect(last(backend).query).toEqual({
      page: '1',
      take: '50',
      marketScope: 'onlyClob',
    });
    expect(rows).toHaveLength(CLOB_MARKET_IDS.length);
    expect(rows[0]?.market).toMatchObject({
      id: 1,
      contractMarketId: conditionIdOf(1),
      collateralToken: { symbol: 'USDC', decimals: 6 },
    });

    await client.markets
      .allActivity({ marketScope: 'onlyConviction', marketId: 5 })
      .firstPage();
    expect(last(backend).query).toEqual({
      page: '1',
      marketScope: 'onlyConviction',
      marketId: '5',
    });
    await client.markets.allActivity({ marketType: 4 }).firstPage();
    expect(last(backend).query.marketType).toBe('4');
    expect(last(backend).query.page).toBe('1');
  });

  test('allActivity refuses unknown keys before any request', () => {
    const { client, backend } = dataRig(server);
    expect(() => client.markets.allActivity({ userId: 1 } as never)).toThrow(
      UserInputError,
    );
    expectNoRequest(backend);
  });
});

describe('markets.feeConfig / tradingStatus / pulseStats', () => {
  test('feeConfig(marketId) is GET /api/markets/fee-config/effective?marketId= and unwraps data', async () => {
    const { client, backend } = dataRig(server);
    const config = await client.markets.feeConfig(conditionIdOf(1));
    expect(last(backend).path).toBe('/api/markets/fee-config/effective');
    expect(last(backend).query).toEqual({ marketId: conditionIdOf(1) });
    expect(config).toMatchObject({
      eligible: true,
      curveModel: 'FLAT_BPS',
      takerFeeBps: 200,
      splitSummary: { creatorShareBps: 5000 },
    });
  });

  test('feeConfig needs a market id: refused locally; an unknown market is the backend 400', async () => {
    const { client, backend } = dataRig(server);
    for (const bad of ['', '   ', undefined, 5]) {
      const error = await caught(() => client.markets.feeConfig(bad as never));
      expect(error).toBeInstanceOf(UserInputError);
      // It names the parameter by what it is: an on-chain id, not the backend's market id.
      expect((error as Error).message).toContain('contractMarketId');
    }
    expectNoRequest(backend);
    // The backend answers 400 "Market not found for id ..." (not 404).
    expect(
      await caught(() => client.markets.feeConfig('0xdeadbeef')),
    ).toSatisfy(rejectedWith(400));
  });

  test('pulseStats defaults to onlyClobPulse and onlyPulse is the explicit AMM scope', async () => {
    const { client, backend } = dataRig(server);
    const stats = await client.markets.pulseStats();
    expect(last(backend).path).toBe('/api/markets/pulse/stats');
    expect(last(backend).query).toEqual({ marketScope: 'onlyClobPulse' });
    expect(stats).toEqual({
      totalVolume: '1234567.89',
      totalTrades: 847,
      uniqueTraders: 12481,
      totalMarkets: 42,
      currentPositionsValue: '234567.89',
      initialCollateral: '50000.00',
    });
    await client.markets.pulseStats({ marketId: conditionIdOf(2) });
    expect(last(backend).query).toEqual({
      marketId: conditionIdOf(2),
      marketScope: 'onlyClobPulse',
    });
    await client.markets.pulseStats({ marketScope: 'onlyPulse' });
    expect(last(backend).query).toEqual({ marketScope: 'onlyPulse' });
    expect(
      await caught(() =>
        client.markets.pulseStats({ marketScope: 'onlyClob' } as never),
      ),
    ).toBeInstanceOf(UserInputError);
  });

  test('tradingStatus is a shared route: it is sent with the backend key', async () => {
    const { client, backend } = dataRig(server, { session: true });
    const status = await client.markets.tradingStatus();
    expect(last(backend).path).toBe('/api/markets/clob/trading-status');
    expect(last(backend).authorization).toBe(`Bearer ${API_KEY}`);
    expect(status).toEqual({ status: 'active' });
    backend.tradingStatus = 'paused';
    expect((await client.markets.tradingStatus()).status).toBe('paused');
  });

  test('tradingStatus without credentials → AuthRequiredError and no request', async () => {
    const { client, backend } = dataRig(server);
    expect(await caught(() => client.markets.tradingStatus())).toBeInstanceOf(
      AuthRequiredError,
    );
    expectNoRequest(backend);
  });

  test('tradingStatus with a key the backend rejects → 401 rejection', async () => {
    const { client, backend } = dataRig(server, { session: true });
    backend.validKeys.clear();
    expect(await caught(() => client.markets.tradingStatus())).toSatisfy(
      rejectedWith(401),
    );
  });
});

describe('credentials', () => {
  test('public routes send no Authorization header even when a session exists', async () => {
    const { client, backend } = dataRig(server, { session: true });
    await client.markets.list().firstPage();
    await client.markets.browse().firstPage();
    await client.markets.get(1);
    await client.markets.bySlug(slugOf(1));
    await client.markets.byContract(conditionIdOf(1));
    await client.markets.priceHistory(1).toArray(200);
    await client.markets.statuses(1);
    await client.markets.activity(1).firstPage();
    await client.markets.allActivity().firstPage();
    await client.markets.feeConfig(conditionIdOf(1));
    await client.markets.pulseStats();
    await client.events.list().firstPage();
    await client.series.list().toArray(200);
    await client.pulse.list().firstPage();
    await client.taxonomy.categories().toArray(200);
    await client.taxonomy.tokens().toArray(200);
    expect(backend.requests.length).toBeGreaterThanOrEqual(16);
    for (const request of backend.requests) {
      expect(
        request.authorization,
        `${request.method} ${request.path}`,
      ).toBeNull();
    }
    // ...while the one shared route does carry the key.
    await client.markets.tradingStatus();
    expect(last(backend).authorization).toBe(`Bearer ${API_KEY}`);
  });

  test('every request carries X-XO-SDK', async () => {
    const { client, backend } = dataRig(server, { session: true });
    await client.markets.get(1);
    await client.markets.tradingStatus();
    await client.events.list().firstPage();
    for (const request of backend.requests) {
      expect(request.sdk).toBe('ts/9.9.9');
    }
  });
});

describe('what the backend has been seen to send (live check)', () => {
  // These shapes were observed on a live backend with strict parsing. The fake carries them,
  // and a strict client must take them.

  test('list rows have no visible, collateralToken or fee config; outcomes have a numeric marketId and no timestamps', async () => {
    const { client } = dataRig(server, { strict: true });
    const [row] = await client.markets.list({ take: 1 }).toArray(1);
    expect(row).toBeDefined();
    expect(row?.visible).toBeUndefined();
    expect(row?.collateralToken).toBeUndefined();
    expect(row?.effectiveFeeConfig).toBeUndefined();
    expect(row?.winningOutcome).toBeUndefined();
    expect(row?.outcomes?.[0]?.marketId).toBe(row?.id);
    expect(row?.outcomes?.[0]?.createdAt).toBeUndefined();
  });

  test('detail rows have the token (no timestamps, empty logo), the fee config and the conviction seed', async () => {
    const { client } = dataRig(server, { strict: true });
    const market = await client.markets.get(1);
    expect(market.collateralToken).toMatchObject({
      symbol: 'USDC',
      logoUrl: '',
    });
    expect(market.collateralToken?.createdAt).toBeUndefined();
    expect(market.convictionSeed).toEqual({
      conditionId: conditionIdOf(1),
      creator: null,
      commitment: null,
    });
  });

  test('a resolved market carries its winning outcome, an unresolved one leaves the keys out', async () => {
    const { client } = dataRig(server, { strict: true });
    const resolved = await client.markets.get(RESOLVED_MARKET_ID);
    expect(resolved.status).toBe('CLOSED');
    expect(resolved.winningOutcomeId).toBe(RESOLVED_MARKET_ID * 10 + 1);
    expect(resolved.winningOutcome?.title).toBe('NO');
    const open = await client.markets.get(1);
    expect('winningOutcome' in open).toBe(false);
    expect('winningOutcomeId' in open).toBe(false);
  });

  test('priceHistory of a CLOB market can be empty; the SDK returns an empty page', async () => {
    const { client, backend } = dataRig(server, { strict: true });
    backend.override = (request) =>
      request.path === '/api/markets/1/price-history'
        ? HttpResponse.json([])
        : undefined;
    const page = await client.markets.priceHistory(1).firstPage();
    expect(page.items).toEqual([]);
    expect(page.hasNext).toBe(false);
    expect(page.raw).toEqual([]);
  });
});

describe('raw token units and whole units are different types', () => {
  test('a market, an outcome and an activity row type their amounts by unit', async () => {
    const { client } = dataRig(server);
    const market = await client.markets.get(1);
    expectTypeOf(market.totalVolume).toEqualTypeOf<RawUnitsString>();
    expectTypeOf(market.totalNotional).toEqualTypeOf<
      RawUnitsString | undefined
    >();
    expectTypeOf(market.initialCollateral).toEqualTypeOf<
      RawUnitsString | null | undefined
    >();
    expectTypeOf(market.totalVolumeInUSD).toEqualTypeOf<DecimalString>();
    const outcome = market.outcomes?.[0];
    expectTypeOf(outcome?.currentPrice).toEqualTypeOf<
      RawUnitsString | null | undefined
    >();
    expectTypeOf(outcome?.volumeTradedInUSD).toEqualTypeOf<
      DecimalString | null | undefined
    >();

    const [row] = await client.markets.activity(1).toArray(1);
    expectTypeOf(row?.collateralAmount).toEqualTypeOf<
      RawUnitsString | undefined
    >();
    expectTypeOf(row?.shareAmount).toEqualTypeOf<RawUnitsString | undefined>();
    expectTypeOf(row?.volumeInUSD).toEqualTypeOf<DecimalString | undefined>();
    expectTypeOf(row?.avgPnl).toEqualTypeOf<DecimalString | undefined>();
    expect(outcome?.currentPrice).toBe('570000');
  });

  test('a raw price cannot be passed to priceToTick by accident', async () => {
    const { client } = dataRig(server);
    const market = await client.markets.get(1);
    const raw = market.outcomes?.[0]?.currentPrice;
    if (raw == null) throw new Error('the fixture outcome has a price');
    // @ts-expect-error currentPrice is in raw token units (570000), not a 0..1 price
    expect(() => priceToTick(raw)).toThrow(UserInputError);
    // Converted to whole units, it is a price.
    expect(priceToTick(fromMicro(BigInt(raw)))).toBe(570n);
  });
});

describe('response checking', () => {
  test('lenient keeps unknown fields and takes enum values it does not know', async () => {
    const { client, backend } = dataRig(server);
    backend.marketExtras = { brandNewField: { a: 1 } };
    const market = await client.markets.get(1);
    expect(
      (market as unknown as Record<string, unknown>).brandNewField,
    ).toEqual({
      a: 1,
    });
    backend.marketExtras = { status: 'SOMETHING_NEW' };
    expect((await client.markets.get(1)).status).toBe('SOMETHING_NEW');
  });

  test('strict rejects unknown fields and unknown enum values', async () => {
    const { client, backend } = dataRig(server, { strict: true });
    // Without extras the fixture parses strictly: the schema knows every field it carries.
    expect((await client.markets.get(1)).id).toBe(1);
    backend.marketExtras = { brandNewField: 1 };
    const error = await caught(() => client.markets.get(1));
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).message).toContain(
      '/api/markets/1',
    );
    expect((error as UnexpectedResponseError).message).toContain(
      'brandNewField',
    );

    backend.marketExtras = { status: 'SOMETHING_NEW' };
    expect(await caught(() => client.markets.get(1))).toBeInstanceOf(
      UnexpectedResponseError,
    );
  });

  test('a strict list parse also rejects an unknown meta field', async () => {
    const strict = dataRig(server, { strict: true });
    expect(
      (await strict.client.markets.list().firstPage()).items.length,
    ).toBeGreaterThan(0);
    strict.backend.override = (request) =>
      request.path === '/api/markets'
        ? HttpResponse.json({
            data: [],
            meta: {
              page: 1,
              take: 10,
              itemCount: 0,
              pageCount: 0,
              hasPreviousPage: false,
              hasNextPage: false,
              extra: true,
            },
          })
        : undefined;
    expect(
      await caught(() => strict.client.markets.list().firstPage()),
    ).toBeInstanceOf(UnexpectedResponseError);
  });

  test('money-like JSON numbers become exact decimal strings; a string in exponent form is expanded; a non-decimal string fails the response', async () => {
    const { client, backend } = dataRig(server);
    backend.override = (request) =>
      request.path === '/api/markets/1/statuses'
        ? undefined
        : request.path === '/api/markets/pulse/stats'
          ? HttpResponse.json({
              totalVolume: 1e21,
              totalTrades: 1,
              uniqueTraders: 2,
              totalMarkets: 3,
              currentPositionsValue: 1e-7,
              initialCollateral: 0.57,
            })
          : undefined;
    expect(await client.markets.pulseStats()).toEqual({
      totalVolume: '1000000000000000000000',
      totalTrades: 1,
      uniqueTraders: 2,
      totalMarkets: 3,
      currentPositionsValue: '0.0000001',
      initialCollateral: '0.57',
    });

    // A string in exponent form is expanded in the text, like a number.
    backend.override = (request) =>
      request.path === '/api/markets/pulse/stats'
        ? HttpResponse.json({
            totalVolume: '1e21',
            totalTrades: 1,
            uniqueTraders: 2,
            totalMarkets: 3,
            currentPositionsValue: '1.5E-7',
            initialCollateral: '-2.5e3',
          })
        : undefined;
    expect(await client.markets.pulseStats()).toEqual({
      totalVolume: '1000000000000000000000',
      totalTrades: 1,
      uniqueTraders: 2,
      totalMarkets: 3,
      currentPositionsValue: '0.00000015',
      initialCollateral: '-2500',
    });

    backend.override = (request) =>
      request.path === '/api/markets/pulse/stats'
        ? HttpResponse.json({
            totalVolume: 'not-a-number',
            totalTrades: 1,
            uniqueTraders: 2,
            totalMarkets: 3,
            currentPositionsValue: '1',
            initialCollateral: '1',
          })
        : undefined;
    const error = await caught(() => client.markets.pulseStats());
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as Error).message).toContain('totalVolume');
    expect((error as Error).message).not.toContain('not-a-number');
  });

  test('a body of the wrong shape → UnexpectedResponseError naming the path', async () => {
    const { client, backend } = dataRig(server);
    backend.override = (request) =>
      request.path === '/api/markets/1'
        ? HttpResponse.json({ id: 'not-a-number' })
        : undefined;
    const error = await caught(() => client.markets.get(1));
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as Error).message).toContain('/api/markets/1');
  });
});
