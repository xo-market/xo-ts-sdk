# Function: rlpInt()

```ts
function rlpInt(value): `0x${string}`;
```

RLP-encode an unsigned integer as a minimal big-endian byte string, matching
alloy. `0` → `'0x'` (which `toRlp` renders as `0x80`); no leading zero bytes.

Do NOT substitute `numberToHex(v, { size })` — fixed-width padding corrupts
the hash and the recovered executor address.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `number` \| `bigint` |

## Returns

`` `0x${string}` ``
