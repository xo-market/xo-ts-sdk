// `@xomarket/client`: the universal entry. No Node builtin is reachable from here (the
// Node-only parts live in `@xomarket/client/node`, the signing kit in
// `@xomarket/client/signing`).
//
// Explicit names only: never `export *`, and nothing marked `@internal` or from an
// `internal.ts`. What is here is what a user names to create a client, call it, read what it
// returns or catch what it throws.

/**
 * `@xomarket/client`: the universal entry of the SDK. Nothing here needs a Node builtin.
 *
 * @module @xomarket/client
 */

// ---------------------------------------------------------------------------
// The environment and requests
// ---------------------------------------------------------------------------

export { type EnvironmentConfig, production } from './core/env';
export type { Page, Paginated } from './core/paginated';
export type { RequestOptions } from './core/requestOptions';
export type { RateLimitUpdate } from './core/transport';
export { SDK_VERSION } from './core/version';

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export type {
  BackendCredential,
  CredentialStore,
  StoredCredentials,
} from './auth/store';
export type { OrderbookCredential } from './signing/hmac';

// ---------------------------------------------------------------------------
// Markets, events and the catalog
// ---------------------------------------------------------------------------

export {
  FetchCollateralTokensError,
  FetchPulseStatsError,
  ListCategoriesError,
  ListPulseMarketsError,
  type ListPulseMarketsRequest,
  ListSubcategoriesError,
  type ListSubcategoriesRequest,
} from './actions/catalog';
export {
  FetchEventError,
  type FetchEventRequest,
  FetchSeriesError,
  type FetchSeriesRequest,
  ListEventsError,
  type ListEventsRequest,
  ListSeriesError,
  type ListSeriesRequest,
  ListSubeventsError,
  type ListSubeventsRequest,
} from './actions/events';
export {
  FetchMarketError,
  type FetchMarketRequest,
  FetchMarketTradabilityError,
  type FetchMarketTradabilityRequest,
  ListBrowseItemsError,
  type ListBrowseItemsRequest,
  ListMarketsError,
  type ListMarketsRequest,
  type MarketTradability,
} from './actions/markets';
export type { TradableReason } from './markets/resolve';
export type { BrowseEvent, BrowseItem } from './models/browse';
export type {
  Category,
  CollateralToken,
  Subcategory,
} from './models/catalog';
export type {
  Event,
  EventCreator,
  EventMetrics,
  EventSchedule,
  Series,
} from './models/event';
export type {
  Market,
  MarketEvent,
  MarketFeeSchedule,
  MarketFeeSplit,
  MarketMetrics,
  MarketOutcome,
  MarketOutcomes,
  MarketResolution,
  MarketRewards,
  MarketRewardsProgramme,
  MarketState,
  MarketStatus,
  MarketTag,
  MarketTrading,
} from './models/market';
export type { PulseMarket, PulseStats, PulseStatus } from './models/pulse';

// ---------------------------------------------------------------------------
// Order books, prices and trades
// ---------------------------------------------------------------------------

export {
  type AssetRequest,
  type AssetsRequest,
  type ConditionRequest,
  FetchConvictionMarketError,
  type FetchConvictionMarketRequest,
  FetchLastTradePriceError,
  type FetchLastTradePriceRequest,
  FetchLastTradePricesError,
  type FetchLastTradePricesRequest,
  FetchMarketCapacityError,
  type FetchMarketCapacityRequest,
  FetchMidpointError,
  type FetchMidpointRequest,
  FetchMidpointsError,
  type FetchMidpointsRequest,
  FetchOrderBookError,
  type FetchOrderBookRequest,
  FetchOrderBooksError,
  type FetchOrderBooksRequest,
  FetchPriceError,
  type FetchPriceRequest,
  FetchPricesError,
  type FetchPricesRequest,
  FetchSpreadError,
  type FetchSpreadRequest,
  FetchSpreadsError,
  type FetchSpreadsRequest,
  FetchTradingStateError,
  ListPriceHistoryError,
  type ListPriceHistoryRequest,
  ListTradesError,
  type ListTradesRequest,
  type SideInput,
} from './actions/marketData';
export type {
  ConvictionCommitment,
  ConvictionMarket,
  ConvictionOutcome,
  LastTradePrice,
  LastTradePriceForAsset,
  MarketCapacity,
  MarketTrade,
  PositionCapacity,
  PricePoint,
  PricesBySide,
} from './models/marketData';
export type { OrderBook, PriceLevel } from './models/orderBook';
export type { TradingState } from './orderbook/schemas';

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export { OrderSide, OrderType } from './models/enums';
export type {
  AcceptedOrderResponse,
  BatchOperationResult,
  CancelOrdersResponse,
  OpenOrder,
  OpenOrderStatus,
  OrderPostStatus,
  OrderRejectionCode,
  OrderResponse,
  ReconciledOrder,
  RejectedOrderResponse,
  SignedOrder,
} from './models/orders';
export type {
  MakerOrder,
  Trade,
  TraderSide,
  TradeStatus,
} from './models/trades';
export type { OrderStruct, WireOrder } from './signing/order';

