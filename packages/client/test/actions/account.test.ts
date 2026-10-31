import { HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { getAddress } from 'viem';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { resetNonceTracking } from '../../src/account/internal';
import { resetProcessState, setClientSeams } from '../../src/clients/internal';
import { createPublicClient } from '../../src/clients/public';
import type { SecureClient } from '../../src/clients/secure';
import {
  RequestAbortedError,
  UserInputError,
  type XoError,
} from '../../src/core/errors';
import { OrderSide } from '../../src/models/enums';
import {
  fixtures,
  installAccountData,
  PNL_MARKET_ID,
  PNL_POSITION_ID,
  PUBLIC_USER,
} from '../helpers/mockAccountData';
import {
  type BackendData,
  conditionIdOf,
  installBackendData,
  pageMeta,
} from '../helpers/mockBackendData';
import { TOKEN_NO, TOKEN_YES } from '../helpers/mockMarketData';
import { OWNER, type RailChainStub, railChain } from '../helpers/railChain';
import {
  type ChainState,
  chainReads,
  defaultChainState,
  signedInClient,
} from '../helpers/secureRig';
import { testEnv, testEnvWithBridge } from '../helpers/testEnv';

// The reads of a signed-in client's own account, and the one a public client makes of any
// wallet's positions. A read of the account goes to XO's routes for the signed-in account, with
// the client's key; a read of another wallet goes to the public route, without it.

const env = testEnvWithBridge;
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

const clients: SecureClient[] = [];
let chain: RailChainStub;
let state: ChainState;

beforeEach(() => {
  chain = railChain();
  state = defaultChainState(env);
  chainReads(chain, env, state);
  setClientSeams({ chain: chain.reader });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((c) => c.close()));
  server.resetHandlers();
  vi.restoreAllMocks();
  setClientSeams({});
  resetProcessState();
  resetNonceTracking();
});

async function rig() {
  const r = await signedInClient(server, { env });
  clients.push(r.client);
  return r;
}

/** The "METHOD /path" of every request the data fake saw, in order. */
const dataCalls = (data: BackendData): string[] =>
  data.requests.map((request) => `${request.method} ${request.path}`);

async function caught(run: () => unknown): Promise<XoError> {
  try {
    await run();
  } catch (error) {
    return error as XoError;
  }
  throw new Error('expected the call to throw');
}

