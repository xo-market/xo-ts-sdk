import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  CLIENT_ACCESS,
  diffCoverage,
  formatReport,
  normaliseMethod,
  normalisePath,
  parseRouteIndex,
  type Route,
  registrySource,
  routeKey,
  runCli,
} from '../../scripts/route-coverage';
import {
  FRONTEND_ONLY,
  coverage as realCoverage,
} from '../../src/data/coverage';

// The backend route coverage check: the "Route index" table of the backend's route registry (a
// Markdown file) against `src/data/coverage.ts`. Where the registry is fetched from comes from the
// ROUTE_REGISTRY_* variables; the tests use a made-up repository, ref and path.

// An excerpt in the shape of the registry: the section before the index (a table whose rows also
// start with a route, in other columns), the index with every kind of "Declared access" it has
// (`shared`, `public`, `frontend`, and `none (no guard)`), and the appendix after it.
const FIXTURE = `# Route registry

## Routes by area

### An example area

| Route | Access | Notes |
|---|---|---|
| \`GET /api/v1/series/slug/:slug\` | public | Listed here only. |

## Route index

Every in-scope route with its handler and source, sorted by path, then method.

| Route | Handler | Source | Guards | Declared access |
|---|---|---|---|---|
| \`GET /api/auth/api-keys\` | \`ExampleKeysController.list\` | \`example/keys.controller.ts:1\` | KeyAuth | \`shared\` |
| \`POST /api/auth/api-keys\` | \`ExampleKeysController.create\` | \`example/keys.controller.ts:2\` | KeyAuth | \`frontend\` |
| \`POST /api/auth/api-keys/nonce\` | \`ExampleNonceController.create\` | \`example/nonce.controller.ts:1\` | none | none (no guard) |
| \`GET /api/categories\` | \`ExampleCategoriesController.list\` | \`example/categories.controller.ts:1\` | OptionalAuth public | \`public\` |
| \`GET /api/categories/:id\` | \`ExampleCategoriesController.get\` | \`example/categories.controller.ts:2\` | OptionalAuth both | \`frontend\` |
| \`GET /api/contests/:slug/markets\` | \`ExampleContestsController.markets\` | \`example/contests.controller.ts:1\` | none | none (no guard) |
| \`GET /api/markets/:id/activity\` | \`ExampleMarketsController.activity\` | \`example/markets.controller.ts:1\` | OptionalAuth mixed | \`public\` |
| \`GET /api/markets/activities\` | \`ExampleMarketsController.allActivity\` | \`example/markets.controller.ts:2\` | OptionalAuth public | \`public\` |
| \`GET /api/users/me/activities\` | \`ExampleAccountController.activity\` | \`example/account.controller.ts:1\` | KeyAuth, AccountCheck | \`shared\` |
| \`GET /api/v1/series/:seriesId\` | \`ExampleSeriesController.get\` | \`example/series.controller.ts:1\` | OptionalAuth public | \`public\` |

## Appendix: out of scope

404 routes are out of scope.

| Controller | Source | Kind | Routes |
|---|---|---|---|
| \`ExampleAdminController\` | \`example/admin.controller.ts\` | admin | 8 |
`;

const route = (method: string, path: string, access: string): Route => ({
  method,
  path,
  access,
});

describe('parseRouteIndex', () => {
  test('returns the rows of the Route index, in order, with the access class', () => {
    expect(parseRouteIndex(FIXTURE)).toEqual([
      route('GET', '/api/auth/api-keys', 'shared'),
      route('POST', '/api/auth/api-keys', 'frontend'),
      // No guard at all is open to anyone: public.
      route('POST', '/api/auth/api-keys/nonce', 'public'),
      route('GET', '/api/categories', 'public'),
      route('GET', '/api/categories/:id', 'frontend'),
      route('GET', '/api/contests/:slug/markets', 'public'),
      route('GET', '/api/markets/:id/activity', 'public'),
      route('GET', '/api/markets/activities', 'public'),
      route('GET', '/api/users/me/activities', 'shared'),
      route('GET', '/api/v1/series/:seriesId', 'public'),
    ]);
  });

  test('reads only the Route index: not the tables before and after it', () => {
    const paths = parseRouteIndex(FIXTURE).map((r) => r.path);
    // The "Routes by area" row (GET /api/v1/series/slug/:slug) is not in the index.
    expect(paths).not.toContain('/api/v1/series/slug/:slug');
    expect(paths).toHaveLength(10);
  });

  test('finds the Declared access column by its header, wherever it is', () => {
    const md = `## Route index

| Route | Declared access | Handler |
|---|---|---|
| \`GET /api/a\` | \`shared\` | \`A.a\` |
| \`GET /api/b\` | none (no guard) | \`B.b\` |
`;
    expect(parseRouteIndex(md)).toEqual([
      route('GET', '/api/a', 'shared'),
      route('GET', '/api/b', 'public'),
    ]);
  });

  test('fails loudly on a document it cannot read, instead of returning no routes', () => {
    expect(() => parseRouteIndex('# Something else\n')).toThrow(
      /no "Route index" section/,
    );
    expect(() => parseRouteIndex('## Route index\n\nNothing here.\n')).toThrow(
      /no table/,
    );
    expect(() =>
      parseRouteIndex(
        '## Route index\n\n| Route | Handler |\n|---|---|\n| `GET /api/a` | `A.a` |\n',
      ),
    ).toThrow(/Declared access/);
    // A table with a header and no route rows is a document that changed, not a clean index.
    expect(() =>
      parseRouteIndex(
        '## Route index\n\n| Route | Declared access |\n|---|---|\n',
      ),
    ).toThrow(/no routes/);
    // A row of the index that is cut short.
    expect(() =>
      parseRouteIndex(
        '## Route index\n\n| Route | Handler | Declared access |\n|---|---|---|\n| `GET /api/a` | `A.a` |\n',
      ),
    ).toThrow(/GET \/api\/a/);
  });
});

