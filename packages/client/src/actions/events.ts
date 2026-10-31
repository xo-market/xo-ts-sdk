import { z } from 'zod';
import type { ActionContext } from '../clients/context';
import {
  makeErrorGuard,
  PaginationLimitError,
  RateLimitError,
  RequestAbortedError,
  RequestRejectedError,
  TimeoutError,
  TransportError,
  UnexpectedResponseError,
  UserInputError,
} from '../core/errors';
import { type Paginated, toPaginated } from '../core/paginated';
import {
  parseRequestOptions,
  type RequestOptions,
} from '../core/requestOptions';
import { type ListEventsParams, MAX_PAGE } from '../data/params';
import { type Event, type Series, toEvent, toSeries } from '../models/event';
import {
  exactlyOne,
  fields,
  noCursor,
  pageNumberOf,
  parseInput,
} from './internal';

// The event and series actions. An event groups markets under one heading, such as a match; a
// series groups events, such as a tournament.

// ---------------------------------------------------------------------------
// listEvents
// ---------------------------------------------------------------------------

/** What {@link PublicClient.listEvents} takes. Every key is optional. */
export type ListEventsRequest = {
  /** Only the events of this series. A series' id, a UUID. */
  seriesId?: string;
  /** Only the events in this category. A category's id (`Category.id`), digits. */
  categoryId?: string;
  /** Only events that match this text. */
  search?: string;
  /**
   * Load each event's markets into `Event.markets`, which a list leaves `null`. It needs
   * `seriesId`.
   */
  withMarkets?: boolean;
  /** How many events a page holds, from 1 to 1000. */
  pageSize?: number;
};

const ListEventsSchema = z
  .strictObject({
    seriesId: fields.uuid().optional(),
    categoryId: fields.digits().optional(),
    search: fields.text().optional(),
    withMarkets: fields.bool().optional(),
    pageSize: fields.whole(1, 1000).optional(),
  })
  .superRefine((request, ctx) => {
    if (request.withMarkets === true && request.seriesId === undefined) {
      ctx.addIssue({
        code: 'custom',
        message:
          'withMarkets needs seriesId: only the events of a series can load their markets',
        input: request,
      });
    }
  });

/** The error union of {@link PublicClient.listEvents}. */
export type ListEventsError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError
  | PaginationLimitError;
/** The guard of {@link ListEventsError}. */
export const ListEventsError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
  PaginationLimitError,
);

/**
 * Lists events, a page at a time: the events that are not sub-events of another. Reading the
 * list makes one request per page.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export function listEvents(
  ctx: ActionContext,
  request?: ListEventsRequest,
  options?: RequestOptions,
): Paginated<Event> {
  const input: ListEventsRequest = parseInput(
    'listEvents',
    request,
    ListEventsSchema,
  );
  const call = parseRequestOptions(options);
  const params: ListEventsParams = {
    ...(input.seriesId === undefined ? {} : { seriesId: input.seriesId }),
    ...(input.categoryId === undefined
      ? {}
      : { categoryId: Number(input.categoryId) }),
    ...(input.search === undefined ? {} : { search: input.search }),
    ...(input.withMarkets === undefined
      ? {}
      : { withMarkets: input.withMarkets }),
    ...(input.pageSize === undefined ? {} : { take: input.pageSize }),
  };
  return toPaginated(
    'events',
    (cursor) =>
      ctx.data.events.list({ ...params, page: pageNumberOf(cursor) }, call),
    toEvent,
    { maxPage: MAX_PAGE },
  );
}

// ---------------------------------------------------------------------------
// fetchEvent
// ---------------------------------------------------------------------------

/**
 * What {@link PublicClient.fetchEvent} takes: `id` (the event's id, a UUID) or `slug` (its URL name).
 */
export type FetchEventRequest = { id: string } | { slug: string };

const FetchEventSchema = z
  .strictObject({
    id: fields.uuid().optional(),
    slug: fields.slug().optional(),
  })
  .superRefine(exactlyOne(['id', 'slug']));

