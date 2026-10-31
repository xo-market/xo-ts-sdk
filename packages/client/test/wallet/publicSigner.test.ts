import { inspect } from 'node:util';
import {
  createWalletClient,
  custom,
  type Hex,
  recoverAddress,
  recoverMessageAddress,
  recoverTypedDataAddress,
  stringToHex,
} from 'viem';
import { privateKeyToAccount, toAccount } from 'viem/accounts';
import { describe, expect, test, vi } from 'vitest';
import { SigningError, UserInputError } from '../../src/core/errors';
import { clobAuthTypedData } from '../../src/signing/clobAuth';
import { orderTypedData } from '../../src/signing/order';
import {
  privateKey,
  type Signer,
  signerFrom,
  toInternalSigner,
} from '../../src/wallet/publicSigner';
import { keySigner } from '../helpers/signers';
import { clobAuthVector, DOMAIN, ORDER, orderVector } from '../signing/helpers';

const { inputs } = clobAuthVector;
const KEY = inputs.privateKey;
const ADDRESS = inputs.address;
const KEY_BODY = KEY.slice(2);

const CLOB_AUTH = clobAuthTypedData({
  address: inputs.address,
  timestamp: inputs.timestamp,
  nonce: BigInt(inputs.nonce),
  chainId: inputs.chainId,
});
const ORDER_TYPED_DATA = orderTypedData(ORDER, DOMAIN);

/** A wallet client over a local account. Its transport must never be reached: local accounts sign offline. */
function localWalletClient() {
  const request = vi.fn(async () => {
    throw new Error('the transport must not be used to sign locally');
  });
  const wc = createWalletClient({
    account: privateKeyToAccount(KEY),
    transport: custom({ request }),
  });
  return { wc, request };
}

/** A local account that has no raw `sign`. */
function accountWithoutSign() {
  const local = privateKeyToAccount(KEY);
  return toAccount({
    address: local.address,
    signMessage: (p) => local.signMessage(p),
    signTypedData: (td) => local.signTypedData(td),
    signTransaction: (tx) => local.signTransaction(tx),
  });
}

/** What an implementation of the public Signer written by hand looks like. */
function handWritten(overrides: Partial<Signer> = {}) {
  const local = privateKeyToAccount(KEY);
  const getAddress = vi.fn(async () => local.address);
  const signer: Signer = {
    getAddress,
    signMessage: async (message) => local.signMessage({ message }),
    signTypedData: async (td) => local.signTypedData(td),
    ...overrides,
  };
  return { signer, getAddress };
}

