import type { UnhandledRequestCallback } from 'msw';
import { described, LOCAL_TEST_HOSTS } from './realHostGuard';

// The network guard of the unit tests: no unit test may reach a real host. `production`
// names XO's production sponsor, which pays for and broadcasts whatever it signs, so a send that
// a test forgot to mock would be a real, sponsored mainnet transaction. Three layers:
//
// - per file, the msw `onUnhandledRequest` of a file that also talks to local servers
//   ({@link refuseRealHosts}) errors every unhandled request to another host (the other msw files
//   use `onUnhandledRequest: 'error'`);
// - globally, the setup file `test/setup/networkGuard.ts` installs ./realHostGuard: the global
//   `fetch` refuses a real host, and so does every TCP connection (`node:http`, `node:https`,
//   `ws`, undici), so a request msw lets through, or one made where msw is not listening, never
//   leaves the process.

export {
  connectTarget,
  FETCH_GUARD_REFUSAL,
  guardFetch,
  guardSockets,
  isLocalTestUrl,
  LOCAL_TEST_HOSTS,
  SOCKET_GUARD_CODE,
} from './realHostGuard';

/** The `code` of the error {@link refuseRealHosts} errors a request with. */
export const MSW_GUARD_CODE = 'EXO_UNIT_TEST_REAL_HOST';

/**
 * An msw `onUnhandledRequest` for a file whose tests also use local servers: an unhandled request
 * to one of {@link LOCAL_TEST_HOSTS} goes through, and any other is **errored**: its `fetch`
 * rejects with this callback's error (code {@link MSW_GUARD_CODE}) after msw prints why, and
 * nothing is handed on to the network. Each refusal is pushed to `refused` when it is given.
 *
 * Why it throws, and what: in msw 2.x the `print.error()` a custom callback is given only prints,
 * and the request then goes out to the network (msw `core/experimental/on-unhandled-frame`: "The
 * defaults only print the corresponding messages now. They do not affect the frame
 * resolution"). An error thrown by the callback stops that, and @mswjs/interceptors then errors
 * the request when the error looks like a Node network error (it has `code` and `errno`, its
 * `isNodeLikeError`); any other thrown error becomes a mocked 500 "Unhandled Exception" response
 * instead of a rejection.
 */
export function refuseRealHosts(refused?: string[]): UnhandledRequestCallback {
  return (request, print) => {
    const url = new URL(request.url);
    if (LOCAL_TEST_HOSTS.has(url.hostname)) {
      return;
    }
    const what = described(request.method, url);
    refused?.push(what);
    print.error();
    throw Object.assign(
      new Error(
        `A unit test never reaches a real host: msw refused the unhandled request ${what}`,
      ),
      { code: MSW_GUARD_CODE, errno: -1 },
    );
  };
}
