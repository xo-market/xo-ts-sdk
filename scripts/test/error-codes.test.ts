import { describe, expect, test } from 'vitest';
import {
  checkErrorsPage,
  extractErrorCodes,
  parseErrorsPage,
} from '../error-codes.js';

// The error-code check of docs/errors.md (scripts/error-codes.ts): the codes are read from the
// SDK's source with the TypeScript compiler (not a grep), and the page must have one entry per
// code, with the right classes, and no entry for a code the source no longer knows.

/** A small stand-in for packages/client/src/core/errors.ts. */
const ERRORS = `
export interface XoErrorOptions { code?: string; service?: string; status?: number; cause?: unknown }
const scrub = (value: string) => value;
export class XoError extends Error {
  readonly code: string;
  readonly service: string;
  constructor(message: string, opts: XoErrorOptions = {}) {
    super(message);
    this.code = scrub(opts.code ?? 'xo_error');
    this.service = opts.service ?? 'sdk';
  }
}
export class ValidationError extends XoError {
  constructor(message: string, opts: XoErrorOptions = {}) {
    super(message, { ...opts, code: opts.code ?? 'invalid_input' });
  }
}
export class ConflictError extends XoError {
  constructor(message: string, opts: XoErrorOptions = {}) {
    super(message, { ...opts, code: opts.code ?? 'conflict' });
  }
}
export class TransactionError extends XoError {
  constructor(message: string, opts: XoErrorOptions & { mayHaveLanded: boolean }) {
    super(message, { ...opts, code: opts.code ?? 'transaction_failed' });
  }
}
export function parseServiceError(service: string, status: number, body: { code?: string }): XoError {
  const code = body.code ?? \`http_\${status}\`;
  const opts: XoErrorOptions = { code, service, status };
  if (status === 409) {
    return new ConflictError('conflict', opts);
  }
  return new XoError('failed', { ...opts });
}
`;

const files = (extra: Record<string, string>): Record<string, string> => ({
  'core/errors.ts': ERRORS,
  ...extra,
});

const codesOf = (extra: Record<string, string>) =>
  [...extractErrorCodes(files(extra)).codes.keys()].sort();

