import {
  type Address,
  getAddress,
  type Hex,
  hashTypedData,
  isAddress,
  recoverTypedDataAddress,
  type TypedDataDomain,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, test } from 'vitest';
import {
  cancelAllTypedData,
  cancelOrderTypedData,
} from '../../src/signing/cancel';
import {
  hashOrder,
  ORDER_TYPES,
  type OrderStruct,
  orderDomain,
  orderTypedData,
  toWireOrder,
} from '../../src/signing/order';
import {
  BAD_CHECKSUM_EXCHANGE,
  badOrder,
  DOMAIN,
  expectInvalid,
  inputs,
  ORDER,
  orderVector,
} from './helpers';

// A 65-byte signature, in mixed case. Used where the signature itself does not matter.
const SIGNATURE = `0x${'ab'.repeat(32)}${'CD'.repeat(32)}1b` as Hex;

/** `n` bytes of mixed-case hex. */
const hexBytes = (n: number): Hex => `0x${'Ef'.repeat(n)}`;

// The Order type string the exchange signs. Written out here on purpose, so the
// test fails if either ORDER_TYPES or the shared vector drifts from it.
const ORDER_TYPE_STRING =
  'Order(uint256 salt,address maker,address signer,address beneficiary,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint128 nonce,bytes16 identifier,bytes32 metadata,uint8 side,uint8 signatureType)';

// ---------------------------------------------------------------------------
// Golden vector
// ---------------------------------------------------------------------------

