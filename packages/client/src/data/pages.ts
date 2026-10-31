// Internal: adapters from the backend's list shapes to the one `Paginator` interface.
//
// The backend mixes several shapes. Each adapter turns one of them into a `Paginator`
// (`core/paginate.ts`) and keeps the answer of every page, as the client parsed it, in
// `Page.raw`:
// - `{ data, meta: PageMeta }` with page/take:  {@link metaPages}
// - `{ items, hasNext, ... }` with page/limit:   {@link itemsPages}
// - `{ data, meta: { hasNextPage, ... } }` with page/limit (pulse): {@link metaPages} as well
// - `{ data, nextCursor }` or `{ orders, nextCursor }`: {@link cursorPages}
// - `{ <list>, page, page_size, total }` with 0-based page/page_size (liquidity rewards):
//   {@link offsetPages}
// - a bare array or a one-shot `{ data: [...] }`: {@link singlePage}
// The traversal rules (stop when the signal says so, or on an empty page) are the core
// paginator's. The page-addressed adapters also stop at the route's page ceiling.

import {
  cursorPaginator,
  type Paginator,
  pagePaginator,
} from '../core/paginate';
import type { CallOptions } from '../core/requestOptions';
import type { DualSchema } from '../core/schema';
import type { DataDeps } from './internal';
import { MAX_PAGE, MAX_REWARDS_PAGE, type Query } from './params';
import type { RouteKey } from './routes';

/** Options of the page-addressed adapters. */
export interface PageOptions {
  /**
   * The last page the route takes. The traversal ends there even if the answer says there is
   * more, instead of asking for a page the backend refuses (a 400). Defaults to
   * {@link MAX_PAGE}, the highest page the backend's list filters take. A list only
   * reaches that deep with a very broad filter; a narrower one reaches the rest.
   */
  ceiling?: number;
}

/**
 * `{ data: T[], meta: { hasNextPage } }`: `meta.hasNextPage` decides, up to the page
 * ceiling. `first` is the page the traversal starts at.
 */
export function metaPages<
  T,
  R extends { data: T[]; meta: { hasNextPage: boolean } },
>(
  first: number,
  fetch: (page: number) => Promise<R>,
  { ceiling = MAX_PAGE }: PageOptions = {},
): Paginator<T> {
  return pagePaginator<T>(async (page) => {
    const raw = await fetch(page);
    return {
      items: raw.data,
      hasNext: raw.meta.hasNextPage && page < ceiling,
      raw,
    };
  }, first);
}

/**
 * A `{ data, meta }` list route as a paginator: it requests `key` with the query and the
 * page number, starting at the query's own `page` (or 1). `params` fills the route's
 * `:name` segments; `call` applies to every page.
 */
export function paged<T>(
  deps: DataDeps,
  key: RouteKey,
  schema: DualSchema<{ data: T[]; meta: { hasNextPage: boolean } }>,
  query: Query,
  o: PageOptions & { params?: Record<string, string>; call?: CallOptions } = {},
): Paginator<T> {
  const first = typeof query.page === 'number' ? query.page : 1;
  return metaPages(
    first,
    (page) =>
      deps.get(key, schema, {
        query: { ...query, page },
        params: o.params,
        call: o.call,
      }),
    o,
  );
}

/** `{ items: T[], hasNext }`: the shape's own `hasNext` decides, up to the page ceiling. */
export function itemsPages<T, R extends { items: T[]; hasNext: boolean }>(
  first: number,
  fetch: (page: number) => Promise<R>,
  { ceiling = MAX_PAGE }: PageOptions = {},
): Paginator<T> {
  return pagePaginator<T>(async (page) => {
    const raw = await fetch(page);
    return { items: raw.items, hasNext: raw.hasNext && page < ceiling, raw };
  }, first);
}

/**
 * `{ <list>: T[], page, page_size, total }` with 0-based pages, as the liquidity-rewards
 * routes answer (the rewards service's paging, passed through by the backend): another page exists
 * when `page_size × (page + 1)` has not reached `total`, up to the route's page ceiling (a `page`
 * of at most 1,000,000). `items` picks the list out of the answer, which stays whole on
 * `Page.raw`. `first` is the page the traversal starts at, normally 0. An answer whose
 * `page_size` is not positive ends the traversal rather than loop.
 */
export function offsetPages<T, R extends { page_size: number; total: number }>(
  first: number,
  fetch: (page: number) => Promise<R>,
  items: (raw: R) => T[],
  { ceiling = MAX_REWARDS_PAGE }: PageOptions = {},
): Paginator<T> {
  return pagePaginator<T>(async (page) => {
    const raw = await fetch(page);
    return {
      items: items(raw),
      hasNext:
        raw.page_size > 0 &&
        raw.page_size * (page + 1) < raw.total &&
        page < ceiling,
      raw,
    };
  }, first);
}

/**
 * `{ data: T[], nextCursor }`, or the list under another key: the traversal ends when
 * `nextCursor` is `null`, missing or one of the core's end cursors, and when the cursor
 * repeats. `items` picks the list out of the parsed answer (`raw.data` by default), which
 * stays whole on `Page.raw`.
 */
export function cursorPages<
  T,
  R extends { data: T[]; nextCursor?: string | null },
>(fetch: (cursor: string | undefined) => Promise<R>): Paginator<T>;
export function cursorPages<T, R extends { nextCursor?: string | null }>(
  fetch: (cursor: string | undefined) => Promise<R>,
  items: (raw: R) => T[],
): Paginator<T>;
export function cursorPages<T, R extends { nextCursor?: string | null }>(
  fetch: (cursor: string | undefined) => Promise<R>,
  items: (raw: R) => T[] = (raw) => (raw as unknown as { data: T[] }).data,
): Paginator<T> {
  return cursorPaginator<T>(async (cursor) => {
    const raw = await fetch(cursor);
    return { data: items(raw), next_cursor: raw.nextCursor ?? '', raw };
  });
}

/**
 * A route that answers the whole list at once (a bare array, or `{ data: [...] }`): one
 * page, no next. `extract` picks the items out of the parsed answer.
 */
export function singlePage<T, R>(
  fetch: () => Promise<R>,
  extract: (raw: R) => T[],
): Paginator<T> {
  return pagePaginator<T>(async () => {
    const raw = await fetch();
    return { items: extract(raw), hasNext: false, raw };
  });
}
