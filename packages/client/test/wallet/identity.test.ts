import { inspect } from 'node:util';
import {
  type Address,
  concat,
  createWalletClient,
  custom,
  encodeAbiParameters,
  type Hex,
  hashTypedData,
  keccak256,
  recoverAddress,
  recoverTypedDataAddress,
  size,
  slice,
  stringToHex,
} from 'viem';
import { privateKeyToAccount, toAccount } from 'viem/accounts';
import { describe, expect, test, vi } from 'vitest';
import { SigningError, UserInputError, XoError } from '../../src/core/errors';
import {
  encodeKernelSignature,
  kernelCreateAccountCalldata,
  kernelWrapTypedData,
} from '../../src/signing/kernel';
import { orderTypedData } from '../../src/signing/order';
import {
  resolveTradingIdentity,
  signAsTrader,
  type TradingIdentity,
  type WalletInput,
} from '../../src/wallet/identity';
import type { InternalSigner } from '../../src/wallet/signer';
import { keySigner, walletClientSigner } from '../helpers/signers';
import { testEnv } from '../helpers/testEnv';
import {
  clobAuthVector,
  DOMAIN,
  kernelVector,
  ORDER,
  orderVector,
} from '../signing/helpers';

const env = testEnv;
const { createAccount, wrap } = kernelVector;
const KEY = clobAuthVector.inputs.privateKey;
const OWNER = createAccount.owner;
const ACCOUNT = createAccount.expectedAccount;
const ORDER_TD = orderTypedData(ORDER, DOMAIN);
const UINT256_MAX = (1n << 256n) - 1n;

/** A 32-byte ABI-encoded address, as an `eth_call` of `createAccount` returns it. */
const pad32 = (address: string): Hex =>
  `0x${'00'.repeat(12)}${address.slice(2)}` as Hex;
const PADDED_ACCOUNT = pad32(ACCOUNT.toLowerCase());

/** A `readContract` that answers with `result`. */
const answering = (result: unknown) =>
  vi.fn(async (_call: { to: Address; data: Hex }) => result as Hex);

/** The Kernel wrap written without viem's typed-data code, from the structure of kernel.json `wrap`. */
function wrapDigest(hash: Hex, verifyingContract: Address, id: number): Hex {
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        keccak256(stringToHex(wrap.typeStrings.EIP712Domain)),
        keccak256(stringToHex(wrap.domain.name)),
        keccak256(stringToHex(wrap.domain.version)),
        BigInt(id),
        verifyingContract,
      ],
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }],
      [keccak256(stringToHex(wrap.typeStrings.Kernel)), hash],
    ),
  );
  return keccak256(concat(['0x1901', domainSeparator, structHash]));
}

