import { beforeAll, describe, expect, test } from 'vitest';
import {
  createPublicClient,
  isPublicClient,
  isSecureClient,
  type Market,
  RequestAbortedError,
} from '../src/index';
import {
  assertEmptyWallet,
  describeLive,
  describeSignedIn,
  e2eClient,
  type HttpCall,
  live,
  liveFetch,
  revokeSucceeded,
  statusOf,
  strictPublicClient,
  trackClients,
} from './setup';

// The two clients against the real mainnet services, read-only.
//
// - `createPublicClient()` with no credentials: the first page of `listMarkets`, then
//   `fetchMarket` of its first row and `fetchOrderBook` of its YES token. The strict client
//   (strictPublicClient: the same actions on engines with strict responses) fails on a field the
//   services add, drop or type differently; the plain `createPublicClient()` is run on the same
//   reads to show the shipped client works as it is, and with the per-call options.
// - `createSecureClient` with the e2e wallet (XO_E2E_WALLET_PK): it signs in, `listOpenOrders`
//   parses, and `close()` revokes the 1-day key it minted. The wallet holds nothing and never
//   trades.
//
// No credential is printed.

const HEX_64 = /^0x[0-9a-f]{64}$/;
const DECIMAL = /^\d+(\.\d+)?$/;

/** The first market of the first page of `listMarkets`, which is what a list row carries. */
async function firstMarket(client: {
  listMarkets: (request: { pageSize: number }) => {
    firstPage(): Promise<{ items: Market[] }>;
  };
}): Promise<Market> {
  const page = await live('listMarkets (first page)', () =>
    client.listMarkets({ pageSize: 5 }).firstPage(),
  );
  const [market] = page.items;
  expect(market, 'mainnet has an active market').toBeDefined();
  return market as Market;
}

describeLive('Live public client on mainnet (no credentials)', () => {
  describe('strict responses', () => {
    const calls: HttpCall[] = [];
    const client = strictPublicClient({ calls });
    let market: Market;

    beforeAll(async () => {
      market = await firstMarket(client);
    });

    test('listMarkets: the first page parses strictly, and a list row leaves the joined fields null', async () => {
      const page = await live('listMarkets', () =>
        client.listMarkets({ pageSize: 5 }).firstPage(),
      );
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.length).toBeLessThanOrEqual(5);
      for (const row of page.items) {
        expect(row.state.active).toBe(true);
        expect(row.conditionId).toMatch(HEX_64);
        expect(row.outcomes.yes.tokenId).toMatch(/^[0-9]+$/);
        expect(row.outcomes.no.tokenId).toMatch(/^[0-9]+$/);
        // The order book, the fee policy and the rewards are not read for a list row.
        expect(row.trading.minimumTickSize).toBeNull();
        expect(row.trading.feesEnabled).toBeNull();
        expect(row.rewards.clobRewards).toBeNull();
      }
      expect(statusOf(calls, 'GET', 'backend', '/api/markets')).toBe(200);
    });

    test('listMarkets: a cursor carries on with the next page', async () => {
      const markets = client.listMarkets({ pageSize: 3 });
      const first = await live('listMarkets (page 1)', () =>
        markets.firstPage(),
      );
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toBeTypeOf('string');
      const second = await live('listMarkets (page 2)', () =>
        markets.from(first.nextCursor).firstPage(),
      );
      expect(second.items.length).toBeGreaterThan(0);
      const ids = new Set([...first.items, ...second.items].map((m) => m.id));
      expect(ids.size, 'no market is on both pages').toBe(
        first.items.length + second.items.length,
      );
    });

    test('fetchMarket of the first row: the order book, fees and rewards are joined', async () => {
      const full = await live('fetchMarket', () =>
        client.fetchMarket({ id: market.id }),
      );
      expect(full.id).toBe(market.id);
      expect(full.conditionId).toBe(market.conditionId);
      expect(full.trading.minimumTickSize).not.toBeNull();
      expect(full.trading.minimumTickSize).toMatch(DECIMAL);
      expect(full.trading.minimumOrderSize).toMatch(DECIMAL);
      expect(typeof full.trading.feesEnabled).toBe('boolean');
      expect(full.state.acceptingOrders).not.toBeNull();
      expect(full.rewards.clobRewards).not.toBeNull();
      expect(full.outcomes.yes.tokenId).toBe(market.outcomes.yes.tokenId);
    });

    test('fetchOrderBook of the YES token parses, and lists the best price last', async () => {
      const assetId = market.outcomes.yes.tokenId as string;
      const book = await live('fetchOrderBook', () =>
        client.fetchOrderBook({ assetId }),
      );
      expect(book.assetId).toBe(assetId);
      expect(book.market).toBe(market.conditionId);
      expect(book.minimumTickSize).toMatch(DECIMAL);
      const bids = book.bids.map((level) => Number(level.price));
      const asks = book.asks.map((level) => Number(level.price));
      expect(bids).toEqual([...bids].sort((a, b) => a - b));
      expect(asks).toEqual([...asks].sort((a, b) => b - a));
      for (const level of [...book.bids, ...book.asks]) {
        expect(level.price).toMatch(DECIMAL);
        expect(level.size).toMatch(DECIMAL);
      }
      expect(statusOf(calls, 'GET', 'orderbook', '/book')).toBe(200);
    });

    test('a read leaves no write on the wire', () => {
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.method).toBe('GET');
      }
    });
  });

  describe('createPublicClient()', () => {
    const calls: HttpCall[] = [];
    const client = createPublicClient({ fetch: liveFetch(calls) });

    test('is a public client, and reads a market, its order book and the trading state', async () => {
      expect(isPublicClient(client)).toBe(true);
      expect(isSecureClient(client)).toBe(false);
      const market = await firstMarket(client);
      const full = await live('fetchMarket', () =>
        client.fetchMarket({ conditionId: market.conditionId as string }),
      );
      expect(full.trading.minimumTickSize).not.toBeNull();
      const book = await live('fetchOrderBook', () =>
        client.fetchOrderBook({ assetId: full.outcomes.yes.tokenId as string }),
      );
      expect(book.market).toBe(full.conditionId);
      const state = await live('fetchTradingState', () =>
        client.fetchTradingState(),
      );
      expect(['active', 'paused']).toContain(state);
      for (const call of calls) {
        expect(call.method).toBe('GET');
        // A market with no rewards programme answers 404 there; every other read is a 200.
        const noProgramme =
          call.status === 404 && call.path.includes('liquidity-rewards');
        expect(call.status === 200 || noProgramme, JSON.stringify(call)).toBe(
          true,
        );
      }
    });

    test('per-call options: a signal that is aborted stops the read, retries and timeout are accepted', async () => {
      const controller = new AbortController();
      controller.abort();
      const aborted = await client
        .listMarkets({ pageSize: 1 }, { signal: controller.signal })
        .firstPage()
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(aborted).toBeInstanceOf(RequestAbortedError);

      const page = await live('listMarkets (options)', () =>
        client
          .listMarkets({ pageSize: 1 }, { timeout: 20_000, retries: 1 })
          .firstPage(),
      );
      expect(page.items).toHaveLength(1);
    });

    test('a request that is not valid throws before anything is sent', async () => {
      const before = calls.length;
      await expect(
        client.fetchOrderBook({ assetId: 'not a token' }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
      expect(calls.length).toBe(before);
    });
  });
});

