import { describe, expect, test, vi } from 'vitest';
import {
  cursorPages,
  itemsPages,
  metaPages,
  offsetPages,
  singlePage,
} from '../../src/data/pages';

// One test per backend list shape. The core paginators are tested in test/core/paginate.test.ts;
// these check the adapters: the signal each shape uses, the start page, and the raw page.

describe('metaPages ({ data, meta.hasNextPage })', () => {
  const answer = (page: number) => ({
    data: [page * 10, page * 10 + 1],
    meta: { page, hasNextPage: page < 3 },
  });

  test('follows meta.hasNextPage and keeps the raw answer of every page', async () => {
    const fetch = vi.fn(async (page: number) => answer(page));
    const paginator = metaPages(1, fetch);
    const pages = [];
    for await (const page of paginator.pages()) pages.push(page);
    expect(pages.map((page) => page.items)).toEqual([
      [10, 11],
      [20, 21],
      [30, 31],
    ]);
    expect(pages.map((page) => page.hasNext)).toEqual([true, true, false]);
    expect(pages[1]?.raw).toEqual(answer(2));
    expect(fetch.mock.calls.map(([page]) => page)).toEqual([1, 2, 3]);
  });

  test('starts at the given page and stops reading on break', async () => {
    const fetch = vi.fn(async (page: number) => answer(page));
    for await (const _ of metaPages(2, fetch)) break;
    expect(fetch.mock.calls.map(([page]) => page)).toEqual([2]);
  });

  test('is lazy', () => {
    const fetch = vi.fn(async (page: number) => answer(page));
    metaPages(1, fetch);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('the page ceiling', () => {
  const always = (page: number) => ({
    data: [page],
    meta: { hasNextPage: true },
  });

  test('metaPages stops at the DTO ceiling (10000) instead of asking for page 10001', async () => {
    const fetch = vi.fn(async (page: number) => always(page));
    const pages = [];
    for await (const page of metaPages(9_998, fetch).pages()) {
      pages.push(page);
      if (pages.length >= 20) break; // a runaway traversal fails the assertions below
    }
    expect(fetch.mock.calls.map(([page]) => page)).toEqual([
      9_998, 9_999, 10_000,
    ]);
    expect(pages.map((page) => page.hasNext)).toEqual([true, true, false]);
    expect(pages.at(-1)?.raw).toEqual(always(10_000));
  });

  test('a traversal that starts at the ceiling reads that one page', async () => {
    const fetch = vi.fn(async (page: number) => always(page));
    expect(await metaPages(10_000, fetch).toArray(50)).toEqual([10_000]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('the ceiling is an option: another route can have another one', async () => {
    const fetch = vi.fn(async (page: number) => always(page));
    expect(await metaPages(1, fetch, { ceiling: 3 }).toArray(50)).toEqual([
      1, 2, 3,
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test('itemsPages has the same ceiling', async () => {
    const fetch = vi.fn(async (page: number) => ({
      items: [page],
      hasNext: true,
    }));
    expect(await itemsPages(9_999, fetch).toArray(50)).toEqual([9_999, 10_000]);
    expect(fetch.mock.calls.map(([page]) => page)).toEqual([9_999, 10_000]);
  });
});

describe('itemsPages ({ items, hasNext })', () => {
  const answer = (page: number) => ({
    items: ['a', 'b'].map((letter) => `${letter}${page}`),
    total: 6,
    hasNext: page < 3,
  });

  test('follows the shape’s own hasNext', async () => {
    const fetch = vi.fn(async (page: number) => answer(page));
    expect(await itemsPages(1, fetch).toArray()).toEqual([
      'a1',
      'b1',
      'a2',
      'b2',
      'a3',
      'b3',
    ]);
    expect(fetch.mock.calls.map(([page]) => page)).toEqual([1, 2, 3]);
    const first = await itemsPages(1, fetch).firstPage();
    expect(first.raw).toEqual(answer(1));
  });

  test('an empty page ends the traversal even if hasNext lies', async () => {
    const fetch = vi.fn(async (page: number) => ({
      items: page === 1 ? ['x'] : [],
      hasNext: true,
    }));
    expect(await itemsPages(1, fetch).toArray()).toEqual(['x']);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('cursorPages ({ data, nextCursor })', () => {
  const chunks: Record<string, { data: number[]; nextCursor: string | null }> =
    {
      start: { data: [1, 2], nextCursor: 'c2' },
      c2: { data: [3, 4], nextCursor: 'c3' },
      c3: { data: [5], nextCursor: null },
    };

  test('follows nextCursor until it is null', async () => {
    const fetch = vi.fn(async (cursor: string | undefined) => {
      const chunk = chunks[cursor ?? 'start'];
      if (chunk === undefined) throw new Error('unknown cursor');
      return chunk;
    });
    const paginator = cursorPages(fetch);
    expect(await paginator.toArray()).toEqual([1, 2, 3, 4, 5]);
    expect(fetch.mock.calls.map(([cursor]) => cursor)).toEqual([
      undefined,
      'c2',
      'c3',
    ]);
    const pages = [];
    for await (const page of paginator.pages()) pages.push(page);
    expect(pages[2]?.raw).toEqual(chunks.c3);
    expect(pages[2]?.hasNext).toBe(false);
  });

  test('a missing nextCursor and the end cursors stop the traversal', async () => {
    const missing = vi.fn(async () => ({ data: [1] }));
    expect(await cursorPages(missing).toArray()).toEqual([1]);
    expect(missing).toHaveBeenCalledTimes(1);
    const ended = vi.fn(async () => ({ data: [1], nextCursor: 'END' }));
    expect(await cursorPages(ended).toArray()).toEqual([1]);
  });

  test('a cursor that repeats cannot loop forever, and the repeated page is not returned twice', async () => {
    const stuck = vi.fn(async () => ({ data: [1], nextCursor: 'same' }));
    expect(await cursorPages(stuck).toArray()).toEqual([1]);
    expect(stuck).toHaveBeenCalledTimes(2);
  });
});

describe('cursorPages with the list under another key ({ orders, nextCursor })', () => {
  const chunks: Record<
    string,
    { userId: string; orders: number[]; nextCursor: string | null }
  > = {
    start: { userId: 'w', orders: [1, 2], nextCursor: 'c2' },
    c2: { userId: 'w', orders: [3], nextCursor: null },
  };

  test('takes the items from the extractor and keeps the whole answer as the raw page', async () => {
    const fetch = vi.fn(async (cursor: string | undefined) => {
      const chunk = chunks[cursor ?? 'start'];
      if (chunk === undefined) throw new Error('unknown cursor');
      return chunk;
    });
    const paginator = cursorPages(fetch, (raw) => raw.orders);
    expect(await paginator.toArray()).toEqual([1, 2, 3]);
    expect(fetch.mock.calls.map(([cursor]) => cursor)).toEqual([
      undefined,
      'c2',
    ]);
    const first = await paginator.firstPage();
    expect(first.raw).toEqual(chunks.start);
    expect(first.hasNext).toBe(true);
  });
});

describe('singlePage (a bare array or a one-shot { data })', () => {
  test('a raw array is one page', async () => {
    const fetch = vi.fn(async () => [1, 2, 3]);
    const paginator = singlePage(fetch, (raw) => raw);
    const page = await paginator.firstPage();
    expect(page.items).toEqual([1, 2, 3]);
    expect(page.hasNext).toBe(false);
    expect(page.raw).toEqual([1, 2, 3]);
    expect(await paginator.toArray()).toEqual([1, 2, 3]);
  });

  test('{ data: [...] } is one page and the envelope is the raw page', async () => {
    const fetch = vi.fn(async () => ({ data: ['a'] }));
    const page = await singlePage(fetch, (raw) => raw.data).firstPage();
    expect(page.items).toEqual(['a']);
    expect(page.raw).toEqual({ data: ['a'] });
  });

  test('an empty list is an empty page', async () => {
    expect(
      await singlePage(
        async () => [],
        (raw) => raw,
      ).toArray(),
    ).toEqual([]);
  });
});

describe('offsetPages ({ <list>, page, page_size, total }, 0-based)', () => {
  // 5 rows, 2 per page: pages 0, 1 and 2.
  const answer = (page: number, pageSize = 2, total = 5) => ({
    page,
    page_size: pageSize,
    total,
    rows: Array.from({ length: total }, (_, n) => n).slice(
      page * pageSize,
      (page + 1) * pageSize,
    ),
  });

  test('starts at the given page (0 for these routes) and ends when page_size × (page + 1) reaches total', async () => {
    const fetch = vi.fn(async (page: number) => answer(page));
    const pages = [];
    for await (const page of offsetPages(0, fetch, (raw) => raw.rows).pages()) {
      pages.push(page);
    }
    expect(pages.map((page) => page.items)).toEqual([[0, 1], [2, 3], [4]]);
    expect(pages.map((page) => page.hasNext)).toEqual([true, true, false]);
    expect(fetch.mock.calls.map(([page]) => page)).toEqual([0, 1, 2]);
    expect(pages[1]?.raw).toEqual(answer(1));
  });

  test('a traversal can start on a later page, and an exact multiple of the page size ends on the last full page', async () => {
    const fetch = vi.fn(async (page: number) => answer(page, 2, 4));
    expect(await offsetPages(1, fetch, (raw) => raw.rows).toArray()).toEqual([
      2, 3,
    ]);
    expect(fetch.mock.calls.map(([page]) => page)).toEqual([1]);
  });

  test('an empty page ends the traversal even if total says there is more', async () => {
    const fetch = vi.fn(async (page: number) => ({
      page,
      page_size: 2,
      total: 99,
      rows: page === 0 ? [1] : [],
    }));
    expect(await offsetPages(0, fetch, (raw) => raw.rows).toArray()).toEqual([
      1,
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('a page_size of 0 cannot loop: the traversal ends', async () => {
    const fetch = vi.fn(async (page: number) => ({
      page,
      page_size: 0,
      total: 5,
      rows: [page],
    }));
    expect(await offsetPages(0, fetch, (raw) => raw.rows).toArray()).toEqual([
      0,
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('stops at the page ceiling (page 1,000,000) instead of asking for a page the backend refuses', async () => {
    const fetch = vi.fn(async (page: number) => ({
      page,
      page_size: 1,
      total: 5_000_000,
      rows: [page],
    }));
    const items = await offsetPages(
      999_998,
      fetch,
      (raw) => raw.rows,
    ).toArray();
    expect(items).toEqual([999_998, 999_999, 1_000_000]);
    expect(fetch.mock.calls.map(([page]) => page)).toEqual([
      999_998, 999_999, 1_000_000,
    ]);
    const custom = vi.fn(async (page: number) => ({
      page,
      page_size: 1,
      total: 99,
      rows: [page],
    }));
    expect(
      await offsetPages(0, custom, (raw) => raw.rows, { ceiling: 2 }).toArray(),
    ).toEqual([0, 1, 2]);
  });

  test('is lazy', () => {
    const fetch = vi.fn(async (page: number) => answer(page));
    offsetPages(0, fetch, (raw) => raw.rows);
    expect(fetch).not.toHaveBeenCalled();
  });
});
