// The snippet check of the pages in docs/: code in the docs is never typed freehand.
//
// Every fenced code block of a page carries a marker on the line above it (blank lines may
// sit between them):
//
//   <!-- snippet: docs/snippets/markets.ts#list-markets -->   the block is region `list-markets` of that file
//   <!-- snippet: none -->                                    a short shell or JSON block, no source
//
// A region is marked in a source with `// #region <name>` … `// #endregion` (the closing
// marker may repeat the name). Regions may nest; the markers of a nested region are left out
// of the outer one. A block must equal its region, ignoring the indent common to every line of
// each. Sources are the docs-only code of `docs/snippets/` (type-checked by
// `pnpm run docs:typecheck`, never run) and tests only: the runnable examples are never quoted,
// so they stay plain scripts.
//
// Code outside a fence cannot carry a marker, so it fails: an indented code block (a line
// indented 4 spaces past its context after a blank line, at the top level or in a list item)
// and a `<pre>` block. Write a fenced block instead.
//
//   pnpm -C scripts docs-snippets            check (exit 1 on any problem)
//   pnpm -C scripts docs-snippets --write    refresh every block from its region
//
// Pages are the Markdown files under docs/, except the generated reference (docs/reference/),
// which holds no snippet of this check.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Languages a `none` block may have: shell commands and JSON shapes, never code. */
const NONE_LANGS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'shell',
  'console',
  'json',
]);

const REGION_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REGION_OPEN = /^\s*\/\/\s*#region\b\s*(.*)$/;
const REGION_CLOSE = /^\s*\/\/\s*#endregion\b\s*(.*)$/;
const MARKER = /^\s*<!--\s*snippet:\s*(.*?)\s*-->\s*$/;
const MARKER_SOURCE = /^([A-Za-z0-9._/-]+)#([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;

/** Folders under docs/ that hold no page of this check. */
const SKIPPED_DIRS = ['reference'];

/**
 * Reads the regions of one source file: name → its lines, the markers of nested regions left
 * out, the blank lines at either end trimmed. Throws on a malformed region, naming the file.
 */
export function parseRegions(
  source: string,
  file: string,
): Map<string, string> {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const regions = new Map<string, string[]>();
  const open: { name: string; line: number }[] = [];
  lines.forEach((text, index) => {
    const line = index + 1;
    const opening = REGION_OPEN.exec(text);
    if (opening !== null) {
      const name = (opening[1] ?? '').trim();
      if (!REGION_NAME.test(name)) {
        throw new Error(
          `${file}:${line}: region name ${JSON.stringify(name)} must be lower-case words joined by hyphens, such as step-5`,
        );
      }
      if (regions.has(name)) {
        throw new Error(
          `${file}:${line}: region "${name}" is defined twice in this file`,
        );
      }
      regions.set(name, []);
      open.push({ name, line });
      return;
    }
    const closing = REGION_CLOSE.exec(text);
    if (closing !== null) {
      const current = open.pop();
      if (current === undefined) {
        throw new Error(`${file}:${line}: #endregion without a #region`);
      }
      const named = (closing[1] ?? '').trim();
      if (named !== '' && named !== current.name) {
        throw new Error(
          `${file}:${line}: #endregion ${named} closes region "${current.name}"`,
        );
      }
      return;
    }
    for (const { name } of open) {
      regions.get(name)?.push(text);
    }
  });
  const unclosed = open.pop();
  if (unclosed !== undefined) {
    throw new Error(
      `${file}:${unclosed.line}: region "${unclosed.name}" is never closed`,
    );
  }
  return new Map(
    [...regions].map(([name, body]) => [name, trimBlankEnds(body).join('\n')]),
  );
}

function trimBlankEnds(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? '').trim() === '') {
    start += 1;
  }
  while (end > start && (lines[end - 1] ?? '').trim() === '') {
    end -= 1;
  }
  return lines.slice(start, end);
}

/** Removes the indent common to every non-blank line. Blank lines become empty. */
export function dedent(text: string): string {
  const lines = text.split('\n');
  let common: string | undefined;
  for (const line of lines) {
    if (line.trim() === '') {
      continue;
    }
    const indent = /^\s*/.exec(line)?.[0] ?? '';
    if (common === undefined) {
      common = indent;
      continue;
    }
    let i = 0;
    while (i < common.length && i < indent.length && common[i] === indent[i]) {
      i += 1;
    }
    common = common.slice(0, i);
  }
  const cut = common?.length ?? 0;
  return lines
    .map((line) => (line.trim() === '' ? '' : line.slice(cut)))
    .join('\n');
}

