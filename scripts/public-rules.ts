// The rules of the public-content check: what no tracked file of the repository, no file of the npm
// tarball, no commit message and no pull-request text may carry. Pure: no I/O. The command line is
// scripts/public-check.ts.
//
// Two kinds of rule.
//
// Hashed terms (dev-address, private-name, attribution, and the name of a third-party SDK, which
// is an internal-term). The terms themselves are never written in the repository: BLOCKED holds
// only their digests (`digestOf`), made from a local terms file that is not committed. A line is
// cut into tokens, and a token whose digest is in the table is a finding of that digest's rule.
// The tokens:
//   - words: runs of letters, digits, `.`, `-`, `_` and `\`, read the way a name is written in
//     code: split at an escape with a letter (`\n`, `\b`), other backslashes dropped
//     (`acme\.example`), `_` read as `-` (`XO_NAME_TOKEN`), in lower case, without leading or
//     trailing dots and hyphens; once as written and once with a `-` at each camelCase boundary
//     (`nameClient`, `NAMEClient`). Then every run of up to 8 of a word's dot-separated labels and
//     of each label's hyphen-separated parts (`name:src/a.ts`, `.name/`, `name.md`);
//   - `0x` and 40 hex digits (an address), in lower case.
//
// Regex rules (case-insensitive unless noted):
//   dev-env    the name of the non-mainnet environment as a word of its own: quoted, in prose, as a
//              property; not inside a longer word, a path, or a hyphenated name
//   test+net   the word for a test network, also inside a camelCase name, and test-token wording
//   ticket     `XO-` and two or more digits, as a ticket key (case-sensitive)
//   ruling     R, an optional hyphen, digits and an optional lower-case letter, as a token of
//              its own (case-sensitive; not inside a base64 run such as an integrity hash)
//   decision   D and digits, as a token of its own (case-sensitive)
//   spec-ref   a numbered reference into the design spec, or the plan's global-constraints heading
//   plan-task  a task id of the implementation plan, T, one or two digits and an optional
//              lower-case letter, as a token of its own (case-sensitive; not the time inside an
//              ISO timestamp, nor a bare `T12:00`, nor inside a base64 run); and a milestone or
//              section label in parentheses: M or S, then one or two digits
//   trea+sury  the name of XO's funding wallets, and its plural
//   internal-term  a path into the local spike folder (the word, then a slash); also a hashed term
//
// Two rule names are words their own rules catch, so this file writes them in two pieces (above, and
// in TEST_NETWORK_RULE and FUNDING_WALLET_RULE below): it passes the check it defines.
//
// A finding is one rule on one line. Its excerpt is the line with every match on it, of any rule,
// replaced by `***`, so a report never prints what it blocks.

import { hash } from 'node:crypto';

const TEST_NETWORK_RULE = `test${'net'}` as const;
const FUNDING_WALLET_RULE = `trea${'sury'}` as const;

export type PublicRule =
  | 'dev-address'
  | 'private-name'
  | 'attribution'
  | 'dev-env'
  | typeof TEST_NETWORK_RULE
  | 'ticket'
  | 'ruling'
  | 'decision'
  | 'spec-ref'
  | 'plan-task'
  | typeof FUNDING_WALLET_RULE
  | 'internal-term';

export interface PublicFinding {
  source: string;
  /** 1-based. */
  line: number;
  rule: PublicRule;
  /** The line with every match on it replaced by `***`, at most 160 characters. */
  excerpt: string;
}

/** Digest (`digestOf` of a term) → the rule a match of that term breaks. */
export type DigestTable = ReadonlyMap<string, PublicRule>;

/** Hex SHA-256 of the term in lower case, with a fixed prefix. */
export function digestOf(term: string): string {
  return hash('sha256', `xo-public-check:${term.toLowerCase()}`, 'hex');
}

/** The entries of one rule's digests. */
const entries = (rule: PublicRule, digests: string[]) =>
  digests.map((digest): [string, PublicRule] => [digest, rule]);

