import type { Session } from '../auth/session';
import { UserInputError } from '../core/errors';
import type { Transport } from '../core/transport';
import { closedObject } from '../orderbook/internal';
import { AccountApi, ProfilesApi } from './account';
import { ActivityApi } from './activity';
import { coverage, type DataCoverage } from './coverage';
import { EventsApi, SeriesApi } from './events';
import { createDeps } from './internal';
import { MarketsApi } from './markets';
import { PnlApi } from './pnl';
import { PortfolioApi } from './portfolio';
import { PulseApi } from './pulse';
import { RewardsApi } from './rewards';
import { TaxonomyApi } from './taxonomy';

export type { AccountProfile, ApiKeyInfo } from './accountSchemas';

export type {
  MarketActivity,
  UserActivity,
  UserMarketActivity,
} from './activitySchemas';

export type {
  OpenOrder,
  PortfolioMarket,
  PortfolioPosition,
  PortfolioValue,
} from './portfolioSchemas';

export type {
  EarningPool,
  EarningPoolCp,
  EarningPoolUsdc,
  RewardAmount,
  RewardsGroup,
  RewardsGroupDay,
  RewardsGroupDetail,
  RewardsGroupHistory,
  RewardsGroupHistoryLine,
  RewardsGroupHistoryTotals,
  RewardsLeaderboardRow,
  RewardsMaker,
  RewardsMakerOrder,
  RewardsMarket,
  RewardsMarketConfig,
  RewardsMarketDay,
  RewardsMarketEpoch,
  RewardsMarketOrder,
  RewardsUsdcMaker,
  RewardsUser,
  RewardsWalletEpoch,
  RewardsWalletSummary,
} from './rewardsSchemas';
export type { Market } from './schemas';

/**
 * The options of {@link DataClient}: a `transport` (with the session installed, for the
 * account's own routes) and its `session`, as a client builds it.
 */
export interface DataClientOptions {
  /**
   * The transport of the SDK. The `shared` routes (`markets.tradingStatus()`, the
   * `portfolio`, `pnl`, `activity` and `account` namespaces, and the `rewards` methods that
   * start with `my`, plus `rewards.leaderboard()`) are sent with its auth provider:
   * install the session on it (`transport.setAuth(session)`) as for the orderbook client. The
   * `public` routes are sent without credentials whatever the transport holds.
   */
  transport: Transport;
  /**
   * The session. The `shared` routes read it: with neither a signer nor a backend key they
   * fail at once with an `AuthRequiredError`, before any request. The public routes do not
   * read it.
   */
  session?: Session;
  /**
   * Reject response fields the schemas do not know (for contract tests). Two answers stay
   * loose whatever this says: `rewards.myGroup()` and `rewards.myGroupHistory()` are the rewards
   * service's answers that the backend passes through untouched and owns no type for, so only the
   * fields the schemas name are checked and the rest is kept as sent.
   */
  strictResponses?: boolean;
}

/** Every option of {@link DataClientOptions}: any other key is refused. */
const OPTION_KEYS = ['transport', 'session', 'strictResponses'] as const;

/** The transport passed in, after a check of the options' keys. */
function readTransport(o: DataClientOptions): Transport {
  if (typeof o !== 'object' || o === null) {
    throw new UserInputError('options must be an object');
  }
  // An unknown key (a misplaced `credentials`, say) would otherwise be dropped without a word.
  closedObject(o, 'options', OPTION_KEYS);
  return o.transport;
}

