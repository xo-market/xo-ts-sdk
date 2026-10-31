import { describe, expect, test } from 'vitest';
import { UnexpectedResponseError } from '../../src/core/errors';
import { BrowsePageSchema } from '../../src/data/catalogSchemas';
import { type BrowseItem, toBrowseItem } from '../../src/models/browse';
import {
  EVENT_ID,
  EVENT_SLUG,
  marketFixture,
  pageMeta,
  SERIES_ID,
} from '../helpers/mockBackendData';
import { wireStyleKeys } from '../helpers/modelKeys';

const media = [
  {
    id: 'a0000000-0000-4000-8000-000000000001',
    role: 'banner',
    url: 'https://cdn.example/banner.png',
    alt: null,
    sortOrder: 0,
    metadata: {},
  },
];

function placement(id: number, groupTitle: string | null) {
  return {
    groupTitle,
    eventSortOrder: 0,
    market: marketFixture(id),
    liquidityRewards: null,
  };
}

function eventCard(
  markets: Array<ReturnType<typeof placement>>,
  patch: Record<string, unknown> = {},
) {
  return {
    kind: 'event',
    event: {
      id: EVENT_ID,
      parentEventId: null,
      seriesId: SERIES_ID,
      slug: EVENT_SLUG,
      title: 'Argentina vs France',
      subtitle: 'Final',
      metadata: { kickoffAt: '2026-11-20T18:00:00Z' },
      parentTitle: null,
      parentSlug: null,
      eventMedia: media,
      graduatedAt: null,
      type: null,
    },
    markets,
    marketCount: markets.length,
    totalVolumeInUSD: '1500.00',
    totalNotionalInUSD: '2500.00',
    expiresAt: '2026-12-01T00:00:00.000Z',
    cpEnabled: true,
    ...patch,
  };
}

function rawItem(card: Record<string, unknown>) {
  const [row] = BrowsePageSchema.lenient.parse({
    data: [card],
    meta: pageMeta(1, 10, 1),
  }).data;
  if (row === undefined) {
    throw new Error('no row');
  }
  return row;
}

const marketCard = (id: number) => ({
  kind: 'market',
  market: marketFixture(id),
  liquidityRewards: null,
});

function eventOf(item: BrowseItem | undefined) {
  if (item?.kind !== 'event') {
    throw new Error('not an event card');
  }
  return item.event;
}

describe('toBrowseItem', () => {
  test('a standalone market card is the listed market', () => {
    const item = toBrowseItem(rawItem(marketCard(1)));
    expect(item?.kind).toBe('market');
    if (item?.kind !== 'market') {
      throw new Error('not a market card');
    }
    expect(item.market).toMatchObject({
      id: '1',
      slug: 'market-1',
      question: 'Will thing 1 happen?',
      groupItemTitle: null,
    });
  });

  test('a market card of another kind of market is left out', () => {
    expect(toBrowseItem(rawItem(marketCard(2)))).toBeUndefined();
    expect(toBrowseItem(rawItem(marketCard(6)))).toBeUndefined();
  });

  test('an event card has the event, its picture, its totals and its markets with their labels', () => {
    const item = toBrowseItem(
      rawItem(eventCard([placement(1, 'Argentina'), placement(3, '')])),
    );
    const event = eventOf(item);
    expect(event).toMatchObject({
      id: EVENT_ID,
      parentEventId: null,
      seriesId: SERIES_ID,
      slug: EVENT_SLUG,
      title: 'Argentina vs France',
      subtitle: 'Final',
      image: 'https://cdn.example/banner.png',
      endDate: '2026-12-01T00:00:00.000Z',
      metrics: { volume: '1500.00' },
      metadata: { kickoffAt: '2026-11-20T18:00:00Z' },
    });
    expect(event.markets.map((m) => [m.id, m.groupItemTitle])).toEqual([
      ['1', 'Argentina'],
      ['3', null],
    ]);
  });

  test('the markets of an event card that are not CLOB markets are left out', () => {
    const event = eventOf(
      toBrowseItem(
        rawItem(
          eventCard([placement(1, 'A'), placement(2, 'B'), placement(6, 'C')]),
        ),
      ),
    );
    expect(event.markets.map((m) => m.id)).toEqual(['1']);
  });

  test('an event card with no market that the model holds is left out', () => {
    expect(
      toBrowseItem(rawItem(eventCard([placement(2, 'A'), placement(6, 'B')]))),
    ).toBeUndefined();
  });

  test('a card of a kind added later is left out', () => {
    expect(
      toBrowseItem(rawItem({ ...marketCard(1), kind: 'collection' })),
    ).toBeUndefined();
  });

  test('a market card without its market is an unexpected response that names the field', () => {
    const { market: _drop, ...bare } = marketCard(1);
    expect(() => toBrowseItem(rawItem(bare))).toThrow(UnexpectedResponseError);
    expect(() => toBrowseItem(rawItem(bare))).toThrow(/market/);
  });

  test('an event card without its event or markets is an unexpected response', () => {
    const { event: _event, ...noEvent } = eventCard([placement(1, 'A')]);
    expect(() => toBrowseItem(rawItem(noEvent))).toThrow(
      UnexpectedResponseError,
    );
    const { markets: _markets, ...noMarkets } = eventCard([placement(1, 'A')]);
    expect(() => toBrowseItem(rawItem(noMarkets))).toThrow(
      UnexpectedResponseError,
    );
  });

  test('an event card without totals has null totals', () => {
    const event = eventOf(
      toBrowseItem(
        rawItem(
          eventCard([placement(1, 'A')], {
            totalVolumeInUSD: undefined,
            expiresAt: undefined,
          }),
        ),
      ),
    );
    expect(event.metrics.volume).toBeNull();
    expect(event.endDate).toBeNull();
  });

  test('no snake_case or ID-suffixed key, and no key of the answer the model does not name', () => {
    const item = toBrowseItem(
      rawItem(eventCard([placement(1, 'A')], { wire_extra: 1 })),
    );
    expect(wireStyleKeys(item)).toEqual([]);
    const event = eventOf(item);
    expect(Object.keys(event).sort()).toEqual([
      'endDate',
      'id',
      'image',
      'markets',
      'metadata',
      'metrics',
      'parentEventId',
      'seriesId',
      'slug',
      'subtitle',
      'title',
    ]);
  });
});
