import { existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { getAddress } from 'viem';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';
import { fileStore } from '../../src/auth/fileStore';
import {
  type BackendCredential,
  type CredentialStore,
  credentialKey,
  memoryStore,
  type StoredCredentials,
} from '../../src/auth/store';
import { UserInputError, XoError } from '../../src/core/errors';
import * as nodeEntry from '../../src/node';
import type { OrderbookCredential } from '../../src/signing/hmac';

// `open` and `rename` delegate to the real fs. They are wrapped only so a test can see
// where `fileStore` writes, watch the order of its calls and make one of them fail.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    rename: vi.fn(actual.rename),
  };
});
const realFs =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

// Obviously fake values. Nothing here is, or was ever, a real credential.
const BACKEND: BackendCredential = {
  id: 'cred-id-TESTONLY',
  key: 'xo_sk_data_TESTONLY0123456789abcdef',
  prefix: 'xo_sk_data_TESTONLY',
  scopes: ['read', 'trade'],
  expiresAt: '2030-01-01T00:00:00.000Z',
};
const ORDERBOOK: OrderbookCredential = {
  apiKey: 'TESTONLY-orderbook-api-key',
  secret: 'TESTSECRET-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  passphrase: 'TESTSECRET-passphrase',
};
const BOTH: StoredCredentials = { backend: BACKEND, orderbook: ORDERBOOK };
const SECRETS = [
  BACKEND.id,
  BACKEND.key,
  BACKEND.prefix,
  ORDERBOOK.apiKey,
  ORDERBOOK.secret,
  ORDERBOOK.passphrase,
];

const ADDR_LOWER = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const KEY = `test:${ADDR_LOWER}`;
const FILE = `test-${ADDR_LOWER}.json`;

const posix = process.platform !== 'win32';
// A root user ignores file permissions, so the EACCES tests cannot fail there.
const canDenyAccess = posix && process.getuid?.() !== 0;

const expectNoSecret = (text: string): void => {
  for (const secret of SECRETS) {
    expect(text).not.toContain(secret);
  }
};

const mode = async (path: string): Promise<number> =>
  (await stat(path)).mode & 0o777;

/** The error a promise rejects with, or `undefined` when it resolves. */
const rejectionOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

// Every console method is watched in every test: a store must never log.
const consoleMethods = [
  'log',
  'info',
  'warn',
  'error',
  'debug',
  'trace',
  'dir',
  'table',
] as const;
let spies: MockInstance[];
beforeEach(() => {
  spies = consoleMethods.map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
});
afterEach(() => {
  for (const spy of spies) {
    spy.mockRestore();
  }
});
const expectSilent = (): void => {
  for (const spy of spies) {
    expect(spy).not.toHaveBeenCalled();
  }
  expectNoSecret(JSON.stringify(spies.map((spy) => spy.mock.calls)));
};

// The message `set` throws for a value of the wrong shape. It is fixed, so it can never
// hold a part of the value.
const INVALID_VALUE =
  'value must be { backend?: BackendCredential; orderbook?: OrderbookCredential } with string fields';
// The message of every rejected key. It names the field and never repeats the key.
const INVALID_KEY = 'key must look like "<env>:<lower-case 0x address>"';

const circularScopes: unknown[] = [];
circularScopes.push(circularScopes);
const throwingGetter = Object.defineProperty({}, 'backend', {
  enumerable: true,
  get() {
    throw new Error('SECRETX-from-a-getter');
  },
});
/** Values that are not `StoredCredentials`, most of them with a secret inside. */
const MALFORMED: Array<[label: string, value: unknown]> = [
  ['undefined', undefined],
  ['null', null],
  ['a string', BACKEND.key],
  ['an array', [BOTH]],
  [
    'a number for key',
    { backend: { ...BACKEND, key: 12345 }, orderbook: ORDERBOOK },
  ],
  [
    'scopes with a non-string',
    { backend: { ...BACKEND, scopes: ['read', 5] }, orderbook: ORDERBOOK },
  ],
  [
    'a missing backend field',
    { backend: { id: BACKEND.id, key: BACKEND.key, prefix: BACKEND.prefix } },
  ],
  [
    'an orderbook without a passphrase',
    { orderbook: { apiKey: ORDERBOOK.apiKey, secret: ORDERBOOK.secret } },
  ],
  ['backend set to null', { backend: null, orderbook: ORDERBOOK }],
  ['a BigInt field', { backend: { ...BACKEND, expiresAt: 10n } }],
  [
    'scopes that hold themselves',
    { backend: { ...BACKEND, scopes: circularScopes } },
  ],
  ['a getter that throws', throwingGetter],
];
/** `BOTH` plus fields the store does not know, each holding a marker secret. */
const WITH_EXTRAS = {
  backend: { ...BACKEND, refreshToken: 'SECRETX' },
  orderbook: { ...ORDERBOOK, extra: 'SECRETX' },
  session: 'SECRETX',
} as StoredCredentials;

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'xo-store-'));
  // `mockReset` drops the call history and any queued `Once` implementation, so nothing
  // leaks from one test into the next. The real fs function is then put back.
  vi.mocked(open).mockReset().mockImplementation(realFs.open);
  vi.mocked(rename).mockReset().mockImplementation(realFs.rename);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('credentialKey', () => {
  it('joins the env name and the lower-cased address', () => {
    expect(credentialKey('test', ADDR_LOWER as `0x${string}`)).toBe(KEY);
  });

  it('accepts a checksummed or wrongly-cased address and lower-cases it', () => {
    const checksummed = getAddress(ADDR_LOWER);
    expect(checksummed).not.toBe(ADDR_LOWER);
    expect(credentialKey('test', checksummed)).toBe(KEY);
    expect(
      credentialKey('test', `0x${checksummed.slice(2).toUpperCase()}`),
    ).toBe(KEY);
  });

  it('accepts env names made of a-z, 0-9 and -', () => {
    expect(credentialKey('prod-eu-2', getAddress(ADDR_LOWER))).toBe(
      `prod-eu-2:${ADDR_LOWER}`,
    );
  });

  it.each([
    '',
    'Test',
    'test_1',
    'test:1',
    'test/1',
    '../test',
    'test.1',
    'test 1',
    'test\n',
    'tést',
  ])('rejects the env name %j', (envName) => {
    expect(() => credentialKey(envName, getAddress(ADDR_LOWER))).toThrow(
      UserInputError,
    );
  });

  it.each([
    '',
    '0x',
    '0x1234',
    ADDR_LOWER.slice(2),
    `${ADDR_LOWER}00`,
    `0x${'g'.repeat(40)}`,
  ])('rejects the address %j', (address) => {
    expect(() => credentialKey('test', address as `0x${string}`)).toThrow(
      UserInputError,
    );
  });
});