// ---------------------------------------------------------------------------
// The account and its positions
// ---------------------------------------------------------------------------

export {
  AccountReadError,
  FetchBalancesError,
  type FetchMarketPnlRequest,
  FetchPortfolioValueError,
  type FetchPositionPnlRequest,
  FetchProfileError,
  FetchTradingApprovalsStateError,
  FetchUserPnlError,
  type FetchUserPnlRequest,
  ListActivityError,
  type ListActivityRequest,
  ListApiKeysError,
  ListPositionsError,
  type ListPositionsRequest,
  type SecureFetchUserStatsRequest,
  type SecureListPositionsRequest,
} from './actions/account';
export {
  FetchPublicProfileError,
  FetchUserStatsError,
  type UsernameRequest,
} from './actions/profiles';
export type {
  Activity,
  ActivityType,
  ApiKey,
  Balances,
  MarketPnl,
  PortfolioValue,
  Position,
  PositionBalance,
  PositionPnl,
  PositionStatus,
  Profile,
  ProfileBadge,
  ProfilePoints,
  ProfileSocials,
  PublicProfile,
  RedemptionResult,
  TradingApprovalsState,
  TransactionHandle,
  TransactionReceiptSummary,
  UserPnl,
  UserStats,
} from './models/account';

// ---------------------------------------------------------------------------
// Deposits and withdrawals
// ---------------------------------------------------------------------------

export type {
  VerificationRequest,
  VerifyCallback,
} from './bridge/verification';
export type {
  BridgeAmount,
  BridgeAsset,
  BridgeDeposit,
  BridgeDirection,
  BridgeFees,
  BridgePayment,
  BridgePaymentStatus,
  BridgeVerificationItem,
  BridgeWithdrawal,
  DepositQuote,
  WithdrawalQuote,
} from './models/bridge';

// ---------------------------------------------------------------------------
// Liquidity rewards
// ---------------------------------------------------------------------------

export {
  FetchMarketRewardsEpochError,
  type FetchMarketRewardsEpochRequest,
  FetchMarketRewardsError,
  type FetchMarketRewardsRequest,
  FetchRewardGroupError,
  type FetchRewardGroupRequest,
  FetchRewardsLeaderboardStandingError,
  type FetchRewardsLeaderboardStandingRequest,
  FetchUserRewardsEpochError,
  type FetchUserRewardsEpochRequest,
  FetchUserRewardsError,
  type FetchUserRewardsRequest,
  ListMarketRewardsMakersError,
  type ListMarketRewardsMakersRequest,
  ListMarketRewardsOrdersError,
  type ListMarketRewardsOrdersRequest,
  ListRewardGroupsError,
  type ListRewardGroupsRequest,
  ListRewardPoolsError,
  ListRewardsLeaderboardError,
  type ListRewardsLeaderboardRequest,
  ListUserRewardsOrdersError,
  type ListUserRewardsOrdersRequest,
  type SecureFetchUserRewardsEpochRequest,
  type SecureFetchUserRewardsRequest,
  type SecureListUserRewardsOrdersRequest,
} from './actions/rewards';
export type {
  MarketRewardsDetails,
  MarketRewardsEpoch,
  RewardAmount,
  RewardBonus,
  RewardCurrency,
  RewardDayStatus,
  RewardGroup,
  RewardGroupProduct,
  RewardInactiveReason,
  RewardLifetime,
  RewardPayoutStatus,
  RewardPool,
  RewardPoolMarket,
  RewardProgramme,
  RewardProgrammeStatus,
  RewardsDay,
  RewardsEpochRail,
  RewardsLeaderboardEntry,
  RewardsLeaderboardStanding,
  RewardsMaker,
  RewardsOrder,
  RewardsOrderExit,
  RewardsUserProfile,
  RewardTerms,
  UserCpRewards,
  UserRewards,
  UserRewardsDay,
  UserRewardsEpoch,
  UserRewardsEpochMarket,
  UserRewardsTotal,
  UserUsdcRewards,
} from './models/rewards';

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

export type {
  ActivityEvent,
  LastTradePriceEvent,
  MarketBookEvent,
  MarketTopicEvent,
  PortfolioEvent,
  PriceChange,
  PriceChangeEvent,
  ReconnectedInfo,
  SubscriptionEvent,
  SubscriptionHandle,
  SubscriptionTopic,
  UserEvent,
  UserOrderEvent,
  UserOrderEventKind,
  UserTradeEvent,
} from './models/realtime';

// ---------------------------------------------------------------------------
// Errors: every class, and the type of the guards
// ---------------------------------------------------------------------------

export { MintedKeyError } from './auth/backendAuth';
export {
  AuthRequiredError,
  type ErrorGuard,
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
  type XoErrorOptions,
} from './core/errors';
export {
  BatchOpsIncompleteError,
  BatchPlaceIncompleteError,
  PlacementError,
} from './orderbook/placement';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type {
  ConditionId,
  DecimalString,
  OrderHash,
  Service,
  TokenId,
} from './core/types';
