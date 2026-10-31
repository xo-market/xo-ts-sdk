import { PaginationLimitError, UserInputError } from './errors';
import {
  nextPosition,
  type Paginator,
  type Page as SourcePage,
} from './paginate';

/**
 * One page of a list.
 *
 * @example
 * const page = await client.listMarkets({ pageSize: 20 }).firstPage();
 * console.log(page.items.length, page.hasMore);
 */
export type Page<T> = {
  /** The rows of this page. */
  items: T[];
  /** Whether another page can be read after this one. */
  hasMore: boolean;
  /**
   * `true` on the last page a listing can reach, when more rows exist beyond its depth cap.
   * `hasMore` is `false` then. Narrow the listing with filters to reach the rest. Absent when
   * the listing ended by itself.
   */
  limitReached?: boolean;
  /**
   * Where the next page starts, for `from`. Opaque: keep it as given. Only while `hasMore` is
   * `true`.
   */
  nextCursor?: string;
  /** How many rows the whole listing holds, when the service says. */
  totalCount?: number;
};

/**
 * A lazy list of pages. Nothing is requested until you read it: `for await` walks the pages in
 * order, stops after the page with `hasMore: false`, and fetches nothing more when you `break`.
 * Every walk starts again from the first page (or from the cursor given to `from`).
 *
 * @example
 * const markets = client.listMarkets({ pageSize: 20 });
 * for await (const page of markets) {
 *   console.log(page.items.length);
 * }
 * const first = await markets.firstPage();
 * const second = await markets.from(first.nextCursor).firstPage();
 */
export type Paginated<T> = AsyncIterable<Page<T>> & {
  /**
   * Reads only the first page.
   *
   * @throws {RequestRejectedError | RateLimitError | TransportError | TimeoutError | RequestAbortedError | UnexpectedResponseError}
   *   when the request fails or is cancelled, or the answer does not match its schema.
   */
  firstPage(): Promise<Page<T>>;
  /**
   * The same list, starting at the page a cursor points to: pass the `nextCursor` of a page of
   * this list, exactly as given, to carry on from there, even in another process. With no
   * cursor it starts at the first page. Nothing is requested until the result is read.
   *
   * @throws {UserInputError} `invalid_cursor` when the cursor is not one this list gave out: it
   *   belongs to another list, comes from another SDK version, or was cut short or changed.
   * @throws {PaginationLimitError} when the cursor lies beyond the deepest page the listing
   *   can reach.
   */
  from(cursor?: string): Paginated<T>;
};

/** Options of {@link toPaginated} for lists with a documented depth. */
export type PaginatedOptions = {
  /**
   * The highest page number the listing takes, for a source that is addressed by page number.
   * The page before it stops at `maxPage` with `limitReached: true` instead of asking for a
   * page the service would refuse, and `from` refuses a cursor beyond it with a
   * `PaginationLimitError`. The source must not stop at that page by itself; if it does, the
   * end is not reported as a cap. Cursor-addressed sources have no page numbers, and ignore it.
   */
  maxPage?: number;
};

/** Where a list resumes: a cursor of the service, or a page number. */
type Position =
  | { kind: 'cursor'; value: string }
  | { kind: 'page'; value: number };

/** The format version of the cursors; a cursor of another version is refused. */
const CURSOR_VERSION = 1;

