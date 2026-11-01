// The runtime smoke test of the BUILT package, for Bun: the CI job "Bun" runs
// `bun scripts/bun-smoke.ts` after `pnpm -C packages/client build`. It runs on Node as well
// (`node scripts/bun-smoke.ts`; Node 22.18 or later strips the types), which is how it is
// checked without Bun. Nothing here touches the network: the HTTP answers come from a fake
// `fetch`, the chain read from a fake reader, and the WebSocket is a server on 127.0.0.1.
//
// What it checks, on the ESM and the CommonJS build of `@xomarket/client`, `/node`, `/signing`
// and `/viem` (through the package's `exports`, as a user imports them):
// 1. Both builds load and export the same names.
// 2. The golden order digest of test-vectors/order.json, with both builds' signing kit.
// 3. A secure client of a freshly generated key (`/viem`'s `privateKey`) signs in with given
//    credentials, which it checks through the fake `fetch`, and signs an order that recovers to
//    that key. Building it reads the tick size (the fake `fetch`) and the exchange nonce (a
//    chain read: the fake JSON-RPC answer of the global `fetch`).
//    The signers of `/viem` (a private key, a viem account) sign the golden ClobAuth
//    vector of test-vectors/clobAuth.json, typed and as a raw hash.
// 4. Every L2 HMAC case of test-vectors/hmac.json: the cases, the four spellings of one secret,
//    and the UTF-8 body.
// 5. A public client's `subscribe([{ topic: 'market' }])` opens against the local server
//    (Bun.serve on Bun, the `ws` package on Node), subscribes, gets a book, and closes.
// 6. The runtime's own WebSocket where a connection fails or is dropped before it opens
//    (Node 22's global one fires `error` and no `close` there): a refused connection is
//    reported and retried within a few backoff delays, not at the 10 s connect timeout, and
//    closing a subscription whose socket is still connecting resolves at once.
// 7. The process exits promptly once all that is done. The script runs itself as a child and
//    times the child from its last line to its exit: a timer the SDK forgot (a request's
//    timeout, a socket's ping or reconnect, a shutdown hook) keeps the event loop alive and
//    fails the run.
//
// The secret of test-vectors/hmac.json, the generated key and the credentials below are test
// values: never use them.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type Server, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, type Hex, recoverTypedDataAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

type Root = typeof import('@xomarket/client');
type NodeEntry = typeof import('@xomarket/client/node');
type Signing = typeof import('@xomarket/client/signing');
type ViemEntry = typeof import('@xomarket/client/viem');

const CHILD_FLAG = '--child';
const DONE = 'SMOKE_DONE';
/** How long the child may take to exit after its last line. */
const EXIT_WITHIN_MS = 3_000;
/** The whole child run, startup included. */
const RUN_WITHIN_MS = 60_000;
/** Waits inside the checks (a book to arrive, the server to see the close). */
const STEP_WITHIN_MS = 10_000;
/**
 * Two refused attempts must be reported within this long. The first two backoff delays are
 * at most 250 and 500 ms; the connect timeout, which is what a missed `error` falls back on,
 * is 10 s.
 */
const REFUSED_RETRY_WITHIN_MS = 5_000;
/** A subscription whose socket is still connecting must close within this long. */
const CLOSE_CONNECTING_WITHIN_MS = 1_000;

const CONDITION = `0x${'c1'.repeat(32)}`;
const TOKEN = '4660';
/** The fake chain's JSON-RPC endpoint, which the global `fetch` answers. */
const RPC_URL = 'https://rpc.smoke.invalid/';
/** The exchange nonce the fake chain gives. */
const NONCE = 7n;
const BOOK_FRAME = {
  event_type: 'book',
  asset_id: TOKEN,
  market: CONDITION,
  bids: [{ price: '0.550', size: '100' }],
  asks: [{ price: '0.560', size: '80' }],
  timestamp: '1800000000123',
  hash: 'ab12',
};

function check(condition: unknown, what: string): asserts condition {
  if (!condition) {
    throw new Error(`bun-smoke: ${what}`);
  }
}

