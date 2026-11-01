// The backend route coverage check. It compares the "Route index" table of the backend's route
// registry (a Markdown file) with `src/data/coverage.ts` and reports the drift between them,
// whatever the area of the route:
//
// - uncovered: a `public` or `shared` route that is in neither `covered` nor `skipped`, and a
//   route skipped as frontend-only that is `public` or `shared` now (it is open to the client
//   today, so it can be covered);
// - stale: a route in `covered` or `skipped` that the index no longer lists;
// - access changed: a `covered` route whose access in the index is not what the client uses.
//   Not `public` or `shared` any more (it is `frontend`, say): an API key gets 401 or 403 on it.
//   `shared` now while the client calls it as `public` (no credentials): 401. `public` now
//   while the client sends a key.
//
//   pnpm -C packages/client route-coverage [--file <path>] [--report <path>]
//
// Without `--file` the registry is fetched with `gh api` from the place the environment variables
// ROUTE_REGISTRY_REPO (owner/name), ROUTE_REGISTRY_REF (a branch, tag or commit; `main` when
// unset) and ROUTE_REGISTRY_PATH (the file in that repository) name. The token is `GH_TOKEN` (in
// CI the secret ROUTE_REGISTRY_TOKEN). In CI the three are secrets too, so the check never prints
// them: no output, error or report holds the repository, the ref, the path or the URL made from
// them, only the names of the variables. Exit code: 0 up to date, 1 drift, 2 the check could not
// run (a variable or the token is missing, the fetch failed, the file could not be read or
// parsed).

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  type DataCoverage,
  coverage as dataCoverage,
  FRONTEND_ONLY,
} from '../src/data/coverage';
import { routes as clientRoutes, type RouteAccess } from '../src/data/routes';

/** A row of the route index: the declared access of a route today. */
export interface Route {
  readonly method: string;
  /** As the index writes it, under `/api`. */
  readonly path: string;
  /**
   * The "Declared access" column: `public`, `shared`, `frontend` (a Privy session only), or
   * what else the registry adds. A route with no guard (`none (no guard)`) is `public`.
   */
  readonly access: string;
}

/** A route the check wants a decision on. */
export interface UncoveredRoute extends Route {
  /**
   * Set when the route is in `skipped` as frontend-only and is `public` or `shared` now:
   * it can be covered.
   */
  readonly nowCoverable?: true;
}

/** A covered route whose access in the index is not the one the client uses. */
export interface AccessChange extends Route {
  /**
   * Set when the route is `public` or `shared` in the index and the client uses the other one:
   * what the client calls it as. Not set when the route is neither any more (`access` says what
   * it is).
   */
  readonly client?: RouteAccess;
}

/** What the check reports. */
export interface CoverageDiff {
  /** Sorted by path, then method. */
  readonly uncovered: UncoveredRoute[];
  /** The routes of the coverage map the index does not list, sorted by path, then method. */
  readonly stale: Array<{ readonly method: string; readonly path: string }>;
  /**
   * The `covered` routes whose declared access is not the one the client uses: not `public` or
   * `shared` any more, or the other one of the two. Sorted by path, then method.
   */
  readonly accessChanged: AccessChange[];
}

/**
 * What the data client calls each of its routes as, by {@link routeKey}: `public` is sent with
 * no credentials, `shared` with the backend key (`src/data/routes.ts`).
 */
export const CLIENT_ACCESS: ReadonlyMap<string, RouteAccess> = new Map(
  Object.values(clientRoutes).map((route) => [routeKey(route), route.access]),
);

/** The secret that holds the token in CI. */
const TOKEN_SECRET = 'ROUTE_REGISTRY_TOKEN';

/** Where the check reads the registry from. */
export interface RegistrySource {
  /** The repository, as `owner/name`. */
  readonly repo: string;
  /** A branch, a tag or a commit. */
  readonly ref: string;
  /** The registry file, relative to the root of the repository. */
  readonly path: string;
}

