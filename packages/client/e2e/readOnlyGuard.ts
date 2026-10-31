import { installReadOnlyGuard } from './setup';

// Runs before every live test file (vitest.e2e.config.ts `setupFiles`): the global `fetch`
// refuses every write but signing in and the sponsor's sign-only route, and every JSON-RPC
// method that is not a read, before the request leaves the process. The tests hand their
// clients liveFetch and readOnlyRpc; this also covers what the SDK builds itself, which a test
// cannot hand either: `createChainReader`, and the chain reads of a client. See
// e2e/setup.ts.
installReadOnlyGuard();
