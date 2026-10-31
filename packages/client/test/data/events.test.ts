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
import { UserInputError } from '../../src/core/errors';
import { caught, dataRig, expectNoRequest, last } from '../helpers/dataRig';
import {
  EVENT_COUNT,
  EVENT_ID,
  EVENT_SLUG,
  MISSING_UUID,
  SERIES_ID,
  SERIES_SLUG,
  SUB_EVENT_ID,
} from '../helpers/mockBackendData';
import { rejectedWith } from '../helpers/rejections';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

describe('events.list', () => {
  test('GET /api/v1/events: no marketScope (the events DTO has none), no credentials', async () => {
    const { client, backend } = dataRig(server);
    const page = await client.events.list().firstPage();
    const request = last(backend);
    expect(request.path).toBe('/api/v1/events');
    expect(request.query).toEqual({ page: '1' });
    expect(request.authorization).toBeNull();
    expect(page.items).toHaveLength(EVENT_COUNT);
    expect(page.items[0]).toMatchObject({
      id: EVENT_ID,
      slug: EVENT_SLUG,
      subEventCount: 1,
      marketCount: 2,
      directMarketCount: 1,
      parentEventId: null,
    });
    expect(page.items[0]?.media?.[0]?.role).toBe('banner');
  });

  test('paginates {data, meta: PageMeta} via hasNextPage', async () => {
    const { client, backend } = dataRig(server);
    const all = await client.events.list({ take: 2 }).toArray(200);
    expect(all).toHaveLength(EVENT_COUNT);
    expect(backend.requests.map((request) => request.query.page)).toEqual([
      '1',
      '2',
    ]);
    const first = await client.events.list({ take: 2 }).firstPage();
    expect((first.raw as { meta: { itemCount: number } }).meta.itemCount).toBe(
      EVENT_COUNT,
    );
  });

  test('sends every supported filter in one request, all of them known to the DTO', async () => {
    const { client, backend } = dataRig(server);
    await client.events
      .list({
        page: 1,
        take: 1000,
        search: 'world cup',
        sortBy: 'endingSoon',
        sortOrder: 'DESC',
        seriesId: SERIES_ID,
        rootsOnly: false,
        categoryId: 1,
        withMarkets: true,
        hasSubEvents: true,
        statuses: ['ACTIVE'],
        excludedStatuses: ['CANCELLED'],
        marketType: [2, 4],
        metadataKey: 'kickoffAt',
        metadataAfter: '2026-11-01T00:00:00Z',
        metadataBefore: new Date('2026-12-01T00:00:00Z'),
      })
      .firstPage();
    expect(last(backend).query).toEqual({
      page: '1',
      take: '1000',
      search: 'world cup',
      sortBy: 'endingSoon',
      sortOrder: 'DESC',
      seriesId: SERIES_ID,
      rootsOnly: 'false',
      categoryId: '1',
      withMarkets: 'true',
      hasSubEvents: 'true',
      statuses: 'ACTIVE',
      excludedStatuses: 'CANCELLED',
      marketType: '2,4',
      metadataKey: 'kickoffAt',
      metadataAfter: '2026-11-01T00:00:00.000Z',
      metadataBefore: '2026-12-01T00:00:00.000Z',
    });
  });

  test('unknown keys, a bad take and a marketScope are ValidationErrors before any request', () => {
    const { client, backend } = dataRig(server);
    expect(() => client.events.list({ nope: 1 } as never)).toThrow(
      UserInputError,
    );
    expect(() => client.events.list({ take: 1001 })).toThrow(UserInputError);
    expect(() =>
      client.events.list({ marketScope: 'onlyClob' } as never),
    ).toThrow(UserInputError);
    expect(() => client.events.list({ seriesId: 'x' })).toThrow(UserInputError);
    expectNoRequest(backend);
  });
});