describe('listPositions', () => {
  test("on a secure client, without a user: the account's own route, with the key", async () => {
    const { client, data } = await rig();
    const page = await client.listPositions().firstPage();
    const [request] = data.requests;
    expect(request?.path).toBe('/api/users/me/portfolio');
    expect(request?.authorization).toMatch(/^Bearer xo_sk_/);
    // Every position of every market of the summary, two per market.
    expect(page.items).toHaveLength(10);
    expect(page.items[0]).toMatchObject({
      marketId: '1',
      conditionId: conditionIdOf(1),
      currentSize: '662.000004',
      outcome: 'Yes',
      status: 'OPEN',
      redeemable: false,
    });
    expect(page.hasMore).toBe(false);
  });

  test('on a secure client, with a user: the public route of that wallet, without the key', async () => {
    const { client, data } = await rig();
    const page = await client
      .listPositions({ user: PUBLIC_USER.wallet })
      .firstPage();
    expect(dataCalls(data)).toEqual(['GET /api/users/portfolio']);
    expect(data.requests[0]?.query.user).toBe(getAddress(PUBLIC_USER.wallet));
    expect(data.requests[0]?.authorization).toBeNull();
    expect(page.items.length).toBeGreaterThan(0);
  });

  test('on a public client: the public route, with the user it was given', async () => {
    const data = installBackendData(server, { validKeys: [] });
    installAccountData(server, data);
    const client = createPublicClient({ environment: testEnv });
    const page = await client
      .listPositions({ user: PUBLIC_USER.wallet })
      .firstPage();
    expect(dataCalls(data)).toEqual(['GET /api/users/portfolio']);
    expect(data.requests[0]?.authorization).toBeNull();
    expect(page.items).toHaveLength(10);
  });

  test('a public client needs a user: without one, invalid_input before any request', async () => {
    const data = installBackendData(server, { validKeys: [] });
    const client = createPublicClient({ environment: testEnv });
    const error = await caught(() =>
      client.listPositions({} as unknown as { user: string }),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect(error.code).toBe('invalid_input');
    expect(error.message).toMatch(/user/);
    expect(data.requests).toEqual([]);
  });

  test('redeemable: only the positions a resolved market pays out and that are not claimed', async () => {
    const { client, data } = await rig();
    const page = await client.listPositions({ redeemable: true }).firstPage();
    expect(page.items.map((p) => p.marketId)).toEqual(['12', '12']);
    expect(page.items.every((p) => p.redeemable)).toBe(true);
    expect(page.items.every((p) => p.status === 'REDEEMABLE')).toBe(true);
    // The settled statuses are asked for, so fewer pages are read.
    expect(data.requests[0]?.search).toContain('marketStatus=RESOLVED');
  });

  test('redeemable: a settled, unclaimed position counts only in a market the SDK redeems (types 2, 3 and 4)', async () => {
    const { client, data } = await rig();
    // One settled market of each type, each with two unclaimed positions: market 100 + type.
    const rows = [0, 1, 2, 3, 4].map((type) => {
      const row = fixtures.portfolioMarketRow(12);
      const id = 100 + type;
      return {
        ...row,
        id,
        type,
        positions: (row.positions as Array<Record<string, unknown>>).map(
          (position) => ({
            ...position,
            marketId: id,
            market: {
              ...(position.market as Record<string, unknown>),
              id,
              type,
            },
          }),
        ),
      };
    });
    data.override = (request) =>
      request.path === '/api/users/me/portfolio'
        ? HttpResponse.json({
            data: rows,
            meta: pageMeta(1, 100, rows.length),
          })
        : undefined;
    const all = await client.listPositions().firstPage();
    expect(all.items.map((p) => [p.marketId, p.status, p.redeemable])).toEqual(
      [100, 101, 102, 103, 104].flatMap((id) => {
        const row = [String(id), 'REDEEMABLE', id >= 102];
        return [row, row];
      }),
    );
    const redeemable = await client
      .listPositions({ redeemable: true })
      .firstPage();
    expect(redeemable.items.map((p) => p.marketId)).toEqual([
      '102',
      '102',
      '103',
      '103',
      '104',
      '104',
    ]);
    const others = await client
      .listPositions({ redeemable: false })
      .firstPage();
    expect(others.items.map((p) => p.marketId)).toEqual([
      '100',
      '100',
      '101',
      '101',
    ]);
  });

  test('market: only the positions of that market, by its condition id in any case', async () => {
    const { client } = await rig();
    const page = await client
      .listPositions({
        market: conditionIdOf(1).toUpperCase().replace('0X', '0x'),
      })
      .firstPage();
    expect(page.items).toHaveLength(2);
    expect(page.items.every((p) => p.conditionId === conditionIdOf(1))).toBe(
      true,
    );
  });

  test('a request that is not valid throws at once, with nothing sent', async () => {
    const { client, data } = await rig();
    for (const request of [
      { user: 'not-an-address' },
      { market: '0x01' },
      { redeemable: 'yes' },
      { pageSize: 10 },
    ]) {
      const error = await caught(() => client.listPositions(request as never));
      expect(error).toBeInstanceOf(UserInputError);
      expect(error.code).toBe('invalid_input');
    }
    expect(data.requests).toEqual([]);
  });
});

describe('fetchPortfolioValue', () => {
  test("reads the account's value, with the key", async () => {
    const { client, data } = await rig();
    const value = await client.fetchPortfolioValue();
    expect(dataCalls(data)).toEqual(['GET /api/users/me/portfolio-value']);
    expect(value).toEqual({
      value: '1136.75',
      cash: '691.5',
      positionsValue: '420.25',
      claimableAmount: '25',
      unpricedPositionCount: 0,
    });
  });
});

describe('fetchUserPnl', () => {
  test('without a request: the whole account', async () => {
    const { client, data } = await rig();
    const pnl = await client.fetchUserPnl();
    expect(dataCalls(data)).toEqual(['GET /api/user/pnl']);
    expect(pnl).toHaveProperty('openPositions');
    expect(pnl).toHaveProperty('positions');
  });

  test('with a marketId: one market', async () => {
    const { client, data } = await rig();
    const pnl = await client.fetchUserPnl({ marketId: String(PNL_MARKET_ID) });
    expect(dataCalls(data)).toEqual([
      `GET /api/user/pnl/market/${PNL_MARKET_ID}`,
    ]);
    expect(pnl.marketId).toBe(String(PNL_MARKET_ID));
    expect(pnl).toHaveProperty('title');
  });

  test('with a positionId: one position', async () => {
    const { client, data } = await rig();
    const pnl = await client.fetchUserPnl({
      positionId: String(PNL_POSITION_ID),
    });
    expect(dataCalls(data)).toEqual([
      `GET /api/user/pnl/position/${PNL_POSITION_ID}`,
    ]);
    expect(pnl.positionId).toBe(String(PNL_POSITION_ID));
  });

  test('both a marketId and a positionId: invalid_input, nothing sent', async () => {
    const { client, data } = await rig();
    const error = await caught(() =>
      client.fetchUserPnl({ marketId: '1', positionId: '2' } as never),
    );
    expect(error.code).toBe('invalid_input');
    expect(data.requests).toEqual([]);
  });
});

describe('listActivity', () => {
  test("lists the account's fills and redemptions, with the trade's hash, shares and price", async () => {
    const { client, data } = await rig();
    const page = await client.listActivity().firstPage();
    expect(dataCalls(data)).toEqual(['GET /api/users/me/market-activities']);
    expect(page.items.length).toBeGreaterThan(0);
    const trade = page.items.find((row) => row.type === 'TRADE');
    expect(trade?.side).toBeOneOf([OrderSide.BUY, OrderSide.SELL]);
    expect(trade).toHaveProperty('shares');
    expect(trade).toHaveProperty('price');
    expect(trade).toHaveProperty('transactionHash');
  });

  test('a type and a market narrow the list; REDEEM is asked of XO', async () => {
    const { client, data } = await rig();
    const page = await client
      .listActivity({ type: 'REDEEM', marketId: '12' })
      .firstPage();
    expect(data.requests[0]?.query).toMatchObject({
      positionType: 'REDEEM',
      marketId: '12',
    });
    expect(page.items.every((row) => row.type === 'REDEEM')).toBe(true);
  });

  test('an unknown type is refused at once', async () => {
    const { client, data } = await rig();
    const error = await caught(() =>
      client.listActivity({ type: 'MINT' } as never),
    );
    expect(error.code).toBe('invalid_input');
    expect(data.requests).toEqual([]);
  });
});

describe('fetchUserStats', () => {
  test("without a username: the account's own statistics", async () => {
    const { client, data } = await rig();
    const stats = await client.fetchUserStats();
    expect(dataCalls(data)).toEqual(['GET /api/users/me/stats']);
    expect(stats).toEqual({
      pnl: '-1690.288222',
      volume: '5936.423181',
      tradedMarketCount: 52,
    });
  });

  test('with a username: that user, by the public route', async () => {
    const { client, data } = await rig();
    await client.fetchUserStats({ username: PUBLIC_USER.username });
    expect(dataCalls(data)).toEqual([
      `GET /api/profiles/${PUBLIC_USER.username}/stats`,
    ]);
  });
});

describe('fetchProfile', () => {
  test("reads the account's own profile", async () => {
    const { client, data } = await rig();
    const profile = await client.fetchProfile();
    expect(dataCalls(data)).toEqual(['GET /api/users/me']);
    expect(profile).toHaveProperty('username');
    expect(profile).toHaveProperty('wallet');
    expect(profile).not.toHaveProperty('walletPublicKey');
  });
});

describe('listApiKeys', () => {
  test("lists the account's keys, without the keys themselves", async () => {
    const { client } = await rig();
    const page = await client.listApiKeys().firstPage();
    expect(page.hasMore).toBe(false);
    expect(page.items.length).toBe(2);
    expect(Object.keys(page.items[0] ?? {}).sort()).toEqual(
      [
        'createdAt',
        'expiresAt',
        'id',
        'lastUsedAt',
        'name',
        'prefix',
        'revokedAt',
        'scopes',
      ].sort(),
    );
  });
});

describe('fetchBalances', () => {
  test("the order book's credit and the shares it holds for the account", async () => {
    const { client, trading } = await rig();
    trading.accounts.set(OWNER.toLowerCase(), {
      cash: '12500000',
      positions: [
        { token_id: TOKEN_YES, balance: '3000000', reserved: '1000000' },
        { token_id: TOKEN_NO, balance: '0', reserved: '0' },
      ],
    });
    const balances = await client.fetchBalances();
    expect(balances).toEqual({
      collateral: '12.5',
      positions: [{ assetId: TOKEN_YES, balance: '3', reserved: '1' }],
    });
  });
});

describe('fetchTradingApprovalsState', () => {
  test('a wallet with nothing approved is not ready, and nothing is sent', async () => {
    const { client, sponsor } = await rig();
    expect(await client.fetchTradingApprovalsState()).toEqual({
      deployed: true,
      usdcApproved: false,
      conditionalTokensApproved: false,
      marketManagerApproved: null,
      ready: false,
    });
    expect(sponsor.bodies).toEqual([]);
  });

  test('a wallet with both approvals is ready', async () => {
    const { client } = await rig();
    state.allowance = 2n ** 256n - 1n;
    state.operatorApproved = true;
    expect(await client.fetchTradingApprovalsState()).toMatchObject({
      usdcApproved: true,
      conditionalTokensApproved: true,
      ready: true,
    });
  });

  test('an aborted signal rejects with RequestAbortedError, before any read', async () => {
    const { client } = await rig();
    const reads = chain.count('readContract');
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    const error = await caught(() =>
      client.fetchTradingApprovalsState({ signal: controller.signal }),
    );
    expect(error).toBeInstanceOf(RequestAbortedError);
    expect(chain.count('readContract')).toBe(reads);
  });
});

describe('a closed client', () => {
  test('refuses every account read with client_closed, and sends nothing', async () => {
    const { client, data } = await rig();
    await client.close();
    const before = data.requests.length;
    for (const run of [
      () => client.listPositions(),
      () => client.fetchPortfolioValue(),
      () => client.fetchUserPnl(),
      () => client.listActivity(),
      () => client.fetchUserStats(),
      () => client.fetchProfile(),
      () => client.listApiKeys(),
      () => client.fetchBalances(),
      () => client.fetchTradingApprovalsState(),
    ]) {
      const error = await caught(run);
      expect(error.code).toBe('client_closed');
    }
    expect(data.requests.length).toBe(before);
  });
});
