import type { DecimalString } from '../core/types';
import type {
  CatalogEventListItem,
  CatalogEventTree,
  CatalogSubEvent,
  CatalogSubEventSummary,
  EventMarketPlacement,
  EventMedia,
  Series as RawSeries,
} from '../data/catalogSchemas';
import type { Market as RawMarket } from '../data/schemas';
import { type Market, toListedMarket } from './market';

// The public event and series models. An event groups markets under one heading, such as a
// match; a series groups events, such as a tournament. Like a market, an event read from a
// listing has only what the listing carries: `markets` is `null` there, because the listing
// did not load them.

/** When an event ends. */
export type EventSchedule = {
  /** The soonest end time among the event's markets, as an ISO 8601 time. `null` when not loaded. */
  endDate: string | null;
};

/** How much has traded on an event. */
export type EventMetrics = {
  /** The volume of the event's markets, in dollars. `null` when not loaded. */
  volume: DecimalString | null;
};

/** The account that created an event. */
export type EventCreator = {
  /** The creator's id. */
  id: string;
  /** The creator's XO username. */
  username: string;
};

/**
 * An event: a heading that markets are placed under, with its sub-events kept separate (an
 * event's sub-event is an event of its own, with `parentEventId` set).
 */
export type Event = {
  /** XO's id for the event. */
  id: string;
  /** The id of the event this one belongs to, for a sub-event. */
  parentEventId: string | null;
  /** The id of the series the event belongs to. */
  seriesId: string | null;
  /** The event's URL name. */
  slug: string;
  /** The event's name. */
  title: string;
  /** A line under the title. */
  subtitle: string | null;
  /** The event's background text. */
  description: string | null;
  /** The event's category, such as `Sports`. */
  category: string | null;
  /** The event's banner picture. */
  image: string | null;
  /** The event's icon. */
  icon: string | null;
  /** When the event was created, as an ISO 8601 time. */
  createdAt: string;
  /** When the event was last changed, as an ISO 8601 time. */
  updatedAt: string;
  /** When the event ends. */
  schedule: EventSchedule;
  /** How much has traded. */
  metrics: EventMetrics;
  /** Extra data XO keeps on the event, as it is. */
  metadata: Record<string, unknown>;
  /** Who created the event. */
  creators: EventCreator[];
  /**
   * The event's CLOB markets with two outcomes, the markets of its sub-events included.
   * `null` when the source did not load them. Each market carries its label in
   * `groupItemTitle`.
   */
  markets: Market[] | null;
};

/** A series of events, such as a tournament. */
export type Series = {
  /** XO's id for the series. */
  id: string;
  /** The series' URL name. */
  slug: string;
  /** The series' name. */
  title: string;
  /** A line under the title. */
  subtitle: string | null;
  /** The series' background text. */
  description: string | null;
  /** The series' category, such as `Sports`. */
  category: string | null;
  /** Whether the series is running. */
  active: boolean;
  /** When the series was created, as an ISO 8601 time. */
  createdAt: string;
  /** When the series was last changed, as an ISO 8601 time. */
  updatedAt: string;
};

/**
 * Every shape an event arrives in: a row of the event list, an event with its markets and
 * sub-events, a sub-event with its markets, and a sub-event summary.
 *
 * @internal
 */
export type RawEventRow =
  | CatalogEventListItem
  | CatalogEventTree
  | CatalogSubEvent
  | CatalogSubEventSummary;

/**
 * The first picture of the first of `roles` that the event has.
 *
 * @internal
 */
export function pictureOf(
  media: EventMedia[] | undefined,
  roles: readonly string[],
): string | null {
  for (const role of roles) {
    const found = media?.find((item) => item.role === role);
    if (found !== undefined) {
      return found.url;
    }
  }
  return null;
}

/**
 * A market as an event places it: the listed market with the placement's label as its
 * `groupItemTitle` (an empty label is none). `undefined` for a row the market model does not
 * hold, as {@link toListedMarket} says.
 *
 * @internal
 */
export function toPlacedMarket(
  row: RawMarket,
  groupTitle: string | null,
): Market | undefined {
  const market = toListedMarket(row);
  if (market === undefined) {
    return undefined;
  }
  // The label belongs to the placement, not to the market row.
  return {
    ...market,
    groupItemTitle:
      groupTitle === null || groupTitle === '' ? null : groupTitle,
  };
}

/**
 * The event's markets, or `null` when the row carries none. A list row that was asked for its
 * markets has the sub-events' markets flattened in already, and an event tree keeps them
 * under its sub-events, so both are read and a market is taken once.
 */
function marketsOf(raw: RawEventRow): Market[] | null {
  const direct: EventMarketPlacement[] | undefined =
    'markets' in raw ? raw.markets : undefined;
  const nested: CatalogSubEvent[] | undefined =
    'subEvents' in raw ? raw.subEvents : undefined;
  if (direct === undefined && nested === undefined) {
    return null;
  }
  const placements = [
    ...(direct ?? []),
    ...(nested ?? []).flatMap((subEvent) => subEvent.markets),
  ];
  const seen = new Set<number>();
  const markets: Market[] = [];
  for (const { market: row, groupTitle } of placements) {
    if (seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    const market = toPlacedMarket(row, groupTitle);
    if (market !== undefined) {
      markets.push(market);
    }
  }
  return markets;
}

/**
 * Maps an event of the catalogue to the {@link Event} model. The markets are mapped as listed
 * markets, and those that are not CLOB markets with two outcomes are left out.
 *
 * @internal
 */
export function toEvent(raw: RawEventRow): Event {
  return {
    id: raw.id,
    parentEventId: raw.parentEventId,
    seriesId: raw.seriesId,
    slug: raw.slug,
    title: raw.title,
    subtitle: raw.subtitle,
    description: raw.description,
    category: raw.category?.name ?? null,
    image: pictureOf(raw.media, ['banner', 'hero']),
    icon: pictureOf(raw.media, ['icon']),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    schedule: {
      endDate: ('expiresAt' in raw ? raw.expiresAt : undefined) ?? null,
    },
    metrics: {
      volume:
        ('totalVolumeInUSD' in raw ? raw.totalVolumeInUSD : undefined) ?? null,
    },
    metadata: { ...raw.metadata },
    creators:
      raw.creator === null
        ? []
        : [{ id: String(raw.creator.id), username: raw.creator.username }],
    markets: marketsOf(raw),
  };
}

/**
 * Maps a series of the catalogue to the {@link Series} model.
 *
 * @internal
 */
export function toSeries(raw: RawSeries): Series {
  return {
    id: raw.id,
    slug: raw.slug,
    title: raw.title,
    subtitle: raw.subtitle,
    description: raw.description,
    category: raw.category?.name ?? null,
    active: raw.active,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}
