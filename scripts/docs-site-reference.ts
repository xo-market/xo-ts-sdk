// The generated reference (docs/reference/: TypeDoc's Markdown, one page per symbol, ~440 pages)
// folded into a few dozen pages of the "TypeScript SDK" tab of docs.xo.market:
//
//   reference/overview          the entry points, and a link to every page below
//   reference/classes/<Name>    a class, as TypeDoc wrote it (its member anchors stay)
//   reference/errors            every class whose name ends in `Error`, one `## <Name>` each
//   reference/<area>            the functions, interfaces, type aliases and variables of one
//                               area of the source (`areaOf`), one `## <Name>` each
//
// On the folded pages (errors and areas) a symbol is the target of every link to it: a link to
// one of its members (`Market.md#marketid`) goes to the symbol (`markets#market`), since member
// headings repeat from one symbol to the next. A heading that would take a symbol's anchor (a
// property `market?` before the interface `Market`) names its own symbol: `market? (ResolveDeps)`.
// The pages go through the converter's escaping and get the same frontmatter and generated note
// as the hand-written pages.
//
// Pure functions, except `typedocSources`, which runs TypeDoc once for the source file of each
// symbol (the Markdown pages do not say it).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  escapeProse,
  type LinkResolver,
  mapProse,
  mdxPage,
  rewriteLinks,
  type SiteManifest,
  unescapeMarkdown,
} from './docs-site-convert.js';

/** A group of Mintlify's navigation (`docs.json`): pages are paths without `.mdx`, or groups. */
export interface MintlifyGroup {
  group: string;
  icon?: string;
  pages: (string | MintlifyGroup)[];
}

export type AreaSlug =
  | 'client'
  | 'orders'
  | 'rewards'
  | 'portfolio'
  | 'markets'
  | 'account'
  | 'bridge'
  | 'realtime'
  | 'auth'
  | 'signing'
  | 'core'
  | 'other';

/** The areas in the order of the sidebar, with the title of their page. */
const AREAS: { slug: AreaSlug; title: string }[] = [
  { slug: 'client', title: 'Client and options' },
  { slug: 'orders', title: 'Orders and the orderbook' },
  { slug: 'rewards', title: 'Liquidity Rewards' },
  { slug: 'portfolio', title: 'Portfolio and activity' },
  { slug: 'markets', title: 'Markets and events' },
  { slug: 'account', title: 'Account, wallets and on-chain' },
  { slug: 'bridge', title: 'Deposits and withdrawals' },
  { slug: 'realtime', title: 'Realtime' },
  { slug: 'auth', title: 'Authentication and credentials' },
  { slug: 'signing', title: 'Signing' },
  { slug: 'core', title: 'Core types' },
  { slug: 'other', title: 'Other' },
];

const SOURCE_ROOT = 'packages/client/src/';

/** The area of a source file: the first rule with a prefix of its path under SOURCE_ROOT. */
const AREA_RULES: [AreaSlug, string[]][] = [
  ['client', ['index.ts', 'clients/']],
  [
    'orders',
    [
      'orderbook/',
      'actions/trading',
      'models/orders',
      'models/trades',
      'models/enums',
    ],
  ],
  // The market lookup (`resolveMarket`, `ResolvedMarket`) is read with the markets.
  ['markets', ['markets/']],
  ['rewards', ['data/rewards', 'actions/rewards', 'models/rewards']],
  [
    'portfolio',
    [
      'data/portfolio',
      'data/pnl',
      'data/activity',
      'data/account',
      'actions/account',
      'actions/profiles',
      'models/account',
    ],
  ],
  [
    'markets',
    [
      'data/',
      'actions/markets',
      'actions/events',
      'actions/catalog',
      'actions/marketData',
      'models/market',
      'models/event',
      'models/catalog',
      'models/browse',
      'models/pulse',
      'models/orderBook',
    ],
  ],
  // The signers of the viem entry are read with the wallets.
  [
    'account',
    ['account/', 'wallet/', 'viem.ts', 'actions/onchain', 'actions/wallets'],
  ],
  ['bridge', ['bridge/', 'actions/bridge', 'models/bridge']],
  ['realtime', ['realtime/', 'actions/subscriptions', 'models/realtime']],
  ['auth', ['auth/', 'node.ts']],
  ['signing', ['signing/']],
  ['core', ['core/']],
];

const ROOT: SiteManifest['root'] = 'typescript-sdk';

