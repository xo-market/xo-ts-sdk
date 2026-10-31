// The reference part of `pnpm run docs:check`: the committed docs/reference/ is exactly what
// `pnpm run docs:build` would write. It writes nothing under docs/: typedoc generates a fresh
// reference into a temporary folder, and the two folders are compared file by file and byte for
// byte.
//
//   pnpm -C scripts reference-check     exit 1 when the committed reference is stale

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Every file under `dir`, relative to it, with `/` separators. None when it does not exist. */
function filesOf(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else {
        files.push(relative(dir, path).split(sep).join('/'));
      }
    }
  };
  walk(dir);
  return files;
}

/**
 * The differences between a freshly generated folder and the committed one, sorted by path:
 * a file that differs, one that is missing, one that is not generated any more.
 */
export function compareTrees(fresh: string, committed: string): string[] {
  const generated = new Set(filesOf(fresh));
  const present = new Set(filesOf(committed));
  const problems: { path: string; text: string }[] = [];
  for (const path of generated) {
    if (!present.has(path)) {
      problems.push({ path, text: `${path} is missing` });
    } else if (
      !readFileSync(join(fresh, path)).equals(
        readFileSync(join(committed, path)),
      )
    ) {
      problems.push({
        path,
        text: `${path} differs from what typedoc generates`,
      });
    }
  }
  for (const path of present) {
    if (!generated.has(path)) {
      problems.push({ path, text: `${path} is not generated any more` });
    }
  }
  return problems
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((p) => p.text);
}

function main(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const docs = join(root, 'docs');
  const fresh = mkdtempSync(join(tmpdir(), 'xo-sdk-reference-'));
  try {
    const typedoc = join(root, 'node_modules', '.bin', 'typedoc');
    const run = spawnSync(
      typedoc,
      ['--options', join(root, 'typedoc.json'), '--out', fresh],
      { cwd: root, encoding: 'utf8' },
    );
    if (run.status !== 0) {
      process.stderr.write(run.stdout ?? '');
      process.stderr.write(run.stderr ?? '');
      console.error(
        'reference-check: typedoc failed (it treats every warning as an error)',
      );
      process.exitCode = 1;
      return;
    }
    const problems = compareTrees(fresh, join(docs, 'reference')).map(
      (text) => `docs/reference/${text}`,
    );
    const pages = filesOf(join(docs, 'reference')).filter((path) =>
      path.endsWith('.md'),
    );
    for (const problem of problems) {
      console.error(problem);
    }
    if (problems.length > 0) {
      console.error(
        `reference-check: ${problems.length} difference(s): run \`pnpm run docs:build\` and commit the result`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `reference-check: docs/reference (${pages.length} pages) is what typedoc generates: OK`,
    );
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
