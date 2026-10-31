import { UserInputError } from './errors';

/** One page of a list endpoint. */
export interface Page<T> {
  items: T[];
  /**
   * The answer this page came from, as the client returned it after checking it against its
   * schema: not the wire bytes. A response that failed the check never gets here; in lenient
   * mode unknown fields are kept, and a client that converts values while parsing (the data
   * client turns a money-like JSON number into a decimal string) shows the converted value.
   */
  raw: unknown;
  /** Whether another page can be fetched after this one. */
  hasNext: boolean;
}

/**
 * A lazy, re-iterable view over a paginated endpoint.
 *
 * Nothing is fetched until you use it. Every `for await`, `pages()`, `toArray()` and
 * `firstPage()` starts again from the first page, and stops fetching as soon as you stop
 * reading (a `break` never triggers another request).
 */
export interface Paginator<T> extends AsyncIterable<T> {
  /** Fetches only the first page. */
  firstPage(): Promise<Page<T>>;
  /** Iterates page by page. */
  pages(): AsyncIterable<Page<T>>;
  /**
   * Collects the items. With `max`, stops as soon as it has `max` items and fetches no
   * further page. `max` must be a non-negative integer.
   */
  toArray(max?: number): Promise<T[]>;
}

/** What one fetch produced: the page, and the key to fetch the page after it. */
interface Step<T, K> {
  page: Page<T>;
  next: K;
}

/**
 * Where the traversal goes after a page, for the pages that have one: a cursor, or a page
 * number. Kept beside the page instead of on it, so a page stays what it was.
 */
const nextPositions = new WeakMap<object, string | number>();

/**
 * Where the traversal goes after `page`: the cursor to fetch it with, or its page number.
 * `undefined` for the last page, and for a page that no paginator of this module made.
 */
export function nextPosition(page: Page<unknown>): string | number | undefined {
  return nextPositions.get(page);
}

/** The page of a step, with the position after it remembered when there is one. */
function pageOf<T, K>({ page, next }: Step<T, K>): Page<T> {
  if (page.hasNext && (typeof next === 'string' || typeof next === 'number')) {
    nextPositions.set(page, next);
  }
  return page;
}

/**
 * Builds a {@link Paginator} from a first key and `start`, which begins one traversal: it
 * returns the function that fetches the page for a key. Every traversal (each `for await`,
 * `pages()`, `toArray()` and `firstPage()`) calls `start` again, so what a step remembers
 * belongs to that traversal alone. The page's `hasNext` decides whether the traversal
 * continues with `next`; a step that answers `undefined` ends it without a page (the page it
 * fetched repeats the previous one).
 */
function createPaginator<T, K>(
  first: K,
  start: () => (key: K) => Promise<Step<T, K> | undefined>,
): Paginator<T> {
  async function* pages(): AsyncGenerator<Page<T>, void, undefined> {
    const step = start();
    let key = first;
    while (true) {
      const result = await step(key);
      if (result === undefined) {
        return;
      }
      yield pageOf(result);
      if (!result.page.hasNext) {
        return;
      }
      key = result.next;
    }
  }

  async function* items(): AsyncGenerator<T, void, undefined> {
    for await (const page of pages()) {
      for (const item of page.items) {
        yield item;
      }
    }
  }

  return {
    [Symbol.asyncIterator]: items,
    pages,
    async firstPage() {
      // The first page of a traversal never repeats a previous one.
      return pageOf((await start()(first)) as Step<T, K>);
    },
    async toArray(max) {
      if (max !== undefined && !(Number.isInteger(max) && max >= 0)) {
        throw new UserInputError(
          `toArray(max) needs a non-negative integer, got ${String(max)}`,
        );
      }
      const collected: T[] = [];
      if (max === 0) {
        return collected;
      }
      for await (const item of items()) {
        collected.push(item);
        if (collected.length === max) {
          break;
        }
      }
      return collected;
    },
  };
}

/** Cursors that mean "there is nothing after this page". */
const END_CURSORS: ReadonlySet<string> = new Set(['LTE=', 'END', '']);

/**
 * What a page holds, to notice a server that sends the same page again. An empty page has
 * none: two empty pages in a row are not a repeat. Bigints compare by value.
 */
function fingerprint(items: readonly unknown[]): string | undefined {
  if (items.length === 0) {
    return undefined;
  }
  try {
    return JSON.stringify(items, (_key, value: unknown) =>
      typeof value === 'bigint' ? `${value}n` : value,
    );
  } catch {
    return undefined;
  }
}

/**
 * Paginates an endpoint that returns `{ data, next_cursor }`. The first page is fetched
 * with an `undefined` cursor. The traversal ends when `next_cursor` is `'LTE='`, `'END'`
 * or `''`, when it goes back to any cursor this traversal already fetched, and before a
 * page with the same items as the one just read (that page is not yielded again). So a
 * server that ignores the cursor or sends cursors in a cycle cannot loop forever.
 *
 * Pass `first` to start the traversal at a cursor a page gave out (see {@link nextPosition}),
 * for instance to resume a walk.
 */
export function cursorPaginator<T>(
  fetch: (
    cursor: string | undefined,
  ) => Promise<{ data: T[]; next_cursor: string; raw: unknown }>,
  first?: string,
): Paginator<T> {
  return createPaginator<T, string | undefined>(first, () => {
    const fetched = new Set<string | undefined>();
    let previous: string | undefined;
    return async (cursor) => {
      const { data, next_cursor: next, raw } = await fetch(cursor);
      const print = fingerprint(data);
      if (print !== undefined && print === previous) {
        return undefined;
      }
      previous = print;
      fetched.add(cursor);
      // A missing cursor (not a string) must end the traversal: continuing would refetch
      // the first page, since the first cursor is `undefined`.
      const hasNext =
        typeof next === 'string' &&
        !END_CURSORS.has(next) &&
        !fetched.has(next);
      return { page: { items: data, raw, hasNext }, next };
    };
  });
}

/**
 * Paginates an endpoint that is addressed by page number. Backend pages are 1-based, so
 * `firstPage` defaults to 1. The traversal ends when `hasNext` is false, on a page with no
 * items, and before a page with the same items as the one just read (that page is not
 * yielded again). So a server that keeps saying `hasNext`, or ignores the page number,
 * cannot loop forever.
 */
export function pagePaginator<T>(
  fetch: (
    page: number,
  ) => Promise<{ items: T[]; hasNext: boolean; raw: unknown }>,
  firstPage = 1,
): Paginator<T> {
  return createPaginator<T, number>(firstPage, () => {
    let previous: string | undefined;
    return async (pageNumber) => {
      const { items, hasNext, raw } = await fetch(pageNumber);
      const print = fingerprint(items);
      if (print !== undefined && print === previous) {
        return undefined;
      }
      previous = print;
      return {
        page: { items, raw, hasNext: hasNext && items.length > 0 },
        next: pageNumber + 1,
      };
    };
  });
}
