import { createPublicClient } from 'viem';
import { beforeAll, expect, test } from 'vitest';
import { XoError } from '../src/core/errors';
import { isSecureClient } from '../src/index';
import {
  assertEmptyWallet,
  describeSignedIn,
  e2eClient,
  e2eSigner,
  readOnlyRpc,
  revokeSucceeded,
  statusOf,
  trackClients,
  trackSessions,
  unexpected,
} from './setup';

// Signing in against the real mainnet services with the e2e wallet: its EOA through
// `createSecureClient`, then its smart wallet at index 0 through the session the client is
// built on. A client for an undeployed smart wallet deploys it with a sponsored transaction when
// it is created, which the suite never sends, so that test stays at the session. Each test mints
// a 1-day backend key (memory store) that `close()` revokes. Credentials are never printed: the
// assertions below compare to booleans, so a failure cannot show a key in a diff. The login gap
// (the services rate-limit by IP) is kept by `trackClients` and by the transport that
// liveSession builds.
const KEYS_PATH = '/api/auth/api-keys';
const ORDERS_PATH = '/data/orders';

const nonEmpty = (value: unknown): boolean =>
  typeof value === 'string' && value.length > 0;

describeSignedIn('Live auth on mainnet (signed in)', () => {
  // Closes every client and session after each test, pass or fail, so the keys are revoked, and
  // prints the wallets and the exchanges (statuses only).
  const clients = trackClients();
  const { start } = trackSessions();
  // ccipRead false: never follow an off-chain lookup that a contract asks for.
  const rpc = createPublicClient({ transport: readOnlyRpc(), ccipRead: false });

  beforeAll(async () => {
    const xo = await e2eClient();
    try {
      await assertEmptyWallet(xo);
    } finally {
      await xo.close();
    }
  });

  test('the EOA gets both credentials, and the backend and L2 routes answer 200', async () => {
    const { client, calls } = await clients.create();
    expect(isSecureClient(client)).toBe(true);

    const credentials = await client.exportCredentials();
    expect(credentials.backend.apiKey.startsWith('xo_sk_data_')).toBe(true);
    expect(
      nonEmpty(credentials.orderbook.apiKey) &&
        nonEmpty(credentials.orderbook.secret) &&
        nonEmpty(credentials.orderbook.passphrase),
    ).toBe(true);
    // The sign-in was the nonce and the key request, both accepted.
    for (const path of [`${KEYS_PATH}/nonce`, KEYS_PATH]) {
      const status = statusOf(calls, 'POST', 'backend', path) ?? 0;
      expect(status >= 200 && status < 300, `POST ${path}`).toBe(true);
    }

    // The client sends the key on the backend (Bearer) and the L2 HMAC on the order book.
    await client.listApiKeys().firstPage();
    await client.listOpenOrders().firstPage();
    expect(statusOf(calls, 'GET', 'backend', KEYS_PATH)).toBe(200);
    expect(statusOf(calls, 'GET', 'orderbook', ORDERS_PATH)).toBe(200);

    // The memory store gives a 1-day key, which close() revokes with a DELETE on its id.
    await client.close();
    expect(revokeSucceeded(calls)).toEqual([true]);
  });

  test('the smart wallet gets the backend key; the orderbook login needs it deployed', async () => {
    // The gateway checks a smart wallet signature with EIP-1271 on chain, so an undeployed
    // smart wallet cannot get orderbook credentials. The wallet signs a plain SIWE message for
    // the backend, which works before deployment. The suite never deploys it (that is a
    // transaction), so it is undeployed unless someone deployed it by hand: then the orderbook
    // login must succeed instead.
    const signer = e2eSigner();
    const live = start(signer, { type: 'smart_wallet', index: 0 });
    const { session, transport, calls } = live;

    const identity = await session.identity();
    expect(identity.type).toBe('smart_wallet');
    expect(identity.owner).toBe(signer.address);
    expect(identity.address).not.toBe(signer.address);

    const backend = await session.ensureBackend();
    expect(backend.key.startsWith('xo_sk_data_')).toBe(true);
    await transport.request({
      service: 'backend',
      method: 'GET',
      path: KEYS_PATH,
      auth: 'backend',
    });
    expect(statusOf(calls, 'GET', 'backend', KEYS_PATH)).toBe(200);

    const code = await rpc.getCode({ address: identity.address });
    const deployed = code !== undefined && code !== '0x';
    console.info(
      `[e2e] smart wallet ${identity.address} is ${deployed ? '' : 'not '}deployed`,
    );
    if (deployed) {
      const orderbook = await session.ensureOrderbook();
      expect(
        nonEmpty(orderbook.apiKey) &&
          nonEmpty(orderbook.secret) &&
          nonEmpty(orderbook.passphrase),
      ).toBe(true);
      await transport.request({
        service: 'orderbook',
        method: 'GET',
        path: ORDERS_PATH,
        auth: 'orderbook',
      });
      expect(statusOf(calls, 'GET', 'orderbook', ORDERS_PATH)).toBe(200);
    } else {
      // isDeployed (eth_getCode) answers false, and the login stops before anything is signed.
      const signed = live.signatures();
      const failure = await session.ensureOrderbook().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(XoError);
      expect((failure as XoError).code).toBe('smart_wallet_not_deployed');
      expect(live.signatures()).toBe(signed);
      // Nothing was asked of the gateway either, except possibly the clock.
      expect(
        calls.filter(
          (call) => call.service === 'orderbook' && call.path !== '/time',
        ),
      ).toEqual([]);
    }

    await session.close();
    expect(revokeSucceeded(calls)).toEqual([true]);
    expect(unexpected(live.warnings)).toEqual([]);
  });
});
