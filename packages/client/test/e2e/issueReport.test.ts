import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { TestModule } from 'vitest/node';
import {
  collectFailures,
  failureReport,
  IssueReporter,
  scrub,
  secretsFromEnv,
} from '../../e2e/issueReport';

// The failure report of the nightly workflow: what it shows, and that a key, a secret or a
// signature never reaches it, whether it comes from the environment or has the shape of one.

const KEY = 'ab'.repeat(32);
const HMAC_SECRET = `${'A1b2C3d4-_'.repeat(4)}xyz=`;
const PASSPHRASE = 'a1B2'.repeat(8);
const API_KEY_ID = '123e4567-e89b-12d3-a456-426614174000';
const SIGNATURE = `0x${'cd'.repeat(65)}`;
const TX_HASH = `0x${'ef'.repeat(32)}`;

describe('secretsFromEnv', () => {
  test('takes the XO_E2E_*_PK* values, with and without 0x, and nothing else', () => {
    const secrets = secretsFromEnv({
      XO_E2E_WALLET_PK: `0x${KEY}`,
      XO_E2E_OTHER_PK_2: KEY.toUpperCase(),
      XO_E2E_ISSUE_FILE: 'some-market-slug-that-is-long',
      XO_E2E_PK_SHORT: 'abc',
      HOME: '/home/runner',
    });
    expect(secrets).toContain(`0x${KEY}`);
    expect(secrets).toContain(KEY);
    expect(secrets).toContain(KEY.toUpperCase());
    expect(secrets).not.toContain('some-market-slug-that-is-long');
    expect(secrets).not.toContain('/home/runner');
    expect(secrets).not.toContain('abc');
  });
});

describe('scrub', () => {
  test('removes a known secret in any case, and xo_sk_ keys', () => {
    const text = `key 0x${KEY.toUpperCase()} then ${KEY} and xo_sk_data_abc123`;
    const safe = scrub(text, [`0x${KEY}`, KEY]);
    expect(safe).not.toContain(KEY);
    expect(safe).not.toContain(KEY.toUpperCase());
    expect(safe).not.toContain('xo_sk_data_abc123');
  });

  test('removes what has the shape of a signature, an HMAC secret, a passphrase or a key id, and keeps hashes and addresses', () => {
    const text = [
      `sig ${SIGNATURE}`,
      `secret ${HMAC_SECRET}`,
      `passphrase ${PASSPHRASE}`,
      `apiKey ${API_KEY_ID}`,
      `tx ${TX_HASH}`,
      'address 0xA822Ca71B1CDfF2A132d3e2bebeD4D990E5bcCd2',
    ].join('\n');
    const safe = scrub(text, []);
    for (const secret of [SIGNATURE, HMAC_SECRET, PASSPHRASE, API_KEY_ID]) {
      expect(safe).not.toContain(secret);
    }
    expect(safe).toContain(TX_HASH);
    expect(safe).toContain('0xA822Ca71B1CDfF2A132d3e2bebeD4D990E5bcCd2');
  });
});

describe('failureReport', () => {
  test('one section per failure, with the known fields, the message and the issues, redacted', () => {
    const body = failureReport(
      [
        {
          name: 'e2e/auth.e2e.test.ts > Live auth > login',
          errors: [
            {
              name: 'RequestRejectedError',
              code: 'policy_rejected',
              status: 403,
              mayHaveLanded: false,
              message: `refused for 0x${KEY}`,
              cause: { secret: 'never shown' },
              stack: 'at somewhere',
            },
          ],
        },
        {
          name: 'e2e/data.e2e.test.ts > strict',
          errors: [
            {
              name: 'UnexpectedResponseError',
              message: 'Unexpected backend response',
              issues: [{ path: 'data.0.positionType', code: 'invalid_value' }],
            },
          ],
        },
        { name: 'unhandled errors', errors: [] },
      ],
      [`0x${KEY}`, KEY],
    );
    expect(body).toMatch(/^3 failure\(s\) in the live e2e run on mainnet\.\n/);
    expect(body).toContain('### e2e/auth.e2e.test.ts > Live auth > login');
    expect(body).toContain(
      'name: RequestRejectedError, code: policy_rejected, status: 403, mayHaveLanded: false',
    );
    expect(body).toContain('data.0.positionType');
    expect(body).toContain('(no error was recorded)');
    expect(body).not.toContain(KEY);
    expect(body).not.toContain('never shown');
    expect(body).not.toContain('at somewhere');
  });

  test('empty without failures; a fence in a message cannot close the block', () => {
    expect(failureReport([], [])).toBe('');
    const body = failureReport(
      [{ name: 't', errors: [{ message: 'a ~~~~ b' }] }],
      [],
    );
    expect(body.match(/~~~~/g)).toHaveLength(2);
  });
});

