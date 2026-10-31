import type { Address } from 'viem';
import { createChainReader } from '../account/chain';
import { AccountClient } from '../account/client';
import { withLanded } from '../account/internal';
import type {
  FetchMarketPnlRequest,
  FetchPositionPnlRequest,
  FetchUserPnlRequest,
  ListActivityRequest,
  SecureFetchUserStatsRequest,
  SecureListPositionsRequest,
} from '../actions/account';
import * as accountActions from '../actions/account';
import type {
  BridgePaymentRequest,
  CreateDepositRequest,
  ListBridgeAssetsRequest,
  ListBridgePaymentsRequest,
  QuoteDepositRequest,
  QuoteWithdrawalRequest,
  VerifyBridgePaymentRequest,
  WaitForBridgePaymentOptions,
  WithdrawRequest,
} from '../actions/bridge';
import * as bridgeActions from '../actions/bridge';
import type { FetchMarketCapacityRequest } from '../actions/marketData';
import * as marketData from '../actions/marketData';
import type {
  MergePositionsRequest,
  RedeemPositionsRequest,
  TransferErc20Request,
} from '../actions/onchain';
import * as onchain from '../actions/onchain';
import type {
  FetchRewardsLeaderboardStandingRequest,
  ListRewardsLeaderboardRequest,
  SecureFetchUserRewardsEpochRequest,
  SecureFetchUserRewardsRequest,
  SecureListUserRewardsOrdersRequest,
} from '../actions/rewards';
import * as rewards from '../actions/rewards';
import type {
  EventOf,
  ExactSpecs,
  SubscriptionSpec,
} from '../actions/subscriptions';
import * as subscriptions from '../actions/subscriptions';
import type {
  CancelMarketOrdersRequest,
  CancelOrderRequest,
  CancelOrdersRequest,
  CreateLimitOrderRequest,
  CreateMarketOrderRequest,
  FetchAccountTradeRequest,
  FetchOrderRequest,
  ListAccountTradesRequest,
  ListOpenOrdersRequest,
  OrderHeartbeat,
  OrderHeartbeatResponse,
  PlaceLimitOrderRequest,
  PlaceMarketOrderRequest,
  PostOrderBatchRequest,
  ReconcileOrderRequest,
  StartOrderHeartbeatRequest,
} from '../actions/trading';
import * as trading from '../actions/trading';
import { checkLabel } from '../auth/backendAuth';
import { readProvided } from '../auth/sessionInternal';
import type { CredentialStore } from '../auth/store';
import { BridgeClient } from '../bridge/client';
import { isSameAddress, normalizeAddress } from '../core/address';
import {
  makeErrorGuard,
  RateLimitError,
  RequestRejectedError,
  SigningError,
  TimeoutError,
  TransactionFailedError,
  TransportError,
  UnexpectedResponseError,
  UserInputError,
  XoError,
} from '../core/errors';
import type { Paginated } from '../core/paginated';
import type { RequestOptions } from '../core/requestOptions';
import type { RateLimitUpdate } from '../core/transport';
import { clientSeams, createCore } from '../core/wiring';
import { DataClient } from '../data/client';
import type {
  Activity,
  ApiKey,
  Balances,
  MarketPnl,
  PortfolioValue,
  Position,
  PositionPnl,
  Profile,
  RedemptionResult,
  TradingApprovalsState,
  TransactionHandle,
  UserPnl,
  UserStats,
} from '../models/account';
import type {
  BridgeAsset,
  BridgePayment,
  BridgeWithdrawal,
  DepositQuote,
  WithdrawalQuote,
} from '../models/bridge';
import type { MarketCapacity } from '../models/marketData';
import type {
  BatchOperationResult,
  CancelOrdersResponse,
  OpenOrder,
  OrderResponse,
  ReconciledOrder,
  SignedOrder,
} from '../models/orders';
import type { SubscriptionHandle } from '../models/realtime';
import type {
  RewardsLeaderboardEntry,
  RewardsLeaderboardStanding,
  RewardsOrder,
  UserRewards,
  UserRewardsEpoch,
} from '../models/rewards';
import type { Trade } from '../models/trades';
import { OrderbookClient } from '../orderbook/client';
import { closedObject } from '../orderbook/internal';
import { RealtimeHub } from '../realtime/merged';
import type { TradingIdentity } from '../wallet/identity';
import { isObject } from '../wallet/internal';
import { type Signer, toInternalSigner } from '../wallet/publicSigner';
import type { ActionContext } from './context';
import { brandClient } from './guards';
import { holdExitHook, holdShutdownHooks } from './lifecycle';
import {
  type Bound,
  createPublicClient,
  optionalFunction,
  type PublicClient,
  type PublicClientOptions,
  publicActions,
  readEnvironment,
} from './public';
import { SessionRail } from './rail';
import { resolveWalletAddress } from './walletAddress';

// The client that has signed in with a wallet: everything the public client reads, plus what
// only the wallet's own credentials allow. It signs in when it is created and holds the
// credentials until it is closed or signs out.

/**
 * The credentials of a wallet: what {@link SecureClient.exportCredentials} gives and the
 * `credentials` option of {@link createSecureClient} takes, so an export can be passed to a new
 * client as it is. They are secrets: keep them out of logs.
 */
export interface WalletCredentials {
  /**
   * An API key of the wallet's account. `id` and `expiresAt` are the key's metadata, when known:
   * an export has them for a key the client signed in for or loaded, and none for a key it was
   * given without them.
   */
  backend?: { apiKey: string; id?: string; expiresAt?: string };
  /** The wallet's own order book credentials: the ones signing in derives for it. */
  orderbook?: { apiKey: string; secret: string; passphrase: string };
}

/** The options of {@link createSecureClient}. Only `signer` is required. */
export interface SecureClientOptions extends PublicClientOptions {
  /**
   * The wallet that signs: `privateKey(key)` or `signerFrom(account)` from
   * `@xomarket/client/viem`, or a signer of your own. Required.
   */
  signer: Signer;
  /**
   * The account that trades, as an address. Leave it out to trade from the signer's own
   * address. Any other address must be one of the signer's smart wallets (numbers 0 to 9:
   * {@link PublicClient.fetchSmartWalletAddress} gives their addresses); an address the signer
   * does not own is refused before anything is signed or sent.
   *
   * An undeployed smart wallet is deployed once, gas-free, when the client is created: XO's
   * sponsor sends the one transaction that {@link SecureClient.setupTradingApprovals} would
   * send, which makes the smart wallet and sets its approvals for trading, before the client
   * signs in. A smart wallet that exists already, or the signer's own address, is sent nothing.
   */
  wallet?: string;
  /**
   * Credentials this wallet already has, used instead of signing in for them: an API key
   * (`backend: { apiKey }`, with its `id` and `expiresAt` when you have them) and order book
   * credentials (`orderbook: { apiKey, secret, passphrase }`). What `exportCredentials()` gives
   * can be passed here as it is.
   *
   * They are checked when the client is created, before they are used for anything: the API
   * key must be one of the wallet's account (one read of the account), and the order book
   * credentials must be the wallet's own default ones, the ones signing in derives for it and
   * `exportCredentials()` gives (one wallet signature). Anything else is refused with
   * `credentials_not_owned`.
   *
   * The client never rotates them. `close()` leaves them active; `endAuthentication()` revokes
   * them.
   */
  credentials?: WalletCredentials;
  /**
   * Where the client keeps the credentials it signs in for. Leave it out to keep them in
   * memory: the client then signs in for a 1-day API key and revokes it on `close()`, on
   * Ctrl-C (SIGINT), SIGTERM, and when the process exits normally. A persistent store, such as
   * `fileStore` from `@xomarket/client/node`, keeps one 90-day key across restarts instead.
   */
  store?: CredentialStore;
  /**
   * How transactions go on chain. Leave it out: XO's sponsor sends them and pays the gas.
   * `'direct'` sends a plain transaction that the signer pays gas for, one call at a time, and
   * works only when the client trades from the signer's own address.
   */
  rail?: 'sponsored' | 'direct';
  /**
   * Whether to revoke a 1-day API key when the process ends: on SIGINT or SIGTERM (then the
   * process ends as the signal asks) and when it exits normally. Defaults to `true`. It only
   * applies to a client that signs in for a 1-day key: no persistent `store`, and no
   * `credentials.backend`. Pass `false` to handle this yourself (call `close()`).
   */
  shutdownHooks?: boolean;
  /** Whether a response field the SDK does not know is an error (for contract tests). */
  strictResponses?: boolean;
  /**
   * A name for the API keys this client signs in for, which they carry as
   * `xo-sdk:<label>:<yyyymmdd>`: 1 to 64 of `A-Z a-z 0-9 . _ -`. Defaults to `default`.
   */
  label?: string;
}

/** The error union of {@link createSecureClient}. */
export type CreateSecureClientError =
  | UserInputError
  | SigningError
  | TransactionFailedError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | UnexpectedResponseError
  | XoError;
/** The guard of {@link CreateSecureClientError}. */
export const CreateSecureClientError = makeErrorGuard(
  UserInputError,
  SigningError,
  TransactionFailedError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  UnexpectedResponseError,
  XoError,
);

/** The error union of {@link SecureClient.endAuthentication}. */
export type EndAuthenticationError =
  | UserInputError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | UnexpectedResponseError
  | XoError;
/** The guard of {@link EndAuthenticationError}. */
export const EndAuthenticationError = makeErrorGuard(
  UserInputError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  UnexpectedResponseError,
  XoError,
);

/** The error union of {@link SecureClient.rotateCredentials}. */
export type RotateCredentialsError =
  | UserInputError
  | SigningError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | UnexpectedResponseError
  | XoError;
/** The guard of {@link RotateCredentialsError}. */
export const RotateCredentialsError = makeErrorGuard(
  UserInputError,
  SigningError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  UnexpectedResponseError,
  XoError,
);

/** The error union of {@link SecureClient.exportCredentials}. */
export type ExportCredentialsError = RotateCredentialsError;
/** The guard of {@link ExportCredentialsError}. */
export const ExportCredentialsError = RotateCredentialsError;

/**
 * A client that has signed in with a wallet. It reads everything a {@link PublicClient}
 * reads, and holds the wallet's credentials: an API key for XO's account data and order book
 * credentials for trading. Create it with {@link createSecureClient}.
 *
 * When the process is done with it, call {@link SecureClient.close}. To sign the wallet out
 * for good, call {@link SecureClient.endAuthentication}. After either one, every member
 * throws a `UserInputError` with the code `client_closed`.
 *
 * @example
 * const client = await createSecureClient({ signer: privateKey(process.env.XO_PK as string) });
 * console.log(client.wallet);
 * console.log(await client.fetchMidpoint({ assetId }));
 */
export interface SecureClient extends PublicClient {
  /**
   * The address of the account that trades and holds the funds: the signer's own address, or
   * the smart wallet that the `wallet` option named. Checksummed.
   *
   * @example
   * const client = await createSecureClient({ signer });
   * console.log(`trading from ${client.wallet}`);
   */
  readonly wallet: Address;

  /**
   * Signs the wallet out, for good, and returns a client that reads public data. It revokes
   * the wallet's API key whether the client signed in for it, loaded it from the `store` or
   * was given it in `credentials`; deletes it from the store; and deletes the wallet's order
   * book API key. That key is shared by every process that trades for the same wallet: all of
   * them lose it, and each one signs in again for a new key when it next needs one.
   *
   * From the moment it is called the client places no new order, stops its order heartbeat and
   * closes its subscriptions; afterwards every member throws a `UserInputError` with the code
   * `client_closed`, whether the sign-out worked or not. Every step is tried even when one
   * fails. A key that could not be revoked stays in the store, so a new client for the same
   * wallet can sign out again. Calling it again returns the same promise.
   *
   * To end only this process and keep a stored key for the next run, call {@link close}
   * instead.
   *
   * @returns A client that reads public data, on the same environment and with the same
   *   `fetch`, `WebSocket` and `onRateLimitUpdate`.
   * @throws {EndAuthenticationError} `client_closed` when {@link close} was called first (nothing
   *   is revoked then); `api_key_not_listed` for an API key given in `credentials` that the
   *   account's key listing does not show, so it could not be revoked; and the request errors
   *   of a revoke or deletion that failed (the client is closed anyway).
   * @example
   * const publicClient = await client.endAuthentication();
   * console.log(await publicClient.fetchTradingState());
   */
  endAuthentication(): Promise<PublicClient>;

