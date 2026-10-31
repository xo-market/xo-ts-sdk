import { generatePrivateKey } from 'viem/accounts';
import { describe, expect, test } from 'vitest';
import { Session } from '../../src/auth/session';
import { BridgeClient } from '../../src/bridge/client';
import { Clock } from '../../src/core/clock';
import { RequestRejectedError } from '../../src/core/errors';
import type { CallOptions } from '../../src/core/requestOptions';
import type { Transport, TransportRequest } from '../../src/core/transport';
import { DataClient } from '../../src/data/client';
import { OrderbookClient } from '../../src/orderbook/client';
import { keySigner } from '../helpers/signers';
import { testEnv, testEnvWithBridge } from '../helpers/testEnv';

// Every read of the engines hands its per-call options down to `Transport.request`, on every
// request it makes (each page of a list, each step of a reconcile). A recording transport
// stands in for the network: it keeps each request and then fails it, so a read stops after
// its first request unless `answer` says otherwise.

const CALL: CallOptions = Object.freeze({ timeoutMs: 1_234, retries: 1 });
const STOP = new Error('recorded');

const CONDITION = `0x${'ab'.repeat(32)}`;
const HASH = `0x${'cd'.repeat(32)}`;
const GROUP = `0x${'ef'.repeat(32)}`;
const ADDRESS = `0x${'12'.repeat(20)}`;
const UUID = '0b0f6c2a-3c1d-4e5f-8a9b-0c1d2e3f4a5b';
const TOKEN = '12345';
const EPOCH = 20_000;

interface Recorder {
  transport: Transport;
  requests: TransportRequest[];
}

function recorder(
  answer: (o: TransportRequest) => unknown = () => {
    throw STOP;
  },
): Recorder {
  const requests: TransportRequest[] = [];
  const fake = {
    async request(o: TransportRequest): Promise<unknown> {
      requests.push(o);
      return answer(o);
    },
  };
  return { transport: fake as unknown as Transport, requests };
}

/** Runs a read (a promise, or a paginator's first page) until it stops. */
async function run(read: unknown): Promise<void> {
  const pending =
    typeof read === 'object' &&
    read !== null &&
    'firstPage' in read &&
    typeof read.firstPage === 'function'
      ? (read.firstPage() as Promise<unknown>)
      : (read as Promise<unknown>);
  await pending.catch((error: unknown) => {
    if (error !== STOP) {
      throw error;
    }
  });
}

function expectThreaded(r: Recorder, name: string): void {
  expect(r.requests.length, name).toBeGreaterThan(0);
  for (const request of r.requests) {
    expect(request.call, `${name}: ${request.method} ${request.path}`).toBe(
      CALL,
    );
  }
}