describe('extractErrorCodes', () => {
  test('a literal code, with its class and service', () => {
    const { codes } = extractErrorCodes(
      files({
        'a.ts': `import { ValidationError, XoError } from './core/errors';
          export const a = () => new XoError('x', { code: 'smart_wallet_not_deployed', service: 'chain' });
          export const b = () => new ValidationError('y', { code: 'direct_rail_single_call' });`,
      }),
    );
    expect(codes.get('smart_wallet_not_deployed')).toMatchObject({
      classes: ['XoError'],
      services: ['chain'],
    });
    expect(codes.get('direct_rail_single_call')).toMatchObject({
      classes: ['ValidationError'],
      services: ['sdk'],
    });
  });

  test("a class's default code counts only when some construction leaves the code out", () => {
    const codes = codesOf({
      'a.ts': `import { ValidationError, TransactionError } from './core/errors';
        export const a = () => new ValidationError('no code given');
        export const b = () => new TransactionError('x', { code: 'tx_reverted', mayHaveLanded: false });`,
    });
    // invalid_input: reachable. transaction_failed, conflict, xo_error: never left to the default.
    expect(codes).toContain('invalid_input');
    expect(codes).not.toContain('transaction_failed');
    expect(codes).not.toContain('conflict');
    expect(codes).not.toContain('xo_error');
    expect(codes).toContain('tx_reverted');
  });

  test('the code of a service error: the http_ template literal reads http_<status>', () => {
    const { codes } = extractErrorCodes(files({}));
    expect(codes.get('http_<status>')).toMatchObject({
      classes: ['ConflictError', 'XoError'],
    });
  });

  test('a conditional, a `??`, a constant and a `{ code }` shorthand', () => {
    const codes = codesOf({
      'a.ts': `import { XoError } from './core/errors';
        const STALE = 'ws_stale';
        export function f(answering: boolean, timedOut: boolean) {
          const code = answering ? 'ws_subscribe_refused' : 'ws_server_error';
          return [
            new XoError('a', { code }),
            new XoError('b', { code: timedOut ? 'receipt_timeout' : 'receipt_unavailable' }),
            new XoError('c', { code: STALE }),
            new XoError('d', { code: (STALE as string) }),
          ];
        }`,
    });
    expect(codes).toEqual(
      expect.arrayContaining([
        'ws_subscribe_refused',
        'ws_server_error',
        'receipt_timeout',
        'receipt_unavailable',
        'ws_stale',
      ]),
    );
  });

  test('an options object in a const, and a spread of one', () => {
    const codes = codesOf({
      'a.ts': `import { XoError } from './core/errors';
        const opts = { code: 'from_const', service: 'chain' };
        const base = { code: 'from_spread' };
        export const a = () => new XoError('a', opts);
        export const b = (status?: number) =>
          new XoError('b', { ...base, ...(status === undefined ? {} : { status }) });`,
    });
    expect(codes).toEqual(
      expect.arrayContaining(['from_const', 'from_spread']),
    );
  });

  test('a later property wins, and a spread of a parameter leaves the service open', () => {
    const { codes } = extractErrorCodes(
      files({
        'a.ts': `import { XoError } from './core/errors';
          export const a = () =>
            new XoError('a', { service: 'chain', ...{ service: 'sponsor' }, code: 'later_wins' });
          export const b = (extra: { service?: string }) =>
            new XoError('b', { code: 'open_service', service: 'chain', ...extra });`,
      }),
    );
    expect(codes.get('later_wins')?.services).toEqual(['sponsor']);
    expect(codes.get('open_service')?.services).toEqual([]);
  });

  test('a code passed to a helper is followed to every call of the helper', () => {
    const codes = codesOf({
      'a.ts': `import { XoError } from './core/errors';
        function fail(code: string, message: string) {
          return new XoError(message, { code, service: 'chain' });
        }
        const failToo = (what: string) => new XoError(what, { code: what === 'x' ? 'helper_c' : 'helper_d' });
        export const a = () => fail('helper_a', 'a');
        export const b = () => fail('helper_b', 'b');
        export const c = () => failToo('x');`,
    });
    expect(codes).toEqual(
      expect.arrayContaining(['helper_a', 'helper_b', 'helper_c', 'helper_d']),
    );
  });

  test('a subclass with a fixed code of its own counts when it is constructed', () => {
    const { codes } = extractErrorCodes(
      files({
        'b.ts': `import { XoError } from './core/errors';
          export class PlacementError extends XoError {
            constructor(message: string, opts: { orderHash: string }) {
              super(message, { code: 'placement_failed', service: 'sdk' });
            }
          }
          export class Unused extends XoError {
            constructor() { super('never', { code: 'never_constructed' }); }
          }
          export const p = () => new PlacementError('x', { orderHash: '0x' });`,
      }),
    );
    expect(codes.get('placement_failed')).toMatchObject({
      classes: ['PlacementError'],
      services: ['sdk'],
    });
    expect(codes.has('never_constructed')).toBe(false);
  });

  test('a subclass that passes its options through gets the parent default', () => {
    const codes = codesOf({
      'b.ts': `import { ValidationError } from './core/errors';
        export class Minted extends ValidationError {
          constructor(message: string, opts: { service?: string }) { super(message, opts); }
        }
        export const m = () => new Minted('x', { service: 'backend' });`,
    });
    expect(codes).toContain('invalid_input');
  });

  test('the `code` of a nested object (a zod issue) is not an error code', () => {
    const codes = codesOf({
      'a.ts': `import { ValidationError } from './core/errors';
        export const a = () => new ValidationError('x', {
          code: 'outer_code',
          issues: [{ path: 'p', code: 'invalid_value', message: 'm' }],
        } as never);`,
    });
    expect(codes).toContain('outer_code');
    expect(codes).not.toContain('invalid_value');
  });

  test("another error's code passed on is not a new code, and is not a problem", () => {
    const result = extractErrorCodes(
      files({
        'a.ts': `import { XoError } from './core/errors';
          export function wrap(error: XoError) {
            const { code } = readServerError();
            return [new XoError('x', { code: error.code }), new XoError('y', { code })];
          }
          declare function readServerError(): { code: string };`,
      }),
    );
    expect(result.unresolved).toEqual([]);
    expect(
      result.passthrough.filter((site) => site.startsWith('a.ts:')),
    ).toEqual(['a.ts:4', 'a.ts:4']);
    // parseServiceError passes the code of the server's answer on, twice.
    expect(
      result.passthrough.filter((site) => site.startsWith('core/errors.ts:')),
    ).toHaveLength(2);
  });

  test('a code it cannot work out is a problem, with its place', () => {
    const result = extractErrorCodes(
      files({
        'a.ts': `import { XoError } from './core/errors';
          declare function pick(): string;
          export const a = () => new XoError('x', { code: pick() });`,
      }),
    );
    expect(result.unresolved).toEqual([
      expect.stringMatching(/^a\.ts:3: .*pick\(\)/),
    ]);
  });

  test('options it cannot read statically are a problem, not a silent default', () => {
    const result = extractErrorCodes(
      files({
        'a.ts': `import { ValidationError, XoError } from './core/errors';
          declare function opts(code: string): { code: string };
          export const a = () => new XoError('x', opts('hidden_code'));
          export const b = (o: { code?: string }) => new ValidationError('y', o);
          export const c = (rest: [string]) => new XoError(...rest);
          export const d = () => new XoError('z', undefined);`,
      }),
    );
    expect(result.unresolved).toEqual([
      expect.stringMatching(
        /^a\.ts:3: .*options it cannot read.*opts\('hidden_code'\)/,
      ),
      expect.stringMatching(/^a\.ts:4: .*options passed in as a parameter/),
      expect.stringMatching(/^a\.ts:5: .*a spread argument/),
    ]);
    // An explicit \`undefined\` is no options at all: the class default, and no problem.
    expect(result.codes.get('xo_error')?.sites).toContain('a.ts:6');
  });

  test('an error class held in a variable, or built with Reflect.construct, is a problem', () => {
    const result = extractErrorCodes(
      files({
        'a.ts': `import { ValidationError, XoError } from './core/errors';
          export function f(strict: boolean) {
            const E = strict ? ValidationError : XoError;
            return [
              new E('x', { code: 'via_variable' }),
              new (strict ? ValidationError : XoError)('y'),
              Reflect.construct(XoError, ['z', { code: 'via_reflect' }]),
            ];
          }`,
      }),
    );
    expect(result.unresolved).toEqual([
      expect.stringMatching(/^a\.ts:5: .*held in a variable.*new E/),
      expect.stringMatching(/^a\.ts:6: .*held in a variable/),
      expect.stringMatching(/^a\.ts:7: .*Reflect\.construct/),
    ]);
  });

  test('a code set after construction is a problem', () => {
    const result = extractErrorCodes(
      files({
        'a.ts': `import { XoError } from './core/errors';
          export function f() {
            const e = new XoError('x', { code: 'first' }) as { code: string };
            e.code = 'later';
            Object.assign(e, { code: 'assigned' });
            Object.defineProperty(e, 'code', { value: 'defined' });
            Object.defineProperty(e, 'mayHaveLanded', { value: false });
            return e;
          }`,
      }),
    );
    expect(result.unresolved).toEqual([
      expect.stringMatching(/^a\.ts:4: .*set after construction/),
      expect.stringMatching(/^a\.ts:5: .*Object\.assign/),
      expect.stringMatching(/^a\.ts:6: .*Object\.defineProperty/),
    ]);
  });

  test('a code field initializer of a subclass wins over the options, and a code getter is a problem', () => {
    const result = extractErrorCodes(
      files({
        'a.ts': `import { XoError } from './core/errors';
          export class FieldError extends XoError {
            override readonly code = 'from_field';
          }
          export class Sub extends FieldError {}
          export class GetterError extends XoError {
            override get code(): string { return 'from_getter'; }
          }
          export const a = () => new FieldError('x', { code: 'ignored_option' });
          export const b = () => new Sub('y');
          export const c = () => new GetterError('z', { code: 'whatever' });`,
      }),
    );
    expect(result.codes.get('from_field')?.classes).toEqual([
      'FieldError',
      'Sub',
    ]);
    expect(result.codes.has('ignored_option')).toBe(false);
    expect(result.unresolved).toEqual([
      expect.stringMatching(/^a\.ts:7: .*`code` getter/),
    ]);
  });

  test('the codes of the services the SDK handles by name', () => {
    const { serviceCodes } = extractErrorCodes(
      files({
        'a.ts': `import { XoError } from './core/errors';
          export const PORTFOLIO_ERROR_CODES = ['INSUFFICIENT_SCOPE', 'RATE_LIMITED'] as const;
          const PERMANENT_CODES = new Map([['EVENT_TOO_LARGE', 'advice']]);
          export function f(error: XoError, code: string) {
            if (error.code === 'invalid_credentials') return 1;
            if ('nonce_too_low' !== error.code) return 2;
            if (code === 'API_KEY_INVALID') return 3;
            if (typeof error.code === 'string') return 4;
            return PERMANENT_CODES.size;
          }`,
      }),
    );
    expect([...serviceCodes.keys()].sort()).toEqual([
      'API_KEY_INVALID',
      'EVENT_TOO_LARGE',
      'INSUFFICIENT_SCOPE',
      'RATE_LIMITED',
      'invalid_credentials',
      'nonce_too_low',
    ]);
  });
});

