import {
  concat,
  encodeAbiParameters,
  type Hex,
  hashTypedData,
  isAddress,
  keccak256,
  recoverTypedDataAddress,
  stringToHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, test } from 'vitest';
import {
  CLOB_AUTH_MESSAGE,
  clobAuthTypedData,
  l1Headers,
} from '../../src/signing/clobAuth';
import { clobAuthVector, expectInvalid } from './helpers';

const { inputs } = clobAuthVector;

const PARAMS = {
  address: inputs.address,
  timestamp: inputs.timestamp,
  nonce: BigInt(inputs.nonce),
  chainId: inputs.chainId,
};

/** The vector address with the case of its first letter flipped: a wrong EIP-55 checksum. */
function withWrongChecksum(address: string): string {
  const index = address.slice(2).search(/[a-fA-F]/) + 2;
  const flipped = address[index];
  if (flipped === undefined || index < 2) {
    throw new Error('the vector address has no letter to flip');
  }
  const swapped =
    flipped === flipped.toUpperCase()
      ? flipped.toLowerCase()
      : flipped.toUpperCase();
  return address.slice(0, index) + swapped + address.slice(index + 1);
}

/** The gateway's algorithm, written without viem's typed-data code. */
function referenceDigest(p: {
  address: string;
  timestamp: string;
  nonce: bigint;
  chainId: number;
}): Hex {
  const separator = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
      ],
      [
        keccak256(stringToHex(clobAuthVector.typeStrings.EIP712Domain)),
        keccak256(stringToHex('ClobAuthDomain')),
        keccak256(stringToHex('1')),
        BigInt(p.chainId),
      ],
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'bytes32' },
      ],
      [
        keccak256(stringToHex(clobAuthVector.typeStrings.ClobAuth)),
        p.address as Hex,
        keccak256(stringToHex(p.timestamp)),
        p.nonce,
        keccak256(stringToHex(CLOB_AUTH_MESSAGE)),
      ],
    ),
  );
  return keccak256(concat(['0x1901', separator, structHash]));
}

describe('ClobAuth vector', () => {
  test('the message constant matches the vector', () => {
    expect(CLOB_AUTH_MESSAGE).toBe(
      'This message attests that I control the given wallet',
    );
    expect(CLOB_AUTH_MESSAGE).toBe(clobAuthVector.message);
  });

  test('the vector key belongs to the vector address', () => {
    expect(privateKeyToAccount(inputs.privateKey).address).toBe(inputs.address);
    expect(inputs.privateKeyNote).toBe('test-only pattern key — never fund');
  });

  test('hashTypedData gives the vector digest', () => {
    expect(hashTypedData(clobAuthTypedData(PARAMS))).toBe(
      clobAuthVector.expectedDigest,
    );
  });

  test('the digest equals a hand-written implementation of the gateway algorithm', () => {
    expect(referenceDigest(PARAMS)).toBe(clobAuthVector.expectedDigest);
  });

  test('signing with the vector key gives the vector signature', async () => {
    const account = privateKeyToAccount(inputs.privateKey);
    const signature = await account.signTypedData(clobAuthTypedData(PARAMS));
    expect(signature).toBe(clobAuthVector.expectedSignature);
  });

  test('the vector signature recovers the vector address', async () => {
    const address = await recoverTypedDataAddress({
      ...clobAuthTypedData(PARAMS),
      signature: clobAuthVector.expectedSignature,
    });
    expect(address).toBe(inputs.address);
  });
});