/** What the line above a code block says about its source. */
export type Marker =
  | { kind: 'region'; path: string; region: string }
  | { kind: 'none' }
  | { kind: 'malformed'; text: string };

/** One fenced code block of a page. Lines count from 1. */
export interface Block {
  /** The line of the opening fence. */
  line: number;
  /** The index (from 0) of the first content line, and one past the last one. */
  start: number;
  end: number;
  /** The whitespace before the opening fence. */
  indent: string;
  lang: string;
  /** The lines between the fences, as they are in the page. */
  content: string;
  marker?: Marker;
}

function readMarker(text: string): Marker | undefined {
  const match = MARKER.exec(text);
  if (match === null) {
    return undefined;
  }
  const value = match[1] ?? '';
  if (value === 'none') {
    return { kind: 'none' };
  }
  const source = MARKER_SOURCE.exec(value);
  if (source === null) {
    return { kind: 'malformed', text: text.trim() };
  }
  return { kind: 'region', path: source[1] ?? '', region: source[2] ?? '' };
}

/** Every fenced code block of a page, with the marker above it when there is one. */
export function findBlocks(markdown: string): Block[] {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const fence = FENCE_OPEN.exec(lines[i] ?? '');
    if (fence === null) {
      i += 1;
      continue;
    }
    const indent = fence[1] ?? '';
    const ticks = fence[2] ?? '```';
    const char = ticks[0] ?? '`';
    const lang = (fence[3] ?? '').toLowerCase();
    const close = new RegExp(`^\\s*\\${char}{${ticks.length},}\\s*$`);
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j] ?? '')) {
      j += 1;
    }
    if (j >= lines.length) {
      throw new Error(`line ${i + 1}: a code fence that is never closed`);
    }
    let above = i - 1;
    while (above >= 0 && (lines[above] ?? '').trim() === '') {
      above -= 1;
    }
    const marker = above >= 0 ? readMarker(lines[above] ?? '') : undefined;
    blocks.push({
      line: i + 1,
      start: i + 1,
      end: j,
      indent,
      lang,
      content: lines.slice(i + 1, j).join('\n'),
      ...(marker === undefined ? {} : { marker }),
    });
    i = j + 1;
  }
  return blocks;
}

/** Code that is not in a fence: an indented code block, or a `<pre>` block. Lines count from 1. */
export interface UnfencedCode {
  line: number;
  kind: 'indented' | 'pre';
}

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)\S/;

/** The width of a line's indent, a tab counting as 4. */
function indentOf(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === ' ') {
      width += 1;
    } else if (char === '\t') {
      width += 4 - (width % 4);
    } else {
      break;
    }
  }
  return width;
}

/**
 * Finds code that is not in a fence. Fenced blocks and HTML comments are skipped. An indented
 * code block is a non-blank line after a blank one, indented at least 4 past its context: the
 * page (column 0), or the content of the list item it continues.
 */