describeSignedIn('Live secure client on mainnet (the e2e wallet)', () => {
  const clients = trackClients();

  beforeAll(async () => {
    const xo = await e2eClient();
    try {
      await assertEmptyWallet(xo);
    } finally {
      await xo.close();
    }
  });

  test('signs in, listOpenOrders parses (the wallet has none), and close() revokes the 1-day key', async () => {
    const { client, calls } = await clients.create();
    expect(isSecureClient(client)).toBe(true);
    expect(isPublicClient(client)).toBe(false);
    expect(client.wallet).toMatch(/^0x[0-9a-fA-F]{40}$/);

    const orders = await live('listOpenOrders', () =>
      client.listOpenOrders().firstPage(),
    );
    expect(orders.items).toEqual([]);
    expect(orders.hasMore).toBe(false);
    expect(statusOf(calls, 'GET', 'orderbook', '/data/orders')).toBe(200);

    // The same client reads the public data too.
    const market = await firstMarket(client);
    expect(market.conditionId).toMatch(HEX_64);

    await client.close();
    expect(revokeSucceeded(calls)).toEqual([true]);
  });

  test('exportCredentials gives the keys without printing them, and a second client reuses them', async () => {
    const first = await clients.create();
    const credentials = await first.client.exportCredentials();
    // Booleans only: a failure must not show a key in a diff.
    expect(credentials.backend.apiKey.startsWith('xo_sk_data_')).toBe(true);
    expect(
      [
        credentials.orderbook.apiKey,
        credentials.orderbook.secret,
        credentials.orderbook.passphrase,
      ].every((part) => part.length > 0),
    ).toBe(true);

    const second = await clients.create({ credentials });
    expect(second.client.wallet).toBe(first.client.wallet);
    // The credentials were given, not signed in for: no key was minted, and none is revoked.
    expect(
      second.calls.some(
        (call) =>
          call.method === 'POST' &&
          call.service === 'backend' &&
          call.path === '/api/auth/api-keys',
      ),
    ).toBe(false);
    const orders = await live('listOpenOrders (reused)', () =>
      second.client.listOpenOrders().firstPage(),
    );
    expect(orders.items).toEqual([]);
    await second.client.close();
    expect(revokeSucceeded(second.calls)).toEqual([]);
    await first.client.close();
    expect(revokeSucceeded(first.calls)).toEqual([true]);
  });
});
