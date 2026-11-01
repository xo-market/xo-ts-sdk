import { readFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { describe, expect, test } from 'vitest';
import {
  BLOCKED,
  type DigestTable,
  digestOf,
  findPublicIssues,
  type PublicRule,
} from '../public-rules.js';

// The rules of the public-content check (scripts/public-rules.ts). Every text the check must catch
// is joined from fragments at runtime, never written whole, so this file passes the check itself.
// The hashed terms here are made up and have their own digest table: the real ones never appear.

/** Joins fragments into a text the check must catch. */
const j = (...parts: string[]): string => parts.join('');

const NAME = 'acme-internal';
const ADDRESS = '0x00000000000000000000000000000000000000aa';

const TABLE: DigestTable = new Map<string, PublicRule>([
  [digestOf(NAME), 'private-name'],
  [digestOf(ADDRESS), 'dev-address'],
]);

/** No hashed term: only the regex rules run. */
const NONE: DigestTable = new Map();

const rules = (text: string, digests: DigestTable = TABLE): PublicRule[] =>
  findPublicIssues('x', text, digests).map((f) => f.rule);

/** Inputs with a hashed term, the rule each must give, and the term the excerpt must hide. */
const HASHED: [string, PublicRule, string][] = [
  [`see ${NAME}:src/a.ts:12`, 'private-name', NAME],
  [`.${NAME}/`, 'private-name', NAME],
  [getAddress(ADDRESS), 'dev-address', ADDRESS],
  [ADDRESS, 'dev-address', ADDRESS],
];

const D = j('d', 'ev');
/** Two rule names are words their own rules catch. */
const TEST_NETWORK_RULE = j('test', 'net') as PublicRule;
const FUNDING_WALLET_RULE = j('trea', 'sury') as PublicRule;

/** The regex rules: each input, its rule, and whether the rule catches it. */
const REGEX: [PublicRule, string, boolean][] = [
  ['dev-env', `env: '${D}'`, true],
  ['dev-env', `env:"${D}"`, true],
  ['dev-env', `environments.${D}`, true],
  ['dev-env', `on ${D}`, true],
  ['dev-env', `the ${D} sponsor`, true],
  ['dev-env', `${D} chain`, true],
  ['dev-env', `${D} environment`, true],
  ['dev-env', `${D} services`, true],
  ['dev-env', `'${D}'`, true],
  ['dev-env', `"${D}"`, true],
  ['dev-env', `\`${D}\``, true],
  ['dev-env', '/dev/null', false],
  ['dev-env', 'devDependencies', false],
  ['dev-env', 'developer', false],
  ['dev-env', 'device', false],
  [TEST_NETWORK_RULE, j('test', 'net'), true],
  [TEST_NETWORK_RULE, j('Test', 'nets'), true],
  [TEST_NETWORK_RULE, j('test', ' USDC'), true],
  [TEST_NETWORK_RULE, j('isTest', 'net'), true],
  [TEST_NETWORK_RULE, j('isTest', 'Net'), true],
  [TEST_NETWORK_RULE, j('test', 'netRpc'), true],
  [TEST_NETWORK_RULE, j('Test', 'netConfig'), true],
  [TEST_NETWORK_RULE, j('TEST', 'NET_RPC'), true],
  [TEST_NETWORK_RULE, 'latest net', false],
  [TEST_NETWORK_RULE, 'latestnet', false],
  [TEST_NETWORK_RULE, 'isLatestNet', false],
  ['ticket', j('XO', '-2588'), true],
  ['ticket', j('(XO', '-123)'), true],
  ['ticket', 'XO-1', false],
  ['ticket', 'REXO-1234', false],
  ['ruling', j('R', '108'), true],
  ['ruling', j('(R', '-32)'), true],
  ['ruling', j('ruling R', '116'), true],
  ['ruling', j('// R', '66:'), true],
  ['ruling', j('R', '92b'), true],
  ['ruling', j('(rulings R', '102 and R', '102b)'), true],
  ['ruling', 'secp256r1', false],
  ['ruling', 'R2D2', false],
  ['ruling', 'sha512-+R0l+dw3Ki+5s/R5a/aa==', false],
  ['ruling', 'R&D', false],
  ['ruling', 'RFC 6979', false],
  ['ruling', 'AR15x', false],
  ['decision', j('(D', '13)'), true],
  ['decision', j('D', '6:'), true],
  ['decision', '3D', false],
  ['decision', 'D3x', false],
  ['plan-task', j('T', '28'), true],
  ['plan-task', j('(T', '05)'), true],
  ['plan-task', j('tasks T', '31 and T', '32'), true],
  ['plan-task', j('the T', '24 pattern'), true],
  ['plan-task', '2026-10-30T12:00', false],
  ['plan-task', "'2026-06-01T12:00:00.000Z'", false],
  ['plan-task', 'T12:00', false],
  ['plan-task', 'UINT256', false],
  ['plan-task', j('T', '8'), true],
  ['plan-task', j('T', '8b'), true],
  ['plan-task', j('(T', '16b)'), true],
  ['plan-task', j('T', '28: label'), true],
  ['plan-task', j('(M', '0)'), true],
  ['plan-task', j('(S', '10)'), true],
  ['plan-task', 'T123', false],
  ['plan-task', 'M0', false],
  ['plan-task', 'S10', false],
  ['plan-task', 'sha512-+R0l+dw3Ki+5s/T5/aa+T8b==', false],
  ['plan-task', '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf', false],
  ['plan-task', 't28', false],
  ['plan-task', 'AT28x', false],
  ['spec-ref', j('spec sec', 'tion 9'), true],
  ['spec-ref', j('spec', ' 6.2'), true],
  ['spec-ref', j('the spec', ' (section 7.3)'), true],
  ['spec-ref', j('Global', ' Constraints'), true],
  ['spec-ref', 'EIP-712 spec', false],
  ['spec-ref', 'the SIWE spec', false],
  [FUNDING_WALLET_RULE, j('trea', 'sury'), true],
  [FUNDING_WALLET_RULE, j('Trea', 'suries'), true],
  ['internal-term', j('see spike', '/bundler'), true],
  ['internal-term', j('Spike', '/notes.md'), true],
  ['internal-term', 'spikes', false],
  ['internal-term', 'spike-free', false],
  ['internal-term', 'a spike in latency', false],
];

/** Identifier and escaped forms of the made-up name, and the excerpt each must give. */
const IDENTIFIERS: [string, PublicRule, string][] = [
  ['ACME_INTERNAL_TOKEN', 'private-name', '***_TOKEN'],
  ['const acme_internal = 1;', 'private-name', 'const *** = 1;'],
  ['acmeInternal()', 'private-name', '***()'],
  ['new AcmeInternalClient()', 'private-name', 'new ***Client()'],
  ['ACMEInternal', 'private-name', '***'],
  ['/acme\\-internal/', 'private-name', '/***/'],
  ['"first line\\nacme-internal"', 'private-name', '"first line\\n***"'],
];

describe('findPublicIssues, the hashed terms', () => {
  test('finds hashed terms inside larger tokens', () => {
    for (const [text, rule] of HASHED) {
      expect(rules(text), text).toEqual([rule]);
    }
    expect(getAddress(ADDRESS)).not.toBe(ADDRESS);
  });

  test('finds hashed terms inside identifiers and escaped text', () => {
    for (const [text, rule, excerpt] of IDENTIFIERS) {
      expect(findPublicIssues('x', text, TABLE), text).toEqual([
        { source: 'x', line: 1, rule, excerpt },
      ]);
    }
  });

  test('an identifier that only shares letters with a term is not a finding', () => {
    expect(rules('acmeinternals, AcmeInternals, acme_internals')).toEqual([]);
    expect(rules('ACME_INTERNALS and acmeInternally')).toEqual([]);
  });

  test('finds a name written with dots inside a longer dotted word', () => {
    const table: DigestTable = new Map([
      [digestOf('acme.tools'), 'private-name'],
    ]);
    expect(rules('see ACME.TOOLS', table)).toEqual(['private-name']);
    expect(rules('wss://ws.acme.tools/x', table)).toEqual(['private-name']);
    expect(rules('the acme.toolsets page and acme-tools', table)).toEqual([]);
  });

  test('finds a name as one part of a hyphenated or dotted word', () => {
    const table: DigestTable = new Map([[digestOf('acme'), 'attribution']]);
    expect(rules('see ACME.md', table)).toEqual(['attribution']);
    expect(rules('the acme-code tool', table)).toEqual(['attribution']);
    expect(rules('noreply@acme.example', table)).toEqual(['attribution']);
    expect(rules('acmeish and macme', table)).toEqual([]);
  });
});

describe('findPublicIssues, the regex rules', () => {
  test.each(REGEX)('%s on %j: caught %s', (rule, text, caught) => {
    expect(rules(text, NONE)).toEqual(caught ? [rule] : []);
  });
});

describe('findPublicIssues, the report', () => {
  test('a finding never contains the matched text', () => {
    for (const [text, rule, term] of HASHED) {
      const [finding] = findPublicIssues('x', text, TABLE);
      expect(finding?.rule).toBe(rule);
      expect(finding?.excerpt.toLowerCase()).not.toContain(term);
      expect(findPublicIssues('x', finding?.excerpt ?? '', TABLE)).toEqual([]);
    }
    for (const [rule, text, caught] of REGEX) {
      if (!caught) continue;
      const [finding] = findPublicIssues('x', text, NONE);
      expect(finding?.rule).toBe(rule);
      expect(finding?.excerpt).toContain('***');
      expect(findPublicIssues('x', finding?.excerpt ?? '', NONE)).toEqual([]);
    }
  });

  test('one finding per rule and line, each hiding every match on the line', () => {
    const ticket = j('XO', '-2588');
    const text = `${ticket} and ${j('trea', 'sury')} at /srv/${NAME}/a, ${ticket}`;
    const excerpt = '*** and *** at /srv/***/a, ***';
    expect(findPublicIssues('docs/a.md', text, TABLE)).toEqual([
      { source: 'docs/a.md', line: 1, rule: 'private-name', excerpt },
      { source: 'docs/a.md', line: 1, rule: 'ticket', excerpt },
      { source: 'docs/a.md', line: 1, rule: FUNDING_WALLET_RULE, excerpt },
    ]);
  });

  test('the excerpt is at most 160 characters', () => {
    const text = `${'a'.repeat(100)} ${j('trea', 'sury')} ${'b'.repeat(100)}`;
    const [finding] = findPublicIssues('x', text, NONE);
    expect(finding?.excerpt).toHaveLength(160);
    expect(finding?.excerpt.startsWith(`${'a'.repeat(100)} *** b`)).toBe(true);
  });

  test('reports 1-based line numbers and handles CRLF', () => {
    const text = ['fine', 'fine', `see ${j('XO', '-2588')}`, 'fine', ''].join(
      '\r\n',
    );
    expect(findPublicIssues('a.md', text, NONE)).toEqual([
      { source: 'a.md', line: 3, rule: 'ticket', excerpt: 'see ***' },
    ]);
  });

  test('the rules file passes its own check', () => {
    for (const file of ['../public-rules.ts', './public-rules.test.ts']) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(findPublicIssues(file, text)).toEqual([]);
    }
  });
});

describe('BLOCKED', () => {
  test('BLOCKED has the expected shape', () => {
    for (const digest of BLOCKED.keys()) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
    const hashed: PublicRule[] = [
      'dev-address',
      'private-name',
      'attribution',
      'internal-term',
    ];
    const present = new Set(BLOCKED.values());
    for (const rule of hashed) {
      expect(present.has(rule), rule).toBe(true);
    }
    expect([...present].every((rule) => hashed.includes(rule))).toBe(true);
  });

  test('blocks the name of the SDK we learned from, in any case', () => {
    const name = ['poly', 'market'].join(''); // built at run time so this file stays clean
    expect(BLOCKED.get(digestOf(name))).toBe('internal-term');
    expect(BLOCKED.get(digestOf(name.toUpperCase()))).toBe('internal-term');
  });

  test('digestOf ignores case', () => {
    expect(digestOf('Example.COM')).toBe(digestOf('example.com'));
    expect(digestOf('example.com')).toMatch(/^[0-9a-f]{64}$/);
  });
});