const runtime = (): string => {
  const bun = (globalThis as { Bun?: { version: string } }).Bun;
  return bun === undefined ? `node ${process.version}` : `bun ${bun.version}`;
};

/** A test vector file of the repository's test-vectors/ folder. */
function vector(name: string): Record<string, unknown> {
  const url = new URL(`../test-vectors/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as Record<string, unknown>;
}

/** Resolves when `ready()` is true, polling on short timers that are always cleared. */
async function until(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + STEP_WITHIN_MS;
  while (!ready()) {
    check(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------
// 1. Both builds
// ---------------------------------------------------------------------------

interface Build {
  root: Root;
  node: NodeEntry;
  signing: Signing;
  viem: ViemEntry;
}

async function loadBuilds(): Promise<{ esm: Build; cjs: Build }> {
  const require = createRequire(import.meta.url);
  const esm: Build = {
    root: await import('@xomarket/client'),
    node: await import('@xomarket/client/node'),
    signing: await import('@xomarket/client/signing'),
    viem: await import('@xomarket/client/viem'),
  };
  const cjs: Build = {
    root: require('@xomarket/client') as Root,
    node: require('@xomarket/client/node') as NodeEntry,
    signing: require('@xomarket/client/signing') as Signing,
    viem: require('@xomarket/client/viem') as ViemEntry,
  };
  for (const entry of ['root', 'node', 'signing', 'viem'] as const) {
    const names = (m: object) => Object.keys(m).sort().join(',');
    check(
      names(esm[entry]) === names(cjs[entry]),
      `the ESM and CJS builds of ${entry} export different names`,
    );
    check(Object.keys(esm[entry]).length > 0, `${entry} exports nothing`);
  }
  // Two builds, two module instances: the CJS one is really the .cjs file.
  check(
    esm.root.createPublicClient !== cjs.root.createPublicClient,
    'the CJS build resolved to the ESM one',
  );
  check(
    esm.root.SDK_VERSION === cjs.root.SDK_VERSION,
    'the two builds have different versions',
  );
  check(
    typeof esm.node.fileStore === 'function' &&
      typeof cjs.node.installShutdownHooks === 'function',
    'the node entry lacks fileStore or installShutdownHooks',
  );
  check(
    typeof esm.viem.privateKey === 'function' &&
      typeof cjs.viem.signerFrom === 'function',
    'the viem entry lacks privateKey or signerFrom',
  );
  return { esm, cjs };
}

// ---------------------------------------------------------------------------
// 2. and 3. Orders
// ---------------------------------------------------------------------------

function goldenOrder(kits: readonly Signing[]): void {
  const v = vector('order.json');
  const i = v.inputs as Record<string, string | number>;
  const order = {
    salt: BigInt(i.salt as string),
    maker: i.maker as Hex,
    signer: i.signer as Hex,
    beneficiary: i.beneficiary as Hex,
    tokenId: BigInt(i.tokenId as string),
    makerAmount: BigInt(i.makerAmount as string),
    takerAmount: BigInt(i.takerAmount as string),
    expiration: BigInt(i.expiration as string),
    nonce: BigInt(i.nonce as string),
    identifier: i.identifier as Hex,
    metadata: i.metadata as Hex,
    side: i.side as 0 | 1,
    signatureType: i.signatureType as 0 | 3,
  };
  for (const kit of kits) {
    const digest = kit.hashOrder(
      order,
      kit.orderDomain(i.chainId as number, i.exchange as Hex),
    );
    check(digest === v.expectedDigest, `order digest ${digest} is not golden`);
  }
}

/** What the fake services know of the wallet that signs in: its address and credentials. */
interface FakeAccount {
  address: string;
  orderbook: { apiKey: string; secret: string; passphrase: string };
}

/**
 * A fake `fetch` for the services, recording what it was asked: the server time, the tick size
 * and, for `account`, the reads that check given credentials.
 */
function fakeFetch(calls: string[], account?: FakeAccount): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input : input.url,
    );
    check(init?.signal instanceof AbortSignal, 'a request without a signal');
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.pathname === '/time') {
      return json(Math.floor(Date.now() / 1000));
    }
    if (url.pathname === '/tick-size') {
      return json({ minimum_tick_size: 0.001 });
    }
    if (account !== undefined && url.pathname === '/api/users/me') {
      return json({ walletPublicKey: account.address });
    }
    if (account !== undefined && url.pathname === '/auth/derive-api-key') {
      return json(account.orderbook);
    }
    return new Response('{"error":"not found"}', { status: 404 });
  }) as typeof fetch;
}

/**
 * The global `fetch` of the child: the fake chain's JSON-RPC endpoint answers every `eth_call`
 * with the nonce, and nothing else is reachable. A client reads the chain with the global
 * `fetch`, whatever `fetch` it is given.
 */
function fakeChain(): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input : input.url,
    );
    check(url.href === RPC_URL, `a request to ${url.host} outside the fakes`);
    const body = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
    };
    check(body.method === 'eth_call', `an unexpected ${body.method}`);
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: encodeAbiParameters([{ type: 'uint128' }], [NONCE]),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
}

async function signedOrder(
  build: Build,
  env: ReturnType<typeof smokeEnv>,
  calls: string[],
): Promise<void> {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  const hmac = vector('hmac.json').inputs as { secret: string };
  const orderbook = {
    apiKey: 'smoke-api-key',
    secret: hmac.secret,
    passphrase: 'smoke-passphrase',
  };
  const before = calls.length;
  const client = await build.root.createSecureClient({
    environment: env,
    signer: build.viem.privateKey(key),
    credentials: { backend: { apiKey: 'xo_sk_data_smoke' }, orderbook },
    fetch: fakeFetch(calls, { address, orderbook }),
  });
  check(
    calls.slice(before).includes('GET /api/users/me') &&
      calls.slice(before).includes('GET /auth/derive-api-key'),
    'the given credentials were not checked',
  );
  check(client.wallet === address, 'the wallet is not the signer');
  const order = await client.createLimitOrder({
    assetId: TOKEN,
    side: build.root.OrderSide.BUY,
    price: '0.45',
    size: '10',
    postOnly: true,
  });
  await client.close();
  check(
    calls.slice(before).includes('GET /tick-size'),
    'building the order read no tick size',
  );
  check(order.order.maker === address, 'the maker is not the signer');
  check(order.order.nonce === NONCE, 'the nonce is not the chain read');
  check(
    order.order.makerAmount === 4_500_000n,
    'the BUY amount is not 4.5 USDC',
  );
  const domain = build.signing.orderDomain(
    env.chainId,
    env.contracts.ctfExchange,
  );
  check(
    build.signing.hashOrder(order.order, domain) === order.orderHash,
    'the order hash does not match the order',
  );
  const recovered = await recoverTypedDataAddress({
    ...build.signing.orderTypedData(order.order, domain),
    signature: order.wire.signature as Hex,
  });
  check(recovered === address, 'the signature does not recover');
}

/** The signers of `/viem` sign the golden ClobAuth vector, typed and as a raw hash. */
async function viemSigners(
  builds: readonly { signing: Signing; viem: ViemEntry }[],
): Promise<void> {
  const v = vector('clobAuth.json');
  const i = v.inputs as {
    privateKey: Hex;
    address: Hex;
    timestamp: string;
    nonce: string;
    chainId: number;
  };
  for (const build of builds) {
    const typedData = build.signing.clobAuthTypedData({
      address: i.address,
      timestamp: i.timestamp,
      nonce: BigInt(i.nonce),
      chainId: i.chainId,
    });
    const signers = [
      build.viem.privateKey(i.privateKey),
      build.viem.signerFrom(privateKeyToAccount(i.privateKey)),
    ];
    for (const signer of signers) {
      check(
        (await signer.getAddress()) === i.address,
        'a /viem signer has another address than the vector key',
      );
      check(
        (await signer.signTypedData(typedData)) === v.expectedSignature,
        'a /viem signer did not sign the ClobAuth vector to the golden signature',
      );
      check(
        signer.signHash !== undefined &&
          (await signer.signHash(v.expectedDigest as Hex)) ===
            v.expectedSignature,
        'a /viem signer did not sign the ClobAuth digest to the golden signature',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 4. HMAC
// ---------------------------------------------------------------------------

interface HmacCase {
  secret: string;
  timestamp: string;
  method: string;
  path: string;
  body: string;
  expectedSignature: string;
}

async function hmacCases(kits: readonly Signing[]): Promise<number> {
  const v = vector('hmac.json');
  const inputs = v.inputs as { secret: string; timestamp: string };
  const listed = v.cases as Array<Omit<HmacCase, 'secret' | 'timestamp'>>;
  const alphabet = v.alphabetCase as Omit<HmacCase, 'secret'> & {
    secrets: Record<string, string>;
  };
  const cases: HmacCase[] = [
    ...listed.map((c) => ({ ...inputs, ...c })),
    ...Object.values(alphabet.secrets).map((secret) => ({
      ...alphabet,
      secret,
    })),
    v.utf8Case as HmacCase,
  ];
  check(listed.length > 0, 'hmac.json has no case');
  for (const kit of kits) {
    for (const c of cases) {
      const signature = await kit.hmacSignature(
        c.secret,
        c.timestamp,
        c.method,
        c.path,
        c.body,
      );
      check(
        signature === c.expectedSignature,
        `HMAC of ${c.method} ${c.path} is not golden`,
      );
    }
  }
  return cases.length;
}

// ---------------------------------------------------------------------------
// 5. A WebSocket subscription
// ---------------------------------------------------------------------------

interface LocalServer {
  url: string;
  received: string[];
  closes: number[];
  stop(): Promise<void>;
}

/** What the market channel's server does with one text frame from the client. */
function answer(text: string, send: (text: string) => void): void {
  if (text === 'PING') {
    send('PONG');
  } else if (text.includes(CONDITION)) {
    send(JSON.stringify(BOOK_FRAME));
  }
}

interface BunServerSocket {
  send(text: string): void;
}
interface BunRuntime {
  serve(o: {
    hostname: string;
    port: number;
    fetch(
      request: Request,
      server: { upgrade(request: Request): boolean },
    ): Response | undefined;
    websocket: {
      message(ws: BunServerSocket, message: string | Uint8Array): void;
      close(ws: BunServerSocket, code: number): void;
    };
  }): { port: number; stop(closeActive?: boolean): void };
}

async function startServer(): Promise<LocalServer> {
  const received: string[] = [];
  const closes: number[] = [];
  const bun = (globalThis as { Bun?: BunRuntime }).Bun;
  if (bun !== undefined) {
    const server = bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, srv) {
        if (new URL(request.url).pathname === '/ws/market') {
          if (srv.upgrade(request)) {
            return undefined;
          }
        }
        return new Response('not found', { status: 404 });
      },
      websocket: {
        message(ws, message) {
          const text =
            typeof message === 'string'
              ? message
              : new TextDecoder().decode(message);
          received.push(text);
          answer(text, (t) => ws.send(t));
        },
        close(_ws, code) {
          closes.push(code);
        },
      },
    });
    return {
      url: `ws://127.0.0.1:${server.port}`,
      received,
      closes,
      stop: async () => server.stop(true),
    };
  }
  const { WebSocketServer } = await import('ws');
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      const text = String(data);
      received.push(text);
      answer(text, (t) => socket.send(t));
    });
    socket.on('close', (code) => closes.push(code));
  });
  const address = wss.address();
  check(typeof address === 'object' && address !== null, 'no server address');
  return {
    url: `ws://127.0.0.1:${address.port}`,
    received,
    closes,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => resolve());
      }),
  };
}

