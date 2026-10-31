import { setupServer } from 'msw/node';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from 'vitest';
import {
  FetchBalancesError,
  FetchPortfolioValueError,
  FetchProfileError,
  FetchTradingApprovalsStateError,
  FetchUserPnlError,
  ListActivityError,
  ListApiKeysError,
  ListPositionsError,
} from '../../src/actions/account';
import {
  CreateDepositError,
  FetchBridgePaymentError,
  ListBridgeAssetsError,
  ListBridgePaymentsError,
  QuoteDepositError,
  QuoteWithdrawalError,
  VerifyBridgePaymentError,
  WaitForBridgePaymentError,
  WithdrawError,
} from '../../src/actions/bridge';
import {
  FetchCollateralTokensError,
  FetchPulseStatsError,
  ListCategoriesError,
  ListPulseMarketsError,
  ListSubcategoriesError,
} from '../../src/actions/catalog';
import {
  FetchEventError,
  FetchSeriesError,
  fetchEvent,
  ListEventsError,
  ListSeriesError,
  ListSubeventsError,
} from '../../src/actions/events';
import {
  FetchConvictionMarketError,
  FetchLastTradePriceError,
  FetchLastTradePricesError,
  FetchMarketCapacityError,
  FetchMidpointError,
  FetchMidpointsError,
  FetchOrderBookError,
  FetchOrderBooksError,
  FetchPriceError,
  FetchPricesError,
  FetchSpreadError,
  FetchSpreadsError,
  FetchTradingStateError,
  ListPriceHistoryError,
  ListTradesError,
} from '../../src/actions/marketData';
import {
  FetchMarketError,
  FetchMarketTradabilityError,
  fetchMarket,
  fetchMarketTradability,
  ListBrowseItemsError,
  ListMarketsError,
  listMarkets,
} from '../../src/actions/markets';
import {
  MergePositionsError,
  RedeemAllPositionsError,
  RedeemPositionsError,
  SetupTradingApprovalsError,
  TransferErc20Error,
} from '../../src/actions/onchain';
import {
  FetchPublicProfileError,
  FetchUserStatsError,
} from '../../src/actions/profiles';
import {
  FetchMarketRewardsEpochError,
  FetchMarketRewardsError,
  FetchRewardGroupError,
  FetchRewardsLeaderboardStandingError,
  FetchUserRewardsEpochError,
  FetchUserRewardsError,
  ListMarketRewardsMakersError,
  ListMarketRewardsOrdersError,
  ListRewardGroupsError,
  ListRewardPoolsError,
  ListRewardsLeaderboardError,
  ListUserRewardsOrdersError,
} from '../../src/actions/rewards';
import {
  AuthRequiredError,
  PaginationLimitError,
  RateLimitError,
  RequestAbortedError,
  RequestRejectedError,
  SigningError,
  TimeoutError,
  TransactionFailedError,
  TransportError,
  UnexpectedResponseError,
  UserInputError,
  XoError,
} from '../../src/core/errors';
import { actionRig } from '../helpers/actionRig';
import { caught } from '../helpers/dataRig';
import { conditionIdOf, MISSING_UUID } from '../helpers/mockBackendData';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

const READ_ERRORS: XoError[] = [
  new UserInputError('x'),
  new RequestRejectedError('x', { status: 404 }),
  new RateLimitError('x'),
  new TimeoutError('x'),
  new TransportError('x'),
  new RequestAbortedError('x'),
  new UnexpectedResponseError('x', { issues: [] }),
];
const FOREIGN: unknown[] = [
  new Error('plain'),
  new SigningError('x'),
  new AuthRequiredError('x'),
  'text',
  undefined,
  null,
];

interface Guard {
  isError(error: unknown): boolean;
}

