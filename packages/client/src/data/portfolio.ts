import { type Paginator, pagePaginator } from '../core/paginate';
import type { CallOptions } from '../core/requestOptions';
import type { DualSchema } from '../core/schema';
import {
  type ClaimableMarketsParams,
  claimableMarketsQuery,
  type OpenOrdersParams,
  openOrdersQuery,
  type PortfolioOwner,
  type PortfolioParams,
  type PortfolioValueParams,
  type PublicPortfolioParams,
  portfolioQuery,
  publicPortfolioQuery,
  publicTarget,
  type RedeemableParams,
  redeemableQuery,
  valueQuery,
} from './accountParams';
import type { DataDeps } from './internal';
import { cursorPages, paged } from './pages';
import { MAX_PAGE, type Query } from './params';
import {
  type ClaimableMarket,
  ClaimableMarketsPageSchema,
  type OpenOrder,
  OpenOrdersPageSchema,
  PortfolioDetailPageSchema,
  type PortfolioMarket,
  type PortfolioPosition,
  PortfolioSummaryPageSchema,
  type PortfolioValue,
  PortfolioValueSchema,
  type RedeemablePosition,
  RedeemablePositionsPageSchema,
} from './portfolioSchemas';

/**
 * The paginator of the public portfolio. The route has been seen to answer the first page
 * whatever `page` says (the answer's `meta.page` still echoes the request, and `hasNextPage`
 * stays true). Read as
 * pages, that would return the first page again and again; a page that repeats the one
 * before it ends the traversal instead, with no items, and `Page.raw` still holds what the
 * backend answered. Once the backend pages properly the guard never triggers.
 *
 * The check is deliberately blunt: a page whose ids equal the page just before it ends the
 * traversal. With a real, working backend that can only happen when the listing changes
 * between two requests and shifts a page's rows onto the next (with `take: 1`, one new
 * market ahead of the first makes page 2 equal page 1). That early stop is accepted: it is
 * rare, no row is returned twice, and the caller can start the traversal again.
 */
function publicPages<T extends { id: number }>(
  deps: DataDeps,
  schema: DualSchema<{ data: T[]; meta: { hasNextPage: boolean } }>,
  query: Query,
  call: CallOptions | undefined,
): Paginator<T> {
  const first = typeof query.page === 'number' ? query.page : 1;
  // The ids of the page read last, to compare the next page with it.
  let previous: { page: number; ids: string } | undefined;
  return pagePaginator<T>(async (page) => {
    const raw = await deps.get('portfolio.ofWallet', schema, {
      query: { ...query, page },
      call,
    });
    const ids = raw.data.map((row) => row.id).join(',');
    if (page === first) {
      previous = undefined;
    }
    const repeated =
      raw.data.length > 0 &&
      previous?.page === page - 1 &&
      previous.ids === ids;
    previous = { page, ids };
    return {
      items: repeated ? [] : raw.data,
      hasNext: raw.meta.hasNextPage && !repeated && page < MAX_PAGE,
      raw,
    };
  }, first);
}

/** The params `P` of `portfolio.mine` or `ofWallet` with `marketId` set: one market's positions. */
export type PortfolioDetailParams<P extends { marketId?: number }> = P & {
  marketId: number;
};
/** The params `P` of `portfolio.mine` or `ofWallet` without `marketId`: one row per market. */
export type PortfolioSummaryParams<P extends { marketId?: number }> = Omit<
  P,
  'marketId'
> & {
  marketId?: undefined;
};

/**
 * The account's holdings: its positions, their value, the winnings to claim and its open
 * orders (`mine`, `value`, `redeemable`, `claimableMarkets`, `openOrders`), and the public
 * portfolio of any user (`ofWallet`).
 *
 * Every `mine` method is a `shared` route: it is sent with the session's backend key (the
 * session logs in with its signer when it has no key yet) and fails at once with an
 * `AuthRequiredError`, before any request, when the session has neither a signer nor a key.
 * `ofWallet` is public and sends no credentials.
 *
 * The list methods return a lazy `Paginator`.
 *
 * **Holdings are never hidden by default.** Unlike the market lists, which default to
 * `'onlyClob'`, these routes default `marketScope` to `'withPulse'`, which applies no type
 * filter: every position, claimable market and redeemable position is listed whatever its
 * market type, pulse rounds included. A scope you pass wins. The backend alone would answer
 * `'default'` for these routes: standard (type 0), CLOB (2) and conviction (4) markets, with
 * the pulse rounds (types 1 and 3) left out.
 */
export class PortfolioApi {
  /** @internal Made by `DataClient`, which owns the transport and the session. */
  constructor(private readonly deps: DataDeps) {}

  /**
   * The account's positions (`GET /users/me/portfolio`, `account:read`). The call has two
   * modes, picked by `marketId`:
   *
   * - **Summary** (the default): one {@link PortfolioMarket} per market, with the account's
   *   positions in it and the totals. `contractMarketId` filters it to one legacy market.
   * - **Detail** (`marketId` set): the flat {@link PortfolioPosition} rows of that market.
   *
   * `marketScope` defaults to `'withPulse'`, every position (the backend alone would leave out
   * the pulse rounds). The backend does not cache a pulse-including scope, so the default
   * summary is always live; a narrower scope (`'default'`, `'onlyClob'`…) is cached for 30 s,
   * and `refresh: true` bypasses that after a trade.
   *
   * @throws {UserInputError} At once, for an unknown param or a value outside the DTO's
   *   ranges (`take` is 1 to 1000, `page` 1 to 10000).
   * @throws {AuthRequiredError} When the session has neither a signer nor a key, before any
   *   request.
   * @throws {RequestRejectedError} Status 404, when the market in `marketId` or `contractMarketId` is unknown.
   */
  mine(
    params: PortfolioDetailParams<PortfolioParams>,
    call?: CallOptions,
  ): Paginator<PortfolioPosition>;
  mine(
    params?: PortfolioSummaryParams<PortfolioParams>,
    call?: CallOptions,
  ): Paginator<PortfolioMarket>;
  mine(
    params?: PortfolioParams,
    call?: CallOptions,
  ): Paginator<PortfolioMarket | PortfolioPosition>;
  mine(
    params?: PortfolioParams,
    call?: CallOptions,
  ): Paginator<PortfolioMarket | PortfolioPosition> {
    const { query, detail } = portfolioQuery(params);
    return detail
      ? paged(this.deps, 'portfolio.mine', PortfolioDetailPageSchema, query, {
          call,
        })
      : paged(this.deps, 'portfolio.mine', PortfolioSummaryPageSchema, query, {
          call,
        });
  }

