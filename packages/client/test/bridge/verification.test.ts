import { describe, expect, test } from 'vitest';
import type { BridgeVerificationItem } from '../../src/bridge/schemas';
import { decodeVerification } from '../../src/bridge/verification';
import { SigningError, type XoError } from '../../src/core/errors';
import { OWNER, SMART_WALLET } from '../helpers/railChain';
import { testEnv } from '../helpers/testEnv';

// decodeVerification: what the SDK will put in front of the callback, and what it refuses
// outright. The bridge provider's payloads come from a server, so anything the SDK itself signs (orders,
// the orderbook login, Kernel wraps), anything that moves tokens or runs transactions (permits,
// authorizations, Safe and ERC-4337 messages) and anything that can be a hash in disguise is
// never offered. What the callback is shown is rebuilt from the parsed values, and is exactly
// what is signed.

const env = testEnv;
const ctx = {
  paymentId: 'pay_v',
  env,
  tradingAddress: SMART_WALLET,
  signerAddress: OWNER,
};
const OTHER = '0x00000000000000000000000000000000000b0b0b';
const SALT = `0x${'ab'.repeat(32)}`;

/** A character by code point (the file keeps to ASCII). */
const ch = (code: number): string => String.fromCodePoint(code);

const STANDARD_DOMAIN_TYPES: Record<string, string> = {
  name: 'string',
  version: 'string',
  chainId: 'uint256',
  verifyingContract: 'address',
  salt: 'bytes32',
};

/** The `EIP712Domain` type a domain with these keys has (the standard order and types). */
function domainType(domain: Record<string, unknown>) {
  return Object.keys(STANDARD_DOMAIN_TYPES)
    .filter((name) => Object.hasOwn(domain, name))
    .map((name) => ({ name, type: STANDARD_DOMAIN_TYPES[name] }));
}

/**
 * An EIP-712 payload like the bridge provider's, with the `EIP712Domain` type spelled out. When `over` gives a
 * `domain` and no `types`, the `EIP712Domain` type follows that domain, so a test of a domain
 * rule is refused for that rule and not for a mismatched type.
 */
