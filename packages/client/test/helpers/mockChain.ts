import {
  type Address,
  decodeFunctionData,
  encodeFunctionResult,
  type Hex,
  zeroHash,
} from 'viem';
import type { EnvironmentConfig } from '../../src/core/env';
import type { ContractReader } from '../../src/orderbook/client';
import { testEnv } from './testEnv';

// A stub of the chain for the market-resolution tests. It is a `ContractReader` that decodes the
// calldata it is given and answers per selector from a small state, so a test sets what the
// chain says and then checks what was asked.
//
// It is NOT an independent check of the selectors: its ABI fragments below are the same
// fragments the SDK uses, so a wrong function name or argument type would be encoded and
// decoded consistently on both sides. The literal calldata test in
// `test/markets/resolve.test.ts` ("the calldata is pinned") is the independent check; it reads
// `ChainStub.calldata`, the raw bytes that were sent.
//
// - `ConditionalTokens.getOutcomeSlotCount(bytes32)`: 0 for a condition that was never prepared.
// - `ConditionalTokens.payoutDenominator(bytes32)`: 0 until the condition is resolved.
// - `CTFExchange.getConditionId(uint256)`: the zero hash for a token the exchange has not
//   registered.
//
// A call to any other address, or with any other selector, throws, as a node would answer a
// call that reverts.

const CONDITIONAL_TOKENS_ABI = [
  {
    type: 'function',
    name: 'getOutcomeSlotCount',
    stateMutability: 'view',
    inputs: [{ name: 'conditionId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'payoutDenominator',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const EXCHANGE_ABI = [
  {
    type: 'function',
    name: 'getConditionId',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'uint256' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const;

/** One decoded call that reached the stub. */
export interface ChainCall {
  to: Address;
  name: 'getOutcomeSlotCount' | 'payoutDenominator' | 'getConditionId';
  /** The argument: a condition id (lower case) or a decimal token id. */
  arg: string;
}

export interface ChainStub {
  reader: ContractReader;
  /** Every decoded call, in order. */
  calls: ChainCall[];
  /** The raw `to` and calldata of every call that reached the stub, in order. */
  calldata: Array<{ to: Address; data: Hex }>;
  /** Slot counts by condition id (lower case). A condition without an entry has 0. */
  slotCounts: Map<string, bigint>;
  /** Payout denominators by condition id (lower case). Without an entry: 0 (not resolved). */
  payoutDenominators: Map<string, bigint>;
  /** The exchange's registry: decimal token id to condition id. Without an entry: the zero hash. */
  registry: Map<string, string>;
  /** Answers the raw result instead of the decoded one (or throws), per function name. */
  override?: (call: ChainCall) => Hex | undefined;
}

/**
 * A stub on `env`'s contracts. Nothing is prepared, resolved or registered until the test says
 * so (see {@link prepare}).
 */
export function chainStub(env: EnvironmentConfig = testEnv): ChainStub {
  const stub: ChainStub = {
    calls: [],
    calldata: [],
    slotCounts: new Map(),
    payoutDenominators: new Map(),
    registry: new Map(),
    reader: {
      async readContract({ to, data }) {
        stub.calldata.push({ to, data });
        const target = to.toLowerCase();
        if (target === env.contracts.conditionalTokens.toLowerCase()) {
          const { functionName, args } = decodeFunctionData({
            abi: CONDITIONAL_TOKENS_ABI,
            data,
          });
          const condition = String(args[0]).toLowerCase();
          const call: ChainCall = { to, name: functionName, arg: condition };
          stub.calls.push(call);
          const forced = stub.override?.(call);
          if (forced !== undefined) {
            return forced;
          }
          const table =
            functionName === 'getOutcomeSlotCount'
              ? stub.slotCounts
              : stub.payoutDenominators;
          return encodeFunctionResult({
            abi: CONDITIONAL_TOKENS_ABI,
            functionName,
            result: table.get(condition) ?? 0n,
          });
        }
        if (target === env.contracts.ctfExchange.toLowerCase()) {
          const { functionName, args } = decodeFunctionData({
            abi: EXCHANGE_ABI,
            data,
          });
          const token = String(args[0]);
          const call: ChainCall = { to, name: functionName, arg: token };
          stub.calls.push(call);
          const forced = stub.override?.(call);
          if (forced !== undefined) {
            return forced;
          }
          return encodeFunctionResult({
            abi: EXCHANGE_ABI,
            functionName,
            result: (stub.registry.get(token) ?? zeroHash) as Hex,
          });
        }
        throw new Error(`execution reverted: no contract at ${to}`);
      },
    },
  };
  return stub;
}

/**
 * Makes a market tradable on the stub: the condition is prepared with two outcomes, is not
 * resolved, and the exchange knows the YES token as that condition's.
 */
export function prepare(
  stub: ChainStub,
  conditionId: string,
  yesTokenId: string,
): void {
  const condition = conditionId.toLowerCase();
  stub.slotCounts.set(condition, 2n);
  stub.payoutDenominators.delete(condition);
  stub.registry.set(yesTokenId, condition);
}
