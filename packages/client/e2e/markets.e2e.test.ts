import { beforeAll, describe, expect, test } from 'vitest';
import { isRejected, XoError } from '../src/core/errors';
import type { Event, Market, PulseStats, Series } from '../src/index';
import { describeLive, live, liveTransport, strictPublicClient } from './setup';

// The market reads of the public client against the real mainnet services, read-only and with
// no credentials. The client is strictPublicClient (the public client's own actions on engines
// with strict responses), so a field the services add, drop or type differently fails the call.
// Ids, slugs and tokens come from earlier responses. Only GETs are made, a few dozen in all.
//
// A call that fails prints its label and the schema issues (paths and zod messages, never the
// values) before the test fails.

const DECIMAL = /^\d+(\.\d+)?$/;

/** A price above 0, or `null` for none: never the order book's `"0.000"`. */
const priceOrNone = (value: string | null): boolean =>
  value === null || (DECIMAL.test(value) && Number(value) > 0);
const HEX_64 = /^0x[0-9a-f]{64}$/;
const TOKEN = /^[0-9]{1,78}$/;

describeLive('Live markets, events and the catalog on mainnet (strict)', () => {
  const client = strictPublicClient();

  let market: Market;
  let event: Event;
  let series: Series;

  beforeAll(async () => {
    // The busiest market: its book and trades are not empty.
    const page = await live('listMarkets (setup)', () =>
      client.listMarkets({ sort: 'volume', pageSize: 10 }).firstPage(),
    );
    expect(page.items.length, 'mainnet has active markets').toBeGreaterThan(0);
    market = page.items[0] as Market;

    const events = await live('listEvents (setup)', () =>
      client.listEvents({ pageSize: 20 }).firstPage(),
    );
    expect(events.items.length, 'mainnet has events').toBeGreaterThan(0);
    event = events.items[0] as Event;

    const allSeries = await live('listSeries (setup)', () =>
      client.listSeries().firstPage(),
    );
    expect(allSeries.items.length, 'mainnet has series').toBeGreaterThan(0);
    series = allSeries.items[0] as Series;
  });

  describe('markets', () => {
    test('listMarkets lists open markets by default, and paginates', async () => {
      const seen: string[] = [];
      let pages = 0;
      for await (const page of client.listMarkets({ pageSize: 3 })) {
        pages += 1;
        expect(page.items.length).toBeGreaterThan(0);
        expect(page.items.length).toBeLessThanOrEqual(3);
        for (const row of page.items) {
          expect(row.state.active).toBe(true);
          expect(row.state.closed).toBe(false);
          seen.push(row.id);
        }
        // Two pages are enough to see the pagination work.
        if (pages === 2) {
          break;
        }
      }
      expect(pages).toBe(2);
      expect(new Set(seen).size, 'no market on both pages').toBe(seen.length);
    });

    test('listMarkets: closed and resolved markets, every sort, a category and endAfter', async () => {
      for (const status of ['closed', 'resolved'] as const) {
        const page = await live(`listMarkets (${status})`, () =>
          client.listMarkets({ status, pageSize: 5 }).firstPage(),
        );
        for (const row of page.items) {
          if (status === 'resolved') {
            // A decided market is RESOLVED, then CLOSED for good.
            expect(['RESOLVED', 'CLOSED']).toContain(row.state.status);
            expect(row.state.closed).toBe(true);
          } else {
            // Past its end time with no outcome yet: XO still reads it ACTIVE.
            expect(row.state.status).toBe('ACTIVE');
            expect(row.state.closed).toBe(false);
            expect(row.state.endDate).not.toBeNull();
            expect(Date.parse(row.state.endDate ?? '')).toBeLessThanOrEqual(
              Date.now(),
            );
          }
        }
      }
      for (const sort of [
        'volume',
        'created',
        'endDate',
        'liquidity',
      ] as const) {
        for (const order of ['asc', 'desc'] as const) {
          const page = await live(`listMarkets (${sort} ${order})`, () =>
            client.listMarkets({ sort, order, pageSize: 3 }).firstPage(),
          );
          expect(page.items.length, `${sort} ${order}`).toBeGreaterThan(0);
        }
      }
      if (market.category !== null) {
        const category = market.category;
        const page = await live('listMarkets (category)', () =>
          client.listMarkets({ category, pageSize: 5 }).firstPage(),
        );
        for (const row of page.items) {
          expect(row.category?.toLowerCase()).toBe(category.toLowerCase());
        }
      }
      const later = await live('listMarkets (endAfter)', () =>
        client
          .listMarkets({ endAfter: new Date(Date.now() + 1000), pageSize: 5 })
          .firstPage(),
      );
      for (const row of later.items) {
        expect(Date.parse(row.state.endDate ?? '')).toBeGreaterThan(Date.now());
      }
    });

    test('listBrowseItems: markets that stand alone and events with their markets', async () => {
      for (const sort of ['trending', 'volume'] as const) {
        const page = await live(`listBrowseItems (${sort})`, () =>
          client.listBrowseItems({ sort, pageSize: 10 }).firstPage(),
        );
        expect(page.items.length).toBeGreaterThan(0);
        for (const item of page.items) {
          expect(['market', 'event']).toContain(item.kind);
          if (item.kind === 'event') {
            expect(item.event.markets.length).toBeGreaterThan(0);
          } else {
            expect(item.market.conditionId).toMatch(HEX_64);
          }
        }
      }
    });

    test('fetchMarket by id, slug, link and condition id returns the same market', async () => {
      const byId = await live('fetchMarket (id)', () =>
        client.fetchMarket({ id: market.id }),
      );
      expect(byId.id).toBe(market.id);
      expect(byId.conditionId).toBe(market.conditionId);
      expect(byId.outcomes.yes.tokenId).toBe(market.outcomes.yes.tokenId);
      expect(byId.trading.minimumTickSize).toMatch(DECIMAL);
      expect(byId.outcomes.yes.tokenId).toMatch(TOKEN);
      expect(byId.outcomes.no.tokenId).toMatch(TOKEN);
      for (const request of [
        { slug: market.slug },
        { url: `https://xo.market/markets/${market.slug}` },
        { conditionId: market.conditionId as string },
      ]) {
        const same = await live(
          `fetchMarket (${Object.keys(request)[0]})`,
          () => client.fetchMarket(request),
        );
        expect(same.id).toBe(market.id);
        expect(same.slug).toBe(market.slug);
      }
    });

    test('fetchMarket: a market XO does not have is a 404 rejection', async () => {
      const failure = await live('fetchMarket (unknown)', () =>
        client.fetchMarket({ conditionId: `0x${'0'.repeat(63)}1` }).then(
          () => undefined,
          (error: unknown) => error,
        ),
      );
      expect(isRejected(failure, 404)).toBe(true);
    });
  });

  describe('events and series', () => {
    test('listEvents, fetchEvent by id and slug, and the markets of an event', async () => {
      const byId = await live('fetchEvent (id)', () =>
        client.fetchEvent({ id: event.id }),
      );
      expect(byId.id).toBe(event.id);
      expect(Array.isArray(byId.markets)).toBe(true);
      for (const row of byId.markets ?? []) {
        expect(row.conditionId).toMatch(HEX_64);
      }
      const bySlug = await live('fetchEvent (slug)', () =>
        client.fetchEvent({ slug: event.slug }),
      );
      expect(bySlug.id).toBe(event.id);
      // An event's markets, from the market list.
      const markets = await live('listMarkets (eventId)', () =>
        client
          .listMarkets({ eventId: event.id, status: 'active', pageSize: 5 })
          .firstPage(),
      );
      expect(Array.isArray(markets.items)).toBe(true);
    });

    test('listSubevents lists the sub-events of an event on one page', async () => {
      const page = await live('listSubevents', () =>
        client.listSubevents({ eventId: event.id }).firstPage(),
      );
      expect(Array.isArray(page.items)).toBe(true);
      expect(page.hasMore).toBe(false);
      for (const sub of page.items) {
        expect(sub.parentEventId).toBe(event.id);
      }
    });

    test('listSeries, fetchSeries by id and slug, and the events and markets of a series', async () => {
      const byId = await live('fetchSeries (id)', () =>
        client.fetchSeries({ id: series.id }),
      );
      expect(byId.id).toBe(series.id);
      const bySlug = await live('fetchSeries (slug)', () =>
        client.fetchSeries({ slug: series.slug }),
      );
      expect(bySlug.id).toBe(series.id);
      const events = await live('listEvents (seriesId)', () =>
        client.listEvents({ seriesId: series.id, pageSize: 5 }).firstPage(),
      );
      for (const row of events.items) {
        expect(row.seriesId).toBe(series.id);
      }
      const markets = await live('listMarkets (seriesId)', () =>
        client
          .listMarkets({ seriesId: series.id, status: 'active', pageSize: 5 })
          .firstPage(),
      );
      expect(Array.isArray(markets.items)).toBe(true);
    });
  });

  describe('the catalog', () => {
    test('categories and subcategories', async () => {
      const categories = await live('listCategories', () =>
        client.listCategories().firstPage(),
      );
      expect(categories.items.length).toBeGreaterThan(0);
      const categoryId = (categories.items[0] as { id: string }).id;
      const overview = await live('listSubcategories', () =>
        client.listSubcategories().firstPage(),
      );
      expect(overview.items.length).toBeGreaterThan(0);
      const ofCategory = await live('listSubcategories (categoryId)', () =>
        client.listSubcategories({ categoryId }).firstPage(),
      );
      for (const sub of ofCategory.items) {
        expect(sub.categoryId).toBe(categoryId);
      }
    });

    test('collateral tokens', async () => {
      const tokens = await live('fetchCollateralTokens', () =>
        client.fetchCollateralTokens(),
      );
      expect(tokens.length).toBeGreaterThan(0);
      for (const token of tokens) {
        expect(token.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(Number.isInteger(token.decimals)).toBe(true);
      }
    });

    test('pulse rounds and their statistics', async () => {
      const page = await live('listPulseMarkets', () =>
        client.listPulseMarkets({ pageSize: 5 }).firstPage(),
      );
      expect(page.items.length, 'mainnet has pulse rounds').toBeGreaterThan(0);
      for (const round of page.items) {
        expect(round.conditionId).toMatch(HEX_64);
        expect(round.endDate).toBeTypeOf('string');
      }
      // The statistics are computed on demand: when the backend's cache is cold it answers 500
      // after about 10 seconds, the SDK does not retry a 500, and the next read is served. Ask
      // again, up to three times.
      let stats: PulseStats | undefined;
      for (let attempt = 1; stats === undefined; attempt += 1) {
        try {
          stats = await live('fetchPulseStats', () => client.fetchPulseStats());
        } catch (error) {
          if (!isRejected(error, 500) || attempt === 3) {
            throw error;
          }
        }
      }
      expect(stats.volume).toMatch(DECIMAL);
      expect(typeof stats.tradeCount).toBe('number');
    });
  });

  describe('prices, books and trades', () => {
    test('order books, midpoints, prices and spreads of the outcome tokens', async () => {
      const yes = market.outcomes.yes.tokenId as string;
      const no = market.outcomes.no.tokenId as string;
      const assetIds = [yes, no];

      const books = await live('fetchOrderBooks', () =>
        client.fetchOrderBooks({ assetIds }),
      );
      expect(books.map((book) => book.assetId).sort()).toEqual(
        [...assetIds].sort(),
      );
      for (const book of books) {
        expect(book.market).toBe(market.conditionId);
      }

      // A price that does not exist (a side of the book is empty) is null, never "0.000".
      const midpoint = await live('fetchMidpoint', () =>
        client.fetchMidpoint({ assetId: yes }),
      );
      expect(priceOrNone(midpoint)).toBe(true);
      const midpoints = await live('fetchMidpoints', () =>
        client.fetchMidpoints({ assetIds }),
      );
      expect(Object.keys(midpoints).sort()).toEqual([...assetIds].sort());
      for (const value of Object.values(midpoints)) {
        expect(priceOrNone(value)).toBe(true);
      }

      const buy = await live('fetchPrice (BUY)', () =>
        client.fetchPrice({ assetId: yes, side: 'BUY' }),
      );
      expect(priceOrNone(buy)).toBe(true);
      const prices = await live('fetchPrices', () =>
        client.fetchPrices({
          requests: [
            { assetId: yes, side: 'BUY' },
            { assetId: yes, side: 'SELL' },
            { assetId: no, side: 'BUY' },
          ],
        }),
      );
      expect(Object.keys(prices).sort()).toEqual([...assetIds].sort());
      expect(Object.keys(prices[yes] ?? {}).sort()).toEqual(['BUY', 'SELL']);
      expect(priceOrNone(prices[yes]?.SELL ?? null)).toBe(true);

      const spread = await live('fetchSpread', () =>
        client.fetchSpread({ assetId: yes }),
      );
      expect(spread === null || DECIMAL.test(spread)).toBe(true);
      const spreads = await live('fetchSpreads', () =>
        client.fetchSpreads({ assetIds }),
      );
      expect(Object.keys(spreads).sort()).toEqual([...assetIds].sort());
      for (const value of Object.values(spreads)) {
        expect(value === null || DECIMAL.test(value)).toBe(true);
      }
    });

    test('last trade prices, price history, the trading state and the conviction view', async () => {
      const yes = market.outcomes.yes.tokenId as string;
      const last = await live('fetchLastTradePrice', () =>
        client.fetchLastTradePrice({ assetId: yes }),
      );
      if (last !== null) {
        expect(last.price).toMatch(DECIMAL);
        expect(['BUY', 'SELL']).toContain(last.side);
      }
      const lasts = await live('fetchLastTradePrices', () =>
        client.fetchLastTradePrices({
          assetIds: [yes, market.outcomes.no.tokenId as string],
        }),
      );
      expect(Array.isArray(lasts)).toBe(true);

      const history = await live('listPriceHistory', () =>
        client.listPriceHistory({ assetId: yes, interval: '1w' }).firstPage(),
      );
      let previous = 0;
      for (const point of history.items) {
        expect(point.price).toMatch(DECIMAL);
        expect(point.timestamp).toBeGreaterThanOrEqual(previous);
        previous = point.timestamp;
      }

      const state = await live('fetchTradingState', () =>
        client.fetchTradingState(),
      );
      expect(['active', 'paused']).toContain(state);

      const conviction = await live('fetchConvictionMarket', () =>
        client.fetchConvictionMarket({
          conditionId: market.conditionId as string,
        }),
      );
      expect(conviction.conditionId).toBe(market.conditionId);
    });

    test('listTrades: the fills of a market, newest first, and by side', async () => {
      const ofMarket = await live('listTrades (marketId)', () =>
        client.listTrades({ marketId: market.id, pageSize: 10 }).firstPage(),
      );
      expect(
        ofMarket.items.length,
        'the busiest market has fills',
      ).toBeGreaterThan(0);
      for (const trade of ofMarket.items) {
        // The fills of a market name it when the feed does.
        if (trade.marketId !== null) {
          expect(trade.marketId).toBe(market.id);
        }
        expect(trade.size).toMatch(DECIMAL);
        expect(['BUY', 'SELL']).toContain(trade.side);
      }
      const times = ofMarket.items.map((trade) => Date.parse(trade.timestamp));
      expect(times).toEqual([...times].sort((a, b) => b - a));

      const sells = await live('listTrades (marketId, SELL)', () =>
        client
          .listTrades({ marketId: market.id, side: 'SELL', pageSize: 5 })
          .firstPage(),
      );
      for (const trade of sells.items) {
        expect(trade.side).toBe('SELL');
      }
    });
  });

  describe('boolean query params', () => {
    // The backend checks some flags as booleans without converting the text, so a flag sent as
    // the text "true" or "false" can be a 400. Every flag the public client sends on these
    // reads is checked here, true and false.
    test('every boolean the reads send is accepted by the backend, true and false', async () => {
      for (const value of [true, false]) {
        const label = `booleans (${value})`;
        await live(`listEvents ${label}`, () =>
          client
            .listEvents({
              seriesId: series.id,
              withMarkets: value,
              pageSize: 1,
            })
            .firstPage(),
        );
        await live(`listSeries ${label}`, () =>
          client.listSeries({ active: value }).firstPage(),
        );
      }
    });

    test('GET /v1/events/:eventId/activity (not offered by the SDK) refuses includeSubEvents, true and false', async () => {
      // The backend checks the flag as a boolean but receives it as text, so any value is a 400
      // today. This documents it for the day the backend fixes it: this test then fails, and
      // the route can be added.
      for (const value of ['true', 'false']) {
        const failure = await live(`events activity (${value})`, async () =>
          liveTransport()
            .request({
              service: 'backend',
              method: 'GET',
              path: `/api/v1/events/${event.id}/activity`,
              query: { take: 1, includeSubEvents: value },
              auth: 'none',
            })
            .then(
              () => undefined,
              (error: unknown) => error,
            ),
        );
        expect(failure, value).toBeInstanceOf(XoError);
        expect((failure as XoError).status).toBe(400);
      }
    });
  });
});