function typedData(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  const domain = (over.domain ?? {
    name: 'Bridge',
    version: '1',
    chainId: 8453,
  }) as Record<string, unknown>;
  return {
    domain,
    types: {
      EIP712Domain: domainType(domain),
      OwnerVerification: [
        { name: 'owner', type: 'address' },
        { name: 'paymentId', type: 'string' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    primaryType: 'OwnerVerification',
    message: { owner: OWNER, paymentId: 'pay_v', nonce: '42' },
    ...over,
  };
}

const eip712 = (payload: unknown, over: Partial<BridgeVerificationItem> = {}) =>
  ({
    reason: 'EVM_OWNER',
    signatureType: 'EIP712',
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    ...over,
  }) as BridgeVerificationItem;

const eip191 = (payload: string, over: Partial<BridgeVerificationItem> = {}) =>
  ({
    reason: 'EVM_WITHDRAWAL',
    signatureType: 'EIP191',
    payload,
    ...over,
  }) as BridgeVerificationItem;

function refusal(item: BridgeVerificationItem, over = {}): XoError {
  try {
    decodeVerification(item, { ...ctx, ...over });
  } catch (error) {
    expect(error).toBeInstanceOf(SigningError);
    return error as XoError;
  }
  throw new Error('expected the payload to be refused');
}

/** Asserts the item is refused, for the rule the message names. */
function expectRefused(item: BridgeVerificationItem, why: RegExp): void {
  const error = refusal(item);
  expect(error.code).toBe('verification_payload_refused');
  expect(error.message).toMatch(why);
}

const accepted = (item: BridgeVerificationItem) =>
  decodeVerification(item, ctx);

describe('decodeVerification: what it accepts', () => {
  test('an EIP-712 payload becomes typed data the callback can read', () => {
    const payload = JSON.stringify(typedData());
    const request = decodeVerification(eip712(payload), ctx);

    expect(request).toEqual({
      paymentId: 'pay_v',
      reason: 'EVM_OWNER',
      signatureType: 'EIP712',
      payload,
      decoded: { kind: 'eip712', typedData: typedData() },
    });
  });

  test('an EIP-191 payload is the message to sign, as text', () => {
    const text = 'Withdraw 5 USDC\tto 0xabc\r\nNonce: 7';
    const request = decodeVerification(eip191(text), ctx);

    expect(request).toEqual({
      paymentId: 'pay_v',
      reason: 'EVM_WITHDRAWAL',
      signatureType: 'EIP191',
      payload: text,
      decoded: { kind: 'eip191', message: text },
    });
  });

  test('a domain with every allowed field is accepted', () => {
    const data = typedData({
      domain: {
        name: 'Bridge',
        version: '1',
        chainId: 8453,
        verifyingContract: OTHER,
        salt: SALT,
      },
    });
    const { decoded } = decodeVerification(eip712(data), ctx);
    expect(decoded.kind).toBe('eip712');
    if (decoded.kind === 'eip712') {
      expect(decoded.typedData).toEqual(data);
    }
  });

  test('a payload without an EIP712Domain type is accepted when the domain is the standard one', () => {
    const data = typedData();
    delete (data.types as Record<string, unknown>).EIP712Domain;
    expect(accepted(eip712(data)).decoded.kind).toBe('eip712');
  });

  test('an empty domain is accepted, with or without an empty EIP712Domain type', () => {
    expect(accepted(eip712(typedData({ domain: {} }))).decoded.kind).toBe(
      'eip712',
    );
    const bare = typedData({ domain: {} });
    delete (bare.types as Record<string, unknown>).EIP712Domain;
    expect(accepted(eip712(bare)).decoded.kind).toBe('eip712');
  });

  test('nested structs and arrays of structs are accepted', () => {
    const data = typedData({
      types: {
        Person: [
          { name: 'name', type: 'string' },
          { name: 'wallets', type: 'address[]' },
        ],
        Mail: [
          { name: 'from', type: 'Person' },
          { name: 'to', type: 'Person[]' },
          { name: 'grid', type: 'uint256[2][]' },
          { name: 'read', type: 'bool' },
        ],
      },
      primaryType: 'Mail',
      message: {
        from: { name: 'A', wallets: [OWNER] },
        to: [
          { name: 'B', wallets: [] },
          { name: 'C', wallets: [OTHER, OWNER] },
        ],
        grid: [
          [1, 2],
          ['3', '4'],
        ],
        read: false,
      },
    });
    const { decoded } = accepted(eip712(data));
    expect(decoded.kind).toBe('eip712');
    if (decoded.kind === 'eip712') {
      expect(decoded.typedData).toEqual(data);
    }
  });

  test('a message that leaves a field out is not refused here (the signer cannot sign it, and says so)', () => {
    const data = typedData({ message: { owner: OWNER } });
    expect(accepted(eip712(data)).decoded.kind).toBe('eip712');
  });

  test.each(['EVM_OWNER', 'EVM_WITHDRAWAL'])(
    'the reason %s is passed on as it is',
    (reason) => {
      expect(accepted(eip712(typedData(), { reason })).reason).toBe(reason);
      expect(accepted(eip191('hello', { reason })).reason).toBe(reason);
    },
  );

  test('what the callback gets is deeply frozen: it cannot change what is signed', () => {
    const request = decodeVerification(eip712(typedData()), ctx);
    const { decoded } = request;
    expect(decoded.kind).toBe('eip712');
    if (decoded.kind !== 'eip712') {
      return;
    }
    const data = decoded.typedData as unknown as Record<string, object>;
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(data)).toBe(true);
    expect(Object.isFrozen(data.domain)).toBe(true);
    expect(Object.isFrozen(data.message)).toBe(true);
    expect(Object.isFrozen(data.types)).toBe(true);
    expect(
      Object.isFrozen((data.types as Record<string, object>).OwnerVerification),
    ).toBe(true);
  });
});

describe('decodeVerification: the typed data is rebuilt, and that is what is shown and signed', () => {
  test('keys outside the allowed ones are dropped from the type fields; nothing of the payload but its values survives', () => {
    const data = typedData();
    const fields = (data.types as Record<string, unknown[]>)
      .OwnerVerification as unknown[];
    fields[0] = { name: 'owner', type: 'address', extra: 'y', toString: 'x' };
    const { decoded } = accepted(eip712(data));
    if (decoded.kind !== 'eip712') {
      throw new Error('expected typed data');
    }
    const types = (
      decoded.typedData as unknown as {
        types: Record<string, { name: string; type: string }[]>;
      }
    ).types;
    expect(types.OwnerVerification?.[0]).toEqual({
      name: 'owner',
      type: 'address',
    });
    expect(Object.keys(types.OwnerVerification?.[0] ?? {})).toEqual([
      'name',
      'type',
    ]);
  });

  test('the domain comes back in the standard order whatever order it was sent in', () => {
    const data = typedData({
      domain: { chainId: 8453, name: 'Bridge', verifyingContract: OTHER },
    });
    const { decoded } = accepted(eip712(data));
    if (decoded.kind !== 'eip712') {
      throw new Error('expected typed data');
    }
    expect(
      Object.keys((decoded.typedData as unknown as { domain: object }).domain),
    ).toEqual(['name', 'chainId', 'verifyingContract']);
  });

  test('the result has no prototype tricks: plain objects with the usual prototype', () => {
    const { decoded } = accepted(eip712(typedData()));
    if (decoded.kind !== 'eip712') {
      throw new Error('expected typed data');
    }
    const data = decoded.typedData as unknown as Record<string, object>;
    for (const part of [
      data,
      data.domain,
      data.types,
      data.message,
    ] as object[]) {
      expect(Object.getPrototypeOf(part)).toBe(Object.prototype);
      expect(Object.hasOwn(part, '__proto__')).toBe(false);
    }
  });
});

describe('decodeVerification: the error it raises', () => {
  test('is a SigningError verification_payload_refused with the payment id and mayHaveLanded false', () => {
    const error = refusal(eip191(`a${ch(0)}b`));
    expect(error.code).toBe('verification_payload_refused');
    expect(error.service).toBe('sdk');
    expect(error.paymentId).toBe('pay_v');
    expect(error.mayHaveLanded).toBe(false);
    expect(error.toJSON()).toMatchObject({
      name: 'SigningError',
      code: 'verification_payload_refused',
      paymentId: 'pay_v',
      mayHaveLanded: false,
    });
  });

  test('never quotes the payload or what the server named', () => {
    const marker = 'SECRET_MARKER_9f3a';
    const named = (key: string) =>
      `{"domain":{"name":"H","${key}":1},"types":{"T":[]},"primaryType":"T","message":{}}`;
    const cases: BridgeVerificationItem[] = [
      eip191(`${marker}${ch(0)}`),
      eip191(`wants you to sign in with your Ethereum account ${marker}`),
      eip712(`{"${marker}": `),
      eip712(typedData({ primaryType: marker })),
      eip712(
        typedData({ domain: { name: marker, verifyingContract: marker } }),
      ),
      eip712(typedData({ domain: { [marker]: 'x' } })),
      eip712(named(marker)),
      eip712(typedData({ message: marker })),
      eip712(typedData({ message: { [marker]: 1 } })),
      eip712(
        typedData({
          types: { [`Permit${marker}`]: [{ name: marker, type: marker }] },
        }),
      ),
      eip712(
        typedData({
          types: {
            EIP712Domain: [{ name: marker, type: 'string' }],
            OwnerVerification: [],
          },
        }),
      ),
      eip712(typedData(), { signatureType: marker }),
      eip712(typedData({ types: { [marker.toLowerCase()]: [] } })),
    ];
    for (const item of cases) {
      const error = refusal(item);
      expect(error.message.toLowerCase()).not.toContain(marker.toLowerCase());
      expect(JSON.stringify(error.toJSON()).toLowerCase()).not.toContain(
        marker.toLowerCase(),
      );
    }
  });
});

describe('decodeVerification: EIP-712 types it refuses', () => {
  // XO's own types, token permits (Permit2 and EIP-2612), token authorizations (EIP-3009),
  // Safe and ERC-4337 messages, meta-transactions and delegations. There is no allowlist of
  // chains or contracts: a payload that names none of these is the callback's to judge.
  const FORBIDDEN = [
    'Order',
    'ClobAuth',
    'Permit',
    'PermitSingle',
    'PermitBatch',
    'PermitTransferFrom',
    'PermitBatchTransferFrom',
    'TransferWithAuthorization',
    'ReceiveWithAuthorization',
    'CancelAuthorization',
    'PermitWitnessTransferFrom',
    'PermitBatchWitnessTransferFrom',
    'PermitDetails',
    'TokenPermissions',
    'SafeTx',
    'SafeMessage',
    'UserOperation',
    'PackedUserOperation',
    'ForwardRequest',
    'MetaTransaction',
    'Delegation',
    // Smart-account wrappers that make a signature valid for another message (ERC-7739 and
    // the smart wallets' own), marketplace and DEX orders that move tokens on a signature,
    // and the NFT permit.
    'PersonalSign',
    'TypedDataSign',
    'CoinbaseSmartWalletMessage',
    'LightAccountMessage',
    'OrderComponents',
    'BulkOrder',
    'LimitOrder',
    'RfqOrder',
    'PermitForAll',
  ];

  test.each(FORBIDDEN)('the primary type %s', (name) => {
    const data = typedData({
      primaryType: name,
      types: { [name]: [{ name: 'x', type: 'uint256' }] },
      message: { x: '1' },
    });
    expectRefused(eip712(data), new RegExp(`has a ${name} type`));
  });

  test.each(FORBIDDEN)(
    'the type %s anywhere in types, not only as the primary type',
    (name) => {
      const data = typedData();
      (data.types as Record<string, unknown>)[name] = [
        { name: 'x', type: 'uint256' },
      ];
      expectRefused(eip712(data), new RegExp(`has a ${name} type`));
    },
  );

  test.each(
    FORBIDDEN.flatMap((name) => [
      [name.toLowerCase(), name],
      [name.toUpperCase(), name],
      [`${name.charAt(0).toLowerCase()}${name.slice(1)}`, name],
    ]),
  )('the type %s is matched whatever its letter case', (written, name) => {
    const data = typedData({
      primaryType: written,
      types: { [written]: [{ name: 'x', type: 'uint256' }] },
      message: { x: '1' },
    });
    expectRefused(eip712(data), new RegExp(`has a ${name} type`));
  });

  test('a Permit hidden in a nested struct is found: the struct it is named by is a key of types', () => {
    const data = typedData({
      types: {
        Wrapper: [
          { name: 'inner', type: 'pErMiT' },
          { name: 'list', type: 'pErMiT[]' },
        ],
        pErMiT: [{ name: 'value', type: 'uint256' }],
      },
      primaryType: 'Wrapper',
      message: { inner: { value: '1' }, list: [] },
    });
    expectRefused(eip712(data), /has a Permit type/);
  });

  test('a name that only contains a listed one is a different type and is accepted', () => {
    for (const name of ['Orders', 'MyPermit', 'OrderInfo', 'Delegations']) {
      const data = typedData({
        primaryType: name,
        types: { [name]: [{ name: 'x', type: 'uint256' }] },
        message: { x: '1' },
      });
      expect(accepted(eip712(data)).decoded.kind).toBe('eip712');
    }
  });

  test('EIP712Domain as the primary type is refused', () => {
    const data = typedData({ primaryType: 'EIP712Domain' });
    expectRefused(eip712(data), /primaryType is EIP712Domain/);
  });
});

describe('decodeVerification: EIP-712 domain it refuses', () => {
  test.each([
    ['the order domain', 'XO Market CLOB'],
    ['the ClobAuth domain', 'ClobAuthDomain'],
    ['the Kernel domain', 'Kernel'],
  ])('%s by name', (_, name) => {
    const data = typedData({ domain: { name, version: '1', chainId: 8453 } });
    expectRefused(eip712(data), /one XO signs with/);
  });

  test('a domain name that only looks like one of XO is a different domain and is accepted', () => {
    for (const name of ['kernel', 'XO Market CLOB v2', 'Kernel ']) {
      const data = typedData({ domain: { name, version: '1', chainId: 8453 } });
      expect(accepted(eip712(data)).decoded.kind).toBe('eip712');
    }
  });

  test.each(
    Object.entries(env.contracts).flatMap(([field, address]) => [
      [`contracts.${field} as written`, address],
      [`contracts.${field} in lower case`, address.toLowerCase()],
      [
        `contracts.${field} with a swapped case`,
        `0x${address.slice(2).replace(/[a-fA-F]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))}`,
      ],
    ]),
  )('verifyingContract = %s', (_, address) => {
    const data = typedData({
      domain: {
        name: 'Bridge',
        version: '1',
        chainId: 8453,
        verifyingContract: address,
      },
    });
    expectRefused(
      eip712(data),
      /bound to a contract of XO, to the trading wallet or to the signer/,
    );
  });

  test('verifyingContract = the trading address, in any case', () => {
    for (const address of [
      SMART_WALLET,
      SMART_WALLET.toLowerCase(),
      SMART_WALLET.toUpperCase().replace('0X', '0x'),
    ]) {
      const data = typedData({
        domain: { name: 'Bridge', verifyingContract: address },
      });
      expectRefused(
        eip712(data),
        /bound to a contract of XO, to the trading wallet or to the signer/,
      );
    }
  });

  test("verifyingContract = the signer's address, in any case: the signature would be the owner's own", () => {
    for (const address of [
      OWNER,
      OWNER.toLowerCase(),
      OWNER.toUpperCase().replace('0X', '0x'),
    ]) {
      const data = typedData({
        domain: { name: 'Bridge', verifyingContract: address },
      });
      expectRefused(
        eip712(data),
        /bound to a contract of XO, to the trading wallet or to the signer/,
      );
    }
    // Another signer: the same address is then an ordinary one.
    const data = typedData({
      domain: { name: 'Bridge', verifyingContract: OWNER },
    });
    expect(
      decodeVerification(eip712(data), { ...ctx, signerAddress: OTHER }).decoded
        .kind,
    ).toBe('eip712');
  });

  test.each([
    ['one more key', { name: 'H', extra: 1 }],
    ['a key that only differs in case', { name: 'H', ChainId: 1 }],
    [
      'verifyingcontract in lower case',
      { name: 'H', verifyingcontract: OTHER },
    ],
    ['a nested object', { name: 'H', extra: { a: 1 } }],
    ['a key that is the name of a struct', { name: 'H', OwnerVerification: 1 }],
  ])('a domain with %s', (_, domain) => {
    expectRefused(eip712(typedData({ domain })), /domain has a field/);
  });

  test('a domain with an own __proto__ key is refused', () => {
    const payload =
      '{"domain":{"name":"H","__proto__":{"verifyingContract":"' +
      OTHER +
      '"}},"types":{"T":[]},"primaryType":"T","message":{}}';
    expectRefused(eip712(payload), /domain has a field/);
  });

  test.each([
    ['a string chainId', { name: 'H', chainId: '8453' }],
    ['a negative chainId', { name: 'H', chainId: -1 }],
    ['a chainId that is null', { name: 'H', chainId: null }],
    ['a name that is not text', { name: 7 }],
    ['a version that is not text', { name: 'H', version: 1 }],
    ['a verifyingContract that is not text', { verifyingContract: 7 }],
    [
      'a verifyingContract that is not an address',
      { verifyingContract: '0x1234' },
    ],
    ['a salt that is too short', { salt: '0x1234' }],
    ['a salt that is not hex', { salt: `0x${'zz'.repeat(32)}` }],
    ['a salt that is a number', { salt: 1 }],
  ])('a domain with %s', (_, domain) => {
    expectRefused(eip712(typedData({ domain })), /domain field/);
  });

  test.each([
    [
      'a field missing',
      [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
      ],
    ],
    [
      'a field it does not have',
      [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'salt', type: 'bytes32' },
      ],
    ],
    [
      'a field with a non-standard type',
      [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'string' },
      ],
    ],
    [
      'the standard type of another field',
      [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'chainId', type: 'uint256' },
      ],
    ],
    [
      'a name that is not a domain field',
      [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'vc', type: 'uint256' },
      ],
    ],
    ['no field at all', []],
  ])('an EIP712Domain type with %s', (_, fields) => {
    const data = typedData();
    (data.types as Record<string, unknown>).EIP712Domain = fields;
    expectRefused(eip712(data), /EIP712Domain type does not match/);
  });

  test('an EIP712Domain type that lists a verifyingContract the domain does not have is refused', () => {
    const data = typedData();
    (data.types as Record<string, unknown>).EIP712Domain = domainType({
      name: 1,
      version: 1,
      chainId: 1,
      verifyingContract: 1,
    });
    expectRefused(eip712(data), /EIP712Domain type does not match/);
  });

  test('an EIP712Domain type that leaves out the verifyingContract the domain carries is refused: it would not be signed as shown', () => {
    const data = typedData({
      domain: { name: 'H', verifyingContract: env.contracts.usdc },
    });
    (data.types as Record<string, unknown>).EIP712Domain = [
      { name: 'name', type: 'string' },
    ];
    expectRefused(eip712(data), /EIP712Domain type does not match/);
  });
});

