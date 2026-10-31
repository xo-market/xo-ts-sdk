import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  test,
} from 'vitest';
import { resetNonceTracking } from '../../src/account/internal';
import { preflightRail } from '../../src/account/rails';
import { type RailKind, SessionRail } from '../../src/clients/rail';
import { type EnvironmentConfig, production } from '../../src/core/env';
import {
  AuthRequiredError,
  TransactionFailedError,
  UserInputError,
  XoError,
} from '../../src/core/errors';
import { Transport } from '../../src/core/transport';
import type { TradingIdentity } from '../../src/wallet/identity';
import {
  call,
  eoaIdentity,
  OWNER,
  ownerSigner,
  railChain,
  smartWalletIdentity,
  TX_HASH,
} from '../helpers/railChain';
import { testEnv } from '../helpers/testEnv';

// The facade's lazy rail: it sends from the session's identity, built once per identity.

const env = testEnv;
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetNonceTracking());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** A fake sponsor on `on`'s `sponsorUrl` (the test environment's by default) that accepts every send. */
function sponsor(on: EnvironmentConfig = env): { count: () => number } {
  let n = 0;
  server.use(
    http.post(`${on.sponsorUrl}/v1/sponsor/send`, () => {
      n += 1;
      return HttpResponse.json({ txHash: TX_HASH, executor: OWNER });
    }),
  );
  return { count: () => n };
}

function rail(
  identity: () => Promise<TradingIdentity>,
  kind: 'sponsored' | 'direct' = 'sponsored',
  isOpen: () => boolean = () => true,
) {
  const chain = railChain();
  let resolved = 0;
  const r = new SessionRail({
    kind,
    env,
    identity: () => {
      resolved += 1;
      return identity();
    },
    isOpen,
    signer: ownerSigner(),
    chain: chain.reader,
    transport: new Transport({ env, version: '0.0.0-test' }),
  });
  return { rail: r, chain, resolved: () => resolved };
}

async function failure(p: Promise<unknown>): Promise<XoError> {
  try {
    await p;
  } catch (error) {
    return error as XoError;
  }
  throw new Error('expected a rejection');
}

