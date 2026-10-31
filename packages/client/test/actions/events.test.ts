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
  fetchEvent,
  fetchSeries,
  listEvents,
  listSeries,
  listSubevents,
} from '../../src/actions/events';
import {
  PaginationLimitError,
  RequestAbortedError,
  UserInputError,
} from '../../src/core/errors';
import { actionRig } from '../helpers/actionRig';
import { caught } from '../helpers/dataRig';
import {
  EVENT_COUNT,
  EVENT_ID,
  EVENT_SLUG,
  MISSING_UUID,
  OTHER_EVENT_ID,
  SERIES_ID,
  SERIES_SLUG,
  SUB_EVENT_ID,
} from '../helpers/mockBackendData';
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

const backendCalls = (r: Rig): string[] =>
  r.backend.requests.map((request) => `${request.method} ${request.path}`);

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

function refusal(run: () => unknown): UserInputError {
  try {
    run();
  } catch (error) {
    if (error instanceof UserInputError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the call to throw');
}

// ---------------------------------------------------------------------------
// listEvents
// ---------------------------------------------------------------------------

describe('listEvents', () => {
  test('reads the event list in one request and yields Event models without markets', async () => {
    const r = actionRig(server);
    const page = await listEvents(r.ctx).firstPage();
    expect(backendCalls(r)).toEqual(['GET /api/v1/events']);
    expect(page.items.map((event) => event.id)).toEqual([
      EVENT_ID,
      OTHER_EVENT_ID,
      'd2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f6a',
    ]);
    expect(page.hasMore).toBe(false);
    expect(page.items).toHaveLength(EVENT_COUNT);
    expect(page.items[0]).toMatchObject({
      id: EVENT_ID,
      slug: EVENT_SLUG,
      parentEventId: null,
      seriesId: SERIES_ID,
      category: 'Sports',
      image: 'https://cdn.example/banner.png',
      // The list did not load the markets: that is not the same as having none.
      markets: null,
    });
    expect(wireStyleKeys(page.items)).toEqual([]);
  });

  test('every filter is its query key', async () => {
    const r = actionRig(server);
    await listEvents(r.ctx, {
      seriesId: SERIES_ID,
      categoryId: '1',
      search: 'argentina',
      withMarkets: true,
      pageSize: 4,
    }).firstPage();
    expect(r.backend.requests[0]?.query).toEqual({
      seriesId: SERIES_ID,
      categoryId: '1',
      search: 'argentina',
      withMarkets: 'true',
      take: '4',
      page: '1',
    });
  });

  test('pages come with a cursor and resume with from()', async () => {
    const r = actionRig(server);
    const pages = [];
    for await (const page of listEvents(r.ctx, { pageSize: 2 })) {
      pages.push(page);
    }
    expect(pages.map((page) => page.items.length)).toEqual([2, 1]);
    expect(pages.map((page) => page.hasMore)).toEqual([true, false]);
    const first = await listEvents(r.ctx, { pageSize: 2 }).firstPage();
    const second = await listEvents(r.ctx, { pageSize: 2 })
      .from(first.nextCursor)
      .firstPage();
    expect(second.items).toHaveLength(1);
    expect(r.backend.requests.at(-1)?.query.page).toBe('2');
  });

  test('a cursor of another list, or one that is not a page number, is refused with invalid_cursor', async () => {
    const r = actionRig(server);
    expect(
      refusal(() => listEvents(r.ctx).from(cursorOf('markets', 'page', 2)))
        .code,
    ).toBe('invalid_cursor');
    const error = await caught(() =>
      listEvents(r.ctx)
        .from(cursorOf('events', 'cursor', 'abc'))
        .firstPage(),
    );
    expect((error as UserInputError).code).toBe('invalid_cursor');
    expect(r.backend.requests).toEqual([]);
  });

  test('a cursor beyond the deepest page is a PaginationLimitError, before any request', () => {
    const r = actionRig(server);
    expect(() =>
      listEvents(r.ctx).from(cursorOf('events', 'page', 10_001)),
    ).toThrow(PaginationLimitError);
    expect(r.backend.requests).toEqual([]);
  });

  test('withMarkets needs a series, as the service does', () => {
    const r = actionRig(server);
    const error = refusal(() => listEvents(r.ctx, { withMarkets: true }));
    expect(error.code).toBe('invalid_input');
    expect(error.message).toMatch(/withMarkets.*seriesId/);
    expect(r.backend.requests).toEqual([]);
  });

  test.each([
    ['an unknown key', { rootsOnly: false }],
    ['a seriesId that is no id', { seriesId: 'abc' }],
    ['a categoryId that is a number', { categoryId: 1 }],
    ['a categoryId that is not digits', { categoryId: 'sports' }],
    ['an empty search', { search: '' }],
    ['a pageSize of 0', { pageSize: 0 }],
    ['a pageSize of 1001', { pageSize: 1001 }],
    ['a withMarkets that is text', { seriesId: SERIES_ID, withMarkets: 'yes' }],
  ])('%s is invalid_input, before any request', (_name, request) => {
    const r = actionRig(server);
    const error = refusal(() => listEvents(r.ctx, request as never));
    expect(error.code).toBe('invalid_input');
    expect(error.message).toMatch(/^listEvents: /);
    expect(r.backend.requests).toEqual([]);
  });

  test('the options reach every request', async () => {
    const r = actionRig(server);
    const spy = vi.spyOn(r.transport, 'request');
    for await (const _page of listEvents(
      r.ctx,
      { pageSize: 2 },
      { retries: 0, timeout: 555 },
    )) {
      // read both pages
    }
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [request] of spy.mock.calls) {
      expect(request.call).toEqual({ timeoutMs: 555, retries: 0 });
    }
  });

  test('an aborted signal rejects with RequestAbortedError', async () => {
    const r = actionRig(server);
    const controller = new AbortController();
    controller.abort();
    const error = await caught(() =>
      listEvents(r.ctx, {}, { signal: controller.signal }).firstPage(),
    );
    expect(error).toBeInstanceOf(RequestAbortedError);
  });
});

// ---------------------------------------------------------------------------
// fetchEvent
// ---------------------------------------------------------------------------

describe('fetchEvent', () => {
  test('by id it reads the event tree: its CLOB markets with their labels, sub-event markets included', async () => {
    const r = actionRig(server);
    const event = await fetchEvent(r.ctx, { id: EVENT_ID });
    expect(backendCalls(r)).toEqual([`GET /api/v1/events/${EVENT_ID}`]);
    expect(event).toMatchObject({
      id: EVENT_ID,
      slug: EVENT_SLUG,
      parentEventId: null,
      seriesId: SERIES_ID,
    });
    // Market 2 of the sub-event is a pulse round, not a CLOB market.
    expect(event.markets?.map((m) => [m.id, m.groupItemTitle])).toEqual([
      ['1', 'Argentina'],
    ]);
  });

  test('by slug it reads the event by its slug', async () => {
    const r = actionRig(server);
    const event = await fetchEvent(r.ctx, { slug: EVENT_SLUG });
    expect(backendCalls(r)).toEqual([`GET /api/v1/events/slug/${EVENT_SLUG}`]);
    expect(event.id).toBe(EVENT_ID);
  });

  test('an unknown event is a 404', async () => {
    const r = actionRig(server);
    expect(
      await caught(() => fetchEvent(r.ctx, { id: MISSING_UUID })),
    ).toSatisfy(rejectedWith(404));
    expect(await caught(() => fetchEvent(r.ctx, { slug: 'nope' }))).toSatisfy(
      rejectedWith(404),
    );
  });

  test.each([
    ['no key', {}],
    ['both keys', { id: EVENT_ID, slug: EVENT_SLUG }],
    ['an id that is not a UUID', { id: '12' }],
    ['an empty slug', { slug: '' }],
    ['an unknown key', { id: EVENT_ID, withMarkets: true }],
  ])('%s is invalid_input, before any request', async (_name, request) => {
    const r = actionRig(server);
    const error = await caught(() => fetchEvent(r.ctx, request as never));
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).code).toBe('invalid_input');
    expect((error as UserInputError).message).toMatch(/^fetchEvent: /);
    expect(r.backend.requests).toEqual([]);
  });

  test('the options reach the request', async () => {
    const r = actionRig(server);
    const spy = vi.spyOn(r.transport, 'request');
    await fetchEvent(r.ctx, { id: EVENT_ID }, { retries: 0, timeout: 321 });
    expect(spy.mock.calls[0]?.[0].call).toEqual({ timeoutMs: 321, retries: 0 });
  });
});

