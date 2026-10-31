import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  convertPage,
  escapeProse,
  type LinkResolver,
  readManifest,
  type SiteManifest,
  type SitePage,
  slugOf,
} from '../docs-site-convert.js';

// The site manifest (docs/site.json) and the converter of one page of docs/ from GitHub Markdown to
// Mintlify MDX (scripts/docs-site-convert.ts). Pure functions: the manifest says which pages the
// "TypeScript SDK" tab has; the converter drops what MDX rejects (HTML comments), escapes what it
// reads as code (`{`, `<`), rewrites the links to the site's paths, turns GitHub alerts and the
// "Start here" list into components, and adds the frontmatter and the note that the page is generated.

const REPO = 'https://github.com/xo-market/xo-ts-sdk/blob/main';

const PAGES: SitePage[] = [
  { source: 'README.md', slug: 'overview', description: 'The overview.' },
  {
    source: 'guides/smart-wallets.md',
    slug: 'guides/smart-wallets',
    description: 'D',
    icon: 'wallet',
  },
  {
    source: 'concepts/heartbeats.md',
    slug: 'concepts/heartbeats',
    description: 'H',
  },
  {
    source: 'guides/show-markets-and-prices.md',
    slug: 'guides/show-markets-and-prices',
    description: 'S',
  },
];

const MANIFEST: SiteManifest = {
  tab: 'TypeScript SDK',
  root: 'typescript-sdk',
  insertAfter: 'Data API reference',
  repo: REPO,
  groups: [{ group: 'Everything', icon: 'rocket', pages: PAGES }],
};

const NOTE = (source: string) =>
  `{/* Generated from xo-market/xo-ts-sdk docs/${source} by pnpm docs:publish. Edit it there. */}`;

/** A resolver that answers with a marker, and records what it was asked. */
const asked: [string, string | undefined][] = [];
const resolveReference: LinkResolver = (path, anchor) => {
  asked.push([path, anchor]);
  return `/typescript-sdk/reference/X${anchor === undefined ? '' : `#${anchor}`}`;
};

/** Every file of the repository exists: the tests that are not about links to files. */
const anyFile = () => true;

/** The body of a converted page: what follows the frontmatter and the generated note. */
function body(
  text: string,
  options: {
    source?: string;
    manifest?: SiteManifest;
    resolve?: LinkResolver;
    exists?: (repoPath: string) => boolean;
  } = {},
): string {
  const source = options.source ?? 'guides/smart-wallets.md';
  const { mdx } = convertPage({
    source,
    text: `# Smart wallets\n\n${text}`,
    manifest: options.manifest ?? MANIFEST,
    resolveReference: options.resolve ?? resolveReference,
    repoFileExists: options.exists ?? anyFile,
  });
  const note = `${NOTE(source)}\n\n`;
  return mdx.slice(mdx.indexOf(note) + note.length);
}

/** The manifest with one page replaced by a variation of itself. */
function withPage(source: string, change: Partial<SitePage>): SiteManifest {
  return {
    ...MANIFEST,
    groups: [
      {
        group: 'Everything',
        icon: 'rocket',
        pages: PAGES.map((p) =>
          p.source === source ? { ...p, ...change } : p,
        ),
      },
    ],
  };
}

