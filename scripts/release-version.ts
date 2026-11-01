// Prepares a release: the new version and CHANGELOG.md from the pending changesets, on a branch
// release/<version>, with its pull request. This is the "Version Packages" step that a bot would
// do in most Changesets setups. Here a maintainer runs it, because the xo-market GitHub organization
// lets GitHub Actions open no pull request, and forbids the force-push the bot uses to update
// its branch. Merging the pull request publishes nothing: publishing is a manual run of the
// Release workflow (.github/workflows/release.yml).
//
// From the repository root, on main, up to date with origin, with a clean tree and `gh` logged in:
//
//   pnpm release:version              version, commit, push, open the pull request
//   pnpm release:version --dry-run    show the version and the changes, then put the tree back
//
// It checks everything it can before it changes anything. If a later step fails, it says what
// is left and how to undo it.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The package this repository releases. */
export const PACKAGE_DIR = 'packages/client';

/** The changeset files in .changeset/, which `changeset version` consumes. */
export function pendingChangesets(names: readonly string[]): string[] {
  return names
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .sort();
}

/** A version Changesets can write: x.y.z, with an optional pre-release suffix. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** The branch of a release: `release/<version>`. Throws for anything that is not a version. */
export function releaseBranch(version: string): string {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`"${version}" is not a version Changesets writes`);
  }
  return `release/${version}`;
}

/**
 * The paths among `changed` that `changeset version` has no business touching. It deletes
 * the consumed changesets and rewrites a package's package.json and CHANGELOG.md, nothing else.
 */
export function unexpectedChanges(changed: readonly string[]): string[] {
  const allowed = [
    /^\.changeset\/[^/]+\.md$/,
    /^packages\/[^/]+\/package\.json$/,
    /^packages\/[^/]+\/CHANGELOG\.md$/,
  ];
  return changed.filter((path) => !allowed.some((re) => re.test(path)));
}

/** One line of `git status --porcelain`: its two-letter status and its path. */
export interface StatusEntry {
  status: string;
  path: string;
}

/** Parses `git status --porcelain` (v1, no renames expected). */
export function parseStatus(output: string): StatusEntry[] {
  return output
    .split('\n')
    .filter((line) => line.length > 3)
    .map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }));
}

/**
 * The entry of `version` in a CHANGELOG.md that Changesets writes: from its `## <version>`
 * heading to the next `## ` heading, without the heading itself. Empty if there is none.
 */
export function changelogSection(changelog: string, version: string): string {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) {
    return '';
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}

/** The title of the release pull request. */
export function pullRequestTitle(name: string, version: string): string {
  return `chore(release): ${name} ${version}`;
}

/** The body of the release pull request. */
export function pullRequestBody(
  name: string,
  version: string,
  changes: string,
): string {
  return [
    `Sets \`${name}\` to **${version}** and writes its CHANGELOG.md from the pending changesets (\`pnpm release:version\`).`,
    '',
    '**Merging this publishes nothing.** After the merge, the Release run on `main` reports that the version is ready to publish. Publishing is a manual run of the Release workflow, with `publish-version` set to this version, during a release window (`NPM_PUBLISH_ENABLED`).',
    '',
    '## Changelog',
    '',
    changes === '' ? '_No entry found for this version._' : changes,
  ].join('\n');
}

/** What the checks before any change look at. */
export interface Preflight {
  branch: string;
  status: string;
  head: string;
  originMain: string;
  pending: readonly string[];
  ghLoggedIn: boolean;
}

