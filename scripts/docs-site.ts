// The "TypeScript SDK" tab of docs.xo.market, built from docs/ and checked.
//
//   pnpm -C scripts docs-site build --out <dir>   write the tab into <dir>
//   pnpm -C scripts docs-site check               build into a temporary folder and check it
//
// `build` writes the pages of the tab as MDX, `<dir>/typescript-sdk/<slug>.mdx`, and
// `<dir>/docs-tab.json`, the tab as Mintlify's navigation wants it: the groups of docs/site.json
// with their pages (`typescript-sdk/<slug>`), then the Reference group. The pages are the
// hand-written ones of docs/site.json, converted (docs-site-convert.ts), and the committed
// docs/reference/ folded into a few dozen (docs-site-reference.ts; its symbols' source files come
// from one run of TypeDoc into a temporary folder). It writes nothing under docs/ and replaces
// `<dir>/typescript-sdk/`. A relative <dir> is relative to where the script runs (scripts/, under
// `pnpm -C scripts`): pass an absolute one.
//
// `check` exits 1 on any of these problems, one line each:
//
//   - a Markdown page under docs/ (not docs/reference/) that docs/site.json does not list;
//   - a page of docs/site.json whose file is not there;
//   - a page that `@mdx-js/mdx` cannot compile (the frontmatter is Mintlify's, so it is cut first);
//   - a link from a page to a file of the repository (an example, a README) that is not there, or to
//     a page of docs/ that docs/site.json does not list (the build stops at the first, naming the
//     page and the link; an anchor such as `#L10` is not part of the file's path);
//   - a link to `/typescript-sdk/...` (Markdown link, definition, `href` of a component) that goes
//     to no page of the tab (anchors are not checked: Mintlify makes them its own way);
//   - a page over 300 KB;
//   - docs-tab.json listing a page twice or one that has no file, or leaving one out;
//   - a symbol of the reference on the `reference/other` page: its source file is outside the area
//     table of docs-site-reference.ts, or TypeDoc did not give it one.
//
// `check` is part of `pnpm run docs:check`, so CI runs it on every pull request.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileSync, createProcessor } from '@mdx-js/mdx';
import {
  convertPage,
  readManifest,
  type SiteManifest,
  unescapeMarkdown,
} from './docs-site-convert.js';
import {
  foldReference,
  type MintlifyGroup,
  typedocSources,
} from './docs-site-reference.js';

/** The tab as Mintlify's navigation (`docs.json`) wants it. */
export type MintlifyTab = {
  tab: SiteManifest['tab'];
  groups: MintlifyGroup[];
};

/** The most a page may weigh: Mintlify slows down and the page is no longer readable well before. */
export const MAX_PAGE_BYTES = 300 * 1024;

const ROOT: SiteManifest['root'] = 'typescript-sdk';
const TAB: SiteManifest['tab'] = 'TypeScript SDK';
const TAB_FILE = 'docs-tab.json';
const OTHER_PAGE = `${ROOT}/reference/other`;

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Every file under `dir`, relative to it, sorted, with `/` separators. None when it does not exist. */
function filesOf(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else {
        files.push(relative(dir, path).split(sep).join('/'));
      }
    }
  };
  walk(dir);
  return files;
}

function loadManifest(docs: string): SiteManifest {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(join(docs, 'site.json'), 'utf8'));
  } catch (error) {
    throw new Error(`docs/site.json: ${reason(error)}`);
  }
  return readManifest(json);
}

function missingSource(source: string): string {
  return `docs/${source}: listed in docs/site.json, but the file does not exist`;
}

// -- Build ----------------------------------------------------------------------------------------

/** Where `buildSite` reads from. Both are for tests: the defaults are the repository's. */
export interface BuildOptions {
  /** The docs/ folder. */
  docs?: string;
  /** The source file of each symbol, as `typedocSources()` answers; by default TypeDoc runs. */
  sources?: Map<string, string>;
}

/**
 * Writes the tab into `outDir` (see the top of this file) and answers it with the paths of its
 * pages (`typescript-sdk/<slug>`, in the order of the sidebar). Throws, naming the page, when a
 * page of docs/site.json has no file or fails to convert, and when the reference does not fold.
 */