describe('readManifest', () => {
  // A fresh copy of the manifest as parsed JSON, to break one field at a time.
  const valid = () => JSON.parse(JSON.stringify(MANIFEST));

  test('returns a valid manifest', () => {
    expect(readManifest(valid())).toEqual(MANIFEST);
  });

  test('rejects a duplicate slug', () => {
    const json = valid();
    json.groups[0].pages[2].slug = 'overview';
    expect(() => readManifest(json)).toThrow(/duplicate slug/);
  });

  test('rejects a duplicate source, also across groups', () => {
    const json = valid();
    json.groups.push({
      group: 'More',
      icon: 'book',
      pages: [{ source: 'README.md', slug: 'other', description: 'x' }],
    });
    expect(() => readManifest(json)).toThrow(/duplicate source/);
  });

  test('rejects a missing field, naming it', () => {
    for (const [path, name] of [
      ['groups.0.pages.1.description', 'description'],
      ['groups.0.pages.1.source', 'source'],
      ['groups.0.pages.1.slug', 'slug'],
      ['groups.0.icon', 'icon'],
      ['groups.0.group', 'group'],
      ['groups', 'groups'],
      ['repo', 'repo'],
      ['root', 'root'],
    ] as const) {
      const json = valid();
      const keys = path.split('.');
      const last = keys.pop() as string;
      let target = json;
      for (const key of keys) {
        target = target[key];
      }
      delete target[last];
      expect(() => readManifest(json), path).toThrow(new RegExp(name));
    }
  });

  test('rejects a field that is not the exact value of the tab', () => {
    for (const [field, value] of [
      ['tab', 'SDK'],
      ['root', 'sdk'],
      ['insertAfter', 'Reference'],
      ['repo', 'https://example.com'],
    ] as const) {
      const json = valid();
      json[field] = value;
      expect(() => readManifest(json), field).toThrow(new RegExp(field));
    }
  });

  test('rejects a field it does not know, such as a typo of sidebarTitle', () => {
    const json = valid();
    json.groups[0].pages[0].sidebartitle = 'Overview';
    expect(() => readManifest(json)).toThrow(/sidebartitle/);
  });

  test('rejects a value of the wrong type or an empty one', () => {
    expect(() => readManifest('nope')).toThrow(/object/);
    const empty = valid();
    empty.groups[0].pages[0].description = '';
    expect(() => readManifest(empty)).toThrow(/description/);
    const notArray = valid();
    notArray.groups[0].pages = 'x';
    expect(() => readManifest(notArray)).toThrow(/pages/);
  });

  test('rejects a slug that is index, which Mintlify serves at the folder path', () => {
    for (const slug of ['index', 'guides/index']) {
      const json = valid();
      json.groups[0].pages[0].slug = slug;
      expect(() => readManifest(json), slug).toThrow(/index/);
    }
  });

  test('rejects a source that is not a path of a page under docs/', () => {
    for (const source of ['docs/a.md', '../a.md', 'a.txt', '/a.md']) {
      const json = valid();
      json.groups[0].pages[0].source = source;
      expect(() => readManifest(json), source).toThrow(/source/);
    }
  });

  test('a page has no cards field: cards come from a comment on the page', () => {
    const json = valid();
    json.groups[0].pages[0].cards = { heading: 'Start here', icons: ['a'] };
    expect(() => readManifest(json)).toThrow(/unknown field "cards"/);
  });

  test('the manifest of the repo is valid and lists pages that exist', () => {
    const docs = fileURLToPath(new URL('../../docs/', import.meta.url));
    const manifest = readManifest(
      JSON.parse(readFileSync(`${docs}site.json`, 'utf8')),
    );
    const sources = manifest.groups.flatMap((g) =>
      g.pages.map((p) => p.source),
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(existsSync(`${docs}${source}`), source).toBe(true);
    }
  });
});

describe('slugOf', () => {
  test('README.md is overview, any other page is its path without .md', () => {
    expect(slugOf('README.md')).toBe('overview');
    expect(slugOf('guides/smart-wallets.md')).toBe('guides/smart-wallets');
    expect(slugOf('errors.md')).toBe('errors');
  });
});

describe('convertPage, the frontmatter and the note', () => {
  test('frontmatter from the H1 and the manifest, then the generated note; the H1 is gone', () => {
    const { slug, mdx } = convertPage({
      source: 'guides/smart-wallets.md',
      text: '# Smart wallets\n\nText',
      manifest: MANIFEST,
      resolveReference,
      repoFileExists: anyFile,
    });
    expect(slug).toBe('guides/smart-wallets');
    expect(mdx).toBe(
      `---\ntitle: "Smart wallets"\ndescription: "D"\nicon: "wallet"\n---\n${NOTE('guides/smart-wallets.md')}\n\nText\n`,
    );
  });

  test('sidebarTitle goes after the title, and values are JSON-quoted', () => {
    const manifest = withPage('README.md', {
      sidebarTitle: 'Overview',
      description: 'It says "hi" and \\ more.',
    });
    const { slug, mdx } = convertPage({
      source: 'README.md',
      text: '# XO Market TypeScript SDK\n\nText\n',
      manifest,
      resolveReference,
      repoFileExists: anyFile,
    });
    expect(slug).toBe('overview');
    expect(
      mdx.startsWith(
        '---\ntitle: "XO Market TypeScript SDK"\nsidebarTitle: "Overview"\ndescription: "It says \\"hi\\" and \\\\ more."\n---\n',
      ),
    ).toBe(true);
  });

  test('the title is the plain text of the H1: no code ticks, no escapes', () => {
    const { mdx } = convertPage({
      source: 'README.md',
      text: '# The `xo.bridge` client \\<T\\> ##\n\nText',
      manifest: MANIFEST,
      resolveReference,
      repoFileExists: anyFile,
    });
    expect(mdx).toContain('title: "The xo.bridge client <T>"\n');
  });

  test('only the first H1 outside fenced code is the title', () => {
    const { mdx } = convertPage({
      source: 'README.md',
      text: '```sh\n# not a title\n```\n\n# Real title\n\nText\n\n# A second H1\n',
      manifest: MANIFEST,
      resolveReference,
      repoFileExists: anyFile,
    });
    expect(mdx).toContain('title: "Real title"');
    expect(mdx).toContain('# not a title');
    expect(mdx).toContain('# A second H1');
    expect(mdx).not.toContain('# Real title');
  });

  test('a page without an H1, or not in the manifest, is an error', () => {
    expect(() =>
      convertPage({
        source: 'README.md',
        text: 'No heading here',
        manifest: MANIFEST,
        resolveReference,
        repoFileExists: anyFile,
      }),
    ).toThrow(/README\.md.*H1/);
    expect(() =>
      convertPage({
        source: 'guides/other.md',
        text: '# Other',
        manifest: MANIFEST,
        resolveReference,
        repoFileExists: anyFile,
      }),
    ).toThrow(/not in docs\/site\.json: docs\/guides\/other\.md/);
  });

  test('the page ends with one newline, and Windows line endings are read as Unix ones', () => {
    const { mdx } = convertPage({
      source: 'README.md',
      text: '# T\r\n\r\nOne.\r\n\r\n\r\n',
      manifest: MANIFEST,
      resolveReference,
      repoFileExists: anyFile,
    });
    expect(mdx.endsWith('\n\nOne.\n')).toBe(true);
    expect(mdx).not.toContain('\r');
  });
});

