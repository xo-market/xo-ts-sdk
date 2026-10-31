import {
  concat,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  type Hex,
  hashTypedData,
  keccak256,
  pad,
  parseAbi,
  recoverTypedDataAddress,
  size,
  slice,
  stringToHex,
  toFunctionSelector,
  toHex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, test } from 'vitest';
import { production } from '../../src/core/env';
import { MAX_CALLS } from '../../src/signing/evTx';
import {
  type Call,
  encodeKernelSignature,
  KERNEL_TYPES,
  kernelCreateAccountCalldata,
  kernelExecuteCalldata,
  kernelWrapTypedData,
} from '../../src/signing/kernel';
import { hashOrder } from '../../src/signing/order';
import {
  DOMAIN,
  expectInvalid,
  kernelVector,
  ORDER,
  orderVector,
} from './helpers';

const { createAccount, wrap, execute, signature } = kernelVector;
const OWNER = createAccount.owner;
const VALIDATOR = createAccount.ecdsaValidator;

// The Kernel ABI, written out here on its own so the tests do not lean on the module's.
const CREATE_ACCOUNT_ABI = parseAbi([
  'function createAccount(bytes data, bytes32 salt) returns (address)',
]);
const INITIALIZE_ABI = parseAbi([
  'function initialize(bytes21 _rootValidator, address hook, bytes validatorData, bytes hookData, bytes[] initConfig)',
]);
const EXECUTE_ABI = parseAbi([
  'function execute(bytes32 mode, bytes executionCalldata)',
]);

const ZERO_ADDRESS = `0x${'00'.repeat(20)}` as const;
const MODE_SINGLE = `0x00${'00'.repeat(31)}` as Hex;
const MODE_BATCH = `0x01${'00'.repeat(31)}` as Hex;
const UINT256_MAX = (1n << 256n) - 1n;

describe('the Kernel vector', () => {
  test('uses the factory and validator of the mainnet environment', () => {
    expect(createAccount.factory).toBe(production.contracts.kernelFactory);
    expect(createAccount.ecdsaValidator).toBe(
      production.contracts.ecdsaValidator,
    );
  });

  test('wraps the digest of the order vector', () => {
    expect(wrap.inputs.hash).toBe(orderVector.expectedDigest);
    expect(hashOrder(ORDER, DOMAIN)).toBe(wrap.inputs.hash);
  });
});

