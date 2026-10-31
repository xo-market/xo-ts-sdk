// The local .env loads first and wins: a file loaded later never overrides a variable.
try {
  process.loadEnvFile?.();
} catch {
  // Examples can run without a local .env when variables are set elsewhere.
}

try {
  process.loadEnvFile?.('../../.env');
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
