import { describe, expect, test, vi } from 'vitest';
import { UserInputError } from '../../src/core/errors';
import {
  cursorPaginator,
  nextPosition,
  type Page,
  pagePaginator,
} from '../../src/core/paginate';

interface CursorResult {
  data: number[];
  next_cursor: string;
  raw: unknown;
}

/**
 * A cursor fetcher that serves `pages` in order, keyed by the cursor it handed out.
 * It throws once it has been called more than `maxFetches` times, so a missing stop
 * guard fails the test quickly instead of hanging it.
 */
function cursorServer(
  pages: Array<{ data: number[]; next: string }>,
  maxFetches = 5,
) {
  // The first page has cursor `undefined`; page i (i >= 1) is fetched with `c<i>`.
  let calls = 0;
  const fetch = vi.fn(
    async (cursor: string | undefined): Promise<CursorResult> => {
      calls += 1;
      if (calls > maxFetches) {
        throw new Error('fetched too many times');
      }
      const index = cursor === undefined ? 0 : Number(cursor.slice(1));
      const page = pages[index];
      if (page === undefined) {
        throw new Error(`unexpected fetch with cursor ${String(cursor)}`);
      }
      return {
        data: page.data,
        next_cursor: page.next,
        raw: { index, next: page.next },
      };
    },
  );
  return fetch;
}

interface PageResult {
  items: number[];
  hasNext: boolean;
  raw: unknown;
}

/** A page fetcher that serves `pages` for page numbers `firstPage`, `firstPage + 1`, ... */
function pageServer(
  pages: Array<{ items: number[]; hasNext: boolean }>,
  firstPage = 1,
) {
  return vi.fn(async (page: number): Promise<PageResult> => {
    const served = pages[page - firstPage];
    if (served === undefined) {
      throw new Error(`unexpected fetch of page ${page}`);
    }
    return { ...served, raw: { page } };
  });
}

async function drain<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) {
    out.push(item);
  }
  return out;
}

