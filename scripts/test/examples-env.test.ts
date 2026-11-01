import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// examples/scripts/src/lib/env.ts: the examples read the .env of the folder they run from, then
// the one at the root of this repository, found from the file's own place. The first file to
// set a variable wins. Copied into another project, the file reads no .env but its own folder's.
//
// Each test loads a copy of the file in a temporary folder, so the repository's own .env (which
// may hold a real key) is never read.

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

type Env = { requireEnv: (name: string) => string };

/**
 * A copy of the repository's layout at `<root>/repo`: its `package.json`, a `.env` at its root
 * (`repoEnv`) and the file at `examples/scripts/src/lib/env.ts`. The copy is loaded from
 * `<root>/repo/examples/scripts` (where the examples' scripts run), with a `.env` there
 * (`local`), unless `from` names another folder under `<root>`.
 */
async function loadInRepo(files: {
  local?: string;
  repoEnv?: string;
  from?: string;
}): Promise<Env> {
  const repo = join(root, 'repo');
  const scripts = join(repo, 'examples', 'scripts');
  const lib = join(scripts, 'src', 'lib');
  mkdirSync(lib, { recursive: true });
  writeFileSync(
    join(repo, 'package.json'),
    '{ "name": "xo-sdk-monorepo", "private": true }\n',
  );
  copyFileSync(ENV, join(lib, 'env.ts'));
  if (files.repoEnv !== undefined) {
    writeFileSync(join(repo, '.env'), files.repoEnv);
  }
  if (files.local !== undefined) {
    writeFileSync(join(scripts, '.env'), files.local);
  }
  const from = files.from === undefined ? scripts : join(root, files.from);
  mkdirSync(from, { recursive: true });
  process.chdir(from);
  return import(join(lib, 'env.ts'));
}

describe('examples/scripts/src/lib/env.ts', () => {
  test('the .env of the folder it runs from wins over the repository one', async () => {
    const env = await loadInRepo({
      local: 'XO_PK=local\n',
      repoEnv: 'XO_PK=repo\n',
    });
    expect(env.requireEnv('XO_PK')).toBe('local');
  });

  test('the repository .env fills in only what the local one leaves unset', async () => {
    const env = await loadInRepo({
      local: 'XO_PK=local\n',
      repoEnv: 'XO_PK=repo\nXO_WALLET=0xrepo\n',
    });
    expect(env.requireEnv('XO_PK')).toBe('local');
    expect(env.requireEnv('XO_WALLET')).toBe('0xrepo');
  });

  test('without a local .env, the repository one is read', async () => {
    const env = await loadInRepo({ repoEnv: 'XO_PK=repo\n' });
    expect(env.requireEnv('XO_PK')).toBe('repo');
  });

  test('a variable set in the environment wins over both files', async () => {
    vi.stubEnv('XO_PK', 'exported');
    const env = await loadInRepo({
      local: 'XO_PK=local\n',
      repoEnv: 'XO_PK=repo\n',
    });
    expect(env.requireEnv('XO_PK')).toBe('exported');
  });

  test('the repository .env is found from the file, not from the folder it runs from', async () => {
    // Two folders above `<root>/elsewhere/deep` is `<root>`: its .env is not the repository's.
    writeFileSync(join(root, '.env'), 'XO_PK=two-folders-up\n');
    const env = await loadInRepo({
      repoEnv: 'XO_PK=repo\n',
      from: join('elsewhere', 'deep'),
    });
    expect(env.requireEnv('XO_PK')).toBe('repo');
  });

  test('copied into another project, it never reads a .env above that project', async () => {
    // `<root>/home/work/project/src/lib/env.ts`, run from `<root>/home/work/project`, with an
    // unrelated .env two folders up (`<root>/home`) and four folders above the file
    // (`<root>/home`, where this repository's root would be).
    const project = join(root, 'home', 'work', 'project');
    const lib = join(project, 'src', 'lib');
    mkdirSync(lib, { recursive: true });
    copyFileSync(ENV, join(lib, 'env.ts'));
    writeFileSync(join(project, 'package.json'), '{ "name": "project" }\n');
    writeFileSync(join(root, 'home', '.env'), 'XO_PK=unrelated\n');
    writeFileSync(join(root, 'home', 'package.json'), '{ "name": "home" }\n');
    process.chdir(project);
    const env: Env = await import(join(lib, 'env.ts'));
    expect(() => env.requireEnv('XO_PK')).toThrow('Set XO_PK');
  });
});