describe('memoryStore', () => {
  it('is not persistent', () => {
    expect(memoryStore().persistent).toBe(false);
  });

  it('round-trips both kinds of credential', async () => {
    const store = memoryStore();
    await store.set(KEY, BOTH);
    expect(await store.get(KEY)).toEqual(BOTH);
  });

  it('round-trips a record that holds only one kind', async () => {
    const store = memoryStore();
    await store.set('a:1', { backend: BACKEND });
    await store.set('b:2', { orderbook: ORDERBOOK });
    expect(await store.get('a:1')).toEqual({ backend: BACKEND });
    expect(await store.get('b:2')).toEqual({ orderbook: ORDERBOOK });
  });

  it('returns undefined for a key that was never set', async () => {
    expect(await memoryStore().get(KEY)).toBeUndefined();
  });

  it('overwrites a key and keeps keys apart', async () => {
    const store = memoryStore();
    await store.set(KEY, { backend: BACKEND });
    await store.set('other', { orderbook: ORDERBOOK });
    await store.set(KEY, { orderbook: ORDERBOOK });
    expect(await store.get(KEY)).toEqual({ orderbook: ORDERBOOK });
    expect(await store.get('other')).toEqual({ orderbook: ORDERBOOK });
  });

  it('deletes a key, and deleting a missing key resolves', async () => {
    const store = memoryStore();
    await store.set(KEY, BOTH);
    await store.delete(KEY);
    expect(await store.get(KEY)).toBeUndefined();
    await expect(store.delete(KEY)).resolves.toBeUndefined();
    await expect(store.delete('never-set')).resolves.toBeUndefined();
  });

  it('does not share state between instances', async () => {
    const a = memoryStore();
    const b = memoryStore();
    await a.set(KEY, BOTH);
    expect(await b.get(KEY)).toBeUndefined();
  });

  it('stores a copy: mutating the value after set changes nothing', async () => {
    const store = memoryStore();
    const value: StoredCredentials = structuredClone(BOTH);
    await store.set(KEY, value);
    if (value.backend) {
      value.backend.key = 'MUTATED';
      value.backend.scopes.push('MUTATED');
    }
    delete value.orderbook;
    expect(await store.get(KEY)).toEqual(BOTH);
  });

  it('returns a copy: mutating a result changes nothing', async () => {
    const store = memoryStore();
    await store.set(KEY, BOTH);
    const first = await store.get(KEY);
    if (first?.backend && first.orderbook) {
      first.backend.key = 'MUTATED';
      first.backend.scopes.length = 0;
      first.orderbook.secret = 'MUTATED';
    }
    delete first?.backend;
    const second = await store.get(KEY);
    expect(second).toEqual(BOTH);
    expect(second).not.toBe(first);
  });

  it('returns a new object on every get', async () => {
    const store = memoryStore();
    await store.set(KEY, BOTH);
    expect(await store.get(KEY)).not.toBe(await store.get(KEY));
  });

  describe('set checks the value', () => {
    it.each(MALFORMED)(
      'rejects %s with a fixed message and stores nothing',
      async (_label, bad) => {
        const store = memoryStore();
        await store.set(KEY, { backend: BACKEND });

        for (const key of [KEY, 'other']) {
          const error = await rejectionOf(
            store.set(key, bad as StoredCredentials),
          );
          expect(error).toBeInstanceOf(UserInputError);
          expect((error as UserInputError).message).toBe(INVALID_VALUE);
          expect((error as UserInputError).cause).toBeUndefined();
          const shown = `${inspect(error, { depth: null })}${JSON.stringify(
            (error as UserInputError).toJSON(),
          )}`;
          expectNoSecret(shown);
          expect(shown).not.toContain('SECRETX');
        }

        expect(await store.get(KEY)).toEqual({ backend: BACKEND });
        expect(await store.get('other')).toBeUndefined();
        expectSilent();
      },
    );

    it('keeps only the fields it knows', async () => {
      const store = memoryStore();
      await store.set(KEY, WITH_EXTRAS);
      const stored = await store.get(KEY);
      expect(stored).toStrictEqual(BOTH);
      expect(JSON.stringify(stored)).not.toContain('SECRETX');
    });

    it('drops a circular reference held in an unknown field', async () => {
      const store = memoryStore();
      const value = { ...BOTH, self: undefined as unknown };
      value.self = value;
      await store.set(KEY, value);
      expect(await store.get(KEY)).toStrictEqual(BOTH);
    });

    it('keeps the login-pause note, which is not a secret, next to the credentials', async () => {
      const store = memoryStore();
      const note = { atMs: 1_792_000_000_000, pauseMs: 120_000 };
      await store.set(KEY, { ...BOTH, mintPause: note });
      expect(await store.get(KEY)).toStrictEqual({ ...BOTH, mintPause: note });
      await store.set(KEY, { mintPause: note });
      expect(await store.get(KEY)).toStrictEqual({ mintPause: note });
    });

    it.each([
      ['a string time', { atMs: 'soon', pauseMs: 60_000 }],
      ['a negative pause', { atMs: 1, pauseMs: -1 }],
      ['a missing pause', { atMs: 1 }],
      ['an infinite time', { atMs: Number.POSITIVE_INFINITY, pauseMs: 1 }],
      ['null', null],
    ])(
      'drops a malformed login-pause note (%s) and keeps the credentials',
      async (_label, note) => {
        const store = memoryStore();
        await store.set(KEY, { ...BOTH, mintPause: note } as never);
        expect(await store.get(KEY)).toStrictEqual(BOTH);
      },
    );
  });
});

