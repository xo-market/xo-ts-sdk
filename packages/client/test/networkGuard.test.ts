import http, { createServer, type Server } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { HttpResponse, http as mswHttp } from 'msw';
import { setupServer } from 'msw/node';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { production } from '../src/core/env';
import {
  connectTarget,
  FETCH_GUARD_REFUSAL,
  guardFetch,
  isLocalTestUrl,
  MSW_GUARD_CODE,
  refuseRealHosts,
  SOCKET_GUARD_CODE,
} from './helpers/networkGuard';
import { testEnv } from './helpers/testEnv';

// The unit tests' network guard (test/helpers/networkGuard.ts, installed by
// test/setup/networkGuard.ts). Nothing here reaches a real host: a refused request is refused
// before any socket is opened, and the one allowed request goes to a server on 127.0.0.1.

const SPONSOR_SEND = `${production.sponsorUrl}/v1/sponsor/send`;

/** What `run` rejected with. */
async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

describe('guardFetch', () => {
  test.each([
    ['the production sponsor', SPONSOR_SEND],
    [
      'a sponsor on the reserved .test domain',
      `${testEnv.sponsorUrl}/v1/sponsor/send`,
    ],
    ['the mainnet RPC', production.rpcUrl],
    ['a URL object', new URL('https://api-mainnet.xo.market/api/markets')],
    ['a Request', new Request(SPONSOR_SEND, { method: 'POST' })],
  ])(
    'refuses %s like a network failure, and never hands it on',
    async (_, input) => {
      const real = vi.fn<typeof fetch>();
      const guarded = guardFetch(real);

      const error = await rejection(() =>
        guarded(input, { method: 'POST', body: '{}' }),
      );

      expect(error).toBeInstanceOf(TypeError);
      expect((error as TypeError).message).toBe('fetch failed');
      const cause = (error as TypeError).cause as Error;
      expect(cause.message.startsWith(FETCH_GUARD_REFUSAL)).toBe(true);
      expect(real).not.toHaveBeenCalled();
    },
  );

  test.each([
    'http://127.0.0.1:8545/',
    'http://localhost:3000/time',
    'http://[::1]:4337/rpc',
  ])('hands %s on to the real fetch', async (url) => {
    const real = vi.fn<typeof fetch>(async () => new Response('ok'));
    await expect(guardFetch(real)(url)).resolves.toBeInstanceOf(Response);
    expect(real).toHaveBeenCalledTimes(1);
  });

  test('the local hosts are 127.0.0.1, localhost and [::1] only', () => {
    expect(isLocalTestUrl('http://127.0.0.1:1')).toBe(true);
    expect(isLocalTestUrl('ws://localhost:1/ws')).toBe(true);
    expect(isLocalTestUrl('http://[::1]:1')).toBe(true);
    expect(isLocalTestUrl('http://127.0.0.2:1')).toBe(false);
    expect(isLocalTestUrl('https://localhost.xo.market')).toBe(false);
    expect(isLocalTestUrl(SPONSOR_SEND)).toBe(false);
  });
});