describe('SessionRail', () => {
  test('resolves the identity on every send, and builds the concrete rail once per identity', async () => {
    const sent = sponsor();
    const identity = smartWalletIdentity();
    const { rail: r, chain, resolved } = rail(async () => identity);
    await r.send([call(1)]);
    await r.send([call(2)]);
    expect(resolved()).toBe(2);
    expect(sent.count()).toBe(2);
    // One SponsoredRail: it remembered that the account is deployed after one code read.
    expect(chain.count('getCode')).toBe(1);
  });

  test('a new identity object gets a new concrete rail', async () => {
    sponsor();
    let current = smartWalletIdentity();
    const { rail: r, chain } = rail(async () => current);
    await r.send([call(1)]);
    current = smartWalletIdentity();
    await r.send([call(2)]);
    expect(chain.count('getCode')).toBe(2);
  });

  test("'direct' sends on a DirectRail", async () => {
    const sent = sponsor();
    const { rail: r, chain } = rail(async () => eoaIdentity(), 'direct');
    await r.send([call()]);
    expect(chain.count('sendRawTransaction')).toBe(1);
    expect(sent.count()).toBe(0);
  });

  test('an identity failure (an SDK error) is not sent: mayHaveLanded false, the error kept', async () => {
    const refused = new AuthRequiredError('no signer');
    const { rail: r, chain } = rail(() => Promise.reject(refused));
    const error = await failure(r.send([call()]));
    expect(error).toBe(refused);
    expect(error.mayHaveLanded).toBe(false);
    expect(chain.log).toEqual([]);
  });

  test('an identity failure of another kind becomes send_failed, mayHaveLanded false', async () => {
    const { rail: r, chain } = rail(() =>
      Promise.reject(new TypeError('https://rpc.example/key-123 is down')),
    );
    const error = await failure(r.send([call()]));
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect(error.code).toBe('send_failed');
    expect(error.mayHaveLanded).toBe(false);
    // Only the error's name is quoted: the message of a raw error can hold a URL with a key.
    expect(error.message).not.toContain('key-123');
    expect(error.message).toContain('TypeError');
    expect(chain.log).toEqual([]);
  });

  test('a closed client: session_closed, mayHaveLanded false, the identity not even resolved', async () => {
    const sent = sponsor();
    const {
      rail: r,
      chain,
      resolved,
    } = rail(
      async () => eoaIdentity(),
      'sponsored',
      () => false,
    );
    const error = await failure(r.send([call()]));
    expect(error).toBeInstanceOf(XoError);
    expect(error.code).toBe('session_closed');
    expect(error.mayHaveLanded).toBe(false);
    expect(resolved()).toBe(0);
    expect(chain.log).toEqual([]);
    expect(sent.count()).toBe(0);
  });

  test('closed while the identity resolves: nothing is sent', async () => {
    const sent = sponsor();
    let open = true;
    const { rail: r, chain } = rail(
      async () => {
        open = false;
        return eoaIdentity();
      },
      'sponsored',
      () => open,
    );
    const error = await failure(r.send([call()]));
    expect(error.code).toBe('session_closed');
    expect(error.mayHaveLanded).toBe(false);
    expect(chain.log).toEqual([]);
    expect(sent.count()).toBe(0);
  });

  test('concurrent first sends share one concrete rail: one code read for the smart wallet', async () => {
    const sent = sponsor();
    const identity = smartWalletIdentity();
    const { rail: r, chain } = rail(async () => identity);
    await Promise.all([r.send([call(1)]), r.send([call(2)])]);
    expect(sent.count()).toBe(2);
    expect(chain.count('getCode')).toBe(1);
  });

  test('without a signer it refuses with AuthRequiredError, nothing read', async () => {
    const chain = railChain();
    const r = new SessionRail({
      kind: 'sponsored',
      env,
      identity: async () => eoaIdentity(),
      isOpen: () => true,
      signer: undefined,
      chain: chain.reader,
      transport: new Transport({ env, version: '0.0.0-test' }),
    });
    const error = await failure(r.send([call()]));
    expect(error).toBeInstanceOf(AuthRequiredError);
    expect(error.mayHaveLanded).toBe(false);
    expect(chain.log).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The rail kind: 'auto' is the sponsored rail, for both wallet types
// ---------------------------------------------------------------------------

/** XO mainnet: the production sponsor, for plain wallets and smart wallets alike. */
const MAINNET = production;

/** A custom environment without a sponsor: the test environment's fields, its `sponsorUrl` left out. */
const { sponsorUrl: _testSponsor, ...TEST_FIELDS } = env;
const NO_SPONSOR: EnvironmentConfig = { ...TEST_FIELDS, name: 'no-sponsor' };

/**
 * An environment object that carries a `bundler` block. `resolveEnvironment`
 * refuses one, so a client never builds a rail for it; a `SessionRail` given one directly shows
 * that `'auto'` has no bundler branch left.
 */
function withLegacyBundler(on: EnvironmentConfig): EnvironmentConfig {
  return {
    ...on,
    name: `${on.name}-legacy-bundler`,
    bundler: {
      url: 'https://bundler.example.com/',
      entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
      paymaster: '0x2353B23D8F329fD3cEC0d21652F14208248A439d',
    },
  } as unknown as EnvironmentConfig;
}

/** Which service a send reached. */
type Reached = 'sponsor' | 'chain' | 'none';

/**
 * A SessionRail for `kind` over `railEnv` and `identity`, with a fake sponsor (on `railEnv`'s
 * `sponsorUrl`, the test environment's when it has none) and the chain stub, and a `send` helper that says which
 * of the two the send reached. Any other request (a bundler's, say) fails the test: the server
 * errors on an unhandled request.
 */
function reaching(
  kind: RailKind,
  railEnv: EnvironmentConfig,
  identity: TradingIdentity,
) {
  const sponsored = sponsor(railEnv.sponsorUrl === undefined ? env : railEnv);
  const chain = railChain();
  const r = new SessionRail({
    kind,
    env: railEnv,
    identity: async () => identity,
    isOpen: () => true,
    signer: ownerSigner(),
    chain: chain.reader,
    transport: new Transport({ env: railEnv, version: '0.0.0-test' }),
  });
  return {
    chain,
    sponsorCalls: () => sponsored.count(),
    async send() {
      const error = await r.send([call()]).then(
        () => undefined,
        (e: unknown) => e as XoError,
      );
      const reached: Reached[] = [];
      if (sponsored.count() > 0) {
        reached.push('sponsor');
      }
      if (chain.count('sendRawTransaction') > 0) {
        reached.push('chain');
      }
      return { error, reached: reached.length === 0 ? ['none'] : reached };
    },
    rail: r,
  };
}

describe("SessionRail kind 'auto' (the default)", () => {
  // 'auto' is the SponsoredRail whatever the identity and the environment: the fakes show
  // which service the send reached.
  type Row = [
    row: string,
    railEnv: EnvironmentConfig,
    identity: TradingIdentity,
    reached: Reached[],
    code?: string,
  ];
  const ROWS: Row[] = [
    [
      'a smart wallet on the test environment: the SponsoredRail',
      env,
      smartWalletIdentity(),
      ['sponsor'],
    ],
    [
      'an EOA on the test environment: the SponsoredRail',
      env,
      eoaIdentity(),
      ['sponsor'],
    ],
    [
      "a smart wallet on mainnet: the SponsoredRail, on mainnet's sponsor",
      MAINNET,
      smartWalletIdentity(),
      ['sponsor'],
    ],
    [
      "an EOA on mainnet: the SponsoredRail, on mainnet's sponsor",
      MAINNET,
      eoaIdentity(),
      ['sponsor'],
    ],
    [
      'a smart wallet on an environment without a sponsor: the SponsoredRail, which refuses sponsor_not_configured',
      NO_SPONSOR,
      smartWalletIdentity(),
      ['none'],
      'sponsor_not_configured',
    ],
    [
      'an EOA on an environment without a sponsor: the SponsoredRail, which refuses sponsor_not_configured',
      NO_SPONSOR,
      eoaIdentity(),
      ['none'],
      'sponsor_not_configured',
    ],
  ];

  it.each(ROWS)('%s', async (_row, railEnv, identity, reached, code) => {
    const rig = reaching('auto', railEnv, identity);
    const result = await rig.send();
    expect(result.reached).toEqual(reached);
    if (code === undefined) {
      expect(result.error).toBeUndefined();
    } else {
      expect(result.error).toBeInstanceOf(UserInputError);
      expect(result.error?.code).toBe(code);
      expect(result.error?.mayHaveLanded).toBe(false);
      // Not even a read: the identity was resolved and nothing else touched.
      expect(rig.chain.log).toEqual([]);
    }
  });

  it.each([
    ['a smart wallet', smartWalletIdentity()],
    ['an EOA', eoaIdentity()],
  ])(
    'has no bundler branch: %s on an environment object that still carries a bundler block goes to the sponsor',
    async (_, identity) => {
      const rig = reaching('auto', withLegacyBundler(env), identity);
      const result = await rig.send();
      expect(result.error).toBeUndefined();
      expect(result.reached).toEqual(['sponsor']);
    },
  );

  it.each([
    ['a smart wallet', smartWalletIdentity()],
    ['an EOA', eoaIdentity()],
  ])(
    'has no bundler branch: %s on one with a bundler block and no sponsor gets sponsor_not_configured, never gas_path_unavailable',
    async (_, identity) => {
      const rig = reaching('auto', withLegacyBundler(NO_SPONSOR), identity);
      for (const attempt of [1, 2]) {
        const result = await rig.send();
        expect(result.reached, `send ${attempt}`).toEqual(['none']);
        expect(result.error, `send ${attempt}`).toBeInstanceOf(UserInputError);
        expect(result.error?.code, `send ${attempt}`).toBe(
          'sponsor_not_configured',
        );
        expect(result.error?.mayHaveLanded, `send ${attempt}`).toBe(false);
      }
      expect(rig.chain.log).toEqual([]);
    },
  );
});

describe('SessionRail with an explicit rail', () => {
  it("'sponsored' is the SponsoredRail on every environment, with a sponsor or not", async () => {
    const rig = reaching('sponsored', NO_SPONSOR, smartWalletIdentity());
    const result = await rig.send();
    expect(result.reached).toEqual(['none']);
    expect(result.error).toBeInstanceOf(UserInputError);
    expect(result.error?.code).toBe('sponsor_not_configured');
    expect(result.error?.mayHaveLanded).toBe(false);

    const withSponsor = reaching('sponsored', env, eoaIdentity());
    expect((await withSponsor.send()).reached).toEqual(['sponsor']);
  });

  it.each([
    ['a plain wallet', eoaIdentity()],
    ['a smart wallet', smartWalletIdentity()],
  ])(
    "'sponsored' on mainnet sends %s through mainnet's sponsor",
    async (_, identity) => {
      const rig = reaching('sponsored', MAINNET, identity);
      const result = await rig.send();
      expect(result.error).toBeUndefined();
      expect(result.reached).toEqual(['sponsor']);
    },
  );

  it("'direct' is the DirectRail: an EOA pays its own gas on an environment without a sponsor, and on mainnet", async () => {
    for (const railEnv of [NO_SPONSOR, MAINNET]) {
      const rig = reaching('direct', railEnv, eoaIdentity());
      const result = await rig.send();
      expect(result.error, railEnv.name).toBeUndefined();
      expect(result.reached, railEnv.name).toEqual(['chain']);
    }
  });
});

describe("SessionRail: the preflight of 'auto' where there is no sponsor", () => {
  it.each([
    ['a plain wallet', eoaIdentity()],
    ['a smart wallet', smartWalletIdentity()],
  ])(
    'refuses %s with sponsor_not_configured before anything is read',
    async (_, identity) => {
      const rig = reaching('auto', NO_SPONSOR, identity);
      const error = await failure(preflightRail(rig.rail));
      expect(error).toBeInstanceOf(UserInputError);
      expect(error.code).toBe('sponsor_not_configured');
      expect(error.mayHaveLanded).toBe(false);
      expect(rig.chain.log).toEqual([]);
      expect(rig.sponsorCalls()).toBe(0);
    },
  );
});

describe('SessionRail on mainnet: the sponsor, for both wallet types', () => {
  it.each([
    ['a plain wallet', eoaIdentity()],
    ['a smart wallet', smartWalletIdentity()],
  ])(
    "the preflight of %s passes after two reads, the owner's latest and pending nonces, and calls no service",
    async (_, identity) => {
      const rig = reaching('auto', MAINNET, identity);
      await preflightRail(rig.rail);
      expect(rig.chain.log).toEqual([
        { method: 'getNonce', args: [OWNER, 'latest'] },
        { method: 'getNonce', args: [OWNER, 'pending'] },
      ]);
      expect(rig.sponsorCalls()).toBe(0);
    },
  );
});