describe('convertPage, HTML comments', () => {
  test('drops the snippet markers and keeps the fenced code under them verbatim', () => {
    const text = [
      'Intro.',
      '',
      '<!-- snippet: docs/snippets/a.ts#b -->',
      '```ts',
      'const x = { y: <T>(a) => a }; // <!-- not a comment, it is code -->',
      '```',
      '',
      '<!-- snippet: none -->',
      '',
      '```sh',
      'pnpm add @xomarket/client',
      '```',
    ].join('\n');
    expect(body(text)).toBe(
      [
        'Intro.',
        '',
        '```ts',
        'const x = { y: <T>(a) => a }; // <!-- not a comment, it is code -->',
        '```',
        '',
        '```sh',
        'pnpm add @xomarket/client',
        '```',
        '',
      ].join('\n'),
    );
  });

  test('drops a comment inside a line and one over several lines, not one in a code span', () => {
    expect(body('Before <!-- gone --> after.')).toBe('Before  after.\n');
    expect(body('One.\n\n<!--\nmany\nlines\n-->\n\nTwo.')).toBe(
      'One.\n\nTwo.\n',
    );
    expect(body('Write `<!-- x -->` to hide it.')).toBe(
      'Write `<!-- x -->` to hide it.\n',
    );
  });

  test('an indented comment takes its line too, and a neighbour of the line when both are blank', () => {
    expect(body('One.\n\n  <!-- x -->\n\nTwo.')).toBe('One.\n\nTwo.\n');
    expect(body('One.\n  <!-- x -->\nTwo.')).toBe('One.\nTwo.\n');
    expect(body('`a` <!-- x -->\nTwo.')).toBe('`a` \nTwo.\n');
  });

  test('a backtick inside a comment does not open a code span', () => {
    expect(body('<!-- a ` b -->\nText {x} `c`')).toBe('Text \\{x\\} `c`\n');
  });
});

describe('convertPage, escaping', () => {
  test('escapes { } and < in prose but not in code', () => {
    expect(body('a {b} <c>')).toBe('a \\{b\\} &lt;c>\n');
    expect(body('`a {b} <c>`')).toBe('`a {b} <c>`\n');
    expect(body('``a ` {b} <c>`` and {d}')).toBe(
      '``a ` {b} <c>`` and \\{d\\}\n',
    );
    const fenced = '```ts\nconst a = {b} as <c>;\n```';
    expect(body(fenced)).toBe(`${fenced}\n`);
    const tilde = '~~~\n{b} <c>\n~~~\n\n{b}';
    expect(body(tilde)).toBe('~~~\n{b} <c>\n~~~\n\n\\{b\\}\n');
  });

  test('a code span that runs over several lines is code', () => {
    const text =
      'Use `credentials: { backend: { apiKey } }` and `a: { b,\nc } }` here, {not}.';
    expect(body(text)).toBe(
      'Use `credentials: { backend: { apiKey } }` and `a: { b,\nc } }` here, \\{not\\}.\n',
    );
  });

  test('a longer fence is closed only by a fence as long, and the text inside is code', () => {
    const text = '````md\n```ts\n{a}\n```\n{b}\n````\n\n{c}';
    expect(body(text)).toBe('````md\n```ts\n{a}\n```\n{b}\n````\n\n\\{c\\}\n');
  });

  test('a fence inside a list item, or after a quote mark, is a fence', () => {
    expect(body('- item\n\n  ```ts\n  {a}\n  ```\n\n{b}')).toBe(
      '- item\n\n  ```ts\n  {a}\n  ```\n\n\\{b\\}\n',
    );
    expect(body('> ```ts\n> {a}\n> ```\n\n{b}')).toBe(
      '> ```ts\n> {a}\n> ```\n\n\\{b\\}\n',
    );
  });

  test('keeps backslash escapes, without a second backslash', () => {
    expect(body('Paginator\\<Market\\>')).toBe('Paginator\\<Market\\>\n');
    expect(body('\\{a\\} and \\\\{b}')).toBe('\\{a\\} and \\\\\\{b\\}\n');
    expect(body('A \\`tick {x}')).toBe('A \\`tick \\{x\\}\n');
  });

  test('an unmatched backtick is text', () => {
    expect(body('One ` tick {x}\n\nTwo ` tick {y}')).toBe(
      'One ` tick \\{x\\}\n\nTwo ` tick \\{y\\}\n',
    );
  });

  test('turns autolinks into links', () => {
    expect(body('See <https://x.y> and <mailto:gm@xo.market>.')).toBe(
      'See [https://x.y](https://x.y) and [mailto:gm@xo.market](mailto:gm@xo.market).\n',
    );
    expect(body('Write to <gm@xo.market>.')).toBe(
      'Write to [gm@xo.market](mailto:gm@xo.market).\n',
    );
    expect(body('1 < 2 and <https://x.y/a_b>')).toBe(
      '1 &lt; 2 and [https://x.y/a_b](https://x.y/a_b)\n',
    );
  });

  test('a line that starts with import or export is not MDX ESM', () => {
    expect(body('import the key.\n\nexport {x} now')).toBe(
      '&#105;mport the key.\n\n&#101;xport \\{x\\} now\n',
    );
    expect(body('Then import it, and export it.\n\nImportant: exports.')).toBe(
      'Then import it, and export it.\n\nImportant: exports.\n',
    );
    expect(body('`import` is code\n\n  export indented')).toBe(
      '`import` is code\n\n  export indented\n',
    );
  });

  test('escapeProse is the same step for any Markdown string', () => {
    expect(escapeProse('a {b} <c>\n\n```\n{d}\n```\n<!-- x -->\n')).toBe(
      'a \\{b\\} &lt;c>\n\n```\n{d}\n```\n',
    );
  });
});