describe('the global fetch of every unit test file', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
    );
  });

  test('refuses a POST to the production sponsor before it leaves the process', async () => {
    const error = await rejection(() =>
      fetch(SPONSOR_SEND, { method: 'POST', body: '{}' }),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(((error as TypeError).cause as Error).message).toBe(
      `${FETCH_GUARD_REFUSAL} POST https://sponsor.xo.market/v1/sponsor/send`,
    );
  });

  test('still reaches a local test server', async () => {
    const server = createServer((_, response) => response.end('local'));
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/`);

    expect(await response.text()).toBe('local');
  });
});

describe('refuseRealHosts (an msw onUnhandledRequest)', () => {
  const print = () => ({ warning: vi.fn(), error: vi.fn() });

  test('throws for a real host, after printing, and records it: an error msw turns into a rejected request', () => {
    const refused: string[] = [];
    const p = print();
    let thrown: unknown;
    try {
      refuseRealHosts(refused)(
        new Request(`${SPONSOR_SEND}?x=1`, { method: 'POST' }),
        p,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/never reaches a real host/);
    // @mswjs/interceptors errors the request only for an error with `code` and `errno`.
    expect(thrown).toMatchObject({ code: MSW_GUARD_CODE, errno: -1 });
    expect(p.error).toHaveBeenCalledTimes(1);
    expect(refused).toEqual(['POST https://sponsor.xo.market/v1/sponsor/send']);
  });

  test('lets a local host through, silently', () => {
    const refused: string[] = [];
    const p = print();
    refuseRealHosts(refused)(
      new Request('http://127.0.0.1:9999/socket.io/'),
      p,
    );
    expect(p.error).not.toHaveBeenCalled();
    expect(refused).toEqual([]);
  });
});

/** What `run` threw, synchronously or as a rejection. */
async function thrownBy(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

/** A server on 127.0.0.1 that answers `body`, and its URL. */
async function localServer(
  body: string,
): Promise<{ server: Server; url: string }> {
  const server = createServer((_, response) => response.end(body));
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/` };
}

/** The body of a `node:http(s)` response. */
function bodyOf(response: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      text += chunk;
    });
    response.on('end', () => resolve(text));
    response.on('error', reject);
  });
}

describe('every TCP connection of a unit test file (node:http, node:https and the rest)', () => {
  test.each([
    [
      'http.request',
      () =>
        http.request(SPONSOR_SEND.replace('https:', 'http:'), {
          method: 'POST',
        }),
    ],
    ['http.get', () => http.get('http://api-mainnet.xo.market/api/markets')],
    ['https.request', () => https.request(SPONSOR_SEND, { method: 'POST' })],
    ['https.get', () => https.get(production.rpcUrl)],
  ])('%s to a real host is refused before a socket opens', async (_, open) => {
    const error = await thrownBy(open);
    expect(error).toMatchObject({ code: SOCKET_GUARD_CODE });
    expect((error as Error).message.startsWith(FETCH_GUARD_REFUSAL)).toBe(true);
  });

  test('http.get to a local test server still works', async () => {
    const { server, url } = await localServer('local over node:http');
    try {
      const response = await new Promise<http.IncomingMessage>(
        (resolve, reject) => http.get(url, resolve).on('error', reject),
      );
      expect(await bodyOf(response)).toBe('local over node:http');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test.each([
    [
      [{ host: 'sponsor.xo.market', port: 443 }],
      { host: 'sponsor.xo.market', port: 443 },
    ],
    [
      [[{ host: '127.0.0.1', port: 8545 }, null]],
      { host: '127.0.0.1', port: 8545 },
    ],
    [[{ port: 80 }], { host: 'localhost', port: 80 }],
    [[{ path: '/tmp/x.sock' }], { path: '/tmp/x.sock' }],
    [['/tmp/x.sock'], { path: '/tmp/x.sock' }],
    [[8545, 'rpc.example'], { host: 'rpc.example', port: 8545 }],
    [[8545], { host: 'localhost', port: 8545 }],
  ])('connectTarget(%j) is %j', (args, target) => {
    expect(connectTarget(args)).toEqual(target);
  });
});

describe("msw's own interception of node:https keeps working under the guard", () => {
  const server = setupServer(
    mswHttp.get('https://api.xo.test/guard-probe', () =>
      HttpResponse.text('mocked by msw'),
    ),
  );
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterAll(() => server.close());

  test('a request msw answers opens no socket, so the guard never sees it', async () => {
    const response = await new Promise<http.IncomingMessage>(
      (resolve, reject) =>
        https
          .get('https://api.xo.test/guard-probe', resolve)
          .on('error', reject),
    );
    expect(await bodyOf(response)).toBe('mocked by msw');
  });
});
