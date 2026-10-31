import type { Address } from 'viem';
import type {
  Category as RawCategory,
  Subcategory as RawSubcategory,
} from '../data/catalogSchemas';
import type { Token as RawToken } from '../data/schemas';
import { addressOf } from './convert';

// The public models of the market taxonomy and of the tokens that markets are paid in. Ids
// are text, like a market's id.

/** The text, or `null` when it is missing or empty. */
function textOrNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

/** A category that markets are filed under, such as `Sports`. */
export type Category = {
  /** XO's id for the category. */
  id: string;
  /** The category's name. */
  name: string;
  /** What the category covers. */
  description: string | null;
  /** Whether the category is in use. */
  active: boolean;
  /** How many CLOB markets are filed under the category. `null` when XO gave no count. */
  marketCount: number | null;
};

/**
 * Maps a category to the {@link Category} model.
 *
 * @internal
 */
export function toCategory(raw: RawCategory): Category {
  return {
    id: String(raw.id),
    name: raw.name,
    description: textOrNull(raw.description),
    active: raw.isActive,
    marketCount: raw.marketsCount ?? null,
  };
}

/** A node under a category, such as `Football` under `Sports`, with the nodes under it. */
export type Subcategory = {
  /** XO's id for the subcategory. */
  id: string;
  /** The id of the category it belongs to. */
  categoryId: string;
  /** The id of the subcategory it sits under. `null` for a node directly under its category. */
  parentId: string | null;
  /** The subcategory's name. */
  name: string;
  /** The subcategory's URL name. */
  slug: string;
  /** What the subcategory covers. */
  description: string | null;
  /** Whether the subcategory is in use. */
  active: boolean;
  /** How many CLOB markets are filed under it, the nodes under it included. */
  marketCount: number;
  /** The subcategories under this one. Empty when there are none. */
  children: Subcategory[];
};

type RawNode = Omit<RawSubcategory, 'children'> & {
  children?: RawNode[];
};

function subcategoryOf(raw: RawNode): Subcategory {
  return {
    id: String(raw.id),
    categoryId: String(raw.categoryId),
    parentId:
      raw.parentSubcategoryId === undefined || raw.parentSubcategoryId === null
        ? null
        : String(raw.parentSubcategoryId),
    name: raw.name,
    slug: raw.slug,
    description: textOrNull(raw.description),
    active: raw.isActive,
    marketCount: raw.marketsCount,
    children: (raw.children ?? []).map(subcategoryOf),
  };
}

/**
 * Maps a subcategory, and the nodes under it, to the {@link Subcategory} model.
 *
 * @internal
 */
export function toSubcategory(raw: RawSubcategory): Subcategory {
  return subcategoryOf(raw);
}

/** A token that markets are paid in, such as USDC. */
export type CollateralToken = {
  /** XO's id for the token. */
  id: string;
  /** The token's symbol, such as `USDC`. */
  symbol: string;
  /** The token's name. */
  name: string;
  /** The token's contract address. */
  address: Address;
  /** How many decimals the token has: an amount in its smallest unit has this many digits after the point. */
  decimals: number;
  /** Whether markets can be paid in the token. */
  active: boolean;
  /** The token's logo. `null` when XO has none. */
  image: string | null;
  /** What the token is. */
  description: string | null;
};

/**
 * Maps a token to the {@link CollateralToken} model.
 *
 * @internal
 */
export function toCollateralToken(raw: RawToken): CollateralToken {
  return {
    id: String(raw.id),
    symbol: raw.symbol,
    name: raw.name,
    address: addressOf(raw.tokenAddress),
    decimals: raw.decimals,
    active: raw.isActive,
    image: textOrNull(raw.logoUrl),
    description: textOrNull(raw.description),
  };
}