/** The error union of {@link PublicClient.fetchEvent}. */
export type FetchEventError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link FetchEventError}. */
export const FetchEventError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Reads one event with its markets: the CLOB markets with two outcomes that are placed on it
 * and on its sub-events, each with its label in `groupItemTitle`. The sub-events themselves are
 * listed by {@link PublicClient.listSubevents}.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export async function fetchEvent(
  ctx: ActionContext,
  request: FetchEventRequest,
  options?: RequestOptions,
): Promise<Event> {
  const input = parseInput('fetchEvent', request, FetchEventSchema);
  const call = parseRequestOptions(options);
  const raw =
    input.id !== undefined
      ? await ctx.data.events.get(input.id, call)
      : await ctx.data.events.bySlug(input.slug ?? '', call);
  return toEvent(raw);
}

// ---------------------------------------------------------------------------
// listSubevents
// ---------------------------------------------------------------------------

/** What {@link PublicClient.listSubevents} takes. */
export type ListSubeventsRequest = {
  /** The id of the event whose sub-events to list, a UUID. */
  eventId: string;
};

const ListSubeventsSchema = z.strictObject({ eventId: fields.uuid() });

/** The error union of {@link PublicClient.listSubevents}. */
export type ListSubeventsError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link ListSubeventsError}. */
export const ListSubeventsError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Lists the sub-events of an event, for example the first half of a match. Each is an event
 * of its own, with `parentEventId` set and its markets not loaded: {@link PublicClient.fetchEvent} loads
 * them. All of them come on one page.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export function listSubevents(
  ctx: ActionContext,
  request: ListSubeventsRequest,
  options?: RequestOptions,
): Paginated<Event> {
  const input = parseInput('listSubevents', request, ListSubeventsSchema);
  const call = parseRequestOptions(options);
  return toPaginated(
    'subevents',
    (cursor) => {
      noCursor(cursor);
      return ctx.data.events.subevents(input.eventId, call);
    },
    toEvent,
  );
}

// ---------------------------------------------------------------------------
// listSeries and fetchSeries
// ---------------------------------------------------------------------------

/** What {@link PublicClient.listSeries} takes. */
export type ListSeriesRequest = {
  /** Only series that are running (`true`, the default) or that are not (`false`). */
  active?: boolean;
};

const ListSeriesSchema = z.strictObject({ active: fields.bool().optional() });

/** The error union of {@link PublicClient.listSeries}. */
export type ListSeriesError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link ListSeriesError}. */
export const ListSeriesError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Lists series of events, such as tournaments. The running ones, unless `active` is `false`.
 * All of them come on one page.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export function listSeries(
  ctx: ActionContext,
  request?: ListSeriesRequest,
  options?: RequestOptions,
): Paginated<Series> {
  const input: ListSeriesRequest = parseInput(
    'listSeries',
    request,
    ListSeriesSchema,
  );
  const call = parseRequestOptions(options);
  return toPaginated(
    'series',
    (cursor) => {
      noCursor(cursor);
      return ctx.data.series.list(
        input.active === undefined ? {} : { active: input.active },
        call,
      );
    },
    toSeries,
  );
}

/**
 * What {@link PublicClient.fetchSeries} takes: `id` (the series' id, a UUID) or `slug` (its URL name).
 */
export type FetchSeriesRequest = { id: string } | { slug: string };

const FetchSeriesSchema = z
  .strictObject({
    id: fields.uuid().optional(),
    slug: fields.slug().optional(),
  })
  .superRefine(exactlyOne(['id', 'slug']));

/** The error union of {@link PublicClient.fetchSeries}. */
export type FetchSeriesError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError;
/** The guard of {@link FetchSeriesError}. */
export const FetchSeriesError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
);

/**
 * Reads one series. Its events are listed by {@link PublicClient.listEvents} with a `seriesId`, and its
 * markets by `listMarkets` with a `seriesId`.
 *
 * The public documentation is on the `PublicClient` member of the same name.
 */
export async function fetchSeries(
  ctx: ActionContext,
  request: FetchSeriesRequest,
  options?: RequestOptions,
): Promise<Series> {
  const input = parseInput('fetchSeries', request, FetchSeriesSchema);
  const call = parseRequestOptions(options);
  const raw =
    input.id !== undefined
      ? await ctx.data.series.get(input.id, call)
      : await ctx.data.series.bySlug(input.slug ?? '', call);
  return toSeries(raw);
}