describe('decodeVerification: EIP-712 message and structure it refuses', () => {
  test.each([
    ['a key at the top', { message: { owner: OWNER, extra: 1 } }],
    ['a key that is the name of a type', { message: { OwnerVerification: 1 } }],
    ['a key that only differs in case', { message: { Owner: OWNER } }],
  ])('a message with %s its struct does not have', (_, over) => {
    expectRefused(eip712(typedData(over)), /message has a field/);
  });

  test('a key a nested struct does not have', () => {
    const data = typedData({
      types: {
        Person: [{ name: 'name', type: 'string' }],
        Mail: [{ name: 'from', type: 'Person' }],
      },
      primaryType: 'Mail',
      message: { from: { name: 'A', spender: OWNER } },
    });
    expectRefused(eip712(data), /message has a field/);
  });

  test('a key a struct inside an array does not have', () => {
    const data = typedData({
      types: {
        Person: [{ name: 'name', type: 'string' }],
        Mail: [{ name: 'to', type: 'Person[]' }],
      },
      primaryType: 'Mail',
      message: { to: [{ name: 'A' }, { name: 'B', spender: OWNER }] },
    });
    expectRefused(eip712(data), /message has a field/);
  });

  test('a key a struct inside an array of arrays does not have', () => {
    const data = typedData({
      types: {
        Person: [{ name: 'name', type: 'string' }],
        Mail: [{ name: 'grid', type: 'Person[][]' }],
      },
      primaryType: 'Mail',
      message: { grid: [[{ name: 'A' }], [{ name: 'B', x: 1 }]] },
    });
    expectRefused(eip712(data), /message has a field/);
  });

  test('an own __proto__ key in the message is refused', () => {
    const payload = `{"domain":{"name":"H"},"types":{"T":[{"name":"a","type":"uint256"}]},"primaryType":"T","message":{"a":1,"__proto__":{"a":2}}}`;
    expectRefused(eip712(payload), /message has a field/);
  });

  test.each([
    ['a type named __proto__', '{"T":[],"__proto__":[]}'],
    [
      'a field named __proto__',
      '{"T":[{"name":"__proto__","type":"uint256"}]}',
    ],
  ])('%s is refused', (_, types) => {
    const payload = `{"domain":{"name":"H"},"types":${types},"primaryType":"T","message":{}}`;
    expect(refusal(eip712(payload)).code).toBe('verification_payload_refused');
  });

  test.each([
    ['a struct value that is an array', { message: { from: [] } }],
    ['a struct value that is text', { message: { from: 'x' } }],
    ['a struct value that is null', { message: { from: null } }],
    ['an array value that is an object', { message: { list: {} } }],
    ['an array value that is text', { message: { list: 'x' } }],
    ['an atomic value that is an object', { message: { value: {} } }],
    ['an atomic value that is an array', { message: { value: [1] } }],
    ['an atomic value that is null', { message: { value: null } }],
    [
      'an element that is an object where an atomic is due',
      { message: { list: [{}] } },
    ],
  ])('%s does not fit its type', (_, over) => {
    const data = typedData({
      types: {
        Person: [{ name: 'name', type: 'string' }],
        T: [
          { name: 'from', type: 'Person' },
          { name: 'list', type: 'uint256[]' },
          { name: 'value', type: 'uint256' },
        ],
      },
      primaryType: 'T',
      message: { from: { name: 'A' }, list: [1], value: 1, ...over.message },
    });
    expectRefused(eip712(data), /does not fit its type/);
  });

  test.each([
    ['a type name with a space', 'My Type'],
    ['a type name with a bracket', 'T['],
    ['an empty type name', ''],
    ['a type name that starts with a digit', '1T'],
  ])('%s is malformed', (_, name) => {
    const data = typedData({
      types: { [name]: [{ name: 'x', type: 'uint256' }] },
      primaryType: name,
      message: { x: 1 },
    });
    expectRefused(eip712(data), /type of the typed data is malformed/);
  });

  test.each([
    ['a field type with a space', 'uint256 '],
    ['a field type with an unclosed bracket', 'uint256[['],
    ['a field type that is empty', ''],
    ['a field type with a path', 'a.b'],
    ['a field name with a space', null],
  ])('%s is malformed', (_, type) => {
    const data = typedData({
      types: {
        T: [{ name: type === null ? 'a b' : 'x', type: type ?? 'uint256' }],
      },
      primaryType: 'T',
      message: {},
    });
    expectRefused(eip712(data), /type of the typed data is malformed/);
  });

  test('data nested deeper than 32 levels is refused, without a stack overflow', () => {
    const depth = 200;
    let message: unknown = { next: null, value: 1 };
    for (let i = 0; i < depth; i++) {
      message = { next: message, value: 1 };
    }
    const data = typedData({
      types: {
        Node: [
          { name: 'next', type: 'Node' },
          { name: 'value', type: 'uint256' },
        ],
      },
      primaryType: 'Node',
      message,
    });
    expectRefused(eip712(data), /nested too deeply/);
  });

  test('a recursive type is accepted when the data is shallow', () => {
    const data = typedData({
      types: {
        Node: [
          { name: 'children', type: 'Node[]' },
          { name: 'value', type: 'uint256' },
        ],
      },
      primaryType: 'Node',
      message: {
        value: 1,
        children: [{ value: 2, children: [] }],
      },
    });
    expect(accepted(eip712(data)).decoded.kind).toBe('eip712');
  });
});