// ---------------------------------------------------------------------------
// listSubevents
// ---------------------------------------------------------------------------

describe('listSubevents', () => {
  test('lists the sub-events of an event as Events with the parent set, on one page', async () => {
    const r = actionRig(server);
    const page = await listSubevents(r.ctx, { eventId: EVENT_ID }).firstPage();
    expect(backendCalls(r)).toEqual([
      `GET /api/v1/events/${EVENT_ID}/subevents`,
    ]);
    expect(page.hasMore).toBe(false);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: SUB_EVENT_ID,
      parentEventId: EVENT_ID,
      markets: null,
    });
  });

  test('an unknown event is a 404; a missing or malformed eventId is invalid_input', async () => {
    const r = actionRig(server);
    expect(
      await caught(() =>
        listSubevents(r.ctx, { eventId: MISSING_UUID }).firstPage(),
      ),
    ).toSatisfy(rejectedWith(404));
    for (const request of [{}, { eventId: 'x' }, { id: EVENT_ID }] as never[]) {
      expect(refusal(() => listSubevents(r.ctx, request)).code).toBe(
        'invalid_input',
      );
    }
    expect(
      refusal(() => listSubevents(r.ctx, undefined as never)).message,
    ).toMatch(/eventId/);
  });

  test('this list never gives a cursor, so any cursor is invalid', async () => {
    const r = actionRig(server);
    const error = await caught(() =>
      listSubevents(r.ctx, { eventId: EVENT_ID })
        .from(cursorOf('subevents', 'page', 2))
        .firstPage(),
    );
    expect((error as UserInputError).code).toBe('invalid_cursor');
  });

  test('the options reach the request', async () => {
    const r = actionRig(server);
    const spy = vi.spyOn(r.transport, 'request');
    await listSubevents(
      r.ctx,
      { eventId: EVENT_ID },
      { retries: 0, timeout: 222 },
    ).firstPage();
    expect(spy.mock.calls[0]?.[0].call).toEqual({ timeoutMs: 222, retries: 0 });
  });
});

