# Function: hmacSignature()

```ts
function hmacSignature(
   secret, 
   timestamp, 
   method, 
   path, 
   body
): Promise<string>;
```

The L2 signature of one request:
`urlSafeBase64(HMAC-SHA256(base64Decode(secret), timestamp + METHOD + path + body))`.

The result is URL-safe base64 with the `=` padding kept (`+/` become `-_`). The secret
may be in the standard or the URL-safe alphabet, padded or not.

- `method` is upper-cased.
- `path` is the request path only: no query string and no fragment. A path with `?` or
  `#` is rejected, because the gateway does not sign the query.
- `body` is the exact string that is sent (`''` when there is none).

## Parameters

| Parameter | Type |
| ------ | ------ |
| `secret` | `string` |
| `timestamp` | `string` |
| `method` | `string` |
| `path` | `string` |
| `body` | `string` |

## Returns

`Promise`\<`string`\>

## Throws

UserInputError if the secret is not valid base64, `timestamp` is not a string of decimal digits, `method` is empty, `path` does not start with `/` or has `?` or `#`, or `body` is not a string. No message contains the secret.