describe('kernelCreateAccountCalldata', () => {
  const calldata = kernelCreateAccountCalldata(
    OWNER,
    BigInt(createAccount.index),
    VALIDATOR,
  );

  test('starts with the createAccount selector 0xea6d13ac', () => {
    expect(createAccount.selector).toBe('0xea6d13ac');
    expect(toFunctionSelector('createAccount(bytes,bytes32)')).toBe(
      createAccount.selector,
    );
    expect(calldata.slice(0, 10)).toBe(createAccount.selector);
  });

  test('matches the golden calldata', () => {
    // The mainnet factory returns createAccount.expectedAccount for exactly this calldata
    // (checked live by e2e/kernel-address.e2e.test.ts).
    expect(calldata).toBe(createAccount.expectedCalldata);
  });

  test('is createAccount(initialize(0x01 || validator, 0, owner, 0x, []), index)', () => {
    const outer = decodeFunctionData({
      abi: CREATE_ACCOUNT_ABI,
      data: calldata,
    });
    expect(outer.functionName).toBe('createAccount');
    const [data, salt] = outer.args;
    expect(salt).toBe(pad('0x00', { size: 32 }));

    const inner = decodeFunctionData({ abi: INITIALIZE_ABI, data });
    expect(inner.functionName).toBe('initialize');
    const [rootValidator, hook, validatorData, hookData, initConfig] =
      inner.args;
    // bytes21: the ECDSA validator type byte 0x01, then the validator address.
    expect(rootValidator).toBe(`0x01${VALIDATOR.slice(2).toLowerCase()}`);
    expect(size(rootValidator)).toBe(21);
    expect(hook).toBe(ZERO_ADDRESS);
    // The validator's init data is the owner address, 20 bytes and not left-padded.
    expect(validatorData).toBe(OWNER.toLowerCase());
    expect(hookData).toBe('0x');
    expect(initConfig).toEqual([]);
  });

  test('encodes the index as the 32-byte big-endian salt', () => {
    for (const index of [0n, 1n, 255n, 1n << 64n, UINT256_MAX]) {
      const data = kernelCreateAccountCalldata(OWNER, index, VALIDATOR);
      const { args } = decodeFunctionData({ abi: CREATE_ACCOUNT_ABI, data });
      expect(args[1]).toBe(pad(toHex(index), { size: 32 }));
    }
    expect(
      decodeFunctionData({
        abi: CREATE_ACCOUNT_ABI,
        data: kernelCreateAccountCalldata(OWNER, UINT256_MAX, VALIDATOR),
      }).args[1],
    ).toBe(`0x${'ff'.repeat(32)}`);
  });

  test('a different owner, index or validator changes the calldata', () => {
    const other = kernelCreateAccountCalldata(
      createAccount.factory,
      0n,
      VALIDATOR,
    );
    expect(other).not.toBe(calldata);
    expect(kernelCreateAccountCalldata(OWNER, 1n, VALIDATOR)).not.toBe(
      calldata,
    );
    expect(
      kernelCreateAccountCalldata(OWNER, 0n, createAccount.factory),
    ).not.toBe(calldata);
  });

  test('accepts any address case, including a wrong checksum', () => {
    const lower = kernelCreateAccountCalldata(
      OWNER.toLowerCase() as Hex,
      0n,
      VALIDATOR.toLowerCase() as Hex,
    );
    const upper = kernelCreateAccountCalldata(
      `0x${OWNER.slice(2).toUpperCase()}`,
      0n,
      `0x${VALIDATOR.slice(2).toUpperCase()}`,
    );
    expect(lower).toBe(calldata);
    expect(upper).toBe(calldata);
  });

  test('rejects a bad owner, index or validator, naming the field', () => {
    const bad = ['0x1234', 'not an address', '', `0x${'zz'.repeat(20)}`];
    for (const value of bad) {
      expectInvalid(
        () => kernelCreateAccountCalldata(value as Hex, 0n, VALIDATOR),
        'owner',
      );
      expectInvalid(
        () => kernelCreateAccountCalldata(OWNER, 0n, value as Hex),
        'validator',
      );
    }
    expectInvalid(
      () =>
        kernelCreateAccountCalldata(undefined as unknown as Hex, 0n, VALIDATOR),
      'owner',
    );
    for (const index of [0, '0', -1n, 1n << 256n, undefined, null, 1.5]) {
      expectInvalid(
        () => kernelCreateAccountCalldata(OWNER, index as bigint, VALIDATOR),
        'index',
      );
    }
  });

  test('checks the fields in parameter order', () => {
    expectInvalid(
      () => kernelCreateAccountCalldata('0x1' as Hex, -1n, '0x2' as Hex),
      'owner',
    );
    expectInvalid(
      () => kernelCreateAccountCalldata(OWNER, -1n, '0x2' as Hex),
      'index',
    );
  });
});