  /**
   * Ends the client for this process: it places no new order from the moment it is called,
   * stops its order heartbeat, closes its subscriptions and, when the client signed in for a
   * 1-day API key (no persistent `store`), revokes that key. A key from a persistent store
   * stays for the next run, and credentials given in `credentials` stay active. The order
   * book credentials are kept.
   *
   * Afterwards every member throws a `UserInputError` with the code `client_closed`. Calling
   * it again returns the same promise. It never rejects: a revoke that fails is reported in a
   * warning, and the key then expires within a day.
   *
   * @example
   * const client = await createSecureClient({ signer });
   * await client.close();
   */
  close(): Promise<void>;

  /**
   * Streams live events of one or more topics through one handle, the account's included. Each
   * spec names a topic:
   *
   * - `market`: the order books, price changes and fills of outcome tokens (`assetIds`) or of
   *   whole markets (`markets`, by condition id), as on a client without a wallet.
   * - `user`: the account's orders (`order` events: placed, filled, cancelled, rejected) and
   *   trades (`trade` events: the fill, then each step of its settlement), on every market.
   * - `portfolio`: the account's positions each time they change, as `listPositions` lists
   *   them, in the first 100 markets of the account.
   * - `activity`: the newest fills of one market, by XO's id for it (`marketId`).
   *
   * The handle's loop yields the events of every topic, in the order they arrive, narrowed to
   * the topics asked for. A stream reconnects by itself but does not replay what it missed. The
   * handle's `'reconnected'` (`{ topic }`) and its errors (`error.topic`) name the topic they
   * concern: on `'reconnected'` and on `ws_events_dropped`, re-read the state of the topic named
   * (`listOpenOrders` for `user`, `fetchOrderBooks` for `market`, `listPositions` for
   * `portfolio`). `subscription_overflow` names no topic: re-read every one. A topic that stops
   * for good says so on `'error'` and the others go on. {@link close} and
   * {@link endAuthentication} close every handle: its loop ends and its `'closed'` fires.
   *
   * The `user` topic sends the order book credentials over the WebSocket, so it refuses to run
   * in a browser.
   *
   * @param specs - The topics, such as `[{ topic: 'user' }, { topic: 'market', assetIds }]`.
   *   See {@link SubscriptionSpec}.
   * @throws {SubscribeError} `invalid_input` for specs that are not valid (an empty list, an
   *   unknown topic or key, a `market` spec with no id, an id that is not one) and for the
   *   `market` or `user` topic when the runtime has no `WebSocket` and none was passed;
   *   `browser_secret_refused` for the `user` topic in a browser; `client_closed` after
   *   {@link close} or {@link endAuthentication}. Nothing is opened then.
   * @example
   * const handle = await client.subscribe([{ topic: 'user' }, { topic: 'portfolio' }]);
   * try {
   *   for await (const event of handle) {
   *     if (event.type === 'order') {
   *       console.log(event.kind, event.orderId, event.status);
   *     } else if (event.type === 'positions') {
   *       console.log(event.positions.length, 'positions');
   *     }
   *   }
   * } finally {
   *   await handle.close();
   * }
   */
  subscribe<const S extends readonly SubscriptionSpec[]>(
    specs: S & ExactSpecs<S>,
  ): Promise<SubscriptionHandle<EventOf<S[number]>>>;

  /**
   * Replaces the wallet's API key now: signs in for a new one, uses and stores it, then revokes
   * the old one. The order book credentials do not change. A key given in `credentials` is
   * never rotated.
   *
   * @throws {RotateCredentialsError} `credentials_provided` for a key given in `credentials`,
   *   `client_closed` after {@link close} or {@link endAuthentication}, and the errors of
   *   signing in: the wallet's signature (`SigningError`), a refusal (`api_key_limit_reached`
   *   when the account has 10 active keys) and the request errors.
   * @example
   * await client.rotateCredentials();
   * const { backend } = await client.exportCredentials();
   * console.log(`now using key ${backend?.id}`);
   */
  rotateCredentials(): Promise<void>;

  /**
   * The credentials the client uses: its API key, with its `id` and `expiresAt` when they are
   * known, and its order book credentials. They are secrets: keep them out of logs. Pass them
   * as they are as the `credentials` of another client for the same wallet, to use them there
   * without signing in again. A key the client was given without its `id` and `expiresAt` comes
   * back without them.
   *
   * With the default memory store the API key lasts a day and {@link close} revokes it; use a
   * persistent `store` to keep one across runs.
   *
   * @throws {ExportCredentialsError} `client_closed` after {@link close} or
   *   {@link endAuthentication}, and the errors of signing in again when the API key was due
   *   for rotation.
   * @example
   * const credentials = await client.exportCredentials();
   * const again = await createSecureClient({ signer, credentials });
   * console.log(credentials.backend.expiresAt, again.wallet);
   */
  exportCredentials(): Promise<Required<WalletCredentials>>;

  /**
   * Builds and signs a limit order without sending it: the wallet signs, and nothing goes to
   * XO. Send it with {@link postOrder}, or several at once with {@link postOrders}. The order
   * is good till cancelled; an `expiration` makes it good till that time. Building it reads the
   * market's tick size and the account's exchange nonce. Nothing is rounded: a price off the
   * market's tick size is refused. The signed order is frozen, since changing it would break
   * its signature.
   *
   * @param request - The outcome token (`assetId`), the `side`, the `price` and the `size`, and
   *   `postOnly` and `expiration` when wanted. See {@link CreateLimitOrderRequest}.
   * @throws {CreateLimitOrderError} `invalid_input` for a request that is not valid (a price
   *   off the market's tick size, fewer than 1 share, more than 6 decimals, an expiration in
   *   milliseconds or too soon), `client_closed` after {@link close} or
   *   {@link endAuthentication}, a `SigningError` when the wallet does not sign, and the errors
   *   of reading the tick size or the exchange nonce (`nonce_unavailable`).
   * @example
   * const order = await client.createLimitOrder({
   *   assetId,
   *   side: OrderSide.BUY,
   *   price: '0.52',
   *   size: 10,
   * });
   * console.log(order.orderHash);
   */
  createLimitOrder(request: CreateLimitOrderRequest): Promise<SignedOrder>;

  /**
   * Builds and signs a market order without sending it. A buy spends an `amount` of dollars
   * and a sell gives a number of `shares`, at the best prices on the book: the order is a limit
   * order at the worst price, 0.999 to buy and 0.001 to sell. It is fill-and-kill (the part
   * that does not fill at once is dropped) unless `orderType` is `OrderType.FOK` (all of it
   * fills at once, or none). Send it with {@link postOrder}.
   *
   * @param request - The outcome token (`assetId`), the `side`, and the `amount` of a buy or the
   *   `shares` of a sell. See {@link CreateMarketOrderRequest}.
   * @throws {CreateMarketOrderError} `invalid_input` for a request that is not valid (`shares`
   *   on a buy, `amount` on a sell, an amount below one share's worth), `client_closed` after
   *   {@link close} or {@link endAuthentication}, a `SigningError` when the wallet does not
   *   sign, and `nonce_unavailable` when the exchange nonce cannot be read.
   * @example
   * const order = await client.createMarketOrder({
   *   assetId,
   *   side: OrderSide.BUY,
   *   amount: 10,
   * });
   * console.log(order.orderType);
   */
  createMarketOrder(request: CreateMarketOrderRequest): Promise<SignedOrder>;

  /**
   * Builds, signs and sends a limit order. It is sent once: never again, and never signed
   * again.
   *
   * The result says what XO answered. `{ ok: true }` when XO accepted the order, with its
   * `orderId`, its `status` (`live` when it rests, `matched` when it filled at once, `delayed`
   * while it waits out the taker delay, when it can still fill) and what filled at once.
   * `{ ok: false, code, message }` when XO refused it: nothing was placed, and `code` says why,
   * such as `insufficient_balance` or `trading_paused`. Both carry the order's `orderHash`.
   *
   * When XO's answer is lost or cannot be read (a timeout, a broken connection, a 5xx), the
   * order may be on the book: it throws with `mayHaveLanded: true` and the `orderHash`. Never
   * place that order again; look it up with {@link reconcileOrder}.
   *
   * @param request - The outcome token (`assetId`), the `side`, the `price` and the `size`, and
   *   `postOnly` and `expiration` when wanted. See {@link CreateLimitOrderRequest}.
   * @throws {PlaceLimitOrderError} The errors of {@link createLimitOrder}, before anything is
   *   sent; with `mayHaveLanded: false`, credentials XO refused (401), a placement it forbids
   *   (403) and too many requests (a 429 `RateLimitError`); and with `mayHaveLanded: true` and
   *   the `orderHash`, every failure after which the order may have been placed.
   * @example
   * const response = await client.placeLimitOrder({
   *   assetId,
   *   side: OrderSide.BUY,
   *   price: '0.52',
   *   size: 10,
   * });
   * console.log(response.ok ? response.orderId : response.code);
   */
  placeLimitOrder(request: PlaceLimitOrderRequest): Promise<OrderResponse>;

  /**
   * Builds, signs and sends a market order, once: see {@link createMarketOrder} for the order
   * and {@link placeLimitOrder} for the result. A taker order often answers `status: 'delayed'`:
   * it waits out the taker delay and can still fill, so it is not a refusal. Read what filled
   * with {@link listAccountTrades}, or look the order up with {@link reconcileOrder}.
   *
   * @param request - The outcome token (`assetId`), the `side`, and the `amount` of a buy or the
   *   `shares` of a sell. See {@link CreateMarketOrderRequest}.
   * @throws {PlaceMarketOrderError} The errors of {@link createMarketOrder}, before anything is
   *   sent, and those of sending the order, as for {@link placeLimitOrder}: when
   *   `mayHaveLanded` is `true`, never place it again; look it up with {@link reconcileOrder}.
   * @example
   * const response = await client.placeMarketOrder({
   *   assetId,
   *   side: OrderSide.SELL,
   *   shares: 5,
   * });
   * console.log(response.ok ? response.status : response.code);
   */
  placeMarketOrder(request: PlaceMarketOrderRequest): Promise<OrderResponse>;

  /**
   * Sends one order that {@link createLimitOrder} or {@link createMarketOrder} signed. It is
   * sent once, with the results of {@link placeLimitOrder}. Before it is sent, its hash is
   * checked against the order, so an order changed after signing is refused. The same signed
   * order sent again is refused with `duplicate_order`.
   *
   * @param order - The signed order.
   * @throws {PostOrderError} `invalid_input` for something that is not a signed order (nothing
   *   is sent), `client_closed` after {@link close} or {@link endAuthentication}; with
   *   `mayHaveLanded: false`, credentials XO refused (401), a placement it forbids (403) and too
   *   many requests (a 429 `RateLimitError`); and with `mayHaveLanded: true` and the
   *   `orderHash`, every failure after which the order may have been placed.
   * @example
   * const order = await client.createLimitOrder({
   *   assetId,
   *   side: OrderSide.SELL,
   *   price: '0.6',
   *   size: 10,
   * });
   * const response = await client.postOrder(order);
   * console.log(response.ok ? response.status : response.code);
   */
  postOrder(order: SignedOrder): Promise<OrderResponse>;

