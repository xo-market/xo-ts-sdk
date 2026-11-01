import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  ALLOWED_VALUES,
  comparePinned,
  declaredExports,
  packageEntries,
  pinnedEntryOf,
  readPinnedLists,
  scanDeclarations,
} from '../../scripts/check-dts.mjs';

// The post-build declaration scan of `check:package`, on small declaration files that
// look like the bundler's output: an entry, and a chunk it imports from.

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function dist(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'xo-check-dts-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(dir, name), text);
  }
  return dir;
}

const CHUNK = `interface Deep { d: string }
interface Chunked { deep: Deep }
export { Chunked as t, Deep as u };
`;

describe('check-dts', () => {
  test('reports every reachable declaration the entry does not export', async () => {
    const dir = await dist({
      'chunk.d.ts': CHUNK,
      'index.d.ts': `import { t as Chunked } from "./chunk.js";
interface Hidden { a: string }
interface Inferred { n: number }
export interface Shown { h: Hidden; c: Chunked }
export declare function inferred(): Inferred;
declare const ORDER_REJECTION_CODES: readonly ['a', 'b'];
export type Code = (typeof ORDER_REJECTION_CODES)[number];
declare const SECRET_LIST: readonly ['x'];
export type Other = (typeof SECRET_LIST)[number];
export interface Box<T> { value: T }
export type { Chunked };
`,
    });
    const { problems, allowedSeen } = scanDeclarations(
      [join(dir, 'index.d.ts')],
      dir,
    );
    const names = problems.map((p) => p.split(': ')[1]?.split(' ')[0]).sort();
    // A hidden member type, an inferred return type, a chunk-internal type, a value tuple
    // that is not allowed. Not `T`, and not the allowed ORDER_REJECTION_CODES.
    expect(names).toEqual(['Deep', 'Hidden', 'Inferred', 'SECRET_LIST']);
    expect([...allowedSeen]).toEqual(['ORDER_REJECTION_CODES']);
  });

  test('a closed entry has no problem', async () => {
    const dir = await dist({
      'chunk.d.ts': CHUNK,
      'index.d.ts': `import { t as Chunked, u as Deep } from "./chunk.js";
export interface Shown { c: Chunked }
export type { Chunked, Deep };
`,
    });
    expect(scanDeclarations([join(dir, 'index.d.ts')], dir).problems).toEqual(
      [],
    );
  });

  test('a renamed clash (X$1) is matched to the allowlist by its source name', async () => {
    const dir = await dist({
      // An export list, as the bundler writes: without one, a .d.ts exports every declaration.
      'index.d.ts': `declare const ACTIVITY_TYPES$1: readonly ['a'];
type Key = (typeof ACTIVITY_TYPES$1)[number];
export type { Key };
`,
    });
    const { problems, allowedSeen } = scanDeclarations(
      [join(dir, 'index.d.ts')],
      dir,
    );
    expect(problems).toEqual([]);
    expect([...allowedSeen]).toEqual(['ACTIVITY_TYPES']);
  });

  test('a member of an exported enum, used as a type, is reached through its enum', async () => {
    const dir = await dist({
      'index.d.ts': `declare enum Side { BUY = 'BUY', SELL = 'SELL' }
declare enum Hidden { A = 'A' }
type Buy = { side: Side.BUY };
type Other = { kind: Hidden.A };
export type { Buy, Other };
export { Side };
`,
    });
    const { problems } = scanDeclarations([join(dir, 'index.d.ts')], dir);
    // Not BUY: Side is exported. Hidden is not, and it is what the problem names.
    expect(problems.map((p) => p.split(': ')[1]?.split(' ')[0])).toEqual([
      'Hidden',
    ]);
  });

  test('an entry without an export list is a problem (it would make everything public)', async () => {
    const dir = await dist({
      'index.d.ts':
        'interface Hidden { a: string }\nexport interface Shown { h: Hidden }\n',
    });
    const { problems } = scanDeclarations([join(dir, 'index.d.ts')], dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no export list');
  });

  test('covers the eight published declaration entries and the two tuple names', () => {
    expect(packageEntries('/d').map((p) => p.slice(3))).toEqual([
      'index.d.ts',
      'index.d.cts',
      'node.d.ts',
      'node.d.cts',
      'signing/index.d.ts',
      'signing/index.d.cts',
      'viem.d.ts',
      'viem.d.cts',
    ]);
    expect([...ALLOWED_VALUES]).toEqual([
      'ACTIVITY_TYPES',
      'ORDER_REJECTION_CODES',
    ]);
  });
});

describe('check-dts: the declared names against the pinned lists', () => {
  test('splits what an entry declares into runtime values and type-only names', async () => {
    const dir = await dist({
      'index.d.ts': `declare function make(): void;
declare class Failure extends Error {}
declare enum Side { BUY = 'BUY' }
declare const LIMIT: 10;
interface Shape { a: string }
type Alias = string;
declare class OnlyAType {}
export { make, Failure, Side, LIMIT };
export type { Shape, Alias, OnlyAType };
`,
    });
    expect(declaredExports(join(dir, 'index.d.ts'))).toEqual({
      values: ['Failure', 'LIMIT', 'Side', 'make'],
      types: ['Alias', 'OnlyAType', 'Shape'],
    });
  });

  test('reads the pinned lists of every entry from the lists file', async () => {
    const dir = await dist({
      'lists.ts': `/** Values. */
export const MAIN_VALUES = ['a', 'b'] as const;
export const MAIN_TYPES = ['T'] as const;
export const NODE_VALUES = [] as const;
export const NODE_TYPES = ['N'] as const;
export const SIGNING_VALUES = ['s'] as const;
export const SIGNING_TYPES = [] as const;
export const VIEM_VALUES = ['v'] as const;
export const VIEM_TYPES = ['V'] as const;
`,
    });
    expect(readPinnedLists(join(dir, 'lists.ts'))).toEqual({
      main: { values: ['a', 'b'], types: ['T'] },
      node: { values: [], types: ['N'] },
      signing: { values: ['s'], types: [] },
      viem: { values: ['v'], types: ['V'] },
    });
  });

  test('maps each published declaration file to the pinned lists of its entry', () => {
    expect(packageEntries('/d').map((p) => pinnedEntryOf(p.slice(3)))).toEqual([
      'main',
      'main',
      'node',
      'node',
      'signing',
      'signing',
      'viem',
      'viem',
    ]);
  });

  test('reports a pinned name the declarations lack, an extra name and a value typed as a type', () => {
    const problems = comparePinned(
      'index.d.ts',
      { values: ['create', 'Side'], types: ['Shape', 'Extra', 'isClient'] },
      { values: ['Side', 'create', 'isClient'], types: ['Shape'] },
    );
    expect(problems).toEqual([
      'index.d.ts: isClient is a pinned value but the declarations have it as a type only',
      'index.d.ts: Extra is declared but not in the pinned lists',
    ]);
  });

  test('reports a pinned name that is missing from the declarations altogether', () => {
    expect(
      comparePinned(
        'index.d.cts',
        { values: ['create'], types: [] },
        { values: ['create', 'isClient'], types: ['Shape'] },
      ),
    ).toEqual([
      'index.d.cts: Shape is pinned but not declared',
      'index.d.cts: isClient is pinned but not declared',
    ]);
  });

  test('an entry that declares exactly its pinned names has no problem', () => {
    expect(
      comparePinned(
        'viem.d.ts',
        { values: ['privateKey'], types: ['Signer'] },
        { values: ['privateKey'], types: ['Signer'] },
      ),
    ).toEqual([]);
  });

  test('reports a pinned type that the declarations make a runtime value', () => {
    expect(
      comparePinned(
        'node.d.ts',
        { values: ['fileStore', 'Store'], types: [] },
        { values: ['fileStore'], types: ['Store'] },
      ),
    ).toEqual([
      'node.d.ts: Store is a pinned type but the declarations have it as a runtime value',
    ]);
  });

  test('maps a declaration path with Windows separators too', () => {
    expect(pinnedEntryOf('signing\\index.d.ts')).toBe('signing');
    expect(pinnedEntryOf('signing\\index.d.cts')).toBe('signing');
  });
});