  /**
   * The account-wide cash and portfolio figures (`GET /users/me/portfolio-value`,
   * `account:read`): spendable USDC, the value of the open positions, the winnings not yet
   * redeemed and their sum. Unlike the lists it applies no market-type filter: pulse and
   * conviction positions are in the total. The backend caches it for 15 s per account;
   * `refresh: true` bypasses that.
   */
  async value(
    params?: PortfolioValueParams,
    call?: CallOptions,
  ): Promise<PortfolioValue> {
    return this.deps.get('portfolio.value', PortfolioValueSchema, {
      query: valueQuery(params),
      call,
    });
  }

  /**
   * The positions the account can redeem (`GET /users/me/redeemable-positions`,
   * `account:read`), as a trader (the default) or, with `role: 'creator'`, as a market
   * creator. `marketScope` defaults to `'withPulse'`, so every redeemable position is listed,
   * pulse rounds included (the backend alone would leave them out).
   */
  redeemable(
    params?: RedeemableParams,
    call?: CallOptions,
  ): Paginator<RedeemablePosition> {
    return paged(
      this.deps,
      'portfolio.redeemable',
      RedeemablePositionsPageSchema,
      redeemableQuery(params),
      { call },
    );
  }

  /**
   * The markets in which the account has winnings to claim
   * (`GET /users/me/claimable-markets`, `account:read`). `marketScope` defaults to
   * `'withPulse'`, so every market with winnings is listed, pulse rounds included (the
   * backend alone would leave them out).
   */
  claimableMarkets(
    params?: ClaimableMarketsParams,
    call?: CallOptions,
  ): Paginator<ClaimableMarket> {
    return paged(
      this.deps,
      'portfolio.claimableMarkets',
      ClaimableMarketsPageSchema,
      claimableMarketsQuery(params),
      { call },
    );
  }

  /**
   * The account's maker orders across every market (`GET /users/me/open-orders`,
   * `account:read`), proxied from the orderbook's aggregator: resting, partial and filled
   * unless `status` narrows it. The route pages by cursor, and the paginator follows the
   * answer's `nextCursor` until it is `null`; `Page.raw` carries the answer whole (the
   * wallet, the echoed query and the cursor). Cancelling an order is the orderbook client's.
   *
   * @throws {UserInputError} At once, for an unknown param or a value outside the ranges
   *   (`limit` is 1 to 200). The cursor is not a param.
   */
  openOrders(
    params?: OpenOrdersParams,
    call?: CallOptions,
  ): Paginator<OpenOrder> {
    const query = openOrdersQuery(params);
    return cursorPages(
      (cursor) =>
        this.deps.get('portfolio.openOrders', OpenOrdersPageSchema, {
          query: { ...query, cursor },
          call,
        }),
      (raw) => raw.orders,
    );
  }

  /**
   * The public portfolio of a user (`GET /users/portfolio`), by wallet address or by
   * username. No credentials are sent. A private profile answers an empty list. The
   * backend's route names its param `user`; the SDK takes `{ wallet }` or `{ username }`
   * and sends it there. The params and the two modes are those of {@link mine} (including the `'withPulse'`
   * default), minus `refresh` and `claimableFirst`, which the public route does not act on.
   *
   * **Paging.** The backend may ignore `page` on this route and answer the first page of the
   * listing every time. The paginator therefore stops at the first page that repeats the one
   * before it instead of returning rows twice; to read beyond one page raise `take` (up to
   * 1000).
   *
   * @throws {UserInputError} At once, when `owner` is not exactly one valid wallet or
   *   username, or for a bad param.
   * @throws {RequestRejectedError} Status 404, when there is no such user.
   */
  ofWallet(
    owner: PortfolioOwner,
    params: PortfolioDetailParams<PublicPortfolioParams>,
    call?: CallOptions,
  ): Paginator<PortfolioPosition>;
  ofWallet(
    owner: PortfolioOwner,
    params?: PortfolioSummaryParams<PublicPortfolioParams>,
    call?: CallOptions,
  ): Paginator<PortfolioMarket>;
  ofWallet(
    owner: PortfolioOwner,
    params?: PublicPortfolioParams,
    call?: CallOptions,
  ): Paginator<PortfolioMarket | PortfolioPosition>;
  ofWallet(
    owner: PortfolioOwner,
    params?: PublicPortfolioParams,
    call?: CallOptions,
  ): Paginator<PortfolioMarket | PortfolioPosition> {
    const { user } = publicTarget(owner);
    const { query, detail } = publicPortfolioQuery(params);
    const withUser = { ...query, user };
    return detail
      ? publicPages(this.deps, PortfolioDetailPageSchema, withUser, call)
      : publicPages(this.deps, PortfolioSummaryPageSchema, withUser, call);
  }
}