/** A signer made of spies, to prove when signing is (not) reached. */
function spySigner(address: Address, ...answer: [signature?: unknown]) {
  // `spySigner(a, undefined)` answers undefined; `spySigner(a)` answers a valid signature.
  const signature = answer.length === 0 ? `0x${'ab'.repeat(64)}1b` : answer[0];
  const signTypedData = vi.fn(async () => signature as Hex);
  const signMessage = vi.fn(async () => signature as Hex);
  const signer: InternalSigner = { address, signMessage, signTypedData };
  return { signer, signTypedData, signMessage };
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

const signer = keySigner(KEY);

const eoaIdentity: TradingIdentity = {
  type: 'eoa',
  owner: OWNER,
  address: OWNER,
  signatureType: 0,
};
const smartWalletIdentity: TradingIdentity = {
  type: 'smart_wallet',
  owner: OWNER,
  address: ACCOUNT,
  signatureType: 3,
  index: 0n,
};
const OTHER = privateKeyToAccount(`0x${'11'.repeat(32)}` as Hex).address;

describe('the vectors', () => {
  test('the pinned addresses are the ones in the vectors', () => {
    // Literals on purpose: they do not come from the vector files, so a bad vector load shows up.
    expect(signer.address).toBe('0x14791697260E4c9A71f18484C9f997B308e59325');
    expect(OWNER).toBe('0x14791697260E4c9A71f18484C9f997B308e59325');
    expect(ACCOUNT).toBe('0xEc4222650Aae70681B8e89447D8Cf607c1851a1b');
  });

  test('the vector key owns the Kernel vector account', () => {
    expect(signer.address).toBe(OWNER);
    expect(wrap.domain.name).toBe('Kernel');
  });

  test('the hand-written wrap digest matches kernel.json', () => {
    expect(
      wrapDigest(wrap.inputs.hash, wrap.inputs.account, wrap.inputs.chainId),
    ).toBe(wrap.expectedDigest);
  });
});

describe('resolveTradingIdentity: eoa', () => {
  test('is the owner itself with signatureType 0', async () => {
    const readContract = answering(PADDED_ACCOUNT);
    const identity = await resolveTradingIdentity(
      signer,
      { type: 'eoa' },
      env,
      readContract,
    );
    expect(identity).toEqual({
      type: 'eoa',
      owner: OWNER,
      address: OWNER,
      signatureType: 0,
    });
    expect('index' in identity).toBe(false);
  });

  test('never calls readContract', async () => {
    const readContract = answering(PADDED_ACCOUNT);
    await resolveTradingIdentity(signer, { type: 'eoa' }, env, readContract);
    expect(readContract).not.toHaveBeenCalled();
  });

  test('checksums the owner', async () => {
    const lower = spySigner(OWNER.toLowerCase() as Address).signer;
    const identity = await resolveTradingIdentity(
      lower,
      { type: 'eoa' },
      env,
      answering('0x'),
    );
    expect(identity.owner).toBe(OWNER);
    expect(identity.address).toBe(OWNER);
  });
});

describe('resolveTradingIdentity: smart_wallet', () => {
  test('resolves the vector account with signatureType 3', async () => {
    const readContract = answering(PADDED_ACCOUNT);
    const identity = await resolveTradingIdentity(
      signer,
      { type: 'smart_wallet' },
      env,
      readContract,
    );
    expect(identity).toEqual({
      type: 'smart_wallet',
      owner: OWNER,
      address: ACCOUNT,
      signatureType: 3,
      index: 0n,
    });
  });

  test('asks the factory for exactly the createAccount calldata', async () => {
    const readContract = answering(PADDED_ACCOUNT);
    await resolveTradingIdentity(
      signer,
      { type: 'smart_wallet' },
      env,
      readContract,
    );
    expect(readContract).toHaveBeenCalledTimes(1);
    expect(readContract).toHaveBeenCalledWith({
      to: env.contracts.kernelFactory,
      data: kernelCreateAccountCalldata(
        OWNER,
        0n,
        env.contracts.ecdsaValidator,
      ),
    });
    expect(readContract.mock.calls[0]?.[0].data).toBe(
      createAccount.expectedCalldata,
    );
  });

  test('checksums a lower-case or upper-case answer', async () => {
    for (const answer of [
      PADDED_ACCOUNT,
      pad32(ACCOUNT.toUpperCase().replace('0X', '0x')),
    ]) {
      const identity = await resolveTradingIdentity(
        signer,
        { type: 'smart_wallet' },
        env,
        answering(answer),
      );
      expect(identity.address).toBe(ACCOUNT);
    }
  });

  test.each([
    ['omitted', {}, 0n],
    ['undefined', { index: undefined }, 0n],
    ['a number', { index: 5 }, 5n],
    ['zero as a number', { index: 0 }, 0n],
    [
      'the largest safe integer',
      { index: Number.MAX_SAFE_INTEGER },
      9007199254740991n,
    ],
    ['a bigint', { index: 7n }, 7n],
    ['the largest uint256', { index: UINT256_MAX }, UINT256_MAX],
  ])('takes the index %s', async (_label, fields, expected) => {
    const readContract = answering(PADDED_ACCOUNT);
    const identity = await resolveTradingIdentity(
      signer,
      { type: 'smart_wallet', ...fields } as WalletInput,
      env,
      readContract,
    );
    expect(identity.index).toBe(expected);
    expect(readContract.mock.calls[0]?.[0].data).toBe(
      kernelCreateAccountCalldata(
        OWNER,
        expected,
        env.contracts.ecdsaValidator,
      ),
    );
  });

  test.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an unsafe integer', 2 ** 53],
    ['a negative bigint', -1n],
    ['2^256', 1n << 256n],
    ['a string', '1'],
    ['null', null],
    ['an object', {}],
  ])('rejects an index that is %s, before any call', async (_label, index) => {
    const readContract = answering(PADDED_ACCOUNT);
    const error = await caught(() =>
      resolveTradingIdentity(
        signer,
        { type: 'smart_wallet', index } as unknown as WalletInput,
        env,
        readContract,
      ),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).message).toMatch(/^wallet\.index /);
    expect(readContract).not.toHaveBeenCalled();
  });

  test('reads the account from the last 20 bytes of the answer', async () => {
    const identity = await resolveTradingIdentity(
      signer,
      { type: 'smart_wallet', index: 1 },
      env,
      answering(pad32(OWNER)),
    );
    expect(identity.address).toBe(OWNER);
  });

  test('a custom validator in the environment reaches the calldata', async () => {
    const readContract = answering(PADDED_ACCOUNT);
    const custom_ = {
      ...env,
      contracts: { ...env.contracts, ecdsaValidator: OWNER },
    };
    await resolveTradingIdentity(
      signer,
      { type: 'smart_wallet' },
      custom_,
      readContract,
    );
    expect(readContract.mock.calls[0]?.[0].data).toBe(
      kernelCreateAccountCalldata(OWNER, 0n, OWNER),
    );
  });
});

