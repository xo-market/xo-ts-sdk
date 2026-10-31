import { describe, expect, test, vi } from 'vitest';
import { PaginationLimitError, UserInputError } from '../../src/core/errors';
import { cursorPaginator, pagePaginator } from '../../src/core/paginate';
import { type Page, toPaginated } from '../../src/core/paginated';

interface Row {
  id: number;
}

const rows = (...ids: number[]): Row[] => ids.map((id) => ({ id }));

/**
 * A cursor source: the first page has no cursor, page i (i >= 1) is fetched with `c<i>`.
 * `open` is what a list action hands to `toPaginated`: it starts the paginator at the cursor.
 */
function cursorList(pages: Array<{ rows: Row[]; next: string }>) {
  const fetch = vi.fn(async (cursor: string | undefined) => {
    const index = cursor === undefined ? 0 : Number(cursor.slice(1));
    const served = pages[index];
    if (served === undefined) {
      throw new Error(`unexpected fetch with cursor ${String(cursor)}`);
    }
    return { data: served.rows, next_cursor: served.next, raw: { index } };
  });
  const open = vi.fn((cursor: string | undefined) =>
    cursorPaginator<Row>(fetch, cursor),
  );
  return { fetch, open };
}

/** A page-number source: the first page is page 1, as the backend counts. */
function pageList(
  pages: Array<{ rows: Row[]; hasNext: boolean }>,
  firstPage = 1,
) {
  const fetch = vi.fn(async (page: number) => {
    const served = pages[page - firstPage];
    if (served === undefined) {
      throw new Error(`unexpected fetch of page ${page}`);
    }
    return { items: served.rows, hasNext: served.hasNext, raw: { page } };
  });
  const open = vi.fn((cursor: string | undefined) =>
    pagePaginator<Row>(
      fetch,
      cursor === undefined ? firstPage : Number(cursor),
    ),
  );
  return { fetch, open };
}

const threeCursorPages = () =>
  cursorList([
    { rows: rows(1, 2), next: 'c1' },
    { rows: rows(3, 4), next: 'c2' },
    { rows: rows(5), next: 'LTE=' },
  ]);

const threePageNumbers = () =>
  pageList([
    { rows: rows(1, 2), hasNext: true },
    { rows: rows(3, 4), hasNext: true },
    { rows: rows(5), hasNext: false },
  ]);

const ids = (row: Row) => row.id;

async function drain<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) {
    out.push(item);
  }
  return out;
}

/** What the documented cursor format decodes to. */
function decode(cursor: string): unknown {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
}

