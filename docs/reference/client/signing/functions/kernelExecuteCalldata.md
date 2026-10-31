# Function: kernelExecuteCalldata()

```ts
function kernelExecuteCalldata(calls): `0x${string}`;
```

The calldata of the Kernel account's ERC-7579 `execute(bytes32 mode, bytes executionCalldata)`
(selector `0xe9ae5c53`), to make one or more calls from the account.

- One call: mode `0x00` plus 31 zero bytes, and `executionCalldata` is the packed
  `target (20 bytes) || value (32 bytes) || data`.
- Two or more calls: mode `0x01` plus 31 zero bytes, and `executionCalldata` is the ABI
  encoding of `(address target, uint256 value, bytes callData)[]`.

The exec type is the default (`0x00`): if a call fails, the whole execution reverts.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `calls` | [`Call`](../interfaces/Call.md)[] |

## Returns

`` `0x${string}` ``

## Throws

UserInputError, starting with `calls` or `calls[i]` or `calls[i].to|value|data`, if `calls` is empty, has more than `MAX_CALLS` (32) calls, or has a call that is not valid.