// ---------------------------------------------------------------------------
// listSeries and fetchSeries
// ---------------------------------------------------------------------------

describe('listSeries', () => {
  test('lists the active series as Series models on one page', async () => {
    const r = actionRig(server);
    const page = await listSeries(r.ctx).firstPage();
    expect(backendCalls(r)).toEqual(['GET /api/v1/series']);
    expect(page.hasMore).toBe(false);
    expect(page.items).toEqual([
      {
        id: SERIES_ID,
        slug: SERIES_SLUG,
        title: 'World Cup 2026',
        subtitle: null,
        description: null,
        category: 'Sports',
        active: true,
        createdAt: '2026-10-01T12:00:00.000Z',
        updatedAt: '2026-10-01T12:00:00.000Z',
      },
    ]);
  });

  test('active: false asks for the series that are not running', async () => {
    const r = actionRig(server);
    const page = await listSeries(r.ctx, { active: false }).firstPage();
    expect(r.backend.requests[0]?.query).toEqual({ active: 'false' });
    expect(page.items).toEqual([]);
  });

  test('a cursor is refused: the list is one page', async () => {
    const r = actionRig(server);
    const error = await caught(() =>
      listSeries(r.ctx)
        .from(cursorOf('series', 'page', 2))
        .firstPage(),
    );
    expect((error as UserInputError).code).toBe('invalid_cursor');
  });

  test('an unknown key and a non-boolean are invalid_input', () => {
    const r = actionRig(server);
    expect(refusal(() => listSeries(r.ctx, { page: 2 } as never)).code).toBe(
      'invalid_input',
    );
    expect(
      refusal(() => listSeries(r.ctx, { active: 'no' } as never)).message,
    ).toMatch(/^listSeries: /);
    expect(r.backend.requests).toEqual([]);
  });
});

describe('fetchSeries', () => {
  test('by id and by slug it reads one series', async () => {
    const r = actionRig(server);
    const byId = await fetchSeries(r.ctx, { id: SERIES_ID });
    const bySlug = await fetchSeries(r.ctx, { slug: SERIES_SLUG });
    expect(backendCalls(r)).toEqual([
      `GET /api/v1/series/${SERIES_ID}`,
      `GET /api/v1/series/slug/${SERIES_SLUG}`,
    ]);
    expect(byId).toEqual(bySlug);
    expect(byId.id).toBe(SERIES_ID);
  });

  test('an unknown series is a 404; a bad request is invalid_input', async () => {
    const r = actionRig(server);
    expect(
      await caught(() => fetchSeries(r.ctx, { id: MISSING_UUID })),
    ).toSatisfy(rejectedWith(404));
    for (const request of [
      {},
      { id: SERIES_ID, slug: SERIES_SLUG },
      { id: 'x' },
      { seriesId: SERIES_ID },
    ] as never[]) {
      const error = await caught(() => fetchSeries(r.ctx, request));
      expect((error as UserInputError).code).toBe('invalid_input');
    }
  });

  test('the options reach the request', async () => {
    const r = actionRig(server);
    const spy = vi.spyOn(r.transport, 'request');
    await fetchSeries(r.ctx, { id: SERIES_ID }, { retries: 0, timeout: 111 });
    expect(spy.mock.calls[0]?.[0].call).toEqual({ timeoutMs: 111, retries: 0 });
  });
});
