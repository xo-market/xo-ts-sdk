import {
  concat,
  encodeAbiParameters,
  getAddress,
  type Hex,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  stringToHex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, test } from 'vitest';
import {
  cancelAllTypedData,
  cancelOrderTypedData,
} from '../../src/signing/cancel';
import { hashOrder, orderDomain } from '../../src/signing/order';
import {
  BAD_CHECKSUM_EXCHANGE,
  cancelVector,
  DOMAIN,
  expectInvalid,
  inputs,
  ORDER,
  orderVector,
} from './helpers';

const TYPE_HASH_DOMAIN = keccak256(
  stringToHex(
    'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
  ),
);

/** The gateway's algorithm, written without viem's typed-data code. */
function referenceDigest(structHash: Hex): Hex {
  const separator = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        TYPE_HASH_DOMAIN,
        keccak256(stringToHex('XO Market CLOB')),
        keccak256(stringToHex('1')),
        BigInt(inputs.chainId),
        getAddress(inputs.exchange),
      ],
    ),
  );
  return keccak256(concat(['0x1901', separator, structHash]));
}

function referenceCancelOrder(orderId: bigint, marketId: string): Hex {
  return referenceDigest(
    keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'uint64' }, { type: 'bytes32' }],
        [
          keccak256(stringToHex('CancelOrder(uint64 orderId,string marketId)')),
          orderId,
          keccak256(stringToHex(marketId)),
        ],
      ),
    ),
  );
}

function referenceCancelAll(marketId: string): Hex {
  return referenceDigest(
    keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }],
        [
          keccak256(stringToHex('CancelAll(string marketId)')),
          keccak256(stringToHex(marketId)),
        ],
      ),
    ),
  );
}

describe('cancelAllTypedData', () => {
  test("cancelAllTypedData('') has primaryType CancelAll and message {marketId:''}", () => {
    const typed = cancelAllTypedData('', DOMAIN);
    expect(typed.primaryType).toBe('CancelAll');
    expect(typed.message).toEqual({ marketId: '' });
    expect(typed.types).toEqual({
      CancelAll: [{ name: 'marketId', type: 'string' }],
    });
    expect(typed.domain).toEqual(DOMAIN);
  });

  test('a market id is carried in the message', () => {
    expect(cancelAllTypedData('market-1', DOMAIN).message).toEqual({
      marketId: 'market-1',
    });
  });

  test('digest matches the gateway algorithm, global and per market', () => {
    for (const marketId of ['', 'market-1', 'ünïcode ✓']) {
      expect(hashTypedData(cancelAllTypedData(marketId, DOMAIN))).toBe(
        referenceCancelAll(marketId),
      );
    }
  });

  test('normalizes the verifying contract of the domain it is given', () => {
    const raw = { ...DOMAIN, verifyingContract: BAD_CHECKSUM_EXCHANGE };
    expect(cancelAllTypedData('', raw).domain).toEqual(DOMAIN);
    expect(hashTypedData(cancelAllTypedData('', raw))).toBe(
      referenceCancelAll(''),
    );
  });
});

describe('cancelOrderTypedData', () => {
  test('has primaryType CancelOrder and the order id and market id in the message', () => {
    const typed = cancelOrderTypedData(42n, 'market-1', DOMAIN);
    expect(typed.primaryType).toBe('CancelOrder');
    expect(typed.message).toEqual({ orderId: 42n, marketId: 'market-1' });
    expect(typed.types).toEqual({
      CancelOrder: [
        { name: 'orderId', type: 'uint64' },
        { name: 'marketId', type: 'string' },
      ],
    });
    expect(typed.domain).toEqual(DOMAIN);
  });

  test('digest matches the gateway algorithm', () => {
    const cases: Array<[bigint, string]> = [
      [42n, 'market-1'],
      [0n, 'market-1'],
      [2n ** 64n - 1n, 'market-1'],
      [7n, ''],
    ];
    for (const [orderId, marketId] of cases) {
      expect(
        hashTypedData(cancelOrderTypedData(orderId, marketId, DOMAIN)),
      ).toBe(referenceCancelOrder(orderId, marketId));
    }
  });

  test('accepts an empty market id (the gateway does not forbid it)', () => {
    expect(cancelOrderTypedData(1n, '', DOMAIN).message).toEqual({
      orderId: 1n,
      marketId: '',
    });
  });

  test('normalizes the verifying contract of the domain it is given', () => {
    const raw = { ...DOMAIN, verifyingContract: BAD_CHECKSUM_EXCHANGE };
    expect(hashTypedData(cancelOrderTypedData(42n, 'market-1', raw))).toBe(
      referenceCancelOrder(42n, 'market-1'),
    );
  });
});

