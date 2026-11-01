// Publishes the "TypeScript SDK" tab of docs.xo.market: builds the tab from docs/ (docs-site.ts),
// writes it into a clone of the docs-site repo (a Mintlify site) on a branch sdk-docs/<version>,
// checks it with Mintlify's own CLI, and opens the pull request into external-prod-only. Merging
// that pull request is what puts the pages live.
//
// From the repository root, on the commit to publish (usually main, after a release), with a clean
// tree, `gh` logged in, and the docs site's repository in the environment variable DOCS_REPO
// (`owner/name`; required: without it the script exits with code 2 and changes nothing):
//
//   DOCS_REPO=<owner/name> pnpm docs:publish --dry-run
//                                           clone, build, check, show the diff stat; push nothing
//   pnpm docs:publish                       the same, then commit, push and open the pull request
//   pnpm docs:publish --draft               open the pull request as a draft
//   pnpm docs:publish --docs-repo <dir>     use that clone of the docs repo instead of a new one
//
// It touches nothing in the docs repo but `docs.json` (the SDK tab only) and `typescript-sdk/`,
// and refuses to go on if anything else would change (a docs.json it would reformat included).
// It never pushes to external-prod-only, and never forces a push: a branch that exists already
// gets one more commit. It prints the identity it commits as before the commit, and in a dry run.
// A dry run commits and pushes nothing, but leaves the new files staged in the clone it prints.

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSite, type MintlifyTab } from './docs-site.js';
import { readManifest } from './docs-site-convert.js';
import { parseStatus } from './release-version.js';

/**
 * The Mintlify CLI, pinned: the newest release that was at least 14 days old when this was last
 * set (4.2.1035, published 2026-10-14, chosen on 2026-10-29 from `npm view mint time --json`).
 * Raise it by hand, to a release that is at least 14 days old, when Mintlify's checks change.
 */
export const MINT_VERSION = '4.2.1035';

/** The environment variable that names the repository of the docs site, `owner/name`. */
export const DOCS_REPO_VARIABLE = 'DOCS_REPO';
/** The branch of the docs site that is live. */
export const BASE_BRANCH = 'external-prod-only';
/** This repository, which the commit and the pull request of the docs site name. */
export const SDK_REPO = 'xo-market/xo-ts-sdk';

/** A GitHub repository, `owner/name`. */
const REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/**
 * The repository of the docs site, from {@link DOCS_REPO_VARIABLE} in `env`: `{ repo }`, or
 * `{ problem }` when it is not set or not `owner/name`.
 */
export function docsRepoFrom(
  env: Readonly<Record<string, string | undefined>>,
): { repo: string } | { problem: string } {
  const value = env[DOCS_REPO_VARIABLE]?.trim() ?? '';
  if (value === '') {
    return {
      problem: `${DOCS_REPO_VARIABLE} is not set: set it to the docs site's repository, owner/name. Nothing was changed.`,
    };
  }
  if (!REPO_PATTERN.test(value)) {
    return {
      problem: `${DOCS_REPO_VARIABLE} is "${value}", not a repository (owner/name). Nothing was changed.`,
    };
  }
  return { repo: value };
}

/** The folder of the pages in the docs repo, the only one this script owns (besides docs.json). */
const SITE_ROOT = 'typescript-sdk';

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** The part of Mintlify's docs.json this script reads and writes. */
export interface DocsJson {
  navigation: { tabs: { tab: string }[] };
}

/**
 * `docsJson` with the SDK tab in it, and nothing else changed (the input is not modified): the tab
 * of the same name is replaced where it is; otherwise the tab goes right after the tab named
 * `insertAfter`; otherwise at the end, with a warning.
 */