describe('convertPage, alerts', () => {
  test('a GitHub alert becomes a component', () => {
    expect(body('> [!WARNING]\n> Real money.')).toBe(
      '<Warning>\nReal money.\n</Warning>\n',
    );
  });

  test('NOTE, TIP, IMPORTANT and CAUTION map to Note, Tip, Info and Warning', () => {
    for (const [alert, component] of [
      ['NOTE', 'Note'],
      ['TIP', 'Tip'],
      ['IMPORTANT', 'Info'],
      ['WARNING', 'Warning'],
      ['CAUTION', 'Warning'],
      ['note', 'Note'],
    ] as const) {
      expect(body(`> [!${alert}]\n> Text.`), alert).toBe(
        `<${component}>\nText.\n</${component}>\n`,
      );
    }
  });

  test('a plain quote stays a blockquote', () => {
    expect(body('> quote')).toBe('> quote\n');
    expect(body('> **Note.** Not an alert.\n> More.')).toBe(
      '> **Note.** Not an alert.\n> More.\n',
    );
  });

  test('keeps paragraphs, lists and the escaping of the body, and ends at the quote', () => {
    const text = [
      '> [!NOTE]',
      '> One {a}.',
      '>',
      '> - item `{b}`',
      '> - item',
      '',
      'After {c}.',
    ].join('\n');
    expect(body(text)).toBe(
      [
        '<Note>',
        'One \\{a\\}.',
        '',
        '- item `{b}`',
        '- item',
        '</Note>',
        '',
        'After \\{c\\}.',
        '',
      ].join('\n'),
    );
  });

  test('a blank line is put around the component when the Markdown had none', () => {
    expect(body('Before.\n> [!TIP]\n> Text.\nAfter.')).toBe(
      'Before.\n\n<Tip>\nText.\n</Tip>\n\nAfter.\n',
    );
  });

  test('an alert in a list item keeps its indent', () => {
    expect(body('- item\n\n  > [!NOTE]\n  > Text.\n')).toBe(
      '- item\n\n  <Note>\n  Text.\n  </Note>\n',
    );
  });

  test('is not applied to fenced code', () => {
    const fenced = '```md\n> [!NOTE]\n> Text.\n```';
    expect(body(fenced)).toBe(`${fenced}\n`);
  });

  test('an unknown alert type, or a code block inside an alert, is an error', () => {
    expect(() => body('> [!DANGER]\n> Text.')).toThrow(/DANGER/);
    expect(() => body('> [!NOTE]\n> ```ts\n> x\n> ```')).toThrow(
      /code block.*alert/,
    );
  });
});

