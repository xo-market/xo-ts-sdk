import { UserInputError } from '../core/errors';
import type { Paginator } from '../core/paginate';
import type { CallOptions } from '../core/requestOptions';
import {
  type PulseMarket,
  PulseMarketSchema,
  PulseMarketsPageSchema,
  PulseMarketsSchema,
} from './catalogSchemas';
import type { DataDeps } from './internal';
import { paged, singlePage } from './pages';
import {
  PULSE_MAX_PAGE,
  type PulseListParams,
  pulseKeySegment,
  pulseListQuery,
} from './params';

/** The most keys one batch call takes: an SDK guard, the backend has no limit. */
const MAX_BATCH = 100;

/** The pulse markets (recurring TWAP markets), proxied from the perpetual-markets service. */
export class PulseApi {
  /** @internal Made by `DataClient`, which owns the transport and the session. */
  constructor(private readonly deps: DataDeps) {}

  /**
   * Pulse markets (`GET /pulse/markets`), newest first. Use `status: 'ACTIVE'` for the
   * running ones and `'RESOLVED'` or `'CLOSED'` for past ones. The route pages by
   * `page`/`limit`; `Page.raw` carries its `{ page, limit, total, totalPages, ... }` meta.
   *
   * @throws {UserInputError} At once, for an unknown param or a bad value (`limit` is 1
   *   to 100).
   */
  list(params?: PulseListParams, call?: CallOptions): Paginator<PulseMarket> {
    return paged(
      this.deps,
      'pulse.list',
      PulseMarketsPageSchema,
      pulseListQuery(params),
      { ceiling: PULSE_MAX_PAGE, call },
    );
  }

  /**
   * Several pulse markets by address or condition id in one request
   * (`GET /pulse/markets/batch?addresses=`). One page. The service answers a market once
   * per key it is known by, so its answer can repeat a market. The items list each market
   * once (by `id`); `Page.raw` is the answer as the client parsed it, repeats included.
   * An empty list asks nothing.
   *
   * At most 100 keys per call is the SDK's own guard (the backend takes any number, but they
   * travel in the URL). Call it again for more.
   *
   * @throws {UserInputError} At once, when `addresses` is not an array of at most 100
   *   addresses (`0x` and 40 hex digits) or condition ids (`0x` and 64).
   */
  batch(
    addresses: readonly string[],
    call?: CallOptions,
  ): Paginator<PulseMarket> {
    if (!Array.isArray(addresses) || addresses.length > MAX_BATCH) {
      throw new UserInputError(
        `pulse.batch: addresses must be an array of at most ${MAX_BATCH} addresses (an SDK limit: call it again for more)`,
      );
    }
    const keys = Array.from(addresses as readonly unknown[], (address, index) =>
      pulseKeySegment(address, `addresses[${index}]`),
    );
    if (keys.length === 0) {
      return singlePage(
        async () => [] as PulseMarket[],
        (raw) => raw,
      );
    }
    const query = { addresses: keys.join(',') };
    return singlePage(
      () => this.deps.get('pulse.batch', PulseMarketsSchema, { query, call }),
      (raw) => {
        const seen = new Set<number>();
        return raw.filter((market) => {
          if (seen.has(market.id)) {
            return false;
          }
          seen.add(market.id);
          return true;
        });
      },
    );
  }

  /**
   * One pulse market by its on-chain address or condition id
   * (`GET /pulse/markets/:address`).
   *
   * @throws {RequestRejectedError} Status 404, when there is no such market.
   */
  async get(address: string, call?: CallOptions): Promise<PulseMarket> {
    return this.deps.get('pulse.get', PulseMarketSchema, {
      params: { address: pulseKeySegment(address) },
      call,
    });
  }
}
