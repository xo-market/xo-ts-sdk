# Function: l2Headers()

```ts
function l2Headers(
   c, 
   timestamp, 
   method, 
   path, 
   body
): Promise<Record<"XO_SIGNATURE" | "XO_TIMESTAMP" | "XO_API_KEY" | "XO_PASSPHRASE", string>>;
```

The L2 request headers for one orderbook call. See [hmacSignature](hmacSignature.md) for what is
signed. Nothing here logs, and no error contains the secret or the passphrase.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `c` | [`OrderbookCredential`](../../interfaces/OrderbookCredential.md) |
| `timestamp` | `string` |
| `method` | `string` |
| `path` | `string` |
| `body` | `string` |

## Returns

`Promise`\<`Record`\<`"XO_SIGNATURE"` \| `"XO_TIMESTAMP"` \| `"XO_API_KEY"` \| `"XO_PASSPHRASE"`, `string`\>\>

## Throws

UserInputError if the credential is missing a field or the signature inputs are invalid (see [hmacSignature](hmacSignature.md)).
