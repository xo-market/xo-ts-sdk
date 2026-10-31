import type { Paginator } from '../core/paginate';
import type { CallOptions } from '../core/requestOptions';
import {
  CategoriesSchema,
  type Category,
  SubcategoriesPageSchema,
  SubcategoriesSchema,
  type Subcategory,
} from './catalogSchemas';
import type { DataDeps } from './internal';
import { itemsPages, singlePage } from './pages';
import {
  type CategoriesParams,
  categoriesQuery,
  type SubcategoriesParams,
  subcategoriesQuery,
} from './params';
import { type Token, TokensSchema } from './schemas';

/** The market taxonomy (categories, subcategories) and the collateral tokens. */
export class TaxonomyApi {
  /** @internal Made by `DataClient`, which owns the transport and the session. */
  constructor(private readonly deps: DataDeps) {}

  /**
   * The active categories (`GET /categories`), each with its `marketsCount`. One page.
   *
   * A `marketScope` (or `marketType`, `sortBy`, `countScope`) puts the route in its
   * overview mode, which returns every field of the plain list plus the count; this client
   * always uses it, with `marketScope: 'onlyClob'` unless you pass another, so the counts
   * are of the markets that trade on the orderbook.
   *
   * @throws {UserInputError} At once, for an unknown param or value.
   */
  categories(
    params?: CategoriesParams,
    call?: CallOptions,
  ): Paginator<Category> {
    const query = categoriesQuery(params);
    return singlePage(
      () =>
        this.deps.get('taxonomy.categories', CategoriesSchema, {
          query,
          call,
        }),
      (raw) => raw,
    );
  }

  /**
   * The subcategories (`GET /subcategories`). The route has two modes, picked by the params:
   *
   * - **Overview** (the default): a flat list of every active subcategory with its
   *   `marketsCount`, scoped by `marketScope` (default `'onlyClob'`), optionally sorted by
   *   `sortBy: 'marketsCount'` and `sort`. One page.
   * - **Paginated**: give `page`, `take` or `search` and the route pages through the
   *   subcategories (`{ items, total, page, limit, totalPages, hasNext, hasPrev }`, which
   *   `Page.raw` keeps). No `marketScope` is added then, and the overview params cannot
   *   be combined with these.
   *
   * @throws {UserInputError} At once, for an unknown param, a bad value, or a mix of the
   *   two modes' params.
   */
  subcategories(
    params?: SubcategoriesParams,
    call?: CallOptions,
  ): Paginator<Subcategory> {
    const { query, paginated } = subcategoriesQuery(params);
    if (!paginated) {
      return singlePage(
        () =>
          this.deps.get('taxonomy.subcategories', SubcategoriesSchema, {
            query,
            call,
          }),
        (raw) => raw,
      );
    }
    const first = typeof query.page === 'number' ? query.page : 1;
    return itemsPages(first, (page) =>
      this.deps.get('taxonomy.subcategories', SubcategoriesPageSchema, {
        query: { ...query, page },
        call,
      }),
    );
  }

  /** The active collateral tokens (`GET /tokens`). One page. */
  tokens(call?: CallOptions): Paginator<Token> {
    return singlePage(
      () => this.deps.get('taxonomy.tokens', TokensSchema, { call }),
      (raw) => raw,
    );
  }
}
