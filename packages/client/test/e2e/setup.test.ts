import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Address, createPublicClient, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  assertEmptyWallet,
  type E2eClient,
  E2eWriteRefused,
  e2eWallet,
  type HttpCall,
  installReadOnlyGuard,
  LOGIN_GAP_MS,
  env as liveEnv,
  liveFetch,
  loginGap,
  loginStampFile,
  markLogin,
  RPC_READ_METHODS,
  readOnlyFetch,
  readOnlyRpc,
  revokeSucceeded,
  strictPublicClient,
  unexpected,
  type WalletChainReads,
} from '../../e2e/setup';
import { SPONSOR_SEND_PATH } from '../../src/account/sponsorClient';
import {
  RequestRejectedError,
  UnexpectedResponseError,
} from '../../src/core/errors';
import { createPublicClient as createXoPublicClient } from '../../src/index';

// The helpers of the live e2e tests that can be checked without the network. Importing them
// opens no connection: nothing is created until `liveSession` or `liveTransport` is called.

const { backendUrl, orderbookUrl, rpcUrl } = liveEnv;
const sponsorUrl = liveEnv.sponsorUrl as string;

const KEYS_URL = `${backendUrl}/api/auth/api-keys`;

/**
 * A `fetch` that answers anything, and counts: a JSON-RPC result for a JSON-RPC body, the
 * backend's 201 with key id 78 for a key mint, and 200 `{}` for the rest.
 */
function answering(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (input, init) => {
    const body = (
      typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    ) as { jsonrpc?: unknown; id?: unknown } | undefined;
    if (body?.jsonrpc !== undefined) {
      return Response.json({ jsonrpc: '2.0', id: body.id, result: '0x01' });
    }
    if (String(input) === KEYS_URL && init?.method === 'POST') {
      return Response.json({ id: 78, key: 'xo_sk_data_test' }, { status: 201 });
    }
    return new Response('{}', { status: 200 });
  });
}

/** A `fetch` that answers every request with `{ id }` and `status`, and counts. */
function answeringWithId(
  id: number,
  status = 201,
): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async () => Response.json({ id }, { status }));
}

/** A JSON-RPC request body, as viem sends it. */
const rpcBody = (...methods: string[]): string =>
  JSON.stringify(
    methods.length === 1
      ? { jsonrpc: '2.0', id: 1, method: methods[0], params: [] }
      : methods.map((method, id) => ({
          jsonrpc: '2.0',
          id,
          method,
          params: [],
        })),
  );

