import {
  type Address,
  getAddress,
  type Hex,
  keccak256,
  numberToHex,
  pad,
  recoverAddress,
} from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import type { ChainReader, TxResult } from '../../src/account/chain';
import type { SponsorRequestBody } from '../../src/account/sponsorClient';
import { type EvTx, executorSigningHash } from '../../src/signing/evTx';
import type { Call } from '../../src/signing/kernel';
import type { TradingIdentity } from '../../src/wallet/identity';
import type { InternalSigner } from '../../src/wallet/signer';
import { keySigner } from './signers';
import { testEnv } from './testEnv';

// A stub of the full ChainReader for the transaction-rail tests and the account client.
// Every method answers from a small, test-settable state and records what it was
// asked, in order, in `log`, so a test can check both what was sent and what was never reached.

export const OWNER_PK: Hex = `0x${'11'.repeat(32)}`;
export const OWNER: Address = privateKeyToAccount(OWNER_PK).address;
/** A smart wallet address for the owner. The tests never derive it: they set it. */
export const SMART_WALLET: Address = getAddress(
  '0x00000000000000000000000000000000000c0de1',
);
export const TX_HASH: Hex = `0x${'ab'.repeat(32)}`;

export function eoaIdentity(owner: Address = OWNER): TradingIdentity {
  return Object.freeze({
    type: 'eoa',
    owner,
    address: owner,
    signatureType: 0,
  });
}

export function smartWalletIdentity(
  owner: Address = OWNER,
  address: Address = SMART_WALLET,
  index = 0n,
): TradingIdentity {
  return Object.freeze({
    type: 'smart_wallet',
    owner,
    address,
    signatureType: 3,
    index,
  });
}

/** The owner's signer, with `signHash`. */
export function ownerSigner(): InternalSigner {
  return keySigner(OWNER_PK);
}

/** The owner's signer without `signHash`, as a wallet client would be. */
export function noRawSigner(): InternalSigner {
  const full = ownerSigner();
  return Object.freeze({
    address: full.address,
    signMessage: full.signMessage,
    signTypedData: full.signTypedData,
  });
}

const SECP256K1_N = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
);
const HALF_N = SECP256K1_N >> 1n;

/**
 * The owner's signer, whose `signHash` returns the high-s twin of the real signature: the
 * same (r, n - s) pair with the recovery byte flipped. It is a valid signature, but nodes
 * refuse the high-s form, so the rail must reduce it.
 */
export function highSSigner(): InternalSigner {
  const base = ownerSigner();
  return Object.freeze({
    address: base.address,
    signMessage: base.signMessage,
    signTypedData: base.signTypedData,
    signHash: async (hash: Hex) => {
      const sig = await sign({ hash, privateKey: OWNER_PK });
      const s = BigInt(sig.s);
      if (s > HALF_N) {
        throw new Error('expected viem to return a low-s signature');
      }
      const high = SECP256K1_N - s;
      const v = sig.yParity === 0 ? 28 : 27;
      return `${sig.r}${numberToHex(high, { size: 32 }).slice(2)}${v.toString(16)}` as Hex;
    },
  });
}

/** Whether the `s` of a 65-byte `r || s || v` signature is in the low half of the curve order. */
export function isLowS(signature: Hex): boolean {
  return BigInt(`0x${signature.slice(66, 130)}`) <= HALF_N;
}

/** The address word `eth_call` returns for `createAccount`. */
export function addressWord(address: Address): Hex {
  return pad(address.toLowerCase() as Hex, { size: 32 });
}

/** One recorded call to the stub. */
export interface ChainCall {
  method: keyof ChainReader;
  args: unknown[];
}