export function buildSite(
  outDir: string,
  o: BuildOptions = {},
): { pages: string[]; tab: MintlifyTab } {
  const docs = o.docs ?? DOCS;
  // docs/ is in the root of the repository: the files the pages link to are found from there.
  const repoRoot = dirname(docs);
  const manifest = loadManifest(docs);
  const reference = new Map(
    filesOf(join(docs, 'reference'))
      .filter((path) => path.endsWith('.md'))
      .map((path) => [
        path,
        readFileSync(join(docs, 'reference', path), 'utf8'),
      ]),
  );
  const fold = foldReference({
    pages: reference,
    sources: o.sources ?? typedocSources(),
  });

  const mdx = new Map<string, string>();
  const add = (slug: string, text: string, from: string) => {
    if (mdx.has(slug)) {
      throw new Error(`${from}: another page is already at ${ROOT}/${slug}`);
    }
    mdx.set(slug, text);
  };
  for (const [slug, text] of fold.pages) {
    add(slug, text, 'docs/reference/');
  }
  for (const group of manifest.groups) {
    for (const page of group.pages) {
      const file = join(docs, page.source);
      if (!existsSync(file)) {
        throw new Error(missingSource(page.source));
      }
      const converted = convertPage({
        source: page.source,
        text: readFileSync(file, 'utf8'),
        manifest,
        resolveReference: fold.resolve,
        repoFileExists: (repoPath) => existsSync(join(repoRoot, repoPath)),
      });
      add(converted.slug, converted.mdx, `docs/${page.source}`);
    }
  }

  const tab: MintlifyTab = {
    tab: manifest.tab,
    groups: [
      ...manifest.groups.map((group) => ({
        group: group.group,
        icon: group.icon,
        pages: group.pages.map((page) => `${manifest.root}/${page.slug}`),
      })),
      fold.nav,
    ],
  };

  const root = join(outDir, manifest.root);
  rmSync(root, { recursive: true, force: true });
  for (const [slug, text] of mdx) {
    const file = `${join(root, slug)}.mdx`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  writeFileSync(join(outDir, TAB_FILE), `${JSON.stringify(tab, null, 2)}\n`);
  return { pages: pagesOf(tab.groups), tab };
}

/** The page paths of Mintlify groups, nested groups included, in order. */
function pagesOf(groups: MintlifyGroup[]): string[] {
  return groups.flatMap((group) =>
    group.pages.flatMap((page) =>
      typeof page === 'string' ? [page] : pagesOf([page]),
    ),
  );
}

// -- Check ----------------------------------------------------------------------------------------

/** The pages docs/site.json does not list, and the pages it lists that have no file. */
function checkSources(docs: string): string[] {
  let manifest: SiteManifest;
  try {
    manifest = loadManifest(docs);
  } catch (error) {
    return [reason(error)];
  }
  const listed = new Set(
    manifest.groups.flatMap((group) => group.pages.map((p) => p.source)),
  );
  return [
    ...filesOf(docs)
      .filter(
        (path) =>
          path.endsWith('.md') &&
          !path.startsWith('reference/') &&
          !listed.has(path),
      )
      .map((path) => `not in docs/site.json: docs/${path}`),
    ...[...listed]
      .filter((source) => !existsSync(join(docs, source)))
      .map(missingSource),
  ];
}

/** The text with its frontmatter blanked out (the lines stay where they are): Mintlify reads it, not MDX. */
function withoutFrontmatter(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, (m) =>
    m.replaceAll(/[^\n]/g, ''),
  );
}

interface MdxNode {
  type?: unknown;
  url?: unknown;
  name?: unknown;
  value?: unknown;
  attributes?: unknown;
  children?: unknown;
}

/** The destinations of the links of a page: Markdown links and definitions, and `href` props. */
function linksOf(node: MdxNode, into: string[] = []): string[] {
  if (
    (node.type === 'link' || node.type === 'definition') &&
    typeof node.url === 'string'
  ) {
    into.push(node.url);
  }
  if (Array.isArray(node.attributes)) {
    for (const attribute of node.attributes as MdxNode[]) {
      if (attribute.name === 'href' && typeof attribute.value === 'string') {
        into.push(attribute.value);
      }
    }
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children as MdxNode[]) {
      linksOf(child, into);
    }
  }
  return into;
}