describe('failureReport: scrubbed before any cut', () => {
  // A key that by value is in the environment, and a signature caught by its shape. No 8
  // characters of either may reach the body, wherever the cuts fall.
  const key = '3f9c'.repeat(16);
  const signature = `0x${'7d1e'.repeat(33)}`.slice(0, 132);
  const pieces = (secret: string) =>
    Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8));
  const leaks = (body: string) =>
    [...pieces(key), ...pieces(signature.slice(2))].filter((piece) =>
      body.includes(piece),
    );

  test('a key or a signature across the message cut (2000)', () => {
    for (const secret of [key, `0x${key}`, signature]) {
      for (const before of [1990, 1999, 2000 - secret.length / 2]) {
        const message = `${'x'.repeat(before)}${secret}${'y'.repeat(600)}`;
        const body = failureReport(
          [{ name: 't', errors: [{ message }] }],
          [key, `0x${key}`],
        );
        expect(body).toContain('(cut)');
        expect(leaks(body)).toEqual([]);
      }
    }
  });

  test('a key or a signature across the issues cut (4000)', () => {
    for (const secret of [key, signature]) {
      // JSON.stringify adds the quotes and brackets: the secret straddles 4000 either way.
      const issues = [
        { message: `${'q'.repeat(3990)}${secret}${'r'.repeat(600)}` },
      ];
      const body = failureReport(
        [{ name: 't', errors: [{ message: 'm', issues }] }],
        [key],
      );
      expect(body).toContain('(cut)');
      expect(leaks(body)).toEqual([]);
    }
  });

  test('a key or a signature across the body cut (60000)', () => {
    const entries = Array.from({ length: 40 }, (_, n) => ({
      name: `test ${n}`,
      errors: [
        {
          message: `${'z'.repeat(1700)}${n % 2 === 0 ? key : signature}${'w'.repeat(200)}`,
        },
      ],
    }));
    const body = failureReport(entries, [key]);
    expect(body).toContain('(cut: see the run log)');
    expect(leaks(body)).toEqual([]);
  });

  test("vitest's diff, actual and expected never reach the body; requestId does", () => {
    const body = failureReport(
      [
        {
          name: 't',
          errors: [
            {
              name: 'AssertionError',
              message: 'merge: every call mined with success',
              diff: '- Expected\n+ Received SECRET-DIFF',
              actual: 'SECRET-ACTUAL',
              expected: 'SECRET-EXPECTED',
              requestId: 'corr-1234',
            },
          ],
        },
      ],
      [],
    );
    expect(body).toContain('merge: every call mined with success');
    expect(body).toContain('requestId: corr-1234');
    for (const hidden of ['SECRET-DIFF', 'SECRET-ACTUAL', 'SECRET-EXPECTED']) {
      expect(body).not.toContain(hidden);
    }
  });
});

/** A finished-run stand-in with the parts of vitest's TestModule the collector reads. */
function fakeModule(o: {
  moduleErrors?: unknown[];
  suites?: Array<{ fullName: string; errors: unknown[] }>;
  failed?: Array<{ fullName: string; errors: unknown[] }>;
}): TestModule {
  return {
    moduleId: '/repo/packages/client/e2e/auth.e2e.test.ts',
    errors: () => o.moduleErrors ?? [],
    children: {
      allSuites: function* () {
        for (const suite of o.suites ?? []) {
          yield { fullName: suite.fullName, errors: () => suite.errors };
        }
      },
      allTests: function* (state?: string) {
        expect(state).toBe('failed');
        for (const test of o.failed ?? []) {
          yield {
            fullName: test.fullName,
            result: () => ({ state: 'failed', errors: test.errors }),
          };
        }
      },
    },
  } as unknown as TestModule;
}

describe('collectFailures and IssueReporter', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xo-sdk-issue-report-test-'));
    file = join(dir, 'failures.md');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('collects file, hook and test failures and unhandled errors, named from the package', () => {
    const entries = collectFailures(
      [
        fakeModule({
          moduleErrors: [{ message: 'syntax' }],
          suites: [
            {
              fullName: 'Live auth',
              errors: [{ message: 'beforeAll' }],
            },
            { fullName: 'quiet', errors: [] },
          ],
          failed: [
            {
              fullName: 'Live auth > step',
              errors: [{ message: 'x' }],
            },
          ],
        }),
      ],
      [{ message: 'late rejection' }],
    );
    expect(entries.map((e) => e.name)).toEqual([
      'e2e/auth.e2e.test.ts',
      'e2e/auth.e2e.test.ts > Live auth',
      'e2e/auth.e2e.test.ts > Live auth > step',
      'unhandled errors',
    ]);
  });

  test('writes the report when a test failed, and removes a stale one when none did', () => {
    const reporter = new IssueReporter(file);
    reporter.onTestRunEnd(
      [
        fakeModule({
          failed: [{ fullName: 'a > b', errors: [{ message: 'boom' }] }],
        }),
      ],
      [],
    );
    expect(readFileSync(file, 'utf8')).toContain(
      '### e2e/auth.e2e.test.ts > a > b',
    );
    writeFileSync(file, 'stale');
    reporter.onTestRunEnd([fakeModule({})], []);
    expect(existsSync(file)).toBe(false);
  });
});
