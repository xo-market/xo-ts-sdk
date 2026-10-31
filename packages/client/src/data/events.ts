import type { Paginator } from '../core/paginate';
import type { CallOptions } from '../core/requestOptions';
import {
  type CatalogEventListItem,
  type CatalogEventTree,
  type CatalogSubEventSummary,
  EventsPageSchema,
  EventTreeSchema,
  type ScopedMarketPlacement,
  ScopedMarketsPageSchema,
  type Series,
  SeriesListSchema,
  SeriesSchema,
  SubEventsSchema,
} from './catalogSchemas';
import type { DataDeps } from './internal';
import { paged, singlePage } from './pages';
import {
  type ListEventsParams,
  type ListSeriesParams,
  listEventsQuery,
  listSeriesQuery,
  type ScopedMarketsParams,
  scopedMarketsQuery,
  slugSegment,
  uuidSegment,
} from './params';

/**
 * Events: the catalogue of fixtures and props. A root event can hold markets directly and
 * have sub-events with their own markets. Ids are UUIDs; a slug route exists for readable
 * URLs, and the id routes are preferred for integrations.
 */
export class EventsApi {
  /** @internal Made by `DataClient`, which owns the transport and the session. */
  constructor(private readonly deps: DataDeps) {}

  /**
   * Root events (`GET /v1/events`), by `sortOrder` and title. With `withMarkets` and a
   * `seriesId`, each event embeds its markets.
   *
   * @throws {UserInputError} At once, for an unknown param or a value outside the
   *   backend's ranges (`take` is 1 to 1000).
   */
  list(
    params?: ListEventsParams,
    call?: CallOptions,
  ): Paginator<CatalogEventListItem> {
    return paged(
      this.deps,
      'events.list',
      EventsPageSchema,
      listEventsQuery(params),
      { call },
    );
  }

  /**
   * An event tree by id (`GET /v1/events/:eventId`). A sub-event id resolves to its root.
   *
   * @throws {RequestRejectedError} Status 404, when there is no such event.
   */
  async get(eventId: string, call?: CallOptions): Promise<CatalogEventTree> {
    const { data } = await this.deps.get('events.get', EventTreeSchema, {
      params: { eventId: uuidSegment(eventId, 'eventId') },
      call,
    });
    return data;
  }

  /**
   * An event tree by its root slug (`GET /v1/events/slug/:slug`).
   *
   * @throws {RequestRejectedError} Status 404, when there is no such event.
   */
  async bySlug(slug: string, call?: CallOptions): Promise<CatalogEventTree> {
    const { data } = await this.deps.get('events.bySlug', EventTreeSchema, {
      params: { slug: slugSegment(slug) },
      call,
    });
    return data;
  }

  /**
   * The markets under an event tree (`GET /v1/events/:eventId/markets`), sub-event markets
   * included unless `includeSubEvents` is false.
   *
   * @throws {UserInputError} At once, like {@link list}.
   */
  markets(
    eventId: string,
    params?: ScopedMarketsParams,
    call?: CallOptions,
  ): Paginator<ScopedMarketPlacement> {
    return paged(
      this.deps,
      'events.markets',
      ScopedMarketsPageSchema,
      scopedMarketsQuery(params, 'events.markets'),
      { params: { eventId: uuidSegment(eventId, 'eventId') }, call },
    );
  }

  /**
   * The sub-events of a root event (`GET /v1/events/:eventId/subevents`). One page: the
   * route answers all of them.
   */
  subevents(
    eventId: string,
    call?: CallOptions,
  ): Paginator<CatalogSubEventSummary> {
    const params = { eventId: uuidSegment(eventId, 'eventId') };
    return singlePage(
      () =>
        this.deps.get('events.subevents', SubEventsSchema, { params, call }),
      (raw) => raw.data,
    );
  }
}

/** Series: groups of events, such as a tournament. */
export class SeriesApi {
  /** @internal Made by `DataClient`, which owns the transport and the session. */
  constructor(private readonly deps: DataDeps) {}

  /**
   * The series (`GET /v1/series`), active ones unless `active` is false. One page: the
   * route answers all of them.
   *
   * @throws {UserInputError} At once, for any param but `active`.
   */
  list(params?: ListSeriesParams, call?: CallOptions): Paginator<Series> {
    const query = listSeriesQuery(params);
    return singlePage(
      () => this.deps.get('series.list', SeriesListSchema, { query, call }),
      (raw) => raw.data,
    );
  }

  /**
   * One series by id (`GET /v1/series/:seriesId`).
   *
   * @throws {RequestRejectedError} Status 404, when there is no such series.
   */
  async get(seriesId: string, call?: CallOptions): Promise<Series> {
    const { data } = await this.deps.get('series.get', SeriesSchema, {
      params: { seriesId: uuidSegment(seriesId, 'seriesId') },
      call,
    });
    return data;
  }

  /**
   * One series by its slug (`GET /v1/series/slug/:slug`).
   *
   * @throws {RequestRejectedError} Status 404, when there is no such series.
   */
  async bySlug(slug: string, call?: CallOptions): Promise<Series> {
    const { data } = await this.deps.get('series.bySlug', SeriesSchema, {
      params: { slug: slugSegment(slug) },
      call,
    });
    return data;
  }

  /**
   * The markets under a series (`GET /v1/series/:seriesId/markets`), across its root events
   * and sub-events.
   *
   * @throws {UserInputError} At once, like {@link EventsApi.list}.
   */
  markets(
    seriesId: string,
    params?: ScopedMarketsParams,
    call?: CallOptions,
  ): Paginator<ScopedMarketPlacement> {
    return paged(
      this.deps,
      'series.markets',
      ScopedMarketsPageSchema,
      scopedMarketsQuery(params, 'series.markets'),
      { params: { seriesId: uuidSegment(seriesId, 'seriesId') }, call },
    );
  }
}
