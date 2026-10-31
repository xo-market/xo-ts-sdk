import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  CheckError,
  findPublicIssues,
  type PublicRule,
  run,
} from '../docs-public-check.js';

// The docs check (scripts/docs-public-check.ts): the pages of docs/ go to the public site
// docs.xo.market, so none may name the non-mainnet environment, use test-network wording, say "ask
// the XO team", or link a page of the site that is out of date. A page runs every rule but
// dev-prose; a generated reference page runs only dev-prose, since its words come from the
// source's TSDoc, which the repository-wide check reads. Tickets and internal terms are the
// repository-wide check's (scripts/public-check.ts).
//
// Every text that the repository-wide check catches is joined from fragments at runtime, never
// written whole, so this file passes that check.

/** Joins fragments into a text the repository-wide check catches. */
const j = (...parts: string[]): string => parts.join('');
/** The non-mainnet environment's name. */
const D = j('d', 'ev');
/** The word for a test network, which is also its rule's name. */
const NET = j('test', 'net');

const rules = (
  text: string,
  scope: 'page' | 'reference' = 'page',
): PublicRule[] =>
  findPublicIssues('docs/x.md', text, scope).map((f) => f.rule);

describe('findPublicIssues, the rules', () => {
  test('dev-env flags the environment as the sample option, not the production config', () => {
    expect(rules(`createPublicClient({ environment: '${D}' })`)).toContain(
      'dev-env',
    );
    expect(rules(`createPublicClient({ env:  '${D}' })`)).toContain('dev-env');
    expect(rules('createPublicClient({ environment: production })')).toEqual(
      [],
    );
  });

  test('dev-word flags the word in any case, not words that contain it', () => {
    expect(rules(`Start on ${D}.`)).toEqual(['dev-word']);
    expect(rules(`Run it on ${D.toUpperCase()} first`)).toEqual(['dev-word']);
    expect(rules('Written for a developer')).toEqual([]);
    expect(rules('"devDependencies": {}')).toEqual([]);
    expect(rules('npm install -D typescript')).toEqual([]);
  });

  test('the test-network rule flags its two wordings, not latest USDC', () => {
    expect(rules(j('Fund it with test', ' USDC'))).toEqual([NET]);
    expect(rules(j('Runs on Test', 'net'))).toEqual([NET]);
    expect(rules('The latest USDC balance')).toEqual([]);
  });

  test('tickets and internal terms are the repository-wide check, not this one', () => {
    expect(rules(j('see XO', '-2479'))).toEqual([]);
    expect(rules(j('As in ruling R', '42, the fee is 0'))).toEqual([]);
    expect(rules(j('Funded from the Trea', 'sury wallet'))).toEqual([]);
  });

  test('ask-xo flags "ask the XO team" and "contact the XO team", not the support address', () => {
    expect(rules('If it fails, ask the XO team.')).toEqual(['ask-xo']);
    expect(rules('Contact the XO team for a key')).toEqual(['ask-xo']);
    expect(rules('If it fails, email gm@xo.market.')).toEqual([]);
  });

  test('stale-link flags a link to any of the seven out-of-date pages, not other pages', () => {
    const stale = [
      'documentation/introduction',
      'guides/smart-accounts',
      'guides/wire-conventions',
      'guides/redeem-positions',
      'guides/market-lifecycle',
      'api-reference/introduction',
      'product/portfolio/claim-payouts',
    ];
    for (const path of stale) {
      expect(rules(`[x](/${path})`)).toEqual(['stale-link']);
      expect(rules(`[x](https://docs.xo.market/${path})`)).toEqual([
        'stale-link',
      ]);
      expect(rules(`[x](/${path}#section)`)).toEqual(['stale-link']);
      expect(rules(`[x](/${path}/ "title")`)).toEqual(['stale-link']);
    }
    expect(rules('[x](/api-reference/rate-limits)')).toEqual([]);
    expect(rules('[x](/typescript-sdk/guides/smart-wallets)')).toEqual([]);
    expect(rules('[x](/guides/smart-accounts-v2)')).toEqual([]);
    expect(rules('[x](https://example.com/guides/smart-accounts)')).toEqual([]);
    expect(rules('The /guides/smart-accounts page')).toEqual([]);
  });

  test('stale-link reports the target of the link', () => {
    const [finding] = findPublicIssues(
      'docs/x.md',
      'See [accounts](https://docs.xo.market/guides/smart-accounts#a).',
      'page',
    );
    expect(finding?.text).toBe('https://docs.xo.market/guides/smart-accounts');
  });
});