const FETCH: Array<[string, Guard]> = [
  ['FetchMarketError', FetchMarketError],
  ['FetchEventError', FetchEventError],
  ['FetchSeriesError', FetchSeriesError],
  ['FetchCollateralTokensError', FetchCollateralTokensError],
  ['FetchPulseStatsError', FetchPulseStatsError],
  ['FetchPublicProfileError', FetchPublicProfileError],
  ['FetchOrderBookError', FetchOrderBookError],
  ['FetchOrderBooksError', FetchOrderBooksError],
  ['FetchMidpointError', FetchMidpointError],
  ['FetchMidpointsError', FetchMidpointsError],
  ['FetchPriceError', FetchPriceError],
  ['FetchPricesError', FetchPricesError],
  ['FetchSpreadError', FetchSpreadError],
  ['FetchSpreadsError', FetchSpreadsError],
  ['FetchLastTradePriceError', FetchLastTradePriceError],
  ['FetchLastTradePricesError', FetchLastTradePricesError],
  ['FetchTradingStateError', FetchTradingStateError],
  ['FetchConvictionMarketError', FetchConvictionMarketError],
  ['FetchRewardGroupError', FetchRewardGroupError],
  ['FetchMarketRewardsError', FetchMarketRewardsError],
  ['FetchMarketRewardsEpochError', FetchMarketRewardsEpochError],
];
// Lists addressed by page number can also refuse a cursor beyond their depth.
const PAGED_LISTS: Array<[string, Guard]> = [
  ['ListMarketsError', ListMarketsError],
  ['ListBrowseItemsError', ListBrowseItemsError],
  ['ListEventsError', ListEventsError],
  ['ListPulseMarketsError', ListPulseMarketsError],
  ['ListTradesError', ListTradesError],
];
// Lists that cannot refuse a cursor for its depth: they have one page, or a source that ends them.
const UNCAPPED_LISTS: Array<[string, Guard]> = [
  ['ListSubeventsError', ListSubeventsError],
  ['ListSeriesError', ListSeriesError],
  ['ListCategoriesError', ListCategoriesError],
  ['ListSubcategoriesError', ListSubcategoriesError],
  ['ListPriceHistoryError', ListPriceHistoryError],
  ['ListRewardPoolsError', ListRewardPoolsError],
  ['ListRewardGroupsError', ListRewardGroupsError],
  ['ListMarketRewardsMakersError', ListMarketRewardsMakersError],
  ['ListMarketRewardsOrdersError', ListMarketRewardsOrdersError],
];

// The reads of a wallet that a signed-in client makes of its own wallet, with its key: they can
// also raise the errors of the sign-in it makes when the key is refused.
const SIGNED_IN_READS: Array<[string, Guard]> = [
  ['FetchUserStatsError', FetchUserStatsError],
  ['FetchUserRewardsError', FetchUserRewardsError],
  ['FetchUserRewardsEpochError', FetchUserRewardsEpochError],
  ['ListUserRewardsOrdersError', ListUserRewardsOrdersError],
  ['ListPositionsError', ListPositionsError],
  ['FetchPortfolioValueError', FetchPortfolioValueError],
  ['FetchUserPnlError', FetchUserPnlError],
  ['ListActivityError', ListActivityError],
  ['FetchProfileError', FetchProfileError],
  ['ListApiKeysError', ListApiKeysError],
  ['FetchBalancesError', FetchBalancesError],
  ['FetchTradingApprovalsStateError', FetchTradingApprovalsStateError],
  ['ListRewardsLeaderboardError', ListRewardsLeaderboardError],
  [
    'FetchRewardsLeaderboardStandingError',
    FetchRewardsLeaderboardStandingError,
  ],
  ['ListBridgeAssetsError', ListBridgeAssetsError],
  ['QuoteDepositError', QuoteDepositError],
  ['QuoteWithdrawalError', QuoteWithdrawalError],
  ['FetchBridgePaymentError', FetchBridgePaymentError],
  ['WaitForBridgePaymentError', WaitForBridgePaymentError],
  ['ListBridgePaymentsError', ListBridgePaymentsError],
];
// The sends of a signed-in client: those of a read, and a TransactionFailedError for the send.
const SENDS: Array<[string, Guard]> = [
  ['SetupTradingApprovalsError', SetupTradingApprovalsError],
  ['MergePositionsError', MergePositionsError],
  ['RedeemPositionsError', RedeemPositionsError],
  ['RedeemAllPositionsError', RedeemAllPositionsError],
  ['TransferErc20Error', TransferErc20Error],
  ['CreateDepositError', CreateDepositError],
  ['WithdrawError', WithdrawError],
  ['VerifyBridgePaymentError', VerifyBridgePaymentError],
];