/** A cursor in the documented format, as a caller could make one by hand. */
function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function failure(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

describe('toPaginated: iterating', () => {
  test('yields the pages in order and stops at hasMore: false (cursor source)', async () => {
    const { fetch, open } = threeCursorPages();
    const pages = await drain(toPaginated('markets', open, ids));
    expect(pages.map((page) => page.items)).toEqual([[1, 2], [3, 4], [5]]);
    expect(pages.map((page) => page.hasMore)).toEqual([true, true, false]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test('yields the pages in order and stops at hasMore: false (page-number source)', async () => {
    const { fetch, open } = threePageNumbers();
    const pages = await drain(toPaginated('markets', open, ids));
    expect(pages.map((page) => page.items)).toEqual([[1, 2], [3, 4], [5]]);
    expect(pages.map((page) => page.hasMore)).toEqual([true, true, false]);
    expect(fetch.mock.calls.map(([page]) => page)).toEqual([1, 2, 3]);
  });

  test('does not fetch anything until it is used', () => {
    const { fetch, open } = threeCursorPages();
    const paginated = toPaginated('markets', open, ids);
    paginated.from(undefined);
    expect(open).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('a page carries nextCursor while there is more, and not on the last page', async () => {
    const { open } = threeCursorPages();
    const pages = await drain(toPaginated('markets', open, ids));
    expect(typeof pages[0]?.nextCursor).toBe('string');
    expect(typeof pages[1]?.nextCursor).toBe('string');
    expect(pages[0]?.nextCursor).not.toBe(pages[1]?.nextCursor);
    expect(pages[2]).toEqual({ items: [5], hasMore: false });
    expect(Object.keys(pages[2] ?? {}).sort()).toEqual(['hasMore', 'items']);
  });

  test('a page of a listing that reports no cap or total has neither limitReached nor totalCount', async () => {
    const { open } = threePageNumbers();
    for (const page of await drain(toPaginated('markets', open, ids))) {
      expect(page).not.toHaveProperty('limitReached');
      expect(page).not.toHaveProperty('totalCount');
    }
  });

  test('breaking out early fetches no further page', async () => {
    const { fetch, open } = threeCursorPages();
    for await (const _page of toPaginated('markets', open, ids)) {
      break;
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('every iteration starts again from the first page', async () => {
    const { fetch, open } = threePageNumbers();
    const paginated = toPaginated('markets', open, ids);
    const first = await drain(paginated);
    const second = await drain(paginated);
    expect(second).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  test('an error thrown by the source propagates unchanged', async () => {
    const boom = new Error('boom');
    const open = () =>
      cursorPaginator<Row>(async () => {
        throw boom;
      });
    await expect(drain(toPaginated('markets', open, ids))).rejects.toBe(boom);
    await expect(toPaginated('markets', open, ids).firstPage()).rejects.toBe(
      boom,
    );
  });

  test('maps each row', async () => {
    const { open } = threeCursorPages();
    const pages = await drain(
      toPaginated('markets', open, (row) => `m${row.id}`),
    );
    expect(pages.map((page) => page.items)).toEqual([
      ['m1', 'm2'],
      ['m3', 'm4'],
      ['m5'],
    ]);
  });
});

describe('toPaginated: firstPage', () => {
  test('equals the first iterated page and fetches exactly one page', async () => {
    const { fetch, open } = threeCursorPages();
    const paginated = toPaginated('markets', open, ids);
    const first = await paginated.firstPage();
    expect(fetch).toHaveBeenCalledTimes(1);
    const iterated = await drain(paginated);
    expect(first).toEqual(iterated[0]);
    expect(first).toEqual({
      items: [1, 2],
      hasMore: true,
      nextCursor: iterated[0]?.nextCursor,
    });
  });

  test('is the only page of a list that ends at once', async () => {
    const { open } = pageList([{ rows: rows(7), hasNext: false }]);
    expect(await toPaginated('markets', open, ids).firstPage()).toEqual({
      items: [7],
      hasMore: false,
    });
  });
});

describe('toPaginated: opaque cursors', () => {
  test('a cursor source gives out base64url of { v: 1, list, kind: "cursor", value }', async () => {
    const { open } = threeCursorPages();
    const pages = await drain(toPaginated('markets', open, ids));
    expect(pages[0]?.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decode(pages[0]?.nextCursor ?? '')).toEqual({
      v: 1,
      list: 'markets',
      kind: 'cursor',
      value: 'c1',
    });
    expect(decode(pages[1]?.nextCursor ?? '')).toEqual({
      v: 1,
      list: 'markets',
      kind: 'cursor',
      value: 'c2',
    });
  });

  test('a page-number source gives out base64url of { v: 1, list, kind: "page", value }', async () => {
    const { open } = threePageNumbers();
    const pages = await drain(toPaginated('openOrders', open, ids));
    expect(decode(pages[0]?.nextCursor ?? '')).toEqual({
      v: 1,
      list: 'openOrders',
      kind: 'page',
      value: 2,
    });
    expect(decode(pages[1]?.nextCursor ?? '')).toEqual({
      v: 1,
      list: 'openOrders',
      kind: 'page',
      value: 3,
    });
  });

  test('a source that counts pages from 0 gives out the number of the page after the first', async () => {
    const { open } = pageList(
      [
        { rows: rows(1), hasNext: true },
        { rows: rows(2), hasNext: false },
      ],
      0,
    );
    const first = await toPaginated('rewards', open, ids).firstPage();
    expect(decode(first.nextCursor ?? '')).toEqual({
      v: 1,
      list: 'rewards',
      kind: 'page',
      value: 1,
    });
  });
});

describe('toPaginated: from', () => {
  test('from(page.nextCursor) resumes at the next page of a cursor source', async () => {
    const { fetch, open } = threeCursorPages();
    const paginated = toPaginated('markets', open, ids);
    const first = await paginated.firstPage();
    fetch.mockClear();
    open.mockClear();
    const rest = await drain(paginated.from(first.nextCursor));
    expect(rest.map((page) => page.items)).toEqual([[3, 4], [5]]);
    expect(rest.map((page) => page.hasMore)).toEqual([true, false]);
    expect(open).toHaveBeenCalledWith('c1');
    expect(fetch.mock.calls.map(([cursor]) => cursor)).toEqual(['c1', 'c2']);
  });

  test('from(page.nextCursor) resumes at the next page of a page-number source', async () => {
    const { fetch, open } = threePageNumbers();
    const paginated = toPaginated('markets', open, ids);
    const first = await paginated.firstPage();
    fetch.mockClear();
    open.mockClear();
    const rest = await drain(paginated.from(first.nextCursor));
    expect(rest.map((page) => page.items)).toEqual([[3, 4], [5]]);
    expect(open).toHaveBeenCalledWith('2');
    expect(fetch.mock.calls.map(([page]) => page)).toEqual([2, 3]);
  });

  test('a resumed page-number list gives out the cursor after the page it resumed at', async () => {
    const { open } = threePageNumbers();
    const paginated = toPaginated('markets', open, ids);
    const first = await paginated.firstPage();
    const second = await paginated.from(first.nextCursor).firstPage();
    expect(decode(second.nextCursor ?? '')).toMatchObject({
      kind: 'page',
      value: 3,
    });
    const third = await paginated.from(second.nextCursor).firstPage();
    expect(third).toEqual({ items: [5], hasMore: false });
  });

  test('walking cursor by cursor reads every page once', async () => {
    const { open } = threeCursorPages();
    const paginated = toPaginated('markets', open, ids);
    const seen: number[][] = [];
    let cursor: string | undefined;
    do {
      const page = await paginated.from(cursor).firstPage();
      seen.push(page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(seen).toEqual([[1, 2], [3, 4], [5]]);
  });

  test('from() with no cursor, and from(undefined), start at the beginning', async () => {
    const { open } = threeCursorPages();
    const paginated = toPaginated('markets', open, ids);
    const fromStart = await drain(paginated.from());
    expect(fromStart.map((page) => page.items)).toEqual([[1, 2], [3, 4], [5]]);
    expect(open).toHaveBeenLastCalledWith(undefined);
    expect((await paginated.from(undefined).firstPage()).items).toEqual([1, 2]);
  });

  test('from returns another Paginated and leaves the first one where it was', async () => {
    const { open } = threeCursorPages();
    const paginated = toPaginated('markets', open, ids);
    const first = await paginated.firstPage();
    const resumed = paginated.from(first.nextCursor);
    expect(resumed).not.toBe(paginated);
    expect((await paginated.firstPage()).items).toEqual([1, 2]);
    expect((await resumed.firstPage()).items).toEqual([3, 4]);
  });

  test('a resumed Paginated is itself resumable and re-iterable', async () => {
    const { open } = threeCursorPages();
    const paginated = toPaginated('markets', open, ids);
    const first = await paginated.firstPage();
    const resumed = paginated.from(first.nextCursor);
    const again = await drain(resumed);
    expect(await drain(resumed)).toEqual(again);
    const second = await resumed.firstPage();
    expect((await resumed.from(second.nextCursor).firstPage()).items).toEqual([
      5,
    ]);
  });

  test('from(cursor) on a resumed Paginated replaces its start, it does not add to it', async () => {
    const { open } = threeCursorPages();
    const paginated = toPaginated('markets', open, ids);
    const first = await paginated.firstPage();
    const second = await paginated.from(first.nextCursor).firstPage();
    const again = await paginated
      .from(second.nextCursor)
      .from(first.nextCursor)
      .firstPage();
    expect(again.items).toEqual([3, 4]);
  });
});

describe('toPaginated: cursors it refuses', () => {
  function refusal(run: () => unknown): UserInputError {
    const error = failure(run);
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).code).toBe('invalid_cursor');
    return error as UserInputError;
  }

  test('a cursor from one list passed to another list is invalid_cursor, and nothing is fetched', async () => {
    const orders = threePageNumbers();
    const markets = threeCursorPages();
    const first = await toPaginated('openOrders', orders.open, ids).firstPage();
    const error = refusal(() =>
      toPaginated('markets', markets.open, ids).from(first.nextCursor),
    );
    expect(error.message).not.toContain(first.nextCursor ?? '');
    expect(markets.open).not.toHaveBeenCalled();
    expect(markets.fetch).not.toHaveBeenCalled();
  });

  test('a cursor of the same kind from another list is refused too', async () => {
    const a = threePageNumbers();
    const b = threePageNumbers();
    const first = await toPaginated('listA', a.open, ids).firstPage();
    refusal(() => toPaginated('listB', b.open, ids).from(first.nextCursor));
  });

  test.each([
    ['text that is not base64url', 'not a cursor!'],
    ['an empty string', ''],
    [
      'base64url of text that is not JSON',
      Buffer.from('hello').toString('base64url'),
    ],
    [
      'a valid cursor with padding added',
      `${encode({ v: 1, list: 'markets', kind: 'cursor', value: 'c1' })}=`,
    ],
    [
      'a valid cursor cut short',
      encode({ v: 1, list: 'markets', kind: 'cursor', value: 'c1' }).slice(
        0,
        -4,
      ),
    ],
    ['JSON null', encode(null)],
    ['a JSON array', encode([1, 'markets', 'cursor', 'c1'])],
    ['a JSON string', encode('markets')],
    [
      'an object without v',
      encode({ list: 'markets', kind: 'cursor', value: 'c1' }),
    ],
    [
      'another version',
      encode({ v: 2, list: 'markets', kind: 'cursor', value: 'c1' }),
    ],
    [
      'a string version',
      encode({ v: '1', list: 'markets', kind: 'cursor', value: 'c1' }),
    ],
    ['a missing list', encode({ v: 1, kind: 'cursor', value: 'c1' })],
    [
      'another list',
      encode({ v: 1, list: 'orders', kind: 'cursor', value: 'c1' }),
    ],
    ['a missing kind', encode({ v: 1, list: 'markets', value: 'c1' })],
    [
      'an unknown kind',
      encode({ v: 1, list: 'markets', kind: 'offset', value: 'c1' }),
    ],
    ['a missing value', encode({ v: 1, list: 'markets', kind: 'cursor' })],
    [
      'an empty cursor value',
      encode({ v: 1, list: 'markets', kind: 'cursor', value: '' }),
    ],
    [
      'a numeric cursor value',
      encode({ v: 1, list: 'markets', kind: 'cursor', value: 3 }),
    ],
    [
      'a string page value',
      encode({ v: 1, list: 'markets', kind: 'page', value: '3' }),
    ],
    [
      'a fractional page value',
      encode({ v: 1, list: 'markets', kind: 'page', value: 2.5 }),
    ],
    [
      'a negative page value',
      encode({ v: 1, list: 'markets', kind: 'page', value: -1 }),
    ],
    [
      'an unsafe page value',
      encode({ v: 1, list: 'markets', kind: 'page', value: 2 ** 60 }),
    ],
  ])(
    '%s is invalid_cursor and the message never echoes it',
    (_name, cursor) => {
      const { open, fetch } = threeCursorPages();
      const error = refusal(() =>
        toPaginated('markets', open, ids).from(cursor),
      );
      if (cursor !== '') {
        expect(error.message).not.toContain(cursor);
      }
      expect(open).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['a number', 3],
    ['null', null],
    ['an object', { v: 1 }],
  ])('%s is invalid_cursor', (_name, cursor) => {
    const { open } = threeCursorPages();
    refusal(() =>
      toPaginated('markets', open, ids).from(cursor as unknown as string),
    );
  });

  test('a cursor that is valid base64url JSON of the right shape is accepted, even one made by hand', async () => {
    const { fetch, open } = threeCursorPages();
    const cursor = encode({
      v: 1,
      list: 'markets',
      kind: 'cursor',
      value: 'c2',
    });
    const pages = await drain(toPaginated('markets', open, ids).from(cursor));
    expect(pages.map((page) => page.items)).toEqual([[5]]);
    expect(fetch.mock.calls.map(([c]) => c)).toEqual(['c2']);
  });

  test('a page cursor of value 0 is accepted', async () => {
    const { open } = pageList(
      [
        { rows: rows(1), hasNext: true },
        { rows: rows(2), hasNext: false },
      ],
      0,
    );
    const cursor = encode({ v: 1, list: 'markets', kind: 'page', value: 0 });
    const pages = await drain(toPaginated('markets', open, ids).from(cursor));
    expect(pages.map((page) => page.items)).toEqual([[1], [2]]);
  });
});

describe('toPaginated: rows that map to undefined', () => {
  test('are dropped, so a page can hold fewer items than the source page', async () => {
    const { open } = cursorList([
      { rows: rows(1, 2, 3), next: 'c1' },
      { rows: rows(4, 5, 6), next: 'LTE=' },
    ]);
    const pages = await drain(
      toPaginated('markets', open, (row) =>
        row.id % 2 === 0 ? row.id : undefined,
      ),
    );
    expect(pages.map((page) => page.items)).toEqual([[2], [4, 6]]);
    expect(pages.map((page) => page.hasMore)).toEqual([true, false]);
  });

  test('falsy results other than undefined are kept', async () => {
    const { open } = cursorList([{ rows: rows(0, 1), next: 'LTE=' }]);
    const page = await toPaginated('markets', open, (row) =>
      row.id === 0 ? 0 : row.id === 1 ? '' : undefined,
    ).firstPage();
    expect(page.items).toEqual([0, '']);
  });

  test('a page whose rows are all dropped is still a page: hasMore and nextCursor stay', async () => {
    const { open } = cursorList([
      { rows: rows(1, 3), next: 'c1' },
      { rows: rows(4), next: 'LTE=' },
    ]);
    const paginated = toPaginated('markets', open, (row) =>
      row.id % 2 === 0 ? row.id : undefined,
    );
    const first = await paginated.firstPage();
    expect(first.items).toEqual([]);
    expect(first.hasMore).toBe(true);
    expect(typeof first.nextCursor).toBe('string');
    expect((await paginated.from(first.nextCursor).firstPage()).items).toEqual([
      4,
    ]);
  });
});

describe('toPaginated: a source that repeats itself', () => {
  test('a cursor cycle ends the walk without an error', async () => {
    const { fetch, open } = cursorList([
      { rows: rows(1), next: 'c1' },
      { rows: rows(2), next: 'c2' },
      { rows: rows(3), next: 'c1' },
    ]);
    const pages = await drain(toPaginated('markets', open, ids));
    expect(pages.map((page) => page.items)).toEqual([[1], [2], [3]]);
    expect(pages.map((page) => page.hasMore)).toEqual([true, true, false]);
    expect(pages[2]?.nextCursor).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test('a repeated page ends the walk without an error and is not yielded again', async () => {
    const fetch = vi.fn(async (page: number) => ({
      items: rows(1, 2),
      hasNext: true,
      raw: { page },
    }));
    const open = (cursor: string | undefined) =>
      pagePaginator<Row>(fetch, cursor === undefined ? 1 : Number(cursor));
    const pages = await drain(toPaginated('markets', open, ids));
    expect(pages.map((page) => page.items)).toEqual([[1, 2]]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('toPaginated: a documented depth cap (maxPage)', () => {
  // The source never stops by itself here: it says `hasNext` on every page. It throws far out,
  // so a missing stop fails the test instead of hanging it.
  function endless() {
    const fetch = vi.fn(async (page: number) => {
      if (page > 20) {
        throw new Error(`fetched page ${page}`);
      }
      return {
        items: rows(page * 10, page * 10 + 1),
        hasNext: true,
        raw: { page },
      };
    });
    const open = (cursor: string | undefined) =>
      pagePaginator<Row>(fetch, cursor === undefined ? 1 : Number(cursor));
    return { fetch, open };
  }

  test('the last page before the cap says limitReached: true, has no more and no nextCursor', async () => {
    const { fetch, open } = endless();
    const pages = await drain(
      toPaginated('markets', open, ids, { maxPage: 3 }),
    );
    expect(pages).toEqual([
      { items: [10, 11], hasMore: true, nextCursor: pages[0]?.nextCursor },
      { items: [20, 21], hasMore: true, nextCursor: pages[1]?.nextCursor },
      { items: [30, 31], hasMore: false, limitReached: true },
    ] satisfies Page<number>[]);
    expect(fetch.mock.calls.map(([page]) => page)).toEqual([1, 2, 3]);
  });

  test('no page beyond the cap is fetched, however the pages are read', async () => {
    const { fetch, open } = endless();
    const paginated = toPaginated('markets', open, ids, { maxPage: 1 });
    expect(await paginated.firstPage()).toEqual({
      items: [10, 11],
      hasMore: false,
      limitReached: true,
    });
    await drain(paginated);
    expect(fetch.mock.calls.map(([page]) => page)).toEqual([1, 1]);
  });

  test('a list that ends exactly at the cap is complete: limitReached stays absent', async () => {
    const { open } = pageList([
      { rows: rows(1), hasNext: true },
      { rows: rows(2), hasNext: false },
    ]);
    const pages = await drain(
      toPaginated('markets', open, ids, { maxPage: 2 }),
    );
    expect(pages[1]).toEqual({ items: [2], hasMore: false });
  });

  test('a list that ends before the cap is untouched by it', async () => {
    const { open } = threePageNumbers();
    const capped = await drain(
      toPaginated('markets', open, ids, { maxPage: 50 }),
    );
    const plain = await drain(toPaginated('markets', open, ids));
    expect(capped).toEqual(plain);
  });

  test('from() with a cursor past the cap throws PaginationLimitError and fetches nothing', () => {
    const { fetch, open } = endless();
    const paginated = toPaginated('markets', open, ids, { maxPage: 3 });
    const error = failure(() =>
      paginated.from(encode({ v: 1, list: 'markets', kind: 'page', value: 4 })),
    );
    expect(error).toBeInstanceOf(PaginationLimitError);
    expect((error as PaginationLimitError).code).toBe('pagination_limit');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('from() with a cursor at the cap is fine', async () => {
    const { open } = endless();
    const paginated = toPaginated('markets', open, ids, { maxPage: 3 });
    const page = await paginated
      .from(encode({ v: 1, list: 'markets', kind: 'page', value: 3 }))
      .firstPage();
    expect(page).toEqual({
      items: [30, 31],
      hasMore: false,
      limitReached: true,
    });
  });

  test('a cursor-keyed source is not paged by number: maxPage does not apply to it', async () => {
    const { open } = threeCursorPages();
    const pages = await drain(
      toPaginated('markets', open, ids, { maxPage: 1 }),
    );
    expect(pages.map((page) => page.items)).toEqual([[1, 2], [3, 4], [5]]);
    for (const page of pages) {
      expect(page).not.toHaveProperty('limitReached');
    }
  });
});
