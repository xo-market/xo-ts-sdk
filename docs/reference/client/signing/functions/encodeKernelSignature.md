# Function: encodeKernelSignature()

```ts
function encodeKernelSignature(ecdsa): `0x${string}`;
```

The Kernel signature for the root validator: `0x00 || ecdsa`, 66 bytes. Pass it as the
signature of a signatureType 3 order, or as the ERC-1271 signature.

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `ecdsa` | `` `0x${string}` `` | The owner's 65-byte `r || s || v` signature over the digest from [kernelWrapTypedData](kernelWrapTypedData.md). |

## Returns

`` `0x${string}` ``

## Throws

UserInputError starting with `ecdsa` if it is not a 0x-prefixed hex string of exactly 65 bytes.