describe('fileStore', () => {
  const dir = () => join(root, 'creds');

  it('is persistent', () => {
    expect(fileStore(dir()).persistent).toBe(true);
  });

  it.each(['', '   ', undefined, null, 5])(
    'rejects the directory %j',
    (bad) => {
      expect(() => fileStore(bad as unknown as string)).toThrow(UserInputError);
    },
  );

  describe('round trip', () => {
    it('round-trips both kinds of credential', async () => {
      const store = fileStore(dir());
      await store.set(KEY, BOTH);
      expect(await store.get(KEY)).toEqual(BOTH);
    });

    it('survives a new store over the same directory', async () => {
      await fileStore(dir()).set(KEY, BOTH);
      expect(await fileStore(dir()).get(KEY)).toEqual(BOTH);
    });

    it('round-trips a record that holds only one kind, or none', async () => {
      const store = fileStore(dir());
      const keys = ['test', 'alpha', 'prod'].map(
        (env) => `${env}:${ADDR_LOWER}`,
      );
      const [onlyBackend, onlyOrderbook, empty] = keys as [
        string,
        string,
        string,
      ];
      await store.set(onlyBackend, { backend: BACKEND });
      await store.set(onlyOrderbook, { orderbook: ORDERBOOK });
      await store.set(empty, {});
      expect(await store.get(onlyBackend)).toEqual({ backend: BACKEND });
      expect(await store.get(onlyOrderbook)).toEqual({ orderbook: ORDERBOOK });
      expect(await store.get(empty)).toEqual({});
    });

    it('returns undefined for a key that was never set', async () => {
      const store = fileStore(dir());
      expect(await store.get(KEY)).toBeUndefined();
      await store.set(`prod:${ADDR_LOWER}`, BOTH);
      expect(await store.get(KEY)).toBeUndefined();
    });

    it('overwrites the previous value', async () => {
      const store = fileStore(dir());
      await store.set(KEY, BOTH);
      await store.set(KEY, { orderbook: ORDERBOOK });
      expect(await store.get(KEY)).toEqual({ orderbook: ORDERBOOK });
    });

    it('returns a new object on every get', async () => {
      const store = fileStore(dir());
      await store.set(KEY, BOTH);
      expect(await store.get(KEY)).not.toBe(await store.get(KEY));
    });

    it('works with a key built by credentialKey', async () => {
      const store = fileStore(dir());
      const key = credentialKey('test', getAddress(ADDR_LOWER));
      await store.set(key, BOTH);
      expect(await store.get(key)).toEqual(BOTH);
      expect(await readdir(dir())).toEqual([FILE]);
    });

    it('ignores fields it does not know', async () => {
      await mkdir(dir());
      await writeFile(
        join(dir(), FILE),
        JSON.stringify({ ...BOTH, future: { a: 1 } }),
      );
      expect(await fileStore(dir()).get(KEY)).toEqual(BOTH);
    });

    it('round-trips the login-pause note across stores over the same directory', async () => {
      const note = { atMs: 1_792_000_000_000, pauseMs: 60_000 };
      await fileStore(dir()).set(KEY, { ...BOTH, mintPause: note });
      expect(await fileStore(dir()).get(KEY)).toStrictEqual({
        ...BOTH,
        mintPause: note,
      });
    });

    it('reads a file written before the login-pause note existed', async () => {
      await mkdir(dir());
      await writeFile(join(dir(), FILE), JSON.stringify(BOTH));
      expect(await fileStore(dir()).get(KEY)).toStrictEqual(BOTH);
    });

    it('a malformed login-pause note in the file is dropped and the credentials kept', async () => {
      await mkdir(dir());
      await writeFile(
        join(dir(), FILE),
        JSON.stringify({ ...BOTH, mintPause: { atMs: 'soon', pauseMs: [] } }),
      );
      expect(await fileStore(dir()).get(KEY)).toStrictEqual(BOTH);
    });
  });

  describe('delete', () => {
    it('removes the value', async () => {
      const store = fileStore(dir());
      await store.set(KEY, BOTH);
      await store.delete(KEY);
      expect(await store.get(KEY)).toBeUndefined();
      expect(await readdir(dir())).toEqual([]);
    });

    it('leaves other keys alone', async () => {
      const store = fileStore(dir());
      const other = `prod:${ADDR_LOWER}`;
      await store.set(KEY, BOTH);
      await store.set(other, { backend: BACKEND });
      await store.delete(KEY);
      expect(await store.get(other)).toEqual({ backend: BACKEND });
    });

    it('resolves for a missing key and for a missing directory', async () => {
      const store = fileStore(dir());
      await expect(store.delete(KEY)).resolves.toBeUndefined();
      await store.set(KEY, BOTH);
      await expect(store.delete(`prod:${ADDR_LOWER}`)).resolves.toBeUndefined();
      await store.delete(KEY);
      await expect(store.delete(KEY)).resolves.toBeUndefined();
    });
  });

  describe('file names', () => {
    it('maps <env>:<address> to <env>-<address>.json, with no colon', async () => {
      const store = fileStore(dir());
      await store.set(KEY, BOTH);
      const names = await readdir(dir());
      expect(names).toEqual([FILE]);
      expect(names.join('')).not.toContain(':');
    });

    it('keeps env names with a hyphen apart', async () => {
      const store = fileStore(dir());
      await store.set(`a-b:${ADDR_LOWER}`, { backend: BACKEND });
      await store.set(`a:${ADDR_LOWER}`, { orderbook: ORDERBOOK });
      expect((await readdir(dir())).sort()).toEqual([
        `a-${ADDR_LOWER}.json`,
        `a-b-${ADDR_LOWER}.json`,
      ]);
      expect(await store.get(`a-b:${ADDR_LOWER}`)).toEqual({
        backend: BACKEND,
      });
      expect(await store.get(`a:${ADDR_LOWER}`)).toEqual({
        orderbook: ORDERBOOK,
      });
    });

    const addr = ADDR_LOWER;
    const CHECKSUMMED = getAddress(ADDR_LOWER);
    it.each([
      ['empty', ''],
      ['no colon', `test-${addr}`],
      ['no env', `:${addr}`],
      ['no address', 'test:'],
      ['uppercase env', `Test:${addr}`],
      ['checksummed address', `test:${CHECKSUMMED}`],
      ['uppercase hex digits', `test:0x${addr.slice(2).toUpperCase()}`],
      ['uppercase 0X', `test:0X${addr.slice(2)}`],
      ['short address', 'test:0x1234'],
      ['long address', `test:${addr}00`],
      ['non-hex address', `test:0x${'g'.repeat(40)}`],
      ['second colon', `test:x:${addr}`],
      ['parent traversal', `../evil:${addr}`],
      ['parent in env', `test/../evil:${addr}`],
      ['slash in env', `test/evil:${addr}`],
      ['backslash in env', `test\\evil:${addr}`],
      ['traversal in address', `test:${addr}/../../evil`],
      ['dot in env', `te.st:${addr}`],
      ['absolute path', `/etc/evil:${addr}`],
      ['trailing newline', `test:${addr}\n`],
      ['leading newline', `\ntest:${addr}`],
      ['NUL byte', `test\0:${addr}`],
      ['underscore in env', `te_st:${addr}`],
    ])('rejects a key with %s', async (_label, key) => {
      const store = fileStore(dir());
      const rejects = async (promise: Promise<unknown>) => {
        const error = await rejectionOf(promise);
        expect(error).toBeInstanceOf(UserInputError);
        // The exact fixed text, so it cannot repeat any part of the key.
        expect((error as UserInputError).message).toBe(INVALID_KEY);
      };
      await rejects(store.get(key));
      await rejects(store.set(key, BOTH));
      await rejects(store.delete(key));
      // Rejected before any fs call: nothing was created, in or outside the directory.
      expect(await readdir(root)).toEqual([]);
    });

    it('rejects a key that is not a string', async () => {
      const store = fileStore(dir());
      await expect(store.get(undefined as unknown as string)).rejects.toThrow(
        UserInputError,
      );
      await expect(
        store.set({ toString: () => KEY } as unknown as string, BOTH),
      ).rejects.toThrow(UserInputError);
    });
  });

  describe('permissions', () => {
    it.skipIf(!posix)('writes the file with mode 0o600', async () => {
      const store = fileStore(dir());
      await store.set(KEY, BOTH);
      expect(await mode(join(dir(), FILE))).toBe(0o600);
    });

    it.skipIf(!posix)('keeps mode 0o600 when it overwrites', async () => {
      const store = fileStore(dir());
      await store.set(KEY, BOTH);
      await chmod(join(dir(), FILE), 0o644);
      await store.set(KEY, { backend: BACKEND });
      expect(await mode(join(dir(), FILE))).toBe(0o600);
    });

    it.skipIf(!posix)('creates a new directory with mode 0o700', async () => {
      const nested = join(root, 'a', 'b', 'creds');
      await fileStore(nested).set(KEY, BOTH);
      expect(await mode(nested)).toBe(0o700);
      expect(await readdir(nested)).toEqual([FILE]);
    });

    it.skipIf(!posix)('does not chmod a directory that exists', async () => {
      await mkdir(dir(), { mode: 0o750 });
      await chmod(dir(), 0o750);
      await fileStore(dir()).set(KEY, BOTH);
      expect(await mode(dir())).toBe(0o750);
    });
  });

  describe('set checks the value', () => {
    it.each(MALFORMED)(
      'rejects %s with a fixed message, before any fs call',
      async (_label, bad) => {
        const store = fileStore(dir());

        const error = await rejectionOf(
          store.set(KEY, bad as StoredCredentials),
        );

        expect(error).toBeInstanceOf(UserInputError);
        expect(error).not.toHaveProperty(
          'code',
          'credential_store_unavailable',
        );
        expect((error as UserInputError).message).toBe(INVALID_VALUE);
        expect((error as UserInputError).cause).toBeUndefined();
        const shown = `${inspect(error, { depth: null })}${JSON.stringify(
          (error as UserInputError).toJSON(),
        )}`;
        expectNoSecret(shown);
        expect(shown).not.toContain('SECRETX');
        expect(vi.mocked(open)).not.toHaveBeenCalled();
        expect(vi.mocked(rename)).not.toHaveBeenCalled();
        // Not even the directory was created.
        expect(await readdir(root)).toEqual([]);
        expectSilent();
      },
    );

    it('keeps the old value when a later set is rejected', async () => {
      const store = fileStore(dir());
      await store.set(KEY, { backend: BACKEND });
      await expect(
        store.set(KEY, { backend: { ...BACKEND, key: 5 } } as never),
      ).rejects.toThrow(UserInputError);
      expect(await store.get(KEY)).toEqual({ backend: BACKEND });
      expect(await readdir(dir())).toEqual([FILE]);
    });

    it('persists only the fields it knows', async () => {
      const store = fileStore(dir());
      await store.set(KEY, WITH_EXTRAS);
      const raw = await readFile(join(dir(), FILE), 'utf8');
      expect(raw).not.toContain('SECRETX');
      expect(raw).not.toContain('refreshToken');
      expect(JSON.parse(raw)).toStrictEqual(BOTH);
      expect(await store.get(KEY)).toStrictEqual(BOTH);
    });

    it('drops a circular reference held in an unknown field', async () => {
      const store = fileStore(dir());
      const value = { ...BOTH, self: undefined as unknown };
      value.self = value;
      await store.set(KEY, value);
      expect(await store.get(KEY)).toStrictEqual(BOTH);
    });

    it('does not keep a reference to the value it was given', async () => {
      const store = fileStore(dir());
      const value = structuredClone(BOTH);
      await store.set(KEY, value);
      value.backend?.scopes.push('MUTATED');
      expect(await store.get(KEY)).toEqual(BOTH);
    });
  });

  // These rely on POSIX rename and file-mode semantics.
  describe.skipIf(!posix)('atomic writes', () => {
    type Step = 'writeFile' | 'sync' | 'close';

    /**
     * Makes the next `open` return the real file handle with its `writeFile`, `sync` and
     * `close` recorded in `calls`. When `failAt` is set, that step runs for real and then
     * throws an error with the given errno.
     */
    function watchNextOpen(
      calls: string[],
      failAt?: { step: Step; code: string },
    ): void {
      vi.mocked(open).mockImplementationOnce((async (
        ...args: Parameters<typeof realFs.open>
      ) => {
        const handle = await realFs.open(...args);
        calls.push('open');
        for (const step of ['writeFile', 'sync', 'close'] as const) {
          const original = handle[step].bind(handle) as (
            ...a: unknown[]
          ) => Promise<void>;
          (handle as unknown as Record<Step, unknown>)[step] = async (
            ...a: unknown[]
          ) => {
            calls.push(step);
            const result = await original(...a);
            if (failAt?.step === step) {
              throw Object.assign(new Error(`${failAt.code}: ${args[0]}`), {
                code: failAt.code,
              });
            }
            return result;
          };
        }
        return handle;
      }) as typeof realFs.open);
    }

    function watchNextRename(calls: string[]): void {
      vi.mocked(rename).mockImplementationOnce(async (from, to) => {
        calls.push('rename');
        return realFs.rename(from, to);
      });
    }

    it('writes a unique tmp file in the same directory, then renames it over the target', async () => {
      const store = fileStore(dir());
      await store.set(KEY, BOTH);
      const target = join(dir(), FILE);

      expect(vi.mocked(open)).toHaveBeenCalledTimes(1);
      const [tmpPath, flags, fileMode] = vi.mocked(open).mock.calls[0] ?? [];
      expect(dirname(String(tmpPath))).toBe(dir());
      expect(String(tmpPath)).not.toBe(target);
      expect(String(tmpPath).slice(dir().length + 1)).toMatch(
        new RegExp(`^\\.${FILE}\\.[0-9a-f-]{36}\\.tmp$`),
      );
      // `wx` fails if the tmp file exists; the mode is set at creation.
      expect(flags).toBe('wx');
      expect(fileMode).toBe(0o600);
      expect(vi.mocked(rename)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(rename)).toHaveBeenCalledWith(tmpPath, target);
    });

    it('flushes the tmp file to disk before the rename', async () => {
      const store = fileStore(dir());
      const calls: string[] = [];
      watchNextOpen(calls);
      watchNextRename(calls);

      await store.set(KEY, BOTH);

      expect(calls).toEqual(['open', 'writeFile', 'sync', 'close', 'rename']);
      expect(await store.get(KEY)).toEqual(BOTH);
    });

    it('uses a different tmp file for every write', async () => {
      const store = fileStore(dir());
      await store.set(KEY, BOTH);
      await store.set(KEY, { backend: BACKEND });
      const [first, second] = vi
        .mocked(open)
        .mock.calls.map(([path]) => String(path));
      expect(first).not.toBe(second);
    });

    it('replaces the old value and leaves no tmp file behind', async () => {
      const store = fileStore(dir());
      await store.set(KEY, { backend: BACKEND });
      await store.set(KEY, { orderbook: ORDERBOOK });
      expect(await store.get(KEY)).toEqual({ orderbook: ORDERBOOK });
      expect(await readdir(dir())).toEqual([FILE]);
      await store.delete(KEY);
      expect(await readdir(dir())).toEqual([]);
    });

    it('keeps the old value and removes the tmp file when the rename fails', async () => {
      const store = fileStore(dir());
      await store.set(KEY, { backend: BACKEND });
      vi.mocked(rename).mockRejectedValueOnce(
        Object.assign(
          new Error(`EXDEV: cross-device link, rename '${dir()}'`),
          { code: 'EXDEV' },
        ),
      );

      const error = await rejectionOf(store.set(KEY, { orderbook: ORDERBOOK }));

      expect(error).toBeInstanceOf(XoError);
      expect((error as XoError).code).toBe('credential_store_unavailable');
      expect((error as XoError).message).toBe(
        'credential store unavailable: write failed (EXDEV)',
      );
      expect(await readdir(dir())).toEqual([FILE]);
      expect(await store.get(KEY)).toEqual({ backend: BACKEND });
    });

    it.each([
      ['writeFile', 'ENOSPC', ['open', 'writeFile', 'close']],
      ['sync', 'EIO', ['open', 'writeFile', 'sync', 'close']],
    ] as const)(
      'closes the handle, removes the tmp file and keeps the old value when %s fails',
      async (step, code, expectedCalls) => {
        const store = fileStore(dir());
        await store.set(KEY, { backend: BACKEND });
        const calls: string[] = [];
        watchNextOpen(calls, { step, code });
        watchNextRename(calls);

        const error = await rejectionOf(
          store.set(KEY, { orderbook: ORDERBOOK }),
        );

        expect(error).toBeInstanceOf(XoError);
        expect((error as XoError).code).toBe('credential_store_unavailable');
        expect((error as XoError).message).toBe(
          `credential store unavailable: write failed (${code})`,
        );
        // The handle is closed and the rename never happens.
        expect(calls).toEqual(expectedCalls);
        expect(await readdir(dir())).toEqual([FILE]);
        expect(await store.get(KEY)).toEqual({ backend: BACKEND });
      },
    );

    it.each([2, 16])(
      'ends with one of the values when %i sets run at once',
      async (count) => {
        const store = fileStore(dir());
        const values = Array.from(
          { length: count },
          (_, i): StoredCredentials => ({
            backend: { ...BACKEND, id: `writer-${i}`, scopes: [`scope-${i}`] },
            orderbook: { ...ORDERBOOK, passphrase: `TESTSECRET-writer-${i}` },
          }),
        );

        await Promise.all(values.map((value) => store.set(KEY, value)));

        const result = await store.get(KEY);
        expect(result).toBeDefined();
        expect(values).toContainEqual(result);
        expect(await readdir(dir())).toEqual([FILE]);
        // The file on disk is valid JSON that holds exactly one of the values.
        const onDisk = JSON.parse(await readFile(join(dir(), FILE), 'utf8'));
        expect(values).toContainEqual(onDisk);
      },
    );

    it('never lets a reader see a partial write', async () => {
      const store = fileStore(dir());
      // Large values make a non-atomic write likely to show a torn file.
      const big = (tag: string): StoredCredentials => ({
        backend: {
          ...BACKEND,
          id: tag,
          scopes: Array.from({ length: 4000 }, (_, i) => `${tag}-${i}`),
        },
      });
      await store.set(KEY, big('seed'));

      let writing = true;
      const writer = (async () => {
        for (let i = 0; i < 40; i++) {
          await store.set(KEY, big(`w${i}`));
        }
        writing = false;
      })();
      const seen: Array<StoredCredentials | undefined> = [];
      const reader = (async () => {
        while (writing) {
          seen.push(await store.get(KEY));
        }
      })();
      await Promise.all([writer, reader]);

      expect(seen.length).toBeGreaterThan(0);
      // `undefined` here would mean the reader saw an unfinished file.
      expect(seen.filter((value) => value === undefined)).toHaveLength(0);
      expect(await readdir(dir())).toEqual([FILE]);
    });
  });

  describe('stale tmp files', () => {
    const STALE_ID = '11111111-1111-4111-8111-111111111111';
    const FRESH_ID = '22222222-2222-4222-8222-222222222222';
    const tmpFor = (file: string, id: string) => `.${file}.${id}.tmp`;

    /** Creates `dir()/name` holding a marker and sets its mtime `ageMs` in the past. */
    async function plant(name: string, ageMs: number): Promise<void> {
      await mkdir(dir(), { recursive: true });
      const path = join(dir(), name);
      await writeFile(path, 'TESTSECRET-partial');
      const when = new Date(Date.now() - ageMs);
      await utimes(path, when, when);
    }

    it('delete removes a stale tmp file of its key and keeps a fresh one', async () => {
      const other = `prod-${ADDR_LOWER}.json`;
      await plant(tmpFor(FILE, STALE_ID), 10 * 60_000);
      await plant(tmpFor(FILE, FRESH_ID), 5_000);
      // Not this key's, or not a tmp name: both are left alone however old they are.
      await plant(tmpFor(other, STALE_ID), 10 * 60_000);
      await plant(`.${FILE}.not-a-uuid.tmp`, 10 * 60_000);
      await plant(`.${FILE}.${STALE_ID}.bak`, 10 * 60_000);
      const store = fileStore(dir());

      // There is no value for the key: the sweep still runs.
      await expect(store.delete(KEY)).resolves.toBeUndefined();

      expect((await readdir(dir())).sort()).toEqual(
        [
          tmpFor(FILE, FRESH_ID),
          tmpFor(other, STALE_ID),
          `.${FILE}.not-a-uuid.tmp`,
          `.${FILE}.${STALE_ID}.bak`,
        ].sort(),
      );
      expectSilent();
    });

    it('delete also sweeps after it removes a value', async () => {
      const store = fileStore(dir());
      await store.set(KEY, BOTH);
      await plant(tmpFor(FILE, STALE_ID), 10 * 60_000);
      await store.delete(KEY);
      expect(await readdir(dir())).toEqual([]);
    });

    it('set removes a stale tmp file of its key, keeps a fresh one, and keeps the new value', async () => {
      await plant(tmpFor(FILE, STALE_ID), 10 * 60_000);
      await plant(tmpFor(FILE, FRESH_ID), 5_000);
      const store = fileStore(dir());

      await store.set(KEY, BOTH);

      expect((await readdir(dir())).sort()).toEqual(
        [FILE, tmpFor(FILE, FRESH_ID)].sort(),
      );
      expect(await store.get(KEY)).toEqual(BOTH);
      expectSilent();
    });

    it('does not sweep when get is called', async () => {
      await plant(tmpFor(FILE, STALE_ID), 10 * 60_000);
      await fileStore(dir()).get(KEY);
      expect(await readdir(dir())).toEqual([tmpFor(FILE, STALE_ID)]);
    });

    it.skipIf(!posix)(
      'ignores a stale entry it cannot remove, without an error or a log',
      async () => {
        // A directory with a tmp name: `unlink` fails on it (EISDIR or EPERM).
        const name = tmpFor(FILE, STALE_ID);
        await mkdir(join(dir(), name), { recursive: true });
        const when = new Date(Date.now() - 10 * 60_000);
        await utimes(join(dir(), name), when, when);
        const store = fileStore(dir());

        await expect(store.set(KEY, BOTH)).resolves.toBeUndefined();
        await expect(store.delete(KEY)).resolves.toBeUndefined();

        expect(await readdir(dir())).toEqual([name]);
        expectSilent();
      },
    );
  });

  describe.skipIf(!posix)('a symlink at the target', () => {
    const victim = () => join(root, 'victim.json');
    const link = () => join(dir(), FILE);

    it.each([
      ['an existing file', true],
      ['a missing file', false],
    ])(
      'set replaces a link to %s and leaves the link target alone',
      async (_label, exists) => {
        await mkdir(dir());
        if (exists) {
          await writeFile(victim(), 'VICTIM');
        }
        await symlink(victim(), link());
        const store = fileStore(dir());

        await store.set(KEY, BOTH);

        expect((await lstat(link())).isSymbolicLink()).toBe(false);
        expect(await readFile(link(), 'utf8')).toContain('xo_sk_data_TESTONLY');
        if (exists) {
          expect(await readFile(victim(), 'utf8')).toBe('VICTIM');
        } else {
          await expect(lstat(victim())).rejects.toMatchObject({
            code: 'ENOENT',
          });
        }
        expect(await store.get(KEY)).toEqual(BOTH);
        expect(await readdir(dir())).toEqual([FILE]);
      },
    );

    it('delete removes only the link', async () => {
      await mkdir(dir());
      await writeFile(victim(), 'VICTIM');
      await symlink(victim(), link());
      const store = fileStore(dir());

      await store.delete(KEY);

      expect(await readdir(dir())).toEqual([]);
      expect(await readFile(victim(), 'utf8')).toBe('VICTIM');
    });
  });

  describe('files it cannot use', () => {
    const valid = JSON.stringify(BOTH);
    it.each([
      ['not JSON', 'xo_sk_data_TESTONLY TESTSECRET not json {{{'],
      ['truncated JSON', valid.slice(0, Math.floor(valid.length * 0.8))],
      ['an empty file', ''],
      ['whitespace only', '  \n'],
      ['JSON null', 'null'],
      ['a JSON string', JSON.stringify(BACKEND.key)],
      ['a JSON array', JSON.stringify([BOTH])],
      [
        'a wrong type for key',
        JSON.stringify({
          backend: { ...BACKEND, key: 12345 },
          orderbook: ORDERBOOK,
        }),
      ],
      [
        'a missing backend field',
        JSON.stringify({
          backend: { id: BACKEND.id, key: BACKEND.key, prefix: BACKEND.prefix },
        }),
      ],
      [
        'scopes that are not strings',
        JSON.stringify({ backend: { ...BACKEND, scopes: [1, 2] } }),
      ],
      [
        'an orderbook without a passphrase',
        JSON.stringify({
          orderbook: { apiKey: ORDERBOOK.apiKey, secret: ORDERBOOK.secret },
        }),
      ],
      ['backend set to null', JSON.stringify({ backend: null })],
      ['a BOM before the JSON', `﻿${valid}`],
    ])(
      'returns undefined for %s, leaves it in place and stays silent',
      async (_label, content) => {
        await mkdir(dir());
        const path = join(dir(), FILE);
        await writeFile(path, content);
        const store = fileStore(dir());

        await expect(store.get(KEY)).resolves.toBeUndefined();

        expect(await readFile(path, 'utf8')).toBe(content);
        expect(await readdir(dir())).toEqual([FILE]);
        expectSilent();
        expectNoSecret(JSON.stringify(spies.map((spy) => spy.mock.calls)));

        // The next set replaces the unusable file.
        await store.set(KEY, BOTH);
        expect(await store.get(KEY)).toEqual(BOTH);
        expect(await readdir(dir())).toEqual([FILE]);
        expectSilent();
      },
    );

    it('treats a bad file as missing for one key only', async () => {
      const store = fileStore(dir());
      await store.set(KEY, BOTH);
      const otherKey = `prod:${ADDR_LOWER}`;
      await writeFile(join(dir(), `prod-${ADDR_LOWER}.json`), '{{{');
      expect(await store.get(otherKey)).toBeUndefined();
      expect(await store.get(KEY)).toEqual(BOTH);
    });

    it.skipIf(!canDenyAccess)(
      'rethrows an unreadable file as credential_store_unavailable, naming only the error code',
      async () => {
        const store = fileStore(dir());
        await store.set(KEY, BOTH);
        const path = join(dir(), FILE);
        await chmod(path, 0o000);

        const error = await store.get(KEY).then(
          () => undefined,
          (e: unknown) => e,
        );
        await chmod(path, 0o600);

        expect(error).toBeInstanceOf(XoError);
        const xo = error as XoError;
        expect(xo.code).toBe('credential_store_unavailable');
        expect(xo.service).toBe('sdk');
        expect(xo.message).toBe(
          'credential store unavailable: read failed (EACCES)',
        );
        expect(xo.cause).toBeUndefined();
        for (const text of [
          xo.message,
          xo.stack ?? '',
          JSON.stringify(xo.toJSON()),
          inspect(xo, { depth: null, showHidden: true }),
        ]) {
          expectNoSecret(text);
          expect(text).not.toContain(root);
          expect(text).not.toContain(ADDR_LOWER);
        }
        expectSilent();
      },
    );

    it.skipIf(!canDenyAccess)(
      'rethrows a write into a read-only directory as credential_store_unavailable',
      async () => {
        const store = fileStore(dir());
        await store.set(KEY, { backend: BACKEND });
        await chmod(dir(), 0o500);

        const error = await store.set(KEY, BOTH).then(
          () => undefined,
          (e: unknown) => e,
        );
        await chmod(dir(), 0o700);

        expect(error).toBeInstanceOf(XoError);
        expect((error as XoError).code).toBe('credential_store_unavailable');
        expect((error as XoError).message).toBe(
          'credential store unavailable: write failed (EACCES)',
        );
        expect((error as XoError).cause).toBeUndefined();
        expect(await readdir(dir())).toEqual([FILE]);
        expect(await store.get(KEY)).toEqual({ backend: BACKEND });
        expectSilent();
      },
    );

    /** Runs get, set and delete on `store` and returns the error each one threw. */
    async function allFail(store: CredentialStore) {
      const runs: Array<[op: string, run: () => Promise<unknown>]> = [
        ['read', () => store.get(KEY)],
        ['write', () => store.set(KEY, BOTH)],
        ['delete', () => store.delete(KEY)],
      ];
      return Promise.all(
        runs.map(async ([op, run]) => ({
          op,
          error: (await rejectionOf(run())) as XoError,
        })),
      );
    }

    function expectUnavailable(
      failures: Awaited<ReturnType<typeof allFail>>,
    ): void {
      expect(failures).toHaveLength(3);
      for (const { error, op } of failures) {
        expect(error).toBeInstanceOf(XoError);
        expect(error).not.toBeInstanceOf(UserInputError);
        expect(error.code).toBe('credential_store_unavailable');
        expect(error.message).toMatch(
          new RegExp(
            `^credential store unavailable: ${op} failed \\([A-Z]+\\)$`,
          ),
        );
        expect(error.message).not.toContain(root);
        expect(error.cause).toBeUndefined();
      }
    }

    it.skipIf(!posix)(
      'reports every operation as credential_store_unavailable when the path runs through a file',
      async () => {
        // `blocker` is a regular file, so nothing can live below it (ENOTDIR).
        const blocker = join(root, 'blocker');
        await writeFile(blocker, 'x');

        expectUnavailable(await allFail(fileStore(join(blocker, 'sub'))));

        expect(await readFile(blocker, 'utf8')).toBe('x');
        expect(await readdir(root)).toEqual(['blocker']);
        expectSilent();
      },
    );

    it.skipIf(!posix)(
      'reports every operation as credential_store_unavailable when dir itself is a file',
      async () => {
        const file = join(root, 'not-a-dir');
        await writeFile(file, 'x');

        expectUnavailable(await allFail(fileStore(file)));

        expect(await readFile(file, 'utf8')).toBe('x');
        expect(await readdir(root)).toEqual(['not-a-dir']);
        expectSilent();
      },
    );
  });

  describe('dir', () => {
    it('is resolved once, when the store is created', async () => {
      const before = process.cwd();
      let store: CredentialStore;
      process.chdir(root);
      try {
        store = fileStore('relative-creds');
      } finally {
        process.chdir(before);
      }

      // The working directory has changed back, but the store still writes under `root`.
      await store.set(KEY, BOTH);

      expect(await readdir(join(root, 'relative-creds'))).toEqual([FILE]);
      expect(await store.get(KEY)).toEqual(BOTH);
      expect(process.cwd()).toBe(before);
    });
  });
});