describe('resolveTradingIdentity: smart wallet address lookup failures', () => {
  test.each([
    ['0x', '0x'],
    ['too short', '0x1234'],
    ['a plain 20-byte address', OWNER],
    ['31 bytes', `0x${'00'.repeat(11)}${'ab'.repeat(20)}`],
    ['33 bytes', `0x${'00'.repeat(13)}${'ab'.repeat(20)}`],
    ['a dirty upper half', `0x${'00'.repeat(11)}01${'ab'.repeat(20)}`],
    ['not hex', `0x${'00'.repeat(12)}${'zz'.repeat(20)}`],
    ['no 0x prefix', PADDED_ACCOUNT.slice(2)],
    ['the zero address', `0x${'00'.repeat(32)}`],
    ['undefined', undefined],
    ['null', null],
    ['a number', 5],
    ['an object', { data: PADDED_ACCOUNT }],
  ])('rejects a result that is %s', async (_label, result) => {
    const error = await caught(() =>
      resolveTradingIdentity(
        signer,
        { type: 'smart_wallet' },
        env,
        answering(result),
      ),
    );
    expect(error).toBeInstanceOf(XoError);
    expect(error).not.toBeInstanceOf(UserInputError);
    const xo = error as XoError;
    expect(xo.code).toBe('smart_wallet_address_unavailable');
    expect(xo.service).toBe('chain');
    expect(xo.cause).toBeUndefined();
  });

  test('wraps a thrown error without its message or cause', async () => {
    const thrown = new TypeError('fetch failed: https://rpc.example/KEY123');
    const readContract = vi.fn(async () => {
      throw thrown;
    });
    const error = (await caught(() =>
      resolveTradingIdentity(
        signer,
        { type: 'smart_wallet' },
        env,
        readContract,
      ),
    )) as XoError;
    expect(error).toBeInstanceOf(XoError);
    expect(error.code).toBe('smart_wallet_address_unavailable');
    expect(error.service).toBe('chain');
    expect(error.message).toBe(
      'Smart wallet address lookup failed (TypeError)',
    );
    expect(error.cause).toBeUndefined();
    expect('cause' in error).toBe(false);
    for (const view of [
      error.message,
      JSON.stringify(error),
      inspect(error, { showHidden: true, depth: null }),
      String(error.stack),
    ]) {
      expect(view).not.toContain('KEY123');
      expect(view).not.toContain('rpc.example');
    }
  });

  test('also wraps an error thrown before a promise is returned', async () => {
    const readContract = vi.fn((): Promise<Hex> => {
      throw new RangeError('https://rpc.example/KEY123');
    });
    const error = (await caught(() =>
      resolveTradingIdentity(
        signer,
        { type: 'smart_wallet' },
        env,
        readContract,
      ),
    )) as XoError;
    expect(error.code).toBe('smart_wallet_address_unavailable');
    expect(error.message).toBe(
      'Smart wallet address lookup failed (RangeError)',
    );
    expect(JSON.stringify(error)).not.toContain('KEY123');
  });

  test('never copies an error name that is not a plain identifier', async () => {
    const hostile = new Error('x');
    hostile.name = 'https://rpc.example/KEY123';
    const error = (await caught(() =>
      resolveTradingIdentity(
        signer,
        { type: 'smart_wallet' },
        env,
        vi.fn(async () => {
          throw hostile;
        }),
      ),
    )) as XoError;
    expect(error.code).toBe('smart_wallet_address_unavailable');
    expect(error.message).toBe('Smart wallet address lookup failed (Error)');
    expect(JSON.stringify(error)).not.toContain('KEY123');
  });

  test('survives an error whose name getter throws', async () => {
    const hostile = {
      get name(): string {
        throw new Error('https://rpc.example/KEY123');
      },
    };
    const error = (await caught(() =>
      resolveTradingIdentity(
        signer,
        { type: 'smart_wallet' },
        env,
        vi.fn(async () => {
          throw hostile;
        }),
      ),
    )) as XoError;
    expect(error).toBeInstanceOf(XoError);
    expect(error.code).toBe('smart_wallet_address_unavailable');
    expect(error.service).toBe('chain');
    expect(error.message).toBe('Smart wallet address lookup failed (Error)');
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('KEY123');
  });

  test('survives a revoked proxy as the thrown value', async () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const error = (await caught(() =>
      resolveTradingIdentity(
        signer,
        { type: 'smart_wallet' },
        env,
        vi.fn(async () => {
          throw proxy;
        }),
      ),
    )) as XoError;
    expect(error).toBeInstanceOf(XoError);
    expect(error.code).toBe('smart_wallet_address_unavailable');
    expect(error.message).toBe('Smart wallet address lookup failed (Error)');
    expect(error.cause).toBeUndefined();
  });

  test.each([
    ['a string', 'https://rpc.example/KEY123'],
    ['undefined', undefined],
    ['an object', { message: 'https://rpc.example/KEY123' }],
  ])('wraps a thrown %s', async (_label, value) => {
    const error = (await caught(() =>
      resolveTradingIdentity(
        signer,
        { type: 'smart_wallet' },
        env,
        vi.fn(async () => {
          throw value;
        }),
      ),
    )) as XoError;
    expect(error).toBeInstanceOf(XoError);
    expect(error.code).toBe('smart_wallet_address_unavailable');
    expect(error.service).toBe('chain');
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('KEY123');
    expect(error.message).not.toContain('KEY123');
  });

  test('an invalid validator is a UserInputError, not an unavailable address', async () => {
    const readContract = answering(PADDED_ACCOUNT);
    const bad = {
      ...env,
      contracts: { ...env.contracts, ecdsaValidator: '0x1234' as Address },
    };
    const error = await caught(() =>
      resolveTradingIdentity(
        signer,
        { type: 'smart_wallet' },
        bad,
        readContract,
      ),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).message).toMatch(/^validator /);
    expect(readContract).not.toHaveBeenCalled();
  });
});

