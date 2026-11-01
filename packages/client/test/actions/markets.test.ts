import { HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
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
  fetchMarket,
  fetchMarketTradability,
  listBrowseItems,
  listMarkets,
} from '../../src/actions/markets';
import { Clock } from '../../src/core/clock';
import {
  PaginationLimitError,
  RequestAbortedError,
  RequestRejectedError,
  UnexpectedResponseError,
  UserInputError,
} from '../../src/core/errors';
import {
  actionRig,
  INACTIVE_ID,
  noTokenOf,
  yesTokenOf,
} from '../helpers/actionRig';
import { caught } from '../helpers/dataRig';
import {
  conditionIdOf,
  EVENT_ID,
  EVENT_SLUG,
  marketFixture,
  pageMeta,
  SERIES_ID,
  slugOf,
} from '../helpers/mockBackendData';
import { gatewayError, tickToClobPrice } from '../helpers/mockMarketData';
import { rejectedWith } from '../helpers/rejections';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

type Rig = ReturnType<typeof actionRig>;

/** The "METHOD /path" of every request the backend fakes saw, in order. */
const backendCalls = (r: Rig): string[] =>
  r.backend.requests.map((request) => `${request.method} ${request.path}`);

/** A cursor as a list gives it out, made by hand (the format belongs to the paginated module). */
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

/** A 503 as the backend's error handler sends it. */
const unavailable = (): Response =>
  HttpResponse.json(
    { error_type: 'InternalServerError', correlation_id: 'c-1' },
    { status: 503 },
  );

const PLAIN_CLOB_IDS = [1, 3, 8, 10, 12];

// ---------------------------------------------------------------------------
// listMarkets
// ---------------------------------------------------------------------------

