import { fromRlp, type Hex, recoverAddress, toRlp } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import type { EvCall, EvTx, ExecutorSignature } from '../../src/signing/evTx';
import {
  encodeSignedTx,
  estimateIntrinsicGas,
  executorSigningHash,
  MAX_CALLDATA_BYTES,
  MAX_CALLS,
  rlpInt,
  validateEvTx,
} from '../../src/signing/evTx';

/**
 * Golden vectors for XO mainnet (chain 3223): TX1 and TX2 are the transactions of cases C1 and
 * C2 of `test-vectors/evtx-conformance.json`. Each execHash was checked against XO's production
 * sponsor with a sign-only request (it recovered the executor from its own signing hash), and
 * each envelope against a re-encoding with Foundry's `cast to-rlp`. These lock byte-for-byte
 * parity between this TypeScript port and the node's `0x76` transaction type — the single most
 * important correctness property, since any RLP divergence makes the executor recover to a
 * different address and the sponsor reject the tx.
 */
const GOLDEN = {
  tx1: {
    execHash:
      '0x6b4b22b3959199d321ab062e19afe81eee1c4017aa62bb408e15b450c986542e',
    encodeSigned:
      '0x76f8c8820c9707843b9aca00847735940083030d40f85ef85c9480c12230ce677e6f304027a14780edd2a829ab0c80b844a9059cbb00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c0b84100000000000000000000000000000000000000000000000000000000deadbeef00000000000000000000000000000000000000000000000000000000cafebabe1b018711223344556677888899aabbccddeeff',
  },
  tx2: {
    execHash:
      '0x4e90525df304306727df55f0455a4db21be9f76cc93d06c7831193c80751886d',
    encodeSigned:
      '0x76f9011e820c978080078307a120f8bcf85c9480c12230ce677e6f304027a14780edd2a829ab0c80b844a9059cbb00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000f85c94ccf1b2c676e2f9a13e5674be0e0ddff6d0b1390980b844a22cb4650000000000000000000000004bc5e872256d12e6017dfe466e04c867dc761b770000000000000000000000000000000000000000000000000000000000000001c0b84100000000000000000000000000000000000000000000000000000000deadbeef00000000000000000000000000000000000000000000000000000000cafebabe1b018711223344556677888899aabbccddeeff',
  },
  // Fixed fee-payer signature the vectors are built with (65 bytes r||s||v).
  feePayer:
    '0x00000000000000000000000000000000000000000000000000000000deadbeef00000000000000000000000000000000000000000000000000000000cafebabe1b' as Hex,
  // Fixed executor signature: r has leading zero bytes, exercising minimal trimming.
  execSig: {
    r: '0x11223344556677',
    s: '0x8899aabbccddeeff',
    yParity: 1,
  } as ExecutorSignature,
} as const;

/** XO mainnet's USDC and ConditionalTokens: calls to them are ones the sponsor's policy signs. */
const USDC = '0x80c12230ce677e6f304027a14780Edd2A829ab0c';
const CTF = '0xCcf1b2C676E2f9A13e5674be0e0DdFF6d0B13909';

const TX1: EvTx = {
  chainId: BigInt(3223),
  nonce: BigInt(7),
  maxPriorityFeePerGas: BigInt(1_000_000_000),
  maxFeePerGas: BigInt(2_000_000_000),
  gasLimit: BigInt(200_000),
  calls: [
    {
      // USDC.transfer(address(0), 0)
      to: USDC,
      value: BigInt(0),
      input: `0xa9059cbb${'00'.repeat(64)}`,
    },
  ],
  accessList: [],
};

// Under noUncheckedIndexedAccess, TX1.calls[0] is possibly undefined; the tests need the call itself.
const TX1_CALL = TX1.calls[0] as EvCall;

const TX2: EvTx = {
  chainId: BigInt(3223),
  nonce: BigInt(0),
  maxPriorityFeePerGas: BigInt(0),
  maxFeePerGas: BigInt(7),
  gasLimit: BigInt(500_000),
  calls: [
    { to: USDC, value: BigInt(0), input: `0xa9059cbb${'00'.repeat(64)}` },
    {
      // ConditionalTokens.setApprovalForAll(CTFExchange, true)
      to: CTF,
      value: BigInt(0),
      input: `0xa22cb465${'00'.repeat(12)}4bc5e872256d12e6017dfe466e04c867dc761b77${'00'.repeat(31)}01`,
    },
  ],
  accessList: [],
};

describe('rlpInt (minimal big-endian integer encoding)', () => {
  it('encodes zero as the empty string (0x80 once RLP-wrapped)', () => {
    expect(rlpInt(0)).toBe('0x');
    expect(rlpInt(BigInt(0))).toBe('0x');
  });

  it('trims leading zero bytes', () => {
    expect(rlpInt(1)).toBe('0x01');
    expect(rlpInt(255)).toBe('0xff');
    expect(rlpInt(256)).toBe('0x0100');
    expect(rlpInt(BigInt('0x11223344556677'))).toBe('0x11223344556677');
  });

  it('rejects negative values', () => {
    expect(() => rlpInt(-1)).toThrow();
  });
});

describe('RLP structural sentinels', () => {
  it('encodes an empty list as 0xc0 and an empty-string element as 0x80', () => {
    expect(toRlp([], 'hex')).toBe('0xc0');
    expect(toRlp(['0x'], 'hex')).toBe('0xc180');
  });
});

describe('executorSigningHash (byte parity with the mainnet encoding)', () => {
  it('matches the golden hash for TX1', () => {
    expect(executorSigningHash(TX1)).toBe(GOLDEN.tx1.execHash);
  });

  it('matches the golden hash for TX2 (zero nonce, zero tip, batch)', () => {
    expect(executorSigningHash(TX2)).toBe(GOLDEN.tx2.execHash);
  });

  it('is deterministic and independent of any sponsor signature', () => {
    expect(executorSigningHash(TX1)).toBe(executorSigningHash({ ...TX1 }));
  });
});