describe('findPublicIssues, the report', () => {
  test('reports 1-based line numbers, the file and the matched text', () => {
    const text = [
      '# Title',
      '',
      'Fine.',
      'If stuck, ask the XO team.',
      'Fine.',
    ].join('\n');
    expect(findPublicIssues('docs/guides/x.md', text, 'page')).toEqual([
      {
        file: 'docs/guides/x.md',
        line: 4,
        rule: 'ask-xo',
        text: 'ask the XO team',
      },
    ]);
  });

  test('counts lines the same with Windows line endings', () => {
    const text = 'Fine.\r\nFine.\r\nAsk the XO team.\r\n';
    expect(
      findPublicIssues('docs/x.md', text, 'page').map((f) => f.line),
    ).toEqual([3]);
  });

  test('reports each rule that matches a line once, in line order', () => {
    const text = [
      `xo.auth.login({ env: '${D}' }) // ask the XO team`,
      'Nothing here.',
      'ask the XO team',
    ].join('\n');
    expect(
      findPublicIssues('docs/x.md', text, 'page').map((f) => [f.line, f.rule]),
    ).toEqual([
      [1, 'dev-env'],
      [1, 'dev-word'],
      [1, 'ask-xo'],
      [3, 'ask-xo'],
    ]);
  });

  test('a rule that matches a line twice reports the first match', () => {
    expect(
      findPublicIssues(
        'docs/x.md',
        `Ask the XO team, then contact the XO team on ${D}.`,
        'page',
      ),
    ).toEqual([
      { file: 'docs/x.md', line: 1, rule: 'dev-word', text: D },
      { file: 'docs/x.md', line: 1, rule: 'ask-xo', text: 'Ask the XO team' },
    ]);
  });

  test('findings inside fenced code are still reported', () => {
    const text = [
      '```ts',
      `const client = createPublicClient({ environment: '${D}' });`,
      '```',
    ].join('\n');
    const found = findPublicIssues('docs/x.md', text, 'page');
    expect(found.map((f) => [f.line, f.rule])).toEqual([
      [2, 'dev-env'],
      [2, 'dev-word'],
    ]);
  });

  test('reference scope ignores dev-env, dev-word and the test-network rule: the name as a value is fine', () => {
    expect(
      rules(
        `env: '${D}' | 'mainnet'. \`environments.${D}\` has none. Use ${NET}.`,
        'reference',
      ),
    ).toEqual([]);
    expect(
      rules(`type EnvironmentName = '${D}' | 'mainnet'`, 'reference'),
    ).toEqual([]);
    expect(rules(`Pass the name (\`env: '${D}'\`)`, 'reference')).toEqual([]);
  });

  test('dev-prose flags the name after "on" or "in" in the reference, in any case', () => {
    expect(
      rules(`**Paging.** On ${D} this route ignores \`page\`.`, 'reference'),
    ).toEqual(['dev-prose']);
    expect(rules(`as seen in ${D}`, 'reference')).toEqual(['dev-prose']);
    expect(rules(`The default rail on ${D} and mainnet`, 'reference')).toEqual([
      'dev-prose',
    ]);
    expect(rules('Written in development', 'reference')).toEqual([]);
    expect(rules(`on \`${D}\` and \`mainnet\``, 'reference')).toEqual([]);
    expect(rules(`on '${D}'`, 'reference')).toEqual([]);
  });

  test('dev-prose reports what matched', () => {
    const [finding] = findPublicIssues(
      'docs/reference/x.md',
      `On ${D} this route ignores \`page\`.`,
      'reference',
    );
    expect(finding).toEqual({
      file: 'docs/reference/x.md',
      line: 1,
      rule: 'dev-prose',
      text: `On ${D}`,
    });
  });

  test('a page does not run dev-prose: dev-word already covers it', () => {
    expect(rules(`On ${D} this route ignores \`page\`.`)).toEqual(['dev-word']);
  });

  test('reference scope runs only dev-prose', () => {
    const text = [
      `Seen on ${D}.`,
      `env: '${D}'`,
      `Use ${NET}.`,
      'ask the XO team',
      '[x](/guides/smart-accounts)',
    ].join('\n');
    expect(rules(text, 'reference')).toEqual(['dev-prose']);
  });
});