// A bundler can only keep `node:` out of the main entry if no module it reaches imports
// a Node builtin. This reads the source and follows relative imports.
describe('runtime boundary', () => {
  const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
  const IMPORT = /\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
  const BUILTINS = new Set(builtinModules);

  const isBuiltin = (specifier: string): boolean =>
    specifier.startsWith('node:') ||
    BUILTINS.has(specifier) ||
    BUILTINS.has(specifier.split('/')[0] ?? '');

  /** Every source file reachable from `entry` through relative imports, and every specifier seen. */
  function graph(entry: string): { files: string[]; specifiers: string[] } {
    const files = new Set<string>();
    const specifiers = new Set<string>();
    const visit = (file: string): void => {
      if (files.has(file)) {
        return;
      }
      files.add(file);
      for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
        const specifier = match[1] as string;
        specifiers.add(specifier);
        if (specifier.startsWith('.') && specifier.endsWith('.json')) {
          // A JSON import (the package version) imports nothing: a leaf.
          const json = resolve(dirname(file), specifier);
          if (!existsSync(json)) {
            throw new Error(`cannot resolve ${specifier} from ${file}`);
          }
          files.add(json);
        } else if (specifier.startsWith('.')) {
          const base = resolve(dirname(file), specifier);
          const next = [`${base}.ts`, join(base, 'index.ts')].find(existsSync);
          if (next === undefined) {
            throw new Error(`cannot resolve ${specifier} from ${file}`);
          }
          visit(next);
        }
      }
    };
    visit(entry);
    return { files: [...files], specifiers: [...specifiers] };
  }

  it('sees a node: import when there is one (the scan is not vacuous)', () => {
    const { files, specifiers } = graph(join(SRC, 'node.ts'));
    expect(files).toContain(join(SRC, 'auth/fileStore.ts'));
    expect(specifiers).toContain('node:fs/promises');
    expect(specifiers.filter(isBuiltin).length).toBeGreaterThan(0);
  });

  it('has no node: import in src/auth/store.ts or anything it reaches', () => {
    const { files, specifiers } = graph(join(SRC, 'auth/store.ts'));
    expect(files).not.toContain(join(SRC, 'auth/fileStore.ts'));
    expect(specifiers.filter(isBuiltin)).toEqual([]);
  });

  it('has no node: import in src/index.ts or anything it reaches', () => {
    const { files, specifiers } = graph(join(SRC, 'index.ts'));
    expect(files).not.toContain(join(SRC, 'auth/fileStore.ts'));
    expect(specifiers.filter(isBuiltin)).toEqual([]);
  });

  it('reaches both clients from src/index.ts (the scan is not vacuous)', () => {
    const { files } = graph(join(SRC, 'index.ts'));
    for (const reached of [
      'clients/public.ts',
      'clients/secure.ts',
      'actions/subscriptions.ts',
      'core/shutdown.ts',
      'clients/lifecycle.ts',
      'clients/rail.ts',
      'account/rails.ts',
      'realtime/socketio.ts',
    ]) {
      expect(files).toContain(join(SRC, reached));
    }
  });

  it('never reaches src/node.ts from the universal entries', () => {
    for (const entry of ['index.ts', 'signing/index.ts']) {
      const { files, specifiers } = graph(join(SRC, entry));
      expect(files).not.toContain(join(SRC, 'node.ts'));
      expect(files).not.toContain(join(SRC, 'auth/fileStore.ts'));
      expect(specifiers.filter(isBuiltin)).toEqual([]);
    }
  });

  it('names no NodeJS type anywhere in the universal graph', () => {
    const { files } = graph(join(SRC, 'index.ts'));
    const sources = files.filter((file) => file.endsWith('.ts'));
    expect(sources.length).toBeGreaterThan(50);
    for (const file of sources) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\bNodeJS\./);
    }
  });

  it('has no node: import anywhere in src/core', () => {
    const core = readdirSync(join(SRC, 'core')).filter((n) =>
      n.endsWith('.ts'),
    );
    expect(core.length).toBeGreaterThan(0);
    for (const name of core) {
      const { files, specifiers } = graph(join(SRC, 'core', name));
      expect(files).not.toContain(join(SRC, 'auth/fileStore.ts'));
      expect(specifiers.filter(isBuiltin)).toEqual([]);
    }
  });

  it('exports fileStore from the node entry only', () => {
    expect(nodeEntry.fileStore).toBe(fileStore);
    const mainSource = readFileSync(join(SRC, 'index.ts'), 'utf8');
    expect(mainSource).not.toContain('fileStore');
    expect(Object.keys(nodeEntry)).toContain('installShutdownHooks');
  });
});