describe('resolveTradingIdentity: the result is frozen', () => {
  /** The same object, typed as writable, to try assignments the types forbid. */
  const writable = <T extends object>(value: T) =>
    value as { -readonly [K in keyof T]: T[K] };

  test.each([
    ['eoa', { type: 'eoa' } as WalletInput],
    ['smart_wallet', { type: 'smart_wallet' } as WalletInput],
  ])('the %s identity cannot be changed', async (_label, wallet) => {
    const identity = await resolveTradingIdentity(
      signer,
      wallet,
      env,
      answering(PADDED_ACCOUNT),
    );
    const before = { ...identity };
    expect(Object.isFrozen(identity)).toBe(true);

    const target = writable(identity);
    expect(() => {
      target.address = OTHER;
    }).toThrow(TypeError);
    expect(() => {
      target.owner = OTHER;
    }).toThrow(TypeError);
    expect(() => {
      target.signatureType = identity.signatureType === 0 ? 3 : 0;
    }).toThrow(TypeError);
    expect(() => {
      target.type = identity.type === 'eoa' ? 'smart_wallet' : 'eoa';
    }).toThrow(TypeError);
    expect(() => {
      target.index = 9n;
    }).toThrow(TypeError);
    expect(() => {
      delete (target as Record<string, unknown>).owner;
    }).toThrow(TypeError);
    expect(() => Object.assign(identity, { extra: 1 })).toThrow(TypeError);

    expect({ ...identity }).toEqual(before);
    expect('extra' in identity).toBe(false);
  });

  test('the fields are readonly in the types', async () => {
    const identity = await resolveTradingIdentity(
      signer,
      { type: 'smart_wallet' },
      env,
      answering(PADDED_ACCOUNT),
    );
    expect(() => {
      // @ts-expect-error address is readonly
      identity.address = OTHER;
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error index is readonly
      identity.index = 1n;
    }).toThrow(TypeError);
    expect(identity.address).toBe(ACCOUNT);
    expect(identity.index).toBe(0n);
  });
});

describe('resolveTradingIdentity: input validation', () => {
  test.each([
    ['the bare string eoa', 'eoa'],
    ['an unknown string', 'smart_wallet'],
    ['a wrong-case string', 'EOA'],
    ['an empty object', {}],
    ['an unknown type', { type: 'kernel' }],
    ['a wrong-case type', { type: 'EOA' }],
    ['the old smart wallet form', { kernel: {} }],
    ['the old form with an index', { kernel: { index: 0 } }],
    ['an index on an eoa', { type: 'eoa', index: 0 }],
    ['a typo beside smart_wallet', { type: 'smart_wallet', idx: 1 }],
    ['an extra key beside eoa', { type: 'eoa', kernel: {} }],
    ['an array', [{ type: 'eoa' }]],
    ['null', null],
    ['undefined', undefined],
    ['a number', 1],
  ])('rejects a wallet that is %s, before any call', async (_label, wallet) => {
    const readContract = answering(PADDED_ACCOUNT);
    const error = await caught(() =>
      resolveTradingIdentity(
        signer,
        wallet as unknown as WalletInput,
        env,
        readContract,
      ),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).message).toBe(
      "wallet must be { type: 'eoa' } or { type: 'smart_wallet', index?: number | bigint } with a non-negative index",
    );
    expect(readContract).not.toHaveBeenCalled();
  });

  test.each([
    ['no address', {}],
    ['a malformed address', { address: '0x1234' }],
    ['null', null],
  ])('rejects a signer with %s', async (_label, bad) => {
    const error = await caught(() =>
      resolveTradingIdentity(
        bad as unknown as InternalSigner,
        { type: 'eoa' },
        env,
        answering('0x'),
      ),
    );
    expect(error).toBeInstanceOf(UserInputError);
  });
});