/** Every reason not to start, in words a maintainer can act on. Empty when all is well. */
export function preflightProblems(p: Preflight): string[] {
  const problems: string[] = [];
  if (p.branch !== 'main') {
    problems.push(
      `You are on "${p.branch}": switch to main (git switch main).`,
    );
  }
  if (p.status.trim() !== '') {
    problems.push('The working tree has changes: commit or stash them first.');
  }
  if (p.head !== p.originMain) {
    problems.push(
      'main is not the same commit as origin/main: pull (or push) first.',
    );
  }
  if (p.pending.length === 0) {
    problems.push(
      'No changeset is pending in .changeset/: there is nothing to release.',
    );
  }
  if (!p.ghLoggedIn) {
    problems.push(
      'The GitHub CLI is not logged in: run `gh auth login` (it opens the pull request).',
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(command: string, args: readonly string[], input?: string): string {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  }).trimEnd();
}

function succeeds(command: string, args: readonly string[]): boolean {
  try {
    run(command, args);
    return true;
  } catch {
    return false;
  }
}

function readPackage(): { name: string; version: string } {
  const pkg = JSON.parse(
    readFileSync(join(root, PACKAGE_DIR, 'package.json'), 'utf8'),
  ) as { name: string; version: string };
  return { name: pkg.name, version: pkg.version };
}

/** Puts the tree back as `changeset version` found it. Removes only files it created. */
function restore(entries: readonly StatusEntry[]): void {
  run('git', ['checkout', 'HEAD', '--', '.changeset', 'packages']);
  for (const entry of entries) {
    if (entry.status === '??') {
      rmSync(join(root, entry.path));
    }
  }
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');

  run('git', ['fetch', '--quiet', 'origin', 'main']);
  const problems = preflightProblems({
    branch: run('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
    status: run('git', ['status', '--porcelain']),
    head: run('git', ['rev-parse', 'HEAD']),
    originMain: run('git', ['rev-parse', 'origin/main']),
    pending: pendingChangesets(readdirSync(join(root, '.changeset'))),
    ghLoggedIn: dryRun || succeeds('gh', ['auth', 'status']),
  });
  if (problems.length > 0) {
    console.error(`Nothing was changed.\n- ${problems.join('\n- ')}`);
    process.exitCode = 1;
    return;
  }

  const before = readPackage();
  run('pnpm', ['exec', 'changeset', 'version']);
  const entries = parseStatus(
    run('git', ['status', '--porcelain', '--untracked-files=all']),
  );
  const after = readPackage();

  const unexpected = unexpectedChanges(entries.map((e) => e.path));
  if (after.version === before.version || unexpected.length > 0) {
    restore(entries.filter((e) => unexpectedChanges([e.path]).length === 0));
    console.error(
      after.version === before.version
        ? `changeset version left ${after.name} at ${before.version}: nothing to release. The tree is back as it was.`
        : `changeset version changed files it should not have:\n- ${unexpected.join('\n- ')}\nThe expected changes were undone; look at these files before trying again.`,
    );
    process.exitCode = 1;
    return;
  }

  const branch = releaseBranch(after.version);
  const changes = changelogSection(
    readFileSync(join(root, PACKAGE_DIR, 'CHANGELOG.md'), 'utf8'),
    after.version,
  );
  const title = pullRequestTitle(after.name, after.version);
  const body = pullRequestBody(after.name, after.version, changes);

  if (dryRun) {
    console.log(`${after.name}: ${before.version} -> ${after.version}`);
    console.log(`Branch: ${branch}`);
    console.log(
      `Changes:\n${entries.map((e) => `  ${e.status} ${e.path}`).join('\n')}`,
    );
    console.log(`\nPull request: ${title}\n\n${body}`);
    restore(entries);
    console.log('\nDry run: the tree is back as it was.');
    return;
  }

  if (
    succeeds('git', [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ]) ||
    run('git', ['ls-remote', '--heads', 'origin', branch]) !== ''
  ) {
    restore(entries);
    console.error(
      `The branch ${branch} already exists (here or on origin): a release of ${after.version} is already prepared. The tree is back as it was.`,
    );
    process.exitCode = 1;
    return;
  }

  run('git', ['switch', '--quiet', '--create', branch]);
  run('git', ['add', '--all', '--', '.changeset', 'packages']);
  run('git', ['commit', '--quiet', '--message', title]);
  let pushed = false;
  try {
    run('git', ['push', '--quiet', '--set-upstream', 'origin', branch]);
    pushed = true;
    const url = run(
      'gh',
      [
        'pr',
        'create',
        '--base',
        'main',
        '--head',
        branch,
        '--title',
        title,
        '--body-file',
        '-',
      ],
      body,
    );
    console.log(`${title}\n${url}`);
    console.log(
      'Next: squash-merge it. Then publish with Actions > Release > Run workflow (see RELEASING.md).',
    );
  } catch (error) {
    const next = pushed
      ? `The branch ${branch} is pushed: open the pull request by hand (gh pr create --base main --head ${branch}).`
      : `Nothing was pushed: fix the cause, then push the branch (git push --set-upstream origin ${branch}) and open the pull request (gh pr create --base main --head ${branch}).`;
    console.error(
      `The release commit is on the local branch ${branch}, but ${pushed ? 'opening the pull request' : 'pushing it'} failed:\n${(error as Error).message}\n${next}`,
    );
    process.exitCode = 1;
  } finally {
    run('git', ['switch', '--quiet', 'main']);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