describe('the error guards of the actions', () => {
  test.each(SIGNED_IN_READS)(
    '%s, a read a signed-in client makes with its key, accepts the read errors, a SigningError and the SDK errors, and nothing else',
    (_name, guard) => {
      for (const error of [
        ...READ_ERRORS,
        new SigningError('x'),
        new AuthRequiredError('x'),
        new XoError('x', { code: 'client_closed' }),
      ]) {
        expect(guard.isError(error), error.name).toBe(true);
      }
      for (const other of [new Error('plain'), 'text', undefined, null]) {
        expect(guard.isError(other), String(other)).toBe(false);
      }
    },
  );

  test.each(SENDS)(
    '%s accepts a TransactionFailedError and the errors before the send, and nothing else',
    (_name, guard) => {
      for (const error of [
        new UserInputError('x'),
        new SigningError('x'),
        new RequestRejectedError('x', { status: 403 }),
        new RateLimitError('x'),
        new TransactionFailedError('x', { mayHaveLanded: true }),
      ]) {
        expect(guard.isError(error), error.name).toBe(true);
      }
      for (const other of [new Error('plain'), 'text', undefined, null]) {
        expect(guard.isError(other), String(other)).toBe(false);
      }
    },
  );

  test.each([...FETCH, ...PAGED_LISTS, ...UNCAPPED_LISTS])(
    '%s accepts every error a read can raise and nothing else',
    (_name, guard) => {
      for (const error of READ_ERRORS) {
        expect(guard.isError(error), error.name).toBe(true);
      }
      for (const other of FOREIGN) {
        expect(guard.isError(other), String(other)).toBe(false);
      }
    },
  );

  test.each(PAGED_LISTS)(
    '%s also accepts a PaginationLimitError',
    (_name, guard) => {
      expect(guard.isError(new PaginationLimitError('x'))).toBe(true);
    },
  );

  test.each([...FETCH, ...UNCAPPED_LISTS])(
    '%s does not accept a PaginationLimitError, which it cannot raise',
    (_name, guard) => {
      expect(guard.isError(new PaginationLimitError('x'))).toBe(false);
    },
  );

  test('FetchMarketTradabilityError also accepts a plain XoError, the error of a failed chain read', () => {
    for (const error of READ_ERRORS) {
      expect(FetchMarketTradabilityError.isError(error)).toBe(true);
    }
    expect(
      FetchMarketTradabilityError.isError(
        new XoError('x', { code: 'chain_read_failed', service: 'chain' }),
      ),
    ).toBe(true);
    expect(FetchMarketTradabilityError.isError(new Error('plain'))).toBe(false);
  });

  test('FetchMarketCapacityError, the error of a read that signs in, also accepts a SigningError and a plain XoError', () => {
    for (const error of READ_ERRORS) {
      expect(FetchMarketCapacityError.isError(error), error.name).toBe(true);
    }
    expect(FetchMarketCapacityError.isError(new SigningError('x'))).toBe(true);
    for (const code of [
      'session_closed',
      'smart_wallet_not_deployed',
      'smart_wallet_deployment_unknown',
      'smart_wallet_address_unavailable',
    ]) {
      expect(
        FetchMarketCapacityError.isError(new XoError('x', { code })),
        code,
      ).toBe(true);
    }
    // It never asks the caller to sign in: a signed-in client has a signer. The plain XoError
    // of the union is a base class, so a subclass such as AuthRequiredError satisfies the guard
    // only by inheritance; the union does not name it.
    for (const other of [new Error('plain'), 'text', undefined, null]) {
      expect(FetchMarketCapacityError.isError(other)).toBe(false);
    }
  });

  test('each name is both a type and a guard', () => {
    expectTypeOf<ListMarketsError>().toExtend<XoError>();
    expectTypeOf<FetchMarketError>().toExtend<XoError>();
    // The union holds exactly the classes the guard lists.
    expectTypeOf<FetchEventError>().toEqualTypeOf<
      | UserInputError
      | RequestRejectedError
      | RateLimitError
      | TimeoutError
      | TransportError
      | RequestAbortedError
      | UnexpectedResponseError
    >();
    expectTypeOf<ListMarketsError>().toEqualTypeOf<
      FetchEventError | PaginationLimitError
    >();
    expectTypeOf<FetchMarketTradabilityError>().toEqualTypeOf<
      FetchEventError | XoError
    >();
    expectTypeOf<FetchMarketCapacityError>().toEqualTypeOf<
      FetchEventError | SigningError | XoError
    >();
  });
});

