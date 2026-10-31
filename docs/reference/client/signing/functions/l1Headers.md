# Function: l1Headers()

```ts
function l1Headers(p): Record<"XO_ADDRESS" | "XO_SIGNATURE" | "XO_TIMESTAMP" | "XO_NONCE", string>;
```

The L1 request headers. `XO_ADDRESS` is checksummed and `XO_NONCE` is the nonce in decimal.

The signature is any non-empty hex string of whole bytes, not only 65 bytes: a smart
wallet signs with EIP-1271 and its signature has another length.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `p` | \{ `address`: `` `0x${string}` ``; `nonce`: `bigint`; `signature`: `` `0x${string}` ``; `timestamp`: `string`; \} |
| `p.address` | `` `0x${string}` `` |
| `p.nonce` | `bigint` |
| `p.signature` | `` `0x${string}` `` |
| `p.timestamp` | `string` |

## Returns

`Record`\<`"XO_ADDRESS"` \| `"XO_SIGNATURE"` \| `"XO_TIMESTAMP"` \| `"XO_NONCE"`, `string`\>

## Throws

UserInputError if `address`, `timestamp` or `nonce` is invalid (see [clobAuthTypedData](clobAuthTypedData.md)) or `signature` is not a non-empty 0x-hex string with an even number of digits.
