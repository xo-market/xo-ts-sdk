// The site manifest (docs/site.json) and the converter of one page of docs/ from GitHub Markdown to
// Mintlify MDX. Pure functions: nothing here reads a file. They build the "TypeScript SDK" tab of
// docs.xo.market from the pages of docs/.
//
// The manifest lists the hand-written pages: the groups of the sidebar, in order, each with its
// pages (a source under docs/, a slug, a description and optional extras). The generated reference
// is not in it.
//
// `convertPage` turns one page into MDX, which reads `{`, `<` and HTML comments as code:
//
//   1. the H1 line becomes the `title` of the frontmatter;
//   2. HTML comments are dropped (the snippet markers), and `{`, `}` and `<` are escaped in prose;
//      fenced code, inline code and the escapes already written (`\<`) are left as they are. Two
//      comments are directives first: `<!-- cards: <icon>, ... -->` above a list makes it cards,
//      and `<!-- code-group -->` above fenced blocks makes them tabs;
//   3. the links go to the paths of the site (a page in the manifest), the generated reference
//      (through the resolver) or the file on GitHub (which the caller says is in the repository,
//      with `repoFileExists`: nothing here reads a file);
//   4. GitHub alerts (`> [!NOTE]`) become components, a `cards` list becomes a CardGroup, a
//      `code-group` run of fenced blocks becomes a CodeGroup, and each run of numbered headings
//      (`## 1. Install`, `## 2. Sign in`) becomes Steps;
//   5. the frontmatter and a note that the page is generated go on top.
//
// The components are added after the escaping, so they are never escaped.

import { posix } from 'node:path';

/** One page of the tab. `source` is a Markdown file under docs/, such as `guides/smart-wallets.md`. */
export interface SitePage {
  source: string;
  /** The path under the tab's root: `guides/smart-wallets` is served at `/typescript-sdk/guides/smart-wallets`. */
  slug: string;
  /** The title in the sidebar, when it differs from the H1 of the page. */
  sidebarTitle?: string;
  description: string;
  icon?: string;
}

export interface SiteGroup {
  group: string;
  icon: string;
  pages: SitePage[];
}

export interface SiteManifest {
  tab: 'TypeScript SDK';
  root: 'typescript-sdk';
  insertAfter: 'Data API reference';
  repo: 'https://github.com/xo-market/xo-ts-sdk/blob/main';
  groups: SiteGroup[];
}

/**
 * Answers the site path (with its anchor) of a link into the generated reference, or `undefined`
 * when there is no such page. It receives the repository path with the `docs/` prefix, such as
 * `docs/reference/client/classes/Session.md`, and the anchor without `#`.
 */
export type LinkResolver = (
  repoPath: string,
  anchor: string | undefined,
) => string | undefined;

// -- The manifest ---------------------------------------------------------------------------------

const TAB = 'TypeScript SDK';
const ROOT = 'typescript-sdk';
const INSERT_AFTER = 'Data API reference';
const REPO = 'https://github.com/xo-market/xo-ts-sdk/blob/main';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

type Fields = Record<string, unknown>;

function asObject(value: unknown, where: string): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  return value as Fields;
}

function asArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${where} must be an array`);
  }
  return value;
}

function noOtherFields(fields: Fields, known: string[], where: string): void {
  for (const key of Object.keys(fields)) {
    if (!known.includes(key)) {
      throw new Error(`${where}: unknown field "${key}"`);
    }
  }
}

function textField(fields: Fields, key: string, where: string): string {
  const value = fields[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${where}.${key} must be a non-empty string`);
  }
  return value;
}

function optionalTextField(
  fields: Fields,
  key: string,
  where: string,
): string | undefined {
  return fields[key] === undefined ? undefined : textField(fields, key, where);
}

function exactField<T extends string>(
  fields: Fields,
  key: string,
  expected: T,
): T {
  if (fields[key] !== expected) {
    throw new Error(`site.json: ${key} must be ${JSON.stringify(expected)}`);
  }
  return expected;
}

function readPage(
  value: unknown,
  where: string,
  seen: { sources: Map<string, string>; slugs: Map<string, string> },
): SitePage {
  const fields = asObject(value, where);
  noOtherFields(
    fields,
    ['source', 'slug', 'sidebarTitle', 'description', 'icon'],
    where,
  );
  const source = textField(fields, 'source', where);
  if (
    !source.endsWith('.md') ||
    source.startsWith('/') ||
    source.startsWith('docs/') ||
    source.split('/').includes('..')
  ) {
    throw new Error(
      `${where}.source must be the path of a Markdown file under docs/, such as guides/x.md: ${source}`,
    );
  }
  const slug = textField(fields, 'slug', where);
  if (!SLUG.test(slug)) {
    throw new Error(
      `${where}.slug must be lower-case words joined by hyphens, and slashes between folders: ${slug}`,
    );
  }
  if (slug === 'index' || slug.endsWith('/index')) {
    // Mintlify serves an index page at the path of its folder, so `/typescript-sdk/index` breaks.
    throw new Error(
      `${where}.slug must not be index: Mintlify serves an index page at the folder path`,
    );
  }
  const sameSource = seen.sources.get(source);
  if (sameSource !== undefined) {
    throw new Error(`duplicate source ${source}: ${sameSource} and ${where}`);
  }
  const sameSlug = seen.slugs.get(slug);
  if (sameSlug !== undefined) {
    throw new Error(`duplicate slug ${slug}: ${sameSlug} and ${where}`);
  }
  seen.sources.set(source, where);
  seen.slugs.set(slug, where);

  const sidebarTitle = optionalTextField(fields, 'sidebarTitle', where);
  const icon = optionalTextField(fields, 'icon', where);
  return {
    source,
    slug,
    ...(sidebarTitle === undefined ? {} : { sidebarTitle }),
    description: textField(fields, 'description', where),
    ...(icon === undefined ? {} : { icon }),
  };
}