describe('signAsTrader: eoa', () => {
  test('signs the typed data itself and recovers to the owner', async () => {
    const identity = await resolveTradingIdentity(
      signer,
      { type: 'eoa' },
      env,
      answering('0x'),
    );
    const signature = await signAsTrader(
      identity,
      signer,
      ORDER_TD,
      env.chainId,
    );
    expect(size(signature)).toBe(65);
    expect(await recoverTypedDataAddress({ ...ORDER_TD, signature })).toBe(
      OWNER,
    );
    expect(signature).toBe(await signer.signTypedData(ORDER_TD));
  });

  test('works through a wallet client too', async () => {
    const wc = createWalletClient({
      account: privateKeyToAccount(KEY),
      transport: custom({ request: vi.fn() }),
    });
    const viaClient = walletClientSigner(wc);
    const identity = await resolveTradingIdentity(
      viaClient,
      { type: 'eoa' },
      env,
      answering('0x'),
    );
    expect(await signAsTrader(identity, viaClient, ORDER_TD, env.chainId)).toBe(
      await signer.signTypedData(ORDER_TD),
    );
  });
});

describe('signAsTrader: smart_wallet', () => {
  test('is 0x00 plus a 65-byte signature that recovers the owner over the wrapped digest', async () => {
    const signature = await signAsTrader(
      smartWalletIdentity,
      signer,
      ORDER_TD,
      env.chainId,
    );
    expect(signature.startsWith('0x00')).toBe(true);
    expect(size(signature)).toBe(66);
    const tail = slice(signature, 1);
    expect(size(tail)).toBe(65);

    const orderHash = hashTypedData(ORDER_TD);
    expect(orderHash).toBe(orderVector.expectedDigest);
    const wrapped = hashTypedData(
      kernelWrapTypedData(orderHash, ACCOUNT, env.chainId),
    );
    expect(wrapped).toBe(wrapDigest(orderHash, ACCOUNT, env.chainId));
    expect(await recoverAddress({ hash: wrapped, signature: tail })).toBe(
      OWNER,
    );
  });

  test('does not sign the raw order digest', async () => {
    const signature = await signAsTrader(
      smartWalletIdentity,
      signer,
      ORDER_TD,
      env.chainId,
    );
    const recovered = await recoverAddress({
      hash: hashTypedData(ORDER_TD),
      signature: slice(signature, 1),
    });
    expect(recovered).not.toBe(OWNER);
  });

  test('is the Kernel encoding of the owner signature over the wrap', async () => {
    const inner = await signer.signTypedData(
      kernelWrapTypedData(hashTypedData(ORDER_TD), ACCOUNT, env.chainId),
    );
    expect(
      await signAsTrader(smartWalletIdentity, signer, ORDER_TD, env.chainId),
    ).toBe(encodeKernelSignature(inner));
  });

  test('binds the signature to the account and the chain', async () => {
    const base = await signAsTrader(
      smartWalletIdentity,
      signer,
      ORDER_TD,
      env.chainId,
    );
    const otherChain = await signAsTrader(
      smartWalletIdentity,
      signer,
      ORDER_TD,
      env.chainId + 1,
    );
    const otherAccount = await signAsTrader(
      { ...smartWalletIdentity, address: OWNER },
      signer,
      ORDER_TD,
      env.chainId,
    );
    expect(otherChain).not.toBe(base);
    expect(otherAccount).not.toBe(base);
  });

  test('works with a wallet client, which has no signHash', async () => {
    const request = vi.fn();
    const wc = createWalletClient({
      account: privateKeyToAccount(KEY),
      transport: custom({ request }),
    });
    const viaClient = walletClientSigner(wc);
    expect(viaClient.signHash).toBeUndefined();
    const identity = await resolveTradingIdentity(
      viaClient,
      { type: 'smart_wallet' },
      env,
      answering(PADDED_ACCOUNT),
    );
    expect(identity.address).toBe(ACCOUNT);
    const signature = await signAsTrader(
      identity,
      viaClient,
      ORDER_TD,
      env.chainId,
    );
    expect(request).not.toHaveBeenCalled();
    expect(signature.startsWith('0x00')).toBe(true);
    const wrapped = hashTypedData(
      kernelWrapTypedData(hashTypedData(ORDER_TD), ACCOUNT, env.chainId),
    );
    expect(
      await recoverAddress({ hash: wrapped, signature: slice(signature, 1) }),
    ).toBe(OWNER);
    expect(signature).toBe(
      await signAsTrader(smartWalletIdentity, signer, ORDER_TD, env.chainId),
    );
  });

  test('asks the signer to sign the wrap typed data only', async () => {
    const { signer: spied, signTypedData, signMessage } = spySigner(OWNER);
    await signAsTrader(smartWalletIdentity, spied, ORDER_TD, env.chainId);
    expect(signMessage).not.toHaveBeenCalled();
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(signTypedData).toHaveBeenCalledWith(
      kernelWrapTypedData(hashTypedData(ORDER_TD), ACCOUNT, env.chainId),
    );
  });

  test('accepts an upper-case 65-byte inner signature, byte for byte', async () => {
    const { signer: spied } = spySigner(OWNER, `0x${'AB'.repeat(64)}1B`);
    const signature = await signAsTrader(
      smartWalletIdentity,
      spied,
      ORDER_TD,
      env.chainId,
    );
    expect(signature).toBe(`0x00${'AB'.repeat(64)}1B`);
  });

  test('rejects an invalid account address before signing', async () => {
    const { signer: spied, signTypedData } = spySigner(OWNER);
    const error = await caught(() =>
      signAsTrader(
        { ...smartWalletIdentity, address: '0x1234' as Address },
        spied,
        ORDER_TD,
        env.chainId,
      ),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect(signTypedData).not.toHaveBeenCalled();
  });
});

describe('signAsTrader: guards', () => {
  test.each([
    ['eoa', eoaIdentity],
    ['smart_wallet', smartWalletIdentity],
  ])(
    'throws signer_mismatch (%s) before any signing call',
    async (_label, identity) => {
      const { signer: spied, signTypedData, signMessage } = spySigner(OTHER);
      const error = await caught(() =>
        signAsTrader(identity, spied, ORDER_TD, env.chainId),
      );
      expect(error).toBeInstanceOf(UserInputError);
      expect((error as UserInputError).code).toBe('signer_mismatch');
      expect(signTypedData).not.toHaveBeenCalled();
      expect(signMessage).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['eoa', eoaIdentity],
    ['smart_wallet', smartWalletIdentity],
  ])(
    'does not catch an error thrown by the signer (%s)',
    async (_label, identity) => {
      const rejected = new Error('user rejected');
      const failing: InternalSigner = {
        address: OWNER,
        signMessage: vi.fn(),
        signTypedData: vi.fn(async () => {
          throw rejected;
        }),
      };
      const error = await caught(() =>
        signAsTrader(identity, failing, ORDER_TD, env.chainId),
      );
      expect(error).toBe(rejected);
      expect(error).not.toBeInstanceOf(SigningError);
    },
  );

  test('compares the owner and the signer case-insensitively', async () => {
    const { signer: spied, signTypedData } = spySigner(
      OWNER.toLowerCase() as Address,
    );
    await signAsTrader(eoaIdentity, spied, ORDER_TD, env.chainId);
    expect(signTypedData).toHaveBeenCalledTimes(1);
  });

  test('checks the signer before the chain id', async () => {
    const { signer: spied } = spySigner(OTHER);
    const error = await caught(() =>
      signAsTrader(eoaIdentity, spied, ORDER_TD, 0),
    );
    expect((error as UserInputError).code).toBe('signer_mismatch');
  });

  test.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['an unsafe integer', 2 ** 53],
    ['a string', String(env.chainId)],
    ['a bigint', BigInt(env.chainId)],
    ['undefined', undefined],
  ])(
    'rejects a chain id that is %s before signing',
    async (_label, chainId) => {
      for (const identity of [eoaIdentity, smartWalletIdentity]) {
        const { signer: spied, signTypedData } = spySigner(OWNER);
        const error = await caught(() =>
          signAsTrader(identity, spied, ORDER_TD, chainId as number),
        );
        expect(error).toBeInstanceOf(UserInputError);
        expect((error as UserInputError).message).toMatch(/^chainId /);
        expect(signTypedData).not.toHaveBeenCalled();
      }
    },
  );

  test.each([
    ['an unknown type', { ...eoaIdentity, type: 'smart' }],
    ['the old kernel type', { ...smartWalletIdentity, type: 'kernel' }],
    ['the old mode field', { ...eoaIdentity, type: undefined, mode: 'eoa' }],
  ])('rejects %s before signing', async (_label, identity) => {
    const { signer: spied, signTypedData } = spySigner(OWNER);
    const error = await caught(() =>
      signAsTrader(
        identity as unknown as TradingIdentity,
        spied,
        ORDER_TD,
        env.chainId,
      ),
    );
    expect(error).toBeInstanceOf(UserInputError);
    expect((error as UserInputError).message).toBe(
      'identity.type must be "eoa" or "smart_wallet"',
    );
    expect(signTypedData).not.toHaveBeenCalled();
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', OWNER],
    ['a number', 42],
    ['a boolean', true],
    ['an array', []],
  ])(
    'rejects %s as the signer before reading its address',
    async (_label, bad) => {
      for (const identity of [eoaIdentity, smartWalletIdentity]) {
        const error = await caught(() =>
          signAsTrader(
            identity,
            bad as unknown as InternalSigner,
            ORDER_TD,
            env.chainId,
          ),
        );
        expect(error).toBeInstanceOf(UserInputError);
        expect((error as UserInputError).message).toMatch(/^signer /);
        expect((error as UserInputError).code).not.toBe('signer_mismatch');
      }
    },
  );

  test('rejects a missing identity', async () => {
    const { signer: spied } = spySigner(OWNER);
    const error = await caught(() =>
      signAsTrader(
        null as unknown as TradingIdentity,
        spied,
        ORDER_TD,
        env.chainId,
      ),
    );
    expect(error).toBeInstanceOf(UserInputError);
  });
});

