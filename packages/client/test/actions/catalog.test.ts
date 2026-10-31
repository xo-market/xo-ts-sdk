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
  fetchCollateralTokens,
  fetchPulseStats,
  listCategories,
  listPulseMarkets,
  listSubcategories,
} from '../../src/actions/catalog';
import { PaginationLimitError, UserInputError } from '../../src/core/errors';
import { actionRig } from '../helpers/actionRig';
import { caught } from '../helpers/dataRig';
import {
  conditionIdOf,
  PULSE_COUNT,
  SUBCATEGORY_COUNT,
} from '../helpers/mockBackendData';

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

describe('listCategories', () => {
  test('lists the categories with the number of CLOB markets in each, on one page', async () => {
    const r = actionRig(server);
    const page = await listCategories(r.ctx).firstPage();
    expect(backendCalls(r)).toEqual(['GET /api/categories']);
    expect(r.backend.requests[0]?.query).toEqual({ marketScope: 'onlyClob' });
    expect(page.hasMore).toBe(false);
    expect(page.items.map((c) => [c.id, c.name, c.marketCount])).toEqual([
      ['1', 'Sports', 9],
      ['2', 'Politics', 8],
      ['3', 'Finance', 7],
    ]);
  });

  test('the options reach the request, and a bad option or cursor is refused', async () => {
    const r = actionRig(server);
    const spy = vi.spyOn(r.transport, 'request');
    await listCategories(r.ctx, { retries: 0, timeout: 88 }).firstPage();
    expect(spy.mock.calls[0]?.[0].call).toEqual({ timeoutMs: 88, retries: 0 });
    expect(refusal(() => listCategories(r.ctx, { retries: 9 })).code).toBe(
      'invalid_request_options',
    );
    const error = await caught(() =>
      listCategories(r.ctx)
        .from(cursorOf('categories', 'page', 2))
        .firstPage(),
    );
    expect((error as UserInputError).code).toBe('invalid_cursor');
  });
});

describe('listSubcategories', () => {
  test('lists every subcategory with its count of CLOB markets, on one page', async () => {
    const r = actionRig(server);
    const page = await listSubcategories(r.ctx).firstPage();
    expect(backendCalls(r)).toEqual(['GET /api/subcategories']);
    expect(r.backend.requests[0]?.query).toEqual({ marketScope: 'onlyClob' });
    expect(page.items).toHaveLength(SUBCATEGORY_COUNT);
    expect(page.items[0]).toMatchObject({
      categoryId: expect.any(String),
      marketCount: expect.any(Number),
      parentId: null,
      children: [],
    });
  });

  test('categoryId keeps the subcategories of one category', async () => {
    const r = actionRig(server);
    const page = await listSubcategories(r.ctx, {
      categoryId: '1',
    }).firstPage();
    expect(r.backend.requests[0]?.query).toEqual({
      marketScope: 'onlyClob',
      categoryId: '1',
    });
    expect(page.items).toHaveLength(3);
    expect(page.items.every((s) => s.categoryId === '1')).toBe(true);
  });

  test.each([
    ['an unknown key', { search: 'foot' }],
    ['a categoryId that is a number', { categoryId: 1 }],
    ['a categoryId that is not digits', { categoryId: 'sports' }],
  ])('%s is invalid_input', (_name, request) => {
    const r = actionRig(server);
    const error = refusal(() => listSubcategories(r.ctx, request as never));
    expect(error.code).toBe('invalid_input');
    expect(error.message).toMatch(/^listSubcategories: /);
    expect(r.backend.requests).toEqual([]);
  });

  test('the options reach the request', async () => {
    const r = actionRig(server);
    const spy = vi.spyOn(r.transport, 'request');
    await listSubcategories(r.ctx, {}, { retries: 0, timeout: 66 }).firstPage();
    expect(spy.mock.calls[0]?.[0].call).toEqual({ timeoutMs: 66, retries: 0 });
  });
});

describe('fetchCollateralTokens', () => {
  test('returns the collateral tokens as a plain array', async () => {
    const r = actionRig(server);
    const tokens = await fetchCollateralTokens(r.ctx);
    expect(backendCalls(r)).toEqual(['GET /api/tokens']);
    expect(Array.isArray(tokens)).toBe(true);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      id: '1',
      symbol: 'USDC',
      decimals: 6,
      active: true,
      image: null,
    });
  });

  test('the options reach the request, and a bad option rejects', async () => {
    const r = actionRig(server);
    const spy = vi.spyOn(r.transport, 'request');
    await fetchCollateralTokens(r.ctx, { retries: 0, timeout: 44 });
    expect(spy.mock.calls[0]?.[0].call).toEqual({ timeoutMs: 44, retries: 0 });
    const error = await caught(() =>
      fetchCollateralTokens(r.ctx, { timeout: 0 }),
    );
    expect((error as UserInputError).code).toBe('invalid_request_options');
  });
});

