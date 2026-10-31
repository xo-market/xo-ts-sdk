import type { DecimalString } from '../core/types';
import type { BrowseItem as RawBrowseItem } from '../data/catalogSchemas';
import { unexpectedField } from './convert';
import { pictureOf, toPlacedMarket } from './event';
import { type Market, toListedMarket } from './market';

// The public model of XO's browse feed: the cards of the market page, each a market that
// stands alone or an event with its markets.

/** An event card of the browse feed: the event and its CLOB markets. */
export type BrowseEvent = {
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
  /** The event's banner picture. */
  image: string | null;
  /** The soonest end time among the event's markets, as an ISO 8601 time. `null` when XO gave none. */
  endDate: string | null;
  /** How much has traded on the event. */
  metrics: {
    /** The volume of the event's markets, in dollars. `null` when XO gave none. */
    volume: DecimalString | null;
  };
  /** Extra data XO keeps on the event, as it is. */
  metadata: Record<string, unknown>;
  /** The event's CLOB markets with two outcomes, each with its label in `groupItemTitle`. */
  markets: Market[];
};

/**
 * One card of the browse feed: a market that stands alone (`kind: 'market'`) or an event with
 * its markets (`kind: 'event'`).
 */
export type BrowseItem =
  | { kind: 'market'; market: Market }
  | { kind: 'event'; event: BrowseEvent };

/**
 * Maps a card of the browse feed to the {@link BrowseItem} model.
 *
 * Returns `undefined` for a card the model does not hold: a market that is not a CLOB market
 * with two outcomes, an event with none of those, or a kind of card added later.
 *
 * @throws {UnexpectedResponseError} When a market card has no market, or an event card has no
 *   event or no markets.
 * @internal
 */
export function toBrowseItem(raw: RawBrowseItem): BrowseItem | undefined {
  if (raw.kind === 'market') {
    if (raw.market === undefined) {
      throw unexpectedField('market', 'a market', 'backend');
    }
    const market = toListedMarket(raw.market);
    return market === undefined ? undefined : { kind: 'market', market };
  }
  if (raw.kind !== 'event') {
    return undefined;
  }
  const { event, markets: placements } = raw;
  if (event === undefined) {
    throw unexpectedField('event', 'an event', 'backend');
  }
  if (placements === undefined) {
    throw unexpectedField('markets', 'a list of markets', 'backend');
  }
  const markets: Market[] = [];
  for (const { market: row, groupTitle } of placements) {
    const market = toPlacedMarket(row, groupTitle);
    if (market !== undefined) {
      markets.push(market);
    }
  }
  if (markets.length === 0) {
    return undefined;
  }
  return {
    kind: 'event',
    event: {
      id: event.id,
      parentEventId: event.parentEventId,
      seriesId: event.seriesId,
      slug: event.slug,
      title: event.title,
      subtitle: event.subtitle,
      image: pictureOf(event.eventMedia, ['banner', 'hero']),
      endDate: raw.expiresAt ?? null,
      metrics: { volume: raw.totalVolumeInUSD ?? null },
      metadata: { ...event.metadata },
      markets,
    },
  };
}