describe('privateKey', () => {
  test('is the address of the vector key', async () => {
    expect(await privateKey(KEY).getAddress()).toBe(ADDRESS);
    // A literal, so a bad vector load cannot make both sides wrong together.
    expect(await privateKey(KEY).getAddress()).toBe(
      '0x14791697260E4c9A71f18484C9f997B308e59325',
    );
  });

  test('accepts an upper-case key and any string at compile time', async () => {
    expect(await privateKey(`0x${KEY_BODY.toUpperCase()}`).getAddress()).toBe(
      ADDRESS,
    );
  });

  test('signs the ClobAuth vector to the golden signature, as the viem account does', async () => {
    const signature = await privateKey(KEY).signTypedData(CLOB_AUTH);
    expect(signature).toBe(clobAuthVector.expectedSignature);
    expect(signature).toBe(await keySigner(KEY).signTypedData(CLOB_AUTH));
    expect(await recoverTypedDataAddress({ ...CLOB_AUTH, signature })).toBe(
      ADDRESS,
    );
  });

  test('signs the ClobAuth digest raw to the golden signature', async () => {
    const { signHash } = privateKey(KEY);
    if (signHash === undefined) {
      throw new Error('privateKey must provide signHash');
    }
    const signature = await signHash(clobAuthVector.expectedDigest);
    expect(signature).toBe(clobAuthVector.expectedSignature);
    expect(
      await recoverAddress({ hash: clobAuthVector.expectedDigest, signature }),
    ).toBe(ADDRESS);
  });

  test('signs the order vector to the same signature as the viem account', async () => {
    const old = keySigner(KEY);
    const signer = privateKey(KEY);
    const typed = await signer.signTypedData(ORDER_TYPED_DATA);
    expect(typed).toBe(await old.signTypedData(ORDER_TYPED_DATA));
    expect(
      await recoverTypedDataAddress({ ...ORDER_TYPED_DATA, signature: typed }),
    ).toBe(ADDRESS);
    // The same digest, signed raw: the exchange recovers the signer from it.
    const raw = await (signer.signHash as (h: Hex) => Promise<Hex>)(
      orderVector.expectedDigest,
    );
    expect(raw).toBe(
      await (old.signHash as (h: Hex) => Promise<Hex>)(
        orderVector.expectedDigest,
      ),
    );
    expect(raw).toBe(typed);
  });

  test('signs a message that recovers to the address', async () => {
    const signature = await privateKey(KEY).signMessage('hello xo');
    expect(signature).toBe(await keySigner(KEY).signMessage('hello xo'));
    expect(
      await recoverMessageAddress({ message: 'hello xo', signature }),
    ).toBe(ADDRESS);
  });

  test('has getAddress and the sign functions, nothing else', () => {
    const signer = privateKey(KEY);
    expect(Object.keys(signer).sort()).toEqual([
      'getAddress',
      'signHash',
      'signMessage',
      'signTypedData',
    ]);
    for (const value of Object.values(signer)) {
      expect(typeof value).toBe('function');
    }
  });

  test('never shows the private key to JSON.stringify or util.inspect', () => {
    const signer = privateKey(KEY);
    const views = [
      JSON.stringify(signer),
      inspect(signer),
      inspect(signer, { showHidden: true, depth: null, getters: true }),
      String(signer),
      JSON.stringify(Object.getOwnPropertyDescriptors(signer)),
    ];
    for (const view of views) {
      expect(view.toLowerCase()).not.toContain(KEY_BODY);
    }
    expect(JSON.parse(JSON.stringify(signer))).toEqual({});
  });

  test.each([
    ['too short', '0x12'],
    ['31 bytes', `0x${'ab'.repeat(31)}`],
    ['33 bytes', `0x${'ab'.repeat(33)}`],
    ['not hex', `0x${'zz'.repeat(32)}`],
    ['no 0x prefix', KEY_BODY],
    ['empty', ''],
    ['the zero key', `0x${'00'.repeat(32)}`],
    ['a key above the curve order', `0x${'ff'.repeat(32)}`],
  ])(
    'rejects a malformed key (%s) as invalid_private_key, without echoing it',
    (_label, bad) => {
      let caught: unknown;
      try {
        privateKey(bad);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(UserInputError);
      const error = caught as UserInputError;
      expect(error.code).toBe('invalid_private_key');
      expect(error.message.startsWith('privateKey ')).toBe(true);
      expect(error.cause).toBeUndefined();
      const shown = `${error.message}${JSON.stringify(error)}${inspect(error)}`;
      if (bad !== '') {
        expect(shown).not.toContain(bad);
      }
      if (bad.length > 4) {
        expect(shown).not.toContain(bad.slice(2));
      }
    },
  );

  test('the message of a short key never contains it', () => {
    let caught: unknown;
    try {
      privateKey('0x12');
    } catch (error) {
      caught = error;
    }
    const error = caught as UserInputError;
    expect(error).toBeInstanceOf(UserInputError);
    expect(error.code).toBe('invalid_private_key');
    expect(error.message).not.toContain('0x12');
    expect(error.message).not.toContain('12');
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 123],
    ['a bigint', 123n],
    ['an object', { key: KEY }],
  ])('rejects %s as a key with invalid_private_key', (_label, bad) => {
    let caught: unknown;
    try {
      privateKey(bad as unknown as string);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UserInputError);
    expect((caught as UserInputError).code).toBe('invalid_private_key');
    expect(
      `${(caught as Error).message}${inspect(caught)}`.toLowerCase(),
    ).not.toContain(KEY_BODY);
  });
});

