import { installRealHostGuard } from '../helpers/realHostGuard';

// Runs before every unit test file (vitest.config.ts `setupFiles`): the global `fetch` and every
// TCP connection refuse every host but the local test servers. msw, once a file's server listens,
// sits in front of them and hands on only the requests it lets through. See
// test/helpers/realHostGuard.ts.
installRealHostGuard();