describe('clobAuthTypedData', () => {
  test('the domain is name, version and chainId only: no verifyingContract', () => {
    const { domain } = clobAuthTypedData(PARAMS);
    expect(domain).toEqual({
      name: 'ClobAuthDomain',
      version: '1',
      chainId: 3223,
    });
    expect(Object.keys(domain ?? {})).toEqual(['name', 'version', 'chainId']);
    // And the domain of the shared vector, which the other SDKs read too.
    expect(domain).toEqual(clobAuthVector.domain);
    expect(Object.keys(domain ?? {})).toEqual(
      Object.keys(clobAuthVector.domain),
    );
  });

  test('has the ClobAuth type of the gateway, in field order', () => {
    const typed = clobAuthTypedData(PARAMS);
    expect(typed.primaryType).toBe('ClobAuth');
    expect(typed.types).toEqual({
      ClobAuth: [
        { name: 'address', type: 'address' },
        { name: 'timestamp', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'message', type: 'string' },
      ],
    });
    // The same fields as the type string of the vector.
    expect(clobAuthVector.typeStrings.ClobAuth).toBe(
      `ClobAuth(${typed.types.ClobAuth.map((f) => `${f.type} ${f.name}`).join(',')})`,
    );
  });

  test('the message carries the constant, the timestamp as given and the nonce as a bigint', () => {
    expect(clobAuthTypedData({ ...PARAMS, nonce: 7n }).message).toEqual({
      address: inputs.address,
      timestamp: '1700000000',
      nonce: 7n,
      message: CLOB_AUTH_MESSAGE,
    });
  });

  test('a lower-case address is checksummed in the message', () => {
    const typed = clobAuthTypedData({
      ...PARAMS,
      address: inputs.address.toLowerCase() as typeof inputs.address,
    });
    expect(typed.message.address).toBe(inputs.address);
  });

  test('an address with a wrong mixed-case checksum hashes like the vector', () => {
    const wrong = withWrongChecksum(inputs.address);
    // Not a valid EIP-55 address, so viem alone would reject it.
    expect(isAddress(wrong)).toBe(false);
    expect(wrong).not.toBe(inputs.address);
    const typed = clobAuthTypedData({
      ...PARAMS,
      address: wrong as typeof inputs.address,
    });
    expect(typed.message.address).toBe(inputs.address);
    expect(hashTypedData(typed)).toBe(clobAuthVector.expectedDigest);
  });

  test('the digest follows the timestamp, nonce and chain id', () => {
    const base = hashTypedData(clobAuthTypedData(PARAMS));
    const variants = [
      { ...PARAMS, timestamp: '1700000001' },
      { ...PARAMS, nonce: 1n },
      { ...PARAMS, chainId: 1 },
    ];
    const digests = variants.map((v) => hashTypedData(clobAuthTypedData(v)));
    expect(new Set([base, ...digests]).size).toBe(4);
    for (const [i, v] of variants.entries()) {
      expect(digests[i]).toBe(referenceDigest(v));
    }
  });

  test('accepts the largest nonce, 2^256 - 1, and signs it', () => {
    const nonce = (1n << 256n) - 1n;
    const typed = clobAuthTypedData({ ...PARAMS, nonce });
    expect(hashTypedData(typed)).toBe(referenceDigest({ ...PARAMS, nonce }));
  });

  test.each([
    ['negative', -1n],
    ['2^256', 1n << 256n],
    ['a number', 0],
    ['a decimal string', '0'],
    ['undefined', undefined],
  ])('rejects a nonce that is %s', (_name, nonce) => {
    expectInvalid(
      () => clobAuthTypedData({ ...PARAMS, nonce: nonce as bigint }),
      'nonce',
    );
  });

  test.each([
    ['zero', 0],
    ['negative', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['above the safe integer range', 2 ** 53],
    ['a bigint', 3223n],
    ['a string', '3223'],
    ['undefined', undefined],
  ])('rejects a chainId that is %s', (_name, chainId) => {
    expectInvalid(
      () => clobAuthTypedData({ ...PARAMS, chainId: chainId as number }),
      'chainId',
    );
  });

  test('accepts the largest safe-integer chainId', () => {
    const chainId = Number.MAX_SAFE_INTEGER;
    expect(hashTypedData(clobAuthTypedData({ ...PARAMS, chainId }))).toBe(
      referenceDigest({ ...PARAMS, chainId }),
    );
  });

  test.each([
    ['empty', ''],
    ['too short', '0x1234'],
    ['not hex', '0xzz91697260E4c9A71f18484C9f997B308e59325'],
    ['without the prefix', '14791697260E4c9A71f18484C9f997B308e59325'],
    ['too long', `${inputs.address}00`],
    ['not a string', 12345],
  ])('rejects an address that is %s', (_name, address) => {
    expectInvalid(
      () => clobAuthTypedData({ ...PARAMS, address: address as never }),
      'address',
    );
  });

  test.each([
    ['empty', ''],
    ['a decimal', '1700000000.5'],
    ['negative', '-1'],
    ['padded', '1700000000 '],
    ['an ISO date', '2023-11-14T22:13:20Z'],
    ['a number', 1700000000],
    ['undefined', undefined],
  ])('rejects a timestamp that is %s', (_name, timestamp) => {
    expectInvalid(
      () => clobAuthTypedData({ ...PARAMS, timestamp: timestamp as string }),
      'timestamp',
    );
  });
});

describe('l1Headers', () => {
  const SIGNATURE = clobAuthVector.expectedSignature;
  const HEADER_PARAMS = {
    address: inputs.address,
    signature: SIGNATURE,
    timestamp: inputs.timestamp,
    nonce: BigInt(inputs.nonce),
  };

  test('matches the vector headers, with the nonce as "0"', () => {
    const headers = l1Headers(HEADER_PARAMS);
    expect(headers).toEqual(clobAuthVector.expectedHeaders);
    expect(headers.XO_NONCE).toBe('0');
  });

  test('returns exactly the four L1 headers', () => {
    expect(Object.keys(l1Headers(HEADER_PARAMS)).sort()).toEqual([
      'XO_ADDRESS',
      'XO_NONCE',
      'XO_SIGNATURE',
      'XO_TIMESTAMP',
    ]);
  });

  test('stringifies the nonce as decimal, not hex', () => {
    expect(l1Headers({ ...HEADER_PARAMS, nonce: 255n }).XO_NONCE).toBe('255');
    expect(l1Headers({ ...HEADER_PARAMS, nonce: 1n << 255n }).XO_NONCE).toBe(
      (1n << 255n).toString(10),
    );
    expect(
      l1Headers({ ...HEADER_PARAMS, nonce: (1n << 256n) - 1n }).XO_NONCE,
    ).toBe(
      '115792089237316195423570985008687907853269984665640564039457584007913129639935',
    );
  });

  test('emits XO_ADDRESS checksummed, from any case', () => {
    const lower = inputs.address.toLowerCase() as typeof inputs.address;
    expect(l1Headers({ ...HEADER_PARAMS, address: lower }).XO_ADDRESS).toBe(
      inputs.address,
    );
    const wrong = withWrongChecksum(inputs.address) as typeof inputs.address;
    expect(l1Headers({ ...HEADER_PARAMS, address: wrong }).XO_ADDRESS).toBe(
      inputs.address,
    );
  });

  test('passes the signature and timestamp through unchanged', () => {
    const headers = l1Headers({
      ...HEADER_PARAMS,
      signature: '0xABCDef',
      timestamp: '1700000042',
    });
    expect(headers.XO_SIGNATURE).toBe('0xABCDef');
    expect(headers.XO_TIMESTAMP).toBe('1700000042');
  });

  test.each([
    ['a 65-byte ECDSA signature', SIGNATURE],
    ['a 2-byte value', '0x1234'],
    ['a 1-byte value', '0x00'],
    ['an upper-case value', '0xABCD'],
    // EIP-1271 signatures of smart wallets are not 65 bytes.
    ['a 300-byte EIP-1271 signature', `0x${'ab'.repeat(300)}`],
  ])('accepts %s', (_name, signature) => {
    expect(
      l1Headers({ ...HEADER_PARAMS, signature: signature as Hex }).XO_SIGNATURE,
    ).toBe(signature);
  });

  test.each([
    ['empty', ''],
    ['just the prefix', '0x'],
    ['an odd number of digits', '0xabc'],
    ['without the prefix', 'abcd'],
    ['with an upper-case prefix', '0XABCD'],
    ['not hex', '0xzzzz'],
    ['padded with a space', '0xabcd '],
    ['not a string', 4660],
  ])('rejects a signature that is %s', (_name, signature) => {
    expectInvalid(
      () => l1Headers({ ...HEADER_PARAMS, signature: signature as Hex }),
      'signature',
    );
  });

  test('rejects a bad address, timestamp or nonce', () => {
    expectInvalid(
      () => l1Headers({ ...HEADER_PARAMS, address: '0x1234' as never }),
      'address',
    );
    expectInvalid(
      () => l1Headers({ ...HEADER_PARAMS, timestamp: '17e8' }),
      'timestamp',
    );
    expectInvalid(() => l1Headers({ ...HEADER_PARAMS, nonce: -1n }), 'nonce');
    expectInvalid(
      () => l1Headers({ ...HEADER_PARAMS, nonce: 1n << 256n }),
      'nonce',
    );
    expectInvalid(
      () => l1Headers({ ...HEADER_PARAMS, nonce: 0 as unknown as bigint }),
      'nonce',
    );
  });

  test('a signature made over the typed data round-trips into the headers', async () => {
    const account = privateKeyToAccount(inputs.privateKey);
    const signature = await account.signTypedData(clobAuthTypedData(PARAMS));
    const headers = l1Headers({ ...HEADER_PARAMS, signature });
    expect(headers).toEqual(clobAuthVector.expectedHeaders);
  });
});
