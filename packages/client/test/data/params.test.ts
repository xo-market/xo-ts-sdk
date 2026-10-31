import { describe, expect, test } from 'vitest';
import { UserInputError } from '../../src/core/errors';
import {
  allActivityQuery,
  browseMarketsQuery,
  categoriesQuery,
  closedQuery,
  field,
  listEventsQuery,
  listMarketsQuery,
  listSeriesQuery,
  marketActivityQuery,
  marketIdSegment,
  marketKeySegment,
  pulseKeySegment,
  pulseListQuery,
  pulseStatsQuery,
  scopedMarketsQuery,
  slugSegment,
  subcategoriesQuery,
  uuidSegment,
} from '../../src/data/params';

// The mirrors of the backend's query validation: the market filters (page 1..10000, take 1..50
// here), the market activity filters, the event, pulse market, category and subcategory
// queries.

const bad = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(UserInputError);
    return (error as UserInputError).message;
  }
  throw new Error('expected a UserInputError');
};

describe('closedQuery', () => {
  const spec = { page: field.int(1, 10), name: field.str() };

  test('undefined input is an empty query', () => {
    expect(closedQuery('x', undefined, spec)).toEqual({});
  });

  test('undefined values are skipped, known keys pass', () => {
    expect(closedQuery('x', { page: 2, name: undefined }, spec)).toEqual({
      page: 2,
    });
  });

  test('an unknown key is a UserInputError naming the key and the allowed ones', () => {
    const message = bad(() => closedQuery('x', { page: 1, bogus: 1 }, spec));
    expect(message).toContain('bogus');
    expect(message).toContain('page');
    expect(message).toContain('name');
  });

  test('an unknown key name is truncated, its value is never echoed', () => {
    const message = bad(() =>
      closedQuery('x', { ['k'.repeat(200)]: 'topsecretvalue' }, spec),
    );
    expect(message).not.toContain('topsecretvalue');
    expect(message.length).toBeLessThan(400);
  });

  test('null, arrays and primitives are not param objects', () => {
    for (const input of [null, [], 5, 'page=1']) {
      bad(() => closedQuery('x', input, spec));
    }
  });

  test('a null value is refused (undefined means absent)', () => {
    bad(() => closedQuery('x', { page: null }, spec));
  });

  test('the label prefixes the message', () => {
    expect(bad(() => closedQuery('markets.list', { nope: 1 }, spec))).toMatch(
      /^markets\.list:/,
    );
  });
});

describe('fields', () => {
  test('int: whole numbers inside the range; no strings', () => {
    const f = field.int(1, 50);
    expect(f(1, 'take')).toBe(1);
    expect(f(50, 'take')).toBe(50);
    for (const value of [0, 51, 1.5, Number.NaN, Infinity, '5', true, 10n]) {
      bad(() => f(value, 'take'));
    }
  });

  test('str: non-empty strings only', () => {
    expect(field.str()('abc', 'search')).toBe('abc');
    for (const value of ['', 5, null, {}]) {
      bad(() => field.str()(value, 'search'));
    }
  });

  test('bool: booleans only', () => {
    expect(field.bool()(true, 'x')).toBe(true);
    expect(field.bool()(false, 'x')).toBe(false);
    for (const value of ['true', 1, 0]) {
      bad(() => field.bool()(value, 'x'));
    }
  });

  test('oneOf: the listed values, case-sensitive', () => {
    const f = field.oneOf(['ASC', 'DESC'] as const);
    expect(f('ASC', 'sortOrder')).toBe('ASC');
    for (const value of ['asc', 'UP', 1, undefined]) {
      bad(() => f(value, 'sortOrder'));
    }
  });

  test('list: joins with commas, accepts one value, drops an empty list', () => {
    const f = field.list(field.oneOf(['A', 'B', 'C'] as const));
    expect(f(['A', 'B'], 'x')).toBe('A,B');
    expect(f('C', 'x')).toBe('C');
    expect(f([], 'x')).toBeUndefined();
    bad(() => f(['A', 'D'], 'x'));
    bad(() => f(['A', undefined], 'x'));
  });

  test('list: max length and no commas inside a string item', () => {
    const f = field.list(field.str(), { max: 2 });
    expect(f(['a', 'b'], 'ids')).toBe('a,b');
    bad(() => f(['a', 'b', 'c'], 'ids'));
    bad(() => f(['a,b'], 'ids'));
  });

  test('dateTime: a valid Date or date string becomes an ISO string', () => {
    const f = field.dateTime();
    expect(f(new Date('2026-10-18T10:00:00Z'), 'x')).toBe(
      '2026-10-18T10:00:00.000Z',
    );
    expect(f('2026-10-18T10:00:00Z', 'x')).toBe('2026-10-18T10:00:00.000Z');
    for (const value of [new Date('nope'), 'yesterday', 5, null]) {
      bad(() => f(value, 'x'));
    }
  });

  test('decimal: a non-negative plain decimal, numbers converted exactly', () => {
    const f = field.decimal();
    expect(f(100, 'minVolume')).toBe('100');
    expect(f(0.5, 'minVolume')).toBe('0.5');
    expect(f(1e-7, 'minVolume')).toBe('0.0000001');
    expect(f('12.50', 'minVolume')).toBe('12.50');
    for (const value of [-1, '-1', '1e3', '', Number.NaN, 'abc', null]) {
      bad(() => f(value, 'minVolume'));
    }
  });
});

