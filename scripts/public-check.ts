// The public-content check on the command line: the rules of public-rules.ts over the tracked files of
// the repository, the files of an npm tarball, commit messages, or the text of environment variables
// (a pull request's title and body). It never prints what it blocks: a finding shows its line with
// every match replaced by `***`, and a file name that breaks a rule is shown the same way.
//
//   pnpm -C scripts public-check                       every tracked text file, and the file names
//   pnpm -C scripts public-check docs packages/client  only the tracked files under these paths
//   pnpm -C scripts public-check --tarball client.tgz  every file inside the tarball, and their names
//   pnpm -C scripts public-check --commits origin/main..HEAD --env PR_TITLE --env PR_BODY
//                                                      each commit message of the range, each variable
//   pnpm -s -C scripts public-check --digest <term>    the digest of a term, for BLOCKED
//
// The options repeat and add up. Tracked files are checked when paths are given, or when nothing
// else is. Relative paths and the tarball are read from the directory pnpm was started in
// (INIT_CWD), and git runs there. A file with a NUL byte is binary and skipped. Prints `source:line: rule: excerpt` for each finding, then one
// summary line. Exit 0 when clean, 1 with findings, 2 when the check could not run (not a git
// repository, a path without a tracked file, a tarball it cannot read, a bad range, a variable
// that is not set, an unknown option).

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digestOf, findPublicIssues } from './public-rules.js';

/** What the check was asked to read is not there or not readable: one line, then exit 2. */
class CheckError extends Error {}

interface Options {
  paths: string[];
  tarballs: string[];
  ranges: string[];
  variables: string[];
  terms: string[];
}

/** The options that take a value, and where it goes. */
const VALUED: Record<string, Exclude<keyof Options, 'paths'>> = {
  '--tarball': 'tarballs',
  '--commits': 'ranges',
  '--env': 'variables',
  '--digest': 'terms',
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    paths: [],
    tarballs: [],
    ranges: [],
    variables: [],
    terms: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const key = Object.hasOwn(VALUED, arg) ? VALUED[arg] : undefined;
    if (key !== undefined) {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new CheckError(`${arg} needs a value`);
      }
      options[key].push(value);
      i++;
    } else if (arg === '--') {
      options.paths.push(...argv.slice(i + 1));
      break;
    } else if (arg.startsWith('-')) {
      throw new CheckError(`unknown option: ${arg}`);
    } else {
      options.paths.push(arg);
    }
  }
  return options;
}

/** A text to check, and how the report names it. */
interface Text {
  source: string;
  text: string;
}

/** The texts of one option, and what the summary says about them. */
interface Group {
  summary: string;
  texts: Text[];
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1 << 30,
    });
  } catch (error) {
    const detail = String((error as { stderr?: unknown }).stderr ?? '')
      .trim()
      .split('\n')[0];
    throw new CheckError(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
}

/** A file's text, or undefined when it is binary (a NUL byte), missing or not a file. */
function readText(path: string): string | undefined {
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') {
      return undefined;
    }
    throw error;
  }
  return data.includes(0) ? undefined : data.toString('utf8');
}

/** The texts of `names` (relative to `root`, shown as `prefix` + name), and the names themselves. */
function filesText(root: string, names: string[], prefix: string): Text[] {
  const texts: Text[] = [];
  for (const name of names) {
    const text = readText(join(root, name));
    if (text !== undefined) {
      texts.push({ source: `${prefix}${name}`, text });
    }
  }
  return [
    { source: `${prefix}(file names)`, text: names.join('\n') },
    ...texts,
  ];
}

/** The tracked files under `paths` (relative to `cwd`), or of the whole repository. */
function trackedFiles(cwd: string, paths: string[]): Group {
  const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const list = (from: string, pathspec: string[]) =>
    git(from, ['ls-files', '-z', '--full-name', '--', ...pathspec])
      .split('\0')
      .filter((name) => name !== '');
  const names =
    paths.length === 0
      ? list(root, [])
      : paths.flatMap((path) => {
          const found = list(cwd, [path]);
          if (found.length === 0) {
            throw new CheckError(`no tracked file under ${path}`);
          }
          return found;
        });
  const texts = filesText(root, [...new Set(names)], '');
  return { summary: `${texts.length - 1} tracked file(s)`, texts };
}

