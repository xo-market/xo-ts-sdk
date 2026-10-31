import { installRealHostGuard } from '../../../packages/client/test/helpers/realHostGuard.js';

// Runs before every test file of the scripts package (vitest.config.ts `setupFiles`): the global
// `fetch` and every TCP connection refuse every host but the local test servers, as in the
// client's unit tests. So a test of `createRealClient` that forgot its `fetch` stub cannot reach
// mainnet, its production sponsor included.
installRealHostGuard();