/** The path of the page a link goes to (`typescript-sdk/guides/x`), or `undefined` when it goes elsewhere. */
function pageOfLink(url: string): string | undefined {
  if (url !== `/${ROOT}` && !url.startsWith(`/${ROOT}/`)) {
    return undefined;
  }
  const path = url.slice(1).split(/[#?]/, 1)[0] ?? '';
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** The names of the `## <Name>` headings of a folded page, outside code, with Markdown's escapes undone. */
function symbolsOf(mdx: string): string[] {
  const names: string[] = [];
  let fence: string | undefined;
  for (const line of withoutFrontmatter(mdx).split('\n')) {
    const mark = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1];
    if (mark !== undefined) {
      fence =
        fence === undefined
          ? mark
          : mark[0] === fence[0] && mark.length >= fence.length
            ? undefined
            : fence;
    } else if (fence === undefined) {
      const name = /^## (.+?)\s*$/.exec(line)?.[1];
      if (name !== undefined) {
        names.push(unescapeMarkdown(name));
      }
    }
  }
  return names;
}

/** What docs-tab.json lists, in order, nested groups included; or what is wrong with its shape. */
function tabListing(json: unknown): { pages: string[] } | { problem: string } {
  const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!object(json) || json.tab !== TAB) {
    return { problem: `${TAB_FILE}: "tab" must be "${TAB}"` };
  }
  const pages: string[] = [];
  /** The entries of `groups`, or of the `pages` of a group: paths, and groups with `pages`. */
  const collect = (entries: unknown): string | undefined => {
    if (!Array.isArray(entries)) {
      return `${TAB_FILE}: "groups" and "pages" must be lists`;
    }
    for (const entry of entries) {
      if (typeof entry === 'string') {
        pages.push(entry);
      } else if (object(entry)) {
        const problem = collect(entry.pages);
        if (problem !== undefined) {
          return problem;
        }
      } else {
        return `${TAB_FILE}: a page must be a path or a group`;
      }
    }
    return undefined;
  };
  const problem = collect(json.groups);
  return problem === undefined ? { pages } : { problem };
}

function checkTab(outDir: string, pages: Set<string>): string[] {
  const file = join(outDir, TAB_FILE);
  if (!existsSync(file)) {
    return [`${TAB_FILE} is missing`];
  }
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return [`${TAB_FILE} is not valid JSON: ${reason(error)}`];
  }
  const listing = tabListing(json);
  if ('problem' in listing) {
    return [listing.problem];
  }
  const problems: string[] = [];
  const listed = new Set<string>();
  const twice = new Set<string>();
  for (const page of listing.pages) {
    if (listed.has(page) && !twice.has(page)) {
      twice.add(page);
      problems.push(`${TAB_FILE} lists ${page} twice`);
    }
    listed.add(page);
  }
  for (const page of listed) {
    if (!pages.has(page)) {
      problems.push(`${TAB_FILE} lists ${page}, which has no page`);
    }
  }
  for (const page of pages) {
    if (!listed.has(page)) {
      problems.push(`${TAB_FILE} does not list ${page}`);
    }
  }
  return problems;
}

/** The pages of `<outDir>/typescript-sdk/`: the path as docs-tab.json lists it to the file. */
function builtPages(outDir: string): Map<string, string> {
  const root = join(outDir, ROOT);
  return new Map(
    filesOf(root)
      .filter((path) => path.endsWith('.mdx'))
      .map((path) => [
        `${ROOT}/${path.slice(0, -'.mdx'.length)}`,
        join(root, path),
      ]),
  );
}