/** What a variable that must be set holds, for the message that asks for it. */
const REQUIRED_VARIABLES = {
  ROUTE_REGISTRY_REPO:
    'the repository that holds the route registry, as owner/name',
  ROUTE_REGISTRY_PATH: 'the path of the route registry file in that repository',
} as const;

/**
 * Where the registry is, from the environment variables `ROUTE_REGISTRY_REPO`,
 * `ROUTE_REGISTRY_REF` (a branch, tag or commit; `main` when it is unset or blank) and
 * `ROUTE_REGISTRY_PATH`. The values are trimmed.
 *
 * @throws {Error} When `ROUTE_REGISTRY_REPO` or `ROUTE_REGISTRY_PATH` is unset or blank; the
 *   message names the variable, never a value.
 */
export function registrySource(env: NodeJS.ProcessEnv): RegistrySource {
  const required = (name: keyof typeof REQUIRED_VARIABLES): string => {
    const value = env[name]?.trim() ?? '';
    if (value === '') {
      throw new Error(
        `${name} is not set or empty. It holds ${REQUIRED_VARIABLES[name]} (in CI it is a repository secret). Set it, or run with --file <path> against a local copy of the registry.`,
      );
    }
    return value;
  };
  return {
    repo: required('ROUTE_REGISTRY_REPO'),
    ref: env.ROUTE_REGISTRY_REF?.trim() || 'main',
    path: required('ROUTE_REGISTRY_PATH'),
  };
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** The method in upper case. */
export function normaliseMethod(method: string): string {
  return method.trim().toUpperCase();
}

/**
 * A path in the one spelling both the coverage map and the index compare by: path params as
 * `:name` (the index and the map use that; an OpenAPI `{name}` is read the same), no `/api`
 * prefix (a map or an index may or may not carry the global prefix), no trailing slash. Param
 * names stay as written: `/markets/:id` and `/markets/:marketId` are different spellings, and
 * the coverage map spells a route as the registry does.
 */
export function normalisePath(path: string): string {
  let normal = path.trim().replace(/\{([^}/]+)\}/g, ':$1');
  if (!normal.startsWith('/')) {
    normal = `/${normal}`;
  }
  normal = normal.replace(/\/{2,}/g, '/').replace(/^\/api(?=\/|$)/, '');
  normal = normal.replace(/\/+$/, '');
  return normal === '' ? '/' : normal;
}

/** The key two spellings of the same route share: `GET /markets/:id`. */
export function routeKey(route: {
  readonly method: string;
  readonly path: string;
}): string {
  return `${normaliseMethod(route.method)} ${normalisePath(route.path)}`;
}

// ---------------------------------------------------------------------------
// The route index
// ---------------------------------------------------------------------------

// A method and a path as the registry writes them: `GET /api/v1/events/:eventId/charts/points`.
// The path charset is the one a backend route template can have here; nothing that would mean
// something in Markdown (a backtick, `@`, a bracket) gets into the report.
const ROUTE_CELL = /^`([A-Za-z]+) (\/[A-Za-z0-9_.:{}/-]*)`$/;

// A class of access: a word. The report echoes it.
const ACCESS_CLASS = /^[A-Za-z][A-Za-z0-9_-]*$/;

function cellsOf(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, '|').trim());
}

/**
 * Reads the routes of the "Route index" table of the route registry, in document order. The
 * table is found by its heading and its columns by their header (`Route`, `Declared access`),
 * so a column added to the registry does not break the check. A route with no guard
 * (`none (no guard)`) is read as `public`, which is what it is: open to anyone.
 *
 * @throws {Error} When the document has no "Route index" section or table, the table has no
 *   `Declared access` column or no routes, a row is cut short, has more cells than the header, or
 *   holds a route or an access the check cannot read, or a line of the section after the first
 *   table starts with `|` (a blank line in the middle of the table, or a second table: its
 *   routes would never be seen). A document the check cannot read must never look like an index
 *   with fewer routes, or none (everything would be reported stale).
 *
 *   The registry is private and the error may end up in a public log: it names the line of the
 *   row, the number of its cells and, when the route cell reads, the route (which the report
 *   shows anyway). It never holds the text of a row: the handler and source cells name internal
 *   code and paths.
 */