describe("listMarketsQuery (the backend's market filter)", () => {
  test('marketScope defaults to onlyClob', () => {
    expect(listMarketsQuery(undefined)).toEqual({ marketScope: 'onlyClob' });
    expect(listMarketsQuery({ page: 2 })).toEqual({
      page: 2,
      marketScope: 'onlyClob',
    });
  });

  test('marketScope can be overridden with any value of the backend list', () => {
    for (const scope of [
      'default',
      'withPulse',
      'onlyPulse',
      'onlyClob',
      'withClob',
      'onlyClobPulse',
      'onlyConviction',
    ]) {
      expect(listMarketsQuery({ marketScope: scope })).toEqual({
        marketScope: scope,
      });
    }
    bad(() => listMarketsQuery({ marketScope: 'everything' }));
  });

  test('take is 1..50 and page is 1..10000', () => {
    expect(listMarketsQuery({ take: 50, page: 10_000 })).toMatchObject({
      take: 50,
      page: 10_000,
    });
    for (const take of [0, 51, 1000]) {
      bad(() => listMarketsQuery({ take }));
    }
    for (const page of [0, 10_001]) {
      bad(() => listMarketsQuery({ page }));
    }
  });

  test('sends every supported filter in the backend names', () => {
    expect(
      listMarketsQuery({
        page: 1,
        take: 10,
        search: 'btc',
        sortBy: 'totalVolumeInUSD',
        sortOrder: 'DESC',
        marketScope: 'withClob',
        marketType: [2, 3],
        categories: ['SPORTS', 'FINANCE'],
        categoryId: 3,
        subcategoryId: 4,
        subcategoryUnassigned: true,
        tagKey: 'player',
        tagValue: 'ronaldo',
        statuses: ['ACTIVE', 'CLOSING_24H'],
        excludedStatuses: ['VOIDED'],
        creatorId: 9,
        creatorType: 'admin',
        expiresAfter: new Date('2026-11-01T00:00:00Z'),
        expiresBefore: '2026-12-01T00:00:00Z',
        minVolume: 100,
        maxVolume: '5000.5',
        volumeInToken: false,
        collateralTokenIds: [1, 2],
        isResolved: false,
        isFeatureMarket: true,
        unplacedOnly: true,
        graduated: false,
        contractMarketIds: ['0xaa', '0xbb'],
      }),
    ).toEqual({
      page: 1,
      take: 10,
      search: 'btc',
      sortBy: 'totalVolumeInUSD',
      sortOrder: 'DESC',
      marketScope: 'withClob',
      marketType: '2,3',
      unplacedOnly: true,
      graduated: false,
      categories: 'SPORTS,FINANCE',
      categoryId: 3,
      subcategoryId: 4,
      subcategoryUnassigned: true,
      tagValue: 'ronaldo',
      tagKey: 'player',
      statuses: 'ACTIVE,CLOSING_24H',
      excludedStatuses: 'VOIDED',
      creatorId: 9,
      expiresAfter: '2026-11-01T00:00:00.000Z',
      expiresBefore: '2026-12-01T00:00:00.000Z',
      minVolume: '100',
      maxVolume: '5000.5',
      volumeInToken: false,
      collateralTokenIds: '1,2',
      isResolved: false,
      creatorType: 'admin',
      isFeatureMarket: true,
      contractMarketIds: '0xaa,0xbb',
    });
  });

  test('refuses a status the backend does not know, a bad sortBy, a bad marketType', () => {
    bad(() => listMarketsQuery({ statuses: ['LIVE'] }));
    bad(() => listMarketsQuery({ sortBy: 'volume' }));
    bad(() => listMarketsQuery({ marketType: [5] }));
    bad(() => listMarketsQuery({ creatorType: 'bot' }));
    bad(() => listMarketsQuery({ contractMarketIds: Array(101).fill('0xaa') }));
  });

  test('`smart` sorting and includeAMM are browse-only; skip is never accepted', () => {
    bad(() => listMarketsQuery({ sortBy: 'smart' }));
    bad(() => listMarketsQuery({ includeAMM: true }));
    expect(browseMarketsQuery({ sortBy: 'smart', includeAMM: true })).toEqual({
      sortBy: 'smart',
      includeAMM: true,
      marketScope: 'onlyClob',
    });
    bad(() => listMarketsQuery({ skip: 10 }));
    bad(() => browseMarketsQuery({ skip: 10 }));
  });

  test('browse: page/take/search/sortBy and the default scope, nothing else', () => {
    expect(
      browseMarketsQuery({
        page: 1,
        take: 20,
        search: 'election',
        sortBy: 'endingSoon',
      }),
    ).toEqual({
      page: 1,
      take: 20,
      search: 'election',
      sortBy: 'endingSoon',
      marketScope: 'onlyClob',
    });
    bad(() => browseMarketsQuery({ page: 1, bogus: true }));
  });
});