export function findUnfencedCode(markdown: string): UnfencedCode[] {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const skipped = new Set<number>();
  for (const block of findBlocks(markdown)) {
    for (let i = block.line - 1; i <= block.end; i += 1) {
      skipped.add(i);
    }
  }
  let inComment = false;
  lines.forEach((text, i) => {
    if (inComment || /^ {0,3}<!--/.test(text)) {
      skipped.add(i);
      const opens = text.lastIndexOf('<!--');
      const closes = text.lastIndexOf('-->');
      inComment = inComment ? closes < 0 : opens > closes;
    }
  });
  const found: UnfencedCode[] = [];
  let listIndent: number | undefined;
  // Whether the next line starts a block: after a blank line, a heading, a thematic break, a
  // closing fence or an HTML comment, any of which an indented code block may follow.
  let prevBlank = true;
  let wasQuote = false;
  let quoteBlank = false;
  lines.forEach((text, i) => {
    if (skipped.has(i)) {
      prevBlank = true;
      wasQuote = false;
      return;
    }
    if (text.trim() === '') {
      prevBlank = true;
      wasQuote = false;
      return;
    }
    if (/<pre[\s>]/i.test(text)) {
      found.push({ line: i + 1, kind: 'pre' });
    }
    if (/^ {0,3}>/.test(text)) {
      // A blockquote: the same rule inside it, on the text after the `>` markers.
      let content = text;
      while (/^ {0,3}>/.test(content)) {
        content = content.replace(/^ {0,3}> ?/, '');
      }
      if (!wasQuote) {
        quoteBlank = true;
      }
      if (content.trim() === '') {
        quoteBlank = true;
      } else {
        if (quoteBlank && indentOf(content) >= 4) {
          found.push({ line: i + 1, kind: 'indented' });
        }
        quoteBlank = false;
      }
      wasQuote = true;
      prevBlank = false;
      return;
    }
    wasQuote = false;
    if (/^ {0,3}(#{1,6}(\s|$)|([-*_])( *\3){2,} *$)/.test(text)) {
      prevBlank = true;
      listIndent = undefined;
      return;
    }
    const indent = indentOf(text);
    const item = LIST_ITEM.exec(text);
    if (prevBlank) {
      const inList = listIndent !== undefined && indent >= listIndent;
      const context = inList ? (listIndent ?? 0) : 0;
      if (indent >= context + 4) {
        found.push({ line: i + 1, kind: 'indented' });
        prevBlank = false;
        return;
      }
      if (!inList && item === null) {
        listIndent = undefined;
      }
    }
    if (item !== null) {
      listIndent =
        (item[1] ?? '').length +
        (item[2] ?? '').length +
        (item[3] ?? '').length;
    }
    prevBlank = false;
  });
  return found;
}

/**
 * Whether a marker may name `path`: a file of `docs/snippets/`, or a test (`test/` or `e2e/`
 * folders, `*.test.ts`), relative to the repository root and inside it.
 */
export function isAllowedSource(path: string): boolean {
  if (path.startsWith('/') || path.split('/').some((part) => part === '..')) {
    return false;
  }
  if (path.startsWith('docs/snippets/')) {
    return true;
  }
  return /(^|\/)(test|e2e)\//.test(path) || /\.test\.ts$/.test(path);
}

/** The first line (from 1) where two texts differ. */
function firstDifference(a: string, b: string): number {
  const left = a.split('\n');
  const right = b.split('\n');
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    if (left[i] !== right[i]) {
      return i + 1;
    }
  }
  return length;
}

export interface PageResult {
  problems: string[];
  stats: { blocks: number; regions: number; none: number };
  /** With `write`: the page with every fixable block refreshed. */
  output?: string;
}

/**
 * Checks the code blocks of one page against their sources. `read(path)` returns a source
 * file (by its path from the repository root), or `undefined` when there is none.
 */