export function parseRouteIndex(markdown: string): Route[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Route index\s*$/.test(line));
  if (start < 0) {
    throw new Error('The document has no "Route index" section.');
  }
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) {
      break;
    }
    section.push(line);
  }
  const isTableLine = (line: string) => line.trimStart().startsWith('|');
  const first = section.findIndex(isTableLine);
  if (first < 0) {
    throw new Error('The "Route index" section has no table.');
  }
  const table: string[] = [];
  for (const line of section.slice(first)) {
    if (!isTableLine(line)) {
      break;
    }
    table.push(line);
  }
  // The 1-based line of the document that holds the `index`th line of the section.
  const lineOf = (index: number) => start + index + 2;
  const afterTable = first + table.length;
  const stray = section.slice(afterTable).findIndex(isTableLine);
  if (stray >= 0) {
    throw new Error(
      `The "Route index" section has table lines after the first table (a blank line in the middle of it, or a second table); the first is on line ${lineOf(afterTable + stray)}.`,
    );
  }
  const header = cellsOf(table[0] ?? '').map((cell) => cell.toLowerCase());
  const routeColumn = header.indexOf('route');
  const accessColumn = header.indexOf('declared access');
  if (routeColumn < 0 || accessColumn < 0) {
    throw new Error(
      'The "Route index" table has no "Route" and "Declared access" columns.',
    );
  }
  const routes: Route[] = [];
  for (const [index, line] of table.slice(1).entries()) {
    // `index` is 0 for the line after the header.
    const row = lineOf(first + index + 1);
    const cells = cellsOf(line);
    if (cells.length === header.length && cells.every(isSeparatorCell)) {
      continue;
    }
    const match = ROUTE_CELL.exec(cells[routeColumn] ?? '');
    if (cells.length !== header.length) {
      const route = match ? ` (${match[1]} ${match[2]})` : '';
      throw new Error(
        `The row on line ${row} of the "Route index" has ${cells.length} cells, the header has ${header.length}${route}.`,
      );
    }
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error(
        `The row on line ${row} of the "Route index" has no route in its "Route" cell.`,
      );
    }
    const declared = (cells[accessColumn] ?? '').replace(/`/g, '').trim();
    const access = declared === 'none (no guard)' ? 'public' : declared;
    if (!ACCESS_CLASS.test(access)) {
      throw new Error(
        `The row of ${match[1]} ${match[2]} (line ${row}) has a "Declared access" the check cannot read: it must be one word of letters, digits, - and _.`,
      );
    }
    routes.push({ method: match[1], path: match[2], access });
  }
  if (routes.length === 0) {
    throw new Error('The "Route index" table has no routes.');
  }
  return routes;
}

function isSeparatorCell(cell: string): boolean {
  return /^:?-+:?$/.test(cell);
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

const isOpen = (route: Route) =>
  route.access === 'public' || route.access === 'shared';

function byPathThenMethod(
  a: { readonly method: string; readonly path: string },
  b: { readonly method: string; readonly path: string },
): number {
  const pathA = normalisePath(a.path);
  const pathB = normalisePath(b.path);
  if (pathA !== pathB) {
    return pathA < pathB ? -1 : 1;
  }
  const methodA = normaliseMethod(a.method);
  const methodB = normaliseMethod(b.method);
  if (methodA === methodB) {
    return 0;
  }
  return methodA < methodB ? -1 : 1;
}

/**
 * Compares the index with the coverage map, for every route of the index.
 *
 * `uncovered` is every route that is `public` or `shared` and in neither `covered` nor
 * `skipped`, plus every route skipped as frontend-only (reason {@link FRONTEND_ONLY}) that is
 * `public` or `shared` now (`nowCoverable`). `stale` is every route of `covered` or `skipped`
 * that the index does not list, whatever its access. `accessChanged` is every `covered` route
 * that the index lists with an access other than the one the client uses: not `public` or
 * `shared` any more (an API key gets 401 or 403), or `shared` now while the client calls it with
 * no credentials (401), or `public` now while the client sends a key. Methods and paths are
 * compared as {@link routeKey} spells them. The inputs are not changed.
 *
 * @param routes The rows of the index ({@link parseRouteIndex}).
 * @param coverage The coverage map of the data client.
 * @param clientAccess What the client calls each covered route as, by {@link routeKey}
 *   ({@link CLIENT_ACCESS}). Without it, or for a route it lacks, only a route that is not
 *   `public` or `shared` any more is reported.
 */
export function diffCoverage(
  routes: readonly Route[],
  coverage: DataCoverage,
  clientAccess?: ReadonlyMap<string, RouteAccess>,
): CoverageDiff {
  const covered = new Set(coverage.covered.map(routeKey));
  const skipped = new Map(coverage.skipped.map((s) => [routeKey(s), s]));
  const listed = new Set(routes.map(routeKey));

  const uncovered: UncoveredRoute[] = [];
  const accessChanged: AccessChange[] = [];
  for (const route of routes) {
    const key = routeKey(route);
    const entry = {
      method: route.method,
      path: route.path,
      access: route.access,
    };
    if (covered.has(key)) {
      const sent = clientAccess?.get(key);
      if (!isOpen(route)) {
        accessChanged.push(entry);
      } else if (sent !== undefined && sent !== route.access) {
        accessChanged.push({ ...entry, client: sent });
      }
      continue;
    }
    if (!isOpen(route)) {
      continue;
    }
    const skip = skipped.get(key);
    if (skip === undefined) {
      uncovered.push(entry);
    } else if (skip.reason === FRONTEND_ONLY) {
      uncovered.push({ ...entry, nowCoverable: true });
    }
  }

  const stale = new Map<string, { method: string; path: string }>();
  for (const entry of [...coverage.covered, ...coverage.skipped]) {
    const key = routeKey(entry);
    if (!listed.has(key) && !stale.has(key)) {
      stale.set(key, { method: entry.method, path: entry.path });
    }
  }

  return {
    uncovered: uncovered.sort(byPathThenMethod),
    stale: [...stale.values()].sort(byPathThenMethod),
    accessChanged: accessChanged.sort(byPathThenMethod),
  };
}

/**
 * The report of a {@link CoverageDiff} as Markdown: the body of the drift issue, and what the
 * command prints.
 */
export function formatReport(diff: CoverageDiff): string {
  if (
    diff.uncovered.length === 0 &&
    diff.stale.length === 0 &&
    diff.accessChanged.length === 0
  ) {
    return 'Route coverage is up to date: every public or shared route of the route index is covered or skipped, nothing in the coverage map is gone from the index, and every covered route still has the access the client uses.\n';
  }
  const parts = [
    "The backend's route registry and the data client's coverage map (`packages/client/src/data/coverage.ts`) disagree.",
  ];
  if (diff.uncovered.length > 0) {
    parts.push(
      [
        `### Not in the coverage map (${diff.uncovered.length})`,
        '',
        'Public or shared routes that are in neither `covered` nor `skipped`, or are skipped as frontend-only and are open now. Cover each one with a client method, or skip it with a reason.',
        '',
        ...diff.uncovered.map((route) =>
          route.nowCoverable === true
            ? `- \`${route.method} ${route.path}\` (${route.access}): now coverable, skipped as frontend-only`
            : `- \`${route.method} ${route.path}\` (${route.access})`,
        ),
      ].join('\n'),
    );
  }
  if (diff.stale.length > 0) {
    parts.push(
      [
        `### No longer in the route index (${diff.stale.length})`,
        '',
        'Routes in `covered` or `skipped` that the registry does not list any more: renamed, moved or removed. Update or remove them.',
        '',
        ...diff.stale.map((route) => `- \`${route.method} ${route.path}\``),
      ].join('\n'),
    );
  }
  if (diff.accessChanged.length > 0) {
    parts.push(
      [
        `### Covered, but the access changed (${diff.accessChanged.length})`,
        '',
        'Covered routes that the registry now declares with another access than the client uses. Not public or shared any more: an API key gets 401 or 403. Shared now, while the client sends no credentials: 401. Public now, while the client sends a key. Stop covering the route (remove the client method and skip it with a reason), change the client, or have the backend revert.',
        '',
        ...diff.accessChanged.map((route) => {
          if (route.client === 'public') {
            return `- \`${route.method} ${route.path}\` (now ${route.access}, the client sends it as public: 401)`;
          }
          if (route.client === 'shared') {
            return `- \`${route.method} ${route.path}\` (now ${route.access}, the client sends a key)`;
          }
          return `- \`${route.method} ${route.path}\` (now ${route.access})`;
        }),
      ].join('\n'),
    );
  }
  return `${parts.join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/** Runs a program and returns its standard output (`gh api`). */
export type Exec = (
  file: string,
  args: readonly string[],
  options: { env: Record<string, string | undefined> },
) => string;

/** What {@link runCli} uses; every part can be replaced (the tests do). */
export interface CliDeps {
  env: Record<string, string | undefined>;
  out: (text: string) => void;
  err: (text: string) => void;
  coverage: DataCoverage;
  /** What the client calls each covered route as ({@link CLIENT_ACCESS}). */
  clientAccess: ReadonlyMap<string, RouteAccess>;
  exec: Exec;
}

const defaultExec: Exec = (file, args, options) =>
  execFileSync(file, [...args], {
    encoding: 'utf8',
    env: options.env,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const USAGE = `Usage: route-coverage [--file <path>] [--report <path>]

  --file <path>    Read the route registry from this file instead of fetching it with gh api.
                   A relative path is relative to the working directory.
  --report <path>  Also write the report (Markdown) to this file, clean or not.