describe('encodeSignedTx (byte parity with the mainnet encoding)', () => {
  it('matches the golden signed envelope for TX1', () => {
    expect(encodeSignedTx(TX1, GOLDEN.feePayer, GOLDEN.execSig)).toBe(
      GOLDEN.tx1.encodeSigned,
    );
  });

  it('matches the golden signed envelope for TX2', () => {
    expect(encodeSignedTx(TX2, GOLDEN.feePayer, GOLDEN.execSig)).toBe(
      GOLDEN.tx2.encodeSigned,
    );
  });

  it('encodes a null fee payer (self-paid) as the empty string in the fee-payer slot', () => {
    const raw = encodeSignedTx(TX1, null, GOLDEN.execSig);
    const decoded = fromRlp(`0x${raw.slice(4)}`, 'hex') as Hex[]; // strip the 0x76 type byte
    // list: [chainId,nonce,maxPrio,maxFee,gasLimit,calls,accessList,feePayer,yParity,r,s]
    expect(decoded[7]).toBe('0x'); // fee-payer slot is the empty string (0x80)
  });
});

describe('round-trip recovery (self-consistency of hash + signature)', () => {
  it('recovers the executor address from a real signature over the hash', async () => {
    const privateKey = `0x${'11'.repeat(32)}` as Hex;
    const account = privateKeyToAccount(privateKey);

    const hash = executorSigningHash(TX1);
    // Raw sign of the prehash — NO EIP-191 prefix (this is the whole point).
    const signature = await sign({ hash, privateKey, to: 'object' });

    const recovered = await recoverAddress({ hash, signature });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it('a signature over a different digest does NOT recover (EIP-191 guard)', async () => {
    const privateKey = `0x${'22'.repeat(32)}` as Hex;
    const account = privateKeyToAccount(privateKey);
    const hash = executorSigningHash(TX2);

    // Sign a *different* digest (simulating an EIP-191 wrapper mistake).
    const wrongDigest = `0x${'ab'.repeat(32)}` as Hex;
    const signature = await sign({
      hash: wrongDigest,
      privateKey,
      to: 'object',
    });

    const recovered = await recoverAddress({ hash, signature });
    expect(recovered.toLowerCase()).not.toBe(account.address.toLowerCase());
  });
});

describe('validateEvTx', () => {
  it('rejects an empty batch', () => {
    expect(() => validateEvTx({ ...TX1, calls: [] })).toThrow(
      /at least one call/,
    );
  });

  it('rejects a contract creation after the first call', () => {
    expect(() =>
      validateEvTx({
        ...TX1,
        calls: [TX1_CALL, { to: null, value: BigInt(0), input: '0x60006000' }],
      }),
    ).toThrow(/only the first call/);
  });

  it('rejects more than MAX_CALLS calls', () => {
    const calls = Array.from({ length: MAX_CALLS + 1 }, () => TX1_CALL);
    expect(() => validateEvTx({ ...TX1, calls })).toThrow(/at most/);
  });

  it('rejects calldata over the byte cap', () => {
    const input = `0x${'ab'.repeat(MAX_CALLDATA_BYTES + 1)}` as Hex;
    expect(() =>
      validateEvTx({
        ...TX1,
        calls: [{ to: TX1_CALL.to, value: BigInt(0), input }],
      }),
    ).toThrow(/exceeds/);
  });

  it('rejects integers wider than the node field types (u64 / u128 / U256)', () => {
    const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
    const U128_MAX = (BigInt(1) << BigInt(128)) - BigInt(1);
    const U256_MAX = (BigInt(1) << BigInt(256)) - BigInt(1);

    expect(() => validateEvTx({ ...TX1, nonce: U64_MAX + BigInt(1) })).toThrow(
      /nonce out of range/,
    );
    expect(() =>
      validateEvTx({ ...TX1, gasLimit: U64_MAX + BigInt(1) }),
    ).toThrow(/gasLimit out of range/);
    expect(() =>
      validateEvTx({ ...TX1, maxFeePerGas: U128_MAX + BigInt(1) }),
    ).toThrow(/maxFeePerGas out of range/);
    expect(() =>
      validateEvTx({
        ...TX1,
        calls: [{ ...TX1_CALL, value: U256_MAX + BigInt(1) }],
      }),
    ).toThrow(/value out of range/);

    // At-the-limit values are accepted (boundary is inclusive).
    expect(() =>
      validateEvTx({ ...TX1, nonce: U64_MAX, maxFeePerGas: U128_MAX }),
    ).not.toThrow();
  });

  it('rejects negative integer fields', () => {
    expect(() => validateEvTx({ ...TX1, nonce: BigInt(-1) })).toThrow(
      /nonce out of range/,
    );
  });
});

describe('estimateIntrinsicGas', () => {
  it('accounts for base, per-call, and calldata bytes', () => {
    // base 21000 + per-call 21000 + one zero byte (4) + one non-zero byte (16)
    const gas = estimateIntrinsicGas([
      { to: `0x${'00'.repeat(20)}`, value: BigInt(0), input: '0x0001' },
    ]);
    expect(gas).toBe(BigInt(21_000 + 21_000 + 4 + 16));
  });

  it('adds the creation surcharge for a to=null (deploy) call', () => {
    // base 21000 + per-call 21000 + CREATE 32000 + one zero byte (4)
    const gas = estimateIntrinsicGas([
      { to: null, value: BigInt(0), input: '0x00' },
    ]);
    expect(gas).toBe(BigInt(21_000 + 21_000 + 32_000 + 4));
  });
});
