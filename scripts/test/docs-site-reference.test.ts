import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  type AreaSlug,
  areaOf,
  foldReference,
  type MintlifyGroup,
  sourcesOf,
} from '../docs-site-reference.js';

// The fold of the generated reference (scripts/docs-site-reference.ts): TypeDoc's one page per
// symbol under docs/reference/ becomes a page per class, one page of error classes and a page per
// area of the source. The fixtures are real TypeDoc pages, trimmed (links to pages that are not in
// the fixtures became code spans; resolveMarket.md links Market.md#marketid), and the matching part
// of TypeDoc's JSON output (`typedoc --json`), which says the source file of each symbol.

const FIXTURES = fileURLToPath(
  new URL('./fixtures/reference/', import.meta.url),
);

/** The fixture pages, keyed by their path under docs/reference/ (`client/classes/Clock.md`). */
function readPages(): Map<string, string> {
  const root = join(FIXTURES, 'pages');
  const pages = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else {
        pages.set(
          relative(root, path).split(sep).join('/'),
          readFileSync(path, 'utf8'),
        );
      }
    }
  };
  walk(root);
  return pages;
}

const PAGES = readPages();
const SOURCES = sourcesOf(
  JSON.parse(readFileSync(join(FIXTURES, 'api.json'), 'utf8')),
);

function fold(
  o: { pages?: Map<string, string>; sources?: Map<string, string> } = {},
) {
  return foldReference({
    pages: o.pages ?? PAGES,
    sources: o.sources ?? SOURCES,
  });
}

const NOTE =
  '{/* Generated from xo-market/xo-ts-sdk docs/reference/ by pnpm docs:publish. Edit it there. */}';

/** A page of the fold, or a failure naming it. */
function page(pages: Map<string, string>, key: string): string {
  const mdx = pages.get(key);
  if (mdx === undefined) {
    throw new Error(`no page ${key} (pages: ${[...pages.keys()].join(', ')})`);
  }
  return mdx;
}

/** The `## ` headings outside fenced code, unescaped: the symbols of a fold page. */
function symbolHeadings(mdx: string): string[] {
  const names: string[] = [];
  let fenced = false;
  for (const line of mdx.split('\n')) {
    if (/^(?:```|~~~)/.test(line)) {
      fenced = !fenced;
    } else if (!fenced && line.startsWith('## ')) {
      names.push(line.slice(3).replace(/\\(.)/g, '$1'));
    }
  }
  return names;
}

/** The text of every heading outside fenced code, in order. */
function headingTexts(mdx: string): string[] {
  const texts: string[] = [];
  let fenced = false;
  for (const line of mdx.split('\n')) {
    const heading = /^#{1,6}[ \t]+(.*)$/.exec(line);
    if (/^(?:```|~~~)/.test(line)) {
      fenced = !fenced;
    } else if (!fenced && heading?.[1] !== undefined) {
      texts.push(heading[1]);
    }
  }
  return texts;
}