/**
 * The hashed terms. Each line of the local terms file (`kind<TAB>term`) gives one entry,
 * `digestOf(term)` → kind. `pnpm -s -C scripts public-check --digest <term>` prints the digest
 * (`-s` keeps pnpm from echoing the command, term and all).
 */
export const BLOCKED: DigestTable = new Map<string, PublicRule>([
  ...entries('dev-address', [
    '1f158868a68c906c18174deeda22e90f9b89ac95571f69d505ae8119d932fcfa',
    '1454b5862ba44daa3970b81cd15c399cb7c6b164015dc207d2184440bc62c7d8',
    'fc97725151ba508b73cb80ffb17dfca1cd31e524208da3ca9db41e9ede67a11d',
    '98ba2e4382aeaf58f4d93fa1e5728646e719ac9da087c73ba71bbacf9b96d9a8',
  ]),
  ...entries('private-name', [
    'd9167ee2b7b6ecc60043fad9f0985158f864bda7f366c80b9f8b4470990bf93d',
    '85ae8d2f6bb86a87825fe291b1a15674b5acc9451a771ba94c125a10d42f2d92',
    'fa370ee765d75ae8fed2c9a3c46b34481fc3b7535f8ca3dc922cb1b16d9e2549',
    '97fe35cf7ffb18a71a688b5083f22cf2767e5aae55f7436b3f466b908a994822',
    'fb8b0211b1d796bbfabce03af747ffbfafcc85b7c1dde7b027d3f02332e3c6c5',
    '62ced5aed6163cca10d344f7b053a329c660c2837419b9dffb262bca81a1bedb',
    '0ede0ef5103efeaaab2fddfd4b633b66901cd4a2c41aa44851d8f10e28fb8712',
    '41ec31c6f4d78cfdf9ab288e98debeef3e055989d6f6729d28604e0c5ebfbb93',
  ]),
  ...entries('attribution', [
    'bd1624132895cdd4e1507cc88e5ca0801e29f581944ae6990836dadc784ad576',
    '47018a63ef3249f739ef0281fe9bcac4bc246128b4cef3124c54713710b9436f',
  ]),
  ...entries('internal-term', [
    // a third-party SDK's name
    '032b99c7e55f52f8495a0c49dc28dfab1494e20c1f0475667b14c6ff2bbeeb16',
  ]),
]);

/** The order of the findings of one line. */
const ORDER: readonly PublicRule[] = [
  'dev-address',
  'private-name',
  'attribution',
  'dev-env',
  TEST_NETWORK_RULE,
  'ticket',
  'ruling',
  'decision',
  'spec-ref',
  'plan-task',
  FUNDING_WALLET_RULE,
  'internal-term',
];

