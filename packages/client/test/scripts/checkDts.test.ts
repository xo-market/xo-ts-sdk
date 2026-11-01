import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  ALLOWED_VALUES,
  packageEntries,
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