  /**
   * Sends signed orders in batches of at most 300, one batch after the other, each once. Every
   * order gets its result, in the order given: accepted (`ok: true`) or refused (`ok: false`
   * with its `code`). XO does not report what filled per order of a batch: an accepted order
   * has `makingAmount`, `takingAmount`, `tradeIds` and `transactionsHashes` all `null` (not
   * reported, which is not "none"); read the account's trades for them. When XO refuses a batch
   * as a whole for good (trading paused, a malformed batch) and no order is left unsent, each
   * order of that batch is refused with that code. The same signed order twice is refused
   * before anything is sent.
   *
   * An order whose entry in XO's answer does not say what became of it, in words the SDK knows
   * for a refusal, is not given a result: it may have been placed, and the call throws.
   *
   * @param orders - The signed orders: at least one.
   * @throws {PostOrdersError} `invalid_input` for an empty list, a duplicate or something that is
   *   not a signed order (nothing is sent); `client_closed` after {@link close} or
   *   {@link endAuthentication}; and a `BatchPlaceIncompleteError` when a batch failed, or when
   *   XO answered without saying what became of some orders. Its `results` are the results so
   *   far, as this call returns them, of the orders XO answered for (an order whose fate it did
   *   not say has none, so match a result to its order by `orderHash`, not by position),
   *   `notSent` the orders not sent, and `failedChunk` the orders that may
   *   have been placed when `mayHaveLanded` is `true`: never send those again; look each up with
   *   {@link reconcileOrder}. When a batch was answered with such an order and a later batch
   *   failed, the error lists those orders (and the later batch's, when they may have been
   *   placed too), with `mayHaveLanded: true`; the failure of the later batch is its `cause`,
   *   whose `failedChunk` and `mayHaveLanded` say what became of that batch.
   * @example
   * const orders = [
   *   await client.createLimitOrder({ assetId, side: OrderSide.BUY, price: '0.5', size: 10 }),
   *   await client.createLimitOrder({ assetId, side: OrderSide.SELL, price: '0.6', size: 10 }),
   * ];
   * const responses = await client.postOrders(orders);
   * console.log(responses.map((response) => response.ok));
   */
  postOrders(orders: SignedOrder[]): Promise<OrderResponse[]>;

  /**
   * Places and cancels orders in one request: the operations run in the order given, and one
   * that fails does not undo the others. It is sent once. Each operation gets its result, in
   * order: the result of each order placed, as for {@link postOrders}, or what a cancel did.
   * When XO refuses the whole request for good before running any of it (trading paused, a
   * malformed request), each order is refused and each cancel not made, with that reason.
   *
   * @param request - The `operations`: `{ type: 'place', orders }` with signed orders, or
   *   `{ type: 'cancel', orderIds }`. See {@link PostOrderBatchRequest}.
   * @throws {PostOrderBatchError} `invalid_input` for operations that are not valid (nothing is
   *   sent), `client_closed` after {@link close} or {@link endAuthentication}, and a
   *   `BatchOpsIncompleteError` for any other failure. When its `mayHaveLanded` is `true`, the
   *   orders of its `orderHashes` may have been placed: never send them again; look each up
   *   with {@link reconcileOrder}, and read the open orders again. When XO answered without
   *   saying what became of some orders, its `results` are what each operation did, as this
   *   call returns them, but for those orders (match the orders of a place operation by
   *   `orderHash`, not by position).
   * @example
   * const replacement = await client.createLimitOrder({
   *   assetId,
   *   side: OrderSide.BUY,
   *   price: '0.51',
   *   size: 10,
   * });
   * const results = await client.postOrderBatch({
   *   operations: [
   *     { type: 'cancel', orderIds: [orderId] },
   *     { type: 'place', orders: [replacement] },
   *   ],
   * });
   * console.log(results.map((result) => result.type));
   */
  postOrderBatch(
    request: PostOrderBatchRequest,
  ): Promise<BatchOperationResult[]>;

  /**
   * Cancels one open order of the account, resting on the book or waiting out the taker delay.
   * The answer lists it in `canceled`, or in `notCanceled` with XO's reason: an order that is
   * not open (it filled, was cancelled, or never reached XO: {@link reconcileOrder} tells
   * which) is not cancelled because it is not found.
   *
   * The cancel is sent once and never retried. When its answer is lost (a timeout, a lost
   * connection, a 5xx), it throws with `mayHaveLanded: true`: the order may be cancelled, so
   * read it with {@link fetchOrder} first. If you send the cancel again yourself, an order the
   * first one cancelled comes back in `notCanceled`, not found.
   *
   * @param request - The order's `orderId`: its hash, as a placement gives it, or a numeric
   *   order id.
   * @throws {CancelOrderError} `invalid_input` for an id that is neither, `client_closed` after
   *   {@link close} or {@link endAuthentication}, and the request errors, which say
   *   `mayHaveLanded: true` when the cancel may have gone through and `false` when XO refused it
   *   or it was not sent.
   * @example
   * const result = await client.cancelOrder({ orderId });
   * console.log(result.canceled, result.notCanceled);
   */
  cancelOrder(request: CancelOrderRequest): Promise<CancelOrdersResponse>;

  /**
   * Cancels open orders of the account by id, 300 to a request. The answer lists each order in
   * `canceled`, or in `notCanceled` with XO's reason, such as `order not found` for one that is
   * not open. Ids are given back in canonical form: hashes in lower case, numeric ids without
   * leading zeros.
   *
   * Each request is sent once and never retried. When the answer of one is lost, it throws with
   * `mayHaveLanded: true`: its orders may be cancelled, so read your open orders with
   * {@link listOpenOrders} first. When a request after the first fails, however it fails, the
   * error says `mayHaveLanded: true` too: the requests before it cancelled orders. If you send a
   * cancel again yourself, an order an earlier one cancelled comes back in `notCanceled`, not
   * found.
   *
   * @param request - The `orderIds`: order hashes or numeric order ids, at least one.
   * @throws {CancelOrdersError} `invalid_input` for an empty list or an id that is not one,
   *   `client_closed` after {@link close} or {@link endAuthentication}, and the request errors,
   *   which say `mayHaveLanded: true` when a cancel may have gone through and `false` only when
   *   nothing was cancelled (XO refused the first request, or it was not sent). After a cancel
   *   that partly failed, read your open orders with {@link listOpenOrders} before acting.
   * @example
   * const result = await client.cancelOrders({ orderIds: [firstId, secondId] });
   * console.log(result.canceled.length);
   */
  cancelOrders(request: CancelOrdersRequest): Promise<CancelOrdersResponse>;

  /**
   * Cancels every open order of the account, in every market, including the orders that wait
   * out the taker delay. An order that already filled is not undone.
   *
   * The cancel is sent once and never retried. When its answer is lost, it throws with
   * `mayHaveLanded: true`: read your open orders with {@link listOpenOrders} first. If you send
   * it again yourself, it also cancels an order placed between the two, and the orders the
   * first one cancelled are missing from `canceled`.
   *
   * @throws {CancelAllError} `client_closed` after {@link close} or {@link endAuthentication},
   *   and the request errors, which say `mayHaveLanded: true` when the cancel may have gone
   *   through and `false` when XO refused it or it was not sent.
   * @example
   * const result = await client.cancelAll();
   * console.log(`cancelled ${result.canceled.length} orders`);
   */
  cancelAll(): Promise<CancelOrdersResponse>;

  /**
   * Cancels the open orders of the account in one market, or of one outcome. With `market`
   * alone, XO cancels every order of that market, both outcomes and the orders that wait out
   * the taker delay, in one request. With an `assetId`, the client lists that outcome's orders
   * that rest on the book (in that `market`, when given) and cancels them by id: an order placed
   * meanwhile, or one still waiting out the taker delay, is not cancelled.
   *
   * Each cancel request is sent once and never retried. When its answer is lost, it throws with
   * `mayHaveLanded: true`: read your open orders with {@link listOpenOrders} first. By id, 300
   * to a request, a request after the first that fails, however it fails, says
   * `mayHaveLanded: true` too: the requests before it cancelled orders. If you send it again
   * yourself with `market` alone, it also cancels an order placed between the two, and the
   * orders the first one cancelled are missing from `canceled`; by id, they come back in
   * `notCanceled`, not found.
   *
   * @param request - The `market` (a condition id), the `assetId` of an outcome, or both.
   * @throws {CancelMarketOrdersError} `invalid_input` without a market and an outcome, or for an
   *   id that is not valid; `client_closed` after {@link close} or {@link endAuthentication};
   *   and the request errors, which say `mayHaveLanded: true` when a cancel may have gone through
   *   and `false` only when nothing was cancelled (XO refused the first request, it was not
   *   sent, or reading the outcome's orders failed). After a cancel that partly failed, read
   *   your open orders with {@link listOpenOrders} before acting.
   * @example
   * const result = await client.cancelMarketOrders({ market: conditionId });
   * console.log(result.canceled);
   */
  cancelMarketOrders(
    request: CancelMarketOrdersRequest,
  ): Promise<CancelOrdersResponse>;

  /**
   * Lists the account's orders that rest on the book, a page at a time, filtered by `market`
   * or by outcome (`assetId`) when given. An order that waits out the taker delay is not
   * listed: {@link fetchOrder} finds it by its hash.
   *
   * Reading the list makes one request per page. Nothing is requested until the list is read.
   * A bad request or option throws at once.
   *
   * @param request - The `market` (a condition id) and the outcome (`assetId`), each optional.
   * @param options - Cancel, timeout and retries of each request.
   * @throws {ListOpenOrdersError} `invalid_input` for a request that is not valid,
   *   `invalid_request_options` for bad options, `invalid_cursor` for a cursor this list did
   *   not give out, `client_closed` after {@link close} or {@link endAuthentication}, and the
   *   read errors when a page fails.
   * @example
   * for await (const page of client.listOpenOrders({ market: conditionId })) {
   *   console.log(page.items.map((order) => `${order.side} ${order.originalSize} @ ${order.price}`));
   * }
   */
  listOpenOrders(
    request?: ListOpenOrdersRequest,
    options?: RequestOptions,
  ): Paginated<OpenOrder>;

  /**
   * Reads one open order of the account: resting on the book, or (by its hash) waiting out the
   * taker delay, which reads as `LIVE`. An order that filled or was cancelled is not open: to
   * find out what became of a placed order, use {@link reconcileOrder}.
   *
   * @param request - The order's `orderId`: its hash, or a numeric order id.
   * @param options - Cancel, timeout and retries of the request.
   * @throws {FetchOrderError} `invalid_input` for an id that is not one, `invalid_request_options`
   *   for bad options, a 404 `RequestRejectedError` when the order is not open or not the
   *   account's, `client_closed` after {@link close} or {@link endAuthentication}, and the read
   *   errors.
   * @example
   * const order = await client.fetchOrder({ orderId });
   * console.log(order.status, order.sizeMatched);
   */
  fetchOrder(
    request: FetchOrderRequest,
    options?: RequestOptions,
  ): Promise<OpenOrder>;

  /**
   * Lists the account's trades, newest first, a page at a time: each fill of its orders, as
   * the maker or as the taker. XO keeps the latest 500. XO filters by `market`; the outcome
   * (`assetId`) and the time window (`after`, `before`) are kept here, from the pages XO sends,
   * so a page can hold fewer trades than XO sent, even none, and still have more after it.
   *
   * Reading the list makes one request per page. Nothing is requested until the list is read.
   * A bad request or option throws at once.
   *
   * @param request - The `market` (a condition id), the outcome (`assetId`), and the window:
   *   matched at or `after` a time and `before` another, each optional.
   * @param options - Cancel, timeout and retries of each request.
   * @throws {ListAccountTradesError} `invalid_input` for a request that is not valid (a time in
   *   milliseconds, say), `invalid_request_options` for bad options, `invalid_cursor` for a
   *   cursor this list did not give out, `client_closed` after {@link close} or
   *   {@link endAuthentication}, and the read errors when a page fails.
   * @example
   * const trades = client.listAccountTrades({ market: conditionId });
   * const page = await trades.firstPage();
   * console.log(page.items.map((trade) => `${trade.side} ${trade.size} @ ${trade.price}`));
   */
  listAccountTrades(
    request?: ListAccountTradesRequest,
    options?: RequestOptions,
  ): Paginated<Trade>;