// The patterns are written so that their own source does not match them (`de[v]`, `test[n]et`).
const REGEX_RULES: readonly { rule: PublicRule; pattern: RegExp }[] = [
  { rule: 'dev-env', pattern: /(?<![a-z0-9/-])de[v](?![a-z0-9/-])/gi },
  {
    rule: TEST_NETWORK_RULE,
    pattern: /(?<![a-z0-9])test(?:[n]ets?|\s+usdc)(?![a-z0-9])/gi,
  },
  // Inside a camelCase name, case-sensitive: a capital T after a lower-case letter or digit, or a
  // name that goes on with a capital or a digit.
  { rule: TEST_NETWORK_RULE, pattern: /(?<=[a-z0-9])Test[nN]ets?(?![a-z])/g },
  {
    rule: TEST_NETWORK_RULE,
    pattern: /(?<![A-Za-z0-9])[Tt]est[nN]ets?(?=[A-Z0-9])/g,
  },
  { rule: 'ticket', pattern: /(?<![A-Za-z0-9])XO-\d{2,}/g },
  {
    rule: 'ruling',
    pattern: /(?<![A-Za-z0-9_])R-?\d+(?:[a-z](?![+/=]))?(?![A-Za-z0-9_])/g,
  },
  { rule: 'decision', pattern: /(?<![A-Za-z0-9_])D\d+(?![A-Za-z0-9_])/g },
  {
    rule: 'spec-ref',
    pattern:
      /\bspec(?:\s+|\s*\(\s*)(?:sections?\s+)?\d+(?:\.\d+)*|\bglobal\s+constraints\b/gi,
  },
  {
    rule: 'plan-task',
    pattern: /(?<![A-Za-z0-9_+/=])T\d{1,2}[a-z]?(?![A-Za-z0-9_+/=]|:\d)/g,
  },
  { rule: 'plan-task', pattern: /\([MS]\d{1,2}[a-z]?\)/g },
  { rule: FUNDING_WALLET_RULE, pattern: /treasur(?:y|ies)/gi },
  { rule: 'internal-term', pattern: /(?<![a-z0-9])spike\//gi },
];

/** Most labels or parts of a word that one hashed term can span. */
const MAX_RUN = 8;
/** The excerpt's length cap. */
const MAX_EXCERPT = 160;

interface Match {
  rule: PublicRule;
  start: number;
  end: number;
}

/** The digests of words, which repeat across files; bounded so a long run stays small. */
const wordDigests = new Map<string, string>();

function cachedDigest(term: string): string {
  let digest = wordDigests.get(term);
  if (digest === undefined) {
    if (wordDigests.size >= 200_000) {
      wordDigests.clear();
    }
    digest = digestOf(term);
    wordDigests.set(term, digest);
  }
  return digest;
}

/** A run of consecutive pieces of a text: its text and where it starts and ends in the text. */
interface Run {
  term: string;
  from: number;
  to: number;
}

/**
 * Every run of 1 to MAX_RUN consecutive pieces of `text` split on `separator`. A run never spans
 * an empty piece.
 */
function runs(text: string, separator: string): Run[] {
  const pieces: { from: number; to: number }[] = [];
  let from = 0;
  for (const piece of text.split(separator)) {
    pieces.push({ from, to: from + piece.length });
    from += piece.length + 1;
  }
  const found: Run[] = [];
  for (const [first, start] of pieces.entries()) {
    for (const end of pieces.slice(first, first + MAX_RUN)) {
      if (end.from === end.to) {
        break;
      }
      found.push({
        term: text.slice(start.from, end.to),
        from: start.from,
        to: end.to,
      });
    }
  }
  return found;
}

/** A word as the hashed terms are looked up in it, with each character's offsets in the line. */
interface Word {
  text: string;
  starts: number[];
  ends: number[];
}

const isUpper = (c: string | undefined) => c !== undefined && /[A-Z]/.test(c);
const isLowerOrDigit = (c: string | undefined) =>
  c !== undefined && /[a-z0-9]/.test(c);

/** The word without leading or trailing dots and hyphens. */
function trimmed(word: Word): Word {
  const from = /^[.-]*/.exec(word.text)?.[0].length ?? 0;
  const to = Math.max(from, word.text.search(/[.-]*$/));
  return {
    text: word.text.slice(from, to),
    starts: word.starts.slice(from, to),
    ends: word.ends.slice(from, to),
  };
}

/**
 * The words of one token of the line (letters, digits, `.`, `-`, `_` and `\`, at `offset`), as
 * the header describes: each piece between escapes with a letter gives the word as written and,
 * when it differs, the word with a `-` at each camelCase boundary.
 */
function wordsOf(token: string, offset: number): Word[] {
  const pieces: { text: string; at: number }[] = [];
  let from = 0;
  for (const sequence of token.matchAll(/\\[a-z]/gi)) {
    pieces.push({ text: token.slice(from, sequence.index), at: from });
    from = sequence.index + 2;
  }
  pieces.push({ text: token.slice(from), at: from });
  const words: Word[] = [];
  for (const piece of pieces) {
    const chars: { c: string; at: number }[] = [];
    for (let i = 0; i < piece.text.length; i++) {
      const c = piece.text.charAt(i);
      if (c !== '\\') {
        chars.push({ c, at: offset + piece.at + i });
      }
    }
    const plain: Word = { text: '', starts: [], ends: [] };
    const camel: Word = { text: '', starts: [], ends: [] };
    const add = (word: Word, c: string, start: number, end: number) => {
      word.text += c;
      word.starts.push(start);
      word.ends.push(end);
    };
    for (const [i, { c, at }] of chars.entries()) {
      const prev = chars[i - 1]?.c;
      const next = chars[i + 1]?.c;
      if (
        isUpper(c) &&
        (isLowerOrDigit(prev) || (isUpper(prev) && /[a-z]/.test(next ?? '')))
      ) {
        add(camel, '-', at, at);
      }
      const lower = c === '_' ? '-' : c.toLowerCase();
      add(plain, lower, at, at + 1);
      add(camel, lower, at, at + 1);
    }
    for (const word of camel.text === plain.text ? [plain] : [plain, camel]) {
      const trim = trimmed(word);
      if (trim.text !== '') {
        words.push(trim);
      }
    }
  }
  return words;
}

/** The matches of the hashed terms on one line. */
function hashedMatches(line: string, digests: DigestTable): Match[] {
  const matches: Match[] = [];
  const look = (term: string, start: number, end: number) => {
    const rule = digests.get(cachedDigest(term));
    if (rule !== undefined) {
      matches.push({ rule, start, end });
    }
  };

  for (const m of line.matchAll(/[a-z0-9._\\-]+/gi)) {
    for (const word of wordsOf(m[0], m.index)) {
      const at = (from: number, to: number): [number, number] => [
        word.starts[from] ?? 0,
        word.ends[to - 1] ?? 0,
      ];
      for (const label of runs(word.text, '.')) {
        look(label.term, ...at(label.from, label.to));
        if (label.term.includes('.')) {
          continue;
        }
        for (const part of runs(label.term, '-')) {
          if (part.term !== label.term) {
            look(
              part.term,
              ...at(label.from + part.from, label.from + part.to),
            );
          }
        }
      }
    }
  }

  for (const m of line.matchAll(/0x[0-9a-f]{40}(?![0-9a-f])/gi)) {
    const address = m[0].toLowerCase();
    look(address, m.index, m.index + 42);
  }
  return matches;
}

/** The matches of the regex rules on one line. */
function regexMatches(line: string): Match[] {
  const matches: Match[] = [];
  for (const { rule, pattern } of REGEX_RULES) {
    for (const m of line.matchAll(pattern)) {
      matches.push({ rule, start: m.index, end: m.index + m[0].length });
    }
  }
  return matches;
}

/** The line with every match replaced by `***` (overlapping or touching matches as one), capped. */
function redact(line: string, matches: Match[]): string {
  const spans = matches
    .map(({ start, end }) => [start, end] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of spans) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  let excerpt = '';
  let at = 0;
  for (const [start, end] of merged) {
    excerpt += `${line.slice(at, start)}***`;
    at = end;
  }
  excerpt += line.slice(at);
  return excerpt.length > MAX_EXCERPT
    ? `${excerpt.slice(0, MAX_EXCERPT - 1)}…`
    : excerpt;
}

/**
 * The findings of one text, in line order, then in rule order: one per rule that matches a line.
 * `source` names the text in the report (a path, a commit, a variable).
 */
export function findPublicIssues(
  source: string,
  text: string,
  digests: DigestTable = BLOCKED,
): PublicFinding[] {
  const findings: PublicFinding[] = [];
  text.split(/\r\n?|\n/).forEach((line, index) => {
    const matches = [...regexMatches(line), ...hashedMatches(line, digests)];
    if (matches.length === 0) {
      return;
    }
    const excerpt = redact(line, matches);
    const rules = new Set(matches.map((m) => m.rule));
    for (const rule of ORDER) {
      if (rules.has(rule)) {
        findings.push({ source, line: index + 1, rule, excerpt });
      }
    }
  });
  return findings;
}