const PAGE = `# Errors

| Field | What it holds |
| --- | --- |
| \`code\` | A stable code. |

## Codes the SDK raises

| Code | Class | What to do |
| --- | --- | --- |
| \`smart_wallet_not_deployed\` | \`XoError\` | Call \`setup()\` first. |
| \`http_<status>\` | \`ConflictError\`, \`XoError\` | Read the status. |

## Codes from the services

| Code | Class | What to do |
| --- | --- | --- |
| \`invalid_credentials\` | \`AuthError\` | Make a new key. |
| \`policy_rejected\` | \`ForbiddenError\` | Nothing was sent. |
`;

const SMART_WALLET_ROW =
  '| `smart_wallet_not_deployed` | `XoError` | Call `setup()` first. |';

describe('parseErrorsPage', () => {
  test('one entry per row of a code table, with its classes and line', () => {
    const entries = parseErrorsPage(PAGE);
    expect(entries.map((e) => e.code)).toEqual([
      'smart_wallet_not_deployed',
      'http_<status>',
      'invalid_credentials',
      'policy_rejected',
    ]);
    expect(entries[0]).toMatchObject({
      line: 11,
      classes: ['XoError'],
    });
    expect(entries[1]).toMatchObject({
      classes: ['ConflictError', 'XoError'],
    });
  });

  test('finds the columns by their header, and reads no other table', () => {
    const entries = parseErrorsPage(`| What to do | Code | Class |
|:--|:-:|--:|
| Wait \\| then place again. | \`trading_paused\` | \`TradingPausedError\` |
| Two codes in one cell are not an entry. | \`a\`, \`b\` | \`XoError\` |

| \`not_in_a_table\` | \`XoError\` | The table above ended at the blank line. |

| Code | What to do |
| --- | --- |
| \`no_class_column\` | Not a code table. |
`);
    expect(entries).toEqual([
      {
        code: 'trading_paused',
        line: 3,
        classes: ['TradingPausedError'],
      },
    ]);
  });
});