  /**
   * Reads one trade of the account, to follow its settlement on chain: its `status` goes from
   * `MATCHED` to `MINED` and `CONFIRMED` (or `FAILED`), and `transactionHash` is set once the
   * settlement is sent.
   *
   * @param request - The trade's `tradeId`, `0x` and 64 hex digits.
   * @param options - Cancel, timeout and retries of the request.
   * @throws {FetchAccountTradeError} `invalid_input` for an id that is not one,
   *   `invalid_request_options` for bad options, a 404 `RequestRejectedError` when XO does not
   *   know the trade, `client_closed` after {@link close} or {@link endAuthentication}, and the
   *   read errors.
   * @example
   * const trade = await client.fetchAccountTrade({ tradeId });
   * console.log(trade.status, trade.transactionHash);
   */
  fetchAccountTrade(
    request: FetchAccountTradeRequest,
    options?: RequestOptions,
  ): Promise<Trade>;

  /**
   * Sends one order heartbeat, once, and says whether XO counted it (`tracked`). It is opt-in:
   * the client never sends one unless you ask.
   *
   * One counted beat opts the whole account in to a dead-man switch: from then on, when no
   * counted beat arrives for 30 seconds, XO cancels every open order of the account, in every
   * market, placed by any process or key. There is no way to opt out again but silence: the
   * orders are then cancelled 30 to 35 seconds after the last counted beat. To keep beating,
   * use {@link startOrderHeartbeat}. `tracked: false` means the beat did not count (the
   * credentials were not accepted), and the countdown was not reset.
   *
   * @throws {SendOrderHeartbeatError} `client_closed` after {@link close} or
   *   {@link endAuthentication}, an `UnexpectedResponseError` for an answer that cannot be read,
   *   and the request errors. A beat is never tried again: the next one is the retry.
   * @example
   * const { tracked } = await client.sendOrderHeartbeat();
   * console.log(tracked ? 'counted' : 'not counted');
   */
  sendOrderHeartbeat(): Promise<OrderHeartbeatResponse>;

  /**
   * Starts sending order heartbeats, at once and then every `intervalMs`, and returns the
   * running heartbeat at once (not a promise). Read {@link sendOrderHeartbeat} first: the first
   * counted beat opts the whole account in to the cancel of every open order after 30 seconds
   * of silence. `stop()` stops sending and does not opt out: the orders are cancelled about 30
   * seconds after the last beat, including orders placed after `stop()`.
   *
   * Each beat that does not count reaches `onMissed`, and the heartbeat goes on: when misses go
   * on for 30 seconds the orders are cancelled, so stop quoting. The timers never keep the
   * process alive. One heartbeat runs per client; {@link close} stops it.
   *
   * @param request - `intervalMs`, from 1 000 to 20 000 (10 000 by default), and `onMissed`.
   * @throws {StartOrderHeartbeatError} At once: `invalid_input` for a request that is not valid,
   *   `heartbeat_already_running` while a heartbeat runs on this client (stop it first), and
   *   `client_closed` after {@link close} or {@link endAuthentication}.
   * @example
   * const heartbeat = client.startOrderHeartbeat({
   *   onMissed: (error) => console.warn('heartbeat missed', error.code),
   * });
   * heartbeat.stop();
   */
  startOrderHeartbeat(request?: StartOrderHeartbeatRequest): OrderHeartbeat;

  /**
   * Finds out what became of an order that may have been placed, such as one whose placement
   * threw with `mayHaveLanded: true`: `resting` with the open order, `traded` with its trades
   * among the account's latest, or `not_found`. It looks the order up by its hash, then reads
   * up to three pages of the account's trades.
   *
   * `not_found` is not proof that the order was not placed: the placement may still be on its
   * way, or the order traded before the trades read. Look again later, and never send or sign
   * the order again on the strength of it.
   *
   * @param request - The `orderHash` of the result or of the error.
   * @param options - Cancel, timeout and retries of each request.
   * @throws {ReconcileOrderError} `invalid_input` for a hash that is not one,
   *   `invalid_request_options` for bad options, `client_closed` after {@link close} or
   *   {@link endAuthentication}, and the read errors.
   * @example
   * const found = await client.reconcileOrder({ orderHash });
   * console.log(found.state);
   */
  reconcileOrder(
    request: ReconcileOrderRequest,
    options?: RequestOptions,
  ): Promise<ReconciledOrder>;

  /**
   * Reads what the account can still commit in one market: the USDC a new buy may use, and for
   * each outcome the shares a new sell may use, once its open orders are counted. Use it to
   * size an order.
   *
   * @param request - The market's `conditionId`.
   * @param options - Cancel, timeout and retries of the request.
   * @throws {FetchMarketCapacityError} `invalid_input` for a request that is not valid,
   *   `invalid_request_options` for bad options, `client_closed` after {@link close} or
   *   {@link endAuthentication}, and the read errors.
   * @example
   * const capacity = await client.fetchMarketCapacity({ conditionId });
   * console.log(capacity.buyCapacity, capacity.positions.map((position) => position.free));
   */
  fetchMarketCapacity(
    request: FetchMarketCapacityRequest,
    options?: RequestOptions,
  ): Promise<MarketCapacity>;

  // -------------------------------------------------------------------------
  // The account
  // -------------------------------------------------------------------------

  /**
   * Lists the positions of the client's own wallet, a page at a time, or of any wallet given as
   * `user`: what it holds in each outcome of each market, with the value and the profit or
   * loss, and whether it can be redeemed. The client's own positions are read with its key; any
   * other wallet's are public, and read without it.
   *
   * `redeemable: true` lists only the positions the SDK can redeem now, with
   * {@link redeemPositions} or {@link redeemAllPositions}: their market is resolved or voided,
   * the winnings are not claimed, and the market is one of the order book. A settled position
   * of an older market type pays out on that market's own contract, which these do not redeem
   * on: it is listed with `status: 'REDEEMABLE'` and `redeemable: false`. `market` lists the
   * positions of one market. Both are kept here from the pages XO sends, so a page can hold
   * fewer positions than XO sent, even none, and still have more after it. What the order book
   * holds for trading now is {@link fetchBalances}.
   *
   * Reading the list makes one request per page. Nothing is requested until the list is read. A
   * bad request or option throws at once.
   *
   * @param request - The `user` wallet (the client's own when left out), and the filters. See
   *   {@link SecureListPositionsRequest}.
   * @param options - Cancel, timeout and retries of each request.
   * @throws {ListPositionsError} `invalid_input` for a request that is not valid,
   *   `invalid_request_options` for bad options, `invalid_cursor` for a cursor that is not a page
   *   of this list, `client_closed` after {@link close} or {@link endAuthentication}, a 404
   *   `RequestRejectedError` for a `user` XO does not know, and the read errors when a page
   *   fails.
   * @example
   * for await (const page of client.listPositions({ redeemable: true })) {
   *   console.log(page.items.map((position) => `${position.title}: ${position.currentSize}`));
   * }
   */
  listPositions(
    request?: SecureListPositionsRequest,
    options?: RequestOptions,
  ): Paginated<Position>;

  /**
   * Reads the account's cash and portfolio figures, in dollars: the spendable USDC, what the
   * open positions are worth, the winnings not yet redeemed, and their sum. Every market type is
   * counted.
   *
   * @param options - Cancel, timeout and retries of the request.
   * @throws {FetchPortfolioValueError} `invalid_request_options` for bad options,
   *   `client_closed` after {@link close} or {@link endAuthentication}, and the read errors.
   * @example
   * const value = await client.fetchPortfolioValue();
   * console.log(value.value, value.cash, value.claimableAmount);
   */
  fetchPortfolioValue(options?: RequestOptions): Promise<PortfolioValue>;

  /**
   * Reads the profit and loss of the whole account: the totals, and the positions behind them.
   * Pass a `marketId` for one market, or a `positionId` for one position, instead.
   *
   * @param request - Nothing, for the whole account. See {@link FetchUserPnlRequest}.
   * @param options - Cancel, timeout and retries of the request.
   * @throws {FetchUserPnlError} `invalid_input` for a request that is not valid (a `marketId`
   *   and a `positionId` together), `invalid_request_options` for bad options, `client_closed`
   *   after {@link close} or {@link endAuthentication}, a 404 `RequestRejectedError` for a market
   *   or a position that is not the account's, and the read errors.
   * @example
   * const pnl = await client.fetchUserPnl();
   * console.log(pnl.pnl, pnl.openPositions, pnl.positions.length);
   */
  fetchUserPnl(
    request?: FetchUserPnlRequest,
    options?: RequestOptions,
  ): Promise<UserPnl>;
  /**
   * Reads the profit and loss of the account's positions in one market.
   *
   * @param request - The market's `marketId`: XO's id for it. See {@link FetchMarketPnlRequest}.
   * @param options - Cancel, timeout and retries of the request.
   * @throws {FetchUserPnlError} As for the whole account, and a 404 `RequestRejectedError` when
   *   the account has no position in the market.
   * @example
   * const pnl = await client.fetchUserPnl({ marketId: market.id });
   * console.log(pnl.title, pnl.pnl);
   */
  fetchUserPnl(
    request: FetchMarketPnlRequest,
    options?: RequestOptions,
  ): Promise<MarketPnl>;
  /**
   * Reads the profit and loss of one position of the account.
   *
   * @param request - The position's `positionId`, as a {@link Position} gives it. See
   *   {@link FetchPositionPnlRequest}.
   * @param options - Cancel, timeout and retries of the request.
   * @throws {FetchUserPnlError} As for the whole account, and a 404 `RequestRejectedError` for a
   *   position that is not the account's.
   * @example
   * const pnl = await client.fetchUserPnl({ positionId: position.positionId });
   * console.log(pnl.outcome, pnl.pnl, pnl.percentPnl);
   */
  fetchUserPnl(
    request: FetchPositionPnlRequest,
    options?: RequestOptions,
  ): Promise<PositionPnl>;

  /**
   * Lists the account's activity, newest first, a page at a time: its buys and sells, with each
   * one's transaction, shares, price and realised profit, and its redemptions, splits, merges
   * and transfers. `type` and `marketId` narrow it; a `type` other than `REDEEM` is kept here
   * from the pages XO sends, so a page can hold fewer rows than XO sent, even none, and still
   * have more after it.
   *
   * Reading the list makes one request per page. Nothing is requested until the list is read. A
   * bad request or option throws at once.
   *
   * @param request - The filters and the page size. See {@link ListActivityRequest}.
   * @param options - Cancel, timeout and retries of each request.
   * @throws {ListActivityError} `invalid_input` for a request that is not valid,
   *   `invalid_request_options` for bad options, `invalid_cursor` for a cursor that is not a page
   *   of this list, `client_closed` after {@link close} or {@link endAuthentication}, and the read
   *   errors when a page fails.
   * @example
   * const page = await client.listActivity({ type: 'TRADE' }).firstPage();
   * for (const row of page.items) {
   *   console.log(row.timestamp, row.side, row.shares, row.price, row.transactionHash);
   * }
   */
  listActivity(
    request?: ListActivityRequest,
    options?: RequestOptions,
  ): Paginated<Activity>;

  /**
   * Reads the trading statistics of the account: profit and loss, volume and the number of
   * markets traded. With a `username`, it reads that user's, as a public client does.
   *
   * @param request - A user's `username`, or nothing for the account's own. See
   *   {@link SecureFetchUserStatsRequest}.
   * @param options - Cancel, timeout and retries of the request.
   * @throws {FetchUserStatsError} `invalid_input` for a request that is not valid,
   *   `invalid_request_options` for bad options, `client_closed` after {@link close} or
   *   {@link endAuthentication}, a 404 `RequestRejectedError` when XO has no such user, and the
   *   read errors.
   * @example
   * const stats = await client.fetchUserStats();
   * console.log(stats.pnl, stats.volume, stats.tradedMarketCount);
   */
  fetchUserStats(
    request?: SecureFetchUserStatsRequest,
    options?: RequestOptions,
  ): Promise<UserStats>;

