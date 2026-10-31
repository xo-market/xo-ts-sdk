import { afterAll, beforeAll, expect, test } from 'vitest';
import type { XoError } from '../src/core/errors';
import type { Market, SubscriptionHandle } from '../src/index';
import {
  assertEmptyWallet,
  describeLive,
  describeSignedIn,
  e2eClient,
  live,
  strictPublicClient,
  trackClients,
} from './setup';

// `subscribe` against the real mainnet sockets, with strict responses, so a field the services
// add, drop or type differently is reported as an error and fails the test. Both only
// subscribe: a socket receives snapshots and sends nothing else.
//
// - `activity` and `market` anonymously, on the busiest market: the backend's market activity
//   channel and the order book's market channel, alone and on one handle.
// - `portfolio` with ONE secure client of the e2e wallet's EOA: it mints a 1-day API key
//   (memory store), sends it in the handshake, and `close()` revokes it. The wallet holds
//   nothing, so the snapshot checks the envelope (an empty list of positions).
//
// No credential is printed.

/** The events of `handle` until `done` says enough, or the errors it reported, within `ms`. */
function collect<E extends { topic: string }>(
  handle: SubscriptionHandle<E>,
  ms: number,
  done: (events: E[]) => boolean,
): Promise<{ events: E[]; errors: XoError[] }> {
  const events: E[] = [];
  const errors: XoError[] = [];
  handle.on('error', (error) => {
    errors.push(error);
    console.error(`[e2e] ${error.code}: ${error.message}`);
  });
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ events, errors }), ms);
    void (async () => {
      for await (const event of handle) {
        events.push(event);
        if (done(events)) {
          clearTimeout(timer);
          resolve({ events, errors });
          return;
        }
      }
    })();
  });
}

describeLive('Live subscriptions on mainnet (strict, anonymous)', () => {
  const client = strictPublicClient();
  let market: Market;

  beforeAll(async () => {
    // The busiest market: its activity is not empty.
    const page = await live('listMarkets (setup)', () =>
      client.listMarkets({ sort: 'volume', pageSize: 1 }).firstPage(),
    );
    expect(page.items[0], 'mainnet has an active market').toBeDefined();
    market = page.items[0] as Market;
  });

  afterAll(async () => {
    await client.closeSubscriptions();
  });

  test('activity: an anonymous subscription on a live market receives a snapshot', async () => {
    const handle = await client.subscribe([
      { topic: 'activity', marketId: market.id },
    ]);
    try {
      const { events, errors } = await collect(
        handle,
        30_000,
        (e) => e.length > 0,
      );
      expect(errors.map((e) => e.code)).toEqual([]);
      const [event] = events;
      expect(event?.topic).toBe('activity');
      expect(event?.type).toBe('trades');
      expect(event?.marketId).toBe(market.id);
      console.info(
        `[e2e] activity snapshot for market ${market.id}: ${event?.trades.length} fill(s)`,
      );
    } finally {
      await handle.close();
    }
  });

  test('market: an anonymous subscription receives the book of each outcome token', async () => {
    const assetIds = [
      market.outcomes.yes.tokenId as string,
      market.outcomes.no.tokenId as string,
    ];
    const handle = await client.subscribe([{ topic: 'market', assetIds }]);
    try {
      const { events, errors } = await collect(handle, 30_000, (e) =>
        assetIds.every((id) =>
          e.some((event) => event.type === 'book' && event.assetId === id),
        ),
      );
      expect(errors.map((e) => e.code)).toEqual([]);
      for (const id of assetIds) {
        const book = events.find(
          (event) => event.type === 'book' && event.assetId === id,
        );
        expect(book, `a book snapshot for token ${id}`).toBeDefined();
        if (book?.type === 'book') {
          expect(book.market).toBe(market.conditionId);
          expect(book.hash.length).toBeGreaterThan(0);
        }
      }
    } finally {
      await handle.close();
    }
  });

  test('one handle merges the topics, and every event names its topic', async () => {
    const handle = await client.subscribe([
      { topic: 'activity', marketId: market.id },
      { topic: 'market', markets: [market.conditionId as string] },
    ]);
    try {
      const { events, errors } = await collect(handle, 30_000, (e) =>
        ['activity', 'market'].every((topic) =>
          e.some((event) => event.topic === topic),
        ),
      );
      expect(errors.map((e) => e.code)).toEqual([]);
      expect(new Set(events.map((event) => event.topic))).toEqual(
        new Set(['activity', 'market']),
      );
    } finally {
      await handle.close();
    }
  });

  test('a topic of the account needs a signed-in client, and nothing is opened', async () => {
    await expect(
      // @ts-expect-error `portfolio` is a topic of a secure client
      client.subscribe([{ topic: 'portfolio' }]),
    ).rejects.toMatchObject({ code: 'topic_needs_sign_in' });
  });
});

describeSignedIn('Live subscriptions on mainnet (strict, signed in)', () => {
  const clients = trackClients();

  beforeAll(async () => {
    const xo = await e2eClient();
    try {
      await assertEmptyWallet(xo);
    } finally {
      await xo.close();
    }
  });

  test('portfolio: the e2e wallet client connects with its key and receives a snapshot', async () => {
    const { client } = await clients.create();
    const handle = await client.subscribe([{ topic: 'portfolio' }]);
    try {
      const { events, errors } = await collect(
        handle,
        45_000,
        (e) => e.length > 0,
      );
      expect(errors.map((e) => e.code)).toEqual([]);
      const [event] = events;
      expect(event?.topic).toBe('portfolio');
      expect(event?.type).toBe('positions');
      // The wallet holds nothing.
      expect(event?.positions).toEqual([]);
    } finally {
      await handle.close();
    }
  });
});