describe('the read-only guard', () => {
  let network: ReturnType<typeof answering>;

  beforeEach(() => {
    network = answering();
    vi.stubGlobal('fetch', network);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('liveFetch refuses a non-GET request outside the sign-in routes', async () => {
    const calls: HttpCall[] = [];
    const fetchFn = liveFetch(calls, () => join(tmpdir(), 'unused'));
    const refused: Array<[string, string]> = [
      ['POST', `${backendUrl}/api/orders`],
      // The orderbook's trading routes: place, cancel, heartbeat.
      ['POST', `${orderbookUrl}/order`],
      ['POST', `${orderbookUrl}/orders`],
      ['DELETE', `${orderbookUrl}/order`],
      ['DELETE', `${orderbookUrl}/cancel-all`],
      ['POST', `${orderbookUrl}/heartbeats`],
      // Derive is a GET; the same path as a POST is not a sign-in.
      ['POST', `${orderbookUrl}/auth/derive-api-key`],
      // The sponsor's broadcasting route, as the sponsored rail sends it.
      ['POST', `${sponsorUrl}${SPONSOR_SEND_PATH}`],
      // Backend writes, and look-alikes of the sign-in routes.
      ['PATCH', `${backendUrl}/api/users/me/profile`],
      ['PUT', `${backendUrl}/api/users/me/privacy`],
      ['POST', `${backendUrl}/api/auth/api-keys/wallet`],
      ['POST', `${backendUrl}/api/auth/api-keys/nonce/extra`],
      ['DELETE', `${backendUrl}/api/auth/api-keys/abc`],
      ['DELETE', `${backendUrl}/api/auth/api-keys`],
      // A key this run did not mint: never revoked, whoever holds it.
      ['DELETE', `${backendUrl}/api/auth/api-keys/2147483647`],
      ['PUT', `${backendUrl}/api/auth/api-keys`],
      // A sign-in path on another service, and any other host.
      ['POST', `${orderbookUrl}/api/auth/api-keys`],
      ['POST', `${backendUrl}/v1/sponsor/sign`],
      ['POST', 'https://example.com/v1/sponsor/sign'],
      // The batch reads are the order book's alone, and their exact paths.
      ['POST', `${backendUrl}/books`],
      ['POST', `${orderbookUrl}/books/extra`],
      ['POST', `${orderbookUrl}/prices-history`],
      ['DELETE', `${orderbookUrl}/books`],
      ['PUT', `${orderbookUrl}/prices`],
      ['POST', 'https://example.com/books'],
    ];
    for (const [method, url] of refused) {
      const failure = await fetchFn(url, { method, body: '{}' }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure, `${method} ${url}`).toBeInstanceOf(E2eWriteRefused);
      expect((failure as Error).message).toContain(method);
    }
    // A Request object carries its method too.
    await expect(
      fetchFn(new Request(`${backendUrl}/api/orders`, { method: 'POST' })),
    ).rejects.toBeInstanceOf(E2eWriteRefused);
    // Nothing reached the network, and nothing was recorded as an exchange.
    expect(network).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  test('liveFetch allows the sign-in routes and sponsor sign', async () => {
    const calls: HttpCall[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'xo-sdk-e2e-allow-test-'));
    try {
      const fetchFn = liveFetch(calls, (service) => join(dir, service));
      // The requests of src/auth/backendAuth.ts (the SIWE nonce, the key mint, the revoke of a
      // key by id), src/auth/orderbookAuth.ts (derive, then create when derive finds none) and
      // the sponsor's sign-only twin of src/account/sponsorClient.ts's send.
      const allowed: Array<[string, string]> = [
        ['POST', `${backendUrl}/api/auth/api-keys/nonce`],
        // The mint answers key id 78, which this run may then revoke.
        ['POST', KEYS_URL],
        ['DELETE', `${KEYS_URL}/78`],
        ['GET', `${orderbookUrl}/auth/derive-api-key`],
        ['POST', `${orderbookUrl}/auth/api-key`],
        ['POST', `${sponsorUrl}/v1/sponsor/sign`],
        // The order book's batch reads: a POST that only reads.
        ['POST', `${orderbookUrl}/books`],
        ['POST', `${orderbookUrl}/midpoints`],
        ['POST', `${orderbookUrl}/prices`],
        ['POST', `${orderbookUrl}/spreads`],
        ['POST', `${orderbookUrl}/last-trades-prices`],
        // Every GET and HEAD is a read.
        ['GET', `${backendUrl}/api/markets?take=1`],
        ['GET', `${sponsorUrl}/health`],
        ['HEAD', `${orderbookUrl}/time`],
        ['get', `${orderbookUrl}/book?token_id=1`],
      ];
      for (const [method, url] of allowed) {
        const response = await fetchFn(url, {
          method,
          ...(method === 'POST' ? { body: '{}' } : {}),
        });
        expect(response.ok, `${method} ${url}`).toBe(true);
      }
      // A GET without an init.
      await fetchFn(`${orderbookUrl}/time`);
      expect(network).toHaveBeenCalledTimes(allowed.length + 1);
      expect(calls.map((c) => `${c.method} ${c.service} ${c.path}`)).toEqual([
        'POST backend /api/auth/api-keys/nonce',
        'POST backend /api/auth/api-keys',
        'DELETE backend /api/auth/api-keys/78',
        'GET orderbook /auth/derive-api-key',
        'POST orderbook /auth/api-key',
        'POST sponsor /v1/sponsor/sign',
        'POST orderbook /books',
        'POST orderbook /midpoints',
        'POST orderbook /prices',
        'POST orderbook /spreads',
        'POST orderbook /last-trades-prices',
        'GET backend /api/markets',
        'GET sponsor /health',
        'HEAD orderbook /time',
        'get orderbook /book',
        'GET orderbook /time',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('liveFetch reads a JSON-RPC body: a read passes, anything else is refused, in a batch too', async () => {
    const fetchFn = liveFetch([], () => join(tmpdir(), 'unused'));
    const post = (body: string) => fetchFn(rpcUrl, { method: 'POST', body });

    await expect(post(rpcBody('eth_call'))).resolves.toBeInstanceOf(Response);
    await expect(
      post(rpcBody('eth_chainId', 'eth_getCode', 'eth_estimateGas')),
    ).resolves.toBeInstanceOf(Response);
    // The names are compared without case.
    await expect(post(rpcBody('ETH_CALL'))).resolves.toBeInstanceOf(Response);
    expect(network).toHaveBeenCalledTimes(3);

    for (const body of [
      rpcBody('eth_sendRawTransaction'),
      rpcBody('eth_sendTransaction'),
      rpcBody('eth_call', 'eth_sendRawTransaction'),
      rpcBody('eth_sendRawTransactionSync'),
      rpcBody('wallet_sendCalls'),
      // A send in any case, or under another namespace.
      rpcBody('ETH_SENDRAWTRANSACTION'),
      rpcBody('Eth_SendTransaction'),
      rpcBody('personal_sendTransaction'),
      rpcBody('eth_call', 'personal_sendTransaction'),
      rpcBody('eth_chainId', 'ETH_SENDRAWTRANSACTION'),
      // Not a read the suite makes: signing, node state, or a method nobody listed.
      rpcBody('eth_sign'),
      rpcBody('eth_signTransaction'),
      rpcBody('debug_traceCall'),
      rpcBody('anvil_setBalance'),
      // A body the guard cannot read is not a read either.
      'not json',
      JSON.stringify({ jsonrpc: '2.0', id: 1 }),
    ]) {
      await expect(post(body), body).rejects.toBeInstanceOf(E2eWriteRefused);
    }
    // Not a string: the guard cannot see what it holds.
    await expect(
      fetchFn(rpcUrl, {
        method: 'POST',
        body: new Blob([rpcBody('eth_call')]),
      }),
    ).rejects.toBeInstanceOf(E2eWriteRefused);
    expect(network).toHaveBeenCalledTimes(3);
  });

  test('the RPC transport refuses to send a transaction', async () => {
    const methods: string[] = [];
    const transport = readOnlyRpc({ methods })({});
    for (const method of [
      'eth_sendRawTransaction',
      'eth_sendTransaction',
      'ETH_SENDRAWTRANSACTION',
      'personal_sendTransaction',
      'eth_sign',
    ]) {
      await expect(
        transport.request({ method, params: ['0x02'] } as never),
        method,
      ).rejects.toBeInstanceOf(E2eWriteRefused);
    }
    // Through a client, as a test would send one.
    const client = createPublicClient({ transport: readOnlyRpc({ methods }) });
    await expect(
      client.sendRawTransaction({ serializedTransaction: '0x02' }),
    ).rejects.toBeInstanceOf(E2eWriteRefused);
    expect(network).not.toHaveBeenCalled();
    expect(methods).toEqual([]);

    // eth_call passes, and is recorded.
    await expect(
      client.call({ to: zeroAddress, data: '0x12345678' }),
    ).resolves.toEqual({ data: '0x01' });
    expect(network).toHaveBeenCalledTimes(1);
    expect(methods).toEqual(['eth_call']);
    const [url, init] = network.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).origin).toBe(new URL(rpcUrl).origin);
    expect(JSON.parse(init.body as string).method).toBe('eth_call');
  });

  test('the RPC allowlist holds reads only', () => {
    expect(RPC_READ_METHODS.size).toBeGreaterThan(0);
    for (const method of RPC_READ_METHODS) {
      expect(method).toMatch(/^eth_/);
      expect(method).not.toMatch(/send|sign|submit|fill/i);
    }
  });

  test('a backend key may be revoked only when this run minted it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xo-sdk-e2e-revoke-test-'));
    try {
      const fetchFn = liveFetch([], (service) => join(dir, service));
      const mint = () => fetchFn(KEYS_URL, { method: 'POST', body: '{}' });
      const revoke = (id: number) =>
        fetchFn(`${KEYS_URL}/${id}`, { method: 'DELETE' });

      // Before the mint, and for any other id after it.
      vi.stubGlobal('fetch', answeringWithId(501));
      await expect(revoke(501)).rejects.toBeInstanceOf(E2eWriteRefused);
      await mint();
      await expect(revoke(501)).resolves.toBeInstanceOf(Response);
      await expect(revoke(502)).rejects.toThrow('not minted in this run');

      // A refused mint made no key, whatever its body says.
      vi.stubGlobal('fetch', answeringWithId(503, 409));
      await mint();
      await expect(revoke(503)).rejects.toBeInstanceOf(E2eWriteRefused);

      // An id answered by another route is not a minted backend key.
      vi.stubGlobal('fetch', answeringWithId(504));
      await fetchFn(`${orderbookUrl}/auth/api-key`, {
        method: 'POST',
        body: '{}',
      });
      await fetchFn(`${KEYS_URL}/nonce`, { method: 'POST', body: '{}' });
      await expect(revoke(504)).rejects.toBeInstanceOf(E2eWriteRefused);

      // The guard of the global fetch notes a mint too.
      const network = answeringWithId(505);
      vi.stubGlobal('fetch', network);
      const guarded = readOnlyFetch((input, init) => fetch(input, init));
      await guarded(KEYS_URL, { method: 'POST', body: '{}' });
      await expect(
        guarded(`${KEYS_URL}/505`, { method: 'DELETE' }),
      ).resolves.toBeInstanceOf(Response);
      await expect(
        guarded(`${KEYS_URL}/506`, { method: 'DELETE' }),
      ).rejects.toBeInstanceOf(E2eWriteRefused);
      expect(network).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the global guard puts the same rules on the global fetch, once', async () => {
    installReadOnlyGuard();
    installReadOnlyGuard();
    await expect(
      fetch(`${backendUrl}/api/orders`, { method: 'POST' }),
    ).rejects.toBeInstanceOf(E2eWriteRefused);
    await expect(
      fetch(rpcUrl, {
        method: 'POST',
        body: rpcBody('eth_sendRawTransaction'),
      }),
    ).rejects.toBeInstanceOf(E2eWriteRefused);
    expect(network).not.toHaveBeenCalled();
    await fetch(`${backendUrl}/api/markets`);
    await fetch(rpcUrl, { method: 'POST', body: rpcBody('eth_call') });
    // Installed twice, called once each: the second install wrapped nothing.
    expect(network).toHaveBeenCalledTimes(2);
  });
});

describe('e2eWallet', () => {
  const NAME = 'XO_E2E_WALLET_PK';
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[NAME];
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env[NAME];
    } else {
      process.env[NAME] = saved;
    }
  });

  test('is undefined when the variable is unset, empty or blank', () => {
    delete process.env[NAME];
    expect(e2eWallet()).toBeUndefined();
    for (const value of ['', '  \n']) {
      process.env[NAME] = value;
      expect(e2eWallet()).toBeUndefined();
    }
  });

  test('takes the key with or without 0x (or 0X), and ignores surrounding whitespace', () => {
    const key = '33'.repeat(32);
    const expected = privateKeyToAccount(`0x${key}`).address;
    for (const value of [key, `0x${key}`, `0X${key}`, `  ${key}\n`]) {
      process.env[NAME] = value;
      expect(e2eWallet()?.address).toBe(expected);
    }
  });

  test('names the variable, and never quotes the value, when it is not a private key', () => {
    for (const value of [
      'not-a-key-SENTINEL-4f9c2e',
      '33'.repeat(31),
      `0x${'33'.repeat(33)}`,
      `0x${'zz'.repeat(32)}`,
    ]) {
      process.env[NAME] = value;
      let thrown: unknown;
      try {
        e2eWallet();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      const error = thrown as Error;
      expect(error.message).toContain(NAME);
      expect(String(error)).not.toContain(value.slice(2, 20));
      expect(error.cause).toBeUndefined();
    }
  });
});

describe('assertEmptyWallet', () => {
  const EOA: Address = '0x1111111111111111111111111111111111111111';
  const SMART: Address = '0x2222222222222222222222222222222222222222';

  /** What one address holds and shows, as the backend would answer. */
  interface Account {
    positions?: number;
    private?: boolean;
    /** What the public portfolio throws instead of answering. */
    portfolioError?: Error;
  }

  /** The backend's answer for a wallet it does not know, as the SDK types it. */
  const unknownUser = () =>
    new RequestRejectedError('User not found', {
      status: 404,
      code: 'http_404',
    });

  /** One client of the e2e wallet (EOA or smart wallet), as far as assertEmptyWallet reads it. */
  function fakeClient(
    type: 'eoa' | 'smart_wallet',
    address: Address,
    account: Account,
    log: string[],
  ): E2eClient {
    const username = `user_${type}`;
    return {
      toJSON: () => ({ type, signer: true }),
      tradingAddress: async () => address,
      data: {
        account: {
          me: async () => {
            log.push(`${type} me`);
            return { username, isPrivate: account.private === true };
          },
        },
        profiles: {
          get: async (name: string) => {
            log.push(`${type} profile ${name}`);
            return { username: name, isPrivate: account.private === true };
          },
        },
        portfolio: {
          ofWallet: (owner: { wallet: Address }, params: unknown) => ({
            firstPage: async () => {
              log.push(
                `${type} portfolio ${owner.wallet} ${JSON.stringify(params)}`,
              );
              if (account.portfolioError !== undefined) {
                throw account.portfolioError;
              }
              return {
                items: Array.from(
                  { length: account.positions ?? 0 },
                  (_, id) => ({
                    id,
                  }),
                ),
              };
            },
          }),
        },
      },
      close: async () => {
        log.push(`${type} close`);
      },
    } as unknown as E2eClient;
  }

  /** assertEmptyWallet on fakes: the EOA and its smart wallet, and their USDC. */
  function check(o: {
    eoa?: Account;
    smart?: Account;
    usdc?: Partial<Record<Address, bigint>>;
    eoaType?: 'eoa' | 'smart_wallet';
    smartAddress?: Address;
  }): { run: () => Promise<void>; log: string[] } {
    const log: string[] = [];
    const client = fakeClient(o.eoaType ?? 'eoa', EOA, o.eoa ?? {}, log);
    const chain: WalletChainReads = {
      smartWalletOf: async (owner) => {
        expect(owner).toBe(EOA);
        return SMART;
      },
      usdcBalance: async (address) => o.usdc?.[address] ?? 0n,
    };
    const run = () =>
      assertEmptyWallet(client, {
        chain,
        smartWalletClient: async () =>
          fakeClient(
            'smart_wallet',
            o.smartAddress ?? SMART,
            o.smart ?? {},
            log,
          ),
        loginGap: async () => {
          log.push('gap');
        },
      });
    return { run, log };
  }

  const failure = (run: () => Promise<void>): Promise<unknown> =>
    run().then(
      () => undefined,
      (error: unknown) => error,
    );

  test('throws when the wallet holds USDC or positions, and passes when both are empty', async () => {
    const empty = check({});
    await expect(empty.run()).resolves.toBeUndefined();
    // Both addresses: each signs in after the login gap, its public profile is read, and its
    // portfolio over every status; the smart wallet's client is closed.
    expect(empty.log).toEqual([
      'gap',
      'eoa me',
      'eoa profile user_eoa',
      `eoa portfolio ${EOA} {"status":"all","take":1}`,
      'gap',
      'smart_wallet me',
      'smart_wallet profile user_smart_wallet',
      `smart_wallet portfolio ${SMART} {"status":"all","take":1}`,
      'smart_wallet close',
    ]);

    const holding: Array<[string, Parameters<typeof check>[0], Address]> = [
      ['USDC on the EOA', { usdc: { [EOA]: 1n } }, EOA],
      ['USDC on the smart wallet', { usdc: { [SMART]: 2_000_000n } }, SMART],
      ['a position of the EOA', { eoa: { positions: 1 } }, EOA],
      ['a position of the smart wallet', { smart: { positions: 3 } }, SMART],
    ];
    for (const [what, setup, names] of holding) {
      const { run, log } = check(setup);
      const error = await failure(run);
      expect(error, what).toBeInstanceOf(Error);
      expect((error as Error).message, what).toContain(names);
      // The smart wallet's client is closed, pass or fail.
      expect(log.at(-1), what).toBe('smart_wallet close');
    }
  });

  test('fails when the profile of the EOA or the smart wallet is private: its public portfolio would hide positions', async () => {
    for (const [what, setup, names] of [
      ['the EOA', { eoa: { private: true } }, EOA],
      ['the smart wallet', { smart: { private: true } }, SMART],
    ] as const) {
      const error = await failure(check(setup).run);
      expect(error, what).toBeInstanceOf(Error);
      expect((error as Error).message, what).toContain(names);
      expect((error as Error).message, what).toContain('private');
    }
  });

  test("only the backend's unknown-user 404 counts as no positions; any other error is thrown", async () => {
    await expect(
      check({
        eoa: { portfolioError: unknownUser() },
        smart: { portfolioError: unknownUser() },
      }).run(),
    ).resolves.toBeUndefined();

    for (const other of [
      // Another 404: a missing route, or a user lookup that says something else.
      new RequestRejectedError('backend responded 404', {
        status: 404,
        code: 'http_404',
      }),
      new RequestRejectedError('Market not found', {
        status: 404,
        code: 'http_404',
      }),
      new RequestRejectedError('User not found', {
        status: 404,
        code: 'user_not_found_v2',
      }),
      new Error('boom'),
    ]) {
      const error = await failure(
        check({ smart: { portfolioError: other } }).run,
      );
      expect(error, other.message).toBe(other);
    }
  });

  test('takes the EOA client only, and a smart wallet client of that EOA at index 0', async () => {
    await expect(check({ eoaType: 'smart_wallet' }).run()).rejects.toThrow(
      'EOA',
    );
    const other: Address = '0x3333333333333333333333333333333333333333';
    const { run, log } = check({ smartAddress: other });
    const error = await failure(run);
    expect((error as Error).message).toContain(other);
    expect(log.at(-1)).toBe('smart_wallet close');
  });
});

describe('loginGap', () => {
  let dir: string;
  let stamp: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    dir = mkdtempSync(join(tmpdir(), 'xo-sdk-e2e-gap-test-'));
    stamp = join(dir, 'last-login');
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Whether `loginGap` has finished, after the timers have run for `ms`. */
  async function settledAfter(ms: number): Promise<boolean> {
    let done = false;
    const pending = loginGap(stamp).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(ms);
    const result = done;
    // Let a wait that is still running finish, so no timer is left behind.
    await vi.advanceTimersByTimeAsync(2 * LOGIN_GAP_MS);
    await pending;
    return result;
  }

  test('does not wait when there is no earlier login', async () => {
    await expect(settledAfter(0)).resolves.toBe(true);
  });

  test('does not wait when the last login ended at least the gap ago', async () => {
    writeFileSync(stamp, String(Date.now() - LOGIN_GAP_MS));
    await expect(settledAfter(0)).resolves.toBe(true);
  });

  test('waits for the rest of the gap after a recent login', async () => {
    markLogin(stamp);
    vi.advanceTimersByTime(5_000);
    await expect(settledAfter(LOGIN_GAP_MS - 5_001)).resolves.toBe(false);
    markLogin(stamp);
    vi.advanceTimersByTime(5_000);
    await expect(settledAfter(LOGIN_GAP_MS - 5_000)).resolves.toBe(true);
  });

  test('never waits longer than the gap, even for a time in the future', async () => {
    writeFileSync(stamp, String(Date.now() + 3_600_000));
    await expect(settledAfter(LOGIN_GAP_MS)).resolves.toBe(true);
  });

  test('ignores a stamp that is not a number', async () => {
    writeFileSync(stamp, 'garbage');
    await expect(settledAfter(0)).resolves.toBe(true);
  });

  test('markLogin writes the time and nothing else', () => {
    markLogin(stamp);
    expect(readFileSync(stamp, 'utf8')).toBe(String(Date.now()));
  });
});

describe('call helpers', () => {
  test('revokeSucceeded counts the revokes of backend keys by id', () => {
    const call = (
      method: string,
      service: 'backend' | 'orderbook',
      path: string,
      status: number,
    ) => ({ method, service, path, status });
    expect(
      revokeSucceeded([
        call('GET', 'backend', '/api/auth/api-keys', 200),
        call('DELETE', 'backend', '/api/auth/api-keys/78', 204),
        call('DELETE', 'backend', '/api/auth/api-keys/79', 401),
        call('DELETE', 'orderbook', '/api/auth/api-keys/80', 204),
      ]),
    ).toEqual([true, false]);
  });

  test('unexpected leaves out the short-lived key warning only', () => {
    expect(
      unexpected([
        '@xomarket/client: no persistent credential store is set, so this session minted a short-lived (1-day) backend API key',
        'something else',
      ]),
    ).toEqual(['something else']);
  });
});

describe('per-service login stamps', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xo-sdk-e2e-fetch-test-'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  test('each service has its own stamp file', () => {
    expect(loginStampFile('backend')).not.toBe(loginStampFile('orderbook'));
  });

  test('liveFetch records every call, and stamps the service of a login request when it ends', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
    const stamp = (service: string) => join(dir, service);
    const calls: HttpCall[] = [];
    const fetchFn = liveFetch(calls, stamp);

    await fetchFn(`${orderbookUrl}/book?token_id=1`);
    await fetchFn(`${backendUrl}/api/markets`);
    expect(existsSync(stamp('backend'))).toBe(false);
    expect(existsSync(stamp('orderbook'))).toBe(false);

    await fetchFn(`${orderbookUrl}/auth/derive-api-key?address=0x1`);
    expect(existsSync(stamp('orderbook'))).toBe(true);
    expect(existsSync(stamp('backend'))).toBe(false);

    await fetchFn(`${backendUrl}/api/auth/api-keys/nonce`, { method: 'post' });
    expect(existsSync(stamp('backend'))).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.service} ${c.path}`)).toEqual([
      'GET orderbook /book',
      'GET backend /api/markets',
      'GET orderbook /auth/derive-api-key',
      'post backend /api/auth/api-keys/nonce',
    ]);
  });

  test('the key request of a backend login is POST /api/auth/api-keys: it stamps the backend, the key listing does not', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
    const stamp = (service: string) => join(dir, service);
    const fetchFn = liveFetch([], stamp);

    await fetchFn(`${backendUrl}/api/auth/api-keys`);
    expect(existsSync(stamp('backend'))).toBe(false);

    await fetchFn(`${backendUrl}/api/auth/api-keys`, { method: 'POST' });
    expect(existsSync(stamp('backend'))).toBe(true);
  });
});

describe('strictPublicClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('refuses a response field the SDK does not know, which the shipped client accepts', async () => {
    const network = vi.fn(async () =>
      Response.json({ state: 'active', surprise: 1 }),
    );
    vi.stubGlobal('fetch', network);
    const calls: HttpCall[] = [];

    const failure = await strictPublicClient({ calls })
      .fetchTradingState({ retries: 0 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(UnexpectedResponseError);
    expect(calls.map((c) => `${c.method} ${c.service} ${c.path}`)).toEqual([
      'GET orderbook /trading-state',
    ]);

    await expect(
      createXoPublicClient().fetchTradingState({ retries: 0 }),
    ).resolves.toBe('active');
  });

  test('is a frozen client with the members of the public client', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ state: 'paused' })),
    );
    const strict = strictPublicClient();
    expect(Object.isFrozen(strict)).toBe(true);
    expect(Object.keys(strict).sort()).toEqual(
      Object.keys(createXoPublicClient()).sort(),
    );
    await expect(strict.fetchTradingState()).resolves.toBe('paused');
  });
});