describe('kernelWrapTypedData', () => {
  const { hash, account, chainId } = wrap.inputs;

  /** The Kernel wrap written without viem's typed-data code. */
  function referenceDigest(h: Hex, verifyingContract: Hex, id: number): Hex {
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
          keccak256(stringToHex('Kernel')),
          keccak256(stringToHex('0.3.1')),
          BigInt(id),
          verifyingContract,
        ],
      ),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }],
        [keccak256(stringToHex(wrap.typeStrings.Kernel)), h],
      ),
    );
    return keccak256(concat(['0x1901', domainSeparator, structHash]));
  }

  test('hashes to the golden digest', () => {
    expect(hashTypedData(kernelWrapTypedData(hash, account, chainId))).toBe(
      wrap.expectedDigest,
    );
  });

  test('matches a hand-written keccak256 version of EIP-712', () => {
    expect(referenceDigest(hash, account, chainId)).toBe(wrap.expectedDigest);
    const other = `0x${'ab'.repeat(32)}` as Hex;
    expect(
      hashTypedData(
        kernelWrapTypedData(other, createAccount.expectedAccount, 7),
      ),
    ).toBe(referenceDigest(other, createAccount.expectedAccount, 7));
  });

  test('is Kernel(bytes32 hash) under the domain Kernel / 0.3.1', () => {
    expect(wrap.typeStrings.Kernel).toBe('Kernel(bytes32 hash)');
    expect(KERNEL_TYPES).toEqual({
      Kernel: [{ name: 'hash', type: 'bytes32' }],
    });
    expect(kernelWrapTypedData(hash, account, chainId)).toEqual({
      domain: wrap.domain,
      types: { Kernel: [{ name: 'hash', type: 'bytes32' }] },
      primaryType: 'Kernel',
      message: { hash },
    });
  });

  test('the domain has exactly name, version, chainId and verifyingContract', () => {
    const { domain } = kernelWrapTypedData(hash, account, chainId);
    expect(Object.keys(domain ?? {}).sort()).toEqual([
      'chainId',
      'name',
      'verifyingContract',
      'version',
    ]);
  });

  test('checksums the account, so the result does not depend on its case', () => {
    const lower = kernelWrapTypedData(
      hash,
      account.toLowerCase() as Hex,
      chainId,
    );
    const upper = kernelWrapTypedData(
      hash,
      `0x${account.slice(2).toUpperCase()}`,
      chainId,
    );
    expect(lower.domain?.verifyingContract).toBe(getAddress(account));
    expect(hashTypedData(lower)).toBe(wrap.expectedDigest);
    expect(hashTypedData(upper)).toBe(wrap.expectedDigest);
  });

  test('accepts an upper-case hash', () => {
    const upper = `0x${hash.slice(2).toUpperCase()}` as Hex;
    expect(hashTypedData(kernelWrapTypedData(upper, account, chainId))).toBe(
      wrap.expectedDigest,
    );
  });

  test('the account and the chain change the digest', () => {
    const base = hashTypedData(kernelWrapTypedData(hash, account, chainId));
    expect(
      hashTypedData(
        kernelWrapTypedData(hash, createAccount.expectedAccount, chainId),
      ),
    ).not.toBe(base);
    expect(
      hashTypedData(kernelWrapTypedData(hash, account, chainId + 1)),
    ).not.toBe(base);
  });

  test('an owner signature over the wrap recovers to the owner', async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const typedData = kernelWrapTypedData(
      hash,
      createAccount.expectedAccount,
      chainId,
    );
    const signature = await owner.signTypedData(typedData);
    expect(size(signature)).toBe(65);
    await expect(
      recoverTypedDataAddress({ ...typedData, signature }),
    ).resolves.toBe(owner.address);
  });

  test('rejects a bad hash, account or chainId, naming the field', () => {
    const badHashes = [
      '0x',
      hash.slice(0, -2), // 31 bytes
      `${hash}00`, // 33 bytes
      hash.slice(2), // no 0x prefix
      `0x${'zz'.repeat(32)}`,
      `${hash.slice(0, -1)}`, // odd number of digits
      42,
      undefined,
      null,
    ];
    for (const bad of badHashes) {
      expectInvalid(
        () => kernelWrapTypedData(bad as Hex, account, chainId),
        'hash',
      );
    }
    for (const bad of ['0x1234', 'nope', '', undefined]) {
      expectInvalid(
        () => kernelWrapTypedData(hash, bad as Hex, chainId),
        'account',
      );
    }
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 53, '1', 1n, undefined]) {
      expectInvalid(
        () => kernelWrapTypedData(hash, account, bad as number),
        'chainId',
      );
    }
  });
});

describe('encodeKernelSignature', () => {
  test('prefixes a 65-byte ECDSA signature with the root-validator byte 0x00', async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const ecdsa = await owner.signTypedData(
      kernelWrapTypedData(
        wrap.inputs.hash,
        wrap.inputs.account,
        wrap.inputs.chainId,
      ),
    );
    expect(size(ecdsa)).toBe(65);
    const encoded = encodeKernelSignature(ecdsa);
    expect(size(encoded)).toBe(66);
    expect(encoded.startsWith('0x00')).toBe(true);
    expect(slice(encoded, 1)).toBe(ecdsa);
    expect(encoded).toBe(`0x00${ecdsa.slice(2)}`);
  });

  test('matches the golden signature of the vector', () => {
    expect(size(signature.ecdsa)).toBe(65);
    expect(size(signature.expectedSignature)).toBe(66);
    expect(encodeKernelSignature(signature.ecdsa)).toBe(
      signature.expectedSignature,
    );
    // Written out by hand: the type byte 0x00, then the 65 signature bytes as they are.
    expect(`0x00${signature.ecdsa.slice(2)}`).toBe(signature.expectedSignature);
  });

  test('keeps the case of the signature', () => {
    const ecdsa = `0x${'aB'.repeat(65)}` as Hex;
    expect(encodeKernelSignature(ecdsa)).toBe(`0x00${'aB'.repeat(65)}`);
  });

  test('rejects anything that is not 65 bytes of hex', () => {
    const good = `0x${'11'.repeat(65)}`;
    const bad = [
      '0x',
      `0x${'11'.repeat(64)}`,
      `0x${'11'.repeat(66)}`,
      encodeKernelSignature(good as Hex), // already prefixed: 66 bytes
      good.slice(2), // no 0x prefix
      `${good}1`, // odd number of digits
      `0x${'zz'.repeat(65)}`,
      '',
      65,
      undefined,
      null,
    ];
    for (const value of bad) {
      expectInvalid(() => encodeKernelSignature(value as Hex), 'ecdsa');
    }
  });
});