describe('the guards accept the errors their actions really throw', () => {
  test('fetchMarket: a 404, an unknown input, an unusable market', async () => {
    const r = actionRig(server);
    for (const run of [
      () => fetchMarket(r.ctx, { id: '999' }),
      () => fetchMarket(r.ctx, {} as never),
      () => fetchMarket(r.ctx, { id: '6' }),
      () => fetchMarket(r.ctx, { id: '1' }, { retries: 99 }),
    ]) {
      const error = await caught(run);
      expect(FetchMarketError.isError(error), String(error)).toBe(true);
    }
  });

  test('fetchMarket: a response the schema refuses', async () => {
    const r = actionRig(server, { strict: true });
    r.backend.marketExtras = { surprise: 1 };
    const error = await caught(() => fetchMarket(r.ctx, { id: '1' }));
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(FetchMarketError.isError(error)).toBe(true);
  });

  test('fetchMarketTradability: a 404 and a failing chain read', async () => {
    const r = actionRig(server);
    const notFound = await caught(() =>
      fetchMarketTradability(r.ctx, { conditionId: `0x${'ee'.repeat(32)}` }),
    );
    expect(FetchMarketTradabilityError.isError(notFound)).toBe(true);
    r.chain.override = () => {
      throw new Error('rpc down');
    };
    const chain = await caught(() =>
      fetchMarketTradability(r.ctx, { conditionId: conditionIdOf(1) }),
    );
    expect(FetchMarketTradabilityError.isError(chain)).toBe(true);
    // A chain read failure is not one of the read errors.
    expect(FetchMarketError.isError(chain)).toBe(false);
  });

  test('listMarkets: a refused request, a refused cursor, a failed page', async () => {
    const r = actionRig(server);
    const request = await caught(() =>
      listMarkets(r.ctx, { status: 'x' } as never),
    );
    expect(ListMarketsError.isError(request)).toBe(true);
    const cursor = await caught(() =>
      listMarkets(r.ctx).from('not-a-cursor').firstPage(),
    );
    expect(ListMarketsError.isError(cursor)).toBe(true);
    r.backend.override = () => new Response('{}', { status: 400 });
    const page = await caught(() =>
      listMarkets(r.ctx, {}, { retries: 0 }).firstPage(),
    );
    expect(page).toBeInstanceOf(RequestRejectedError);
    expect(ListMarketsError.isError(page)).toBe(true);
  });

  test('fetchEvent: a 404', async () => {
    const r = actionRig(server);
    const error = await caught(() => fetchEvent(r.ctx, { id: MISSING_UUID }));
    expect(FetchEventError.isError(error)).toBe(true);
  });
});
