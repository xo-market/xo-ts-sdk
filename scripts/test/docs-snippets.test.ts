import { describe, expect, test } from 'vitest';
import {
  checkPage,
  dedent,
  findBlocks,
  findUnfencedCode,
  isAllowedSource,
  parseRegions,
} from '../docs-snippets.js';

// The snippet check of the docs (scripts/docs-snippets.ts): every fenced code block of a
// docs page carries a marker naming the region of an example or a test it is copied from, and
// it must equal that region, ignoring the common indent. `--write` refreshes the blocks.

const SOURCE = [
  "import { createPublicClient } from '@xomarket/client';",
  '',
  'export async function main() {',
  '  // #region make-client',
  '  const xo = await createPublicClient({',
  '    environment: production,',
  '  });',
  '  // #endregion',
  '  // #region outer',
  '  await xo.fetchMarket({ marketId });',
  '  // #region inner',
  '  await xo.close();',
  '  // #endregion inner',
  '  // #endregion outer',
  '}',
].join('\n');

const sources: Record<string, string> = {
  'docs/snippets/first-hour.ts': SOURCE,
};
const read = (path: string): string | undefined => sources[path];

describe('parseRegions', () => {
  test('reads each region, without the markers of the regions nested in it', () => {
    const regions = parseRegions(SOURCE, 'docs/snippets/first-hour.ts');
    expect(regions.get('make-client')).toBe(
      [
        '  const xo = await createPublicClient({',
        '    environment: production,',
        '  });',
      ].join('\n'),
    );
    expect(regions.get('outer')).toBe(
      ['  await xo.fetchMarket({ marketId });', '  await xo.close();'].join(
        '\n',
      ),
    );
    expect(regions.get('inner')).toBe('  await xo.close();');
  });

  test('refuses a region name used twice in one file', () => {
    const twice =
      '// #region a\nx;\n// #endregion\n// #region a\ny;\n// #endregion';
    expect(() => parseRegions(twice, 'f.ts')).toThrow(/region "a".*twice/);
  });

  test('refuses an unclosed region, a stray #endregion and a mismatched name', () => {
    expect(() => parseRegions('// #region a\nx;', 'f.ts')).toThrow(
      /region "a".*never closed/,
    );
    expect(() => parseRegions('x;\n// #endregion', 'f.ts')).toThrow(
      /#endregion without a #region/,
    );
    expect(() =>
      parseRegions('// #region a\nx;\n// #endregion b', 'f.ts'),
    ).toThrow(/#endregion b closes region "a"/);
  });

  test('refuses a region name that is not lower-case words joined by hyphens', () => {
    expect(() =>
      parseRegions('// #region Step_5\nx;\n// #endregion', 'f.ts'),
    ).toThrow(/region name/);
  });

  test('trims the blank lines at either end of a region', () => {
    const regions = parseRegions(
      '// #region a\n\n  x;\n\n// #endregion',
      'f.ts',
    );
    expect(regions.get('a')).toBe('  x;');
  });
});

describe('dedent', () => {
  test('removes the indent common to every non-blank line', () => {
    expect(dedent('    a\n      b\n\n    c')).toBe('a\n  b\n\nc');
  });

  test('leaves text without a common indent as it is', () => {
    expect(dedent('a\n  b')).toBe('a\n  b');
  });
});

describe('findBlocks', () => {
  test('pairs each fence with the marker on the line above it, skipping blank lines', () => {
    const md = [
      '# Page',
      '',
      '<!-- snippet: docs/snippets/first-hour.ts#make-client -->',
      '',
      '```ts',
      'code',
      '```',
      '',
      '<!-- snippet: none -->',
      '~~~~sh',
      'npm install @xomarket/client viem',
      '~~~~',
      '',
      '```json',
      '{}',
      '```',
    ].join('\n');
    const blocks = findBlocks(md);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({
      lang: 'ts',
      line: 5,
      marker: {
        kind: 'region',
        path: 'docs/snippets/first-hour.ts',
        region: 'make-client',
      },
      content: 'code',
    });
    expect(blocks[1]).toMatchObject({
      lang: 'sh',
      marker: { kind: 'none' },
      content: 'npm install @xomarket/client viem',
    });
    expect(blocks[2]?.marker).toBeUndefined();
  });

  test('reads an indented fence (in a list) and a longer closing fence', () => {
    const md = [
      '- item',
      '',
      '  <!-- snippet: docs/snippets/first-hour.ts#inner -->',
      '  ```ts',
      '  await xo.close();',
      '  `````',
    ].join('\n');
    const [block] = findBlocks(md);
    expect(block).toMatchObject({
      indent: '  ',
      content: '  await xo.close();',
      marker: { kind: 'region', region: 'inner' },
    });
  });

  test('throws on a fence that is never closed', () => {
    expect(() => findBlocks('```ts\ncode')).toThrow(/never closed/);
  });
});

describe('findUnfencedCode', () => {
  test('an indented code block at the top level, and one inside a list item', () => {
    const md = [
      '# Page', // 1
      '', // 2
      '    const xo = await createPublicClient();', // 3: top-level indented code
      '', // 4
      '- an item', // 5
      '', // 6
      '      inside(the, item);', // 7: content indent 2 + 4 = code
      '', // 8
      '  a paragraph of the item', // 9: continuation, not code
      '', // 10
      '  - a nested item', // 11
      '', // 12
      '    its paragraph', // 13: continuation of the nested item
    ].join('\n');
    expect(findUnfencedCode(md)).toEqual([
      { line: 3, kind: 'indented' },
      { line: 7, kind: 'indented' },
    ]);
  });

  test('indented lines that follow text are not code, nor are fenced blocks and comments', () => {
    const md = [
      'A paragraph', // 1
      '    that wraps lazily.', // 2: no blank line before
      '', // 3
      '```ts', // 4
      '', // 5
      '    indented(inside, a, fence);', // 6
      '```', // 7
      '', // 8
      '<!--', // 9
      '', // 10
      '    an indented comment', // 11
      '-->', // 12
    ].join('\n');
    expect(findUnfencedCode(md)).toEqual([]);
  });

  test('an indented code block right after a heading, after a closing fence, or in a blockquote', () => {
    const md = [
      '## Heading', // 1
      '    code(after, a, heading);', // 2
      '', // 3
      '<!-- snippet: none -->', // 4
      '```sh', // 5
      'npm install', // 6
      '```', // 7
      '    code(after, a, fence);', // 8
      '', // 9
      '> A quote:', // 10
      '>', // 11
      '>     code(in, a, quote);', // 12
      '> > nested', // 13
      '> >', // 14
      '> >     code(in, a, nested, quote);', // 15
      '', // 16
      '> text', // 17
      '>     lazily(continued);', // 18: no blank quote line before: a paragraph
    ].join('\n');
    expect(findUnfencedCode(md)).toEqual([
      { line: 2, kind: 'indented' },
      { line: 8, kind: 'indented' },
      { line: 12, kind: 'indented' },
      { line: 15, kind: 'indented' },
    ]);
  });

  test('a <pre> block', () => {
    expect(findUnfencedCode('text\n\n<pre>\nconst x = 1;\n</pre>\n')).toEqual([
      { line: 3, kind: 'pre' },
    ]);
    expect(findUnfencedCode('<PRE class="x">x</PRE>')).toEqual([
      { line: 1, kind: 'pre' },
    ]);
  });

  test('checkPage fails both, even with a marker above them', () => {
    const md = [
      '<!-- snippet: docs/snippets/first-hour.ts#inner -->',
      '',
      '    await xo.close();',
      '',
      '<!-- snippet: none -->',
      '<pre>npm install</pre>',
    ].join('\n');
    expect(checkPage(md, 'docs/p.md', read).problems).toEqual([
      expect.stringMatching(
        /docs\/p\.md:3: an indented code block.*fenced block/,
      ),
      expect.stringMatching(/docs\/p\.md:6: a <pre> block.*fenced block/),
    ]);
  });
});

describe('isAllowedSource', () => {
  test('takes docs-only code and tests only, and nothing outside the repository', () => {
    expect(isAllowedSource('docs/snippets/first-hour.ts')).toBe(true);
    expect(isAllowedSource('packages/client/test/client.test.ts')).toBe(true);
    expect(isAllowedSource('packages/client/e2e/mainnet.e2e.test.ts')).toBe(
      true,
    );
    expect(isAllowedSource('scripts/test/unresolved.test.ts')).toBe(true);
    expect(isAllowedSource('packages/client/src/client.ts')).toBe(false);
    expect(isAllowedSource('scripts/docs-publish.ts')).toBe(false);
    expect(isAllowedSource('docs/markets.md')).toBe(false);
    expect(isAllowedSource('../docs/snippets/first-hour.ts')).toBe(false);
    expect(
      isAllowedSource('docs/snippets/../../packages/client/src/index.ts'),
    ).toBe(false);
    expect(isAllowedSource('/docs/snippets/first-hour.ts')).toBe(false);
  });

  test('never takes a runnable example: the examples are not quoted', () => {
    expect(isAllowedSource('examples/scripts/src/list-markets.ts')).toBe(false);
    expect(isAllowedSource('examples/mm-bot/index.ts')).toBe(false);
  });
});

describe('checkPage', () => {
  const page = (block: string, marker: string, lang = 'ts') =>
    ['# Page', '', marker, `\`\`\`${lang}`, block, '```', ''].join('\n');

  test('passes a block equal to its region, whatever the indent', () => {
    const md = page(
      'const xo = await createPublicClient({\n  environment: production,\n});',
      '<!-- snippet: docs/snippets/first-hour.ts#make-client -->',
    );
    const result = checkPage(md, 'docs/quickstart.md', read);
    expect(result.problems).toEqual([]);
    expect(result.stats).toEqual({ blocks: 1, regions: 1, none: 0 });
  });

  test('fails a block that differs from its region, naming the first different line', () => {
    const md = page(
      'const xo = await createPublicClient({\n  environment: customEnv,\n});',
      '<!-- snippet: docs/snippets/first-hour.ts#make-client -->',
    );
    const { problems } = checkPage(md, 'docs/quickstart.md', read);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /docs\/quickstart\.md:4: .*differs from docs\/snippets\/first-hour\.ts#make-client.*line 2/s,
    );
  });

  test('fails a code block without a marker, and a marker that is not one', () => {
    const md = [
      '```ts',
      'x',
      '```',
      '',
      '<!-- snippet: -->',
      '```ts',
      'y',
      '```',
    ].join('\n');
    const { problems } = checkPage(md, 'docs/p.md', read);
    expect(problems).toEqual([
      expect.stringMatching(/docs\/p\.md:1: .*no snippet marker/),
      expect.stringMatching(/docs\/p\.md:6: .*no snippet marker/),
    ]);
  });

  test('takes `none` for a shell or JSON block only', () => {
    for (const lang of ['sh', 'bash', 'shell', 'console', 'json']) {
      const md = page('npm install', '<!-- snippet: none -->', lang);
      expect(checkPage(md, 'docs/p.md', read).problems).toEqual([]);
    }
    for (const lang of ['ts', 'typescript', 'js', '']) {
      const md = page('const x = 1;', '<!-- snippet: none -->', lang);
      expect(checkPage(md, 'docs/p.md', read).problems).toEqual([
        expect.stringMatching(/`none` is only for a shell or JSON block/),
      ]);
    }
  });

  test('fails a missing file, a missing region, a runnable example and a source that is not docs-only code or a test', () => {
    const missingFile = page(
      'x',
      '<!-- snippet: docs/snippets/nope.ts#make-client -->',
    );
    expect(checkPage(missingFile, 'docs/p.md', read).problems).toEqual([
      expect.stringMatching(/docs\/snippets\/nope\.ts does not exist/),
    ]);
    const missingRegion = page(
      'x',
      '<!-- snippet: docs/snippets/first-hour.ts#nope -->',
    );
    expect(checkPage(missingRegion, 'docs/p.md', read).problems).toEqual([
      expect.stringMatching(
        /no region "nope" in docs\/snippets\/first-hour\.ts/,
      ),
    ]);
    const notAllowed = page(
      'x',
      '<!-- snippet: packages/client/src/client.ts#make-client -->',
    );
    expect(checkPage(notAllowed, 'docs/p.md', read).problems).toEqual([
      expect.stringMatching(/not docs-only code or a test/),
    ]);
    const example = page(
      'x',
      '<!-- snippet: examples/scripts/src/list-markets.ts#make-client -->',
    );
    expect(checkPage(example, 'docs/p.md', read).problems).toEqual([
      expect.stringMatching(/not docs-only code or a test/),
    ]);
  });

  test('reports a broken region file once per block, as a problem', () => {
    const broken = { 'docs/snippets/broken.ts': '// #region a\nx;' };
    const md = page('x', '<!-- snippet: docs/snippets/broken.ts#a -->');
    expect(
      checkPage(
        md,
        'docs/p.md',
        (path) => broken[path as 'docs/snippets/broken.ts'],
      ).problems,
    ).toEqual([expect.stringMatching(/never closed/)]);
  });

  test('--write refreshes a stale block, keeps its fence and indent, and is idempotent', () => {
    const md = [
      '- step',
      '',
      '  <!-- snippet: docs/snippets/first-hour.ts#make-client -->',
      '  ```ts',
      '  old code',
      '  ```',
      '',
      '<!-- snippet: none -->',
      '```sh',
      'npm install',
      '```',
    ].join('\n');
    const first = checkPage(md, 'docs/p.md', read, { write: true });
    expect(first.problems).toEqual([]);
    expect(first.output).toBe(
      [
        '- step',
        '',
        '  <!-- snippet: docs/snippets/first-hour.ts#make-client -->',
        '  ```ts',
        '  const xo = await createPublicClient({',
        '    environment: production,',
        '  });',
        '  ```',
        '',
        '<!-- snippet: none -->',
        '```sh',
        'npm install',
        '```',
      ].join('\n'),
    );
    const second = checkPage(first.output ?? '', 'docs/p.md', read, {
      write: true,
    });
    expect(second.output).toBe(first.output);
    expect(checkPage(first.output ?? '', 'docs/p.md', read).problems).toEqual(
      [],
    );
  });

  test('--write still reports what it cannot fix', () => {
    const md = page('x', '<!-- snippet: docs/snippets/first-hour.ts#nope -->');
    const result = checkPage(md, 'docs/p.md', read, { write: true });
    expect(result.problems).toEqual([
      expect.stringMatching(/no region "nope"/),
    ]);
  });

  test('keeps CRLF pages comparable', () => {
    const md = page(
      'const xo = await createPublicClient({\n  environment: production,\n});',
      '<!-- snippet: docs/snippets/first-hour.ts#make-client -->',
    ).replaceAll('\n', '\r\n');
    expect(checkPage(md, 'docs/p.md', read).problems).toEqual([]);
  });
});