  /**
   * Reads the account's own profile: its username, wallet, points, tier, socials and standing.
   * Positions and activity are not part of it: see {@link listPositions} and
   * {@link listActivity}.
   *
   * @param options - Cancel, timeout and retries of the request.
   * @throws {FetchProfileError} `invalid_request_options` for bad options, `client_closed` after
   *   {@link close} or {@link endAuthentication}, and the read errors.
   * @example
   * const profile = await client.fetchProfile();
   * console.log(profile.username, profile.tier, profile.convictionPoints);
   */
  fetchProfile(options?: RequestOptions): Promise<Profile>;

  /**
   * Lists the account's API keys, newest first, on one page: each key's id, name, prefix,
   * scopes and dates, never the key itself. Revoked and expired keys are listed too. XO lists at
   * most the 100 newest. A key can be revoked only by itself: the client revokes the key it uses
   * with {@link endAuthentication}, or replaces it with {@link rotateCredentials}.
   *
   * Nothing is requested until the list is read. A bad option throws at once.
   *
   * @param options - Cancel, timeout and retries of the request.
   * @throws {ListApiKeysError} `invalid_request_options` for bad options, `invalid_cursor` for
   *   any cursor (the list has one page), `client_closed` after {@link close} or
   *   {@link endAuthentication}, and the read errors.
   * @example
   * const page = await client.listApiKeys().firstPage();
   * console.log(page.items.map((key) => `${key.id} ${key.name} ${key.revokedAt ?? 'active'}`));
   */
  listApiKeys(options?: RequestOptions): Paginated<ApiKey>;

  /**
   * Reads what the order book holds for the account now: its cash credit (`collateral`), and
   * for each outcome token the shares it holds and those that resting sell orders reserve. This
   * is what trading can use, not the balances at the wallet address on chain: the two can
   * differ, for example right after a deposit or before a withdrawal.
   *
   * @param options - Cancel, timeout and retries of the request.
   * @throws {FetchBalancesError} `invalid_request_options` for bad options, `client_closed` after
   *   {@link close} or {@link endAuthentication}, an `UnexpectedResponseError` for an amount that
   *   cannot be read, and the read errors.
   * @example
   * const balances = await client.fetchBalances();
   * console.log(balances.collateral, balances.positions.map((p) => `${p.assetId}: ${p.balance}`));
   */
  fetchBalances(options?: RequestOptions): Promise<Balances>;

  /**
   * Reads on chain what the account has set up for trading: whether it exists (a smart wallet is
   * made by its first transaction), whether the exchange may spend its USDC and move its outcome
   * tokens, and so whether it is `ready`. Nothing is sent. When it is not ready,
   * {@link setupTradingApprovals} sets it up.
   *
   * The reads are of the chain: `signal` and `timeout` bound the whole of it, and the chain
   * reads retry on their own, so `retries` does not change them.
   *
   * @param options - Cancel and timeout of the reads.
   * @throws {FetchTradingApprovalsStateError} `invalid_request_options` for bad options,
   *   `client_closed` after {@link close} or {@link endAuthentication}, a `RequestAbortedError`
   *   or `TimeoutError` from the options, and an `XoError` `chain_read_failed` when the chain
   *   cannot be read.
   * @example
   * const state = await client.fetchTradingApprovalsState();
   * if (!state.ready) {
   *   await client.setupTradingApprovals();
   * }
   */
  fetchTradingApprovalsState(
    options?: RequestOptions,
  ): Promise<TradingApprovalsState>;

  // -------------------------------------------------------------------------
  // On chain
  // -------------------------------------------------------------------------

  /**
   * Sets the account up for trading: in one transaction, it lets the exchange spend the
   * account's USDC and move its outcome tokens, and makes a smart wallet that does not exist
   * yet. It reads what is missing first and sends only that, so calling it again is safe; when
   * nothing is missing it sends nothing and returns `null`. XO's sponsor pays the gas unless the
   * client uses the direct rail.
   *
   * The transaction is sent once, never again and never signed again. The call returns once the
   * chain has mined it. When its outcome is unknown (the receipt did not come, or the sponsor's
   * answer was lost), it throws with `mayHaveLanded: true` and the `transactionHash` (or the
   * executor `nonce`) to look it up by: check before you call again.
   *
   * @throws {SetupTradingApprovalsError} `client_closed` after {@link close} or
   *   {@link endAuthentication}, a `chain_read_failed` `XoError` when the chain cannot be read,
   *   the sponsor's refusals (`mayHaveLanded: false`), a `TransactionFailedError` `tx_reverted`
   *   when the transaction was mined and reverted (call again: it reads the chain again), and a
   *   `TransactionFailedError` with `mayHaveLanded: true` when the outcome is unknown.
   * @example
   * const transaction = await client.setupTradingApprovals();
   * console.log(transaction === null ? 'set up already' : transaction.transactionHash);
   */
  setupTradingApprovals(): Promise<TransactionHandle | null>;

  /**
   * Merges YES and NO shares of one market back into USDC: an amount of YES and the same amount
   * of NO are burnt for that many USDC, in one transaction. Without `amount`, it merges all it
   * can: as many full sets as are free of both outcomes on the order book (shares held by
   * resting sell orders are not free). Stop quoting the market first: an order matched while
   * the merge is on its way can be left without its shares.
   *
   * The transaction is sent once, never again and never signed again, and the call returns once
   * the chain has mined it: a reverted merge is a result (`wait()` says `reverted`). When its
   * outcome is unknown it throws with `mayHaveLanded: true` and the `transactionHash` (or the
   * executor `nonce`): look it up before you merge again.
   *
   * @param request - The market's `conditionId`, and the `amount` of full sets, in whole shares.
   * @throws {MergePositionsError} `invalid_input` for a request that is not valid,
   *   `nothing_to_merge` when none of one outcome is free and `amount_exceeds_free` above what
   *   is (nothing is sent), `client_closed` after {@link close} or {@link endAuthentication},
   *   the errors of reading the order book, the sponsor's refusals, and a
   *   `TransactionFailedError` with `mayHaveLanded: true` when the outcome is unknown.
   * @example
   * const transaction = await client.mergePositions({ conditionId, amount: '5' });
   * console.log((await transaction.wait()).status);
   */
  mergePositions(request: MergePositionsRequest): Promise<TransactionHandle>;

  /**
   * Redeems the account's YES and NO shares of one resolved market for what they pay out, in one
   * transaction. The market must be resolved on chain: while it is not, nothing is sent. A
   * redeem with no shares pays nothing.
   *
   * The transaction is sent once, never again and never signed again, and the call returns once
   * the chain has mined it: a reverted redeem is a result (`wait()` says `reverted`). When its
   * outcome is unknown it throws with `mayHaveLanded: true` and the `transactionHash` (or the
   * executor `nonce`): look it up before you redeem again.
   *
   * @param request - The resolved market's `conditionId`.
   * @throws {RedeemPositionsError} `invalid_input` for a request that is not valid,
   *   `not_resolved` while the market is not resolved on chain (nothing is sent), `client_closed`
   *   after {@link close} or {@link endAuthentication}, a `chain_read_failed` `XoError`, the
   *   sponsor's refusals, and a `TransactionFailedError` with `mayHaveLanded: true` when the
   *   outcome is unknown.
   * @example
   * const transaction = await client.redeemPositions({ conditionId });
   * console.log(transaction.transactionHash);
   */
  redeemPositions(request: RedeemPositionsRequest): Promise<TransactionHandle>;

  /**
   * Redeems every market the account can redeem, one transaction per market, one after the
   * other, and gives one result per market: `ok: true` with the mined transaction, or
   * `ok: false` with the error. A market that fails does not stop the others, with one
   * exception: after a send whose outcome is unknown nothing more is sent, since another
   * transaction could take its place, and every market after it is `skipped_after_ambiguous`.
   * Look that transaction up, then call again. Nothing to redeem gives an empty list.
   *
   * Each transaction is sent once, never again and never signed again.
   *
   * @throws {RedeemAllPositionsError} `client_closed` after {@link close} or
   *   {@link endAuthentication}, and the errors of reading which markets can be redeemed, before
   *   anything is sent. The failure of one market is its result, not a throw.
   * @example
   * const results = await client.redeemAllPositions();
   * for (const result of results) {
   *   console.log(result.conditionId, result.ok ? result.transaction.transactionHash : result.error.code);
   * }
   */
  redeemAllPositions(): Promise<RedemptionResult[]>;

  /**
   * Sends an ERC-20 token from the trading wallet to an address, in one transaction: XO's USDC
   * when `token` is left out. The amount is in whole units of the token (`'5'` is 5 USDC); for
   * another token its decimals are read from the chain first. The balance is read before the
   * send, and when it is short nothing is sent.
   *
   * The transaction is sent once, never again and never signed again, and the call returns once
   * the chain has mined it: a reverted transfer is a result (`wait()` says `reverted`). When its
   * outcome is unknown it throws with `mayHaveLanded: true` and the `transactionHash` (or the
   * executor `nonce`): look it up before you send again, or the tokens may go out twice.
   *
   * @param request - The `to` address, the `amount` in whole units, and the `token` (XO's USDC
   *   by default). See {@link TransferErc20Request}.
   * @throws {TransferErc20Error} `invalid_input` for a request that is not valid, the zero
   *   address or a token contract as `to` (`recipient_is_token_contract`), an amount with more
   *   decimals than the token has, `insufficient_balance` (nothing is sent),
   *   `client_closed` after {@link close} or {@link endAuthentication}, a `chain_read_failed`
   *   `XoError`, the sponsor's refusals, and a `TransactionFailedError` with
   *   `mayHaveLanded: true` when the outcome is unknown.
   * @example
   * const transaction = await client.transferErc20({ to: recipient, amount: '25' });
   * const receipt = await transaction.wait();
   * console.log(receipt.status, receipt.blockNumber);
   */
  transferErc20(request: TransferErc20Request): Promise<TransactionHandle>;

  // -------------------------------------------------------------------------
  // Deposits and withdrawals
  // -------------------------------------------------------------------------

  /**
   * Lists the tokens a deposit can be paid in (`deposit`), or a withdrawal can deliver
   * (`withdraw`), on one page. A deposit lands as USDC in the trading wallet whatever it is paid
   * in. Pass an asset's `assetId` to a quote.
   *
   * Nothing is requested until the list is read. A bad request or option throws at once.
   *
   * @param request - The `direction`.
   * @param options - Cancel, timeout and retries of the request.
   * @throws {ListBridgeAssetsError} `invalid_input` for a direction that is neither,
   *   `invalid_request_options` for bad options, `invalid_cursor` for any cursor (the list has
   *   one page), `bridge_not_available` on an environment without deposits, `client_closed`
   *   after {@link close} or {@link endAuthentication}, and the read errors.
   * @example
   * const page = await client.listBridgeAssets({ direction: 'deposit' }).firstPage();
   * console.log(page.items.map((asset) => `${asset.symbol} on ${asset.chain}: ${asset.assetId}`));
   */
  listBridgeAssets(
    request: ListBridgeAssetsRequest,
    options?: RequestOptions,
  ): Paginated<BridgeAsset>;

  /**
   * Asks for the ways to deposit an amount of a token into XO: each quote says what goes in,
   * what lands in the trading wallet (USDC) and what it costs, the one that lands the most first.
   * A quote moves nothing; confirm one with {@link createDeposit} before its `acceptBy`.
   *
   * A quote is a read: it is retried like one. The quotes carry no minimum or maximum: an amount
   * the bridge does not take fails with `amount_out_of_range`, whose message names the bounds.
   *
   * @param request - The `assetId` to pay in and the `amount`, in whole units of it.
   * @param options - Cancel, timeout and retries of the request.
   * @throws {QuoteDepositError} `invalid_input` for a request that is not valid,
   *   `invalid_request_options` for bad options, a 400 `RequestRejectedError`
   *   (`asset_not_supported`, `amount_out_of_range`, `amount_invalid`), `bridge_not_available`,
   *   `client_closed` after {@link close} or {@link endAuthentication}, and the read errors.
   * @example
   * const [best] = await client.quoteDeposit({ assetId, amount: '25' });
   * console.log(best?.output.amount, best?.fees.total);
   */
  quoteDeposit(
    request: QuoteDepositRequest,
    options?: RequestOptions,
  ): Promise<DepositQuote[]>;