describe('activity queries', () => {
  test('market activity: take is capped at 50 (the usecase clamps), no marketScope', () => {
    expect(
      marketActivityQuery({
        page: 2,
        take: 50,
        sortBy: 'volumeInUSD',
        sortOrder: 'ASC',
        positionType: 'BUY',
        userId: 7,
        outcomeId: 3,
        outcomeIndex: 0,
      }),
    ).toEqual({
      page: 2,
      take: 50,
      sortBy: 'volumeInUSD',
      sortOrder: 'ASC',
      positionType: 'BUY',
      userId: 7,
      outcomeId: 3,
      outcomeIndex: 0,
    });
    bad(() => marketActivityQuery({ take: 51 }));
    bad(() => marketActivityQuery({ positionType: 'REDEEM' }));
    bad(() => marketActivityQuery({ marketScope: 'onlyClob' }));
  });

  test('userTradesOnly needs a signed-in user, which a public call never has', () => {
    const message = bad(() => marketActivityQuery({ userTradesOnly: true }));
    expect(message).toContain('userTradesOnly');
  });

  test('all activity: marketScope defaults to onlyClob; marketType and marketId pass', () => {
    expect(allActivityQuery(undefined)).toEqual({ marketScope: 'onlyClob' });
    expect(
      allActivityQuery({ marketType: 4, marketId: 12, positionType: 'all' }),
    ).toEqual({
      marketType: '4',
      marketId: 12,
      positionType: 'all',
      marketScope: 'onlyClob',
    });
    expect(allActivityQuery({ marketScope: 'onlyConviction' })).toEqual({
      marketScope: 'onlyConviction',
    });
    bad(() => allActivityQuery({ take: 100 }));
    bad(() => allActivityQuery({ userId: 1 }));
  });
});

