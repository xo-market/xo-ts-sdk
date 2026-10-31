import type { Address } from 'viem';
import { describe, expectTypeOf, test } from 'vitest';
import {
  CloseSubscriptionsError,
  type EventOf,
  type ExactSpecs,
  type PublicSubscriptionSpec,
  SubscribeError,
  type SubscriptionSpec,
} from '../src/actions/subscriptions';
import type {
  BatchOperationResult,
  OrderHeartbeat,
  PlaceLimitOrderRequest,
  ReconciledOrder,
} from '../src/actions/trading';
import type { CredentialStore } from '../src/auth/store';
import type { ActionContext } from '../src/clients/context';
import { isPublicClient, isSecureClient } from '../src/clients/guards';
import {
  type BoundAction,
  createPublicClient,
  type PublicClient,
  type PublicClientOptions,
  type publicActions,
} from '../src/clients/public';
import {
  createSecureClient,
  type SecureClient,
  type SecureClientOptions,
  type secureActions,
  type WalletCredentials,
} from '../src/clients/secure';
import { type EnvironmentConfig, production } from '../src/core/env';
import type { XoError } from '../src/core/errors';
import type { Paginated } from '../src/core/paginated';
import type { RequestOptions } from '../src/core/requestOptions';
import type { RateLimitUpdate } from '../src/core/transport';
import type { DecimalString } from '../src/core/types';
import type {
  MarketPnl,
  Position,
  PositionPnl,
  RedemptionResult,
  TransactionHandle,
  UserPnl,
} from '../src/models/account';
import type {
  BridgePayment,
  BridgeWithdrawal,
  DepositQuote,
  WithdrawalQuote,
} from '../src/models/bridge';
import { OrderSide, OrderType } from '../src/models/enums';
import type {
  LastTradePrice,
  MarketCapacity,
  PricePoint,
  PricesBySide,
} from '../src/models/marketData';
import type { OrderBook } from '../src/models/orderBook';
import type {
  CancelOrdersResponse,
  OpenOrder,
  OrderResponse,
  SignedOrder,
} from '../src/models/orders';
import type {
  ActivityEvent,
  LastTradePriceEvent,
  MarketBookEvent,
  MarketTopicEvent,
  PortfolioEvent,
  PriceChangeEvent,
  ReconnectedInfo,
  SubscriptionHandle,
  SubscriptionTopic,
  UserEvent,
  UserOrderEvent,
  UserTradeEvent,
} from '../src/models/realtime';
import type { RewardPool, UserRewards } from '../src/models/rewards';
import type { Trade } from '../src/models/trades';
import type { Signer } from '../src/wallet/publicSigner';

/** The overloads of an action, with its context bound. */
type BoundOverloads<F> = F extends {
  (ctx: ActionContext, ...args: infer A1): infer First;
  (ctx: ActionContext, ...args: infer A2): infer Second;
  (ctx: ActionContext, ...args: infer A3): infer Third;
}
  ? {
      (...args: A1): First;
      (...args: A2): Second;
      (...args: A3): Third;
    }
  : never;