Without --file the registry is fetched with gh api from the place these environment variables
name (in CI they are secrets, and the check never prints their values):
  ROUTE_REGISTRY_REPO   the repository, as owner/name (required)
  ROUTE_REGISTRY_REF    a branch, tag or commit (main when unset)
  ROUTE_REGISTRY_PATH   the registry file in that repository (required)
and GH_TOKEN must be set: in CI it is the secret ${TOKEN_SECRET}, a token with read access
to that repository's contents.
Exit code: 0 up to date, 1 drift, 2 the check could not run.
`;

/** Thrown for what stops the check from running (exit code 2). */
class CheckError extends Error {}

/** `text` with each of the `hidden` values replaced by `***`, whatever the case it is written in. */
function redact(text: string, hidden: readonly string[]): string {
  // The longest first, so the whole URL goes before the pieces it is made of.
  return [...new Set(hidden)]
    .filter((value) => value !== '')
    .sort((a, b) => b.length - a.length)
    .reduce(
      (result, value) =>
        result.replace(
          new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
          '***',
        ),
      text,
    );
}

function fetchSource(
  env: Record<string, string | undefined>,
  exec: Exec,
): string {
  const source = registrySource(env);
  const token = env.GH_TOKEN?.trim() ?? '';
  // The location is a secret in CI: no message says where it points, only which variable holds it.
  const needs = `The secret ${TOKEN_SECRET} needs read access to the contents of the repository ROUTE_REGISTRY_REPO names.`;
  if (token === '') {
    throw new CheckError(
      `GH_TOKEN is not set or empty. In CI it comes from the secret ${TOKEN_SECRET}, which is missing or empty. ${needs} Add the secret, or run with --file <path> against a local copy of the route registry.`,
    );
  }
  // The path may hold characters a URL does not (a space, `#`, `?`): each segment is encoded.
  const segments = source.path.split('/');
  const path = segments.map(encodeURIComponent).join('/');
  const url = `repos/${source.repo}/contents/${path}?ref=${encodeURIComponent(source.ref)}`;
  try {
    return exec(
      'gh',
      ['api', '-H', 'Accept: application/vnd.github.raw+json', url],
      { env: { ...env, GH_TOKEN: token } },
    );
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail =
      (typeof stderr === 'string' || Buffer.isBuffer(stderr)
        ? String(stderr).trim()
        : '') || (error instanceof Error ? error.message : String(error));
    // What gh (or Node, with the command line) says may echo the URL, or a piece of the location.
    // A piece is a part of the repository or a segment of the path; one that is only letters
    // (`registry`, `rest`) is an ordinary word and stays, or the "rest" of docs.github.com/rest
    // would be blanked. The whole values and their encoded forms always go.
    const distinctive = (part: string) =>
      part.length >= 3 && /[^A-Za-z]/.test(part);
    const hidden = [
      token,
      url,
      source.repo,
      ...source.repo.split('/').filter(distinctive),
      source.path,
      path,
      ...segments.filter(distinctive),
      ...segments.map(encodeURIComponent).filter(distinctive),
      encodeURIComponent(source.ref),
      source.ref,
    ].filter((value) => value !== 'main');
    throw new CheckError(
      `Could not fetch the route registry from the place ROUTE_REGISTRY_REPO, ROUTE_REGISTRY_REF and ROUTE_REGISTRY_PATH name: ${redact(detail, hidden)}\n${needs}`,
    );
  }
}

