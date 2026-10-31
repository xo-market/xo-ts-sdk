import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { compareTrees } from '../reference-check.js';

// The reference check of `pnpm run docs:check` (scripts/reference-check.ts): typedoc writes a
// fresh reference into a temporary folder, and the committed docs/reference/ must hold exactly
// the same files with exactly the same bytes.

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'reference-check-'));
  made.push(dir);
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  }
  return dir;
}

describe('compareTrees', () => {
  test('two folders with the same files and bytes have no difference', () => {
    const files = { 'README.md': '# API\n', 'client/README.md': '# client\n' };
    expect(compareTrees(tree(files), tree(files))).toEqual([]);
  });

  test('names a missing, an extra and a changed file', () => {
    const fresh = tree({
      'README.md': '# API\n',
      'client/classes/XoError.md': '# XoError\n',
      'client/README.md': '# client\n',
    });
    const committed = tree({
      'README.md': '# API (old)\n',
      'client/README.md': '# client\n',
      'client/classes/Gone.md': '# Gone\n',
    });
    expect(compareTrees(fresh, committed)).toEqual([
      'README.md differs from what typedoc generates',
      'client/classes/Gone.md is not generated any more',
      'client/classes/XoError.md is missing',
    ]);
  });

  test('a committed folder that does not exist is one difference', () => {
    const fresh = tree({ 'README.md': '# API\n' });
    expect(compareTrees(fresh, join(fresh, 'nope'))).toEqual([
      'README.md is missing',
    ]);
  });
});