describe('cursorPaginator', () => {
  const threePages = (maxFetches?: number) =>
    cursorServer(
      [
        { data: [1, 2], next: 'c1' },
        { data: [3, 4], next: 'c2' },
        { data: [5], next: 'LTE=' },
      ],
      maxFetches,
    );

  test('does not fetch until it is used', () => {
    const fetch = threePages();
    cursorPaginator(fetch);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('fetches from an undefined cursor, then follows next_cursor', async () => {
    const fetch = threePages();
    const items = await drain(cursorPaginator(fetch));
    expect(items).toEqual([1, 2, 3, 4, 5]);
    expect(fetch.mock.calls.map(([cursor]) => cursor)).toEqual([
      undefined,
      'c1',
      'c2',
    ]);
  });

  test.each([['LTE='], ['END'], ['']])(
    'stops after the page whose next_cursor is %j',
    async (end) => {
      const fetch = cursorServer([
        { data: [1], next: 'c1' },
        { data: [2], next: end },
      ]);
      const items = await drain(cursorPaginator(fetch));
      expect(items).toEqual([1, 2]);
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  test('stops when next_cursor equals the cursor it just fetched', async () => {
    const fetch = cursorServer([
      { data: [1], next: 'c1' },
      { data: [2], next: 'c1' },
    ]);
    const items = await drain(cursorPaginator(fetch));
    expect(items).toEqual([1, 2]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('stops when next_cursor goes back to any cursor it already fetched (A → B → A)', async () => {
    const fetch = cursorServer([
      { data: [1], next: 'c1' },
      { data: [2], next: 'c2' },
      { data: [3], next: 'c1' },
    ]);
    const pages = await drain(cursorPaginator(fetch).pages());
    expect(pages.map((page) => page.items)).toEqual([[1], [2], [3]]);
    expect(pages.map((page) => page.hasNext)).toEqual([true, true, false]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test('a server that ignores the cursor: the repeated page is not yielded again', async () => {
    const fetch = vi.fn(
      async (): Promise<CursorResult> => ({
        data: [1, 2],
        next_cursor: 'c1',
        raw: null,
      }),
    );
    expect(await cursorPaginator(fetch).toArray()).toEqual([1, 2]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('empty pages in a row are not taken for a repeat', async () => {
    const fetch = cursorServer([
      { data: [], next: 'c1' },
      { data: [], next: 'c2' },
      { data: [5], next: 'END' },
    ]);
    expect(await cursorPaginator(fetch).toArray()).toEqual([5]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test('what one traversal saw does not stop the next one', async () => {
    const fetch = cursorServer(
      [
        { data: [1], next: 'c1' },
        { data: [2], next: 'c2' },
        { data: [3], next: 'c1' },
      ],
      6,
    );
    const paginator = cursorPaginator(fetch);
    expect(await paginator.toArray()).toEqual([1, 2, 3]);
    expect(await paginator.toArray()).toEqual([1, 2, 3]);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 7],
  ])(
    'stops when next_cursor is %s instead of a string',
    async (_label, bad) => {
      // Without the guard, an `undefined` cursor would refetch the first page forever.
      const fetch = cursorServer([
        { data: [1], next: 'c1' },
        { data: [2], next: bad as unknown as string },
      ]);
      const items = await drain(cursorPaginator(fetch));
      expect(items).toEqual([1, 2]);
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  test('pages() yields each page with items, raw and hasNext', async () => {
    const fetch = threePages();
    const pages = await drain(cursorPaginator(fetch).pages());
    expect(pages).toEqual([
      { items: [1, 2], raw: { index: 0, next: 'c1' }, hasNext: true },
      { items: [3, 4], raw: { index: 1, next: 'c2' }, hasNext: true },
      { items: [5], raw: { index: 2, next: 'LTE=' }, hasNext: false },
    ] satisfies Page<number>[]);
  });

  test('firstPage() fetches exactly one page', async () => {
    const fetch = threePages();
    const page = await cursorPaginator(fetch).firstPage();
    expect(page).toEqual({
      items: [1, 2],
      raw: { index: 0, next: 'c1' },
      hasNext: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(undefined);
  });

  test.each([['LTE='], ['END'], ['']])(
    'firstPage().hasNext is false for next_cursor %j',
    async (end) => {
      const fetch = cursorServer([{ data: [1], next: end }]);
      const page = await cursorPaginator(fetch).firstPage();
      expect(page.hasNext).toBe(false);
    },
  );

  test('toArray() collects everything', async () => {
    const fetch = threePages();
    expect(await cursorPaginator(fetch).toArray()).toEqual([1, 2, 3, 4, 5]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test('toArray(3) stops as soon as it has 3 items and fetches no further page', async () => {
    const fetch = threePages();
    expect(await cursorPaginator(fetch).toArray(3)).toEqual([1, 2, 3]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('toArray(max) does not fetch the next page when max lands on a page boundary', async () => {
    const fetch = threePages();
    expect(await cursorPaginator(fetch).toArray(2)).toEqual([1, 2]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('toArray(max) larger than the data returns all of it', async () => {
    const fetch = threePages();
    expect(await cursorPaginator(fetch).toArray(100)).toEqual([1, 2, 3, 4, 5]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test('toArray(0) returns [] without fetching', async () => {
    const fetch = threePages();
    expect(await cursorPaginator(fetch).toArray(0)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([[-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'toArray(%s) rejects with UserInputError and fetches nothing',
    async (max) => {
      const fetch = threePages();
      await expect(cursorPaginator(fetch).toArray(max)).rejects.toBeInstanceOf(
        UserInputError,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  test('breaking out of for await early does not fetch another page', async () => {
    const fetch = threePages();
    for await (const item of cursorPaginator(fetch)) {
      expect(item).toBe(1);
      break;
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('breaking after the last item of a page does not fetch the next page', async () => {
    const fetch = threePages();
    for await (const item of cursorPaginator(fetch)) {
      if (item === 2) {
        break;
      }
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('breaking out of pages() early does not fetch another page', async () => {
    const fetch = threePages();
    for await (const page of cursorPaginator(fetch).pages()) {
      expect(page.items).toEqual([1, 2]);
      break;
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('is re-iterable: every traversal restarts from the first page', async () => {
    // Five traversals in a row make more than the default 5 fetches.
    const fetch = threePages(20);
    const paginator = cursorPaginator(fetch);

    expect(await drain(paginator)).toEqual([1, 2, 3, 4, 5]);
    expect(await drain(paginator)).toEqual([1, 2, 3, 4, 5]);
    expect((await drain(paginator.pages())).length).toBe(3);
    expect(await paginator.toArray(1)).toEqual([1]);
    expect((await paginator.firstPage()).items).toEqual([1, 2]);

    const firstCursors = fetch.mock.calls
      .map(([cursor]) => cursor)
      .filter((cursor) => cursor === undefined);
    // 2 full iterations, pages(), toArray(1) and firstPage() each began at the start.
    expect(firstCursors).toHaveLength(5);
  });

  test('two iterators over the same paginator do not share state', async () => {
    const paginator = cursorPaginator(threePages());
    const a = paginator[Symbol.asyncIterator]();
    const b = paginator[Symbol.asyncIterator]();
    expect((await a.next()).value).toBe(1);
    expect((await a.next()).value).toBe(2);
    expect((await b.next()).value).toBe(1);
    expect((await a.next()).value).toBe(3);
  });

  test('an error thrown by fetch propagates unchanged', async () => {
    const boom = new Error('boom');
    const fetch = vi.fn(async (cursor: string | undefined) => {
      if (cursor === undefined) {
        return { data: [1], next_cursor: 'c1', raw: null };
      }
      throw boom;
    });
    const paginator = cursorPaginator(fetch);
    await expect(drain(paginator)).rejects.toBe(boom);
    await expect(paginator.toArray()).rejects.toBe(boom);
    await expect(drain(paginator.pages())).rejects.toBe(boom);

    const failing = cursorPaginator(async () => {
      throw boom;
    });
    await expect(failing.firstPage()).rejects.toBe(boom);
  });
});

describe('pagePaginator', () => {
  const threePages = () =>
    pageServer([
      { items: [1, 2], hasNext: true },
      { items: [3, 4], hasNext: true },
      { items: [5], hasNext: false },
    ]);

  test('does not fetch until it is used', () => {
    const fetch = threePages();
    pagePaginator(fetch);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('starts at page 1 by default and follows hasNext', async () => {
    const fetch = threePages();
    const items = await drain(pagePaginator(fetch));
    expect(items).toEqual([1, 2, 3, 4, 5]);
    expect(fetch.mock.calls.map(([page]) => page)).toEqual([1, 2, 3]);
  });

  test('starts at the given first page', async () => {
    const fetch = pageServer(
      [
        { items: [1], hasNext: true },
        { items: [2], hasNext: false },
      ],
      0,
    );
    const items = await drain(pagePaginator(fetch, 0));
    expect(items).toEqual([1, 2]);
    expect(fetch.mock.calls.map(([page]) => page)).toEqual([0, 1]);
  });

  test('stops on hasNext false even if more pages exist', async () => {
    const fetch = pageServer([
      { items: [1], hasNext: false },
      { items: [2], hasNext: false },
    ]);
    expect(await drain(pagePaginator(fetch))).toEqual([1]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('stops on a page with zero items even when hasNext is true', async () => {
    const fetch = pageServer([
      { items: [1], hasNext: true },
      { items: [], hasNext: true },
      { items: [99], hasNext: true },
    ]);
    const pages = await drain(pagePaginator(fetch).pages());
    expect(pages.map((page) => page.items)).toEqual([[1], []]);
    expect(pages.map((page) => page.hasNext)).toEqual([true, false]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('a server that ignores the page number: stops at the first repeat, without yielding it', async () => {
    let calls = 0;
    const fetch = vi.fn(async (_page: number): Promise<PageResult> => {
      calls += 1;
      if (calls > 5) {
        throw new Error('fetched too many times');
      }
      return { items: [1, 2], hasNext: true, raw: null };
    });
    expect(await pagePaginator(fetch).toArray()).toEqual([1, 2]);
    expect(fetch.mock.calls.map(([page]) => page)).toEqual([1, 2]);
  });

  test('pages that only look alike are all kept', async () => {
    const fetch = pageServer([
      { items: [1, 2], hasNext: true },
      { items: [1, 3], hasNext: true },
      { items: [1, 2, 3], hasNext: false },
    ]);
    expect(await pagePaginator(fetch).toArray()).toEqual([1, 2, 1, 3, 1, 2, 3]);
  });

  test('items holding bigints are compared too', async () => {
    const fetch = vi.fn(async (page: number) => ({
      items: [{ id: 1n }],
      hasNext: page < 5,
      raw: null,
    }));
    expect(await pagePaginator(fetch).toArray()).toEqual([{ id: 1n }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('pages() yields each page with items, raw and hasNext', async () => {
    const fetch = threePages();
    const pages = await drain(pagePaginator(fetch).pages());
    expect(pages).toEqual([
      { items: [1, 2], raw: { page: 1 }, hasNext: true },
      { items: [3, 4], raw: { page: 2 }, hasNext: true },
      { items: [5], raw: { page: 3 }, hasNext: false },
    ] satisfies Page<number>[]);
  });

  test('firstPage() fetches exactly one page', async () => {
    const fetch = threePages();
    const page = await pagePaginator(fetch).firstPage();
    expect(page).toEqual({ items: [1, 2], raw: { page: 1 }, hasNext: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(1);
  });

  test('firstPage() reports hasNext false for an empty first page', async () => {
    const fetch = pageServer([{ items: [], hasNext: true }]);
    const page = await pagePaginator(fetch).firstPage();
    expect(page.items).toEqual([]);
    expect(page.hasNext).toBe(false);
  });

  test('toArray() collects everything', async () => {
    const fetch = threePages();
    expect(await pagePaginator(fetch).toArray()).toEqual([1, 2, 3, 4, 5]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test('toArray(3) stops as soon as it has 3 items and fetches no further page', async () => {
    const fetch = threePages();
    expect(await pagePaginator(fetch).toArray(3)).toEqual([1, 2, 3]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('toArray(max) does not fetch the next page when max lands on a page boundary', async () => {
    const fetch = threePages();
    expect(await pagePaginator(fetch).toArray(4)).toEqual([1, 2, 3, 4]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('toArray(0) returns [] without fetching', async () => {
    const fetch = threePages();
    expect(await pagePaginator(fetch).toArray(0)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([[-1], [2.5], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'toArray(%s) rejects with UserInputError and fetches nothing',
    async (max) => {
      const fetch = threePages();
      await expect(pagePaginator(fetch).toArray(max)).rejects.toBeInstanceOf(
        UserInputError,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  test('breaking out of for await early does not fetch another page', async () => {
    const fetch = threePages();
    for await (const item of pagePaginator(fetch)) {
      if (item === 2) {
        break;
      }
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('is re-iterable: every traversal restarts from the first page', async () => {
    const fetch = threePages();
    const paginator = pagePaginator(fetch);

    expect(await drain(paginator)).toEqual([1, 2, 3, 4, 5]);
    expect(await drain(paginator)).toEqual([1, 2, 3, 4, 5]);
    expect(await paginator.toArray(1)).toEqual([1]);
    expect((await paginator.firstPage()).items).toEqual([1, 2]);

    const firstPageCalls = fetch.mock.calls.filter(([page]) => page === 1);
    expect(firstPageCalls).toHaveLength(4);
  });

  test('an error thrown by fetch propagates unchanged', async () => {
    const boom = new Error('boom');
    const fetch = vi.fn(async (page: number) => {
      if (page === 1) {
        return { items: [1], hasNext: true, raw: null };
      }
      throw boom;
    });
    const paginator = pagePaginator(fetch);
    await expect(drain(paginator)).rejects.toBe(boom);
    await expect(paginator.toArray()).rejects.toBe(boom);
    await expect(drain(paginator.pages())).rejects.toBe(boom);

    const failing = pagePaginator(async () => {
      throw boom;
    });
    await expect(failing.firstPage()).rejects.toBe(boom);
  });
});

describe('starting a paginator at a given position', () => {
  test('cursorPaginator(fetch, cursor) fetches that cursor first and follows next_cursor from there', async () => {
    const fetch = cursorServer([
      { data: [1, 2], next: 'c1' },
      { data: [3, 4], next: 'c2' },
      { data: [5], next: 'LTE=' },
    ]);
    const pages = await drain(cursorPaginator(fetch, 'c1').pages());
    expect(pages.map((page) => page.items)).toEqual([[3, 4], [5]]);
    expect(fetch.mock.calls.map(([cursor]) => cursor)).toEqual(['c1', 'c2']);
  });

  test('a paginator started at a cursor still stops when the cursors cycle', async () => {
    const fetch = cursorServer([
      { data: [1], next: 'c1' },
      { data: [2], next: 'c2' },
      { data: [3], next: 'c1' },
    ]);
    const pages = await drain(cursorPaginator(fetch, 'c1').pages());
    expect(pages.map((page) => page.items)).toEqual([[2], [3]]);
    expect(fetch.mock.calls.map(([cursor]) => cursor)).toEqual(['c1', 'c2']);
  });

  test('without a start cursor the first fetch has an undefined cursor, as before', async () => {
    const fetch = cursorServer([{ data: [1], next: 'LTE=' }]);
    await drain(cursorPaginator(fetch, undefined));
    expect(fetch.mock.calls.map(([cursor]) => cursor)).toEqual([undefined]);
  });
});

describe('nextPosition', () => {
  test('is the next cursor of a cursor-paginated page, from pages() and firstPage()', async () => {
    const fetch = cursorServer([
      { data: [1], next: 'c1' },
      { data: [2], next: 'LTE=' },
    ]);
    const paginator = cursorPaginator(fetch);
    const pages = await drain(paginator.pages());
    expect(pages.map(nextPosition)).toEqual(['c1', undefined]);
    expect(nextPosition(await paginator.firstPage())).toBe('c1');
  });

  test('is the next page number of a page-numbered page', async () => {
    const fetch = pageServer(
      [
        { items: [1], hasNext: true },
        { items: [2], hasNext: true },
        { items: [3], hasNext: false },
      ],
      4,
    );
    const paginator = pagePaginator(fetch, 4);
    const pages = await drain(paginator.pages());
    expect(pages.map(nextPosition)).toEqual([5, 6, undefined]);
    expect(nextPosition(await paginator.firstPage())).toBe(5);
  });

  test('is undefined for a page the paginator did not make', () => {
    expect(
      nextPosition({ items: [], raw: null, hasNext: true }),
    ).toBeUndefined();
  });

  test('leaves the page itself as it was', async () => {
    const fetch = pageServer([{ items: [1, 2], hasNext: true }]);
    const page = await pagePaginator(fetch).firstPage();
    expect(page).toEqual({ items: [1, 2], raw: { page: 1 }, hasNext: true });
    expect(Object.keys(page)).toEqual(['items', 'raw', 'hasNext']);
  });
});
