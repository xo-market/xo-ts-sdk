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
import { dataRig, expectNoRequest, last } from '../helpers/dataRig';
import { SUBCATEGORY_COUNT } from '../helpers/mockBackendData';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

describe('taxonomy.categories', () => {
  test('GET /api/categories with the default marketScope: the overview, with marketsCount', async () => {
    const { client, backend } = dataRig(server, { session: true });
    const page = await client.taxonomy.categories().firstPage();
    expect(last(backend).path).toBe('/api/categories');
    expect(last(backend).query).toEqual({ marketScope: 'onlyClob' });
    expect(last(backend).authorization).toBeNull();
    expect(page.hasNext).toBe(false);
    expect(page.items.map((category) => category.name)).toEqual([
      'Sports',
      'Politics',
      'Finance',
    ]);
    expect(page.items[0]).toMatchObject({
      id: 1,
      isActive: true,
      marketsCount: 9,
    });
    expect(Array.isArray(page.raw)).toBe(true);
  });

  test('marketScope and the other overview params can be set', async () => {
    const { client, backend } = dataRig(server);
    await client.taxonomy
      .categories({
        sortBy: 'marketsCount',
        sort: 'asc',
        marketScope: 'onlyConviction',
        status: 'active',
        countScope: 'browse',
      })
      .toArray(200);
    expect(last(backend).query).toEqual({
      sortBy: 'marketsCount',
      sort: 'asc',
      marketScope: 'onlyConviction',
      status: 'active',
      countScope: 'browse',
    });
    await client.taxonomy.categories({ marketType: [4] }).toArray(200);
    expect(last(backend).query).toEqual({
      marketType: '4',
      marketScope: 'onlyClob',
    });
    expect(
      await client.taxonomy.categories({ status: 'inactive' }).toArray(200),
    ).toEqual([]);
  });

  test('unknown keys are ValidationErrors before any request', () => {
    const { client, backend } = dataRig(server);
    expect(() => client.taxonomy.categories({ page: 1 } as never)).toThrow(
      UserInputError,
    );
    expect(() => client.taxonomy.categories({ sort: 'ASC' } as never)).toThrow(
      UserInputError,
    );
    expectNoRequest(backend);
  });
});

describe('taxonomy.subcategories', () => {
  test('by default: the overview, a flat array with marketsCount and the default marketScope', async () => {
    const { client, backend } = dataRig(server);
    const page = await client.taxonomy.subcategories().firstPage();
    expect(last(backend).path).toBe('/api/subcategories');
    expect(last(backend).query).toEqual({ marketScope: 'onlyClob' });
    expect(page.hasNext).toBe(false);
    expect(page.items).toHaveLength(SUBCATEGORY_COUNT);
    // Sorted by marketsCount, descending.
    expect(page.items.map((row) => row.marketsCount)).toEqual([5, 4, 3, 2, 1]);
    expect(Array.isArray(page.raw)).toBe(true);
  });

  test('overview params: categoryId and sort', async () => {
    const { client, backend } = dataRig(server);
    const rows = await client.taxonomy
      .subcategories({ categoryId: 1, sortBy: 'marketsCount', sort: 'asc' })
      .toArray(200);
    expect(last(backend).query).toEqual({
      categoryId: '1',
      sortBy: 'marketsCount',
      sort: 'asc',
      marketScope: 'onlyClob',
    });
    expect(rows.map((row) => row.id)).toEqual([1, 2, 3]);
  });

  test('page/take select the paginated {items, ...} list and pagePaginator follows hasNext', async () => {
    const { client, backend } = dataRig(server);
    const pages: Array<{ raw: unknown; hasNext: boolean; count: number }> = [];
    for await (const page of client.taxonomy
      .subcategories({ take: 2 })
      .pages()) {
      pages.push({
        raw: page.raw,
        hasNext: page.hasNext,
        count: page.items.length,
      });
      if (pages.length >= 20) break; // a runaway traversal fails the assertions below
    }
    expect(pages.map((page) => page.count)).toEqual([2, 2, 1]);
    expect(pages.map((page) => page.hasNext)).toEqual([true, true, false]);
    // No marketScope in this mode: it would switch the route to the overview.
    expect(backend.requests.map((request) => request.query)).toEqual([
      { take: '2', page: '1' },
      { take: '2', page: '2' },
      { take: '2', page: '3' },
    ]);
    expect(pages[0]?.raw).toMatchObject({
      total: SUBCATEGORY_COUNT,
      page: 1,
      limit: 2,
      totalPages: 3,
      hasNext: true,
      hasPrev: false,
    });
    expect(
      await client.taxonomy.subcategories({ take: 2 }).toArray(200),
    ).toHaveLength(SUBCATEGORY_COUNT);
  });

  test('the paginated list starts at the given page and passes search and categoryId', async () => {
    const { client, backend } = dataRig(server);
    const rows = await client.taxonomy
      .subcategories({ page: 2, take: 2, search: 'sub', categoryId: 1 })
      .toArray(200);
    expect(backend.requests[0]?.query).toEqual({
      page: '2',
      take: '2',
      search: 'sub',
      categoryId: '1',
    });
    expect(rows.map((row) => row.id)).toEqual([3]);
  });

  test('paginated and overview params cannot be mixed; unknown keys are refused', () => {
    const { client, backend } = dataRig(server);
    expect(() =>
      client.taxonomy.subcategories({ take: 2, marketScope: 'onlyClob' }),
    ).toThrow(UserInputError);
    expect(() =>
      client.taxonomy.subcategories({ page: 1, sortBy: 'marketsCount' }),
    ).toThrow(UserInputError);
    expect(() =>
      client.taxonomy.subcategories({ sortOrder: 'ASC' } as never),
    ).toThrow(UserInputError);
    expect(() => client.taxonomy.subcategories({ nope: 1 } as never)).toThrow(
      UserInputError,
    );
    expectNoRequest(backend);
  });
});

describe('taxonomy.tokens', () => {
  test('GET /api/tokens: a bare array, one page', async () => {
    const { client, backend } = dataRig(server, {
      session: true,
      strict: true,
    });
    const page = await client.taxonomy.tokens().firstPage();
    expect(last(backend).path).toBe('/api/tokens');
    expect(last(backend).query).toEqual({});
    expect(last(backend).authorization).toBeNull();
    expect(page.hasNext).toBe(false);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      symbol: 'USDC',
      decimals: 6,
      isActive: true,
      priceTrackingEnabled: true,
    });
    // Token rows have been seen to carry no createdAt or updatedAt, and the logo can be empty.
    expect(page.items[0]?.createdAt).toBeUndefined();
    expect(page.items[0]?.logoUrl).toBe('');
  });
});
