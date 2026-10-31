// Response schemas of the data client for the catalogue routes: events, series, the browse
// catalogue, pulse markets and the taxonomy (categories, subcategories). Markets, activity
// and the shared building blocks are in `schemas.ts`. The conventions are the same: the
// backend's own field names, money-like fields as `DecimalString`, ISO-8601 timestamps.

import { z } from 'zod';
import {
  defineSchema,
  type EnumFactory,
  type ObjFactory,
} from '../core/schema';
import type { DecimalString } from '../core/types';
import {
  arrayOf,
  dataOf,
  decimalString,
  type Market,
  marketSchema,
  pageOf,
} from './schemas';

const timestamp = z.string();
const jsonObject = z.record(z.string(), z.unknown());

// ---------------------------------------------------------------------------
// Events and series
// ---------------------------------------------------------------------------

/** The category an event or series belongs to. */
export interface EventCategory {
  id: number;
  name: string;
  description?: string | null;
  isActive: boolean;
}

const eventCategorySchema = (obj: ObjFactory) =>
  obj({
    id: z.number(),
    name: z.string(),
    description: z.string().nullish(),
    isActive: z.boolean(),
  });

/** A series of events, such as a tournament. */
export interface Series {
  id: string;
  categoryId: number | null;
  category: EventCategory | null;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  active: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

const seriesSchema = (obj: ObjFactory) =>
  obj({
    id: z.string(),
    categoryId: z.number().nullable(),
    category: eventCategorySchema(obj).nullable(),
    slug: z.string(),
    title: z.string(),
    subtitle: z.string().nullable(),
    description: z.string().nullable(),
    active: z.boolean(),
    sortOrder: z.number(),
    createdAt: timestamp,
    updatedAt: timestamp,
  });

export const SeriesListSchema = dataOf<Series[]>((obj) =>
  z.array(seriesSchema(obj)),
);

export const SeriesSchema = dataOf<Series>(seriesSchema);

/** An event image: an icon, a banner, a background, or another slot the admin defined. */
export interface EventMedia {
  id: string;
  /**
   * The placement slot. The presenter documents `icon`, `banner` and `background`, but the
   * column is free text, so any string is accepted, such as `hero`.
   */
  role: 'icon' | 'banner' | 'background' | 'hero' | (string & {});
  url: string;
  /** The admin-visible label, also the front end's slot key. */
  alt: string | null;
  sortOrder: number;
  metadata: Record<string, unknown>;
}

export const eventMediaSchema = (obj: ObjFactory) =>
  obj({
    id: z.string(),
    // Free text ('hero' is sent), not a closed enum: a strict parse must not reject a new slot.
    role: z.string(),
    url: z.string(),
    alt: z.string().nullable(),
    sortOrder: z.number(),
    metadata: jsonObject,
  });

/**
 * Where an event-placed market sits: the root event, the
 * series, the sub-event and the group. The portfolio and the activity feeds attach it to a
 * market so a client can link to `/event/{rootEventSlug}?market={contractMarketId}`.
 */
export interface EventPlacement {
  rootEventId: string;
  rootEventSlug: string;
  rootEventTitle: string;
  rootMetadata: Record<string, unknown>;
  seriesId: string | null;
  seriesSlug: string | null;
  placementEventId: string;
  subEventId: string | null;
  subEventSlug: string | null;
  subEventTitle: string | null;
  groupTitle: string | null;
  eventSortOrder: number;
  eventMedia: EventMedia[];
}

export const eventPlacementSchema = (obj: ObjFactory) =>
  obj({
    rootEventId: z.string(),
    rootEventSlug: z.string(),
    rootEventTitle: z.string(),
    rootMetadata: jsonObject,
    seriesId: z.string().nullable(),
    seriesSlug: z.string().nullable(),
    placementEventId: z.string(),
    subEventId: z.string().nullable(),
    subEventSlug: z.string().nullable(),
    subEventTitle: z.string().nullable(),
    groupTitle: z.string().nullable(),
    eventSortOrder: z.number(),
    eventMedia: z.array(eventMediaSchema(obj)),
  });

/** The liquidity rewards programme summary embedded on a market placement. */
export interface LiquidityRewardsPlacement {
  currency: 'CP' | 'USDC' | (string & {});
  eligible: boolean;
  /** The daily pool in the programme's currency. */
  dailyPool: DecimalString | null;
  /** How far from the midpoint an order still scores, in cents. */
  maxDistanceCents: DecimalString;
  /** How long an order must rest to score, in milliseconds. */
  minOrderRestMs: number;
  /** @deprecated `minOrderRestMs` rounded up to seconds. */
  minOrderRestSeconds: number;
  /** The smallest scoring order, in shares. */
  minOrderSizeShares: DecimalString;
  minPayout: DecimalString;
  /** Midpoints above this (or below 1 minus it) score 0. */
  maxAvgPrice: DecimalString;
}

const liquidityRewardsSchema = (obj: ObjFactory, enumOf: EnumFactory) =>
  obj({
    currency: enumOf(['CP', 'USDC']),
    eligible: z.boolean(),
    dailyPool: decimalString.nullable(),
    maxDistanceCents: decimalString,
    minOrderRestMs: z.number(),
    minOrderRestSeconds: z.number(),
    minOrderSizeShares: decimalString,
    minPayout: decimalString,
    maxAvgPrice: decimalString,
  });

/** A market placed on an event, with its editorial label. */
export interface EventMarketPlacement {
  liquidityRewards?: LiquidityRewardsPlacement | null;
  eventId: string;
  eventSortOrder: number;
  groupTitle: string | null;
  market: Market;
}

const eventMarketPlacementSchema = (obj: ObjFactory, enumOf: EnumFactory) =>
  obj({
    liquidityRewards: liquidityRewardsSchema(obj, enumOf).nullish(),
    eventId: z.string(),
    eventSortOrder: z.number(),
    groupTitle: z.string().nullable(),
    market: marketSchema(obj, enumOf),
  });

/** An event of the catalogue: a root event or a sub-event. */
export interface CatalogEvent {
  id: string;
  seriesId: string | null;
  categoryId: number | null;
  category: EventCategory | null;
  /** The root event, for a sub-event. */
  parentEventId: string | null;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  priorityScore: number;
  /** Mirrors the market type (4 is a CLOB conviction). `null` for editorial events. */
  type: number | null;
  /** `null` is ungraduated (convictions feed only). */
  graduatedAt: string | null;
  creatorId: number | null;
  creator: { id: number; username: string } | null;
  /** Left out (not an empty array) when the event has no media, except on an event tree. */
  media?: EventMedia[];
}

const eventFields = (obj: ObjFactory) => ({
  id: z.string(),
  seriesId: z.string().nullable(),
  categoryId: z.number().nullable(),
  category: eventCategorySchema(obj).nullable(),
  parentEventId: z.string().nullable(),
  slug: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  description: z.string().nullable(),
  metadata: jsonObject,
  sortOrder: z.number(),
  createdAt: timestamp,
  updatedAt: timestamp,
  priorityScore: z.number(),
  type: z.number().nullable(),
  graduatedAt: timestamp.nullable(),
  creatorId: z.number().nullable(),
  creator: obj({ id: z.number(), username: z.string() }).nullable(),
  media: z.array(eventMediaSchema(obj)).optional(),
});

/** A sub-event with its markets. */
export interface CatalogSubEvent extends CatalogEvent {
  /** True when every nested market has conviction points enabled. */
  cpEnabled: boolean;
  markets: EventMarketPlacement[];
}

const subEventSchema = (obj: ObjFactory, enumOf: EnumFactory) =>
  obj({
    ...eventFields(obj),
    cpEnabled: z.boolean(),
    markets: z.array(eventMarketPlacementSchema(obj, enumOf)),
  });

/** A root event with its media, markets and sub-events. */
export interface CatalogEventTree extends CatalogEvent {
  media: EventMedia[];
  cpEnabled: boolean;
  /** The markets placed directly on the root. */
  markets: EventMarketPlacement[];
  subEvents: CatalogSubEvent[];
}

const eventTreeSchema = (obj: ObjFactory, enumOf: EnumFactory) =>
  obj({
    ...eventFields(obj),
    media: z.array(eventMediaSchema(obj)),
    cpEnabled: z.boolean(),
    markets: z.array(eventMarketPlacementSchema(obj, enumOf)),
    subEvents: z.array(subEventSchema(obj, enumOf)),
  });

export const EventTreeSchema = dataOf<CatalogEventTree>(eventTreeSchema);

/** One row of the event list. */
export interface CatalogEventListItem extends CatalogEvent {
  subEventCount: number;
  marketCount: number;
  directMarketCount: number;
  /** With `withMarkets` only: the markets of the event, sub-event markets flattened in. */
  markets?: EventMarketPlacement[];
  subEvents?: CatalogSubEvent[];
  cpEnabled?: boolean;
  /** Sum of the nested markets' USD volume (`withMarkets` only). */
  totalVolumeInUSD?: DecimalString;
  totalNotionalInUSD?: DecimalString;
  /** The soonest expiry across the nested markets (`withMarkets` only). */
  expiresAt?: string | null;
  newestMarketAt?: string | null;
}

const eventListItemSchema = (obj: ObjFactory, enumOf: EnumFactory) =>
  obj({
    ...eventFields(obj),
    subEventCount: z.number(),
    marketCount: z.number(),
    directMarketCount: z.number(),
    markets: z.array(eventMarketPlacementSchema(obj, enumOf)).optional(),
    subEvents: z.array(subEventSchema(obj, enumOf)).optional(),
    cpEnabled: z.boolean().optional(),
    totalVolumeInUSD: decimalString.optional(),
    totalNotionalInUSD: decimalString.optional(),
    expiresAt: timestamp.nullish(),
    newestMarketAt: timestamp.nullish(),
  });

export const EventsPageSchema =
  pageOf<CatalogEventListItem>(eventListItemSchema);

/** A sub-event in the sub-event list. */
export interface CatalogSubEventSummary extends CatalogEvent {
  marketCount: number;
}

export const SubEventsSchema = dataOf<CatalogSubEventSummary[]>((obj) =>
  z.array(
    obj({
      ...eventFields(obj),
      marketCount: z.number(),
    }),
  ),
);

/** A market placement under an event or series tree. */
export interface ScopedMarketPlacement {
  eventId: string;
  parentEventId: string | null;
  eventTitle: string;
  eventSlug: string;
  /** Root-event media; `market.imageUrl` is per outcome. */
  eventMedia: EventMedia[];
  subEventId: string | null;
  subEventTitle: string | null;
  subEventSlug: string | null;
  eventSortOrder: number;
  rootEventSortOrder: number;
  groupTitle: string | null;
  market: Market;
  liquidityRewards?: LiquidityRewardsPlacement | null;
}

const scopedPlacementSchema = (obj: ObjFactory, enumOf: EnumFactory) =>
  obj({
    eventId: z.string(),
    parentEventId: z.string().nullable(),
    eventTitle: z.string(),
    eventSlug: z.string(),
    eventMedia: z.array(eventMediaSchema(obj)),
    subEventId: z.string().nullable(),
    subEventTitle: z.string().nullable(),
    subEventSlug: z.string().nullable(),
    eventSortOrder: z.number(),
    rootEventSortOrder: z.number(),
    groupTitle: z.string().nullable(),
    market: marketSchema(obj, enumOf),
    liquidityRewards: liquidityRewardsSchema(obj, enumOf).nullish(),
  });

export const ScopedMarketsPageSchema = pageOf<ScopedMarketPlacement>(
  scopedPlacementSchema,
);

// ---------------------------------------------------------------------------
// Browse catalogue
// ---------------------------------------------------------------------------

/** The event context of an event card in the browse catalogue. */
export interface BrowseEvent {
  id: string;
  parentEventId: string | null;
  seriesId: string | null;
  slug: string;
  title: string;
  subtitle: string | null;
  metadata: Record<string, unknown>;
  parentTitle?: string | null;
  parentSlug?: string | null;
  eventMedia: EventMedia[];
  graduatedAt?: string | null;
  type?: number | null;
}

/** A market inside an event card of the browse catalogue. */
export interface BrowsePlacement {
  groupTitle: string | null;
  eventSortOrder: number;
  market: Market;
  liquidityRewards?: LiquidityRewardsPlacement | null;
}

/**
 * One card of `GET /markets/browse`: a standalone market (`kind: 'market'`, with `market`)
 * or an event (`kind: 'event'`, with `event`, `markets` and the totals).
 */
export interface BrowseItem {
  kind: 'market' | 'event' | (string & {});
  market?: Market;
  liquidityRewards?: LiquidityRewardsPlacement | null;
  event?: BrowseEvent;
  markets?: BrowsePlacement[];
  marketCount?: number;
  totalVolumeInUSD?: DecimalString;
  totalNotionalInUSD?: DecimalString;
  expiresAt?: string | null;
  cpEnabled?: boolean;
}

const browseItemSchema = (obj: ObjFactory, enumOf: EnumFactory) =>
  obj({
    kind: enumOf(['market', 'event']),
    market: marketSchema(obj, enumOf).optional(),
    liquidityRewards: liquidityRewardsSchema(obj, enumOf).nullish(),
    event: obj({
      id: z.string(),
      parentEventId: z.string().nullable(),
      seriesId: z.string().nullable(),
      slug: z.string(),
      title: z.string(),
      subtitle: z.string().nullable(),
      metadata: jsonObject,
      parentTitle: z.string().nullish(),
      parentSlug: z.string().nullish(),
      eventMedia: z.array(eventMediaSchema(obj)),
      graduatedAt: timestamp.nullish(),
      type: z.number().nullish(),
    }).optional(),
    markets: z
      .array(
        obj({
          groupTitle: z.string().nullable(),
          eventSortOrder: z.number(),
          market: marketSchema(obj, enumOf),
          liquidityRewards: liquidityRewardsSchema(obj, enumOf).nullish(),
        }),
      )
      .optional(),
    marketCount: z.number().optional(),
    totalVolumeInUSD: decimalString.optional(),
    totalNotionalInUSD: decimalString.optional(),
    expiresAt: timestamp.nullish(),
    cpEnabled: z.boolean().optional(),
  });

export const BrowsePageSchema = pageOf<BrowseItem>(browseItemSchema);

// ---------------------------------------------------------------------------
// Pulse markets
// ---------------------------------------------------------------------------

/** A pulse market, as the perpetual-markets service describes it. */
export interface PulseMarket {
  id: number;
  marketConfigId: number;
  adapterConfigId: number;
  marketConfigName: string;
  /** The AMM market's address. `null` for CLOB pulse markets, which use `conditionId`. */
  marketAddress?: string | null;
  /** The CLOB condition id. `null` for AMM pulse markets. */
  conditionId?: string | null;
  /** Such as `active`, `resolved`, `closed` (the service's own words). */
  status: string;
  cycleNumber: number;
  startsAt: string;
  expiresAt: string;
  observationStartsAt: string;
  observationEndsAt: string;
  resolvedAt?: string | null;
  closedAt?: string | null;
  /** The TWAP at the start of the observation window, a price. */
  openingTwap?: DecimalString | null;
  closingTwap?: DecimalString | null;
  /** The reference price at the start of the round (newer service versions). */
  openingPrice?: DecimalString | null;
  /** The reference price at the end of the round. */
  closingPrice?: DecimalString | null;
  /** The winning outcome's index, once resolved. */
  winningOutcome?: number | null;
  sampleCount: number;
  resolutionData?: Record<string, unknown> | null;
  marketMetadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

const pulseMarketSchema = (obj: ObjFactory) =>
  obj({
    id: z.number(),
    marketConfigId: z.number(),
    adapterConfigId: z.number(),
    marketConfigName: z.string(),
    marketAddress: z.string().nullish(),
    conditionId: z.string().nullish(),
    status: z.string(),
    cycleNumber: z.number(),
    startsAt: timestamp,
    expiresAt: timestamp,
    observationStartsAt: timestamp,
    observationEndsAt: timestamp,
    resolvedAt: timestamp.nullish(),
    closedAt: timestamp.nullish(),
    openingTwap: decimalString.nullish(),
    closingTwap: decimalString.nullish(),
    openingPrice: decimalString.nullish(),
    closingPrice: decimalString.nullish(),
    winningOutcome: z.number().nullish(),
    sampleCount: z.number(),
    resolutionData: jsonObject.nullish(),
    marketMetadata: jsonObject.nullish(),
    createdAt: timestamp,
    updatedAt: timestamp,
  });

/** The page/limit meta of `GET /pulse/markets`. */
export interface PulsePageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export const PulseMarketsPageSchema = defineSchema<{
  data: PulseMarket[];
  meta: PulsePageMeta;
}>((obj) =>
  obj({
    data: z.array(pulseMarketSchema(obj)),
    meta: obj({
      page: z.number(),
      limit: z.number(),
      total: z.number(),
      totalPages: z.number(),
      hasNextPage: z.boolean(),
      hasPreviousPage: z.boolean(),
    }),
  }),
);

export const PulseMarketSchema = defineSchema<PulseMarket>(pulseMarketSchema);

export const PulseMarketsSchema = arrayOf<PulseMarket>(pulseMarketSchema);

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

/**
 * A market category. `marketsCount` is there in the overview mode the data client uses by
 * default: the number of markets in the category after the market scope filter.
 */
export interface Category {
  id: number;
  createdAt: string;
  updatedAt: string;
  name: string;
  description?: string | null;
  isActive: boolean;
  marketsCount?: number;
}

const categorySchema = (obj: ObjFactory) =>
  obj({
    id: z.number(),
    createdAt: timestamp,
    updatedAt: timestamp,
    name: z.string(),
    description: z.string().nullish(),
    isActive: z.boolean(),
    marketsCount: z.number().optional(),
  });

export const CategoriesSchema = arrayOf<Category>(categorySchema);

/** The category embedded on a subcategory. */
export type SubcategoryCategory = Omit<Category, 'marketsCount'>;

/** A market subcategory (a second- or third-level taxonomy node). */
export interface Subcategory {
  id: number;
  createdAt: string;
  updatedAt: string;
  name: string;
  slug: string;
  description?: string | null;
  isActive: boolean;
  /** The parent category. */
  categoryId: number;
  /** Set on a third-level node. */
  parentSubcategoryId?: number | null;
  /** 1 for a subcategory, 2 for a sub-subcategory. */
  depth?: number | null;
  /** The sub-subcategories of a second-level node. */
  children?: Array<Omit<Subcategory, 'children'>>;
  category?: SubcategoryCategory;
  /** Markets in the node (and its descendants) after the market scope filter. */
  marketsCount: number;
}

const subcategoryFields = (obj: ObjFactory) => ({
  id: z.number(),
  createdAt: timestamp,
  updatedAt: timestamp,
  name: z.string(),
  slug: z.string(),
  description: z.string().nullish(),
  isActive: z.boolean(),
  categoryId: z.number(),
  parentSubcategoryId: z.number().nullish(),
  depth: z.number().nullish(),
  category: obj({
    id: z.number(),
    createdAt: timestamp,
    updatedAt: timestamp,
    name: z.string(),
    description: z.string().nullish(),
    isActive: z.boolean(),
  }).optional(),
  marketsCount: z.number(),
});

const subcategorySchema = (obj: ObjFactory) =>
  obj({
    ...subcategoryFields(obj),
    children: z.array(obj(subcategoryFields(obj))).optional(),
  });

export const SubcategoriesSchema = arrayOf<Subcategory>(subcategorySchema);

/** The paginated list of `GET /subcategories` without an overview param. */
export interface SubcategoriesPage {
  items: Subcategory[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export const SubcategoriesPageSchema = defineSchema<SubcategoriesPage>((obj) =>
  obj({
    items: z.array(subcategorySchema(obj)),
    total: z.number(),
    page: z.number(),
    limit: z.number(),
    totalPages: z.number(),
    hasNext: z.boolean(),
    hasPrev: z.boolean(),
  }),
);