  /**
   * Asks for the ways to withdraw an amount of USDC out of XO, delivered as a token to a
   * recipient: each quote says what leaves the trading wallet, what the recipient gets and what
   * it costs, the one that delivers the most first. A quote moves nothing; withdraw with one with
   * {@link withdraw} before its `acceptBy`. Check the recipient: a valid address that is wrong
   * cannot be undone.
   *
   * A quote is a read: it is retried like one. The quotes carry no minimum or maximum: an amount
   * the bridge does not take fails with `amount_out_of_range`, whose message names the bounds.
   *
   * @param request - The `assetId` to deliver, the `amount` of USDC and the `recipient`. See
   *   {@link QuoteWithdrawalRequest}.
   * @param options - Cancel, timeout and retries of the request.
   * @throws {QuoteWithdrawalError} As {@link quoteDeposit}, and a 400 `RequestRejectedError`
   *   `recipient_invalid` for an address that is not one on the asset's network.
   * @example
   * const [best] = await client.quoteWithdrawal({ assetId, amount: '25', recipient });
   * console.log(best?.output.amount, best?.recipient);
   */
  quoteWithdrawal(
    request: QuoteWithdrawalRequest,
    options?: RequestOptions,
  ): Promise<WithdrawalQuote[]>;

  /**
   * Confirms a deposit quote, once: the payment it gives says where to send the funds
   * (`deposit`: a one-time address, the exact amount and the token). Sending them is up to you;
   * then follow the payment with {@link waitForBridgePayment}. The bridge answers a repeated
   * confirm with the payment it has. A payment in `CONFIRM_UNKNOWN` has no `deposit` yet: read it
   * again with {@link fetchBridgePayment} before you send anything.
   *
   * When the bridge asks the owner wallet to sign first, every item is checked and shown to your
   * `verify` callback, and nothing is signed unless it approves them all. Without it, the call
   * fails with `verification_required` and the payment waits: finish it with
   * {@link verifyBridgePayment}.
   *
   * @param request - The `quote`, and `verify` when the bridge may ask for signatures.
   * @throws {CreateDepositError} `invalid_input` for a request that is not valid (a withdrawal
   *   quote included; nothing is sent), `client_closed` after {@link close} or
   *   {@link endAuthentication}, a 409 `RequestRejectedError` `quote_expired`,
   *   `verification_required`, the signer's errors, and, with `mayHaveLanded: true` and the
   *   `paymentId`, a confirm whose answer was lost: read the payment before anything else.
   * @example
   * const [quote] = await client.quoteDeposit({ assetId, amount: '25' });
   * const payment = await client.createDeposit({ quote });
   * console.log(payment.deposit?.address, payment.deposit?.amount);
   */
  createDeposit(request: CreateDepositRequest): Promise<BridgePayment>;

  /**
   * Withdraws from XO with a quote: it confirms the quote, checks that the payment delivers to
   * the quote's recipient and asks for exactly the quoted USDC, claims the payment's funding
   * once, and sends that USDC from the trading wallet once. The bridge then delivers the quoted
   * token to the recipient: follow it with {@link waitForBridgePayment}. Everything that can be
   * checked is checked before the claim (the balance included), and a failure there leaves
   * nothing claimed or sent.
   *
   * Money moves once: the claim and the transfer are never repeated, and calling again for the
   * same quote after the claim fails with `bridge_funding_claimed` and sends nothing. After an
   * error with `mayHaveLanded: true`, read the payment with {@link fetchBridgePayment} and look
   * the transfer up by its `transactionHash` (or `nonce`) before you send anything yourself. A
   * transfer that reverted is a result (`transaction.wait()` says `reverted`): the claim is used,
   * so send the payment's `deposit.amount` to its `deposit.address` yourself.
   *
   * @param request - The `quote`, and `verify` when the bridge may ask for signatures.
   * @throws {WithdrawError} `invalid_input` for a request that is not valid (a deposit quote
   *   included), `insufficient_balance`, `client_closed` after {@link close} or
   *   {@link endAuthentication}, `bridge_funding_mismatch` for a payment the SDK will not fund
   *   (nothing claimed or sent), `bridge_funding_claimed` (`mayHaveLanded: true`) when the
   *   funding was claimed already, the rail's checks before the confirm
   *   (`previous_operation_pending` while an earlier transaction may still land), the bridge's
   *   refusals, and a `TransactionFailedError` with `mayHaveLanded: true`, the `paymentId` and the
   *   `transactionHash` or `nonce` when the transfer's outcome is unknown.
   * @example
   * const [quote] = await client.quoteWithdrawal({ assetId, amount: '25', recipient });
   * const { payment, transaction } = await client.withdraw({ quote });
   * console.log(payment.paymentId, (await transaction.wait()).status);
   */
  withdraw(request: WithdrawRequest): Promise<BridgeWithdrawal>;

  /**
   * Finishes a payment that waits for the owner wallet's signatures (`NEEDS_VERIFICATION`), such
   * as a deposit that failed with `verification_required`. Every item is checked and shown to
   * `verify`, and nothing is signed unless it approves them all; the signatures are sent once. A
   * payment in any other status is returned as it is, with nothing asked, signed or sent, so it
   * is safe to call again.
   *
   * @param request - The `paymentId`, and `verify`, which approves each item.
   * @throws {VerifyBridgePaymentError} `invalid_input` for a request that is not valid,
   *   `client_closed` after {@link close} or {@link endAuthentication}, a 404
   *   `RequestRejectedError` `payment_not_found`, `verification_required` when `verify` did not
   *   approve, the signer's errors, and, with `mayHaveLanded: true`, a sending of the signatures
   *   whose answer was lost.
   * @example
   * const payment = await client.verifyBridgePayment({
   *   paymentId,
   *   verify: (item) => item.reason === 'EVM_OWNER',
   * });
   * console.log(payment.status);
   */
  verifyBridgePayment(
    request: VerifyBridgePaymentRequest,
  ): Promise<BridgePayment>;

  /**
   * Reads one payment by its id: a deposit or a withdrawal at any point of its life, or a quote
   * nobody confirmed. Its `status` says what to do next.
   *
   * @param request - The `paymentId`.
   * @param options - Cancel, timeout and retries of the request.
   * @throws {FetchBridgePaymentError} `invalid_input` for a request that is not valid,
   *   `invalid_request_options` for bad options, `client_closed` after {@link close} or
   *   {@link endAuthentication}, a 404 `RequestRejectedError` `payment_not_found`, and the read
   *   errors.
   * @example
   * const payment = await client.fetchBridgePayment({ paymentId });
   * console.log(payment.status, payment.fundingClaimedAt);
   */
  fetchBridgePayment(
    request: BridgePaymentRequest,
    options?: RequestOptions,
  ): Promise<BridgePayment>;

  /**
   * Waits until a payment is final, reading it every 10 seconds, and returns it. A final payment
   * is not always a success: `COMPLETE` delivered, `EXPIRED` was not funded in time and
   * `TAINTED` will not complete. `HALTED` is waited out: it may still finish. A read that fails
   * because the service is down or slow is ridden out until the timeout. Waiting only reads: it
   * is safe to call again.
   *
   * It takes a `signal` and a `timeout` for the whole wait, and no retries: it reads again by
   * itself.
   *
   * @param request - The `paymentId`.
   * @param options - The `signal` that ends the wait, and the `timeout` of the whole wait (one
   *   hour by default, at most 24 hours).
   * @throws {WaitForBridgePaymentError} `invalid_input` for a request that is not valid,
   *   `invalid_request_options` for bad options, `client_closed` after {@link close} or
   *   {@link endAuthentication}, a `RequestAbortedError` when the signal aborts (its `cause` is
   *   the signal's reason), a `TimeoutError` `bridge_wait_timeout` when the payment was not final
   *   in time (it goes on), a 404 `RequestRejectedError` `payment_not_found`, and the read errors
   *   that are not ridden out.
   * @example
   * const payment = await client.waitForBridgePayment({ paymentId }, { timeout: 30 * 60_000 });
   * console.log(payment.status === 'COMPLETE' ? 'delivered' : payment.status);
   */
  waitForBridgePayment(
    request: BridgePaymentRequest,
    options?: WaitForBridgePaymentOptions,
  ): Promise<BridgePayment>;

  /**
   * Lists the account's deposits and withdrawals, newest first, a page at a time. A quote nobody
   * confirmed is not listed.
   *
   * Reading the list makes one request per page. Nothing is requested until the list is read. A
   * bad request or option throws at once.
   *
   * @param request - The `direction` and the `status` to list, each optional.
   * @param options - Cancel, timeout and retries of each request.
   * @throws {ListBridgePaymentsError} `invalid_input` for a request that is not valid (the
   *   status `QUOTED` included), `invalid_request_options` for bad options, `invalid_cursor` for a
   *   cursor that is not a page of this list, `client_closed` after {@link close} or
   *   {@link endAuthentication}, and the read errors when a page fails.
   * @example
   * for await (const page of client.listBridgePayments({ direction: 'withdraw' })) {
   *   console.log(page.items.map((payment) => `${payment.paymentId} ${payment.status}`));
   * }
   */
  listBridgePayments(
    request?: ListBridgePaymentsRequest,
    options?: RequestOptions,
  ): Paginated<BridgePayment>;

  // -------------------------------------------------------------------------
  // Rewards
  // -------------------------------------------------------------------------

  /**
   * Lists the makers by the liquidity rewards they earned in a period, best first, a page at a
   * time, each with the profile of its wallet. XO shows the leaderboard to signed-in accounts.
   * An empty leaderboard can also mean XO could not read it for now: ask again before you
   * conclude that nobody earned.
   *
   * Reading the list makes one request per page. Nothing is requested until the list is read. A
   * bad request or option throws at once.
   *
   * @param request - The `period` (`weekly` by default) and the page size. See
   *   {@link ListRewardsLeaderboardRequest}.
   * @param options - Cancel, timeout and retries of each request.
   * @throws {ListRewardsLeaderboardError} `invalid_input` for a request that is not valid,
   *   `invalid_request_options` for bad options, `invalid_cursor` for a cursor that is not a page
   *   of this list, `client_closed` after {@link close} or {@link endAuthentication}, and the read
   *   errors when a page fails.
   * @example
   * const page = await client.listRewardsLeaderboard({ period: 'daily' }).firstPage();
   * console.log(page.items.map((entry) => `${entry.rank} ${entry.username ?? entry.wallet} ${entry.liquidityCp}`));
   */
  listRewardsLeaderboard(
    request?: ListRewardsLeaderboardRequest,
    options?: RequestOptions,
  ): Paginated<RewardsLeaderboardEntry>;

  /**
   * Reads where the account stands on the liquidity leaderboard of a period: its rank and what
   * it earned. An account that is not ranked gets a 404, which XO also answers when it cannot
   * read the leaderboard for now: ask again before you conclude.
   *
   * @param request - The `period`, `weekly` by default.
   * @param options - Cancel, timeout and retries of the request.
   * @throws {FetchRewardsLeaderboardStandingError} `invalid_input` for a request that is not
   *   valid, `invalid_request_options` for bad options, `client_closed` after {@link close} or
   *   {@link endAuthentication}, a 404 `RequestRejectedError` when the account is not ranked,
   *   and the read errors.
   * @example
   * const standing = await client.fetchRewardsLeaderboardStanding({ period: 'weekly' });
   * console.log(standing.rank, standing.liquidityCp);
   */
  fetchRewardsLeaderboardStanding(
    request?: FetchRewardsLeaderboardStandingRequest,
    options?: RequestOptions,
  ): Promise<RewardsLeaderboardStanding>;