describe('parseRouteIndex: the shape of the table', () => {
  const head =
    '## Route index\n\n| Route | Handler | Declared access |\n|---|---|---|\n';

  test('reads an escaped pipe inside a cell without losing the column', () => {
    const rows = parseRouteIndex(
      `${head}| \`GET /api/a\` | \`A.a \\| b\` | \`shared\` |\n`,
    );
    expect(rows).toEqual([route('GET', '/api/a', 'shared')]);
  });

  test('reads a document with CRLF line ends', () => {
    expect(parseRouteIndex(FIXTURE.replace(/\n/g, '\r\n'))).toEqual(
      parseRouteIndex(FIXTURE),
    );
  });

  test('a second table after the first, or the same table after a blank line, is an error: its routes would never be seen', () => {
    // A blank line in the middle of the table.
    expect(() =>
      parseRouteIndex(
        `${head}| \`GET /api/a\` | \`A.a\` | \`shared\` |\n\n| \`GET /api/b\` | \`B.b\` | \`public\` |\n`,
      ),
    ).toThrow(/after the first table/);
    // A second table.
    expect(() =>
      parseRouteIndex(
        `${head}| \`GET /api/a\` | \`A.a\` | \`shared\` |\n\nMore.\n\n| Route | Handler | Declared access |\n|---|---|---|\n| \`GET /api/b\` | \`B.b\` | \`public\` |\n`,
      ),
    ).toThrow(/after the first table/);
    // Text after the table is fine, up to the next heading.
    expect(
      parseRouteIndex(
        `${head}| \`GET /api/a\` | \`A.a\` | \`shared\` |\n\nA note.\n\n## Appendix\n\n| x |\n`,
      ),
    ).toEqual([route('GET', '/api/a', 'shared')]);
  });

  test('a row with another number of cells than the header is an error', () => {
    expect(() =>
      parseRouteIndex(
        `${head}| \`GET /api/a\` | \`A.a\` | \`shared\` | extra |\n`,
      ),
    ).toThrow(/4 cells, the header has 3/);
  });

  test('a blank row of the table is an error, not a skipped line', () => {
    expect(() =>
      parseRouteIndex(
        `${head}| \`GET /api/a\` | \`A.a\` | \`shared\` |\n| | | |\n`,
      ),
    ).toThrow(/no route/);
    expect(() =>
      parseRouteIndex(`${head}| \`GET /api/a\` | \`A.a\` | \`shared\` |\n|\n`),
    ).toThrow(/cells/);
  });

  test('the route cell takes a method and a path and nothing else', () => {
    for (const cell of [
      '`GET /api/a` `x`',
      '`GET /api/a`b`',
      '`GET /api/@a`',
      '`GET /api/a b`',
      '`GET api/a`',
      '`GET /api/a?x=1`',
      '`GET /api/<script>`',
      'GET /api/a',
    ]) {
      expect(
        () => parseRouteIndex(`${head}| ${cell} | \`A.a\` | \`shared\` |\n`),
        cell,
      ).toThrow(/no route/);
    }
    // What the registry writes: params, dashes, dots, digits, and `{id}` too.
    expect(
      parseRouteIndex(
        `${head}| \`GET /api/v1/events/:eventId/charts/points\` | \`A.a\` | \`shared\` |\n| \`GET /api/x_y.z/{id}-2\` | \`B.b\` | \`public\` |\n`,
      ).map((r) => r.path),
    ).toEqual(['/api/v1/events/:eventId/charts/points', '/api/x_y.z/{id}-2']);
  });

  test('the access is a word, since it is echoed in the issue', () => {
    for (const access of [
      '`shared` @team',
      '`**bold**`',
      '`a b`',
      '`[x](http://evil)`',
      '',
    ]) {
      expect(() =>
        parseRouteIndex(`${head}| \`GET /api/a\` | \`A.a\` | ${access} |\n`),
      ).toThrow(/Declared access/);
    }
    // The classes the registry has, and a new class name.
    expect(
      parseRouteIndex(
        `${head}| \`GET /api/a\` | \`A.a\` | \`frontend\` |\n| \`GET /api/b\` | \`B.b\` | \`admin-only\` |\n`,
      ).map((r) => r.access),
    ).toEqual(['frontend', 'admin-only']);
  });
});

// The registry is private and its rows carry the handler class and the source file of each route.
// When the fetched file does not parse, the error ends up in the log of a public run, so it names
// the row (by its line) and, when the route cell reads, the route: never the text of the row.
const SECRET_CELLS = {
  handler: 'SecretController.list',
  source: 'internal/secret.controller.ts:12',
  guard: 'SecretGuard',
};
const SECRET_PARTS = [
  'SecretController',
  'secret.controller',
  'internal/',
  'SecretGuard',
  '@team',
  'weird-access',
];
const WIDE_HEAD =
  '## Route index\n\n| Route | Handler | Source | Guards | Declared access |\n|---|---|---|---|---|\n| `GET /api/ok` | `Fine.list` | `fine/ok.controller.ts:1` | KeyAuth | `shared` |\n';
// The bad row is the fourth line after the heading: line 6 of the document.
const WIDE_ROW = (route: string, access: string, extra = '') =>
  `| ${route} | \`${SECRET_CELLS.handler}\` | \`${SECRET_CELLS.source}\` | ${SECRET_CELLS.guard} | ${access} |${extra}\n`;

const MALFORMED: Array<[string, string, RegExp[]]> = [
  [
    'a row with more cells than the header',
    `${WIDE_HEAD}| \`GET /api/x\` | \`${SECRET_CELLS.handler}\` | \`${SECRET_CELLS.source}\` | ${SECRET_CELLS.guard} | \`shared\` | \`extra\` | \`more\` |\n`,
    [/line 6/, /7 cells, the header has 5/, /GET \/api\/x/],
  ],
  [
    'a row that is cut short',
    `${WIDE_HEAD}| \`GET /api/x\` | \`${SECRET_CELLS.handler}\` | \`${SECRET_CELLS.source}\` |\n`,
    [/line 6/, /3 cells, the header has 5/, /GET \/api\/x/],
  ],
  [
    'a row cut short before the route cell reads',
    `${WIDE_HEAD}| not a route | \`${SECRET_CELLS.handler}\` |\n`,
    [/line 6/, /2 cells, the header has 5/],
  ],
  [
    'a row without a route',
    `${WIDE_HEAD}${WIDE_ROW('`GET /api/@x`', '`shared`')}`,
    [/line 6/, /no route/],
  ],
  [
    'a row with an access the check cannot read',
    `${WIDE_HEAD}${WIDE_ROW('`GET /api/x`', '`weird-access` @team')}`,
    [/line 6/, /GET \/api\/x/, /Declared access/],
  ],
  [
    'table lines after the table',
    `${WIDE_HEAD}\n${WIDE_ROW('`GET /api/y`', '`shared`')}`,
    [/line 7/, /after the first table/],
  ],
];