describe('listPulseMarkets', () => {
  test('lists the CLOB pulse rounds and leaves out the older pricing-curve ones', async () => {
    const r = actionRig(server);
    const page = await listPulseMarkets(r.ctx).firstPage();
    expect(backendCalls(r)).toEqual(['GET /api/pulse/markets']);
    // The fake has five rounds: ids 1 and 2 have no condition id.
    expect(PULSE_COUNT).toBe(5);
    expect(page.items.map((round) => round.id)).toEqual(['3', '4', '5']);
    expect(page.items[0]).toMatchObject({
      conditionId: conditionIdOf(3),
      name: 'BTC 5 min',
      status: 'active',
      cycle: 12,
      openingPrice: '81918.80912067',
      metadata: { symbol: 'BTC' },
    });
  });

  test('a page whose rounds are all left out is empty and still has more', async () => {
    const r = actionRig(server);
    const first = await listPulseMarkets(r.ctx, { pageSize: 2 }).firstPage();
    expect(first.items).toEqual([]);
    expect(first.hasMore).toBe(true);
    const all = [];
    for await (const page of listPulseMarkets(r.ctx, { pageSize: 2 })) {
      all.push(...page.items.map((round) => round.id));
    }
    expect(all).toEqual(['3', '4', '5']);
  });

  test('from(nextCursor) resumes, and the status and page size are the filters', async () => {
    const r = actionRig(server);
    const first = await listPulseMarkets(r.ctx, {
      pageSize: 2,
      status: 'active',
    }).firstPage();
    expect(r.backend.requests[0]?.query).toMatchObject({
      limit: '2',
      status: 'ACTIVE',
    });
    const second = await listPulseMarkets(r.ctx, {
      pageSize: 2,
      status: 'active',
    })
      .from(first.nextCursor)
      .firstPage();
    expect(r.backend.requests.at(-1)?.query.page).toBe('2');
    expect(second.items.map((round) => round.id)).toEqual(['3', '4']);
  });

  test('a cursor that is not a page number is invalid_cursor', async () => {
    const r = actionRig(server);
    const error = await caught(() =>
      listPulseMarkets(r.ctx)
        .from(cursorOf('pulseMarkets', 'cursor', 'x'))
        .firstPage(),
    );
    expect((error as UserInputError).code).toBe('invalid_cursor');
    expect(r.backend.requests).toEqual([]);
  });

  test('a cursor beyond the deepest page is a PaginationLimitError, before any request', () => {
    const r = actionRig(server);
    expect(() =>
      listPulseMarkets(r.ctx).from(cursorOf('pulseMarkets', 'page', 1_000_001)),
    ).toThrow(PaginationLimitError);
    expect(() =>
      listPulseMarkets(r.ctx).from(cursorOf('pulseMarkets', 'page', 1_000_000)),
    ).not.toThrow();
    expect(r.backend.requests).toEqual([]);
  });

  test.each([
    ['an unknown key', { marketConfigId: 3 }],
    ['a status that is not one', { status: 'live' }],
    ['a pageSize of 0', { pageSize: 0 }],
    ['a pageSize of 101', { pageSize: 101 }],
  ])('%s is invalid_input', (_name, request) => {
    const r = actionRig(server);
    const error = refusal(() => listPulseMarkets(r.ctx, request as never));
    expect(error.code).toBe('invalid_input');
    expect(error.message).toMatch(/^listPulseMarkets: /);
    expect(r.backend.requests).toEqual([]);
  });

  test('the options reach every page request', async () => {
    const r = actionRig(server);
    const spy = vi.spyOn(r.transport, 'request');
    for await (const _page of listPulseMarkets(
      r.ctx,
      { pageSize: 2 },
      { retries: 0, timeout: 33 },
    )) {
      // read them all
    }
    expect(spy).toHaveBeenCalledTimes(3);
    for (const [request] of spy.mock.calls) {
      expect(request.call).toEqual({ timeoutMs: 33, retries: 0 });
    }
  });
});

describe('fetchPulseStats', () => {
  test('returns the totals of the CLOB pulse markets', async () => {
    const r = actionRig(server);
    const stats = await fetchPulseStats(r.ctx);
    expect(backendCalls(r)).toEqual(['GET /api/markets/pulse/stats']);
    expect(r.backend.requests[0]?.query).toEqual({
      marketScope: 'onlyClobPulse',
    });
    expect(stats).toEqual({
      volume: '1234567.89',
      tradeCount: 847,
      traderCount: 12481,
      marketCount: 42,
      positionsValue: '234567.89',
      initialCollateral: '50000.00',
    });
  });

  test('the options reach the request', async () => {
    const r = actionRig(server);
    const spy = vi.spyOn(r.transport, 'request');
    await fetchPulseStats(r.ctx, { retries: 0, timeout: 22 });
    expect(spy.mock.calls[0]?.[0].call).toEqual({ timeoutMs: 22, retries: 0 });
  });
});