export interface RailChainStub {
  reader: ChainReader;
  /** Every call, in order. */
  log: ChainCall[];
  /** How many times `method` was called. */
  count(method: keyof ChainReader): number;
  /** The `'pending'` nonce `getNonce` answers. */
  nonce: bigint;
  /**
   * The `'latest'` nonce `getNonce(address, 'latest')` answers (only mined transactions), or
   * throws. Left out, it is `nonce`: nothing of the owner is pending.
   */
  latestNonce?: bigint | Error;
  /** The code by address (lower case). Without an entry: `'0x'` (nothing deployed). */
  code: Map<string, Hex>;
  /** What `estimateGas` answers, or throws. */
  estimate: bigint | Error;
  /** What `simulateBundleGas` answers, or throws. */
  simulate: bigint | Error;
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | Error;
  /** What `readContract` answers, or throws. A function answers each call by its `to` and calldata. */
  read: Hex | Error | ((call: { to: Address; data: Hex }) => Hex | Error);
  /** The receipt `waitForReceipt` answers for a hash, or the error it throws. */
  receipt: (hash: Hex, timeoutMs: number) => TxResult | Error;
  /** What `sendRawTransaction` throws, if anything. Otherwise it answers the hash of the bytes. */
  broadcast?: Error;
  /** What `getTransaction` answers for any hash, or throws. Defaults to `'not_found'`. */
  lookup: 'found' | 'not_found' | Error;
}

/**
 * A stub with a deployed owner and smart wallet, an estimate of 100 000 gas, a bundle
 * simulation of 200 000 gas, zero fees and a successful receipt for any hash.
 */
export function railChain(): RailChainStub {
  const stub: RailChainStub = {
    log: [],
    count: (method) => stub.log.filter((c) => c.method === method).length,
    nonce: 5n,
    code: new Map([[SMART_WALLET.toLowerCase(), '0x6000' as Hex]]),
    estimate: 100_000n,
    simulate: 200_000n,
    fees: { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n },
    read: new Error('execution reverted'),
    receipt: (hash) => ({ txHash: hash, status: 'success', blockNumber: 42n }),
    lookup: 'not_found',
    reader: {} as ChainReader,
  };
  const answer = <T>(value: T | Error): T => {
    if (value instanceof Error) {
      throw value;
    }
    return value;
  };
  stub.reader = {
    async getNonce(address, blockTag) {
      stub.log.push({
        method: 'getNonce',
        args: blockTag === undefined ? [address] : [address, blockTag],
      });
      return blockTag === 'latest'
        ? answer(stub.latestNonce ?? stub.nonce)
        : stub.nonce;
    },
    async getCode(address) {
      stub.log.push({ method: 'getCode', args: [address] });
      return stub.code.get(address.toLowerCase()) ?? '0x';
    },
    async estimateGas(o) {
      stub.log.push({ method: 'estimateGas', args: [o] });
      return answer(stub.estimate);
    },
    async simulateBundleGas(o) {
      stub.log.push({ method: 'simulateBundleGas', args: [o] });
      return answer(stub.simulate);
    },
    async getFees() {
      stub.log.push({ method: 'getFees', args: [] });
      return answer(stub.fees);
    },
    async readContract(call) {
      stub.log.push({ method: 'readContract', args: [call] });
      return answer(
        typeof stub.read === 'function' ? stub.read(call) : stub.read,
      );
    },
    async waitForReceipt(hash, timeoutMs) {
      stub.log.push({ method: 'waitForReceipt', args: [hash, timeoutMs] });
      return answer(stub.receipt(hash, timeoutMs));
    },
    async getTransaction(hash) {
      stub.log.push({ method: 'getTransaction', args: [hash] });
      return answer(stub.lookup);
    },
    async sendRawTransaction(raw) {
      stub.log.push({ method: 'sendRawTransaction', args: [raw] });
      if (stub.broadcast !== undefined) {
        throw stub.broadcast;
      }
      return keccak256(raw);
    },
  };
  return stub;
}

/** The unsigned EvNode transaction a sponsor request body describes. */
export function evTxOf(body: SponsorRequestBody): EvTx {
  const { tx } = body;
  return {
    chainId: BigInt(tx.chainId),
    nonce: BigInt(tx.nonce),
    maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
    maxFeePerGas: BigInt(tx.maxFeePerGas),
    gasLimit: BigInt(tx.gasLimit),
    calls: tx.calls.map((c) => ({
      to: c.to,
      value: BigInt(c.value),
      input: c.data,
    })),
    accessList: [],
  };
}

/** Who signed a sponsor request: the address its executor signature recovers to. */
export async function executorOf(body: SponsorRequestBody): Promise<Address> {
  return recoverAddress({
    hash: executorSigningHash(evTxOf(body)),
    signature: body.executorSignature,
  });
}

/** A plain call, for tests that do not care what it does. */
export function call(n = 1): Call {
  return {
    to: testEnv.contracts.usdc,
    data: `0x095ea7b3${n.toString(16).padStart(64, '0')}`,
  };
}
