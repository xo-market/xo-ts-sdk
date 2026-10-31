import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import {
  buildSite,
  checkSite,
  MAX_PAGE_BYTES,
  type MintlifyTab,
  parseArgs,
} from '../docs-site.js';
import { sourcesOf } from '../docs-site-reference.js';

// The build and the check of the "TypeScript SDK" tab (scripts/docs-site.ts), on a small docs/ in a
// temporary folder: two hand-written pages and a manifest, over the reference fixtures of the fold's
// test. The sources of the symbols are passed in, so no test runs TypeDoc (the real run is
// `pnpm run docs:check`).

const FIXTURES = fileURLToPath(
  new URL('./fixtures/reference/', import.meta.url),
);
const SOURCES = sourcesOf(
  JSON.parse(readFileSync(join(FIXTURES, 'api.json'), 'utf8')),
);

const MANIFEST = {
  tab: 'TypeScript SDK',
  root: 'typescript-sdk',
  insertAfter: 'Data API reference',
  repo: 'https://github.com/xo-market/xo-ts-sdk/blob/main',
  groups: [
    {
      group: 'Get started',
      icon: 'rocket',
      pages: [
        {
          source: 'README.md',
          slug: 'overview',
          sidebarTitle: 'Overview',
          description: 'Where to start.',
        },
        {
          source: 'guides/trading.md',
          slug: 'guides/trading',
          description: 'Trade from a server.',
        },
      ],
    },
  ],
};

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xo-docs-site-test-'));
  scratch.push(dir);
  return dir;
}

function write(root: string, path: string, text: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A small docs/: a manifest, two pages (one links the other, and the reference), the reference. */
function makeDocs(): string {
  const docs = join(tempDir(), 'docs');
  write(docs, 'site.json', `${JSON.stringify(MANIFEST, null, 2)}\n`);
  write(
    docs,
    'README.md',
    '# Overview\n\nRead the [guide](guides/trading.md#orders).\n',
  );
  write(
    docs,
    'guides/trading.md',
    '# Trading\n\nBack to the [overview](../README.md), or see [Clock](../reference/client/classes/Clock.md).\n',
  );
  cpSync(join(FIXTURES, 'pages'), join(docs, 'reference'), { recursive: true });
  return docs;
}

function build(o: { docs?: string; sources?: Map<string, string> } = {}) {
  const docs = o.docs ?? makeDocs();
  const out = tempDir();
  const built = buildSite(out, { docs, sources: o.sources ?? SOURCES });
  return { docs, out, built };
}

function filesOf(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else {
        files.push(relative(dir, path).split(sep).join('/'));
      }
    }
  };
  walk(dir);
  return files;
}

function read(out: string, path: string): string {
  return readFileSync(join(out, path), 'utf8');
}

/** Rewrites a built file. */
function edit(out: string, path: string, change: (text: string) => string) {
  writeFileSync(join(out, path), change(read(out, path)));
}

function editTab(out: string, change: (tab: MintlifyTab) => void) {
  const tab = JSON.parse(read(out, 'docs-tab.json')) as MintlifyTab;
  change(tab);
  writeFileSync(
    join(out, 'docs-tab.json'),
    `${JSON.stringify(tab, null, 2)}\n`,
  );
}

/** A page of the tab with the given body. */
function page(body: string, title = 'Page'): string {
  return `---\ntitle: ${JSON.stringify(title)}\n---\n{/* Generated from xo-market/xo-ts-sdk docs/x.md by pnpm docs:publish. Edit it there. */}\n\n${body}\n`;
}