describe('events.get / bySlug', () => {
  test('get(id) is GET /api/v1/events/:eventId and returns the tree without the data envelope', async () => {
    const { client, backend } = dataRig(server);
    const tree = await client.events.get(EVENT_ID);
    expect(last(backend).path).toBe(`/api/v1/events/${EVENT_ID}`);
    expect(tree.id).toBe(EVENT_ID);
    expect(tree.slug).toBe(EVENT_SLUG);
    expect(tree.cpEnabled).toBe(true);
    expect(tree.markets).toHaveLength(1);
    expect(tree.markets[0]?.market.id).toBe(1);
    expect(tree.markets[0]?.groupTitle).toBe('Argentina');
    expect(tree.subEvents).toHaveLength(1);
    expect(tree.subEvents[0]?.id).toBe(SUB_EVENT_ID);
    expect(tree.subEvents[0]?.parentEventId).toBe(EVENT_ID);
    // The size is a JSON number in the response and a DecimalString here.
    expect(tree.markets[0]?.liquidityRewards).toEqual({
      currency: 'USDC',
      eligible: true,
      dailyPool: '1000',
      maxDistanceCents: '3',
      minOrderRestMs: 2500,
      minOrderRestSeconds: 3,
      minOrderSizeShares: '5',
      minPayout: '1.00',
      maxAvgPrice: '0.98',
    });
  });

  test('a bad event id is a UserInputError before any request; an unknown one is a 404 rejection', async () => {
    const { client, backend } = dataRig(server);
    for (const bad of ['', 'abc', `${EVENT_ID}/x`, 5, null, undefined]) {
      expect(
        await caught(() => client.events.get(bad as never)),
      ).toBeInstanceOf(UserInputError);
    }
    expectNoRequest(backend);
    expect(await caught(() => client.events.get(MISSING_UUID))).toSatisfy(
      rejectedWith(404),
    );
  });

  test('bySlug is GET /api/v1/events/slug/:slug; 404 → 404 rejection', async () => {
    const { client, backend } = dataRig(server);
    const tree = await client.events.bySlug(EVENT_SLUG);
    expect(last(backend).path).toBe(`/api/v1/events/slug/${EVENT_SLUG}`);
    expect(tree.id).toBe(EVENT_ID);
    expect(await caught(() => client.events.bySlug('nope'))).toSatisfy(
      rejectedWith(404),
    );
    expect(await caught(() => client.events.bySlug('..'))).toBeInstanceOf(
      UserInputError,
    );
  });
});

describe('events.markets / subevents', () => {
  test('markets(id, p) is GET /api/v1/events/:eventId/markets and paginates', async () => {
    const { client, backend } = dataRig(server);
    const rows = await client.events
      .markets(EVENT_ID, {
        take: 2,
        sortBy: 'expiresAt',
        sortOrder: 'ASC',
        includeSubEvents: true,
        statuses: ['ACTIVE'],
      })
      .toArray(200);
    expect(rows).toHaveLength(3);
    expect(backend.requests.map((request) => request.path)).toEqual([
      `/api/v1/events/${EVENT_ID}/markets`,
      `/api/v1/events/${EVENT_ID}/markets`,
    ]);
    expect(backend.requests[0]?.query).toEqual({
      page: '1',
      take: '2',
      sortBy: 'expiresAt',
      sortOrder: 'ASC',
      includeSubEvents: 'true',
      statuses: 'ACTIVE',
    });
    expect(rows[1]).toMatchObject({
      eventId: SUB_EVENT_ID,
      parentEventId: EVENT_ID,
      subEventTitle: 'First half winner',
    });
    expect(rows[0]?.market.id).toBe(1);
  });

  test('markets validates the id and the params before any request', () => {
    const { client, backend } = dataRig(server);
    expect(() => client.events.markets('nope')).toThrow(UserInputError);
    expect(() =>
      client.events.markets(EVENT_ID, { sortBy: 'priorityScore' } as never),
    ).toThrow(UserInputError);
    expect(() =>
      client.events.markets(EVENT_ID, { marketScope: 'onlyClob' } as never),
    ).toThrow(UserInputError);
    expectNoRequest(backend);
  });

  test('subevents(id) is GET /api/v1/events/:eventId/subevents: one page, raw {data}', async () => {
    const { client, backend } = dataRig(server);
    const page = await client.events.subevents(EVENT_ID).firstPage();
    expect(last(backend).path).toBe(`/api/v1/events/${EVENT_ID}/subevents`);
    expect(last(backend).query).toEqual({});
    expect(page.hasNext).toBe(false);
    expect(Object.keys(page.raw as object)).toEqual(['data']);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: SUB_EVENT_ID, marketCount: 1 });
    expect(await client.events.subevents(EVENT_ID).toArray(200)).toHaveLength(
      1,
    );
  });

  test('subevents of an unknown event → 404 rejection', async () => {
    const { client } = dataRig(server);
    expect(
      await caught(() => client.events.subevents(MISSING_UUID).toArray(200)),
    ).toSatisfy(rejectedWith(404));
  });
});