describe('signerFrom a local account', () => {
  test('is the account, with signHash', async () => {
    const signer = signerFrom(privateKeyToAccount(KEY));
    expect(await signer.getAddress()).toBe(ADDRESS);
    expect(Object.keys(signer).sort()).toEqual([
      'getAddress',
      'signHash',
      'signMessage',
      'signTypedData',
    ]);
    expect(await signer.signTypedData(CLOB_AUTH)).toBe(
      clobAuthVector.expectedSignature,
    );
    expect(
      await (signer.signHash as (h: Hex) => Promise<Hex>)(
        clobAuthVector.expectedDigest,
      ),
    ).toBe(clobAuthVector.expectedSignature);
    expect(
      await recoverMessageAddress({
        message: 'm',
        signature: await signer.signMessage('m'),
      }),
    ).toBe(ADDRESS);
  });

  test('has no signHash property when the account has no sign', async () => {
    const account = accountWithoutSign();
    expect(account.sign).toBeUndefined();
    const signer = signerFrom(account);
    expect('signHash' in signer).toBe(false);
    expect(signer.signHash).toBeUndefined();
    expect(await signer.signTypedData(CLOB_AUTH)).toBe(
      clobAuthVector.expectedSignature,
    );
  });

  test('checksums the address of the account', async () => {
    const local = privateKeyToAccount(KEY);
    const account = toAccount({
      address: ADDRESS.toLowerCase() as Hex,
      signMessage: (p) => local.signMessage(p),
      signTypedData: (td) => local.signTypedData(td),
      signTransaction: (tx) => local.signTransaction(tx),
    });
    expect(await signerFrom(account).getAddress()).toBe(ADDRESS);
  });

  test('does not leak the account through JSON.stringify or util.inspect', () => {
    const signer = signerFrom(privateKeyToAccount(KEY));
    expect(JSON.parse(JSON.stringify(signer))).toEqual({});
    expect(
      inspect(signer, { showHidden: true, depth: null }).toLowerCase(),
    ).not.toContain(KEY_BODY);
  });
});

describe('signerFrom a wallet client', () => {
  test('has no signHash property', () => {
    const signer = signerFrom(localWalletClient().wc);
    expect(signer.signHash).toBeUndefined();
    expect('signHash' in signer).toBe(false);
    expect(Object.keys(signer).sort()).toEqual([
      'getAddress',
      'signMessage',
      'signTypedData',
    ]);
  });

  test('is the address of the client account', async () => {
    expect(await signerFrom(localWalletClient().wc).getAddress()).toBe(ADDRESS);
  });

  test('signs offline, as the account', async () => {
    const { wc, request } = localWalletClient();
    const signer = signerFrom(wc);
    expect(await signer.signTypedData(CLOB_AUTH)).toBe(
      clobAuthVector.expectedSignature,
    );
    expect(await signer.signTypedData(ORDER_TYPED_DATA)).toBe(
      await privateKey(KEY).signTypedData(ORDER_TYPED_DATA),
    );
    expect(
      await recoverMessageAddress({
        message: 'hello xo',
        signature: await signer.signMessage('hello xo'),
      }),
    ).toBe(ADDRESS);
    expect(request).not.toHaveBeenCalled();
  });

  test('keeps signing as the account it was created with', async () => {
    const { wc } = localWalletClient();
    const signer = signerFrom(wc);
    Object.assign(wc, {
      account: privateKeyToAccount(`0x${'11'.repeat(32)}` as Hex),
    });
    expect(await signer.getAddress()).toBe(ADDRESS);
    expect(await signer.signTypedData(CLOB_AUTH)).toBe(
      clobAuthVector.expectedSignature,
    );
  });

  test('signs through a JSON-RPC account with personal_sign', async () => {
    const signature = await privateKeyToAccount(KEY).signMessage({
      message: 'hello xo',
    });
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'personal_sign') {
        return signature;
      }
      throw new Error(`unexpected ${method}`);
    });
    const wc = createWalletClient({
      account: ADDRESS,
      transport: custom({ request }),
    });
    const signer = signerFrom(wc);
    expect(await signer.getAddress()).toBe(ADDRESS);
    expect(await signer.signMessage('hello xo')).toBe(signature);
    expect(request.mock.calls[0]?.[0]).toEqual({
      method: 'personal_sign',
      params: [stringToHex('hello xo'), ADDRESS],
    });
  });

  test('requires an account on the client', () => {
    const wc = createWalletClient({
      transport: custom({ request: async () => null }),
    });
    expect(() => signerFrom(wc)).toThrow(UserInputError);
    expect(() => signerFrom(wc)).toThrow(/account/);
  });
});