describe('decodeVerification: every value fits its Solidity type, so what is shown is what is signed', () => {
  /** Typed data whose message is one field `v` of `type`, set to `value`. */
  const holding = (type: string, value: unknown) =>
    typedData({
      types: { T: [{ name: 'v', type }] },
      primaryType: 'T',
      message: { v: value },
    });
  const fits = (type: string, value: unknown) => {
    const { decoded } = accepted(eip712(holding(type, value)));
    if (decoded.kind !== 'eip712') {
      throw new Error('expected typed data');
    }
    // The value is shown, and signed, as it was sent.
    expect(decoded.typedData.message).toEqual({ v: value });
  };
  const misfits = (type: string, value: unknown) =>
    expectRefused(eip712(holding(type, value)), /does not fit its type/);

  const MAX_UINT256 = (2n ** 256n - 1n).toString();
  const FIT: [string, unknown][] = [
    ['string', 'Bridge'],
    ['string', ''],
    ['bool', true],
    ['bool', false],
    ['address', OWNER],
    ['address', OWNER.toLowerCase()],
    ['bytes', '0x'],
    ['bytes', '0xabCD'],
    ['bytes1', '0xab'],
    ['bytes32', SALT],
    ['uint256', 42],
    ['uint256', 0],
    ['uint256', '42'],
    ['uint256', '0x2a'],
    ['uint256', MAX_UINT256],
    ['uint256', `0x${'f'.repeat(64)}`],
    ['uint8', 255],
    ['uint8', '0xff'],
    ['int8', -128],
    ['int8', 127],
    ['int8', '-128'],
    ['int256', '-5'],
    ['uint64', Number.MAX_SAFE_INTEGER],
  ];
  test.each(FIT)('a %s holding %j fits', (type, value) => {
    fits(type, value);
  });

  const MISFIT: [string, unknown][] = [
    // string
    ['string', 1],
    ['string', true],
    // bool
    ['bool', 'true'],
    ['bool', 1],
    ['bool', 0],
    // address
    ['address', '0x1234'],
    ['address', OWNER.slice(2)],
    ['address', `${OWNER}00`],
    ['address', 1],
    // bytes
    ['bytes', '0xabc'],
    ['bytes', 'abcd'],
    ['bytes', '0xzz'],
    ['bytes', 12],
    // bytesN
    ['bytes32', '0x1234'],
    ['bytes32', `${SALT}ab`],
    ['bytes1', '0xabcd'],
    ['bytes1', '0x'],
    ['bytes1', 1],
    // uintN and intN
    ['uint256', -1],
    ['uint256', '-1'],
    ['uint256', (2n ** 256n).toString()],
    ['uint256', `0x1${'0'.repeat(64)}`],
    ['uint256', '1.5'],
    ['uint256', '1e3'],
    ['uint256', ''],
    ['uint256', ' 42'],
    ['uint256', '42 '],
    ['uint256', '0x'],
    ['uint256', '-0x2a'],
    ['uint256', '0b101'],
    ['uint256', '1_000'],
    ['uint256', true],
    ['uint8', 256],
    ['uint8', '0x100'],
    ['int8', 128],
    ['int8', -129],
    ['int8', '0x80'],
    ['uint256', '1'.repeat(81)],
    // types the signer does not know, or knows differently
    ['uint', 1],
    ['int', 1],
    ['uint7', 1],
    ['uint264', 1],
    ['uint08', 1],
    ['bytes0', '0x'],
    ['bytes33', `0x${'ab'.repeat(33)}`],
    ['bytes01', '0xab'],
    ['Undeclared', 'x'],
    ['function', 'x'],
  ];
  test.each(MISFIT)('a %s holding %j does not fit', (type, value) => {
    misfits(type, value);
  });

  test('an element of an array is checked against the element type', () => {
    fits('uint8[]', [1, '2', '0x03']);
    misfits('uint8[]', [1, 256]);
    misfits('address[2]', [OWNER, '0x1234']);
    misfits('bool[][]', [[true], ['false']]);
  });

  // A fixed-size array is signed with as many elements as it holds, so one whose length is not
  // the size its type gives would be shown as one type and signed as another. The last suffix is
  // the outer array: `uint256[2][3]` is 3 arrays of 2.
  const FIXED_FIT: [string, unknown][] = [
    ['uint256[2]', [1, '2']],
    ['address[1]', [OWNER]],
    [
      'uint256[2][]',
      [
        [1, 2],
        [3, 4],
        [5, 6],
      ],
    ],
    ['uint256[2][]', []],
    ['uint256[][2]', [[], [1, 2, 3]]],
    [
      'uint256[2][3]',
      [
        [1, 2],
        [3, 4],
        [5, 6],
      ],
    ],
  ];
  test.each(FIXED_FIT)('a %s holding %j fits', (type, value) => {
    fits(type, value);
  });

  const FIXED_MISFIT: [string, unknown][] = [
    ['uint256[2]', [1]],
    ['uint256[2]', [1, 2, 3]],
    ['uint256[2]', []],
    ['address[1]', [OWNER, OTHER]],
    ['uint256[2][]', [[1, 2], [3]]],
    ['uint256[][2]', [[1], [2], [3]]],
    [
      'uint256[2][3]',
      [
        [1, 2],
        [3, 4],
      ],
    ],
    ['uint256[2][3]', [[1, 2], [3, 4], [5]]],
    ['uint256[99999999999999999999]', [1]],
  ];
  test.each(FIXED_MISFIT)(
    'a %s holding %j is refused: its length is not the size its type gives',
    (type, value) => {
      expectRefused(
        eip712(holding(type, value)),
        /an array of the message does not have the length its type gives/,
      );
    },
  );

  test('a fixed-size array of structs is checked for its length too', () => {
    const data = typedData({
      types: {
        Leg: [{ name: 'amount', type: 'uint256' }],
        Route: [{ name: 'legs', type: 'Leg[2]' }],
      },
      primaryType: 'Route',
      message: { legs: [{ amount: 1 }] },
    });
    expectRefused(
      eip712(data),
      /an array of the message does not have the length its type gives/,
    );
  });

  test('a field of a nested struct is checked too', () => {
    const data = typedData({
      types: {
        Inner: [{ name: 'flag', type: 'bool' }],
        Outer: [{ name: 'inner', type: 'Inner' }],
      },
      primaryType: 'Outer',
      message: { inner: { flag: 'yes' } },
    });
    expectRefused(eip712(data), /does not fit its type/);
  });

  test.each([
    ['an empty name', { name: '', version: '1', chainId: 8453 }],
    ['an empty version', { name: 'Bridge', version: '', chainId: 8453 }],
  ])('a domain with %s is refused', (_, domain) => {
    expectRefused(
      eip712(typedData({ domain })),
      /domain has an empty name or version/,
    );
  });

  test('a domain may leave the name or the version out', () => {
    expect(
      accepted(eip712(typedData({ domain: { chainId: 8453 } }))).decoded.kind,
    ).toBe('eip712');
  });
});

