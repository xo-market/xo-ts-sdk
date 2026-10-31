import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests only. Live e2e tests live in e2e/** and never run here or in CI.
    include: ['test/**/*.test.ts'],
    // No unit test reaches a real host: the global fetch refuses every one but the local test
    // servers (msw, where a file listens, sits in front of it).
    setupFiles: ['./test/setup/networkGuard.ts'],
    // Type tests (`*.test-d.ts`) are compiled, never run: the public API's signatures.
    typecheck: {
      enabled: true,
      include: ['test/**/*.test-d.ts'],
      tsconfig: './tsconfig.json',
    },
  },
});
