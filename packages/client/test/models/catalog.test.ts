import { getAddress } from 'viem';
import { describe, expect, test } from 'vitest';
import {
  CategoriesSchema,
  SubcategoriesSchema,
} from '../../src/data/catalogSchemas';
import { TokensSchema } from '../../src/data/schemas';
import {
  toCategory,
  toCollateralToken,
  toSubcategory,
} from '../../src/models/catalog';
import { tokenFixture } from '../helpers/mockBackendData';
import { wireStyleKeys } from '../helpers/modelKeys';

const TS = '2026-10-01T12:00:00.000Z';

function category(patch: Record<string, unknown> = {}) {
  const [row] = CategoriesSchema.lenient.parse([
    {
      id: 7,
      createdAt: TS,
      updatedAt: TS,
      name: 'Sports',
      description: null,
      isActive: true,
      marketsCount: 12,
      ...patch,
    },
  ]);
  if (row === undefined) {
    throw new Error('no row');
  }
  return row;
}

function subcategory(patch: Record<string, unknown> = {}) {
  const [row] = SubcategoriesSchema.lenient.parse([
    {
      id: 21,
      createdAt: TS,
      updatedAt: TS,
      name: 'Football',
      slug: 'football',
      description: 'Matches',
      isActive: true,
      categoryId: 7,
      parentSubcategoryId: null,
      depth: 1,
      marketsCount: 9,
      ...patch,
    },
  ]);
  if (row === undefined) {
    throw new Error('no row');
  }
  return row;
}

describe('toCategory', () => {
  test('maps a category: the id is text and the count is named for what it counts', () => {
    expect(toCategory(category())).toEqual({
      id: '7',
      name: 'Sports',
      description: null,
      active: true,
      marketCount: 12,
    });
  });

  test('a category without a count has a null count, not zero', () => {
    const { marketsCount: _drop, ...bare } = {
      id: 7,
      createdAt: TS,
      updatedAt: TS,
      name: 'Sports',
      description: 'All sports',
      isActive: false,
    } as Record<string, unknown>;
    const [row] = CategoriesSchema.lenient.parse([bare]);
    if (row === undefined) {
      throw new Error('no row');
    }
    expect(toCategory(row)).toEqual({
      id: '7',
      name: 'Sports',
      description: 'All sports',
      active: false,
      marketCount: null,
    });
  });

  test('an unknown key of the answer stays out of the model', () => {
    const model = toCategory(category({ wire_extra: 1, wireExtra: 2 }));
    expect(Object.keys(model).sort()).toEqual([
      'active',
      'description',
      'id',
      'marketCount',
      'name',
    ]);
  });
});

describe('toSubcategory', () => {
  test('maps a subcategory: ids are text, a top-level node has no parent and no children', () => {
    expect(toSubcategory(subcategory())).toEqual({
      id: '21',
      categoryId: '7',
      parentId: null,
      name: 'Football',
      slug: 'football',
      description: 'Matches',
      active: true,
      marketCount: 9,
      children: [],
    });
  });

  test('maps the nested nodes with their parent', () => {
    const child = {
      id: 22,
      createdAt: TS,
      updatedAt: TS,
      name: 'Premier League',
      slug: 'premier-league',
      isActive: true,
      categoryId: 7,
      parentSubcategoryId: 21,
      depth: 2,
      marketsCount: 4,
    };
    const model = toSubcategory(subcategory({ children: [child] }));
    expect(model.children).toEqual([
      {
        id: '22',
        categoryId: '7',
        parentId: '21',
        name: 'Premier League',
        slug: 'premier-league',
        description: null,
        active: true,
        marketCount: 4,
        children: [],
      },
    ]);
  });

  test('no snake_case or ID-suffixed key, and no key of the answer that the model does not name', () => {
    const model = toSubcategory(
      subcategory({
        wire_extra: 1,
        category: {
          id: 7,
          createdAt: TS,
          updatedAt: TS,
          name: 'Sports',
          isActive: true,
        },
      }),
    );
    expect(wireStyleKeys(model)).toEqual([]);
    expect(Object.keys(model).sort()).toEqual([
      'active',
      'categoryId',
      'children',
      'description',
      'id',
      'marketCount',
      'name',
      'parentId',
      'slug',
    ]);
  });
});

describe('toCollateralToken', () => {
  test('maps a token: a checksummed address, no logo is null', () => {
    const [row] = TokensSchema.lenient.parse([
      { ...tokenFixture(), description: null, priceTrackingEnabled: true },
    ]);
    if (row === undefined) {
      throw new Error('no row');
    }
    const token = toCollateralToken(row);
    expect(token).toEqual({
      id: '1',
      symbol: 'USDC',
      name: 'Bridged USDC (Lucid)',
      address: getAddress(`0x${'0f'.repeat(20)}`),
      decimals: 6,
      active: true,
      image: null,
      description: null,
    });
  });

  test('keeps a logo and a description when there are some', () => {
    const [row] = TokensSchema.lenient.parse([
      {
        ...tokenFixture(),
        logoUrl: 'https://cdn.example/usdc.png',
        description: 'A dollar token',
      },
    ]);
    if (row === undefined) {
      throw new Error('no row');
    }
    expect(toCollateralToken(row)).toMatchObject({
      image: 'https://cdn.example/usdc.png',
      description: 'A dollar token',
    });
  });
});