describe('decodeVerification: a JSON number that is not a safe integer, anywhere in the payload', () => {
  // JSON.parse rounds such a number before the SDK sees it: what the callback would be shown is
  // not what the server sent.
  const UNSAFE = /not a safe integer/;
  const withText = (where: string, text: string) =>
    JSON.stringify(typedData()).replace(where, text);

  test.each([
    ['2^53', 2 ** 53],
    ['a fraction', 1.5],
  ])('%s as a uint256 of the message', (_, nonce) => {
    const data = typedData({ message: { owner: OWNER, nonce } });
    expectRefused(eip712(data), UNSAFE);
  });

  test.each([
    ['a fractional chainId', 1.5],
    ['an unsafe chainId', 2 ** 60],
  ])('%s in the domain', (_, chainId) => {
    const data = typedData({ domain: { name: 'H', chainId } });
    expectRefused(eip712(data), UNSAFE);
  });

  test('a number that JSON.parse rounds (9007199254740993) is refused, not shown rounded', () => {
    const payload = withText('"nonce":"42"', '"nonce":9007199254740993');
    expectRefused(eip712(payload), UNSAFE);
  });

  test.each([
    ['a fraction', '1.5'],
    ['an exponent beyond the safe range', '1e300'],
    ['a number too large for a double', '1e400'],
  ])('%s in a key the SDK ignores is refused too', (_, number) => {
    const payload = withText('{"domain"', `{"extra":${number},"domain"`);
    expectRefused(eip712(payload), UNSAFE);
  });

  test('a safe integer written with an exponent is the integer it parses to', () => {
    const payload = withText('"nonce":"42"', '"nonce":4.2e1');
    const { decoded } = accepted(eip712(payload));
    if (decoded.kind !== 'eip712') {
      throw new Error('expected typed data');
    }
    expect(decoded.typedData.message).toEqual({
      owner: OWNER,
      paymentId: 'pay_v',
      nonce: 42,
    });
  });
});