describe('convertPage, links', () => {
  test('rewrites the links of a page to the paths of the site', () => {
    expect(body('[a](../concepts/heartbeats.md#the-rule)')).toBe(
      '[a](/typescript-sdk/concepts/heartbeats#the-rule)\n',
    );
    expect(body('[a](../README.md)')).toBe('[a](/typescript-sdk/overview)\n');
    expect(body('[a](../../examples/smart-wallet.ts)')).toBe(
      `[a](${REPO}/examples/smart-wallet.ts)\n`,
    );
    expect(body('[a](https://x.y)')).toBe('[a](https://x.y)\n');
  });

  test('a link into the reference goes through the resolver, with docs/ and the anchor', () => {
    asked.length = 0;
    expect(body('[a](../reference/client/classes/Session.md#close)')).toBe(
      '[a](/typescript-sdk/reference/X#close)\n',
    );
    expect(body('[b](../reference/README.md)')).toBe(
      '[b](/typescript-sdk/reference/X)\n',
    );
    expect(asked).toEqual([
      ['docs/reference/client/classes/Session.md', 'close'],
      ['docs/reference/README.md', undefined],
    ]);
  });

  test('a reference link the resolver cannot place is an error that names the link', () => {
    const none: LinkResolver = () => undefined;
    expect(() =>
      body('[a](../reference/client/classes/Nope.md)', { resolve: none }),
    ).toThrow(/reference\/client\/classes\/Nope\.md/);
  });

  test('a link to a page that is not in the manifest is an error', () => {
    expect(() => body('[a](../missing.md)')).toThrow(
      /not in docs\/site.json: docs\/missing\.md/,
    );
    expect(() => body('[a](../concepts/unlisted.md)')).toThrow(
      /not in docs\/site.json: docs\/concepts\/unlisted\.md/,
    );
  });

  test('leaves alone an anchor, a path of the site, a host and a mail address', () => {
    for (const link of [
      '#the-rule',
      '/product/accounts/deposit',
      '/typescript-sdk/overview',
      'https://docs.xo.market/guides/fees',
      'mailto:gm@xo.market',
    ]) {
      expect(body(`[a](${link})`), link).toBe(`[a](${link})\n`);
    }
  });

  test('links from the root README resolve from docs/', () => {
    const options = { source: 'README.md' };
    expect(body('[a](guides/smart-wallets.md#x)', options)).toBe(
      '[a](/typescript-sdk/guides/smart-wallets#x)\n',
    );
    expect(body('[a](../packages/client/README.md)', options)).toBe(
      `[a](${REPO}/packages/client/README.md)\n`,
    );
    expect(body('[a](../examples/mm-bot/)', options)).toBe(
      `[a](${REPO}/examples/mm-bot/)\n`,
    );
    expect(body('[a](../examples/first-hour.ts#L10)', options)).toBe(
      `[a](${REPO}/examples/first-hour.ts#L10)\n`,
    );
  });

  test('keeps the title of a link, and rewrites several links of a line', () => {
    expect(
      body('[a](../README.md "The overview") and [b](heartbeats.md)', {
        source: 'concepts/heartbeats.md',
      }),
    ).toBe(
      '[a](/typescript-sdk/overview "The overview") and [b](/typescript-sdk/concepts/heartbeats)\n',
    );
  });

  test('a link whose text is code, and a link after a code span, are rewritten', () => {
    expect(body('[`a`](../README.md) and `x` then [b](../README.md)')).toBe(
      '[`a`](/typescript-sdk/overview) and `x` then [b](/typescript-sdk/overview)\n',
    );
  });

  test('leaves the links in code alone', () => {
    const code = '`[a](../missing.md)`';
    expect(body(code)).toBe(`${code}\n`);
    const fenced = '```md\n[a](../missing.md)\n```';
    expect(body(fenced)).toBe(`${fenced}\n`);
  });

  test('a link out of the repo is an error', () => {
    expect(() => body('[a](../../../../etc/passwd)')).toThrow(/outside/);
  });
});

