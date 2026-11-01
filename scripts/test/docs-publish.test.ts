import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  BASE_BRANCH,
  commitIdentityLine,
  docsJsonProblem,
  docsRepoFrom,
  docsRepoProblems,
  formatDocsJson,
  MINT_VERSION,
  mintChecks,
  parseArgs,
  preflightProblems,
  publishPlan,
  SDK_REPO,
  spliceTab,
  unexpectedChanges,
} from '../docs-publish.js';
import type { MintlifyTab } from '../docs-site.js';

// `pnpm docs:publish` (scripts/docs-publish.ts): writes the built "TypeScript SDK" tab into a
// clone of the docs-site repo and opens the pull request. These tests cover its decisions; the
// git, gh and npx calls around them are thin and run for real only by `pnpm docs:publish --dry-run`.

const tab: MintlifyTab = {
  tab: 'TypeScript SDK',
  groups: [
    {
      group: 'Get started',
      icon: 'rocket',
      pages: ['typescript-sdk/overview', 'typescript-sdk/quickstart'],
    },
  ],
};

const other = (name: string) => ({
  tab: name,
  groups: [{ group: `${name} group`, pages: [`${name.toLowerCase()}/a`] }],
});

const docsJson = (names: string[]) => ({
  $schema: 'https://mintlify.com/docs.json',
  name: 'XO Market Docs',
  navigation: { tabs: names.map(other) },
  redirects: [{ source: '/', destination: '/product/what-is-xo' }],
});

const tabNames = (json: unknown) =>
  (json as { navigation: { tabs: { tab: string }[] } }).navigation.tabs.map(
    (t) => t.tab,
  );

describe('spliceTab', () => {
  test('replaces in place', () => {
    const before = docsJson([
      'Product',
      'TypeScript SDK',
      'Data API reference',
    ]);
    const { json, warning } = spliceTab(before, tab, 'Data API reference');
    expect(tabNames(json)).toEqual([
      'Product',
      'TypeScript SDK',
      'Data API reference',
    ]);
    const tabs = (json as { navigation: { tabs: unknown[] } }).navigation.tabs;
    expect(tabs[1]).toEqual(tab);
    expect(warning).toBeUndefined();
  });

  test('inserts after Data API reference', () => {
    const { json, warning } = spliceTab(
      docsJson(['Product', 'Data API reference', 'X']),
      tab,
      'Data API reference',
    );
    expect(tabNames(json)).toEqual([
      'Product',
      'Data API reference',
      'TypeScript SDK',
      'X',
    ]);
    expect(warning).toBeUndefined();
  });

  test('appends and warns when Data API reference is missing', () => {
    const { json, warning } = spliceTab(
      docsJson(['Product', 'X']),
      tab,
      'Data API reference',
    );
    expect(tabNames(json)).toEqual(['Product', 'X', 'TypeScript SDK']);
    expect(warning).toBe(
      'tab "Data API reference" not found: appended at the end',
    );
  });

  test('keeps other tabs', () => {
    const before = docsJson(['Product', 'Data API reference', 'X']);
    const { json } = spliceTab(before, tab, 'Data API reference');
    const after = json as typeof before;
    expect(after.navigation.tabs.filter((t) => t.tab !== tab.tab)).toEqual(
      before.navigation.tabs,
    );
    // The rest of the file is not touched either.
    expect({ ...after, navigation: undefined }).toEqual({
      ...before,
      navigation: undefined,
    });
  });

  test('does not change its input', () => {
    const before = docsJson(['Product', 'Data API reference']);
    const copy = structuredClone(before);
    spliceTab(before, tab, 'Data API reference');
    expect(before).toEqual(copy);
  });

  test('is idempotent', () => {
    const once = spliceTab(
      docsJson(['Product', 'Data API reference', 'X']),
      tab,
      'Data API reference',
    ).json;
    const twice = spliceTab(once as never, tab, 'Data API reference').json;
    expect(twice).toEqual(once);
    expect(
      tabNames(twice).filter((name) => name === 'TypeScript SDK'),
    ).toHaveLength(1);
  });

  test('replaces an older version of the tab, wherever it is', () => {
    const old = {
      tab: 'TypeScript SDK',
      groups: [{ group: 'Old', pages: [] }],
    };
    const before = docsJson(['Product', 'X']);
    before.navigation.tabs.push(old as never);
    const { json, warning } = spliceTab(before, tab, 'Data API reference');
    expect(tabNames(json)).toEqual(['Product', 'X', 'TypeScript SDK']);
    expect(
      (json as { navigation: { tabs: unknown[] } }).navigation.tabs[2],
    ).toEqual(tab);
    // Found in place: nothing to warn about, even though Data API reference is missing.
    expect(warning).toBeUndefined();
  });

  test('refuses a docs.json that has no navigation.tabs', () => {
    expect(() => spliceTab({} as never, tab, 'Data API reference')).toThrow(
      'docs.json has no navigation.tabs',
    );
  });
});