describe('the data client', () => {
  const r = recorder();
  const d = new DataClient({ transport: r.transport });

  const reads: [string, () => unknown][] = [
    ['markets.list', () => d.markets.list(undefined, CALL)],
    ['markets.browse', () => d.markets.browse(undefined, CALL)],
    ['markets.get', () => d.markets.get(1, CALL)],
    ['markets.bySlug', () => d.markets.bySlug('a-market', CALL)],
    ['markets.byContract', () => d.markets.byContract(CONDITION, CALL)],
    ['markets.priceHistory', () => d.markets.priceHistory(1, CALL)],
    ['markets.statuses', () => d.markets.statuses(1, CALL)],
    ['markets.activity', () => d.markets.activity(1, undefined, CALL)],
    ['markets.allActivity', () => d.markets.allActivity(undefined, CALL)],
    ['markets.feeConfig', () => d.markets.feeConfig(CONDITION, CALL)],
    ['markets.tradingStatus', () => d.markets.tradingStatus(CALL)],
    ['markets.pulseStats', () => d.markets.pulseStats(undefined, CALL)],
    ['events.list', () => d.events.list(undefined, CALL)],
    ['events.get', () => d.events.get(UUID, CALL)],
    ['events.bySlug', () => d.events.bySlug('an-event', CALL)],
    ['events.markets', () => d.events.markets(UUID, undefined, CALL)],
    ['events.subevents', () => d.events.subevents(UUID, CALL)],
    ['series.list', () => d.series.list(undefined, CALL)],
    ['series.get', () => d.series.get(UUID, CALL)],
    ['series.bySlug', () => d.series.bySlug('a-series', CALL)],
    ['series.markets', () => d.series.markets(UUID, undefined, CALL)],
    ['pulse.list', () => d.pulse.list(undefined, CALL)],
    ['pulse.batch', () => d.pulse.batch([ADDRESS], CALL)],
    ['pulse.get', () => d.pulse.get(ADDRESS, CALL)],
    ['taxonomy.categories', () => d.taxonomy.categories(undefined, CALL)],
    ['taxonomy.subcategories', () => d.taxonomy.subcategories(undefined, CALL)],
    [
      'taxonomy.subcategories (pages)',
      () => d.taxonomy.subcategories({ page: 1 }, CALL),
    ],
    ['taxonomy.tokens', () => d.taxonomy.tokens(CALL)],
    ['portfolio.mine', () => d.portfolio.mine(undefined, CALL)],
    ['portfolio.mine (detail)', () => d.portfolio.mine({ marketId: 1 }, CALL)],
    ['portfolio.value', () => d.portfolio.value(undefined, CALL)],
    ['portfolio.redeemable', () => d.portfolio.redeemable(undefined, CALL)],
    [
      'portfolio.claimableMarkets',
      () => d.portfolio.claimableMarkets(undefined, CALL),
    ],
    ['portfolio.openOrders', () => d.portfolio.openOrders(undefined, CALL)],
    [
      'portfolio.ofWallet',
      () => d.portfolio.ofWallet({ wallet: ADDRESS }, undefined, CALL),
    ],
    ['pnl.summary', () => d.pnl.summary(undefined, CALL)],
    ['pnl.market', () => d.pnl.market(1, CALL)],
    ['pnl.position', () => d.pnl.position(1, CALL)],
    ['activity.mine', () => d.activity.mine(undefined, CALL)],
    [
      'activity.marketActivities',
      () => d.activity.marketActivities(undefined, CALL),
    ],
    ['activity.stats', () => d.activity.stats(CALL)],
    ['account.me', () => d.account.me(CALL)],
    ['account.apiKeys', () => d.account.apiKeys(CALL)],
    ['profiles.get', () => d.profiles.get('alice', CALL)],
    ['profiles.stats', () => d.profiles.stats('alice', CALL)],
    ['rewards.earningPools', () => d.rewards.earningPools(CALL)],
    ['rewards.groups', () => d.rewards.groups(undefined, CALL)],
    ['rewards.group', () => d.rewards.group(GROUP, CALL)],
    ['rewards.marketConfig', () => d.rewards.marketConfig(CONDITION, CALL)],
    ['rewards.market', () => d.rewards.market(CONDITION, CALL)],
    [
      'rewards.marketEpoch',
      () => d.rewards.marketEpoch(CONDITION, EPOCH, CALL),
    ],
    [
      'rewards.marketEpochMakers',
      () => d.rewards.marketEpochMakers(CONDITION, EPOCH, undefined, CALL),
    ],
    [
      'rewards.marketEpochOrders',
      () => d.rewards.marketEpochOrders(CONDITION, EPOCH, undefined, CALL),
    ],
    [
      'rewards.marketWallet',
      () => d.rewards.marketWallet(CONDITION, ADDRESS, undefined, CALL),
    ],
    ['rewards.wallet', () => d.rewards.wallet(ADDRESS, CALL)],
    ['rewards.walletEpoch', () => d.rewards.walletEpoch(ADDRESS, EPOCH, CALL)],
    [
      'rewards.walletOrders',
      () => d.rewards.walletOrders(ADDRESS, undefined, CALL),
    ],
    ['rewards.mySummary', () => d.rewards.mySummary(CALL)],
    ['rewards.myEpoch', () => d.rewards.myEpoch(EPOCH, CALL)],
    ['rewards.myOrders', () => d.rewards.myOrders(undefined, CALL)],
    ['rewards.myGroupHistory', () => d.rewards.myGroupHistory(undefined, CALL)],
    ['rewards.myMarket', () => d.rewards.myMarket(CONDITION, undefined, CALL)],
    ['rewards.myGroup', () => d.rewards.myGroup(GROUP, undefined, CALL)],
    ['rewards.leaderboard', () => d.rewards.leaderboard(undefined, CALL)],
    ['rewards.myRank', () => d.rewards.myRank(undefined, CALL)],
  ];

  test.each(reads)(
    '%s passes its call to the transport',
    async (name, read) => {
      r.requests.length = 0;
      await run(read());
      expectThreaded(r, name);
    },
  );

  test('without call, a read passes none', async () => {
    r.requests.length = 0;
    await run(d.markets.get(1));
    expect(r.requests.map((request) => request.call)).toEqual([undefined]);
  });
});