export function spliceTab(
  docsJson: DocsJson,
  tab: MintlifyTab,
  insertAfter: string,
): { json: unknown; warning?: string } {
  if (!Array.isArray(docsJson?.navigation?.tabs)) {
    throw new Error('docs.json has no navigation.tabs');
  }
  const json = structuredClone(docsJson);
  const tabs = json.navigation.tabs as unknown[];
  const named = (name: string) =>
    tabs.findIndex((t) => (t as { tab?: unknown }).tab === name);

  const own = named(tab.tab);
  if (own !== -1) {
    tabs[own] = structuredClone(tab);
    return { json };
  }
  const after = named(insertAfter);
  if (after !== -1) {
    tabs.splice(after + 1, 0, structuredClone(tab));
    return { json };
  }
  tabs.push(structuredClone(tab));
  return {
    json,
    warning: `tab "${insertAfter}" not found: appended at the end`,
  };
}

/** docs.json as the docs repo has it: two spaces, a final newline. */
export function formatDocsJson(json: unknown): string {
  return `${JSON.stringify(json, null, 2)}\n`;
}

/**
 * Why the script must not write over `text`, the docs.json it found in the docs repo, or
 * undefined when it may. The script writes the whole file back with {@link formatDocsJson}, so a
 * file it would format differently would change outside the SDK tab: it refuses that file, in
 * one line, instead of reformatting it.
 */
export function docsJsonProblem(text: string): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return 'Nothing was changed: docs.json in the docs repo is not valid JSON.';
  }
  return formatDocsJson(json) === text
    ? undefined
    : 'Nothing was changed: docs.json in the docs repo is not formatted as this script writes it (2 spaces, a final newline), so writing the tab would reformat the whole file.';
}

/** The line printed before the docs commit is made (and in a dry run): who it is made as. */
export function commitIdentityLine(author: {
  name: string;
  email: string;
}): string {
  return author.name.trim() === ''
    ? `Will commit as <${author.email}> (git config user.name is empty: git takes a name from the system)`
    : `Will commit as ${author.name} <${author.email}>`;
}

/** A version Changesets writes: x.y.z, with an optional pre-release suffix. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/;

/** What goes into the docs repo for one version of the SDK. */
export interface PublishPlan {
  branch: string;
  commitMessage: string;
  prTitle: string;
  prBody: string;
}

/**
 * The names and texts of a publish of `version`, built from the commit `sdkSha` of this repository.
 * `branchExists` says whether origin has the branch already: it changes nothing here, because a
 * second run adds a commit to the same branch and its open pull request, under the same names.
 */
export function publishPlan(o: {
  version: string;
  sdkSha: string;
  branchExists: boolean;
}): PublishPlan {
  if (!VERSION_PATTERN.test(o.version)) {
    throw new Error(`"${o.version}" is not a version`);
  }
  if (!SHA_PATTERN.test(o.sdkSha)) {
    throw new Error(`"${o.sdkSha}" is not a commit`);
  }
  const sha7 = o.sdkSha.slice(0, 7);
  return {
    branch: `sdk-docs/${o.version}`,
    commitMessage: `docs(typescript-sdk): ${o.version} from ${SDK_REPO}@${sha7}`,
    prTitle: `docs: TypeScript SDK ${o.version}`,
    prBody: [
      `Generated from ${SDK_REPO}@${sha7} by \`pnpm docs:publish\`.`,
      '',
      `Writes the **TypeScript SDK** tab for \`@xomarket/client\` ${o.version}: the pages under \`${SITE_ROOT}/\`, and that tab in \`docs.json\`. Nothing else in the repository changes.`,
      '',
      `Do not merge before ${SDK_REPO} is public: the pages link to it.`,
    ].join('\n'),
  };
}

/**
 * The arguments of `npx` for Mintlify's two checks, run in the clone of the docs repo.
 * `validate` takes the whole site. `broken-links` takes only our pages (`--files`), anchors
 * included (`--check-anchors`: it checks them against Mintlify's own heading slugs): the
 * pages of the other tabs are not ours to fix here, and at the time of writing one of them
 * (`product/what-is-xo.mdx`, a card to `/index`) makes the check of the whole site fail on
 * `external-prod-only` itself.
 */