describe('events and series queries', () => {
  const SERIES = '0d9f3a5e-2b3c-4d4e-8f50-6a7b8c9d0e1f';

  test('listEventsQuery sends the DTO names; take goes up to 1000', () => {
    expect(
      listEventsQuery({
        page: 1,
        take: 1000,
        search: 'world cup',
        sortBy: 'endingSoon',
        sortOrder: 'DESC',
        seriesId: SERIES,
        rootsOnly: false,
        categoryId: 2,
        withMarkets: true,
        hasSubEvents: false,
        statuses: ['ACTIVE'],
        excludedStatuses: ['CANCELLED'],
        marketType: [2, 4],
        metadataKey: 'kickoffAt',
        metadataAfter: '2026-11-01T00:00:00Z',
        metadataBefore: new Date('2026-12-01T00:00:00Z'),
      }),
    ).toEqual({
      page: 1,
      take: 1000,
      search: 'world cup',
      sortBy: 'endingSoon',
      sortOrder: 'DESC',
      seriesId: SERIES,
      rootsOnly: false,
      categoryId: 2,
      withMarkets: true,
      hasSubEvents: false,
      statuses: 'ACTIVE',
      excludedStatuses: 'CANCELLED',
      marketType: '2,4',
      metadataKey: 'kickoffAt',
      metadataAfter: '2026-11-01T00:00:00.000Z',
      metadataBefore: '2026-12-01T00:00:00.000Z',
    });
    bad(() => listEventsQuery({ take: 1001 }));
    bad(() => listEventsQuery({ seriesId: 'not-a-uuid' }));
    bad(() => listEventsQuery({ metadataKey: 'a-b' }));
    bad(() => listEventsQuery({ sortBy: 'totalVolumeInUSDs' }));
    bad(() => listEventsQuery({ marketScope: 'onlyClob' }));
  });

  test('events have no marketScope: nothing is defaulted', () => {
    expect(listEventsQuery(undefined)).toEqual({});
  });

  test('scopedMarketsQuery', () => {
    expect(
      scopedMarketsQuery(
        {
          page: 2,
          take: 25,
          search: 'x',
          sortBy: 'rootEventSortOrder',
          sortOrder: 'ASC',
          includeSubEvents: false,
          statuses: ['ACTIVE', 'EXPIRED'],
          excludedStatuses: ['VOIDED'],
        },
        'events.markets',
      ),
    ).toEqual({
      page: 2,
      take: 25,
      search: 'x',
      sortBy: 'rootEventSortOrder',
      sortOrder: 'ASC',
      includeSubEvents: false,
      statuses: 'ACTIVE,EXPIRED',
      excludedStatuses: 'VOIDED',
    });
    bad(() => scopedMarketsQuery({ sortBy: 'priorityScore' }, 'x'));
    bad(() => scopedMarketsQuery({ marketScope: 'onlyClob' }, 'x'));
  });

  test('listSeriesQuery: only `active` is honoured by the route', () => {
    expect(listSeriesQuery(undefined)).toEqual({});
    expect(listSeriesQuery({ active: false })).toEqual({ active: false });
    bad(() => listSeriesQuery({ page: 1 }));
  });
});

describe('pulse queries', () => {
  test('pulseListQuery', () => {
    expect(
      pulseListQuery({
        page: 2,
        limit: 100,
        status: 'ACTIVE',
        marketConfigId: 3,
        adapterConfigId: 4,
        sortBy: 'expiresAt',
        sortOrder: 'ASC',
      }),
    ).toEqual({
      page: 2,
      limit: 100,
      status: 'ACTIVE',
      marketConfigId: 3,
      adapterConfigId: 4,
      sortBy: 'expiresAt',
      sortOrder: 'ASC',
    });
    bad(() => pulseListQuery({ limit: 101 }));
    bad(() => pulseListQuery({ limit: 0 }));
    bad(() => pulseListQuery({ take: 10 }));
    bad(() => pulseListQuery({ sortBy: 'startsAt' }));
  });

  test('pulseStatsQuery: marketScope is onlyPulse | onlyClobPulse and defaults to onlyClobPulse', () => {
    // The backend maps anything but onlyClobPulse to onlyPulse (legacy AMM pulse), the
    // opposite of the onlyClob intent, so the SDK asks for the CLOB pulse markets.
    expect(pulseStatsQuery(undefined)).toEqual({
      marketScope: 'onlyClobPulse',
    });
    expect(pulseStatsQuery({ marketId: '0xabc' })).toEqual({
      marketId: '0xabc',
      marketScope: 'onlyClobPulse',
    });
    expect(pulseStatsQuery({ marketScope: 'onlyPulse' })).toEqual({
      marketScope: 'onlyPulse',
    });
    expect(
      pulseStatsQuery({ marketId: '0xabc', marketScope: 'onlyClobPulse' }),
    ).toEqual({ marketId: '0xabc', marketScope: 'onlyClobPulse' });
    bad(() => pulseStatsQuery({ marketScope: 'onlyClob' }));
  });
});