function parseCliArgs(args: readonly string[]) {
  return parseArgs({
    args: [...args],
    options: {
      file: { type: 'string' },
      report: { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  }).values;
}

/**
 * Runs the check as the command does.
 *
 * @param argv The arguments after the script name.
 * @returns The exit code: 0 up to date, 1 drift, 2 the check could not run.
 */
export function runCli(
  argv: readonly string[],
  overrides: Partial<CliDeps> = {},
): number {
  const deps: CliDeps = {
    env: process.env,
    out: (text) => {
      process.stdout.write(text);
    },
    err: (text) => {
      process.stderr.write(text);
    },
    coverage: dataCoverage,
    clientAccess: CLIENT_ACCESS,
    exec: defaultExec,
    ...overrides,
  };
  let values: ReturnType<typeof parseCliArgs>;
  try {
    values = parseCliArgs(argv[0] === '--' ? argv.slice(1) : argv);
  } catch (error) {
    deps.err(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help === true) {
    deps.out(USAGE);
    return 0;
  }

  try {
    let source: string;
    if (values.file !== undefined) {
      try {
        source = readFileSync(values.file, 'utf8');
      } catch (error) {
        throw new CheckError(
          `Could not read ${values.file}: ${(error as Error).message}`,
        );
      }
    } else {
      source = fetchSource(deps.env, deps.exec);
    }
    const routes = parseRouteIndex(source);
    const diff = diffCoverage(routes, deps.coverage, deps.clientAccess);
    const report = formatReport(diff);

    const lines = [
      `Route index: ${routes.length} routes, ${routes.filter(isOpen).length} public or shared.`,
      `Coverage map: ${deps.coverage.covered.length} covered, ${deps.coverage.skipped.length} skipped.`,
    ];
    deps.out(`${lines.join('\n')}\n\n${report}`);
    if (values.report !== undefined) {
      writeFileSync(values.report, report);
    }
    return diff.uncovered.length > 0 ||
      diff.stale.length > 0 ||
      diff.accessChanged.length > 0
      ? 1
      : 0;
  } catch (error) {
    deps.err(`route-coverage: ${(error as Error).message}\n`);
    return 2;
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = runCli(process.argv.slice(2));
}