// A link from docs/ to a file of the repository (an example, a README) goes to GitHub, so nothing
// else would notice that the file was renamed or deleted: the converter asks `repoFileExists`.
describe('convertPage, links to files of the repository', () => {
  const present = new Set([
    'examples/smart-wallet.ts',
    'examples/mm-bot/',
    'packages/client/README.md',
  ]);
  const exists = (repoPath: string) => present.has(repoPath);

  test('a link to a file that is not there is an error naming the page, the link and the file', () => {
    expect(() =>
      body('[a](../../examples/missing.ts)', { exists }),
    ).toThrowError(
      'docs/guides/smart-wallets.md: link ../../examples/missing.ts: no such file in the repository: examples/missing.ts',
    );
    expect(() =>
      body('[a](../packages/client/MISSING.md)', {
        exists,
        source: 'README.md',
      }),
    ).toThrowError(
      'docs/README.md: link ../packages/client/MISSING.md: no such file in the repository: packages/client/MISSING.md',
    );
  });

  test('the other spellings of a link are checked too', () => {
    for (const link of [
      '[a](<../../examples/missing.ts> "Title")',
      '[a]: ../../examples/missing.ts',
      '[a]: <../../examples/missing.ts>',
    ]) {
      expect(() => body(link, { exists }), link).toThrow(
        /no such file in the repository: examples\/missing\.ts/,
      );
    }
  });

  test('a space written as %20 is the file with the space', () => {
    const spaced = (repoPath: string) => repoPath === 'examples/my file.ts';
    expect(body('[a](../../examples/my%20file.ts)', { exists: spaced })).toBe(
      `[a](${REPO}/examples/my%20file.ts)\n`,
    );
    expect(body('[a](<../../examples/my file.ts>)', { exists: spaced })).toBe(
      `[a](${REPO}/examples/my%20file.ts)\n`,
    );
  });

  test('a link to a file that is there, or a directory, is rewritten as before', () => {
    expect(body('[a](../../examples/smart-wallet.ts)', { exists })).toBe(
      `[a](${REPO}/examples/smart-wallet.ts)\n`,
    );
    expect(body('[a](../../examples/mm-bot/)', { exists })).toBe(
      `[a](${REPO}/examples/mm-bot/)\n`,
    );
  });

  test('an anchor is left out of the question: file.ts#L10 asks for file.ts', () => {
    const asked: string[] = [];
    const record = (repoPath: string) => {
      asked.push(repoPath);
      return exists(repoPath);
    };
    expect(
      body('[a](../../examples/smart-wallet.ts#L10)', { exists: record }),
    ).toBe(`[a](${REPO}/examples/smart-wallet.ts#L10)\n`);
    expect(asked).toEqual(['examples/smart-wallet.ts']);
    expect(() =>
      body('[a](../../examples/missing.ts#L10)', { exists: record }),
    ).toThrow(/no such file in the repository: examples\/missing\.ts$/);
  });

  test('a page of the manifest, the reference and a link in code are not asked about', () => {
    const asked: string[] = [];
    const record = (repoPath: string) => {
      asked.push(repoPath);
      return false;
    };
    body(
      '[a](../concepts/heartbeats.md) [b](../reference/client/classes/Session.md)',
      {
        exists: record,
      },
    );
    body('`[a](../../examples/missing.ts)`', { exists: record });
    body('```md\n[a](../../examples/missing.ts)\n```', { exists: record });
    expect(asked).toEqual([]);
  });
});

// The three other spellings of a link must follow the same rules as `[a](dest)`: a page of the
// manifest, the reference or a repo file is rewritten, an unknown page throws. None passes through.
describe('convertPage, the other spellings of a link', () => {
  const UNDERSCORE: SiteManifest = {
    ...MANIFEST,
    groups: [
      {
        group: 'Everything',
        icon: 'rocket',
        pages: [
          ...PAGES,
          {
            source: 'guides/my_page.md',
            slug: 'guides/my-page',
            description: 'M',
          },
        ],
      },
    ],
  };

  test('an angle-bracket destination: <dest>', () => {
    expect(() => body('[b](<../missing.md>)')).toThrow(
      /not in docs\/site\.json: docs\/missing\.md/,
    );
    expect(() => body('[b](<../missing.md> "Title")')).toThrow(
      /docs\/missing\.md/,
    );
    expect(body('[b](<../concepts/heartbeats.md#the-rule>)')).toBe(
      '[b](/typescript-sdk/concepts/heartbeats#the-rule)\n',
    );
    expect(body('[b](<../concepts/heartbeats.md> "The rule")')).toBe(
      '[b](/typescript-sdk/concepts/heartbeats "The rule")\n',
    );
    // A space is allowed inside the brackets, and is encoded in the address.
    expect(body('[b](<../../examples/my file.ts>)')).toBe(
      `[b](${REPO}/examples/my%20file.ts)\n`,
    );
    asked.length = 0;
    expect(body('[b](<../reference/client/classes/Session.md#close>)')).toBe(
      '[b](/typescript-sdk/reference/X#close)\n',
    );
    expect(asked).toEqual([
      ['docs/reference/client/classes/Session.md', 'close'],
    ]);
    // An address that stays as it is keeps its brackets, and its braces are escaped.
    expect(body('[b](<https://x.y/a b>) and [c](<https://x.y/{id}>)')).toBe(
      '[b](<https://x.y/a b>) and [c](<https://x.y/\\{id\\}>)\n',
    );
    // A `<` that is not the start of a destination is still text.
    expect(body('a <b> and [c](d.txt) <e>')).toBe(
      'a &lt;b> and [c](https://github.com/xo-market/xo-ts-sdk/blob/main/docs/guides/d.txt) &lt;e>\n',
    );
  });

  test('a reference-style definition: [label]: dest', () => {
    expect(() => body('See [a][x].\n\n[x]: ../missing.md')).toThrow(
      /not in docs\/site\.json: docs\/missing\.md/,
    );
    expect(() => body('[x]: <../missing.md> "Title"')).toThrow(
      /docs\/missing\.md/,
    );
    expect(() => body('> [x]: ../missing.md')).toThrow(/docs\/missing\.md/);
    expect(
      body(
        [
          'See [a][x], [b][y] and [c][z].',
          '',
          '[x]: ../concepts/heartbeats.md#the-rule "The rule"',
          '[y]: <../README.md>',
          '   [z]: ../../examples/smart-wallet.ts',
          '[w]: ../reference/client/classes/Session.md#close',
          '[semver]: https://semver.org',
          '[top]: #top',
        ].join('\n'),
      ),
    ).toBe(
      [
        'See [a][x], [b][y] and [c][z].',
        '',
        '[x]: /typescript-sdk/concepts/heartbeats#the-rule "The rule"',
        '[y]: /typescript-sdk/overview',
        `   [z]: ${REPO}/examples/smart-wallet.ts`,
        '[w]: /typescript-sdk/reference/X#close',
        '[semver]: https://semver.org',
        '[top]: #top',
        '',
      ].join('\n'),
    );
  });

  test('a definition only counts at the start of a line, outside code, and with nothing after it but a title', () => {
    const same = [
      'Text [x]: ../missing.md in a line.',
      '',
      '[Note]: remember that the page is gone.',
      '',
      '`code`  [x]: ../missing.md',
      '',
      '```md',
      '[x]: ../missing.md',
      '```',
      '',
      '`[x]: ../missing.md`',
    ].join('\n');
    expect(body(same)).toBe(`${same}\n`);
  });

  test('a destination with backslash escapes: the escapes are read, then the rules apply', () => {
    expect(() => body('[a](../missing\\_x.md)')).toThrow(
      /not in docs\/site\.json: docs\/missing_x\.md/,
    );
    expect(() => body('[a]: ../missing\\_x.md')).toThrow(/docs\/missing_x\.md/);
    expect(
      body('[a](my\\_page.md#a\\_b) and [b](<my\\_page.md>)', {
        manifest: UNDERSCORE,
      }),
    ).toBe(
      '[a](/typescript-sdk/guides/my-page#a_b) and [b](/typescript-sdk/guides/my-page)\n',
    );
    // What would end the destination is encoded in the address.
    expect(body('[a](../README.md#a\\)b)')).toBe(
      '[a](/typescript-sdk/overview#a%29b)\n',
    );
    // An address that stays as it is keeps its escapes.
    expect(body('[a](https://x.y/a\\_b)')).toBe('[a](https://x.y/a\\_b)\n');
  });
});