describe('signerFrom a wallet client: the account', () => {
  test('passes the account explicitly to every sign call', async () => {
    const { wc } = localWalletClient();
    const signMessage = vi.spyOn(wc, 'signMessage');
    const signTypedData = vi.spyOn(wc, 'signTypedData');
    const signer = signerFrom(wc);
    await signer.signMessage('hello xo');
    await signer.signTypedData(CLOB_AUTH);
    expect(signMessage).toHaveBeenCalledTimes(1);
    expect(signMessage.mock.calls[0]?.[0]).toMatchObject({
      account: wc.account,
      message: 'hello xo',
    });
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(signTypedData.mock.calls[0]?.[0]).toMatchObject({
      account: wc.account,
      primaryType: 'ClobAuth',
    });
  });

  test('does not let the typed data pick another account', async () => {
    const { wc } = localWalletClient();
    const other = privateKeyToAccount(`0x${'11'.repeat(32)}` as Hex);
    const signature = await signerFrom(wc).signTypedData({
      ...CLOB_AUTH,
      account: other,
    } as never);
    expect(signature).toBe(clobAuthVector.expectedSignature);
  });
});

describe('every adapter signs to plain hex', () => {
  test('is a plain object whose methods return promises of plain hex', async () => {
    const signers: Signer[] = [
      privateKey(KEY),
      signerFrom(privateKeyToAccount(KEY)),
      signerFrom(localWalletClient().wc),
    ];
    for (const signer of signers) {
      const results = [
        signer.signMessage('m'),
        signer.signTypedData(CLOB_AUTH),
      ];
      for (const result of results) {
        expect(result).toBeInstanceOf(Promise);
        const value = await result;
        expect(typeof value).toBe('string');
        expect(value).toMatch(/^0x[0-9a-f]{130}$/);
      }
    }
  });
});

describe('signerFrom rejects anything else', () => {
  test.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', ADDRESS],
    ['a private key', KEY],
    ['a number', 1],
    ['an array', []],
    ['an empty object', {}],
    ['an object with only an address', { address: ADDRESS }],
    ['a public Signer', handWritten().signer],
  ])('%s', (_label, bad) => {
    expect(() => signerFrom(bad as never)).toThrow(UserInputError);
  });
});

describe('every adapter is frozen', () => {
  const OTHER = privateKeyToAccount(`0x${'11'.repeat(32)}` as Hex).address;
  const cases: Array<[string, () => Signer]> = [
    ['privateKey', () => privateKey(KEY)],
    ['signerFrom an account', () => signerFrom(privateKeyToAccount(KEY))],
    [
      'signerFrom an account without sign',
      () => signerFrom(accountWithoutSign()),
    ],
    ['signerFrom a wallet client', () => signerFrom(localWalletClient().wc)],
  ];

  test.each(cases)('%s cannot be changed', async (_label, make) => {
    const signer = make();
    const writable = signer as unknown as Record<string, unknown>;
    const before = { ...signer };
    const hadSignHash = 'signHash' in signer;
    expect(Object.isFrozen(signer)).toBe(true);
    for (const name of ['getAddress', 'signMessage', 'signTypedData']) {
      expect(() => {
        writable[name] = async () => OTHER;
      }, name).toThrow(TypeError);
    }
    expect(() => {
      writable.signHash = async () => '0x';
    }).toThrow(TypeError);
    expect(() => {
      writable.address = OTHER;
    }).toThrow(TypeError);
    expect(() => {
      delete writable.getAddress;
    }).toThrow(TypeError);
    expect({ ...signer }).toEqual(before);
    expect(await signer.getAddress()).toBe(ADDRESS);
    expect('signHash' in signer).toBe(hadSignHash);
    expect(await signer.signTypedData(CLOB_AUTH)).toBe(
      clobAuthVector.expectedSignature,
    );
  });
});

