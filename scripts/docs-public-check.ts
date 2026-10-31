// The public-content check of the docs: the pages of docs/ go to the public site docs.xo.market, so
// none may carry what stays inside XO or points at a page of the site that is out of date.
//
// A finding is one rule on one line (the first match of it). Fenced code counts, since the samples go public
// too. Rules (a page runs every one but the one marked "reference only"; a generated reference page
// runs only that one):
//
//   dev-env        the name of the non-mainnet environment as the `environment` (or `env`) of a sample
//   dev-word       that name as a word of its own, in any case
//   dev-prose      that name after "on" or "in" (reference only)
//   test+net       the word for a test network, and test-token wording: the SDK runs on mainnet only
//   ask-xo         "ask the XO team", "contact the XO team": say gm@xo.market instead
//   stale-link     a link to one of the pages of the site that are out of date
//
// Tickets and other internal terms are the repository-wide check's
// (scripts/public-check.ts), which reads every tracked file, these pages included. That check
// blocks the name and the test-network word too, so this file builds them from fragments at run
// time and never writes them whole, and one rule name is written in two pieces above.
//
// The generated reference (docs/reference/) is written from the source's TSDoc, whose words the
// repository-wide check already reads, so it runs only dev-prose, the narrowest of the three
// name rules; a page's dev-word already covers what dev-prose catches.
//
//   pnpm -C scripts docs-public-check            every page of docs/site.json, and the generated reference
//   pnpm -C scripts docs-public-check a.md b.md  only those files, as pages
//
// Prints `file:line: rule: text` for each finding (the text is what matched), exits 1 when any.
// A missing file, an invalid docs/site.json and a manifest without pages are one-line errors
// (exit 1), not findings. The run with no file is part of `pnpm run docs:check`, so CI runs it
// on every pull request.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readManifest } from './docs-site-convert.js';

/** The name of the non-mainnet environment, built from fragments (see the header). */
const ENV_NAME = `d${'ev'}`;
/** The name of the test-network rule, a word the repository-wide check blocks. */
const TEST_NETWORK_RULE = `test${'net'}` as const;

export type PublicRule =
  | 'dev-env'
  | 'dev-word'
  | 'dev-prose'
  | typeof TEST_NETWORK_RULE
  | 'ask-xo'
  | 'stale-link';

export interface PublicFinding {
  file: string;
  line: number;
  rule: PublicRule;
  /** What matched: for `stale-link`, the target of the link. */
  text: string;
}

/** The pages of the public site that are out of date: no page links to them. */
const STALE_PATHS = [
  'documentation/introduction',
  'guides/smart-accounts',
  'guides/wire-conventions',
  'guides/redeem-positions',
  'guides/market-lifecycle',
  'api-reference/introduction',
  'product/portfolio/claim-payouts',
];

interface Rule {
  rule: PublicRule;
  /** Not global: a line has one finding of a rule, however often it matches. */
  pattern: RegExp;
  /** Where it runs: on pages or on generated reference pages. */
  scope: 'page' | 'reference';
}

/** In report order, for the matches of one line. */
const RULES: readonly Rule[] = [
  {
    rule: 'dev-env',
    pattern: new RegExp(`\\benv(?:ironment)?:\\s*'${ENV_NAME}'`),
    scope: 'page',
  },
  {
    rule: 'dev-word',
    pattern: new RegExp(`\\b${ENV_NAME}\\b`, 'i'),
    scope: 'page',
  },
  {
    rule: 'dev-prose',
    pattern: new RegExp(`\\b(?:on|in) ${ENV_NAME}\\b`, 'i'),
    scope: 'reference',
  },
  {
    rule: TEST_NETWORK_RULE,
    pattern: new RegExp(`\\b${TEST_NETWORK_RULE}\\b|\\btest[ ]USDC\\b`, 'i'),
    scope: 'page',
  },
  {
    rule: 'ask-xo',
    pattern: /\b(?:ask|contact) the XO team\b/i,
    scope: 'page',
  },
  {
    // The target of an inline link: the page of the site with or without its host, then an end
    // (a closing parenthesis, an anchor, a query, a title, a trailing slash), not a longer path.
    rule: 'stale-link',
    pattern: new RegExp(
      `(?<=\\]\\()(?:https://docs\\.xo\\.market)?/(?:${STALE_PATHS.join('|')})(?=/?(?![\\w/.-]))`,
    ),
    scope: 'page',
  },
];