describe('buildSite', () => {
  test('writes a page per manifest page and per folded reference page, and docs-tab.json', () => {
    const { out } = build();
    expect(filesOf(out)).toEqual([
      'docs-tab.json',
      'typescript-sdk/guides/trading.mdx',
      'typescript-sdk/overview.mdx',
      'typescript-sdk/reference/auth.mdx',
      'typescript-sdk/reference/classes/Clock.mdx',
      'typescript-sdk/reference/classes/OrderbookClient.mdx',
      'typescript-sdk/reference/client.mdx',
      'typescript-sdk/reference/core.mdx',
      'typescript-sdk/reference/errors.mdx',
      'typescript-sdk/reference/markets.mdx',
      'typescript-sdk/reference/orders.mdx',
      'typescript-sdk/reference/overview.mdx',
      'typescript-sdk/reference/signing.mdx',
    ]);
  });

  test('returns the tab: the manifest groups with site paths, then the Reference group', () => {
    const { out, built } = build();
    expect(built.tab.tab).toBe('TypeScript SDK');
    expect(built.tab.groups).toHaveLength(2);
    expect(built.tab.groups[0]).toEqual({
      group: 'Get started',
      icon: 'rocket',
      pages: ['typescript-sdk/overview', 'typescript-sdk/guides/trading'],
    });
    expect(built.tab.groups[1]?.group).toBe('Reference');
    expect(JSON.parse(read(out, 'docs-tab.json'))).toEqual(built.tab);
    expect(read(out, 'docs-tab.json').endsWith('}\n')).toBe(true);
  });

  test('lists in pages every page of the tab, in the order of the sidebar', () => {
    const { out, built } = build();
    expect(built.pages.slice(0, 2)).toEqual([
      'typescript-sdk/overview',
      'typescript-sdk/guides/trading',
    ]);
    expect(built.pages).toHaveLength(12);
    expect([...built.pages].sort()).toEqual(
      filesOf(out)
        .filter((f) => f.endsWith('.mdx'))
        .map((f) => f.replace(/\.mdx$/, ''))
        .sort(),
    );
  });

  test('converts the hand-written pages: links go to the site and into the fold of the reference', () => {
    const { out } = build();
    expect(read(out, 'typescript-sdk/overview.mdx')).toContain(
      '[guide](/typescript-sdk/guides/trading#orders)',
    );
    const trading = read(out, 'typescript-sdk/guides/trading.mdx');
    expect(trading).toContain('[overview](/typescript-sdk/overview)');
    expect(trading).toContain(
      '[Clock](/typescript-sdk/reference/classes/Clock)',
    );
    expect(trading.startsWith('---\ntitle: "Trading"\n')).toBe(true);
  });

  test('replaces what an earlier build left in the folder', () => {
    const { out, docs } = build();
    write(out, 'typescript-sdk/old-page.mdx', page('Gone.'));
    buildSite(out, { docs, sources: SOURCES });
    expect(existsSync(join(out, 'typescript-sdk/old-page.mdx'))).toBe(false);
    expect(existsSync(join(out, 'typescript-sdk/overview.mdx'))).toBe(true);
  });

  test('names the file when a page of the manifest does not exist', () => {
    const docs = makeDocs();
    rmSync(join(docs, 'guides/trading.md'));
    expect(() => build({ docs })).toThrow(
      /docs\/guides\/trading\.md: listed in docs\/site\.json, but the file does not exist/,
    );
  });

  test('throws, naming the page, on a link to a page that is not in the manifest', () => {
    const docs = makeDocs();
    write(docs, 'README.md', '# Overview\n\nSee [changes](changelog.md).\n');
    expect(() => build({ docs })).toThrow(
      /not in docs\/site\.json: docs\/changelog\.md/,
    );
  });

  // docs/ sits in the root of the repository, so `../examples/x.ts` from docs/README.md is
  // <root>/examples/x.ts, here the folder that holds the temporary docs/.
  describe('a link from a page to a file of the repository', () => {
    test('throws, naming the page, the link and the file, when the file is not there', () => {
      const docs = makeDocs();
      write(
        docs,
        'README.md',
        '# Overview\n\nSee the [example](../examples/missing.ts).\n',
      );
      expect(() => build({ docs })).toThrowError(
        'docs/README.md: link ../examples/missing.ts: no such file in the repository: examples/missing.ts',
      );
    });

    test('builds when the file is there, with or without an anchor, and a folder too', () => {
      const docs = makeDocs();
      const root = dirname(docs);
      write(root, 'examples/first.ts', 'export {};\n');
      write(root, 'examples/bot/README.md', '# Bot\n');
      write(
        docs,
        'README.md',
        '# Overview\n\nSee [a](../examples/first.ts), [b](../examples/first.ts#L10) and [c](../examples/bot/).\n',
      );
      const { out } = build({ docs });
      const overview = read(out, 'typescript-sdk/overview.mdx');
      expect(overview).toContain(
        '[a](https://github.com/xo-market/xo-ts-sdk/blob/main/examples/first.ts)',
      );
      expect(overview).toContain(
        '[b](https://github.com/xo-market/xo-ts-sdk/blob/main/examples/first.ts#L10)',
      );
      expect(overview).toContain(
        '[c](https://github.com/xo-market/xo-ts-sdk/blob/main/examples/bot/)',
      );
    });
  });
});