/**
 * Checks the parsed JSON of docs/site.json and returns it typed. Throws, naming the field, on a
 * missing or unknown field, a value of the wrong type, a duplicate source or slug, and a slug
 * that is `index`.
 */
export function readManifest(json: unknown): SiteManifest {
  const top = asObject(json, 'site.json');
  noOtherFields(
    top,
    ['tab', 'root', 'insertAfter', 'repo', 'groups'],
    'site.json',
  );
  const seen = {
    sources: new Map<string, string>(),
    slugs: new Map<string, string>(),
  };
  return {
    tab: exactField(top, 'tab', TAB),
    root: exactField(top, 'root', ROOT),
    insertAfter: exactField(top, 'insertAfter', INSERT_AFTER),
    repo: exactField(top, 'repo', REPO),
    groups: asArray(top.groups, 'groups').map((value, index) => {
      const where = `groups[${index}]`;
      const fields = asObject(value, where);
      noOtherFields(fields, ['group', 'icon', 'pages'], where);
      return {
        group: textField(fields, 'group', where),
        icon: textField(fields, 'icon', where),
        pages: asArray(fields.pages, `${where}.pages`).map((page, at) =>
          readPage(page, `${where}.pages[${at}]`, seen),
        ),
      };
    }),
  };
}

/**
 * The slug of a source: `README.md` is `overview`, any other page its path without `.md`. Never
 * `index`: Mintlify serves an index page at the folder path, which breaks `/typescript-sdk/index`.
 */
export function slugOf(source: string): string {
  return source === 'README.md' ? 'overview' : source.replace(/\.md$/, '');
}

// -- Fenced code, inline code and comments --------------------------------------------------------

interface Segment {
  fenced: boolean;
  /** Whole lines, each with its newline (the last may lack it). */
  text: string;
}

/** A fence line: after the marks of a quote (`>`), 3 or more backticks or tildes, then the rest. */
const FENCE = /^(?:[ \t]*>)*[ \t]*(`{3,}|~{3,})(.*)$/;

/** Splits Markdown into fenced code blocks (fences included) and the text between them. */
function splitFences(markdown: string): Segment[] {
  const segments: Segment[] = [];
  const lines = markdown.split('\n');
  let pending = '';
  let open: { mark: string; length: number } | undefined;
  const flush = (fenced: boolean) => {
    if (pending !== '') {
      segments.push({ fenced, text: pending });
    }
    pending = '';
  };
  lines.forEach((line, index) => {
    const withNewline = index < lines.length - 1 ? `${line}\n` : line;
    const fence = FENCE.exec(line);
    const run = fence?.[1] ?? '';
    const rest = fence?.[2] ?? '';
    if (open === undefined) {
      // A backtick fence has no backtick in its info string: ```a``` is code on one line.
      if (fence !== null && !(run.startsWith('`') && rest.includes('`'))) {
        flush(false);
        open = { mark: run.charAt(0), length: run.length };
      }
      pending += withNewline;
      return;
    }
    pending += withNewline;
    if (
      fence !== null &&
      run.charAt(0) === open.mark &&
      run.length >= open.length &&
      rest.trim() === ''
    ) {
      flush(true);
      open = undefined;
    }
  });
  flush(open !== undefined);
  return segments;
}

/** Applies `fn` to the text between the fenced blocks; the blocks stay as they are. */
export function mapProse(
  markdown: string,
  fn: (prose: string) => string,
): string {
  return splitFences(markdown)
    .map((segment) => (segment.fenced ? segment.text : fn(segment.text)))
    .join('');
}

interface Piece {
  kind: 'text' | 'code' | 'comment';
  text: string;
}

/** The start of the next run of exactly `length` backticks, or -1. */
function closingRun(text: string, from: number, length: number): number {
  let i = from;
  while (i < text.length) {
    if (text.charAt(i) !== '`') {
      i += 1;
      continue;
    }
    let end = i;
    while (text.charAt(end) === '`') {
      end += 1;
    }
    if (end - i === length) {
      return i;
    }
    i = end;
  }
  return -1;
}