describe('taxonomy queries', () => {
  test('categories: overview mode with the default onlyClob scope', () => {
    expect(categoriesQuery(undefined)).toEqual({ marketScope: 'onlyClob' });
    expect(
      categoriesQuery({
        sortBy: 'marketsCount',
        sort: 'asc',
        marketType: 4,
        status: 'active',
        countScope: 'browse',
      }),
    ).toEqual({
      sortBy: 'marketsCount',
      sort: 'asc',
      marketType: '4',
      marketScope: 'onlyClob',
      status: 'active',
      countScope: 'browse',
    });
    expect(categoriesQuery({ marketScope: 'default' })).toEqual({
      marketScope: 'default',
    });
    bad(() => categoriesQuery({ sortBy: 'name' }));
    bad(() => categoriesQuery({ sort: 'ASC' }));
    bad(() => categoriesQuery({ page: 1 }));
  });

  test('subcategories: overview by default', () => {
    expect(subcategoriesQuery(undefined)).toEqual({
      paginated: false,
      query: { marketScope: 'onlyClob' },
    });
    expect(
      subcategoriesQuery({
        categoryId: 3,
        sortBy: 'marketsCount',
        sort: 'desc',
      }),
    ).toEqual({
      paginated: false,
      query: {
        categoryId: 3,
        sortBy: 'marketsCount',
        sort: 'desc',
        marketScope: 'onlyClob',
      },
    });
  });

  test('subcategories: page/take/search select the paginated list and no scope is defaulted', () => {
    expect(
      subcategoriesQuery({ page: 2, take: 20, search: 'foot', categoryId: 1 }),
    ).toEqual({
      paginated: true,
      query: { page: 2, take: 20, search: 'foot', categoryId: 1 },
    });
    expect(subcategoriesQuery({ take: 5, status: 'active' })).toEqual({
      paginated: true,
      query: { take: 5, status: 'active' },
    });
  });

  test('subcategories: paginated and overview params cannot be mixed', () => {
    bad(() => subcategoriesQuery({ page: 1, sortBy: 'marketsCount' }));
    bad(() => subcategoriesQuery({ take: 5, marketScope: 'onlyClob' }));
    bad(() => subcategoriesQuery({ search: 'x', countScope: 'all' }));
  });

  test("subcategories: take is 1..1000 (the backend's list filter) and sortOrder is not accepted", () => {
    bad(() => subcategoriesQuery({ take: 1001 }));
    bad(() => subcategoriesQuery({ sortOrder: 'ASC' }));
  });
});

describe('path segments', () => {
  test('marketIdSegment: positive whole numbers, as numbers or digit strings', () => {
    expect(marketIdSegment(42)).toBe('42');
    expect(marketIdSegment('42')).toBe('42');
    for (const value of [
      0,
      -1,
      1.5,
      '0',
      '1/2',
      '1e3',
      '',
      ' 4',
      null,
      2 ** 53,
    ]) {
      bad(() => marketIdSegment(value));
    }
  });

  test('uuidSegment: a UUID, any case', () => {
    const id = '0d9f3a5e-2b3c-4d4e-8f50-6a7b8c9d0e1f';
    expect(uuidSegment(id, 'eventId')).toBe(id);
    expect(uuidSegment(id.toUpperCase(), 'eventId')).toBe(id.toUpperCase());
    for (const value of ['', 'abc', `${id}/x`, `${id}?a=1`, 5, null]) {
      bad(() => uuidSegment(value, 'eventId'));
    }
  });

  test('slugSegment: encoded; empty, dot-only and over-long slugs are refused', () => {
    expect(slugSegment('will-btc-hit-100k')).toBe('will-btc-hit-100k');
    expect(slugSegment('a b/c?d#e')).toBe('a%20b%2Fc%3Fd%23e');
    for (const value of ['', '.', '..', 'x'.repeat(301), 5, null, 'a\nb']) {
      bad(() => slugSegment(value));
    }
  });

  test('marketKeySegment: a 20-byte address or a 32-byte condition id', () => {
    const address = `0x${'ab'.repeat(20)}`;
    const condition = `0x${'cd'.repeat(32)}`;
    expect(marketKeySegment(address, 'key')).toBe(address);
    expect(marketKeySegment(condition, 'key')).toBe(condition);
    for (const value of [
      '0x12',
      `0x${'g'.repeat(40)}`,
      'ab'.repeat(20),
      '',
      5,
    ]) {
      bad(() => marketKeySegment(value, 'key'));
    }
  });

  test('pulseKeySegment: the same two shapes', () => {
    const address = `0x${'ab'.repeat(20)}`;
    expect(pulseKeySegment(address)).toBe(address);
    bad(() => pulseKeySegment('0x12'));
  });
});