describe('checkSite', () => {
  test('finds nothing to report in a good build', () => {
    const { docs, out } = build();
    expect(checkSite(out, docs)).toEqual([]);
  });

  describe('every hand-written page is in the manifest', () => {
    test('reports a page of docs/ that the manifest does not list', () => {
      const { docs, out } = build();
      write(docs, 'x.md', '# X\n');
      write(docs, 'guides/y.md', '# Y\n');
      expect(checkSite(out, docs)).toEqual([
        'not in docs/site.json: docs/guides/y.md',
        'not in docs/site.json: docs/x.md',
      ]);
    });

    test('leaves out the generated reference, and files that are not pages', () => {
      const { docs, out } = build();
      write(docs, 'reference/client/classes/New.md', '# New\n');
      write(docs, 'diagram.png', 'not a page');
      expect(checkSite(out, docs)).toEqual([]);
    });
  });

  describe('every manifest source exists', () => {
    test('reports a listed page whose file is gone', () => {
      const { docs, out } = build();
      rmSync(join(docs, 'guides/trading.md'));
      expect(checkSite(out, docs)).toEqual([
        'docs/guides/trading.md: listed in docs/site.json, but the file does not exist',
      ]);
    });

    test('reports an unreadable manifest, and checks the pages that were built', () => {
      const { docs, out } = build();
      write(docs, 'site.json', '{ "tab": ');
      write(out, 'typescript-sdk/overview.mdx', page('Broken {'));
      const problems = checkSite(out, docs);
      expect(problems).toHaveLength(2);
      expect(problems[0]).toMatch(/^docs\/site\.json: /);
      expect(problems[1]).toMatch(/^typescript-sdk\/overview\.mdx:/);
    });
  });

  describe('every internal link resolves', () => {
    test('reports a link to a page the build did not generate, naming the file', () => {
      const { docs, out } = build();
      edit(out, 'typescript-sdk/overview.mdx', (t) =>
        t.replace(
          'Read the',
          'Read [this](/typescript-sdk/guides/nope) and the',
        ),
      );
      expect(checkSite(out, docs)).toEqual([
        'typescript-sdk/overview.mdx: link /typescript-sdk/guides/nope: no such page',
      ]);
    });

    test('accepts a link to a page, with or without an anchor', () => {
      const { docs, out } = build();
      edit(out, 'typescript-sdk/overview.mdx', (t) =>
        t.replace(
          'Read the',
          'Read [a](/typescript-sdk/guides/trading), [b](/typescript-sdk/reference/classes/Clock#now) and the',
        ),
      );
      expect(checkSite(out, docs)).toEqual([]);
    });

    test('reports the href of a component and a link definition too', () => {
      const { docs, out } = build();
      edit(out, 'typescript-sdk/overview.mdx', (t) =>
        t.replace(
          'Read the',
          '<Card title="X" href="/typescript-sdk/nope-1" />\n\n[ref]: /typescript-sdk/nope-2\n\nRead the',
        ),
      );
      expect(checkSite(out, docs)).toEqual([
        'typescript-sdk/overview.mdx: link /typescript-sdk/nope-1: no such page',
        'typescript-sdk/overview.mdx: link /typescript-sdk/nope-2: no such page',
      ]);
    });

    test('leaves out code, other sites and the other tabs of the site', () => {
      const { docs, out } = build();
      edit(out, 'typescript-sdk/overview.mdx', (t) =>
        t.replace(
          'Read the',
          '`[x](/typescript-sdk/nope)` [a](/api-reference/orders) [b](https://example.com/typescript-sdk/nope) [c](#orders) and the\n\n```md\n[d](/typescript-sdk/nope)\n```\n\nRead the',
        ),
      );
      expect(checkSite(out, docs)).toEqual([]);
    });

    test('reports a link to the root of the tab, which has no page', () => {
      const { docs, out } = build();
      edit(out, 'typescript-sdk/overview.mdx', (t) =>
        t.replace('Read the', 'Read [it](/typescript-sdk) and the'),
      );
      expect(checkSite(out, docs)).toEqual([
        'typescript-sdk/overview.mdx: link /typescript-sdk: no such page',
      ]);
    });
  });

  describe('every page compiles', () => {
    test('reports a page that MDX rejects, with the line, naming the file', () => {
      const { docs, out } = build();
      write(
        out,
        'typescript-sdk/guides/trading.mdx',
        page('Fine.\n\nBroken {'),
      );
      const problems = checkSite(out, docs);
      expect(problems).toEqual([
        expect.stringMatching(
          /^typescript-sdk\/guides\/trading\.mdx:8:\d+: does not compile: Unexpected end of file in expression/,
        ),
      ]);
    });

    test('reports an unclosed tag', () => {
      const { docs, out } = build();
      write(
        out,
        'typescript-sdk/overview.mdx',
        page('A <Foo> that never ends.'),
      );
      expect(checkSite(out, docs)).toEqual([
        expect.stringMatching(
          /^typescript-sdk\/overview\.mdx:6:\d+: does not compile: /,
        ),
      ]);
    });

    test('does not read the frontmatter as MDX', () => {
      const { docs, out } = build();
      write(
        out,
        'typescript-sdk/overview.mdx',
        '---\ntitle: "Overview"\ndescription: "Orders <5 {and} more"\n---\n\nFine.\n',
      );
      expect(checkSite(out, docs)).toEqual([]);
    });

    test('reports every page that fails, in the order of their paths', () => {
      const { docs, out } = build();
      write(out, 'typescript-sdk/overview.mdx', page('A {'));
      write(out, 'typescript-sdk/guides/trading.mdx', page('B {'));
      expect(checkSite(out, docs).map((p) => p.split(':')[0])).toEqual([
        'typescript-sdk/guides/trading.mdx',
        'typescript-sdk/overview.mdx',
      ]);
    });
  });

  describe('no page over 300 KB', () => {
    /** A page of exactly `bytes` bytes. */
    const sized = (bytes: number) => {
      const head = page('').trimEnd();
      return `${head}\n\n${'a'.repeat(bytes - head.length - 3)}\n`;
    };

    test('the limit is 300 KB', () => {
      expect(MAX_PAGE_BYTES).toBe(300 * 1024);
    });

    test('accepts a page of exactly the limit', () => {
      const { docs, out } = build();
      write(out, 'typescript-sdk/overview.mdx', sized(MAX_PAGE_BYTES));
      expect(statSync(join(out, 'typescript-sdk/overview.mdx')).size).toBe(
        MAX_PAGE_BYTES,
      );
      expect(checkSite(out, docs)).toEqual([]);
    });

    test('reports a page one byte over, with its size', () => {
      const { docs, out } = build();
      write(out, 'typescript-sdk/overview.mdx', sized(MAX_PAGE_BYTES + 1));
      expect(checkSite(out, docs)).toEqual([
        'typescript-sdk/overview.mdx is 301 KB, over the 300 KB limit',
      ]);
    });
  });

  describe('docs-tab.json lists every page once', () => {
    test('reports a page listed twice', () => {
      const { docs, out } = build();
      editTab(out, (tab) => {
        tab.groups[0]?.pages.push('typescript-sdk/overview');
      });
      expect(checkSite(out, docs)).toEqual([
        'docs-tab.json lists typescript-sdk/overview twice',
      ]);
    });

    test('reports a page listed in a nested group twice', () => {
      const { docs, out } = build();
      editTab(out, (tab) => {
        tab.groups[0]?.pages.push({
          group: 'Again',
          pages: ['typescript-sdk/guides/trading'],
        });
      });
      expect(checkSite(out, docs)).toEqual([
        'docs-tab.json lists typescript-sdk/guides/trading twice',
      ]);
    });

    test('reports a page that has no file', () => {
      const { docs, out } = build();
      editTab(out, (tab) => {
        tab.groups[0]?.pages.push('typescript-sdk/ghost');
      });
      expect(checkSite(out, docs)).toEqual([
        'docs-tab.json lists typescript-sdk/ghost, which has no page',
      ]);
    });

    test('reports a page that it does not list', () => {
      const { docs, out } = build();
      editTab(out, (tab) => {
        tab.groups[0]?.pages.pop();
      });
      expect(checkSite(out, docs)).toEqual([
        'docs-tab.json does not list typescript-sdk/guides/trading',
      ]);
    });

    test('reports a missing file and one that is not JSON', () => {
      const { docs, out } = build();
      rmSync(join(out, 'docs-tab.json'));
      expect(checkSite(out, docs)).toEqual(['docs-tab.json is missing']);
      write(out, 'docs-tab.json', '{ "tab": ');
      expect(checkSite(out, docs)).toEqual([
        expect.stringMatching(/^docs-tab\.json is not valid JSON: /),
      ]);
    });

    test('reports a file that is not the tab', () => {
      const { docs, out } = build();
      write(out, 'docs-tab.json', JSON.stringify({ tab: 'Other', groups: [] }));
      expect(checkSite(out, docs)).toEqual([
        'docs-tab.json: "tab" must be "TypeScript SDK"',
      ]);
    });
  });

  describe('no reference symbol falls into "other"', () => {
    test('reports the symbol that lost its source file', () => {
      const sources = new Map(SOURCES);
      sources.delete('client/Market');
      const { docs, out } = build({ sources });
      expect(existsSync(join(out, 'typescript-sdk/reference/other.mdx'))).toBe(
        true,
      );
      expect(checkSite(out, docs)).toEqual([
        'reference symbols fell into "other": Market',
      ]);
    });

    test('names every such symbol, in the order of the page, with the escapes of its heading undone', () => {
      const sources = new Map(SOURCES);
      sources.delete('client/Market');
      sources.delete('client/SDK_VERSION');
      sources.set('client/resolveMarket', 'packages/client/src/elsewhere.ts');
      const { docs, out } = build({ sources });
      expect(read(out, 'typescript-sdk/reference/other.mdx')).toContain(
        '## SDK\\_VERSION',
      );
      expect(checkSite(out, docs)).toEqual([
        'reference symbols fell into "other": resolveMarket, Market, SDK_VERSION',
      ]);
    });

    test('is happy with a build that has no such page', () => {
      const { docs, out } = build();
      expect(existsSync(join(out, 'typescript-sdk/reference/other.mdx'))).toBe(
        false,
      );
      expect(checkSite(out, docs)).toEqual([]);
    });
  });
});

describe('parseArgs', () => {
  test('build takes --out', () => {
    expect(parseArgs(['build', '--out', '/tmp/site'])).toEqual({
      command: 'build',
      out: '/tmp/site',
    });
  });

  test('check takes nothing', () => {
    expect(parseArgs(['check'])).toEqual({ command: 'check' });
    expect(() => parseArgs(['check', '--out', 'x'])).toThrow(/usage/);
  });

  test('refuses the rest, with the usage', () => {
    expect(() => parseArgs([])).toThrow(/usage/);
    expect(() => parseArgs(['wat'])).toThrow(/usage/);
    expect(() => parseArgs(['build'])).toThrow(/--out/);
    expect(() => parseArgs(['build', '--out'])).toThrow(/--out/);
    expect(() => parseArgs(['build', '--out', 'a', 'b'])).toThrow(/usage/);
  });
});
