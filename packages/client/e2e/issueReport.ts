import { rmSync, writeFileSync } from 'node:fs';
import type { Reporter, TestModule } from 'vitest/node';
import { redact } from '../src/core/redact';

// The body of the "Nightly e2e failing" issue: the failing tests and, for each, its errors with
// the same redaction the e2e output uses. vitest runs this reporter when XO_E2E_ISSUE_FILE
// names the file to write (see vitest.e2e.config.ts); the nightly workflow posts the file.
// Nothing here reads a key: the secrets (XO_E2E_WALLET_PK, and any other XO_E2E_*_PK) are
// scrubbed by value and by shape, as a second line of defence behind tests that never print one.

/** The most characters of one error message, of its issues, and of the whole body. */
const MAX_MESSAGE = 2000;
const MAX_ISSUES = 4000;
const MAX_BODY = 60_000;

/**
 * The fields of an error the issue shows; everything else is left out: a `cause`, a stack, and
 * vitest's `diff`, `actual` and `expected` (they can quote a whole response). `requestId` is
 * the services' correlation id, which the SDK already redacts (XoError).
 */
const ERROR_FIELDS = [
  'name',
  'code',
  'service',
  'status',
  'requestId',
  'mayHaveLanded',
  'txHash',
  'orderHash',
] as const;

/** One failed test, suite, file or run, and its errors as vitest serialized them. */
export interface FailureEntry {
  name: string;
  errors: ReadonlyArray<unknown>;
}

const SHAPES: ReadonlyArray<[RegExp, string]> = [
  // A signature: 0x and 130 hex characters or more (a tx hash or an id is 64).
  [/0x[0-9a-fA-F]{130,}/g, '[redacted signature]'],
  // An HMAC secret: 43 characters of (URL-safe) base64 and one '='.
  [/(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{43}=(?![A-Za-z0-9=])/g, '[redacted]'],
  // An API key id (a UUID) and a passphrase (32 letters and digits).
  [
    /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
    '[redacted]',
  ],
  [/(?<![A-Za-z0-9])[A-Za-z0-9]{32}(?![A-Za-z0-9])/g, '[redacted]'],
];

/**
 * The secret values in the environment: every `XO_E2E_*` variable whose name says it holds
 * a key (`_PK`), with and without `0x`, so a key printed either way is caught.
 */
export function secretsFromEnv(
  environment: Record<string, string | undefined> = process.env,
): string[] {
  const secrets: string[] = [];
  for (const [name, raw] of Object.entries(environment)) {
    const value = raw?.trim() ?? '';
    if (!/^XO_E2E_.*_PK(_|$)/.test(name) || value.length < 16) {
      continue;
    }
    const bare = value.replace(/^0[xX]/, '');
    secrets.push(value, bare, `0x${bare}`);
  }
  return secrets;
}

/**
 * `text` without the given secrets (in any case), without `xo_sk_` keys (the SDK's own
 * `redact`) and without anything shaped like a signature, an HMAC secret, a passphrase or an
 * API key id.
 */
export function scrub(text: string, secrets: readonly string[]): string {
  let safe = String(redact(text));
  for (const secret of secrets) {
    if (secret.length >= 16) {
      safe = safe.replace(
        new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
        '[redacted]',
      );
    }
  }
  for (const [shape, replacement] of SHAPES) {
    safe = safe.replace(shape, replacement);
  }
  return safe;
}

const cut = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}… (cut)` : text;

/** A fenced block that the text cannot close early. */
function fenced(text: string): string {
  return ['~~~~', text.replace(/~{4,}/g, '~~~'), '~~~~'].join('\n');
}

/**
 * One error: its known fields, its message and its schema issues (paths and messages). Each
 * part is scrubbed whole before it is cut: a cut through a secret would leave a piece that the
 * by-value scrub no longer recognises.
 */
function describeError(error: unknown, secrets: readonly string[]): string {
  if (typeof error !== 'object' || error === null) {
    return cut(scrub(String(error), secrets), MAX_MESSAGE);
  }
  const e = redact(error) as Record<string, unknown>;
  const head = scrub(
    ERROR_FIELDS.filter((field) => e[field] !== undefined)
      .map((field) => `${field}: ${String(e[field])}`)
      .join(', '),
    secrets,
  );
  const lines = [
    head,
    cut(scrub(String(e.message ?? ''), secrets), MAX_MESSAGE),
  ];
  if (e.issues !== undefined) {
    lines.push(
      `issues: ${cut(scrub(JSON.stringify(e.issues) ?? '', secrets), MAX_ISSUES)}`,
    );
  }
  return lines.filter((line) => line !== '').join('\n');
}

/** The issue body: one section per failure. Empty when there is none. */
export function failureReport(
  entries: readonly FailureEntry[],
  secrets: readonly string[],
): string {
  if (entries.length === 0) {
    return '';
  }
  const sections = entries.map((entry) => {
    const errors =
      entry.errors.length === 0
        ? ['(no error was recorded)']
        : entry.errors.map((error) => fenced(describeError(error, secrets)));
    return [`### ${scrub(entry.name, secrets)}`, ...errors].join('\n\n');
  });
  // Every section is scrubbed already, so cutting the body cannot split a secret.
  const body = [
    `${entries.length} failure(s) in the live e2e run on mainnet.`,
    ...sections,
  ].join('\n\n');
  return body.length > MAX_BODY
    ? `${body.slice(0, MAX_BODY)}\n\n… (cut: see the run log)`
    : body;
}

/** The module's path from the package root, for a name. */
function relative(moduleId: string): string {
  const at = moduleId.lastIndexOf('/e2e/');
  return at === -1 ? moduleId : moduleId.slice(at + 1);
}

/** The failures of a finished run: files, suites (hooks), tests and unhandled errors. */
export function collectFailures(
  modules: ReadonlyArray<TestModule>,
  unhandled: ReadonlyArray<unknown>,
): FailureEntry[] {
  const entries: FailureEntry[] = [];
  for (const module of modules) {
    const file = relative(module.moduleId);
    const own = module.errors();
    if (own.length > 0) {
      entries.push({ name: file, errors: own });
    }
    for (const suite of module.children.allSuites()) {
      const errors = suite.errors();
      if (errors.length > 0) {
        entries.push({ name: `${file} > ${suite.fullName}`, errors });
      }
    }
    for (const test of module.children.allTests('failed')) {
      entries.push({
        name: `${file} > ${test.fullName}`,
        errors: test.result().errors ?? [],
      });
    }
  }
  if (unhandled.length > 0) {
    entries.push({ name: 'unhandled errors', errors: unhandled });
  }
  return entries;
}

/**
 * Writes {@link failureReport} to `file` when the run had a failure, and removes the file when
 * it had none, so a stale report is never posted.
 */
export class IssueReporter implements Reporter {
  constructor(private readonly file: string) {}

  onTestRunEnd(
    modules: ReadonlyArray<TestModule>,
    unhandled: ReadonlyArray<unknown>,
  ): void {
    const body = failureReport(
      collectFailures(modules, unhandled),
      secretsFromEnv(),
    );
    if (body === '') {
      rmSync(this.file, { force: true });
      return;
    }
    writeFileSync(this.file, `${body}\n`);
  }
}
