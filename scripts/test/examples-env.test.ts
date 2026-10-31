import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// examples/scripts/src/lib/env.ts: the examples read the .env of the folder they run from, then
// the one two folders up (the repository's, in a clone). The first file to set a variable wins,
// so a .env above a project (a monorepo's, say) never changes the key a script signs with.

// A path in a variable, so that this package's type check (NodeNext) leaves the example to its
// own (`pnpm --filter @xomarket/examples typecheck`, which resolves imports as bundlers do).
const ENV = fileURLToPath(
  new URL('../../examples/scripts/src/lib/env.ts', import.meta.url),
);

let root: string;
let cwd: string;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('XO_PK', undefined);
  vi.stubEnv('XO_WALLET', undefined);
  root = mkdtempSync(join(tmpdir(), 'xo-examples-env-'));
  cwd = process.cwd();
});

afterEach(() => {
  process.chdir(cwd);
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** Loads env.ts from `<root>/repo/project`, with a `.env` there and one at `<root>`. */
async function load(files: {
  local?: string;
  above?: string;
}): Promise<{ requireEnv: (name: string) => string }> {
  const project = join(root, 'repo', 'project');
  mkdirSync(project, { recursive: true });
  if (files.local !== undefined) {
    writeFileSync(join(project, '.env'), files.local);
  }
  if (files.above !== undefined) {
    writeFileSync(join(root, '.env'), files.above);
  }
  process.chdir(project);
  return import(ENV);
}

describe('examples/scripts/src/lib/env.ts', () => {
  test('the .env of the folder it runs from wins over the one two folders up', async () => {
    const env = await load({ local: 'XO_PK=local\n', above: 'XO_PK=above\n' });
    expect(env.requireEnv('XO_PK')).toBe('local');
  });

  test('the .env two folders up fills in only what the local one leaves unset', async () => {
    const env = await load({
      local: 'XO_PK=local\n',
      above: 'XO_PK=above\nXO_WALLET=0xabove\n',
    });
    expect(env.requireEnv('XO_PK')).toBe('local');
    expect(env.requireEnv('XO_WALLET')).toBe('0xabove');
  });

  test('without a local .env, the one two folders up is read', async () => {
    const env = await load({ above: 'XO_PK=above\n' });
    expect(env.requireEnv('XO_PK')).toBe('above');
  });

  test('a variable set in the environment wins over both files', async () => {
    vi.stubEnv('XO_PK', 'exported');
    const env = await load({ local: 'XO_PK=local\n', above: 'XO_PK=above\n' });
    expect(env.requireEnv('XO_PK')).toBe('exported');
  });
});
