import { HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { zeroHash } from 'viem';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import type { EnvironmentConfig } from '../../src/core/env';
import {
  type RequestRejectedError,
  UserInputError,
  XoError,
} from '../../src/core/errors';
import { parseRequestOptions } from '../../src/core/requestOptions';
import {
  type ResolveDeps,
  type ResolvedMarket,
  resolveMarket,
} from '../../src/markets/resolve';
import { OrderbookClient } from '../../src/orderbook/client';
import { caught, dataRig } from '../helpers/dataRig';
import {
  addressOf,
  conditionIdOf,
  marketFixture,
  slugOf,
} from '../helpers/mockBackendData';
import { type ChainStub, chainStub, prepare } from '../helpers/mockChain';
import {
  type FixtureMarket,
  installMarketData,
  TOKEN_NO,
  TOKEN_YES,
} from '../helpers/mockMarketData';
import { rejectedWith } from '../helpers/rejections';
import { testEnv } from '../helpers/testEnv';

const env = testEnv;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
//
// The backend fake has markets 1..14 and the rewards fake enrols markets 1 and 2.
// The orderbook fake gets a market for every backend CLOB market but id 3 (a CLOB market the
// gateway does not know) and holds id 9 inactive. Market 6 is a legacy LMSR market and market 7
// a legacy pulse market: both have no condition id.

/** The backend fixtures expire on 2026-12-01; this is a day in October, before that. */
const NOW = Date.parse('2026-10-18T00:00:00.000Z');
const EXPIRES = Date.parse('2026-12-01T00:00:00.000Z');

const yesOf = (n: number): string => (BigInt(TOKEN_YES) + BigInt(n)).toString();
const noOf = (n: number): string => (BigInt(TOKEN_NO) + BigInt(n)).toString();

const ORDERBOOK_IDS = [1, 2, 4, 8, 9, 10, 11, 12];
const INACTIVE_ID = 9;

function orderbookMarkets(): FixtureMarket[] {
  return ORDERBOOK_IDS.map((n) => ({
    condition_id: conditionIdOf(n),
    yes: yesOf(n),
    no: noOf(n),
    active: n !== INACTIVE_ID,
  }));
}

interface RigOptions {
  /** Give the resolver a chain reader, and prepare every orderbook market on it. Default true. */
  chain?: boolean;
  /** Replace the contracts' environment. */
  env?: EnvironmentConfig;
  /** Pass `null` to leave `nowMs` out. */
  nowMs?: (() => number) | null;
  /** The client of both services holds a session (credentials on the transport). */
  session?: boolean;
  /**
   * Check the orderbook's answers against the strict schemas (the default). The gateway's
   * market object names its outcomes "Yes" and "No" only, so a test that feeds other names
   * turns it off.
   */
  strictOrderbook?: boolean;
}

function rig(o: RigOptions = {}) {
  const base = dataRig(server, {
    strict: true,
    ...(o.session === true ? { session: true } : {}),
  });
  const orderbook = installMarketData(server, { markets: orderbookMarkets() });
  const client = new OrderbookClient({
    transport: base.transport,
    env,
    strictResponses: o.strictOrderbook ?? true,
  });
  const chain = chainStub(o.env ?? env);
  for (const n of ORDERBOOK_IDS) {
    prepare(chain, conditionIdOf(n), yesOf(n));
  }
  const deps = (): ResolveDeps => ({
    data: base.client,
    orderbook: client,
    env: o.env ?? env,
    ...(o.chain === false ? {} : { chain: chain.reader }),
    ...(o.nowMs === null ? {} : { nowMs: o.nowMs ?? (() => NOW) }),
  });
  return {
    ...base,
    orderbook,
    chain,
    deps,
    resolve: (input: string | number): Promise<ResolvedMarket> =>
      resolveMarket(input, deps()),
  };
}

/** The "METHOD path" of every backend request. */
const backendCalls = (r: ReturnType<typeof rig>): string[] =>
  r.backend.requests.map((request) => `${request.method} ${request.path}`);

// ---------------------------------------------------------------------------
// Input kinds
// ---------------------------------------------------------------------------

describe('resolveMarket: input kinds', () => {
  test('a number is a backend id', async () => {
    const r = rig();
    const market = await r.resolve(1);
    expect(market.marketId).toBe(1);
    expect(backendCalls(r)).toContain('GET /api/markets/1');
  });

  test('a numeric string is a backend id', async () => {
    const r = rig();
    const market = await r.resolve('10');
    expect(market.marketId).toBe(10);
    expect(backendCalls(r)).toContain('GET /api/markets/10');
    expect(backendCalls(r).some((c) => c.includes('/slug/'))).toBe(false);
  });

  test('a slug is looked up by slug', async () => {
    const r = rig();
    const market = await r.resolve(slugOf(2));
    expect(market.marketId).toBe(2);
    expect(market.slug).toBe(slugOf(2));
    expect(backendCalls(r)).toContain(`GET /api/markets/slug/${slugOf(2)}`);
  });

  test('0x and 64 hex digits is a condition id (by contract key)', async () => {
    const r = rig();
    const market = await r.resolve(conditionIdOf(8));
    expect(market.marketId).toBe(8);
    expect(market.conditionId).toBe(conditionIdOf(8));
    expect(backendCalls(r)).toContain(
      `GET /api/markets/contract/${conditionIdOf(8)}`,
    );
  });

  test('an upper-case condition id is normalised to lower case', async () => {
    const r = rig();
    // Market 10's id is 0x0a0a...: it has letters to upper-case.
    const lower = conditionIdOf(10);
    const upper = `0x${lower.slice(2).toUpperCase()}`;
    expect(upper).not.toBe(lower);
    const market = await r.resolve(upper);
    expect(market.conditionId).toBe(lower);
    expect(backendCalls(r)).toContain(`GET /api/markets/contract/${lower}`);
    // The orderbook and the rewards route were asked with the lower-case id too.
    expect(r.orderbook.calls).toContain(`GET /markets/${lower}`);
    expect(
      r.backend.requests.some(
        (q) =>
          q.path === `/api/public/liquidity-rewards/markets/${lower}/config`,
      ),
    ).toBe(true);
  });

  test('a 0X prefix is read as a condition id as well', async () => {
    const r = rig();
    const market = await r.resolve(`0X${conditionIdOf(1).slice(2)}`);
    expect(market.marketId).toBe(1);
  });

  test('0x and 40 hex digits is a contract address (by contract key)', async () => {
    const r = rig();
    // A legacy CLOB market keyed by its wrapper address, with a condition id of its own.
    const address = `0x${'ab'.repeat(20)}`;
    r.backend.override = (request) =>
      request.path === `/api/markets/contract/${address}`
        ? HttpResponse.json({
            ...marketFixture(1),
            contractMarketId: address,
          })
        : undefined;
    const market = await r.resolve(address);
    expect(market.marketId).toBe(1);
    expect(market.conditionId).toBe(conditionIdOf(1));
    expect(backendCalls(r)).toContain(`GET /api/markets/contract/${address}`);
  });

  test('an upper-case address is sent in lower case', async () => {
    const r = rig();
    const address = `0x${'AB'.repeat(20)}`;
    r.backend.override = (request) =>
      request.path === `/api/markets/contract/${address.toLowerCase()}`
        ? HttpResponse.json({
            ...marketFixture(1),
            contractMarketId: address.toLowerCase(),
          })
        : undefined;
    await r.resolve(address);
    expect(backendCalls(r)).toContain(
      `GET /api/markets/contract/${address.toLowerCase()}`,
    );
  });

  test('surrounding spaces are ignored', async () => {
    const r = rig();
    const market = await r.resolve(`  ${conditionIdOf(1)}  `);
    expect(market.marketId).toBe(1);
  });

  test.each([
    ['0x and 63 hex digits', `0x${'ab'.repeat(31)}a`],
    ['0x and 65 hex digits', `0x${'ab'.repeat(32)}a`],
    ['0x and 39 hex digits', `0x${'ab'.repeat(19)}a`],
    ['0x and 41 hex digits', `0x${'ab'.repeat(20)}a`],
    ['0x and 64 characters that are not all hex', `0x${'g'.repeat(64)}`],
  ])(
    '%s is a slug, and a 404 says it was treated as one',
    async (_name, input) => {
      const r = rig();
      const error = await caught(() => r.resolve(input));
      // Looked up by slug, never by contract key.
      expect(backendCalls(r)).toEqual([`GET /api/markets/slug/${input}`]);
      expect(error).toSatisfy(rejectedWith(404));
      const miss = error as RequestRejectedError;
      expect(miss.code).not.toBe('not_tradable_on_orderbook');
      expect(miss.message).toContain('treated as a slug');
      expect(miss.message).toContain('64 hex');
      // The original 404 is kept: its status and its service.
      expect(miss.status).toBe(404);
      expect(miss.service).toBe('backend');
      expect(miss.cause).toSatisfy(rejectedWith(404));
      expect(r.orderbook.calls).toEqual([]);
    },
  );

  test('a plain slug that is not found gets no hint', async () => {
    const r = rig();
    const error = await caught(() => r.resolve('no-such-market'));
    expect(error).toSatisfy(rejectedWith(404));
    expect((error as RequestRejectedError).message).not.toContain(
      'treated as a slug',
    );
  });

  test('whitespace around a slug is trimmed: spaces, tabs and newlines', async () => {
    const r = rig();
    const market = await r.resolve(`  \t${slugOf(2)}\n `);
    expect(market.marketId).toBe(2);
    expect(backendCalls(r)).toContain(`GET /api/markets/slug/${slugOf(2)}`);
  });

  test('whitespace around a numeric id is trimmed', async () => {
    const r = rig();
    const market = await r.resolve(' 10\n');
    expect(market.marketId).toBe(10);
    expect(backendCalls(r)).toContain('GET /api/markets/10');
  });

  test('whitespace inside a slug is kept and sent encoded: it finds nothing, not another market', async () => {
    const r = rig();
    const error = await caught(() => r.resolve('market 2'));
    expect(error).toSatisfy(rejectedWith(404));
    expect(backendCalls(r)).toEqual(['GET /api/markets/slug/market%202']);
  });

  test('whitespace inside a number is not an id', async () => {
    const r = rig();
    const error = await caught(() => r.resolve('1 0'));
    expect(error).toSatisfy(rejectedWith(404));
    expect(backendCalls(r)).toEqual(['GET /api/markets/slug/1%200']);
  });

  test.each([
    ['an empty string', ''],
    ['a blank string', '   '],
    ['zero', 0],
    ['a negative number', -3],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['an unsafe integer', 2 ** 60],
    ['a 17-digit numeric string', '12345678901234567'],
  ])('%s is a UserInputError, before any request', async (_name, input) => {
    const r = rig();
    const error = await caught(() => r.resolve(input as string | number));
    expect(error).toBeInstanceOf(UserInputError);
    expect(r.backend.requests).toEqual([]);
    expect(r.orderbook.calls).toEqual([]);
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['an object', { id: 1 }],
    ['a boolean', true],
    ['a bigint', 1n],
  ])('%s is a UserInputError', async (_name, input) => {
    const r = rig();
    const error = await caught(() => r.resolve(input as never));
    expect(error).toBeInstanceOf(UserInputError);
    expect(r.backend.requests).toEqual([]);
  });

  test('an unknown market is the backend 404, not "not tradable"', async () => {
    const r = rig();
    const error = await caught(() => r.resolve(999));
    expect(error).toSatisfy(rejectedWith(404));
    expect((error as RequestRejectedError).code).not.toBe(
      'not_tradable_on_orderbook',
    );
    expect((error as RequestRejectedError).service).toBe('backend');
    expect(r.orderbook.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The joined market
// ---------------------------------------------------------------------------

describe('resolveMarket: the joined market', () => {
  test('joins the backend market with the orderbook market', async () => {
    const r = rig();
    const market = await r.resolve(1);
    expect(market).toMatchObject({
      marketId: 1,
      slug: slugOf(1),
      conditionId: conditionIdOf(1),
      yesTokenId: yesOf(1),
      noTokenId: noOf(1),
      tickSize: '0.001',
      active: true,
    });
  });

  test('tokens come from the orderbook outcomes, not from their position or case', async () => {
    const r = rig({ strictOrderbook: false });
    r.orderbook.override = (route) =>
      route === '/markets/{condition_id}'
        ? HttpResponse.json({
            condition_id: conditionIdOf(1),
            // NO first, and the labels in other cases.
            tokens: [
              { token_id: '222', outcome: 'NO', price: '0.400' },
              { token_id: '111', outcome: 'yes', price: '0.600' },
            ],
            minimum_tick_size: 0.01,
            neg_risk: false,
            active: true,
          })
        : undefined;
    const market = await r.resolve(1);
    expect(market.yesTokenId).toBe('111');
    expect(market.noTokenId).toBe('222');
    // The tick size is the orderbook market's own.
    expect(market.tickSize).toBe('0.01');
  });

  test('token ids are canonical decimal strings', async () => {
    const r = rig();
    r.orderbook.override = (route) =>
      route === '/markets/{condition_id}'
        ? HttpResponse.json({
            condition_id: conditionIdOf(1),
            tokens: [
              { token_id: '0111', outcome: 'Yes', price: '0.600' },
              { token_id: '0222', outcome: 'No', price: '0.400' },
            ],
            minimum_tick_size: 0.001,
            neg_risk: false,
            active: true,
          })
        : undefined;
    const market = await r.resolve(1);
    expect(market.yesTokenId).toBe('111');
    expect(market.noTokenId).toBe('222');
  });

  test('a market whose condition id is only its contract key still resolves', async () => {
    const r = rig();
    r.backend.marketExtras = { conditionId: null };
    const market = await r.resolve(1);
    expect(market.conditionId).toBe(conditionIdOf(1));
    expect(market.yesTokenId).toBe(yesOf(1));
  });

  test('asks the backend once, the orderbook market once, and the rewards config once', async () => {
    const r = rig();
    await r.resolve(1);
    expect(backendCalls(r)).toEqual([
      'GET /api/markets/1',
      `GET /api/public/liquidity-rewards/markets/${conditionIdOf(1)}/config`,
    ]);
    // The tick size is in the orderbook market: no `GET /tick-size`.
    expect(r.orderbook.calls).toEqual([`GET /markets/${conditionIdOf(1)}`]);
  });

  test('`active` is the orderbook status', async () => {
    const r = rig();
    const market = await r.resolve(INACTIVE_ID);
    expect(market.active).toBe(false);
    // The backend still says ACTIVE for it.
    expect((await r.client.markets.get(INACTIVE_ID)).status).toBe('ACTIVE');
  });

  test('an enrolled market carries its rewards config', async () => {
    const r = rig();
    const market = await r.resolve(1);
    expect(market.rewards).toBeDefined();
    expect(market.rewards).toEqual(
      await r.client.rewards.marketConfig(conditionIdOf(1)),
    );
    // And it is the typed config, not an unknown blob.
    expect(market.rewards?.market_id).toBe(conditionIdOf(1));
    expect(market.rewards?.programmes.length).toBeGreaterThan(0);
  });

  test('a market without a rewards config leaves `rewards` undefined and does not throw', async () => {
    const r = rig();
    const market = await r.resolve(INACTIVE_ID);
    expect(market.rewards).toBeUndefined();
    expect('rewards' in market).toBe(false);
  });

  test('any other rewards failure is not swallowed', async () => {
    const r = rig();
    r.backend.override = (request) =>
      request.path.includes('/liquidity-rewards/')
        ? HttpResponse.json({ message: 'boom' }, { status: 500 })
        : undefined;
    const error = await caught(() => r.resolve(1));
    expect(error).toBeInstanceOf(XoError);
    expect(error).not.toSatisfy(rejectedWith(404));
  });

  test('sends no credentials, whatever the clients hold', async () => {
    const r = rig({ session: true });
    expect(r.session).toBeDefined();
    await r.resolve(1);
    expect(r.backend.requests.length).toBeGreaterThan(0);
    for (const request of r.backend.requests) {
      expect(request.authorization).toBeNull();
    }
    for (const request of r.orderbook.requests) {
      expect(request.headers.get('authorization')).toBeNull();
      expect(
        [...request.headers.keys()].filter((name) =>
          /^poly|api-key/i.test(name),
        ),
      ).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Markets that do not trade on the orderbook, and markets that are not binary
// ---------------------------------------------------------------------------

describe('resolveMarket: not tradable on the orderbook', () => {
  test('a legacy LMSR market has no condition id: UserInputError not_tradable_on_orderbook', async () => {
    const r = rig();
    const error = await caught(() => r.resolve(6));
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).code).toBe('not_tradable_on_orderbook');
    expect((error as UserInputError).message).toContain('6');
    // The orderbook was never asked.
    expect(r.orderbook.calls).toEqual([]);
  });

  test('the same by contract address', async () => {
    const r = rig();
    const error = await caught(() => r.resolve(addressOf(6)));
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).code).toBe('not_tradable_on_orderbook');
  });

  test('a legacy pulse market is not tradable either', async () => {
    const r = rig();
    const error = await caught(() => r.resolve(7));
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).code).toBe('not_tradable_on_orderbook');
  });

  test('a CLOB market the gateway does not know: 404 RequestRejectedError not_tradable_on_orderbook', async () => {
    const r = rig();
    const error = await caught(() => r.resolve(3));
    expect(error).toSatisfy(rejectedWith(404));
    expect((error as RequestRejectedError).code).toBe(
      'not_tradable_on_orderbook',
    );
    expect((error as RequestRejectedError).service).toBe('orderbook');
    expect((error as RequestRejectedError).cause).toSatisfy(rejectedWith(404));
    expect(r.orderbook.calls).toEqual([`GET /markets/${conditionIdOf(3)}`]);
  });

  test('an orderbook failure other than a 404 is not turned into "not tradable"', async () => {
    const r = rig();
    r.orderbook.override = (route) =>
      route === '/markets/{condition_id}'
        ? HttpResponse.json({ error: 'overloaded' }, { status: 500 })
        : undefined;
    const error = await caught(() => r.resolve(1));
    expect(error).toBeInstanceOf(XoError);
    expect((error as XoError).code).not.toBe('not_tradable_on_orderbook');
  });
});

describe('resolveMarket: not binary', () => {
  const answer = (
    r: ReturnType<typeof rig>,
    tokens: Array<{ token_id: string; outcome: string }>,
  ) => {
    r.orderbook.override = (route) =>
      route === '/markets/{condition_id}'
        ? HttpResponse.json({
            condition_id: conditionIdOf(1),
            tokens: tokens.map((t) => ({ ...t, price: '0.500' })),
            minimum_tick_size: 0.001,
            neg_risk: true,
            active: true,
          })
        : undefined;
  };

  test('a multi-outcome market (named outcomes) is refused with not_binary', async () => {
    const r = rig({ strictOrderbook: false });
    answer(r, [
      { token_id: '1', outcome: 'Charles Leclerc' },
      { token_id: '2', outcome: 'Lando Norris' },
      { token_id: '3', outcome: 'Max Verstappen' },
    ]);
    const error = await caught(() => r.resolve(1));
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).code).toBe('not_binary');
    expect((error as UserInputError).message).toContain('Charles Leclerc');
  });

  test('two outcomes that are not YES and NO are refused', async () => {
    const r = rig({ strictOrderbook: false });
    answer(r, [
      { token_id: '1', outcome: 'Over' },
      { token_id: '2', outcome: 'Under' },
    ]);
    const error = await caught(() => r.resolve(1));
    expect((error as UserInputError).code).toBe('not_binary');
  });

  test('a third outcome next to YES and NO is refused', async () => {
    const r = rig({ strictOrderbook: false });
    answer(r, [
      { token_id: '1', outcome: 'Yes' },
      { token_id: '2', outcome: 'No' },
      { token_id: '3', outcome: 'Draw' },
    ]);
    const error = await caught(() => r.resolve(1));
    expect((error as UserInputError).code).toBe('not_binary');
  });

  test('two YES tokens are refused', async () => {
    const r = rig({ strictOrderbook: false });
    answer(r, [
      { token_id: '1', outcome: 'Yes' },
      { token_id: '2', outcome: 'Yes' },
    ]);
    const error = await caught(() => r.resolve(1));
    expect((error as UserInputError).code).toBe('not_binary');
  });

  test('one token, or none, is refused', async () => {
    const one = rig({ strictOrderbook: false });
    answer(one, [{ token_id: '1', outcome: 'Yes' }]);
    expect(((await caught(() => one.resolve(1))) as UserInputError).code).toBe(
      'not_binary',
    );
    server.resetHandlers();
    const none = rig({ strictOrderbook: false });
    answer(none, []);
    expect(((await caught(() => none.resolve(1))) as UserInputError).code).toBe(
      'not_binary',
    );
  });

  test('a long outcome name is cut in the message', async () => {
    const r = rig({ strictOrderbook: false });
    answer(r, [
      { token_id: '1', outcome: 'x'.repeat(500) },
      { token_id: '2', outcome: 'No' },
    ]);
    const error = (await caught(() => r.resolve(1))) as UserInputError;
    expect(error.code).toBe('not_binary');
    expect(error.message.length).toBeLessThan(400);
  });
});

// ---------------------------------------------------------------------------
// The tradable verdict
// ---------------------------------------------------------------------------

describe('resolveMarket: the tradable verdict', () => {
  test('everything checks out: ok, no reasons, every check passes', async () => {
    const r = rig();
    const { tradable } = await r.resolve(1);
    expect(tradable).toEqual({
      ok: true,
      reasons: [],
      checks: {
        orderbookActive: 'pass',
        notExpired: 'pass',
        prepared: 'pass',
        unresolved: 'pass',
        registeredOnExchange: 'pass',
      },
    });
  });

  test('asks the chain exactly three things, on the environment contracts', async () => {
    const r = rig();
    await r.resolve(1);
    expect(r.chain.calls).toHaveLength(3);
    const byName = Object.fromEntries(
      r.chain.calls.map((call) => [call.name, call]),
    );
    expect(byName.getOutcomeSlotCount).toEqual({
      to: env.contracts.conditionalTokens,
      name: 'getOutcomeSlotCount',
      arg: conditionIdOf(1),
    });
    expect(byName.payoutDenominator).toEqual({
      to: env.contracts.conditionalTokens,
      name: 'payoutDenominator',
      arg: conditionIdOf(1),
    });
    // The exchange is asked about the YES token, as a uint256.
    expect(byName.getConditionId).toEqual({
      to: env.contracts.ctfExchange,
      name: 'getConditionId',
      arg: yesOf(1),
    });
  });

  test('the calldata is pinned: literal selectors, one ABI word of argument', async () => {
    const r = rig();
    await r.resolve(1);
    // keccak256 selectors of getOutcomeSlotCount(bytes32), payoutDenominator(bytes32) and
    // getConditionId(uint256), written out here so a wrong signature in the SDK cannot agree
    // with itself.
    const tokens = env.contracts.conditionalTokens.toLowerCase();
    const exchange = env.contracts.ctfExchange.toLowerCase();
    const condition = conditionIdOf(1).slice(2);
    const yesWord = BigInt(yesOf(1)).toString(16).padStart(64, '0');
    expect(
      r.chain.calldata.map((c) => `${c.to.toLowerCase()} ${c.data}`).sort(),
    ).toEqual(
      [
        `${tokens} 0xd42dc0c2${condition}`,
        `${tokens} 0xdd34de67${condition}`,
        `${exchange} 0xd7fb272f${yesWord}`,
      ].sort(),
    );
  });

  test('the contract addresses come from `deps.env`', async () => {
    const custom: EnvironmentConfig = {
      ...env,
      contracts: {
        ...env.contracts,
        ctfExchange: `0x${'e1'.repeat(20)}`,
        conditionalTokens: `0x${'c7'.repeat(20)}`,
      },
    };
    const r = rig({ env: custom });
    const { tradable } = await r.resolve(1);
    expect(tradable.ok).toBe(true);
    expect(new Set(r.chain.calls.map((call) => call.to.toLowerCase()))).toEqual(
      new Set([
        custom.contracts.ctfExchange.toLowerCase(),
        custom.contracts.conditionalTokens.toLowerCase(),
      ]),
    );
  });

  describe('without a chain reader', () => {
    test('the on-chain checks are unchecked, and ok is false', async () => {
      const r = rig({ chain: false });
      const { tradable } = await r.resolve(1);
      expect(tradable.checks).toEqual({
        orderbookActive: 'pass',
        notExpired: 'pass',
        prepared: 'unchecked',
        unresolved: 'unchecked',
        registeredOnExchange: 'unchecked',
      });
      expect(tradable.ok).toBe(false);
      // `ok: false` always says why.
      expect(tradable.reasons).toEqual(['chain_unchecked']);
      expect(r.chain.calls).toEqual([]);
    });

    test('an inactive market still reports its own reason, with the unchecked one', async () => {
      const r = rig({ chain: false });
      const { tradable } = await r.resolve(INACTIVE_ID);
      expect(tradable.ok).toBe(false);
      expect(tradable.reasons).toEqual([
        'orderbook_inactive',
        'chain_unchecked',
      ]);
    });
  });

  describe('orderbook status', () => {
    test('an inactive orderbook market fails with orderbook_inactive', async () => {
      const r = rig();
      const { tradable, active } = await r.resolve(INACTIVE_ID);
      expect(active).toBe(false);
      expect(tradable.ok).toBe(false);
      expect(tradable.checks.orderbookActive).toBe('fail');
      expect(tradable.reasons).toEqual(['orderbook_inactive']);
    });
  });

  describe('expiry', () => {
    test('a market past its expiry fails with expired, although the orderbook says active', async () => {
      const r = rig({ nowMs: () => EXPIRES + 24 * 3_600_000 });
      const { tradable, active } = await r.resolve(1);
      expect(active).toBe(true);
      expect(tradable.ok).toBe(false);
      expect(tradable.checks.notExpired).toBe('fail');
      expect(tradable.checks.orderbookActive).toBe('pass');
      expect(tradable.reasons).toEqual(['expired']);
    });

    test('the expiry instant itself is expired; a millisecond before is not', async () => {
      const at = rig({ nowMs: () => EXPIRES });
      expect((await at.resolve(1)).tradable.checks.notExpired).toBe('fail');
      server.resetHandlers();
      const before = rig({ nowMs: () => EXPIRES - 1 });
      expect((await before.resolve(1)).tradable.checks.notExpired).toBe('pass');
    });

    test('`nowMs` is the clock: it is read once per call', async () => {
      const nowMs = vi.fn(() => NOW);
      const r = rig({ nowMs });
      await r.resolve(1);
      expect(nowMs).toHaveBeenCalledTimes(1);
    });

    test('without `nowMs` the local clock is used', async () => {
      const r = rig({ nowMs: null });
      vi.spyOn(Date, 'now').mockReturnValue(EXPIRES + 1000);
      const { tradable } = await r.resolve(1);
      expect(tradable.checks.notExpired).toBe('fail');
      expect(tradable.reasons).toEqual(['expired']);
    });

    test('a market with no expiry date cannot be checked: unchecked, not ok', async () => {
      const r = rig();
      r.backend.marketExtras = { expiresAt: null };
      const { tradable } = await r.resolve(1);
      expect(tradable.checks.notExpired).toBe('unchecked');
      // Every other check passes, and still it is not ok.
      expect(tradable.checks.prepared).toBe('pass');
      expect(tradable.ok).toBe(false);
      expect(tradable.reasons).toEqual(['expiry_unknown']);
    });

    test('an expiry date that is not a date is unchecked as well', async () => {
      const r = rig();
      r.backend.marketExtras = { expiresAt: 'soon' };
      const { tradable } = await r.resolve(1);
      expect(tradable.checks.notExpired).toBe('unchecked');
      expect(tradable.ok).toBe(false);
    });

    test.each([
      ['no Z or offset', '2026-12-01T00:00:00'],
      ['no Z or offset, with milliseconds', '2026-12-01T00:00:00.000'],
      ['a date only', '2026-12-01'],
      ['a space instead of T', '2026-12-01 00:00:00Z'],
      ['an offset without a colon', '2026-12-01T00:00:00+0000'],
      ['a lower-case z', '2026-12-01T00:00:00z'],
    ])(
      'an expiry with %s is unchecked, not read as local time',
      async (_name, expiresAt) => {
        const r = rig({ nowMs: () => EXPIRES + 365 * 24 * 3_600_000 });
        r.backend.marketExtras = { expiresAt };
        const { tradable } = await r.resolve(1);
        // Long past either way, still not a verdict: the instant is unknown.
        expect(tradable.checks.notExpired).toBe('unchecked');
        expect(tradable.ok).toBe(false);
        expect(tradable.reasons).toEqual(['expiry_unknown']);
      },
    );

    test.each([
      ['Z', '2026-12-01T00:00:00Z'],
      ['Z with milliseconds', '2026-12-01T00:00:00.000Z'],
      ['+00:00', '2026-12-01T00:00:00+00:00'],
      ['a positive offset', '2026-12-01T02:00:00+02:00'],
      ['a negative offset', '2026-11-30T19:00:00-05:00'],
    ])(
      'an expiry with %s is the same instant, to the millisecond',
      async (_name, expiresAt) => {
        const at = rig({ nowMs: () => EXPIRES });
        at.backend.marketExtras = { expiresAt };
        expect((await at.resolve(1)).tradable.checks.notExpired).toBe('fail');
        server.resetHandlers();
        const before = rig({ nowMs: () => EXPIRES - 1 });
        before.backend.marketExtras = { expiresAt };
        expect((await before.resolve(1)).tradable.checks.notExpired).toBe(
          'pass',
        );
      },
    );

    test('a `nowMs` that is not a finite number is refused', async () => {
      const r = rig({ nowMs: () => Number.NaN });
      const error = await caught(() => r.resolve(1));
      expect(error).toBeInstanceOf(UserInputError);
    });
  });

  describe('on-chain checks', () => {
    test('a condition that was never prepared fails with not_prepared', async () => {
      const r = rig();
      r.chain.slotCounts.delete(conditionIdOf(1));
      const { tradable } = await r.resolve(1);
      expect(tradable.ok).toBe(false);
      expect(tradable.checks).toMatchObject({
        prepared: 'fail',
        unresolved: 'pass',
        registeredOnExchange: 'pass',
      });
      expect(tradable.reasons).toEqual(['not_prepared']);
    });

    test('a condition with three outcomes is not prepared for a binary market', async () => {
      const r = rig();
      r.chain.slotCounts.set(conditionIdOf(1), 3n);
      const { tradable } = await r.resolve(1);
      expect(tradable.checks.prepared).toBe('fail');
      expect(tradable.reasons).toEqual(['not_prepared']);
    });

    test('a resolved condition fails with already_resolved', async () => {
      const r = rig();
      r.chain.payoutDenominators.set(conditionIdOf(1), 1n);
      const { tradable } = await r.resolve(1);
      expect(tradable.ok).toBe(false);
      expect(tradable.checks).toMatchObject({
        prepared: 'pass',
        unresolved: 'fail',
        registeredOnExchange: 'pass',
      });
      expect(tradable.reasons).toEqual(['already_resolved']);
    });

    test('a token the exchange has not registered fails with not_registered_on_exchange', async () => {
      const r = rig();
      r.chain.registry.delete(yesOf(1));
      const { tradable } = await r.resolve(1);
      expect(tradable.ok).toBe(false);
      expect(tradable.checks).toMatchObject({
        prepared: 'pass',
        unresolved: 'pass',
        registeredOnExchange: 'fail',
      });
      expect(tradable.reasons).toEqual(['not_registered_on_exchange']);
    });

    test('the zero hash is never a registered condition, even when the exchange answers it', async () => {
      const r = rig();
      // A garbage backend row whose condition id is the zero hash: the exchange answers the
      // zero hash for every token it does not know, so "equal" must not count.
      r.backend.marketExtras = { conditionId: zeroHash };
      r.orderbook.markets.push({
        condition_id: zeroHash,
        yes: yesOf(1),
        no: noOf(1),
        active: true,
      });
      r.chain.slotCounts.set(zeroHash, 2n);
      r.chain.registry.set(yesOf(1), zeroHash);
      const { tradable, conditionId } = await r.resolve(1);
      expect(conditionId).toBe(zeroHash);
      expect(tradable.checks).toMatchObject({
        prepared: 'pass',
        unresolved: 'pass',
        registeredOnExchange: 'fail',
      });
      expect(tradable.ok).toBe(false);
      expect(tradable.reasons).toEqual(['not_registered_on_exchange']);
    });

    test('a token registered under another condition fails as well', async () => {
      const r = rig();
      r.chain.registry.set(yesOf(1), conditionIdOf(2));
      const { tradable } = await r.resolve(1);
      expect(tradable.checks.registeredOnExchange).toBe('fail');
      expect(tradable.reasons).toEqual(['not_registered_on_exchange']);
    });

    test('every failing check adds its reason, in a fixed order', async () => {
      const r = rig({ nowMs: () => EXPIRES + 1 });
      const id = INACTIVE_ID;
      r.chain.slotCounts.delete(conditionIdOf(id));
      r.chain.payoutDenominators.set(conditionIdOf(id), 1n);
      r.chain.registry.delete(yesOf(id));
      const { tradable } = await r.resolve(id);
      expect(tradable.ok).toBe(false);
      expect(tradable.checks).toEqual({
        orderbookActive: 'fail',
        notExpired: 'fail',
        prepared: 'fail',
        unresolved: 'fail',
        registeredOnExchange: 'fail',
      });
      expect(tradable.reasons).toEqual([
        'orderbook_inactive',
        'expired',
        'not_prepared',
        'already_resolved',
        'not_registered_on_exchange',
      ]);
    });

    test('an expired market still gets its on-chain checks', async () => {
      const r = rig({ nowMs: () => EXPIRES + 1 });
      await r.resolve(1);
      expect(r.chain.calls).toHaveLength(3);
    });
  });

  describe('chain read failures', () => {
    test('a failing read is an XoError chain_read_failed, without the underlying message', async () => {
      const r = rig();
      r.chain.override = () => {
        throw new Error(
          'connect ECONNREFUSED https://rpc.example/v1/SECRETKEY',
        );
      };
      const error = await caught(() => r.resolve(1));
      expect(error).toBeInstanceOf(XoError);
      const failure = error as XoError;
      expect(failure.code).toBe('chain_read_failed');
      expect(failure.service).toBe('chain');
      expect(failure.message).not.toContain('SECRETKEY');
      expect(failure.cause).toBeUndefined();
      expect(JSON.stringify(failure.toJSON())).not.toContain('SECRETKEY');
    });

    test.each([
      ['empty data', '0x'],
      ['a short word', '0x01'],
      ['two words', `0x${'00'.repeat(63)}02${'00'.repeat(32)}`],
      ['not hex', 'nope'],
      ['not a string', 5],
    ])('an answer that is %s is chain_read_failed', async (_name, answer) => {
      const r = rig();
      r.chain.override = (call) =>
        call.name === 'getOutcomeSlotCount' ? (answer as never) : undefined;
      const error = await caught(() => r.resolve(1));
      expect((error as XoError).code).toBe('chain_read_failed');
      expect((error as XoError).service).toBe('chain');
    });
  });

  test('a market with a custom chain stub answers the same through `resolveMarket`', async () => {
    // A hand-built chain: only the prepared market passes.
    const stub: ChainStub = chainStub();
    prepare(stub, conditionIdOf(2), yesOf(2));
    const r = rig();
    const deps = { ...r.deps(), chain: stub.reader };
    const first = await resolveMarket(1, deps);
    const second = await resolveMarket(2, deps);
    expect(first.tradable.ok).toBe(false);
    expect(second.tradable.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

describe('resolveMarket: per-call options', () => {
  test('the call reaches every request: the backend market, the orderbook market and the rewards config', async () => {
    const r = rig();
    const call = parseRequestOptions({ timeout: 5_000, retries: 0 });
    const request = vi.spyOn(r.transport, 'request');
    const market = await resolveMarket(1, r.deps(), call);
    expect(market.marketId).toBe(1);
    expect(request.mock.calls.map(([o]) => [o.path, o.call])).toEqual([
      ['/api/markets/1', call],
      [`/markets/${conditionIdOf(1)}`, call],
      [
        `/api/public/liquidity-rewards/markets/${conditionIdOf(1)}/config`,
        call,
      ],
    ]);
  });

  test('without a call, the requests carry none', async () => {
    const r = rig();
    const request = vi.spyOn(r.transport, 'request');
    await resolveMarket(1, r.deps());
    expect(request.mock.calls.map(([o]) => o.call)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe('resolveMarket: deps', () => {
  test('a chain without readContract is a UserInputError', async () => {
    const r = rig();
    const error = await caught(() =>
      resolveMarket(1, { ...r.deps(), chain: {} as never }),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect(r.backend.requests).toEqual([]);
  });

  describe('env.contracts, when a chain reader is set', () => {
    const withContracts = (contracts: unknown): EnvironmentConfig =>
      ({ ...env, contracts }) as EnvironmentConfig;

    test.each([
      [
        'a missing conditionalTokens',
        { ...env.contracts, conditionalTokens: undefined },
      ],
      [
        'a malformed conditionalTokens',
        { ...env.contracts, conditionalTokens: '0x1234' },
      ],
      ['a missing ctfExchange', { ...env.contracts, ctfExchange: undefined }],
      ['a malformed ctfExchange', { ...env.contracts, ctfExchange: 'nope' }],
      ['a numeric ctfExchange', { ...env.contracts, ctfExchange: 5 }],
      ['no contracts at all', undefined],
      ['contracts that are not an object', 'a string'],
    ])(
      '%s is a UserInputError, before any request',
      async (_name, contracts) => {
        const r = rig();
        const error = await caught(() =>
          resolveMarket(1, { ...r.deps(), env: withContracts(contracts) }),
        );
        expect(error).toBeInstanceOf(UserInputError);
        expect(error).not.toBeInstanceOf(TypeError);
        expect(r.backend.requests).toEqual([]);
        expect(r.orderbook.calls).toEqual([]);
        expect(r.chain.calldata).toEqual([]);
      },
    );

    test('the message names the field', async () => {
      const r = rig();
      const error = await caught(() =>
        resolveMarket(1, {
          ...r.deps(),
          env: withContracts({ ...env.contracts, ctfExchange: 'nope' }),
        }),
      );
      expect((error as UserInputError).message).toContain('ctfExchange');
    });

    test('without a chain reader the contracts are not needed', async () => {
      const r = rig({ chain: false });
      const market = await resolveMarket(1, {
        ...r.deps(),
        env: withContracts(undefined),
      });
      expect(market.tradable.checks.prepared).toBe('unchecked');
    });

    test('a mixed-case address is accepted and the call goes to its checksummed form', async () => {
      const r = rig();
      const lower = {
        ...env.contracts,
        conditionalTokens: env.contracts.conditionalTokens.toLowerCase(),
        ctfExchange: env.contracts.ctfExchange.toLowerCase(),
      };
      const { tradable } = await resolveMarket(1, {
        ...r.deps(),
        env: withContracts(lower),
      });
      expect(tradable.ok).toBe(true);
      expect(r.chain.calldata.map((c) => c.to).sort()).toEqual(
        [
          env.contracts.conditionalTokens,
          env.contracts.conditionalTokens,
          env.contracts.ctfExchange,
        ].sort(),
      );
    });
  });

  test('missing clients are a UserInputError', async () => {
    const r = rig();
    for (const broken of [
      { ...r.deps(), data: undefined },
      { ...r.deps(), orderbook: undefined },
      { ...r.deps(), env: undefined },
    ]) {
      const error = await caught(() => resolveMarket(1, broken as never));
      expect(error).toBeInstanceOf(UserInputError);
    }
    expect(r.backend.requests).toEqual([]);
  });
});
