import type { CallOptions } from '../core/requestOptions';
import {
  type PnlSummaryParams,
  pnlSummaryQuery,
  positionIdSegment,
} from './accountParams';
import type { DataDeps } from './internal';
import { marketIdSegment } from './params';
import {
  type PnlMarket,
  PnlMarketSchema,
  type PnlPositionResult,
  PnlPositionResultSchema,
  type PnlSummary,
  PnlSummarySchema,
} from './portfolioSchemas';

/**
 * The account's profit and loss (`/user/pnl`, singular), calculated by the backend from the
 * indexer's positions and the live prices. All three routes are `shared` (`account:read`):
 * they are sent with the session's backend key, and fail at once with an `AuthRequiredError`
 * when the session has neither a signer nor a key.
 */
export class PnlApi {
  /** @internal Made by `DataClient`, which owns the transport and the session. */
  constructor(private readonly deps: DataDeps) {}

  /**
   * The PnL of every position that matches the filter, with the totals (`GET /user/pnl`).
   * `marketScope` defaults to `'withPulse'`, every position, so nothing the account holds is
   * left out. The backend alone would answer `'default'`, standard (type 0), CLOB (2)
   * and conviction (4) markets, and leave out the pulse rounds.
   *
   * @throws {UserInputError} For an unknown param or a bad value.
   */
  async summary(
    params?: PnlSummaryParams,
    call?: CallOptions,
  ): Promise<PnlSummary> {
    return this.deps.get('pnl.summary', PnlSummarySchema, {
      query: pnlSummaryQuery(params),
      call,
    });
  }

  /**
   * The PnL of the account's positions in one market (`GET /user/pnl/market/:marketId`),
   * by the market's database id.
   *
   * @throws {RequestRejectedError} Status 404, when there is no such market, or the account has no position
   *   in it.
   */
  async market(
    marketId: number | string,
    call?: CallOptions,
  ): Promise<PnlMarket> {
    return this.deps.get('pnl.market', PnlMarketSchema, {
      params: { marketId: marketIdSegment(marketId, 'marketId') },
      call,
    });
  }

  /**
   * The PnL of one position (`GET /user/pnl/position/:positionId`), by the position's id
   * (the `id` of a portfolio position).
   *
   * @throws {RequestRejectedError} Status 404, when the position does not exist or is not the account's.
   */
  async position(
    positionId: number | string,
    call?: CallOptions,
  ): Promise<PnlPositionResult> {
    return this.deps.get('pnl.position', PnlPositionResultSchema, {
      params: { positionId: positionIdSegment(positionId) },
      call,
    });
  }
}
