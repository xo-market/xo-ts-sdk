import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { runCheck } from '../public-check.js';
import { digestOf, findPublicIssues } from '../public-rules.js';

// The public-content check on the command line (scripts/public-check.ts), on temporary git
// repositories and a tarball made with tar. Every text the check must catch is joined from
// fragments at runtime, never written whole, so this file passes the check itself.

/** Joins fragments into a text the check must catch. */
const j = (...parts: string[]): string => parts.join('');
const TICKET = j('XO', '-2588');
/** A word the check catches, and the name of its rule. */
const WALLET = j('trea', 'sury');

const SCRIPTS = fileURLToPath(new URL('..', import.meta.url));

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'public-check-test-'));
  made.push(dir);
  return dir;
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/** git with a fixed identity, no signing and no hooks of the machine it runs on. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  );
}

/** A git repository: `tracked` files are added to the index, `untracked` ones are only written. */
function repo(
  tracked: Record<string, string>,
  untracked: Record<string, string> = {},
): string {
  const dir = tempDir();
  git(dir, 'init', '-q');
  write(dir, { ...tracked, ...untracked });
  if (Object.keys(tracked).length > 0) {
    git(dir, 'add', '--', ...Object.keys(tracked));
  }
  return dir;
}

/** Runs the check in this process: its exit code and what it printed. */
function check(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runCheck(args, {
    cwd,
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out, err };
}

/**
 * Runs the check as a command, the way pnpm runs it from `cwd`. `env` adds variables to the
 * environment; an `undefined` value removes the variable, so a test controls whether it is set.
 */
function command(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined> = {},
) {
  const merged: Record<string, string | undefined> = {
    ...process.env,
    INIT_CWD: cwd,
    ...env,
  };
  for (const [name, value] of Object.entries(merged)) {
    if (value === undefined) {
      delete merged[name];
    }
  }
  return spawnSync(
    join(SCRIPTS, 'node_modules/.bin/tsx'),
    [join(SCRIPTS, 'public-check.ts'), ...args],
    { cwd, encoding: 'utf8', env: merged as NodeJS.ProcessEnv },
  );
}

describe('public-check, what it reads', () => {
  test('scans tracked files only', () => {
    const dir = repo(
      { 'a.md': `fine\nsee ${TICKET}\n`, 'b.md': 'fine\n' },
      { 'c.md': `see ${TICKET}\n` },
    );
    expect(check([], dir)).toEqual({
      code: 1,
      out: [
        'a.md:2: ticket: see ***',
        'public-check: checked 2 tracked file(s): 1 finding(s)',
      ],
      err: [],
    });
  });

  test('paths limit the scan, relative to the directory it runs from', () => {
    const dir = repo({
      'docs/a.md': `see ${TICKET}\n`,
      'src/b.ts': `// ${WALLET}\n`,
      'src/c.ts': 'fine\n',
    });
    const expected = [
      `src/b.ts:1: ${WALLET}: // ***`,
      'public-check: checked 2 tracked file(s): 1 finding(s)',
    ];
    expect(check(['src'], dir).out).toEqual(expected);
    expect(check(['.'], join(dir, 'src')).out).toEqual(expected);
    expect(check(['src/c.ts'], dir)).toEqual({
      code: 0,
      out: ['public-check: checked 1 tracked file(s): OK'],
      err: [],
    });
  });

  test('a path without a tracked file is an error, not a clean run', () => {
    const dir = repo({ 'a.md': 'fine\n' }, { 'new.md': 'fine\n' });
    for (const path of ['nope', 'new.md']) {
      expect(check([path], dir)).toEqual({
        code: 2,
        out: [],
        err: [`public-check: no tracked file under ${path}`],
      });
    }
  });

  test('skips binary files', () => {
    const dir = repo({ 'a.bin': `\0${TICKET}\n`, 'b.md': 'fine\n' });
    expect(check([], dir).out).toEqual([
      'public-check: checked 1 tracked file(s): OK',
    ]);
  });

  test('checks file names, and never prints a name that breaks a rule', () => {
    const dir = repo({ [`notes-${WALLET}.md`]: `see ${TICKET}\n` });
    expect(check([], dir).out).toEqual([
      `(file names):1: ${WALLET}: notes-***.md`,
      'notes-***.md:1: ticket: see ***',
      'public-check: checked 1 tracked file(s): 2 finding(s)',
    ]);
  });

  test('--tarball scans the files inside', () => {
    const dir = repo({ 'a.md': `see ${TICKET}\n` });
    const pack = tempDir();
    write(pack, {
      'package/package.json': '{}\n',
      'package/dist/index.js': `const a = 1;\n// ${WALLET}\n`,
    });
    execFileSync(
      'tar',
      ['-czf', join(dir, 'client.tgz'), '-C', pack, 'package'],
      {
        env: { ...process.env, COPYFILE_DISABLE: '1' },
      },
    );
    expect(check(['--tarball', 'client.tgz'], dir)).toEqual({
      code: 1,
      out: [
        `client.tgz:package/dist/index.js:2: ${WALLET}: // ***`,
        'public-check: checked 2 file(s) in client.tgz: 1 finding(s)',
      ],
      err: [],
    });
    expect(check(['--tarball', 'missing.tgz'], dir)).toEqual({
      code: 2,
      out: [],
      err: ['public-check: tarball not found: missing.tgz'],
    });
  });

  test('--commits scans each message', () => {
    const dir = repo({ 'a.md': 'fine\n' });
    git(dir, 'commit', '-q', '-m', `first ${TICKET}`);
    git(dir, 'commit', '-q', '--allow-empty', '-m', `second ${TICKET}`);
    git(
      dir,
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'third',
      '-m',
      `Body ${WALLET}.`,
    );
    const sha = (rev: string) => git(dir, 'rev-parse', rev).trim().slice(0, 12);
    expect(check(['--commits', 'HEAD~2..HEAD'], dir)).toEqual({
      code: 1,
      out: [
        `commit ${sha('HEAD')}:3: ${WALLET}: Body ***.`,
        `commit ${sha('HEAD~1')}:1: ticket: second ***`,
        'public-check: checked 2 commit message(s): 2 finding(s)',
      ],
      err: [],
    });
    expect(check(['--commits', 'HEAD..HEAD'], dir).out).toEqual([
      'public-check: checked 0 commit message(s): OK',
    ]);
    const bad = check(['--commits', 'nope..HEAD'], dir);
    expect(bad.code).toBe(2);
    expect(bad.err[0]).toMatch(/^public-check: git log failed/);
  });

  test("--env scans the variable's text", () => {
    const dir = repo({ 'a.md': `see ${TICKET}\n` });
    const env = {
      PR_TITLE: 'feat: a fine title',
      PR_BODY: `What it does.\n\nSee ${TICKET}.`,
      EMPTY: '',
    };
    expect(
      check(
        ['--env', 'PR_TITLE', '--env', 'PR_BODY', '--env', 'EMPTY'],
        dir,
        env,
      ),
    ).toEqual({
      code: 1,
      out: [
        '$PR_BODY:3: ticket: See ***.',
        'public-check: checked 3 variable(s): 1 finding(s)',
      ],
      err: [],
    });
    expect(check(['--env', 'PR_NOPE'], dir, env)).toEqual({
      code: 2,
      out: [],
      err: ['public-check: environment variable not set: PR_NOPE'],
    });
  });

  describe('the pull request step of ci.yml', () => {
    // ci.yml runs `public-check --commits origin/$BASE_REF..HEAD --env PR_TITLE --env PR_BODY`,
    // with the title and the description in the environment. A pull request on a branch off
    // main, with two commits, stands in for it (the range here is main..HEAD).
    function pullRequest(): string {
      const dir = repo({ 'a.md': 'fine\n' });
      git(dir, 'commit', '-q', '-m', 'chore: the base');
      git(dir, 'checkout', '-q', '-b', 'feature');
      git(dir, 'commit', '-q', '--allow-empty', '-m', 'feat: one change');
      git(dir, 'commit', '-q', '--allow-empty', '-m', 'fix: another change');
      return dir;
    }
    const ARGS = [
      '--commits',
      'main..HEAD',
      '--env',
      'PR_TITLE',
      '--env',
      'PR_BODY',
    ];

    test('a pull request without a description passes: an empty variable is an empty text', () => {
      const dir = pullRequest();
      expect(
        check(ARGS, dir, { PR_TITLE: 'feat!: a fine title', PR_BODY: '' }),
      ).toEqual({
        code: 0,
        out: ['public-check: checked 2 commit message(s), 2 variable(s): OK'],
        err: [],
      });
      // The same through a real process, with the empty variable in its environment.
      const run = command(ARGS, dir, {
        PR_TITLE: 'feat!: a fine title',
        PR_BODY: '',
      });
      expect(run.stdout).toBe(
        'public-check: checked 2 commit message(s), 2 variable(s): OK\n',
      );
      expect(run.status).toBe(0);
    });

    test('a variable that is not set at all is an error, not a pass: a misspelt name cannot go unnoticed', () => {
      const dir = pullRequest();
      const run = command(ARGS, dir, {
        PR_TITLE: 'feat!: a fine title',
        PR_BODY: undefined,
      });
      expect(run.stderr).toBe(
        'public-check: environment variable not set: PR_BODY\n',
      );
      expect(run.status).toBe(2);
    });

    test('a description with Windows line endings is read line by line', () => {
      const dir = pullRequest();
      expect(
        check(ARGS, dir, {
          PR_TITLE: 'feat!: a fine title',
          PR_BODY: `What it does.\r\n\r\nSee ${TICKET}.\r\n`,
        }),
      ).toEqual({
        code: 1,
        out: [
          '$PR_BODY:3: ticket: See ***.',
          'public-check: checked 2 commit message(s), 2 variable(s): 1 finding(s)',
        ],
        err: [],
      });
    });

    test('a title or description that looks like shell is only text', () => {
      const dir = pullRequest();
      const hostile = '$(touch pwned); `touch pwned` "; touch pwned; "\' --x';
      const run = command(ARGS, dir, { PR_TITLE: hostile, PR_BODY: hostile });
      expect(run.status).toBe(0);
      expect(existsSync(join(dir, 'pwned'))).toBe(false);
    });
  });

  test('nothing it prints names a blocked term: errors and the summary are hidden too', () => {
    const dir = repo({ 'a.md': 'fine\n' });
    expect(check(['--tarball', `missing-${WALLET}.tgz`], dir).err).toEqual([
      'public-check: tarball not found: missing-***.tgz',
    ]);
    expect(check([`notes-${WALLET}`], dir).err).toEqual([
      'public-check: no tracked file under notes-***',
    ]);
    const pack = tempDir();
    write(pack, { 'package/index.js': 'fine\n' });
    execFileSync(
      'tar',
      ['-czf', join(dir, `client-${WALLET}.tgz`), '-C', pack, 'package'],
      { env: { ...process.env, COPYFILE_DISABLE: '1' } },
    );
    expect(check(['--tarball', `client-${WALLET}.tgz`], dir).out).toEqual([
      'public-check: checked 1 file(s) in client-***.tgz: OK',
    ]);
  });

  test.skipIf(process.getuid?.() === 0)(
    'an unexpected error is hidden the same way',
    () => {
      const name = `notes-${WALLET}.md`;
      const dir = repo({ [name]: 'fine\n' });
      chmodSync(join(dir, name), 0o000);
      const { code, out, err } = check([], dir);
      expect([code, out, err.length]).toEqual([2, [], 1]);
      expect(err[0]).toMatch(/^public-check: could not run: EACCES/);
      expect(err[0]).toContain('notes-***.md');
      expect(err[0]?.toLowerCase()).not.toContain(WALLET);
    },
  );

  test('sources add up: paths with commits', () => {
    const dir = repo({ 'a.md': `see ${TICKET}\n` });
    git(dir, 'commit', '-q', '-m', 'fine');
    expect(check(['a.md', '--commits', 'HEAD'], dir).out).toEqual([
      'a.md:1: ticket: see ***',
      'public-check: checked 1 tracked file(s), 1 commit message(s): 1 finding(s)',
    ]);
  });
});

describe('public-check, the command', () => {
  test('exit codes 0, 1 and 2', () => {
    const clean = command([], repo({ 'a.md': 'fine\n' }));
    expect([clean.status, clean.stdout]).toEqual([
      0,
      'public-check: checked 1 tracked file(s): OK\n',
    ]);
    const found = command([], repo({ 'a.md': `see ${TICKET}\n` }));
    expect([found.status, found.stdout]).toEqual([
      1,
      'a.md:1: ticket: see ***\npublic-check: checked 1 tracked file(s): 1 finding(s)\n',
    ]);
    const outside = command([], tempDir());
    expect(outside.status).toBe(2);
    expect(outside.stderr).toMatch(/^public-check: git rev-parse failed/);
    const unknown = command(['--nope'], tempDir());
    expect([unknown.status, unknown.stderr]).toEqual([
      2,
      'public-check: unknown option: --nope\n',
    ]);
  });

  test('--digest prints the digest', () => {
    expect(check(['--digest', 'Example.COM'], tempDir())).toEqual({
      code: 0,
      out: [digestOf('example.com')],
      err: [],
    });
    expect(check(['--digest'], tempDir())).toEqual({
      code: 2,
      out: [],
      err: ['public-check: --digest needs a value'],
    });
  });

  test('its own files pass the check', () => {
    for (const file of ['../public-check.ts', './public-check.test.ts']) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(findPublicIssues(file, text)).toEqual([]);
    }
  });
});