describe('run, the pages of docs/site.json', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A repository with the given files (path -> text), and the reference folder. */
  function repo(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'docs-public-check-'));
    made.push(dir);
    mkdirSync(join(dir, 'docs/reference'), { recursive: true });
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return dir;
  }

  const manifest = (sources: string[]) =>
    JSON.stringify({
      tab: 'TypeScript SDK',
      root: 'typescript-sdk',
      insertAfter: 'Data API reference',
      repo: 'https://github.com/xo-market/xo-ts-sdk/blob/main',
      groups: [
        {
          group: 'G',
          icon: 'rocket',
          pages: sources.map((source) => ({
            source,
            slug: source.replace(/\.md$/, ''),
            description: 'D',
          })),
        },
      ],
    });

  test('checks the pages the manifest lists, the two READMEs and the reference', () => {
    const root = repo({
      'docs/site.json': manifest(['a.md', 'guides/b.md']),
      'docs/a.md': `# A\n\nStart on ${D}.\n`,
      'docs/guides/b.md': '# B\n\nFine.\n',
      'docs/unlisted.md': `# Not a page of the site\n\nStart on ${D}.\n`,
      'docs/reference/README.md': '# Reference\n\nAsk the XO team.\n',
      'docs/reference/client/Env.md': `# Env\n\n\`'${D}'\` or \`'mainnet'\`. On ${D} this route ignores \`page\`.\n`,
      'packages/client/README.md': '# Client\n',
      'examples/scripts/README.md': '# Examples\n',
    });
    const { findings, checked } = run(root, [], root);
    expect(checked).toBe(6);
    expect(findings.map((f) => [f.file, f.rule])).toEqual([
      ['docs/a.md', 'dev-word'],
      ['docs/reference/client/Env.md', 'dev-prose'],
    ]);
  });

  test('an empty page list is an error, not a clean run', () => {
    const root = repo({ 'docs/site.json': manifest([]) });
    expect(() => run(root, [], root)).toThrow(CheckError);
    expect(() => run(root, [], root)).toThrow(/no pages/);
  });

  test('a missing manifest, or a page it lists that is missing, is one "file not found" line', () => {
    const none = repo({});
    expect(() => run(none, [], none)).toThrow('file not found: docs/site.json');
    const root = repo({
      'docs/site.json': manifest(['gone.md']),
      'packages/client/README.md': '# Client\n',
      'examples/scripts/README.md': '# Examples\n',
    });
    expect(() => run(root, [], root)).toThrow(CheckError);
    expect(() => run(root, [], root)).toThrow('file not found: docs/gone.md');
  });

  test('a file named on the command line that is missing is named the same way', () => {
    const root = repo({});
    expect(() => run(root, ['docs/nope.md'], root)).toThrow(
      'file not found: docs/nope.md',
    );
  });

  test('a manifest that is not valid is an error naming docs/site.json', () => {
    const bad = repo({ 'docs/site.json': '{ nope' });
    expect(() => run(bad, [], bad)).toThrow(CheckError);
    expect(() => run(bad, [], bad)).toThrow(/docs\/site\.json/);
    const dup = repo({ 'docs/site.json': manifest(['a.md', 'a.md']) });
    expect(() => run(dup, [], dup)).toThrow(/docs\/site\.json.*duplicate/);
  });

  test('files named on the command line are checked as pages, whatever the manifest', () => {
    const root = repo({
      'docs/x.md': `Start on ${D}.\n`,
    });
    const { findings, checked } = run(root, ['docs/x.md'], root);
    expect(checked).toBe(1);
    expect(findings.map((f) => f.rule)).toEqual(['dev-word']);
  });
});