describe('convertPage, cards', () => {
  const README = { source: 'README.md' };
  const START = [
    '## Start here',
    '',
    '<!-- cards: chart-line, server -->',
    '- **[Show XO markets](guides/show-markets-and-prices.md)**: List markets.',
    '- **[Trade from a server](guides/smart-wallets.md#x)**: Place `orders` from {your} server.',
  ].join('\n');

  test('the list after a cards comment becomes a CardGroup with the icons in order', () => {
    expect(body(START, README)).toBe(
      [
        '## Start here',
        '',
        '<CardGroup cols={2}>',
        '  <Card title="Show XO markets" icon="chart-line" href="/typescript-sdk/guides/show-markets-and-prices">List markets.</Card>',
        '  <Card title="Trade from a server" icon="server" href="/typescript-sdk/guides/smart-wallets#x">Place `orders` from \\{your\\} server.</Card>',
        '</CardGroup>',
        '',
      ].join('\n'),
    );
  });

  test('keeps the text around the list, an item that wraps, and two lists on one page', () => {
    const text = [
      'Intro.',
      '',
      '<!-- cards: a, b -->',
      '- **[A "quoted" one](guides/show-markets-and-prices.md)**: One',
      '  that wraps.',
      '',
      '- **[B](https://example.com/b)**: Two.',
      '',
      'After.',
      '',
      '<!-- cards: c -->',
      '- **[C](../examples/c.ts)**: Three.',
    ].join('\n');
    expect(body(text, README)).toBe(
      [
        'Intro.',
        '',
        '<CardGroup cols={2}>',
        '  <Card title="A &quot;quoted&quot; one" icon="a" href="/typescript-sdk/guides/show-markets-and-prices">One that wraps.</Card>',
        '  <Card title="B" icon="b" href="https://example.com/b">Two.</Card>',
        '</CardGroup>',
        '',
        'After.',
        '',
        '<CardGroup cols={2}>',
        `  <Card title="C" icon="c" href="${REPO}/examples/c.ts">Three.</Card>`,
        '</CardGroup>',
        '',
      ].join('\n'),
    );
  });

  test('a list without a cards comment stays a list', () => {
    expect(
      body(START.replace('<!-- cards: chart-line, server -->\n', ''), README),
    ).toContain(
      '- **[Show XO markets](/typescript-sdk/guides/show-markets-and-prices)**',
    );
  });

  test('a wrong number of icons, an item of another shape or no list is an error', () => {
    expect(() =>
      body(START.replace('chart-line, server', 'a'), README),
    ).toThrow(/2 items.*1 icon/);
    expect(() => body('<!-- cards: a -->\n- just text\n', README)).toThrow(
      /just text/,
    );
    expect(() => body('<!-- cards: a -->\n\nNo list.\n', README)).toThrow(
      /no list after a cards comment/,
    );
    expect(() => body('<!-- cards -->\n- **[A](x.md)**: A.\n', README)).toThrow(
      /names an icon/,
    );
    expect(() => body('Text <!-- cards: a --> more.\n', README)).toThrow(
      /alone on its line/,
    );
  });

  test('a cards comment inside fenced code is code', () => {
    const fenced = '```md\n<!-- cards: a -->\n- **[A](x.md)**: A.\n```';
    expect(body(fenced, README)).toBe(`${fenced}\n`);
  });
});

