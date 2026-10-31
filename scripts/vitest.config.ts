import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // No test of the scripts reaches a real host: the global fetch and every TCP connection
    // refuse every one but the local test servers (packages/client/test/helpers/realHostGuard.ts).
    setupFiles: ['./test/setup/networkGuard.ts'],
  },
});