describe('decodeVerification: the reason of an item', () => {
  test.each(['EVM_NEW_THING', '', 'evm_owner', 'EVM_OWNER ', 'OWNER'])(
    'a reason of %j is refused, before the callback is asked',
    (reason) => {
      expectRefused(
        eip712(typedData(), { reason }),
        /reason is neither EVM_OWNER nor EVM_WITHDRAWAL/,
      );
      expectRefused(
        eip191('hello', { reason }),
        /reason is neither EVM_OWNER nor EVM_WITHDRAWAL/,
      );
    },
  );

  test('a reason that is not a string is refused', () => {
    expect(
      refusal({
        reason: 7,
        signatureType: 'EIP191',
        payload: 'hello',
      } as unknown as BridgeVerificationItem).code,
    ).toBe('verification_payload_refused');
  });
});

describe('decodeVerification: EIP-712 payloads it cannot parse', () => {
  test.each([
    ['not JSON', '{"domain": '],
    ['an empty string', ''],
    ['JSON null', 'null'],
    ['a JSON array', '[]'],
    ['a JSON string', '"hello"'],
    ['a JSON number', '42'],
  ])('a payload that is %s', (_, payload) => {
    expect(refusal(eip712(payload)).code).toBe('verification_payload_refused');
  });

  test.each(['domain', 'types', 'primaryType', 'message'])(
    'a payload without %s',
    (key) => {
      const data = typedData();
      delete data[key];
      expect(refusal(eip712(data)).code).toBe('verification_payload_refused');
    },
  );

  test.each([
    ['domain is an array', { domain: [] }],
    ['domain is null', { domain: null }],
    ['types is an array', { types: [] }],
    ['types is a string', { types: 'x' }],
    ['primaryType is not a string', { primaryType: 7 }],
    ['primaryType is not a key of types', { primaryType: 'Missing' }],
    [
      'primaryType is only inherited by types (toString)',
      { primaryType: 'toString' },
    ],
    ['primaryType is constructor', { primaryType: 'constructor' }],
    ['message is a string', { message: 'x' }],
    ['message is an array', { message: [] }],
    ['message is null', { message: null }],
    ['a type is not a list', { types: { OwnerVerification: { name: 'x' } } }],
    [
      'a type field has no name',
      { types: { OwnerVerification: [{ type: 'address' }] } },
    ],
    [
      'a type field has no type',
      { types: { OwnerVerification: [{ name: 'owner' }] } },
    ],
    ['a type field is a string', { types: { OwnerVerification: ['owner'] } }],
  ])('malformed typed data: %s', (_, over) => {
    expect(refusal(eip712(typedData(over))).code).toBe(
      'verification_payload_refused',
    );
  });
});