describe('PublicClient', () => {
  test('has no member that needs a wallet to act or to read its own account', () => {
    expectTypeOf<PublicClient>().not.toHaveProperty('placeLimitOrder');
    expectTypeOf<PublicClient>().not.toHaveProperty('placeMarketOrder');
    expectTypeOf<PublicClient>().not.toHaveProperty('cancelOrder');
    expectTypeOf<PublicClient>().not.toHaveProperty('listOpenOrders');
    expectTypeOf<PublicClient>().not.toHaveProperty('fetchBalances');
    expectTypeOf<PublicClient>().not.toHaveProperty('fetchPortfolioValue');
    expectTypeOf<PublicClient>().not.toHaveProperty('transferErc20');
    expectTypeOf<PublicClient>().not.toHaveProperty('withdraw');
    expectTypeOf<PublicClient>().not.toHaveProperty('fetchMarketCapacity');
    expectTypeOf<PublicClient>().not.toHaveProperty('endAuthentication');
  });

  test('reads of a wallet take the wallet', () => {
    type Request = Parameters<PublicClient['fetchUserRewards']>[0];
    expectTypeOf<Request>().toEqualTypeOf<{ user: string }>();
    // @ts-expect-error the wallet is required on a client without one
    createPublicClient().fetchUserRewards({});
    expectTypeOf<
      PublicClient['fetchUserRewards']
    >().returns.resolves.toEqualTypeOf<UserRewards>();
  });

  test('fetchSmartWalletAddress takes an owner and an optional index, and gives an address', () => {
    type Request = Parameters<PublicClient['fetchSmartWalletAddress']>[0];
    expectTypeOf<Request>().toEqualTypeOf<{ owner: string; index?: number }>();
    expectTypeOf<
      PublicClient['fetchSmartWalletAddress']
    >().returns.resolves.toEqualTypeOf<Address>();
    // @ts-expect-error the owner is required
    createPublicClient().fetchSmartWalletAddress({ index: 0 });
    // A signed-in client has it too, as it is.
    expectTypeOf<SecureClient['fetchSmartWalletAddress']>().toEqualTypeOf<
      PublicClient['fetchSmartWalletAddress']
    >();
  });

  test("listPositions reads any wallet's positions, and needs the wallet", () => {
    type Request = Parameters<PublicClient['listPositions']>[0];
    expectTypeOf<Request['user']>().toEqualTypeOf<string>();
    // @ts-expect-error the wallet is required on a client without one
    createPublicClient().listPositions({});
    // @ts-expect-error and so is the request
    createPublicClient().listPositions();
    expectTypeOf<PublicClient['listPositions']>().toEqualTypeOf<
      BoundAction<(typeof publicActions)['listPositions']>
    >();
    expectTypeOf<PublicClient['listPositions']>().returns.toEqualTypeOf<
      Paginated<Position>
    >();
  });

  test('each read takes its request and then the options of the call', () => {
    const client = createPublicClient();
    const controller = new AbortController();
    expectTypeOf(
      client.fetchOrderBook(
        { assetId: '1' },
        { retries: 1, signal: controller.signal },
      ),
    ).resolves.toEqualTypeOf<OrderBook>();
    expectTypeOf(
      client.fetchOrderBook({ assetId: '1' }, { timeout: false }),
    ).resolves.toEqualTypeOf<OrderBook>();
    expectTypeOf<Parameters<PublicClient['fetchOrderBook']>[1]>().toEqualTypeOf<
      RequestOptions | undefined
    >();
    expectTypeOf<Parameters<PublicClient['fetchTradingState']>>().toEqualTypeOf<
      [options?: RequestOptions | undefined]
    >();
    expectTypeOf<Parameters<PublicClient['listRewardPools']>>().toEqualTypeOf<
      [options?: RequestOptions | undefined]
    >();
  });

  test('a read that has no request takes options first', () => {
    const client = createPublicClient();
    expectTypeOf(
      client.fetchTradingState({ retries: 0 }),
    ).resolves.toEqualTypeOf<'active' | 'paused' | (string & {})>();
    expectTypeOf(client.listRewardPools({ retries: 0 })).toEqualTypeOf<
      Paginated<RewardPool>
    >();
  });

  test('options other than those of a read do not compile', () => {
    const client = createPublicClient();
    // @ts-expect-error a read takes no body-level extras
    client.fetchOrderBook({ assetId: '1' }, { retries: 1, extra: true });
    // @ts-expect-error the request of a read is one object, not positional
    client.fetchOrderBook('1');
    // @ts-expect-error the side of a price is a side
    client.fetchPrice({ assetId: '1', side: 'HOLD' });
  });

  test('the side of a price may be OrderSide or its text', () => {
    const client = createPublicClient();
    client.fetchPrice({ assetId: '1', side: OrderSide.BUY });
    client.fetchPrice({ assetId: '1', side: 'SELL' });
  });

  test('the answers are the models', () => {
    const client = createPublicClient();
    expectTypeOf(
      client.fetchMidpoint({ assetId: '1' }),
    ).resolves.toEqualTypeOf<DecimalString | null>();
    expectTypeOf(
      client.fetchMidpoints({ assetIds: ['1'] }),
    ).resolves.toEqualTypeOf<Record<string, DecimalString | null>>();
    expectTypeOf(
      client.fetchPrice({ assetId: '1', side: OrderSide.BUY }),
    ).resolves.toEqualTypeOf<DecimalString | null>();
    expectTypeOf(
      client.fetchPrices({ requests: [{ assetId: '1', side: 'BUY' }] }),
    ).resolves.toEqualTypeOf<Record<string, PricesBySide>>();
    expectTypeOf<PricesBySide['BUY']>().toEqualTypeOf<
      DecimalString | null | undefined
    >();
    expectTypeOf(
      client.fetchSpread({ assetId: '1' }),
    ).resolves.toEqualTypeOf<DecimalString | null>();
    expectTypeOf(
      client.fetchSpreads({ assetIds: ['1'] }),
    ).resolves.toEqualTypeOf<Record<string, DecimalString | null>>();
    expectTypeOf(
      client.fetchLastTradePrice({ assetId: '1' }),
    ).resolves.toEqualTypeOf<LastTradePrice | null>();
    expectTypeOf(
      client.listPriceHistory({ assetId: '1', interval: '1d' }),
    ).toEqualTypeOf<Paginated<PricePoint>>();
  });

  test('the price history takes the intervals of the order book', () => {
    const client = createPublicClient();
    for (const interval of ['1h', '6h', '1d', '1w', 'max'] as const) {
      client.listPriceHistory({ assetId: '1', interval });
    }
    // @ts-expect-error an interval is one of the five
    client.listPriceHistory({ assetId: '1', interval: '1m' });
    // @ts-expect-error an interval is required
    client.listPriceHistory({ assetId: '1' });
  });

  test('the fills of a market need the market', () => {
    const client = createPublicClient();
    client.listTrades({ marketId: '1', side: 'BUY', pageSize: 5 });
    // @ts-expect-error a market id is required
    client.listTrades({});
    // @ts-expect-error and so is the request
    client.listTrades();
  });

  test('closeSubscriptions returns a promise', () => {
    expectTypeOf<
      PublicClient['closeSubscriptions']
    >().returns.resolves.toBeVoid();
  });

  test('the guards narrow an unknown value', () => {
    const value: unknown = undefined;
    if (isPublicClient(value)) {
      expectTypeOf(value).toEqualTypeOf<PublicClient>();
    }
    if (isSecureClient(value)) {
      expectTypeOf(value).toEqualTypeOf<SecureClient>();
    }
  });

  test('every action takes the context first, and the client leaves it out', () => {
    type Bound = PublicClient['fetchOrderBook'];
    expectTypeOf<Parameters<Bound>[0]>().toEqualTypeOf<{ assetId: string }>();
    expectTypeOf<Parameters<Bound>[0]>().not.toExtend<ActionContext>();
  });
});