function toBase64Url(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function fromBase64Url(text: string): string | undefined {
  // `=` is not in the alphabet: a cursor is given back as it was given out.
  if (text === '' || !/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) {
    return undefined;
  }
  try {
    const standard = text.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(standard + '='.repeat((4 - (standard.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** The opaque cursor of a list at `position`. */
function encodeCursor(list: string, position: Position): string {
  return toBase64Url(
    JSON.stringify({
      v: CURSOR_VERSION,
      list,
      kind: position.kind,
      value: position.value,
    }),
  );
}

function invalidCursor(list: string, why: string): UserInputError {
  // Never the cursor itself: it is caller input that may end up in logs.
  return new UserInputError(
    `from() needs the nextCursor of a page of the "${list}" list, exactly as it was given: this cursor ${why}`,
    { code: 'invalid_cursor' },
  );
}

/**
 * The position inside a cursor of `list`. Anything else is a `UserInputError` with the code
 * `invalid_cursor`, and its message does not contain the cursor.
 */
function decodeCursor(list: string, cursor: unknown): Position {
  const text = typeof cursor === 'string' ? fromBase64Url(cursor) : undefined;
  let parsed: unknown;
  try {
    parsed = text === undefined ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidCursor(list, 'is not a cursor');
  }
  const fields = parsed as Record<string, unknown>;
  if (fields.v !== CURSOR_VERSION) {
    throw invalidCursor(list, 'comes from another version of the SDK');
  }
  if (fields.list !== list) {
    throw invalidCursor(list, 'belongs to another list');
  }
  if (
    fields.kind === 'cursor' &&
    typeof fields.value === 'string' &&
    fields.value !== ''
  ) {
    return { kind: 'cursor', value: fields.value };
  }
  if (
    fields.kind === 'page' &&
    typeof fields.value === 'number' &&
    Number.isSafeInteger(fields.value) &&
    fields.value >= 0
  ) {
    return { kind: 'page', value: fields.value };
  }
  throw invalidCursor(list, 'is not a cursor');
}

/**
 * Wraps a list in {@link Paginated}: pages with opaque cursors that resume a walk, whatever
 * the source is keyed by.
 *
 * - `list` names the list in its cursors (`'markets'`, `'openOrders'`, ...): a cursor only
 *   works on the list that gave it out.
 * - `open(cursor)` starts the source at a position: `undefined` is its first page. For a source
 *   keyed by the service's own cursor, `cursor` is that cursor; for a source addressed by page
 *   number, it is the page number as a decimal string. It closes over the call's query and
 *   options, and is called again for every walk.
 * - `map(row)` turns a source row into an item; `undefined` drops the row. A page can then
 *   hold fewer items than the source page, even none, and still have `hasMore`.
 *
 * A source that repeats itself (cursors that cycle, a page that comes back again) ends the
 * walk quietly, as the source paginator does. See {@link PaginatedOptions} for a depth cap.
 *
 * @throws {UserInputError} `invalid_cursor` from `from`, for a cursor of another list or a
 *   malformed one.
 * @throws {PaginationLimitError} from `from`, for a cursor beyond `maxPage`.
 * @example
 * const markets = toPaginated(
 *   'markets',
 *   (cursor) => pageSource(cursor === undefined ? 1 : Number(cursor)),
 *   (row) => (row.isBinary ? row : undefined),
 * );
 */
export function toPaginated<R, T>(
  list: string,
  open: (cursor: string | undefined) => Paginator<R>,
  map: (raw: R) => T | undefined,
  options: PaginatedOptions = {},
): Paginated<T> {
  const { maxPage } = options;

  function paginatedFrom(start: Position | undefined): Paginated<T> {
    // What `open` is given: the service's cursor, or the page number as text.
    const startAt = start === undefined ? undefined : String(start.value);

    /** A page of the source as a page of this list. */
    function shape(source: SourcePage<R>): Page<T> {
      const items: T[] = [];
      for (const row of source.items) {
        const item = map(row);
        if (item !== undefined) {
          items.push(item);
        }
      }
      const next = source.hasNext ? nextPosition(source) : undefined;
      if (next === undefined) {
        return { items, hasMore: false };
      }
      if (typeof next === 'number' && maxPage !== undefined && next > maxPage) {
        return { items, hasMore: false, limitReached: true };
      }
      return {
        items,
        hasMore: true,
        nextCursor: encodeCursor(
          list,
          typeof next === 'number'
            ? { kind: 'page', value: next }
            : { kind: 'cursor', value: next },
        ),
      };
    }

    async function* pages(): AsyncGenerator<Page<T>, void, undefined> {
      for await (const page of open(startAt).pages()) {
        const shaped = shape(page);
        yield shaped;
        if (!shaped.hasMore) {
          // The source may have more (beyond a depth cap): do not ask for it.
          return;
        }
      }
    }

    return {
      [Symbol.asyncIterator]: pages,
      async firstPage() {
        return shape(await open(startAt).firstPage());
      },
      from(cursor) {
        if (cursor === undefined) {
          return paginatedFrom(undefined);
        }
        const position = decodeCursor(list, cursor);
        if (
          position.kind === 'page' &&
          maxPage !== undefined &&
          position.value > maxPage
        ) {
          throw new PaginationLimitError(
            `The "${list}" list cannot be read past page ${maxPage}. Narrow it with filters to reach the rest.`,
          );
        }
        return paginatedFrom(position);
      },
    };
  }

  return paginatedFrom(undefined);
}