describe('decodeVerification: the size of an EIP-712 payload', () => {
  const encoder = new TextEncoder();
  const bytesOf = (text: string) => encoder.encode(text).byteLength;
  /** A payload whose message pads one string with `n` copies of `filler`. */
  const build = (n: number, filler = 'a') =>
    JSON.stringify(
      typedData({
        message: { owner: OWNER, paymentId: filler.repeat(n), nonce: '1' },
      }),
    );
  const LIMIT = 65_536;

  test('64 KB (65536 bytes) is the most it reads; one byte more is refused before it is parsed', () => {
    const at = build(LIMIT - bytesOf(build(0)));
    expect(bytesOf(at)).toBe(LIMIT);
    expect(accepted(eip712(at)).decoded.kind).toBe('eip712');

    const over = build(LIMIT + 1 - bytesOf(build(0)));
    expect(bytesOf(over)).toBe(LIMIT + 1);
    expectRefused(eip712(over), /larger than 64 KB/);
  });

  test('the limit counts UTF-8 bytes, not characters', () => {
    const euro = String.fromCodePoint(0x20ac);
    const base = bytesOf(build(0));
    // Under the limit in bytes: accepted, though it holds fewer characters.
    const under = build(Math.floor((LIMIT - base) / 3), euro);
    expect(bytesOf(under)).toBeLessThanOrEqual(LIMIT);
    expect(bytesOf(under)).toBeGreaterThan(LIMIT - 3);
    expect(under.length).toBeLessThan(LIMIT / 2);
    expect(accepted(eip712(under)).decoded.kind).toBe('eip712');
    // Over the limit in bytes, with far fewer than 65536 characters.
    const over = build(Math.floor((LIMIT - base) / 3) + 1, euro);
    expect(bytesOf(over)).toBeGreaterThan(LIMIT);
    expect(over.length).toBeLessThan(LIMIT);
    expectRefused(eip712(over), /larger than 64 KB/);
  });

  test('a huge payload is refused without being parsed', () => {
    expectRefused(eip712('['.repeat(1_000_000)), /larger than 64 KB/);
  });
});

