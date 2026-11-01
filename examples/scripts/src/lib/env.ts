import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The local .env loads first and wins: a file loaded later never overrides a variable.
try {
  process.loadEnvFile?.();
} catch {
  // Examples can run without a local .env when variables are set elsewhere.
}

// Then the .env at the root of this repository, and only there: copied into another
// project, this file must never load a .env that belongs to something else.
const root = new URL('../../../../', import.meta.url);

try {
  const { name } = JSON.parse(
    readFileSync(new URL('package.json', root), 'utf8'),
  ) as { name?: unknown };

  if (name === 'xo-sdk-monorepo') {
    process.loadEnvFile?.(fileURLToPath(new URL('.env', root)));
  }
} catch {
  // Examples can run without a repo-level .env when variables are set elsewhere.
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (value === undefined || value === '') {
    throw new Error(`Set ${name} (see .env.example)`);
  }

  return value;
}