describe('toInternalSigner', () => {
  test('asks for the address once and keeps it', async () => {
    const { signer, getAddress } = handWritten();
    const internal = await toInternalSigner(signer);
    expect(getAddress).toHaveBeenCalledTimes(1);
    expect(internal.address).toBe(ADDRESS);
    await internal.signMessage('a');
    await internal.signTypedData(CLOB_AUTH);
    expect(internal.address).toBe(ADDRESS);
    expect(getAddress).toHaveBeenCalledTimes(1);
  });

  test('returns the internal shape: an address and the sign functions', async () => {
    const internal = await toInternalSigner(privateKey(KEY));
    expect(Object.keys(internal).sort()).toEqual([
      'address',
      'signHash',
      'signMessage',
      'signTypedData',
    ]);
    expect(typeof internal.address).toBe('string');
    expect(Object.isFrozen(internal)).toBe(true);
    expect(JSON.parse(JSON.stringify(internal))).toEqual({ address: ADDRESS });
    expect(inspect(internal, { showHidden: true }).toLowerCase()).not.toContain(
      KEY_BODY,
    );
  });

  test('signs the golden vectors through the internal signer', async () => {
    const internal = await toInternalSigner(privateKey(KEY));
    expect(await internal.signTypedData(CLOB_AUTH)).toBe(
      clobAuthVector.expectedSignature,
    );
    expect(
      await (internal.signHash as (h: Hex) => Promise<Hex>)(
        clobAuthVector.expectedDigest,
      ),
    ).toBe(clobAuthVector.expectedSignature);
    expect(await internal.signTypedData(ORDER_TYPED_DATA)).toBe(
      await keySigner(KEY).signTypedData(ORDER_TYPED_DATA),
    );
    expect(
      await recoverMessageAddress({
        message: 'm',
        signature: await internal.signMessage('m'),
      }),
    ).toBe(ADDRESS);
  });

  test('has no signHash when the signer has none', async () => {
    for (const signer of [
      signerFrom(localWalletClient().wc),
      signerFrom(accountWithoutSign()),
      handWritten().signer,
    ]) {
      const internal = await toInternalSigner(signer);
      expect('signHash' in internal).toBe(false);
      expect(internal.signHash).toBeUndefined();
    }
  });

  test('checksums the address a custom signer returns', async () => {
    const { signer } = handWritten({
      getAddress: async () => ADDRESS.toLowerCase() as Hex,
    });
    expect((await toInternalSigner(signer)).address).toBe(ADDRESS);
  });

  test('keeps `this` for a signer written as a class', async () => {
    const local = privateKeyToAccount(KEY);
    class Custom implements Signer {
      readonly #account = local;
      async getAddress() {
        return this.#account.address;
      }
      async signMessage(message: string) {
        return this.#account.signMessage({ message });
      }
      async signTypedData(td: Parameters<Signer['signTypedData']>[0]) {
        return this.#account.signTypedData(td);
      }
      async signHash(hash: Hex) {
        return (this.#account.sign as NonNullable<typeof local.sign>)({
          hash,
        });
      }
    }
    const internal = await toInternalSigner(new Custom());
    expect(internal.address).toBe(ADDRESS);
    expect(await internal.signTypedData(CLOB_AUTH)).toBe(
      clobAuthVector.expectedSignature,
    );
    expect(
      await (internal.signHash as (h: Hex) => Promise<Hex>)(
        clobAuthVector.expectedDigest,
      ),
    ).toBe(clobAuthVector.expectedSignature);
  });

  test('rejects an address that is not an address, naming signer.address', async () => {
    const { signer } = handWritten({
      getAddress: async () => '0x1234' as Hex,
    });
    const error = await toInternalSigner(signer).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UserInputError);
    expect(
      (error as UserInputError).message.startsWith('signer.address '),
    ).toBe(true);
  });

  test('turns a getAddress that throws into a SigningError that names only the error type', async () => {
    const secret = 'https://node.invalid/v1/SECRETKEY';
    const { signer } = handWritten({
      getAddress: async () => {
        throw new TypeError(secret);
      },
    });
    const error = await toInternalSigner(signer).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SigningError);
    const signingError = error as SigningError;
    expect(signingError.code).toBe('signing_failed');
    expect(signingError.message).toContain('TypeError');
    expect(`${signingError.message}${inspect(signingError)}`).not.toContain(
      'SECRETKEY',
    );
    expect(signingError.cause).toBeUndefined();
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', ADDRESS],
    ['an object with only an address', { address: ADDRESS }],
    ['the internal signer shape', keySigner(KEY)],
    ['a signer without signMessage', { getAddress: async () => ADDRESS }],
  ])('rejects %s', async (_label, bad) => {
    const error = await toInternalSigner(bad as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).message.startsWith('signer ')).toBe(true);
  });

  test('a signHash that is not a function counts as none', async () => {
    const { signer } = handWritten({ signHash: 'nope' as never });
    const internal = await toInternalSigner(signer);
    expect('signHash' in internal).toBe(false);
  });
});