describe('PublicClient is pinned to the actions it binds', () => {
  type Actions = typeof publicActions;

  test('it has a member per action, subscribe and closeSubscriptions, and nothing else', () => {
    expectTypeOf<keyof PublicClient>().toEqualTypeOf<
      keyof Actions | 'subscribe' | 'closeSubscriptions'
    >();
  });

  test('subscribe takes the public topics and keeps their events', () => {
    expectTypeOf<PublicClient['subscribe']>().toEqualTypeOf<
      <const S extends readonly PublicSubscriptionSpec[]>(
        specs: S & ExactSpecs<S>,
      ) => Promise<SubscriptionHandle<EventOf<S[number]>>>
    >();
    expectTypeOf<PublicClient['closeSubscriptions']>().toEqualTypeOf<
      () => Promise<void>
    >();
  });

  test('each member has the signature of its bound action', () => {
    expectTypeOf<PublicClient['listMarkets']>().toEqualTypeOf<
      BoundAction<Actions['listMarkets']>
    >();
    expectTypeOf<PublicClient['fetchMarket']>().toEqualTypeOf<
      BoundAction<Actions['fetchMarket']>
    >();
    expectTypeOf<PublicClient['fetchMarketTradability']>().toEqualTypeOf<
      BoundAction<Actions['fetchMarketTradability']>
    >();
    expectTypeOf<PublicClient['listBrowseItems']>().toEqualTypeOf<
      BoundAction<Actions['listBrowseItems']>
    >();
    expectTypeOf<PublicClient['listEvents']>().toEqualTypeOf<
      BoundAction<Actions['listEvents']>
    >();
    expectTypeOf<PublicClient['fetchEvent']>().toEqualTypeOf<
      BoundAction<Actions['fetchEvent']>
    >();
    expectTypeOf<PublicClient['listSubevents']>().toEqualTypeOf<
      BoundAction<Actions['listSubevents']>
    >();
    expectTypeOf<PublicClient['listSeries']>().toEqualTypeOf<
      BoundAction<Actions['listSeries']>
    >();
    expectTypeOf<PublicClient['fetchSeries']>().toEqualTypeOf<
      BoundAction<Actions['fetchSeries']>
    >();
    expectTypeOf<PublicClient['listCategories']>().toEqualTypeOf<
      BoundAction<Actions['listCategories']>
    >();
    expectTypeOf<PublicClient['listSubcategories']>().toEqualTypeOf<
      BoundAction<Actions['listSubcategories']>
    >();
    expectTypeOf<PublicClient['fetchCollateralTokens']>().toEqualTypeOf<
      BoundAction<Actions['fetchCollateralTokens']>
    >();
    expectTypeOf<PublicClient['listPulseMarkets']>().toEqualTypeOf<
      BoundAction<Actions['listPulseMarkets']>
    >();
    expectTypeOf<PublicClient['fetchPulseStats']>().toEqualTypeOf<
      BoundAction<Actions['fetchPulseStats']>
    >();
    expectTypeOf<PublicClient['fetchPublicProfile']>().toEqualTypeOf<
      BoundAction<Actions['fetchPublicProfile']>
    >();
    expectTypeOf<PublicClient['fetchUserStats']>().toEqualTypeOf<
      BoundAction<Actions['fetchUserStats']>
    >();
    expectTypeOf<PublicClient['fetchSmartWalletAddress']>().toEqualTypeOf<
      BoundAction<Actions['fetchSmartWalletAddress']>
    >();
    expectTypeOf<PublicClient['fetchOrderBook']>().toEqualTypeOf<
      BoundAction<Actions['fetchOrderBook']>
    >();
    expectTypeOf<PublicClient['fetchOrderBooks']>().toEqualTypeOf<
      BoundAction<Actions['fetchOrderBooks']>
    >();
    expectTypeOf<PublicClient['fetchMidpoint']>().toEqualTypeOf<
      BoundAction<Actions['fetchMidpoint']>
    >();
    expectTypeOf<PublicClient['fetchMidpoints']>().toEqualTypeOf<
      BoundAction<Actions['fetchMidpoints']>
    >();
    expectTypeOf<PublicClient['fetchPrice']>().toEqualTypeOf<
      BoundAction<Actions['fetchPrice']>
    >();
    expectTypeOf<PublicClient['fetchPrices']>().toEqualTypeOf<
      BoundAction<Actions['fetchPrices']>
    >();
    expectTypeOf<PublicClient['fetchSpread']>().toEqualTypeOf<
      BoundAction<Actions['fetchSpread']>
    >();
    expectTypeOf<PublicClient['fetchSpreads']>().toEqualTypeOf<
      BoundAction<Actions['fetchSpreads']>
    >();
    expectTypeOf<PublicClient['fetchLastTradePrice']>().toEqualTypeOf<
      BoundAction<Actions['fetchLastTradePrice']>
    >();
    expectTypeOf<PublicClient['fetchLastTradePrices']>().toEqualTypeOf<
      BoundAction<Actions['fetchLastTradePrices']>
    >();
    expectTypeOf<PublicClient['listPriceHistory']>().toEqualTypeOf<
      BoundAction<Actions['listPriceHistory']>
    >();
    expectTypeOf<PublicClient['fetchTradingState']>().toEqualTypeOf<
      BoundAction<Actions['fetchTradingState']>
    >();
    expectTypeOf<PublicClient['fetchConvictionMarket']>().toEqualTypeOf<
      BoundAction<Actions['fetchConvictionMarket']>
    >();
    expectTypeOf<PublicClient['listTrades']>().toEqualTypeOf<
      BoundAction<Actions['listTrades']>
    >();
    expectTypeOf<PublicClient['listRewardPools']>().toEqualTypeOf<
      BoundAction<Actions['listRewardPools']>
    >();
    expectTypeOf<PublicClient['listRewardGroups']>().toEqualTypeOf<
      BoundAction<Actions['listRewardGroups']>
    >();
    expectTypeOf<PublicClient['fetchRewardGroup']>().toEqualTypeOf<
      BoundAction<Actions['fetchRewardGroup']>
    >();
    expectTypeOf<PublicClient['fetchMarketRewards']>().toEqualTypeOf<
      BoundAction<Actions['fetchMarketRewards']>
    >();
    expectTypeOf<PublicClient['fetchMarketRewardsEpoch']>().toEqualTypeOf<
      BoundAction<Actions['fetchMarketRewardsEpoch']>
    >();
    expectTypeOf<PublicClient['listMarketRewardsMakers']>().toEqualTypeOf<
      BoundAction<Actions['listMarketRewardsMakers']>
    >();
    expectTypeOf<PublicClient['listMarketRewardsOrders']>().toEqualTypeOf<
      BoundAction<Actions['listMarketRewardsOrders']>
    >();
    expectTypeOf<PublicClient['fetchUserRewards']>().toEqualTypeOf<
      BoundAction<Actions['fetchUserRewards']>
    >();
    expectTypeOf<PublicClient['fetchUserRewardsEpoch']>().toEqualTypeOf<
      BoundAction<Actions['fetchUserRewardsEpoch']>
    >();
    expectTypeOf<PublicClient['listUserRewardsOrders']>().toEqualTypeOf<
      BoundAction<Actions['listUserRewardsOrders']>
    >();
  });
});