describe('formatDocsJson', () => {
  const FIXTURE = fileURLToPath(
    new URL('./fixtures/docs-json/docs.json', import.meta.url),
  );

  test('round-trips the real docs.json', () => {
    // A copy of docs.json on the branch external-prod-only of the docs repo (biome.json leaves
    // it alone: it has to stay byte for byte as Mintlify's repo has it).
    const text = readFileSync(FIXTURE, 'utf8');
    expect(formatDocsJson(JSON.parse(text))).toBe(text);
  });

  test('two spaces and a final newline', () => {
    expect(formatDocsJson({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}\n');
  });

  test('splicing the tab into the real docs.json changes nothing else', () => {
    const text = readFileSync(FIXTURE, 'utf8');
    const { json, warning } = spliceTab(
      JSON.parse(text),
      tab,
      'Data API reference',
    );
    expect(warning).toBeUndefined();
    const names = tabNames(json);
    expect(names.indexOf('TypeScript SDK')).toBe(
      names.indexOf('Data API reference') + 1,
    );
    const back = JSON.parse(formatDocsJson(json)) as {
      navigation: { tabs: { tab: string }[] };
    };
    back.navigation.tabs = back.navigation.tabs.filter(
      (t) => t.tab !== 'TypeScript SDK',
    );
    expect(formatDocsJson(back)).toBe(text);
  });
});

describe('docsJsonProblem', () => {
  const FIXTURE = fileURLToPath(
    new URL('./fixtures/docs-json/docs.json', import.meta.url),
  );
  const REFORMAT =
    'Nothing was changed: docs.json in the docs repo is not formatted as this script writes it (2 spaces, a final newline), so writing the tab would reformat the whole file.';

  test('the real docs.json may be written over', () => {
    expect(docsJsonProblem(readFileSync(FIXTURE, 'utf8'))).toBeUndefined();
  });

  test('a file as formatDocsJson writes it may be written over', () => {
    expect(
      docsJsonProblem(formatDocsJson(docsJson(['Product']))),
    ).toBeUndefined();
  });

  test('a file it would reformat is refused, in one line', () => {
    const json = docsJson(['Product', 'Data API reference']);
    const canonical = formatDocsJson(json);
    for (const text of [
      `${JSON.stringify(json, null, 4)}\n`, // four spaces
      canonical.trimEnd(), // no final newline
      `${canonical}\n`, // two final newlines
      canonical.replaceAll('\n', '\r\n'), // CRLF
      canonical.replace('XO Market Docs', 'XO Market Docs \\u00e9'), // an escape JSON.stringify would not write
      `${JSON.stringify(json)}\n`, // minified
    ]) {
      expect(docsJsonProblem(text)).toBe(REFORMAT);
    }
    expect(REFORMAT).not.toContain('\n');
  });

  test('a file that is not JSON is refused', () => {
    expect(docsJsonProblem('{ "navigation": ')).toBe(
      'Nothing was changed: docs.json in the docs repo is not valid JSON.',
    );
  });
});

describe('commitIdentityLine', () => {
  test('the name and the email the commit is made as', () => {
    expect(
      commitIdentityLine({
        name: 'Maintainer',
        email: 'maintainer@example.com',
      }),
    ).toBe('Will commit as Maintainer <maintainer@example.com>');
  });

  test('no user.name: says so instead of printing an empty name', () => {
    expect(
      commitIdentityLine({ name: '', email: 'maintainer@example.com' }),
    ).toBe(
      'Will commit as <maintainer@example.com> (git config user.name is empty: git takes a name from the system)',
    );
  });
});

describe('publishPlan', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';

  test('the branch, the commit and the pull request', () => {
    const plan = publishPlan({
      version: '0.4.0',
      sdkSha: sha,
      branchExists: false,
    });
    expect(plan.branch).toBe('sdk-docs/0.4.0');
    expect(plan.commitMessage).toBe(
      'docs(typescript-sdk): 0.4.0 from xo-market/xo-ts-sdk@0123456',
    );
    expect(plan.prTitle).toBe('docs: TypeScript SDK 0.4.0');
    expect(plan.prBody).toContain(
      'Generated from xo-market/xo-ts-sdk@0123456 by `pnpm docs:publish`.',
    );
    expect(plan.prBody).toContain(
      'Do not merge before xo-market/xo-ts-sdk is public: the pages link to it.',
    );
  });

  test('sha7 is the first 7 characters', () => {
    const plan = publishPlan({
      version: '1.0.0',
      sdkSha: 'abcdef1234567890',
      branchExists: true,
    });
    expect(plan.commitMessage.endsWith('@abcdef1')).toBe(true);
    expect(plan.prBody).not.toContain('abcdef12');
  });

  test('an existing branch gets the same names and texts', () => {
    const o = { version: '0.4.0', sdkSha: sha };
    expect(publishPlan({ ...o, branchExists: true })).toEqual(
      publishPlan({ ...o, branchExists: false }),
    );
  });

  test('refuses what is not a version or a commit', () => {
    expect(() =>
      publishPlan({ version: '0.4', sdkSha: sha, branchExists: false }),
    ).toThrow('"0.4" is not a version');
    expect(() =>
      publishPlan({ version: '0.4.0', sdkSha: 'main', branchExists: false }),
    ).toThrow('"main" is not a commit');
  });

  test('a pre-release version is a version', () => {
    expect(
      publishPlan({ version: '0.5.0-rc.1', sdkSha: sha, branchExists: false })
        .branch,
    ).toBe('sdk-docs/0.5.0-rc.1');
  });
});

describe('preflightProblems', () => {
  const ok = {
    sdkStatus: '',
    email: 'maintainer@example.com',
    ghLoggedIn: true,
  };

  test('nothing to say when all is well', () => {
    expect(preflightProblems(ok)).toEqual([]);
  });

  test('a dirty SDK tree', () => {
    expect(preflightProblems({ ...ok, sdkStatus: ' M README.md\n' })).toEqual([
      'The working tree has changes: commit or stash them first (the pages are built from it).',
    ]);
  });

  test('an empty git user.email', () => {
    expect(preflightProblems({ ...ok, email: '  ' })).toEqual([
      'git config user.email is empty: set it (git config user.email <you>), the docs commit is made as you.',
    ]);
  });

  test('gh not logged in', () => {
    expect(preflightProblems({ ...ok, ghLoggedIn: false })).toEqual([
      'The GitHub CLI is not logged in: run `gh auth login` (it clones the docs repo and opens the pull request).',
    ]);
  });

  test('all of them at once', () => {
    expect(
      preflightProblems({ sdkStatus: '?? x', email: '', ghLoggedIn: false }),
    ).toHaveLength(3);
  });
});

describe('docsRepoProblems', () => {
  const ok = {
    status: '',
    origin: 'https://github.com/acme/docs-site.git',
    repo: 'acme/docs-site',
  };

  test('a clean clone of the docs repo, by https or ssh', () => {
    expect(docsRepoProblems(ok)).toEqual([]);
    expect(
      docsRepoProblems({
        ...ok,
        origin: 'git@github.com:acme/docs-site.git',
      }),
    ).toEqual([]);
    expect(
      docsRepoProblems({
        ...ok,
        origin: 'https://github.com/acme/docs-site',
      }),
    ).toEqual([]);
    expect(
      docsRepoProblems({
        ...ok,
        origin: 'ssh://git@github.com/acme/docs-site.git',
      }),
    ).toEqual([]);
    // An ssh host alias (~/.ssh/config) is still the docs repo.
    expect(
      docsRepoProblems({
        ...ok,
        origin: 'git@github-work:acme/docs-site.git',
      }),
    ).toEqual([]);
  });

  test('an owner whose name only ends in the docs repo owner is not the docs repo', () => {
    for (const origin of [
      'https://github.com/evil-acme/docs-site.git',
      'git@github.com:evil-acme/docs-site.git',
      'https://github.com/notacme/docs-site',
    ]) {
      expect(docsRepoProblems({ ...ok, origin })).toEqual([
        `The docs repo's origin is "${origin}", not acme/docs-site.`,
      ]);
    }
  });

  test('a dirty clone', () => {
    expect(docsRepoProblems({ ...ok, status: '?? notes.md' })).toEqual([
      'The docs repo has changes: use a clean clone.',
    ]);
  });

  test('a dot in the repository name is matched as a dot', () => {
    expect(
      docsRepoProblems({
        status: '',
        origin: 'https://github.com/acme/docsXsite.git',
        repo: 'acme/docs.site',
      }),
    ).toEqual([
      'The docs repo\'s origin is "https://github.com/acme/docsXsite.git", not acme/docs.site.',
    ]);
  });

  test('a clone of something else, a fork included', () => {
    expect(
      docsRepoProblems({
        ...ok,
        origin: 'https://github.com/someone/docs-site.git',
      }),
    ).toEqual([
      `The docs repo's origin is "https://github.com/someone/docs-site.git", not acme/docs-site.`,
    ]);
  });
});

describe('unexpectedChanges', () => {
  test('docs.json and typescript-sdk/** are the only paths the script may change', () => {
    expect(
      unexpectedChanges([
        'docs.json',
        'typescript-sdk/overview.mdx',
        'typescript-sdk/reference/classes/OrderbookClient.mdx',
      ]),
    ).toEqual([]);
  });

  test('anything else is named', () => {
    expect(
      unexpectedChanges([
        'docs.json',
        'product/what-is-xo.mdx',
        'typescript-sdk-old/x.mdx',
        'docs.json.bak',
        'typescript-sdk/a.mdx',
      ]),
    ).toEqual([
      'product/what-is-xo.mdx',
      'typescript-sdk-old/x.mdx',
      'docs.json.bak',
    ]);
  });
});

describe('parseArgs', () => {
  test('no arguments: clone, publish, ready for review', () => {
    expect(parseArgs([])).toEqual({
      docsRepo: undefined,
      dryRun: false,
      draft: false,
    });
  });

  test('the three options, in any order', () => {
    expect(
      parseArgs(['--draft', '--docs-repo', '/tmp/docs', '--dry-run']),
    ).toEqual({
      docsRepo: '/tmp/docs',
      dryRun: true,
      draft: true,
    });
  });

  test('--docs-repo needs a directory', () => {
    expect(() => parseArgs(['--docs-repo'])).toThrow('usage:');
    expect(() => parseArgs(['--docs-repo', '--dry-run'])).toThrow('usage:');
  });

  test('anything else is the usage', () => {
    expect(() => parseArgs(['--force'])).toThrow('usage:');
    expect(() => parseArgs(['publish'])).toThrow('usage:');
  });
});

describe('docsRepoFrom', () => {
  test('DOCS_REPO names the repository of the docs site', () => {
    expect(docsRepoFrom({ DOCS_REPO: 'acme/docs-site' })).toEqual({
      repo: 'acme/docs-site',
    });
    expect(docsRepoFrom({ DOCS_REPO: ' acme/docs.site \n' })).toEqual({
      repo: 'acme/docs.site',
    });
  });

  test('missing or empty: a problem that names DOCS_REPO', () => {
    for (const env of [{}, { DOCS_REPO: '' }, { DOCS_REPO: '  ' }]) {
      const result = docsRepoFrom(env);
      expect('problem' in result && result.problem).toMatch(
        /^DOCS_REPO is not set/,
      );
    }
  });

  test('anything but owner/name is a problem', () => {
    for (const value of [
      'docs-site',
      'acme/docs-site/extra',
      'https://github.com/acme/docs-site',
      'acme/docs site',
    ]) {
      const result = docsRepoFrom({ DOCS_REPO: value });
      expect('problem' in result && result.problem).toMatch(
        /^DOCS_REPO is ".*", not a repository \(owner\/name\)/,
      );
    }
  });
});

describe('the script', () => {
  test('without DOCS_REPO it exits with code 2, names the variable, and does nothing else', () => {
    const env = { ...process.env };
    delete env.DOCS_REPO;
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('../docs-publish.ts', import.meta.url)),
      ],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        encoding: 'utf8',
        env,
      },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^DOCS_REPO is not set/);
    expect(result.stdout).toBe('');
  });

  test('never forces a push', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../docs-publish.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/--force|--force-with-lease|'-f'|\+refs/);
  });
});

describe('mintChecks', () => {
  test('validate the site, then check the links of our pages, anchors included', () => {
    expect(mintChecks()).toEqual([
      ['--yes', `mint@${MINT_VERSION}`, 'validate'],
      [
        '--yes',
        `mint@${MINT_VERSION}`,
        'broken-links',
        '--files',
        'typescript-sdk/**/*.mdx',
        '--check-anchors',
      ],
    ]);
  });
});

describe('constants', () => {
  test('MINT_VERSION is one exact release, not a range or a tag', () => {
    expect(MINT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('the pull request goes to the live branch of the docs site', () => {
    expect(BASE_BRANCH).toBe('external-prod-only');
  });

  test('the pages and the pull request name this repository', () => {
    expect(SDK_REPO).toBe('xo-market/xo-ts-sdk');
  });
});