describe('cancel golden vectors (test-vectors/cancel.json)', () => {
  const domain = orderDomain(
    cancelVector.inputs.chainId,
    cancelVector.inputs.exchange,
  );

  test('uses the same domain as the order vector', () => {
    expect(cancelVector.inputs).toEqual({
      chainId: inputs.chainId,
      exchange: inputs.exchange,
    });
    expect(cancelVector.domain).toEqual(orderVector.domain);
  });

  test('its domain block equals orderDomain(chainId, exchange)', () => {
    expect(cancelVector.domain).toEqual(
      orderDomain(cancelVector.inputs.chainId, cancelVector.inputs.exchange),
    );
  });

  test('pins the type strings of the gateway', () => {
    expect(cancelVector.typeStrings).toEqual({
      CancelOrder: 'CancelOrder(uint64 orderId,string marketId)',
      CancelAll: 'CancelAll(string marketId)',
    });
  });

  test('covers CancelOrder, a global CancelAll and a per-market CancelAll', () => {
    expect(
      cancelVector.cases.map((c) => [
        c.primaryType,
        c.message.orderId,
        c.message.marketId,
      ]),
    ).toEqual([
      ['CancelOrder', '42', 'market-1'],
      ['CancelAll', undefined, ''],
      ['CancelAll', undefined, 'market-1'],
    ]);
  });

  test.each(cancelVector.cases)(
    '$name: the SDK and the independent keccak re-implementation both match',
    (c) => {
      expect(c.expectedDigest).toMatch(/^0x[0-9a-f]{64}$/);
      if (c.primaryType === 'CancelOrder') {
        const orderId = BigInt(c.message.orderId ?? 'missing');
        const typed = cancelOrderTypedData(orderId, c.message.marketId, domain);
        expect(typed.primaryType).toBe('CancelOrder');
        expect(hashTypedData(typed)).toBe(c.expectedDigest);
        expect(referenceCancelOrder(orderId, c.message.marketId)).toBe(
          c.expectedDigest,
        );
      } else {
        const typed = cancelAllTypedData(c.message.marketId, domain);
        expect(typed.primaryType).toBe('CancelAll');
        expect(hashTypedData(typed)).toBe(c.expectedDigest);
        expect(referenceCancelAll(c.message.marketId)).toBe(c.expectedDigest);
      }
    },
  );

  test('the three digests are distinct', () => {
    const digests = cancelVector.cases.map((c) => c.expectedDigest);
    expect(new Set(digests).size).toBe(digests.length);
  });
});

describe('cancel signing round trip', () => {
  // A throwaway key made for this test only.
  const account = privateKeyToAccount(generatePrivateKey());

  test('a signed cancel recovers to the signer', async () => {
    const typed = cancelOrderTypedData(42n, 'market-1', DOMAIN);
    const signature = await account.signTypedData(typed);
    const recovered = await recoverTypedDataAddress({ ...typed, signature });
    expect(recovered).toBe(account.address);
  });

  test('a signed cancel-all recovers to the signer', async () => {
    for (const marketId of ['', 'market-1']) {
      const typed = cancelAllTypedData(marketId, DOMAIN);
      const signature = await account.signTypedData(typed);
      const recovered = await recoverTypedDataAddress({ ...typed, signature });
      expect(recovered).toBe(account.address);
    }
  });

  test('cancel, cancel-all and order digests all differ', () => {
    const digests = new Set([
      hashTypedData(cancelOrderTypedData(42n, 'market-1', DOMAIN)),
      hashTypedData(cancelOrderTypedData(42n, '', DOMAIN)),
      hashTypedData(cancelAllTypedData('market-1', DOMAIN)),
      hashTypedData(cancelAllTypedData('', DOMAIN)),
      hashOrder(ORDER, DOMAIN),
    ]);
    expect(digests.size).toBe(5);
  });
});

describe('cancel input validation', () => {
  test('cancel order id must be a bigint in [0, 2^64)', () => {
    for (const bad of [-1n, 2n ** 64n, 42, '42', 4.2, undefined, null]) {
      expectInvalid(
        () => cancelOrderTypedData(bad as bigint, 'market-1', DOMAIN),
        'orderId',
      );
    }
    expect(() => cancelOrderTypedData(0n, 'm', DOMAIN)).not.toThrow();
    expect(() =>
      cancelOrderTypedData(2n ** 64n - 1n, 'm', DOMAIN),
    ).not.toThrow();
  });

  test('marketId must be a string (empty is allowed)', () => {
    for (const bad of [42, 42n, undefined, null, {}, ['a']]) {
      expectInvalid(
        () => cancelOrderTypedData(1n, bad as string, DOMAIN),
        'marketId',
      );
      expectInvalid(
        () => cancelAllTypedData(bad as string, DOMAIN),
        'marketId',
      );
    }
    expect(() => cancelOrderTypedData(1n, '', DOMAIN)).not.toThrow();
    expect(() => cancelAllTypedData('', DOMAIN)).not.toThrow();
  });
});