/** The source of every page of the reference, in its generated note. */
const SOURCE = 'docs/reference/';

/** The kinds on an area page, by TypeDoc's folder for them, in order; any other comes after. */
const KIND_ORDER = ['functions', 'interfaces', 'type-aliases', 'variables'];

/** TypeDoc's `ReflectionKind.Module`: an entry point, with its symbols as children. */
const MODULE_KIND = 2;
/** TypeDoc's `ReflectionKind.Reference`: a re-export, which has no page of its own. */
const REFERENCE_KIND = 4194304;

/**
 * The area of a symbol by its source file, a path in the repository such as
 * `packages/client/src/data/schemas.ts`. A file outside packages/client/src/, one that no rule
 * matches, or no file at all is `other`.
 */
export function areaOf(sourcePath: string | undefined): AreaSlug {
  if (sourcePath === undefined || !sourcePath.startsWith(SOURCE_ROOT)) {
    return 'other';
  }
  const path = sourcePath.slice(SOURCE_ROOT.length);
  const rule = AREA_RULES.find(([, prefixes]) =>
    prefixes.some((prefix) => path.startsWith(prefix)),
  );
  return rule?.[0] ?? 'other';
}

// -- The source of each symbol --------------------------------------------------------------------

interface Reflection {
  name?: unknown;
  kind?: unknown;
  children?: unknown;
  sources?: unknown;
}

function childrenOf(value: unknown): Reflection[] {
  const children =
    typeof value === 'object' && value !== null
      ? (value as Reflection).children
      : undefined;
  return Array.isArray(children)
    ? children.filter(
        (child): child is Reflection =>
          typeof child === 'object' && child !== null,
      )
    : [];
}

function firstFile(reflection: Reflection): string | undefined {
  const sources = reflection.sources;
  const first: unknown = Array.isArray(sources) ? sources[0] : undefined;
  const file =
    typeof first === 'object' && first !== null
      ? (first as { fileName?: unknown }).fileName
      : undefined;
  return typeof file === 'string' ? file : undefined;
}

/**
 * The source file of each symbol, from TypeDoc's JSON output: `"<module>/<Name>"` (the folder of
 * the module under docs/reference/, such as `client/signing`) to the file's path in the
 * repository, for example `"client/Market" → "packages/client/src/data/schemas.ts"`. Re-exports
 * are left out: they have no page.
 */