describe('convertPage, code groups', () => {
  test('the titled blocks after a code-group comment become a CodeGroup', () => {
    const text = [
      'Install it.',
      '',
      '<!-- code-group -->',
      '<!-- snippet: none -->',
      '```sh npm',
      'npm install x',
      '```',
      '',
      '<!-- snippet: none -->',
      '```sh bun',
      'bun add x',
      '```',
      '',
      'Then {go}.',
    ].join('\n');
    expect(body(text)).toBe(
      [
        'Install it.',
        '',
        '<CodeGroup>',
        '```sh npm',
        'npm install x',
        '```',
        '```sh bun',
        'bun add x',
        '```',
        '</CodeGroup>',
        '',
        'Then \\{go\\}.',
        '',
      ].join('\n'),
    );
  });

  test('a group of one block, or a block without a title, is an error', () => {
    expect(() => body('<!-- code-group -->\n```sh npm\nx\n```\n')).toThrow(
      /two or more/,
    );
    expect(() =>
      body('<!-- code-group -->\n```sh npm\nx\n```\n\n```sh\ny\n```\n'),
    ).toThrow(/title for its tab/);
  });
});

describe('convertPage, code titles', () => {
  test('a quoted block gets no title, and a block with a title keeps it', () => {
    const text = [
      '<!-- snippet: docs/snippets/orders.ts#place -->',
      '```ts',
      'a();',
      '```',
      '',
      '<!-- snippet: none -->',
      '```sh',
      'b',
      '```',
      '',
      '<!-- snippet: docs/snippets/x.ts#c -->',
      '```ts Mine',
      'c();',
      '```',
    ].join('\n');
    expect(body(text)).toBe(
      '```ts\na();\n```\n\n```sh\nb\n```\n\n```ts Mine\nc();\n```\n',
    );
  });
});

describe('convertPage, steps', () => {
  test('a run of numbered headings becomes Steps', () => {
    const text = [
      'Intro.',
      '',
      '## 1. Install `sdk`',
      '',
      'Run it.',
      '',
      '```sh',
      '## 2. not a step',
      '```',
      '',
      '## 2. Sign "in"',
      '',
      'Done {a}.',
      '',
      '## Next',
      '',
      'More.',
    ].join('\n');
    expect(body(text)).toBe(
      [
        'Intro.',
        '',
        '<Steps>',
        '<Step title="Install sdk">',
        '',
        'Run it.',
        '',
        '```sh',
        '## 2. not a step',
        '```',
        '',
        '</Step>',
        '<Step title="Sign &quot;in&quot;">',
        '',
        'Done \\{a\\}.',
        '',
        '</Step>',
        '</Steps>',
        '',
        '## Next',
        '',
        'More.',
        '',
      ].join('\n'),
    );
  });

  test('a run at the end of the page is closed, and a second run starts again at 1', () => {
    const text = '## 1. A\n\nx\n\n## Other\n\n## 1. B\n\ny\n';
    expect(body(text)).toBe(
      [
        '<Steps>',
        '<Step title="A">',
        '',
        'x',
        '',
        '</Step>',
        '</Steps>',
        '',
        '## Other',
        '',
        '<Steps>',
        '<Step title="B">',
        '',
        'y',
        '',
        '</Step>',
        '</Steps>',
        '',
      ].join('\n'),
    );
  });

  test('steps out of order, or a heading inside a step, are errors', () => {
    expect(() => body('## 2. A\n\nx\n')).toThrow(/should be number 1/);
    expect(() => body('## 1. A\n\n## 3. B\n')).toThrow(/should be number 2/);
    expect(() => body('## 1. A\n\n### Inside\n')).toThrow(
      /cannot hold a heading/,
    );
  });

  test('a numbered heading of another level is not a step', () => {
    expect(body('### 1. Not a step\n')).toBe('### 1. Not a step\n');
  });
});