/**
 * Splits text that has no fenced block into code spans, HTML comments and the text between them.
 * A backslash escapes the next character, so `\`` opens no span; a span ends with a run of as
 * many backticks as it began with and never runs over a blank line; a backtick inside a comment
 * opens no span, nor a comment inside a span.
 */
function inlinePieces(text: string): Piece[] {
  const pieces: Piece[] = [];
  let pending = '';
  const emit = (kind: Piece['kind'], piece: string) => {
    if (pending !== '') {
      pieces.push({ kind: 'text', text: pending });
      pending = '';
    }
    pieces.push({ kind, text: piece });
  };
  let i = 0;
  while (i < text.length) {
    const char = text.charAt(i);
    if (char === '\\') {
      pending += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (char === '`') {
      let end = i;
      while (text.charAt(end) === '`') {
        end += 1;
      }
      const length = end - i;
      const close = closingRun(text, end, length);
      if (close !== -1 && !/\n[ \t]*\n/.test(text.slice(end, close))) {
        emit('code', text.slice(i, close + length));
        i = close + length;
      } else {
        pending += text.slice(i, end);
        i = end;
      }
      continue;
    }
    if (text.startsWith('<!--', i)) {
      const close = text.indexOf('-->', i + 4);
      if (close !== -1) {
        emit('comment', text.slice(i, close + 3));
        i = close + 3;
        continue;
      }
    }
    pending += char;
    i += 1;
  }
  if (pending !== '') {
    pieces.push({ kind: 'text', text: pending });
  }
  return pieces;
}

/**
 * Drops the comments. One that is alone on its line takes the line with it, and a blank line
 * too when its neighbours are both blank, so a marker above a fence leaves no gap.
 */
function withoutComments(pieces: Piece[]): Piece[] {
  const kept: Piece[] = [];
  const rest = pieces.map((piece) => ({ ...piece }));
  rest.forEach((piece, index) => {
    if (piece.kind !== 'comment') {
      kept.push(piece);
      return;
    }
    const before = kept.map((p) => p.text).join('');
    const next = rest[index + 1];
    const alone =
      /(?:^|\n)[ \t]*$/.test(before) &&
      (next === undefined ||
        (next.kind === 'text' && /^[ \t]*(?:\n|$)/.test(next.text)));
    if (!alone) {
      return;
    }
    const last = kept[kept.length - 1];
    if (last?.kind === 'text') {
      last.text = last.text.replace(/[ \t]*$/, '');
    }
    if (next !== undefined) {
      const blankBefore = /(?:^|\n)[ \t]*\n$/.test(
        before.replace(/[ \t]*$/, ''),
      );
      next.text = next.text.replace(/^[ \t]*\n?/, '');
      if (blankBefore) {
        next.text = next.text.replace(/^[ \t]*\n/, '');
      }
    }
  });
  return kept;
}

/**
 * Applies `fn` to the text of a segment without a fenced block, outside its code spans, after
 * dropping the comments. `atLineStart` tells whether the text starts a line.
 */
function mapText(
  segment: string,
  fn: (text: string, atLineStart: boolean) => string,
): string {
  let out = '';
  for (const piece of withoutComments(inlinePieces(segment))) {
    out +=
      piece.kind === 'code'
        ? piece.text
        : fn(piece.text, out === '' || out.endsWith('\n'));
  }
  return out;
}

// -- Escaping -------------------------------------------------------------------------------------

/** Reads the backslash escapes of Markdown: `\_` is `_`. */
export function unescapeMarkdown(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

/**
 * The index of the `>` that closes the angle-bracket destination `<...>` opened at `open`, or -1
 * when it does not close on that line (a destination holds no `<` and no line break).
 */
function angleDestinationEnd(text: string, open: number): number {
  let i = open + 1;
  while (i < text.length) {
    const char = text.charAt(i);
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (char === '>') {
      return i;
    }
    if (char === '<' || char === '\n') {
      return -1;
    }
    i += 1;
  }
  return -1;
}

/** What comes before the destination of a link definition, `[label]: `, alone on its line. */
const DEFINITION_HEAD = /^[ \t]*(?:>[ \t]*)*\[[^\]\n]+\]:[ \t]*$/;

/** Whether the `<` at `index` opens an angle-bracket destination: after `](`, or after `[label]:`. */
function opensDestination(
  text: string,
  index: number,
  atLineStart: boolean,
): boolean {
  if (text.slice(Math.max(0, index - 2), index) === '](') {
    return true;
  }
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  return (
    (lineStart > 0 || atLineStart) &&
    DEFINITION_HEAD.test(text.slice(lineStart, index))
  );
}

const URI_AUTOLINK = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/y;
const EMAIL_AUTOLINK =
  /<([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)>/y;
const ESM_START = /^(import|export)(?=[\s{*])/;

function autolinkAt(text: string, index: number): [string, number] | undefined {
  URI_AUTOLINK.lastIndex = index;
  const uri = URI_AUTOLINK.exec(text);
  if (uri !== null) {
    return [`[${uri[1]}](${uri[1]})`, uri[0].length];
  }
  EMAIL_AUTOLINK.lastIndex = index;
  const email = EMAIL_AUTOLINK.exec(text);
  if (email !== null) {
    return [`[${email[1]}](mailto:${email[1]})`, email[0].length];
  }
  return undefined;
}

function escapeText(text: string, atLineStart: boolean): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const char = text.charAt(i);
    if (char === '\\') {
      // An escape already written: the next character stays as it is.
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (char === '{' || char === '}') {
      out += `\\${char}`;
    } else if (char === '<') {
      // An angle-bracket destination, `[a](<my file.md>)`, is not text: it keeps its brackets.
      const close = opensDestination(text, i, atLineStart)
        ? angleDestinationEnd(text, i)
        : -1;
      if (close !== -1) {
        out += `<${escapeText(text.slice(i + 1, close), false)}>`;
        i = close + 1;
        continue;
      }
      const autolink = autolinkAt(text, i);
      if (autolink !== undefined) {
        out += autolink[0];
        i += autolink[1];
        continue;
      }
      out += '&lt;';
    } else if (
      (i === 0 ? atLineStart : text.charAt(i - 1) === '\n') &&
      ESM_START.test(text.slice(i, i + 7))
    ) {
      // MDX reads a block that starts with `import` or `export` as JavaScript.
      out += char === 'i' ? '&#105;' : '&#101;';
    } else {
      out += char;
    }
    i += 1;
  }
  return out;
}

/**
 * Makes Markdown prose valid MDX: drops the HTML comments, escapes `{`, `}` and `<` (an autolink
 * `<https://x.y>` becomes a link), and keeps what is code: fenced blocks, inline code, and the
 * backslash escapes already there. A block that starts with `import` or `export` is changed so
 * that MDX does not read it as JavaScript.
 */
export function escapeProse(markdown: string): string {
  return mapProse(markdown, (prose) => mapText(prose, escapeText));
}

// -- Links ----------------------------------------------------------------------------------------

/**
 * Calls `rewrite` on the destination of every inline link `](dest "title")` of the text, written
 * as it is in the text (escapes included): `rewrite` answers the destination to put there. An
 * angle-bracket destination, `](<my file.md>)`, keeps its brackets when `rewrite` leaves it as it is.
 */
function rewriteDestinations(
  text: string,
  rewrite: (dest: string) => string,
): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const char = text.charAt(i);
    if (char === '\\') {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (char === ']' && text.charAt(i + 1) === '(') {
      const start = i + 2;
      const close =
        text.charAt(start) === '<' ? angleDestinationEnd(text, start) : -1;
      if (close !== -1) {
        const dest = text.slice(start + 1, close);
        const target = rewrite(dest);
        out += `](${target === dest ? `<${dest}>` : target}`;
        i = close + 1;
        continue;
      }
      let end = start;
      let depth = 0;
      while (end < text.length) {
        const c = text.charAt(end);
        if (c === '\\') {
          end += 2;
          continue;
        }
        if (/\s/.test(c) || (c === ')' && depth === 0)) {
          break;
        }
        depth += c === '(' ? 1 : c === ')' ? -1 : 0;
        end += 1;
      }
      out += `](${rewrite(text.slice(start, end))}`;
      i = end;
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

/** A link definition: `[label]: dest` (or `<dest>`), then a title or nothing, alone on a line. */
const DEFINITION =
  /^([ \t]*(?:>[ \t]*)*\[[^\]\n]+\]:[ \t]*)(<[^>\n]*>|[^\s<]\S*)((?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*)$/;

/**
 * Calls `rewrite` on the destination of every link definition of the text, as for
 * `rewriteDestinations`. A definition starts a line (the first line of the text only when
 * `atLineStart`); a line like "[Note]: remember to" is text, since more than a title follows.
 */
function rewriteDefinitions(
  text: string,
  atLineStart: boolean,
  rewrite: (dest: string) => string,
): string {
  return text
    .split('\n')
    .map((line, index) => {
      const match = index === 0 && !atLineStart ? null : DEFINITION.exec(line);
      if (match === null) {
        return line;
      }
      const [, head = '', dest = '', tail = ''] = match;
      if (dest.startsWith('<')) {
        const inner = dest.slice(1, -1);
        const target = rewrite(inner);
        return `${head}${target === inner ? dest : target}${tail}`;
      }
      return `${head}${rewrite(dest)}${tail}`;
    })
    .join('\n');
}

/**
 * Calls `rewrite` on the destination of every link of the Markdown, inline (`](dest)`) or a
 * definition (`[label]: dest`), outside fenced and inline code: it gets the destination as
 * written (escapes included) and answers the one to put there.
 */
export function rewriteLinks(
  markdown: string,
  rewrite: (dest: string) => string,
): string {
  return mapProse(markdown, (prose) =>
    mapText(prose, (text, atLineStart) =>
      rewriteDefinitions(
        rewriteDestinations(text, rewrite),
        atLineStart,
        rewrite,
      ),
    ),
  );
}

/** Encodes what would end or break a destination in Markdown or MDX: spaces, `()`, `<>`, `{}`. */
function encodeAddress(address: string): string {
  return address.replace(
    /[\s(){}<>]/g,
    (char) =>
      `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

/** Whether a path from the root of the repository (`examples/scripts/src/list-markets.ts`, or `examples/mm-bot/`) is there. */
export type RepoFileCheck = (repoPath: string) => boolean;

/**
 * The site path, GitHub address or reference path of a link written in the page `source`. `raw`
 * is the destination as written (with its backslash escapes); a destination that needs no change
 * (an address, an anchor, a path of the site) comes back as `raw`.
 */
function linkTarget(
  raw: string,
  o: {
    source: string;
    pages: Map<string, SitePage>;
    manifest: SiteManifest;
    resolveReference: LinkResolver;
    repoFileExists: RepoFileCheck;
  },
): string {
  const dest = unescapeMarkdown(raw);
  if (
    dest === '' ||
    dest.startsWith('#') ||
    dest.startsWith('/') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(dest)
  ) {
    return raw;
  }
  const where = `docs/${o.source}: link ${dest}`;
  const hash = dest.indexOf('#');
  const path = hash === -1 ? dest : dest.slice(0, hash);
  const anchor = hash === -1 ? undefined : dest.slice(hash + 1) || undefined;
  const suffix = anchor === undefined ? '' : `#${anchor}`;
  if (path === '') {
    return raw;
  }
  const repoPath = posix.join('docs', posix.dirname(o.source), path);
  if (repoPath === '..' || repoPath.startsWith('../')) {
    throw new Error(`${where}: points outside the repository`);
  }
  if (repoPath.startsWith('docs/reference/')) {
    const resolved = o.resolveReference(repoPath, anchor);
    if (resolved === undefined) {
      throw new Error(`${where}: no page of the reference for ${repoPath}`);
    }
    return resolved;
  }
  if (repoPath.startsWith('docs/') && repoPath.endsWith('.md')) {
    const page = o.pages.get(repoPath.slice('docs/'.length));
    if (page === undefined) {
      throw new Error(`${where}: not in docs/site.json: ${repoPath}`);
    }
    return encodeAddress(`/${o.manifest.root}/${page.slug}${suffix}`);
  }
  // A file of the repository: the address is GitHub's, so only the repository can say it is there.
  // The anchor (`file.ts#L10`) is not part of the path.
  if (
    ![repoPath, readEscapes(repoPath)].some((path) => o.repoFileExists(path))
  ) {
    throw new Error(`${where}: no such file in the repository: ${repoPath}`);
  }
  return encodeAddress(`${o.manifest.repo}/${repoPath}${suffix}`);
}

/** `path` with its %-escapes read (`my%20file.ts` is `my file.ts`), or as written when they are not valid. */
function readEscapes(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

// -- Components -----------------------------------------------------------------------------------

const ALERTS: Record<string, string> = {
  NOTE: 'Note',
  TIP: 'Tip',
  IMPORTANT: 'Info',
  WARNING: 'Warning',
  CAUTION: 'Warning',
};

const ALERT_START = /^([ \t]*)>[ \t]?\[!([A-Za-z]+)\][ \t]*$/;
const QUOTE = /^[ \t]*>/;

/** Converts the alerts of text without a fenced block; `openAtEnd` says the last one reaches its end. */
function alertsOf(
  text: string,
  where: string,
): { text: string; openAtEnd: boolean } {
  const lines = text.split('\n');
  const out: string[] = [];
  let openAtEnd = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const start = ALERT_START.exec(line);
    if (start === null) {
      out.push(line);
      continue;
    }
    const type = start[2] ?? '';
    const component = ALERTS[type.toUpperCase()];
    if (component === undefined) {
      throw new Error(
        `${where}: unknown alert [!${type}]; use NOTE, TIP, IMPORTANT, WARNING or CAUTION`,
      );
    }
    const indent = start[1] ?? '';
    const content: string[] = [];
    let j = i + 1;
    while (j < lines.length && QUOTE.test(lines[j] ?? '')) {
      content.push((lines[j] ?? '').replace(/^[ \t]*>[ \t]?/, ''));
      j += 1;
    }
    if (content.some((c) => FENCE.test(c))) {
      throw new Error(
        `${where}: a code block inside an alert is not supported; put it after the alert`,
      );
    }
    while (content.length > 0 && (content[0] ?? '').trim() === '') {
      content.shift();
    }
    while (
      content.length > 0 &&
      (content[content.length - 1] ?? '').trim() === ''
    ) {
      content.pop();
    }
    // A component is a block of its own: a blank line before it, and after it.
    if (out.length > 0 && (out[out.length - 1] ?? '').trim() !== '') {
      out.push('');
    }
    out.push(`${indent}<${component}>`);
    for (const c of content) {
      out.push(c.trim() === '' ? '' : `${indent}${c}`);
    }
    out.push(`${indent}</${component}>`);
    if (j < lines.length && (lines[j] ?? '').trim() !== '') {
      out.push('');
    }
    openAtEnd =
      j >= lines.length || (j === lines.length - 1 && lines[j] === '');
    i = j - 1;
  }
  return { text: out.join('\n'), openAtEnd };
}

/** Turns the GitHub alerts (`> [!NOTE]`) into Mintlify components. Not applied to fenced code. */
function convertAlerts(markdown: string, where: string): string {
  const segments = splitFences(markdown);
  return segments
    .map((segment, index) => {
      if (segment.fenced) {
        return segment.text;
      }
      const converted = alertsOf(segment.text, where);
      const next = segments[index + 1];
      if (
        converted.openAtEnd &&
        next?.fenced === true &&
        QUOTE.test(next.text)
      ) {
        throw new Error(
          `${where}: a code block inside an alert is not supported; put it after the alert`,
        );
      }
      return converted.text;
    })
    .join('');
}

const BULLET = /^[-*+][ \t]+/;
const CARD_ITEM = /^\*\*\[([^\]]+)\]\(([^)\s]+)\)\*\*:[ \t]+(\S.*)$/;

function plain(markdown: string): string {
  return unescapeMarkdown(markdown.replace(/`+/g, '')).trim();
}

function attribute(value: string): string {
  return value.replaceAll('"', '&quot;');
}

/** The lines of the Markdown, each with whether it is part of a fenced block (its fences included). */
function linesOf(markdown: string): { text: string; fenced: boolean }[] {
  const lines: { text: string; fenced: boolean }[] = [];
  for (const segment of splitFences(markdown)) {
    const parts = segment.text.split('\n');
    if (segment.text.endsWith('\n')) {
      parts.pop();
    }
    for (const text of parts) {
      lines.push({ text, fenced: segment.fenced });
    }
  }
  return lines;
}

function joinLines(lines: readonly string[], like: string): string {
  return `${lines.join('\n')}${like.endsWith('\n') ? '\n' : ''}`;
}

// A directive is kept through the escaping as a line of its own between two private-use
// characters, which nothing else writes and the escaping leaves alone.
const SENTINEL = '\uE000';
const DIRECTIVE =
  /^[ \t]*<!--[ \t]*(cards|code-group)(?:[ \t]*:[ \t]*(.*?))?[ \t]*-->[ \t]*$/;
const DIRECTIVE_LINE = new RegExp(
  `^${SENTINEL}(cards|code-group)${SENTINEL}(.*)${SENTINEL}$`,
);

/** Turns the directive comments into sentinel lines that survive the escaping. */
function prepareDirectives(markdown: string, where: string): string {
  const out: string[] = [];
  for (const line of linesOf(markdown)) {
    if (line.fenced) {
      out.push(line.text);
      continue;
    }
    const directive = DIRECTIVE.exec(line.text);
    if (directive === null) {
      if (/<!--[ \t]*(cards|code-group)\b/.test(line.text)) {
        throw new Error(
          `${where}: a cards or code-group comment must be alone on its line: ${line.text.trim()}`,
        );
      }
      out.push(line.text);
      continue;
    }
    const [, kind = '', args = ''] = directive;
    if (kind === 'cards' && args.trim() === '') {
      throw new Error(
        `${where}: a cards comment names an icon per card: <!-- cards: a, b -->`,
      );
    }
    out.push(`${SENTINEL}${kind}${SENTINEL}${args.trim()}${SENTINEL}`);
  }
  return joinLines(out, markdown);
}

/** The card list that starts at `start`: its items (a wrapped item joined), and the line after it. */
function cardItems(
  lines: readonly string[],
  start: number,
): { items: string[]; end: number } {
  let i = start;
  while (i < lines.length && (lines[i] ?? '').trim() === '') {
    i += 1;
  }
  const items: string[] = [];
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (BULLET.test(line)) {
      items.push(line.replace(BULLET, '').trim());
      i += 1;
    } else if (line.trim() === '') {
      let next = i;
      while (next < lines.length && (lines[next] ?? '').trim() === '') {
        next += 1;
      }
      if (next < lines.length && BULLET.test(lines[next] ?? '')) {
        i = next;
      } else {
        break;
      }
    } else if (items.length > 0 && !/^#{1,6}[ \t]/.test(line)) {
      // An item that wraps onto the next line.
      items[items.length - 1] += ` ${line.trim()}`;
      i += 1;
    } else {
      break;
    }
  }
  return { items, end: i };
}

/**
 * Turns the list after each `cards` directive into a CardGroup: each item
 * `- **[Title](page.md)**: Description` is a card, with the icon of its position.
 */
function convertCards(markdown: string, where: string): string {
  return mapProse(markdown, (prose) => {
    const lines = prose.split('\n');
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const directive = DIRECTIVE_LINE.exec(lines[i] ?? '');
      if (directive === null || directive[1] !== 'cards') {
        out.push(lines[i] ?? '');
        i += 1;
        continue;
      }
      const icons = (directive[2] ?? '').split(',').map((icon) => icon.trim());
      const { items, end } = cardItems(lines, i + 1);
      if (items.length === 0) {
        throw new Error(`${where}: no list after a cards comment`);
      }
      if (items.length !== icons.length) {
        const n = items.length;
        const m = icons.length;
        throw new Error(
          `${where}: a cards list has ${n} ${n === 1 ? 'item' : 'items'} but its comment names ${m} ${m === 1 ? 'icon' : 'icons'}`,
        );
      }
      const group = items.map((item, index) => {
        const match = CARD_ITEM.exec(item);
        if (match === null) {
          throw new Error(
            `${where}: a card item must look like "- **[Title](page.md)**: Description": ${item}`,
          );
        }
        const title = attribute(plain(match[1] ?? ''));
        const icon = attribute(icons[index] ?? '');
        return `  <Card title="${title}" icon="${icon}" href="${attribute(match[2] ?? '')}">${match[3]}</Card>`;
      });
      while (out.length > 0 && (out[out.length - 1] ?? '').trim() === '') {
        out.pop();
      }
      out.push(
        ...(out.length > 0 ? [''] : []),
        '<CardGroup cols={2}>',
        ...group,
        '</CardGroup>',
        ...(end < lines.length && (lines[end] ?? '').trim() !== '' ? [''] : []),
      );
      i = end;
    }
    return out.join('\n');
  });
}

/**
 * Wraps the fenced blocks after each `code-group` directive in a CodeGroup: the blocks that
 * follow it with only blank lines between them, at least two, each with a title for its tab.
 */
function convertCodeGroups(markdown: string, where: string): string {
  const lines = linesOf(markdown);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as { text: string; fenced: boolean };
    const directive = line.fenced ? null : DIRECTIVE_LINE.exec(line.text);
    if (directive === null || directive[1] !== 'code-group') {
      out.push(line.text);
      i += 1;
      continue;
    }
    const blocks: string[][] = [];
    let j = i + 1;
    let end = j;
    while (j < lines.length) {
      const next = lines[j] as { text: string; fenced: boolean };
      if (!next.fenced && next.text.trim() === '') {
        j += 1;
        continue;
      }
      if (!next.fenced) {
        break;
      }
      const block: string[] = [];
      while (j < lines.length && (lines[j] as { fenced: boolean }).fenced) {
        block.push((lines[j] as { text: string }).text);
        j += 1;
        // A fence closes the block it opened: the next fenced line opens another one.
        if (block.length > 1 && FENCE.test(block[block.length - 1] ?? '')) {
          break;
        }
      }
      blocks.push(block);
      end = j;
    }
    if (blocks.length < 2) {
      throw new Error(
        `${where}: a code-group comment needs two or more code blocks after it`,
      );
    }
    for (const block of blocks) {
      const open = /^[ \t]*(?:`{3,}|~{3,})[^\s`]*[ \t]+(\S.*)$/.exec(
        block[0] ?? '',
      );
      if (open === null) {
        throw new Error(
          `${where}: each block of a code group needs a title for its tab, such as \`\`\`sh npm: ${block[0]?.trim()}`,
        );
      }
    }
    while (out.length > 0 && (out[out.length - 1] ?? '').trim() === '') {
      out.pop();
    }
    out.push(
      ...(out.length > 0 ? [''] : []),
      '<CodeGroup>',
      ...blocks.flatMap((block) => [...block]),
      '</CodeGroup>',
    );
    i = end;
    if (i < lines.length && (lines[i]?.text ?? '').trim() !== '') {
      out.push('');
    }
  }
  return joinLines(out, markdown);
}

/** A numbered step heading: `## 1. Title`. */
const STEP = /^##[ \t]+(\d+)\.[ \t]+(\S.*?)(?:[ \t]+#+)?[ \t]*$/;
const HEADING = /^#{1,6}[ \t]/;

/**
 * Turns each run of numbered `##` headings (`## 1. Install`, `## 2. Sign in`, ...) into a Steps
 * component, one Step per heading, titled with the heading's text. A run ends at the next other
 * heading of level 1 or 2, or at the end of the page. The numbers start at 1 and go up by one,
 * and a step holds no heading of its own: either is an error.
 */
function convertSteps(markdown: string, where: string): string {
  const lines: { text: string; fenced: boolean }[] = [];
  for (const segment of splitFences(markdown)) {
    const parts = segment.text.split('\n');
    if (segment.text.endsWith('\n')) {
      parts.pop();
    }
    for (const text of parts) {
      lines.push({ text, fenced: segment.fenced });
    }
  }
  const out: string[] = [];
  const trimBlank = () => {
    while (out.length > 0 && (out[out.length - 1] ?? '').trim() === '') {
      out.pop();
    }
  };
  let step = 0;
  let skipBlank = false;
  for (const line of lines) {
    if (skipBlank && line.text.trim() === '') {
      continue;
    }
    skipBlank = false;
    const match = line.fenced ? null : STEP.exec(line.text);
    if (match !== null) {
      const number = Number(match[1]);
      if (number !== step + 1) {
        throw new Error(
          `${where}: the step "${line.text}" should be number ${step + 1}`,
        );
      }
      trimBlank();
      if (step === 0) {
        out.push(...(out.length > 0 ? [''] : []), '<Steps>');
      } else {
        out.push('', '</Step>');
      }
      out.push(`<Step title="${attribute(plain(match[2] ?? ''))}">`, '');
      step = number;
      skipBlank = true;
      continue;
    }
    if (step > 0 && !line.fenced && HEADING.test(line.text)) {
      if (!/^#{1,2}[ \t]/.test(line.text)) {
        throw new Error(
          `${where}: a numbered step cannot hold a heading: ${line.text}`,
        );
      }
      trimBlank();
      out.push('', '</Step>', '</Steps>', '');
      step = 0;
    }
    out.push(line.text);
  }
  if (step > 0) {
    trimBlank();
    out.push('', '</Step>', '</Steps>');
  }
  return `${out.join('\n')}${markdown.endsWith('\n') ? '\n' : ''}`;
}

// -- The page -------------------------------------------------------------------------------------

/** Takes the first H1 outside fenced code off the page: its plain text, and the page without it. */
function takeTitle(
  markdown: string,
  where: string,
): { title: string; rest: string } {
  let title: string | undefined;
  const rest = mapProse(markdown, (prose) => {
    if (title !== undefined) {
      return prose;
    }
    const lines = prose.split('\n');
    const at = lines.findIndex((line) => /^#[ \t]+\S/.test(line));
    if (at === -1) {
      return prose;
    }
    title = plain(
      (lines[at] ?? '').replace(/^#[ \t]+/, '').replace(/[ \t]+#+[ \t]*$/, ''),
    );
    const blankBefore = at === 0 || (lines[at - 1] ?? '').trim() === '';
    const blankAfter = (lines[at + 1] ?? '').trim() === '';
    lines.splice(at, blankBefore && blankAfter ? 2 : 1);
    return lines.join('\n');
  });
  if (title === undefined) {
    throw new Error(
      `${where}: the page has no H1 (a line "# Title") for its title`,
    );
  }
  return { title, rest };
}

/**
 * Converts one page of docs/ (`source`, relative to docs/, such as `guides/smart-wallets.md`) to
 * MDX, with the frontmatter from its H1 and the manifest. Links into the generated reference
 * (`docs/reference/...`) go through `resolveReference`, and `repoFileExists` says whether a file
 * the page links to (an example, a README) is in the repository. Throws, naming the page, on a
 * link to a page that is not in the manifest or that the resolver cannot place, a link to a file
 * that is not in the repository, a page without an H1, an unknown alert, a cards list
 * that does not fit its cards comment, a code group without two titled blocks, and numbered
 * steps out of order or holding a heading.
 */
export function convertPage(o: {
  source: string;
  text: string;
  manifest: SiteManifest;
  resolveReference: LinkResolver;
  repoFileExists: RepoFileCheck;
}): { slug: string; mdx: string } {
  const where = `docs/${o.source}`;
  const pages = new Map(
    o.manifest.groups.flatMap((g) => g.pages).map((p) => [p.source, p]),
  );
  const page = pages.get(o.source);
  if (page === undefined) {
    throw new Error(`not in docs/site.json: ${where}`);
  }

  const { title, rest } = takeTitle(
    prepareDirectives(o.text.replaceAll('\r\n', '\n'), where),
    where,
  );
  const context = {
    source: o.source,
    pages,
    manifest: o.manifest,
    resolveReference: o.resolveReference,
    repoFileExists: o.repoFileExists,
  };
  let body = rewriteLinks(escapeProse(rest), (dest) =>
    linkTarget(dest, context),
  );
  body = convertAlerts(body, where);
  body = convertCards(body, where);
  body = convertCodeGroups(body, where);
  body = convertSteps(body, where);
  if (body.includes(SENTINEL)) {
    throw new Error(
      `${where}: a cards or code-group comment that is not alone on its line`,
    );
  }
  return {
    slug: page.slug,
    mdx: mdxPage({
      title,
      sidebarTitle: page.sidebarTitle,
      description: page.description,
      icon: page.icon,
      source: where,
      body,
    }),
  };
}

/**
 * A page of the tab: the frontmatter, the note that it is generated from `source` (the path in
 * the repository, such as `docs/guides/smart-wallets.md`, or `docs/reference/` for the
 * reference), then the body without the blank lines around it.
 */
export function mdxPage(o: {
  title: string;
  sidebarTitle?: string | undefined;
  description?: string | undefined;
  icon?: string | undefined;
  source: string;
  body: string;
}): string {
  const field = (name: string, value: string | undefined) =>
    value === undefined ? [] : [`${name}: ${JSON.stringify(value)}`];
  const frontmatter = [
    '---',
    ...field('title', o.title),
    ...field('sidebarTitle', o.sidebarTitle),
    ...field('description', o.description),
    ...field('icon', o.icon),
    '---',
  ].join('\n');
  const note = `{/* Generated from xo-market/xo-ts-sdk ${o.source} by pnpm docs:publish. Edit it there. */}`;
  const body = o.body.replace(/^\n+/, '').trimEnd();
  return `${frontmatter}\n${note}\n${body === '' ? '' : `\n${body}`}\n`;
}