  /**
   * Reads what the account's wallet has earned from liquidity rewards, or any wallet given as
   * `user`: in each currency the total received, what came from liquidity and what is accruing
   * on the open day. A wallet that has earned nothing reads zeros. Every figure is rounded to
   * two decimals. The account's own is read with its key.
   *
   * @param request - The `user` wallet, or nothing for the account's own.
   * @param options - Cancel, timeout and retries of the request.
   * @throws {FetchUserRewardsError} `invalid_input` for a request that is not valid,
   *   `invalid_request_options` for bad options, `client_closed` after {@link close} or
   *   {@link endAuthentication}, and the read errors.
   * @example
   * const rewards = await client.fetchUserRewards();
   * console.log(rewards.usdc?.totalReceived, rewards.cp?.totalReceived);
   */
  fetchUserRewards(
    request?: SecureFetchUserRewardsRequest,
    options?: RequestOptions,
  ): Promise<UserRewards>;

  /**
   * Reads one UTC day of the rewards of the account's wallet, or of any wallet given as `user`,
   * across every market it made liquidity in: for each market the score, the share of the pot
   * and the payout.
   *
   * @param request - The `user` wallet (the account's own when left out) and the `epoch`. See
   *   {@link SecureFetchUserRewardsEpochRequest}.
   * @param options - Cancel, timeout and retries of the request.
   * @throws {FetchUserRewardsEpochError} `invalid_input` for a request that is not valid,
   *   `invalid_request_options` for bad options, `client_closed` after {@link close} or
   *   {@link endAuthentication}, and the read errors.
   * @example
   * const day = await client.fetchUserRewardsEpoch({ epoch: 20_743 });
   * console.log(day.effectiveCp, day.markets.map((market) => market.conditionId));
   */
  fetchUserRewardsEpoch(
    request?: SecureFetchUserRewardsEpochRequest,
    options?: RequestOptions,
  ): Promise<UserRewardsEpoch>;

  /**
   * Lists the orders of the account's wallet that were scored for rewards, or of any wallet
   * given as `user`, a page at a time, each with its market, price, score, how it ended and what
   * it paid per currency.
   *
   * Reading the list makes one request per page. Nothing is requested until the list is read. A
   * bad request or option throws at once.
   *
   * @param request - The `user` wallet (the account's own when left out) and the filters. See
   *   {@link SecureListUserRewardsOrdersRequest}.
   * @param options - Cancel, timeout and retries of each request.
   * @throws {ListUserRewardsOrdersError} `invalid_input` for a request that is not valid,
   *   `invalid_request_options` for bad options, `invalid_cursor` for a cursor that is not a page
   *   of this list, `client_closed` after {@link close} or {@link endAuthentication}, and the read
   *   errors when a page fails.
   * @example
   * const page = await client.listUserRewardsOrders({ epoch: 20_743 }).firstPage();
   * console.log(page.items.map((order) => order.payouts));
   */
  listUserRewardsOrders(
    request?: SecureListUserRewardsOrdersRequest,
    options?: RequestOptions,
  ): Paginated<RewardsOrder>;
}

/**
 * Every action a secure client adds to those of a public client, each taking the context
 * first. The reads of a wallet that a public client makes of any wallet (`listPositions`,
 * `fetchUserStats` and the rewards of a user) are bound again here: on a secure client they
 * read its own wallet when the request names none.
 *
 * @internal
 */
export const secureActions = {
  createLimitOrder: trading.createLimitOrder,
  createMarketOrder: trading.createMarketOrder,
  placeLimitOrder: trading.placeLimitOrder,
  placeMarketOrder: trading.placeMarketOrder,
  postOrder: trading.postOrder,
  postOrders: trading.postOrders,
  postOrderBatch: trading.postOrderBatch,
  cancelOrder: trading.cancelOrder,
  cancelOrders: trading.cancelOrders,
  cancelAll: trading.cancelAll,
  cancelMarketOrders: trading.cancelMarketOrders,
  listOpenOrders: trading.listOpenOrders,
  fetchOrder: trading.fetchOrder,
  listAccountTrades: trading.listAccountTrades,
  fetchAccountTrade: trading.fetchAccountTrade,
  sendOrderHeartbeat: trading.sendOrderHeartbeat,
  startOrderHeartbeat: trading.startOrderHeartbeat,
  reconcileOrder: trading.reconcileOrder,
  fetchMarketCapacity: marketData.fetchMarketCapacity,
  listPositions: accountActions.secureListPositions,
  fetchPortfolioValue: accountActions.fetchPortfolioValue,
  fetchUserPnl: accountActions.fetchUserPnl,
  listActivity: accountActions.listActivity,
  fetchUserStats: accountActions.secureFetchUserStats,
  fetchProfile: accountActions.fetchProfile,
  listApiKeys: accountActions.listApiKeys,
  fetchBalances: accountActions.fetchBalances,
  fetchTradingApprovalsState: accountActions.fetchTradingApprovalsState,
  setupTradingApprovals: onchain.setupTradingApprovals,
  mergePositions: onchain.mergePositions,
  redeemPositions: onchain.redeemPositions,
  redeemAllPositions: onchain.redeemAllPositions,
  transferErc20: onchain.transferErc20,
  listBridgeAssets: bridgeActions.listBridgeAssets,
  quoteDeposit: bridgeActions.quoteDeposit,
  quoteWithdrawal: bridgeActions.quoteWithdrawal,
  createDeposit: bridgeActions.createDeposit,
  withdraw: bridgeActions.withdraw,
  verifyBridgePayment: bridgeActions.verifyBridgePayment,
  fetchBridgePayment: bridgeActions.fetchBridgePayment,
  waitForBridgePayment: bridgeActions.waitForBridgePayment,
  listBridgePayments: bridgeActions.listBridgePayments,
  listRewardsLeaderboard: rewards.listRewardsLeaderboard,
  fetchRewardsLeaderboardStanding: rewards.fetchRewardsLeaderboardStanding,
  fetchUserRewards: rewards.secureFetchUserRewards,
  fetchUserRewardsEpoch: rewards.secureFetchUserRewardsEpoch,
  listUserRewardsOrders: rewards.secureListUserRewardsOrders,
} as const;

/** Every action of a secure client. */
const allActions = { ...publicActions, ...secureActions };

/** The names of the actions of `A` that return at once, not a promise. */
type ImmediateName<A> = {
  [K in keyof A]: A[K] extends (...args: never[]) => infer R
    ? R extends PromiseLike<unknown>
      ? never
      : K
    : never;
}[keyof A];

/**
 * The actions that return at once: a list, or the running heartbeat. Named one by one, and the
 * compiler checks the list is exactly the actions that do not return a promise, so a member's
 * type always says what it returns.
 */
const IMMEDIATE: Readonly<Record<ImmediateName<typeof allActions>, true>> = {
  listMarkets: true,
  listBrowseItems: true,
  listEvents: true,
  listSubevents: true,
  listSeries: true,
  listCategories: true,
  listSubcategories: true,
  listPulseMarkets: true,
  listPriceHistory: true,
  listTrades: true,
  listRewardPools: true,
  listRewardGroups: true,
  listMarketRewardsMakers: true,
  listMarketRewardsOrders: true,
  listUserRewardsOrders: true,
  listOpenOrders: true,
  listAccountTrades: true,
  startOrderHeartbeat: true,
  listPositions: true,
  listActivity: true,
  listApiKeys: true,
  listBridgeAssets: true,
  listBridgePayments: true,
  listRewardsLeaderboard: true,
};

const OPTION_KEYS = [
  'environment',
  'fetch',
  'WebSocket',
  'onRateLimitUpdate',
  'signer',
  'wallet',
  'credentials',
  'store',
  'rail',
  'shutdownHooks',
  'strictResponses',
  'label',
] as const;

/**
 * The per-attempt timeout of the requests that sign the wallet in or out: the sign-in
 * message, the API key, the order book credentials, and the revokes of a sign-out.
 */
const AUTH_TIMEOUT_MS = 15_000;

const NO_SIGNER =
  'signer is required: pass privateKey(key) or signerFrom(account) from @xomarket/client/viem, or use createPublicClient to read public data without a wallet';

type Phase = 'open' | 'closed' | 'signed_out';

/** What every member throws once the client is closed or signed out. Nothing was sent. */
function closedError(phase: Exclude<Phase, 'open'>): UserInputError {
  return withLanded(
    new UserInputError(
      phase === 'closed'
        ? 'The client is closed: create a new one with createSecureClient'
        : 'The client signed the wallet out: use the client endAuthentication returned to read public data, or create a new one with createSecureClient',
      { code: 'client_closed' },
    ),
    false,
  );
}

function readBoolean(
  value: unknown,
  field: string,
  fallback: boolean,
): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new UserInputError(`${field} must be true or false`);
  }
  return value;
}

function readStore(value: unknown): CredentialStore | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isObject(value) ||
    typeof value.persistent !== 'boolean' ||
    typeof value.get !== 'function' ||
    typeof value.set !== 'function' ||
    typeof value.delete !== 'function'
  ) {
    throw new UserInputError(
      'store must be a CredentialStore: fileStore(directory) from @xomarket/client/node, or your own; leave it out to keep the credentials in memory',
    );
  }
  return value as unknown as CredentialStore;
}

function readRail(value: unknown): 'sponsored' | 'direct' | undefined {
  if (value !== undefined && value !== 'sponsored' && value !== 'direct') {
    throw new UserInputError('rail must be "sponsored" or "direct"');
  }
  return value;
}

/**
 * Deploys the trading smart wallet when it has no code yet, with the trading setup's one
 * transaction (the factory's deployment, then the approvals), on the client's rail. Nothing is
 * sent when it has code. The send is made once and never again: its errors propagate as the
 * rail and the setup throw them, `mayHaveLanded` included. The code read before it leaves with
 * `mayHaveLanded: false`.
 */
async function deployUndeployed(account: AccountClient): Promise<void> {
  let deployed: boolean;
  try {
    deployed = await account.isDeployed();
  } catch (error) {
    throw error instanceof XoError ? withLanded(error, false) : error;
  }
  if (!deployed) {
    await account.setupTransaction();
  }
}

/**
 * The actions bound to `ctx`, each refusing with `client_closed` once the client is closed.
 * An action named in `immediate` returns at once (a list, a running heartbeat), so it throws
 * at once; every other action returns a promise, so it rejects.
 */
function guardedActions<A extends Record<string, unknown>>(
  actions: A,
  ctx: ActionContext,
  assertOpen: () => void,
  immediate: Readonly<Record<ImmediateName<A>, true>>,
): Bound<A> {
  const bound: Record<string, unknown> = {};
  for (const [name, action] of Object.entries(actions)) {
    const run = action as (ctx: ActionContext, ...args: unknown[]) => unknown;
    bound[name] = Object.hasOwn(immediate, name)
      ? (...args: unknown[]) => {
          assertOpen();
          return run(ctx, ...args);
        }
      : async (...args: unknown[]) => {
          assertOpen();
          return run(ctx, ...args);
        };
  }
  return bound as Bound<A>;
}