describe('parseRouteIndex: an error names the row, not its text', () => {
  test.each(MALFORMED)('%s', (_name, markdown, expected) => {
    let message = '';
    try {
      parseRouteIndex(markdown);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    for (const pattern of expected) {
      expect(message).toMatch(pattern);
    }
    for (const part of SECRET_PARTS) {
      expect(message, `the error has "${part}"`).not.toContain(part);
    }
    // No cell of the row at all: the message is short.
    expect(message.length).toBeLessThan(250);
  });
});

describe('normalisation', () => {
  test('path params are `:name` whichever way they are written', () => {
    expect(normalisePath('/api/markets/{id}/activity')).toBe(
      '/markets/:id/activity',
    );
    expect(normalisePath('/api/markets/:id/activity')).toBe(
      '/markets/:id/activity',
    );
  });

  test('the /api prefix and trailing slashes do not matter', () => {
    expect(normalisePath('/api/markets/')).toBe('/markets');
    expect(normalisePath('/markets')).toBe('/markets');
    expect(normalisePath('markets')).toBe('/markets');
    expect(normalisePath('/api')).toBe('/');
    expect(normalisePath('/')).toBe('/');
    // Only a whole first segment is the prefix.
    expect(normalisePath('/apis/markets')).toBe('/apis/markets');
    expect(normalisePath('/api/v1/events')).toBe('/v1/events');
  });

  test('param names stay as written: a renamed param is a different route', () => {
    expect(normalisePath('/api/markets/:id')).not.toBe(
      normalisePath('/api/markets/:marketId'),
    );
  });

  test('the method is upper case', () => {
    expect(normaliseMethod('get')).toBe('GET');
    expect(routeKey({ method: 'post', path: '/api/a/' })).toBe('POST /a');
  });
});

describe('diffCoverage', () => {
  const none = { covered: [], skipped: [] };

  test('a shared route in neither covered nor skipped is uncovered', () => {
    const diff = diffCoverage(
      [route('GET', '/api/users/me/new-thing', 'shared')],
      {
        covered: [{ method: 'GET', path: '/api/markets' }],
        skipped: [{ method: 'GET', path: '/api/pulse', reason: 'x' }],
      },
    );
    expect(diff.uncovered).toEqual([
      route('GET', '/api/users/me/new-thing', 'shared'),
    ]);
    expect(diff.stale).toEqual([
      { method: 'GET', path: '/api/markets' },
      { method: 'GET', path: '/api/pulse' },
    ]);
  });

  test('a public route in neither list is uncovered too; a frontend one is not', () => {
    const diff = diffCoverage(
      [
        route('GET', '/api/a', 'public'),
        route('GET', '/api/b', 'frontend'),
        route('GET', '/api/c', 'admin'),
      ],
      none,
    );
    expect(diff.uncovered).toEqual([route('GET', '/api/a', 'public')]);
    expect(diff.stale).toEqual([]);
  });

  test('a covered or skipped route that is gone from the index is stale', () => {
    const diff = diffCoverage([route('GET', '/api/kept', 'public')], {
      covered: [
        { method: 'GET', path: '/api/kept' },
        { method: 'GET', path: '/api/removed' },
      ],
      skipped: [
        { method: 'POST', path: '/api/also-removed', reason: 'write route' },
      ],
    });
    expect(diff.uncovered).toEqual([]);
    expect(diff.stale).toEqual([
      { method: 'POST', path: '/api/also-removed' },
      { method: 'GET', path: '/api/removed' },
    ]);
  });

  test('a route that only changed its method is both uncovered and stale', () => {
    const diff = diffCoverage([route('PUT', '/api/a', 'shared')], {
      covered: [{ method: 'POST', path: '/api/a' }],
      skipped: [],
    });
    expect(diff.uncovered).toEqual([route('PUT', '/api/a', 'shared')]);
    expect(diff.stale).toEqual([{ method: 'POST', path: '/api/a' }]);
  });

  test('a route skipped as frontend-only that is now public or shared is uncovered, as now coverable', () => {
    const diff = diffCoverage(
      [
        route('GET', '/api/opened', 'shared'),
        route('GET', '/api/opened-public', 'public'),
        route('GET', '/api/still-frontend', 'frontend'),
        // Skipped for another reason: opening it changes nothing.
        route('GET', '/api/not-yet', 'shared'),
      ],
      {
        covered: [],
        skipped: [
          { method: 'GET', path: '/api/opened', reason: FRONTEND_ONLY },
          { method: 'GET', path: '/api/opened-public', reason: FRONTEND_ONLY },
          {
            method: 'GET',
            path: '/api/still-frontend',
            reason: FRONTEND_ONLY,
          },
          {
            method: 'GET',
            path: '/api/not-yet',
            reason: 'not part of the SDK yet',
          },
        ],
      },
    );
    expect(diff.uncovered).toEqual([
      { ...route('GET', '/api/opened', 'shared'), nowCoverable: true },
      { ...route('GET', '/api/opened-public', 'public'), nowCoverable: true },
    ]);
    expect(diff.stale).toEqual([]);
  });

  test('both sides are normalised the same way', () => {
    const diff = diffCoverage(
      [
        route('GET', '/api/markets/{id}/activity', 'public'),
        route('GET', '/api/pulse/', 'public'),
        route('get', '/api/categories', 'public'),
        route('GET', '/api/skipped/{id}', 'frontend'),
      ],
      {
        covered: [
          { method: 'GET', path: '/api/markets/:id/activity' },
          { method: 'GET', path: '/pulse' },
          { method: 'GET', path: '/api/categories/' },
        ],
        skipped: [
          { method: 'GET', path: '/api/skipped/:id', reason: FRONTEND_ONLY },
        ],
      },
    );
    expect(diff).toEqual({ uncovered: [], stale: [], accessChanged: [] });
  });

  test('takes readonly arrays and does not change them', () => {
    const routes = Object.freeze([
      Object.freeze(route('GET', '/api/z', 'public')),
      Object.freeze(route('GET', '/api/a', 'shared')),
    ]) as readonly Route[];
    const covered = Object.freeze([
      Object.freeze({ method: 'GET', path: '/api/y' }),
      Object.freeze({ method: 'GET', path: '/api/b' }),
    ]);
    const skipped = Object.freeze([
      Object.freeze({ method: 'GET', path: '/api/x', reason: 'no' }),
    ]);
    const diff = diffCoverage(routes, { covered, skipped });
    // Sorted by path, then method, like the index.
    expect(diff.uncovered.map((r) => r.path)).toEqual(['/api/a', '/api/z']);
    expect(diff.stale.map((r) => r.path)).toEqual([
      '/api/b',
      '/api/x',
      '/api/y',
    ]);
    expect(routes.map((r) => r.path)).toEqual(['/api/z', '/api/a']);
    expect(covered.map((r) => r.path)).toEqual(['/api/y', '/api/b']);
  });

  test('the data client coverage is consistent with an index derived from it', () => {
    // An index that lists every covered route with the access the client calls it with, and
    // every skipped route as the map says it is (frontend-only ones as frontend, the others
    // open): nothing is uncovered, stale or changed.
    const derived: Route[] = [
      ...realCoverage.covered.map((r) =>
        route(r.method, r.path, CLIENT_ACCESS.get(routeKey(r)) ?? 'missing'),
      ),
      ...realCoverage.skipped.map((r) =>
        route(
          r.method,
          r.path,
          r.reason === FRONTEND_ONLY ? 'frontend' : 'public',
        ),
      ),
    ];
    expect(derived.filter((r) => r.access === 'missing')).toEqual([]);
    expect(diffCoverage(derived, realCoverage, CLIENT_ACCESS)).toEqual({
      uncovered: [],
      stale: [],
      accessChanged: [],
    });
    // The client's access is in the map for every covered route, and only those.
    expect(CLIENT_ACCESS.size).toBe(realCoverage.covered.length);
  });

  test('a route of any area is demanded: there is no area filter', () => {
    const diff = diffCoverage(
      [
        route('GET', '/api/squads', 'public'),
        route('GET', '/api/some-new-area/things', 'shared'),
      ],
      none,
    );
    expect(diff.uncovered.map((r) => r.path)).toEqual([
      '/api/some-new-area/things',
      '/api/squads',
    ]);
  });

  test('the data client coverage and the real rows of the fixture: nothing uncovered, nothing changed', () => {
    // The fixture rows are rows of the registry. (Most of the map is not in the fixture, so it is
    // not asked for staleness here.)
    const diff = diffCoverage(parseRouteIndex(FIXTURE), realCoverage);
    expect(diff.uncovered).toEqual([]);
    expect(diff.accessChanged).toEqual([]);
  });
});

describe('diffCoverage: access changed', () => {
  const none = { covered: [], skipped: [] };

  test('a covered route that is frontend now is reported: an API key would get 401 or 403', () => {
    const diff = diffCoverage([route('GET', '/api/was-public', 'frontend')], {
      covered: [{ method: 'GET', path: '/api/was-public' }],
      skipped: [],
    });
    expect(diff.accessChanged).toEqual([
      route('GET', '/api/was-public', 'frontend'),
    ]);
    // It is in the index: not stale. It is covered: not uncovered.
    expect(diff.stale).toEqual([]);
    expect(diff.uncovered).toEqual([]);
  });

  test('anything that is not public or shared counts, whatever the class is called', () => {
    const diff = diffCoverage(
      [
        route('GET', '/api/a', 'admin'),
        route('GET', '/api/b', 'frontend'),
        route('GET', '/api/c', 'something-new'),
      ],
      {
        covered: [
          { method: 'GET', path: '/api/c' },
          { method: 'GET', path: '/api/a' },
          { method: 'GET', path: '/api/b' },
        ],
        skipped: [],
      },
    );
    expect(diff.accessChanged.map((r) => `${r.path} ${r.access}`)).toEqual([
      '/api/a admin',
      '/api/b frontend',
      '/api/c something-new',
    ]);
  });

  test('a covered route that is public or shared is not reported, whichever of the two', () => {
    const diff = diffCoverage(
      [route('GET', '/api/a', 'public'), route('GET', '/api/b', 'shared')],
      {
        covered: [
          { method: 'GET', path: '/api/a' },
          { method: 'GET', path: '/api/b' },
        ],
        skipped: [],
      },
    );
    expect(diff).toEqual({ uncovered: [], stale: [], accessChanged: [] });
  });

  test('a public route that is shared now is reported: the client sends no credentials, so 401', () => {
    const covered = [{ method: 'GET', path: '/api/markets/:id/activity' }];
    const diff = diffCoverage(
      [route('GET', '/api/markets/{id}/activity', 'shared')],
      { covered, skipped: [] },
      new Map([[routeKey(covered[0] as Route), 'public']]),
    );
    expect(diff.accessChanged).toEqual([
      {
        ...route('GET', '/api/markets/{id}/activity', 'shared'),
        client: 'public',
      },
    ]);
    expect(diff.stale).toEqual([]);
    expect(diff.uncovered).toEqual([]);
  });

  test('a shared route that is public now is reported: the client sends a key it does not need', () => {
    const covered = [{ method: 'GET', path: '/api/users/me/stats' }];
    const diff = diffCoverage(
      [route('GET', '/api/users/me/stats', 'public')],
      { covered, skipped: [] },
      new Map([[routeKey(covered[0] as Route), 'shared']]),
    );
    expect(diff.accessChanged).toEqual([
      { ...route('GET', '/api/users/me/stats', 'public'), client: 'shared' },
    ]);
  });

  test('the same access, a route the client map lacks, and no client map: nothing is reported', () => {
    const covered = [
      { method: 'GET', path: '/api/a' },
      { method: 'GET', path: '/api/b' },
      { method: 'GET', path: '/api/c' },
    ];
    const routes = [
      route('GET', '/api/a', 'public'),
      route('GET', '/api/b', 'shared'),
      route('GET', '/api/c', 'shared'),
    ];
    const clientAccess = new Map<string, 'public' | 'shared'>([
      ['GET /a', 'public'],
      ['GET /b', 'shared'],
    ]);
    expect(
      diffCoverage(routes, { covered, skipped: [] }, clientAccess)
        .accessChanged,
    ).toEqual([]);
    expect(
      diffCoverage(routes, { covered, skipped: [] }).accessChanged,
    ).toEqual([]);
  });

  test('a skipped route is not compared with the client: it has no client call', () => {
    const diff = diffCoverage(
      [route('GET', '/api/s', 'shared')],
      {
        covered: [],
        skipped: [{ method: 'GET', path: '/api/s', reason: 'not v1' }],
      },
      new Map([['GET /s', 'public']]),
    );
    expect(diff.accessChanged).toEqual([]);
  });

  test('a route that is frontend now has no client field: it is not about public or shared', () => {
    const diff = diffCoverage(
      [route('GET', '/api/a', 'frontend')],
      { covered: [{ method: 'GET', path: '/api/a' }], skipped: [] },
      new Map([['GET /a', 'public']]),
    );
    expect(diff.accessChanged).toEqual([route('GET', '/api/a', 'frontend')]);
  });

  test('only covered routes: a skipped route that is frontend, or anything else, is not', () => {
    const diff = diffCoverage(
      [
        route('GET', '/api/skipped-frontend', 'frontend'),
        route('GET', '/api/skipped-admin', 'admin'),
      ],
      {
        covered: [],
        skipped: [
          {
            method: 'GET',
            path: '/api/skipped-frontend',
            reason: FRONTEND_ONLY,
          },
          { method: 'GET', path: '/api/skipped-admin', reason: 'not v1' },
        ],
      },
    );
    expect(diff.accessChanged).toEqual([]);
    expect(diff.uncovered).toEqual([]);
  });

  test('a route not in the index is stale, not access changed', () => {
    const diff = diffCoverage([], {
      covered: [{ method: 'GET', path: '/api/gone' }],
      skipped: [],
    });
    expect(diff.stale).toEqual([{ method: 'GET', path: '/api/gone' }]);
    expect(diff.accessChanged).toEqual([]);
  });

  test('both sides are normalised the same way, and the input is not changed', () => {
    const routes = Object.freeze([
      Object.freeze(route('GET', '/api/z/{id}/', 'frontend')),
      Object.freeze(route('GET', '/api/a', 'frontend')),
    ]) as readonly Route[];
    const covered = Object.freeze([
      Object.freeze({ method: 'get', path: '/z/:id' }),
      Object.freeze({ method: 'GET', path: '/api/a/' }),
    ]);
    const diff = diffCoverage(routes, { covered, skipped: none.skipped });
    // The index spelling is reported, sorted by path.
    expect(diff.accessChanged).toEqual([
      route('GET', '/api/a', 'frontend'),
      route('GET', '/api/z/{id}/', 'frontend'),
    ]);
    expect(routes.map((r) => r.path)).toEqual(['/api/z/{id}/', '/api/a']);
  });
});

describe('formatReport', () => {
  test('lists the uncovered and the stale routes, and marks the now coverable', () => {
    const text = formatReport({
      uncovered: [
        route('GET', '/api/a', 'public'),
        { ...route('GET', '/api/b', 'shared'), nowCoverable: true },
      ],
      stale: [{ method: 'POST', path: '/api/c' }],
      accessChanged: [route('GET', '/api/d', 'frontend')],
    });
    expect(text).toContain('Not in the coverage map (2)');
    expect(text).toContain('- `GET /api/a` (public)');
    expect(text).toContain(
      '- `GET /api/b` (shared): now coverable, skipped as frontend-only',
    );
    expect(text).toContain('No longer in the route index (1)');
    expect(text).toContain('- `POST /api/c`');
    // Its own section, with the access it has now.
    expect(text).toContain('Covered, but the access changed (1)');
    expect(text).toContain('- `GET /api/d` (now frontend)');
  });

  test('says what a public/shared flip does to the client', () => {
    const text = formatReport({
      uncovered: [],
      stale: [],
      accessChanged: [
        { ...route('GET', '/api/p', 'shared'), client: 'public' },
        { ...route('GET', '/api/q', 'public'), client: 'shared' },
      ],
    });
    expect(text).toContain('Covered, but the access changed (2)');
    expect(text).toContain(
      '- `GET /api/p` (now shared, the client sends it as public: 401)',
    );
    expect(text).toContain(
      '- `GET /api/q` (now public, the client sends a key)',
    );
  });

  test('a report of access changes only is not up to date', () => {
    const text = formatReport({
      uncovered: [],
      stale: [],
      accessChanged: [route('GET', '/api/d', 'frontend')],
    });
    expect(text).not.toMatch(/up to date/);
    expect(text).not.toContain('Not in the coverage map');
    expect(text).not.toContain('No longer in the route index');
    expect(text).toContain('Covered, but the access changed (1)');
  });

  test('says so when there is nothing to report', () => {
    const text = formatReport({ uncovered: [], stale: [], accessChanged: [] });
    expect(text).toMatch(/up to date/);
    expect(text).not.toContain('Not in the coverage map');
    expect(text).not.toContain('not public or shared any more');
  });
});

describe('registrySource', () => {
  test('registrySource reads the three variables', () => {
    expect(
      registrySource({
        ROUTE_REGISTRY_REPO: 'acme/registry',
        ROUTE_REGISTRY_REF: 'main',
        ROUTE_REGISTRY_PATH: 'docs/ROUTES.md',
      }),
    ).toEqual({ repo: 'acme/registry', ref: 'main', path: 'docs/ROUTES.md' });
    // The ref is the variable's, not a fixed one.
    expect(
      registrySource({
        ROUTE_REGISTRY_REPO: 'acme/registry',
        ROUTE_REGISTRY_REF: 'release',
        ROUTE_REGISTRY_PATH: 'docs/ROUTES.md',
      }).ref,
    ).toBe('release');
  });

  test('ref defaults to main', () => {
    const env = {
      ROUTE_REGISTRY_REPO: 'acme/registry',
      ROUTE_REGISTRY_PATH: 'docs/ROUTES.md',
    };
    expect(registrySource(env).ref).toBe('main');
    // An unset repository variable reaches the job as an empty string: the same.
    expect(registrySource({ ...env, ROUTE_REGISTRY_REF: '' }).ref).toBe('main');
    expect(registrySource({ ...env, ROUTE_REGISTRY_REF: '  ' }).ref).toBe(
      'main',
    );
  });

  test('the values are trimmed', () => {
    expect(
      registrySource({
        ROUTE_REGISTRY_REPO: ' acme/registry\n',
        ROUTE_REGISTRY_REF: ' main ',
        ROUTE_REGISTRY_PATH: ' docs/ROUTES.md ',
      }),
    ).toEqual({ repo: 'acme/registry', ref: 'main', path: 'docs/ROUTES.md' });
  });

  test.each([['ROUTE_REGISTRY_REPO'], ['ROUTE_REGISTRY_PATH']])(
    'a missing %s throws an Error that names it',
    (name) => {
      const env: NodeJS.ProcessEnv = {
        ROUTE_REGISTRY_REPO: 'acme/registry',
        ROUTE_REGISTRY_PATH: 'docs/ROUTES.md',
      };
      for (const value of [undefined, '', '   ']) {
        expect(() => registrySource({ ...env, [name]: value })).toThrow(
          new RegExp(`^${name} is not set`),
        );
      }
      expect(() => registrySource({ ...env, [name]: undefined })).toThrow(
        Error,
      );
    },
  );

  test('with nothing set, the first missing variable is the one named', () => {
    expect(() => registrySource({})).toThrow(/ROUTE_REGISTRY_REPO/);
  });
});

describe('runCli', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function indexFile(text = FIXTURE): Promise<{
    dir: string;
    file: string;
  }> {
    const dir = await mkdtemp(join(tmpdir(), 'xo-route-coverage-'));
    dirs.push(dir);
    const file = join(dir, 'ROUTES.md');
    await writeFile(file, text);
    return { dir, file };
  }

  const FIXTURE_COVERAGE = {
    covered: [
      { method: 'GET', path: '/api/categories' },
      { method: 'GET', path: '/api/markets/:id/activity' },
      { method: 'GET', path: '/api/markets/activities' },
      { method: 'GET', path: '/api/users/me/activities' },
      { method: 'GET', path: '/api/v1/series/:seriesId' },
    ],
    skipped: [
      { method: 'GET', path: '/api/auth/api-keys', reason: 'see auth' },
      { method: 'POST', path: '/api/auth/api-keys', reason: FRONTEND_ONLY },
      {
        method: 'POST',
        path: '/api/auth/api-keys/nonce',
        reason: 'wallet sign-in',
      },
      { method: 'GET', path: '/api/categories/:id', reason: FRONTEND_ONLY },
      {
        method: 'GET',
        path: '/api/contests/:slug/markets',
        reason: 'out of scope',
      },
    ],
  };

  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      deps: {
        out: (text: string) => out.push(text),
        err: (text: string) => err.push(text),
      },
    };
  }

  test('--file: a clean index exits 0 and says so', async () => {
    const { file, dir } = await indexFile();
    const io = capture();
    const report = join(dir, 'report.md');
    const code = runCli(['--file', file, '--report', report], {
      ...io.deps,
      env: {},
      coverage: FIXTURE_COVERAGE,
    });
    expect(code).toBe(0);
    expect(io.out.join('')).toMatch(/up to date/);
    expect(io.err).toEqual([]);
    // The report file is written for a clean run too (the workflow checks it exists).
    expect(await readFile(report, 'utf8')).toMatch(/up to date/);
  });

  test('--file: drift exits 1, prints it and writes the report', async () => {
    const { file, dir } = await indexFile();
    const io = capture();
    const report = join(dir, 'report.md');
    const code = runCli(['--file', file, '--report', report], {
      ...io.deps,
      env: {},
      coverage: {
        covered: FIXTURE_COVERAGE.covered.filter(
          (r) => r.path !== '/api/categories',
        ),
        skipped: [
          ...FIXTURE_COVERAGE.skipped,
          { method: 'GET', path: '/api/gone', reason: 'was a thing' },
        ],
      },
    });
    expect(code).toBe(1);
    const text = await readFile(report, 'utf8');
    expect(text).toContain('`GET /api/categories` (public)');
    expect(text).toContain('`GET /api/gone`');
    expect(io.out.join('')).toContain('`GET /api/categories` (public)');
  });

  test('a public or shared route of a new area is drift: every area is checked', async () => {
    const { file } = await indexFile(
      FIXTURE.replace(
        '\n\n## Appendix',
        '\n| `GET /api/squads` | `ExampleSquadsController.list` | `example/squads.controller.ts:1` | KeyAuth | `shared` |\n\n## Appendix',
      ),
    );
    const io = capture();
    expect(
      runCli(['--file', file], {
        ...io.deps,
        env: {},
        coverage: FIXTURE_COVERAGE,
      }),
    ).toBe(1);
    expect(io.out.join('')).toContain('`GET /api/squads` (shared)');
    expect(io.out.join('')).not.toMatch(/outside the covered areas/);
  });

  test('a covered public route that is shared now exits 1: the client would get 401', async () => {
    const { file, dir } = await indexFile(
      FIXTURE.replace(
        '| `GET /api/markets/:id/activity` | `ExampleMarketsController.activity` | `example/markets.controller.ts:1` | OptionalAuth mixed | `public` |',
        '| `GET /api/markets/:id/activity` | `ExampleMarketsController.activity` | `example/markets.controller.ts:1` | KeyAuth | `shared` |',
      ),
    );
    const report = join(dir, 'report.md');
    const io = capture();
    expect(
      runCli(['--file', file, '--report', report], {
        ...io.deps,
        env: {},
        coverage: FIXTURE_COVERAGE,
      }),
    ).toBe(1);
    const text = await readFile(report, 'utf8');
    expect(text).toContain(
      '- `GET /api/markets/:id/activity` (now shared, the client sends it as public: 401)',
    );
    // With the client's access replaced by what the index says, nothing is wrong.
    const same = capture();
    expect(
      runCli(['--file', file], {
        ...same.deps,
        env: {},
        coverage: FIXTURE_COVERAGE,
        clientAccess: new Map([
          ['GET /markets/:id/activity', 'shared'],
          ['GET /categories', 'public'],
          ['GET /markets/activities', 'public'],
          ['GET /users/me/activities', 'shared'],
          ['GET /v1/series/:seriesId', 'public'],
        ]),
      }),
    ).toBe(0);
  });

  test('a covered route that is frontend now exits 1 and is in the report and the file', async () => {
    const { file, dir } = await indexFile(
      FIXTURE.replace(
        '| `GET /api/categories` | `ExampleCategoriesController.list` | `example/categories.controller.ts:1` | OptionalAuth public | `public` |',
        '| `GET /api/categories` | `ExampleCategoriesController.list` | `example/categories.controller.ts:1` | OptionalAuth both | `frontend` |',
      ),
    );
    const report = join(dir, 'report.md');
    const io = capture();
    expect(
      runCli(['--file', file, '--report', report], {
        ...io.deps,
        env: {},
        coverage: FIXTURE_COVERAGE,
      }),
    ).toBe(1);
    for (const text of [io.out.join(''), await readFile(report, 'utf8')]) {
      expect(text).toContain('Covered, but the access changed (1)');
      expect(text).toContain('- `GET /api/categories` (now frontend)');
      expect(text).not.toContain('Not in the coverage map');
    }
  });

  // The registry location as the workflow passes it, with made-up values.
  const REGISTRY_ENV = {
    ROUTE_REGISTRY_REPO: 'acme/registry',
    ROUTE_REGISTRY_REF: 'main',
    ROUTE_REGISTRY_PATH: 'docs/ROUTES.md',
  };

  // The location is a secret in CI: nothing the check prints may carry it (neither a value, nor
  // the pieces of the URL made from it).
  function expectNoLocation(
    text: string,
    location: {
      ROUTE_REGISTRY_REPO: string;
      ROUTE_REGISTRY_REF: string;
      ROUTE_REGISTRY_PATH: string;
    },
  ) {
    const hidden = [
      location.ROUTE_REGISTRY_REPO,
      location.ROUTE_REGISTRY_PATH,
      location.ROUTE_REGISTRY_PATH.split('/').map(encodeURIComponent).join('/'),
      location.ROUTE_REGISTRY_PATH.split('/').at(-1) ?? '',
      `repos/${location.ROUTE_REGISTRY_REPO}`,
      'contents/',
    ];
    // The default ref is not a secret: it is `main` in the script.
    if (location.ROUTE_REGISTRY_REF !== 'main') {
      hidden.push(location.ROUTE_REGISTRY_REF);
    }
    for (const value of hidden) {
      expect(text, `the output has "${value}"`).not.toContain(value);
    }
  }

  test('without --file and without GH_TOKEN it fails, naming the secret and what it needs', () => {
    const io = capture();
    const code = runCli([], {
      ...io.deps,
      env: { ...REGISTRY_ENV, GH_TOKEN: '' },
      coverage: FIXTURE_COVERAGE,
      exec: () => {
        throw new Error('must not call gh without a token');
      },
    });
    expect(code).toBe(2);
    const message = io.err.join('');
    expect(message).toContain('ROUTE_REGISTRY_TOKEN');
    // It names the variable, never the repository it holds.
    expect(message).toContain(
      'read access to the contents of the repository ROUTE_REGISTRY_REPO names',
    );
    expect(message).toContain('--file');
    expectNoLocation(message, REGISTRY_ENV);
  });

  test('without --file it fetches the file from the repository the variables name, with gh api and the token', async () => {
    const io = capture();
    const calls: Array<{
      file: string;
      args: readonly string[];
      env: Record<string, string | undefined>;
    }> = [];
    const code = runCli([], {
      ...io.deps,
      env: { ...REGISTRY_ENV, GH_TOKEN: 'a-token', PATH: '/usr/bin' },
      coverage: FIXTURE_COVERAGE,
      exec: (file, args, options) => {
        calls.push({ file, args, env: options.env });
        return FIXTURE;
      },
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe('gh');
    expect(calls[0]?.args).toEqual([
      'api',
      '-H',
      'Accept: application/vnd.github.raw+json',
      'repos/acme/registry/contents/docs/ROUTES.md?ref=main',
    ]);
    expect(calls[0]?.env.GH_TOKEN).toBe('a-token');
    // The token is not printed, nor is the location.
    expect(io.out.join('') + io.err.join('')).not.toContain('a-token');
    expectNoLocation(io.out.join('') + io.err.join(''), REGISTRY_ENV);
  });

  // Another made-up location, with a ref that is not main and a path that needs encoding.
  const OTHER_ENV = {
    ROUTE_REGISTRY_REPO: 'other/place',
    ROUTE_REGISTRY_REF: 'release',
    ROUTE_REGISTRY_PATH: 'notes/ROUTE LIST.md',
  };

  test('the fetch uses the ref and the path of the variables, not fixed ones', async () => {
    const { dir } = await indexFile();
    const report = join(dir, 'report.md');
    const io = capture();
    const urls: string[] = [];
    const code = runCli(['--report', report], {
      ...io.deps,
      env: { ...OTHER_ENV, GH_TOKEN: 'a-token' },
      coverage: FIXTURE_COVERAGE,
      exec: (_file, args) => {
        urls.push(args.at(-1) ?? '');
        return FIXTURE;
      },
    });
    expect(code).toBe(0);
    // A space in the path is encoded; the slashes stay.
    expect(urls).toEqual([
      'repos/other/place/contents/notes/ROUTE%20LIST.md?ref=release',
    ]);
    // Neither the output nor the report says where the file came from.
    expectNoLocation(io.out.join('') + io.err.join(''), OTHER_ENV);
    expectNoLocation(await readFile(report, 'utf8'), OTHER_ENV);
  });

  test.each([['ROUTE_REGISTRY_REPO'], ['ROUTE_REGISTRY_PATH']])(
    'a missing %s exits 2 with its name, and nothing is fetched',
    (name) => {
      for (const value of [undefined, '', '   ']) {
        const io = capture();
        const code = runCli([], {
          ...io.deps,
          env: { ...REGISTRY_ENV, GH_TOKEN: 'a-token', [name]: value },
          coverage: FIXTURE_COVERAGE,
          exec: () => {
            throw new Error('must not call gh without a registry location');
          },
        });
        expect(code).toBe(2);
        expect(io.out).toEqual([]);
        expect(io.err.join('')).toContain(name);
      }
    },
  );

  test('--file does not need the registry variables or the token', async () => {
    const { file } = await indexFile();
    const io = capture();
    expect(
      runCli(['--file', file], {
        ...io.deps,
        env: {},
        coverage: FIXTURE_COVERAGE,
        exec: () => {
          throw new Error('must not call gh with --file');
        },
      }),
    ).toBe(0);
    expect(io.err).toEqual([]);
  });

  test('a failed fetch exits 2 and points at the secret, without the token or the location', () => {
    const io = capture();
    const code = runCli([], {
      ...io.deps,
      env: { ...REGISTRY_ENV, GH_TOKEN: 'a-token' },
      coverage: FIXTURE_COVERAGE,
      exec: () => {
        throw Object.assign(new Error('Command failed: gh api'), {
          stderr: 'gh: Not Found (HTTP 404)',
        });
      },
    });
    expect(code).toBe(2);
    const message = io.err.join('');
    expect(message).toContain('HTTP 404');
    expect(message).toContain('ROUTE_REGISTRY_TOKEN');
    expect(message).not.toContain('a-token');
    expectNoLocation(message, REGISTRY_ENV);
    expect(io.out).toEqual([]);
  });

  test.each([
    [
      'the error of gh echoes the URL',
      REGISTRY_ENV,
      {
        stderr:
          'Get "https://api.github.com/repos/acme/registry/contents/docs/ROUTES.md?ref=main": dial tcp: lookup api.github.com: no such host',
      },
    ],
    [
      'the error of gh echoes the pieces of the location',
      OTHER_ENV,
      {
        stderr:
          'gh: Could not resolve to a Repository with the name other/place (HTTP 404)\nnotes/ROUTE%20LIST.md at release is not there, nor is notes/ROUTE LIST.md, nor is ROUTE LIST.md, and the token a-token is no good',
      },
    ],
    [
      'gh could not be run and the error holds the command line',
      REGISTRY_ENV,
      {
        message:
          'Command failed: gh api -H Accept: application/vnd.github.raw+json repos/acme/registry/contents/docs/ROUTES.md?ref=main',
      },
    ],
    [
      'gh could not be run and the error holds the command line with another location',
      OTHER_ENV,
      {
        message:
          'Command failed: gh api -H Accept: application/vnd.github.raw+json repos/other/place/contents/notes/ROUTE%20LIST.md?ref=release',
      },
    ],
  ])(
    'a failed fetch never prints the location, even when %s',
    (_name, location, failure) => {
      const io = capture();
      const code = runCli([], {
        ...io.deps,
        env: { ...location, GH_TOKEN: 'a-token' },
        coverage: FIXTURE_COVERAGE,
        exec: () => {
          throw Object.assign(
            new Error(
              'message' in failure ? failure.message : 'Command failed',
            ),
            'stderr' in failure ? { stderr: failure.stderr } : {},
          );
        },
      });
      expect(code).toBe(2);
      const message = io.err.join('');
      // It still says what failed and which secret to look at.
      expect(message).toContain('Could not fetch the route registry');
      expect(message).toContain('ROUTE_REGISTRY_TOKEN');
      expect(message).not.toContain('a-token');
      expectNoLocation(message, location);
      expect(io.out).toEqual([]);
    },
  );

  test('a failed fetch keeps the ordinary words of gh, even when the path has them as segments', () => {
    const location = {
      ROUTE_REGISTRY_REPO: 'acme/registry',
      ROUTE_REGISTRY_REF: 'main',
      ROUTE_REGISTRY_PATH: 'registry/rest/ROUTES.md',
    };
    const io = capture();
    const code = runCli([], {
      ...io.deps,
      env: { ...location, GH_TOKEN: 'a-token' },
      coverage: FIXTURE_COVERAGE,
      exec: () => {
        throw Object.assign(new Error('Command failed'), {
          stderr:
            'gh: Requires authentication (HTTP 401)\nSee https://docs.github.com/rest/features for the registry and ROUTES.md',
        });
      },
    });
    expect(code).toBe(2);
    const message = io.err.join('');
    // The words stay, the name of the file that is the registry does not.
    expect(message).toContain('Requires authentication (HTTP 401)');
    expect(message).toContain('https://docs.github.com/rest/features');
    expect(message).not.toContain('ROUTES.md');
    expectNoLocation(message, location);
  });

  test('a file it cannot read exits 2 and does not print the registry location either', () => {
    const io = capture();
    const code = runCli(['--file', '/nonexistent/LOCAL.md'], {
      ...io.deps,
      env: { ...REGISTRY_ENV, GH_TOKEN: 'a-token' },
      coverage: FIXTURE_COVERAGE,
      exec: () => {
        throw new Error('must not call gh with --file');
      },
    });
    expect(code).toBe(2);
    const message = io.err.join('');
    expect(message).toContain('/nonexistent/LOCAL.md');
    expectNoLocation(message, REGISTRY_ENV);
  });

  test.each(MALFORMED)(
    'a fetched registry that does not parse exits 2 without printing its rows: %s',
    (_name, markdown) => {
      const io = capture();
      const code = runCli([], {
        ...io.deps,
        env: { ...REGISTRY_ENV, GH_TOKEN: 'a-token' },
        coverage: FIXTURE_COVERAGE,
        exec: () => markdown,
      });
      expect(code).toBe(2);
      expect(io.out).toEqual([]);
      const message = io.err.join('');
      expect(message).toMatch(/^route-coverage: /);
      for (const part of SECRET_PARTS) {
        expect(message, `the error has "${part}"`).not.toContain(part);
      }
      expectNoLocation(message, REGISTRY_ENV);
    },
  );

  test.each(MALFORMED)(
    'a file that does not parse exits 2 without printing its rows (same parser): %s',
    async (_name, markdown) => {
      const { file } = await indexFile(markdown);
      const io = capture();
      const code = runCli(['--file', file], {
        ...io.deps,
        env: {},
        coverage: FIXTURE_COVERAGE,
      });
      expect(code).toBe(2);
      expect(io.out).toEqual([]);
      const message = io.err.join('');
      for (const part of SECRET_PARTS) {
        expect(message, `the error has "${part}"`).not.toContain(part);
      }
    },
  );

  test('a missing variable is named, never its value', () => {
    const io = capture();
    runCli([], {
      ...io.deps,
      env: { ...REGISTRY_ENV, ROUTE_REGISTRY_PATH: '', GH_TOKEN: 'a-token' },
      coverage: FIXTURE_COVERAGE,
    });
    const message = io.err.join('');
    expect(message).toContain('ROUTE_REGISTRY_PATH');
    expectNoLocation(message, {
      ...REGISTRY_ENV,
      ROUTE_REGISTRY_PATH: 'docs/ROUTES.md',
    });
  });

  test('a file it cannot read, an index it cannot parse and a wrong option exit 2', async () => {
    const missing = capture();
    expect(
      runCli(['--file', '/nonexistent/ROUTES.md'], {
        ...missing.deps,
        env: {},
        coverage: FIXTURE_COVERAGE,
      }),
    ).toBe(2);
    expect(missing.err.join('')).toContain('/nonexistent/ROUTES.md');

    const { file } = await indexFile('# Not the registry\n');
    const bad = capture();
    expect(
      runCli(['--file', file], {
        ...bad.deps,
        env: {},
        coverage: FIXTURE_COVERAGE,
      }),
    ).toBe(2);
    expect(bad.err.join('')).toMatch(/no "Route index" section/);

    const option = capture();
    expect(
      runCli(['--nope'], {
        ...option.deps,
        env: {},
        coverage: FIXTURE_COVERAGE,
      }),
    ).toBe(2);
    expect(option.err.join('')).toContain('Usage');
    // There is no area filter.
    const areas = capture();
    expect(
      runCli(['--all-areas'], {
        ...areas.deps,
        env: {},
        coverage: FIXTURE_COVERAGE,
      }),
    ).toBe(2);
  });

  test('a leading -- (from `pnpm run … --`) is ignored', async () => {
    const { file } = await indexFile();
    const io = capture();
    expect(
      runCli(['--', '--file', file], {
        ...io.deps,
        env: {},
        coverage: FIXTURE_COVERAGE,
      }),
    ).toBe(0);
  });
});