export function mintChecks(): string[][] {
  const mint = ['--yes', `mint@${MINT_VERSION}`];
  return [
    [...mint, 'validate'],
    [
      ...mint,
      'broken-links',
      '--files',
      `${SITE_ROOT}/**/*.mdx`,
      '--check-anchors',
    ],
  ];
}

/** What the checks before any change look at. */
export interface Preflight {
  /** `git status --porcelain` of this repository. */
  sdkStatus: string;
  /** `git config user.email` here. */
  email: string;
  ghLoggedIn: boolean;
}

/** Every reason not to start, in words a maintainer can act on. Empty when all is well. */
export function preflightProblems(p: Preflight): string[] {
  const problems: string[] = [];
  if (p.sdkStatus.trim() !== '') {
    problems.push(
      'The working tree has changes: commit or stash them first (the pages are built from it).',
    );
  }
  if (p.email.trim() === '') {
    problems.push(
      'git config user.email is empty: set it (git config user.email <you>), the docs commit is made as you.',
    );
  }
  if (!p.ghLoggedIn) {
    problems.push(
      'The GitHub CLI is not logged in: run `gh auth login` (it clones the docs repo and opens the pull request).',
    );
  }
  return problems;
}

/**
 * Whether `origin` is the remote of `repo` (`owner/name`), by https or ssh: `repo` right after
 * the `/` or `:` that ends the host, so `evil-owner/name` is not one.
 */
function isOriginOf(origin: string, repo: string): boolean {
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`[:/]${escaped}(\\.git)?/?$`).test(origin);
}

/**
 * The reasons not to use a clone of the docs repo `repo` (`owner/name`): not clean, or not a
 * clone of that repository.
 */
export function docsRepoProblems(c: {
  status: string;
  origin: string;
  repo: string;
}): string[] {
  const problems: string[] = [];
  if (c.status.trim() !== '') {
    problems.push('The docs repo has changes: use a clean clone.');
  }
  if (!isOriginOf(c.origin.trim(), c.repo)) {
    problems.push(
      `The docs repo's origin is "${c.origin.trim()}", not ${c.repo}.`,
    );
  }
  return problems;
}

/**
 * The paths among `changed` that this script has no business changing: it writes `docs.json` and
 * the files under `typescript-sdk/`, nothing else.
 */
export function unexpectedChanges(changed: readonly string[]): string[] {
  return changed.filter(
    (path) => path !== 'docs.json' && !path.startsWith(`${SITE_ROOT}/`),
  );
}

const USAGE =
  'usage: DOCS_REPO=<owner/name> docs-publish [--docs-repo <dir>] [--dry-run] [--draft]\n  DOCS_REPO          the repository of the docs site (required)\n  --docs-repo <dir>  a clean clone of the docs repo (default: clone it into a temporary folder)\n  --dry-run          build and check, show the diff stat, commit and push nothing\n  --draft            open the pull request as a draft';

export interface Args {
  docsRepo: string | undefined;
  dryRun: boolean;
  draft: boolean;
}