/** What is wrong with one built page: its size, whether it compiles, and its links. */
function checkPage(
  path: string,
  file: string,
  pages: ReadonlyMap<string, string>,
  parse: (text: string) => MdxNode,
): string[] {
  const name = `${path}.mdx`;
  const problems: string[] = [];
  const bytes = statSync(file).size;
  if (bytes > MAX_PAGE_BYTES) {
    problems.push(
      `${name} is ${Math.ceil(bytes / 1024)} KB, over the ${MAX_PAGE_BYTES / 1024} KB limit`,
    );
  }
  const text = withoutFrontmatter(readFileSync(file, 'utf8'));
  try {
    compileSync(text, { format: 'mdx' });
  } catch (error) {
    const line = (error as { line?: unknown }).line;
    const column = (error as { column?: unknown }).column;
    const at =
      typeof line === 'number'
        ? `:${line}${typeof column === 'number' ? `:${column}` : ''}`
        : '';
    const message = (error as { reason?: unknown }).reason;
    problems.push(
      `${name}${at}: does not compile: ${typeof message === 'string' ? message : reason(error)}`,
    );
    return problems;
  }
  for (const url of new Set(linksOf(parse(text)))) {
    const target = pageOfLink(url);
    if (target !== undefined && !pages.has(target)) {
      problems.push(`${name}: link ${url}: no such page`);
    }
  }
  return problems;
}

/**
 * The problems of the tab built into `outDir` (see the top of this file), one line each, none when
 * it is good. `docs` is the docs/ folder it was built from.
 */
export function checkSite(outDir: string, docs: string = DOCS): string[] {
  const pages = builtPages(outDir);
  const processor = createProcessor({ format: 'mdx' });
  const problems = checkSources(docs);
  for (const [path, file] of pages) {
    problems.push(
      ...checkPage(
        path,
        file,
        pages,
        (text) => processor.parse(text) as MdxNode,
      ),
    );
  }
  problems.push(...checkTab(outDir, new Set(pages.keys())));
  const other = pages.get(OTHER_PAGE);
  if (other !== undefined) {
    problems.push(
      `reference symbols fell into "other": ${symbolsOf(readFileSync(other, 'utf8')).join(', ')}`,
    );
  }
  return problems;
}

// -- Command line ---------------------------------------------------------------------------------

const USAGE =
  'usage: docs-site build --out <dir>   write the tab into <dir>\n       docs-site check               build into a temporary folder and check it';

export type Args = { command: 'build'; out: string } | { command: 'check' };

/** Reads the command line (without `node` and the script). Throws the usage on anything else. */
export function parseArgs(argv: readonly string[]): Args {
  const [command, ...rest] = argv;
  if (command === 'check' && rest.length === 0) {
    return { command };
  }
  if (command === 'build') {
    if (rest[0] === '--out' && rest.length === 2 && rest[1] !== undefined) {
      return { command, out: rest[1] };
    }
    if (rest.length < 2 && (rest.length === 0 || rest[0] === '--out')) {
      throw new Error(`docs-site build needs --out <dir>\n${USAGE}`);
    }
  }
  throw new Error(USAGE);
}

function kb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

function main(): void {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(reason(error));
    process.exitCode = 1;
    return;
  }
  if (args.command === 'build') {
    const out = resolve(args.out);
    const built = buildSite(out);
    console.log(
      `docs-site: wrote ${built.pages.length} pages to ${join(out, ROOT)} and the tab to ${join(out, TAB_FILE)}`,
    );
    return;
  }
  const out = mkdtempSync(join(tmpdir(), 'xo-sdk-site-'));
  try {
    const started = Date.now();
    let built: { pages: string[] };
    try {
      built = buildSite(out);
    } catch (error) {
      console.error(`docs-site: ${reason(error)}`);
      process.exitCode = 1;
      return;
    }
    const problems = checkSite(out);
    for (const problem of problems) {
      console.error(problem);
    }
    if (problems.length > 0) {
      console.error(`docs-site: ${problems.length} problem(s)`);
      process.exitCode = 1;
      return;
    }
    const sizes = [...builtPages(out)].map(
      ([path, file]) => [path, statSync(file).size] as const,
    );
    const [largest, bytes] = sizes.reduce((a, b) => (b[1] > a[1] ? b : a));
    console.log(
      `docs-site: ${built.pages.length} pages (largest ${largest}.mdx, ${kb(bytes)}) build, compile and link: OK (${((Date.now() - started) / 1000).toFixed(1)} s)`,
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