/**
 * The findings of one file, in line order. `page` runs every rule but `dev-prose`; `reference`
 * (a generated reference page) only `dev-prose`.
 */
export function findPublicIssues(
  path: string,
  text: string,
  scope: 'page' | 'reference',
): PublicFinding[] {
  const rules = RULES.filter((r) => r.scope === scope);
  const findings: PublicFinding[] = [];
  text.split(/\r?\n/).forEach((content, index) => {
    for (const { rule, pattern } of rules) {
      const match = pattern.exec(content);
      if (match !== null) {
        findings.push({ file: path, line: index + 1, rule, text: match[0] });
      }
    }
  });
  return findings;
}

/** A problem with what the check was asked to read, not a finding: one line, then exit 1. */
export class CheckError extends Error {}

/** The text of a file, or a `CheckError` "file not found: <shown>" when there is no such file. */
function readText(path: string, shown: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CheckError(`file not found: ${shown}`);
    }
    throw error;
  }
}

/** The pages listed in docs/site.json, as repository paths. */
function sitePages(root: string): string[] {
  const text = readText(join(root, 'docs/site.json'), 'docs/site.json');
  try {
    return readManifest(JSON.parse(text)).groups.flatMap((group) =>
      group.pages.map((page) => `docs/${page.source}`),
    );
  } catch (error) {
    throw new CheckError(
      `docs/site.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The pages of docs/site.json plus the two READMEs that go with the SDK. */
function pagesOfSite(root: string): string[] {
  const pages = sitePages(root);
  if (pages.length === 0) {
    throw new CheckError('docs/site.json lists no pages');
  }
  return [...pages, 'packages/client/README.md', 'examples/scripts/README.md'];
}

/** A path as the report shows it: relative to the repository, with slashes. */
function shownPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

/** The Markdown files under `dir`, as repository paths. */
function markdownUnder(root: string, dir: string): string[] {
  const files: string[] = [];
  const walk = (path: string) => {
    for (const entry of readdirSync(path).sort()) {
      const child = join(path, entry);
      if (statSync(child).isDirectory()) {
        walk(child);
      } else if (entry.endsWith('.md')) {
        files.push(shownPath(root, child));
      }
    }
  };
  walk(join(root, dir));
  return files;
}

/**
 * Checks `files` as pages, or with none, every page of docs/site.json plus the two READMEs that
 * go with the SDK as pages, and every file of the generated reference as `reference`. Relative
 * `files` are read from `cwd`. Throws a `CheckError` when a file is missing, docs/site.json is
 * not valid, or it lists no page.
 */
export function run(
  root: string,
  files: string[],
  cwd: string,
): { findings: PublicFinding[]; checked: number } {
  const targets: { path: string; scope: 'page' | 'reference' }[] =
    files.length > 0
      ? files.map((file) => {
          const absolute = isAbsolute(file) ? file : resolve(cwd, file);
          return { path: absolute, scope: 'page' as const };
        })
      : [
          ...pagesOfSite(root).map((path) => ({
            path: join(root, path),
            scope: 'page' as const,
          })),
          ...markdownUnder(root, 'docs/reference').map((path) => ({
            path: join(root, path),
            scope: 'reference' as const,
          })),
        ];
  const findings: PublicFinding[] = [];
  for (const { path, scope } of targets) {
    const shown = shownPath(root, path);
    findings.push(...findPublicIssues(shown, readText(path, shown), scope));
  }
  return { findings, checked: targets.length };
}

function main(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const cwd = process.env.INIT_CWD ?? process.cwd();
  let result: ReturnType<typeof run>;
  try {
    result = run(root, process.argv.slice(2), cwd);
  } catch (error) {
    if (error instanceof CheckError) {
      console.error(`docs-public-check: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  const { findings, checked } = result;
  for (const f of findings) {
    console.log(`${f.file}:${f.line}: ${f.rule}: ${f.text}`);
  }
  const summary = `docs-public-check: ${checked} file(s)`;
  if (findings.length > 0) {
    console.log(`${summary}: ${findings.length} finding(s)`);
    process.exitCode = 1;
    return;
  }
  console.log(`${summary}: OK`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