describe('signAsTrader: the recovery byte', () => {
  const KERNEL_WRAP_TD = kernelWrapTypedData(
    hashTypedData(ORDER_TD),
    ACCOUNT,
    env.chainId,
  );
  const WRAPPED_DIGEST = hashTypedData(KERNEL_WRAP_TD);

  /** `r || s` of the vector key's real signature, to rebuild it with any `v`. */
  const rs = (signature: Hex): string => signature.slice(0, -2);
  const withV = (signature: Hex, v: number): Hex =>
    `${rs(signature)}${v.toString(16).padStart(2, '0')}` as Hex;
  const vOf = (signature: Hex): number =>
    Number.parseInt(signature.slice(-2), 16);

  /** A real EOA signature over the order, and a real inner signature over the Kernel wrap. */
  async function realSignatures() {
    const eoa = await signer.signTypedData(ORDER_TD);
    const inner = await signer.signTypedData(KERNEL_WRAP_TD);
    return { eoa, inner };
  }

  test('viem signatures end in 27 or 28 already', async () => {
    const { eoa, inner } = await realSignatures();
    expect([27, 28]).toContain(vOf(eoa));
    expect([27, 28]).toContain(vOf(inner));
  });

  test('a wallet that returns v as 0/1 still gives a signature that recovers to the owner (EOA)', async () => {
    const { eoa } = await realSignatures();
    const wallet = withV(eoa, vOf(eoa) - 27);
    expect([0, 1]).toContain(vOf(wallet));
    const { signer: stub } = spySigner(OWNER, wallet);
    const signature = await signAsTrader(
      eoaIdentity,
      stub,
      ORDER_TD,
      env.chainId,
    );
    expect(signature).toBe(eoa);
    expect(await recoverTypedDataAddress({ ...ORDER_TD, signature })).toBe(
      OWNER,
    );
  });

  test('a wallet that returns v as 0/1 still gives a signature that recovers to the owner (smart wallet)', async () => {
    const { inner } = await realSignatures();
    const wallet = withV(inner, vOf(inner) - 27);
    expect([0, 1]).toContain(vOf(wallet));
    const { signer: stub } = spySigner(OWNER, wallet);
    const signature = await signAsTrader(
      smartWalletIdentity,
      stub,
      ORDER_TD,
      env.chainId,
    );
    expect(signature).toBe(encodeKernelSignature(inner));
    expect(signature.startsWith('0x00')).toBe(true);
    expect(
      await recoverAddress({
        hash: WRAPPED_DIGEST,
        signature: slice(signature, 1),
      }),
    ).toBe(OWNER);
  });

  test.each([
    ['00', '1b'],
    ['01', '1c'],
  ])(
    'maps v=0x%s to 0x%s and changes nothing else (EOA and smart wallet)',
    async (low, high) => {
      const body = 'cd'.repeat(64);
      const eoa = spySigner(OWNER, `0x${body}${low}`);
      expect(
        await signAsTrader(eoaIdentity, eoa.signer, ORDER_TD, env.chainId),
      ).toBe(`0x${body}${high}`);
      const smart = spySigner(OWNER, `0x${body}${low}`);
      expect(
        await signAsTrader(
          smartWalletIdentity,
          smart.signer,
          ORDER_TD,
          env.chainId,
        ),
      ).toBe(`0x00${body}${high}`);
    },
  );

  test('keeps the case of r and s when it changes v', async () => {
    const { signer: stub } = spySigner(OWNER, `0x${'CD'.repeat(64)}00`);
    expect(await signAsTrader(eoaIdentity, stub, ORDER_TD, env.chainId)).toBe(
      `0x${'CD'.repeat(64)}1b`,
    );
  });

  test.each([
    ['27', '1b'],
    ['28', '1c'],
    ['27 in upper case', '1B'],
    ['28 in upper case', '1C'],
  ])(
    'returns a signature with v=%s byte for byte (EOA and smart wallet)',
    async (_label, v) => {
      const wallet = `0x${'cd'.repeat(32)}${'ef'.repeat(32)}${v}` as Hex;
      const eoa = spySigner(OWNER, wallet);
      expect(
        await signAsTrader(eoaIdentity, eoa.signer, ORDER_TD, env.chainId),
      ).toBe(wallet);
      const smart = spySigner(OWNER, wallet);
      expect(
        await signAsTrader(
          smartWalletIdentity,
          smart.signer,
          ORDER_TD,
          env.chainId,
        ),
      ).toBe(`0x00${wallet.slice(2)}`);
    },
  );

  test('a real 27/28 signature comes back identical', async () => {
    const { eoa, inner } = await realSignatures();
    expect(await signAsTrader(eoaIdentity, signer, ORDER_TD, env.chainId)).toBe(
      eoa,
    );
    expect(
      await signAsTrader(smartWalletIdentity, signer, ORDER_TD, env.chainId),
    ).toBe(`0x00${inner.slice(2)}`);
  });

  test.each([
    ['2', 0x02],
    ['26', 0x1a],
    ['29', 0x1d],
    ['30', 0x1e],
    ['255', 0xff],
  ])('rejects v=%s without echoing the signature', async (_label, v) => {
    for (const identity of [eoaIdentity, smartWalletIdentity]) {
      const bad = `0x${'cd'.repeat(64)}${v.toString(16).padStart(2, '0')}`;
      const { signer: stub } = spySigner(OWNER, bad);
      const error = await caught(() =>
        signAsTrader(identity, stub, ORDER_TD, env.chainId),
      );
      expect(error).toBeInstanceOf(SigningError);
      const shown = `${(error as SigningError).message}${JSON.stringify(error)}`;
      expect(shown).not.toContain('cdcd');
      expect(shown).not.toContain(bad.slice(2));
    }
  });

  test.each([
    ['a 64-byte (EIP-2098 compact) signature', `0x${'cd'.repeat(64)}`],
    ['a 64-byte signature that ends in 0x1b', `0x${'cd'.repeat(63)}1b`],
    ['a 64-byte signature that ends in 0x00', `0x${'cd'.repeat(63)}00`],
    ['66 bytes', `0x${'cd'.repeat(65)}1b`],
    ['empty', '0x'],
    ['not hex', `0x${'zz'.repeat(64)}1b`],
    ['no 0x prefix', `${'cd'.repeat(64)}1b`],
    ['undefined', undefined],
    ['null', null],
    ['a number', 27],
    ['an object', { signature: `0x${'cd'.repeat(64)}1b` }],
  ])(
    'rejects %s with a SigningError that does not echo it (EOA and smart wallet)',
    async (_label, bad) => {
      for (const identity of [eoaIdentity, smartWalletIdentity]) {
        const { signer: stub } = spySigner(OWNER, bad);
        const error = await caught(() =>
          signAsTrader(identity, stub, ORDER_TD, env.chainId),
        );
        expect(error).toBeInstanceOf(SigningError);
        const shown = `${(error as SigningError).message}${JSON.stringify(error)}`;
        expect(shown).not.toContain('cdcd');
        expect(shown).not.toContain('zzzz');
      }
    },
  );

  test('does not touch what the signer adapters return', async () => {
    // The adapters pass the wallet's answer through; only signAsTrader normalises.
    const stubAccount = privateKeyToAccount(KEY);
    const real = await stubAccount.signTypedData(ORDER_TD);
    const zeroBased = withV(real, vOf(real) - 27);
    const wallet = walletClientSigner(
      createWalletClient({
        account: toAccount({
          address: stubAccount.address,
          signMessage: (p) => stubAccount.signMessage(p),
          signTypedData: async () => zeroBased,
          signTransaction: (tx) => stubAccount.signTransaction(tx),
        }),
        transport: custom({ request: vi.fn() }),
      }),
    );
    expect(await wallet.signTypedData(ORDER_TD)).toBe(zeroBased);
    expect(await signAsTrader(eoaIdentity, wallet, ORDER_TD, env.chainId)).toBe(
      real,
    );
  });
});