/**
 * Creates a client that signs in with a wallet. It resolves once the client has signed in:
 * the wallet's API key is loaded from the `store` or signed in for (one wallet signature), and
 * its order book credentials are derived, or created the first time (one more signature).
 * Credentials given in `credentials` are checked to be the wallet's first (see the option),
 * and then used without signing in for new ones.
 *
 * Before any of that, the `wallet` address is checked against the signer: the signer's own
 * address, or one of its smart wallets (read from the chain). An address the signer does not
 * own is refused before anything is signed or sent to XO.
 *
 * An undeployed smart wallet is deployed once, gas-free, when the client is created: XO's
 * order book checks a smart wallet's signatures on chain, so it cannot sign in before. Once
 * given credentials are checked and before it signs in, the client sends, through XO's sponsor,
 * the one transaction that {@link SecureClient.setupTradingApprovals} would send: it makes the
 * smart wallet and sets its approvals for trading. It waits for the transaction to be mined.
 * The transaction is sent once, never again and never signed again; when it fails, no client
 * is made and no key is left signed in for. A smart wallet that exists already, or the signer's
 * own address, is sent nothing.
 *
 * With the default memory store the API key lasts a day, and the client revokes it on
 * `close()`, on SIGINT or SIGTERM and when the process exits normally (see `shutdownHooks`).
 * When creating the client fails after a key was signed in for, that key is revoked before
 * the error is thrown. `JSON.stringify` and `util.inspect` of the client show its wallet
 * address, never a credential.
 *
 * @param options - The `signer` (required), the `wallet` to trade from, `credentials` to
 *   reuse, the credential `store`, and the options of {@link createPublicClient}.
 * @throws {CreateSecureClientError} `invalid_input` for a missing `signer`, a key that is not
 *   an option or an option of the wrong type (the message never repeats a value);
 *   `wallet_not_owned` for a `wallet` the signer does not own; `credentials_not_owned` for
 *   `credentials` that are not the wallet's (nothing is stored or revoked then);
 *   `direct_rail_eoa_only` for
 *   `rail: 'direct'` with a smart wallet; `sponsor_not_configured` for `rail: 'sponsored'`, or an
 *   undeployed smart wallet, on an environment without a sponsor;
 *   `smart_wallet_address_unavailable` when the chain cannot be read; the errors of deploying an
 *   undeployed smart wallet: a `chain_read_failed` `XoError` and the signer's `SigningError`
 *   before it is sent, the sponsor's refusals (`mayHaveLanded: false`), a
 *   `TransactionFailedError` `tx_reverted` when it was mined and reverted, and a
 *   `TransactionFailedError` with `mayHaveLanded: true` and the `transactionHash` (or, when the
 *   sponsor's answer was lost, the executor `nonce`) when its outcome is unknown: check it
 *   before you create the client again; and the errors of signing in: the signer's
 *   (`SigningError`), a refusal (`api_key_limit_reached` when the account has 10 active keys)
 *   and the request errors.
 * @example
 * const client = await createSecureClient({ signer: privateKey(process.env.XO_PK as string) });
 * console.log(client.wallet, await client.fetchTradingState());
 */
export async function createSecureClient(
  options: SecureClientOptions,
): Promise<SecureClient> {
  // Every option is checked before anything is read, signed or sent.
  const o = closedObject(options, 'options', OPTION_KEYS);
  if (o.signer === undefined) {
    throw new UserInputError(NO_SIGNER);
  }
  const env = readEnvironment(o.environment);
  const fetchImpl = optionalFunction<typeof fetch>(o.fetch, 'fetch');
  const WebSocketImpl = optionalFunction<typeof WebSocket>(
    o.WebSocket,
    'WebSocket',
  );
  const onRateLimit = optionalFunction<(update: RateLimitUpdate) => void>(
    o.onRateLimitUpdate,
    'onRateLimitUpdate',
  );
  const rail = readRail(o.rail);
  const shutdownHooks = readBoolean(o.shutdownHooks, 'shutdownHooks', true);
  const strict = readBoolean(o.strictResponses, 'strictResponses', false);
  if (o.label !== undefined) {
    checkLabel(o.label);
  }
  const label = o.label as string | undefined;
  const given =
    o.credentials === undefined
      ? {}
      : closedObject(o.credentials, 'credentials', ['backend', 'orderbook']);
  if (given.backend !== undefined) {
    closedObject(given.backend, 'credentials.backend', [
      'apiKey',
      'id',
      'expiresAt',
    ]);
  }
  if (given.orderbook !== undefined) {
    closedObject(given.orderbook, 'credentials.orderbook', [
      'apiKey',
      'secret',
      'passphrase',
    ]);
  }
  readProvided(given);
  const provided = given as WalletCredentials;
  const store = readStore(o.store);
  if (o.wallet !== undefined && typeof o.wallet !== 'string') {
    throw new UserInputError(
      "wallet must be a 0x address: the signer's own, or one of its smart wallets",
    );
  }
  if (rail === 'sponsored' && env.sponsorUrl === undefined) {
    throw new UserInputError(
      `rail: 'sponsored' needs a sponsor, and the ${env.name} environment has none: add a sponsorUrl to the environment, or use rail: 'direct' with a plain wallet that pays its own gas`,
      { code: 'sponsor_not_configured', service: 'sponsor' },
    );
  }

  // The signer is converted once; every engine signs with the same object.
  const signer = await toInternalSigner(o.signer as Signer);
  const chain = clientSeams().chain ?? createChainReader(env);
  // Only the chain is read here: a wallet the signer does not own is refused before any
  // request to XO and before any signature.
  const walletInput = await resolveWalletAddress(
    signer.address,
    o.wallet as string | undefined,
    env,
    (call) => chain.readContract(call),
  );
  if (rail === 'direct' && walletInput.type === 'smart_wallet') {
    throw new UserInputError(
      "rail 'direct' sends from the signer's own address only: a smart wallet needs the default rail, so leave the rail option out",
      { code: 'direct_rail_eoa_only' },
    );
  }
  const expected =
    walletInput.type === 'eoa'
      ? signer.address
      : normalizeAddress(o.wallet as string);

  const { transport, clock, session } = createCore({
    env,
    signer,
    wallet: walletInput,
    store,
    provided,
    label,
    strictResponses: strict,
    fetch: fetchImpl,
    onRateLimit,
    chain,
    authTimeoutMs: AUTH_TIMEOUT_MS,
  });
  const orderbook = new OrderbookClient({
    transport,
    session,
    env,
    chain,
    strictResponses: strict,
  });
  const data = new DataClient({ transport, session, strictResponses: strict });

  let phase: Phase = 'open';
  const assertOpen = (): void => {
    if (phase !== 'open') {
      throw closedError(phase);
    }
  };
  // The session is the one place the identity is resolved; a closed client reads and sends
  // nothing.
  const identityOf = async (): Promise<TradingIdentity> => {
    assertOpen();
    try {
      return await session.identity();
    } catch (error) {
      throw error instanceof XoError ? withLanded(error, false) : error;
    }
  };
  const account = new AccountClient({
    env,
    identity: identityOf,
    signer,
    rail: new SessionRail({
      kind: rail ?? 'auto',
      env,
      identity: identityOf,
      isOpen: () => phase === 'open',
      signer,
      chain,
      transport,
    }),
    chain,
    orderbook,
    data,
  });
  const bridge = new BridgeClient({
    env,
    transport,
    session,
    identity: identityOf,
    signer,
    chain,
    account,
    strictResponses: strict,
  });

  // The live subscriptions of the client: closed with it.
  const realtime = new RealtimeHub({
    env,
    orderbook,
    session,
    ...(WebSocketImpl === undefined ? {} : { WebSocket: WebSocketImpl }),
    strict,
    ...clientSeams().realtime,
  });
  const closeSubscriptions = (): Promise<void> => realtime.handles.closeAll();

  // The process's hooks revoke a 1-day key this client signs in for. A key from a persistent
  // store, or one given in `credentials`, is never revoked by them.
  const mintsShortLived =
    provided.backend === undefined && store?.persistent !== true;
  let closing: Promise<void> | undefined;
  let ending: Promise<PublicClient> | undefined;
  let releaseSignals: () => void = () => {};
  let releaseExit: () => void = () => {};
  /** Lets go of the process's hooks. Idempotent. */
  const release = (): void => {
    releaseSignals();
    releaseExit();
  };
  /** Stops what runs and refuses what is new: the first step of both ways to end. */
  const stopWork = (): void => {
    orderbook.refuseNewOrders();
    orderbook.stopHeartbeat();
  };

  const close = (): Promise<void> => {
    if (closing !== undefined) {
      return closing;
    }
    phase = 'closed';
    closing = (async () => {
      try {
        stopWork();
        // The subscriptions and the session close together, so a socket slow to close does
        // not hold up the revoke of a short-lived key.
        await Promise.allSettled([closeSubscriptions(), session.close()]);
      } finally {
        release();
      }
    })();
    return closing;
  };

  const endAuthentication = (): Promise<PublicClient> => {
    if (ending !== undefined) {
      return ending;
    }
    if (phase !== 'open') {
      return Promise.reject(closedError(phase));
    }
    phase = 'signed_out';
    ending = (async () => {
      try {
        stopWork();
        const [, signedOut] = await Promise.allSettled([
          closeSubscriptions(),
          session.signOut(),
        ]);
        if (signedOut.status === 'rejected') {
          throw signedOut.reason;
        }
        return createPublicClient({
          environment: env,
          ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
          ...(WebSocketImpl === undefined ? {} : { WebSocket: WebSocketImpl }),
          ...(onRateLimit === undefined
            ? {}
            : { onRateLimitUpdate: onRateLimit }),
        });
      } finally {
        release();
      }
    })();
    // close() afterwards resolves when the sign-out is done, and never rejects.
    closing = ending.then(
      () => undefined,
      () => undefined,
    );
    return ending;
  };

  if (shutdownHooks && mintsShortLived) {
    releaseSignals = holdShutdownHooks(close);
    releaseExit = holdExitHook(close);
  }

  // Sign in now, so the client is ready to trade when it resolves.
  let identity: TradingIdentity;
  try {
    // Best effort: a failed sync leaves the offset at 0, and the session syncs again to sign in.
    await clock.sync().catch(() => undefined);
    identity = await session.identity();
    if (!isSameAddress(identity.address, expected)) {
      throw new UserInputError(
        'wallet resolved to another address than the one given: check the smart wallet contracts of a custom environment',
        { code: 'wallet_not_owned' },
      );
    }
    // Given credentials must be this wallet's before anything uses, stores or revokes them.
    await session.checkProvidedCredentials();
    // The order book checks a smart wallet's signatures on chain: one that is not deployed is
    // deployed first, by the trading setup's one transaction, sent once.
    if (identity.type === 'smart_wallet') {
      await deployUndeployed(account);
    }
    await session.login();
  } catch (error) {
    // A key signed in for meanwhile is revoked (or kept in a persistent store) before the
    // error reaches the caller. The hooks are held until then, so a signal meanwhile still
    // waits for the revoke.
    phase = 'closed';
    try {
      await session.close();
    } catch {
      // close() reports a failed revoke itself; the sign-in error is what the caller sees.
    } finally {
      release();
    }
    throw error;
  }

  const ctx: ActionContext = {
    env,
    orderbook,
    data,
    chain,
    clock,
    strict,
    realtime,
    secure: { session, signer, identity, account, bridge, assertOpen },
  };

  const json = (): Record<string, unknown> => {
    const state = session.toJSON();
    return {
      environment: env.name,
      wallet: identity.address,
      walletType: identity.type,
      rail: rail ?? 'sponsored',
      credentials: state.credentials,
      state: phase,
    };
  };

  const client = {
    ...guardedActions(allActions, ctx, assertOpen, IMMEDIATE),
    wallet: identity.address,
    subscribe: <const S extends readonly SubscriptionSpec[]>(
      specs: S & ExactSpecs<S>,
    ) => subscriptions.secureSubscribe<S>(ctx, specs),
    closeSubscriptions: () => subscriptions.closeSubscriptions(ctx),
    endAuthentication,
    close,
    rotateCredentials: async (): Promise<void> => {
      assertOpen();
      await session.rotateBackend();
    },
    exportCredentials: async (): Promise<Required<WalletCredentials>> => {
      assertOpen();
      return session.exportCredentials();
    },
  };
  // Not enumerable: `JSON.stringify` and `util.inspect` show these, and nothing else of the
  // client's state. No credential is in them.
  Object.defineProperty(client, 'toJSON', { value: json });
  Object.defineProperty(client, Symbol.for('nodejs.util.inspect.custom'), {
    value: json,
  });
  return Object.freeze(brandClient(client, 'secure')) as SecureClient;
}