describe('createPublicClient', () => {
  test('takes no argument, or the options of a public client', () => {
    expectTypeOf(createPublicClient).returns.toEqualTypeOf<PublicClient>();
    expectTypeOf(createPublicClient).parameters.toEqualTypeOf<
      [options?: PublicClientOptions | undefined]
    >();
    createPublicClient();
    createPublicClient({});
    createPublicClient({ environment: {} as EnvironmentConfig });
    createPublicClient({
      fetch: (async () => new Response()) as typeof fetch,
      WebSocket: {} as typeof WebSocket,
      onRateLimitUpdate: (update: RateLimitUpdate) => {
        void update.retryAfter;
      },
    });
  });

  test('has no environment name', () => {
    // @ts-expect-error there is no env option; pass an environment config or nothing
    createPublicClient({ env: production });
    // @ts-expect-error the environment is a config, not a name
    createPublicClient({ environment: 'mainnet' });
  });

  test('has no client-level retry, and no key or wallet option', () => {
    // @ts-expect-error retries belong to each call
    createPublicClient({ retries: 2 });
    // @ts-expect-error a public client has no API key
    createPublicClient({ apiKey: 'k' });
    // @ts-expect-error a public client has no signer
    createPublicClient({ signer: {} });
    // @ts-expect-error the callback is named onRateLimitUpdate
    createPublicClient({ onRateLimit: () => {} });
  });

  test('the rate-limit update carries retryAfter in milliseconds', () => {
    expectTypeOf<RateLimitUpdate['retryAfter']>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<RateLimitUpdate>().not.toHaveProperty('retryAfterMs');
  });
});