describe('listMarkets', () => {
  test('asks for CLOB markets and yields a page of Market models from a single request', async () => {
    const r = actionRig(server);
    const page = await listMarkets(r.ctx).firstPage();
    expect(backendCalls(r)).toEqual(['GET /api/markets']);
    expect(r.backend.requests[0]?.query).toMatchObject({ marketType: '2' });
    expect(r.orderbook.requests).toEqual([]);
    expect(page.items.map((market) => market.id)).toEqual(
      PLAIN_CLOB_IDS.map(String),
    );
    expect(page.hasMore).toBe(false);
    expect(page.items[0]).toMatchObject({
      id: '1',
      slug: slugOf(1),
      conditionId: conditionIdOf(1),
      question: 'Will thing 1 happen?',
      state: { active: true, closed: false, acceptingOrders: null },
      // A list row has no order book, fee policy or rewards: those fields are null, not guessed.
      trading: { minimumTickSize: null, feesEnabled: null, feeSchedule: null },
      rewards: { clobRewards: null },
      outcomes: {
        yes: { label: 'YES', tokenId: yesTokenOf(1), price: null },
        no: { label: 'NO', tokenId: noTokenOf(1), price: null },
      },
    });
  });

  test('a page of three markets is one request: no request per row', async () => {
    const r = actionRig(server);
    const page = await listMarkets(r.ctx, { pageSize: 3 }).firstPage();
    expect(page.items).toHaveLength(3);
    expect(r.backend.requests).toHaveLength(1);
    expect(r.orderbook.requests).toHaveLength(0);
    expect(r.chain.calls).toHaveLength(0);
  });

  test.each([
    ['volume', 'desc', 'totalVolumeInUSD', 'DESC'],
    ['volume', 'asc', 'totalVolumeInUSD', 'ASC'],
    ['created', 'desc', 'createdAt', 'DESC'],
    ['endDate', 'asc', 'expiresAt', 'ASC'],
    ['liquidity', 'desc', 'liquidity', 'DESC'],
  ] as const)(
    'sort %s with order %s is sortBy=%s sortOrder=%s',
    async (sort, order, sortBy, sortOrder) => {
      const r = actionRig(server);
      await listMarkets(r.ctx, { sort, order }).firstPage();
      expect(r.backend.requests[0]?.query).toMatchObject({ sortBy, sortOrder });
    },
  );

  test('a sort without an order is descending; neither sends neither', async () => {
    const r = actionRig(server);
    await listMarkets(r.ctx, { sort: 'volume' }).firstPage();
    expect(r.backend.requests[0]?.query).toMatchObject({
      sortBy: 'totalVolumeInUSD',
      sortOrder: 'DESC',
    });
    await listMarkets(r.ctx).firstPage();
    expect(r.backend.requests[1]?.query).not.toHaveProperty('sortBy');
    expect(r.backend.requests[1]?.query).not.toHaveProperty('sortOrder');
  });

  test('without a status it asks for open (active) markets only', async () => {
    const r = actionRig(server);
    await listMarkets(r.ctx).firstPage();
    await listMarkets(r.ctx, { sort: 'volume', pageSize: 3 }).firstPage();
    await listMarkets(r.ctx, {}).firstPage();
    for (const request of r.backend.requests) {
      expect(request.query.statuses).toBe('ACTIVE');
    }
    expect(r.backend.requests).toHaveLength(3);
  });

  test('an explicit status replaces the default with the stages it covers', async () => {
    const r = actionRig(server);
    await listMarkets(r.ctx, { status: 'closed' }).firstPage();
    await listMarkets(r.ctx, { status: 'resolved' }).firstPage();
    await listMarkets(r.ctx, { status: 'active' }).firstPage();
    // `closed`: past the end time, outcome not decided yet, which XO calls EXPIRED.
    // `resolved`: the outcome is decided, first RESOLVED and then, for good, CLOSED.
    expect(r.backend.requests.map((request) => request.query.statuses)).toEqual(
      ['EXPIRED', 'RESOLVED,CLOSED', 'ACTIVE'],
    );
  });

  test('status, category, page size and end date become the matching filters', async () => {
    const r = actionRig(server);
    await listMarkets(r.ctx, {
      status: 'resolved',
      category: 'Sports',
      pageSize: 7,
      endAfter: new Date('2026-11-01T00:00:00.000Z'),
    }).firstPage();
    expect(r.backend.requests[0]?.query).toMatchObject({
      marketType: '2',
      statuses: 'RESOLVED,CLOSED',
      categories: 'Sports',
      take: '7',
      expiresAfter: '2026-11-01T00:00:00.000Z',
    });
    await listMarkets(r.ctx, { status: 'active' }).firstPage();
    expect(r.backend.requests[1]?.query.statuses).toBe('ACTIVE');
    await listMarkets(r.ctx, { status: 'closed' }).firstPage();
    expect(r.backend.requests[2]?.query.statuses).toBe('EXPIRED');
  });

  test('iterating yields the pages in order, one request each', async () => {
    const r = actionRig(server);
    const pages = [];
    for await (const page of listMarkets(r.ctx, { pageSize: 2 })) {
      pages.push(page);
    }
    expect(pages.map((page) => page.items.map((m) => m.id))).toEqual([
      ['1', '3'],
      ['8', '10'],
      ['12'],
    ]);
    expect(pages.map((page) => page.hasMore)).toEqual([true, true, false]);
    expect(pages[0]?.nextCursor).toEqual(expect.any(String));
    expect(pages[2]?.nextCursor).toBeUndefined();
    expect(r.backend.requests.map((request) => request.query.page)).toEqual([
      '1',
      '2',
      '3',
    ]);
  });

  test('from(nextCursor) resumes at the next page, on a list made again', async () => {
    const r = actionRig(server);
    const first = await listMarkets(r.ctx, { pageSize: 2 }).firstPage();
    const second = await listMarkets(r.ctx, { pageSize: 2 })
      .from(first.nextCursor)
      .firstPage();
    expect(second.items.map((m) => m.id)).toEqual(['8', '10']);
    expect(r.backend.requests.at(-1)?.query.page).toBe('2');
  });

  test('a cursor of another list is refused with invalid_cursor', () => {
    const r = actionRig(server);
    const error = (() => {
      try {
        listMarkets(r.ctx).from(cursorOf('events', 'page', 2));
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).code).toBe('invalid_cursor');
  });

  test('a cursor that is not a page number is refused when the list is read, before any request', async () => {
    const r = actionRig(server);
    for (const forged of [
      cursorOf('markets', 'cursor', 'abc'),
      cursorOf('markets', 'cursor', '1.5'),
      cursorOf('markets', 'cursor', '-2'),
      cursorOf('markets', 'cursor', '0'),
      cursorOf('markets', 'cursor', '007'),
      cursorOf('markets', 'page', 0),
    ]) {
      const error = await caught(() =>
        listMarkets(r.ctx).from(forged).firstPage(),
      );
      expect(error).toBeInstanceOf(UserInputError);
      expect((error as UserInputError).code).toBe('invalid_cursor');
    }
    expect(r.backend.requests).toEqual([]);
  });

  test('a cursor beyond the deepest page is a PaginationLimitError, before any request', () => {
    const r = actionRig(server);
    expect(() =>
      listMarkets(r.ctx).from(cursorOf('markets', 'page', 10_001)),
    ).toThrow(PaginationLimitError);
    expect(r.backend.requests).toEqual([]);
  });

  test('with strict responses a row carrying a field the schema does not know is an unexpected response', async () => {
    const r = actionRig(server, { strict: true });
    r.backend.marketExtras = { surprise: 1 };
    const error = await caught(() => listMarkets(r.ctx).firstPage());
    expect(error).toBeInstanceOf(UnexpectedResponseError);
  });

  test('without strict responses the unknown field is ignored and does not reach the model', async () => {
    const r = actionRig(server, { strict: false });
    r.backend.marketExtras = { surprise: 1 };
    const page = await listMarkets(r.ctx).firstPage();
    expect(page.items).toHaveLength(PLAIN_CLOB_IDS.length);
    expect(JSON.stringify(page.items)).not.toContain('surprise');
  });

  test('a row with other than two outcomes is left out of the page', async () => {
    const r = actionRig(server);
    const one = (id: number) => {
      const row = marketFixture(id) as { outcomes: unknown[] };
      return { ...row, outcomes: row.outcomes.slice(0, 1) };
    };
    r.backend.override = (request) =>
      request.path === '/api/markets'
        ? HttpResponse.json({
            data: [marketFixture(1), one(3), marketFixture(8)],
            meta: pageMeta(1, 10, 3),
          })
        : undefined;
    const page = await listMarkets(r.ctx).firstPage();
    expect(page.items.map((m) => m.id)).toEqual(['1', '8']);
  });

  test('an unknown key is refused at once as invalid_input, naming the key and the allowed ones', () => {
    const r = actionRig(server);
    const error = (() => {
      try {
        listMarkets(r.ctx, { sorted: 'volume' } as never);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).code).toBe('invalid_input');
    expect((error as UserInputError).message).toContain('sorted');
    expect((error as UserInputError).message).toContain('pageSize');
    expect(r.backend.requests).toEqual([]);
  });

  test.each([
    ['status', { status: 'open' }],
    ['sort', { sort: 'price' }],
    ['order', { order: 'up' }],
    ['pageSize of 0', { pageSize: 0 }],
    ['pageSize of 51', { pageSize: 51 }],
    ['pageSize of 1.5', { pageSize: 1.5 }],
    ['pageSize as text', { pageSize: '10' }],
    ['empty category', { category: '' }],
    ['numeric category', { category: 5 }],
    ['endAfter as text', { endAfter: '2026-11-01' }],
    ['endAfter that is no date', { endAfter: new Date('nope') }],
    ['eventId that is no id', { eventId: 'abc' }],
    ['seriesId that is a number', { seriesId: 7 }],
    ['request that is text', 'volume'],
    ['request that is null', null],
  ])('an invalid %s is invalid_input, before any request', (_name, request) => {
    const r = actionRig(server);
    const error = (() => {
      try {
        listMarkets(r.ctx, request as never);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).code).toBe('invalid_input');
    expect((error as UserInputError).message).toMatch(/^listMarkets: /);
    expect(r.backend.requests).toEqual([]);
  });

  test('a message never contains the value that was refused', () => {
    const r = actionRig(server);
    expect(() =>
      listMarkets(r.ctx, { status: 'secret-value' } as never),
    ).toThrow(/status/);
    expect(() =>
      listMarkets(r.ctx, { status: 'secret-value' } as never),
    ).not.toThrow(/secret-value/);
  });

  describe('options', () => {
    test('retries: 0 makes one attempt on a 503; the default retries', async () => {
      const r = actionRig(server);
      r.backend.override = () => unavailable();
      const error = await caught(() =>
        listMarkets(r.ctx, {}, { retries: 0 }).firstPage(),
      );
      expect(error).toSatisfy(rejectedWith(503));
      expect(r.backend.requests).toHaveLength(1);

      const again = await caught(() =>
        listMarkets(r.ctx, {}, { retries: 1 }).firstPage(),
      );
      expect(again).toSatisfy(rejectedWith(503));
      expect(r.backend.requests).toHaveLength(3);
    });

    test('every page request carries the call options', async () => {
      const r = actionRig(server);
      const spy = vi.spyOn(r.transport, 'request');
      for await (const _page of listMarkets(
        r.ctx,
        { pageSize: 2 },
        { retries: 0, timeout: 1234 },
      )) {
        // read them all
      }
      expect(spy).toHaveBeenCalledTimes(3);
      for (const [request] of spy.mock.calls) {
        expect(request.call).toEqual({ timeoutMs: 1234, retries: 0 });
      }
    });

    test('an aborted signal rejects the read with RequestAbortedError and sends nothing', async () => {
      const r = actionRig(server);
      const controller = new AbortController();
      controller.abort();
      const error = await caught(() =>
        listMarkets(r.ctx, {}, { signal: controller.signal }).firstPage(),
      );
      expect(error).toBeInstanceOf(RequestAbortedError);
      expect(r.backend.requests).toEqual([]);
    });

    test('options that are not valid are invalid_request_options, at once', () => {
      const r = actionRig(server);
      for (const options of [
        { retries: 6 },
        { timeout: 0 },
        { retry: 1 },
      ] as never[]) {
        expect(() => listMarkets(r.ctx, {}, options)).toThrow(UserInputError);
      }
      const error = (() => {
        try {
          listMarkets(r.ctx, {}, { retries: 6 });
        } catch (e) {
          return e;
        }
      })();
      expect((error as UserInputError).code).toBe('invalid_request_options');
    });
  });

  describe('inside an event or a series', () => {
    /** The scoped list of an event or a series, with the label each placement carries. */
    function scoped(
      r: Rig,
      path: string,
      labels: Array<[number, string | null]>,
    ) {
      r.backend.override = (request) =>
        request.path === path
          ? HttpResponse.json({
              data: labels.map(([id, groupTitle]) => ({
                eventId: EVENT_ID,
                parentEventId: null,
                eventTitle: 'Argentina vs France',
                eventSlug: EVENT_SLUG,
                eventMedia: [],
                subEventId: null,
                subEventTitle: null,
                subEventSlug: null,
                eventSortOrder: 0,
                rootEventSortOrder: 0,
                groupTitle,
                market: marketFixture(id),
                liquidityRewards: null,
              })),
              meta: pageMeta(1, 10, labels.length),
            })
          : undefined;
    }

    test('eventId reads the markets of the event, each with its label as groupItemTitle', async () => {
      const r = actionRig(server);
      scoped(r, `/api/v1/events/${EVENT_ID}/markets`, [
        [1, 'Argentina'],
        [2, 'Pulse round'],
        [3, ''],
        [8, null],
      ]);
      const page = await listMarkets(r.ctx, { eventId: EVENT_ID }).firstPage();
      expect(backendCalls(r)).toEqual([
        `GET /api/v1/events/${EVENT_ID}/markets`,
      ]);
      // Market 2 is a pulse round, not a CLOB market: it is left out.
      expect(page.items.map((m) => [m.id, m.groupItemTitle])).toEqual([
        ['1', 'Argentina'],
        ['3', null],
        ['8', null],
      ]);
      expect(r.backend.requests[0]?.query).not.toHaveProperty('marketType');
    });

    test('seriesId reads the markets of the series', async () => {
      const r = actionRig(server);
      scoped(r, `/api/v1/series/${SERIES_ID}/markets`, [[1, 'A']]);
      const page = await listMarkets(r.ctx, {
        seriesId: SERIES_ID,
      }).firstPage();
      expect(backendCalls(r)).toEqual([
        `GET /api/v1/series/${SERIES_ID}/markets`,
      ]);
      expect(page.items.map((m) => m.groupItemTitle)).toEqual(['A']);
    });

    test('without a status the markets of an event or a series are the open ones too', async () => {
      const r = actionRig(server);
      await listMarkets(r.ctx, { eventId: EVENT_ID }).firstPage();
      await listMarkets(r.ctx, { seriesId: SERIES_ID }).firstPage();
      await listMarkets(r.ctx, {
        eventId: EVENT_ID,
        status: 'resolved',
      }).firstPage();
      await listMarkets(r.ctx, {
        seriesId: SERIES_ID,
        status: 'closed',
      }).firstPage();
      expect(
        r.backend.requests.map((request) => request.query.statuses),
      ).toEqual(['ACTIVE', 'ACTIVE', 'RESOLVED,CLOSED', 'EXPIRED']);
    });

    test('status, sort, order and page size apply to the scoped list too', async () => {
      const r = actionRig(server);
      await listMarkets(r.ctx, {
        eventId: EVENT_ID,
        status: 'active',
        sort: 'endDate',
        order: 'asc',
        pageSize: 5,
      }).firstPage();
      expect(r.backend.requests[0]?.query).toMatchObject({
        statuses: 'ACTIVE',
        sortBy: 'expiresAt',
        sortOrder: 'ASC',
        take: '5',
      });
    });

    test('it pages with a cursor like the general list', async () => {
      const r = actionRig(server);
      const first = await listMarkets(r.ctx, {
        eventId: EVENT_ID,
        pageSize: 2,
      }).firstPage();
      expect(first.hasMore).toBe(true);
      const second = await listMarkets(r.ctx, {
        eventId: EVENT_ID,
        pageSize: 2,
      })
        .from(first.nextCursor)
        .firstPage();
      expect(r.backend.requests.at(-1)?.query.page).toBe('2');
      expect(second.items.length).toBeGreaterThan(0);
    });

    test.each([
      [
        'eventId together with seriesId',
        { eventId: EVENT_ID, seriesId: SERIES_ID },
      ],
      ['category with an eventId', { eventId: EVENT_ID, category: 'Sports' }],
      [
        'endAfter with a seriesId',
        { seriesId: SERIES_ID, endAfter: new Date() },
      ],
      [
        'sort liquidity with an eventId',
        { eventId: EVENT_ID, sort: 'liquidity' },
      ],
    ])('%s is refused as invalid_input', (_name, request) => {
      const r = actionRig(server);
      const error = (() => {
        try {
          listMarkets(r.ctx, request as never);
        } catch (e) {
          return e;
        }
      })();
      expect(error).toBeInstanceOf(UserInputError);
      expect((error as UserInputError).code).toBe('invalid_input');
      expect(r.backend.requests).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// fetchMarket
// ---------------------------------------------------------------------------

describe('fetchMarket', () => {
  test('by slug it reads the market, its order book, its fees and its rewards: four requests', async () => {
    const r = actionRig(server);
    r.orderbook.books.set(yesTokenOf(1), {
      bids: [{ tick: 550, size: '100' }],
      asks: [{ tick: 560, size: '10' }],
    });
    const market = await fetchMarket(r.ctx, { slug: slugOf(1) });
    const sources = [
      ...backendCalls(r),
      ...r.orderbook.requests.map((q) => `${q.method} ${q.path}`),
    ];
    expect(sources).toHaveLength(4);
    expect(sources).toEqual(
      expect.arrayContaining([
        `GET /api/markets/slug/${slugOf(1)}`,
        `GET /api/markets/fee-config/effective`,
        `GET /api/public/liquidity-rewards/markets/${conditionIdOf(1)}/config`,
        `GET /markets/${conditionIdOf(1)}`,
      ]),
    );
    expect(market).toMatchObject({
      id: '1',
      conditionId: conditionIdOf(1),
      state: { active: true, acceptingOrders: true },
      trading: {
        minimumOrderSize: '1',
        minimumTickSize: '0.001',
        feesEnabled: true,
        feeType: 'FLAT_BPS',
        feeSchedule: {
          takerFeeBps: 200,
          makerFeeBps: 0,
          split: {
            creatorShareBps: 5000,
            makerShareBps: 2500,
            platformShareBps: 2500,
          },
        },
      },
      outcomes: {
        yes: { tokenId: yesTokenOf(1), price: tickToClobPrice(555) },
      },
    });
    expect(market.rewards.clobRewards?.length).toBeGreaterThan(0);
    expect(market.rewards.rewardsMaxSpread).not.toBeNull();
    expect(r.chain.calls).toHaveLength(0);
  });

  test('by id it reads /api/markets/<id> and the three other sources', async () => {
    const r = actionRig(server);
    const market = await fetchMarket(r.ctx, { id: '8' });
    expect(backendCalls(r)).toContain('GET /api/markets/8');
    expect(r.orderbook.requests.map((q) => q.path)).toEqual([
      `/markets/${conditionIdOf(8)}`,
    ]);
    expect(market.id).toBe('8');
    expect(market.state.acceptingOrders).toBe(true);
  });

  test('by condition id it reads the order book market and the contract route of the backend', async () => {
    const r = actionRig(server);
    const market = await fetchMarket(r.ctx, {
      conditionId: conditionIdOf(1).toUpperCase().replace('0X', '0x'),
    });
    expect(r.orderbook.requests.map((q) => q.path)).toEqual([
      `/markets/${conditionIdOf(1)}`,
    ]);
    expect(backendCalls(r)).toContain(
      `GET /api/markets/contract/${conditionIdOf(1)}`,
    );
    expect(backendCalls(r)).toHaveLength(3);
    expect(market.id).toBe('1');
    expect(market.trading.minimumTickSize).toBe('0.001');
  });

  describe('by url', () => {
    test.each([
      'https://xo.market/markets/market-1',
      'https://xo.market/markets/market-1/',
      'https://www.xo.market/markets/market-1',
      'https://beta.xo.market/markets/market-1?ref=abc#top',
      'HTTPS://XO.MARKET/markets/market-1',
      'https://xo.market/markets/market%2D1',
    ])('%s reads the market by its slug', async (url) => {
      const r = actionRig(server);
      const market = await fetchMarket(r.ctx, { url });
      expect(backendCalls(r)).toContain('GET /api/markets/slug/market-1');
      expect(market.slug).toBe('market-1');
    });

    test.each([
      'http://xo.market/markets/market-1',
      'https://example.com/markets/market-1',
      'https://xo.market.evil.com/markets/market-1',
      'https://evilxo.market/markets/market-1',
      'https://xo.market/event/argentina-vs-france',
      'https://xo.market/markets/',
      'https://xo.market/markets',
      'https://xo.market/markets/market-1/extra',
      'https://user:hunter2@xo.market/markets/market-1',
      'https://xo.market:8443/markets/market-1',
      'xo.market/markets/market-1',
      'not a url',
      'https://xo.market/markets/%E0%A4%A',
      '',
    ])('%j is invalid_market_url, before any request', async (url) => {
      const r = actionRig(server);
      const error = await caught(() => fetchMarket(r.ctx, { url }));
      expect(error).toBeInstanceOf(UserInputError);
      expect((error as UserInputError).code).toBe('invalid_market_url');
      const { message } = error as UserInputError;
      // At most the host is echoed: never the path, the credentials, the query or the port.
      for (const secret of [
        'market-1',
        'hunter2',
        'ref=abc',
        '8443',
        'argentina',
        'extra',
        '%E0',
      ]) {
        expect(message, secret).not.toContain(secret);
      }
      expect(r.backend.requests).toEqual([]);
    });

    test('a link on a foreign host may be named by its host and nothing else', async () => {
      const r = actionRig(server);
      const error = await caught(() =>
        fetchMarket(r.ctx, { url: 'https://example.com/markets/market-1?x=1' }),
      );
      expect((error as UserInputError).message).toContain('example.com');
    });
  });

  test('a rewards 404 (the market has no programme) is not an error: the market says so', async () => {
    const r = actionRig(server);
    // Market 8 is not enrolled in the rewards fake.
    const market = await fetchMarket(r.ctx, { id: '8' });
    expect(backendCalls(r)).toContain(
      `GET /api/public/liquidity-rewards/markets/${conditionIdOf(8)}/config`,
    );
    expect(market.rewards).toEqual({
      clobRewards: [],
      rewardsMinSize: null,
      rewardsMaxSpread: null,
    });
    expect(r.backend.requests.length + r.orderbook.requests.length).toBe(4);
  });

  test('a rewards outage is not read as "no programme": the error reaches the caller', async () => {
    const r = actionRig(server);
    r.backend.override = (request) =>
      request.path.includes('/liquidity-rewards/') ? unavailable() : undefined;
    const error = await caught(() =>
      fetchMarket(r.ctx, { id: '1' }, { retries: 0 }),
    );
    expect(error).toSatisfy(rejectedWith(503));
  });

  test('a fee-config failure reaches the caller too', async () => {
    const r = actionRig(server);
    r.backend.override = (request) =>
      request.path === '/api/markets/fee-config/effective'
        ? unavailable()
        : undefined;
    const error = await caught(() =>
      fetchMarket(r.ctx, { id: '1' }, { retries: 0 }),
    );
    expect(error).toSatisfy(rejectedWith(503));
  });

  test('a market the backend does not know is a 404', async () => {
    const r = actionRig(server);
    const error = await caught(() => fetchMarket(r.ctx, { id: '999' }));
    expect(error).toSatisfy(rejectedWith(404));
    const byCondition = await caught(() =>
      fetchMarket(r.ctx, { conditionId: `0x${'ee'.repeat(32)}` }),
    );
    expect(byCondition).toSatisfy(rejectedWith(404));
    const bySlug = await caught(() => fetchMarket(r.ctx, { slug: 'nope' }));
    expect(bySlug).toSatisfy(rejectedWith(404));
  });

  test('a legacy market, which has no condition id, is not_tradable_on_orderbook and nothing else is asked', async () => {
    const r = actionRig(server);
    const error = await caught(() => fetchMarket(r.ctx, { id: '6' }));
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).code).toBe('not_tradable_on_orderbook');
    expect(backendCalls(r)).toEqual(['GET /api/markets/6']);
    expect(r.orderbook.requests).toEqual([]);
  });

  test('a CLOB market the order book does not know is a 404 not_tradable_on_orderbook from the orderbook', async () => {
    const r = actionRig(server);
    // Market 3 is a CLOB market the order book fake does not know.
    const byId = await caught(() => fetchMarket(r.ctx, { id: '3' }));
    expect(byId).toBeInstanceOf(RequestRejectedError);
    expect(byId).toMatchObject({
      status: 404,
      code: 'not_tradable_on_orderbook',
      service: 'orderbook',
    });
    const byCondition = await caught(() =>
      fetchMarket(r.ctx, { conditionId: conditionIdOf(3) }),
    );
    expect(byCondition).toMatchObject({
      status: 404,
      code: 'not_tradable_on_orderbook',
    });
  });

  test('a market that does not have exactly two outcomes is market_not_binary', async () => {
    const r = actionRig(server);
    r.backend.marketExtras = { outcomes: [] };
    const error = await caught(() => fetchMarket(r.ctx, { id: '1' }));
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).code).toBe('market_not_binary');
  });

  test('a market whose outcomes carry no token id has null token ids, not a crash', async () => {
    const r = actionRig(server, { strict: false });
    const outcome = (index: number) => ({
      id: index + 1,
      marketId: 1,
      title: index === 0 ? 'YES' : 'NO',
      index,
      currentPrice: '500000',
    });
    r.backend.marketExtras = { outcomes: [outcome(0), outcome(1)] };
    const market = await fetchMarket(r.ctx, { id: '1' });
    // The order book still gives the tokens, by their YES and NO names.
    expect(market.outcomes.yes.tokenId).toBe(yesTokenOf(1));
    expect(market.outcomes.no.tokenId).toBe(noTokenOf(1));
  });

  test('every one of the four requests carries the call options', async () => {
    const r = actionRig(server);
    const spy = vi.spyOn(r.transport, 'request');
    await fetchMarket(
      r.ctx,
      { slug: slugOf(1) },
      { retries: 0, timeout: 1234 },
    );
    expect(spy).toHaveBeenCalledTimes(4);
    for (const [request] of spy.mock.calls) {
      expect(request.call).toEqual({ timeoutMs: 1234, retries: 0 });
    }
  });

  test('every request of a lookup by condition id carries the call options as well', async () => {
    const r = actionRig(server);
    const spy = vi.spyOn(r.transport, 'request');
    await fetchMarket(
      r.ctx,
      { conditionId: conditionIdOf(1) },
      { retries: 0, timeout: 4321 },
    );
    expect(spy).toHaveBeenCalledTimes(4);
    for (const [request] of spy.mock.calls) {
      expect(request.call).toEqual({ timeoutMs: 4321, retries: 0 });
    }
  });

  test('retries: 0 makes one attempt on a 503 of the order book', async () => {
    const r = actionRig(server);
    r.orderbook.override = (route) =>
      route === '/markets/{condition_id}'
        ? gatewayError(503, 'busy')
        : undefined;
    const error = await caught(() =>
      fetchMarket(r.ctx, { id: '1' }, { retries: 0 }),
    );
    expect(error).toSatisfy(rejectedWith(503));
    expect(r.orderbook.requests).toHaveLength(1);
  });

  test('an aborted signal rejects with RequestAbortedError', async () => {
    const r = actionRig(server);
    const controller = new AbortController();
    controller.abort();
    const error = await caught(() =>
      fetchMarket(r.ctx, { id: '1' }, { signal: controller.signal }),
    );
    expect(error).toBeInstanceOf(RequestAbortedError);
  });

  test.each([
    ['an unknown key', { id: '1', include: 'tags' }],
    ['no key at all', {}],
    ['two ways to name the market', { id: '1', slug: slugOf(1) }],
    ['an id that is not a market id', { id: 'abc' }],
    ['a numeric id', { id: 1 }],
    ['an empty slug', { slug: '' }],
    ['a condition id that is too short', { conditionId: '0x12' }],
    ['a contract address', { conditionId: `0x${'ab'.repeat(20)}` }],
    ['a url that is not text', { url: 7 }],
  ])('%s is invalid_input, before any request', async (_name, request) => {
    const r = actionRig(server);
    const error = await caught(() => fetchMarket(r.ctx, request as never));
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).code).toBe('invalid_input');
    expect((error as UserInputError).message).toMatch(/^fetchMarket: /);
    expect(r.backend.requests).toEqual([]);
    expect(r.orderbook.requests).toEqual([]);
  });

  test('called without a request it says which keys it takes', async () => {
    const r = actionRig(server);
    const error = await caught(() => fetchMarket(r.ctx, undefined as never));
    expect((error as UserInputError).message).toMatch(/id, slug, url/);
  });

  test('invalid options are invalid_request_options', async () => {
    const r = actionRig(server);
    const error = await caught(() =>
      fetchMarket(r.ctx, { id: '1' }, { retries: 99 }),
    );
    expect((error as UserInputError).code).toBe('invalid_request_options');
  });
});

// ---------------------------------------------------------------------------
// fetchMarketTradability
// ---------------------------------------------------------------------------

describe('fetchMarketTradability', () => {
  test('a prepared, registered, active, unexpired market is ok with no reasons', async () => {
    const r = actionRig(server);
    const tradability = await fetchMarketTradability(r.ctx, {
      conditionId: conditionIdOf(1),
    });
    expect(tradability).toEqual({ ok: true, reasons: [] });
    // The three on-chain reads ran.
    expect(r.chain.calls.map((call) => call.name).sort()).toEqual([
      'getConditionId',
      'getOutcomeSlotCount',
      'payoutDenominator',
    ]);
  });

  test('it reads only what the verdict needs: the market, the order book and the chain', async () => {
    const r = actionRig(server);
    await fetchMarketTradability(r.ctx, { conditionId: conditionIdOf(1) });
    expect(backendCalls(r)).toEqual([
      `GET /api/markets/contract/${conditionIdOf(1)}`,
    ]);
    expect(r.orderbook.requests.map((q) => q.path)).toEqual([
      `/markets/${conditionIdOf(1)}`,
    ]);
  });

  test('a rewards outage cannot fail a tradability check', async () => {
    const r = actionRig(server);
    r.backend.override = (request) =>
      request.path.includes('/liquidity-rewards/') ? unavailable() : undefined;
    const tradability = await fetchMarketTradability(r.ctx, {
      conditionId: conditionIdOf(1),
    });
    expect(tradability.ok).toBe(true);
  });

  test('an inactive market is not ok and says orderbook_inactive', async () => {
    const r = actionRig(server);
    const tradability = await fetchMarketTradability(r.ctx, {
      conditionId: conditionIdOf(INACTIVE_ID),
    });
    expect(tradability).toEqual({ ok: false, reasons: ['orderbook_inactive'] });
  });

  test('a condition that is not prepared on chain says not_prepared', async () => {
    const r = actionRig(server);
    r.chain.slotCounts.delete(conditionIdOf(1));
    const tradability = await fetchMarketTradability(r.ctx, {
      conditionId: conditionIdOf(1),
    });
    expect(tradability.ok).toBe(false);
    expect(tradability.reasons).toContain('not_prepared');
  });

  test('a resolved condition and an unregistered token say so', async () => {
    const r = actionRig(server);
    r.chain.payoutDenominators.set(conditionIdOf(1), 1n);
    r.chain.registry.delete(yesTokenOf(1));
    const tradability = await fetchMarketTradability(r.ctx, {
      conditionId: conditionIdOf(1),
    });
    expect(tradability.reasons).toEqual([
      'already_resolved',
      'not_registered_on_exchange',
    ]);
  });

  test("it uses the context's clock for the expiry, not the machine's", async () => {
    const r = actionRig(server);
    const late = new Clock({
      fetchServerTimeSec: async () => 0,
      now: () => Date.parse('2027-01-01T00:00:00.000Z'),
    });
    const tradability = await fetchMarketTradability(
      { ...r.ctx, clock: late },
      { conditionId: conditionIdOf(1) },
    );
    expect(tradability).toEqual({ ok: false, reasons: ['expired'] });
  });

  describe('the signal', () => {
    test('aborting before the chain reads rejects with RequestAbortedError and reads no chain', async () => {
      const r = actionRig(server);
      const controller = new AbortController();
      const reason = new Error('stop now');
      const getMarket = r.ctx.orderbook.getMarket.bind(r.ctx.orderbook);
      // The order book answers, and then the caller gives up.
      vi.spyOn(r.ctx.orderbook, 'getMarket').mockImplementation(
        async (...args) => {
          const market = await getMarket(...args);
          controller.abort(reason);
          return market;
        },
      );
      const error = await caught(() =>
        fetchMarketTradability(
          r.ctx,
          { conditionId: conditionIdOf(1) },
          { signal: controller.signal },
        ),
      );
      expect(error).toBeInstanceOf(RequestAbortedError);
      expect((error as RequestAbortedError).cause).toBe(reason);
      expect(r.chain.calls).toEqual([]);
    });

    test('aborting while the chain is read still rejects, and no verdict is returned', async () => {
      const r = actionRig(server);
      const controller = new AbortController();
      const reason = new Error('too slow');
      r.chain.override = () => {
        controller.abort(reason);
        return undefined;
      };
      const error = await caught(() =>
        fetchMarketTradability(
          r.ctx,
          { conditionId: conditionIdOf(1) },
          { signal: controller.signal },
        ),
      );
      expect(error).toBeInstanceOf(RequestAbortedError);
      expect((error as RequestAbortedError).cause).toBe(reason);
      // The reads were under way and were not cut short.
      expect(r.chain.calls.length).toBeGreaterThan(0);
    });

    test('a signal that is never aborted changes nothing', async () => {
      const r = actionRig(server);
      const controller = new AbortController();
      const tradability = await fetchMarketTradability(
        r.ctx,
        { conditionId: conditionIdOf(1) },
        { signal: controller.signal },
      );
      expect(tradability).toEqual({ ok: true, reasons: [] });
    });
  });

  test('the answer has only ok and reasons', async () => {
    const r = actionRig(server);
    const tradability = await fetchMarketTradability(r.ctx, {
      conditionId: conditionIdOf(1),
    });
    expect(Object.keys(tradability).sort()).toEqual(['ok', 'reasons']);
  });

  test('a failing chain read is an error with the code chain_read_failed, never a guessed verdict', async () => {
    const r = actionRig(server);
    r.chain.override = () => {
      throw new Error('rpc down');
    };
    const error = await caught(() =>
      fetchMarketTradability(r.ctx, { conditionId: conditionIdOf(1) }),
    );
    expect(error).toMatchObject({
      code: 'chain_read_failed',
      service: 'chain',
    });
  });

  test('a market the backend does not know is a 404; one the order book does not know is a 404 too', async () => {
    const r = actionRig(server);
    const unknown = await caught(() =>
      fetchMarketTradability(r.ctx, { conditionId: `0x${'ee'.repeat(32)}` }),
    );
    expect(unknown).toSatisfy(rejectedWith(404));
    const noBook = await caught(() =>
      fetchMarketTradability(r.ctx, { conditionId: conditionIdOf(3) }),
    );
    expect(noBook).toMatchObject({
      status: 404,
      code: 'not_tradable_on_orderbook',
    });
  });

  test('every request carries the call options', async () => {
    const r = actionRig(server);
    const spy = vi.spyOn(r.transport, 'request');
    await fetchMarketTradability(
      r.ctx,
      { conditionId: conditionIdOf(1) },
      { retries: 0, timeout: 999 },
    );
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [request] of spy.mock.calls) {
      expect(request.call).toEqual({ timeoutMs: 999, retries: 0 });
    }
  });

  test.each([
    ['no condition id', {}],
    ['a slug', { conditionId: 'market-1' }],
    ['a short hex', { conditionId: '0x12' }],
    ['a contract address', { conditionId: `0x${'ab'.repeat(20)}` }],
    ['an unknown key', { conditionId: conditionIdOf(1), id: '1' }],
  ])('%s is invalid_input, before any request', async (_name, request) => {
    const r = actionRig(server);
    const error = await caught(() =>
      fetchMarketTradability(r.ctx, request as never),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).code).toBe('invalid_input');
    expect(r.backend.requests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listBrowseItems
// ---------------------------------------------------------------------------

describe('listBrowseItems', () => {
  test('reads the browse feed in its trending order, CLOB markets only, in one request per page', async () => {
    const r = actionRig(server);
    const page = await listBrowseItems(r.ctx).firstPage();
    expect(backendCalls(r)).toEqual(['GET /api/markets/browse']);
    expect(r.backend.requests[0]?.query).toMatchObject({
      sortBy: 'smart',
      marketType: '2',
    });
    expect(page.items.every((item) => item.kind === 'market')).toBe(true);
    expect(
      page.items.map((item) => (item.kind === 'market' ? item.market.id : '')),
    ).toEqual(PLAIN_CLOB_IDS.map(String));
  });

  test('without a status the feed is of open (active) markets; an explicit status replaces it', async () => {
    const r = actionRig(server);
    await listBrowseItems(r.ctx).firstPage();
    await listBrowseItems(r.ctx, { status: 'resolved' }).firstPage();
    await listBrowseItems(r.ctx, { status: 'closed' }).firstPage();
    expect(r.backend.requests.map((request) => request.query.statuses)).toEqual(
      ['ACTIVE', 'RESOLVED,CLOSED', 'EXPIRED'],
    );
  });

  test('another sort replaces the trending one', async () => {
    const r = actionRig(server);
    await listBrowseItems(r.ctx, {
      sort: 'volume',
      order: 'asc',
      status: 'active',
      category: 'Sports',
      pageSize: 3,
    }).firstPage();
    expect(r.backend.requests[0]?.query).toMatchObject({
      sortBy: 'totalVolumeInUSD',
      sortOrder: 'ASC',
      statuses: 'ACTIVE',
      categories: 'Sports',
      take: '3',
    });
  });

  test('an event card has its markets with their labels', async () => {
    const r = actionRig(server);
    r.backend.override = (request) =>
      request.path === '/api/markets/browse'
        ? HttpResponse.json({
            data: [
              {
                kind: 'event',
                event: {
                  id: EVENT_ID,
                  parentEventId: null,
                  seriesId: SERIES_ID,
                  slug: EVENT_SLUG,
                  title: 'Argentina vs France',
                  subtitle: null,
                  metadata: {},
                  eventMedia: [],
                },
                markets: [
                  {
                    groupTitle: 'Argentina',
                    eventSortOrder: 0,
                    market: marketFixture(1),
                    liquidityRewards: null,
                  },
                ],
                marketCount: 1,
              },
              {
                kind: 'market',
                market: marketFixture(3),
                liquidityRewards: null,
              },
            ],
            meta: pageMeta(1, 10, 2),
          })
        : undefined;
    const page = await listBrowseItems(r.ctx).firstPage();
    expect(page.items.map((item) => item.kind)).toEqual(['event', 'market']);
    const [card] = page.items;
    if (card?.kind !== 'event') {
      throw new Error('not an event card');
    }
    expect(card.event.slug).toBe(EVENT_SLUG);
    expect(card.event.markets.map((m) => [m.id, m.groupItemTitle])).toEqual([
      ['1', 'Argentina'],
    ]);
  });

  test('it pages with a cursor', async () => {
    const r = actionRig(server);
    const first = await listBrowseItems(r.ctx, { pageSize: 2 }).firstPage();
    expect(first.hasMore).toBe(true);
    await listBrowseItems(r.ctx, { pageSize: 2 })
      .from(first.nextCursor)
      .firstPage();
    expect(r.backend.requests.at(-1)?.query.page).toBe('2');
    const forged = await caught(() =>
      listBrowseItems(r.ctx)
        .from(cursorOf('browse', 'cursor', 'x'))
        .firstPage(),
    );
    expect((forged as UserInputError).code).toBe('invalid_cursor');
  });

  test('a cursor beyond the deepest page is a PaginationLimitError, before any request', () => {
    const r = actionRig(server);
    expect(() =>
      listBrowseItems(r.ctx).from(cursorOf('browse', 'page', 10_001)),
    ).toThrow(PaginationLimitError);
    expect(r.backend.requests).toEqual([]);
  });

  test('an unknown key and a bad value are invalid_input at once', () => {
    const r = actionRig(server);
    expect(() =>
      listBrowseItems(r.ctx, { eventId: EVENT_ID } as never),
    ).toThrow(/listBrowseItems: .*eventId/);
    expect(() => listBrowseItems(r.ctx, { sort: 'smart' } as never)).toThrow(
      UserInputError,
    );
    expect(r.backend.requests).toEqual([]);
  });

  test('the options reach every request', async () => {
    const r = actionRig(server);
    const spy = vi.spyOn(r.transport, 'request');
    await listBrowseItems(r.ctx, {}, { retries: 0, timeout: 777 }).firstPage();
    expect(spy.mock.calls[0]?.[0].call).toEqual({ timeoutMs: 777, retries: 0 });
  });
});
