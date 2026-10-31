import { describe, expect, expectTypeOf, test } from 'vitest';
import type { DecimalString } from '../../src/core/types';
import {
  type CatalogEventListItem,
  type CatalogEventTree,
  type CatalogSubEventSummary,
  EventsPageSchema,
  EventTreeSchema,
  type Series as RawSeries,
  SeriesSchema,
  SubEventsSchema,
} from '../../src/data/catalogSchemas';
import {
  type Event,
  type Series,
  toEvent,
  toSeries,
} from '../../src/models/event';
import {
  EVENT_ID,
  EVENT_SLUG,
  eventListItem,
  eventTreeFixture,
  OTHER_EVENT_ID,
  pageMeta,
  SERIES_ID,
  SERIES_SLUG,
  SUB_EVENT_ID,
  seriesFixture,
} from '../helpers/mockBackendData';

function tree(): CatalogEventTree {
  return EventTreeSchema.lenient.parse({ data: eventTreeFixture() }).data;
}

function listItem(
  patch: Record<string, unknown> = {},
  id = EVENT_ID,
  slug = EVENT_SLUG,
): CatalogEventListItem {
  const [row] = EventsPageSchema.lenient.parse({
    data: [{ ...eventListItem(id, slug), ...patch }],
    meta: pageMeta(1, 10, 1),
  }).data;
  if (row === undefined) {
    throw new Error('no row');
  }
  return row;
}

function series(patch: Record<string, unknown> = {}): RawSeries {
  return SeriesSchema.lenient.parse({ data: { ...seriesFixture(), ...patch } })
    .data;
}