describe('SecureClient', () => {
  const signer = {} as Signer;

  test('the signer is required', () => {
    // @ts-expect-error the signer is required
    void createSecureClient({});
    // @ts-expect-error the options are required
    void createSecureClient();
    void createSecureClient({ signer });
    expectTypeOf<SecureClientOptions['signer']>().toEqualTypeOf<Signer>();
  });

  test('it resolves to a SecureClient, which has every member of the public client', () => {
    expectTypeOf(
      createSecureClient,
    ).returns.resolves.toEqualTypeOf<SecureClient>();
    expectTypeOf<SecureClient>().toExtend<PublicClient>();
    expectTypeOf<PublicClient>().not.toExtend<SecureClient>();
  });

  test('it cannot revoke another API key: a key revokes only itself, with endAuthentication', () => {
    expectTypeOf<SecureClient>().not.toHaveProperty('revokeApiKey');
  });

  test('the members it adds, and nothing else yet', () => {
    expectTypeOf<
      Exclude<keyof SecureClient, keyof PublicClient>
    >().toEqualTypeOf<
      | 'wallet'
      | 'endAuthentication'
      | 'close'
      | 'rotateCredentials'
      | 'exportCredentials'
      | Exclude<keyof typeof secureActions, keyof PublicClient>
    >();
    // The reads of a wallet that the secure client makes of its own wallet by default.
    expectTypeOf<
      Extract<keyof typeof secureActions, keyof PublicClient>
    >().toEqualTypeOf<
      | 'listPositions'
      | 'fetchUserStats'
      | 'fetchUserRewards'
      | 'fetchUserRewardsEpoch'
      | 'listUserRewardsOrders'
    >();
    expectTypeOf<keyof typeof secureActions>().toEqualTypeOf<
      | 'createLimitOrder'
      | 'createMarketOrder'
      | 'placeLimitOrder'
      | 'placeMarketOrder'
      | 'postOrder'
      | 'postOrders'
      | 'postOrderBatch'
      | 'cancelOrder'
      | 'cancelOrders'
      | 'cancelAll'
      | 'cancelMarketOrders'
      | 'listOpenOrders'
      | 'fetchOrder'
      | 'listAccountTrades'
      | 'fetchAccountTrade'
      | 'sendOrderHeartbeat'
      | 'startOrderHeartbeat'
      | 'reconcileOrder'
      | 'fetchMarketCapacity'
      | 'listPositions'
      | 'fetchPortfolioValue'
      | 'fetchUserPnl'
      | 'listActivity'
      | 'fetchUserStats'
      | 'fetchProfile'
      | 'listApiKeys'
      | 'fetchBalances'
      | 'fetchTradingApprovalsState'
      | 'setupTradingApprovals'
      | 'mergePositions'
      | 'redeemPositions'
      | 'redeemAllPositions'
      | 'transferErc20'
      | 'listBridgeAssets'
      | 'quoteDeposit'
      | 'quoteWithdrawal'
      | 'createDeposit'
      | 'withdraw'
      | 'verifyBridgePayment'
      | 'fetchBridgePayment'
      | 'waitForBridgePayment'
      | 'listBridgePayments'
      | 'listRewardsLeaderboard'
      | 'fetchRewardsLeaderboardStanding'
      | 'fetchUserRewards'
      | 'fetchUserRewardsEpoch'
      | 'listUserRewardsOrders'
    >();
  });

  test('each member it adds has its signature', () => {
    expectTypeOf<SecureClient['wallet']>().toEqualTypeOf<Address>();
    expectTypeOf<SecureClient['endAuthentication']>().toEqualTypeOf<
      () => Promise<PublicClient>
    >();
    expectTypeOf<SecureClient['close']>().toEqualTypeOf<() => Promise<void>>();
    expectTypeOf<SecureClient['rotateCredentials']>().toEqualTypeOf<
      () => Promise<void>
    >();
    expectTypeOf<SecureClient['exportCredentials']>().toEqualTypeOf<
      () => Promise<Required<WalletCredentials>>
    >();
  });

  test('each trading member has the signature of its bound action', () => {
    type Actions = typeof secureActions;
    expectTypeOf<SecureClient['createLimitOrder']>().toEqualTypeOf<
      BoundAction<Actions['createLimitOrder']>
    >();
    expectTypeOf<SecureClient['createMarketOrder']>().toEqualTypeOf<
      BoundAction<Actions['createMarketOrder']>
    >();
    expectTypeOf<SecureClient['placeLimitOrder']>().toEqualTypeOf<
      BoundAction<Actions['placeLimitOrder']>
    >();
    expectTypeOf<SecureClient['placeMarketOrder']>().toEqualTypeOf<
      BoundAction<Actions['placeMarketOrder']>
    >();
    expectTypeOf<SecureClient['postOrder']>().toEqualTypeOf<
      BoundAction<Actions['postOrder']>
    >();
    expectTypeOf<SecureClient['postOrders']>().toEqualTypeOf<
      BoundAction<Actions['postOrders']>
    >();
    expectTypeOf<SecureClient['postOrderBatch']>().toEqualTypeOf<
      BoundAction<Actions['postOrderBatch']>
    >();
    expectTypeOf<SecureClient['cancelOrder']>().toEqualTypeOf<
      BoundAction<Actions['cancelOrder']>
    >();
    expectTypeOf<SecureClient['cancelOrders']>().toEqualTypeOf<
      BoundAction<Actions['cancelOrders']>
    >();
    expectTypeOf<SecureClient['cancelAll']>().toEqualTypeOf<
      BoundAction<Actions['cancelAll']>
    >();
    expectTypeOf<SecureClient['cancelMarketOrders']>().toEqualTypeOf<
      BoundAction<Actions['cancelMarketOrders']>
    >();
    expectTypeOf<SecureClient['listOpenOrders']>().toEqualTypeOf<
      BoundAction<Actions['listOpenOrders']>
    >();
    expectTypeOf<SecureClient['fetchOrder']>().toEqualTypeOf<
      BoundAction<Actions['fetchOrder']>
    >();
    expectTypeOf<SecureClient['listAccountTrades']>().toEqualTypeOf<
      BoundAction<Actions['listAccountTrades']>
    >();
    expectTypeOf<SecureClient['fetchAccountTrade']>().toEqualTypeOf<
      BoundAction<Actions['fetchAccountTrade']>
    >();
    expectTypeOf<SecureClient['sendOrderHeartbeat']>().toEqualTypeOf<
      BoundAction<Actions['sendOrderHeartbeat']>
    >();
    expectTypeOf<SecureClient['startOrderHeartbeat']>().toEqualTypeOf<
      BoundAction<Actions['startOrderHeartbeat']>
    >();
    expectTypeOf<SecureClient['reconcileOrder']>().toEqualTypeOf<
      BoundAction<Actions['reconcileOrder']>
    >();
    expectTypeOf<SecureClient['fetchMarketCapacity']>().toEqualTypeOf<
      BoundAction<Actions['fetchMarketCapacity']>
    >();
  });

  test('each account, on-chain, bridge and rewards member has the signature of its bound action', () => {
    type Actions = typeof secureActions;
    expectTypeOf<SecureClient['listPositions']>().toEqualTypeOf<
      BoundAction<Actions['listPositions']>
    >();
    expectTypeOf<SecureClient['fetchPortfolioValue']>().toEqualTypeOf<
      BoundAction<Actions['fetchPortfolioValue']>
    >();
    expectTypeOf<SecureClient['listActivity']>().toEqualTypeOf<
      BoundAction<Actions['listActivity']>
    >();
    expectTypeOf<SecureClient['fetchUserStats']>().toEqualTypeOf<
      BoundAction<Actions['fetchUserStats']>
    >();
    expectTypeOf<SecureClient['fetchProfile']>().toEqualTypeOf<
      BoundAction<Actions['fetchProfile']>
    >();
    expectTypeOf<SecureClient['listApiKeys']>().toEqualTypeOf<
      BoundAction<Actions['listApiKeys']>
    >();
    expectTypeOf<SecureClient['fetchBalances']>().toEqualTypeOf<
      BoundAction<Actions['fetchBalances']>
    >();
    expectTypeOf<SecureClient['fetchTradingApprovalsState']>().toEqualTypeOf<
      BoundAction<Actions['fetchTradingApprovalsState']>
    >();
    expectTypeOf<SecureClient['setupTradingApprovals']>().toEqualTypeOf<
      BoundAction<Actions['setupTradingApprovals']>
    >();
    expectTypeOf<SecureClient['mergePositions']>().toEqualTypeOf<
      BoundAction<Actions['mergePositions']>
    >();
    expectTypeOf<SecureClient['redeemPositions']>().toEqualTypeOf<
      BoundAction<Actions['redeemPositions']>
    >();
    expectTypeOf<SecureClient['redeemAllPositions']>().toEqualTypeOf<
      BoundAction<Actions['redeemAllPositions']>
    >();
    expectTypeOf<SecureClient['transferErc20']>().toEqualTypeOf<
      BoundAction<Actions['transferErc20']>
    >();
    expectTypeOf<SecureClient['listBridgeAssets']>().toEqualTypeOf<
      BoundAction<Actions['listBridgeAssets']>
    >();
    expectTypeOf<SecureClient['quoteDeposit']>().toEqualTypeOf<
      BoundAction<Actions['quoteDeposit']>
    >();
    expectTypeOf<SecureClient['quoteWithdrawal']>().toEqualTypeOf<
      BoundAction<Actions['quoteWithdrawal']>
    >();
    expectTypeOf<SecureClient['createDeposit']>().toEqualTypeOf<
      BoundAction<Actions['createDeposit']>
    >();
    expectTypeOf<SecureClient['withdraw']>().toEqualTypeOf<
      BoundAction<Actions['withdraw']>
    >();
    expectTypeOf<SecureClient['verifyBridgePayment']>().toEqualTypeOf<
      BoundAction<Actions['verifyBridgePayment']>
    >();
    expectTypeOf<SecureClient['fetchBridgePayment']>().toEqualTypeOf<
      BoundAction<Actions['fetchBridgePayment']>
    >();
    expectTypeOf<SecureClient['waitForBridgePayment']>().toEqualTypeOf<
      BoundAction<Actions['waitForBridgePayment']>
    >();
    expectTypeOf<SecureClient['listBridgePayments']>().toEqualTypeOf<
      BoundAction<Actions['listBridgePayments']>
    >();
    expectTypeOf<SecureClient['listRewardsLeaderboard']>().toEqualTypeOf<
      BoundAction<Actions['listRewardsLeaderboard']>
    >();
    expectTypeOf<
      SecureClient['fetchRewardsLeaderboardStanding']
    >().toEqualTypeOf<
      BoundAction<Actions['fetchRewardsLeaderboardStanding']>
    >();
    expectTypeOf<SecureClient['fetchUserRewards']>().toEqualTypeOf<
      BoundAction<Actions['fetchUserRewards']>
    >();
    expectTypeOf<SecureClient['fetchUserRewardsEpoch']>().toEqualTypeOf<
      BoundAction<Actions['fetchUserRewardsEpoch']>
    >();
    expectTypeOf<SecureClient['listUserRewardsOrders']>().toEqualTypeOf<
      BoundAction<Actions['listUserRewardsOrders']>
    >();
  });

  test('fetchUserPnl answers by the shape of its request', () => {
    const client = {} as SecureClient;
    expectTypeOf(client.fetchUserPnl()).resolves.toEqualTypeOf<UserPnl>();
    expectTypeOf(client.fetchUserPnl({})).resolves.toEqualTypeOf<UserPnl>();
    expectTypeOf(
      client.fetchUserPnl({ marketId: '1' }, { retries: 0 }),
    ).resolves.toEqualTypeOf<MarketPnl>();
    expectTypeOf(
      client.fetchUserPnl({ positionId: '1' }),
    ).resolves.toEqualTypeOf<PositionPnl>();
    // @ts-expect-error one market or one position, not both
    void client.fetchUserPnl({ marketId: '1', positionId: '1' });
    // The client's member is the action, overloads and all.
    expectTypeOf<
      BoundOverloads<(typeof secureActions)['fetchUserPnl']>
    >().toExtend<SecureClient['fetchUserPnl']>();
  });

  test('the reads of a wallet default to the own wallet on a secure client', () => {
    const client = {} as SecureClient;
    expectTypeOf(client.listPositions()).toEqualTypeOf<Paginated<Position>>();
    void client.listPositions({ redeemable: true }, { retries: 0 });
    void client.listPositions({ user: '0x01' });
    void client.fetchUserStats();
    void client.fetchUserStats({ username: 'someone' });
    void client.fetchUserRewards();
    void client.fetchUserRewardsEpoch({ epoch: 20_743 });
    void client.listUserRewardsOrders();
  });

  test('what the on-chain and bridge members return', () => {
    expectTypeOf<
      SecureClient['setupTradingApprovals']
    >().returns.resolves.toEqualTypeOf<TransactionHandle | null>();
    expectTypeOf<
      SecureClient['transferErc20']
    >().returns.resolves.toEqualTypeOf<TransactionHandle>();
    expectTypeOf<
      SecureClient['mergePositions']
    >().returns.resolves.toEqualTypeOf<TransactionHandle>();
    expectTypeOf<
      SecureClient['redeemAllPositions']
    >().returns.resolves.toEqualTypeOf<RedemptionResult[]>();
    expectTypeOf<SecureClient['quoteDeposit']>().returns.resolves.toEqualTypeOf<
      DepositQuote[]
    >();
    expectTypeOf<
      SecureClient['withdraw']
    >().returns.resolves.toEqualTypeOf<BridgeWithdrawal>();
    expectTypeOf<
      SecureClient['waitForBridgePayment']
    >().returns.resolves.toEqualTypeOf<BridgePayment>();
    expectTypeOf<SecureClient['listBridgePayments']>().returns.toEqualTypeOf<
      Paginated<BridgePayment>
    >();
  });

  test('an on-chain send, a deposit, a withdrawal and a revoke take no options; a quote and a wait do', () => {
    const client = {} as SecureClient;
    // @ts-expect-error a send is never retried, so it takes no options
    void client.setupTradingApprovals(undefined, { retries: 1 });
    // @ts-expect-error nor does a transfer
    void client.transferErc20({ to: '0x01', amount: '1' }, { retries: 1 });
    // @ts-expect-error nor a merge
    void client.mergePositions({ conditionId: '0x01' }, { timeout: 1_000 });
    // @ts-expect-error nor a redeem of every market
    void client.redeemAllPositions({ retries: 0 });
    // @ts-expect-error nor a withdrawal
    void client.withdraw({ quote: {} as WithdrawalQuote }, { retries: 1 });
    expectTypeOf<
      Parameters<SecureClient['setupTradingApprovals']>
    >().toEqualTypeOf<[]>();
    expectTypeOf<
      Parameters<SecureClient['redeemAllPositions']>
    >().toEqualTypeOf<[]>();
    void client.quoteDeposit(
      { assetId: 'base:0x01', amount: '1' },
      { retries: 1 },
    );
    void client.waitForBridgePayment(
      { paymentId: 'pay_1' },
      { signal: {} as AbortSignal, timeout: 60_000 },
    );
    // @ts-expect-error a wait is not retried: it reads again until the payment is final
    void client.waitForBridgePayment({ paymentId: 'pay_1' }, { retries: 1 });
  });

  test('what the trading members return', () => {
    expectTypeOf<
      SecureClient['createLimitOrder']
    >().returns.resolves.toEqualTypeOf<SignedOrder>();
    expectTypeOf<
      SecureClient['placeLimitOrder']
    >().returns.resolves.toEqualTypeOf<OrderResponse>();
    expectTypeOf<SecureClient['postOrders']>().returns.resolves.toEqualTypeOf<
      OrderResponse[]
    >();
    expectTypeOf<
      SecureClient['postOrderBatch']
    >().returns.resolves.toEqualTypeOf<BatchOperationResult[]>();
    expectTypeOf<
      SecureClient['cancelAll']
    >().returns.resolves.toEqualTypeOf<CancelOrdersResponse>();
    expectTypeOf<SecureClient['listOpenOrders']>().returns.toEqualTypeOf<
      Paginated<OpenOrder>
    >();
    expectTypeOf<SecureClient['listAccountTrades']>().returns.toEqualTypeOf<
      Paginated<Trade>
    >();
    expectTypeOf<
      SecureClient['sendOrderHeartbeat']
    >().returns.resolves.toEqualTypeOf<{ tracked: boolean }>();
    // A handle, at once: not a promise of one.
    expectTypeOf<
      SecureClient['startOrderHeartbeat']
    >().returns.toEqualTypeOf<OrderHeartbeat>();
    expectTypeOf<
      SecureClient['reconcileOrder']
    >().returns.resolves.toEqualTypeOf<ReconciledOrder>();
    expectTypeOf<
      SecureClient['fetchMarketCapacity']
    >().returns.resolves.toEqualTypeOf<MarketCapacity>();
  });

  test('a side is an OrderSide: a string literal does not compile', () => {
    const client = {} as SecureClient;
    void client.placeLimitOrder({
      assetId: '1',
      side: OrderSide.BUY,
      price: '0.5',
      size: 10,
    });
    void client.placeLimitOrder({
      assetId: '1',
      // @ts-expect-error the side is OrderSide.BUY, not the text
      side: 'BUY',
      price: '0.5',
      size: 10,
    });
    void client.createMarketOrder({
      assetId: '1',
      side: OrderSide.SELL,
      shares: 5,
      orderType: OrderType.FOK,
    });
    void client.createMarketOrder({
      assetId: '1',
      side: OrderSide.BUY,
      // @ts-expect-error a market buy spends an amount; shares are for a sell
      shares: 5,
    });
    void client.createMarketOrder({
      assetId: '1',
      side: OrderSide.BUY,
      amount: 5,
      // @ts-expect-error a market order is FAK or FOK
      orderType: OrderType.GTC,
    });
  });

  test('a call that sends orders or cancels takes no options; a read does', () => {
    const client = {} as SecureClient;
    const request = {
      assetId: '1',
      side: OrderSide.BUY,
      price: '0.5',
      size: 10,
    };
    // @ts-expect-error a placement is never retried, so it takes no options
    void client.placeLimitOrder(request, { retries: 1 });
    // @ts-expect-error nor a signal: aborting cannot undo a placement
    void client.postOrder({} as SignedOrder, { signal: {} as AbortSignal });
    // @ts-expect-error a cancel takes no options either
    void client.cancelAll({ retries: 0 });
    // @ts-expect-error nor does a heartbeat
    void client.sendOrderHeartbeat({ timeout: 1_000 });
    void client.listOpenOrders({ market: '0x01' }, { retries: 0 });
    void client.fetchOrder({ orderId: '1' }, { timeout: 5_000 });
    void client.listAccountTrades(undefined, { retries: 1 });
    void client.reconcileOrder({ orderHash: '0x01' }, { retries: 0 });
    expectTypeOf<Parameters<SecureClient['placeLimitOrder']>>().toEqualTypeOf<
      [request: PlaceLimitOrderRequest]
    >();
    expectTypeOf<Parameters<SecureClient['postOrder']>>().toEqualTypeOf<
      [order: SignedOrder]
    >();
    expectTypeOf<Parameters<SecureClient['cancelAll']>>().toEqualTypeOf<[]>();
    expectTypeOf<
      Parameters<SecureClient['sendOrderHeartbeat']>
    >().toEqualTypeOf<[]>();
  });

  test('a market cancel names a market or an outcome', () => {
    const client = {} as SecureClient;
    void client.cancelMarketOrders({ market: '0x01' });
    void client.cancelMarketOrders({ assetId: '1' });
    // @ts-expect-error one of the two is needed
    void client.cancelMarketOrders({});
  });

  test('wallet is read-only', () => {
    const client = {} as SecureClient;
    // @ts-expect-error the trading address cannot be changed
    client.wallet = '0x0000000000000000000000000000000000000001';
  });

  test('its options: the public ones and the wallet, credentials and lifecycle', () => {
    expectTypeOf<SecureClientOptions>().toExtend<PublicClientOptions>();
    expectTypeOf<SecureClientOptions['wallet']>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<SecureClientOptions['credentials']>().toEqualTypeOf<
      WalletCredentials | undefined
    >();
    expectTypeOf<SecureClientOptions['store']>().toEqualTypeOf<
      CredentialStore | undefined
    >();
    expectTypeOf<SecureClientOptions['rail']>().toEqualTypeOf<
      'sponsored' | 'direct' | undefined
    >();
    // @ts-expect-error the wallet is an address, not a wallet shape
    void createSecureClient({ signer, wallet: { type: 'eoa' } });
    // @ts-expect-error the store is an option of its own, not part of the credentials
    void createSecureClient({ signer, credentials: { store: {} } });
    // @ts-expect-error there is no environment name
    void createSecureClient({ signer, env: production });
    // @ts-expect-error one of the two rails
    void createSecureClient({ signer, rail: 'bundler' });
  });
});