export function checkPage(
  markdown: string,
  page: string,
  read: (path: string) => string | undefined,
  o: { write?: boolean } = {},
): PageResult {
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const problems: string[] = [];
  const stats = { blocks: 0, regions: 0, none: 0 };
  let blocks: Block[];
  try {
    blocks = findBlocks(markdown);
  } catch (error) {
    return {
      problems: [`${page}: ${(error as Error).message}`],
      stats,
    };
  }
  for (const code of findUnfencedCode(markdown)) {
    problems.push(
      code.kind === 'pre'
        ? `${page}:${code.line}: a <pre> block: write a fenced block with a snippet marker instead`
        : `${page}:${code.line}: an indented code block: write a fenced block with a snippet marker instead (or indent the line less)`,
    );
  }
  const regionsOf = new Map<string, Map<string, string> | Error | undefined>();
  const regions = (path: string): Map<string, string> | Error | undefined => {
    if (!regionsOf.has(path)) {
      const source = read(path);
      let parsed: Map<string, string> | Error | undefined;
      try {
        parsed = source === undefined ? undefined : parseRegions(source, path);
      } catch (error) {
        parsed = error as Error;
      }
      regionsOf.set(path, parsed);
    }
    return regionsOf.get(path);
  };
  // Replacements, applied from the last block up so earlier indexes stay valid.
  const replacements: { start: number; end: number; lines: string[] }[] = [];
  for (const block of blocks) {
    stats.blocks += 1;
    const at = `${page}:${block.line}`;
    const marker = block.marker;
    if (marker === undefined || marker.kind === 'malformed') {
      problems.push(
        `${at}: a code block with no snippet marker above it: add <!-- snippet: <path>#<region> --> (or <!-- snippet: none --> for a short shell or JSON block)`,
      );
      continue;
    }
    if (marker.kind === 'none') {
      stats.none += 1;
      if (!NONE_LANGS.has(block.lang)) {
        problems.push(
          `${at}: \`none\` is only for a shell or JSON block (sh, bash, shell, console, json), not ${block.lang === '' ? 'a block without a language' : `\`${block.lang}\``}: copy it from a region instead`,
        );
      }
      continue;
    }
    stats.regions += 1;
    const source = `${marker.path}#${marker.region}`;
    if (!isAllowedSource(marker.path)) {
      problems.push(
        `${at}: ${marker.path} is not docs-only code or a test (docs/snippets/, test/ or e2e/ folders, *.test.ts)`,
      );
      continue;
    }
    const found = regions(marker.path);
    if (found === undefined) {
      problems.push(`${at}: ${marker.path} does not exist`);
      continue;
    }
    if (found instanceof Error) {
      problems.push(`${at}: ${found.message}`);
      continue;
    }
    const region = found.get(marker.region);
    if (region === undefined) {
      problems.push(`${at}: no region "${marker.region}" in ${marker.path}`);
      continue;
    }
    const want = dedent(region);
    const have = dedent(block.content);
    if (want === have) {
      continue;
    }
    if (o.write === true) {
      replacements.push({
        start: block.start,
        end: block.end,
        lines: want
          .split('\n')
          .map((line) => (line === '' ? '' : `${block.indent}${line}`)),
      });
      continue;
    }
    problems.push(
      `${at}: the block differs from ${source} (first at line ${firstDifference(want, have)} of the block): run \`pnpm -C scripts docs-snippets --write\`, or fix the region`,
    );
  }
  if (o.write !== true) {
    return { problems, stats };
  }
  for (const r of replacements.reverse()) {
    lines.splice(r.start, r.end - r.start, ...r.lines);
  }
  return { problems, stats, output: lines.join(eol) };
}

/** The pages of the check: Markdown under `docs/`, without the skipped folders. */
export function listPages(root: string): string[] {
  const docs = join(root, 'docs');
  const pages: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        const top = relative(docs, path).split(sep)[0] ?? '';
        if (!SKIPPED_DIRS.includes(top)) {
          walk(path);
        }
      } else if (entry.endsWith('.md')) {
        pages.push(relative(root, path).split(sep).join('/'));
      }
    }
  };
  walk(docs);
  return pages;
}

/** Checks (or with `write`, refreshes) every page. Returns the problems and the totals. */
export function run(root: string, o: { write?: boolean } = {}) {
  const read = (path: string): string | undefined => {
    try {
      return readFileSync(join(root, path), 'utf8');
    } catch {
      return undefined;
    }
  };
  const problems: string[] = [];
  const totals = { pages: 0, blocks: 0, regions: 0, none: 0, written: 0 };
  for (const page of listPages(root)) {
    const markdown = readFileSync(join(root, page), 'utf8');
    const result = checkPage(markdown, page, read, o);
    totals.pages += 1;
    totals.blocks += result.stats.blocks;
    totals.regions += result.stats.regions;
    totals.none += result.stats.none;
    problems.push(...result.problems);
    if (result.output !== undefined && result.output !== markdown) {
      writeFileSync(join(root, page), result.output);
      totals.written += 1;
    }
  }
  return { problems, totals };
}

function main(): void {
  const write = process.argv.includes('--write');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { problems, totals } = run(root, { write });
  for (const problem of problems) {
    console.error(problem);
  }
  const summary = `docs-snippets: ${totals.blocks} code blocks in ${totals.pages} pages (${totals.regions} from regions, ${totals.none} marked none)${write ? `, ${totals.written} pages refreshed` : ''}`;
  if (problems.length > 0) {
    console.error(`${summary}: ${problems.length} problem(s)`);
    process.exitCode = 1;
    return;
  }
  console.log(`${summary}: OK`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