/** Every key at every depth, leaving out the free-form `metadata` objects. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(keysOf);
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => [
      key,
      ...(key === 'metadata' ? [] : keysOf(child)),
    ]);
  }
  return [];
}

describe('toEvent', () => {
  test('maps an event tree to the event model', () => {
    const event = toEvent(tree());

    expect(event).toMatchObject({
      id: EVENT_ID,
      parentEventId: null,
      seriesId: SERIES_ID,
      slug: EVENT_SLUG,
      title: 'argentina vs france',
      subtitle: null,
      description: null,
      category: 'Sports',
      image: 'https://cdn.example/banner.png',
      icon: null,
      createdAt: '2026-10-01T12:00:00.000Z',
      updatedAt: '2026-10-01T12:00:00.000Z',
      schedule: { endDate: null },
      metrics: { volume: null },
      metadata: { kickoffAt: '2026-11-20T18:00:00Z' },
      creators: [],
    });
  });

  test('has the fields of the model and nothing else', () => {
    expect(Object.keys(toEvent(tree())).sort()).toEqual([
      'category',
      'createdAt',
      'creators',
      'description',
      'icon',
      'id',
      'image',
      'markets',
      'metadata',
      'metrics',
      'parentEventId',
      'schedule',
      'seriesId',
      'slug',
      'subtitle',
      'title',
      'updatedAt',
    ]);
  });

  test('the markets are the CLOB markets only, mapped as listed markets', () => {
    // The tree has market 1 (CLOB) on the root and market 2 (a CLOB pulse round) on the sub-event.
    const event = toEvent(tree());
    expect(event.markets?.map((m) => m.id)).toEqual(['1']);
    expect(event.markets?.[0]).toMatchObject({
      slug: 'market-1',
      trading: { minimumTickSize: null, feesEnabled: true },
    });
  });

  test('a market keeps the label of its placement as groupItemTitle', () => {
    // The fixture's placements are labelled 'Argentina'.
    const event = toEvent(tree());
    expect(event.markets?.[0]?.groupItemTitle).toBe('Argentina');

    const base = tree();
    const root = base.markets[0];
    if (root === undefined) {
      throw new Error('fixture has a root market');
    }
    const labelled = (groupTitle: string | null) =>
      toEvent({ ...base, markets: [{ ...root, groupTitle }], subEvents: [] })
        .markets?.[0]?.groupItemTitle;
    expect(labelled('France')).toBe('France');
    expect(labelled(null)).toBeNull();
    expect(labelled('')).toBeNull();
  });

  test('the label of a sub-event placement is kept, and the first placement of a market wins', () => {
    const base = tree();
    const root = base.markets[0];
    const sub = base.subEvents[0];
    if (root === undefined || sub === undefined) {
      throw new Error('fixture has a root market and a sub-event');
    }
    const clob = (id: number, groupTitle: string) => ({
      ...root,
      groupTitle,
      market: { ...root.market, id, slug: `market-${id}` },
    });
    const event = toEvent({
      ...base,
      markets: [clob(1, 'Argentina')],
      subEvents: [{ ...sub, markets: [clob(3, 'Draw'), clob(1, 'Elsewhere')] }],
    });
    expect(event.markets?.map((m) => [m.id, m.groupItemTitle])).toEqual([
      ['1', 'Argentina'],
      ['3', 'Draw'],
    ]);
  });

  test('markets of the sub-events are included, once', () => {
    const base = tree();
    const root = base.markets[0];
    const sub = base.subEvents[0];
    if (root === undefined || sub === undefined) {
      throw new Error('fixture has a root market and a sub-event');
    }
    const clob = (id: number, from: typeof root) => ({
      ...from,
      market: {
        ...from.market,
        id,
        slug: `market-${id}`,
      },
    });
    const nested: CatalogEventTree = {
      ...base,
      markets: [root, clob(3, root)],
      subEvents: [
        {
          ...sub,
          markets: [clob(3, root), clob(8, root), sub.markets[0] ?? root],
        },
      ],
    };

    expect(toEvent(nested).markets?.map((m) => m.id)).toEqual(['1', '3', '8']);
  });

  test('a list row without markets has markets null: they were not loaded', () => {
    const event = toEvent(listItem());
    expect(event.markets).toBeNull();
    expect(event).toMatchObject({
      id: EVENT_ID,
      image: 'https://cdn.example/banner.png',
    });
  });

  test('a list row without media has no image and no icon', () => {
    const event = toEvent(listItem({}, OTHER_EVENT_ID, 'brazil-vs-spain'));
    expect(event.image).toBeNull();
    expect(event.icon).toBeNull();
  });

  test('a list row that carries markets, volume and an end time maps them', () => {
    const placements = tree().markets;
    const event = toEvent({
      ...listItem({
        totalVolumeInUSD: '2500.50',
        expiresAt: '2026-12-01T00:00:00.000Z',
      }),
      markets: placements,
    });
    expect(event.markets?.map((m) => m.id)).toEqual(['1']);
    expect(event.metrics.volume).toBe('2500.50');
    expect(event.schedule.endDate).toBe('2026-12-01T00:00:00.000Z');
  });

  test('a sub-event summary keeps its parent and has markets null', () => {
    const [summary] = SubEventsSchema.lenient.parse({
      data: [
        {
          ...eventListItem(SUB_EVENT_ID, 'first-half-winner'),
          parentEventId: EVENT_ID,
          marketCount: 3,
        },
      ],
    }).data;
    const event = toEvent(summary as CatalogSubEventSummary);
    expect(event.parentEventId).toBe(EVENT_ID);
    expect(event.slug).toBe('first-half-winner');
    expect(event.markets).toBeNull();
  });

  test('image is the banner, else the hero; icon is the icon', () => {
    const base = tree();
    const media = (...roles: string[]) =>
      roles.map((role, index) => ({
        id: `m${index}`,
        role,
        url: `https://cdn.example/${role}.png`,
        alt: null,
        sortOrder: index,
        metadata: {},
      }));

    expect(
      toEvent({ ...base, media: media('icon', 'banner', 'hero') }),
    ).toMatchObject({
      image: 'https://cdn.example/banner.png',
      icon: 'https://cdn.example/icon.png',
    });
    expect(toEvent({ ...base, media: media('hero') })).toMatchObject({
      image: 'https://cdn.example/hero.png',
      icon: null,
    });
    expect(toEvent({ ...base, media: media('background') })).toMatchObject({
      image: null,
      icon: null,
    });
    expect(toEvent({ ...base, media: [] }).image).toBeNull();
  });

  test('the creator becomes a one-element creators list', () => {
    const event = toEvent({
      ...tree(),
      creatorId: 7,
      creator: { id: 7, username: 'maker' },
    });
    expect(event.creators).toEqual([{ id: '7', username: 'maker' }]);
  });

  test('a category that is not set is null, and so is a series', () => {
    const event = toEvent({
      ...tree(),
      category: null,
      categoryId: null,
      seriesId: null,
    });
    expect(event.category).toBeNull();
    expect(event.seriesId).toBeNull();
  });

  test('no snake_case or *ID key, and no market type, anywhere in a mapped event', () => {
    const event = toEvent({ ...tree(), creator: { id: 7, username: 'maker' } });
    const keys = keysOf(event);
    expect(keys.length).toBeGreaterThan(40);
    expect(keys.filter((key) => /_|ID$/.test(key))).toEqual([]);
    for (const name of ['type', 'marketType', 'sortOrder', 'priorityScore']) {
      expect(keys, name).not.toContain(name);
    }
  });

  test('does not change the row it reads', () => {
    const row = tree();
    const before = JSON.stringify(row);
    toEvent(row);
    expect(JSON.stringify(row)).toBe(before);
  });

  test('has the types of the model', () => {
    const event = toEvent(tree());
    expectTypeOf(event).toEqualTypeOf<Event>();
    expectTypeOf(event.id).toEqualTypeOf<string>();
    expectTypeOf(event.metrics.volume).toEqualTypeOf<DecimalString | null>();
    expectTypeOf(event.markets).toEqualTypeOf<Event['markets']>();
  });
});

describe('toSeries', () => {
  test('maps a series to the series model', () => {
    expect(toSeries(series())).toEqual({
      id: SERIES_ID,
      slug: SERIES_SLUG,
      title: 'World Cup 2026',
      subtitle: null,
      description: null,
      category: 'Sports',
      active: true,
      createdAt: '2026-10-01T12:00:00.000Z',
      updatedAt: '2026-10-01T12:00:00.000Z',
    });
  });

  test('keeps a subtitle and a description, and has no category when there is none', () => {
    const mapped = toSeries(
      series({
        subtitle: 'Qatar to Canada',
        description: 'Every match.',
        categoryId: null,
        category: null,
        active: false,
      }),
    );
    expect(mapped).toMatchObject({
      subtitle: 'Qatar to Canada',
      description: 'Every match.',
      category: null,
      active: false,
    });
  });

  test('no snake_case or *ID key, and no sort order', () => {
    const keys = keysOf(toSeries(series()));
    expect(keys.filter((key) => /_|ID$/.test(key))).toEqual([]);
    expect(keys).not.toContain('sortOrder');
    expect(keys).not.toContain('categoryId');
  });

  test('has the type of the model', () => {
    expectTypeOf(toSeries(series())).toEqualTypeOf<Series>();
  });
});
