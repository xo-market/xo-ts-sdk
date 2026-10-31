# Function: executorSigningHash()

```ts
function executorSigningHash(tx): `0x${string}`;
```

The digest the executor raw-signs (secp256k1 over the prehash, NO EIP-191):
`keccak256(0x76 || rlp([...7 fields, feePayer = empty string]))`.

The fee-payer field is always the empty string here, which is why the
executor hash is independent of any sponsor signature.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `tx` | [`EvTx`](../interfaces/EvTx.md) |

## Returns

`` `0x${string}` ``
