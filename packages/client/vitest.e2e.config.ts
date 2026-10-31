import { defineConfig } from 'vitest/config';
import { IssueReporter } from './e2e/issueReport';

// With XO_E2E_ISSUE_FILE set (the nightly workflow), the failures are also written there,
// redacted, as the body of the "Nightly e2e failing" issue.
const issueFile = process.env.XO_E2E_ISSUE_FILE;

export default defineConfig({
  test: {
    // Live e2e tests against XO mainnet, read-only. Run with XO_E2E=1 (and XO_E2E_WALLET_PK for
    // the signed-in blocks); `pnpm test` never includes them.
    include: ['e2e/**/*.e2e.test.ts'],
    // Before every file: the global fetch refuses writes (see e2e/readOnlyGuard.ts).
    setupFiles: ['./e2e/readOnlyGuard.ts'],
    // Real network calls, and the tests wait between logins.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // One file at a time: the services rate-limit per IP, and files run in parallel would
    // share those buckets.
    fileParallelism: false,
    reporters:
      issueFile === undefined || issueFile === ''
        ? ['default']
        : ['default', new IssueReporter(issueFile)],
  },
});