describe('hashOrder', () => {
  test('hashOrder matches the deployed exchange vector', () => {
    expect(hashOrder(ORDER, DOMAIN)).toBe(orderVector.expectedDigest);
    expect(orderVector.expectedDigest).toBe(
      '0x7888da24d7e5af54e92846246e411c3edd1a7ae16bd64b59824130a212c5bf9f',
    );
  });

  test('the same vector with uppercase-hex maker 0x…00A1 still hashes identically after normalizeAddress', () => {
    const upper = badOrder({
      maker: '0x00000000000000000000000000000000000000A1',
    });
    expect(upper.maker).not.toBe(ORDER.maker);
    expect(hashOrder(upper, DOMAIN)).toBe(orderVector.expectedDigest);
  });

  test('every address hashes identically in any case, including a wrong mixed-case checksum', () => {
    // 0x…00B2 is not the checksummed form of the beneficiary, so viem alone would throw.
    const wrongBeneficiary = '0x00000000000000000000000000000000000000B2';
    expect(isAddress(wrongBeneficiary)).toBe(false);
    expect(isAddress(BAD_CHECKSUM_EXCHANGE)).toBe(false);
    const order = badOrder({
      maker: '0x00000000000000000000000000000000000000A1',
      signer: '0x00000000000000000000000000000000000000A1',
      beneficiary: wrongBeneficiary,
    });
    const domain = orderDomain(inputs.chainId, BAD_CHECKSUM_EXCHANGE);
    expect(hashOrder(order, domain)).toBe(orderVector.expectedDigest);
    // a domain that was not built by orderDomain is normalized too
    const raw = { ...DOMAIN, verifyingContract: BAD_CHECKSUM_EXCHANGE };
    expect(hashOrder(order, raw)).toBe(orderVector.expectedDigest);
    const lower = inputs.exchange.toLowerCase() as Address;
    expect(hashOrder(ORDER, { ...DOMAIN, verifyingContract: lower })).toBe(
      orderVector.expectedDigest,
    );
  });

  test('a wrong mixed-case checksum on maker, signer or beneficiary does not change the hash', () => {
    const wrong = '0xD8Da6bf26964aF9D7eEd9e03E53415D37aA96045';
    expect(isAddress(wrong)).toBe(false);
    for (const field of ['maker', 'signer', 'beneficiary']) {
      expect(hashOrder(badOrder({ [field]: wrong }), DOMAIN), field).toBe(
        hashOrder(badOrder({ [field]: wrong.toLowerCase() }), DOMAIN),
      );
    }
  });

  test('upper-case identifier and metadata hex hash identically to lower-case', () => {
    const upper = badOrder({
      identifier: `0x${inputs.identifier.slice(2).toUpperCase()}`,
      metadata: `0x${inputs.metadata.slice(2).toUpperCase()}`,
    });
    expect(upper.identifier).not.toBe(ORDER.identifier);
    expect(hashOrder(upper, DOMAIN)).toBe(orderVector.expectedDigest);
  });

  test('every field is part of the hash', () => {
    const changes: Record<string, unknown> = {
      salt: 2n,
      maker: '0x00000000000000000000000000000000000000c3',
      signer: '0x00000000000000000000000000000000000000c3',
      beneficiary: '0x00000000000000000000000000000000000000c3',
      tokenId: 4661n,
      makerAmount: 501n,
      takerAmount: 1001n,
      expiration: 1n,
      nonce: 10n,
      identifier: '0xdeadbeef000000000000000000000012',
      metadata:
        '0x00000000000000000000000000000000000000000000000000000000000000fe',
      side: 1,
      signatureType: 3,
    };
    for (const [field, value] of Object.entries(changes)) {
      expect(hashOrder(badOrder({ [field]: value }), DOMAIN), field).not.toBe(
        orderVector.expectedDigest,
      );
    }
  });

  test('the chain id and the exchange address are part of the hash', () => {
    expect(
      hashOrder(ORDER, orderDomain(inputs.chainId + 1, inputs.exchange)),
    ).not.toBe(orderVector.expectedDigest);
    expect(
      hashOrder(
        ORDER,
        orderDomain(
          inputs.chainId,
          '0x00000000000000000000000000000000000000d4',
        ),
      ),
    ).not.toBe(orderVector.expectedDigest);
  });

  test('accepts the largest and smallest values of every range', () => {
    const max256 = 2n ** 256n - 1n;
    const widest = badOrder({
      salt: max256,
      tokenId: max256,
      makerAmount: max256,
      takerAmount: max256,
      expiration: max256,
      nonce: 2n ** 128n - 1n,
    });
    expect(hashOrder(widest, DOMAIN)).toMatch(/^0x[0-9a-f]{64}$/);
    const zero = badOrder({
      salt: 0n,
      tokenId: 0n,
      makerAmount: 0n,
      takerAmount: 0n,
      expiration: 0n,
      nonce: 0n,
    });
    expect(hashOrder(zero, DOMAIN)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// ORDER_TYPES / orderDomain / orderTypedData
// ---------------------------------------------------------------------------

describe('ORDER_TYPES', () => {
  test('ORDER_TYPES field order equals the written-out type string', () => {
    const fields = ORDER_TYPES.Order.map(
      (field) => `${field.type} ${field.name}`,
    ).join(',');
    expect(`Order(${fields})`).toBe(ORDER_TYPE_STRING);
    expect(orderVector.typeString).toBe(ORDER_TYPE_STRING);
  });

  test('has no EIP712Domain entry (viem derives it)', () => {
    expect(Object.keys(ORDER_TYPES)).toEqual(['Order']);
  });
});

describe('orderDomain', () => {
  test('its domain block in order.json equals orderDomain(chainId, exchange)', () => {
    expect(orderVector.domain).toEqual(
      orderDomain(inputs.chainId, inputs.exchange),
    );
  });

  test('builds the XO Market CLOB domain with a checksummed exchange', () => {
    expect(DOMAIN).toEqual({
      name: 'XO Market CLOB',
      version: '1',
      chainId: 3223,
      verifyingContract: '0x4bC5E872256D12E6017dfe466E04c867DC761B77',
    });
  });

  test('checksums an exchange address of any case', () => {
    const checksummed = getAddress(inputs.exchange);
    expect(
      orderDomain(inputs.chainId, inputs.exchange.toLowerCase() as Address)
        .verifyingContract,
    ).toBe(checksummed);
    expect(
      orderDomain(inputs.chainId, BAD_CHECKSUM_EXCHANGE).verifyingContract,
    ).toBe(checksummed);
  });
});

describe('orderTypedData', () => {
  test('returns the Order type, primary type and the normalized struct', () => {
    const typed = orderTypedData(
      badOrder({ maker: '0x00000000000000000000000000000000000000A1' }),
      { ...DOMAIN, verifyingContract: BAD_CHECKSUM_EXCHANGE },
    );
    expect(typed.primaryType).toBe('Order');
    expect(typed.types).toBe(ORDER_TYPES);
    expect(typed.domain).toEqual(DOMAIN);
    expect(typed.message).toEqual({
      ...ORDER,
      maker: getAddress(ORDER.maker),
      signer: getAddress(ORDER.signer),
      beneficiary: getAddress(ORDER.beneficiary),
    });
    expect(hashTypedData(typed)).toBe(orderVector.expectedDigest);
  });

  test('ignores extra properties on the order', () => {
    const typed = orderTypedData(badOrder({ extra: 'x' }), DOMAIN);
    expect(Object.keys(typed.message).sort()).toEqual(
      ORDER_TYPES.Order.map((field) => field.name).sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// toWireOrder
// ---------------------------------------------------------------------------

describe('toWireOrder', () => {
  test("toWireOrder emits decimal strings and side 'BUY'", () => {
    expect(toWireOrder(ORDER, SIGNATURE)).toEqual({
      salt: '1',
      maker: getAddress(inputs.maker),
      signer: getAddress(inputs.signer),
      beneficiary: getAddress(inputs.beneficiary),
      tokenId: '4660',
      makerAmount: '500',
      takerAmount: '1000',
      expiration: '0',
      nonce: '9',
      identifier: '0xdeadbeef000000000000000000000011',
      metadata:
        '0x00000000000000000000000000000000000000000000000000000000000000ff',
      side: 'BUY',
      signatureType: 0,
      signature: SIGNATURE,
    });
  });

  test("emits side 'SELL' and signatureType 3", () => {
    const wire = toWireOrder(
      badOrder({ side: 1, signatureType: 3 }),
      SIGNATURE,
    );
    expect(wire.side).toBe('SELL');
    expect(wire.signatureType).toBe(3);
  });

  test('emits checksummed addresses for any input case', () => {
    const wire = toWireOrder(
      badOrder({
        maker: '0x00000000000000000000000000000000000000A1',
        signer: '0x00000000000000000000000000000000000000a1',
        beneficiary: '0x00000000000000000000000000000000000000B2',
      }),
      SIGNATURE,
    );
    expect(wire.maker).toBe(getAddress(inputs.maker));
    expect(wire.signer).toBe(getAddress(inputs.signer));
    expect(wire.beneficiary).toBe(getAddress(inputs.beneficiary));
  });

  test('writes the largest values as exact decimal strings (no exponent, no precision loss)', () => {
    const max256 = 2n ** 256n - 1n;
    const wire = toWireOrder(
      badOrder({
        salt: max256,
        tokenId: max256,
        makerAmount: max256,
        takerAmount: max256,
        expiration: max256,
        nonce: 2n ** 128n - 1n,
      }),
      SIGNATURE,
    );
    const MAX_256 =
      '115792089237316195423570985008687907853269984665640564039457584007913129639935';
    expect(wire.salt).toBe(MAX_256);
    expect(wire.tokenId).toBe(MAX_256);
    expect(wire.makerAmount).toBe(MAX_256);
    expect(wire.takerAmount).toBe(MAX_256);
    expect(wire.expiration).toBe(MAX_256);
    expect(wire.nonce).toBe('340282366920938463463374607431768211455');
    for (const value of [wire.salt, wire.nonce]) {
      expect(value).toMatch(/^[0-9]+$/);
    }
  });

  test('passes the signature through unchanged, in its own case', () => {
    expect(toWireOrder(ORDER, SIGNATURE).signature).toBe(SIGNATURE);
  });

  test('has exactly the 14 wire fields, even when the order carries extra properties', () => {
    const names = [
      'salt',
      'maker',
      'signer',
      'beneficiary',
      'tokenId',
      'makerAmount',
      'takerAmount',
      'expiration',
      'nonce',
      'identifier',
      'metadata',
      'side',
      'signatureType',
      'signature',
    ];
    expect(Object.keys(toWireOrder(ORDER, SIGNATURE))).toEqual(names);
    // an extra property, even one called `signature`, must not reach the wire
    const wire = toWireOrder(
      badOrder({ extra: 'x', signature: '0xdead', price: '0.5' }),
      SIGNATURE,
    );
    expect(Object.keys(wire)).toEqual(names);
    expect(wire.signature).toBe(SIGNATURE);
  });

  describe('signature', () => {
    const SMART_WALLET = { signatureType: 3 };

    test('must be non-empty, even-length 0x hex, for either signature type', () => {
      for (const bad of ['', '0x', '0xabc', 'abcd', '0xzz', undefined, 12]) {
        for (const order of [ORDER, badOrder(SMART_WALLET)]) {
          expectInvalid(() => toWireOrder(order, bad as Hex), 'signature');
        }
      }
      expect(() => toWireOrder(ORDER, '0xabc' as Hex)).toThrowError(
        'signature must be a non-empty, even-length 0x-prefixed hex string',
      );
    });

    test('an EOA order (signatureType 0) needs exactly 65 bytes', () => {
      for (const bytes of [1, 32, 64, 66, 130]) {
        expectInvalid(() => toWireOrder(ORDER, hexBytes(bytes)), 'signature');
      }
      expect(() => toWireOrder(ORDER, hexBytes(64))).toThrowError(
        'signature must be exactly 65 bytes for an EOA order (signatureType 0)',
      );
      expect(toWireOrder(ORDER, hexBytes(65)).signature).toBe(hexBytes(65));
    });

    test('a smart wallet order (signatureType 3) takes any non-empty even length', () => {
      for (const bytes of [1, 64, 65, 66, 130, 400]) {
        const wire = toWireOrder(badOrder(SMART_WALLET), hexBytes(bytes));
        expect(wire.signature).toBe(hexBytes(bytes));
        expect(wire.signatureType).toBe(3);
      }
    });
  });

  test('range-checks the order exactly like hashOrder', () => {
    expectInvalid(
      () => toWireOrder(badOrder({ salt: -1n }), SIGNATURE),
      'salt',
    );
    expectInvalid(
      () => toWireOrder(badOrder({ maker: '0x123' }), SIGNATURE),
      'maker',
    );
  });
});

describe('order signing round trip', () => {
  // A throwaway key made for this test only.
  const account = privateKeyToAccount(generatePrivateKey());

  test('a signed order recovers to the signer and goes on the wire unchanged', async () => {
    const order: OrderStruct = {
      ...ORDER,
      maker: account.address,
      signer: account.address,
    };
    const typed = orderTypedData(order, DOMAIN);
    const signature = await account.signTypedData(typed);
    const recovered = await recoverTypedDataAddress({ ...typed, signature });
    expect(recovered).toBe(account.address);
    expect(toWireOrder(order, signature).signature).toBe(signature);
  });
});

// ---------------------------------------------------------------------------
// Input validation: a field-named UserInputError, never a viem error
// ---------------------------------------------------------------------------

describe('input validation', () => {
  const calls: Array<[string, (order: OrderStruct) => unknown]> = [
    ['hashOrder', (order) => hashOrder(order, DOMAIN)],
    ['orderTypedData', (order) => orderTypedData(order, DOMAIN)],
    ['toWireOrder', (order) => toWireOrder(order, SIGNATURE)],
  ];

  describe.each(calls)('%s', (_name, call) => {
    test.each(['salt', 'tokenId', 'makerAmount', 'takerAmount', 'expiration'])(
      '%s must be a bigint in [0, 2^256)',
      (field) => {
        for (const bad of [-1n, 2n ** 256n, 5, '5', 5.5, undefined, null]) {
          expectInvalid(() => call(badOrder({ [field]: bad })), field);
        }
      },
    );

    test('the order must be an object', () => {
      for (const bad of [undefined, null, 'order', 1, 1n, true]) {
        expectInvalid(() => call(bad as unknown as OrderStruct), 'order');
      }
      expect(() => call(null as unknown as OrderStruct)).toThrowError(
        'order must be an object',
      );
    });

    test('nonce must be a bigint in [0, 2^128)', () => {
      for (const bad of [-1n, 2n ** 128n, 9, '9', undefined, null]) {
        expectInvalid(() => call(badOrder({ nonce: bad })), 'nonce');
      }
    });

    test('identifier must be exactly 16 bytes of hex', () => {
      const bad = [
        '0x',
        `0x${'00'.repeat(15)}`,
        `0x${'00'.repeat(17)}`,
        `0x${'00'.repeat(32)}`,
        `0x${'zz'.repeat(16)}`,
        '00'.repeat(16),
        `0X${'00'.repeat(16)}`,
        '',
        undefined,
        16,
      ];
      for (const value of bad) {
        expectInvalid(
          () => call(badOrder({ identifier: value })),
          'identifier',
        );
      }
    });

    test('metadata must be exactly 32 bytes of hex', () => {
      const bad = [
        '0x',
        `0x${'00'.repeat(31)}`,
        `0x${'00'.repeat(33)}`,
        `0x${'00'.repeat(16)}`,
        `0x${'zz'.repeat(32)}`,
        '00'.repeat(32),
        '',
        undefined,
        32,
      ];
      for (const value of bad) {
        expectInvalid(() => call(badOrder({ metadata: value })), 'metadata');
      }
    });

    test('side must be 0 or 1', () => {
      for (const bad of [
        2,
        -1,
        0.5,
        '0',
        'BUY',
        'SELL',
        0n,
        1n,
        undefined,
        null,
      ]) {
        expectInvalid(() => call(badOrder({ side: bad })), 'side');
      }
    });

    test('signatureType must be 0 or 3', () => {
      for (const bad of [1, 2, 4, -1, '0', '3', 3n, undefined, null]) {
        expectInvalid(
          () => call(badOrder({ signatureType: bad })),
          'signatureType',
        );
      }
    });

    test.each(['maker', 'signer', 'beneficiary'])(
      '%s must be a 20-byte hex address',
      (field) => {
        for (const bad of [
          '',
          '0x',
          '0x123',
          'not an address',
          `0x${'g'.repeat(40)}`,
          undefined,
          1n,
        ]) {
          expectInvalid(() => call(badOrder({ [field]: bad })), field);
        }
      },
    );
  });

  test('the bounds themselves are valid', () => {
    expect(() =>
      hashOrder(
        badOrder({
          salt: 2n ** 256n - 1n,
          nonce: 2n ** 128n - 1n,
          side: 1,
          signatureType: 3,
        }),
        DOMAIN,
      ),
    ).not.toThrow();
  });

  test('orderDomain rejects a chain id that is not a positive safe integer', () => {
    for (const bad of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 53,
      1n,
      '1',
      undefined,
    ]) {
      expectInvalid(
        () => orderDomain(bad as number, inputs.exchange),
        'chainId',
      );
    }
    expect(orderDomain(Number.MAX_SAFE_INTEGER, inputs.exchange).chainId).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(orderDomain(1, inputs.exchange).chainId).toBe(1);
  });

  test('orderDomain rejects a malformed exchange address', () => {
    for (const bad of ['', '0x', '0x123', `0x${'g'.repeat(40)}`, undefined]) {
      expectInvalid(
        () => orderDomain(inputs.chainId, bad as Address),
        'exchange',
      );
    }
  });

  test('a domain with a malformed verifyingContract is rejected by every builder', () => {
    const bad = { ...DOMAIN, verifyingContract: '0x123' as Address };
    const field = 'domain.verifyingContract';
    expectInvalid(() => orderTypedData(ORDER, bad), field);
    expectInvalid(() => hashOrder(ORDER, bad), field);
    expectInvalid(() => cancelOrderTypedData(1n, 'm', bad), field);
    expectInvalid(() => cancelAllTypedData('m', bad), field);
  });

  describe('the domain must be complete', () => {
    const builders: Array<[string, (domain: TypedDataDomain) => unknown]> = [
      ['orderTypedData', (domain) => orderTypedData(ORDER, domain)],
      ['hashOrder', (domain) => hashOrder(ORDER, domain)],
      [
        'cancelOrderTypedData',
        (domain) => cancelOrderTypedData(1n, 'market-1', domain),
      ],
      [
        'cancelAllTypedData',
        (domain) => cancelAllTypedData('market-1', domain),
      ],
    ];
    const without = (field: string): TypedDataDomain =>
      Object.fromEntries(
        Object.entries(DOMAIN).filter(([key]) => key !== field),
      ) as TypedDataDomain;

    describe.each(builders)('%s', (_name, build) => {
      test.each(['name', 'version', 'chainId', 'verifyingContract'])(
        'rejects a domain without %s',
        (field) => {
          expectInvalid(() => build(without(field)), `domain.${field}`);
          expectInvalid(
            () => build({ ...DOMAIN, [field]: undefined }),
            `domain.${field}`,
          );
        },
      );

      test.each(['name', 'version'])(
        'rejects an empty or non-string %s',
        (field) => {
          for (const bad of ['', 1, 1n, null, {}]) {
            expectInvalid(
              () => build({ ...DOMAIN, [field]: bad } as TypedDataDomain),
              `domain.${field}`,
            );
          }
        },
      );

      test('rejects a chainId that is not a positive safe integer or bigint', () => {
        for (const bad of [
          0,
          -1,
          1.5,
          Number.NaN,
          2 ** 53,
          '1',
          null,
          0n,
          -1n,
          2n ** 256n,
        ]) {
          expectInvalid(
            () => build({ ...DOMAIN, chainId: bad } as TypedDataDomain),
            'domain.chainId',
          );
        }
      });

      test('accepts a bigint chainId', () => {
        expect(() =>
          build({ ...DOMAIN, chainId: BigInt(inputs.chainId) }),
        ).not.toThrow();
      });

      test('rejects an extra key whose value is defined', () => {
        const extras: Array<[string, unknown]> = [
          ['salt', `0x${'00'.repeat(32)}`],
          ['chainID', inputs.chainId],
          ['foo', 'bar'],
          ['nothing', null],
          ['flag', false],
          ['zero', 0],
        ];
        for (const [key, value] of extras) {
          expectInvalid(
            () => build({ ...DOMAIN, [key]: value } as TypedDataDomain),
            `domain.${key}`,
          );
        }
        expect(() =>
          build({ ...DOMAIN, salt: `0x${'00'.repeat(32)}` }),
        ).toThrowError('domain.salt is not supported');
      });

      test('ignores a key that is present but undefined', () => {
        expect(() =>
          build({
            ...DOMAIN,
            salt: undefined,
            foo: undefined,
          } as TypedDataDomain),
        ).not.toThrow();
      });

      test('rejects a domain that is not an object', () => {
        for (const bad of [undefined, null, 'domain', 1]) {
          expectInvalid(() => build(bad as TypedDataDomain), 'domain');
        }
      });
    });

    test('salt: undefined hashes to the vector, as if the key were absent', () => {
      expect(hashOrder(ORDER, { ...DOMAIN, salt: undefined })).toBe(
        orderVector.expectedDigest,
      );
      expect(
        hashTypedData(
          cancelAllTypedData('market-1', { ...DOMAIN, salt: undefined }),
        ),
      ).toBe(hashTypedData(cancelAllTypedData('market-1', DOMAIN)));
    });

    test('the returned domain is a fresh object with exactly the four keys', () => {
      const messy = {
        salt: undefined,
        verifyingContract: BAD_CHECKSUM_EXCHANGE,
        extra: undefined,
        chainId: inputs.chainId,
        version: '1',
        name: 'XO Market CLOB',
      } as TypedDataDomain;
      const keys = ['name', 'version', 'chainId', 'verifyingContract'];
      for (const typed of [
        orderTypedData(ORDER, messy),
        cancelOrderTypedData(1n, 'market-1', messy),
        cancelAllTypedData('market-1', messy),
      ]) {
        const domain = typed.domain as TypedDataDomain;
        expect(Object.keys(domain)).toEqual(keys);
        expect(domain).toEqual(DOMAIN);
        expect(domain).not.toBe(messy);
      }
    });

    test('a bigint chainId hashes like the same number', () => {
      expect(
        hashOrder(ORDER, { ...DOMAIN, chainId: BigInt(inputs.chainId) }),
      ).toBe(orderVector.expectedDigest);
    });
  });
});