export function sourcesOf(api: unknown): Map<string, string> {
  const modules = childrenOf(api).filter((m) => m.kind === MODULE_KIND);
  if (modules.length === 0) {
    throw new Error(
      'api.json: no modules (expected the JSON output of typedoc, with its entry points as modules)',
    );
  }
  const sources = new Map<string, string>();
  for (const module of modules) {
    const dir = String(module.name).replace(/^@[^/]+\//, '');
    for (const symbol of childrenOf(module)) {
      const file = firstFile(symbol);
      if (symbol.kind !== REFERENCE_KIND && file !== undefined) {
        sources.set(`${dir}/${String(symbol.name)}`, file);
      }
    }
  }
  return sources;
}

/**
 * Runs TypeDoc once, with typedoc.json plus its JSON output and the sources that typedoc.json
 * leaves out, into a temporary folder (docs/reference/ is untouched), and answers `sourcesOf`
 * that JSON. The one side effect of this file.
 */
export function typedocSources(): Map<string, string> {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const dir = mkdtempSync(join(tmpdir(), 'xo-sdk-typedoc-json-'));
  try {
    const json = join(dir, 'api.json');
    const run = spawnSync(
      join(root, 'node_modules', '.bin', 'typedoc'),
      [
        '--options',
        join(root, 'typedoc.json'),
        '--json',
        json,
        '--out',
        join(dir, 'md'),
        '--disableSources',
        'false',
        // The source paths from the root of the repository (`packages/client/src/...`). With git
        // off (typedoc.json: `disableGit`) TypeDoc wants a link template; the links go unused.
        '--basePath',
        root,
        '--sourceLinkTemplate',
        '{path}',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    if (run.error !== undefined) {
      throw run.error;
    }
    if (run.status !== 0) {
      throw new Error(
        `typedoc failed (it treats every warning as an error):\n${run.stdout}${run.stderr}`,
      );
    }
    return sourcesOf(JSON.parse(readFileSync(json, 'utf8')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// -- The fold -------------------------------------------------------------------------------------

/** An entry point: its folder under docs/reference/ (`client/signing`) and its README. */
interface Module {
  dir: string;
  /** The import path, from the H1 of its README: `@xomarket/client/signing`. */
  name: string;
  readme: string;
  /** What its README says above its lists of symbols. */
  description: string;
}

/** The page of one symbol: `<module>/<kind>/<Name>.md` under docs/reference/. */
interface Declaration {
  path: string;
  module: Module;
  /** TypeDoc's folder for its kind: `classes`, `interfaces`, `functions`... */
  kind: string;
  name: string;
  text: string;
}

const README = /(?:^|\/)README\.md$/;

const byName = (a: string, b: string) =>
  a.toLowerCase().localeCompare(b.toLowerCase(), 'en') ||
  (a < b ? -1 : a > b ? 1 : 0);

const kindRank = (kind: string) =>
  KIND_ORDER.includes(kind) ? KIND_ORDER.indexOf(kind) : KIND_ORDER.length;

/** Functions, interfaces, type aliases, variables (then any other kind), each by name. */
function byKindThenName(a: Declaration, b: Declaration): number {
  return (
    kindRank(a.kind) - kindRank(b.kind) ||
    byName(a.kind, b.kind) ||
    byName(a.name, b.name)
  );
}

/** The plain text of the H1 of a page, or undefined. */
function titleOf(text: string): string | undefined {
  const h1 = /^# (.+)$/m.exec(text);
  return h1?.[1] === undefined ? undefined : unescapeMarkdown(h1[1].trim());
}

/** The page without its H1 (TypeDoc's `# Interface: Market`) and the blank lines after it. */
function withoutTitle(text: string): string {
  return text.replace(/^# [^\n]*\n+/, '');
}

/** A symbol's name as a heading's text: Markdown's characters escaped (`SDK\_VERSION`). */
function headingText(name: string): string {
  return name.replace(/[\\`*_[\]{}<>|]/g, '\\$&');
}

/**
 * The anchor of a heading, as GitHub makes it (and the links TypeDoc writes expect): lower case,
 * punctuation dropped, spaces to `-`. `placeOrder()` is `placeorder`, `SDK_VERSION` `sdk_version`.
 */
function anchorOf(text: string): string {
  return unescapeMarkdown(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

/**
 * The page of a symbol as a part of a folded page: without its title, each heading one level
 * down (`######` stays), fenced code left as it is. A heading whose anchor is that of a symbol of
 * the page (`anchors`), such as a property `market?` next to the interface `Market`, also names
 * its own symbol, `market? (ResolveDeps)`, so that the anchor stays the symbol's: its anchor,
 * `market-resolvedeps`, has a `-`, which the anchor of a name never has.
 */
function foldedBody(d: Declaration, anchors: Set<string>): string {
  return mapProse(withoutTitle(d.text), (prose) =>
    prose.replace(
      /^(#{1,6})([ \t]+(.*))?$/gm,
      (_line, marks: string, rest: string | undefined, text: string) => {
        const level = marks.length === 6 ? marks : `#${marks}`;
        return rest === undefined || !anchors.has(anchorOf(text))
          ? `${level}${rest ?? ''}`
          : `${level} ${text} (${headingText(d.name)})`;
      },
    ),
  );
}

function modulesOf(pages: Map<string, string>): Module[] {
  const modules: Module[] = [];
  for (const [path, text] of pages) {
    if (!README.test(path) || path === 'README.md') {
      continue;
    }
    const dir = posix.dirname(path);
    const name = titleOf(text);
    if (name === undefined) {
      throw new Error(`docs/reference/${path}: no H1 naming the module`);
    }
    const body = withoutTitle(text);
    const end = body.search(/^## /m);
    modules.push({
      dir,
      name,
      readme: path,
      description: (end === -1 ? body : body.slice(0, end)).trim(),
    });
  }
  return modules.sort((a, b) => byName(a.dir, b.dir));
}

function declarationsOf(
  pages: Map<string, string>,
  modules: Module[],
): Declaration[] {
  const declarations: Declaration[] = [];
  for (const [path, text] of pages) {
    if (README.test(path)) {
      continue;
    }
    const module = modules
      .filter((m) => path.startsWith(`${m.dir}/`))
      .sort((a, b) => b.dir.length - a.dir.length)[0];
    const rest =
      module?.dir === undefined
        ? []
        : path.slice(module.dir.length + 1).split('/');
    const [kind, file] = rest;
    if (
      module === undefined ||
      rest.length !== 2 ||
      kind === undefined ||
      file === undefined ||
      !file.endsWith('.md')
    ) {
      throw new Error(
        `docs/reference/${path}: not the page of a symbol (<module>/<kind>/<Name>.md, under a folder with a README.md)`,
      );
    }
    declarations.push({
      path,
      module,
      kind,
      name: file.slice(0, -'.md'.length),
      text,
    });
  }
  return declarations;
}

/**
 * Whether `a` and `b` are a type alias and a value of one name, such as an error union and its
 * guard (`ListMarketsError`): they share one section of a folded page, the type's, then the
 * value's.
 */
function areTwins(a: Declaration, b: Declaration): boolean {
  return (
    a !== b &&
    a.name === b.name &&
    a.module === b.module &&
    [a.kind, b.kind].sort().join() === 'type-aliases,variables'
  );
}

/**
 * Folds the generated reference. `pages` are the files of docs/reference/, keyed by their path
 * under it (`client/classes/Session.md`, `README.md`); `sources` is `typedocSources()`. The pages
 * of the result are keyed by their path under the tab's root (`reference/classes/Session`) and
 * listed in that order in `nav`; `resolve` answers the site path of a link into docs/reference/
 * (the hand-written pages' links). Throws, naming the pages, on a link to a page the reference
 * does not have, two symbols that would share an anchor or a page (but a type alias and a value
 * of one name, which share a section), and a file that is not the page of a symbol or a module.
 */
export function foldReference(o: {
  pages: Map<string, string>;
  sources: Map<string, string>;
}): { pages: Map<string, string>; resolve: LinkResolver; nav: MintlifyGroup } {
  const pages = new Map(
    [...o.pages].map(([path, text]) => [path, text.replaceAll('\r\n', '\n')]),
  );
  const modules = modulesOf(pages);
  const main = modules.filter((m) => !m.dir.includes('/'));
  if (main[0] === undefined || main.length > 1) {
    throw new Error(
      `docs/reference/: expected one top-level module, found ${main.length} (${main.map((m) => m.dir).join(', ')})`,
    );
  }
  const mainModule = main[0];
  const declarations = declarationsOf(pages, modules);

  const classes = declarations
    .filter((d) => d.kind === 'classes' && !d.name.endsWith('Error'))
    .sort((a, b) => byName(a.name, b.name));
  const errors = declarations
    .filter((d) => d.kind === 'classes' && d.name.endsWith('Error'))
    .sort((a, b) => byName(a.name, b.name));
  const areas = AREAS.map(({ slug, title }) => ({
    slug: `reference/${slug}`,
    title,
    symbols: declarations
      .filter(
        (d) =>
          d.kind !== 'classes' &&
          areaOf(o.sources.get(`${d.module.dir}/${d.name}`)) === slug,
      )
      .sort(byKindThenName),
  })).filter((area) => area.symbols.length > 0);
  const folded = [
    { slug: 'reference/errors', title: 'Error classes', symbols: errors },
    ...areas,
  ].filter((page) => page.symbols.length > 0);

  // Where a link to each page of docs/reference/ goes.
  const targets = new Map<string, (anchor: string | undefined) => string>();
  const target = (path: string, to: (anchor: string | undefined) => string) => {
    targets.set(`docs/reference/${path}`, to);
  };
  const overview = `/${ROOT}/reference/overview`;
  for (const path of pages.keys()) {
    if (README.test(path)) {
      target(path, () => overview);
    }
  }
  const classSlugs = new Map<string, string>();
  for (const d of classes) {
    const slug = `reference/classes/${d.name}`;
    const other = classSlugs.get(slug.toLowerCase());
    if (other !== undefined) {
      throw new Error(
        `${slug}: the page of both docs/reference/${other} and docs/reference/${d.path}`,
      );
    }
    classSlugs.set(slug.toLowerCase(), d.path);
    target(d.path, (anchor) =>
      anchor === undefined ? `/${ROOT}/${slug}` : `/${ROOT}/${slug}#${anchor}`,
    );
  }
  for (const page of folded) {
    const anchors = new Map<string, Declaration>();
    for (const d of page.symbols) {
      const anchor = anchorOf(d.name);
      const other = anchors.get(anchor);
      if (other !== undefined && !areTwins(other, d)) {
        throw new Error(
          `${page.slug}: #${anchor} would be the anchor of both docs/reference/${other.path} and docs/reference/${d.path} (rename one, or give its source file another area in areaOf)`,
        );
      }
      anchors.set(anchor, other ?? d);
      target(d.path, () => `/${ROOT}/${page.slug}#${anchor}`);
    }
  }
  const resolve: LinkResolver = (repoPath, anchor) =>
    targets.get(repoPath)?.(anchor);

  /** Escapes the Markdown of the page `path` and sends its links where the fold puts them. */
  const render = (markdown: string, path: string, ownAnchors: boolean) => {
    const repoPath = `docs/reference/${path}`;
    return rewriteLinks(escapeProse(markdown), (raw) => {
      const dest = unescapeMarkdown(raw);
      if (
        dest === '' ||
        dest.startsWith('/') ||
        /^[A-Za-z][A-Za-z0-9+.-]*:/.test(dest)
      ) {
        return raw;
      }
      const hash = dest.indexOf('#');
      const file = hash === -1 ? dest : dest.slice(0, hash);
      const anchor =
        hash === -1 ? undefined : dest.slice(hash + 1) || undefined;
      if (file === '' && ownAnchors) {
        return raw;
      }
      const linked =
        file === '' ? repoPath : posix.join(posix.dirname(repoPath), file);
      const resolved = resolve(linked, anchor);
      if (resolved === undefined) {
        throw new Error(
          `${repoPath}: link ${dest}: no page of the reference for ${linked}`,
        );
      }
      return resolved;
    });
  };

  const importLine = (d: Declaration) =>
    d.module === mainModule ? '' : `Import from \`${d.module.name}\`.\n\n`;

  const out = new Map<string, string>();
  const listItem = (title: string, slug: string) =>
    `- [${title}](/${ROOT}/${slug})`;
  const pageList = [
    ...(classes.length === 0
      ? []
      : [
          '## Classes',
          classes
            .map((d) => listItem(d.name, `reference/classes/${d.name}`))
            .join('\n'),
        ]),
    ...(errors.length === 0
      ? []
      : [
          '## Errors',
          `${listItem('Error classes', 'reference/errors')}: ${errors.map((d) => `\`${d.name}\``).join(', ')}`,
        ]),
    ...(areas.length === 0
      ? []
      : [
          '## Types and functions',
          areas.map((area) => listItem(area.title, area.slug)).join('\n'),
        ]),
  ].join('\n\n');
  out.set(
    'reference/overview',
    mdxPage({
      title: titleOf(pages.get('README.md') ?? '') ?? 'API reference',
      source: SOURCE,
      body: [
        '## Entry points',
        ...modules.map((m) =>
          render(m.description || `\`${m.name}\``, m.readme, false),
        ),
        render(pageList, 'README.md', false),
      ].join('\n\n'),
    }),
  );
  for (const d of classes) {
    out.set(
      `reference/classes/${d.name}`,
      mdxPage({
        title: d.name,
        source: SOURCE,
        body: render(`${importLine(d)}${withoutTitle(d.text)}`, d.path, true),
      }),
    );
  }
  for (const page of folded) {
    const anchors = new Set(page.symbols.map((d) => anchorOf(d.name)));
    const twinOf = (d: Declaration) =>
      page.symbols.find((other) => areTwins(d, other));
    out.set(
      page.slug,
      mdxPage({
        title: page.title,
        source: SOURCE,
        body: page.symbols
          // A value with a type of its name is in the type's section.
          .filter((d) => d.kind !== 'variables' || twinOf(d) === undefined)
          .map((d) => {
            const twin = twinOf(d);
            const own = render(
              `## ${headingText(d.name)}\n\n${importLine(d)}${foldedBody(d, anchors)}`,
              d.path,
              false,
            ).trimEnd();
            return twin === undefined
              ? own
              : `${own}\n\n${render(foldedBody(twin, anchors), twin.path, false).trimEnd()}`;
          })
          .join('\n\n'),
      }),
    );
  }

  const nav: MintlifyGroup = {
    group: 'Reference',
    icon: 'book',
    pages: [
      `${ROOT}/reference/overview`,
      ...(classes.length === 0
        ? []
        : [
            {
              group: 'Classes',
              pages: classes.map((d) => `${ROOT}/reference/classes/${d.name}`),
            },
          ]),
      ...(errors.length === 0 ? [] : [`${ROOT}/reference/errors`]),
      ...(areas.length === 0
        ? []
        : [{ group: 'Types', pages: areas.map((a) => `${ROOT}/${a.slug}`) }]),
    ],
  };
  return { pages: out, resolve, nav };
}