/** Reads the command line (without `node` and the script). Throws the usage on anything else. */
export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { docsRepo: undefined, dryRun: false, draft: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--draft') {
      args.draft = true;
    } else if (arg === '--docs-repo') {
      const dir = argv[++i];
      if (dir === undefined || dir.startsWith('--')) {
        throw new Error(`--docs-repo needs a directory\n${USAGE}`);
      }
      args.docsRepo = dir;
    } else {
      throw new Error(USAGE);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(
  command: string,
  args: readonly string[],
  o: { cwd?: string; input?: string } = {},
): string {
  return execFileSync(command, args, {
    cwd: o.cwd ?? root,
    encoding: 'utf8',
    input: o.input,
    stdio: [o.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  }).trimEnd();
}

/** Runs a command whose output the maintainer should see (Mintlify's checks). */
function show(command: string, args: readonly string[], cwd: string): void {
  execFileSync(command, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
}

function succeeds(
  command: string,
  args: readonly string[],
  cwd?: string,
): boolean {
  try {
    run(command, args, { cwd });
    return true;
  } catch {
    return false;
  }
}

/** A git setting, or '' when it is not set (git exits 1 then). */
function gitConfig(key: string): string {
  try {
    return run('git', ['config', key]);
  } catch {
    return '';
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
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
  const docsRepo = docsRepoFrom(process.env);
  if ('problem' in docsRepo) {
    console.error(docsRepo.problem);
    process.exitCode = 2;
    return;
  }
  const { repo } = docsRepo;

  // Everything that can be checked before anything is cloned or written.
  const problems = preflightProblems({
    sdkStatus: run('git', ['status', '--porcelain']),
    email: gitConfig('user.email'),
    // A dry run in a given clone uses no gh at all.
    ghLoggedIn:
      (args.dryRun && args.docsRepo !== undefined) ||
      succeeds('gh', ['auth', 'status']),
  });
  if (problems.length > 0) {
    console.error(`Nothing was changed.\n- ${problems.join('\n- ')}`);
    process.exitCode = 1;
    return;
  }

  const { version } = readJson(
    join(root, 'packages', 'client', 'package.json'),
  ) as { version: string };
  const sdkSha = run('git', ['rev-parse', 'HEAD']);
  const author = {
    name: gitConfig('user.name'),
    email: gitConfig('user.email'),
  };
  const insertAfter = readManifest(
    readJson(join(root, 'docs', 'site.json')),
  ).insertAfter;
  if (run('git', ['branch', '--remotes', '--contains', 'HEAD']) === '') {
    console.warn(
      `warning: ${sdkSha.slice(0, 7)} is on no branch of origin yet: the commit and the pull request name it, and the name leads nowhere until it is pushed.`,
    );
  }

  const work = mkdtempSync(join(tmpdir(), 'xo-docs-publish-'));
  const ownClone = args.docsRepo === undefined;
  // pnpm runs this in scripts/; a relative --docs-repo is relative to where it was typed.
  const clone = args.docsRepo
    ? resolve(process.env.INIT_CWD ?? process.cwd(), args.docsRepo)
    : join(work, 'docs');
  let plan: PublishPlan | undefined;
  let pushed = false;
  // True once the clone has nothing left to show: nothing to publish, or its work is on origin.
  let cleanUp = false;
  try {
    if (ownClone) {
      console.log(`Cloning ${repo} into ${clone}`);
      run('gh', ['repo', 'clone', repo, clone]);
    }
    const git = (...a: string[]) => run('git', a, { cwd: clone });

    const bad = docsRepoProblems({
      status: git('status', '--porcelain', '--untracked-files=all'),
      origin: git('remote', 'get-url', 'origin'),
      repo,
    });
    if (bad.length > 0) {
      console.error(`Nothing was changed.\n- ${bad.join('\n- ')}`);
      process.exitCode = 1;
      return;
    }

    git('fetch', '--quiet', 'origin');
    const remote = (branch: string) =>
      succeeds(
        'git',
        ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
        clone,
      );
    if (!remote(BASE_BRANCH)) {
      throw new Error(`origin has no branch ${BASE_BRANCH}`);
    }
    const branchExists = remote(`sdk-docs/${version}`);
    plan = publishPlan({ version, sdkSha, branchExists });
    console.log(
      branchExists
        ? `Branch ${plan.branch} exists on origin: adding a commit to it`
        : `Branch ${plan.branch}: new, from origin/${BASE_BRANCH}`,
    );
    git(
      'switch',
      '--quiet',
      '--no-track',
      '--create',
      plan.branch,
      `origin/${branchExists ? plan.branch : BASE_BRANCH}`,
    );

    // docs.json is written back whole: refuse, before writing anything, one this would reformat.
    const docsJsonText = readFileSync(join(clone, 'docs.json'), 'utf8');
    const unformatted = docsJsonProblem(docsJsonText);
    if (unformatted !== undefined) {
      console.error(unformatted);
      process.exitCode = 1;
      return;
    }

    // The tab, built from this repository, replaces the old one.
    const built = join(work, 'site');
    const { pages, tab } = buildSite(built);
    rmSync(join(clone, SITE_ROOT), { recursive: true, force: true });
    cpSync(join(built, SITE_ROOT), join(clone, SITE_ROOT), { recursive: true });
    const spliced = spliceTab(
      JSON.parse(docsJsonText) as DocsJson,
      tab,
      insertAfter,
    );
    if (spliced.warning !== undefined) {
      console.warn(`warning: ${spliced.warning}`);
    }
    writeFileSync(join(clone, 'docs.json'), formatDocsJson(spliced.json));
    console.log(`Wrote ${pages.length} pages and the "${tab.tab}" tab`);

    const outside = unexpectedChanges(
      parseStatus(git('status', '--porcelain', '--untracked-files=all')).map(
        (entry) => entry.path,
      ),
    );
    if (outside.length > 0) {
      throw new Error(
        `Files outside docs.json and ${SITE_ROOT}/ would change, nothing was committed:\n- ${outside.join('\n- ')}`,
      );
    }

    for (const check of mintChecks()) {
      show('npx', check, clone);
    }

    git('add', '--all', '--', 'docs.json', SITE_ROOT);
    if (succeeds('git', ['diff', '--cached', '--quiet'], clone)) {
      console.log(
        `\nNothing to publish: ${plan.branch} already has these pages.`,
      );
      cleanUp = true;
      return;
    }
    console.log(`\n${git('diff', '--cached', '--stat=120')}`);
    console.log(commitIdentityLine(author));

    if (args.dryRun) {
      console.log(
        `\nDry run: nothing was committed or pushed. The clone, with the changes staged, is ${clone}`,
      );
      return;
    }

    git(
      ...(author.name === '' ? [] : ['-c', `user.name=${author.name}`]),
      '-c',
      `user.email=${author.email}`,
      'commit',
      '--quiet',
      '--message',
      plan.commitMessage,
    );
    console.log(`Committed as ${author.name} <${author.email}>`);
    git('push', 'origin', plan.branch);
    pushed = true;
    cleanUp = true;

    const open = run('gh', [
      'pr',
      'list',
      '--repo',
      repo,
      '--head',
      plan.branch,
      '--base',
      BASE_BRANCH,
      '--state',
      'open',
      '--json',
      'url',
      '--jq',
      '.[0].url // empty',
    ]);
    if (open !== '') {
      console.log(`Pushed. The pull request is open already: ${open}`);
      return;
    }
    const url = run(
      'gh',
      [
        'pr',
        'create',
        '--repo',
        repo,
        '--base',
        BASE_BRANCH,
        '--head',
        plan.branch,
        '--title',
        plan.prTitle,
        '--body-file',
        '-',
        ...(args.draft ? ['--draft'] : []),
      ],
      { input: plan.prBody },
    );
    console.log(`${plan.prTitle}\n${url}`);
    console.log(
      `Next: check the preview, and merge it once ${SDK_REPO} is public.`,
    );
  } catch (error) {
    console.error(`docs-publish failed: ${reason(error)}`);
    console.error(
      pushed
        ? `The branch ${plan?.branch} is pushed: open the pull request by hand (gh pr create --repo ${repo} --base ${BASE_BRANCH} --head ${plan?.branch}).`
        : `Nothing was pushed. The clone is ${clone}`,
    );
    process.exitCode = 1;
  } finally {
    // The temporary clone goes once its work is on origin or there was none; a dry run and a
    // failure leave it for the maintainer to look at. A clone given by --docs-repo is not ours.
    if (cleanUp || !ownClone) {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