describe('the credentials round-trip', () => {
  test('an export is what the credentials option takes', async () => {
    const signer = {} as Signer;
    const old = {} as SecureClient;
    void createSecureClient({
      signer,
      credentials: await old.exportCredentials(),
    });
    expectTypeOf<
      Awaited<ReturnType<SecureClient['exportCredentials']>>
    >().toExtend<NonNullable<SecureClientOptions['credentials']>>();
  });

  test("an export always has both, and the key's metadata is optional", () => {
    type Exported = Awaited<ReturnType<SecureClient['exportCredentials']>>;
    expectTypeOf<Exported['backend']>().toEqualTypeOf<{
      apiKey: string;
      id?: string;
      expiresAt?: string;
    }>();
    expectTypeOf<Exported['orderbook']>().toEqualTypeOf<{
      apiKey: string;
      secret: string;
      passphrase: string;
    }>();
    // @ts-expect-error the key is named apiKey, as the option takes it
    void ({} as Exported).backend.key;
  });
});

describe('subscribe', () => {
  const client = createPublicClient();
  const secure = {} as SecureClient;

  test('iterating a handle of the market topic narrows to market events only', async () => {
    const handle = await client.subscribe([{ topic: 'market' }]);
    expectTypeOf(handle).toEqualTypeOf<SubscriptionHandle<MarketTopicEvent>>();
    for await (const event of handle) {
      expectTypeOf(event).toEqualTypeOf<MarketTopicEvent>();
      expectTypeOf(event.topic).toEqualTypeOf<'market'>();
      if (event.type === 'book') {
        expectTypeOf(event).toEqualTypeOf<MarketBookEvent>();
      } else if (event.type === 'price_change') {
        expectTypeOf(event).toEqualTypeOf<PriceChangeEvent>();
      } else {
        expectTypeOf(event).toEqualTypeOf<LastTradePriceEvent>();
      }
    }
  });

  test('the events of several topics are the union of theirs, and inline ids compile', () => {
    expectTypeOf(
      client.subscribe([
        { topic: 'market', assetIds: ['1', '2'], markets: [] },
        { topic: 'activity', marketId: '7' },
      ]),
    ).resolves.toEqualTypeOf<
      SubscriptionHandle<MarketTopicEvent | ActivityEvent>
    >();
    const assetIds: string[] = ['1'];
    expectTypeOf(
      client.subscribe([{ topic: 'market', assetIds }]),
    ).resolves.toEqualTypeOf<SubscriptionHandle<MarketTopicEvent>>();
  });

  test("a client without a wallet does not compile with the account's topics", () => {
    // @ts-expect-error the user topic needs a signed-in client
    void client.subscribe([{ topic: 'user' }]);
    // @ts-expect-error the portfolio topic needs a signed-in client
    void client.subscribe([{ topic: 'portfolio' }]);
    // @ts-expect-error a topic it does not know
    void client.subscribe([{ topic: 'books' }]);
    // @ts-expect-error the activity topic names its market
    void client.subscribe([{ topic: 'activity' }]);
    // @ts-expect-error ids are strings
    void client.subscribe([{ topic: 'market', assetIds: [1] }]);
    // @ts-expect-error a key the topic does not take
    void client.subscribe([{ topic: 'market', assetIds: ['1'], channel: 'x' }]);
    // @ts-expect-error a key of another topic
    void client.subscribe([{ topic: 'activity', marketId: '1', assetIds: [] }]);
  });

  test('a signed-in client subscribes to every topic', () => {
    expectTypeOf<SecureClient['subscribe']>().toEqualTypeOf<
      <const S extends readonly SubscriptionSpec[]>(
        specs: S & ExactSpecs<S>,
      ) => Promise<SubscriptionHandle<EventOf<S[number]>>>
    >();
    expectTypeOf(secure.subscribe([{ topic: 'user' }])).resolves.toEqualTypeOf<
      SubscriptionHandle<UserEvent>
    >();
    expectTypeOf(
      secure.subscribe([{ topic: 'portfolio' }]),
    ).resolves.toEqualTypeOf<SubscriptionHandle<PortfolioEvent>>();
    // @ts-expect-error the portfolio topic takes no detail: it streams the listPositions set
    void secure.subscribe([{ topic: 'portfolio', detail: true }]);
    // @ts-expect-error the user topic is on every market: it takes no markets
    void secure.subscribe([{ topic: 'user', markets: ['0x'] }]);
    expectTypeOf(
      secure.subscribe([
        { topic: 'market', markets: ['0x'] },
        { topic: 'user' },
        { topic: 'portfolio' },
        { topic: 'activity', marketId: '1' },
      ]),
    ).resolves.toEqualTypeOf<
      SubscriptionHandle<
        MarketTopicEvent | UserEvent | PortfolioEvent | ActivityEvent
      >
    >();
  });

  test('the user events narrow by type', async () => {
    for await (const event of await secure.subscribe([{ topic: 'user' }])) {
      if (event.type === 'order') {
        expectTypeOf(event).toEqualTypeOf<UserOrderEvent>();
      } else {
        expectTypeOf(event).toEqualTypeOf<UserTradeEvent>();
      }
    }
  });

  test('the events are camelCase', () => {
    expectTypeOf<MarketBookEvent>().toHaveProperty('assetId');
    expectTypeOf<MarketBookEvent>().not.toHaveProperty('asset_id');
    expectTypeOf<PriceChangeEvent>().toHaveProperty('priceChanges');
    expectTypeOf<LastTradePriceEvent>().not.toHaveProperty('fee_rate_bps');
    expectTypeOf<UserOrderEvent>().toHaveProperty('orderId');
    expectTypeOf<UserOrderEvent>().not.toHaveProperty('maker_address');
    expectTypeOf<UserTradeEvent>().toHaveProperty('takerOrderId');
  });

  test('the handle listens to its lifecycle only, and closes', async () => {
    const handle = await client.subscribe([{ topic: 'market' }]);
    handle.on('error', (error) => {
      expectTypeOf(error).toEqualTypeOf<XoError>();
      // The topic it is about; none for an overflow of the whole handle.
      expectTypeOf(error.topic).toEqualTypeOf<SubscriptionTopic | undefined>();
    });
    handle.on('reconnected', (info) => {
      expectTypeOf(info).toEqualTypeOf<ReconnectedInfo>();
      expectTypeOf(info.topic).toEqualTypeOf<SubscriptionTopic>();
    });
    // A listener that takes nothing still fits.
    expectTypeOf(handle.on('reconnected', () => {})).toEqualTypeOf<
      () => void
    >();
    handle.on('closed', () => {});
    // @ts-expect-error the events come through the loop
    handle.on('book', () => {});
    expectTypeOf(handle.close()).toEqualTypeOf<Promise<void>>();
  });

  test('the guards narrow an unknown value', () => {
    const value: unknown = undefined;
    if (SubscribeError.isError(value)) {
      expectTypeOf(value.code).toEqualTypeOf<string>();
    }
    if (CloseSubscriptionsError.isError(value)) {
      expectTypeOf(value.code).toEqualTypeOf<string>();
    }
  });
});