describe('series', () => {
  test('list() is GET /api/v1/series: a single page of {data: [...]}', async () => {
    const { client, backend } = dataRig(server);
    const page = await client.series.list().firstPage();
    expect(last(backend).path).toBe('/api/v1/series');
    expect(last(backend).query).toEqual({});
    expect(last(backend).authorization).toBeNull();
    expect(page.hasNext).toBe(false);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: SERIES_ID,
      slug: SERIES_SLUG,
      active: true,
    });
    expect(page.items[0]?.category?.name).toBe('Sports');
  });

  test('list({ active: false }) sends active=false; other keys are refused', async () => {
    const { client, backend } = dataRig(server);
    expect(await client.series.list({ active: false }).toArray(200)).toEqual(
      [],
    );
    expect(last(backend).query).toEqual({ active: 'false' });
    // The route reads only `active`; page and take would be silently ignored.
    expect(() => client.series.list({ page: 1 } as never)).toThrow(
      UserInputError,
    );
  });

  test('get(id), bySlug(slug) unwrap the data envelope', async () => {
    const { client, backend } = dataRig(server);
    const byId = await client.series.get(SERIES_ID);
    expect(last(backend).path).toBe(`/api/v1/series/${SERIES_ID}`);
    expect(byId.slug).toBe(SERIES_SLUG);
    const bySlug = await client.series.bySlug(SERIES_SLUG);
    expect(last(backend).path).toBe(`/api/v1/series/slug/${SERIES_SLUG}`);
    expect(bySlug.id).toBe(SERIES_ID);
    expect(await caught(() => client.series.get(MISSING_UUID))).toSatisfy(
      rejectedWith(404),
    );
    expect(await caught(() => client.series.bySlug('nope'))).toSatisfy(
      rejectedWith(404),
    );
    expect(await caught(() => client.series.get('nope'))).toBeInstanceOf(
      UserInputError,
    );
  });

  test('markets(id, p) is GET /api/v1/series/:seriesId/markets and paginates', async () => {
    const { client, backend } = dataRig(server);
    const rows = await client.series
      .markets(SERIES_ID, { take: 2 })
      .toArray(200);
    expect(rows).toHaveLength(3);
    expect(backend.requests.map((request) => request.path)).toEqual([
      `/api/v1/series/${SERIES_ID}/markets`,
      `/api/v1/series/${SERIES_ID}/markets`,
    ]);
    expect(rows[0]?.eventSlug).toBe(EVENT_SLUG);
    expect(() =>
      client.series.markets(SERIES_ID, { bogus: 1 } as never),
    ).toThrow(UserInputError);
    expect(
      await caught(() => client.series.markets(MISSING_UUID).toArray(200)),
    ).toSatisfy(rejectedWith(404));
  });
});

describe('what the backend has been seen to send (live check)', () => {
  test('a media slot outside icon, banner and background (hero) parses strictly', async () => {
    const { client } = dataRig(server, { strict: true });
    const tree = await client.events.get(EVENT_ID);
    expect(tree.media.map((media) => media.role)).toEqual(['banner', 'hero']);
  });

  test('media is left out of a sub-event and of an event without media, not sent empty', async () => {
    const { client } = dataRig(server, { strict: true });
    const tree = await client.events.get(EVENT_ID);
    const sub = tree.subEvents[0];
    expect(sub).toBeDefined();
    expect('media' in (sub ?? {})).toBe(false);
    const [summary] = await client.events.subevents(EVENT_ID).toArray(5);
    expect(summary).toBeDefined();
    expect('media' in (summary ?? {})).toBe(false);
    const events = await client.events.list({ take: 3 }).toArray(3);
    expect(events.map((event) => event.media !== undefined)).toEqual([
      true,
      false,
      false,
    ]);
  });
});
