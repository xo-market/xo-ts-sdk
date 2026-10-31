import { toFunctionSelector } from 'viem';
import { describe, expect, test } from 'vitest';
import { CONDITIONAL_TOKENS_ABI, ERC20_ABI } from '../../src/account/abis';

// The selectors are pinned to literal values (the well-known ERC-20 ones, and those of the
// Gnosis ConditionalTokens contract), so a wrong name or argument type in a fragment fails here.

function selectors(abi: readonly { type: string; name: string }[]) {
  return Object.fromEntries(
    abi.map((item) => [item.name, toFunctionSelector(item as never)]),
  );
}

describe('ABI fragments', () => {
  test('ERC-20', () => {
    expect(selectors(ERC20_ABI)).toEqual({
      approve: '0x095ea7b3',
      transfer: '0xa9059cbb',
      allowance: '0xdd62ed3e',
      balanceOf: '0x70a08231',
      decimals: '0x313ce567',
    });
  });

  test('ConditionalTokens', () => {
    expect(selectors(CONDITIONAL_TOKENS_ABI)).toEqual({
      setApprovalForAll: '0xa22cb465',
      isApprovedForAll: '0xe985e9c5',
      balanceOf: '0x00fdd58e',
      balanceOfBatch: '0x4e1273f4',
      mergePositions: '0x9e7212ad',
      redeemPositions: '0x01b7037c',
      payoutDenominator: '0xdd34de67',
    });
  });
});