/**
 * The client of the XO backend's read routes (`/api`): markets, events, series, pulse
 * markets and the taxonomy, the account's portfolio, PnL, activity, profile and API keys
 * together with public profiles, and liquidity rewards.
 *
 * Only routes in the backend's `public` or `shared` access class are callable with an `xo_sk`
 * key. Routes that are Privy-only today are not offered;
 * `coverage` lists every route of these areas the client calls or leaves out, and why.
 *
 * **Public and account routes.** The market namespaces and `profiles` are public: they send
 * no credentials. The `portfolio`, `pnl`, `activity` and `account` namespaces are the
 * account's own (`shared`, `account:read`): they are sent with the session's backend key, log
 * in with its signer when it has none, and fail with an `AuthRequiredError` before any
 * request when the session has neither a signer nor a key. `portfolio.ofWallet` is the one
 * public method among them.
 *
 * **Liquidity rewards.** The `rewards` namespace reads what market makers earn: the programmes
 * (`earningPools`, `groups`, `marketConfig`, `market`), a market's or a wallet's days, and the
 * account's own totals (`mySummary`, the first-hour "read today's earnings"). The reads of any
 * wallet and market are public and send no credentials; the ones that start with `my`, and the
 * leaderboard, are the account's own `shared` routes. `rewards.currentEpoch()` is today's UTC-day
 * index.
 *
 * "Today's earnings" is two things in a summary: `.today` is what has **settled** today
 * (`today_credited` for CP, `today_paid` for USDC), and the open day's live accrual is
 * `currentEpoch.effective` / `currentEpoch.estimate` of each rail. The backend rounds every
 * summary figure to 2 decimals, USDC included, so a small accrual reads `"0.00"`; the exact
 * amounts are on `rewards.myMarket()` / `marketWallet()` and in `myOrders().raw.payout_summary`.
 * Summaries are cached for about 60 s (up to 5 min stale). The CP-only `walletEpoch` / `myEpoch`
 * and the leaderboard can answer an empty 200 when the rewards service is down: see their docs.
 *
 * **Lists** are `Paginator`s whatever the backend's shape (`{ data, meta }`, `{ items }`,
 * page/limit, cursors or a bare array): iterate with `for await`, or call `toArray()`,
 * `firstPage()` or `pages()`. The decoded answer of every page stays on `Page.raw`.
 *
 * **Params** are closed objects: an unknown key, or a value outside the backend's ranges, is
 * a `UserInputError` before any request. Where a market list takes a `marketScope`, it
 * defaults to `'onlyClob'`, because legacy LMSR markets cannot trade on the orderbook. That
 * default is for discovery, what a user can trade: the account routes (`portfolio`, `pnl`,
 * `activity`) list what the account holds or did, so they default to `'withPulse'`, which
 * applies no type filter, and a scope you pass wins. Without a scope the backend would leave
 * out the pulse rounds on all of them.
 *
 * **Money-like fields** (prices, sizes, amounts, volumes, PnL, rewards) are decimal
 * strings: a string the backend sends is checked and kept as it is (an exponent form is
 * expanded), and a JSON number is converted exactly. Counts, ids and timestamps stay
 * numbers. Whole-unit values (`"0.57"`, `"1500.00"`) are `DecimalString`s; amounts in the
 * collateral token's raw units (`"570000"`) are `RawUnitsString`s, a brand that keeps them
 * from being used as whole units by accident.
 *
 * Internal: an engine behind the two clients. No entry of the package exports it.
 */
export class DataClient {
  readonly markets: MarketsApi;
  readonly events: EventsApi;
  readonly series: SeriesApi;
  readonly pulse: PulseApi;
  readonly taxonomy: TaxonomyApi;
  /** The account's holdings (`mine`, `value`, `openOrders`…) and public portfolios (`ofWallet`). */
  readonly portfolio: PortfolioApi;
  /** The account's profit and loss. */
  readonly pnl: PnlApi;
  /** The account's trading history and statistics. */
  readonly activity: ActivityApi;
  /** The account's profile and API keys. */
  readonly account: AccountApi;
  /** Liquidity rewards: the programmes, any wallet's earnings, and the account's own. */
  readonly rewards: RewardsApi;
  /** Public profiles by username. */
  readonly profiles: ProfilesApi;
  /** The routes this client covers and the ones it skips, with the reason. */
  readonly coverage: DataCoverage = coverage;

  /**
   * Checks the options and requests nothing.
   * @throws {UserInputError} For options that are not an object, or an unknown option.
   */
  constructor(o: DataClientOptions) {
    const deps = createDeps({
      transport: readTransport(o),
      session: o.session,
      strict: o.strictResponses ?? false,
    });
    this.markets = new MarketsApi(deps);
    this.events = new EventsApi(deps);
    this.series = new SeriesApi(deps);
    this.pulse = new PulseApi(deps);
    this.taxonomy = new TaxonomyApi(deps);
    this.portfolio = new PortfolioApi(deps);
    this.pnl = new PnlApi(deps);
    this.activity = new ActivityApi(deps);
    this.account = new AccountApi(deps);
    this.rewards = new RewardsApi(deps);
    this.profiles = new ProfilesApi(deps);
  }
}