/** Every file inside the tarball, unpacked with tar into a temporary directory. */
function tarballFiles(cwd: string, tarball: string): Group {
  const path = resolve(cwd, tarball);
  if (!existsSync(path)) {
    throw new CheckError(`tarball not found: ${tarball}`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'public-check-'));
  try {
    try {
      execFileSync('tar', ['-xf', path, '-C', dir], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch {
      throw new CheckError(`could not unpack ${tarball}`);
    }
    const names = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) =>
        relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'),
      )
      .sort();
    if (names.length === 0) {
      throw new CheckError(`no file in ${tarball}`);
    }
    const label = basename(tarball);
    const texts = filesText(dir, names, `${label}:`);
    return { summary: `${texts.length - 1} file(s) in ${label}`, texts };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The message of each commit of `range`, newest first. */
function commitMessages(cwd: string, range: string): Group {
  const log = git(cwd, [
    'log',
    '-z',
    '--format=%H%n%B',
    '--end-of-options',
    range,
    '--',
  ]);
  const texts = log
    .split('\0')
    .filter((entry) => entry !== '')
    .map((entry) => {
      const newline = entry.indexOf('\n');
      return {
        source: `commit ${entry.slice(0, 12)}`,
        text: entry.slice(newline + 1),
      };
    });
  return { summary: `${texts.length} commit message(s)`, texts };
}

function variables(env: NodeJS.ProcessEnv, names: string[]): Group {
  const texts = names.map((name) => {
    const text = env[name];
    if (text === undefined) {
      throw new CheckError(`environment variable not set: ${name}`);
    }
    return { source: `$${name}`, text };
  });
  return { summary: `${texts.length} variable(s)`, texts };
}

/**
 * Text the report prints that is not an excerpt (a source, the summary, an error, any of which can
 * hold a path or a name): each line that breaks a rule is shown with the match hidden.
 */
function shown(text: string): string {
  return text
    .split(/\r\n?|\n/)
    .map((line) => findPublicIssues('', line)[0]?.excerpt ?? line)
    .join(' ');
}

export interface Io {
  /** Where relative paths and the tarball are read from, and where git runs. */
  cwd: string;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Runs the check for the command line `argv`: the exit code. */
export function runCheck(argv: string[], io: Io): 0 | 1 | 2 {
  try {
    const options = parseArgs(argv);
    if (options.terms.length > 0) {
      for (const term of options.terms) {
        io.out(digestOf(term));
      }
      return 0;
    }
    const groups: Group[] = [];
    const others =
      options.tarballs.length +
      options.ranges.length +
      options.variables.length;
    if (options.paths.length > 0 || others === 0) {
      groups.push(trackedFiles(io.cwd, options.paths));
    }
    for (const tarball of options.tarballs) {
      groups.push(tarballFiles(io.cwd, tarball));
    }
    for (const range of options.ranges) {
      groups.push(commitMessages(io.cwd, range));
    }
    if (options.variables.length > 0) {
      groups.push(variables(io.env, options.variables));
    }
    const findings = groups.flatMap((group) =>
      group.texts.flatMap(({ source, text }) => findPublicIssues(source, text)),
    );
    for (const f of findings) {
      io.out(`${shown(f.source)}:${f.line}: ${f.rule}: ${f.excerpt}`);
    }
    const checked = groups.map((group) => group.summary).join(', ');
    const result =
      findings.length === 0 ? 'OK' : `${findings.length} finding(s)`;
    io.out(`public-check: checked ${shown(checked)}: ${result}`);
    return findings.length === 0 ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err(
      `public-check: ${error instanceof CheckError ? '' : 'could not run: '}${shown(message)}`,
    );
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = runCheck(process.argv.slice(2), {
    cwd: process.env.INIT_CWD ?? process.cwd(),
    env: process.env,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