/** The anchor of a heading, as GitHub makes it: `placeOrder()` is #placeorder. */
const slug = (text: string) =>
  text
    .replace(/\\(.)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');

/** Every page path of the navigation, groups included, in order. */
function navPages(group: MintlifyGroup): string[] {
  return group.pages.flatMap((p) =>
    typeof p === 'string' ? [p] : navPages(p),
  );
}

const isClassPage = (key: string) => key.startsWith('reference/classes/');
const isFoldPage = (key: string) =>
  key !== 'reference/overview' && !isClassPage(key);

describe('typedoc sources', () => {
  test('each symbol of each module, by `<module>/<Name>`, to its file in the repository', () => {
    expect(SOURCES.get('client/Market')).toBe(
      'packages/client/src/data/schemas.ts',
    );
    expect(SOURCES.get('client/signing/hashOrder')).toBe(
      'packages/client/src/signing/order.ts',
    );
    expect(SOURCES.get('client/node/fileStore')).toBe(
      'packages/client/src/auth/fileStore.ts',
    );
    expect(SOURCES.get('client/resolveMarket')).toBe(
      'packages/client/src/markets/resolve.ts',
    );
  });

  test('a re-export has no page of its own, so no source', () => {
    expect(SOURCES.has('client/node/CredentialStore')).toBe(false);
    expect(SOURCES.has('client/signing/OrderHash')).toBe(false);
    expect(SOURCES.size).toBe(16);
  });

  test('not the JSON of TypeDoc: throws', () => {
    expect(() => sourcesOf({ name: 'x' })).toThrow(/modules/);
  });
});

describe('areaOf', () => {
  const cases: [string | undefined, AreaSlug][] = [
    ['packages/client/src/index.ts', 'client'],
    ['packages/client/src/clients/rail.ts', 'client'],
    ['packages/client/src/orderbook/client.ts', 'orders'],
    // The market lookup (resolveMarket, ResolvedMarket) is with the markets.
    ['packages/client/src/markets/resolve.ts', 'markets'],
    ['packages/client/src/data/rewards.ts', 'rewards'],
    ['packages/client/src/data/rewardsSchemas.ts', 'rewards'],
    ['packages/client/src/data/portfolio.ts', 'portfolio'],
    ['packages/client/src/data/pnl.ts', 'portfolio'],
    ['packages/client/src/data/activitySchemas.ts', 'portfolio'],
    ['packages/client/src/data/accountParams.ts', 'portfolio'],
    ['packages/client/src/data/schemas.ts', 'markets'],
    ['packages/client/src/account/client.ts', 'account'],
    ['packages/client/src/wallet/signer.ts', 'account'],
    ['packages/client/src/bridge/client.ts', 'bridge'],
    ['packages/client/src/realtime/orderbookWs.ts', 'realtime'],
    ['packages/client/src/auth/session.ts', 'auth'],
    ['packages/client/src/node.ts', 'auth'],
    ['packages/client/src/signing/order.ts', 'signing'],
    ['packages/client/src/core/errors.ts', 'core'],
    ['packages/client/src/clients/secure.ts', 'client'],
    ['packages/client/src/actions/trading.ts', 'orders'],
    ['packages/client/src/models/orders.ts', 'orders'],
    ['packages/client/src/models/enums.ts', 'orders'],
    ['packages/client/src/actions/rewards.ts', 'rewards'],
    ['packages/client/src/actions/account.ts', 'portfolio'],
    ['packages/client/src/models/account.ts', 'portfolio'],
    ['packages/client/src/actions/marketData.ts', 'markets'],
    ['packages/client/src/models/marketData.ts', 'markets'],
    ['packages/client/src/models/orderBook.ts', 'markets'],
    ['packages/client/src/actions/onchain.ts', 'account'],
    ['packages/client/src/actions/wallets.ts', 'account'],
    ['packages/client/src/viem.ts', 'account'],
    ['packages/client/src/wallet/publicSigner.ts', 'account'],
    ['packages/client/src/actions/bridge.ts', 'bridge'],
    ['packages/client/src/models/bridge.ts', 'bridge'],
    ['packages/client/src/actions/subscriptions.ts', 'realtime'],
    ['packages/client/src/models/realtime.ts', 'realtime'],
    ['packages/client/src/misc.ts', 'other'],
    ['packages/client/src/signing.ts', 'other'],
    ['packages/other/src/core/errors.ts', 'other'],
    [undefined, 'other'],
  ];
  test.each(cases)('%s → %s', (source, area) => {
    expect(areaOf(source)).toBe(area);
  });
});

describe('foldReference', () => {
  test('a page per class, one of error classes, one per area that has symbols', () => {
    expect([...fold().pages.keys()].sort()).toEqual([
      'reference/auth',
      'reference/classes/Clock',
      'reference/classes/OrderbookClient',
      'reference/client',
      'reference/core',
      'reference/errors',
      'reference/markets',
      'reference/orders',
      'reference/overview',
      'reference/signing',
    ]);
  });

  test('every symbol on exactly one page', () => {
    const { pages } = fold();
    const symbols = [...PAGES.keys()].filter((k) => !k.endsWith('README.md'));
    const placed = [...pages].flatMap(([key, mdx]) =>
      isClassPage(key)
        ? [key.slice('reference/classes/'.length)]
        : isFoldPage(key)
          ? symbolHeadings(mdx)
          : [],
    );
    expect(placed).toHaveLength(symbols.length);
    expect(placed.sort()).toEqual(
      symbols.map((k) => k.replace(/^.*\//, '').replace(/\.md$/, '')).sort(),
    );
  });

  test('an area page: functions, interfaces, type aliases, variables, each by name', () => {
    const { pages } = fold();
    expect(symbolHeadings(page(pages, 'reference/markets'))).toEqual([
      'resolveMarket',
      'Market',
      'ResolveDeps',
      'ResolvedMarket',
    ]);
    expect(symbolHeadings(page(pages, 'reference/core'))).toEqual([
      'OrderHash',
      'SDK_VERSION',
    ]);
    expect(symbolHeadings(page(pages, 'reference/errors'))).toEqual([
      'AuthError',
      'XoError',
    ]);
  });

  test('the headings of a folded symbol go one level down', () => {
    const { pages } = fold();
    const markets = page(pages, 'reference/markets');
    expect(markets).not.toMatch(/^# /m);
    expect(markets).toContain('\n### Properties\n');
    expect(markets).toContain('\n#### conditionId?\n');
    expect(markets).toContain('\n##### Returns\n\n`number`'); // ResolveDeps.nowMs
    const errors = page(pages, 'reference/errors');
    expect(errors).toContain('\n### Constructors\n');
    expect(errors).toContain('\n##### Inherited from\n');
    // Code stays as it is.
    expect(page(pages, 'reference/core')).toContain(
      '```ts\nreadonly __brand: "OrderHash";\n```',
    );
  });

  test('a class page is the class as TypeDoc wrote it', () => {
    const { pages } = fold();
    const clock = page(pages, 'reference/classes/Clock');
    expect(clock.startsWith(`---\ntitle: "Clock"\n---\n${NOTE}\n\n`)).toBe(
      true,
    );
    const original = PAGES.get('client/classes/Clock.md') ?? '';
    expect(clock.trimEnd().endsWith(original.trimEnd().slice(-200))).toBe(true);
    expect(clock).toContain('\n## Constructors\n');
    expect(clock).toContain('\n### sync()\n');
    // Its own member anchors stay.
    expect(clock).toContain('[Clock.sync](#sync)');
  });

  test('every page has its title and the generated note', () => {
    const { pages } = fold();
    const titles = new Map([
      ['reference/overview', 'API reference'],
      ['reference/classes/OrderbookClient', 'OrderbookClient'],
      ['reference/errors', 'Error classes'],
      ['reference/client', 'Client and options'],
      ['reference/orders', 'Orders and the orderbook'],
      ['reference/markets', 'Markets and events'],
      ['reference/auth', 'Authentication and credentials'],
      ['reference/signing', 'Signing'],
      ['reference/core', 'Core types'],
    ]);
    for (const [key, title] of titles) {
      expect(
        page(pages, key).startsWith(
          `---\ntitle: ${JSON.stringify(title)}\n---\n${NOTE}\n\n`,
        ),
      ).toBe(true);
    }
  });

  test('member links point at the parent', () => {
    const { pages, resolve } = fold();
    expect(
      resolve('docs/reference/client/interfaces/Market.md', 'marketid'),
    ).toBe('/typescript-sdk/reference/markets#market');
    expect(
      resolve('docs/reference/client/interfaces/Market.md', undefined),
    ).toBe('/typescript-sdk/reference/markets#market');
    expect(page(pages, 'reference/markets')).toContain(
      '[Market](/typescript-sdk/reference/markets#market)',
    );
    // An error class is a symbol of the errors page.
    expect(resolve('docs/reference/client/classes/XoError.md', 'code')).toBe(
      '/typescript-sdk/reference/errors#xoerror',
    );
    expect(page(pages, 'reference/errors')).toContain(
      '[`code`](/typescript-sdk/reference/errors#xoerror)',
    );
    // A member anchor of the same symbol, too.
    expect(page(pages, 'reference/client')).toContain(
      '[XoAuth.login](/typescript-sdk/reference/client#xoauth)',
    );
    // From a page of another module.
    expect(page(pages, 'reference/signing')).toContain(
      '[`OrderHash`](/typescript-sdk/reference/core#orderhash)',
    );
  });

  test('class member anchors survive', () => {
    const { pages, resolve } = fold();
    expect(
      resolve('docs/reference/client/classes/OrderbookClient.md', 'placeorder'),
    ).toBe('/typescript-sdk/reference/classes/OrderbookClient#placeorder');
    expect(
      resolve('docs/reference/client/classes/OrderbookClient.md', undefined),
    ).toBe('/typescript-sdk/reference/classes/OrderbookClient');
    expect(page(pages, 'reference/orders')).toContain(
      '[OrderbookClient.getMarkets](/typescript-sdk/reference/classes/OrderbookClient#getmarkets)',
    );
    expect(page(pages, 'reference/classes/OrderbookClient')).toContain(
      '[OrderbookClient.getMarkets](#getmarkets)',
    );
  });

  test('the module pages lead to the overview; anything else is unknown', () => {
    const { resolve } = fold();
    expect(resolve('docs/reference/README.md', undefined)).toBe(
      '/typescript-sdk/reference/overview',
    );
    expect(
      resolve('docs/reference/client/signing/README.md', 'functions'),
    ).toBe('/typescript-sdk/reference/overview');
    expect(
      resolve('docs/reference/client/interfaces/Nope.md', undefined),
    ).toBeUndefined();
    expect(
      resolve('reference/client/classes/Clock.md', undefined),
    ).toBeUndefined();
    expect(resolve('docs/guides/x.md', undefined)).toBeUndefined();
  });

  test('a link to a page the reference does not have throws, naming both', () => {
    const pages = new Map(PAGES);
    pages.set(
      'client/interfaces/Market.md',
      `${PAGES.get('client/interfaces/Market.md')}\nSee [Nope](Nope.md).\n`,
    );
    expect(() => fold({ pages })).toThrow(
      /client\/interfaces\/Market\.md.*Nope\.md/,
    );
  });

  test('unmatched source goes to other', () => {
    expect(fold().pages.has('reference/other')).toBe(false);
    const sources = new Map(SOURCES);
    sources.set('client/SDK_VERSION', 'packages/client/src/misc/version.ts');
    sources.delete('client/OrderHash');
    const { pages, resolve, nav } = fold({ sources });
    expect(symbolHeadings(page(pages, 'reference/other'))).toEqual([
      'OrderHash',
      'SDK_VERSION',
    ]);
    expect(page(pages, 'reference/other')).toMatch(/^title: "Other"$/m);
    expect(pages.has('reference/core')).toBe(false);
    expect(
      resolve('docs/reference/client/variables/SDK_VERSION.md', undefined),
    ).toBe('/typescript-sdk/reference/other#sdk_version');
    expect(navPages(nav).at(-1)).toBe('typescript-sdk/reference/other');
  });

  test('no duplicate symbol anchor on a page', () => {
    for (const [key, mdx] of fold().pages) {
      if (isFoldPage(key)) {
        const anchors = symbolHeadings(mdx).map((name) => name.toLowerCase());
        expect(new Set(anchors).size, key).toBe(anchors.length);
      }
    }
    // A function `market` next to the interface `Market` would share its anchor: refused.
    const pages = new Map(PAGES);
    pages.set(
      'client/functions/market.md',
      '# Function: market()\n\n```ts\nfunction market(): void;\n```\n',
    );
    const sources = new Map(SOURCES);
    sources.set('client/market', 'packages/client/src/data/markets.ts');
    expect(() => fold({ pages, sources })).toThrow(
      /reference\/markets.*#market.*client\/functions\/market\.md.*client\/interfaces\/Market\.md/,
    );
  });

  test('a type alias and a value of one name share a section: the type, then the value', () => {
    // An error union and its guard, as TypeDoc writes them.
    const pages = new Map(PAGES);
    pages.set(
      'client/type-aliases/FetchThingError.md',
      '# Type Alias: FetchThingError\n\n```ts\ntype FetchThingError = XoError;\n```\n\nThe error union.\n',
    );
    pages.set(
      'client/variables/FetchThingError.md',
      '# Variable: FetchThingError\n\n```ts\nFetchThingError: ErrorGuard<XoError>;\n```\n\nThe guard of FetchThingError.\n',
    );
    const sources = new Map(SOURCES);
    sources.set('client/FetchThingError', 'packages/client/src/core/errors.ts');
    const { pages: out, resolve } = fold({ pages, sources });
    const core = page(out, 'reference/core');
    expect(symbolHeadings(core)).toEqual([
      'FetchThingError',
      'OrderHash',
      'SDK_VERSION',
    ]);
    const section = core.slice(
      core.indexOf('## FetchThingError'),
      core.indexOf('## OrderHash'),
    );
    expect(section.indexOf('type FetchThingError')).toBeLessThan(
      section.indexOf('FetchThingError: ErrorGuard'),
    );
    expect(section).toContain('The guard of FetchThingError.');
    for (const kind of ['type-aliases', 'variables']) {
      expect(
        resolve(`docs/reference/client/${kind}/FetchThingError.md`, undefined),
      ).toBe('/typescript-sdk/reference/core#fetchthingerror');
    }
  });

  test('a member heading never takes the anchor of a symbol of its page', () => {
    // ResolveDeps with a property `market?`, whose heading would also be #market: it names its
    // symbol, so #market stays the interface Market's. Not as `ResolveDeps.market?`, whose
    // anchor #resolvedepsmarket is the one of an interface ResolveDepsMarket (on the real
    // reference: Subcategory.category? and SubcategoryCategory).
    const pages = new Map(PAGES);
    pages.set(
      'client/interfaces/ResolveDeps.md',
      `${PAGES.get('client/interfaces/ResolveDeps.md')}\n***\n\n### market?\n\n\`\`\`ts\noptional market?: Market;\n\`\`\`\n`,
    );
    pages.set(
      'client/interfaces/ResolveDepsMarket.md',
      '# Interface: ResolveDepsMarket\n\nA market of the dependencies.\n',
    );
    const sources = new Map(SOURCES);
    sources.set(
      'client/ResolveDepsMarket',
      'packages/client/src/markets/resolve.ts',
    );
    const markets = page(fold({ pages, sources }).pages, 'reference/markets');
    expect(markets).toContain('\n#### market? (ResolveDeps)\n');
    expect(markets).not.toMatch(/^#### market\?$/m);
    for (const [key, mdx] of [
      ...fold().pages,
      ['reference/markets', markets] as const,
    ]) {
      if (isFoldPage(key)) {
        const symbols = new Set(symbolHeadings(mdx).map(slug));
        const taken = headingTexts(mdx).filter((text) =>
          symbols.has(slug(text)),
        );
        expect(taken.map(slug), key).toEqual([...symbols]);
      }
    }
  });

  test('signing symbols name their import path', () => {
    const { pages } = fold();
    expect(page(pages, 'reference/signing')).toContain(
      '## hashOrder\n\nImport from `@xomarket/client/signing`.\n\n```ts\nfunction hashOrder',
    );
    const auth = page(pages, 'reference/auth');
    expect(auth).toContain(
      '## fileStore\n\nImport from `@xomarket/client/node`.\n',
    );
    // A symbol of the main module needs no such line.
    expect(auth).toContain('## CredentialStore\n\nKeeps credentials');
    expect(page(pages, 'reference/core')).not.toContain('Import from');
  });

  test('every page body goes through escapeProse', () => {
    const pages = new Map(PAGES);
    pages.set(
      'client/interfaces/Market.md',
      '# Interface: Market\n\nKeyed by {id} <here>, as `{ id }` says.\n',
    );
    const markets = page(fold({ pages }).pages, 'reference/markets');
    expect(markets).toContain('Keyed by \\{id\\} &lt;here>, as `{ id }` says.');
  });

  test('the overview: the entry points, then a link to every page', () => {
    const { pages } = fold();
    const overview = page(pages, 'reference/overview');
    expect(overview).toContain(
      '`@xomarket/client/signing`: the pure signing kit, for advanced use.',
    );
    expect(overview).toContain(
      '`@xomarket/client/node`: what needs a Node builtin',
    );
    for (const key of pages.keys()) {
      if (key !== 'reference/overview') {
        expect(overview, key).toContain(`](/typescript-sdk/${key})`);
      }
    }
  });

  test('nav lists every page once', () => {
    const { pages, nav } = fold();
    expect(nav).toEqual({
      group: 'Reference',
      icon: 'book',
      pages: [
        'typescript-sdk/reference/overview',
        {
          group: 'Classes',
          pages: [
            'typescript-sdk/reference/classes/Clock',
            'typescript-sdk/reference/classes/OrderbookClient',
          ],
        },
        'typescript-sdk/reference/errors',
        {
          group: 'Types',
          pages: [
            'typescript-sdk/reference/client',
            'typescript-sdk/reference/orders',
            'typescript-sdk/reference/markets',
            'typescript-sdk/reference/auth',
            'typescript-sdk/reference/signing',
            'typescript-sdk/reference/core',
          ],
        },
      ],
    });
    const listed = navPages(nav);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual(
      [...pages.keys()].map((key) => `typescript-sdk/${key}`).sort(),
    );
  });
});