describe('decodeVerification: EIP-191 it refuses', () => {
  test.each([
    ['an empty message', ''],
    ['a NUL', `a${ch(0)}b`],
    ['a bell', `a${ch(7)}b`],
    ['an escape', `a${ch(0x1b)}b`],
    ['a delete', `a${ch(0x7f)}b`],
    ['a vertical tab', `a${ch(0x0b)}b`],
    ['a form feed', `a${ch(0x0c)}b`],
    ['a non-ASCII letter', `caf${ch(0xe9)}`],
    ['a line separator', `a${ch(0x2028)}b`],
    ['a right-to-left override', `a${ch(0x202e)}b`],
    ['an emoji', `ok ${ch(0x1f600)}`],
    ['a zero-width space', `a${ch(0x200b)}b`],
  ])('a message with %s', (_, payload) => {
    expectRefused(eip191(payload), /1 to 4000 characters of printable ASCII/);
  });

  test('4000 characters is the longest message; 4001 is refused', () => {
    expect(accepted(eip191('a'.repeat(4000))).decoded.kind).toBe('eip191');
    expect(refusal(eip191('a'.repeat(4001))).code).toBe(
      'verification_payload_refused',
    );
  });

  test('one character is enough', () => {
    expect(accepted(eip191(' ')).decoded.kind).toBe('eip191');
  });

  describe('a message that can be a hash in disguise', () => {
    // Kernel's ECDSA validator accepts the eth-signed form of a 32-byte hash, and so does Safe's
    // eth_sign mode; a signer that hands a string to personal_sign may decode 0x + 64 hex to 32
    // raw bytes. So a 32-byte message and any hex text sign what is not shown.
    test('a message of exactly 32 bytes is refused', () => {
      expectRefused(eip191('a'.repeat(32)), /32-byte message/);
      expectRefused(
        eip191('Withdraw 5 USDC to 0xabc12345'.padEnd(32, '.')),
        /32-byte/,
      );
      expectRefused(eip191(`${'x'.repeat(30)}\r\n`), /32-byte/);
    });

    test('31 and 33 bytes are not a hash and are accepted', () => {
      expect(accepted(eip191('a'.repeat(31))).decoded.kind).toBe('eip191');
      expect(accepted(eip191('a'.repeat(33))).decoded.kind).toBe('eip191');
    });

    test.each([
      ['0x + 64 hex digits', `0x${'ab'.repeat(32)}`],
      ['0x + 64 upper-case hex digits', `0x${'AB'.repeat(32)}`],
      ['0x alone', '0x'],
      ['a short hex string', '0xabc'],
      ['a long hex string', `0x${'0'.repeat(500)}`],
      ['an odd number of hex digits', '0x123'],
    ])('hex text (%s) is refused', (_, payload) => {
      expectRefused(eip191(payload), /only hex/);
    });

    test('text that merely starts with 0x or contains hex is not hex text', () => {
      expect(accepted(eip191('0xabc and more')).decoded.kind).toBe('eip191');
      expect(accepted(eip191(' 0xabcdef')).decoded.kind).toBe('eip191');
      expect(accepted(eip191('Send to 0xabcdef')).decoded.kind).toBe('eip191');
      expect(accepted(eip191('0xabcdefg')).decoded.kind).toBe('eip191');
    });
  });

  describe('a sign-in message', () => {
    const siwe = (domain: string, uri: string) =>
      `${domain} wants you to sign in with your Ethereum account:\n${OWNER}\n\nXO API key.\n\nURI: ${uri}\nVersion: 1\nChain ID: ${env.chainId}\nNonce: abcdef12\nIssued At: 2026-10-21T12:00:00.000Z`;

    test('a login for XO itself (the environment domain or URI) is refused', () => {
      expect(refusal(eip191(siwe(env.siweDomain, env.siweUri))).code).toBe(
        'verification_payload_refused',
      );
    });

    test('the environment domain or URI alone is enough, in any letter case, even with no sign-in text', () => {
      expectRefused(
        eip191(`Please confirm ${env.siweDomain.toUpperCase()} access`),
        /login for XO/,
      );
      expectRefused(
        eip191(`Please confirm ${env.siweUri.toUpperCase()} access`),
        /login for XO/,
      );
    });

    test.each([
      ['another domain', 'other.example'],
      ['a domain the backend may allow too', 'web.xo.test'],
      ['an unknown domain', 'evil.example'],
    ])(
      'an EIP-4361 message for %s is refused too: the backend may allow several domains',
      (_, domain) => {
        expectRefused(eip191(siwe(domain, `https://${domain}`)), /EIP-4361/);
      },
    );

    test('the sign-in sentence is matched whatever its letter case', () => {
      for (const sentence of [
        'WANTS YOU TO SIGN IN WITH YOUR ETHEREUM ACCOUNT',
        'Wants You To Sign In With Your Ethereum Account',
        'x wants you to sign in with your ethereum account:',
      ]) {
        expectRefused(eip191(`a.example ${sentence}\n${OWNER}`), /EIP-4361/);
      }
    });

    test('a message that only talks about signing in is not a sign-in message', () => {
      expect(
        accepted(
          eip191('The bridge asks you to sign in to approve payment pay_v'),
        ).decoded.kind,
      ).toBe('eip191');
    });
  });
});

describe('decodeVerification: any other signature type', () => {
  test.each(['OTHER', 'eip712', 'EIP-712', 'EIP1271', 'ETH_SIGN', ''])(
    'signatureType %j',
    (signatureType) => {
      expect(refusal(eip712(typedData(), { signatureType })).code).toBe(
        'verification_payload_refused',
      );
      expect(refusal(eip191('hello', { signatureType })).code).toBe(
        'verification_payload_refused',
      );
    },
  );

  test('a payload that is not a string is refused', () => {
    expect(
      refusal({
        reason: 'EVM_OWNER',
        signatureType: 'EIP191',
        payload: 12,
      } as unknown as BridgeVerificationItem).code,
    ).toBe('verification_payload_refused');
  });
});