/**
 * An environment on fake hosts, with every endpoint the smoke uses pointed at fakes. It is built
 * inline because the smoke runs from the built package. The contracts are mainnet's, which the
 * smoke only uses as opaque values.
 */
function smokeEnv(root: Root, wsUrl: string) {
  const { contracts, kernelVersion } = root.production;
  return {
    name: 'smoke',
    chainId: 31337,
    backendUrl: 'https://backend.smoke.invalid',
    backendSocketUrl: 'https://backend.smoke.invalid',
    orderbookUrl: 'https://orderbook.smoke.invalid',
    orderbookMarketWsUrl: `${wsUrl}/ws/market`,
    orderbookUserWsUrl: `${wsUrl}/ws/user`,
    sponsorUrl: 'https://sponsor.smoke.invalid',
    rpcUrl: RPC_URL,
    siweDomain: 'app.smoke.invalid',
    siweUri: 'https://app.smoke.invalid',
    contracts: { ...contracts },
    kernelVersion,
  };
}

async function subscription(
  root: Root,
  server: LocalServer,
  calls: string[],
): Promise<void> {
  const client = root.createPublicClient({
    environment: smokeEnv(root, server.url),
    fetch: fakeFetch(calls),
  });
  const closesBefore = server.closes.length;
  const handle = await client.subscribe([
    { topic: 'market', markets: [CONDITION] },
  ]);
  let books = 0;
  for await (const event of handle) {
    check(
      event.type === 'book' && event.market === CONDITION,
      'an event that is not the book of the market',
    );
    books += 1;
    break;
  }
  check(books > 0, 'no book event');
  check(
    server.received.some((frame) => frame.includes(CONDITION)),
    'the server saw no subscribe frame for the market',
  );
  await handle.close();
  await until(
    () => server.closes.length > closesBefore,
    'the server to see the close',
  );
  await client.closeSubscriptions();
}

