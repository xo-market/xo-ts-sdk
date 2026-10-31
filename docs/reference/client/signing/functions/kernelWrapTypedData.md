# Function: kernelWrapTypedData()

```ts
function kernelWrapTypedData(
   hash, 
   account, 
   chainId
): MessageDefinition<{
  Kernel: readonly [{
     name: "hash";
     type: "bytes32";
  }];
}, "Kernel">;
```

The typed data a Kernel owner signs to make an ERC-1271 signature for `hash` (for
example an order digest). Kernel does not check the raw hash: it wraps it as the
EIP-712 struct `Kernel(bytes32 hash)` under the domain
`{ name: 'Kernel', version: '0.3.1', chainId, verifyingContract: account }`.

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `hash` | `` `0x${string}` `` | The 32-byte digest to approve. |
| `account` | `` `0x${string}` `` | The Kernel account address. Any case: it is checksummed. |
| `chainId` | `number` | The chain the account lives on, a positive safe integer. |

## Returns

`MessageDefinition`\<\{
  `Kernel`: readonly \[\{
     `name`: `"hash"`;
     `type`: `"bytes32"`;
  \}\];
\}, `"Kernel"`\>

## Throws

UserInputError, starting with `hash`, `account` or `chainId`, for the first of them that is invalid.
