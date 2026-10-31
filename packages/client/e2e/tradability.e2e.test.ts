import { afterAll, beforeAll, expect, test } from 'vitest';
import { isRejected } from '../src/core/errors';
import { DataClient } from '../src/data/client';
import type { Market, MarketTradability, PublicClient } from '../src/index';
import {
  describeLive,
  env,
  type HttpCall,
  live,
  liveTransport,
  strictPublicClient,
} from './setup';

// `fetchMarketTradability` and the market joins against the real mainnet services, strict
// responses: the market, the order book market, the rewards programme and three read-only
// `eth_call`s per verdict.
//
// Public reads only: no credentials, no session, no signer, no writes. The test records every
// JSON-RPC method the run sent (a wrapper on the global `fetch`, which the read-only guard
// already sits behind) and asserts that each was `eth_call` and every HTTP call a GET or one
// of the order book's batch reads.
//
// Every market comes from the live data: the newest active markets for the tradable one, and
// the same scan, plus the oldest active markets past their end, for the ones that must FAIL a
// check while the order book reports them active. When mainnet has no such market right now,
// that test skips (and says so) instead of failing.

const SCAN = 10;

describeLive(
  'Live market tradability on mainnet (public reads, strict)',
  () => {
    const calls: HttpCall[] = [];
    const rpcMethods: string[] = [];
    // Made in beforeAll, after the global fetch is wrapped: the chain reader holds the fetch
    // it finds when it is made.
    let client: PublicClient;

    // Every JSON-RPC method sent while this file runs, read off the global fetch.
    const realFetch = globalThis.fetch;
    const recordRpc: typeof fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (
        url.href === new URL(env.rpcUrl).href &&
        typeof init?.body === 'string'
      ) {
        const body: unknown = JSON.parse(init.body);
        for (const item of Array.isArray(body) ? body : [body]) {
          rpcMethods.push((item as { method: string }).method);
        }
      }
      return realFetch(input, init);
    };

    let tradable: Market;
    const verdicts: Array<{ market: Market; verdict: MarketTradability }> = [];

    beforeAll(async () => {
      globalThis.fetch = recordRpc;
      client = strictPublicClient({ calls });
      // The newest active markets: the scan also looks for one that fails a check.
      const page = await live('listMarkets (scan)', () =>
        client.listMarkets({ sort: 'created', pageSize: SCAN }).firstPage(),
      );
      expect(page.items.length, 'mainnet has active markets').toBeGreaterThan(
        0,
      );
      for (const candidate of page.items) {
        const verdict = await live(
          `fetchMarketTradability(${candidate.id})`,
          () =>
            client.fetchMarketTradability({
              conditionId: candidate.conditionId as string,
            }),
        );
        verdicts.push({ market: candidate, verdict });
        if (verdict.ok && tradable === undefined) {
          tradable = candidate;
        }
      }
      const scanned = verdicts
        .map(
          ({ market, verdict }) =>
            `${market.id}: ${verdict.ok ? 'ok' : verdict.reasons.join(',')}`,
        )
        .join('; ');
      console.info(`[e2e] fetchMarketTradability scan: ${scanned}`);
      expect(
        tradable,
        `a tradable market among the newest ${SCAN} (scanned: ${scanned})`,
      ).toBeDefined();
    });

    afterAll(() => {
      globalThis.fetch = realFetch;
    });

    test('a tradable market: ok and no reasons, and the order book takes its orders', async () => {
      const verdict = await live('fetchMarketTradability', () =>
        client.fetchMarketTradability({
          conditionId: tradable.conditionId as string,
        }),
      );
      expect(verdict).toEqual({ ok: true, reasons: [] });
      const full = await live('fetchMarket', () =>
        client.fetchMarket({ conditionId: tradable.conditionId as string }),
      );
      expect(full.state.active).toBe(true);
      expect(full.state.acceptingOrders).toBe(true);
      expect(full.conditionId).toBe(tradable.conditionId);
      expect(full.outcomes.yes.tokenId).not.toBe(full.outcomes.no.tokenId);
    });

    test('the tokens and the tick size are the order book ones', async () => {
      const full = await live('fetchMarket', () =>
        client.fetchMarket({ conditionId: tradable.conditionId as string }),
      );
      for (const outcome of [full.outcomes.yes, full.outcomes.no]) {
        const book = await live('fetchOrderBook', () =>
          client.fetchOrderBook({ assetId: outcome.tokenId as string }),
        );
        expect(book.assetId).toBe(outcome.tokenId);
        expect(book.market).toBe(full.conditionId);
        expect(book.minimumTickSize).toBe(full.trading.minimumTickSize);
      }
    });

    test('the condition id in upper case reaches the same verdict', async () => {
      const lower = tradable.conditionId as string;
      const verdict = await live('fetchMarketTradability (upper case)', () =>
        client.fetchMarketTradability({
          conditionId: `0x${lower.slice(2).toUpperCase()}`,
        }),
      );
      expect(verdict).toEqual({ ok: true, reasons: [] });
    });

    test('a condition id XO does not know is a 404 rejection', async () => {
      const failure = await live('fetchMarketTradability (unknown)', () =>
        client
          .fetchMarketTradability({ conditionId: `0x${'0'.repeat(63)}1` })
          .then(
            () => undefined,
            (error: unknown) => error,
          ),
      );
      expect(isRejected(failure, 404)).toBe(true);
    });

    test('a market past its end that is still listed as active fails with expired', async (ctx) => {
      // The oldest active markets, filtered here by their end time: the backend does not filter
      // by expiry reliably.
      const now = Date.now();
      const listed = await live('listMarkets (oldest active)', () =>
        client
          .listMarkets({ sort: 'created', order: 'asc', pageSize: 50 })
          .firstPage(),
      );
      const expired = listed.items.filter((market) => {
        const at = Date.parse(market.state.endDate ?? '');
        return Number.isFinite(at) && at <= now;
      });
      for (const candidate of expired.slice(0, SCAN)) {
        let verdict: MarketTradability;
        try {
          verdict = await live(`fetchMarketTradability(${candidate.id})`, () =>
            client.fetchMarketTradability({
              conditionId: candidate.conditionId as string,
            }),
          );
        } catch (error) {
          // The order book no longer trades it: nothing to compare.
          if (isRejected(error, 404)) {
            continue;
          }
          throw error;
        }
        console.info(`[e2e] expired but listed active: market ${candidate.id}`);
        expect(verdict.ok).toBe(false);
        expect(verdict.reasons).toContain('expired');
        return;
      }
      console.warn(
        `[e2e] no market past its end is still listed as active (${expired.length} of the ${listed.items.length} oldest active markets are past it): skipped`,
      );
      ctx.skip();
    });

    test('a market the exchange does not know fails with not_registered_on_exchange', (ctx) => {
      const unregistered = verdicts.find(({ verdict }) =>
        verdict.reasons.includes('not_registered_on_exchange'),
      );
      if (unregistered === undefined) {
        console.warn(
          `[e2e] every one of the ${verdicts.length} scanned markets is registered on the exchange: skipped`,
        );
        ctx.skip();
        return;
      }
      console.info(
        `[e2e] unknown to the exchange: market ${unregistered.market.id}`,
      );
      expect(unregistered.verdict.ok).toBe(false);
    });

    test('a rewarded market carries its programme, as fetchMarketRewards reads it', async () => {
      const pools = await live('listRewardPools', () =>
        client.listRewardPools().firstPage(),
      );
      expect(pools.items.length, 'mainnet has reward pools').toBeGreaterThan(0);
      let checked = 0;
      for (const pool of pools.items) {
        if (pool.groupId !== null) {
          // A Pulse window is paid by its group; the market has no programme of its own.
          continue;
        }
        let full: Market;
        try {
          full = await live(`fetchMarket(${pool.conditionId})`, () =>
            client.fetchMarket({ conditionId: pool.conditionId }),
          );
        } catch (error) {
          // A pool market the order book no longer trades has nothing to compare.
          if (
            isRejected(error, 404) ||
            (error as { code?: string }).code === 'not_tradable_on_orderbook'
          ) {
            continue;
          }
          throw error;
        }
        const rewards = await live('fetchMarketRewards', () =>
          client.fetchMarketRewards({ conditionId: pool.conditionId }),
        );
        const joined = (full.rewards.clobRewards ?? []).map(
          (programme) => programme.currency,
        );
        expect(
          joined.length,
          `programmes of ${pool.conditionId}`,
        ).toBeGreaterThan(0);
        expect(new Set(joined)).toEqual(
          new Set(rewards.programmes.map((programme) => programme.currency)),
        );
        checked += 1;
        break;
      }
      expect(checked, 'a reward pool that resolves').toBe(1);
    });

    test('fetchMarket lists rewards programmes exactly when fetchMarketRewards does not answer 404', async () => {
      const full = await live('fetchMarket', () =>
        client.fetchMarket({ conditionId: tradable.conditionId as string }),
      );
      const programme = await client
        .fetchMarketRewards({ conditionId: tradable.conditionId as string })
        .catch((error: unknown) => {
          if (isRejected(error, 404)) {
            return undefined;
          }
          throw error;
        });
      expect(full.rewards.clobRewards !== null).toBe(true);
      expect((full.rewards.clobRewards ?? []).length > 0).toBe(
        programme !== undefined,
      );
    });

    test('older market kinds are not tradable on the order book', async () => {
      // A lookup through the data engine, the only reader that lists the kinds the SDK leaves out.
      const data = new DataClient({
        transport: liveTransport(),
        strictResponses: true,
      });
      for (const marketType of [0, 1] as const) {
        const [legacy] = await live(`legacy list ${marketType}`, () =>
          data.markets.list({ marketType, take: 1 }).toArray(1),
        );
        if (legacy === undefined) {
          console.warn(
            `[e2e] mainnet has no type ${marketType} market: skipped`,
          );
          continue;
        }
        for (const request of [
          { id: String(legacy.id) },
          { slug: legacy.slug },
        ]) {
          const error = await client
            .fetchMarket(request)
            .catch((e: unknown) => e);
          expect(
            error,
            `fetchMarket(${Object.keys(request)[0]})`,
          ).toMatchObject({
            code: 'not_tradable_on_orderbook',
          });
        }
      }
    });

    test('only public reads were made: GETs, the order book batch reads, and eth_call', () => {
      expect(calls.length).toBeGreaterThan(0);
      const reads = new Set([
        '/books',
        '/midpoints',
        '/prices',
        '/spreads',
        '/last-trades-prices',
      ]);
      for (const call of calls) {
        expect(['backend', 'orderbook']).toContain(call.service);
        expect(
          call.method === 'GET' ||
            (call.method === 'POST' && reads.has(call.path)),
          `${call.method} ${call.path}`,
        ).toBe(true);
      }
      expect(rpcMethods.length).toBeGreaterThan(0);
      expect(new Set(rpcMethods)).toEqual(new Set(['eth_call']));
    });
  },
);
