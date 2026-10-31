import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import fixture from '../../../../test-vectors/evtx-conformance.json';
import type { EvCall, EvTx, ExecutorSignature } from '../../src/signing/evTx';
import { encodeSignedTx, executorSigningHash } from '../../src/signing/evTx';

/**
 * Fixture-driven conformance suite for XO mainnet (chain 3223). Each case's expected
 * `execHash` / `encodeSigned` bytes are in `test-vectors/evtx-conformance.json`; the
 * transaction inputs are reconstructed here. Any RLP divergence — including the tricky edge
 * cases below — fails loudly.
 *
 * How the bytes were checked (the file's `_note` has the details): every case that XO's
 * production sponsor will sign was sent to its sign-only route with a fresh executor key, and the
 * sponsor recovered that executor from its own signing hash; every case was also re-encoded
 * with Foundry's `cast to-rlp`. The sponsor signs only zero-value calls to XO's contracts, so
 * the calls go to USDC and ConditionalTokens. C3 (a contract creation) and C5 (chain ID
 * 2^64 - 1) are cases the sponsor will not sign.
 */

const MASK = (bits: number): bigint => BigInt(2) ** BigInt(bits) - BigInt(1);
const U64_MAX = MASK(64);
const U128_MAX = MASK(128);
const U256_MAX = MASK(256);

const addr = (byte: number): Hex =>
  `0x${byte.toString(16).padStart(2, '0').repeat(20)}` as Hex;
const key = (byte: number): Hex =>
  `0x${byte.toString(16).padStart(2, '0').repeat(32)}` as Hex;

/** XO mainnet's USDC and ConditionalTokens. */
const USDC: Hex = '0x80c12230ce677e6f304027a14780Edd2A829ab0c';
const CTF: Hex = '0xCcf1b2C676E2f9A13e5674be0e0DdFF6d0B13909';
/** The mainnet CTFExchange, as a 32-byte ABI word (no 0x). */
const EXCHANGE_WORD = `${'00'.repeat(12)}4bc5e872256d12e6017dfe466e04c867dc761b77`;

/** USDC.transfer(address(0), 0): 68 bytes of calldata. */
const TRANSFER_ZERO: Hex = `0xa9059cbb${'00'.repeat(64)}`;
/** USDC.approve(CTFExchange, 2^256 - 1). */
const APPROVE_EXCHANGE_MAX: Hex = `0x095ea7b3${EXCHANGE_WORD}${'ff'.repeat(32)}`;
/** ConditionalTokens.setApprovalForAll(CTFExchange, true). */
const APPROVE_OPERATOR: Hex = `0xa22cb465${EXCHANGE_WORD}${'00'.repeat(31)}01`;

const usdc = (value: bigint, input: Hex): EvCall => ({
  to: USDC,
  value,
  input,
});
const ctf = (input: Hex): EvCall => ({ to: CTF, value: BigInt(0), input });

const BASE = {
  chainId: BigInt(3223),
  nonce: BigInt(7),
  maxPriorityFeePerGas: BigInt(1_000_000_000),
  maxFeePerGas: BigInt(2_000_000_000),
  gasLimit: BigInt(200_000),
  accessList: [] as EvTx['accessList'],
};

const EXEC_SIG: ExecutorSignature = {
  r: '0x11223344556677',
  s: '0x8899aabbccddeeff',
  yParity: 1,
};
const EXEC_SIG_HIGHBIT: ExecutorSignature = {
  r: '0x8000000000000000000000000000000000000000000000000000000000001234',
  s: `0x${'ff'.repeat(32)}`,
  yParity: 0,
};
const FEE_PAYER: Hex =
  '0x00000000000000000000000000000000000000000000000000000000deadbeef00000000000000000000000000000000000000000000000000000000cafebabe1b';

interface Case {
  name: keyof typeof fixture.cases;
  tx: EvTx;
  execSig: ExecutorSignature;
}

const CASES: Case[] = [
  {
    name: 'C1_transfer',
    tx: { ...BASE, calls: [usdc(BigInt(0), TRANSFER_ZERO)] },
    execSig: EXEC_SIG,
  },
  {
    // Zero nonce and zero tip (both the empty string), a one-byte fee cap, two calls.
    name: 'C2_batch',
    tx: {
      ...BASE,
      nonce: BigInt(0),
      maxPriorityFeePerGas: BigInt(0),
      maxFeePerGas: BigInt(7),
      gasLimit: BigInt(500_000),
      calls: [usdc(BigInt(0), TRANSFER_ZERO), ctf(APPROVE_OPERATOR)],
    },
    execSig: EXEC_SIG,
  },
  {
    // `to = null`: a contract creation (the empty string in the `to` slot).
    name: 'C3_create',
    tx: {
      ...BASE,
      nonce: BigInt(1),
      calls: [{ to: null, value: BigInt(0), input: '0x6080604052' }],
    },
    execSig: EXEC_SIG,
  },
  {
    name: 'C4_accesslist',
    tx: {
      ...BASE,
      calls: [usdc(BigInt(0), TRANSFER_ZERO)],
      accessList: [
        { address: addr(0xaa), storageKeys: [key(0x01), key(0x02)] },
      ],
    },
    execSig: EXEC_SIG,
  },
  {
    // Every integer at its maximum width; independent of the chain.
    name: 'C5_maxvalues',
    tx: {
      chainId: U64_MAX,
      nonce: U64_MAX,
      maxPriorityFeePerGas: U128_MAX,
      maxFeePerGas: U128_MAX,
      gasLimit: U64_MAX,
      calls: [{ to: addr(0x55), value: U256_MAX, input: '0x' }],
      accessList: [],
    },
    execSig: EXEC_SIG,
  },
  {
    // The single-byte boundary: 0x7f encodes as itself, 0x80 as 0x8180. It sits in the fee
    // fields, since the sponsor signs only zero-value calls.
    name: 'C6_boundary',
    tx: {
      ...BASE,
      maxPriorityFeePerGas: BigInt(0x7f),
      maxFeePerGas: BigInt(0x80),
      calls: [usdc(BigInt(0), TRANSFER_ZERO), usdc(BigInt(0), TRANSFER_ZERO)],
    },
    execSig: EXEC_SIG,
  },
  {
    // MAX_CALLS calls: a calls list long enough for a multi-byte RLP length.
    name: 'C7_batch32',
    tx: {
      ...BASE,
      gasLimit: BigInt(1_000_000),
      calls: Array.from({ length: 32 }, () => usdc(BigInt(0), TRANSFER_ZERO)),
    },
    execSig: EXEC_SIG,
  },
  {
    // An executor signature with the high bit of r and s set (only in the envelope).
    name: 'C8_sighighbit',
    tx: { ...BASE, calls: [usdc(BigInt(0), APPROVE_EXCHANGE_MAX)] },
    execSig: EXEC_SIG_HIGHBIT,
  },
];

describe('EvNode 0x76 conformance on mainnet', () => {
  it('covers every fixture case (no silent gaps)', () => {
    expect(CASES.map((c) => c.name).sort()).toEqual(
      Object.keys(fixture.cases).sort(),
    );
  });

  it.each(CASES)('$name — executor signing hash', ({ name, tx }) => {
    expect(executorSigningHash(tx)).toBe(fixture.cases[name].execHash);
  });

  it.each(CASES)('$name — signed envelope', ({ name, tx, execSig }) => {
    expect(encodeSignedTx(tx, FEE_PAYER, execSig)).toBe(
      fixture.cases[name].encodeSigned,
    );
  });
});