describe('the orderbook client', () => {
  const r = recorder();
  const signer = keySigner(generatePrivateKey());
  const session = new Session({
    env: testEnv,
    transport: r.transport,
    clock: new Clock({ fetchServerTimeSec: async () => 0 }),
    signer,
    readContract: async () => '0x',
    warn: () => {},
  });
  const o = new OrderbookClient({
    transport: r.transport,
    session,
    env: testEnv,
  });

  const reads: [string, () => unknown][] = [
    ['getServerTime', () => o.getServerTime(CALL)],
    ['getTradingState', () => o.getTradingState(CALL)],
    ['getTickSize', () => o.getTickSize(TOKEN, CALL)],
    ['getMarkets', () => o.getMarkets({}, CALL)],
    ['getMarket', () => o.getMarket(CONDITION, CALL)],
    ['getConvictionMarket', () => o.getConvictionMarket(CONDITION, CALL)],
    ['getBook', () => o.getBook(TOKEN, CALL)],
    ['getBooks', () => o.getBooks([TOKEN], CALL)],
    ['getMidpoint', () => o.getMidpoint(TOKEN, CALL)],
    ['getMidpoints', () => o.getMidpoints([TOKEN], CALL)],
    ['getPrice', () => o.getPrice(TOKEN, 'BUY', CALL)],
    ['getPrices', () => o.getPrices([{ tokenId: TOKEN, side: 'BUY' }], CALL)],
    ['getSpread', () => o.getSpread(TOKEN, CALL)],
    ['getSpreads', () => o.getSpreads([TOKEN], CALL)],
    ['getLastTradePrice', () => o.getLastTradePrice(TOKEN, CALL)],
    ['getLastTradePrices', () => o.getLastTradePrices([TOKEN], CALL)],
    ['getPricesHistory', () => o.getPricesHistory({ tokenId: TOKEN }, CALL)],
    ['getOpenOrders', () => o.getOpenOrders({}, CALL)],
    ['getOrder', () => o.getOrder(HASH, CALL)],
    ['getTrades', () => o.getTrades({}, CALL)],
    ['getTrade', () => o.getTrade(HASH, CALL)],
    [
      'getBalanceAllowance',
      () => o.getBalanceAllowance({ assetType: 'COLLATERAL' }, CALL),
    ],
    ['getPositions', () => o.getPositions(CALL)],
    ['getClaimable', () => o.getClaimable(CALL)],
    ['getMarketCapacity', () => o.getMarketCapacity(CONDITION, CALL)],
  ];

  test.each(reads)(
    '%s passes its call to the transport',
    async (name, read) => {
      r.requests.length = 0;
      await run(read());
      expectThreaded(r, name);
    },
  );

  test('reconcileOrder passes its call to every read it makes', async () => {
    const steps = recorder((request) => {
      if (request.path.startsWith('/data/order/')) {
        throw new RequestRejectedError('not open', {
          service: 'orderbook',
          status: 404,
        });
      }
      throw STOP;
    });
    const client = new OrderbookClient({
      transport: steps.transport,
      env: testEnv,
    });
    await run(client.reconcileOrder(HASH, {}, CALL));
    expect(steps.requests.map((request) => request.path)).toEqual([
      `/data/order/${HASH}`,
      '/data/trades',
    ]);
    expectThreaded(steps, 'reconcileOrder');
  });
});

describe('the bridge client', () => {
  const r = recorder();
  const bridge = new BridgeClient({
    env: testEnvWithBridge,
    transport: r.transport,
    session: {
      hasSigner: () => false,
      hasBackendCredential: () => true,
      toJSON: () => ({ closed: false }),
    } as unknown as Session,
    identity: async () => {
      throw new Error('not needed');
    },
    chain: { readContract: async () => 0n } as never,
    account: { transferUsdc: async () => undefined } as never,
  });

  test.each([
    ['assets', () => bridge.assets('deposit', CALL)],
    ['get', () => bridge.get('payment_1', CALL)],
    ['history', () => bridge.history({}, CALL)],
  ] as [string, () => unknown][])(
    '%s passes its call to the transport',
    async (name, read) => {
      r.requests.length = 0;
      await run(read());
      expectThreaded(r, name);
    },
  );
});
