# Function: encodeSignedTx()

```ts
function encodeSignedTx(
   tx, 
   feePayerSignature, 
   exec
): `0x${string}`;
```

The signed envelope for `eth_sendRawTransaction`:
`0x76 || rlp([...7 fields, feePayerSignature, execYParity, execR, execS])`.

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `tx` | [`EvTx`](../interfaces/EvTx.md) | - |
| `feePayerSignature` | `` `0x${string}` `` \| `null` | the sponsor's 65-byte `r\|\|s\|\|v` signature, passed verbatim; `null` for a self-paid (unsponsored) transaction. |
| `exec` | [`ExecutorSignature`](../interfaces/ExecutorSignature.md) | - |

## Returns

`` `0x${string}` ``