// ---------------------------------------------------------------------------
// 6. Sockets that fail or are closed before they open
// ---------------------------------------------------------------------------

/** A TCP server on 127.0.0.1 that runs `onConnection` for each connection. */
async function tcpServer(
  onConnection: (socket: Socket) => void,
): Promise<{ server: Server; port: number }> {
  const server = createServer(onConnection);
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = server.address();
  check(
    typeof address === 'object' && address !== null,
    'no TCP server address',
  );
  return { server, port: address.port };
}

const closeTcp = (server: Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

/** A refused connection is reported and retried at the backoff's pace. */
async function refusedConnection(root: Root, calls: string[]): Promise<void> {
  // A port nothing listens on: a server that was started and stopped.
  const dead = await tcpServer(() => undefined);
  await closeTcp(dead.server);
  const client = root.createPublicClient({
    environment: smokeEnv(root, `ws://127.0.0.1:${dead.port}`),
    fetch: fakeFetch(calls),
  });
  const failures: string[] = [];
  const handle = await client.subscribe([
    { topic: 'market', markets: [CONDITION] },
  ]);
  handle.on('error', (error) => failures.push(error.code));
  const started = Date.now();
  await until(
    () => failures.filter((code) => code === 'transport_error').length >= 2,
    'two refused attempts',
  );
  const tookMs = Date.now() - started;
  check(
    tookMs < REFUSED_RETRY_WITHIN_MS,
    `two refused attempts took ${tookMs} ms (at most ${REFUSED_RETRY_WITHIN_MS}): a failed connect was noticed only at the connect timeout`,
  );
  check(
    !failures.includes('ws_connect_timeout'),
    'a refused connection was reported as a connect timeout',
  );
  await handle.close();
}

/** Closing a subscription whose socket is still connecting resolves at once. */
async function closeWhileConnecting(
  root: Root,
  calls: string[],
): Promise<void> {
  // Takes the TCP connection and never answers the WebSocket upgrade.
  const held: Socket[] = [];
  const silent = await tcpServer((socket) => {
    held.push(socket);
    socket.on('error', () => undefined);
  });
  try {
    const client = root.createPublicClient({
      environment: smokeEnv(root, `ws://127.0.0.1:${silent.port}`),
      fetch: fakeFetch(calls),
    });
    const handle = await client.subscribe([
      { topic: 'market', markets: [CONDITION] },
    ]);
    await until(() => held.length > 0, 'the connection to reach the server');
    const started = Date.now();
    await handle.close();
    const tookMs = Date.now() - started;
    check(
      tookMs < CLOSE_CONNECTING_WITHIN_MS,
      `closing a subscription whose socket was still connecting took ${tookMs} ms (at most ${CLOSE_CONNECTING_WITHIN_MS})`,
    );
  } finally {
    for (const socket of held) {
      socket.destroy();
    }
    await closeTcp(silent.server);
  }
}

// ---------------------------------------------------------------------------
// The child: every check, then one last line
// ---------------------------------------------------------------------------

async function child(): Promise<void> {
  globalThis.fetch = fakeChain();
  const { esm, cjs } = await loadBuilds();
  goldenOrder([esm.signing, cjs.signing]);
  await viemSigners([esm, cjs]);
  const server = await startServer();
  const calls: string[] = [];
  try {
    for (const build of [esm, cjs]) {
      await signedOrder(build, smokeEnv(build.root, server.url), calls);
    }
    const cases = await hmacCases([esm.signing, cjs.signing]);
    await subscription(esm.root, server, calls);
    await subscription(cjs.root, server, calls);
    await refusedConnection(esm.root, calls);
    await closeWhileConnecting(cjs.root, calls);
    console.log(
      `bun-smoke: ${runtime()}: both builds of 4 entries, golden order digest, 2 secure clients signed in and signed an order, 4 /viem signers on the ClobAuth vector, ${cases} HMAC cases x 2, ${calls.length} fake requests, 2 book subscriptions opened and closed, a refused connection retried promptly, a connecting socket closed at once`,
    );
  } finally {
    await server.stop();
  }
  // The child returns from here: the parent measures how long it then takes to exit.
  console.log(DONE);
}

// ---------------------------------------------------------------------------
// The parent: runs the child and times its exit
// ---------------------------------------------------------------------------

function parent(): Promise<void> {
  const script = fileURLToPath(import.meta.url);
  return new Promise((resolve, reject) => {
    const run = spawn(
      process.execPath,
      [...process.execArgv, script, CHILD_FLAG],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let doneAt: number | undefined;
    let buffered = '';
    run.stdout.setEncoding('utf8');
    run.stdout.on('data', (chunk: string) => {
      process.stdout.write(chunk);
      buffered += chunk;
      if (doneAt === undefined && buffered.includes(DONE)) {
        doneAt = Date.now();
      }
    });
    const cap = setTimeout(() => {
      run.kill('SIGKILL');
      reject(
        new Error(
          `bun-smoke: the child did not finish within ${RUN_WITHIN_MS / 1000} s (${doneAt === undefined ? 'its checks did not end' : 'it did not exit after its checks: a stray timer or socket'})`,
        ),
      );
    }, RUN_WITHIN_MS);
    run.on('error', (error) => {
      clearTimeout(cap);
      reject(error);
    });
    run.on('exit', (code, signal) => {
      clearTimeout(cap);
      if (code !== 0) {
        reject(
          new Error(`bun-smoke: the child failed (${code ?? signal ?? '?'})`),
        );
        return;
      }
      if (doneAt === undefined) {
        reject(new Error('bun-smoke: the child exited without its last line'));
        return;
      }
      const lingered = Date.now() - doneAt;
      if (lingered > EXIT_WITHIN_MS) {
        reject(
          new Error(
            `bun-smoke: the child took ${lingered} ms to exit after its checks (at most ${EXIT_WITHIN_MS} ms): something keeps the event loop alive`,
          ),
        );
        return;
      }
      console.log(
        `bun-smoke: OK on ${runtime()}; the child exited ${lingered} ms after its checks`,
      );
      resolve();
    });
  });
}

if (process.argv.includes(CHILD_FLAG)) {
  await child();
} else {
  await parent();
}