describe('checkErrorsPage', () => {
  const extraction = extractErrorCodes(
    files({
      'a.ts': `import { XoError } from './core/errors';
        export const a = () => new XoError('x', { code: 'smart_wallet_not_deployed', service: 'chain' });
        export function f(error: XoError) { return error.code === 'invalid_credentials'; }
        /** The sponsor answers 403 \`policy_rejected\`. */
        export const doc = 1;`,
    }),
  );
  const source = (path: string) =>
    path === 'a.ts'
      ? '/** The sponsor answers 403 `policy_rejected`. */'
      : undefined;
  const mentioned = (code: string) =>
    (source('a.ts') ?? '').includes(`\`${code}\``);

  test('passes a page with exactly the codes of the source', () => {
    expect(
      checkErrorsPage(extraction, parseErrorsPage(PAGE), mentioned),
    ).toEqual([]);
  });

  test('fails a missing entry and a stale one', () => {
    const page = PAGE.replace(
      '| `smart_wallet_not_deployed` |',
      '| `smart_wallet_gone` |',
    );
    expect(
      checkErrorsPage(extraction, parseErrorsPage(page), mentioned),
    ).toEqual([
      expect.stringMatching(/smart_wallet_not_deployed.*no entry/),
      expect.stringMatching(
        /errors\.md:11: .*smart_wallet_gone.*not raised or named anywhere/,
      ),
    ]);
  });

  test('fails a missing service code the SDK handles by name', () => {
    const page = PAGE.replace(
      '| `invalid_credentials` |',
      '| `policy_rejected_2` |',
    );
    expect(
      checkErrorsPage(extraction, parseErrorsPage(page), mentioned),
    ).toEqual([
      expect.stringMatching(/invalid_credentials.*no entry/),
      expect.stringMatching(/policy_rejected_2.*not raised or named anywhere/),
    ]);
  });

  test('fails an entry whose classes are not the ones that raise the code', () => {
    const page = PAGE.replace(
      SMART_WALLET_ROW,
      SMART_WALLET_ROW.replace('`XoError`', '`ValidationError`'),
    );
    expect(
      checkErrorsPage(extraction, parseErrorsPage(page), mentioned),
    ).toEqual([
      expect.stringMatching(
        /smart_wallet_not_deployed.*class.*ValidationError.*XoError/,
      ),
    ]);
  });

  test('fails a code listed twice', () => {
    const page = PAGE.replace(
      SMART_WALLET_ROW,
      `${SMART_WALLET_ROW}\n${SMART_WALLET_ROW}`,
    );
    expect(
      checkErrorsPage(extraction, parseErrorsPage(page), mentioned),
    ).toEqual([
      expect.stringMatching(
        /errors\.md:12: .*smart_wallet_not_deployed.*twice \(lines 11 and 12\)/,
      ),
    ]);
  });
});