describe('kernelExecuteCalldata', () => {
  const FACTORY = createAccount.factory;
  const TRANSFER =
    `0xa9059cbb${'00'.repeat(12)}${'a1'.repeat(20)}${'00'.repeat(31)}05` as Hex;
  const CALL_A: Call = { to: FACTORY, value: 5n, data: TRANSFER };
  const CALL_B: Call = { to: VALIDATOR, data: '0x' }; // no value
  const CALL_C: Call = { to: OWNER, value: UINT256_MAX, data: '0xdeadbeef' };

  /** What a call is once the defaults are applied and the address is checksummed. */
  const normalized = (c: Call) => ({
    to: getAddress(c.to),
    value: c.value ?? 0n,
    data: c.data,
  });

  /** Decodes single-call executionCalldata: 20 bytes target, 32 bytes value, then the data. */
  function decodeSingle(executionCalldata: Hex) {
    return {
      to: getAddress(slice(executionCalldata, 0, 20)),
      value: BigInt(slice(executionCalldata, 20, 52)),
      // viem's slice throws when the start is at the end, which is the empty data case.
      data:
        size(executionCalldata) === 52 ? '0x' : slice(executionCalldata, 52),
    };
  }

  function decodeBatch(executionCalldata: Hex) {
    const [calls] = decodeAbiParameters(
      [
        {
          type: 'tuple[]',
          components: [
            { name: 'target', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'callData', type: 'bytes' },
          ],
        },
      ],
      executionCalldata,
    );
    return calls.map((c) => ({
      to: c.target,
      value: c.value,
      data: c.callData,
    }));
  }

  /**
   * The expected calldata, built by hand with concat, pad and encodeAbiParameters and not
   * with the SDK function: selector || abi.encode(mode, executionCalldata).
   */
  function referenceExecute(calls: Call[]): Hex {
    const [only] = calls;
    const [mode, executionCalldata] =
      calls.length === 1 && only !== undefined
        ? [
            MODE_SINGLE,
            concat([
              only.to,
              pad(toHex(only.value ?? 0n), { size: 32 }),
              only.data,
            ]),
          ]
        : [
            MODE_BATCH,
            encodeAbiParameters(
              [
                {
                  type: 'tuple[]',
                  components: [
                    { name: 'target', type: 'address' },
                    { name: 'value', type: 'uint256' },
                    { name: 'callData', type: 'bytes' },
                  ],
                },
              ],
              [
                calls.map((c) => ({
                  target: c.to,
                  value: c.value ?? 0n,
                  callData: c.data,
                })),
              ],
            ),
          ];
    return concat([
      '0xe9ae5c53',
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes' }],
        [mode, executionCalldata],
      ),
    ]).toLowerCase() as Hex;
  }

  /** The calls of a vector case, with the decimal-string values as bigints. */
  const vectorCalls = (c: (typeof execute)['single']): Call[] =>
    c.calls.map((x) => ({ to: x.to, value: BigInt(x.value), data: x.data }));

  test('the selector is execute(bytes32,bytes) = 0xe9ae5c53', () => {
    expect(toFunctionSelector('execute(bytes32,bytes)')).toBe('0xe9ae5c53');
    expect(kernelExecuteCalldata([CALL_A]).slice(0, 10)).toBe('0xe9ae5c53');
    expect(kernelExecuteCalldata([CALL_A, CALL_B]).slice(0, 10)).toBe(
      '0xe9ae5c53',
    );
  });

  test('one call uses the single mode and packs target, value and data', () => {
    const data = kernelExecuteCalldata([CALL_A]);
    const decoded = decodeFunctionData({ abi: EXECUTE_ABI, data });
    expect(decoded.functionName).toBe('execute');
    const [mode, executionCalldata] = decoded.args;
    expect(mode).toBe(MODE_SINGLE);
    expect(size(executionCalldata)).toBe(20 + 32 + size(TRANSFER));
    expect(decodeSingle(executionCalldata)).toEqual(normalized(CALL_A));
  });

  test('one call is exactly the bytes of the packed form', () => {
    expect(kernelExecuteCalldata([CALL_A])).toBe(referenceExecute([CALL_A]));
  });

  test('one call: a missing value is 0, empty data is allowed, value can be 2^256 - 1', () => {
    for (const call of [
      CALL_B,
      CALL_C,
      { to: FACTORY, value: 0n, data: '0x' as Hex },
    ]) {
      const { args } = decodeFunctionData({
        abi: EXECUTE_ABI,
        data: kernelExecuteCalldata([call]),
      });
      expect(args[0]).toBe(MODE_SINGLE);
      expect(decodeSingle(args[1])).toEqual(normalized(call));
    }
    const [, packed] = decodeFunctionData({
      abi: EXECUTE_ABI,
      data: kernelExecuteCalldata([CALL_B]),
    }).args;
    expect(size(packed)).toBe(52);
    expect(slice(packed, 20, 52)).toBe(`0x${'00'.repeat(32)}`);
  });

  test('two calls use the batch mode and an ABI-encoded Execution[]', () => {
    const data = kernelExecuteCalldata([CALL_A, CALL_B]);
    const decoded = decodeFunctionData({ abi: EXECUTE_ABI, data });
    expect(decoded.functionName).toBe('execute');
    const [mode, executionCalldata] = decoded.args;
    expect(mode).toBe(MODE_BATCH);
    expect(decodeBatch(executionCalldata)).toEqual([
      normalized(CALL_A),
      normalized(CALL_B),
    ]);
  });

  test('two calls are exactly the bytes of the ABI-encoded batch', () => {
    expect(kernelExecuteCalldata([CALL_A, CALL_B])).toBe(
      referenceExecute([CALL_A, CALL_B]),
    );
  });

  test('matches the golden single-call calldata of the vector', () => {
    const { single } = execute;
    expect(single.calls).toHaveLength(1);
    expect(kernelExecuteCalldata(vectorCalls(single))).toBe(
      single.expectedCalldata,
    );
    expect(referenceExecute(vectorCalls(single))).toBe(single.expectedCalldata);
    expect(single.expectedCalldata.slice(0, 10)).toBe(execute.selector);
  });

  test('matches the golden batch calldata of the vector', () => {
    const { batch } = execute;
    expect(batch.calls).toHaveLength(2);
    expect(kernelExecuteCalldata(vectorCalls(batch))).toBe(
      batch.expectedCalldata,
    );
    expect(referenceExecute(vectorCalls(batch))).toBe(batch.expectedCalldata);
    expect(batch.expectedCalldata.slice(0, 10)).toBe(execute.selector);
  });

  test('the vector cases decode back to their calls, in the right mode', () => {
    for (const [c, mode] of [
      [execute.single, MODE_SINGLE],
      [execute.batch, MODE_BATCH],
    ] as const) {
      const { args } = decodeFunctionData({
        abi: EXECUTE_ABI,
        data: c.expectedCalldata,
      });
      expect(args[0]).toBe(mode);
      const decoded =
        mode === MODE_SINGLE ? [decodeSingle(args[1])] : decodeBatch(args[1]);
      expect(decoded).toEqual(vectorCalls(c).map(normalized));
    }
  });

  test('three calls keep their order and the large value', () => {
    const calls = [CALL_C, CALL_A, CALL_B];
    const { args } = decodeFunctionData({
      abi: EXECUTE_ABI,
      data: kernelExecuteCalldata(calls),
    });
    expect(args[0]).toBe(MODE_BATCH);
    expect(decodeBatch(args[1])).toEqual(calls.map(normalized));
  });

  test(`accepts exactly ${MAX_CALLS} calls`, () => {
    const calls = Array.from({ length: MAX_CALLS }, (_, i) => ({
      to: FACTORY,
      value: BigInt(i),
      data: '0xdeadbeef' as Hex,
    }));
    const { args } = decodeFunctionData({
      abi: EXECUTE_ABI,
      data: kernelExecuteCalldata(calls),
    });
    expect(args[0]).toBe(MODE_BATCH);
    expect(decodeBatch(args[1])).toEqual(calls.map(normalized));
  });

  test('accepts any address case and any data case; the bytes are the same', () => {
    const lower = kernelExecuteCalldata([
      { to: FACTORY.toLowerCase() as Hex, value: 5n, data: TRANSFER },
      { to: VALIDATOR.toLowerCase() as Hex, data: '0x' },
    ]);
    const upper = kernelExecuteCalldata([
      {
        to: `0x${FACTORY.slice(2).toUpperCase()}`,
        value: 5n,
        data: `0x${TRANSFER.slice(2).toUpperCase()}`,
      },
      { to: `0x${VALIDATOR.slice(2).toUpperCase()}`, data: '0x' },
    ]);
    const mixed = kernelExecuteCalldata([CALL_A, CALL_B]);
    expect(lower).toBe(mixed);
    expect(upper).toBe(mixed);
  });

  test('does not modify the calls it is given', () => {
    const calls: Call[] = [{ ...CALL_B }, { ...CALL_A }];
    const before = JSON.stringify(calls, (_, v) =>
      typeof v === 'bigint' ? `${v}n` : v,
    );
    kernelExecuteCalldata(calls);
    expect(
      JSON.stringify(calls, (_, v) => (typeof v === 'bigint' ? `${v}n` : v)),
    ).toBe(before);
  });

  test('rejects 0 calls and more than MAX_CALLS calls', () => {
    expectInvalid(() => kernelExecuteCalldata([]), 'calls');
    const tooMany = Array.from({ length: MAX_CALLS + 1 }, () => CALL_A);
    const error = expectInvalid(() => kernelExecuteCalldata(tooMany), 'calls');
    expect(error.message).toContain(String(MAX_CALLS));
  });

  test('rejects an argument that is not an array, and a call that is not an object', () => {
    for (const bad of [undefined, null, 'x', 1, {}, new Set([CALL_A])]) {
      expectInvalid(
        () => kernelExecuteCalldata(bad as unknown as Call[]),
        'calls',
      );
    }
    // A hole in a sparse array is an invalid call, not a skipped one.
    expectInvalid(
      () => kernelExecuteCalldata(new Array(2) as Call[]),
      'calls[0]',
    );
    expectInvalid(
      () =>
        kernelExecuteCalldata(
          Object.assign(new Array(3), { 0: CALL_A, 2: CALL_B }) as Call[],
        ),
      'calls[1]',
    );
    for (const bad of [null, undefined, 'x', 1]) {
      expectInvalid(
        () => kernelExecuteCalldata([bad as unknown as Call]),
        'calls[0]',
      );
      expectInvalid(
        () => kernelExecuteCalldata([CALL_A, bad as unknown as Call]),
        'calls[1]',
      );
    }
  });

  test('rejects a bad target, value or data, naming the call and the field', () => {
    const bad = (override: Record<string, unknown>) =>
      ({ ...CALL_A, ...override }) as unknown as Call;

    for (const to of ['0x1234', 'nope', '', undefined, 5]) {
      expectInvalid(() => kernelExecuteCalldata([bad({ to })]), 'calls[0].to');
      expectInvalid(
        () => kernelExecuteCalldata([CALL_B, bad({ to })]),
        'calls[1].to',
      );
    }
    for (const value of [-1n, UINT256_MAX + 1n, 1, '1', null]) {
      expectInvalid(
        () => kernelExecuteCalldata([bad({ value })]),
        'calls[0].value',
      );
      expectInvalid(
        () => kernelExecuteCalldata([CALL_B, bad({ value })]),
        'calls[1].value',
      );
    }
    for (const data of [
      '0xabc',
      'abcd',
      '0xzz',
      '0x0',
      '',
      undefined,
      null,
      123,
    ]) {
      expectInvalid(
        () => kernelExecuteCalldata([bad({ data })]),
        'calls[0].data',
      );
      expectInvalid(
        () => kernelExecuteCalldata([CALL_B, bad({ data })]),
        'calls[1].data',
      );
    }
  });

  test('checks a call in the order to, value, data, and calls in order', () => {
    const allBad = { to: 'x', value: -1n, data: 'y' } as unknown as Call;
    expectInvalid(() => kernelExecuteCalldata([allBad]), 'calls[0].to');
    expectInvalid(
      () => kernelExecuteCalldata([{ ...allBad, to: FACTORY }]),
      'calls[0].value',
    );
    expectInvalid(
      () => kernelExecuteCalldata([{ ...allBad, to: FACTORY, value: 0n }]),
      'calls[0].data',
    );
    expectInvalid(
      () => kernelExecuteCalldata([CALL_A, allBad, { ...allBad, to: FACTORY }]),
      'calls[1].to',
    );
  });
});
